/*
 * Fills a scratch collector's database with a long-lived owner's volume of
 * history, so a load-time measurement sees the snapshot and thread sizes a
 * real install serves rather than an empty one. The schema comes from the
 * store's own migrations (createStore); the rows go in with plain inserts in
 * one transaction, spread over the past `days` with timestamps in each
 * table's native format.
 *
 * The owner's Persona console thread is the store's getOrCreatePersonaConsoleThread
 * row (the oldest console thread wins), back-dated, so it is the thread the
 * console opens by default.
 *
 * Each session also gets the hook events a real one leaves (SessionStart, a
 * prompt, tool use pairs, Stop, and SessionEnd once done), every payload
 * carrying the session's transcript_path the way Claude Code's hooks do, and
 * a JSONL transcript at that path under the scratch HOME
 * (<home>/.claude/projects/<encoded cwd>/<session>.jsonl, 50-200 KB, the
 * assistant turns stamped with a model). So the collector's per-session
 * transcript reads (the current model, working dirs) run against files of a
 * real size, not against sessions with no transcript at all.
 *
 * It refuses any path whose real location is outside /tmp: it is only ever
 * pointed at a scratch DB and a scratch HOME.
 */
import { randomUUID } from "crypto";
import { lstatSync, mkdirSync, realpathSync, rmSync, utimesSync, writeFileSync, type Stats } from "fs";
import { homedir, userInfo } from "os";
import { basename, dirname, join, resolve } from "path";
import { createStore, getOrCreatePersonaConsoleThread } from "../../store/src/index.ts";

const REAL_TMP = realpathSync("/tmp");

/** lstat, or undefined when nothing (not even a dangling link) is at `path`. */
function lstatOrNone(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/**
 * `path`'s real location, required to be under the real /tmp. A path not
 * made yet resolves through its nearest existing ancestor; a dangling link
 * anywhere on the way is refused (realpath fails on it).
 */
export function realUnderTmp(path: string): string {
  const real = resolvedPath(path);
  if (!real.startsWith(`${REAL_TMP}/`)) throw new Error(`${path} resolves to ${real}, outside ${REAL_TMP}`);
  return real;
}

/** The live install's data dir, from the account's home (not `$HOME`, which a caller may override). */
export const LIVE_DATA_DIR = join(userInfo().homedir || homedir(), ".local", "share", "standup");

/** `path` resolved as far as it exists, the rest joined on: where it really points. */
function resolvedPath(path: string): string {
  let existing = resolve(path);
  const rest: string[] = [];
  while (!lstatOrNone(existing)) {
    rest.unshift(basename(existing));
    existing = dirname(existing);
  }
  return join(realpathSync(existing), ...rest);
}

/**
 * Refuses `path` when it really points into the live install's data dir (its
 * database, secrets, worktrees), or at a directory that holds it, compared by
 * resolved path on both sides.
 */
export function refuseLiveInstall(path: string, liveDir: string = LIVE_DATA_DIR): void {
  const real = resolvedPath(path);
  const live = resolvedPath(liveDir);
  if (real === live || real.startsWith(`${live}/`) || live.startsWith(`${real}/`)) {
    throw new Error(`${path} resolves to ${real}, which is the live install's ${live}`);
  }
}

/** Refuses a symlink at `path`; nothing there is fine. */
export function refuseSymlink(path: string): void {
  if (lstatOrNone(path)?.isSymbolicLink()) throw new Error(`${path} is a symlink`);
}

/** `path` is a real directory (not a symlink) owned by this process's user. */
export function requireOwnedDir(path: string): void {
  const st = lstatOrNone(path);
  if (!st) throw new Error(`${path} does not exist`);
  if (st.isSymbolicLink()) throw new Error(`${path} is a symlink`);
  if (!st.isDirectory()) throw new Error(`${path} is not a directory`);
  if (st.uid !== process.getuid!()) throw new Error(`${path} is owned by uid ${st.uid}, not ${process.getuid!()}`);
}

export interface SeedVolumes {
  projects: number;
  sessions: number;
  /** Sessions still open (running/idle/waiting); the rest are done. */
  activeSessions: number;
  checkpointsPerSession: number;
  asks: number;
  pendingAsks: number;
  messages: number;
  jobs: number;
  approvals: number;
  pendingApprovals: number;
  launches: number;
  tickets: number;
  days: number;
  /** Hook events per session. */
  eventsPerSession: number;
  /** Nonzero: every session gets a JSONL transcript its events point at. 0: none, and no transcript_path. */
  transcripts: number;
}

export interface SeedOptions {
  /** The scratch collector's HOME; transcripts go under <home>/.claude/projects. Required when transcripts are seeded. */
  home?: string;
}

/** About 2-3x a heavy owner's real volume. */
export const DEFAULT_VOLUMES: SeedVolumes = {
  projects: 15,
  sessions: 1500,
  activeSessions: 40,
  checkpointsPerSession: 30,
  asks: 5000,
  pendingAsks: 50,
  messages: 8000,
  jobs: 1000,
  approvals: 5000,
  pendingApprovals: 20,
  launches: 300,
  tickets: 200,
  days: 90,
  eventsPerSession: 20,
  transcripts: 1,
};

export const NO_VOLUMES: SeedVolumes = {
  ...DEFAULT_VOLUMES,
  projects: 0,
  sessions: 0,
  activeSessions: 0,
  checkpointsPerSession: 0,
  asks: 0,
  pendingAsks: 0,
  messages: 0,
  jobs: 0,
  approvals: 0,
  pendingApprovals: 0,
  launches: 0,
  tickets: 0,
  eventsPerSession: 0,
  transcripts: 0,
};

export interface SeedResult {
  threadId: string | null;
  counts: Record<string, number>;
  avgMessageChars: number;
  ms: number;
}

/** A small deterministic PRNG, so every seeded DB is the same. */
function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
  };
}

