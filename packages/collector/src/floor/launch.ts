import type { Database } from "bun:sqlite";
import { randomBytes } from "crypto";
import { existsSync, readFileSync, readdirSync, realpathSync } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join, resolve, sep } from "path";
import { DEFAULT_COLLECTOR_PORT, type Launch } from "@standup/shared";
import { getOriginalLaunchBySession } from "@standup/store";
import { ownerSecretsDir, reviewMediaDir, reviewScratchRoot, workerTokensDir } from "@standup/shared/owner-token";
import { PERSONA_ATTACHMENTS_DIRNAME } from "@standup/shared/persona";
import { SCRATCH_ID, scratchDirFor, scratchRoot } from "@standup/shared/scratch";
import { defaultDbPath } from "../db-path.js";
import { hostUserAlias } from "../host-user.js";
import { PERSONA_CWD } from "../internal-cwd.js";
import { activeOwnerSecrets } from "../owner-secret.js";
import { publicKnowledgeSocketPath } from "../public-knowledge/listener.js";
import { resolveInstallDir } from "../restart/state.js";
import { activeOrgProfile, orgProfilePath } from "../org-profile/load.js";
import { DEFAULT_ORG_PROFILE } from "../org-profile/default.js";
import { activeProjectLayout } from "../project-layout/layout.js";
import { activeTunnelProvider, type TunnelProvider } from "../tunnels/provider.js";
import {
  DEFAULT_FLOOR_WAIT_S,
  DEFAULT_SHARED_BRANCHES,
  FLOOR_DIR,
  FLOOR_HOOK_PATH,
  type FloorConfig,
} from "./gate.js";

/*
 * What the launcher needs to install the safety floor on a bypass-mode launch:
 * the per-launch FloorConfig (built from the launch plus collector env), and the
 * fail-closed check that the floor can actually run on this box and worktree.
 */

type Env = Record<string, string | undefined>;

/**
 * The collector's own base URL as a local worker reaches it: loopback on
 * COLLECTOR_PORT (default DEFAULT_COLLECTOR_PORT), or the bind host when the
 * collector is bound to one specific address. Mirrors how index.ts derives the
 * URL it hands Persona's turn runner.
 */
export function collectorBaseUrl(env: Env = process.env): string {
  const port = parseInt(env.COLLECTOR_PORT ?? String(DEFAULT_COLLECTOR_PORT));
  const bind = env.STANDUP_BIND_HOST?.trim() || "127.0.0.1";
  const host = !bind || bind === "0.0.0.0" || bind === "::" ? "127.0.0.1" : bind;
  return `http://${host}:${Number.isFinite(port) ? port : DEFAULT_COLLECTOR_PORT}`;
}

/**
 * The owner's personal AWS account ids from STANDUP_PERSONAL_AWS_ACCOUNTS (a
 * comma list). Entries are trimmed and anything that isn't a 12-digit account id
 * is dropped, so a typo narrows the allowlist rather than widening it.
 */
export function parsePersonalAwsAccounts(raw: string | undefined): string[] {
  if (!raw) return [];
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d{12}$/.test(s));
  return [...new Set(ids)];
}

/** Personal AWS accounts when STANDUP_PERSONAL_AWS_ACCOUNTS is unset: none, so every AWS change outside a listed account is held. */
export const DEFAULT_PERSONAL_AWS_ACCOUNTS: readonly string[] = [];

/** Personal AWS account ids from STANDUP_PERSONAL_AWS_ACCOUNTS (read like parsePersonalAwsAccounts), else DEFAULT_PERSONAL_AWS_ACCOUNTS. */
export function personalAwsAccounts(raw: string | undefined): string[] {
  return raw === undefined ? [...DEFAULT_PERSONAL_AWS_ACCOUNTS] : parsePersonalAwsAccounts(raw);
}

