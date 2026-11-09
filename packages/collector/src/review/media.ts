import { createHash, randomUUID } from "crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "fs";
import { dirname, isAbsolute, join, resolve } from "path";
import type { PersonaAttachmentMime, ReviewMediaKind } from "@standup/shared";
import { PERSONA_ATTACHMENT_MAX_BYTES, REVIEW_VIDEO_MAX_BYTES } from "@standup/shared";
import { reviewMediaDir, reviewScratchRoot } from "@standup/shared/owner-token";
import { SCRATCH_ID } from "@standup/shared/scratch";
import { AttachmentError, IMAGE_EXTENSIONS, openSafeFd, sniffImageMime } from "../persona/attachments.js";
import type { SafeFd, SafeFileMessages } from "../persona/attachments.js";
import { hasScratchMarker } from "../scratch-dirs.js";

/**
 * Validation and storage of the screenshots and screen recordings a worker
 * attaches to a review packet.
 *
 * The worker names a file on this host; it goes through the same path checks
 * as Persona's attach_image (openSafeFd: denied roots and allowed roots
 * checked on the path as given, as resolved and as opened, size capped before
 * reading), must not be hard-linked elsewhere, and is accepted only when its
 * content is a PNG, JPEG, GIF, WebP, WebM or MP4 whose family agrees with its
 * extension. The collector keeps its own copy under `<dataDir>/review-media/`,
 * named by SHA-256 and written by streaming the opened file through the hash,
 * so the digest names exactly the bytes stored; only those copies are served.
 * Workers save media in their launch's own scratch dir (its TMPDIR,
 * launchScratchMediaDir), in the worktree Standup made for the launch
 * (reviewMediaWorktree), or in the launch's review scratch dir,
 * `<dataDir>/review-scratch/<launchId>/`, which the collector creates.
 */

export type ReviewVideoMime = "video/webm" | "video/mp4";
export type ReviewMediaMime = PersonaAttachmentMime | ReviewVideoMime;

export const REVIEW_MEDIA_MIMES: readonly ReviewMediaMime[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "video/webm",
  "video/mp4",
];

const MIME_EXTENSIONS: Record<ReviewMediaMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/webm": "webm",
  "video/mp4": "mp4",
};

/** The stored-copy file extension for `mime`. */
export function extForReviewMime(mime: ReviewMediaMime): string {
  return MIME_EXTENSIONS[mime];
}

export function isReviewMediaMime(value: unknown): value is ReviewMediaMime {
  return typeof value === "string" && (REVIEW_MEDIA_MIMES as readonly string[]).includes(value);
}

/** Video extensions, each with the only container its content may be. */
const VIDEO_EXTENSIONS: Record<string, ReviewVideoMime> = {
  webm: "video/webm",
  mp4: "video/mp4",
  m4v: "video/mp4",
};

const REVIEW_EXTENSIONS: readonly string[] = [...IMAGE_EXTENSIONS, ...Object.keys(VIDEO_EXTENSIONS)];

