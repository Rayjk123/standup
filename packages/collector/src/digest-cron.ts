import type { Database } from "bun:sqlite";
import {
  getSetting,
  setSetting,
  getProjects,
  getAllSessions,
  getActiveWork,
  getTaskRunsFinishedSince,
  getCheckpointsSince,
  getRecentKnowledgeChanges,
  getRecentResolvedAsks,
  getLaunchesSince,
  createDigest,
  listPendingPersonaApprovalsAwaiting,
  getSessionKnowledgeUsage,
  summarizeKnowledgeUsage,
  type ActiveWorkItem,
  type KnowledgeUsageSummary,
  type SessionKnowledgeUsage,
} from "@standup/store";
import { hostUserAlias } from "./host-user.js";
import type {
  Ask,
  Checkpoint,
  Digest,
  DigestCounts,
  KnowledgeChange,
  Launch,
  TaskRun,
  WsMessage,
} from "@standup/shared";
import { approvalHeadline, isRoutineCheckpoint } from "@standup/shared";
import { runClaudeText } from "./claude-cli.js";
import { DIGEST_CWD } from "./internal-cwd.js";
import { stripPlaybooks } from "./persona/playbook.js";
import { stripOwnerPreferences } from "./persona/preferences-block.js";

/**
 * Daily morning digest — a once-a-day standup summary of the last ~24h of work
 * across every project, posted at the configured local hour (default 9am EST).
 *
 * Modeled on knowledge-graph-audit.ts: a setTimeout kick plus a ~15min setInterval
 * poll with an injectable clock, an anacron per-day gate (a settings key holding
 * the last local date it ran), and a 9am FLOOR so an early poll waits. A process
 * that was down at 9am runs on the first poll after it returns (still today, not
 * yet done) — a best-attempt catch-up. Delivery is persist-then-broadcast (clone
 * of makeKnowledgeChangeEmitter) so the digest survives a reload/reconnect and
 * lands with no client connected. The cron NEVER throws into the process.
 */

/** Poll interval: ~15min. The per-day settings gate keeps a `bun --watch` restart
 *  from re-posting the digest the same day. */
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
/** Delay before the first kick so the server binds and the initial syncAll settles
 *  before a poll reads the store. */
const INITIAL_DELAY_MS = 60_000;
/** Local hour (0–23) the digest floor opens at — before it, a poll waits. */
const DEFAULT_DIGEST_HOUR = 9;
/** TZ the local date/hour are computed in — explicit + configurable. */
const DEFAULT_DIGEST_TZ = "America/New_York";
/** The cheap model the summary is written with. */
const DEFAULT_DIGEST_MODEL = "claude-sonnet-5";
/** The summarization spawn's timeout — a slow model call falls back, never hangs the cron. */
const DEFAULT_TIMEOUT_MS = 120_000;
/** The window the digest covers, in hours. */
const DEFAULT_SINCE_HOURS = 24;

/** Env flag gating the digest (DEFAULT ON). */
export const DIGEST_ENV = "STANDUP_DIGEST";
/** Settings key gating the digest (DEFAULT ON), an alternative to the env flag. */
export const DIGEST_SETTING_KEY = "digest.enabled";

const DIGEST_HOUR_ENV = "STANDUP_DIGEST_HOUR";
const DIGEST_TZ_ENV = "STANDUP_DIGEST_TZ";
const DIGEST_INTERVAL_ENV = "STANDUP_DIGEST_INTERVAL_MS";
const DIGEST_MODEL_ENV = "STANDUP_DIGEST_MODEL";

/** The per-day gate key — holds the local ISO date the digest last posted, so a
 *  restart mid-day (or a later poll) doesn't re-post it. */
export const DIGEST_LAST_RUN_KEY = "digest_last_run";

/** Item caps per project section so a busy project can't blow the render budget. */
const MAX_ITEMS_PER_LINE = 6;
/** Overall render cap — the head is kept (the overview and first projects matter most). */
const MAX_RENDER_CHARS = 12_000;
/** Most sessions the knowledge-use lines read across the whole window. */
const MAX_USAGE_SESSIONS = 2000;

const MS_PER_HOUR = 3_600_000;

