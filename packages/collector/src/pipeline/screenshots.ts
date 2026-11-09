import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, isAbsolute, join, relative, sep } from "path";

/**
 * Screenshot evidence for the delivery pipeline's screenshot stage. A worker
 * names PNG files by absolute path under a temp root; the collector accepts
 * only a real PNG the worker's own user wrote there (the file and every
 * directory between the root and it owned by this user and not writable by
 * anyone else, the file itself no symlink), reads it once through one file
 * descriptor, and keeps its own copy of those bytes. The console is only ever
 * served that copy, never the worker's path.
 */

/** The PNG file signature. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Signature (8) + IHDR length (4) + "IHDR" (4) + width (4) + height (4). */
const PNG_HEADER_BYTES = 24;

/** The largest screenshot accepted (and served). */
export const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;

export type ScreenshotValidation =
  | { ok: true; path: string; width: number; height: number; bytes: Uint8Array }
  | { ok: false; error: string };

function realpathOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    // A root that doesn't exist on this box simply isn't one.
    return null;
  }
}

/**
 * Directories a screenshot may live under: the real paths of os.tmpdir() and
 * /tmp, plus each entry of the colon-separated STANDUP_SCREENSHOT_ROOTS.
 */
export function allowedScreenshotRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates = [tmpdir(), "/tmp", ...(env.STANDUP_SCREENSHOT_ROOTS ?? "").split(":")];
  const roots = new Set<string>();
  for (const c of candidates) {
    const trimmed = c.trim();
    if (!trimmed || !isAbsolute(trimmed)) continue;
    const real = realpathOrNull(trimmed);
    if (real) roots.add(real);
  }
  return [...roots];
}

function isUnder(path: string, root: string): boolean {
  if (root === sep) return path.startsWith(sep);
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** This process's uid, or null where the platform has none. */
function currentUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

/**
 * Why a directory between a root and the screenshot can't be trusted — not
 * owned by `uid`, or writable by its group or others — or null.
 */
function untrustedDirectory(dir: string, uid: number | null): string | null {
  let st;
  try {
    st = statSync(dir);
  } catch {
    return `${dir} could not be read`;
  }
  if (!st.isDirectory()) return `${dir} is not a directory`;
  if (uid !== null && st.uid !== uid) return `${dir} is not owned by the collector's user`;
  if ((st.mode & 0o022) !== 0) return `${dir} is writable by its group or others`;
  return null;
}

/**
 * Checks that `path` is a screenshot the pipeline may record and returns its
 * bytes: an absolute `.png` path, not itself a symlink, whose real path is
 * under one of `roots` with every directory between the root and the file
 * owned by this user and not group/world-writable (the root itself, e.g.
 * sticky /tmp, is exempt). The file is opened once (O_NOFOLLOW) and its
 * owner, type, size (at most MAX_SCREENSHOT_BYTES), PNG signature and IHDR
 * dimensions (non-zero) are all checked on that descriptor, from the same
 * bytes that are returned.
 */
export function validateScreenshotPath(path: string, roots: string[] = allowedScreenshotRoots()): ScreenshotValidation {
  if (typeof path !== "string" || !path.trim()) return { ok: false, error: "path is empty" };
  if (!isAbsolute(path)) return { ok: false, error: `${path} is not an absolute path` };
  if (!path.toLowerCase().endsWith(".png")) return { ok: false, error: `${path} is not a .png file` };
  try {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) return { ok: false, error: `${path} is a symlink; name the file itself` };
    if (!entry.isFile()) return { ok: false, error: `${path} is not a regular file` };
  } catch {
    return { ok: false, error: `${path} does not exist` };
  }
  const real = realpathOrNull(path);
  if (!real) return { ok: false, error: `${path} does not exist` };
  if (!real.toLowerCase().endsWith(".png")) return { ok: false, error: `${path} resolves to ${real}, which is not a .png file` };
  // The deepest root holding the file: only the directories below it are checked.
  const root = [...roots].sort((a, b) => b.length - a.length).find((r) => isUnder(real, r) && real !== r);
  if (!root) return { ok: false, error: `${path} is outside the screenshot roots (${roots.join(", ") || "none"})` };

  const uid = currentUid();
  const between = relative(root, dirname(real)).split(sep).filter(Boolean);
  let dir = root;
  for (const part of between) {
    dir = join(dir, part);
    const problem = untrustedDirectory(dir, uid);
    if (problem) return { ok: false, error: `${path} can't be trusted: ${problem}` };
  }

  // O_NONBLOCK: a FIFO or device swapped in after the lstat must not hang the
  // open; the descriptor's own fstat then refuses anything but a regular file.
  let fd: number;
  try {
    fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return { ok: false, error: `${path} could not be opened` };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, error: `${path} is not a regular file` };
    if (uid !== null && st.uid !== uid) return { ok: false, error: `${path} is not owned by the collector's user` };
    if (st.size > MAX_SCREENSHOT_BYTES) {
      return { ok: false, error: `${path} is larger than ${MAX_SCREENSHOT_BYTES / (1024 * 1024)} MB` };
    }
    const bytes = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) {
      const n = readSync(fd, bytes, read, st.size - read, read);
      if (n <= 0) break;
      read += n;
    }
    if (read < PNG_HEADER_BYTES || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
      return { ok: false, error: `${path} is not a PNG image` };
    }
    if (bytes.toString("latin1", 12, 16) !== "IHDR") return { ok: false, error: `${path} has no PNG IHDR header` };
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width === 0 || height === 0) return { ok: false, error: `${path} has zero width or height` };
    return { ok: true, path: real, width, height, bytes: new Uint8Array(bytes.subarray(0, read)) };
  } catch {
    return { ok: false, error: `${path} could not be read` };
  } finally {
    closeSync(fd);
  }
}

