import { homedir } from "os";
import { join } from "path";
import { mkdirSync } from "fs";
import type { Database } from "bun:sqlite";
import {
  getProjects,
  getSetting,
  setSetting,
  getTaskRuns,
  getEventsSince,
  headSeq,
  getSessionInjectedDocs,
  type LaunchInjectedDoc,
} from "@standup/store";
import type { Project, TaskRun, TranscriptEvent } from "@standup/shared";
import {
  DEFAULT_HALF_LIFE_DAYS,
  MAX_TAGS,
  draftFileExists,
  isValidSlug,
  loadPersonalFingerprint,
  withholdPersonalDraft,
  LocalMarkdownBackend,
  type KnowledgeBackend,
  type KnowledgeDraftInput,
  type KnowledgeDocFile,
  type SourceKind,
  type SearchResult,
  type SearchOptions,
  type EmbeddingProvider,
  type EmbeddingConfig,
} from "@standup/knowledge";
import { primaryRepoPath, resolveHeadSha } from "./knowledge-staleness.js";
import { ensureInternalCwd, internalRoot } from "./internal-cwd.js";
import { headlessSettingsArgs } from "./claude-cli.js";
import { withoutSlotEnv } from "./worker-env.js";
import { stripPlaybooks } from "./persona/playbook.js";
import { stripOwnerPreferences } from "./persona/preferences-block.js";
import { findNearestDocs } from "./knowledge-dedup.js";
import { UNVERIFIED_CONFIDENCE } from "./draft-verify.js";
import { deferForHostPressure } from "./host-headroom.js";

/**
 * Self-growing knowledge — the auto-distillation half of taking the
 * knowledge base from grow-able to growing.
 *
 * Once a session's task_run reaches terminal SUCCESS, a Haiku distiller reads
 * the session's transcript_events and proposes a candidate knowledge DRAFT via
 * the KnowledgeBackend seam, stamped `origin_class='agent'` with the run's
 * `generatedFromSha` + `sourceSessionId`, tags + `related` edges derived from
 * the files/projects the session touched. Human accept stays in the loop — a
 * draft is invisible to search and injection until a human accepts it — and the
 * adversarial draft-verify pass fact-checks it in the background, exactly the
 * two gates the interactive `propose_knowledge` path already relies on.
 *
 * Near-duplicate detection at draft time keeps auto-ingest from bloating the
 * corpus: before writing, the candidate is searched against the ACCEPTED corpus
 * (the embedding-backed hybrid search — search only ever returns accepted docs),
 * and a near-identical hit suppresses the draft rather than adding a redundant
 * one.
 *
 * The scheduler mirrors review-cron.ts / knowledge-reverify.ts exactly: a plain
 * interval with a per-run once-only settings gate, because the collector is a
 * local-first process that may not run continuously — "has this run been
 * distilled yet?" is the honest question, not "fire on the SessionEnd event"
 * (which a restart would miss). Gated on the same `dailyReviewActive` opt-in the
 * other two background agent passes use: all three spawn `claude` over the
 * user's own data, so one opt-in governs the resource use.
 */

const DISTILL_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_INTERVAL_MS = 3_600_000; // 1h poll
/** Per-distill `claude` cap. */
const DISTILL_TIMEOUT_MS = 8 * 60 * 1000;
/** Max sessions distilled per tick — bounds `claude` spawns; the rest wait for
 *  the next poll (their gate has not been recorded, so they are retried). */
const MAX_PER_TICK = 4;
/** How much of the (tail of the) transcript is fed to the distiller. */
const MAX_TRANSCRIPT_CHARS = 60_000;
/**
 * Max transcript records pulled for a session. Fetched from the TAIL of the log
 * (see distillTick) — a session's distillable conclusions (the final summary,
 * the fix that worked) land LAST, so for a session longer than this we want its
 * end, not its exploratory beginning. renderTranscript then char-truncates that
 * window to MAX_TRANSCRIPT_CHARS, also keeping the tail.
 */
const MAX_TRANSCRIPT_EVENTS = 5000;
/** Largest injected doc body shown to the distiller as an update target. */
const MAX_INJECTED_DOC_CHARS = 12_000;
/** Total injected doc chars per prompt; with MAX_TRANSCRIPT_CHARS it stays under
 *  the 128 KiB single-argument limit for mostly-ASCII text. */
