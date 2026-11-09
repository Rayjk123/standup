import { createHash, createPublicKey, randomBytes, sign, verify, type KeyObject } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, dirname, isAbsolute, join, normalize } from "path";
import { HOOK_CLIENT_TIMEOUT_SECONDS, STANDUP_HOOK_EVENTS } from "@standup/shared/constants";
import { SCRATCH_LABEL_OPEN, plainScratchRoot, scratchInstanceLabel, splitScratchLabel, type ScratchInstance } from "./scratch-instance.js";
import type { OrgProfile } from "../org-profile/types.js";
import { readCarriedOrgProfile } from "../org-profile/load.js";

/*
 * The safety floor for workers launched with permissions bypassed.
 *
 * A bypass-mode worker runs every tool call without a prompt, so Standup
 * injects a PreToolUse command hook (floor/hook.ts) through `--settings`. The
 * hook classifies each call locally (floor/classify.ts); an ordinary call is
 * allowed on the spot without touching the collector, while a floored one is
 * routed to the collector as a pending ask and the hook waits for the answer.
 * Persona (or the owner) answers "Allow once" or "Deny".
 *
 * Claude Code treats a hook that exits non-zero (other than 2) or runs past its
 * timeout as a non-blocking error and RUNS the tool, so the hook command is
 * wrapped to turn any crash into exit 2, a watchdog kills a hung hook (also
 * exit 2) before Claude Code's timeout, and the hook keeps its own deadline
 * below both (see floorHookCommand and buildFloorHookSettings).
 *
 * The hook trusts only what the launcher fixed for it: it runs from the floor
 * dir with Bun's `.env` autoload and cwd `bunfig.toml` disabled, reads its
 * temp dirs from the config rather than its env, presents the launch's scoped
 * worker token, and honors an allow only when the reply carries the
 * collector's signature over this exact call (floorReplyPayload).
 */

/**
 * Whether text typed into a Claude Code pane starts with `!`, which the TUI
 * runs as a shell command outside the floor's PreToolUse hook. Leading
 * whitespace and invisible characters are skipped the way the input box
 * ignores them.
 */
export function startsWithShellEscape(text: string): boolean {
  return /^[\s\u200b-\u200f\u2060\ufeff]*[!\uff01]/.test(text);
}

/** Why text that starts with `!` is not typed into a bypass-mode worker's pane. */
export const SHELL_ESCAPE_REFUSAL =
  "text starting with `!` would run as a shell command in a worker that has permissions bypassed, outside the safety floor; rephrase it without the leading `!`";

/** `Ask.gate` of a floored call Persona may decide (allow once / deny) or escalate. */
export const FLOOR_GATE = "safety_floor";

/**
 * `Ask.gate` of a floored call in an owner-only category (OWNER_ONLY_CATEGORIES).
 * The owner, or the host's own Persona on a session its job owns, may allow it
 * once; Persona's allow passes an independent second check and is recorded
 * with its reason for the owner to review. Persona escalates to the owner with
 * ask_user when it won't decide; Standup never cards one by itself.
 * A guest's Persona and anyone else answering from Slack may only deny it.
 */
export const FLOOR_OWNER_GATE = "safety_floor_owner";

/**
 * The hold reason of an acceptance criterion the owner holds for review
 * (STANDUP_PERSONA_HOLD=acceptance_criterion): every such criterion waits on
 * a floor ask Persona decides, even one the floor itself would let run.
 */
export const CRITERION_OWNER_HOLD_REASON =
  "the owner holds acceptance criteria for review before they run (STANDUP_PERSONA_HOLD)";

/** floorQuestion's opening, which the collector writes ahead of anything the worker controls. */
const FLOOR_QUESTION_HEAD = /^Safety floor held a (\S+) call \(([a-z-]+)\): /;

/**
 * The shape of a tool name a hold may carry: a built-in tool's (`Bash`,
 * `NotebookEdit`, `TodoWrite`), or an MCP tool's (`mcp__<server>__<tool>`,
 * whose server part may hold `-` and `.`, as plugin servers' names do).
 */
export const FLOOR_TOOL_NAME = /^(?:[A-Za-z][A-Za-z0-9_]{0,63}|mcp__[A-Za-z0-9_.-]{1,200})$/;

/** The category floorQuestion wrote into a safety-floor ask's question (the tool name is one word). */
export function floorCategoryOf(question: string): string | undefined {
  return FLOOR_QUESTION_HEAD.exec(question)?.[2];
}

/**
 * floorQuestion's label, right after the category, on an ownerReserved hold:
 * a call whose effect can outlast the one allow.
 */
export const FLOOR_HIGH_RISK_LABEL =
  "HIGH RISK — it reaches Standup's or the owner's secrets, Standup's database, another process's memory, or the floor hook or install, and one allowed call there can outlast the allow: ";
const HIGH_RISK_LINE =
  "High risk: Persona may allow it once (second-checked and recorded for the owner) or deny it; escalate to the owner with ask_user when unsure.";