function isTruthyFlag(v: string | null | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "on" || s === "yes" || s === "enabled";
}

function isFalsyFlag(v: string | null | undefined): boolean {
  if (v == null) return false;
  const s = v.trim().toLowerCase();
  return s === "0" || s === "false" || s === "off" || s === "no" || s === "disabled";
}

/**
 * Whether the daily digest is enabled. DEFAULT ON (the mirror of the nightly
 * sweep's dual env-or-setting gate, inverted to opt-out): with neither the env
 * flag nor the settings key set, it runs. An explicit falsy env value
 * (`0`/`false`/`off`) hard-disables it even if the settings key is on, so an
 * operator can always kill the digest from the environment; a falsy settings
 * value disables it when the env flag is unset.
 */
export function isDigestEnabled(
  env: string | undefined,
  setting: string | null
): boolean {
  if (isFalsyFlag(env)) return false;
  if (isTruthyFlag(env)) return true;
  if (isFalsyFlag(setting)) return false;
  return true;
}

/**
 * The local date (ISO `YYYY-MM-DD`) and hour (0–23) of `now` in `tz`, via
 * Intl.DateTimeFormat('en-CA') — the one net-new bit of TZ math (no existing TZ
 * code). en-CA formats the date parts ISO-style; hour12:false yields a 24-hour
 * hour. Some engines emit "24" for midnight, which is normalized to 0. Pure, so
 * the gate's TZ handling is unit-testable.
 */
export function localParts(now: Date, tz: string): { date: string; hour: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
  });
  const parts = fmt.formatToParts(now);
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  let hour = parseInt(get("hour"), 10);
  if (hour === 24) hour = 0;
  return { date, hour: Number.isFinite(hour) ? hour : 0 };
}

/** A per-project bucket of the last-window activity the digest renders. */
export interface DigestProjectSection {
  projectId: string;
  projectName: string;
  activeWork: ActiveWorkItem[];
  /** Task runs that FINISHED (ended_at) inside the window. */
  taskRuns: TaskRun[];
  /** Non-routine checkpoints inside the window. */
  checkpoints: Checkpoint[];
  knowledgeChanges: KnowledgeChange[];
  /** Asks resolved inside the window. */
  resolvedAsks: Ask[];
  /** Launches created inside the window. */
  launches: Launch[];
  /** How the project's sessions started inside the window used the knowledge base; absent when none started. */
  knowledgeUsage?: KnowledgeUsageSummary;
}

/** The gathered, windowed view the digest renders and counts. */
export interface DigestData {
  /** ISO start of the covered window. */
  periodStart: string;
  /** ISO end of the covered window (when it was built). */
  periodEnd: string;
  /** The local ISO date the digest is FOR (the gate key). */
  date: string;
  /** Persona's approval cards still waiting on the owner, one plain-English line each; absent when none are. */
  awaitingApproval?: string[];
  sections: DigestProjectSection[];
  counts: DigestCounts;
  /** True when no project had any activity in the window — a quiet day. */
  empty: boolean;
}

export interface GatherOptions {
  now?: Date;
  sinceHours?: number;
  tz?: string;
  /** The digest's reader, whose waiting Persona cards it lists; defaults to the host (hostUserAlias). */
  reader?: string;
}

/**
 * Epoch ms of an ISO / bare-UTC-sqlite string; NaN when unparseable. A bare
 * sqlite stamp (`YYYY-MM-DD HH:MM:SS`, no zone) is normalized to UTC before
 * parsing — mirroring format.ts's parseTimestampMs. Only STRING timestamps are
 * accepted on purpose: a mapper-built Date (`new Date(bareStamp)`) parses the
 * bare stamp as LOCAL time, so its `getTime()` is offset-skewed and must never
 * be windowed against a true-UTC bound (Date-typed dimensions are windowed in
 * SQL instead — see gatherDigest).
 */
function toMs(value: string | undefined): number {
  if (value == null) return NaN;
  const t = value.trim();
  const bare = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(t);
  return Date.parse(bare ? `${t.replace(" ", "T")}Z` : t);
}