const WORDS = (
  "the collector session worker review persona launch ticket branch build test deploy rebase merge snapshot thread " +
  "knowledge doc checkpoint migration schema index query cache socket reconnect console view route chunk bundle " +
  "lazy prefetch render latency budget tunnel proxy token owner approval policy floor hold gate pipeline stage " +
  "verify green red failing passing flaky retry backoff timeout handler store row column table insert update"
).split(" ");

const CODE = [
  "```ts\nexport function median(xs: number[]): number {\n  const s = [...xs].sort((a, b) => a - b);\n  return s[Math.floor(s.length / 2)]!;\n}\n```",
  "```bash\nbun run typecheck && bun test packages/collector/src/persona\ngit log --oneline -5\n```",
  "```sql\nSELECT id, status, created_at FROM persona_jobs WHERE owner = ? ORDER BY created_at DESC LIMIT 50;\n```",
  "```diff\n-  const limit = 1000;\n+  const limit = opts.limit ?? 200;\n   return rows.reverse();\n```",
  "```json\n{ \"runState\": \"idle\", \"pendingInbox\": 0, \"activeLaunches\": 2, \"maxActiveLaunches\": 6 }\n```",
];

function sentence(r: ReturnType<typeof rng>): string {
  const n = r.int(8, 22);
  const words: string[] = [];
  for (let i = 0; i < n; i++) words.push(r.pick(WORDS));
  const s = words.join(" ");
  return s[0]!.toUpperCase() + s.slice(1) + ".";
}

function paragraph(r: ReturnType<typeof rng>, minChars: number): string {
  let p = "";
  while (p.length < minChars) p += (p ? " " : "") + sentence(r);
  return p;
}

/**
 * A Persona thread message: most 1-3 KB, a tenth short; plain prose, markdown
 * with headings and lists, or prose around a code block.
 */
