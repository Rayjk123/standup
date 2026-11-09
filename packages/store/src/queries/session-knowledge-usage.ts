import type { Database } from "bun:sqlite";
import { BUDGET_DROP_REASON } from "./knowledge-retrievals.js";

/**
 * The `events.type` a contribute nudge is recorded under. A session with at
 * least one such event reads as `nudged`; with none recorded, every session
 * reads as not nudged.
 */
export const CONTRIBUTE_NUDGE_EVENT_TYPE = "ContributeNudge";

/**
 * Tool names that change files in the working tree, across harnesses: Claude's
 * Edit, Write, MultiEdit and NotebookEdit hook tools, and the ApplyPatch call
 * the Codex observer logs for a file change (`apply_patch` when Codex reports
 * the patch as a plain function call). Shell commands are not counted, since a
 * command's effect on files is not recorded.
 */
const EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit", "ApplyPatch", "apply_patch"] as const;

/**
 * The agent CLI a session ran under: `claude` (hook events in `events`),
 * `codex` (tool calls in `transcript_events`, logged by the Codex observer),
 * or `other` for a harness this reader does not know.
 */
export type SessionHarness = "claude" | "codex" | "other";

/** Default and maximum number of sessions one call reads. */
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;
/** Ranks (0-based) a result must reach to count toward a session's top hits. */
const TOP_HIT_RANKS = 3;
const MAX_TOP_HIT_SLUGS = 5;
const MAX_INJECTED_SLUGS = 20;

/** Outcome counts of a session's propose_knowledge calls. */
export interface SessionProposalCounts {
  /** Every propose_knowledge call, whatever came of it. */
  calls: number;
  /** Calls that published a live doc. */
  published: number;
  /** Calls saved as a draft awaiting human review. */
  drafts: number;
  /** Calls the collector rejected or that added nothing (a validation error, or "already covers this"). */
  refused: number;
}

/** How one session used the knowledge base. */
export interface SessionKnowledgeUsage {
  sessionId: string;
  projectId: string | null;
  title: string | null;
  /** The session's start, as stored (bare UTC `YYYY-MM-DD HH:MM:SS`). */
  startedAt: string | null;
  /** The harness of the session's latest launch that names one; `claude` when none does. */
  harness: SessionHarness;
  /** Docs injected into the session's launch prompt (only sessions started by a launch have any). */
  injectedDocs: { count: number; slugs: string[] };
  /** Distinct search_knowledge queries. */
  searches: number;
  /** Distinct docs fetched with get_knowledge_doc. */
  docGets: number;
  /** Up to five slugs the session's searches returned most often near the top. */
  topHitSlugs: string[];
  proposals: SessionProposalCounts;
  /**
   * Knowledge tool calls (search, doc fetch, propose) made by the
   * session's subagents. A subagent's hook events arrive under its parent's
   * session id with an `agent_id` in the payload, which is what marks them.
   * The other counts on this row include subagent activity.
   */
  subagentKbCalls: number;
  /** File-change tool calls (Claude's Edit, Write, MultiEdit, NotebookEdit; Codex's ApplyPatch), the session's subagents included. */
  edits: number;
  /** Whether a knowledge lookup came at or before the first edit; null when the session made no edit. */
  searchedBeforeFirstEdit: boolean | null;
  /** Whether a contribute nudge was recorded for the session. */
  nudged: boolean;
}

/** Filters for {@link getSessionKnowledgeUsage}. */
export interface SessionKnowledgeUsageOptions {
  /** Read exactly these sessions (subagent rows included if named); the other filters still apply. */
  sessionIds?: string[];
  /** Only sessions homed in this project. */
  projectId?: string;
  /** Only sessions started at or after this instant (ISO or bare UTC sqlite stamp). */
  since?: string;
  /** Only sessions started before this instant (ISO or bare UTC sqlite stamp). */
  until?: string;
  /** Most sessions to return, newest first (default 200, capped at 2000). */
  limit?: number;
  /** Keep only sessions this accepts; applied before `limit`, so the limit counts kept sessions. */
  include?: (sessionId: string) => boolean;
}