/**
 * Non-prod AWS accounts when STANDUP_FLOOR_NONPROD_AWS_ACCOUNTS is unset:
 * none. An install lists its shared test accounts there, and usually its
 * personal ones too, so a call there that nothing places as personal (no
 * credential step or sts guard the floor reads) is still known as non-prod
 * rather than prod or unlisted.
 */
export const DEFAULT_NONPROD_AWS_ACCOUNTS: readonly string[] = [];

/** Non-prod AWS account ids from STANDUP_FLOOR_NONPROD_AWS_ACCOUNTS (a comma list, read like parsePersonalAwsAccounts), else DEFAULT_NONPROD_AWS_ACCOUNTS. */
export function nonProdAwsAccounts(raw: string | undefined): string[] {
  return raw === undefined ? [...DEFAULT_NONPROD_AWS_ACCOUNTS] : parsePersonalAwsAccounts(raw);
}

/**
 * The owner's own hosts: STANDUP_FLOOR_OWNER_HOSTS (a comma list of globs)
 * when set, else the org profile's ownerHostPatterns with `{owner}` filled
 * in (none in the default profile). An owner login that isn't a plain alias
 * gets no default.
 */
export function ownerHosts(raw: string | undefined, owner: string, patterns: readonly string[] = activeOrgProfile().ownerHostPatterns): string[] {
  if (raw !== undefined) return parseFloorList(raw).map((h) => h.toLowerCase());
  if (!/^[a-z0-9]+$/i.test(owner) || owner === "local") return [];
  return patterns.map((p) => p.split("{owner}").join(owner.toLowerCase()).toLowerCase());
}

/**
 * Hosts serving Standup's API: STANDUP_FLOOR_STANDUP_HOSTS when set, else the
 * host of the owner's Standup tunnel (`<owner>-standup`) under the tunnel
 * provider, when one is configured.
 */
export function standupHosts(raw: string | undefined, owner: string, provider: TunnelProvider = activeTunnelProvider()): string[] {
  if (raw !== undefined) return parseFloorList(raw).map((h) => h.toLowerCase());
  if (!/^[a-z0-9]+$/i.test(owner) || owner === "local" || !provider.enabled) return [];
  try {
    return [new URL(provider.url(`${owner.toLowerCase()}-standup`)).hostname.toLowerCase()];
  } catch {
    return [];
  }
}

/** The global setting naming where launch worktrees go (launcher.ts resolveWorktreeRoot). */
export const WORKTREE_ROOT_SETTING = "worktree_root";

/**
 * The dirs Standup creates launch worktrees under, absolute and deduped:
 * `worktrees/` in its data dir (the built-in default), STANDUP_WORKTREE_ROOT,
 * STANDUP_FLOOR_WORKTREE_ROOTS (a comma list), and `extra` (the worktree_root
 * setting and the project's own root). A root that is `/`, the home dir or
 * relative is dropped: it would make every checkout a Standup worktree. So is
 * one at or above the data dir, which would make Standup's own data one.
 */
export function floorWorktreeRoots(standupDataDir: string, env: Env, extra: ReadonlyArray<string | null | undefined> = [], home: string = homedir()): string[] {
  const expand = (p: string) => (p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p);
  // Raw and canonical forms, so a home dir reached through a symlink can't slip a root past these checks.
  const homes = [...new Set([resolve(home), canonical(resolve(home))])];
  const datas = [...new Set([resolve(standupDataDir), canonical(resolve(standupDataDir))])];
  const allowed = (r: string) => r !== "/" && !homes.includes(r) && !datas.some((d) => d === r || d.startsWith(`${r}/`));
  const roots = [join(standupDataDir, "worktrees"), env.STANDUP_WORKTREE_ROOT, ...parseFloorList(env.STANDUP_FLOOR_WORKTREE_ROOTS), ...extra]
    .map((r) => r?.trim())
    .filter((r): r is string => !!r)
    .map((r) => resolve(expand(r)))
    .filter((r) => r.startsWith("/") && allowed(r) && allowed(canonical(r)));
  return [...new Set(roots.flatMap((r) => [r, canonical(r)]))];
}