/** MP4-family brands taken as a playable MP4 (`M4V ` carries a trailing space). */
const MP4_BRANDS = new Set(["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "dash", "M4V ", "mmp4"]);

/** How far into the EBML header the DocType element is looked for. */
const EBML_SCAN_BYTES = 64;

/** How many leading bytes are read to tell the file's type before any of it is copied. */
const SNIFF_BYTES = 4096;

/** The chunk size files are hashed, copied and served in. */
const CHUNK_BYTES = 1024 * 1024;

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

/** The length in bytes of the EBML variable-size integer starting with `first`, or 0 when invalid. */
function vintLength(first: number): number {
  for (let len = 1; len <= 8; len++) {
    if (first & (0x80 >> (len - 1))) return len;
  }
  return 0;
}

function isWebm(bytes: Uint8Array): boolean {
  if (bytes.length < 4 || bytes[0] !== 0x1a || bytes[1] !== 0x45 || bytes[2] !== 0xdf || bytes[3] !== 0xa3) return false;
  const end = Math.min(bytes.length, 4 + EBML_SCAN_BYTES);
  for (let i = 4; i + 2 < end; i++) {
    if (bytes[i] !== 0x42 || bytes[i + 1] !== 0x82) continue;
    const sizeAt = i + 2;
    const len = vintLength(bytes[sizeAt]!);
    if (!len || sizeAt + len > bytes.length) continue;
    let size = bytes[sizeAt]! & (0xff >> len);
    for (let j = 1; j < len; j++) size = size * 256 + bytes[sizeAt + j]!;
    const valueAt = sizeAt + len;
    if (size < 1 || size > 32 || valueAt + size > bytes.length) continue;
    // A DocType string may be NUL-padded.
    return ascii(bytes, valueAt, valueAt + size).replace(/\0+$/, "") === "webm";
  }
  return false;
}

function isMp4(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || ascii(bytes, 4, 8) !== "ftyp") return false;
  const boxSize = ((bytes[0]! << 24) >>> 0) + (bytes[1]! << 16) + (bytes[2]! << 8) + bytes[3]!;
  if (boxSize < 16 || boxSize > bytes.length) return false;
  if (MP4_BRANDS.has(ascii(bytes, 8, 12))) return true;
  for (let at = 16; at + 4 <= boxSize; at += 4) {
    if (MP4_BRANDS.has(ascii(bytes, at, at + 4))) return true;
  }
  return false;
}

/** The video container `bytes` hold, by header, or null for anything else (Matroska included). */
export function sniffVideoMime(bytes: Uint8Array): ReviewVideoMime | null {
  if (isWebm(bytes)) return "video/webm";
  if (isMp4(bytes)) return "video/mp4";
  return null;
}

/** The media type `bytes` hold, by content; SVG and every other format is null. */
export function sniffReviewMediaMime(bytes: Uint8Array): { mime: ReviewMediaMime; kind: ReviewMediaKind } | null {
  const image = sniffImageMime(bytes);
  if (image) return { mime: image, kind: "image" };
  const video = sniffVideoMime(bytes);
  if (video) return { mime: video, kind: "video" };
  return null;
}

export class ReviewMediaError extends AttachmentError {}

export interface ReadReviewMediaOptions {
  home?: string;
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  /** When set, the file must lie inside one of these directories; an empty list refuses every path. */
  allowedRoots?: string[];
  /**
   * The only directories inside `dataDir` a file may come from (the launch's
   * own scratch dir, its own worktree when that lies in the data dir); the
   * rest of the data dir is refused whatever `allowedRoots` says.
   */
  dataDirExcept?: string[];
  imageMaxBytes?: number;
  videoMaxBytes?: number;
}

export interface ValidatedReviewMedia {
  mime: ReviewMediaMime;
  kind: ReviewMediaKind;
  sha256: string;
  size: number;
}

/** A validated file copied to a temp file in the stored-copy dir, not yet in place. */
export interface StagedReviewMedia extends ValidatedReviewMedia {
  tmpPath: string;
}

/**
 * The one refusal for a path that is missing, denied or outside the allowed
 * roots, so a refusal never tells which (or whether the file exists).
 */
export const REVIEW_MEDIA_UNAVAILABLE =
  "refused: no such file, or not one review media may be read from; save screenshots and recordings only where the review brief says";

const REVIEW_FILE_MESSAGES: SafeFileMessages = {
  extension: "only .png, .jpg, .jpeg, .gif, .webp images and .webm, .mp4, .m4v videos can be attached to a review",
  denied: REVIEW_MEDIA_UNAVAILABLE,
  notAllowed: REVIEW_MEDIA_UNAVAILABLE,
  unavailable: REVIEW_MEDIA_UNAVAILABLE,
  tooLarge: (path, size, max) => `${path} is ${size}; files of its type over ${max} can't be attached to a review`,
};

/** Opens the file at `rawPath` after every review media path check, or throws ReviewMediaError. */
function openReviewMedia(rawPath: string, opts: ReadReviewMediaOptions): SafeFd {
  const imageMax = opts.imageMaxBytes ?? PERSONA_ATTACHMENT_MAX_BYTES;
  const videoMax = opts.videoMaxBytes ?? REVIEW_VIDEO_MAX_BYTES;
  try {
    return openSafeFd(rawPath, {
      home: opts.home,
      dataDir: opts.dataDir,
      env: opts.env,
      allowedRoots: opts.allowedRoots,
      allowedExtensions: REVIEW_EXTENSIONS,
      maxBytes: (ext) => (ext in VIDEO_EXTENSIONS ? videoMax : imageMax),
      messages: REVIEW_FILE_MESSAGES,
      refuseHardLinks: true,
      denyWithin: { roots: [opts.dataDir], except: opts.dataDirExcept ?? [] },
    });
  } catch (err) {
    if (err instanceof AttachmentError && !(err instanceof ReviewMediaError)) throw new ReviewMediaError(err.message);
    throw err;
  }
}

/** Reads up to `length` bytes of `fd` at `position` into a fresh buffer; shorter at the end of the file. */
function readAt(fd: number, length: number, position: number): Uint8Array {
  const buf = new Uint8Array(length);
  let got = 0;
  while (got < length) {
    const n = readSync(fd, buf, got, length - got, position + got);
    if (n <= 0) break;
    got += n;
  }
  return got === length ? buf : buf.subarray(0, got);
}

/**
 * Checks the opened file's content type and hashes it chunk by chunk, handing
 * each chunk to `sink` (after the type check passes); throws ReviewMediaError
 * when the type is wrong or the file's size changes while it is read.
 */
function digestReviewMedia(file: SafeFd, sink?: (chunk: Uint8Array) => void): ValidatedReviewMedia {
  const head = readAt(file.fd, Math.min(file.size, SNIFF_BYTES), 0);
  const sniffed = sniffReviewMediaMime(head);
  if (!sniffed) throw new ReviewMediaError(`${file.label} is not a PNG, JPEG, GIF, WebP, WebM or MP4 file (checked by content)`);
  const videoMime = VIDEO_EXTENSIONS[file.ext];
  if (videoMime ? sniffed.mime !== videoMime : sniffed.kind !== "image") {
    throw new ReviewMediaError(`${file.label} does not hold what its .${file.ext} extension says (checked by content)`);
  }
  const hash = createHash("sha256");
  let read = 0;
  let chunk = head;
  while (chunk.length > 0) {
    hash.update(chunk);
    sink?.(chunk);
    read += chunk.length;
    if (read > file.size) break;
    // One byte past the checked size is asked for, so a file that grew is caught.
    chunk = readAt(file.fd, Math.min(CHUNK_BYTES, file.size + 1 - read), read);
  }
  if (read !== file.size) throw new ReviewMediaError(`${file.label} changed while it was read`);
  return { mime: sniffed.mime, kind: sniffed.kind, sha256: hash.digest("hex"), size: read };
}

/**
 * The size of the review media file at `rawPath`, after every path check and
 * before any of it is read; throws ReviewMediaError saying why it can't be attached.
 */
export function statMediaForReview(rawPath: string, opts: ReadReviewMediaOptions): number {
  const file = openReviewMedia(rawPath, opts);
  closeSync(file.fd);
  return file.size;
}

/**
 * Checks the image or video at `rawPath` for a review packet and returns its
 * type, digest and size, or throws ReviewMediaError (an AttachmentError)
 * saying why it can't be attached. Nothing is kept in memory but one chunk.
 */
export function readMediaForReview(rawPath: string, opts: ReadReviewMediaOptions): ValidatedReviewMedia {
  const file = openReviewMedia(rawPath, opts);
  try {
    return digestReviewMedia(file);
  } finally {
    closeSync(file.fd);
  }
}

export { reviewMediaDir, reviewScratchRoot };

/** A launch id safe to name a directory with: letters, digits, `.`, `_`, `-`, not starting with a dot. */
const SAFE_LAUNCH_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

/** The launch's review scratch dir, `<dataDir>/review-scratch/<launchId>`; throws for an unsafe id. */
export function reviewScratchDir(dataDir: string, launchId: string): string {
  if (!SAFE_LAUNCH_ID.test(launchId)) throw new ReviewMediaError("refused: the launch id can't name a scratch dir");
  const root = reviewScratchRoot(dataDir);
  const dir = join(root, launchId);
  if (dirname(resolve(dir)) !== resolve(root)) throw new ReviewMediaError("refused: the launch id can't name a scratch dir");
  return dir;
}

/** Whether `path` is a real directory (not a symlink) owned by this process's user. */
export function isOwnDirectory(path: string): boolean {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
    return typeof process.getuid !== "function" || st.uid === process.getuid();
  } catch {
    return false;
  }
}

