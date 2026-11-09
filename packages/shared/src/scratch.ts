import { homedir } from "os";
import { basename, isAbsolute, join, normalize } from "path";

/**
 * Per-launch scratch directories: each worker's TMPDIR. They live on disk
 * under the user's cache dir (`${XDG_CACHE_HOME:-~/.cache}/standup-scratch`),
 * a sibling of the protected `standup` toolchain dir rather than inside it,
 * and not under /tmp, which is often a tmpfs, so a worker's scratch files
 * and test fixtures don't hold the host's RAM. One dir per launch, named by its
 * id, removed when the launch's job closes.
 */

type Env = Record<string, string | undefined>;

/**
 * A launch id usable as a scratch dir name: the shape of the launch ids
 * Standup makes (randomUUID) and other plain ids — letters, digits, `_` and
 * `-`, starting with a letter or digit, at most 64 characters. No `.` at all,
 * so never `.`/`..`, a dotfile or the marker file's name, and no separators.
 */
export const SCRATCH_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** The file in each scratch dir naming the launch it belongs to; only a dir carrying it is ever removed. */
export const SCRATCH_MARKER = ".standup-scratch";

/** What every scratch root's own name starts with: a STANDUP_SCRATCH_ROOT named otherwise is ignored. */
const SCRATCH_ROOT_NAME = "standup-scratch";

/**
 * The root holding every launch's scratch dir: STANDUP_SCRATCH_ROOT when set
 * to an absolute path whose last component starts with `standup-scratch`
 * (test runs point it at such a temp dir), else
 * `${XDG_CACHE_HOME:-~/.cache}/standup-scratch`. The name check keeps an
 * override from making some unrelated dir the root the scratch sweep lists.
 */
export function scratchRoot(env: Env = process.env, home: string = homedir()): string {
  const override = env.STANDUP_SCRATCH_ROOT?.trim();
  const root = override && isAbsolute(override) ? normalize(override).replace(/(.)\/+$/, "$1") : null;
  if (root && basename(root).startsWith(SCRATCH_ROOT_NAME)) return root;
  const cache = env.XDG_CACHE_HOME?.trim();
  return join(cache && isAbsolute(cache) ? normalize(cache) : join(home, ".cache"), "standup-scratch");
}

/** The scratch dir of `launchId`: `<scratchRoot>/<launchId>`. Throws for an id SCRATCH_ID refuses. */
export function scratchDirFor(launchId: string, env: Env = process.env, home: string = homedir()): string {
  if (!SCRATCH_ID.test(launchId)) throw new Error(`not a usable launch id for a scratch dir: ${JSON.stringify(launchId)}`);
  return join(scratchRoot(env, home), launchId);
}

/** Whether `path` (normalized) is exactly the scratch dir of `launchId`. */
export function isOwnScratchDir(path: string, launchId: string, env: Env = process.env, home: string = homedir()): boolean {
  if (!SCRATCH_ID.test(launchId) || !isAbsolute(path)) return false;
  return normalize(path).replace(/\/+$/, "") === scratchDirFor(launchId, env, home);
}
