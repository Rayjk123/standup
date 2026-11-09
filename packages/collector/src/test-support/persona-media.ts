import { chmodSync, writeFileSync } from "fs";
import { join } from "path";

/**
 * Minimal media files for tests, each just the header bytes the collector
 * sniffs (and reads dimensions from), plus a fake ffmpeg.
 */

const text = (s: string) => [...new TextEncoder().encode(s)];
const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const le24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];

/** `bytes` followed by `padTo - bytes.length` zero bytes, when `padTo` is larger. */
function padded(bytes: number[], padTo = 0): Uint8Array {
  const out = new Uint8Array(Math.max(bytes.length, padTo));
  out.set(bytes);
  return out;
}

export function pngBytes(width = 1, height = 1, padTo = 0): Uint8Array {
  return padded(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), ...text("IHDR"), ...be32(width), ...be32(height), 8, 2, 0, 0, 0, 0, 0, 0, 0],
    padTo
  );
}

export function jpegBytes(width = 1, height = 1, padTo = 0): Uint8Array {
  return padded(
    [
      0xff, 0xd8,
      0xff, 0xe0, ...be16(16), ...text("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
      0xff, 0xc0, ...be16(17), 8, ...be16(height), ...be16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
      0xff, 0xd9,
    ],
    padTo
  );
}

export function gifBytes(width = 1, height = 1): Uint8Array {
  return Uint8Array.from([...text("GIF89a"), ...le16(width), ...le16(height), 0, 0, 0, 0x3b]);
}

/** A WebP whose first chunk is `kind` (lossy, lossless or extended). */
export function webpBytes(kind: "VP8 " | "VP8L" | "VP8X" = "VP8X", width = 1, height = 1): Uint8Array {
  const body =
    kind === "VP8 "
      ? [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(width), ...le16(height)]
      : kind === "VP8L"
        ? [0x2f, ...le32(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14))]
        : [0, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)];
  const chunk = [...text(kind), ...le32(body.length), ...body];
  return Uint8Array.from([...text("RIFF"), ...le32(4 + chunk.length), ...text("WEBP"), ...chunk]);
}

/** An `ftyp` box with the given major and compatible brands, then a `free` box and padding. */
export function ftypBytes(major: string, compatible: string[], padTo = 0): Uint8Array {
  const size = 16 + compatible.length * 4;
  return padded(
    [...be32(size), ...text("ftyp"), ...text(major), 0, 0, 2, 0, ...compatible.flatMap(text), ...be32(8), ...text("free")],
    padTo
  );
}

export const mp4Bytes = (padTo = 0) => ftypBytes("isom", ["isom", "mp41"], padTo);

/** An ISO-BMFF box of `type` around `body`. */
function box(type: string, body: number[]): number[] {
  return [...be32(8 + body.length), ...text(type), ...body];
}

export interface TrackedMp4Options {
  /** Each video track's sample-entry code, e.g. "avc1" (H.264) or "hvc1" (HEVC); none for no video track. */
  codec?: string | string[];
  /** An audio track (`smhd`, `mp4a`) beside it. */
  audio?: boolean;
  /** Bytes of `mdat` after the `moov`. */
  mdat?: number;
}

/**
 * An MP4 whose `moov` holds a video track for each `codec` (and an audio
 * track when asked), each `trak/mdia/minf/stbl/stsd` as a real file lays
 * them out, then an `mdat` of zeros.
 */
export function trackedMp4Bytes(opts: TrackedMp4Options = {}): Uint8Array {
  const trak = (header: string, entry: string) =>
    box("trak", [
      ...box("tkhd", Array(84).fill(0)),
      ...box("mdia", [
        ...box("mdhd", Array(24).fill(0)),
        ...box("minf", [
          ...box(header, Array(header === "vmhd" ? 12 : 8).fill(0)),
          ...box("stbl", [...box("stsd", [0, 0, 0, 0, ...be32(1), ...box(entry, Array(78).fill(0))]), ...box("stts", Array(8).fill(0))]),
        ]),
      ]),
    ]);
  const moov = box("moov", [
    ...box("mvhd", Array(100).fill(0)),
    ...[opts.codec ?? []].flat().flatMap((codec) => trak("vmhd", codec)),
    ...(opts.audio ? trak("smhd", "mp4a") : []),
  ]);
  return Uint8Array.from([...ftypBytes("isom", ["isom", "iso2", "avc1", "mp41"]), ...moov, ...box("mdat", Array(opts.mdat ?? 64).fill(0))]);
}
export const movBytes = (padTo = 0) => ftypBytes("qt  ", ["qt  "], padTo);

/** An EBML header whose DocType is `docType` ("webm" for WebM). */
export function webmBytes(docType = "webm"): Uint8Array {
  const dt = text(docType);
  const body = [
    0x42, 0x86, 0x81, 0x01,
    0x42, 0xf7, 0x81, 0x01,
    0x42, 0xf2, 0x81, 0x04,
    0x42, 0xf3, 0x81, 0x08,
    0x42, 0x82, 0x80 | dt.length, ...dt,
    0x42, 0x87, 0x81, 0x04,
    0x42, 0x85, 0x81, 0x02,
  ];
  return Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x80 | body.length, ...body, 0x18, 0x53, 0x80, 0x67, 0x01, 0, 0, 0]);
}

/** The JPEG the fake ffmpeg writes for every frame or image it is asked for. */
export const FAKE_FFMPEG_JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...text("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);

export interface FakeFfmpegOptions {
  /** The `Duration:` value printed for `-i` alone, e.g. "00:00:12.50" or "N/A". */
  duration?: string;
  /** "jpeg" writes FAKE_FFMPEG_JPEG for an output on pipe:1; "fail" exits 1 there; "hang" never finishes. */
  frames?: "jpeg" | "fail" | "hang";
  /** Seconds each run takes before it answers. */
  delaySec?: number;
}

/**
 * Writes an executable shell script standing in for ffmpeg into `dir` and
 * returns its path. Each run's arguments are appended to `<path>.log`, one
 * line per run, and `start <pid>` / `end <pid>` around it to `<path>.events`.
 */
export function writeFakeFfmpeg(dir: string, opts: FakeFfmpegOptions = {}): string {
  const path = join(dir, "ffmpeg");
  const jpeg = [...FAKE_FFMPEG_JPEG].map((b) => `\\${b.toString(8).padStart(3, "0")}`).join("");
  const end = `echo "end $$" >> "$0.events"`;
  const frames =
    opts.frames === "fail"
      ? `${end}; exit 1`
      : opts.frames === "hang"
        ? "exec sleep 30"
        : `printf '${jpeg}'; ${end}; exit 0`;
  const script = [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> "$0.log"`,
    `echo "start $$" >> "$0.events"`,
    ...(opts.delaySec ? [`sleep ${opts.delaySec}`] : []),
    'for a in "$@"; do',
    `  if [ "$a" = "pipe:1" ]; then ${frames}; fi`,
    "done",
    end,
    `echo "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'in':" >&2`,
    `echo "  Duration: ${opts.duration ?? "00:00:12.50"}, start: 0.000000, bitrate: 100 kb/s" >&2`,
    'echo "At least one output file must be specified" >&2',
    "exit 1",
    "",
  ].join("\n");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}
