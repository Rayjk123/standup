import type { Database } from "bun:sqlite";
import { GLOBAL_PROJECT_ID } from "@standup/shared";
import type { MirrorProjects } from "../duplicate-hits.js";
import type { EmbeddingProvider } from "../embeddings.js";
import { memoizedSemanticNeighborIndex } from "../graph.js";
import {
  formatPushBlock,
  pushAreaQuery,
  pushPromptQuery,
  pushRef,
  pushSearchOptions,
  pushSessionStartQuery,
  selectPushDocs,
  type PushEvent,
} from "../push.js";
import {
  foreignIntentAdmissible,
  fuseInjectionResults,
  injectionPlanGate,
  mergeActivityHits,
  planInjection,
  type InjectionPlan,
} from "../query-rewrite.js";
import { isConfident, isVerdictAdmissible } from "../relevance.js";
import {
  GRAPH_RERANK_ENABLED,
  searchKnowledge,
  type RankWeights,
  type SearchOptions,
  type SearchResult,
} from "../search.js";
import { KnowledgeStore } from "../store.js";
import { isOriginEligibleForInjection, layerOf, type Layer, type ScopeAudience, type SourceKind } from "../types.js";
import { decayOnlyFreshnessGate, demoteStale } from "./freshness.js";
import type { ProjectSpec } from "./fixture.js";
import type { Hit, UsefulnessTask } from "./types.js";

/**
 * The retrieval surfaces the eval drives, each a mirror of the collector code
 * that serves it in production. A mirror reproduces the options and gates of
 * its original exactly but takes no collector import, so the harness's import
 * graph stays inside the knowledge/store/shared packages. When an original is
 * extracted into an importable pure module, replace the mirror with it:
 *
 *  - `search`: collector `server.ts` POST /api/knowledge/search as an agent
 *    session calls it through the MCP `search_knowledge` tool — `{ project,
 *    query, scoped: true }`, corpus `all`, `confidentFor: "search"`, no
 *    low-confidence tail; the agent audience (resolveAgentAudience: project,
 *    resolved user, host user, related projects) with the personal layer
 *    excluded unless the project is `global`; each hit annotated with the
 *    freshness gate and confidence flag, stale hits demoted (demoteStale), the
 *    first 5 confident hits returned.
 *  - `recall`: collector `persona/tools.ts` recall — the same route with
 *    `project: GLOBAL_PROJECT_ID, scoped: true` (an owner-only thread, so not
 *    restricted).
 *  - `inject`: collector `launcher.ts` retrieveCodeKnowledge /
 *    retrieveProductKnowledge → retrieveKnowledgeOfKinds: the brief's
 *    heuristic injection plan (planInjection; the model rewrite is off by
 *    default), each query searched over corpus `all` — code/decision/runbook
 *    with the activity pass merged in, product/spec with foreign intent
 *    excluded — each at most 3, `limit: 12`, `confidentFor: "inject"`, personal
 *    and activity layers excluded from the family search; the per-query lists
 *    fused (fuseInjectionResults), then the floor, plan (forbidden runbooks,
 *    activity bar), origin, verdict and freshness gates and demoteStale (a
 *    disputed doc is admitted at its trust-demoted rank and exempt from the
 *    freshness gate); the brief is resolveRetrievalQuery with no ticket
 *    context. Not mirrored: named-slug pins (resolveNamedPins); no task brief
 *    here names a slug, so pins would be empty.
 *  - `push`: collector `knowledge-push.ts`, the SessionStart /
 *    UserPromptSubmit / first-edit PreToolUse hook context. The selection is
 *    the knowledge package's own push module, so only the search call, the
 *    freshness mirror and the session simulation live here (PUSH_SURFACES).
 *    Not mirrored: the latency budget, and the session's own search /
 *    get_knowledge_doc retrievals in the dedup set (a fixture session makes none).
 *
 * Freshness is the decay-only mirror (see freshness.ts). The search route's
 * backend call is mirrored too (backendSearch), so nothing here imports the
 * backend or writer modules.
 */