/** Aggregate knowledge use across a set of sessions. Percentages are whole numbers, 0 when the base is empty. */
export interface KnowledgeUsageSummary {
  sessions: number;
  /** Sessions that ran at least one search or doc fetch. */
  searched: number;
  searchedPct: number;
  /** Sessions that made at least one edit. */
  editing: number;
  /** Editing sessions whose first knowledge lookup came at or before their first edit. */
  searchedBeforeEdit: number;
  /** Share of `editing`, not of `sessions`. */
  searchedBeforeEditPct: number;
  /** Sessions that called propose_knowledge at least once. */
  proposed: number;
  proposedPct: number;
  /** Total propose_knowledge calls. */
  proposalCalls: number;
  /** Drafts from these sessions still awaiting review (see {@link summarizeKnowledgeUsage}). */
  draftsPending: number;
  /**
   * The same counts split by {@link SessionHarness}, one entry per harness
   * that has at least one session. Always set by {@link summarizeKnowledgeUsage}.
   */
  byHarness?: Partial<Record<SessionHarness, HarnessKnowledgeUsage>>;
}

/** One harness's share of a {@link KnowledgeUsageSummary}; pending drafts are only totalled. */
export type HarnessKnowledgeUsage = Omit<KnowledgeUsageSummary, "draftsPending" | "byHarness">;

interface SessionRow {
  id: string;
  project_id: string | null;
  title: string | null;
  started_at: string | null;
  harness: string | null;
}

interface ToolEventRow {
  session_id: string;
  created_at: string;
  tool: string | null;
  agent_id: string | null;
  query: string | null;
  slug: string | null;
  response: string | null;
}

interface RetrievalRow {
  session_id: string;
  surface: string;
  query: string;
  doc_slug: string;
  rank: number;
  drop_reason: string | null;
  created_at: string | null;
}

type KbTool = "search" | "doc_get" | "propose";

function tableExists(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null;
}

/** Epoch ms of an ISO or bare UTC sqlite stamp; NaN when unparseable. */
function toMs(value: string | null | undefined): number {
  if (value == null) return NaN;
  const t = value.trim();
  const bare = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(t);
  return Date.parse(bare ? `${t.replace(" ", "T")}Z` : t);
}

/** A bound as a bare UTC sqlite stamp, comparable to `sessions.started_at`; unparseable input passes through. */
function toSqlUtc(value: string): string {
  const ms = toMs(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 19).replace("T", " ") : value;
}

/** The knowledge tool a hook tool name refers to, matched on its suffix so any MCP server prefix works. */
function kbTool(tool: string | null): KbTool | null {
  if (!tool) return null;
  if (/(^|__|\.)search_knowledge$/.test(tool)) return "search";
  if (/(^|__|\.)get_knowledge_doc$/.test(tool)) return "doc_get";
  if (/(^|__|\.)propose_knowledge$/.test(tool)) return "propose";
  return null;
}

/** The prefix the MCP server puts on a tool call that threw (a collector 4xx/5xx or a network failure). */
const TOOL_FAILED_PREFIX = 'standup tool "propose_knowledge" failed:';

/**
 * How a propose_knowledge call ended, read from the text the tool returned;
 * null when no response was stored.
 *
 * Only the first line is read: the MCP tool states the outcome there with a
 * fixed opening, and appends the nearest existing docs (whose titles are
 * free text) and any project warning on later lines. A duplicate is checked
 * before a publish, since its line says "nothing new was published".
 */
function proposalOutcome(response: string | null): "published" | "draft" | "refused" | null {
  if (response == null || response.trim() === "") return null;
  const head = response.trimStart().split("\n", 1)[0]!;
  if (head.startsWith(TOOL_FAILED_PREFIX)) return "refused";
  if (/^Draft ".*" saved for human review\b/.test(head) || head.startsWith("Saved as a review draft ")) return "draft";
  if (/nothing (new )?was (published|added)|already covers/i.test(head)) return "refused";
  if (/^Knowledge ".*" published\b/.test(head)) return "published";
  return "refused";
}

function normalized(value: string | null): string | null {
  const t = value?.trim();
  return t ? t : null;
}

/** A launch's harness value as a {@link SessionHarness}; no value reads as the default harness, Claude. */
function harnessOf(value: string | null): SessionHarness {
  if (value == null || value === "claude") return "claude";
  return value === "codex" ? "codex" : "other";
}