const NOTHING_RUNS = "Nothing runs unless it is allowed.";

/**
 * Whether a floor ask's question carries FLOOR_HIGH_RISK_LABEL. The collector
 * writes it right after the category, ahead of the held call's own text, so
 * no command can forge it away; quoting it elsewhere changes nothing.
 */
export function isHighRiskFloorHold(question: string): boolean {
  const head = FLOOR_QUESTION_HEAD.exec(question);
  return !!head && question.startsWith(FLOOR_HIGH_RISK_LABEL, head[0].length);
}

/**
 * The isolated scratch instance a Bash floor ask's question carries
 * (scratchInstanceLabel), or null. The collector writes it right after the
 * category and the high-risk label, from its own classification of the call
 * (FloorHold.scratch), and floorQuestion keeps a reason from spelling it, so
 * no command can forge one. A question whose tool name isn't of a tool
 * name's shape (FLOOR_TOOL_NAME), or isn't Bash, carries none.
 */
export function floorScratchInstanceOf(question: string): ScratchInstance | null {
  const head = FLOOR_QUESTION_HEAD.exec(question);
  if (!head || head[1] !== "Bash" || !FLOOR_TOOL_NAME.test(head[1])) return null;
  let at = head[0].length;
  if (question.startsWith(FLOOR_HIGH_RISK_LABEL, at)) at += FLOOR_HIGH_RISK_LABEL.length;
  const end = question.indexOf("\n\n", at);
  return splitScratchLabel(question.slice(at, end > 0 ? end : undefined)).scratch;
}

/** A floor reason (floorReasonOf's) without the scratch label (scratchInstanceLabel), after the high-risk label when there is one. */
export function withoutScratchLabel(reason: string): string {
  const risk = reason.startsWith(FLOOR_HIGH_RISK_LABEL) ? FLOOR_HIGH_RISK_LABEL : "";
  return `${risk}${splitScratchLabel(reason.slice(risk.length)).reason}`;
}

export const FLOOR_ALLOW_OPTION = "Allow once";
export const FLOOR_DENY_OPTION = "Deny";
export const FLOOR_OPTIONS = [FLOOR_ALLOW_OPTION, FLOOR_DENY_OPTION] as const;

/** Whether `gate` marks an ask raised by the safety floor. */
export function isFloorGate(gate: string | undefined | null): boolean {
  return gate === FLOOR_GATE || gate === FLOOR_OWNER_GATE;
}

/**
 * Whether an answer to a floor ask allows the call. Only a short, plain yes
 * counts; anything else — including an empty answer, a dismissal or free text
 * — denies. The hook and Persona's policy both read answers through this, so
 * what the policy treats as a denial is exactly what the hook refuses to run.
 */
export function floorAnswerAllows(answer: string | undefined | null): boolean {
  if (typeof answer !== "string") return false;
  const text = answer.normalize("NFKC").trim().replace(/[.!]+$/, "").trim().toLowerCase();
  return /^(?:1|allow|allow once|allow it|yes|y|approve|approved|ok|okay|go ahead)$/.test(text);
}

/** The longest decider's reason a floor deny answer carries. */
export const FLOOR_DENY_REASON_CHARS = 1_000;

/**
 * The answer a floor deny is stored with: "Deny", then the decider's reason
 * on one line when there is one, so the worker told of the deny can adjust.
 * It never reads as an allow (floorAnswerAllows takes only a whole yes).
 */
export function floorDenyAnswer(reason?: string | null): string {
  const flat = reason?.replace(/\s+/g, " ").trim();
  if (!flat) return FLOOR_DENY_OPTION;
  return `${FLOOR_DENY_OPTION}: ${flat.length > FLOOR_DENY_REASON_CHARS ? `${flat.slice(0, FLOOR_DENY_REASON_CHARS - 1)}…` : flat}`;
}