const MAX_INJECTED_TOTAL_CHARS = 24_000;
/** Doc kinds kept by their own writers, never replaced by a distilled draft. */
const NOT_DISTILLED_KINDS: ReadonlySet<SourceKind> = new Set(["native-memory", "playbook"]);

export {
  NEAR_DUP_THRESHOLD,
  NEAR_DUP_LEXICAL_THRESHOLD,
  NEAR_DUP_CONTAINMENT_THRESHOLD,
  NEAR_DUP_SIZE_RATIO_FLOOR,
  isLexicalNearDup,
} from "./knowledge-dedup.js";

/**
 * The reserved cwd the distiller runs from — never a real checkout. Standup's
 * hooks are global (see internal-cwd.ts), so a subprocess running inside the
 * repo would register as an ordinary session and feed its own events back to
 * the collector. It is handed the repo via --add-dir and reads absolute paths
 * from here instead. Lives under the reserved internal root so isInternalCwd()
 * covers it.
 */
const DISTILL_CRON_CWD = join(internalRoot(), "distill");

const DIFF_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/** Settings key marking a run as already distilled (write-once gate). */
function distilledKey(runId: string): string {
  return `knowledge_distill_done:${runId}`;
}

/** The distilled content a distiller produces from a transcript. */
export interface DistilledDraft {
  slug: string;
  title: string;
  body: string;
  tags?: string[];
}

/** What the distiller is handed about the completed session. */
export interface DistillInput {
  run: TaskRun;
  /** The rendered transcript (tail-truncated to MAX_TRANSCRIPT_CHARS). */
  transcript: string;
  /** Absolute file paths the session edited. */
  touchedFiles: string[];
  /** Project ids owning those files. */
  touchedProjectIds: string[];
  /** Accepted docs of the run's project that were injected into the session's
   *  brief — the first candidates to update when the session proved one wrong. */
  injectedDocs: Array<{ slug: string; title: string; body: string }>;
}

/**
 * The side effects distillSession needs, injected so the distillation logic is
 * testable without spawning `claude`, a real backend, or a database.
 */
export interface DistillDeps {
  /** Runs the LLM distiller; returns the draft content, or null when the agent
   *  judged the session not worth distilling (nothing durable to capture). */
  distill(input: DistillInput): Promise<DistilledDraft | null>;
  /** Corpus search for near-duplicate detection AND `related`-edge derivation —
   *  the KnowledgeBackend seam's read side (reuses the embedding index). */
  search(projectId: string, query: string, options?: SearchOptions): Promise<SearchResult[]>;
  /** Ground-truth read of an accepted doc — powers the replaces-slug data-loss
   *  gate and the lexical near-dup comparison (needs the doc's full body, which
   *  a SearchResult excerpt does not carry). The seam's authoritative read. */
  readAcceptedDoc(projectId: string, slug: string): Promise<KnowledgeDocFile | null>;
  /** Whether search fuses an embedding arm (undefined reads as yes); without
   *  one, near-dup detection runs on token overlap alone. */
  embeddingsEnabled?: boolean;
  /** The KnowledgeBackend seam's write side. */
  writeDraft(projectId: string, draft: KnowledgeDraftInput): Promise<void>;
  /** Whether a review draft is already pending at the slug; one is never
   *  overwritten (it may hold an agent's correction or a human's edit). */
  draftExists?(projectId: string, slug: string): boolean;
  now?: () => Date;
}

export type DistillOutcome =
  | { status: "proposed"; slug: string; title: string; body: string }
  | { status: "suppressed-dup"; slug: string; dupSlug: string; score: number }
  | { status: "pending-draft"; slug: string }
  | { status: "empty" }
  | { status: "invalid"; reason: string };

/** `project.repos` with `~` expanded to the home dir. */
function projectRepoPaths(project: Project): string[] {
  return project.repos.map((r) => r.replace(/^~/, homedir()));
}

/** Whether `file` sits inside `base` (equal, or under it as a directory). */
function isUnder(file: string, base: string): boolean {
  if (!base) return false;
  return file === base || file.startsWith(base.endsWith("/") ? base : base + "/");
}

/**
 * The absolute file paths the session edited, pulled from Edit/Write/MultiEdit/
 * NotebookEdit tool_use blocks in the transcript. Reads `file_path` (the tool's
 * input param) and `notebook_path` (NotebookEdit's). Deduped, order-stable.
 */
