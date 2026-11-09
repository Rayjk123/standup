import type { Database } from "bun:sqlite";
import { isAbsolute, join } from "path";
import {
  formatPushBlock,
  pushAreaQuery,
  pushEditTarget,
  pushPromptQuery,
  pushRef,
  pushSearchOptions,
  pushSessionStartQuery,
  selectPushDocs,
  PUSH_EXCLUDED_LAYERS,
  type KnowledgeStore,
  type PushEvent,
  type ScopeAudience,
  type SearchOptions,
  type SearchResult,
} from "@standup/knowledge";
import type { KnowledgePushSurface } from "@standup/shared";
import { getLaunchBySession, getProject, getProjects, getSession, getSessionSeenDocs } from "@standup/store";
import { hostUserAlias } from "./host-user.js";
import { docsAboutFile } from "./knowledge-code-mentions.js";
import { freshnessGate } from "./knowledge-freshness.js";
import { MIRROR_PROJECTS, relatedProjects } from "./projects-registry.js";
import { hitRecordFields, recordKnowledgeRetrievals } from "./retrieval-telemetry.js";

/**
 * Knowledge Standup pushes into a Claude Code session through its hooks,
 * without waiting for the agent to search: SessionStart (the launch brief, or
 * the project and session title), UserPromptSubmit (the prompt) and the first
 * Edit/Write/MultiEdit/NotebookEdit/apply_patch in each directory (the target
 * path). The selection — the queries, the relevance bar, the disputed /
 * stale / personal exclusions, the caps and the text — is the knowledge
 * package's push module; this module adds the search under a latency budget,
 * the per-session dedup read from knowledge_retrievals, and the telemetry row
 * per pushed doc (surface `push:<event>`), which getPushUptake joins against
 * later get_knowledge_doc fetches.
 *
 * Fail-open everywhere: a search past the budget, an error, or nothing clearing
 * the bar returns no context, and the hook answers as it would have without it.
 * Off with STANDUP_KNOWLEDGE_PUSH=0.
 *
 * A Codex worker posts no hooks, so its push rides the launch brief instead
 * (launchKnowledgePush, surface `push:launch`).
 */

/**
 * Hard server-side budget on one push, counted from the hook's arrival (so the
 * session/launch reads and the about-file lookup spend it too); past it the
 * hook gets no context.
 */
export const KNOWLEDGE_PUSH_BUDGET_MS = 250;

/** `0` turns every hook push off. */
export const KNOWLEDGE_PUSH_ENV = "STANDUP_KNOWLEDGE_PUSH";

/** Sessions whose edited directories are remembered for the once-per-area push. */
const MAX_TRACKED_SESSIONS = 1000;

export function isKnowledgePushEnvEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[KNOWLEDGE_PUSH_ENV]?.trim() !== "0";
}

/** The search a push runs: the knowledge backend's, or searchKnowledge bound to a provider. */
export type PushSearch = (projectId: string, query: string, options: SearchOptions) => Promise<SearchResult[]>;

/** One push: the hook event it answers, the injected text and the docs it names. */
export interface KnowledgePush {
  event: PushEvent;
  text: string;
  docs: SearchResult[];
}

/** The hook payload fields a push reads. */
export interface PushHookPayload {
  session_id?: string;
  hook_event_name?: string;
  cwd?: string;
  prompt?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
}

/** `promise`'s value, or null when it rejects or takes longer than `ms`. */
export async function withinBudget<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise.catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

interface PushRun {
  db: Database;
  search: PushSearch;
  /** performance.now() when the push began; the budget counts from here, before any lookup. */
  started: number;
  budgetMs: number;
  event: PushEvent;
  surface: KnowledgePushSurface;
  projectId: string;
  query: string;
  sessionId?: string;
  launchId?: string;
  /** Refs the agent already has; read after the search so concurrent pushes see each other's rows. */
  seen: () => ReadonlySet<string>;
  /** Hits ranked ahead of the search's: the docs naming the edited file. */
  pinned?: SearchResult[];
}

