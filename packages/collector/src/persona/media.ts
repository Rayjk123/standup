import { createHash } from "crypto";
import { accessSync, constants as fsConstants, rmSync, statSync } from "fs";
import { basename, isAbsolute } from "path";
import type { PersonaAttachmentMime, PersonaMediaMime, PersonaVideoMime } from "@standup/shared";
import {
  PERSONA_ATTACHMENT_MAX_BYTES,
  PERSONA_VIDEO_FRAMES,
  PERSONA_VIDEO_MAX_BYTES,
  isPersonaVideoMime,
} from "@standup/shared";
import type { Database } from "bun:sqlite";
import type { PersonaAttachmentMedia, PersonaDerivedImage, PersonaVideoFrame } from "@standup/store";
import { isPersonaAttachmentFileReferenced, pruneStaleOwnerUploads, pruneStaleTurnAttachments } from "@standup/store";
import { sniffVideoMime } from "../review/media.js";
import type { ReviewVideoMime } from "../review/media.js";
import { AttachmentError, openSafeFile, sniffImageMime, storeAttachmentCopy, storedAttachmentPath } from "./attachments.js";
import type { ReadImageOptions, SafeFileMessages } from "./attachments.js";

/**
 * Validation of the images and videos the owner sends Persona, and what the
 * collector derives from them at upload time; and of the videos Persona
 * attaches to its replies (attach_video), with their poster frames.
 *
 * The content decides the type: PNG, JPEG, GIF and WebP images by magic
 * number, MP4, MOV and WebM videos by container header. A declared type that
 * disagrees with the content is refused, as is anything else (SVG, HTML,
 * archives). A video's still frames, its duration, and a re-encoded JPEG model
 * copy of every image come from ffmpeg, run on the stored copy with an argv
 * (never a shell), a forced demuxer, one thread, a decode pixel limit, a
 * timeout, bounded output, and at most FFMPEG_CONCURRENCY runs host-wide.
 * Without ffmpeg an upload is still accepted and says what Persona can't see
 * of it.
 */

/** Longest upload name kept, in characters. */
export const MAX_UPLOAD_NAME_CHARS = 120;

/**
 * Largest image shown to the model as-is: the API refuses an image whose
 * base64 exceeds 5 MB, which is 3.75 MiB of raw bytes.
 */
export const MODEL_IMAGE_MAX_BYTES = 3.75 * 1024 * 1024;
/**
 * Longest side, in pixels, of an original shown to the model without a
 * re-encoded copy: a request with many images refuses any image over 2000 px.
 */
export const ORIGINAL_IMAGE_MAX_SIDE = 2000;
/** Longest edge of the re-encoded JPEG model copy every owner image gets when ffmpeg is available. */
export const MODEL_COPY_LONG_EDGE = 1568;
/** Longest side, in pixels, of an image ffmpeg is asked to decode; larger is refused from its header. */
export const MAX_DECODE_SIDE = 16384;
/** The pixel count ffmpeg's decoders are held to (`-max_pixels`); an image whose header says more is refused. */
export const MAX_DECODE_PIXELS = 8192 * 6144;
/** Longest side of a still frame extracted from a video. */
export const VIDEO_FRAME_MAX_SIDE = 1024;
/** How long one ffmpeg run may take before it is killed (time queued for a slot not counted). */
export const FFMPEG_TIMEOUT_MS = 20_000;
/** ffmpeg processes the host runs at once; further runs wait for a slot. */
export const FFMPEG_CONCURRENCY = 2;
/** Most bytes one ffmpeg run may write to stdout (one JPEG). */
const FFMPEG_MAX_STDOUT = 8 * 1024 * 1024;
/** Most stderr kept from one ffmpeg run. */
const FFMPEG_MAX_STDERR = 64 * 1024;

export const FFMPEG_MISSING_NOTE =
  "ffmpeg is not available on the collector host, so Persona can't see frames from this video (install ffmpeg on PATH or set STANDUP_FFMPEG)";
export const IMAGE_TOO_LARGE_NOTE =
  "too large to show Persona without ffmpeg on the collector host (install ffmpeg on PATH or set STANDUP_FFMPEG)";
export const IMAGE_UNKNOWN_SIZE_NOTE =
  "its size couldn't be read from its header, so Persona can't be shown it without ffmpeg on the collector host (install ffmpeg on PATH or set STANDUP_FFMPEG)";
const NO_DURATION_NOTE = "ffmpeg couldn't read this video's length, so Persona sees only its first frame";

const ACCEPTED_TYPES = "PNG, JPEG, GIF, WebP, MP4, MOV or WebM";