/** A bare UTC sqlite datetime (`YYYY-MM-DD HH:MM:SS`) for a resolved_at comparison. */
function sqlUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Gather the last ~24h of work across every project into per-project sections.
 * Store-scoped dimensions (active work, finished task runs, knowledge changes,
 * launches) are read per project; the session-scoped ones (non-routine
 * checkpoints, resolved asks) are read globally and bucketed onto their session's
 * project. Knowledge use is summarized per project over the root sessions
 * started in the window. A section is kept only when it carries at least one item; an all-empty
 * gather is a quiet day. Reads only, writes nothing.
 */
export function gatherDigest(db: Database, opts: GatherOptions = {}): DigestData {
  const now = opts.now ?? new Date();
  const tz = opts.tz ?? DEFAULT_DIGEST_TZ;
  const sinceHours = opts.sinceHours ?? DEFAULT_SINCE_HOURS;
  const nowMs = now.getTime();
  const sinceMs = nowMs - sinceHours * MS_PER_HOUR;
  const since = new Date(sinceMs);
  // Bare UTC sqlite cutoff shared by every SQL-windowed dimension. The
  // Date-typed dimensions (finished task runs, launches, checkpoints) are
  // windowed in SQL against their stored UTC stamps rather than against a
  // mapper-built Date, whose bare stamp was parsed as LOCAL time and so skews a
  // getTime() comparison by the UTC offset.
  const sinceIso = sqlUtc(since);
  // Only string timestamps flow through here (knowledge-change createdAt); the
  // Date-typed dimensions never do — see the SQL-windowed reads below.
  const inWindow = (value: string | undefined): boolean => {
    const ms = toMs(value);
    return Number.isFinite(ms) && ms >= sinceMs;
  };

  const projects = getProjects(db);
  const nameById = new Map(projects.map((p) => [p.id, p.name]));

  // session -> project for the session-scoped dimensions (checkpoints, asks).
  const sessionProject = new Map<string, string>();
  for (const s of getAllSessions(db)) sessionProject.set(s.id, s.projectId);

  const byProject = new Map<string, DigestProjectSection>();
  const ensure = (projectId: string): DigestProjectSection => {
    let sec = byProject.get(projectId);
    if (!sec) {
      sec = {
        projectId,
        projectName: nameById.get(projectId) ?? projectId,
        activeWork: [],
        taskRuns: [],
        checkpoints: [],
        knowledgeChanges: [],
        resolvedAsks: [],
        launches: [],
      };
      byProject.set(projectId, sec);
    }
    return sec;
  };

  for (const p of projects) {
    const activeWork = getActiveWork(db, p.id, { sinceHours });
    const taskRuns = getTaskRunsFinishedSince(db, p.id, sinceIso);
    if (activeWork.length || taskRuns.length) {
      const sec = ensure(p.id);
      sec.activeWork = activeWork;
      sec.taskRuns = taskRuns;
    }
  }

  // The digest is shared (persisted, broadcast, posted to Slack), so it reads
  // as no one: no personal-layer change of any owner.
  for (const k of getRecentKnowledgeChanges(db, 500, null)) {
    if (inWindow(k.createdAt)) ensure(k.projectId).knowledgeChanges.push(k);
  }
  for (const l of getLaunchesSince(db, sinceIso)) {
    ensure(l.projectId).launches.push(l);
  }
  for (const c of getCheckpointsSince(db, sinceIso)) {
    if (isRoutineCheckpoint(c.source)) continue;
    const pid = sessionProject.get(c.sessionId);
    if (pid) ensure(pid).checkpoints.push(c);
  }
  for (const a of getRecentResolvedAsks(db, sinceIso)) {
    const pid = sessionProject.get(a.sessionId);
    if (pid) ensure(pid).resolvedAsks.push(a);
  }
  const usageByProject = new Map<string, SessionKnowledgeUsage[]>();
  for (const u of getSessionKnowledgeUsage(db, {
    since: sinceIso,
    until: sqlUtc(now),
    limit: MAX_USAGE_SESSIONS,
  })) {
    if (!u.projectId) continue;
    const rows = usageByProject.get(u.projectId) ?? [];
    rows.push(u);
    usageByProject.set(u.projectId, rows);
  }
  for (const [pid, rows] of usageByProject) {
    ensure(pid).knowledgeUsage = summarizeKnowledgeUsage(rows, db);
  }

  const sections = [...byProject.values()].sort((a, b) =>
    a.projectName.localeCompare(b.projectName)
  );

  const counts: DigestCounts = {
    projects: sections.length,
    activeWork: sections.reduce((n, s) => n + s.activeWork.length, 0),
    taskRuns: sections.reduce((n, s) => n + s.taskRuns.length, 0),
    checkpoints: sections.reduce((n, s) => n + s.checkpoints.length, 0),
    knowledgeChanges: sections.reduce((n, s) => n + s.knowledgeChanges.length, 0),
    asks: sections.reduce((n, s) => n + s.resolvedAsks.length, 0),
    launches: sections.reduce((n, s) => n + s.launches.length, 0),
  };

  // Only the cards the reader decides: another user's Persona cards are theirs.
  const awaitingApproval = listPendingPersonaApprovalsAwaiting(db, opts.reader ?? hostUserAlias()).map((a) =>
    approvalHeadline(a)
  );

  return {
    periodStart: since.toISOString(),
    periodEnd: now.toISOString(),
    date: localParts(now, tz).date,
    ...(awaitingApproval.length > 0 ? { awaitingApproval } : {}),
    sections,
    counts,
    empty: sections.length === 0,
  };
}