/**
 * Kinds of floored call. The floor allows by default and holds only its
 * denylist (classify.ts Tier): outward steps, AWS changes outside personal
 * accounts, owner secrets, Standup's live data and DB, the floor itself, and
 * steps that reach the whole host, plus what it can't see through at all.
 * Some kinds below are therefore held only in part: `owner-host` never on its
 * own, `standup-ops` only where it touches Standup's data or stops its
 * service, `unseen-code` and `unclassified` only where the floor can't see
 * through the step or the text it has names a denylist target.
 * - `outward`: pushes, PR/MR actions, code-review MCP writes, merges into a
 *   shared branch, deploys, pipeline triggers, publishing, messaging or
 *   writing to external services.
 * - `review`: creating or revising a code review with one of the org
 *   profile's review CLIs, or rewriting its description or summary (one of
 *   its review write tools). It only uploads the diff or its write-up for
 *   review, so Persona may allow it.
 * - `aws`: a mutating AWS call (or credentials for one) against an account
 *   that is not configured as the owner's personal account, or whose account
 *   could not be determined.
 * - `nonprod-aws`: a mutating AWS call (or credentials for one) against an
 *   account configured as non-prod. Persona may allow it.
 * - `owner-host`: ssh, scp or rsync to one of the owner's own hosts
 *   (FloorConfig.ownerHosts). What the remote command does is classified on
 *   its own, so a push or deploy run there is still owner-only.
 * - `collector-api`: a call that may write through Standup's own HTTP API:
 *   a write method or body, a raw connection, or code or MCP input aimed at
 *   it. Its writes can answer the floor's own asks.
 * - `standup-ops`: operating Standup itself without changing the floor: GET
 *   or HEAD to its API, checkpointing, checking or backing up its DB,
 *   systemctl on its user units, its data dir outside the DB and secrets,
 *   running its scripts or restart supervisor, forwarding its port.
 * - `floor-tamper`: a change to the hook, the settings that load it, any
 *   Claude Code settings file that could disable hooks, the Standup install,
 *   Standup's DB (the floor's asks and answers), an agent started outside the
 *   floor; or a read of owner-side secrets or another process's memory or
 *   environment.
 * - `unseen-code`: configuration that makes later commands run code the
 *   floor doesn't read (git hooks, aliases and transports, npm config, a
 *   nested agent whose tools the floor doesn't see).
 * - `destructive`: deletes or overwrites outside the worker's worktree,
 *   force-resets or rewrites of other repos, deletes or drops on live data
 *   stores (Standup's own DB included), killing processes it didn't start.
 * - `unclassified`: a call the floor could not read (unparseable shell,
 *   unresolvable program, unreadable script, unknown tool).
 */
/**
 * `personal-aws` is never the hook's own: the collector gives it to a hook's
 * owner-only `aws` hold whose account its current personal-account allowlist
 * names but the launch's (older) floor config didn't, or whose account the
 * command doesn't name but the credentials it runs with belong to a listed
 * account (routes.ts personalAccountHold).
 */
export type FloorCategory =
  | "outward"
  | "review"
  | "aws"
  | "personal-aws"
  | "nonprod-aws"
  | "owner-host"
  | "collector-api"
  | "standup-ops"
  | "floor-tamper"
  | "unseen-code"
  | "destructive"
  | "unclassified";

const FLOOR_CATEGORIES: ReadonlySet<string> = new Set<FloorCategory>([
  "outward",
  "review",
  "aws",
  "personal-aws",
  "nonprod-aws",
  "owner-host",
  "collector-api",
  "standup-ops",
  "floor-tamper",
  "unseen-code",
  "destructive",
  "unclassified",
]);

/**
 * Categories held on FLOOR_OWNER_GATE: only the owner, or the host's own
 * Persona (second-checked and audited), may allow them.
 */
export const OWNER_ONLY_CATEGORIES: ReadonlySet<FloorCategory> = new Set<FloorCategory>([
  "outward",
  "aws",
  "collector-api",
  "floor-tamper",
]);

export interface FloorHold {
  category: FloorCategory;
  /**
   * Held on FLOOR_OWNER_GATE (OWNER_ONLY_CATEGORIES): only the owner, or the
   * host's own Persona with a recorded reason, may allow it.
   */
  ownerOnly: boolean;
  /**
   * High risk: a read of Standup's or the owner's secrets, of another
   * process's memory or environment, of Standup's DB, or a write to the floor
   * hook or the Standup install's code. One allowed call there can outlast
   * the allow (a leaked owner token, a changed hook), so floorQuestion labels
   * it (FLOOR_HIGH_RISK_LABEL) for Persona to weigh; Persona still decides it.
   */
  ownerReserved?: boolean;
  /** Why it is floored, shown to Persona, the owner and the worker. */
  reason: string;
  /** The words of the call that tripped the floor, clipped. */
  step: string;
  /**
   * The floor found the whole call to be one isolated scratch Standup
   * instance's run (scratch-instance.ts): the token files the vars name lie
   * under its scratch root. Only the collector's own classification sets it;
   * one in a hook's request is dropped (readHold).
   */
  scratch?: ScratchInstance;
}

export type FloorVerdict = { action: "allow" } | ({ action: "hold" } & FloorHold);

/** One tool call as the PreToolUse hook receives it. */
export interface FloorCall {
  toolName: string;
  toolInput: Record<string, unknown>;
  /** The worker's cwd when it made the call. */
  cwd: string;
  /** The Claude Code session that made the call (the hook payload's session_id), when it names one. */
  sessionId?: string;
}

/** A private path (FloorConfig.privatePaths): what a read of it is held as, and why. */
export interface FloorPrivatePath {
  path: string;
  category: FloorCategory;
  reason: string;
}