/** collector launcher.ts CODE_KNOWLEDGE_KINDS. */
export const CODE_KNOWLEDGE_KINDS: readonly SourceKind[] = ["code", "decision", "runbook"];
/** collector launcher.ts PRODUCT_KNOWLEDGE_KINDS. */
export const PRODUCT_KNOWLEDGE_KINDS: readonly SourceKind[] = ["product", "spec"];
/** collector launcher.ts INJECTION_EXCLUDED_LAYERS. */
export const INJECTION_EXCLUDED_LAYERS: readonly Layer[] = ["personal", "activity"];
/** collector launcher.ts ACTIVITY_SOURCE_KINDS / ACTIVITY_PASS_EXCLUDED_LAYERS / ACTIVITY_PASS_LIMIT. */
export const ACTIVITY_SOURCE_KINDS: readonly SourceKind[] = ["native-memory"];
export const ACTIVITY_PASS_EXCLUDED_LAYERS: readonly Layer[] = ["personal"];
export const ACTIVITY_PASS_LIMIT = 4;
/** collector launcher.ts MAX_CODE_DOCS / MAX_PRODUCT_DOCS defaults. */
export const MAX_CODE_DOCS = 3;
export const MAX_PRODUCT_DOCS = 3;
/** The search route's agent-path result cap. */
export const SEARCH_RESULT_LIMIT = 5;

export interface SurfaceContext {
  db: Database;
  embeddingProvider: EmbeddingProvider | null;
  projects: readonly ProjectSpec[];
  /** The resolved requesting user (the tunnel identity). */
  user: string;
  /** collector hostUserAlias(): the host user unowned home mirrors belong to. */
  hostUser: string;
  now: Date;
  /** `project/slug` → content key (see Hit.contentKey). */
  contentKeyOf(ref: string): string;
  /** Ordering-score weights every surface's search uses; unset = the resolved defaults. */
  rankWeights?: Partial<RankWeights>;
}

/** collector `projects-registry.ts` relatedProjects over the fixture's project specs. */
export function relatedProjects(projectId: string, all: readonly ProjectSpec[]): string[] {
  const self = all.find((p) => p.id === projectId);
  if (projectId === "scratch" || projectId === GLOBAL_PROJECT_ID || self?.reserved) return [];
  const excluded = new Set([projectId, "scratch", GLOBAL_PROJECT_ID]);
  const listed = new Set(self?.related ?? []);
  const related = new Set<string>();
  for (const other of all) {
    if (excluded.has(other.id) || other.reserved) continue;
    const prefixFamily = other.id.startsWith(`${projectId}-`) || projectId.startsWith(`${other.id}-`);
    if (prefixFamily || listed.has(other.id) || (other.related ?? []).includes(projectId)) related.add(other.id);
  }
  return [...related].sort();
}

/** collector `projects-registry.ts` MIRROR_PROJECTS, from the fixture specs' `mirrorOf`. */
export function mirrorProjectsOf(all: readonly ProjectSpec[]): MirrorProjects {
  const mirrors: Record<string, string> = {};
  for (const p of all) if (p.mirrorOf) mirrors[p.id] = p.mirrorOf;
  return mirrors;
}

/**
 * LocalMarkdownBackend.search (knowledge `backend.ts`), which the search route
 * calls: searchKnowledge with the graph-rerank neighbor index supplied only
 * when the rerank is on, and the registry's mirror projects.
 */
function backendSearch(ctx: SurfaceContext, projectId: string, query: string, options: SearchOptions): Promise<SearchResult[]> {
  const graphRerankOn = options.graphRerank ?? GRAPH_RERANK_ENABLED;
  const graphNeighbors =
    options.graphNeighbors ?? (graphRerankOn ? memoizedSemanticNeighborIndex(new KnowledgeStore(ctx.db)) : undefined);
  return searchKnowledge(
    ctx.db,
    projectId,
    query,
    ctx.embeddingProvider,
    { ...options, graphNeighbors, rankWeights: ctx.rankWeights, mirrorProjects: mirrorProjectsOf(ctx.projects) },
    {}
  );
}

function toHit(ctx: SurfaceContext, r: SearchResult, extra: Partial<Hit> = {}): Hit {
  const ref = `${r.projectId}/${r.slug}`;
  return {
    ref,
    contentKey: ctx.contentKeyOf(ref),
    ...(r.relevance !== undefined ? { relevance: r.relevance } : {}),
    score: r.score,
    ...extra,
  };
}