/** Where the collector keeps its copies of recorded screenshots: `<dataDir>/pipeline-screenshots/`. */
export function pipelineScreenshotsDir(dataDir: string): string {
  return join(dataDir, "pipeline-screenshots");
}

/** The collector's own copies of accepted screenshots. */
export interface ScreenshotStore {
  /** Writes `bytes` as `<dir>/<runId>/<name>` (owner-only) and returns the stored path. */
  save: (runId: string, name: string, bytes: Uint8Array) => string;
  /** Where `save(runId, name, …)` puts its copy, or null when the ids aren't safe file names. */
  pathFor: (runId: string, name: string) => string | null;
  /** A stored copy's bytes, or null when `storedPath` isn't one of this store's files or can't be read. */
  read: (storedPath: string) => Uint8Array | null;
  /** Deletes a stored copy (a recorded advance that didn't commit). */
  remove: (storedPath: string) => void;
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A ScreenshotStore under `dir`: directories 0700, files 0600, written through a temp file and a rename. */
export function screenshotStore(dir: string): ScreenshotStore {
  const inside = (storedPath: string): string | null => {
    const base = realpathOrNull(dir);
    const real = realpathOrNull(storedPath);
    return base && real && isUnder(real, base) && real !== base ? real : null;
  };
  return {
    pathFor(runId, name) {
      return SAFE_NAME.test(runId) && SAFE_NAME.test(name) ? join(dir, runId, name) : null;
    },
    save(runId, name, bytes) {
      if (!SAFE_NAME.test(runId) || !SAFE_NAME.test(name)) throw new Error("invalid screenshot storage name");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      const runDir = join(dir, runId);
      mkdirSync(runDir, { recursive: true, mode: 0o700 });
      chmodSync(runDir, 0o700);
      const path = join(runDir, name);
      const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, bytes, { mode: 0o600, flag: "wx" });
      renameSync(tmp, path);
      return path;
    },
    read(storedPath) {
      const real = inside(storedPath);
      if (!real) return null;
      let fd: number;
      try {
        fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch {
        return null;
      }
      try {
        const st = fstatSync(fd);
        if (!st.isFile() || st.size > MAX_SCREENSHOT_BYTES) return null;
        const bytes = Buffer.alloc(st.size);
        let read = 0;
        while (read < st.size) {
          const n = readSync(fd, bytes, read, st.size - read, read);
          if (n <= 0) break;
          read += n;
        }
        return new Uint8Array(bytes.subarray(0, read));
      } catch {
        return null;
      } finally {
        closeSync(fd);
      }
    },
    remove(storedPath) {
      const real = inside(storedPath);
      if (real) rmSync(real, { force: true });
    },
  };
}