/** What the launcher tells the hook about the launch it guards. */
export interface FloorConfig {
  v: 1;
  /** Collector base URL, e.g. http://localhost:7777. */
  collectorUrl: string;
  launchId: string;
  /** The worker's worktree (or in-place repository) root: its own ground. */
  root: string;
  /** Branch names that are shared: merging into or rewriting them is outward. */
  sharedBranches: string[];
  /** AWS account ids that are the owner's personal accounts; mutations there are not floored. */
  personalAwsAccounts: string[];
  /** AWS account ids that are non-prod; mutations there are held for Persona (`nonprod-aws`). */
  nonProdAwsAccounts?: string[];
  /**
   * Only model invokes pass in a personal account; any other AWS change there
   * is held as in an unlisted one. Never part of a launch's config: the
   * collector classifies with it to tell whether a call's personal-account
   * steps are all invokes (classifyWithCredentials).
   */
  personalAwsInvokesOnly?: boolean;
  /**
   * Hosts that are the owner's own, as globs whose `*` stays within one DNS
   * label. ssh, scp and rsync to them are `owner-host`.
   */
  ownerHosts?: string[];
  /** Hostnames serving Standup's own API beside the collector URL (the owner's tunnel); reads there are `standup-ops`. */
  standupHosts?: string[];
  /**
   * Dirs Standup creates launch worktrees under. Edit and Write of a file in
   * a git checkout below one are ordinary source edits, even when the
   * checkout isn't this launch's own (a worktree it made for its subagents).
   */
  worktreeRoots?: string[];
  /**
   * The worktrees and workspaces of the other launches of this launch's
   * Persona job (earlier and concurrent), canonical and each strictly under a
   * worktree root (floorJobRoots). A worker relaunched on the same job often
   * carries on in an earlier launch's workspace, so they are its own ground as
   * much as `root` is; deleting one of them, or a dir above one, is not.
   */
  jobRoots?: string[];
  /**
   * The worktree paths of live launches outside this launch's Persona job
   * (another job's, or no job's), canonical. A linked worktree under a
   * worktree root is own ground unless it lies in one of these: writes there
   * change another job's work. `root` and jobRoots win where they nest.
   */
  foreignRoots?: string[];
  /** How long the hook waits on a decision before denying. */
  waitSeconds: number;
  /** Standup's data dir (its DB lives here); deletes or writes there are floored. */
  standupDataDir: string;
  /**
   * The Unix socket the public knowledge API listens on (publicKnowledgeSocketPath),
   * wherever it is: connecting to it, or naming it in a command, is `standup-ops`.
   */
  publicKnowledgeSocket?: string;
  /** Files and dirs that make up the floor itself; changes to them are floor-tamper. */
  floorPaths: string[];
  /**
   * The Standup install the collector runs from. Creating, changing or deleting
   * anything in it is floor-tamper: the collector loads that code on its next
   * start.
   */
  installDir: string;
  /**
   * Paths holding owner-side secrets (the owner secret, Persona's private
   * config). Reading them is floor-tamper as much as writing them.
   */
  protectedPaths: string[];
  /**
   * Paths whose content is private but not an owner-side secret (the owner's
   * media uploads to Persona). Reading or listing one is held like a
   * protected path, under its own category and reason, after the
   * protected-path, DB and data-dir checks, which outrank it.
   */
  privatePaths?: FloorPrivatePath[];
  /** Temp dirs whose children are scratch space, fixed at launch rather than read from the hook's env. */
  tmpDirs: string[];
  /**
   * This launch's own scratch dir, `<scratchRoot>/<scratchId ?? launchId>`
   * (the worker's TMPDIR): what lies below it is scratch space as below a
   * temp dir. Fixed at launch, never taken from the hook's env; honored only
   * as scratchRoot's child named for the launch's scratch id (ownScratchDirOf).
   */
  scratchDir?: string;
  /**
   * The id the launch's scratch dir is named for when it isn't the launch id:
   * a resumed session keeps the scratch dir of the session's first launch.
   * The collector sets it from its own launch records, never from the worker.
   */
  scratchId?: string;
  /** The dir every launch's scratch dir sits in; it is a protected path, all but this launch's own dir. */
  scratchRoot?: string;
  /**
   * The launch's scoped credential: it lets the hook raise holds for this
   * launch and nothing else. It is visible to the worker (the hook command is
   * in its process table), so it grants no approval.
   */
  workerToken: string;
  /**
   * The collector's Ed25519 public key (SPKI DER, base64). A hold's reply is
   * honored only when its signature verifies, so nothing else listening on
   * the collector's port can answer for it.
   */
  replyPublicKey: string;
  /**
   * MCP tools the owner lists as read-only beside the built-in list, as
   * `server__tool` or `server__*` (STANDUP_FLOOR_READONLY_MCP).
   */
  readOnlyMcpTools?: string[];
  /** Domains WebFetch may read beside the built-in docs list (STANDUP_FLOOR_WEBFETCH_DOMAINS). */
  webFetchDomains?: string[];
  /**
   * The file marking a multi-checkout workspace's root (the project layout's
   * workspaceMarker): a job root that holds the launch's root is its own
   * ground only when it carries one. Absent: none is.
   */
  workspaceMarker?: string;
  /**
   * The org profile the collector loaded when it built this config: the
   * hook classifies with it and never reads the profile file itself.
   * Absent: the built-in default profile (DEFAULT_ORG_PROFILE).
   */
  orgProfile?: OrgProfile;
  /**
   * Read the repository's own git hooks strictly rather than leniently: set
   * for a Persona-launched worker running in place, where those hooks are the
   * owner's checkout's.
   */
  strictHooks?: boolean;
}