const DESCRIPTIONS: Record<PersonaMediaMime, string> = {
  "image/png": "a PNG image",
  "image/jpeg": "a JPEG image",
  "image/gif": "a GIF image",
  "image/webp": "a WebP image",
  "video/mp4": "an MP4 video",
  "video/quicktime": "a MOV video",
  "video/webm": "a WebM video",
};

/** Declared types that name the same format as a canonical one. */
const MIME_ALIASES: Record<string, string> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "video/x-m4v": "video/mp4",
};

/** MP4 and MOV are both ISO-BMFF; senders label one as the other freely. */
const ISO_BMFF: ReadonlySet<string> = new Set(["video/mp4", "video/quicktime"]);

/** Characters dropped from an upload name: controls, format characters, line and paragraph separators. */
const NAME_STRIPPED = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

/**
 * The video container `bytes` hold, by header: WebM and MP4 as review media
 * sniffs them, and an ISO-BMFF file whose major brand is QuickTime's (`qt  `)
 * as MOV. Null for anything else.
 */
export function sniffOwnerVideoMime(bytes: Uint8Array): PersonaVideoMime | null {
  if (bytes.length >= 16 && ascii(bytes, 4, 8) === "ftyp" && ascii(bytes, 8, 12) === "qt  ") {
    const boxSize = be32(bytes, 0);
    if (boxSize >= 16 && boxSize <= bytes.length) return "video/quicktime";
  }
  return sniffVideoMime(bytes);
}

/** The media type `bytes` hold, by content, or null when it is none the owner may send. */
export function sniffOwnerMediaMime(bytes: Uint8Array): PersonaMediaMime | null {
  return sniffImageMime(bytes) ?? sniffOwnerVideoMime(bytes);
}

/** An ISO-BMFF box: its type and where its content lies in the buffer. */
interface Mp4Box {
  type: string;
  start: number;
  end: number;
}

/** Most boxes read at one level of an MP4; a real file has a handful. */
const MP4_MAX_BOXES = 4096;

/**
 * The boxes laid end to end in `b[from, to)`, at most MP4_MAX_BOXES. A 64-bit
 * size and a size of 0 (to the end) are followed; a box running past `to`
 * ends the walk.
 */
function mp4Boxes(b: Uint8Array, from: number, to: number): Mp4Box[] {
  const out: Mp4Box[] = [];
  let at = from;
  while (at + 8 <= to && out.length < MP4_MAX_BOXES) {
    let size = be32(b, at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > to) break;
      size = be32(b, at + 8) * 2 ** 32 + be32(b, at + 12);
      header = 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < header || at + size > to) break;
    out.push({ type: ascii(b, at + 4, at + 8), start: at + header, end: at + size });
    at += size;
  }
  return out;
}

function mp4Child(b: Uint8Array, box: Mp4Box | undefined, type: string): Mp4Box | undefined {
  return box ? mp4Boxes(b, box.start, box.end).find((c) => c.type === type) : undefined;
}

/**
 * The sample-entry codes (`avc1`, `hvc1`, `av01`, …) of an MP4's video
 * tracks: each `moov/trak` whose media header is a video one (`vmhd`), read
 * from its `stsd`. Empty when the file has no `moov` or no video track.
 */
export function mp4VideoCodecs(b: Uint8Array): string[] {
  const moov = mp4Boxes(b, 0, b.length).find((box) => box.type === "moov");
  if (!moov) return [];
  const codecs: string[] = [];
  for (const trak of mp4Boxes(b, moov.start, moov.end).filter((box) => box.type === "trak")) {
    const minf = mp4Child(b, mp4Child(b, trak, "mdia"), "minf");
    if (!mp4Child(b, minf, "vmhd")) continue;
    const stsd = mp4Child(b, mp4Child(b, minf, "stbl"), "stsd");
    // A full box: version and flags, then the entry count, then the entries.
    if (stsd && stsd.start + 8 <= stsd.end) {
      for (const entry of mp4Boxes(b, stsd.start + 8, stsd.end)) codecs.push(entry.type);
    }
  }
  return codecs;
}

/** H.264 sample entries: parameter sets in the entry (`avc1`) or in the stream (`avc3`). */
const H264_CODECS: ReadonlySet<string> = new Set(["avc1", "avc3"]);

/** The extensions attach_video takes, each with the only container its content may be. */
const ATTACH_VIDEO_EXTENSIONS: Record<string, ReviewVideoMime> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
};

const ATTACH_VIDEO_DESCRIPTIONS: Record<ReviewVideoMime, string> = {
  "video/mp4": "an MP4 (H.264)",
  "video/webm": "a WebM",
};