/**
 * The text of a tool result the Codex observer logged. An MCP result is stored
 * as the call's JSON-rendered result, `{ content: [{ type: "text", text }] }`,
 * so its first text item is the reply; anything else is read as is.
 */
function transcriptResultText(content: string | null): string | null {
  if (content == null) return null;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed === "string") return parsed;
    const items = (parsed as { content?: unknown } | null)?.content;
    if (Array.isArray(items)) {
      const text = items.find(
        (i): i is { text: string } => typeof (i as { text?: unknown } | null)?.text === "string"
      );
      if (text) return text.text;
    }
  } catch {
    // Plain text, not JSON.
  }
  return content;
}

/** The tool names {@link getSessionKnowledgeUsage} reads, as a SQL condition on `column`. */
function trackedToolCondition(column: string): string {
  const editList = EDIT_TOOLS.map((t) => `'${t}'`).join(", ");
  return `(${column} IN (${editList})
           OR ${column} LIKE '%search_knowledge'
           OR ${column} LIKE '%get_knowledge_doc' OR ${column} LIKE '%propose_knowledge')`;
}

/**
 * Tool calls from the transcripts of sessions whose harness posts no hook
 * events. Each call is a `tool_use` block in an assistant record; a
 * propose_knowledge call's reply is read from the `tool_result` record that
 * shares its `tool_use_id`. Records that are not valid JSON are skipped.
 */
function transcriptToolEvents(db: Database, sessionIds: string[]): ToolEventRow[] {
  if (sessionIds.length === 0 || !tableExists(db, "transcript_events")) return [];
  const ids = JSON.stringify(sessionIds);
  const calls = db
    .query(
      `SELECT session_id, created_at, tool, tool_use_id, query, slug
         FROM (SELECT te.session_id, te.created_at,
                      json_extract(c.value, '$.name') AS tool,
                      json_extract(c.value, '$.id') AS tool_use_id,
                      json_extract(c.value, '$.input.query') AS query,
                      COALESCE(json_extract(c.value, '$.input.slug'),
                               json_extract(c.value, '$.input.id')) AS slug
                 FROM transcript_events te,
                      json_each(CASE WHEN json_valid(te.event_json)
                                      AND json_extract(te.event_json, '$.type') = 'assistant'
                                      AND json_type(te.event_json, '$.message.content') = 'array'
                                     THEN te.event_json ELSE '{"message":{"content":[]}}' END,
                                '$.message.content') c
                WHERE te.session_id IN (SELECT value FROM json_each(?))
                  AND json_extract(c.value, '$.type') = 'tool_use')
        WHERE ${trackedToolCondition("tool")}
        ORDER BY session_id, created_at`
    )
    .all(ids) as Array<Omit<ToolEventRow, "agent_id" | "response"> & { tool_use_id: string | null }>;

  const proposeIds = calls
    .filter((c) => kbTool(c.tool) === "propose" && c.tool_use_id)
    .map((c) => `${c.session_id}\u0000${c.tool_use_id}`);
  const replies = new Map<string, string | null>();
  if (proposeIds.length > 0) {
    const results = db
      .query(
        `SELECT te.session_id, json_extract(c.value, '$.tool_use_id') AS tool_use_id,
                json_extract(c.value, '$.content') AS content
           FROM transcript_events te,
                json_each(CASE WHEN json_valid(te.event_json)
                                AND json_extract(te.event_json, '$.type') = 'user'
                                AND json_type(te.event_json, '$.message.content') = 'array'
                               THEN te.event_json ELSE '{"message":{"content":[]}}' END,
                          '$.message.content') c
          WHERE te.session_id IN (SELECT value FROM json_each(?))
            AND json_extract(c.value, '$.type') = 'tool_result'`
      )
      .all(ids) as Array<{ session_id: string; tool_use_id: string | null; content: string | null }>;
    const wanted = new Set(proposeIds);
    for (const r of results) {
      const key = `${r.session_id}\u0000${r.tool_use_id}`;
      if (wanted.has(key)) replies.set(key, transcriptResultText(r.content));
    }
  }

  return calls.map((c) => ({
    session_id: c.session_id,
    created_at: c.created_at,
    tool: c.tool,
    agent_id: null,
    query: c.query,
    slug: c.slug,
    response: replies.get(`${c.session_id}\u0000${c.tool_use_id}`) ?? null,
  }));
}

