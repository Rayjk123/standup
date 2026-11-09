import { createHash } from "crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { basename, isAbsolute, join, relative, resolve, sep } from "path";
import type { PersonaAttachmentMime, PersonaMediaMime } from "@standup/shared";
import { PERSONA_ATTACHMENT_MAX_BYTES, PERSONA_ATTACHMENTS_DIRNAME } from "@standup/shared";
import { activeOrgProfile } from "../org-profile/load.js";
import { ownerSecretsDir, ownerTokenPath, workerTokensDir } from "@standup/shared/owner-token";

/**
 * Validation and storage of the images Persona attaches to its replies.
 *
 * Persona names a file a worker produced on this host; the collector reads it
 * only after resolving its real path (symlinks followed) and refusing anything
 * under a secret-bearing location, accepts it only when its leading bytes are
 * a PNG, JPEG, GIF or WebP header, and keeps its own copy under the data dir,
 * named by its SHA-256. Clients are only ever served those copies, by
 * attachment id; the source path is never served or echoed back.
 *
 * The same directory holds the images and videos the owner uploads, and the
 * frames and model copies derived from them (persona/media.ts).
 */

/** Where the stored copies live: `<dataDir>/persona-attachments/`. */
export function attachmentsDir(dataDir: string): string {
  return join(dataDir, PERSONA_ATTACHMENTS_DIRNAME);
}

/** The stored copy's extension for each media type (an owner upload may be a video). */
const EXTENSIONS: Record<PersonaMediaMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

/** Bytes to keep as a stored copy, named by their SHA-256. */
export interface StorableMedia {
  bytes: Uint8Array;
  mimeType: PersonaMediaMime;
  sha256: string;
}

