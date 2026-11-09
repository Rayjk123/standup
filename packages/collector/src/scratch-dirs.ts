import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { basename, isAbsolute, join, normalize } from "path";
import type { Database } from "bun:sqlite";
import type { Launch } from "@standup/shared";
import { SCRATCH_ID, SCRATCH_MARKER, scratchRoot } from "@standup/shared/scratch";
import { getLaunch, launchHasOpenPersonaJob, personaJobForLaunch, personaJobForSession } from "@standup/store";
import { launchScratchId } from "./floor/launch.js";
import { launchLiveForHygiene, type LivenessOptions, type PaneAlive } from "./launch-holds.js";

/**
 * The launches' scratch dirs on disk (see @standup/shared/scratch): made at
 * launch as the worker's TMPDIR, removed when its job closes, and swept when a
 * dir outlives its launch. Each carries a marker file (SCRATCH_MARKER) holding
 * its launch id, and only a dir whose marker names it is ever removed.
 */

/** How old an unclaimed scratch dir must be before the sweep removes it. */
export const SCRATCH_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

function ownUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function refuseId(launchId: string): void {
  if (!SCRATCH_ID.test(launchId)) throw new Error(`not a usable launch id for a scratch dir: ${JSON.stringify(launchId)}`);
}

/** The launch id `dir`'s marker file names; null when it has none (or it isn't a plain file). */
function markerOf(dir: string): string | null {
  const marker = join(dir, SCRATCH_MARKER);
  try {
    if (!lstatSync(marker).isFile()) return null;
    return readFileSync(marker, "utf8").trim();
  } catch {
    return null;
  }
}

/**
 * Whether `root` may hold scratch dirs that get removed: an absolute,
 * normalized path (no `..` or `.` segment, no `//`, no trailing `/`) other
 * than `/`, whose last segment starts with `standup-scratch`.
 */
export function usableScratchRoot(root: string): boolean {
  if (root === "" || root === "/" || !isAbsolute(root)) return false;
  if (normalize(root) !== root || root.endsWith("/") || root.includes("//")) return false;
  if (root.split("/").some((seg) => seg === ".." || seg === ".")) return false;
  return basename(root).startsWith("standup-scratch");
}

/** Whether `dir` carries a marker naming `launchId`. */
export function hasScratchMarker(dir: string, launchId: string): boolean {
  return markerOf(dir) === launchId;
}

/**
 * Creates `<root>/<launchId>` as a 0700 directory of this user's, with its
 * marker file naming `launchId`, and returns its path. Throws for an id
 * SCRATCH_ID refuses, when the path is already something else (a symlink, a
 * file, another user's dir), and when its marker names another launch (or is
 * not a plain file), so a worker's TMPDIR never points somewhere it doesn't own.
 */