/** The search route's annotated, demoted, confidence-split agent result (see the module header). */
async function searchRoute(ctx: SurfaceContext, projectId: string, query: string): Promise<Hit[]> {
  const relatedIds = relatedProjects(projectId, ctx.projects);
  const personalAllowed = projectId === GLOBAL_PROJECT_ID;
  const excludeLayers: Layer[] = personalAllowed ? [] : ["personal"];
  const audience: ScopeAudience = {
    projectId,
    user: ctx.user,
    hostUser: ctx.hostUser,
    relatedProjectIds: relatedIds,
    ...(excludeLayers.length > 0 ? { excludeLayers } : {}),
  };
  const results = await backendSearch(ctx, projectId, query, {
    corpus: "all",
    audience,
    owners: undefined,
    confidentFor: "search",
    lowConfidenceLimit: 0,
  });
  const freshness = decayOnlyFreshnessGate(ctx.db, ctx.now);
  const annotated = results.map((r) => {
    const injectionEligible =
      isOriginEligibleForInjection(r.originClass) && isVerdictAdmissible(r, "inject") && freshness.eligible(r);
    const staleSince = freshness.staleSince(r)?.slice(0, 10);
    return {
      result: r,
      projectId: r.projectId,
      confident: isConfident(r, "search"),
      layer: layerOf(r),
      marked:
        r.verdict === "disputed" ||
        r.verdict === "contradicted" ||
        r.verdict === "superseded" ||
        !injectionEligible ||
        !!staleSince,
      staleSince,
    };
  });
  const demoted = demoteStale(annotated, (a) => a.staleSince);
  return demoted
    .filter((a) => a.confident)
    .slice(0, SEARCH_RESULT_LIMIT)
    .map((a) => toHit(ctx, a.result, { confident: true, marked: a.marked }));
}

/** search_knowledge from an agent session in `projectId`. */
export function runSearch(ctx: SurfaceContext, projectId: string, query: string): Promise<Hit[]> {
  return searchRoute(ctx, projectId, query);
}

/** Persona's `recall` tool. */
export function runRecall(ctx: SurfaceContext, query: string): Promise<Hit[]> {
  return searchRoute(ctx, GLOBAL_PROJECT_ID, query);
}

async function retrieveKnowledgeOfKinds(
  ctx: SurfaceContext,
  projectId: string,
  plan: InjectionPlan,
  kinds: readonly SourceKind[],
  maxDocs: number,
  reach: { excludeForeignIntent: boolean; activity: boolean },
  audience: ScopeAudience
): Promise<SearchResult[]> {
  try {
    const base: ScopeAudience = { ...audience, ...(reach.excludeForeignIntent ? { excludeForeignIntent: true } : {}) };
    const search = (query: string, sourceKinds: readonly SourceKind[], excludeLayers: readonly Layer[], limit: number) =>
      searchKnowledge(ctx.db, projectId, query, ctx.embeddingProvider, {
        corpus: "all",
        limit,
        sourceKinds,
        audience: { ...base, excludeLayers },
        confidentFor: "inject",
        rankWeights: ctx.rankWeights,
        mirrorProjects: mirrorProjectsOf(ctx.projects),
      });
    const perQuery: SearchResult[][] = [];
    for (const query of plan.queries) {
      const hits = await search(query, kinds, INJECTION_EXCLUDED_LAYERS, Math.max(maxDocs * 4, 12));
      const activity = reach.activity
        ? await search(query, ACTIVITY_SOURCE_KINDS, ACTIVITY_PASS_EXCLUDED_LAYERS, ACTIVITY_PASS_LIMIT)
        : [];
      perQuery.push(mergeActivityHits(hits, activity));
    }
    const results = fuseInjectionResults(perQuery);
    const freshness = decayOnlyFreshnessGate(ctx.db, ctx.now);
    const store = new KnowledgeStore(ctx.db);
    const tagsOf = (r: SearchResult) => store.getDoc(r.projectId, r.slug)?.tags;
    // A disputed doc skips the freshness gate and stale demotion: its low
    // confidence is the dispute's write-down, already counted by its verdict.
    const staleSince = (r: SearchResult) => (r.verdict === "disputed" ? undefined : freshness.staleSince(r));
    const admitted = results.filter(
      (r) =>
        (kinds.includes(r.sourceKind) || (reach.activity && layerOf(r) === "activity")) &&
        isConfident(r, "inject") &&
        foreignIntentAdmissible(r, projectId) &&
        injectionPlanGate(r, plan, ctx.now, tagsOf) === null &&
        isOriginEligibleForInjection(r.originClass) &&
        isVerdictAdmissible(r, "inject") &&
        (r.verdict === "disputed" || freshness.eligible(r))
    );
    return demoteStale(admitted, staleSince).slice(0, maxDocs);
  } catch {
    return [];
  }
}