/** Branches every launch treats as shared, beside the project's own base branch. */
export const DEFAULT_SHARED_BRANCHES = [
  "main",
  "master",
  "mainline",
  "trunk",
  "develop",
  "development",
  "prod",
  "production",
  "release",
  "live",
];

/** The floor's own directory: the hook runs from here. */
export const FLOOR_DIR = import.meta.dir;

/** The hook entry point, next to this module. */
export const FLOOR_HOOK_PATH = join(FLOOR_DIR, "hook.ts");

/** The empty Bun config the hook runs under, in place of any `bunfig.toml` in its cwd. */
export const FLOOR_BUNFIG_NAME = "bunfig.toml";

/** Seconds the hook command is given beyond its own wait, so it always answers before Claude Code times it out. */
export const FLOOR_HOOK_TIMEOUT_MARGIN_S = 120;

/**
 * Seconds past the wait the watchdog lets the hook run before killing it.
 * Above the hook's own deadline (the wait plus at most 30s of reply grace)
 * and below FLOOR_HOOK_TIMEOUT_MARGIN_S, so a hung hook is killed (and the
 * call blocked) before Claude Code would time it out and run the call.
 */
export const FLOOR_WATCHDOG_MARGIN_S = 60;

/** Env vars that would change how Bun starts the hook; the hook command unsets them. */
export const FLOOR_HOOK_UNSET_ENV = ["BUN_OPTIONS", "NODE_OPTIONS", "NODE_PATH"] as const;

export const DEFAULT_FLOOR_WAIT_S = 3600;

/** How long the hook keeps retrying a collector it can't reach before denying: long enough to ride out a restart. */
export const FLOOR_UNREACHABLE_GRACE_MS = 60_000;

/**
 * How long a hold whose hook disconnected stays pending for the hook to come
 * back under the same request id before it times out. A disconnect isn't
 * always the hook leaving: a gateway that shuts down aborts its upstream
 * long-poll the same way, and the hook then keeps retrying for its whole
 * unreachable grace before it gives up, so this outlasts that window.
 */
export const FLOOR_ABANDON_GRACE_MS = FLOOR_UNREACHABLE_GRACE_MS + 30_000;

/**
 * How long after a collector starts a hold the previous collector raised
 * waits for its hook to re-attach: past the hook's unreachable grace, a hook
 * that hasn't come back has denied and exited.
 */
export const FLOOR_BOOT_REATTACH_GRACE_MS = FLOOR_UNREACHABLE_GRACE_MS + 30_000;

export function encodeFloorConfig(config: FloorConfig): string {
  return Buffer.from(JSON.stringify(config), "utf8").toString("base64url");
}