const VIDEO_FILE_MESSAGES: SafeFileMessages = {
  extension: "only .mp4, .m4v and .webm videos can be attached",
  denied: "refused: that path is under a location Persona may not attach from (credentials, system or Standup secrets)",
  notAllowed: "refused: this Persona attaches only videos inside its own workers' worktrees or its own directory",
  tooLarge: (path, size, max) => `${path} is ${size}; videos over ${max} can't be attached`,
};

/** A video attach_video accepted: its bytes, type by content, digest and source base name. */
export interface ValidatedVideo {
  bytes: Uint8Array;
  mimeType: ReviewVideoMime;
  sha256: string;
  name: string;
}

/**
 * Reads the video at `rawPath` for attach_video, or throws AttachmentError
 * saying why it can't be attached: the path checks every agent-named file
 * goes through (openSafeFile, the cap `opts.maxBytes`, by default
 * PERSONA_VIDEO_MAX_BYTES), then its content must be an MP4 whose video
 * track is H.264, or a WebM, and agree with its extension.
 */
export function readVideoForAttachment(rawPath: string, opts: ReadImageOptions): ValidatedVideo {
  const file = openSafeFile(rawPath, {
    home: opts.home,
    dataDir: opts.dataDir,
    env: opts.env,
    allowedRoots: opts.allowedRoots,
    allowedExtensions: Object.keys(ATTACH_VIDEO_EXTENSIONS),
    maxBytes: opts.maxBytes ?? PERSONA_VIDEO_MAX_BYTES,
    messages: VIDEO_FILE_MESSAGES,
  });
  const label = rawPath.trim();
  const mimeType = sniffVideoMime(file.bytes);
  if (!mimeType) throw new AttachmentError(`${label} is not an MP4 or WebM video (checked by content)`);
  if (ATTACH_VIDEO_EXTENSIONS[file.ext] !== mimeType) {
    throw new AttachmentError(`${label} is named .${file.ext} but its content is ${ATTACH_VIDEO_DESCRIPTIONS[mimeType]} video`);
  }
  if (mimeType === "video/mp4") {
    // Every video track must be H.264: a browser may play any of them.
    const codecs = mp4VideoCodecs(file.bytes);
    if (codecs.length === 0) throw new AttachmentError(`${label} has no video track that can be read (checked by content)`);
    const other = [...new Set(codecs.filter((c) => !H264_CODECS.has(c)))];
    if (other.length > 0) {
      const named = other.map((c) => c.replace(/[^\w ]/g, "?")).join(", ");
      throw new AttachmentError(`${label} has ${named} video; only H.264 MP4s (or WebM) play in every browser — re-encode it`);
    }
  }
  return { bytes: file.bytes, mimeType, sha256: createHash("sha256").update(file.bytes).digest("hex"), name: basename(file.realPath) };
}

export interface ImageDimensions {
  width: number;
  height: number;
}

function be16(b: Uint8Array, i: number): number {
  return (b[i]! << 8) | b[i + 1]!;
}
function le16(b: Uint8Array, i: number): number {
  return b[i]! | (b[i + 1]! << 8);
}
function le24(b: Uint8Array, i: number): number {
  return b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
}
function be32(b: Uint8Array, i: number): number {
  return ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
}

/** The frame size from a JPEG's first SOFn segment, walking the segments before it. */
function jpegDimensions(b: Uint8Array): ImageDimensions | null {
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = be16(b, i + 2);
    if (length < 2) return null;
    // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > b.length) return null;
      return { height: be16(b, i + 5), width: be16(b, i + 7) };
    }
    i += 2 + length;
  }
  return null;
}

/** The canvas size from a WebP's first chunk (lossy VP8, lossless VP8L or extended VP8X). */
function webpDimensions(b: Uint8Array): ImageDimensions | null {
  if (b.length < 25) return null;
  const chunk = ascii(b, 12, 16);
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (b.length < 30) return null;
  if (chunk === "VP8 ") {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  }
  if (chunk === "VP8X") return { width: le24(b, 24) + 1, height: le24(b, 27) + 1 };
  return null;
}

/** An image's pixel size read from its header, or null when the header doesn't say. */
export function imageDimensions(bytes: Uint8Array, mime: PersonaAttachmentMime): ImageDimensions | null {
  switch (mime) {
    case "image/png":
      if (bytes.length < 24 || ascii(bytes, 12, 16) !== "IHDR") return null;
      return { width: be32(bytes, 16), height: be32(bytes, 20) };
    case "image/gif":
      return bytes.length >= 10 ? { width: le16(bytes, 6), height: le16(bytes, 8) } : null;
    case "image/jpeg":
      return jpegDimensions(bytes);
    case "image/webp":
      return webpDimensions(bytes);
  }
}

/**
 * Whether an original image of `bytes` and `dims` may be shown to the model
 * as it is (no re-encoded copy): its size must be known, its long edge at
 * most ORIGINAL_IMAGE_MAX_SIDE and its bytes at most MODEL_IMAGE_MAX_BYTES.
 */