/**
 * One push's outcome. `settled` is false when the search ran out of budget or
 * failed, so the caller can try the same area again later; true when the
 * search answered (whether or not anything cleared the bar).
 */
interface PushOutcome {
  push: KnowledgePush | null;
  settled: boolean;
}

async function runPush(run: PushRun): Promise<PushOutcome> {
  const { started } = run;
  const audience: ScopeAudience = {
    projectId: run.projectId,
    relatedProjectIds: relatedProjects(run.projectId, getProjects(run.db)),
  };
  const remainingMs = run.budgetMs - (performance.now() - started);
  const searched =
    remainingMs > 0
      ? await withinBudget(
          run.search(run.projectId, run.query, pushSearchOptions(audience, MIRROR_PROJECTS)),
          remainingMs
        )
      : null;
  const settled = searched !== null;
  const results = [...(run.pinned ?? []), ...(searched ?? [])];
  if (results.length === 0) return { push: null, settled };
  // From here to the telemetry write nothing awaits, so a second push for the
  // same session (another hook, or the global hook's copy) cannot interleave
  // between reading the seen set and recording what this one pushed.
  const gate = freshnessGate(run.db);
  const picked = selectPushDocs(results, run.event, {
    projectId: run.projectId,
    seen: run.seen(),
    fresh: (r) => gate.eligible(r) && !gate.staleSince(r),
  });
  const { text, included } = formatPushBlock(run.event, picked);
  if (included.length === 0) return { push: null, settled };
  const latencyMs = performance.now() - started;
  try {
    recordKnowledgeRetrievals(
      run.db,
      included.map((r, rank) => ({
        docProject: r.projectId,
        docSlug: r.slug,
        query: run.query,
        rank,
        surface: run.surface,
        injected: true,
        queryProject: run.projectId,
        latencyMs,
        ...(run.sessionId ? { sessionId: run.sessionId } : {}),
        ...(run.launchId ? { launchId: run.launchId } : {}),
        ...hitRecordFields(r, null, hostUserAlias()),
      })),
      undefined
    );
  } catch (err) {
    console.error(`[knowledge-push] telemetry: ${String(err)}`);
  }
  return { push: { event: run.event, text, docs: included }, settled: true };
}

