import type { Database } from "bun:sqlite";
import type {
  KnowledgeRetrievalBreakdown,
  KnowledgeRetrievalSurface,
  KnowledgeRetrievalUsage,
} from "@standup/shared";

/**
 * The `drop_reason` of a result squeezed out of a launch prompt by the char
 * budget. Unlike every other drop reason it marks a doc the surface DID return
 * (a ranked result that lost the budget), so usage counts it as a retrieval;
 * every other non-null drop_reason is a candidate a gate held back before it
 * became a result.
 */
export const BUDGET_DROP_REASON = "budget";

/** One retrieved doc to record — a single (query, hit) pair. */
export interface RetrievalRecord {
  /** Project the retrieved doc lives in (may differ from queryProject). */
  docProject: string;
  docSlug: string;
  /** The query text that surfaced this doc. */
  query: string;
  /** 0-based position in the result list. */
  rank: number;
  /** Retrieval score, when the surface carries one. */
  score?: number;
  surface: KnowledgeRetrievalSurface;
  /** Correlated calling session, when known. */
  sessionId?: string;
  /** The project context the query ran in. */
  queryProject?: string;
  /**
   * Whether this retrieved doc actually rode into the agent: true = injected
   * into a launch prompt, false = retrieved but dropped by the injection char
   * budget. Left undefined for
   * a ranking-only surface (`search`), which persists NULL (not-applicable).
   */
  injected?: boolean;
  /** The launch whose opening prompt this doc fed — set on `inject`-surface rows. */
  launchId?: string;
  /**
   * The hit's numeric score fields as the surface saw them (score, rawScore,
   * relevance, and any signal/component breakdown), persisted as JSON.
   */
  components?: Record<string, unknown>;
  /** The retrieval algorithm revision that produced this row (ALGO_VERSION). */
  algoVersion?: string;
  /** The absolute relevance on the pre-boost scale (SearchResult.rawScore). */
  rawScore?: number;
  /** The surface's relevance figure, when it carries one. */
  relevance?: number;
  /** The doc's knowledge layer (personal / intent / docs / activity). */
  layer?: string;
  sourceKind?: string;
  scope?: string;
  /** The owner of a personal-layer doc — the only viewer its row is shown to. */
  docOwner?: string;
  /**
   * Why a retrieved candidate was held back, or undefined for a returned hit.
   * See BUDGET_DROP_REASON for the one reason that marks a returned hit.
   */
  dropReason?: string;
  /**
   * Collector-side milliseconds the request that surfaced this row took, end
   * to end (sync, retrieval, ranking). Set by the timed `search` surface; the
   * same on every row of one query.
   */
  latencyMs?: number;
}

/**
 * Records retrieval-usage rows for one query's hits in a single transaction.
 * Best-effort by contract: callers wrap this so a logging failure never fails
 * the search or doc read it is observing (the table is telemetry, not a
 * correctness dependency). An empty list is a no-op.
 */