export function originalShowable(bytes: number, dims: ImageDimensions | null | undefined): boolean {
  if (!dims || bytes > MODEL_IMAGE_MAX_BYTES) return false;
  return Math.max(dims.width, dims.height) <= ORIGINAL_IMAGE_MAX_SIDE;
}

/**
 * An upload's name as kept: its base name only (anything up to the last `/`
 * or `\` dropped), without control, format or line-separator characters, at
 * most MAX_UPLOAD_NAME_CHARS (its extension kept), and "upload" when nothing
 * is left.
 */
export function sanitizeUploadName(raw: unknown): string {
  const base = (typeof raw === "string" ? raw : "").split(/[\\/]/).pop() ?? "";
  const clean = base.replace(NAME_STRIPPED, "").trim();
  if (!clean || clean === "." || clean === "..") return "upload";
  const chars = [...clean];
  if (chars.length <= MAX_UPLOAD_NAME_CHARS) return clean;
  const dot = clean.lastIndexOf(".");
  const ext = dot > 0 ? [...clean.slice(dot)] : [];
  if (ext.length > 1 && ext.length <= 11) {
    return chars.slice(0, MAX_UPLOAD_NAME_CHARS - ext.length).join("") + ext.join("");
  }
  return chars.slice(0, MAX_UPLOAD_NAME_CHARS).join("");
}

/** A size for people: "12.4 MB", "10 MB", "312 KB". */
export function formatMediaSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
  return `${Math.max(1, Math.ceil(n / 1024))} KB`;
}

/** A duration for people: "12.3 s". */
export function formatDuration(sec: number): string {
  return `${sec.toFixed(1)} s`;
}

/** The declared type as compared: lower-cased, parameters dropped, aliases resolved; null when none was declared. */
function normalizeDeclared(raw: string | undefined): string | null {
  const mime = raw?.split(";")[0]?.trim().toLowerCase();
  if (!mime || mime === "application/octet-stream") return null;
  return MIME_ALIASES[mime] ?? mime;
}

export interface OwnerUploadInput {
  name: unknown;
  /** The type the sender declared, if any. */
  declaredMime?: string;
  bytes: Uint8Array;
}

/** An upload validateOwnerUpload accepted. */
export interface ValidOwnerUpload {
  ok: true;
  /** The name as kept (sanitizeUploadName). */
  name: string;
  mimeType: PersonaMediaMime;
  kind: "image" | "video";
  sha256: string;
  bytes: Uint8Array;
  /** An image's pixel size, when its header says. */
  dimensions?: ImageDimensions;
}

export type OwnerUploadValidation = ValidOwnerUpload | { ok: false; status: 400 | 413; error: string };

/**
 * Checks an owner upload by its content: it must be a PNG, JPEG, GIF or WebP
 * image within PERSONA_ATTACHMENT_MAX_BYTES or an MP4, MOV or WebM video
 * within PERSONA_VIDEO_MAX_BYTES (413 over), and a declared type, when given,
 * must name the same format (400 otherwise).
 */
export function validateOwnerUpload(input: OwnerUploadInput): OwnerUploadValidation {
  const name = sanitizeUploadName(input.name);
  if (input.bytes.length === 0) return { ok: false, status: 400, error: `${name} is empty` };
  const mimeType = sniffOwnerMediaMime(input.bytes);
  if (!mimeType) {
    return { ok: false, status: 400, error: `${name} isn't a supported image or video (${ACCEPTED_TYPES})` };
  }
  const declared = normalizeDeclared(input.declaredMime);
  if (declared && declared !== mimeType && !(ISO_BMFF.has(declared) && ISO_BMFF.has(mimeType))) {
    const shown = declared.replace(/[^\w.+/-]/g, "").slice(0, 80) || "an unknown type";
    return { ok: false, status: 400, error: `${name} was sent as ${shown} but its content is ${DESCRIPTIONS[mimeType]}` };
  }
  const kind = isPersonaVideoMime(mimeType) ? "video" : "image";
  const max = kind === "video" ? PERSONA_VIDEO_MAX_BYTES : PERSONA_ATTACHMENT_MAX_BYTES;
  if (input.bytes.length > max) {
    const size = formatMediaSize(input.bytes.length);
    const cap = formatMediaSize(max);
    return {
      ok: false,
      status: 413,
      error: `${name} is ${size === cap ? `over ${cap}` : size}; ${kind}s can be at most ${cap}`,
    };
  }
  const dimensions = kind === "image" ? imageDimensions(input.bytes, mimeType as PersonaAttachmentMime) : null;
  if (
    dimensions &&
    (dimensions.width > MAX_DECODE_SIDE ||
      dimensions.height > MAX_DECODE_SIDE ||
      dimensions.width * dimensions.height > MAX_DECODE_PIXELS)
  ) {
    return {
      ok: false,
      status: 400,
      error: `${name} is ${dimensions.width}×${dimensions.height} pixels; images can be at most ${Math.round(MAX_DECODE_PIXELS / 1_000_000)} megapixels and ${MAX_DECODE_SIDE} pixels a side`,
    };
  }
  return {
    ok: true,
    name,
    mimeType,
    kind,
    sha256: createHash("sha256").update(input.bytes).digest("hex"),
    bytes: input.bytes,
    ...(dimensions ? { dimensions } : {}),
  };
}