function emptyUsage(row: SessionRow): SessionKnowledgeUsage {
  return {
    sessionId: row.id,
    projectId: row.project_id,
    title: row.title,
    startedAt: row.started_at,
    harness: harnessOf(row.harness),
    injectedDocs: { count: 0, slugs: [] },
    searches: 0,
    docGets: 0,
    topHitSlugs: [],
    proposals: { calls: 0, published: 0, drafts: 0, refused: 0 },
    subagentKbCalls: 0,
    edits: 0,
    searchedBeforeFirstEdit: null,
    nudged: false,
  };
}

/** Per-session working state while the rows are assembled. */
interface Accumulator {
  usage: SessionKnowledgeUsage;
  searches: Set<string>;
  /** Docs fetched, keyed by slug, or by the id the call passed when no retrieval row names its slug. */
  docs: Set<string>;
  /** The slug a doc fetch's id or slug resolved to, from its retrieval row. */
  docSlugs: Map<string, string>;
  injected: Set<string>;
  hits: Map<string, { count: number; bestRank: number }>;
  firstLookupMs: number;
  firstEditMs: number;
}

/**
 * Reads how each session used the knowledge base: what was injected into its
 * launch prompt, what it looked up, what it proposed, and whether it looked
 * anything up before it first edited a file.
 *
 * Sources:
 * - `sessions` picks the rows. Without `sessionIds`, subagent rows are left
 *   out, since their tool calls are already counted under the parent session.
 * - `knowledge_retrievals` gives search and doc fetch queries (by
 *   `session_id`) and injected docs (inject rows, through
 *   `launches.session_id`). Rows a gate held back before they became results
 *   are not counted as hits.
 * - PostToolUse `events` give edits, knowledge tool calls, subagent calls
 *   (`agent_id` in the payload), and propose_knowledge outcomes from the
 *   stored tool response. A lookup that returned nothing leaves no retrieval
 *   row, so its event still counts it.
 * - For a session whose harness posts no hooks (Codex), `transcript_events`
 *   gives the same tool calls: the observer logs each as a `tool_use` block,
 *   a file change as ApplyPatch and an MCP call as `mcp__<server>__<tool>`.
 *   A search or fetch named both there and in `knowledge_retrievals` counts
 *   once, since both are keyed by query and slug.
 * - `launches.harness` (the latest launch that names one) gives the harness;
 *   a session without one is a Claude session.
 * - A {@link CONTRIBUTE_NUDGE_EVENT_TYPE} event marks the session `nudged`.
 *
 * The knowledge tables are created lazily, so a missing one reads as no
 * activity. Reads only.
 *
 * @param db the Standup database
 * @param opts session filters; see {@link SessionKnowledgeUsageOptions}
 * @returns one row per session, newest first
 */
