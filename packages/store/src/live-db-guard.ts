import { lstatSync, readlinkSync, realpathSync } from "fs";
import { homedir, tmpdir, userInfo } from "os";
import { basename, dirname, join, resolve, sep } from "path";

/**
 * Tests run as the owner's Unix user on the machine that hosts the live
 * Standup service, so a test that opens a SQLite file by the collector's
 * default resolution (DB_PATH, else ~/.local/share/standup/standup.db) would
 * read and write the owner's real data. These checks let the DB layer refuse
 * that during a test run.
 */

/**
 * The env var the test preload records an inherited DB_PATH under before it
 * replaces it: a worker's env names the live DB there, wherever the owner
 * keeps it, so that file counts as live too.
 */
export const INHERITED_DB_PATH_ENV = "STANDUP_INHERITED_DB_PATH";

/**
 * Whether this process is a test run: the bunfig preload's STANDUP_TEST, or
 * the NODE_ENV `bun test` sets. Nothing outside tests sets NODE_ENV=test; a
 * collector started under it would refuse to open its DB, loudly.
 */
export function isTestRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.STANDUP_TEST === "1" || env.NODE_ENV === "test";
}

/**
 * `p` with every symlink resolved, including a dangling leaf link (which
 * SQLite would create its file through) and missing trailing components.
 */
function canonical(p: string, hops = 0): string {
  try {
    return realpathSync(p);
  } catch {
    // Missing, or a dangling link: resolve what can be resolved below.
  }
  if (hops < 32) {
    try {
      if (lstatSync(p).isSymbolicLink()) return canonical(resolve(canonical(dirname(p), hops + 1), readlinkSync(p)), hops + 1);
    } catch {
      // Nothing at `p` at all.
    }
  }
  const parent = dirname(p);
  return parent === p ? p : join(canonical(parent, hops), basename(p));
}

/**
 * The file a bun:sqlite filename opens, or null for an in-memory DB: a
 * `file:` URI (`file:/x`, `file:///x`, `file://localhost/x`, with any
 * `?query`/`#fragment`) is reduced to its path.
 */
export function sqliteFilePath(dbPath: string): string | null {
  if (dbPath === "" || dbPath === ":memory:") return null;
  if (!dbPath.startsWith("file:")) return dbPath;
  const query = new URLSearchParams(dbPath.split(/[?#]/)[1] ?? "");
  let rest = dbPath.slice("file:".length).split(/[?#]/)[0];
  if (rest.startsWith("//")) {
    const slash = rest.indexOf("/", 2);
    rest = slash === -1 ? "" : rest.slice(slash);
  }
  let path: string;
  try {
    path = decodeURIComponent(rest);
  } catch {
    path = rest;
  }
  if (path === "" || path === ":memory:" || query.get("mode") === "memory") return null;
  return path;
}

/** The home dirs a default DB path can resolve under: HOME as it is now, and os.homedir() (which Bun caches at startup). */
function currentHomes(): string[] {
  return [process.env.HOME, homedir()].filter((h): h is string => !!h);
}

/**
 * Every spelling of the owner's real data dir: under each of `homes`, and
 * under the account's home from the password database (which a test that
 * points HOME elsewhere still runs as), each as written and with symlinks
 * resolved.
 */
export function liveDataDirs(homes: string[] = currentHomes()): string[] {
  const all = new Set(homes);
  try {
    all.add(userInfo().homedir);
  } catch {
    // No password-database entry for this uid: HOME is all there is.
  }
  const dirs = new Set<string>();
  for (const h of all) {
    const dir = resolve(h, ".local", "share", "standup");
    dirs.add(dir);
    dirs.add(canonical(dir));
  }
  return [...dirs];
}

/**
 * Whether `dbPath` is the owner's live data: a database in the real data dir,
 * or the DB_PATH the test preload found inherited. Worktrees live under
 * `<dataDir>/worktrees/`, and a test's own scratch file there is not the
 * owner's data, so that subtree is excluded.
 */
export function isLiveDbPath(
  dbPath: string,
  homes: string[] = currentHomes(),
  inherited: string | undefined = process.env[INHERITED_DB_PATH_ENV]
): boolean {
  const file = sqliteFilePath(dbPath);
  if (file === null) return false;
  const spellings = new Set([resolve(file), canonical(resolve(file))]);
  const inheritedFile = inherited ? sqliteFilePath(inherited) : null;
  if (inheritedFile) {
    const live = new Set([resolve(inheritedFile), canonical(resolve(inheritedFile))]);
    for (const p of spellings) if (live.has(p)) return true;
  }
  for (const dir of liveDataDirs(homes)) {
    for (const p of spellings) {
      if (!p.startsWith(dir + sep)) continue;
      if (p.startsWith(join(dir, "worktrees") + sep)) continue;
      return true;
    }
  }
  return false;
}

/** tmux's socket-path ceiling (tmux-launch's SUN_PATH_MAX). */
const SUN_PATH_MAX = 103;

/**
 * Where a test's scratch data dir named `<prefix>XXXXXX` goes: the temp dir,
 * unless the workers' tmux socket under it (`<dataDir>/tmux/workers`) would
 * be too long for tmux — a worker's own TMPDIR is deep enough for that — and
 * then /tmp.
 */
export function scratchDataDirBase(prefix: string): string {
  const dir = tmpdir();
  return join(dir, `${prefix}XXXXXX`, "tmux", "workers").length <= SUN_PATH_MAX ? dir : "/tmp";
}

/** Throws when a test run is about to open the owner's live database. */
export function assertNotLiveDbInTest(dbPath: string, env: NodeJS.ProcessEnv = process.env, homes: string[] = currentHomes()): void {
  if (!isTestRun(env) || !isLiveDbPath(dbPath, homes, env[INHERITED_DB_PATH_ENV])) return;
  throw new Error(
    `refusing to open ${dbPath} under a test run: it is the live Standup database. ` +
      `Give the test a scratch DB under a mkdtemp dir (or ":memory:").`
  );
}