/** `path` through its symlinks; null when it doesn't exist. */
function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * The launch's own scratch dir, `<root>/<scratchId>` (its TMPDIR, see
 * @standup/shared/scratch), when review media may be read from it: a real
 * directory of this user's (not a symlink), whose real path is that same
 * place below the root's real path, carrying the marker that names
 * `scratchId`. Undefined otherwise, so a scratch dir re-pointed at another
 * launch's, or anywhere else, is never an allowed root.
 */
export function launchScratchMediaDir(root: string, scratchId: string): string | undefined {
  if (!SCRATCH_ID.test(scratchId) || !isAbsolute(root)) return undefined;
  const dir = join(resolve(root), scratchId);
  if (!isOwnDirectory(dir)) return undefined;
  const realRoot = realOrNull(root);
  if (!realRoot || realOrNull(dir) !== join(realRoot, scratchId)) return undefined;
  return hasScratchMarker(dir, scratchId) ? dir : undefined;
}

/**
 * Creates `dir` (its parent must exist) owner-only, or accepts it when it is
 * already a real directory of this user's; throws ReviewMediaError when it is
 * a symlink, not a directory, or someone else's, so nothing is written
 * through it.
 */
export function ensureOwnDirectory(dir: string): void {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new ReviewMediaError(`refused: ${dir} could not be created (${(err as NodeJS.ErrnoException).code ?? "error"})`);
    }
  }
  if (!isOwnDirectory(dir)) throw new ReviewMediaError(`refused: ${dir} is not a directory of the collector's own`);
  chmodSync(dir, 0o700);
}