export function extractTouchedFiles(events: TranscriptEvent[]): string[] {
  const files = new Set<string>();
  for (const ev of events) {
    const rec = ev.event as { message?: { content?: unknown } } | null;
    const content = rec?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = block as { type?: string; name?: string; input?: Record<string, unknown> };
      if (b?.type !== "tool_use" || !b.name || !DIFF_TOOLS.has(b.name)) continue;
      const fp = b.input?.file_path ?? b.input?.notebook_path;
      if (typeof fp === "string" && fp) files.add(fp);
    }
  }
  return [...files];
}

/** The ids of every project owning at least one of the touched files. */
export function touchedProjectIds(touchedFiles: string[], projects: Project[]): string[] {
  const ids = new Set<string>();
  for (const project of projects) {
    const bases = projectRepoPaths(project);
    if (touchedFiles.some((f) => bases.some((base) => isUnder(f, base)))) {
      ids.add(project.id);
    }
  }
  return [...ids];
}

/**
 * Renders a session's transcript into plain text for the distiller: each
 * message as `role: text`, tool calls as a compact `[tool_use …]` line, any
 * owner-preferences block (preferences-block.ts) left out. Kept to
 * the TAIL when it overflows the budget — a session's conclusions (the final
 * summary, the fix that worked) are the distillable part, and they land last.
 */