export function getSessionKnowledgeUsage(
  db: Database,
  opts: SessionKnowledgeUsageOptions = {}
): SessionKnowledgeUsage[] {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
  const since = opts.since ? toSqlUtc(opts.since) : null;
  const until = opts.until ? toSqlUtc(opts.until) : null;
  const projectId = opts.projectId ?? null;
  const named = opts.sessionIds ? JSON.stringify(opts.sessionIds) : null;
  if (opts.sessionIds && opts.sessionIds.length === 0) return [];

  const include = opts.include;
  const matched = db
    .query(
      `SELECT id, project_id, title, started_at,
              (SELECT l.harness FROM launches l
                WHERE l.session_id = sessions.id AND l.harness IS NOT NULL
                ORDER BY l.created_at DESC LIMIT 1) AS harness
         FROM sessions
        WHERE (?1 IS NULL AND (kind IS NULL OR kind <> 'subagent')
               OR ?1 IS NOT NULL AND id IN (SELECT value FROM json_each(?1)))
          AND (?2 IS NULL OR project_id = ?2)
          AND (?3 IS NULL OR started_at >= ?3)
          AND (?4 IS NULL OR started_at < ?4)
        ORDER BY started_at DESC, id
        LIMIT ?5`
    )
    .all(named, projectId, since, until, include ? -1 : limit) as SessionRow[];
  const sessions = include ? matched.filter((s) => include(s.id)).slice(0, limit) : matched;
  if (sessions.length === 0) return [];

  const ids = JSON.stringify(sessions.map((s) => s.id));
  const acc = new Map<string, Accumulator>();
  for (const s of sessions) {
    acc.set(s.id, {
      usage: emptyUsage(s),
      searches: new Set(),
      docs: new Set(),
      docSlugs: new Map(),
      injected: new Set(),
      hits: new Map(),
      firstLookupMs: Infinity,
      firstEditMs: Infinity,
    });
  }

  const hookToolEvents = db
    .query(
      `SELECT session_id, created_at, tool, agent_id, query, slug,
              CASE WHEN tool LIKE '%propose_knowledge' THEN
                COALESCE(json_extract(payload_json, '$.tool_response[0].text'),
                         json_extract(payload_json, '$.tool_response'))
              END AS response
         FROM (SELECT e.session_id, e.created_at, e.payload_json,
                      json_extract(e.payload_json, '$.tool_name') AS tool,
                      json_extract(e.payload_json, '$.agent_id') AS agent_id,
                      json_extract(e.payload_json, '$.tool_input.query') AS query,
                      COALESCE(json_extract(e.payload_json, '$.tool_input.slug'),
                               json_extract(e.payload_json, '$.tool_input.id')) AS slug
                 FROM events e
                WHERE e.session_id IN (SELECT value FROM json_each(?))
                  AND e.type = 'PostToolUse')
        WHERE ${trackedToolCondition("tool")}
        ORDER BY session_id, created_at`
    )
    .all(ids) as ToolEventRow[];
  // A Claude session's transcript repeats the tool calls its hooks already
  // recorded, so only the other harnesses' transcripts are read.
  const transcriptEvents = transcriptToolEvents(
    db,
    sessions.filter((s) => harnessOf(s.harness) !== "claude").map((s) => s.id)
  );
  const toolEvents = [...hookToolEvents, ...transcriptEvents].sort(
    (x, y) => x.session_id.localeCompare(y.session_id) || toMs(x.created_at) - toMs(y.created_at)
  );

  for (const e of toolEvents) {
    const a = acc.get(e.session_id);
    if (!a) continue;
    const at = toMs(e.created_at);
    if (e.tool && (EDIT_TOOLS as readonly string[]).includes(e.tool)) {
      a.usage.edits += 1;
      if (at < a.firstEditMs) a.firstEditMs = at;
      continue;
    }
    const kind = kbTool(e.tool);
    if (!kind) continue;
    if (e.agent_id) a.usage.subagentKbCalls += 1;
    if (kind === "propose") {
      a.usage.proposals.calls += 1;
      const outcome = proposalOutcome(e.response);
      if (outcome === "published") a.usage.proposals.published += 1;
      else if (outcome === "draft") a.usage.proposals.drafts += 1;
      else if (outcome === "refused") a.usage.proposals.refused += 1;
      continue;
    }
    if (at < a.firstLookupMs) a.firstLookupMs = at;
    if (kind === "search") {
      const q = normalized(e.query);
      if (q) a.searches.add(q);
    } else {
      const slug = normalized(e.slug);
      if (slug) a.docs.add(slug);
    }
  }

  if (tableExists(db, "knowledge_retrievals")) {
    const retrievals = db
      .query(
        `SELECT session_id, surface, query, doc_slug, rank, drop_reason, created_at
           FROM knowledge_retrievals
          WHERE session_id IN (SELECT value FROM json_each(?))
            AND surface IN ('search', 'doc_get')`
      )
      .all(ids) as RetrievalRow[];
    for (const r of retrievals) {
      const a = acc.get(r.session_id);
      if (!a) continue;
      const at = toMs(r.created_at);
      if (at < a.firstLookupMs) a.firstLookupMs = at;
      const q = normalized(r.query);
      if (r.surface === "search" && q) a.searches.add(q);
      else if (r.surface === "doc_get") {
        a.docs.add(r.doc_slug);
        if (q) a.docSlugs.set(q, r.doc_slug);
      }
      const returned = r.drop_reason == null || r.drop_reason === BUDGET_DROP_REASON;
      if (r.surface !== "doc_get" && returned && r.rank < TOP_HIT_RANKS) {
        const hit = a.hits.get(r.doc_slug) ?? { count: 0, bestRank: r.rank };
        hit.count += 1;
        hit.bestRank = Math.min(hit.bestRank, r.rank);
        a.hits.set(r.doc_slug, hit);
      }
    }

    const injected = db
      .query(
        `SELECT DISTINCT l.session_id, r.doc_slug
           FROM knowledge_retrievals r
           JOIN launches l ON l.id = r.launch_id
          WHERE r.surface = 'inject' AND r.injected = 1
            AND l.session_id IN (SELECT value FROM json_each(?))
          ORDER BY r.id`
      )
      .all(ids) as Array<{ session_id: string; doc_slug: string }>;
    for (const r of injected) acc.get(r.session_id)?.injected.add(r.doc_slug);
  }

  const nudged = db
    .query(
      `SELECT DISTINCT session_id FROM events
        WHERE type = ? AND session_id IN (SELECT value FROM json_each(?))`
    )
    .all(CONTRIBUTE_NUDGE_EVENT_TYPE, ids) as Array<{ session_id: string }>;
  for (const n of nudged) {
    const a = acc.get(n.session_id);
    if (a) a.usage.nudged = true;
  }

  return sessions.map((s) => {
    const a = acc.get(s.id)!;
    const u = a.usage;
    u.searches = a.searches.size;
    u.docGets = new Set([...a.docs].map((k) => a.docSlugs.get(k) ?? k)).size;
    u.injectedDocs = { count: a.injected.size, slugs: [...a.injected].slice(0, MAX_INJECTED_SLUGS) };
    u.topHitSlugs = [...a.hits.entries()]
      .sort((x, y) => y[1].count - x[1].count || x[1].bestRank - y[1].bestRank || x[0].localeCompare(y[0]))
      .slice(0, MAX_TOP_HIT_SLUGS)
      .map(([slug]) => slug);
    // Stamps have one-second resolution, so a lookup and an edit in the same
    // second tie; `<=` reads the tie as looked-up-first.
    u.searchedBeforeFirstEdit =
      u.edits === 0 ? null : Number.isFinite(a.firstLookupMs) && a.firstLookupMs <= a.firstEditMs;
    return u;
  });
}

