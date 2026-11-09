import type { Database } from "bun:sqlite";
import { extractTerms, type EmbeddingConfig, type EmbeddingProvider, type ScopeAudience, type SearchResult } from "@standup/knowledge";
import { GLOBAL_PROJECT_ID } from "@standup/shared";
import { getOrCreatePersonaState, getUserPrefs } from "@standup/store";
import { literalAlternation, searchCode } from "../code-search.js";
import {
  formatCodeKnowledgeInjection,
  formatProductKnowledgeInjection,
  resolveRetrievalQuery,
  retrieveCodeKnowledge,
  retrieveProductKnowledge,
} from "../launcher.js";
import { buildOwnerProfile, formatOwnerPreferences, profilePromptText } from "../persona/owner-profile.js";
import { buildSystemPrompt } from "../persona/prompt.js";
import { scoreComponents, type GatedCandidate } from "../retrieval-telemetry.js";
import { normalizePath, roundNumbers } from "./metrics.js";
import type { EvalCase, GatedHit, Hit, HitWhy, SurfaceRun } from "./types.js";

/** The in-process collector app (Hono) the surfaces drive, as Persona does. */
export interface InProcessApp {
  request(path: string, init?: RequestInit): Response | Promise<Response>;
}

export interface SurfaceContext {
  app: InProcessApp;
  db: Database;
  /** Header the collector reads the requesting user from (the tunnel identity header). */
  identityHeader: string;
  /** Repo root per project, for the cwd a session in that project runs from. */
  repoFor(projectId: string): string | undefined;
  /** An empty directory used as the cwd when a project has no repo. */
  emptyCwd: string;
  embeddingProvider: EmbeddingProvider | null;
  embeddingConfig: EmbeddingConfig;
}

/**
 * A user the collector resolves to nobody's docs. A case with no audience user
 * is sent under it so the loopback host-user fallback can't inject the host's
 * own user-scoped docs into the measurement.
 */
export const NO_USER_ALIAS = "kbeval-no-user";