/**
 * The worktree paths of the other launches of the Persona job `launchId` is
 * linked to, or of `jobId` (the job a launch is being started for, before
 * Persona links it), cleaned-up launches left out. Empty when neither names a
 * job.
 */
export function jobLaunchPaths(db: Database, launchId: string, jobId?: string): string[] {
  const rows = db
    .query(
      `SELECT DISTINCT l.worktree_path AS path
         FROM persona_job_launches pjl
         JOIN launches l ON l.id = pjl.launch_id
        WHERE (pjl.job_id = ? OR pjl.job_id IN (SELECT job_id FROM persona_job_launches WHERE launch_id = ?))
          AND l.id != ?
          AND l.status != 'cleaned'`
    )
    .all(jobId ?? null, launchId, launchId) as Array<{ path: string | null }>;
  return rows.map((r) => r.path).filter((p): p is string => !!p);
}

/**
 * The worktree paths of the live launches outside the Persona job
 * `launchId` is linked to (or `jobId`, the job a launch is being started
 * for): other jobs' launches and launches of no job, cleaned-up ones left
 * out. With no job, every other live launch's.
 */
export function foreignLaunchPaths(db: Database, launchId: string, jobId?: string): string[] {
  const rows = db
    .query(
      `SELECT DISTINCT l.worktree_path AS path
         FROM launches l
        WHERE l.id != ?
          AND l.status != 'cleaned'
          AND l.id NOT IN (
            SELECT pjl.launch_id FROM persona_job_launches pjl
             WHERE pjl.job_id = ? OR pjl.job_id IN (SELECT job_id FROM persona_job_launches WHERE launch_id = ?)
          )`
    )
    .all(launchId, jobId ?? null, launchId) as Array<{ path: string | null }>;
  return rows.map((r) => r.path).filter((p): p is string => !!p);
}

/**
 * The foreign roots a launch's floor holds writes in (FloorConfig.foreignRoots):
 * `paths` filtered as floorJobRoots filters job roots (under a worktree root)
 * but each kept as given, never widened to its workspace, less any
 * that is the launch's own root or workspace or one of its job roots. Another
 * job's package checkout in the launch's own workspace stays foreign: the
 * floor lets a foreign root win where it lies strictly inside an own one.
 */
export function floorForeignRoots(
  paths: ReadonlyArray<string | null | undefined>,
  opts: Parameters<typeof floorJobRoots>[1] & { jobRoots?: readonly string[] }
): string[] {
  const own = new Set([...floorJobRoots([], opts), ...(opts.jobRoots ?? [])]);
  return floorJobRoots(paths, { ...opts, widen: false }).filter((p) => !own.has(p));
}

/**
 * The job roots a launch's floor treats as its own ground (FloorConfig.jobRoots):
 * each of `paths`, canonical, kept only when it lies at least two levels
 * under one of `worktreeRoots` (where the launcher makes them:
 * `<root>/<project>/<slug>`; one level down is a project's dir holding every
 * job's) and is neither `/`, the home dir, at or above the data dir
 * or the install, inside the install, nor inside the data dir outside its
 * `worktrees/`. A path with a `..` segment, or a relative one, is dropped, as
 * is `root` itself. Both a path as given and its canonical form must pass,
 * and no link below its worktree root may lead to it, so a symlink can't
 * carry one out of a worktree root or onto another job's worktree.
 *
 * A path inside a multi-checkout workspace (a dir under the worktree root
 * holding the project layout's workspaceMarker, `isWorkspace`) stands for the
 * whole workspace: a launch or an adopted session may be rooted at one
 * checkout of it. `root`'s own workspace is a job root too when the root is
 * below it. With no marker (the default git layout) no path is widened.
 * `widen: false` keeps each path as given.
 */