function pct(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 100);
}

/** The session, search, edit and proposal counts over `rows`. */
function usageCounts(rows: SessionKnowledgeUsage[]): HarnessKnowledgeUsage {
  const sessions = rows.length;
  const searched = rows.filter((r) => r.searches + r.docGets > 0).length;
  const editing = rows.filter((r) => r.edits > 0).length;
  const searchedBeforeEdit = rows.filter((r) => r.searchedBeforeFirstEdit === true).length;
  const proposed = rows.filter((r) => r.proposals.calls > 0).length;
  return {
    sessions,
    searched,
    searchedPct: pct(searched, sessions),
    editing,
    searchedBeforeEdit,
    searchedBeforeEditPct: pct(searchedBeforeEdit, editing),
    proposed,
    proposedPct: pct(proposed, sessions),
    proposalCalls: rows.reduce((n, r) => n + r.proposals.calls, 0),
  };
}

/**
 * Totals a set of {@link getSessionKnowledgeUsage} rows.
 *
 * `draftsPending` counts, when `db` is given, the drafts still pending review
 * that came from one of the rows' sessions: through the draft's launch, or
 * through a propose_knowledge response in which the session saved it. The
 * draft row holds no source session, so the response is what names it: a
 * plain draft by slug alone, a review draft by project and slug. Without `db` (or before
 * the drafts table exists) it is the number of proposals that were saved as
 * drafts, which over-counts any a human has since reviewed.
 *
 * @param rows per-session usage rows
 * @param db the Standup database, to count drafts still pending review
 * @returns the aggregate across `rows`
 */