export function recordRetrievals(db: Database, records: RetrievalRecord[]): void {
  if (records.length === 0) return;
  const insert = db.prepare(
    `INSERT INTO knowledge_retrievals
       (doc_project, doc_slug, query, rank, score, surface, session_id, query_project, injected, launch_id,
        components_json, algo_version, raw_score, relevance, layer, source_kind, scope, doc_owner, drop_reason,
        latency_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertAll = db.transaction((rows: RetrievalRecord[]) => {
    for (const r of rows) {
      insert.run(
        r.docProject,
        r.docSlug,
        r.query,
        r.rank,
        finiteOrNull(r.score),
        r.surface,
        r.sessionId ?? null,
        r.queryProject ?? null,
        r.injected === undefined ? null : r.injected ? 1 : 0,
        r.launchId ?? null,
        r.components && Object.keys(r.components).length > 0 ? JSON.stringify(r.components) : null,
        r.algoVersion ?? null,
        finiteOrNull(r.rawScore),
        finiteOrNull(r.relevance),
        r.layer ?? null,
        r.sourceKind ?? null,
        r.scope ?? null,
        r.docOwner ?? null,
        r.dropReason ?? null,
        typeof r.latencyMs === "number" && Number.isFinite(r.latencyMs) ? Math.round(r.latencyMs) : null
      );
    }
  });
  insertAll(records);
}

function finiteOrNull(n: number | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * Who a usage read is for. `viewer` is the caller's resolved alias, or null for
 * a caller with no identity: a personal-layer row is returned only when its
 * `doc_owner` is the viewer. Omitting the option reads every row (in-process
 * consumers whose output never leaves the collector).
 */
export interface RetrievalViewerOptions {
  viewer?: string | null;
}

/** The WHERE conditions + params scoping a read to a project and a viewer. */
function retrievalWhere(
  projectId: string | undefined,
  opts: RetrievalViewerOptions | undefined
): { where: string; params: string[] } {
  const conditions: string[] = [];
  const params: string[] = [];
  if (projectId) {
    conditions.push("kr.doc_project = ?");
    params.push(projectId);
  }
  if (opts && opts.viewer !== undefined) {
    if (opts.viewer === null) {
      conditions.push("COALESCE(kr.layer, '') != 'personal'");
    } else {
      conditions.push("(COALESCE(kr.layer, '') != 'personal' OR kr.doc_owner = ?)");
      params.push(opts.viewer);
    }
  }
  return { where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "", params };
}

/**
 * A row for a hit the surface returned: not a get_knowledge_doc fetch, and not
 * a candidate a gate held back (a budget drop is still a returned result).
 */
const RETURNED_SQL = `(kr.surface != 'doc_get' AND (kr.drop_reason IS NULL OR kr.drop_reason = '${BUDGET_DROP_REASON}'))`;
/**
 * A returned hit that reached its consumer: a ranking-only search result
 * (injected NULL), or one injected into a prompt — not a budget-dropped
 * injection. Only these earn a session's outcome or count as a doc's use.
 */
const USED_SQL = `(${RETURNED_SQL} AND COALESCE(kr.injected, 1) = 1)`;
/**
 * A get_knowledge_doc fetch of a doc the same session had already been handed
 * by a search result or a launch injection (a used row, see USED_SQL, at or
 * before the fetch): the agent read the surfaced doc in full, so its surfacing
 * was acted on. Rows of the `attributed` CTE, keyed by the session the outcome
 * join uses, so an injection recorded before its session attached still counts.
 */
const CITED_SQL = `(kr.surface = 'doc_get' AND kr.outcome_session_id IS NOT NULL AND EXISTS (
         SELECT 1 FROM attributed shown
          WHERE shown.doc_project = kr.doc_project AND shown.doc_slug = kr.doc_slug
            AND shown.outcome_session_id = kr.outcome_session_id
            AND shown.surface IN ('search', 'inject')
            AND (shown.drop_reason IS NULL OR shown.drop_reason = '${BUDGET_DROP_REASON}')
            AND COALESCE(shown.injected, 1) = 1
            AND shown.created_at <= kr.created_at))`;
/** A row for a candidate a gate held back before it became a result. */
const GATED_SQL = `(kr.surface != 'doc_get' AND kr.drop_reason IS NOT NULL AND kr.drop_reason != '${BUDGET_DROP_REASON}')`;

interface UsageRow {
  doc_project: string;
  doc_slug: string;
  retrievals: number;
  last_retrieved_at: string;
  succeeded: number;
  failed: number;
  injected: number;
  dropped: number;
  gated: number;
  doc_gets: number;
  cited: number;
  layer: string | null;
  last_used_at: string | null;
}

/**
 * Per-doc retrieval usage — total retrievals, the most recent retrieval
 * timestamp, the feedback breakdown (how many retrievals rode in a session
 * that ultimately succeeded vs failed), and the injected-vs-dropped split (how
 * many were actually fed to an agent vs retrieved-but-dropped), grouped by the
 * (project, slug) pair docs are keyed by. `projectId` scopes to docs living in
 * that project; omit it for the whole corpus. Ordered by most-retrieved first
 * so the read is directly rankable.
 *
 * `retrievals` counts the hits a surface returned. A candidate a gate held back
 * (a non-null drop_reason other than `budget`) counts toward `gated` instead,
 * and a get_knowledge_doc fetch toward `docGets`; `cited` is the subset of
 * `docGets` that followed the doc being surfaced to the same session (see
 * CITED_SQL). `lastRetrievedAt` is the latest row of any kind;
 * `lastUsedAt` the latest hit that reached its consumer (see USED_SQL) or
 * fetch, absent when there is none. The outcome counts below credit only hits
 * that reached their consumer: a budget-dropped injection rode in the session
 * without being used, so it earns neither verdict.
 *
 * `injected`/`dropped` fold the per-row `injected` flag: a launch injection
 * counts `injected`, a budget-dropped one counts `dropped`, and a
 * ranking-only `search` retrieval (NULL flag) counts
 * toward neither — so the two need not sum to `retrievals`.
 *
 * The feedback half is a join, not a stored column: each retrieval carries the
 * calling `session_id` — or, for a launch injection recorded before its session
 * existed, the `launch_id` whose `launches.session_id` names the session once
 * it attaches — and a session's outcome is derived from two ledgers, in
 * priority order:
 *
 *  1. `task_runs` — a console-dispatched launch reports an explicit terminal
 *     status. `session_outcome` resolves each session to its LATEST run (a
 *     session is effectively 1:1 with a run, but keying on the run id keeps it
 *     exactly one row per session even if that ever stops holding).
 *     `succeeded` → helpful; `failed` → not-helpful. `lost` is NOT a failure —
 *     it means the pane vanished without an explicit report, i.e. the outcome
 *     is unknown, so it must not count against the doc (a launch that did good
 *     work but never called report_task is routinely reconciled to `lost`).
 *  2. `sessions.status` — the fallback for every session with no decisive task
 *     run, which is the common case: interactive `claude` sessions and ad-hoc
 *     runs get a `sessions` row but never a `task_runs` row. A session the
 *     turn-end classifier marked `done` (agent finished with nothing pending)
 *     is the automatic "it worked" proxy for these; any other session status
 *     (running/idle/waiting/stalled) is an in-flight non-verdict.
 *
 * A retrieval with no session at all (e.g. a UI/Knowledge-tab search), or one
 * whose session is in flight / cancelled with no `done`, falls through both and
 * counts toward neither bucket — so `succeededRetrievals + failedRetrievals` is
 * the correlated-with-a-verdict subset of `retrievals`, which is exactly the
 * signal #4/#5 want (an uncorrelated or in-flight retrieval carries no outcome
 * evidence yet). Deriving rather than storing means a run/session outcome that
 * lands AFTER the retrieval still attributes correctly and never goes stale.
 *
 * `opts.viewer` hides other users' personal-layer rows (RetrievalViewerOptions).
 */
export function getRetrievalUsage(
  db: Database,
  projectId?: string,
  opts?: RetrievalViewerOptions
): KnowledgeRetrievalUsage[] {
  const { where, params } = retrievalWhere(projectId, opts);
  const rows = db
    .query(
      `WITH session_outcome AS (
         SELECT tr.session_id AS session_id, tr.status AS status
           FROM task_runs tr
          WHERE tr.session_id IS NOT NULL
            AND tr.id = (
                  SELECT t2.id FROM task_runs t2
                   WHERE t2.session_id = tr.session_id
                   ORDER BY t2.created_at DESC, t2.id DESC
                   LIMIT 1
                )
       ),
       attributed AS (
         SELECT kr.*, COALESCE(kr.session_id, l.session_id) AS outcome_session_id
           FROM knowledge_retrievals kr
           LEFT JOIN launches l ON l.id = kr.launch_id
         ${where}
       )
       SELECT kr.doc_project, kr.doc_slug,
              SUM(CASE WHEN ${RETURNED_SQL} THEN 1 ELSE 0 END) AS retrievals,
              MAX(kr.created_at) AS last_retrieved_at,
              SUM(CASE
                    WHEN NOT ${USED_SQL} THEN 0
                    WHEN so.status = 'succeeded' THEN 1
                    WHEN so.status = 'failed' THEN 0
                    WHEN s.status = 'done' THEN 1
                    ELSE 0
                  END) AS succeeded,
              SUM(CASE WHEN ${USED_SQL} AND so.status = 'failed' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN ${RETURNED_SQL} AND kr.injected = 1 THEN 1 ELSE 0 END) AS injected,
              SUM(CASE WHEN ${RETURNED_SQL} AND kr.injected = 0 THEN 1 ELSE 0 END) AS dropped,
              SUM(CASE WHEN ${GATED_SQL} THEN 1 ELSE 0 END) AS gated,
              SUM(CASE WHEN kr.surface = 'doc_get' THEN 1 ELSE 0 END) AS doc_gets,
              SUM(CASE WHEN ${CITED_SQL} THEN 1 ELSE 0 END) AS cited,
              MAX(kr.layer) AS layer,
              MAX(CASE WHEN ${USED_SQL} OR kr.surface = 'doc_get' THEN kr.created_at END) AS last_used_at
         FROM attributed kr
         LEFT JOIN session_outcome so ON so.session_id = kr.outcome_session_id
         LEFT JOIN sessions s ON s.id = kr.outcome_session_id
        GROUP BY kr.doc_project, kr.doc_slug
        ORDER BY retrievals DESC, last_retrieved_at DESC`
    )
    .all(...params) as UsageRow[];

  return rows.map((r) => ({
    docProject: r.doc_project,
    docSlug: r.doc_slug,
    retrievals: r.retrievals,
    lastRetrievedAt: r.last_retrieved_at,
    succeededRetrievals: r.succeeded,
    failedRetrievals: r.failed,
    injected: r.injected,
    dropped: r.dropped,
    gated: r.gated,
    docGets: r.doc_gets,
    cited: r.cited,
    ...(r.layer ? { layer: r.layer } : {}),
    ...(r.last_used_at ? { lastUsedAt: r.last_used_at } : {}),
  }));
}

interface BreakdownRow {
  key: string;
  surface: KnowledgeRetrievalSurface;
  rows: number;
  docs: number;
  returned: number;
  gated: number;
  injected: number;
}

/**
 * Retrieval rows broken down two ways, each per surface: by the retrieved doc's
 * knowledge layer (a row recorded before layers were stamped reads `unknown`),
 * and by drop reason (`returned` for a hit the surface returned with no drop).
 * `returned` / `gated` split each layer's rows the way getRetrievalUsage does,
 * and `docs` counts distinct docs. Scoped and viewer-filtered like
 * getRetrievalUsage.
 */
export function getRetrievalBreakdown(
  db: Database,
  projectId?: string,
  opts?: RetrievalViewerOptions
): KnowledgeRetrievalBreakdown {
  const { where, params } = retrievalWhere(projectId, opts);
  const grouped = (keyExpr: string): BreakdownRow[] =>
    db
      .query(
        `SELECT ${keyExpr} AS key, kr.surface AS surface,
                COUNT(*) AS rows,
                COUNT(DISTINCT kr.doc_project || '/' || kr.doc_slug) AS docs,
                SUM(CASE WHEN ${RETURNED_SQL} THEN 1 ELSE 0 END) AS returned,
                SUM(CASE WHEN ${GATED_SQL} THEN 1 ELSE 0 END) AS gated,
                SUM(CASE WHEN ${RETURNED_SQL} AND kr.injected = 1 THEN 1 ELSE 0 END) AS injected
           FROM knowledge_retrievals kr
           ${where}
          GROUP BY key, kr.surface
          ORDER BY key, kr.surface`
      )
      .all(...params) as BreakdownRow[];
  return {
    byLayer: grouped("COALESCE(kr.layer, 'unknown')").map((r) => ({
      layer: r.key,
      surface: r.surface,
      rows: r.rows,
      docs: r.docs,
      returned: r.returned,
      gated: r.gated,
      injected: r.injected,
    })),
    byDropReason: grouped("COALESCE(kr.drop_reason, 'returned')").map((r) => ({
      reason: r.key,
      surface: r.surface,
      rows: r.rows,
      docs: r.docs,
    })),
  };
}

/** A doc that rode into a launch's opening prompt. */
export interface LaunchInjectedDoc {
  docProject: string;
  docSlug: string;
  /** The doc's title from the knowledge index, when the index exists and holds it. */
  title?: string;
}

interface LaunchInjectedDocRow {
  doc_project: string;
  doc_slug: string;
  title: string | null;
}

/**
 * The docs injected into a launch's opening prompt (`inject`-surface rows with
 * injected = 1), one entry per doc, best-ranked first, capped at `limit`. A doc
 * recorded under several queries keeps its best (lowest) rank.
 *
 * Titles come from the `knowledge` index, which the KnowledgeStore creates
 * lazily — so the join only runs when that table exists, and a doc missing from
 * it simply has no title.
 */
export function getLaunchInjectedDocs(
  db: Database,
  launchId: string,
  limit = 6
): LaunchInjectedDoc[] {
  return injectedDocs(db, "kr.launch_id = ?", [launchId], limit);
}

/**
 * The docs of `docProject` injected into a session's opening prompt, via the
 * launch whose `launches.session_id` names it (launch injections are recorded
 * before the session exists). Filtered by project before the limit, since one
 * brief mixes code, product, playbook and other-project docs whose ranks each
 * restart at 0. Same shape and ordering as getLaunchInjectedDocs.
 */
export function getSessionInjectedDocs(
  db: Database,
  sessionId: string,
  docProject: string,
  limit = 6
): LaunchInjectedDoc[] {
  return injectedDocs(
    db,
    "kr.launch_id IN (SELECT id FROM launches WHERE session_id = ?) AND kr.doc_project = ?",
    [sessionId, docProject],
    limit
  );
}

function injectedDocs(
  db: Database,
  where: string,
  params: string[],
  limit: number
): LaunchInjectedDoc[] {
  const indexed =
    db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'knowledge'").get() !== null;
  const title = indexed
    ? `(SELECT k.title FROM knowledge k
         WHERE k.project_id = d.doc_project AND k.slug = d.doc_slug
         LIMIT 1)`
    : "NULL";
  const rows = db
    .query(
      `SELECT d.doc_project, d.doc_slug, ${title} AS title
         FROM (SELECT kr.doc_project, kr.doc_slug, MIN(kr.rank) AS best_rank, MIN(kr.id) AS first_id
                 FROM knowledge_retrievals kr
                WHERE ${where} AND kr.surface = 'inject' AND kr.injected = 1
                GROUP BY kr.doc_project, kr.doc_slug) d
        ORDER BY d.best_rank, d.first_id
        LIMIT ?`
    )
    .all(...params, limit) as LaunchInjectedDocRow[];
  return rows.map((r) => ({
    docProject: r.doc_project,
    docSlug: r.doc_slug,
    ...(r.title ? { title: r.title } : {}),
  }));
}

/**
 * Every doc (`project/slug`) a session has already been handed: pushed by a
 * hook (`push:*`), returned by its searches, fetched with get_knowledge_doc, or
 * injected into its launch's opening prompt (`launchId`, the launch the session
 * runs, whose inject rows predate the session). The hook push's dedup set: a
 * doc in it is never pushed to the session again. A gated or budget-dropped
 * candidate does not count; the session never saw it.
 */
export function getSessionSeenDocs(db: Database, sessionId: string, launchId?: string): Set<string> {
  const rows = db
    .query(
      `SELECT DISTINCT doc_project, doc_slug FROM knowledge_retrievals
        WHERE ((session_id = ? AND (surface IN ('search', 'doc_get') OR surface LIKE 'push:%'))
               OR (? IS NOT NULL AND launch_id = ? AND (surface = 'inject' OR surface LIKE 'push:%')))
          AND drop_reason IS NULL
          AND COALESCE(injected, 1) = 1`
    )
    .all(sessionId, launchId ?? null, launchId ?? null) as Array<{ doc_project: string; doc_slug: string }>;
  return new Set(rows.map((r) => `${r.doc_project}/${r.doc_slug}`));
}

/** Pushed docs and how many were opened afterwards, overall and per hook event. */
export interface PushUptake {
  /** Push rows recorded since the cutoff. */
  pushed: number;
  /** Of those, the ones the same session fetched with get_knowledge_doc at or after the push. */
  opened: number;
  /** Keyed by the event after `push:` (SessionStart, UserPromptSubmit, PreToolUse, launch). */
  byEvent: Record<string, { pushed: number; opened: number }>;
}

/** An epoch-ms instant as the `YYYY-MM-DD HH:MM:SS` UTC text `created_at` defaults to. */
function sqliteUtc(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

/**
 * Push uptake since `sinceMs` (epoch ms): each `push:*` row, and whether the
 * session it was pushed to later opened that doc with get_knowledge_doc. A
 * push recorded against a launch (a Codex brief) reaches its session through
 * launches.session_id once the session attaches.
 */
export function getPushUptake(db: Database, sinceMs: number): PushUptake {
  const rows = db
    .query(
      `WITH pushed AS (
         SELECT kr.id, kr.doc_project, kr.doc_slug, kr.created_at, substr(kr.surface, 6) AS event,
                COALESCE(kr.session_id, l.session_id) AS sid
           FROM knowledge_retrievals kr
           LEFT JOIN launches l ON l.id = kr.launch_id
          WHERE kr.surface LIKE 'push:%' AND kr.created_at >= ?
       )
       SELECT p.event AS event, COUNT(*) AS pushed,
              SUM(CASE WHEN p.sid IS NOT NULL AND EXISTS (
                    SELECT 1 FROM knowledge_retrievals g
                     WHERE g.surface = 'doc_get' AND g.session_id = p.sid
                       AND g.doc_project = p.doc_project AND g.doc_slug = p.doc_slug
                       AND g.created_at >= p.created_at
                  ) THEN 1 ELSE 0 END) AS opened
         FROM pushed p
        GROUP BY p.event
        ORDER BY p.event`
    )
    .all(sqliteUtc(sinceMs)) as Array<{ event: string; pushed: number; opened: number }>;
  const byEvent: PushUptake["byEvent"] = {};
  let pushed = 0;
  let opened = 0;
  for (const r of rows) {
    byEvent[r.event] = { pushed: r.pushed, opened: r.opened };
    pushed += r.pushed;
    opened += r.opened;
  }
  return { pushed, opened, byEvent };
}