export interface KnowledgePusherDeps {
  db: Database;
  search: PushSearch;
  /** The docs naming a file (or a symbol defined in it), ranked ahead of the first-edit search. */
  aboutFile?: (projectId: string, path: string) => SearchResult[];
  /**
   * A line SessionStart's context always carries while the push is on, after
   * any pushed docs: the stale-steering correction (steering-staleness.ts).
   */
  sessionStartNotice?: string;
  budgetMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** `push` with `notice` appended, or a doc-less SessionStart push of the notice alone. */
function withSessionStartNotice(push: KnowledgePush | null, notice: string | undefined): KnowledgePush | null {
  if (!notice) return push;
  if (!push) return { event: "SessionStart", text: notice, docs: [] };
  return { ...push, text: `${push.text}\n\n${notice}` };
}

/**
 * The aboutFile lookup over the doc→code mentions (docsAboutFile): docs that
 * name the file or a symbol defined in it, as named hits (relevance 1), within
 * the push audience. A doc naming only a sibling file, or one whose mentions no
 * longer resolve in the code, is left out. Reads the mentions table as the
 * indexer pass last left it: a refresh is too slow for the hook path.
 */
export function aboutFilePushHits(store: KnowledgeStore, db: Database): (projectId: string, path: string) => SearchResult[] {
  return (projectId, path) => {
    const projects = getProjects(db);
    const audience: ScopeAudience = {
      projectId,
      relatedProjectIds: relatedProjects(projectId, projects),
      excludeLayers: PUSH_EXCLUDED_LAYERS,
      excludeForeignIntent: true,
    };
    const repos = projects.find((p) => p.id === projectId)?.repos ?? [];
    const { docs } = docsAboutFile(store, {
      projectId,
      path,
      audience,
      repos,
      limit: ABOUT_FILE_PUSH_LIMIT,
      refresh: false,
    });
    const hits: SearchResult[] = [];
    for (const d of docs) {
      if (d.match === "directory" || (d.missingMentions?.length ?? 0) > 0) continue;
      const doc = store.getDocById(d.id);
      if (!doc) continue;
      hits.push({
        id: doc.id,
        projectId: doc.projectId,
        slug: doc.slug,
        title: doc.title,
        excerpt: d.excerpt,
        score: 1,
        relevance: 1,
        source: "text",
        originClass: doc.originClass ?? "untrusted",
        sourceKind: doc.sourceKind ?? "unclassified",
        generated: !!doc.generatedFromSha,
        ...(doc.scope ? { scope: doc.scope } : {}),
        ...(doc.confidence !== undefined ? { confidence: doc.confidence } : {}),
        ...(doc.lastVerifiedAt ? { lastVerifiedAt: doc.lastVerifiedAt } : {}),
        ...(doc.halfLifeDays !== undefined ? { halfLifeDays: doc.halfLifeDays } : {}),
        ...(doc.verdict ? { verdict: doc.verdict } : {}),
      });
    }
    return hits;
  };
}

/** Docs the about-file lookup returns for one first-edit push, before the gate. */
const ABOUT_FILE_PUSH_LIMIT = 4;

export interface KnowledgePusher {
  /** The push for one hook event, or null when the event pushes nothing. */
  forHook(payload: PushHookPayload): Promise<KnowledgePush | null>;
  /** Drops a session's remembered edit areas. */
  forget(sessionId: string): void;
}

export function createKnowledgePusher(deps: KnowledgePusherDeps): KnowledgePusher {
  const { db } = deps;
  const budgetMs = deps.budgetMs ?? KNOWLEDGE_PUSH_BUDGET_MS;
  // Directories each session has already had its first-edit push for. In
  // memory only: after a restart an area may be searched once more, but the
  // doc dedup (knowledge_retrievals) still keeps a doc from being pushed twice.
  const areas = new Map<string, Set<string>>();

  function hasArea(sessionId: string, area: string): boolean {
    return areas.get(sessionId)?.has(area) ?? false;
  }

  function claimArea(sessionId: string, area: string): void {
    let mine = areas.get(sessionId);
    if (!mine) {
      if (areas.size >= MAX_TRACKED_SESSIONS) areas.delete(areas.keys().next().value!);
      mine = new Set();
      areas.set(sessionId, mine);
    }
    mine.add(area);
  }

  async function forHook(payload: PushHookPayload): Promise<KnowledgePush | null> {
    const started = performance.now();
    const sessionId = payload.session_id;
    const event = payload.hook_event_name;
    if (!sessionId || (event !== "SessionStart" && event !== "UserPromptSubmit" && event !== "PreToolUse")) return null;
    try {
      if (!isKnowledgePushEnvEnabled(deps.env)) return null;
      const session = getSession(db, sessionId);
      const projectId = session?.projectId ?? "scratch";
      const launch = getLaunchBySession(db, sessionId);
      let query: string | null = null;
      let pinned: SearchResult[] = [];
      // The first-edit area, claimed once its push lands or its search answers
      // below the bar; a search past the budget leaves it open for a later edit.
      let editArea: string | null = null;
      let notice: string | undefined;
      if (event === "SessionStart") {
        notice = deps.sessionStartNotice;
        const project = projectId === "scratch" ? null : getProject(db, projectId);
        query = pushSessionStartQuery({
          brief: launch?.task,
          projectName: project?.name,
          recentPrompt: session?.title || undefined,
        });
      } else if (event === "UserPromptSubmit") {
        // A launch's opening prompt is its brief, which SessionStart searched.
        const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
        if (launch?.task && prompt.includes(launch.task.trim())) return null;
        query = pushPromptQuery(prompt);
      } else {
        const target = pushEditTarget(payload.tool_name, payload.tool_input);
        if (!target) return null;
        const cwd = payload.cwd;
        const path = isAbsolute(target) || !cwd ? target : join(cwd, target);
        const area = pushAreaQuery(path, cwd);
        if (hasArea(sessionId, area.area)) return null;
        editArea = area.area;
        query = area.query;
        try {
          pinned = deps.aboutFile?.(projectId, path) ?? [];
        } catch (err) {
          console.error(`[knowledge-push] about-file ${sessionId.slice(0, 8)}: ${String(err)}`);
        }
      }
      if (!query) return withSessionStartNotice(null, notice);
      const outcome = await runPush({
        db,
        search: deps.search,
        started,
        budgetMs,
        event,
        surface: `push:${event}`,
        projectId,
        query,
        sessionId,
        ...(launch ? { launchId: launch.id } : {}),
        seen: () => getSessionSeenDocs(db, sessionId, launch?.id),
        pinned,
      });
      if (editArea !== null && outcome.settled) claimArea(sessionId, editArea);
      return withSessionStartNotice(outcome.push, notice);
    } catch (err) {
      console.error(`[knowledge-push] ${event} ${sessionId.slice(0, 8)}: ${String(err)}`);
      return null;
    }
  }

  return { forHook, forget: (sessionId) => void areas.delete(sessionId) };
}

/**
 * `output` with `push` added: appended to the same event's additionalContext
 * (UserPromptSubmit's steers and mail come first), or as the hook's own
 * hookSpecificOutput. An output that already answers with another event's
 * hookSpecificOutput is left alone.
 */
export function mergeHookContext(
  output: Record<string, unknown> | null,
  push: KnowledgePush | null
): Record<string, unknown> | null {
  if (!push) return output;
  const existing = output?.hookSpecificOutput as { hookEventName?: string; additionalContext?: string } | undefined;
  if (existing) {
    if (existing.hookEventName !== push.event) return output;
    return {
      ...output,
      hookSpecificOutput: {
        ...existing,
        additionalContext: [existing.additionalContext, push.text].filter((t): t is string => !!t).join("\n\n"),
      },
    };
  }
  return { ...(output ?? {}), hookSpecificOutput: { hookEventName: push.event, additionalContext: push.text } };
}

/**
 * The push a Codex launch's brief carries in place of a SessionStart hook: the
 * SessionStart selection over the brief, minus the docs the launch's injection
 * already put in the prompt, recorded as `push:launch` against the launch. ""
 * when nothing clears the bar, the budget runs out, or pushes are off by env.
 */
export async function launchKnowledgePush(
  db: Database,
  input: {
    projectId: string;
    brief: string;
    launchId: string;
    injected: ReadonlyArray<{ projectId: string; slug: string }>;
    search: PushSearch;
    budgetMs?: number;
    env?: NodeJS.ProcessEnv;
  }
): Promise<string> {
  const started = performance.now();
  try {
    if (!isKnowledgePushEnvEnabled(input.env)) return "";
    const query = pushSessionStartQuery({ brief: input.brief });
    if (!query) return "";
    const injected = new Set(input.injected.map(pushRef));
    const { push } = await runPush({
      db,
      search: input.search,
      started,
      budgetMs: input.budgetMs ?? KNOWLEDGE_PUSH_BUDGET_MS,
      event: "SessionStart",
      surface: "push:launch",
      projectId: input.projectId,
      query,
      launchId: input.launchId,
      seen: () => injected,
    });
    return push?.text ?? "";
  } catch (err) {
    console.error(`[knowledge-push] launch ${input.launchId}: ${String(err)}`);
    return "";
  }
}
