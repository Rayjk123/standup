/**
 * Slash commands in the Persona chat: deterministic reads the owner runs from
 * the composer (`/state`). A command runs on the collector straight from the
 * store — never as a Persona turn — and its result is kept in the thread as a
 * structured card.
 *
 * This list is the registry both sides share: the console's `/` menu lists it
 * and the collector refuses any name not in it. Adding a command means one
 * entry here, one handler in the collector's command registry and one
 * renderer in the console's.
 */

import type { PersonaMessage } from "./persona.js";

export interface PersonaCommandSpec {
  /** The word after the slash, lowercase. */
  name: string;
  /** One line for the `/` menu. */
  description: string;
  /**
   * Whether text may follow the name. A command that takes none is only the
   * bare `/name`; "/state of the build?" is chat for Persona.
   */
  takesArgs?: boolean;
}

export const PERSONA_COMMANDS: readonly PersonaCommandSpec[] = [
  {
    name: "state",
    description: "The state of everything: what's waiting on you, what's running, and whether it all looks healthy",
  },
  {
    name: "ram",
    description: "What is using the host's memory: workers, Standup, leftovers from closed jobs, and everything else",
  },
];

/** A command parsed from a message: its name and the rest of the line. */
export interface ParsedPersonaCommand {
  name: string;
  args: string;
}

const COMMAND_PATTERN = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/i;

/**
 * The known command `text` invokes, or null. Only a message that starts with
 * `/<known name>` (then whitespace or the end) is a command, and text after
 * the name only for a command that takes it; `/word` for any other word, or
 * text with a slash later on, is ordinary chat.
 */
export function parsePersonaCommand(
  text: string,
  commands: readonly PersonaCommandSpec[] = PERSONA_COMMANDS
): ParsedPersonaCommand | null {
  const m = COMMAND_PATTERN.exec(text.trim());
  if (!m) return null;
  const name = m[1]!.toLowerCase();
  const spec = commands.find((c) => c.name === name);
  const args = (m[2] ?? "").trim();
  if (!spec || (args && !spec.takesArgs)) return null;
  return { name, args };
}

/** What a command produced, stored on its result message. */
export interface PersonaCommandResult {
  /** False when the handler failed; `summary` then says why. */
  ok: boolean;
  /** The command's card data, shaped per command (`StateReport` for `/state`). */
  data: unknown;
  /** One plain-language line, also the result message's text. */
  summary: string;
  ranAt: string;
  /** How long the handler took. */
  ms: number;
}

/**
 * The command a message carries: on the owner's `/state` line just the name
 * and args, on the result message also the result.
 */
export interface PersonaMessageCommand {
  name: string;
  args: string;
  result?: PersonaCommandResult;
}

/** POST /api/persona/commands. */
export interface PersonaCommandRequest {
  /** The whole composer line, e.g. "/state". */
  text: string;
  /** The owner's thread; their console thread when absent. Private threads only. */
  threadId?: string;
  /** Dedupe key: a retried run returns the messages it first made. */
  idempotencyKey?: string;
}

/** The owner's command line and the result card, both kept in the thread. */
export interface PersonaCommandResponse {
  message: PersonaMessage;
  result: PersonaMessage;
}

/** GET /api/persona/commands. */
export interface PersonaCommandsResponse {
  commands: PersonaCommandSpec[];
}

// ── /state ──────────────────────────────────────────────────────────────────

export interface StateItem {
  id: string;
  title: string;
  /** A short plain-language line under the title. */
  detail?: string;
  /** When the thing started waiting, last moved, or is due (ISO). */
  at?: string;
  /** The console path it opens: `/persona?job=<id>`, `/review/<id>`, `/work/s/<id>`, `/schedules`. */
  href?: string;
}

export interface StateInFlightItem extends StateItem {
  /** The worker's newest activity (ISO), when it has a session. */
  lastActivityAt?: string;
  /** Running with no worker activity for STATE_STALL_MINUTES or more. */
  stalled: boolean;
}

export interface StateStageGroup {
  /** The pipeline stage id, or "" for jobs with no pipeline run. */
  stage: string;
  /** Its plain title ("Coding", "Review", "No pipeline"). */
  title: string;
  jobs: StateInFlightItem[];
}

export interface StateHealth {
  collector: {
    startedAt?: string;
    uptimeMs?: number;
    /** The install's main sha the collector booted from. */
    head?: string;
  };
  /** The newest restart, or null when there is no record of one. */
  restart: {
    id: string;
    /** "ok" | "rolled-back" | "failed", or absent while one is still under way. */
    outcome?: string;
    phase?: string;
    at: string;
    error?: string;
  } | null;
  host: {
    memAvailableBytes?: number;
    memTotalBytes?: number;
    load1?: number;
    cores?: number;
    /** Persona launches running now. */
    active: number;
    /** The configured active-session cap. */
    cap: number;
    /** The cap after the host's headroom. */
    effectiveCap: number;
    hostLimited: boolean;
    queued: number;
  } | null;
  /** Schedules whose last run failed, or that missed a slot. */
  schedules: StateItem[];
  /** Jobs at or past their budget's warning line. */
  budgets: StateItem[];
  /** Persona commitments past due or gone quiet. */
  commitments: StateItem[];
}