/** A short, single-line rendering of one item, trimmed of newlines. */
function oneLine(s: string, max = 140): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** Render up to MAX_ITEMS_PER_LINE items, noting how many were dropped. */
function renderItems<T>(label: string, items: T[], fmt: (x: T) => string): string {
  if (items.length === 0) return "";
  const shown = items.slice(0, MAX_ITEMS_PER_LINE).map(fmt).filter(Boolean);
  const overflow = items.length - Math.min(items.length, MAX_ITEMS_PER_LINE);
  const more = overflow > 0 ? ` (+${overflow} more)` : "";
  return `- ${label} (${items.length}): ${shown.join("; ")}${more}`;
}

/**
 * One line of a project's knowledge use, e.g. `- Knowledge use: 6/8 sessions
 * searched · 5/7 editing sessions searched before editing · 3/8 proposed
 * (7 calls) · 2 drafts pending`. The before-editing clause is left out when no
 * session edited, and the drafts clause when none are pending. When sessions
 * ran under more than one harness, the before-editing clause is split by
 * harness, e.g. `(claude 4/5, codex 1/2)`. Empty when no
 * session started in the window.
 */
export function renderKnowledgeUsage(u: KnowledgeUsageSummary | undefined): string {
  if (!u || u.sessions === 0) return "";
  const parts = [`${u.searched}/${u.sessions} sessions searched`];
  if (u.editing > 0) {
    const perHarness = Object.entries(u.byHarness ?? {}).filter(([, h]) => h.sessions > 0);
    const split =
      perHarness.length > 1
        ? ` (${perHarness.map(([name, h]) => `${name} ${h.searchedBeforeEdit}/${h.editing}`).join(", ")})`
        : "";
    parts.push(
      `${u.searchedBeforeEdit}/${u.editing} editing session${u.editing === 1 ? "" : "s"} searched before editing${split}`
    );
  }
  parts.push(`${u.proposed}/${u.sessions} proposed (${u.proposalCalls} call${u.proposalCalls === 1 ? "" : "s"})`);
  if (u.draftsPending > 0) {
    parts.push(`${u.draftsPending} draft${u.draftsPending === 1 ? "" : "s"} pending`);
  }
  return `- Knowledge use: ${parts.join(" · ")}`;
}

/**
 * Render the gathered data into a COMPACT, size-bounded plain-text summary — the
 * fallback body AND the model's input. An empty window renders a real "quiet day"
 * sentence, never a blank. Over-budget renders keep the HEAD (à la
 * distill-cron.renderTranscript, which keeps the tail — here the overview and
 * first projects are what matter, so the head is kept).
 */