/**
 * The ffmpeg to run: STANDUP_FFMPEG when set (it must be an absolute path to
 * an executable file, or there is none), else `ffmpeg` on PATH; null when
 * there is none.
 */
export function resolveFfmpeg(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.STANDUP_FFMPEG?.trim();
  if (configured) {
    if (!isAbsolute(configured)) return null;
    try {
      if (!statSync(configured).isFile()) return null;
      accessSync(configured, fsConstants.X_OK);
      return configured;
    } catch {
      return null;
    }
  }
  return Bun.which("ffmpeg", { PATH: env.PATH ?? "" }) ?? null;
}

interface FfmpegRun {
  exitCode: number | null;
  stdout: Uint8Array;
  stderr: string;
  timedOut: boolean;
  overflow: boolean;
}

/** Reads `stream` to its end, keeping at most `max` bytes; `onOverflow` runs once when it outgrows them. */
async function readBounded(
  stream: ReadableStream<Uint8Array>,
  max: number,
  onOverflow: () => void
): Promise<{ bytes: Uint8Array; overflow: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflow = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (overflow) continue;
    if (total + value.length > max) {
      overflow = true;
      onOverflow();
      continue;
    }
    chunks.push(value);
    total += value.length;
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return { bytes, overflow };
}

/** ffmpeg processes running now, host-wide, and the runs waiting for a slot. */
let ffmpegRunning = 0;
const ffmpegWaiting: Array<() => void> = [];

/** Takes one of the FFMPEG_CONCURRENCY slots, waiting in order when all are taken. */
function acquireFfmpegSlot(): Promise<void> {
  if (ffmpegRunning < FFMPEG_CONCURRENCY) {
    ffmpegRunning++;
    return Promise.resolve();
  }
  return new Promise((resolve) => ffmpegWaiting.push(resolve));
}

/** Hands the slot to the next waiting run, or frees it. */
function releaseFfmpegSlot(): void {
  const next = ffmpegWaiting.shift();
  if (next) next();
  else ffmpegRunning--;
}

/**
 * Runs ffmpeg with `args` (no shell, no stdin) once a host-wide slot is free,
 * killed after `timeoutMs` of running or once stdout outgrows its bound.
 */