export function floorJobRoots(
  paths: ReadonlyArray<string | null | undefined>,
  opts: { root: string; worktreeRoots: readonly string[]; standupDataDir: string; installDir: string; home?: string; isWorkspace?: (dir: string) => boolean; widen?: boolean }
): string[] {
  const marker = activeProjectLayout().workspaceMarker;
  const isWorkspace = opts.isWorkspace ?? ((dir: string) => !!marker && existsSync(join(dir, marker)));
  const home = opts.home ?? homedir();
  const both = (p: string) => [...new Set([resolve(p), canonical(resolve(p))])];
  const homes = both(home);
  const datas = both(opts.standupDataDir);
  const installs = opts.installDir ? both(opts.installDir) : [];
  const roots = [...new Set(opts.worktreeRoots.filter((r) => r.startsWith("/")).flatMap(both))];
  const inside = (p: string, d: string) => p === d || p.startsWith(`${d}/`);
  const allowed = (p: string) =>
    p !== "/" &&
    !homes.includes(p) &&
    !datas.some((d) => inside(d, p)) &&
    !installs.some((d) => inside(d, p) || inside(p, d)) &&
    !datas.some((d) => inside(p, d) && !p.startsWith(`${join(d, "worktrees")}/`)) &&
    roots.some((r) => p.startsWith(`${r}/`) && p.slice(r.length + 1).split("/").length >= 2);
  const own = both(opts.root);
  // The workspace `p` is in, at least two levels below the worktree root it is under; `p` itself when there is none.
  const workspaceOf = (p: string): string => {
    const r = roots.find((x) => p.startsWith(`${x}/`));
    if (r === undefined) return p;
    for (let d = p; d.startsWith(`${r}/`) && d.slice(r.length + 1).split("/").length >= 2; d = dirname(d)) if (isWorkspace(d)) return d;
    return p;
  };
  const out: string[] = [];
  for (const raw of [...paths, opts.root]) {
    const p = raw?.trim();
    if (!p || !p.startsWith("/") || p.split("/").includes("..")) continue;
    const given = opts.widen === false ? resolve(p) : workspaceOf(resolve(p));
    const canon = canonical(given);
    // Only the worktree root itself may be reached through a link: one below it points wherever whoever wrote it chose.
    const unlinked = roots.some((r) => given.startsWith(`${r}/`) && join(canonical(r), given.slice(r.length + 1)) === canon);
    if (!unlinked || !allowed(given) || !allowed(canon) || own.includes(canon)) continue;
    if (!out.includes(canon)) out.push(canon);
  }
  return out;
}

/** Seconds a floored call waits on a decision: STANDUP_FLOOR_WAIT_S when a positive number, else DEFAULT_FLOOR_WAIT_S. */
export function floorWaitSeconds(raw: string | undefined): number {
  const n = raw === undefined ? NaN : Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FLOOR_WAIT_S;
}

/** Resolves symlinks when the path exists, so the root matches the cwd a worker reports. */
function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * The files and dirs the hook itself runs from: the floor dir, the persona
 * policy module and the persona modules it imports (consent-target,
 * owner-speech, review-noun), the org-profile readings the classifier
 * imports, and the shared package. A worker that edits any of them could
 * change what the hook decides, so the classifier treats them as
 * floor-tampering targets.
 */
export function floorSourcePaths(floorDir: string = FLOOR_DIR): string[] {
  return [
    floorDir,
    resolve(floorDir, "..", "persona", "policy.ts"),
    resolve(floorDir, "..", "persona", "consent-target.ts"),
    resolve(floorDir, "..", "persona", "owner-speech.ts"),
    resolve(floorDir, "..", "persona", "review-noun.ts"),
    resolve(floorDir, "..", "org-profile"),
    resolve(floorDir, "..", "..", "..", "shared"),
  ];
}