/** Decodes a config the launcher encoded; throws on anything malformed. */
export function decodeFloorConfig(encoded: string): FloorConfig {
  const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<FloorConfig>;
  const strings = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === "string");
  if (
    parsed?.v !== 1 ||
    typeof parsed.collectorUrl !== "string" ||
    typeof parsed.launchId !== "string" ||
    typeof parsed.root !== "string" ||
    !parsed.root.startsWith("/") ||
    !strings(parsed.sharedBranches) ||
    !strings(parsed.personalAwsAccounts) ||
    (parsed.nonProdAwsAccounts !== undefined && !strings(parsed.nonProdAwsAccounts)) ||
    (parsed.ownerHosts !== undefined && !strings(parsed.ownerHosts)) ||
    (parsed.standupHosts !== undefined && !strings(parsed.standupHosts)) ||
    (parsed.worktreeRoots !== undefined && !strings(parsed.worktreeRoots)) ||
    (parsed.jobRoots !== undefined && !strings(parsed.jobRoots)) ||
    (parsed.foreignRoots !== undefined && !strings(parsed.foreignRoots)) ||
    typeof parsed.waitSeconds !== "number" ||
    !(parsed.waitSeconds > 0) ||
    typeof parsed.standupDataDir !== "string" ||
    (parsed.publicKnowledgeSocket !== undefined && (typeof parsed.publicKnowledgeSocket !== "string" || !parsed.publicKnowledgeSocket)) ||
    !strings(parsed.floorPaths) ||
    typeof parsed.installDir !== "string" ||
    !parsed.installDir.startsWith("/") ||
    !strings(parsed.protectedPaths) ||
    !strings(parsed.tmpDirs) ||
    typeof parsed.workerToken !== "string" ||
    parsed.workerToken.length < 32 ||
    typeof parsed.replyPublicKey !== "string" ||
    !parsed.replyPublicKey ||
    (parsed.readOnlyMcpTools !== undefined && !strings(parsed.readOnlyMcpTools)) ||
    (parsed.webFetchDomains !== undefined && !strings(parsed.webFetchDomains)) ||
    (parsed.strictHooks !== undefined && typeof parsed.strictHooks !== "boolean") ||
    (parsed.workspaceMarker !== undefined && (typeof parsed.workspaceMarker !== "string" || !/^[\w.-]+$/.test(parsed.workspaceMarker))) ||
    (parsed.privatePaths !== undefined &&
      !(Array.isArray(parsed.privatePaths) && parsed.privatePaths.every((p) => typeof p?.path === "string" && FLOOR_CATEGORIES.has(p.category) && typeof p.reason === "string"))) ||
    (parsed.scratchDir !== undefined && typeof parsed.scratchDir !== "string") ||
    (parsed.scratchId !== undefined && (typeof parsed.scratchId !== "string" || !FLOOR_SCRATCH_ID.test(parsed.scratchId))) ||
    (parsed.scratchRoot !== undefined && typeof parsed.scratchRoot !== "string")
  ) {
    throw new Error("malformed safety-floor config");
  }
  if (parsed.orgProfile !== undefined) {
    try {
      parsed.orgProfile = readCarriedOrgProfile(parsed.orgProfile);
    } catch {
      throw new Error("malformed safety-floor config");
    }
  }
  // A scratch dir that isn't exactly the launch's own under the scratch root grants nothing.
  if (parsed.scratchDir !== undefined && ownScratchDirOf(parsed as FloorConfig) === null) delete parsed.scratchDir;
  return parsed as FloorConfig;
}

/**
 * The longest encoded config the hook command carries inline. The command
 * rides in the `--settings` JSON on the `tmux new-session` line, which tmux
 * caps at ~16 KB ("command too long"), and foreignRoots grows with every live
 * launch, so a larger config is passed as a file instead (floorConfigArg).
 */
export const FLOOR_INLINE_CONFIG_MAX = 4096;

/** Marks a hook argument that names a config file rather than carrying the config; base64url never contains it. */
export const FLOOR_CONFIG_FILE_PREFIX = "@";

/** The data-dir subdir holding the configs too large to pass inline. */
export const FLOOR_CONFIG_DIR = "floor-configs";

/**
 * The hook's config argument: the encoded config itself when it fits in
 * FLOOR_INLINE_CONFIG_MAX, else `@<file>` naming a 0600 copy of it under the
 * data dir's FLOOR_CONFIG_DIR. Writes in the data dir are floored
 * (standupDataDir), so a worker can't rewrite its own config there.
 */