export function renderDigest(data: DigestData): string {
  const awaiting = data.awaitingApproval?.length
    ? renderItems("Waiting on your approval", data.awaitingApproval, (line) => oneLine(line, 160))
    : "";
  if (data.empty) {
    const quiet =
      "Quiet day — no agent activity in the last 24h. Nothing shipped, in " +
      "flight, or blocked across the tracked projects.";
    return awaiting ? `${quiet}\n\n${awaiting}` : quiet;
  }

  const lines: string[] = [];
  lines.push(
    `Standup digest — last 24h across ${data.counts.projects} project` +
      `${data.counts.projects === 1 ? "" : "s"}.`
  );
  if (awaiting) lines.push("", awaiting);
  for (const s of data.sections) {
    lines.push("");
    lines.push(`## ${s.projectName}`);
    const rows = [
      renderItems("Active", s.activeWork, (w) => `${oneLine(w.title || "Untitled", 80)} (${w.status})`),
      renderItems("Finished", s.taskRuns, (r) =>
        `${r.status}${r.summary ? `: ${oneLine(r.summary, 100)}` : r.error ? `: ${oneLine(r.error, 100)}` : ""}`
      ),
      renderItems("Checkpoints", s.checkpoints, (c) => oneLine(c.summary, 100)),
      renderItems("Knowledge", s.knowledgeChanges, (k) => `${k.kind} ${oneLine(k.title || k.slug, 80)}`),
      renderKnowledgeUsage(s.knowledgeUsage),
      renderItems("Resolved asks", s.resolvedAsks, (a) => `${a.status}: ${oneLine(a.question, 90)}`),
      renderItems("Launches", s.launches, (l) => oneLine(stripPlaybooks(stripOwnerPreferences(l.task)), 100)),
    ].filter(Boolean);
    for (const row of rows) lines.push(row);
  }

  const joined = lines.join("\n");
  return joined.length > MAX_RENDER_CHARS ? joined.slice(0, MAX_RENDER_CHARS) : joined;
}

/** The summarization prompt handed to the model over the rendered activity. */
function buildPrompt(rendered: string): string {
  return (
    "Write a concise morning standup digest of the last ~24 hours across these " +
    "projects — what shipped, what's in flight, and what's blocked or awaiting " +
    "review. Group by project, keep it short and skimmable, and do NOT invent " +
    "anything that isn't in the activity below.\n\n" +
    "Activity:\n" +
    rendered
  );
}

export interface SummarizeOptions {
  /** The model seam — defaults to a headless `claude` call. Injectable for tests. */
  generate?: (prompt: string) => Promise<string | null>;
  model?: string;
  cwd?: string;
  timeoutMs?: number;
}

/**
 * Summarize the rendered activity with the cheap model, falling back to the
 * plain rendered summary when the call returns null / throws / times out. NEVER
 * throws — a summarization failure must not break the cron. A quiet day skips the
 * model entirely (nothing to summarize) and returns the rendered sentence.
 */
export async function summarizeDigest(
  rendered: string,
  data: DigestData,
  opts: SummarizeOptions = {}
): Promise<string> {
  if (data.empty) return rendered;
  const model = opts.model ?? process.env[DIGEST_MODEL_ENV] ?? DEFAULT_DIGEST_MODEL;
  const generate =
    opts.generate ??
    ((prompt: string) =>
      runClaudeText(prompt, {
        model,
        cwd: opts.cwd ?? DIGEST_CWD,
        timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        tools: "",
      }));
  try {
    const out = await generate(buildPrompt(rendered));
    const text = out?.trim();
    return text && text.length > 0 ? text : rendered;
  } catch (err) {
    console.error("[digest-cron] summarize failed:", err);
    return rendered;
  }
}

/**
 * Persist-then-broadcast a finished digest, cloning makeKnowledgeChangeEmitter:
 * the row is written FIRST, then broadcast, so the digest is durable and lands
 * even with no client connected. INSERT OR IGNORE on the per-day id
 * makes a same-day re-post a no-op.
 */
export function makeDigestEmitter(
  db: Database,
  broadcast: (message: WsMessage) => void
): (digest: Digest) => void {
  return function emitDigest(digest: Digest): void {
    createDigest(db, digest);
    broadcast({ type: "digest:posted", payload: digest, timestamp: digest.createdAt });
  };
}