/** The docs launch injection puts into a task's opening prompt: the code block, then the product/spec block. */
export async function runInject(ctx: SurfaceContext, projectId: string, brief: string): Promise<{ code: Hit[]; product: Hit[] }> {
  const audience: ScopeAudience = {
    projectId,
    user: ctx.user,
    relatedProjectIds: relatedProjects(projectId, ctx.projects),
  };
  const plan = planInjection(brief);
  const [code, product] = await Promise.all([
    retrieveKnowledgeOfKinds(ctx, projectId, plan, CODE_KNOWLEDGE_KINDS, MAX_CODE_DOCS, { excludeForeignIntent: false, activity: true }, audience),
    retrieveKnowledgeOfKinds(ctx, projectId, plan, PRODUCT_KNOWLEDGE_KINDS, MAX_PRODUCT_DOCS, { excludeForeignIntent: true, activity: false }, audience),
  ]);
  return { code: code.map((r) => toHit(ctx, r)), product: product.map((r) => toHit(ctx, r)) };
}

/** One hook firing: the query it searched and the docs it pushed, in order. */
export interface PushInstance {
  event: PushEvent;
  query: string;
  hits: Hit[];
}

/**
 * Knowledge a hook pushes into a worker's context without the worker asking:
 * SessionStart (the brief), UserPromptSubmit (each query typed as a prompt), and
 * the first Edit/Write in each file area of the task's `paths`. An
 * implementation returns each firing's pushes; `seen` is the session's dedup
 * set (the launch's injected docs, then every earlier push), which it extends.
 * `bar` overrides PUSH_RELEVANCE_BAR for the eval's calibration sweep.
 */
export interface PushSurface {
  event: PushEvent;
  run(ctx: SurfaceContext, task: UsefulnessTask, seen: Set<string>, bar?: number): Promise<PushInstance[]>;
}

/** The repo root a fixture task's `paths` are relative to; the simulated session's cwd. */
export const PUSH_FIXTURE_CWD = "/repo";

/**
 * collector `knowledge-push.ts` pushFor: the push search (pushSearchOptions over
 * the agent audience, through the backend), then selectPushDocs with the
 * freshness gate (eligible and not stale) and the session's seen set, then the
 * formatter's char budget. What the block carries is added to `seen`.
 */
async function pushOnce(
  ctx: SurfaceContext,
  event: PushEvent,
  projectId: string,
  query: string,
  seen: Set<string>,
  bar?: number
): Promise<PushInstance> {
  const audience: ScopeAudience = { projectId, relatedProjectIds: relatedProjects(projectId, ctx.projects) };
  const results = await backendSearch(ctx, projectId, query, pushSearchOptions(audience));
  const freshness = decayOnlyFreshnessGate(ctx.db, ctx.now);
  const picked = selectPushDocs(results, event, {
    projectId,
    seen,
    fresh: (r) => freshness.eligible(r) && !freshness.staleSince(r),
    ...(bar !== undefined ? { bar } : {}),
  });
  const { included } = formatPushBlock(event, picked);
  for (const r of included) seen.add(pushRef(r));
  return { event, query, hits: included.map((r) => toHit(ctx, r)) };
}

/** Registered push surfaces, in the order a session fires them. */
export const PUSH_SURFACES: PushSurface[] = [
  {
    event: "SessionStart",
    async run(ctx, task, seen, bar) {
      const query = pushSessionStartQuery({ brief: task.brief });
      return query ? [await pushOnce(ctx, "SessionStart", task.project, query, seen, bar)] : [];
    },
  },
  {
    event: "UserPromptSubmit",
    async run(ctx, task, seen, bar) {
      const out: PushInstance[] = [];
      for (const q of task.queries) {
        const query = pushPromptQuery(q.query);
        if (query) out.push(await pushOnce(ctx, "UserPromptSubmit", q.project ?? task.project, query, seen, bar));
      }
      return out;
    },
  },
  {
    event: "PreToolUse",
    async run(ctx, task, seen, bar) {
      const out: PushInstance[] = [];
      const areas = new Set<string>();
      for (const path of task.paths ?? []) {
        const { area, query } = pushAreaQuery(`${PUSH_FIXTURE_CWD}/${path}`, PUSH_FIXTURE_CWD);
        if (areas.has(area)) continue;
        areas.add(area);
        out.push(await pushOnce(ctx, "PreToolUse", task.project, query, seen, bar));
      }
      return out;
    },
  },
];