/** The stored-copy dir, created owner-only when missing; throws ReviewMediaError when it isn't the collector's own. */
export function ensureReviewMediaDir(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const dir = reviewMediaDir(dataDir);
  ensureOwnDirectory(dir);
  return dir;
}

/**
 * The launch's review scratch dir, created owner-only (with its parent) when
 * missing; throws ReviewMediaError for an unsafe launch id or a dir on the
 * way that isn't the collector's own.
 */
export function ensureReviewScratchDir(dataDir: string, launchId: string): string {
  const dir = reviewScratchDir(dataDir, launchId);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  ensureOwnDirectory(reviewScratchRoot(dataDir));
  ensureOwnDirectory(dir);
  return dir;
}

/** ensureReviewScratchDir, or undefined (logged) when the dir can't be made. */
export function reviewScratchDirFor(dataDir: string, launchId: string): string | undefined {
  try {
    return ensureReviewScratchDir(dataDir, launchId);
  } catch (err) {
    console.error(`[review] no scratch dir for launch ${launchId}:`, (err as Error).message);
    return undefined;
  }
}

const SHA256 = /^[0-9a-f]{64}$/;

/** The stored copy's path for `sha256` of type `mime`, built only from those two once validated. */
export function storedReviewMediaPath(dataDir: string, sha256: string, mime: string): string {
  if (!SHA256.test(sha256)) throw new ReviewMediaError("invalid review media digest");
  if (!isReviewMediaMime(mime)) throw new ReviewMediaError("unsupported review media type");
  const dir = reviewMediaDir(dataDir);
  const path = join(dir, `${sha256}.${MIME_EXTENSIONS[mime]}`);
  if (dirname(resolve(path)) !== resolve(dir)) throw new ReviewMediaError("invalid review media path");
  return path;
}

/**
 * Checks the file at `rawPath` and copies it, through the hash, to a fresh
 * owner-only temp file in the stored-copy dir; throws ReviewMediaError (and
 * leaves no temp file) when it can't be attached. commitStagedReviewMedia puts
 * the copy in place; discardStagedReviewMedia drops it.
 */
export function stageReviewMedia(rawPath: string, opts: ReadReviewMediaOptions): StagedReviewMedia {
  const dir = ensureReviewMediaDir(opts.dataDir);
  const file = openReviewMedia(rawPath, opts);
  const tmpPath = join(dir, `.staging-${randomUUID()}.tmp`);
  let out: number | undefined;
  try {
    out = openSync(
      tmpPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
      0o600
    );
    const target = out;
    const media = digestReviewMedia(file, (chunk) => {
      let written = 0;
      while (written < chunk.length) written += writeSync(target, chunk, written, chunk.length - written);
    });
    closeSync(out);
    out = undefined;
    return { ...media, tmpPath };
  } catch (err) {
    if (out !== undefined) closeSync(out);
    rmSync(tmpPath, { force: true });
    throw err;
  } finally {
    closeSync(file.fd);
  }
}

/**
 * Moves a staged copy into place under its digest, replacing whatever is
 * there (a tampered copy or a symlink is replaced, not followed); returns
 * its path.
 */
export function commitStagedReviewMedia(dataDir: string, staged: StagedReviewMedia): string {
  const dir = reviewMediaDir(dataDir);
  if (!isOwnDirectory(dir)) throw new ReviewMediaError(`refused: ${dir} is not a directory of the collector's own`);
  const path = storedReviewMediaPath(dataDir, staged.sha256, staged.mime);
  if (dirname(resolve(staged.tmpPath)) !== resolve(dir)) throw new ReviewMediaError("invalid staged review media path");
  renameSync(staged.tmpPath, path);
  return path;
}

/** Drops a staged copy that won't be committed. */
export function discardStagedReviewMedia(staged: StagedReviewMedia): void {
  rmSync(staged.tmpPath, { force: true });
}