export interface LaunchFloorInput {
  launchId: string;
  /** The launch's worktree path (an in-place launch's real repo path). */
  root: string;
  /** The project's base branch, shared beside DEFAULT_SHARED_BRANCHES. */
  projectBranch?: string;
  /** The launch's scoped worker token; a fresh random one when omitted (see newWorkerToken). */
  workerToken?: string;
  /** The collector's floor reply public key; defaults to activeOwnerSecrets()'s. */
  replyPublicKey?: string;
  /** Read the repository's own hooks strictly (FloorConfig.strictHooks). */
  strictHooks?: boolean;
  /** Worktree roots beside the built-in ones: the worktree_root setting and the project's own (floorWorktreeRoots). */
  worktreeRoots?: ReadonlyArray<string | null | undefined>;
  /** The id the launch's scratch dir (its TMPDIR) is named for, when not the launch's own (launchScratchId). */
  scratchId?: string;
  /** The worktree paths of the other launches of the launch's Persona job (jobLaunchPaths), filtered into FloorConfig.jobRoots by floorJobRoots. */
  jobRoots?: ReadonlyArray<string | null | undefined>;
  /** The worktree paths of live launches outside that job (foreignLaunchPaths), filtered into FloorConfig.foreignRoots by floorForeignRoots. */
  foreignRoots?: ReadonlyArray<string | null | undefined>;
}

/**
 * The id a launch's scratch dir is named for, from the collector's launch
 * records: an adopted launch resumes a session and keeps the scratch dir of
 * the session's first launch; any other launch has its own.
 */
export function launchScratchId(db: Database, launch: Pick<Launch, "id" | "kind" | "sessionId">): string {
  if (launch.kind !== "adopted" || !launch.sessionId) return launch.id;
  return getOriginalLaunchBySession(db, launch.sessionId)?.id ?? launch.id;
}

/** A comma list from the env, trimmed, with blanks and duplicates dropped. */
export function parseFloorList(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
}

/** A fresh scoped worker credential for one launch (32 random bytes, hex). */
export function newWorkerToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * The temp dirs whose children are scratch space: the collector's os.tmpdir(),
 * /tmp and /var/tmp, each as given and with symlinks resolved (macOS's /tmp is
 * /private/tmp), deduped. Fixed at launch so the hook never takes them from its
 * own env. An os.tmpdir() at or below the scratch root (a collector started
 * from a worker's pane inherits that worker's TMPDIR) is dropped: the scratch
 * root is protected, and no launch's scratch dir is every launch's temp dir.
 */
export function floorTmpDirs(osTmp: string = tmpdir(), scratch: string = scratchRoot()): string[] {
  const out: string[] = [];
  for (const dir of underRoot(osTmp, scratch) ? ["/tmp", "/var/tmp"] : [osTmp, "/tmp", "/var/tmp"]) {
    for (const p of [dir.replace(/\/+$/, "") || "/", canonical(dir)]) {
      if (p && !out.includes(p)) out.push(p);
    }
  }
  return out;
}

/** Whether `path` is `root` or below it, each taken as given and with symlinks resolved. */
function underRoot(path: string, root: string): boolean {
  const roots = [...new Set([resolve(root), canonical(resolve(root))])];
  return [resolve(path), canonical(resolve(path))].some((p) => roots.some((r) => p === r || p.startsWith(`${r}/`)));
}

/** The env names os.tmpdir() and Python's tempfile find the temp dir by. */
const TEMP_ENV_NAMES = ["TMPDIR", "TMP", "TEMP"] as const;

/**
 * Deletes from `env` each of TMPDIR, TMP and TEMP that lies at or below the
 * scratch root, returning the names deleted. A collector started from a
 * worker's pane inherits that worker's scratch dir as its temp dir, which the
 * dir's job hygiene removes and every temp path the collector derives (the
 * floor's temp dirs, the panes' tmux dir) would root in.
 */
export function dropScratchTempEnv(env: Env = process.env, root: string = scratchRoot(env)): string[] {
  const dropped: string[] = [];
  for (const name of TEMP_ENV_NAMES) {
    const value = env[name]?.trim();
    if (!value || !underRoot(value, root)) continue;
    delete env[name];
    dropped.push(name);
  }
  return dropped;
}