export interface DigestCronOptions {
  /** The WS broadcast — the digest is delivered through {@link makeDigestEmitter}. */
  broadcast: (message: WsMessage) => void;
  /** Persist-then-broadcast override; defaults to makeDigestEmitter(db, broadcast). Injectable for tests. */
  emit?: (digest: Digest) => void;
  /** Injectable clock for the anacron gate + 9am floor (tests). */
  now?: () => Date;
  /** The model seam handed to summarizeDigest. */
  generate?: (prompt: string) => Promise<string | null>;
  model?: string;
  cwd?: string;
  timeoutMs?: number;
  /** Local hour floor; env STANDUP_DIGEST_HOUR overrides the default 9. */
  digestHour?: number;
  /** TZ the date/hour are computed in; env STANDUP_DIGEST_TZ overrides. */
  tz?: string;
  /** Poll interval; env STANDUP_DIGEST_INTERVAL_MS overrides. */
  intervalMs?: number;
  /** The gather window in hours (default 24). */
  sinceHours?: number;
}

/** Parses a positive integer from an env value, falling back to `fallback`. */
function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value == null) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Parses the digest hour (0–23) from an env value, else `fallback`. */
function parseHour(value: string | undefined, fallback: number): number {
  if (value == null) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 && n <= 23 ? n : fallback;
}

/**
 * One scheduler tick: the anacron gate + 9am floor, then build + summarize +
 * deliver, once per local day. Exported so a test can drive the gate (TZ math,
 * catch-up, already-done) under an injected {@link DigestCronOptions.now} clock
 * without waiting on the timer. Records the run date in a `finally` so a
 * per-item failure — or a failed summarization — doesn't re-fire the digest
 * every poll for the rest of the day. NEVER throws.
 */
export async function tick(db: Database, opts: DigestCronOptions): Promise<void> {
  const now = opts.now?.() ?? new Date();
  const tz = opts.tz ?? process.env[DIGEST_TZ_ENV] ?? DEFAULT_DIGEST_TZ;
  const digestHour = opts.digestHour ?? parseHour(process.env[DIGEST_HOUR_ENV], DEFAULT_DIGEST_HOUR);
  const { date, hour } = localParts(now, tz);

  if (hour < digestHour) return; // before the floor — wait
  if (getSetting(db, DIGEST_LAST_RUN_KEY) === date) return; // already ran today

  try {
    const data = gatherDigest(db, { now, tz, sinceHours: opts.sinceHours });
    const rendered = renderDigest(data);
    const body = await summarizeDigest(rendered, data, {
      generate: opts.generate,
      model: opts.model,
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
    });
    const emit = opts.emit ?? makeDigestEmitter(db, opts.broadcast);
    const digest: Digest = {
      id: `digest:${date}`,
      createdAt: now.toISOString(),
      periodStart: data.periodStart,
      periodEnd: data.periodEnd,
      body,
      projects: data.sections.map((s) => s.projectId),
      counts: data.counts,
    };
    emit(digest);
    console.log(
      `[digest-cron] posted digest for ${date}: ${data.counts.projects} project(s), ` +
        `${data.counts.taskRuns} finished / ${data.counts.activeWork} active`
    );
  } catch (err) {
    console.error("[digest-cron] tick failed:", err);
  } finally {
    setSetting(db, DIGEST_LAST_RUN_KEY, date);
  }
}

/**
 * Start the daily-digest scheduler. The CALLER gates registration on
 * {@link isDigestEnabled}; once started, it kicks after INITIAL_DELAY_MS and then
 * on the interval, with the per-day gate + 9am floor in {@link tick}. Returns the
 * interval timer so the caller can clearInterval it on shutdown, mirroring
 * startKnowledgeGraphAuditCron.
 */
export function startDigestCron(
  db: Database,
  opts: DigestCronOptions
): ReturnType<typeof setInterval> {
  const intervalMs =
    opts.intervalMs ?? parsePositiveInt(process.env[DIGEST_INTERVAL_ENV], DEFAULT_INTERVAL_MS);

  const kick = () => {
    tick(db, opts).catch((e) => console.error("[digest-cron]", e));
  };
  setTimeout(kick, INITIAL_DELAY_MS);
  return setInterval(kick, intervalMs);
}