async function postJson(
  ctx: SurfaceContext,
  path: string,
  body: Record<string, unknown>,
  user: string | undefined
): Promise<Record<string, unknown>> {
  const res = await ctx.app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [ctx.identityHeader]: user ?? NO_USER_ALIAS,
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (res.status !== 200) {
    throw new Error(`${path} returned ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

function cwdFor(ctx: SurfaceContext, projectId: string): string {
  return ctx.repoFor(projectId) ?? ctx.emptyCwd;
}

interface AnnotatedResult extends Omit<SearchResult, "verdict"> {
  currentConfidence?: number;
  verdict?: string;
  injectionEligible?: boolean;
  staleSince?: string;
}

/**
 * Whether the search_knowledge MCP formatter prints a ⚠ on a hit: a doc
 * re-verification disputed, a contradicted or superseded doc, one the route
 * flags as not injection-eligible (untrusted, stale or low confidence), or one
 * it reports stale since a date.
 */
function searchMarker(r: AnnotatedResult): boolean {
  return (
    r.verdict === "disputed" ||
    r.verdict === "contradicted" ||
    r.verdict === "superseded" ||
    r.injectionEligible === false ||
    !!r.staleSince
  );
}

/** A hit's `why` from its score fields, or nothing when it carries none. */
function whyOf(components: Record<string, unknown> | undefined): { why?: HitWhy } {
  return components && Object.keys(components).length > 0 ? { why: { components } } : {};
}

/** Gated candidates as recorded in a run's detail, scores rounded like hit scores. */
function gatedHits(gated: ReadonlyArray<{ ref: string; reason: string; components?: Record<string, unknown> }>): GatedHit[] {
  return gated.map((g) => ({
    ref: g.ref,
    reason: g.reason,
    ...(g.components && Object.keys(g.components).length > 0 ? { components: roundNumbers(g.components) } : {}),
  }));
}

function docHits(results: AnnotatedResult[], withFlags: boolean): Hit[] {
  return results.map((r, rank) => ({
    ref: `${r.projectId}/${r.slug}`,
    rank,
    score: r.score,
    rawScore: r.rawScore,
    ...(r.relevance !== undefined ? { relevance: r.relevance } : {}),
    ...whyOf(scoreComponents(r)),
    kind: "doc" as const,
    flags: withFlags
      ? {
          verdict: r.verdict ?? undefined,
          injectionEligible: r.injectionEligible,
          currentConfidence: r.currentConfidence,
          marked: searchMarker(r),
        }
      : { marked: false },
  }));
}

/**
 * search_knowledge as an agent session in the case's project calls it: the MCP
 * tool posts `{ cwd, query, scoped: true }` to /api/knowledge/search, with the
 * session's project resolved server-side (passed explicitly here, since the
 * eval has no session) and the user taken from the identity header.
 */
export async function runSearch(ctx: SurfaceContext, c: EvalCase): Promise<SurfaceRun> {
  const body = await postJson(
    ctx,
    "/api/knowledge/search",
    {
      cwd: cwdFor(ctx, c.audience.projectId),
      query: c.query,
      project: c.audience.projectId,
      scoped: true,
    },
    c.audience.user
  );
  const results = (body.results as AnnotatedResult[] | undefined) ?? [];
  return { hits: docHits(results, true), detail: { project: body.project } };
}

/**
 * Least fraction of a query's distinct terms a file must contain to be a hit.
 * The search is an alternation of the query's terms, so a file sharing one
 * word with the query comes back; one holding most of them is about it.
 */
export const CODE_MIN_COVERAGE = 0.6;
/**
 * Bonus for a file whose name holds a query term: a file named after the
 * subject is a stronger signal than prose that mentions it. Kept below full
 * coverage (1) so a name match breaks ties rather than deciding the rank.
 */
const CODE_NAME_BONUS = 0.45;
/** Added per further query term the file name holds. */
const CODE_NAME_BONUS_STEP = 0.18;
/** Prose matches more terms per file than code by length alone; it is damped. */
const CODE_PROSE_DAMPING = 0.7;
/**
 * Per-file match cap. A file's coverage is read off its returned lines, so a
 * low cap would bound how many distinct terms a file can show.
 */
const CODE_MAX_COUNT = 10;
/** Line budget well above a typical query's volume, so truncation never decides which files qualify. */
const CODE_MAX_MATCHES = 4000;
/** Matched lines kept per file as its excerpt, and the width each is cut to. */
const CODE_EXCERPT_LINES = 8;
const CODE_EXCERPT_LINE_CHARS = 220;

/**
 * Code search as an agent drives it for a natural-language question: the
 * query's terms (extractTerms) as one case-insensitive alternation of literals,
 * run by the shared engine the `ripgrep` tool uses (searchCode) over the case
 * project's repo. Files are ranked by the share of distinct terms they contain,
 * plus a bonus for a term in the file name and a damping for prose, and a file
 * under CODE_MIN_COVERAGE is dropped. Eval fixtures (`*.eval.ts`) hold the case
 * text by construction and are excluded. A project with no repo, or a query
 * with no terms, searches nothing and reports why in `detail.codeSearch`.
 */
export async function runCode(ctx: SurfaceContext, c: EvalCase): Promise<SurfaceRun> {
  const terms = extractTerms(c.query);
  const repo = ctx.repoFor(c.audience.projectId);
  if (terms.length === 0 || !repo) {
    const error = terms.length === 0 ? "no searchable terms in the query" : "no repo path to search";
    return { hits: [], detail: { terms, codeSearch: { status: "unavailable", backend: null, error } } };
  }
  const result = await searchCode({
    pattern: literalAlternation(terms),
    cwd: repo,
    caseInsensitive: true,
    maxCount: CODE_MAX_COUNT,
    excludes: ["*.eval.ts"],
    maxMatches: CODE_MAX_MATCHES,
  });
  const byFile = new Map<string, { lines: string[]; hits: Set<string> }>();
  for (const match of result.matches) {
    let entry = byFile.get(match.file);
    if (!entry) {
      entry = { lines: [], hits: new Set() };
      byFile.set(match.file, entry);
    }
    if (entry.lines.length < CODE_EXCERPT_LINES) {
      entry.lines.push(`${match.line}: ${match.text.trim().slice(0, CODE_EXCERPT_LINE_CHARS)}`);
    }
    const text = match.text.toLowerCase();
    for (const term of terms) if (text.includes(term)) entry.hits.add(term);
  }
  const ranked: Array<{ file: string; score: number; excerpt: string }> = [];
  for (const [file, entry] of byFile) {
    const coverage = entry.hits.size / terms.length;
    if (coverage < CODE_MIN_COVERAGE) continue;
    const name = file.split("/").pop()?.toLowerCase() ?? "";
    const nameHits = terms.filter((t) => name.includes(t)).length;
    const nameBonus = nameHits > 0 ? CODE_NAME_BONUS + CODE_NAME_BONUS_STEP * (nameHits - 1) : 0;
    const damping = /\.(md|txt)$/i.test(file) ? CODE_PROSE_DAMPING : 1;
    ranked.push({ file, score: (coverage + nameBonus) * damping, excerpt: entry.lines.join("\n") });
  }
  ranked.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return {
    hits: ranked.map((r, rank) => ({
      ref: `code:${normalizePath(r.file)}`,
      rank,
      score: r.score,
      kind: "code" as const,
      excerpt: r.excerpt,
      flags: { marked: false },
    })),
    detail: {
      terms,
      files: byFile.size,
      codeSearch: {
        status: result.status,
        backend: result.backend,
        ...(result.error ? { error: result.error } : {}),
        ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
      },
    },
  };
}

/**
 * Launch-time injection for a launch whose task is the case query, by the
 * case's user, in the case's project: the same retrieval calls, audience and
 * char-budgeted rendering the launcher runs. Hits are the docs actually
 * included in the opening prompt, code block first (its prompt order).
 */
export async function runInject(ctx: SurfaceContext, c: EvalCase): Promise<SurfaceRun> {
  const projectId = c.audience.projectId;
  const retrievalQuery = resolveRetrievalQuery(c.query);
  const audience: ScopeAudience = { projectId, user: c.audience.user };
  const codeGated: GatedCandidate<SearchResult>[] = [];
  const productGated: GatedCandidate<SearchResult>[] = [];
  const [codeDocs, productDocs] = await Promise.all([
    retrieveCodeKnowledge(ctx.db, projectId, retrievalQuery, ctx.embeddingProvider, ctx.embeddingConfig, audience, codeGated),
    retrieveProductKnowledge(ctx.db, projectId, retrievalQuery, ctx.embeddingProvider, ctx.embeddingConfig, audience, productGated),
  ]);
  const codeBlock = formatCodeKnowledgeInjection(codeDocs);
  const productBlock = formatProductKnowledgeInjection(productDocs);
  const included = [...codeBlock.includedDocs, ...productBlock.includedDocs];
  const ref = (r: SearchResult) => `${r.projectId}/${r.slug}`;
  const budgetDropped = [
    ...codeDocs.filter((r) => !codeBlock.includedDocs.includes(r)),
    ...productDocs.filter((r) => !productBlock.includedDocs.includes(r)),
  ];
  const gated = gatedHits([
    ...[...codeGated, ...productGated].map((g) => ({ ref: ref(g.hit), reason: g.reason, components: scoreComponents(g.hit) })),
    ...budgetDropped.map((r) => ({ ref: ref(r), reason: "budget", components: scoreComponents(r) })),
  ]);
  return {
    hits: docHits(included, false),
    detail: {
      codeCandidates: codeDocs.map(ref),
      productCandidates: productDocs.map(ref),
      codeIncluded: codeBlock.includedDocs.map(ref),
      productIncluded: productBlock.includedDocs.map(ref),
      injectedChars: codeBlock.text.length + productBlock.text.length,
      gated,
    },
  };
}

/** What reaches Persona for a query, as doc refs and ranked recall hits. */
export interface PersonaContext {
  /** Docs present in Persona's system prompt. */
  contextRefs: string[];
  /** Docs present in the preferences block every worker brief carries. */
  briefRefs: string[];
  /** The `recall` tool's ranked results, for when Persona calls it. */
  recall: Hit[];
  detail?: Record<string, unknown>;
}

/**
 * What Persona has in context about its owner for a query. Swappable so an
 * owner-profile implementation can be measured on the same cases.
 */
export interface PersonaContextAdapter {
  readonly name: string;
  run(ctx: SurfaceContext, query: string, owner: string | undefined): Promise<PersonaContext>;
}

/** Text a hook renders into Persona's context, and the docs it drew on when it knows them. */
export interface RenderedContext {
  text: string;
  /** `project/slug` of every doc the text carries; absent, the text is matched by name. */
  refs?: string[];
}

export interface PersonaAdapterHooks {
  /** The owner profile rendered into Persona's system prompt. */
  ownerProfile?(ctx: SurfaceContext, owner: string): string | RenderedContext | undefined;
  /** The owner's preferences block appended to every worker brief. */
  briefPreferencesBlock?(ctx: SurfaceContext, owner: string): string | RenderedContext | undefined;
}

/** Doc refs whose `project/slug` or exact title appears in a prompt. */
function docsNamedIn(db: Database, prompt: string): string[] {
  const rows = db
    .query("SELECT project_id, slug, title FROM knowledge ORDER BY project_id, slug")
    .all() as Array<{ project_id: string; slug: string; title: string }>;
  return rows
    .filter((r) => prompt.includes(`${r.project_id}/${r.slug}`) || (r.title.length > 12 && prompt.includes(r.title)))
    .map((r) => `${r.project_id}/${r.slug}`);
}

/**
/**
 * Persona's context through the production code paths: its system prompt
 * (buildSystemPrompt over the owner's saved preferences, the handoff note and
 * the owner profile when a hook renders one), the worker-brief preferences
 * block when a hook renders one, and its `recall` tool, which posts
 * `{ cwd: "", query, project: global, scoped: true }` to /api/knowledge/search
 * as the owner and keeps the top 6 (title, slug, project, excerpt — no trust
 * markers). A hook that reports the docs it drew on is taken at its word;
 * the rest of the prompt is matched by name (docsNamedIn), so a same-titled
 * copy of a profile doc elsewhere in the corpus is not counted as in context.
 */
export function makePersonaAdapter(name: string, hooks: PersonaAdapterHooks = {}): PersonaContextAdapter {
  return {
    name,
    async run(ctx, query, owner) {
      const state = owner ? getOrCreatePersonaState(ctx.db, owner) : undefined;
      const prefs = owner ? getUserPrefs(ctx.db, owner) : null;
      const promptInput = {
        owner: owner ?? NO_USER_ALIAS,
        handoffNote: state?.handoffNote,
        personalInstructions: prefs?.personalInstructions,
      };
      const profile = owner ? asRendered(hooks.ownerProfile?.(ctx, owner)) : undefined;
      const systemPrompt = buildSystemPrompt({ ...promptInput, ownerProfile: profile?.text });
      const contextRefs = profile?.refs
        ? union(profile.refs, docsNamedIn(ctx.db, buildSystemPrompt(promptInput)))
        : docsNamedIn(ctx.db, systemPrompt);
      const brief = owner ? asRendered(hooks.briefPreferencesBlock?.(ctx, owner)) : undefined;
      const briefRefs = !brief?.text ? [] : brief.refs ?? docsNamedIn(ctx.db, brief.text);
      const body = await postJson(
        ctx,
        "/api/knowledge/search",
        { cwd: "", query, project: GLOBAL_PROJECT_ID, scoped: true },
        owner
      );
      const recalled = ((body.results as AnnotatedResult[] | undefined) ?? []).slice(0, 6);
      return {
        contextRefs,
        briefRefs,
        recall: docHits(recalled, false),
        detail: {
          systemPromptChars: systemPrompt.length,
          profileChars: profile === undefined ? null : profile.text.length,
          briefBlockChars: brief === undefined ? null : brief.text.length,
        },
      };
    },
  };
}

function asRendered(value: string | RenderedContext | undefined): RenderedContext | undefined {
  return typeof value === "string" ? { text: value } : value;
}

function union(first: string[], rest: string[]): string[] {
  return [...new Set([...first, ...rest])];
}

/**
 * The product's Persona: the owner profile in its system prompt and the
 * owner-preferences block in every brief, both from the production builders.
 */
export const currentPersonaAdapter: PersonaContextAdapter = makePersonaAdapter("profile+brief+recall", {
  ownerProfile: (ctx, owner) => {
    const profile = buildOwnerProfile(ctx.db, owner);
    return { text: profilePromptText(profile), refs: profile.refs };
  },
  briefPreferencesBlock: (ctx, owner) => formatOwnerPreferences(buildOwnerProfile(ctx.db, owner), owner),
});

/**
 * A persona case's two run surfaces: `context` is every doc in Persona's
 * system prompt or the worker-brief preferences block (an unordered set), and
 * `recall` is the ranked recall results.
 */
export async function runPersona(
  ctx: SurfaceContext,
  c: EvalCase,
  adapter: PersonaContextAdapter = currentPersonaAdapter
): Promise<{ context: SurfaceRun; recall: SurfaceRun }> {
  const p = await adapter.run(ctx, c.query, c.audience.user);
  const refs = [...new Set([...p.contextRefs, ...p.briefRefs])];
  return {
    context: {
      hits: refs.map((ref, rank) => ({ ref, rank, kind: "doc" as const, flags: { marked: false } })),
      detail: { adapter: adapter.name, systemPromptDocs: p.contextRefs, briefDocs: p.briefRefs, ...p.detail },
    },
    recall: {
      hits: p.recall.map((h, rank) => ({ ...h, rank })),
      detail: { adapter: adapter.name, recalled: p.recall.map((h) => h.ref) },
    },
  };
}