async function runFfmpeg(bin: string, args: string[], timeoutMs: number): Promise<FfmpegRun> {
  await acquireFfmpegSlot();
  try {
    const proc = Bun.spawn([bin, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);
    try {
      const [out, err] = await Promise.all([
        readBounded(proc.stdout, FFMPEG_MAX_STDOUT, () => proc.kill("SIGKILL")),
        readBounded(proc.stderr, FFMPEG_MAX_STDERR, () => {}),
      ]);
      const exitCode = await proc.exited;
      return { exitCode, stdout: out.bytes, stderr: new TextDecoder().decode(err.bytes), timedOut, overflow: out.overflow };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    releaseFfmpegSlot();
  }
}

/** The demuxer ffmpeg is told to use for each type, so no other (playlists, concat) can be reached. */
const DEMUXERS: Record<PersonaMediaMime, string> = {
  "image/png": "png_pipe",
  "image/jpeg": "jpeg_pipe",
  "image/gif": "gif",
  "image/webp": "webp_pipe",
  "video/mp4": "mov",
  "video/quicktime": "mov",
  "video/webm": "matroska",
};

const FFMPEG_BASE = ["-nostdin", "-hide_banner"];

/** The input: one decoder thread, held to MAX_DECODE_PIXELS, through the forced demuxer. */
function inputArgs(path: string, mime: PersonaMediaMime): string[] {
  return ["-threads", "1", "-max_pixels", String(MAX_DECODE_PIXELS), "-f", DEMUXERS[mime], "-i", `file:${path}`];
}

/** One JPEG frame on stdout, scaled by `filter`, encoded on one thread. */
function jpegOutputArgs(filter: string, quality: number): string[] {
  return ["-threads", "1", "-frames:v", "1", "-vf", filter, "-c:v", "mjpeg", "-q:v", String(quality), "-f", "image2", "pipe:1"];
}

/** The `Duration: HH:MM:SS.xx` ffmpeg prints for an input, in seconds; undefined when it says N/A or nothing. */
export function parseFfmpegDuration(stderr: string): number | undefined {
  const m = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
  if (!m) return undefined;
  const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return Number.isFinite(sec) && sec > 0 ? sec : undefined;
}

/** The video's length, from `ffmpeg -i` (which exits non-zero with no output named, after printing it). */
export async function probeDuration(
  ffmpeg: string,
  path: string,
  mime: PersonaVideoMime,
  timeoutMs = FFMPEG_TIMEOUT_MS
): Promise<number | undefined> {
  const run = await runFfmpeg(ffmpeg, [...FFMPEG_BASE, ...inputArgs(path, mime)], timeoutMs);
  return run.timedOut ? undefined : parseFfmpegDuration(run.stderr);
}

/** One still frame at `atSec` as a JPEG, or null when ffmpeg produced none. */
async function extractFrame(
  ffmpeg: string,
  path: string,
  mime: PersonaVideoMime,
  atSec: number,
  timeoutMs: number
): Promise<Uint8Array | null> {
  const run = await runFfmpeg(
    ffmpeg,
    [
      ...FFMPEG_BASE,
      "-loglevel",
      "error",
      "-ss",
      atSec.toFixed(3),
      ...inputArgs(path, mime),
      ...jpegOutputArgs(
        `scale='min(${VIDEO_FRAME_MAX_SIDE},iw)':'min(${VIDEO_FRAME_MAX_SIDE},ih)':force_original_aspect_ratio=decrease`,
        4
      ),
    ],
    timeoutMs
  );
  if (run.timedOut || run.overflow || run.exitCode !== 0) return null;
  return sniffImageMime(run.stdout) === "image/jpeg" ? run.stdout : null;
}

/** The times frames are taken at: `count` spread over the length, or just the start when it is unknown. */
export function frameTimes(durationSec: number | undefined, count = PERSONA_VIDEO_FRAMES): number[] {
  if (!durationSec) return [0];
  return Array.from({ length: count }, (_, i) => Math.round(((i + 0.5) / count) * durationSec * 1000) / 1000);
}

/**
 * The image at `path` decoded and re-encoded as a JPEG with its long edge at
 * most MODEL_COPY_LONG_EDGE, or null when ffmpeg can't decode it (or made
 * nothing that fits).
 */
async function reencodeImage(
  ffmpeg: string,
  path: string,
  mime: PersonaAttachmentMime,
  timeoutMs: number
): Promise<Uint8Array | null> {
  const edge = MODEL_COPY_LONG_EDGE;
  const run = await runFfmpeg(
    ffmpeg,
    [
      ...FFMPEG_BASE,
      "-loglevel",
      "error",
      ...inputArgs(path, mime),
      ...jpegOutputArgs(`scale='min(${edge},iw)':'min(${edge},ih)':force_original_aspect_ratio=decrease`, 5),
    ],
    timeoutMs
  );
  if (run.timedOut || run.overflow || run.exitCode !== 0) return null;
  if (sniffImageMime(run.stdout) !== "image/jpeg" || run.stdout.length > MODEL_IMAGE_MAX_BYTES) return null;
  return run.stdout;
}

/** A stored file of an upload: the upload itself, a frame, or a model copy. */
export interface StoredMediaFile {
  sha256: string;
  mimeType: PersonaMediaMime;
}

/**
 * Digests of files an upload in progress has stored (or is about to), each
 * with how many uploads hold it: a cleanup must keep them, since no row
 * references them yet.
 */
const digestsInFlight = new Map<string, number>();

function holdDigest(sha256: string): void {
  digestsInFlight.set(sha256, (digestsInFlight.get(sha256) ?? 0) + 1);
}

function releaseDigest(sha256: string): void {
  const n = (digestsInFlight.get(sha256) ?? 0) - 1;
  if (n > 0) digestsInFlight.set(sha256, n);
  else digestsInFlight.delete(sha256);
}

/** Whether an upload in progress holds the stored file `sha256`. */
export function isDigestInFlight(sha256: string): boolean {
  return digestsInFlight.has(sha256);
}

/**
 * Removes each of `files` from the stored-copy dir unless a row references it
 * or an upload in progress holds it.
 */
export function discardStoredFiles(db: Database, dataDir: string, files: readonly StoredMediaFile[]): void {
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.sha256)) continue;
    seen.add(file.sha256);
    if (isDigestInFlight(file.sha256) || isPersonaAttachmentFileReferenced(db, file.sha256)) continue;
    try {
      rmSync(storedAttachmentPath(dataDir, file.sha256, file.mimeType), { force: true });
    } catch {
      // A malformed digest names no stored file.
    }
  }
}