/** Why a read or listing of the owner's media uploads is held: Persona forwarded them and decides who opens them. */
export const PERSONA_MEDIA_REASON = "reads an owner media upload in persona-attachments, which Persona decides whether this worker may open";

/** Why a read of the per-launch scratch dirs past the launch's own is held: they hold other workers' files, not owner-side secrets. */
export const SCRATCH_ROOT_REASON = "is in or above other launches' scratch dirs (their venvs, scripts and evidence), which Persona decides whether this worker may open";

/** The FloorConfig for one launch, reading the collector's env for the box-wide knobs. */
export function buildLaunchFloorConfig(input: LaunchFloorInput, env: Env = process.env): FloorConfig {
  const branch = input.projectBranch?.trim();
  const sharedBranches = [...DEFAULT_SHARED_BRANCHES];
  if (branch && !sharedBranches.includes(branch)) sharedBranches.push(branch);
  const standupDataDir = dirname(env.DB_PATH ?? defaultDbPath());
  const scratch = scratchRoot(env);
  const scratchId = input.scratchId ?? input.launchId;
  const worktreeRoots = floorWorktreeRoots(standupDataDir, env, input.worktreeRoots);
  const installDir = resolveInstallDir(env);
  const jobRoots = floorJobRoots(input.jobRoots ?? [], { root: input.root, worktreeRoots, standupDataDir, installDir });
  const foreignRoots = floorForeignRoots(input.foreignRoots ?? [], { root: input.root, worktreeRoots, standupDataDir, installDir, jobRoots });
  return {
    v: 1,
    collectorUrl: collectorBaseUrl(env),
    launchId: input.launchId,
    root: canonical(input.root),
    sharedBranches,
    personalAwsAccounts: personalAwsAccounts(env.STANDUP_PERSONAL_AWS_ACCOUNTS),
    nonProdAwsAccounts: nonProdAwsAccounts(env.STANDUP_FLOOR_NONPROD_AWS_ACCOUNTS),
    ownerHosts: ownerHosts(env.STANDUP_FLOOR_OWNER_HOSTS, hostUserAlias(env)),
    standupHosts: standupHosts(env.STANDUP_FLOOR_STANDUP_HOSTS, hostUserAlias(env)),
    worktreeRoots,
    ...(jobRoots.length ? { jobRoots } : {}),
    ...(foreignRoots.length ? { foreignRoots } : {}),
    waitSeconds: floorWaitSeconds(env.STANDUP_FLOOR_WAIT_S),
    standupDataDir,
    publicKnowledgeSocket: publicKnowledgeSocketPath(standupDataDir, env),
    // The org profile file is floor-tamper ground too: the next launch's
    // floor reads the vocabulary it gives.
    floorPaths: [...floorSourcePaths(), orgProfilePath(env)],
    ...(activeProjectLayout().workspaceMarker ? { workspaceMarker: activeProjectLayout().workspaceMarker! } : {}),
    // The built-in profile is what an absent one means; only another is carried.
    ...(activeOrgProfile() === DEFAULT_ORG_PROFILE ? {} : { orgProfile: activeOrgProfile() }),
    installDir,
    // Every launch's review token file is out of every worker's reach: a
    // worker's own is read by its MCP server, never through a tool call.
    // Stored review media and the review scratch dirs hold other users'
    // captures; the classifier leaves the launch's own scratch dir to it.
    protectedPaths: [
      ...new Set([
        ownerSecretsDir(standupDataDir),
        workerTokensDir(standupDataDir),
        reviewMediaDir(standupDataDir),
        reviewScratchRoot(standupDataDir),
        PERSONA_CWD,
      ]),
    ],
    // The owner's media uploads to Persona and the per-launch TMPDIR scratch
    // dirs: private, but Persona's to allow a worker to open. The classifier
    // leaves the launch's own scratch dir to it.
    privatePaths: [
      { path: join(standupDataDir, PERSONA_ATTACHMENTS_DIRNAME), category: "standup-ops", reason: PERSONA_MEDIA_REASON },
      { path: scratch, category: "standup-ops", reason: SCRATCH_ROOT_REASON },
    ],
    tmpDirs: floorTmpDirs(tmpdir(), scratch),
    scratchRoot: scratch,
    ...(SCRATCH_ID.test(scratchId) ? { scratchDir: scratchDirFor(scratchId, env), ...(scratchId !== input.launchId ? { scratchId } : {}) } : {}),
    workerToken: input.workerToken ?? newWorkerToken(),
    replyPublicKey: input.replyPublicKey ?? activeOwnerSecrets().replyPublicKey,
    readOnlyMcpTools: parseFloorList(env.STANDUP_FLOOR_READONLY_MCP),
    webFetchDomains: parseFloorList(env.STANDUP_FLOOR_WEBFETCH_DOMAINS).map((d) => d.toLowerCase()),
    ...(input.strictHooks ? { strictHooks: true } : {}),
  };
}