export function renderTranscript(
  events: TranscriptEvent[],
  maxChars = MAX_TRANSCRIPT_CHARS
): string {
  const parts: string[] = [];
  for (const ev of events) {
    const rec = ev.event as { type?: string; message?: { role?: string; content?: unknown } } | null;
    const role = rec?.message?.role ?? rec?.type ?? "event";
    const content = rec?.message?.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .map((block) => {
          const b = block as {
            type?: string;
            text?: string;
            name?: string;
            input?: unknown;
            content?: unknown;
          };
          if (b?.type === "text" && typeof b.text === "string") return b.text;
          if (b?.type === "tool_use") {
            return `[tool_use ${b.name ?? "?"} ${JSON.stringify(b.input ?? {}).slice(0, 300)}]`;
          }
          if (b?.type === "tool_result") {
            const c = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
            return `[tool_result ${c.slice(0, 300)}]`;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    // A Persona brief's owner-preferences and playbook blocks are the
    // owner's personal layer, never material for a shared doc.
    text = stripPlaybooks(stripOwnerPreferences(text));
    if (text.trim()) parts.push(`${role}: ${text.trim()}`);
  }
  const joined = parts.join("\n\n");
  return joined.length > maxChars ? joined.slice(joined.length - maxChars) : joined;
}

/**
 * `related` edge targets (`projectId/slug`) linking the draft to the strongest
 * existing doc in each OTHER project the session touched — the graph compile
 * pass materializes these into cross-project edges once the draft is accepted.
 * Same-project links are left to the tag co-citation the draft already carries.
 */
async function deriveRelatedEdges(
  deps: DistillDeps,
  ownProjectId: string,
  query: string,
  touched: string[]
): Promise<string[]> {
  const related = new Set<string>();
  for (const pid of touched) {
    if (pid === ownProjectId) continue;
    const hits = await deps.search(pid, query, { corpus: "project", limit: 1 });
    if (hits[0]) related.add(`${hits[0].projectId}/${hits[0].slug}`);
  }
  return [...related];
}

/**
 * Distills one completed session into a candidate draft written through the
 * KnowledgeBackend seam, or reports why no draft was written. Pure of I/O
 * beyond its injected deps: the LLM call, the corpus search, and the draft
 * write are all deps, so the whole decision (provenance stamping, near-dup
 * suppression, edge derivation) is unit-testable.
 */
export async function distillSession(
  deps: DistillDeps,
  run: TaskRun,
  events: TranscriptEvent[],
  projects: Project[],
  headSha: string | null,
  /** The run project's docs injected into the session (getSessionInjectedDocs).
   *  Only that project's: the draft is written there, so updating another
   *  project's doc would fork its slug rather than replace it. */
  injected: LaunchInjectedDoc[] = []
): Promise<DistillOutcome> {
  const touchedFiles = extractTouchedFiles(events);
  const touched = touchedProjectIds(touchedFiles, projects);
  const transcript = renderTranscript(events);

  // Update targets: whole bodies only (an update replaces the whole doc, and the
  // distiller could not keep text it never saw), within a total budget that keeps
  // the `-p` argument under the OS limit. A personal doc never feeds a shared
  // draft, and a doc with a pending review draft is left to that draft.
  const injectedDocs: DistillInput["injectedDocs"] = [];
  let injectedChars = 0;
  for (const doc of injected) {
    if (deps.draftExists?.(run.projectId, doc.docSlug)) continue;
    const accepted = await deps.readAcceptedDoc(run.projectId, doc.docSlug);
    if (!accepted || accepted.scope === "user" || accepted.body.length > MAX_INJECTED_DOC_CHARS) continue;
    if (accepted.nativeMemoryFrom || NOT_DISTILLED_KINDS.has(accepted.sourceKind)) continue;
    if (injectedChars + accepted.body.length > MAX_INJECTED_TOTAL_CHARS) continue;
    injectedChars += accepted.body.length;
    injectedDocs.push({ slug: doc.docSlug, title: accepted.title, body: accepted.body });
  }

  const draft = await deps.distill({ run, transcript, touchedFiles, touchedProjectIds: touched, injectedDocs });
  if (!draft) return { status: "empty" };
  if (!isValidSlug(draft.slug) || !draft.title.trim() || !draft.body.trim()) {
    return { status: "invalid", reason: "distiller returned an unusable draft" };
  }
  if (deps.draftExists?.(run.projectId, draft.slug)) return { status: "pending-draft", slug: draft.slug };

  // Near-duplicate detection against the ACCEPTED corpus (search never returns
  // drafts) the project's agents can see — its own docs and scope=global ones:
  // a doc already covering this suppresses the draft rather than bloating the
  // corpus. The shared detector (knowledge-dedup.ts) reads raw cosine when an
  // embedding provider is configured and token overlap in every deployment.
  const candidateText = `${draft.title}\n${draft.body}`;
  const query = candidateText.slice(0, 2000);
  const nearest = await findNearestDocs(
    deps,
    run.projectId,
    { slug: draft.slug, title: draft.title, body: draft.body },
    { audience: { projectId: run.projectId } }
  );
  const dup = nearest.find((n) => n.duplicate);
  if (dup) {
    return { status: "suppressed-dup", slug: draft.slug, dupSlug: dup.slug, score: dup.similarity };
  }

  // Data-loss gate, identical to the interactive propose path (server.ts): a
  // distilled draft whose slug already names an ACCEPTED doc is a regenerate,
  // not a first write, so it must carry replacesSlug. Leaving it unset lets
  // accept / accept-all silently overwrite the human-authored doc via a plain
  // rename; setting it routes accept to a merge and holds the draft back from
  // accept-all until a human decides. Reads ground truth (readAcceptedDoc), not
  // the rebuildable index. This is DISTINCT from near-dup suppression above,
  // which keys off content similarity at any slug; here the slug itself collides.
  const collision = await deps.readAcceptedDoc(run.projectId, draft.slug);
  const replacesSlug = collision ? draft.slug : undefined;
  // The same guards as the update targets: a personal doc never takes a shared
  // draft, and a mirrored native memory or a playbook is maintained by its own
  // writer (a replacement would drop its marker and freeze it).
  if (collision && (collision.scope === "user" || collision.nativeMemoryFrom || NOT_DISTILLED_KINDS.has(collision.sourceKind))) {
    return { status: "invalid", reason: "slug names a doc the distiller never replaces" };
  }
  // A replacement keeps the doc's kind, tags, edges and half-life, so it stays
  // in the same injection kind and gates; only the body is the distiller's.
  const sourceKind = collision?.sourceKind ?? "code";

  // Edges derived from touched files/projects: tag the draft with every project
  // whose files the session edited (drives the graph's shared-tag co-citation),
  // and add explicit cross-project `related` links to their strongest docs.
  const tags = [...new Set([...(collision?.tags ?? []), ...(draft.tags ?? []), ...touched])].slice(0, MAX_TAGS);
  const related = [
    ...new Set([
      ...(Array.isArray(collision?.related) ? collision.related : []),
      ...(await deriveRelatedEdges(deps, run.projectId, query, touched)),
    ]),
  ];

  const nowIso = (deps.now?.() ?? new Date()).toISOString();
  await deps.writeDraft(run.projectId, {
    slug: draft.slug,
    title: draft.title.trim(),
    body: draft.body,
    tags: tags.length ? tags : undefined,
    related: related.length ? related : undefined,
    replacesSlug,
    // Provenance: the run's project HEAD + authoring session, stamped by the
    // collector (never the agent) exactly as the interactive propose path does.
    // An agent distilled it: 'agent', never the fail-closed 'untrusted' default,
    // so it is auto-injection-eligible once accepted. Confidence bookkeeping
    // matches propose_knowledge: unverified until its fact-check passes (the
    // draft's own check, or the one run when it is accepted); the replaced doc's
    // half-life, else the default.
    generatedFromSha: headSha ?? undefined,
    generatedAt: nowIso,
    sourceSessionId: run.sessionId,
    originClass: "agent",
    sourceKind,
    confidence: UNVERIFIED_CONFIDENCE,
    halfLifeDays: collision?.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS,
  });

  return { status: "proposed", slug: draft.slug, title: draft.title.trim(), body: draft.body };
}

/** The distiller prompt: capture durable, reusable knowledge, not a task log. */
export function distillPrompt(input: DistillInput): string {
  const touched =
    input.touchedFiles.length > 0
      ? input.touchedFiles.slice(0, 40).map((f) => `- ${f}`).join("\n")
      : "(none recorded)";
  const injected =
    input.injectedDocs.length > 0
      ? input.injectedDocs
          .map((d) => `--- slug: ${d.slug} | title: ${d.title}\n${d.body}`)
          .join("\n\n")
      : "(none)";
  return `You are distilling a COMPLETED, successful coding session into ONE reusable knowledge document for this project's knowledge base — durable facts a future engineer or agent would want: a decision and its rationale, a non-obvious gotcha and its fix, how a subsystem actually works. NOT a narrative of what happened this session, NOT a task summary, NOT anything that will be stale next week.

Rules:
- Lessons, not logs: write what a future agent should know, never what this session did.
- Nothing to save is a fine outcome: skip unless the session taught something durable and new.
- Prefer, in this order: (1) update the injected doc below that the session showed wrong, stale or incomplete, reusing its slug; (2) otherwise extend an injected doc below that covers a related subject, reusing its slug; (3) only then draft a new doc under a new slug.
- An update replaces the whole doc: keep everything in it that is still true and change only what the session proved.

Docs of project "${input.run.projectId}" injected into the session's brief (full text):
${injected}

Files the session edited:
${touched}

Transcript (may be truncated to the tail):
"""
${input.transcript}
"""

Reply with ONLY a JSON object and nothing else:
{"slug":"kebab-case-id","title":"Short title","body":"Markdown body","tags":["tag1","tag2"]}

The slug must be lowercase letters, numbers and hyphens only. If the session produced nothing durable enough to be worth a permanent knowledge doc, reply with exactly {"skip":true} instead.`;
}

/** Pulls the first balanced top-level JSON object out of a string. Claude's
 *  `--output-format json` result is the agent's final text, which should be the
 *  JSON object we asked for — but may carry stray prose around it. */
function extractJsonObject(text: string): unknown | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Parses a `claude --output-format json` run into a candidate draft, or null
 * when the reply carries no usable draft. Two unwraps, because Haiku's JSON is
 * DOUBLE-wrapped: the CLI envelope (`{result, is_error, …}`) whose `result` is
 * the agent's final text, which is itself the `{slug,title,body,tags}` object we
 * asked for — possibly with prose or a ```json fence around it, which
 * extractJsonObject tolerates by scanning to the first balanced object. An
 * errored envelope, a `{skip:true}` decline, or a reply missing the string
 * fields all resolve to null. Slug SHAPE is validated downstream (distillSession's
 * isValidSlug) so a non-kebab slug becomes an "invalid" outcome, not a silent
 * drop here. Pure and exported so this brittle real-model parse path is
 * deterministically tested against realistic Haiku output, not only mocked.
 */
export function parseDistillerOutput(stdout: string): DistilledDraft | null {
  const envelope = extractJsonObject(stdout) as { result?: string; is_error?: boolean } | null;
  if (!envelope || envelope.is_error || typeof envelope.result !== "string") return null;
  const parsed = extractJsonObject(envelope.result) as
    | { skip?: boolean; slug?: string; title?: string; body?: string; tags?: unknown }
    | null;
  if (!parsed || parsed.skip) return null;
  if (typeof parsed.slug !== "string" || typeof parsed.title !== "string" || typeof parsed.body !== "string") {
    return null;
  }
  return {
    slug: parsed.slug,
    title: parsed.title,
    body: parsed.body,
    tags: Array.isArray(parsed.tags) ? parsed.tags.filter((t): t is string => typeof t === "string") : undefined,
  };
}

/**
 * The production distiller: spawns a read-only Haiku `claude` over the added
 * repo dir with the transcript in the prompt, and parses its JSON reply. Same
 * trust level and setting-source handling as review-cron.ts's lens agents.
 * Never throws — a failed/timed-out distill resolves to null (nothing written).
 */
export async function runClaudeDistiller(
  input: DistillInput,
  repoPath: string | null
): Promise<DistilledDraft | null> {
  const args = [
    "claude",
    "-p",
    distillPrompt(input),
    "--model",
    DISTILL_MODEL,
    // Non-interactive; nobody is here to answer a prompt. Read-only tool list.
    "--permission-mode",
    "bypassPermissions",
    // Drop the user setting source so global hooks never fire — otherwise this
    // subprocess registers as a phantom session in Standup's own feed.
    "--setting-sources",
    "project",
    ...headlessSettingsArgs(),
    "--strict-mcp-config",
    "--allowedTools",
    "Read,Grep,Glob",
    "--output-format",
    "json",
  ];
  if (repoPath) args.push("--add-dir", repoPath);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = Bun.spawn(args, {
      cwd: DISTILL_CRON_CWD,
      stdout: "pipe",
      stderr: "pipe",
      env: withoutSlotEnv(),
    });
    timer = setTimeout(() => proc.kill(), DISTILL_TIMEOUT_MS);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    if (proc.exitCode !== 0) return null;
    return parseDistillerOutput(stdout);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Injected side effects the tick performs around a proposed draft. */
export interface DistillTickDeps {
  /** Builds the LLM distiller for a run's repo (production spawns `claude`). */
  makeDistiller: (repoPath: string | null) => DistillDeps["distill"];
  backend: KnowledgeBackend;
  /** Reconciles knowledge_drafts to the newly-written file on disk. */
  syncDrafts: (projectId: string) => Promise<void>;
  draftExists?: DistillDeps["draftExists"];
  /** Background adversarial fact-check of the proposed draft (fire-and-forget),
   *  mirroring the interactive propose path. Optional. */
  verify?: (projectId: string, slug: string, body: string, repoPath: string) => void;
  /** Pushes the new draft to connected clients. Optional. */
  broadcast?: (projectId: string, slug: string, title: string) => void;
  maxPerTick?: number;
}

/**
 * One scheduler tick: for every succeeded, not-yet-distilled run in an opted-in
 * project (bounded by maxPerTick), distill its session and record the gate. A
 * transient failure leaves the gate unset so the run retries next tick; every
 * terminal outcome (proposed / suppressed / pending-draft / empty / invalid) records it so a
 * session is distilled at most once.
 */
export async function distillTick(
  db: Database,
  deps: DistillTickDeps
): Promise<void> {
  const projects = getProjects(db);
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const optedIn = new Set(projects.filter((p) => p.dailyReviewActive).map((p) => p.id));

  const candidates = getTaskRuns(db).filter(
    (r) =>
      r.status === "succeeded" &&
      r.sessionId &&
      optedIn.has(r.projectId) &&
      getSetting(db, distilledKey(r.id)) === null
  );

  const maxPerTick = deps.maxPerTick ?? MAX_PER_TICK;
  let done = 0;
  for (const run of candidates) {
    if (done >= maxPerTick) break;
    const project = projectById.get(run.projectId);
    if (!project) continue;
    const repoPath = primaryRepoPath(project);

    try {
      // Fetch the TAIL: getEventsSince returns seqs > sinceSeq ascending, so
      // anchoring sinceSeq at head-N yields the last N records (the session's
      // conclusions), not its head. head === 0 (no events) leaves sinceSeq 0 and
      // returns empty, handled just below.
      const head = headSeq(db, run.sessionId!);
      const sinceSeq = Math.max(0, head - MAX_TRANSCRIPT_EVENTS);
      const events = getEventsSince(db, run.sessionId!, sinceSeq, MAX_TRANSCRIPT_EVENTS).events;
      if (events.length === 0) {
        // Nothing to distill; consume the run so it stops being a candidate.
        setSetting(db, distilledKey(run.id), new Date().toISOString());
        continue;
      }
      const headSha = repoPath ? await resolveHeadSha(repoPath) : null;
      const distillDeps: DistillDeps = {
        distill: deps.makeDistiller(repoPath),
        search: (projectId, query, options) => deps.backend.search(projectId, query, options),
        readAcceptedDoc: (projectId, slug) => deps.backend.readAcceptedDoc(projectId, slug),
        embeddingsEnabled: deps.backend.embeddingsEnabled,
        writeDraft: (projectId, draft) => deps.backend.writeDraft(projectId, withholdPersonalDraft(draft, loadPersonalFingerprint(db))),
        draftExists: deps.draftExists,
      };
      const injected = getSessionInjectedDocs(db, run.sessionId!, run.projectId);
      const outcome = await distillSession(distillDeps, run, events, projects, headSha, injected);
      if (outcome.status === "proposed") {
        await deps.syncDrafts(run.projectId);
        deps.broadcast?.(run.projectId, outcome.slug, outcome.title);
        if (repoPath) deps.verify?.(run.projectId, outcome.slug, outcome.body, repoPath);
        console.log(`[distill-cron] ${run.projectId}/${outcome.slug}: proposed from run ${run.id}`);
      } else if (outcome.status === "suppressed-dup") {
        console.log(
          `[distill-cron] ${run.projectId}: run ${run.id} suppressed (near-dup of ${outcome.dupSlug}, score ${outcome.score.toFixed(2)})`
        );
      } else if (outcome.status === "pending-draft") {
        console.log(`[distill-cron] ${run.projectId}/${outcome.slug}: run ${run.id} skipped (a review draft is already pending)`);
      } else {
        console.log(`[distill-cron] ${run.projectId}: run ${run.id} produced no draft (${outcome.status})`);
      }
      // Terminal outcome: record the gate so this run is distilled at most once.
      setSetting(db, distilledKey(run.id), new Date().toISOString());
      done++;
    } catch (err) {
      // Leave the gate unset — a transient failure (spawn error, git hiccup)
      // should retry on the next tick rather than silently drop the session.
      console.error(`[distill-cron] ${run.projectId}: run ${run.id} failed:`, err);
    }
  }
}

export interface DistillCronOptions {
  /** Poll interval; env STANDUP_KNOWLEDGE_DISTILL_INTERVAL_MS overrides. */
  intervalMs?: number;
  embeddingProvider?: EmbeddingProvider | null;
  embeddingConfig?: EmbeddingConfig;
  knowledgeDir: string;
  syncDrafts: (projectId: string) => Promise<void>;
  verify?: (projectId: string, slug: string, body: string, repoPath: string) => void;
  broadcast?: (projectId: string, slug: string, title: string) => void;
}

/**
 * Start the self-growing knowledge distiller. Returns the interval timer so the
 * caller can clearInterval it on shutdown, mirroring the reaper and the other
 * two crons. Constructs its own LocalMarkdownBackend over the shared db so the
 * whole write goes through the KnowledgeBackend seam.
 */
export function startDistillCron(
  db: Database,
  opts: DistillCronOptions
): ReturnType<typeof setInterval> {
  const intervalMs =
    opts.intervalMs ??
    parseInt(
      process.env.STANDUP_KNOWLEDGE_DISTILL_INTERVAL_MS ?? String(DEFAULT_INTERVAL_MS)
    );

  mkdirSync(DISTILL_CRON_CWD, { recursive: true });
  ensureInternalCwd(DISTILL_CRON_CWD);

  const backend = new LocalMarkdownBackend(
    db,
    opts.embeddingProvider ?? null,
    opts.embeddingConfig ?? {},
    opts.knowledgeDir
  );

  const deps: DistillTickDeps = {
    makeDistiller: (repoPath) => (input) => runClaudeDistiller(input, repoPath),
    backend,
    syncDrafts: opts.syncDrafts,
    draftExists: (projectId, slug) => draftFileExists(opts.knowledgeDir, projectId, slug),
    verify: opts.verify,
    broadcast: opts.broadcast,
  };

  // Fire a little after startup (let the server bind and the initial syncAll
  // settle), then on the interval.
  const kick = () => {
    // Each distill spawns a model; a host short on headroom skips this poll.
    if (deferForHostPressure("distill-cron")) return;
    distillTick(db, deps).catch((e) => console.error("[distill-cron]", e));
  };
  setTimeout(kick, 12_000);
  return setInterval(kick, intervalMs);
}