export function floorConfigArg(config: FloorConfig): string {
  const encoded = encodeFloorConfig(config);
  if (encoded.length <= FLOOR_INLINE_CONFIG_MAX) return encoded;
  const dir = join(config.standupDataDir, FLOOR_CONFIG_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${config.launchId.replace(/[^A-Za-z0-9_-]/g, "_")}.b64`);
  writeFileSync(file, encoded, { encoding: "utf8", mode: 0o600 });
  return `${FLOOR_CONFIG_FILE_PREFIX}${file}`;
}

/** The config a hook argument from floorConfigArg carries or names; throws on anything unreadable or malformed. */
export function readFloorConfigArg(arg: string): FloorConfig {
  return decodeFloorConfig(arg.startsWith(FLOOR_CONFIG_FILE_PREFIX) ? readFileSync(arg.slice(FLOOR_CONFIG_FILE_PREFIX.length), "utf8") : arg);
}

/**
 * The launch ids a scratch dir is named after: the shared scratch module's
 * SCRATCH_ID, kept here so the hook's config decoding loads nothing from the
 * shared package.
 */
export const FLOOR_SCRATCH_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * The launch's own scratch dir from its config, or null: the dir must be an
 * absolute, normalized path whose parent is exactly the (absolute, normalized,
 * non-root) scratch root and whose name is the launch's scratch id (its
 * scratchId, else its launch id), itself a usable scratch dir name
 * (FLOOR_SCRATCH_ID).
 */
export function ownScratchDirOf(config: Pick<FloorConfig, "launchId" | "scratchDir" | "scratchRoot" | "scratchId">): string | null {
  const { scratchDir: dir, scratchRoot: root } = config;
  const id = config.scratchId === undefined ? config.launchId : config.scratchId;
  if (typeof dir !== "string" || typeof root !== "string" || typeof id !== "string" || !FLOOR_SCRATCH_ID.test(id)) return null;
  if (!isAbsolute(dir) || !isAbsolute(root) || normalize(dir) !== dir || normalize(root) !== root) return null;
  if (root === "/" || root.endsWith("/") || dir.endsWith("/")) return null;
  return dirname(dir) === root && basename(dir) === id ? dir : null;
}

/** Single-quotes `s` for a POSIX shell. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The message a crashed hook leaves the worker; the wrapper exits 2 so the call is blocked. */
export const FLOOR_CRASH_MESSAGE =
  "Standup safety floor: the hook failed to run, so this tool call was blocked (fail closed). Nothing ran.";

/**
 * The hook command: the hook under `bunPath`, started so nothing in the
 * worker's reach changes how it runs, with any failure turned into exit 2
 * (block) instead of a non-blocking error.
 *
 * - It `cd`s into the hook's own dir, so Bun never reads the worker's cwd.
 * - `--no-env-file` stops Bun autoloading a `.env`, and `--config` names the
 *   empty `bunfig.toml` shipped beside the hook in place of `$cwd/bunfig.toml`
 *   (whose `preload` would run code before the hook). The env vars that
 *   inject Bun or Node options (FLOOR_HOOK_UNSET_ENV) are unset.
 * - Where coreutils `timeout` exists, a watchdog SIGKILLs the hook
 *   FLOOR_WATCHDOG_MARGIN_S past its wait; the kill reads as a failure, so the
 *   call is blocked rather than left to Claude Code's timeout (which would run
 *   it). Stock macOS has no `timeout` (Homebrew coreutils installs one); there
 *   the hook runs unwatched and relies on its own deadline, which stays
 *   FLOOR_HOOK_TIMEOUT_MARGIN_S - 30 seconds below Claude Code's.
 */
export function floorHookCommand(config: FloorConfig, bunPath: string = process.execPath, hookPath: string = FLOOR_HOOK_PATH): string {
  const dir = dirname(hookPath);
  const run = [
    shellQuote(bunPath),
    "--no-env-file",
    shellQuote(`--config=${join(dir, FLOOR_BUNFIG_NAME)}`),
    shellQuote(hookPath),
    shellQuote(floorConfigArg(config)),
  ].join(" ");
  const watchdog = Math.ceil(config.waitSeconds) + FLOOR_WATCHDOG_MARGIN_S;
  return (
    `cd ${shellQuote(dir)} && unset ${FLOOR_HOOK_UNSET_ENV.join(" ")} && ` +
    `if command -v timeout >/dev/null 2>&1; then timeout -s KILL ${watchdog} ${run}; else ${run}; fi ` +
    `|| { echo ${shellQuote(FLOOR_CRASH_MESSAGE)} >&2; exit 2; }`
  );
}

/**
 * Where a launch's own hooks POST its events: the collector's `/hook` route
 * under a URL of its own. Claude Code deduplicates HTTP hooks by URL, so the
 * global hook's bare `/hook` would otherwise stand in for it.
 */
export const WORKER_HOOK_PATH = "/hook?via=worker";

/** The header a launch's own hooks present its hook token in. */
export const HOOK_TOKEN_HEADER = "x-standup-hook-token";

/**
 * The env var holding a launch's hook token, set on its Claude session
 * (tmux `-e`). The hooks name it rather than the token, so the token stays
 * out of claude's argv, which every local user can read; it is in the
 * argv of the `tmux new-session` client only while that client runs.
 */
export const HOOK_TOKEN_ENV = "STANDUP_HOOK_TOKEN";

/** A fresh hook token: 32 random bytes, hex. */
export function newHookToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * One HTTP hook presenting the hook token for each event Standup reports
 * (STANDUP_HOOK_EVENTS), with the same client timeout the global hooks carry
 * on the knowledge-push events (HOOK_CLIENT_TIMEOUT_SECONDS), so a busy
 * collector cannot stall a launched worker.
 */
function workerHookEntries(config: FloorConfig): Record<string, unknown[]> {
  const url = `${config.collectorUrl.replace(/\/+$/, "")}${WORKER_HOOK_PATH}`;
  return Object.fromEntries(
    STANDUP_HOOK_EVENTS.map((event) => {
      const timeout = HOOK_CLIENT_TIMEOUT_SECONDS[event];
      const hook = {
        type: "http",
        url,
        headers: { [HOOK_TOKEN_HEADER]: `$${HOOK_TOKEN_ENV}` },
        allowedEnvVars: [HOOK_TOKEN_ENV],
        ...(timeout !== undefined ? { timeout } : {}),
      };
      return [event, [{ hooks: [hook] }]];
    }),
  );
}

/**
 * The `--settings` JSON that installs the floor for one launch: a PreToolUse
 * command hook on every tool, and an HTTP hook for every event Standup reports
 * that presents the launch's hook token (HOOK_TOKEN_ENV), so once the
 * collector has seen that token it takes this session's events from these
 * hooks and from nothing else (see hook-auth.ts). Passed inline (not as a
 * file) so there is no settings file on disk a worker could edit.
 */
export function buildFloorHookSettings(config: FloorConfig, bunPath?: string, hookPath?: string): string {
  const reporting = workerHookEntries(config);
  return JSON.stringify({
    hooks: {
      ...reporting,
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: floorHookCommand(config, bunPath, hookPath),
              timeout: Math.ceil(config.waitSeconds) + FLOOR_HOOK_TIMEOUT_MARGIN_S,
            },
          ],
        },
        ...(reporting.PreToolUse ?? []),
      ],
    },
  });
}

/** The collector route the hook routes a floored call to. */
export const FLOOR_HOLD_ROUTE = "/api/floor/hold";

/** The header the hook presents its launch's scoped worker token in. */
export const FLOOR_WORKER_TOKEN_HEADER = "x-standup-worker-token";

/** sha256 (hex) of a worker token: what the launch row stores in its place. */
export function workerTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** JSON with every object's keys sorted, so equal values serialize identically whatever their key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** sha256 (hex) of a tool call — its tool name, canonical input and cwd — pinning which call a hold is for. */
export function floorCallHash(call: FloorCall): string {
  return createHash("sha256").update(canonicalJson([call.toolName, call.toolInput, call.cwd]), "utf8").digest("hex");
}

/** What a floor reply's signature covers. */
export interface FloorReplyFields {
  requestId: string;
  askId: string;
  decision: "allow" | "deny";
  answer: string;
  /** floorCallHash of the call the hold is for. */
  callHash: string;
}

/** The exact bytes a floor reply's signature covers: `${request_id}\n${askId}\n${decision}\n${answer}\n${callHash}`. */
export function floorReplyPayload(fields: FloorReplyFields): string {
  return `${fields.requestId}\n${fields.askId}\n${fields.decision}\n${fields.answer}\n${fields.callHash}`;
}

/** The collector's Ed25519 signature (base64) over a reply's payload. */
export function signFloorReply(privateKey: KeyObject, fields: FloorReplyFields): string {
  return sign(null, Buffer.from(floorReplyPayload(fields), "utf8"), privateKey).toString("base64");
}

/**
 * Whether `signature` is the collector's signature over `fields`, checked
 * against `publicKey` (SPKI DER base64). Any malformed key or signature is a
 * failed check.
 */
export function verifyFloorReply(publicKey: string, fields: FloorReplyFields, signature: string | undefined): boolean {
  if (!signature) return false;
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") return false;
    return verify(null, Buffer.from(floorReplyPayload(fields), "utf8"), key, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

/** Body the hook POSTs to FLOOR_HOLD_ROUTE. */
export interface FloorHoldRequest {
  session_id: string;
  cwd: string;
  launch_id: string;
  /**
   * Stable per tool call (the call's tool_use_id, else a random id): a retry
   * after the collector restarts re-attaches to the same ask instead of
   * raising a second one, and only with the same call (floorCallHash).
   */
  request_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  /** The hook's verdict. The collector re-classifies and may only tighten it. */
  hold: FloorHold;
  wait_s: number;
}

/** The collector's reply once the ask is answered, dismissed or timed out. */
export interface FloorHoldResponse {
  decision: "allow" | "deny";
  askId: string;
  answer: string;
  timed_out?: boolean;
  /** Why a deny was given when it isn't the answer itself (e.g. the allow was already used). */
  reason?: string;
  /** signFloorReply over the request id, the reply's fields and the call's hash; an allow without a valid one is a deny. */
  signature?: string;
}

/** The ask question for a floored call: what it is, why it's held, and who decides. */
export function floorQuestion(call: FloorCall, hold: FloorHold): string {
  const input =
    call.toolName === "Bash" && typeof call.toolInput.command === "string"
      ? call.toolInput.command
      : JSON.stringify(call.toolInput);
  const clipped = input.length > 4000 ? `${input.slice(0, 4000)}…` : input;
  const who = hold.ownerReserved
    ? HIGH_RISK_LINE
    : hold.ownerOnly
      ? "Persona may allow it once (recorded for the owner) or deny it."
      : "Persona may allow it once or deny it.";
  const label = hold.ownerReserved ? FLOOR_HIGH_RISK_LABEL : "";
  // Only the hold's own marker writes the scratch label (splitScratchLabel); a reason quoting it can't pass for one,
  // and a call whose tool name isn't of a tool name's shape (FLOOR_TOOL_NAME) gets none.
  const scratch = hold.scratch && FLOOR_TOOL_NAME.test(call.toolName) && plainScratchRoot(hold.scratch.root) ? scratchInstanceLabel(hold.scratch) : "";
  const reason = hold.reason.replaceAll(SCRATCH_LABEL_OPEN, `(${SCRATCH_LABEL_OPEN.slice(1)}`);
  return (
    `Safety floor held a ${call.toolName} call (${hold.category}): ${label}${scratch}${reason}\n\n` +
    `${clipped}\n\n` +
    `cwd: ${call.cwd}\n${who} ${NOTHING_RUNS}`
  );
}