/** How long an owner upload may sit unsent before it is removed. */
export const STALE_OWNER_UPLOAD_MS = 24 * 60 * 60 * 1000;

/**
 * Removes `owner`'s uploads still unsent STALE_OWNER_UPLOAD_MS after they
 * were staged, and each stored file of theirs (the upload, its frames, its
 * model copy) that no remaining row references and no upload in progress
 * holds. Returns how many uploads were removed.
 */
export function removeStaleOwnerUploads(db: Database, dataDir: string, owner: string, now: Date): number {
  const pruned = pruneStaleOwnerUploads(db, owner, new Date(now.getTime() - STALE_OWNER_UPLOAD_MS).toISOString());
  discardStoredFiles(
    db,
    dataDir,
    pruned.flatMap((record) => [
      { sha256: record.sha256, mimeType: record.mimeType },
      ...(record.media?.frames ?? []),
      ...(record.media?.modelCopy ? [record.media.modelCopy] : []),
    ])
  );
  return pruned.length;
}

/**
 * Removes `owner`'s attach_image and attach_video rows no reply claimed
 * STALE_OWNER_UPLOAD_MS after they were staged, and each of their stored
 * files (the image or video, a video's poster) that no remaining row
 * references and no upload in progress holds. Returns how many rows went.
 */
export function removeStaleTurnAttachments(db: Database, dataDir: string, owner: string, now: Date): number {
  const pruned = pruneStaleTurnAttachments(db, owner, new Date(now.getTime() - STALE_OWNER_UPLOAD_MS).toISOString());
  discardStoredFiles(
    db,
    dataDir,
    pruned.flatMap((record) => [
      { sha256: record.sha256, mimeType: record.mimeType },
      ...(record.media?.poster ? [record.media.poster] : []),
    ])
  );
  return pruned.length;
}

export interface PrepareOwnerMediaOptions {
  /** Consulted, when a refused upload's files are removed, for rows that still use them. */
  db: Database;
  dataDir: string;
  /** The ffmpeg to run (resolveFfmpeg), or null for none. */
  ffmpeg: string | null;
  timeoutMs?: number;
}

export type PreparedOwnerMedia =
  | {
      ok: true;
      media: PersonaAttachmentMedia;
      storedPath: string;
      /** Every file stored for the upload (it, its frames, its model copy). */
      files: StoredMediaFile[];
      /**
       * Lets a cleanup remove the files again; call it once the row that
       * references them is written, or before discardStoredFiles when it can't be.
       */
      release: () => void;
    }
  | { ok: false; status: 400; error: string };

/**
 * Stores a validated upload's copy and derives what Persona is shown of it.
 * With ffmpeg, an image gets a re-encoded JPEG model copy (long edge at most
 * MODEL_COPY_LONG_EDGE), which also proves it decodes, and a video its
 * duration and PERSONA_VIDEO_FRAMES still frames; an image or video ffmpeg
 * can't decode is refused. Without ffmpeg the media says what Persona can't
 * see. Every derived image is stored content-addressed beside the upload,
 * and a refused upload (or one that throws) leaves none of its files behind.
 */