export function summarizeKnowledgeUsage(
  rows: SessionKnowledgeUsage[],
  db?: Database
): KnowledgeUsageSummary {
  let draftsPending = rows.reduce((n, r) => n + r.proposals.drafts, 0);
  if (db && tableExists(db, "knowledge_drafts")) {
    draftsPending =
      rows.length === 0
        ? 0
        : (
            db
              .query(
                `WITH ids AS (SELECT value AS id FROM json_each(?1)),
                      saved AS (
                        SELECT COALESCE(json_extract(e.payload_json, '$.tool_response[0].text'),
                                        json_extract(e.payload_json, '$.tool_response')) AS text,
                               ss.project_id AS project_id
                          FROM events e
                          JOIN sessions ss ON ss.id = e.session_id
                         WHERE e.session_id IN (SELECT id FROM ids)
                           AND e.type = 'PostToolUse'
                           AND json_extract(e.payload_json, '$.tool_name') LIKE '%propose_knowledge')
                 SELECT COUNT(*) AS n
                   FROM knowledge_drafts d
                  WHERE d.status = 'pending'
                    AND (d.generated_by_launch_id IN
                           (SELECT l.id FROM launches l WHERE l.session_id IN (SELECT id FROM ids))
                         OR EXISTS (
                           -- Each reply is matched on the exact first words it
                           -- starts with (no LIKE, so a slug's _ or % is literal).
                           -- One that names the draft by slug alone counts only
                           -- for a draft in the session's own project.
                           SELECT 1 FROM saved s
                            WHERE substr(s.text, 1, length('Saved as a review draft replacing ' || d.project_id || '/' || d.slug || ' '))
                                    = 'Saved as a review draft replacing ' || d.project_id || '/' || d.slug || ' '
                               OR (s.project_id = d.project_id
                                   AND (substr(s.text, 1, length('Draft "' || d.slug || '" saved for human review'))
                                          = 'Draft "' || d.slug || '" saved for human review'
                                        OR substr(s.text, 1, length('Saved as a review draft replacing "' || d.slug || '" '))
                                          = 'Saved as a review draft replacing "' || d.slug || '" '))))`
              )
              .get(JSON.stringify(rows.map((r) => r.sessionId))) as { n: number }
          ).n;
  }

  const groups = new Map<SessionHarness, SessionKnowledgeUsage[]>();
  for (const r of rows) {
    const group = groups.get(r.harness);
    if (group) group.push(r);
    else groups.set(r.harness, [r]);
  }
  const byHarness: Partial<Record<SessionHarness, HarnessKnowledgeUsage>> = {};
  for (const harness of ["claude", "codex", "other"] as const) {
    const group = groups.get(harness);
    if (group) byHarness[harness] = usageCounts(group);
  }

  return { ...usageCounts(rows), draftsPending, byHarness };
}

/** The counts the contribute nudge decides on for one session; subagent events count toward their parent. */
export interface ContributeNudgeFacts {
  /** File-change tool calls in the session's hook events. */
  edits: number;
  /** propose_knowledge calls, whatever came of them. */
  proposals: number;
  /** Whether a contribute nudge is already recorded for the session. */
  nudged: boolean;
}

/** Reads {@link ContributeNudgeFacts} for one session in a single statement. */
export function getContributeNudgeFacts(db: Database, sessionId: string): ContributeNudgeFacts {
  const editList = EDIT_TOOLS.map((t) => `'${t}'`).join(", ");
  const row = db
    .query(
      `SELECT
         COALESCE(SUM(type = 'PostToolUse' AND json_extract(payload_json, '$.tool_name') IN (${editList})), 0) AS edits,
         COALESCE(SUM(type = 'PostToolUse' AND json_extract(payload_json, '$.tool_name') LIKE '%propose_knowledge'), 0) AS proposals,
         COALESCE(SUM(type = ?), 0) AS nudges
       FROM events
      WHERE session_id = ?`
    )
    .get(CONTRIBUTE_NUDGE_EVENT_TYPE, sessionId) as { edits: number; proposals: number; nudges: number };
  return { edits: row.edits, proposals: row.proposals, nudged: row.nudges > 0 };
}

/** Records a contribute nudge as a {@link CONTRIBUTE_NUDGE_EVENT_TYPE} event at the session's next seq. */
export function recordContributeNudge(db: Database, sessionId: string, payload: Record<string, unknown>): void {
  db.run(
    `INSERT INTO events (session_id, seq, type, payload_json)
     VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE session_id = ?), ?, ?)`,
    [sessionId, sessionId, CONTRIBUTE_NUDGE_EVENT_TYPE, JSON.stringify(payload)]
  );
}