export function ensureScratchDir(launchId: string, root: string = scratchRoot()): string {
  refuseId(launchId);
  const dir = join(root, launchId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  const uid = ownUid();
  if (!st.isDirectory() || (uid !== null && st.uid !== uid)) {
    throw new Error(`scratch dir ${dir} is not a directory of this user's`);
  }
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  const marker = join(dir, SCRATCH_MARKER);
  let present = true;
  try {
    lstatSync(marker);
  } catch {
    present = false;
  }
  // `wx` creates the file and never follows or overwrites what is there.
  if (!present) writeFileSync(marker, `${launchId}\n`, { flag: "wx", mode: 0o600 });
  if (!hasScratchMarker(dir, launchId)) throw new Error(`scratch dir ${dir} is marked as another launch's`);
  return dir;
}

/**
 * Removes the scratch dir of `launchId` and everything in it. Only a real
 * directory at exactly `<root>/<launchId>` whose marker names `launchId` is
 * removed: a symlink there, anything that isn't a directory, and a dir with
 * no marker or another's are left alone, and the recursive removal unlinks
 * symlinks inside rather than following them. Returns whether a dir was
 * removed; a missing one is not an error. Nothing is touched under a root
 * usableScratchRoot refuses.
 */
export function removeScratchDir(launchId: string, root: string = scratchRoot()): boolean {
  if (!usableScratchRoot(root)) return false;
  if (!SCRATCH_ID.test(launchId)) return false;
  const dir = join(root, launchId);
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return false;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return false;
  if (!hasScratchMarker(dir, launchId)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * The launches whose scratch dir is the one named `launchId`: that launch and
 * every launch of its session whose scratch id (launchScratchId) is it, as an
 * adoption resuming the session keeps the original launch's dir.
 */
function scratchUsers(db: Database, launch: Launch): Launch[] {
  if (!launch.sessionId) return [launch];
  const rows = db.query("SELECT id FROM launches WHERE session_id = ? AND id != ?").all(launch.sessionId, launch.id) as Array<{ id: string }>;
  const users = [launch];
  for (const { id } of rows) {
    const other = getLaunch(db, id);
    if (other && launchScratchId(db, other) === launch.id) users.push(other);
  }
  return users;
}

const CLOSED_JOB = new Set(["done", "failed", "cancelled"]);

/** Whether a paused worker may still be resumed into the launch: it is running and reaped, and its Persona job (if any) is open. */
function resumable(db: Database, launch: Launch): boolean {
  if (launch.status !== "running" || !launch.reapedAt) return false;
  const job = personaJobForLaunch(db, launch.id)?.job ?? (launch.sessionId ? personaJobForSession(db, launch.sessionId)?.job : undefined);
  return !job || !CLOSED_JOB.has(job.status);
}

/**
 * Whether a launch's scratch dir must stay: the launch is known and either
 * reaped while its Persona job is still open, or any launch using the dir
 * (scratchUsers) is live by launchLiveForHygiene or is a paused worker that
 * may still be resumed (so it finds its files again).
 */
export function scratchKeptByStore(db: Database, launchId: string, opts: LivenessOptions = {}): boolean {
  const launch = getLaunch(db, launchId);
  if (!launch) return false;
  if (launch.reapedAt !== undefined && launchHasOpenPersonaJob(db, launchId)) return true;
  return scratchUsers(db, launch).some((user) => launchLiveForHygiene(db, user, opts) || resumable(db, user));
}

export interface SweepScratchOptions {
  /** The current time in ms; defaults to Date.now(). */
  now?: number;
  /** Dirs not modified for longer than this are candidates; defaults to SCRATCH_MAX_AGE_MS. */
  maxAgeMs?: number;
  /** Whether `launchId`'s dir must stay; defaults to scratchKeptByStore. */
  isKept?: (launchId: string) => boolean;
  /** Whether a running launch's pane still exists, for the default isKept; defaults to the workers' tmux server. */
  paneAlive?: PaneAlive;
  /** Whether `launchId` is a launch the store knows; defaults to a getLaunch lookup. */
  isKnown?: (launchId: string) => boolean;
  root?: string;
  /** Logs a dir left because no known launch owns it; defaults to console.log, once per dir per process. */
  log?: (message: string) => void;
}

/** Dirs already logged as belonging to no known launch. */
const loggedUnknown = new Set<string>();

/**
 * Removes scratch dirs of launches the store knows that no longer claim them
 * (isKept) and that have not been modified for `maxAgeMs`. A dir's mtime moves
 * only when an entry directly in it is added or removed, so the age is a floor
 * on idleness, and the claim check is what keeps a live launch's dir. Entries
 * that aren't a launch-id-named real directory carrying its marker are
 * skipped, and so is a dir whose launch the store doesn't know (logged once).
 * A root usableScratchRoot refuses is not read at all. Returns the launch ids
 * removed.
 */
export function sweepScratchDirs(db: Database, opts: SweepScratchOptions = {}): string[] {
  const root = opts.root ?? scratchRoot();
  if (!usableScratchRoot(root)) return [];
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? SCRATCH_MAX_AGE_MS;
  const liveness: LivenessOptions = opts.paneAlive ? { paneAlive: opts.paneAlive } : {};
  const isKept = opts.isKept ?? ((id: string) => scratchKeptByStore(db, id, liveness));
  const isKnown = opts.isKnown ?? ((id: string) => getLaunch(db, id) !== null);
  const log = opts.log ?? ((message: string) => console.log(message));
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!SCRATCH_ID.test(name)) continue;
    let st;
    try {
      st = lstatSync(join(root, name));
    } catch {
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) continue;
    if (now - st.mtimeMs <= maxAgeMs) continue;
    if (!hasScratchMarker(join(root, name), name)) continue;
    if (!isKnown(name)) {
      const dir = join(root, name);
      if (!loggedUnknown.has(dir)) {
        loggedUnknown.add(dir);
        log(`[scratch] left ${dir}: no known launch ${name} owns it`);
      }
      continue;
    }
    if (isKept(name)) continue;
    if (removeScratchDir(name, root)) removed.push(name);
  }
  return removed;
}

export interface CheckScratchFsOptions {
  root?: string;
  /** Runs `findmnt` and returns its stdout, or null when it can't be run; injectable for tests. */
  findmnt?: (path: string) => string | null;
  warn?: (message: string) => void;
}

function runFindmnt(path: string): string | null {
  try {
    const res = Bun.spawnSync(["findmnt", "-no", "FSTYPE", "-T", path], { stdout: "pipe", stderr: "ignore", timeout: 2_000 });
    return res.exitCode === 0 ? res.stdout.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The filesystem type the scratch root sits on (`findmnt -T`, which resolves
 * the nearest existing ancestor), or null when findmnt is missing or fails.
 * Warns when it is tmpfs: the scratch dirs would then hold RAM, the thing
 * keeping them off /tmp is meant to avoid.
 */
export function checkScratchFs(opts: CheckScratchFsOptions = {}): string | null {
  const root = opts.root ?? scratchRoot();
  const out = (opts.findmnt ?? runFindmnt)(root);
  const fstype = out?.trim().split("\n")[0]?.trim() || null;
  if (fstype === "tmpfs") {
    (opts.warn ?? console.warn)(`[scratch] ${root} is on tmpfs, so worker scratch dirs use RAM; point XDG_CACHE_HOME at a disk-backed dir`);
  }
  return fstype;
}