export interface StateReport {
  generatedAt: string;
  waiting: {
    jobs: StateItem[];
    questions: StateItem[];
    approvals: StateItem[];
    reviews: StateItem[];
  };
  inFlight: {
    total: number;
    stalled: number;
    stages: StateStageGroup[];
  };
  holds: StateItem[];
  health: StateHealth;
  verdict: {
    /** Things the owner has to act on: everything waiting, plus holds. */
    needYou: number;
    /** Things that look wrong. */
    lookOff: number;
    /** "All good", "2 things need you", … */
    line: string;
  };
}

/** A running job with no worker activity for this long counts as stalled. */
export const STATE_STALL_MINUTES = 30;

/** A failed or rolled-back restart looks off for this long after it. */
export const STATE_RESTART_RECENT_MS = 24 * 60 * 60 * 1000;

/** Whether the last restart failed or rolled back within STATE_RESTART_RECENT_MS of `nowMs`. */
export function restartLooksOff(restart: StateHealth["restart"], nowMs: number): boolean {
  if (!restart || (restart.outcome !== "failed" && restart.outcome !== "rolled-back")) return false;
  return nowMs - Date.parse(restart.at) < STATE_RESTART_RECENT_MS;
}

/** The verdict line for the counts. */
export function stateVerdictLine(needYou: number, lookOff: number): string {
  const need = `${needYou} ${needYou === 1 ? "thing needs" : "things need"} you`;
  const off = `${lookOff} ${lookOff === 1 ? "thing looks" : "things look"} off`;
  if (needYou === 0 && lookOff === 0) return "All good";
  if (lookOff === 0) return need;
  if (needYou === 0) return off;
  return `${need} · ${off}`;
}

// ── /ram ────────────────────────────────────────────────────────────────────

/** Host memory from /proc/meminfo. Used is total less available. */
export interface RamHost {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
  /** Resident memory of Standup's own processes, its workers and their leftovers. */
  standupBytes: number;
}

/** One process tree (or several) with what it was attached to and its summed resident memory. */
export interface RamGroup {
  id: string;
  /** What the memory belongs to: a job title, "Collector", "vite server". */
  label: string;
  /** A short plain-language line under the label. */
  detail?: string;
  /** Summed resident memory (RSS) of every process in the group. */
  rssBytes: number;
  processCount: number;
  /** The root pid of each process tree in the group. */
  pids: number[];
  /** The heaviest process: its program and a trimmed, redacted argument summary. */
  command: string;
  /** When the oldest root started (ISO), when ps showed it. */
  startedAt?: string;
  /** The console path it opens, e.g. `/persona?job=<id>`. */
  href?: string;
}

/** Why a process tree counts as a leftover. */
export type RamLeftoverReason = "job_closed" | "session_ended" | "pane_gone";

export interface RamLeftover extends RamGroup {
  reason: RamLeftoverReason;
  /** What kind of process it is ("vite server", "Claude CLI", "Gradle daemon"). */
  kind: string;
  /**
   * Its launch's worker is still live by the hygiene rules (its session or
   * pane is up, a resume holds it, or another launch of its session runs):
   * listed, but never counted as something to free.
   */
  stillLive?: boolean;
  /**
   * Found only by the path it names, and its parent still runs (a shell, a
   * terminal): the orphan sweep never stops it, so it isn't counted as
   * something to free either.
   */
  hasParent?: boolean;
}

/** Leftovers of one kind and reason that cleanup can stop, for "3 leftover vite servers from closed jobs, 4.1 GB". */
export interface RamFreeable {
  kind: string;
  reason: RamLeftoverReason;
  count: number;
  rssBytes: number;
  pids: number[];
  line: string;
}

export interface RamReport {
  generatedAt: string;
  /** Null when the platform gives no /proc/meminfo. */
  host: RamHost | null;
  /** The five heaviest groups across every section. */
  top: Array<RamGroup & { section: "worker" | "standup" | "leftover" | "other" }>;
  workers: RamGroup[];
  standup: RamGroup[];
  leftovers: RamLeftover[];
  /** The heaviest process trees Standup can't attribute. */
  other: RamGroup[];
  /** Unattributed process trees left out of `other`, and their memory. */
  otherRest: { count: number; rssBytes: number };
  freeable: RamFreeable[];
  /** Why the process table could not be read; null when it was. */
  processError: string | null;
  summary: string;
}

/** Why `count` leftovers are ones, in plain words: "from closed jobs", "from an ended session". */
export function ramReasonPhrase(reason: RamLeftoverReason, count: number): string {
  const one = count === 1;
  if (reason === "job_closed") return one ? "from a closed job" : "from closed jobs";
  if (reason === "session_ended") return one ? "from an ended session" : "from ended sessions";
  return one ? "whose tmux pane is gone" : "whose tmux panes are gone";
}

/** "3 leftover vite servers from closed jobs". */
export function ramFreeableTitle(f: Pick<RamFreeable, "kind" | "reason" | "count">): string {
  return `${f.count} leftover ${f.count === 1 ? f.kind : `${f.kind}s`} ${ramReasonPhrase(f.reason, f.count)}`;
}