/** Checks and stores the file at `rawPath` in one step (stageReviewMedia, then commitStagedReviewMedia). */
export function storeReviewMediaCopy(rawPath: string, opts: ReadReviewMediaOptions): { path: string; media: ValidatedReviewMedia } {
  const staged = stageReviewMedia(rawPath, opts);
  try {
    const path = commitStagedReviewMedia(opts.dataDir, staged);
    const { tmpPath: _tmp, ...media } = staged;
    return { path, media };
  } catch (err) {
    discardStagedReviewMedia(staged);
    throw err;
  }
}

/**
 * The stored copy opened for serving, or null when it is missing, its dir or
 * the file is a symlink, it is not a regular file, or its size isn't
 * `expectedSize` (the digest was checked when it was stored). The caller
 * reads it through `fd` and closes it.
 */
export function openStoredReviewMedia(
  dataDir: string,
  sha256: string,
  mime: string,
  expectedSize: number
): { fd: number; size: number } | null {
  let path: string;
  try {
    path = storedReviewMediaPath(dataDir, sha256, mime);
  } catch {
    return null;
  }
  if (!isOwnDirectory(reviewMediaDir(dataDir))) return null;
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (st.isFile() && st.size === expectedSize) return { fd, size: st.size };
  } catch {
    // Unreadable: treated as missing.
  }
  closeSync(fd);
  return null;
}

/**
 * How long a media stream may sit unread before its file is closed: long
 * enough for a paused or slowly buffering playback (a phone on a poor link)
 * to resume reading the same response.
 */
export const REVIEW_MEDIA_STREAM_IDLE_MS = 15 * 60 * 1000;

/** An open stored copy a stream reads, closed exactly once. */
interface StreamFile {
  fd: number;
  closed: boolean;
}

function closeStreamFile(file: StreamFile): void {
  if (file.closed) return;
  file.closed = true;
  try {
    closeSync(file.fd);
  } catch {
    // Already gone.
  }
}

/** Closes the file of a stream that was dropped unread and collected. */
const abandonedStreams = new FinalizationRegistry<StreamFile>(closeStreamFile);

/**
 * The idle timer's work: close the file and fail the stream if it is still
 * around. It holds the stream's controller only weakly, so a pending timer
 * never keeps a dropped stream (and its finalizer) from being collected.
 */
function expireStream(file: StreamFile, controller: WeakRef<ReadableStreamDefaultController<Uint8Array>>): void {
  if (file.closed) return;
  closeStreamFile(file);
  try {
    controller.deref()?.error(new Error("the media stream sat unread too long"));
  } catch {
    // Already closed.
  }
}

/**
 * Bytes `start`..`end` (inclusive) of the open file `fd`, read a chunk at a
 * time as the response is consumed. `fd` is closed when the stream ends,
 * fails or is cancelled; as a backstop for a response whose body is dropped
 * without either (a HEAD answered from a GET, a client gone mid-read), also
 * when the stream has gone `idleMs` without a read, or is garbage-collected.
 */
export function reviewMediaStream(
  fd: number,
  start: number,
  end: number,
  idleMs: number = REVIEW_MEDIA_STREAM_IDLE_MS
): ReadableStream<Uint8Array> {
  let position = start;
  const file: StreamFile = { fd, closed: false };
  let idle: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    if (idle) clearTimeout(idle);
    idle = undefined;
    closeStreamFile(file);
  };
  const armIdle = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(expireStream, idleMs, file, new WeakRef(controller));
    idle.unref?.();
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      armIdle(controller);
    },
    pull(controller) {
      // A pull is the reader draining the queue: the stream is in use.
      armIdle(controller);
      try {
        if (file.closed) {
          controller.error(new Error("the media stream was closed"));
          return;
        }
        if (position > end) {
          close();
          controller.close();
          return;
        }
        const chunk = readAt(fd, Math.min(CHUNK_BYTES, end - position + 1), position);
        if (chunk.length === 0) {
          close();
          controller.close();
          return;
        }
        position += chunk.length;
        controller.enqueue(chunk);
        armIdle(controller);
      } catch (err) {
        close();
        controller.error(err);
      }
    },
    cancel() {
      close();
    },
  });
  abandonedStreams.register(stream, file);
  return stream;
}

/**
 * Removes the stored copy `sha256` of type `mime`, only when the stored-copy
 * dir is a real directory of the collector's own. The caller removes only a
 * copy no media row names any more (countReviewMediaRefs).
 */
export function deleteStoredReviewMedia(dataDir: string, sha256: string, mime: string): void {
  // Nothing is removed through a stored-copy dir that is a symlink or not the collector's own.
  if (!isOwnDirectory(reviewMediaDir(dataDir))) return;
  try {
    rmSync(storedReviewMediaPath(dataDir, sha256, mime), { force: true });
  } catch {
    // An invalid digest or type names no stored copy.
  }
}