function messageText(r: ReturnType<typeof rng>, role: "user" | "persona"): string {
  if (role === "user" || r.next() < 0.1) return paragraph(r, r.int(20, role === "user" ? 400 : 200));
  const target = r.int(1000, 3000);
  const shape = r.next();
  if (shape < 0.35) {
    let t = "";
    while (t.length < target) t += (t ? "\n\n" : "") + paragraph(r, r.int(200, 500));
    return t;
  }
  if (shape < 0.7) {
    let t = `**${sentence(r)}**\n\n`;
    while (t.length < target) {
      t += `### ${r.pick(WORDS)} ${r.pick(WORDS)}\n\n`;
      for (let i = r.int(2, 5); i > 0; i--) t += `- ${sentence(r)} \`${r.pick(WORDS)}\`\n`;
      t += "\n" + paragraph(r, 150) + "\n\n";
    }
    return t.trim();
  }
  let t = paragraph(r, 200) + "\n\n" + r.pick(CODE) + "\n\n";
  while (t.length < target) t += paragraph(r, 200) + "\n\n" + (r.next() < 0.5 ? r.pick(CODE) + "\n\n" : "");
  return t.trim();
}

/** `YYYY-MM-DD HH:MM:SS`, SQLite's datetime('now') format. */
const sqlTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const isoTime = (ms: number) => new Date(ms).toISOString();

const MODELS = ["claude-opus-4-5-20251101", "claude-sonnet-4-5-20250929", "claude-opus-4-1-20250805", "claude-haiku-4-5-20251001"] as const;
const TOOLS = ["Bash", "Read", "Edit", "Grep", "Write", "Glob"] as const;
/** Stand-ins a transcript body carries, filled per session. */
const SID = "@@seed-sid@@";
const CWD = "@@seed-cwd@@";
const MODEL = "@@seed-model@@";
const TRANSCRIPT_BODIES = 8;

/** Claude Code's project directory name for a cwd: every non-alphanumeric becomes `-`. */
const encodeCwd = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

/**
 * A session transcript of `targetBytes`, in Claude Code's JSONL shape: a user
 * prompt, then assistant turns (text, a tool_use) answered by tool_result
 * user records, each assistant turn's `message.model` the session's model and
 * the odd tool-only turn `<synthetic>`. The session id, cwd and model are left
 * as stand-ins, so one body serves many sessions.
 */
function transcriptBody(r: ReturnType<typeof rng>, targetBytes: number): string {
  const lines: string[] = [];
  let bytes = 0;
  let n = 0;
  let parent: string | null = null;
  const t0 = Date.UTC(2026, 8, 1);
  const push = (record: Record<string, unknown>) => {
    const uuid = `${SID}-${String(++n).padStart(5, "0")}`;
    const line = JSON.stringify({ parentUuid: parent, ...record, uuid, timestamp: isoTime(t0 + n * 7_000), sessionId: SID, cwd: CWD });
    parent = uuid;
    lines.push(line);
    bytes += line.length + 1;
  };
  push({ type: "user", message: { role: "user", content: paragraph(r, r.int(80, 600)) } });
  while (bytes < targetBytes) {
    const tool = r.pick(TOOLS);
    const toolId = `toolu_${n.toString(36)}${r.int(0, 1e9).toString(36)}`;
    const synthetic = r.next() < 0.05;
    push({
      type: "assistant",
      message: {
        role: "assistant",
        model: synthetic ? "<synthetic>" : MODEL,
        content: [
          { type: "text", text: paragraph(r, r.int(80, 900)) },
          { type: "tool_use", id: toolId, name: tool, input: tool === "Bash" ? { command: `bun test ${r.pick(WORDS)}` } : { file_path: `${CWD}/src/${r.pick(WORDS)}.ts` } },
        ],
        usage: { input_tokens: r.int(1, 40), output_tokens: r.int(40, 1200), cache_read_input_tokens: r.int(10_000, 180_000), cache_creation_input_tokens: r.int(0, 4000) },
      },
    });
    push({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: r.next() < 0.3 ? r.pick(CODE) : paragraph(r, r.int(100, 2500)) }] },
    });
    if (r.next() < 0.08) push({ type: "user", message: { role: "user", content: paragraph(r, r.int(20, 300)) } });
  }
  // A transcript ends on a real assistant turn: the one the current model is read from.
  push({ type: "assistant", message: { role: "assistant", model: MODEL, content: [{ type: "text", text: paragraph(r, r.int(100, 600)) }], usage: { input_tokens: 4, output_tokens: 300 } } });
  return lines.join("\n") + "\n";
}