/** Filesystem reads the installability check makes; injectable for tests. */
export interface FloorFs {
  exists(path: string): boolean;
  /** The file's text, or undefined when it can't be read. */
  read(path: string): string | undefined;
  /** The names in a directory, or [] when it can't be listed. */
  list?(dir: string): string[];
}

const realFs: FloorFs = {
  exists: (p) => existsSync(p),
  read: (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return undefined;
    }
  },
  list: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
};

/** Managed-policy settings files, and the drop-in dirs whose `*.json` Claude Code merges into them. */
const MANAGED_SETTINGS = [
  { file: "/etc/claude-code/managed-settings.json", dropIns: "/etc/claude-code/managed-settings.d" },
  {
    file: "/Library/Application Support/ClaudeCode/managed-settings.json",
    dropIns: "/Library/Application Support/ClaudeCode/managed-settings.d",
  },
];

/** Claude Code settings keys that stop a `--settings` PreToolUse hook from running. */
const HOOK_DISABLING_KEYS = ["disableAllHooks", "allowManagedHooksOnly"] as const;

/**
 * Settings files Claude Code reads for a session started in `dirs`: the
 * managed-policy files and their `managed-settings.d/*.json` drop-ins (when
 * `fs` can list them), the user's own settings (under ~/.claude and, when
 * set, `$CLAUDE_CONFIG_DIR`), and each dir's project and local settings.
 */
export function claudeSettingsFiles(dirs: string[], home: string = homedir(), fs: FloorFs = realFs, env: Env = process.env): string[] {
  const files: string[] = [];
  for (const managed of MANAGED_SETTINGS) {
    files.push(managed.file);
    const dropIns = (fs.list?.(managed.dropIns) ?? []).filter((name) => name.endsWith(".json")).sort();
    for (const name of dropIns) files.push(join(managed.dropIns, name));
  }
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  for (const dir of [join(home, ".claude"), ...(configDir ? [configDir] : [])]) {
    files.push(join(dir, "settings.json"), join(dir, "settings.local.json"));
  }
  for (const dir of dirs) {
    files.push(join(dir, ".claude", "settings.json"), join(dir, ".claude", "settings.local.json"));
  }
  return [...new Set(files)];
}

/** Whether `path` is `root` or lies under it. */
function isWithin(path: string, root: string): boolean {
  const base = root.endsWith(sep) ? root : root + sep;
  return path === root || path.startsWith(base);
}

/**
 * Why a worker rooted at `root` can't run bypassed: its root contains (is, or
 * is an ancestor of) the user's home, Standup's data dir or the Standup install
 * dir. Such a root would make everything the floor protects part of the
 * worker's own tree, which the classifier treats as the worker's to change.
 * A root strictly inside those (a repo under home, a Standup worktree under
 * the data dir) is fine. Undefined when the root is safe.
 */