export async function prepareOwnerMedia(upload: ValidOwnerUpload, opts: PrepareOwnerMediaOptions): Promise<PreparedOwnerMedia> {
  const timeoutMs = opts.timeoutMs ?? FFMPEG_TIMEOUT_MS;
  const files: StoredMediaFile[] = [];
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    for (const file of files) releaseDigest(file.sha256);
  };
  const store = (bytes: Uint8Array, sha256: string, mimeType: PersonaMediaMime): string => {
    holdDigest(sha256);
    files.push({ sha256, mimeType });
    return storeAttachmentCopy(opts.dataDir, { bytes, sha256, mimeType });
  };
  const storeJpeg = (bytes: Uint8Array): PersonaDerivedImage => {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    store(bytes, sha256, "image/jpeg");
    return { sha256, mimeType: "image/jpeg" };
  };
  const refuse = (error: string): PreparedOwnerMedia => {
    release();
    discardStoredFiles(opts.db, opts.dataDir, files);
    return { ok: false, status: 400, error };
  };
  try {
    const storedPath = store(upload.bytes, upload.sha256, upload.mimeType);
    const done = (media: PersonaAttachmentMedia): PreparedOwnerMedia => ({ ok: true, media, storedPath, files, release });
    if (upload.kind === "image") {
      const mime = upload.mimeType as PersonaAttachmentMime;
      const dims: PersonaAttachmentMedia = upload.dimensions
        ? { width: upload.dimensions.width, height: upload.dimensions.height }
        : {};
      if (!opts.ffmpeg) {
        if (originalShowable(upload.bytes.length, upload.dimensions)) return done(dims);
        return done({ ...dims, note: upload.dimensions ? IMAGE_TOO_LARGE_NOTE : IMAGE_UNKNOWN_SIZE_NOTE });
      }
      const copy = await reencodeImage(opts.ffmpeg, storedPath, mime, timeoutMs);
      if (!copy) return refuse(`${upload.name} couldn't be decoded as an image`);
      return done({ ...dims, modelCopy: storeJpeg(copy) });
    }
    const mime = upload.mimeType as PersonaVideoMime;
    if (!opts.ffmpeg) return done({ frames: [], note: FFMPEG_MISSING_NOTE });
    const durationSec = await probeDuration(opts.ffmpeg, storedPath, mime, timeoutMs);
    const times = frameTimes(durationSec);
    const frames: PersonaVideoFrame[] = [];
    for (const atSec of times) {
      const jpeg = await extractFrame(opts.ffmpeg, storedPath, mime, atSec, timeoutMs);
      if (jpeg) frames.push({ sha256: storeJpeg(jpeg).sha256, mimeType: "image/jpeg", atSec });
    }
    if (frames.length === 0) return refuse(`${upload.name} couldn't be decoded as a video`);
    const note =
      durationSec === undefined
        ? NO_DURATION_NOTE
        : frames.length < times.length
          ? `only ${frames.length} of ${times.length} frames could be extracted`
          : undefined;
    return done({
      ...(durationSec !== undefined ? { durationSec: Math.round(durationSec * 100) / 100 } : {}),
      frames,
      ...(note ? { note } : {}),
    });
  } catch (err) {
    release();
    discardStoredFiles(opts.db, opts.dataDir, files);
    throw err;
  }
}

/** The latest a poster frame is taken from: a second in, or a tenth of a shorter video. */
const POSTER_MAX_SEC = 1;

/** When a video's poster frame is taken: a tenth of the way in, at most POSTER_MAX_SEC; the start when its length is unknown. */
export function posterTime(durationSec: number | undefined): number {
  return durationSec ? Math.min(POSTER_MAX_SEC, Math.round(durationSec * 100) / 1000) : 0;
}

export type PreparedAttachedVideo =
  | {
      ok: true;
      media: PersonaAttachmentMedia;
      /** Every file stored for the video (it and its poster). */
      files: StoredMediaFile[];
      /** As in PreparedOwnerMedia: lets a cleanup remove the files once the row referencing them is written. */
      release: () => void;
    }
  | { ok: false; error: string };

/**
 * Stores the copy of a video Persona attaches and, with ffmpeg, reads its
 * length and takes its poster frame (a JPEG, stored beside it), which also
 * proves it decodes; a video ffmpeg can't decode is refused and leaves none
 * of its files. Without ffmpeg the video is kept with no poster, and the
 * console shows the browser's first frame instead.
 */
export async function prepareAttachedVideo(video: ValidatedVideo, opts: PrepareOwnerMediaOptions): Promise<PreparedAttachedVideo> {
  const timeoutMs = opts.timeoutMs ?? FFMPEG_TIMEOUT_MS;
  const files: StoredMediaFile[] = [];
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    for (const file of files) releaseDigest(file.sha256);
  };
  const store = (bytes: Uint8Array, sha256: string, mimeType: PersonaMediaMime): string => {
    holdDigest(sha256);
    files.push({ sha256, mimeType });
    return storeAttachmentCopy(opts.dataDir, { bytes, sha256, mimeType });
  };
  try {
    const storedPath = store(video.bytes, video.sha256, video.mimeType);
    if (!opts.ffmpeg) return { ok: true, media: {}, files, release };
    const durationSec = await probeDuration(opts.ffmpeg, storedPath, video.mimeType, timeoutMs);
    const jpeg = await extractFrame(opts.ffmpeg, storedPath, video.mimeType, posterTime(durationSec), timeoutMs);
    if (!jpeg) {
      release();
      discardStoredFiles(opts.db, opts.dataDir, files);
      return { ok: false, error: `${video.name} couldn't be decoded as a video` };
    }
    const sha256 = createHash("sha256").update(jpeg).digest("hex");
    store(jpeg, sha256, "image/jpeg");
    return {
      ok: true,
      media: {
        ...(durationSec !== undefined ? { durationSec: Math.round(durationSec * 100) / 100 } : {}),
        poster: { sha256, mimeType: "image/jpeg" },
      },
      files,
      release,
    };
  } catch (err) {
    release();
    discardStoredFiles(opts.db, opts.dataDir, files);
    throw err;
  }
}