interface SessionTranscript {
  path: string;
  id: string;
  cwd: string;
  model: string;
  body: number;
  mtimeMs: number;
}

/** A v4-shaped UUID from `r`, so a session's id (and its transcript's file name) is the same every run. */
function seededUuid(r: ReturnType<typeof rng>): string {
  const hex = Array.from({ length: 32 }, () => r.int(0, 15).toString(16)).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${"89ab"[r.int(0, 3)]}${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export function seedRealistic(dbPath: string, owner: string, v: SeedVolumes, opts: SeedOptions = {}): SeedResult {
  const resolved = resolve(dbPath);
  const realDir = realpathSync(dirname(resolved));
  if (!realDir.startsWith(`${REAL_TMP}/`)) throw new Error(`refusing to seed ${resolved}: its directory is ${realDir}, outside ${REAL_TMP}`);
  // No symlink on the way: the directory is where its path says it is.
  const lexicalDir = dirname(resolved).startsWith("/tmp/") ? join(REAL_TMP, dirname(resolved).slice("/tmp/".length)) : dirname(resolved);
  if (realDir !== lexicalDir) throw new Error(`refusing to seed ${resolved}: its directory leads elsewhere, to ${realDir}`);
  const path = join(realDir, basename(resolved));
  refuseLiveInstall(path);
  // A fresh DB each run, so the volumes are exactly what was asked for.
  for (const suffix of ["", "-wal", "-shm"]) {
    refuseSymlink(path + suffix);
    if (lstatOrNone(path + suffix)) rmSync(path + suffix);
  }
  const withTranscripts = v.transcripts > 0 && v.sessions > 0 && v.projects > 0;
  let projectsRoot: string | null = null;
  if (withTranscripts) {
    if (!opts.home) throw new Error("seeding transcripts needs the scratch HOME (opts.home)");
    const home = realpathSync(opts.home);
    if (!home.startsWith(`${REAL_TMP}/`)) throw new Error(`refusing to write transcripts under ${home}: outside ${REAL_TMP}`);
    refuseLiveInstall(home);
    requireOwnedDir(home);
    const root = join(home, ".claude", "projects");
    // Checked before and after it is made: an existing .claude that links out of /tmp is refused, not written through.
    realUnderTmp(root);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    for (const d of [join(home, ".claude"), root]) requireOwnedDir(d);
    projectsRoot = realUnderTmp(root);
  }
  const started = performance.now();
  const store = createStore(path);
  const db = store.db;
  const r = rng(20261009);
  const now = Date.now();
  const span = v.days * 86400_000;
  /** A time `frac` of the way from `days` ago to now. */
  const at = (frac: number) => now - span + Math.floor(frac * span);
  const counts: Record<string, number> = {};
  let messageChars = 0;
  let threadId: string | null = null;
  // Session ids, events and transcripts draw from their own streams, so the
  // rest of the seeded content is the same with or without them.
  const ids = rng(20261010);
  const hooks = rng(20261011);
  const transcripts: SessionTranscript[] = [];

  db.transaction(() => {
    const projectIds: string[] = [];
    const insProject = db.query("INSERT INTO projects (id, name, repos_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
    for (let i = 0; i < v.projects; i++) {
      const id = `proj-${i + 1}`;
      const t = sqlTime(at(0));
      insProject.run(id, `Project ${i + 1} ${r.pick(WORDS)}`, JSON.stringify([`/tmp/seed-repos/${id}`]), t, t);
      projectIds.push(id);
    }
    counts.projects = projectIds.length;

    const sessionIds: string[] = [];
    if (projectIds.length > 0) {
      const insSession = db.query(
        `INSERT INTO sessions (id, project_id, title, cwd, status, started_at, ended_at, created_actor, owner_actor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const insCheckpoint = db.query("INSERT INTO checkpoints (id, session_id, source, summary, created_at) VALUES (?, ?, ?, ?, ?)");
      const insEvent = db.query("INSERT INTO events (session_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)");
      const openStatuses = ["running", "idle", "waiting"] as const;
      const sources = ["structural", "self-reported", "auto"] as const;
      let checkpoints = 0;
      let events = 0;
      for (let i = 0; i < v.sessions; i++) {
        const id = seededUuid(ids);
        const project = r.pick(projectIds);
        // The newest sessions are the open ones.
        const open = i >= v.sessions - v.activeSessions;
        const start = open ? now - r.int(5, 600) * 60_000 : at(i / v.sessions);
        const end = open ? null : start + r.int(5, 240) * 60_000;
        insSession.run(
          id,
          project,
          `${sentence(r).slice(0, 70)}`,
          `/tmp/seed-repos/${project}`,
          open ? r.pick(openStatuses) : "done",
          sqlTime(start),
          end === null ? null : sqlTime(end),
          owner,
          owner
        );
        sessionIds.push(id);
        const until = end ?? now;
        for (let c = 0; c < v.checkpointsPerSession; c++) {
          const t = start + Math.floor(((c + 1) / (v.checkpointsPerSession + 1)) * (until - start));
          insCheckpoint.run(randomUUID(), id, r.pick(sources), paragraph(r, r.int(60, 240)), sqlTime(t));
          checkpoints++;
        }

        const cwd = `/tmp/seed-repos/${project}`;
        const transcriptPath = projectsRoot ? join(projectsRoot, encodeCwd(cwd), `${id}.jsonl`) : null;
        if (transcriptPath) {
          transcripts.push({ path: transcriptPath, id, cwd, model: hooks.pick(MODELS), body: hooks.int(0, TRANSCRIPT_BODIES - 1), mtimeMs: until });
        }
        // SessionStart, a prompt, tool use pairs, Stop; SessionEnd once done.
        const n = v.eventsPerSession;
        const effort = hooks.pick(["low", "medium", "high"] as const);
        for (let e = 0; e < n; e++) {
          const type =
            e === 0 ? "SessionStart"
            : e === n - 1 && end !== null ? "SessionEnd"
            : e === n - (end !== null ? 2 : 1) ? "Stop"
            : e === 1 || hooks.next() < 0.1 ? "UserPromptSubmit"
            : e % 2 === 0 ? "PreToolUse"
            : "PostToolUse";
          const tool = hooks.pick(TOOLS);
          const payload: Record<string, unknown> = {
            session_id: id,
            ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
            cwd,
            hook_event_name: type,
            permission_mode: "default",
            effort: { level: effort },
            ...(type === "UserPromptSubmit" ? { prompt: sentence(hooks) } : {}),
            ...(type === "PreToolUse" || type === "PostToolUse"
              ? { tool_name: tool, tool_input: tool === "Bash" ? { command: `bun test ${hooks.pick(WORDS)}` } : { file_path: `${cwd}/src/${hooks.pick(WORDS)}.ts` } }
              : {}),
            ...(type === "SessionStart" ? { source: "startup" } : {}),
            ...(type === "SessionEnd" ? { reason: "other" } : {}),
          };
          const t = start + Math.floor((e / Math.max(1, n - 1)) * (until - start));
          insEvent.run(id, e + 1, type, JSON.stringify(payload), sqlTime(t));
          events++;
        }
      }
      counts.sessions = sessionIds.length;
      counts.checkpoints = checkpoints;
      counts.events = events;

      const insAsk = db.query(
        `INSERT INTO asks (id, session_id, kind, question, options_json, answer, status, created_at, resolved_at, answered_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const openSessions = sessionIds.slice(-Math.max(1, v.activeSessions));
      for (let i = 0; i < v.asks; i++) {
        const pending = i >= v.asks - v.pendingAsks;
        const kind = r.next() < 0.7 ? "ask_human" : "permission_prompt";
        const options = kind === "ask_human" ? ["Yes", "No", "Something else"] : ["Allow", "Deny"];
        const t = pending ? now - r.int(1, 120) * 60_000 : at(i / v.asks);
        insAsk.run(
          randomUUID(),
          pending ? r.pick(openSessions) : r.pick(sessionIds),
          kind,
          paragraph(r, r.int(60, 400)),
          JSON.stringify(options),
          pending ? null : r.pick(options),
          pending ? "pending" : r.next() < 0.9 ? "answered" : r.pick(["timeout", "cancelled"] as const),
          sqlTime(t),
          pending ? null : sqlTime(t + r.int(1, 30) * 60_000),
          pending ? null : owner
        );
      }
      counts.asks = v.asks;
    }

    const launchIds: string[] = [];
    if (projectIds.length > 0) {
      const insLaunch = db.query(
        `INSERT INTO launches (id, project_id, task, worktree_path, branch, base_branch, session_id, status, created_at, kind, requester, launched_by)
         VALUES (?, ?, ?, ?, ?, 'main', ?, ?, ?, 'worktree', ?, ?)`
      );
      for (let i = 0; i < v.launches; i++) {
        const id = randomUUID();
        const project = r.pick(projectIds);
        const slug = `seed-${i}-${r.pick(WORDS)}`;
        insLaunch.run(
          id,
          project,
          sentence(r).slice(0, 80),
          `/tmp/seed-worktrees/${slug}`,
          `standup/${slug}`,
          sessionIds.length ? r.pick(sessionIds) : null,
          r.next() < 0.9 ? "cleaned" : "failed",
          sqlTime(at(i / Math.max(1, v.launches))),
          owner,
          owner
        );
        launchIds.push(id);
      }
      counts.launches = launchIds.length;

      const insTicket = db.query(
        `INSERT INTO tickets (id, project_id, lens, title, body, severity, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const ticketStatuses = ["proposed", "approved", "developing", "needs_review", "shipped", "shipped", "dismissed"] as const;
      for (let i = 0; i < v.tickets; i++) {
        const t = sqlTime(at(i / Math.max(1, v.tickets)));
        insTicket.run(
          randomUUID(),
          r.pick(projectIds),
          r.pick(["security", "performance", "correctness", "ux"] as const),
          sentence(r).slice(0, 90),
          paragraph(r, r.int(200, 1200)),
          r.pick(["low", "medium", "high", "critical"] as const),
          r.pick(ticketStatuses),
          t,
          t
        );
      }
      counts.tickets = v.tickets;
    }

    if (v.messages > 0 || v.jobs > 0 || v.approvals > 0) {
      const thread = getOrCreatePersonaConsoleThread(db, owner);
      threadId = thread.id;
      db.run("UPDATE persona_threads SET created_at = ?, updated_at = ? WHERE id = ?", [isoTime(at(0)), isoTime(now), thread.id]);

      const jobIds: string[] = [];
      const insJob = db.query(
        `INSERT INTO persona_jobs (id, owner, thread_id, title, goal, acceptance, status, outcome, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const insJobLaunch = db.query("INSERT INTO persona_job_launches (job_id, launch_id, created_at) VALUES (?, ?, ?)");
      for (let i = 0; i < v.jobs; i++) {
        const id = randomUUID();
        const recent = i >= v.jobs - 25;
        const status = recent ? r.pick(["active", "active", "waiting_user"] as const) : r.next() < 0.85 ? "done" : r.pick(["failed", "cancelled"] as const);
        const created = recent ? now - r.int(10, 2000) * 60_000 : at(i / v.jobs);
        insJob.run(
          id,
          owner,
          thread.id,
          sentence(r).slice(0, 80),
          paragraph(r, r.int(150, 600)),
          paragraph(r, 80),
          status,
          status === "done" ? paragraph(r, 120) : null,
          isoTime(created),
          isoTime(created + r.int(10, 600) * 60_000)
        );
        if (launchIds.length && r.next() < 0.3) insJobLaunch.run(id, r.pick(launchIds), isoTime(created));
        jobIds.push(id);
      }
      counts.jobs = jobIds.length;

      const insApproval = db.query(
        `INSERT INTO persona_approvals (id, owner, job_id, thread_id, action, summary, reason, args_json, status, result, decided_by, created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (let i = 0; i < v.approvals; i++) {
        const pending = i >= v.approvals - v.pendingApprovals;
        const created = pending ? now - r.int(1, 240) * 60_000 : at(i / v.approvals);
        const status = pending ? "pending" : r.next() < 0.8 ? "executed" : r.pick(["denied", "expired", "superseded", "failed"] as const);
        insApproval.run(
          randomUUID(),
          owner,
          jobIds.length ? r.pick(jobIds) : null,
          thread.id,
          r.pick(["launch_worker", "message_session", "close_job", "propose_knowledge"] as const),
          sentence(r).slice(0, 120),
          paragraph(r, 80),
          JSON.stringify({ project: "proj-1", task: sentence(r) }),
          status,
          pending ? null : paragraph(r, 60),
          pending ? null : owner,
          isoTime(created),
          pending ? null : isoTime(created + r.int(1, 60) * 60_000)
        );
      }
      counts.approvals = v.approvals;

      const insMessage = db.query(
        `INSERT INTO persona_messages (id, thread_id, seq, role, text, actor, job_ids_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const insTag = db.query(
        "INSERT OR IGNORE INTO persona_message_jobs (message_id, job_id, owner, source, created_at) VALUES (?, ?, ?, 'explicit', ?)"
      );
      for (let i = 0; i < v.messages; i++) {
        const id = randomUUID();
        // Mostly owner/Persona turns, with an occasional system note.
        const role = i % 2 === 0 ? "user" : r.next() < 0.05 ? "system" : "persona";
        const text = messageText(r, role === "user" ? "user" : "persona");
        messageChars += text.length;
        const t = isoTime(at((i + 1) / (v.messages + 1)));
        const job = role === "persona" && jobIds.length && r.next() < 0.2 ? jobIds[Math.min(jobIds.length - 1, Math.floor((i / v.messages) * jobIds.length))]! : null;
        insMessage.run(id, thread.id, i + 1, role, text, role === "user" ? owner : null, job ? JSON.stringify([job]) : null, t);
        if (job) insTag.run(id, job, owner, t);
      }
      counts.messages = v.messages;
    }
  })();

  // The collector opens the file next; leave it checkpointed and closed.
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  store.close();

  if (projectsRoot && transcripts.length) {
    // 44-183 KB with stand-ins, 50-200 KB once the session's values replace them.
    const bodies = Array.from({ length: TRANSCRIPT_BODIES }, (_, i) => transcriptBody(hooks, (44 + Math.floor((i / (TRANSCRIPT_BODIES - 1)) * 139)) * 1024));
    const dirs = new Set<string>();
    let bytes = 0;
    for (const t of transcripts) {
      const dir = dirname(t.path);
      if (!dirs.has(dir)) {
        refuseSymlink(dir);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        requireOwnedDir(dir);
        if (realpathSync(dir) !== dir) throw new Error(`${dir} resolves elsewhere`);
        dirs.add(dir);
      }
      refuseSymlink(t.path);
      const text = bodies[t.body]!.replaceAll(SID, t.id).replaceAll(CWD, t.cwd).replaceAll(MODEL, t.model);
      writeFileSync(t.path, text, { mode: 0o600 });
      utimesSync(t.path, t.mtimeMs / 1000, t.mtimeMs / 1000);
      bytes += text.length;
    }
    counts.transcripts = transcripts.length;
    counts.transcriptMb = Math.round((bytes / (1024 * 1024)) * 10) / 10;
  }
  return {
    threadId,
    counts,
    avgMessageChars: v.messages ? Math.round(messageChars / v.messages) : 0,
    ms: Math.round(performance.now() - started),
  };
}