export function floorRootReason(root: string, home: string, env: Env = process.env): string | undefined {
  const canon = canonical(root);
  const protectedDirs = [
    { what: "the user's home directory", dir: canonical(home) },
    { what: "Standup's data directory", dir: canonical(dirname(env.DB_PATH ?? defaultDbPath())) },
    { what: "the Standup install directory", dir: canonical(resolveInstallDir(env)) },
  ];
  const hit = protectedDirs.find((p) => isWithin(p.dir, canon));
  return hit ? `the working directory ${root} contains ${hit.what}` : undefined;
}

export interface FloorCheckOptions {
  fs?: FloorFs;
  home?: string;
  hookPath?: string;
  /** The env Claude Code runs under (its CLAUDE_CONFIG_DIR); defaults to the collector's. */
  env?: Env;
  /** Whether the launch bypasses, so its confirmation dialog must be pre-dismissed (default true). */
  bypass?: boolean;
}

/**
 * Why a launch working in `dirs` (its worktree root and launch cwd) can't run
 * bypassed under the safety floor, or undefined when it can. The floor can't
 * run when its hook script is missing, or when any settings file Claude Code
 * loads for the session turns hooks off (`disableAllHooks`) or restricts them
 * to managed ones (`allowManagedHooksOnly`) — in either case a bypassed session
 * would run unguarded, so the launcher must not bypass. A settings file that
 * can't be read or parsed is skipped: Claude Code doesn't apply it either.
 *
 * Bypass mode also opens on a confirmation dialog unless a settings file sets
 * `skipDangerousModePermissionPrompt` or `~/.claude.json` records the mode as
 * accepted (`bypassPermissionsModeAccepted`); nobody is at a launched pane to
 * dismiss it, so without either the session would stall before its first turn.
 * With `bypass: false` that check is skipped: the answer is then whether the
 * hook can run in a session that doesn't bypass.
 *
 * A working directory that contains the user's home, Standup's data dir or the
 * install dir is refused too (floorRootReason): the floor would treat all of
 * it as the worker's own.
 */
export function floorUnavailableReason(dirs: string[], opts: FloorCheckOptions = {}): string | undefined {
  const fs = opts.fs ?? realFs;
  const hookPath = opts.hookPath ?? FLOOR_HOOK_PATH;
  if (!fs.exists(hookPath)) return `the safety-floor hook is missing at ${hookPath}`;
  const home = opts.home ?? homedir();
  for (const dir of dirs) {
    const reason = floorRootReason(dir, home, opts.env ?? process.env);
    if (reason) return reason;
  }
  const readJson = (file: string): Record<string, unknown> | undefined => {
    if (!fs.exists(file)) return undefined;
    const text = fs.read(file);
    if (text === undefined) return undefined;
    try {
      const parsed: unknown = JSON.parse(text);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };
  const env = opts.env ?? process.env;
  let promptSkipped = false;
  for (const file of claudeSettingsFiles(dirs, opts.home, fs, env)) {
    const parsed = readJson(file);
    if (!parsed) continue;
    for (const key of HOOK_DISABLING_KEYS) {
      if (parsed[key] === true) {
        return `${file} sets ${key}: true, so the safety-floor hook would not run`;
      }
    }
    if (parsed.skipDangerousModePermissionPrompt === true) promptSkipped = true;
  }
  if (opts.bypass === false) return undefined;
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  const claudeJsons = [join(opts.home ?? homedir(), ".claude.json"), ...(configDir ? [join(configDir, ".claude.json")] : [])];
  const accepted = claudeJsons.some((file) => readJson(file)?.bypassPermissionsModeAccepted === true);
  if (!promptSkipped && !accepted) {
    return "bypass mode would open on Claude Code's confirmation dialog (no settings file sets skipDangerousModePermissionPrompt and ~/.claude.json has not accepted the mode), and nobody is at the pane to dismiss it";
  }
  return undefined;
}