/** The image type `bytes` begin with, by magic number, or null for anything else. */
export function sniffImageMime(bytes: Uint8Array): PersonaAttachmentMime | null {
  const at = (i: number, ...want: number[]) => want.every((b, j) => bytes[i + j] === b);
  if (bytes.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (bytes.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (bytes.length >= 6 && (at(0, 0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || at(0, 0x47, 0x49, 0x46, 0x38, 0x39, 0x61))) {
    return "image/gif";
  }
  if (bytes.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

/** File extensions attach_image takes; the content still decides the type. */
export const IMAGE_EXTENSIONS: readonly string[] = ["png", "jpg", "jpeg", "gif", "webp"];

/**
 * Locations an attachment may never be read from: credentials and keys in the
 * owner's home (the org profile's single sign-on dirs among them, `ssoDirs`
 * by default the active profile's), kernel and device pseudo-filesystems,
 * and Standup's own secrets and configuration. Compared against the real
 * path, so a symlink into one of them is refused too.
 */
export function deniedRoots(opts: { home: string; dataDir: string; env?: NodeJS.ProcessEnv; ssoDirs?: readonly string[] }): string[] {
  const home = opts.home;
  const env = opts.env ?? process.env;
  const roots = [
    join(home, ".aws"),
    join(home, ".ssh"),
    ...(opts.ssoDirs ?? activeOrgProfile().sso.dirs).map((dir) => join(home, dir)),
    join(home, ".gnupg"),
    join(home, ".kube"),
    join(home, ".docker"),
    join(home, ".netrc"),
    join(home, ".config", "standup"),
    join(home, ".claude.json"),
    join(home, ".claude", ".credentials.json"),
    join(home, ".claude", "settings.json"),
    "/proc",
    "/sys",
    "/dev",
    "/etc",
    "/root",
    ownerSecretsDir(opts.dataDir),
    workerTokensDir(opts.dataDir),
    ownerTokenPath(env),
    ...dbPaths(opts.dataDir, env),
  ];
  // Each root as it resolves, too: a home or data dir reached through a symlink
  // still covers the real files under it.
  const out = new Set<string>();
  for (const r of roots) {
    out.add(resolve(r));
    try {
      out.add(realpathSync(r));
    } catch {
      // A root that doesn't exist can't hold the file either.
    }
  }
  return [...out];
}

function isWithin(path: string, root: string): boolean {
  if (path === root) return true;
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

/** The collector's database file: DB_PATH, else `<dataDir>/standup.db`. */
function dbPaths(dataDir: string, env: NodeJS.ProcessEnv): string[] {
  return [...new Set([resolve(join(dataDir, "standup.db")), ...(env.DB_PATH ? [resolve(env.DB_PATH)] : [])])];
}

/** Whether `path` names a DB file (the database itself, its WAL, shared memory or journal). */
function isDbFile(path: string, dbRoots: string[]): boolean {
  return dbRoots.some((db) => path === db || path === `${db}-wal` || path === `${db}-shm` || path === `${db}-journal`);
}

export class AttachmentError extends Error {}

export interface ReadImageOptions {
  home?: string;
  dataDir: string;
  maxBytes?: number;
  env?: NodeJS.ProcessEnv;
  /**
   * When set, the image must lie inside one of these directories (checked on
   * the path as given, as resolved and as opened); an empty list refuses
   * every path.
   */
  allowedRoots?: string[];
  /** The refusal for a path outside allowedRoots (default: Persona's). */
  notAllowedMessage?: string;
  /** Refuse a file with other hard links, which may name one outside allowedRoots. */
  refuseHardLinks?: boolean;
}

/** Each of `roots` as given and, where it exists, as resolved through its symlinks. */
function resolvedRoots(roots: string[]): string[] {
  const out = new Set<string>();
  for (const root of roots) {
    if (!root || !isAbsolute(root)) continue;
    out.add(resolve(root));
    try {
      out.add(realpathSync(root));
    } catch {
      // A root that no longer exists contains nothing.
    }
  }
  return [...out];
}

export interface ValidatedImage {
  bytes: Uint8Array;
  mimeType: PersonaAttachmentMime;
  sha256: string;
  /** The source file's base name. */
  name: string;
}

/** The refusal messages a caller of openSafeFile words for its own users. */
export interface SafeFileMessages {
  /** The path's extension is not one of `allowedExtensions`. */
  extension: string;
  /** The path is under a denied root or is a database file. */
  denied: string;
  /** The path is outside every `allowedRoots` entry. */
  notAllowed: string;
  /** The file is `size` bytes, over the `maxBytes` cap for its extension. */
  tooLarge: (path: string, size: string, max: string) => string;
  /**
   * When set, said in place of `denied`, `notAllowed` and a missing file, so
   * a refusal does not tell a file that exists from one that doesn't.
   */
  unavailable?: string;
}

export interface SafeFileOptions {
  home?: string;
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  /** As in ReadImageOptions: when set, the file must lie inside one of these. */
  allowedRoots?: string[];
  /** Lower-case extensions, without the dot, the path may end in. */
  allowedExtensions: readonly string[];
  /** The size cap, in bytes, for a file with extension `ext` (lower-case, no dot). */
  maxBytes: number | ((ext: string) => number);
  messages: SafeFileMessages;
  /** Refuse a file with more than one hard link (a link may name a file outside every allowed root). */
  refuseHardLinks?: boolean;
  /**
   * Directories refused beside deniedRoots(), except inside `except`: checked,
   * like the rest, on the path as given, as resolved and as opened.
   */
  denyWithin?: { roots: string[]; except: string[] };
}

export interface SafeFile {
  bytes: Uint8Array;
  /** The opened file's real path (symlinks resolved). */
  realPath: string;
  /** The path's extension, lower-case, without the dot. */
  ext: string;
}

/** An opened, checked file: the caller reads it through `fd` and must close it. */
export interface SafeFd {
  fd: number;
  /** Its size when checked (fstat), in bytes. */
  size: number;
  /** The opened file's real path (symlinks resolved). */
  realPath: string;
  /** The path's extension, lower-case, without the dot. */
  ext: string;
  /** The path as given, trimmed, for messages. */
  label: string;
}

/** The trailing `.ext` of `path`'s last segment, lower-case, or "" when it has none. */
function pathExtension(path: string): string {
  const match = /\.([^./]+)$/.exec(path);
  return match ? match[1]!.toLowerCase() : "";
}

/**
 * Reads the file at `rawPath` after the checks every agent-named file goes
 * through, or throws AttachmentError saying why it can't be read: `~/` expands
 * to `home` and the path must then be absolute; its extension must be allowed;
 * the path as given, as resolved and as opened must stay clear of
 * deniedRoots() and DB files (and inside `allowedRoots` when set); and it must
 * be a non-empty regular file within the size cap, checked before any byte is
 * read. The content is not interpreted here.
 */
export function openSafeFile(rawPath: string, opts: SafeFileOptions): SafeFile {
  const file = openSafeFd(rawPath, opts);
  try {
    const bytes = new Uint8Array(file.size);
    let read = 0;
    while (read < file.size) {
      const n = readSync(file.fd, bytes, read, file.size - read, read);
      if (n <= 0) break;
      read += n;
    }
    if (read !== file.size) throw new AttachmentError(`${file.label} changed while it was read`);
    return { bytes, realPath: file.realPath, ext: file.ext };
  } finally {
    closeSync(file.fd);
  }
}

/**
 * openSafeFile's checks, leaving the checked file open: the path as given is
 * checked before it is resolved (so a denied or out-of-root path is refused
 * whether or not it exists), then as resolved and as opened. The caller reads
 * the file through the returned descriptor and closes it.
 */
export function openSafeFd(rawPath: string, opts: SafeFileOptions): SafeFd {
  const home = opts.home ?? homedir();
  const trimmed = rawPath.trim();
  if (!trimmed) throw new AttachmentError("path is required");
  if (trimmed.includes("\0")) throw new AttachmentError("path is not a valid file path");
  const expanded = trimmed === "~" ? home : trimmed.startsWith("~/") ? join(home, trimmed.slice(2)) : trimmed;
  if (!isAbsolute(expanded)) throw new AttachmentError("path must be absolute (or start with ~/)");
  const ext = pathExtension(expanded);
  if (!ext || !opts.allowedExtensions.includes(ext)) throw new AttachmentError(opts.messages.extension);
  const maxBytes = typeof opts.maxBytes === "number" ? opts.maxBytes : opts.maxBytes(ext);
  const unavailable = opts.messages.unavailable;

  const roots = deniedRoots({ home, dataDir: opts.dataDir, env: opts.env });
  const dbRoots = dbPaths(opts.dataDir, opts.env ?? process.env);
  const allowed = opts.allowedRoots ? resolvedRoots(opts.allowedRoots) : undefined;
  const extraDenied = opts.denyWithin ? resolvedRoots(opts.denyWithin.roots) : [];
  const extraExcept = opts.denyWithin ? resolvedRoots(opts.denyWithin.except) : [];
  const refuse = (candidate: string) => {
    if (isDbFile(candidate, dbRoots) || roots.some((root) => isWithin(candidate, root))) {
      throw new AttachmentError(unavailable ?? opts.messages.denied);
    }
    if (extraDenied.some((root) => isWithin(candidate, root)) && !extraExcept.some((root) => isWithin(candidate, root))) {
      throw new AttachmentError(unavailable ?? opts.messages.denied);
    }
    if (allowed && !allowed.some((root) => isWithin(candidate, root))) {
      throw new AttachmentError(unavailable ?? opts.messages.notAllowed);
    }
  };
  const lexical = resolve(expanded);
  refuse(lexical);
  let real: string;
  try {
    real = realpathSync(lexical);
  } catch {
    throw new AttachmentError(unavailable ?? `no such file: ${trimmed}`);
  }
  refuse(real);

  // Open once and check the opened file, so the bytes read are the ones checked.
  let fd: number;
  try {
    fd = openSync(real, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  } catch (err) {
    throw new AttachmentError(`could not open ${trimmed}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
  }
  try {
    // The file actually opened, where the OS can say (a path swapped for a
    // symlink after the check above resolves elsewhere here).
    const opened = openedPath(fd);
    if (opened) refuse(opened);
    const st = fstatSync(fd);
    if (!st.isFile()) throw new AttachmentError(`${trimmed} is not a regular file`);
    if (opts.refuseHardLinks && st.nlink > 1) {
      throw new AttachmentError(`${trimmed} has other hard links; attach a file of its own (copy it, don't link it)`);
    }
    if (st.size === 0) throw new AttachmentError(`${trimmed} is empty`);
    if (st.size > maxBytes) {
      throw new AttachmentError(opts.messages.tooLarge(trimmed, formatBytes(st.size), formatBytes(maxBytes)));
    }
    return { fd, size: st.size, realPath: real, ext, label: trimmed };
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

const IMAGE_FILE_MESSAGES: SafeFileMessages = {
  extension: "only .png, .jpg, .jpeg, .gif and .webp images can be attached",
  denied: "refused: that path is under a location Standup never reads images from (credentials, system or Standup secrets)",
  notAllowed: "refused: this Persona attaches only images inside its own workers' worktrees or its own directory",
  tooLarge: (path, size, max) => `${path} is ${size}; images over ${max} can't be attached`,
};

/**
 * Reads the image at `rawPath` for an attachment, or throws AttachmentError
 * saying why it can't be attached. `~/` expands to the owner's home; the path
 * must then be absolute.
 */
export function readImageForAttachment(rawPath: string, opts: ReadImageOptions): ValidatedImage {
  const file = openSafeFile(rawPath, {
    home: opts.home,
    dataDir: opts.dataDir,
    env: opts.env,
    allowedRoots: opts.allowedRoots,
    refuseHardLinks: opts.refuseHardLinks,
    allowedExtensions: IMAGE_EXTENSIONS,
    maxBytes: opts.maxBytes ?? PERSONA_ATTACHMENT_MAX_BYTES,
    messages: opts.notAllowedMessage ? { ...IMAGE_FILE_MESSAGES, notAllowed: opts.notAllowedMessage } : IMAGE_FILE_MESSAGES,
  });
  const mimeType = sniffImageMime(file.bytes);
  if (!mimeType) throw new AttachmentError(`${rawPath.trim()} is not a PNG, JPEG, GIF or WebP image (checked by content)`);
  return { bytes: file.bytes, mimeType, sha256: createHash("sha256").update(file.bytes).digest("hex"), name: basename(file.realPath) };
}

/** The path the descriptor `fd` refers to, on Linux; undefined elsewhere. */
function openedPath(fd: number): string | undefined {
  try {
    return readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return undefined;
  }
}

export function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;
}

const SHA256 = /^[0-9a-f]{64}$/;

/** The stored copy's path for `sha256` of type `mimeType`. */
export function storedAttachmentPath(dataDir: string, sha256: string, mimeType: PersonaMediaMime): string {
  if (!SHA256.test(sha256)) throw new AttachmentError("invalid attachment digest");
  const ext = EXTENSIONS[mimeType];
  if (!ext) throw new AttachmentError("invalid attachment type");
  return join(attachmentsDir(dataDir), `${sha256}.${ext}`);
}

/**
 * Writes the stored copy of `image` (once: a copy already there is kept),
 * owner-only (dir 0700, file 0600), through a temp file and a rename so a
 * reader never sees a partial file.
 */
export function storeAttachmentCopy(dataDir: string, image: StorableMedia): string {
  const dir = attachmentsDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = storedAttachmentPath(dataDir, image.sha256, image.mimeType);
  try {
    const existing = readFileSync(path);
    if (createHash("sha256").update(existing).digest("hex") === image.sha256) return path;
  } catch {
    // Not stored yet.
  }
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, image.bytes, { mode: 0o600, flag: "wx" });
  renameSync(tmp, path);
  return path;
}

/** Stored copies whose digest was checked, by path, with the size, mtime and inode they had then. */
const verifiedCopies = new Map<string, string>();
/** Entries kept in verifiedCopies before it starts over. */
const VERIFIED_COPIES_MAX = 10_000;

/**
 * The stored copy's path and size once its bytes are known to match their
 * digest, or null when it is missing or doesn't match. The digest is checked
 * once per version of the file (size, mtime, inode), not on every call, so a
 * large video can be served range by range without rehashing it.
 */
export function verifiedStoredAttachment(
  dataDir: string,
  sha256: string,
  mimeType: PersonaMediaMime
): { path: string; size: number } | null {
  let path: string;
  try {
    path = storedAttachmentPath(dataDir, sha256, mimeType);
  } catch {
    return null;
  }
  let stamp: string;
  let size: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    size = st.size;
    stamp = `${st.size}:${st.mtimeMs}:${st.ino}`;
  } catch {
    return null;
  }
  if (verifiedCopies.get(path) !== stamp) {
    verifiedCopies.delete(path);
    if (!readStoredAttachment(dataDir, sha256, mimeType)) return null;
    if (verifiedCopies.size >= VERIFIED_COPIES_MAX) verifiedCopies.clear();
    verifiedCopies.set(path, stamp);
  }
  return { path, size };
}

/** The stored copy's bytes, or null when it is missing or no longer matches its digest. */
export function readStoredAttachment(dataDir: string, sha256: string, mimeType: PersonaMediaMime): Uint8Array | null {
  try {
    const bytes = readFileSync(storedAttachmentPath(dataDir, sha256, mimeType));
    return createHash("sha256").update(bytes).digest("hex") === sha256 ? new Uint8Array(bytes) : null;
  } catch {
    return null;
  }
}
