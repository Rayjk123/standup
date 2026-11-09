import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PERSONA_ATTACHMENT_MAX_BYTES, PERSONA_VIDEO_FRAMES, PERSONA_VIDEO_MAX_BYTES } from "@standup/shared";
import type { PersonaMediaMime } from "@standup/shared";
import {
  FFMPEG_CONCURRENCY,
  FFMPEG_MISSING_NOTE,
  IMAGE_TOO_LARGE_NOTE,
  IMAGE_UNKNOWN_SIZE_NOTE,
  isDigestInFlight,
  removeStaleOwnerUploads,
  MODEL_IMAGE_MAX_BYTES,
  formatMediaSize,
  frameTimes,
  imageDimensions,
  originalShowable,
  parseFfmpegDuration,
  prepareOwnerMedia,
  resolveFfmpeg,
  sanitizeUploadName,
  sniffOwnerMediaMime,
  validateOwnerUpload,
} from "./media.js";
import type { ValidOwnerUpload } from "./media.js";
import { storedAttachmentPath } from "./attachments.js";
import { createStore, stageOwnerUpload } from "@standup/store";
import type { Database } from "bun:sqlite";

/** A fresh in-memory store's database. */
const db = (): Database => createStore(":memory:").db;
import {
  FAKE_FFMPEG_JPEG,
  ftypBytes,
  gifBytes,
  jpegBytes,
  movBytes,
  mp4Bytes,
  pngBytes,
  webmBytes,
  webpBytes,
  writeFakeFfmpeg,
} from "../test-support/persona-media.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix = "persona-media-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const enc = (s: string) => new TextEncoder().encode(s);

function accepted(input: Parameters<typeof validateOwnerUpload>[0]): ValidOwnerUpload {
  const v = validateOwnerUpload(input);
  if (!v.ok) throw new Error(`expected ${String(input.name)} to be accepted: ${v.error}`);
  return v;
}

describe("sniffOwnerMediaMime", () => {
  test("knows each image and video type by content, and nothing else", () => {
    const cases: Array<{ bytes: Uint8Array; want: PersonaMediaMime | null }> = [
      { bytes: pngBytes(), want: "image/png" },
      { bytes: jpegBytes(), want: "image/jpeg" },
      { bytes: gifBytes(), want: "image/gif" },
      { bytes: webpBytes(), want: "image/webp" },
      { bytes: mp4Bytes(), want: "video/mp4" },
      { bytes: movBytes(), want: "video/quicktime" },
      { bytes: ftypBytes("qt  ", ["qt  ", "isom"]), want: "video/quicktime" },
      { bytes: webmBytes(), want: "video/webm" },
      { bytes: webmBytes("matroska"), want: null },
      { bytes: ftypBytes("M4A ", ["M4A "]), want: null },
      { bytes: enc("<svg xmlns='http://www.w3.org/2000/svg'/>"), want: null },
      { bytes: enc("<!doctype html><html></html>"), want: null },
      { bytes: Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]), want: null },
      { bytes: enc("hello"), want: null },
    ];
    for (const c of cases) expect(sniffOwnerMediaMime(c.bytes)).toBe(c.want);
  });
});

describe("imageDimensions", () => {
  test("reads the size from PNG, GIF, JPEG and each WebP flavour's header", () => {
    const cases: Array<{ bytes: Uint8Array; mime: Parameters<typeof imageDimensions>[1]; want: { width: number; height: number } | null }> = [
      { bytes: pngBytes(640, 480), mime: "image/png", want: { width: 640, height: 480 } },
      { bytes: pngBytes(9000, 10), mime: "image/png", want: { width: 9000, height: 10 } },
      { bytes: gifBytes(320, 200), mime: "image/gif", want: { width: 320, height: 200 } },
      { bytes: jpegBytes(1920, 1080), mime: "image/jpeg", want: { width: 1920, height: 1080 } },
      { bytes: webpBytes("VP8 ", 800, 600), mime: "image/webp", want: { width: 800, height: 600 } },
      { bytes: webpBytes("VP8L", 1000, 16383), mime: "image/webp", want: { width: 1000, height: 16383 } },
      { bytes: webpBytes("VP8X", 12000, 3), mime: "image/webp", want: { width: 12000, height: 3 } },
      { bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), mime: "image/jpeg", want: null },
      { bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), mime: "image/png", want: null },
    ];
    for (const c of cases) expect(imageDimensions(c.bytes, c.mime)).toEqual(c.want);
  });

  test("an original is shown without ffmpeg only when its size is known, ≤ 2000 px and ≤ 3.75 MiB", () => {
    const cases: Array<{ bytes: number; dims: { width: number; height: number } | null; want: boolean }> = [
      { bytes: 1000, dims: { width: 2000, height: 2000 }, want: true },
      { bytes: 1000, dims: { width: 2001, height: 10 }, want: false },
      { bytes: 1000, dims: { width: 10, height: 2001 }, want: false },
      { bytes: 1000, dims: null, want: false },
      { bytes: MODEL_IMAGE_MAX_BYTES, dims: { width: 10, height: 10 }, want: true },
      { bytes: MODEL_IMAGE_MAX_BYTES + 1, dims: { width: 10, height: 10 }, want: false },
    ];
    for (const c of cases) expect(originalShowable(c.bytes, c.dims)).toBe(c.want);
  });
});

describe("sanitizeUploadName", () => {
  test("keeps the base name, drops control and format characters, clips, falls back", () => {
    const cases: Array<{ raw: unknown; want: string }> = [
      { raw: "photo.png", want: "photo.png" },
      { raw: "/home/me/Pictures/photo.png", want: "photo.png" },
      { raw: "C:\\Users\\me\\clip.mp4", want: "clip.mp4" },
      { raw: "a\nb\r\tc\u0000.png", want: "abc.png" },
      { raw: "evil\u202egnp.exe", want: "evilgnp.exe" },
      { raw: "line\u2028break.png", want: "linebreak.png" },
      { raw: "", want: "upload" },
      { raw: "  ", want: "upload" },
      { raw: "..", want: "upload" },
      { raw: "dir/", want: "upload" },
      { raw: 42, want: "upload" },
      { raw: `${"x".repeat(200)}.png`, want: `${"x".repeat(116)}.png` },
      { raw: "y".repeat(200), want: "y".repeat(120) },
    ];
    for (const c of cases) expect(sanitizeUploadName(c.raw)).toBe(c.want);
  });
});

describe("validateOwnerUpload", () => {
  test("each image and video type is accepted by content", () => {
    const cases: Array<{ name: string; bytes: Uint8Array; declared?: string; mime: PersonaMediaMime; kind: "image" | "video" }> = [
      { name: "a.png", bytes: pngBytes(), declared: "image/png", mime: "image/png", kind: "image" },
      { name: "a.jpg", bytes: jpegBytes(), declared: "image/jpg", mime: "image/jpeg", kind: "image" },
      { name: "a.jpeg", bytes: jpegBytes(), declared: "image/pjpeg", mime: "image/jpeg", kind: "image" },
      { name: "a.gif", bytes: gifBytes(), mime: "image/gif", kind: "image" },
      { name: "a.webp", bytes: webpBytes(), declared: "IMAGE/WEBP; charset=x", mime: "image/webp", kind: "image" },
      { name: "a.mp4", bytes: mp4Bytes(), declared: "video/mp4", mime: "video/mp4", kind: "video" },
      { name: "a.m4v", bytes: mp4Bytes(), declared: "video/x-m4v", mime: "video/mp4", kind: "video" },
      { name: "a.mov", bytes: movBytes(), declared: "video/quicktime", mime: "video/quicktime", kind: "video" },
      { name: "a.mov", bytes: movBytes(), declared: "video/mp4", mime: "video/quicktime", kind: "video" },
      { name: "a.mp4", bytes: mp4Bytes(), declared: "video/quicktime", mime: "video/mp4", kind: "video" },
      { name: "a.webm", bytes: webmBytes(), declared: "video/webm", mime: "video/webm", kind: "video" },
      { name: "a.bin", bytes: pngBytes(), declared: "application/octet-stream", mime: "image/png", kind: "image" },
      { name: "a", bytes: pngBytes(), declared: "", mime: "image/png", kind: "image" },
    ];
    for (const c of cases) {
      const v = accepted({ name: c.name, bytes: c.bytes, ...(c.declared !== undefined ? { declaredMime: c.declared } : {}) });
      expect({ mime: v.mimeType, kind: v.kind }).toEqual({ mime: c.mime, kind: c.kind });
      expect(v.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(accepted({ name: "p.png", bytes: pngBytes(30, 20) }).dimensions).toEqual({ width: 30, height: 20 });
  });

  test("refusals: unsupported, mismatched, empty (400) and oversized (413), each said plainly", () => {
    const cases: Array<{ name: unknown; bytes: Uint8Array; declared?: string; status: number; error: string }> = [
      {
        name: "notes.png",
        bytes: enc("just text"),
        status: 400,
        error: "notes.png isn't a supported image or video (PNG, JPEG, GIF, WebP, MP4, MOV or WebM)",
      },
      {
        name: "logo.svg",
        bytes: enc("<svg xmlns='http://www.w3.org/2000/svg'/>"),
        declared: "image/svg+xml",
        status: 400,
        error: "logo.svg isn't a supported image or video (PNG, JPEG, GIF, WebP, MP4, MOV or WebM)",
      },
      {
        name: "bundle.zip",
        bytes: Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]),
        status: 400,
        error: "bundle.zip isn't a supported image or video (PNG, JPEG, GIF, WebP, MP4, MOV or WebM)",
      },
      {
        name: "clip.mp4",
        bytes: pngBytes(),
        declared: "video/mp4",
        status: 400,
        error: "clip.mp4 was sent as video/mp4 but its content is a PNG image",
      },
      {
        name: "photo.jpg",
        bytes: webmBytes(),
        declared: "image/jpeg",
        status: 400,
        error: "photo.jpg was sent as image/jpeg but its content is a WebM video",
      },
      {
        name: "x.png",
        bytes: pngBytes(),
        declared: "text/<b>html",
        status: 400,
        error: "x.png was sent as text/bhtml but its content is a PNG image",
      },
      { name: "empty.png", bytes: new Uint8Array(), status: 400, error: "empty.png is empty" },
      {
        name: "photo.png",
        bytes: pngBytes(1, 1, Math.round(12.4 * 1024 * 1024)),
        status: 413,
        error: "photo.png is 12.4 MB; images can be at most 10 MB",
      },
      {
        name: "long.mp4",
        bytes: mp4Bytes(PERSONA_VIDEO_MAX_BYTES + 1),
        status: 413,
        error: "long.mp4 is over 50 MB; videos can be at most 50 MB",
      },
    ];
    for (const c of cases) {
      const v = validateOwnerUpload({ name: c.name, bytes: c.bytes, ...(c.declared !== undefined ? { declaredMime: c.declared } : {}) });
      expect(v).toEqual({ ok: false, status: c.status as 400 | 413, error: c.error });
    }
    // At the caps exactly, both are accepted.
    expect(validateOwnerUpload({ name: "a.png", bytes: pngBytes(1, 1, PERSONA_ATTACHMENT_MAX_BYTES) }).ok).toBe(true);
    expect(validateOwnerUpload({ name: "a.mp4", bytes: mp4Bytes(PERSONA_VIDEO_MAX_BYTES) }).ok).toBe(true);
  });

  test("sizes read the way people say them", () => {
    const cases: Array<[number, string]> = [
      [10 * 1024 * 1024, "10 MB"],
      [Math.round(1.25 * 1024 * 1024), "1.3 MB"],
      [1, "1 KB"],
      [312 * 1024, "312 KB"],
    ];
    for (const [n, want] of cases) expect(formatMediaSize(n)).toBe(want);
  });
});

describe("ffmpeg", () => {
  test("resolveFfmpeg: STANDUP_FFMPEG must be an absolute executable file; none is null", () => {
    const dir = tempDir();
    const fake = writeFakeFfmpeg(dir);
    const cases: Array<{ env: NodeJS.ProcessEnv; want: string | null }> = [
      { env: { STANDUP_FFMPEG: fake }, want: fake },
      { env: { STANDUP_FFMPEG: join(dir, "missing") }, want: null },
      { env: { STANDUP_FFMPEG: "ffmpeg" }, want: null },
      { env: { STANDUP_FFMPEG: dir }, want: null },
      { env: { PATH: dir }, want: fake },
      { env: { PATH: join(dir, "nowhere") }, want: null },
    ];
    for (const c of cases) expect(resolveFfmpeg(c.env)).toBe(c.want);
  });

  test("durations and frame times", () => {
    expect(parseFfmpegDuration("  Duration: 00:00:12.50, start: 0")).toBe(12.5);
    expect(parseFfmpegDuration("  Duration: 01:02:03.25, start: 0")).toBe(3723.25);
    expect(parseFfmpegDuration("  Duration: N/A, start: 0")).toBeUndefined();
    expect(parseFfmpegDuration("nothing")).toBeUndefined();
    expect(frameTimes(10)).toEqual([1, 3, 5, 7, 9]);
    expect(frameTimes(undefined)).toEqual([0]);
  });

  test("a video gets its duration and PERSONA_VIDEO_FRAMES content-addressed JPEG frames, with a forced demuxer", async () => {
    const dataDir = tempDir();
    const ffmpeg = writeFakeFfmpeg(tempDir());
    const cases: Array<{ upload: ValidOwnerUpload; demuxer: string }> = [
      { upload: accepted({ name: "clip.mp4", bytes: mp4Bytes(64) }), demuxer: "mov" },
      { upload: accepted({ name: "clip.mov", bytes: movBytes(64) }), demuxer: "mov" },
      { upload: accepted({ name: "clip.webm", bytes: webmBytes() }), demuxer: "matroska" },
    ];
    for (const c of cases) {
      rmSync(`${ffmpeg}.log`, { force: true });
      const prepared = await prepareOwnerMedia(c.upload, { db: db(), dataDir, ffmpeg });
      if (!prepared.ok) throw new Error(prepared.error);
      prepared.release();
      expect(prepared.storedPath).toBe(storedAttachmentPath(dataDir, c.upload.sha256, c.upload.mimeType));
      expect(prepared.media.durationSec).toBe(12.5);
      expect(prepared.media.frames).toHaveLength(PERSONA_VIDEO_FRAMES);
      expect(prepared.media.frames!.map((f) => f.atSec)).toEqual([1.25, 3.75, 6.25, 8.75, 11.25]);
      expect(prepared.media.note).toBeUndefined();
      const frame = prepared.media.frames![0]!;
      expect([...readFileSync(storedAttachmentPath(dataDir, frame.sha256, "image/jpeg"))]).toEqual([...FAKE_FFMPEG_JPEG]);
      const runs = readFileSync(`${ffmpeg}.log`, "utf8").trim().split("\n");
      expect(runs).toHaveLength(1 + PERSONA_VIDEO_FRAMES);
      for (const run of runs) {
        expect(run).toStartWith("-nostdin -hide_banner");
        expect(run).toContain(`-threads 1 -max_pixels 50331648 -f ${c.demuxer} -i file:${prepared.storedPath}`);
      }
      expect(runs[1]).toContain("-ss 1.250 ");
      expect(runs[1]).toContain(
        "-threads 1 -frames:v 1 -vf scale='min(1024,iw)':'min(1024,ih)':force_original_aspect_ratio=decrease -c:v mjpeg -q:v 4 -f image2 pipe:1"
      );
    }
  });

  test("an unknown length takes the first frame only and says so", async () => {
    const prepared = await prepareOwnerMedia(accepted({ name: "rec.webm", bytes: webmBytes() }), {
      db: db(),
      dataDir: tempDir(),
      ffmpeg: writeFakeFfmpeg(tempDir(), { duration: "N/A" }),
    });
    expect(prepared.ok && prepared.media.frames?.map((f) => f.atSec)).toEqual([0]);
    expect(prepared.ok && prepared.media.durationSec).toBeUndefined();
    expect(prepared.ok && prepared.media.note).toContain("only its first frame");
    if (prepared.ok) prepared.release();
  });

  test("a video or image ffmpeg can't decode is refused, leaving none of its files; a hung ffmpeg is killed", async () => {
    const cases: Array<{ upload: ValidOwnerUpload; frames: "fail" | "hang"; error: string }> = [
      { upload: accepted({ name: "broken.mp4", bytes: mp4Bytes(64) }), frames: "fail", error: "broken.mp4 couldn't be decoded as a video" },
      { upload: accepted({ name: "broken.mp4", bytes: mp4Bytes(64) }), frames: "hang", error: "broken.mp4 couldn't be decoded as a video" },
      { upload: accepted({ name: "broken.png", bytes: pngBytes(5, 5) }), frames: "fail", error: "broken.png couldn't be decoded as an image" },
    ];
    for (const c of cases) {
      const dataDir = tempDir();
      const prepared = await prepareOwnerMedia(c.upload, {
        db: db(),
        dataDir,
        ffmpeg: writeFakeFfmpeg(tempDir(), { frames: c.frames }),
        timeoutMs: 300,
      });
      expect(prepared).toEqual({ ok: false, status: 400, error: c.error });
      expect(existsSync(storedAttachmentPath(dataDir, c.upload.sha256, c.upload.mimeType))).toBe(false);
      expect(isDigestInFlight(c.upload.sha256)).toBe(false);
    }
  });

  test("a refused upload keeps a stored file another row still uses", async () => {
    const store = db();
    const dataDir = tempDir();
    const upload = accepted({ name: "clip.mp4", bytes: mp4Bytes(70) });
    stageOwnerUpload(store, { owner: "me", threadId: "t", sha256: upload.sha256, mimeType: upload.mimeType, bytes: 70, name: "clip.mp4" });
    const prepared = await prepareOwnerMedia(upload, { db: store, dataDir, ffmpeg: writeFakeFfmpeg(tempDir(), { frames: "fail" }) });
    expect(prepared.ok).toBe(false);
    expect(existsSync(storedAttachmentPath(dataDir, upload.sha256, upload.mimeType))).toBe(true);
  });

  test("without ffmpeg a video is kept with the note; an image is shown as-is only when small and of known size", async () => {
    const dataDir = tempDir();
    const video = await prepareOwnerMedia(accepted({ name: "clip.mp4", bytes: mp4Bytes(64) }), { db: db(), dataDir, ffmpeg: null });
    expect(video).toMatchObject({ ok: true, media: { frames: [], note: FFMPEG_MISSING_NOTE } });
    if (video.ok) video.release();
    const cases: Array<{ upload: ValidOwnerUpload; media: Record<string, unknown> }> = [
      { upload: accepted({ name: "a.png", bytes: pngBytes(10, 20) }), media: { width: 10, height: 20 } },
      { upload: accepted({ name: "big.png", bytes: pngBytes(2001, 20) }), media: { width: 2001, height: 20, note: IMAGE_TOO_LARGE_NOTE } },
      {
        upload: accepted({ name: "heavy.png", bytes: pngBytes(10, 10, MODEL_IMAGE_MAX_BYTES + 1) }),
        media: { width: 10, height: 10, note: IMAGE_TOO_LARGE_NOTE },
      },
      {
        upload: accepted({ name: "odd.jpg", bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]) }),
        media: { note: IMAGE_UNKNOWN_SIZE_NOTE },
      },
    ];
    for (const c of cases) {
      const prepared = await prepareOwnerMedia(c.upload, { db: db(), dataDir, ffmpeg: null });
      if (!prepared.ok) throw new Error(prepared.error);
      prepared.release();
      expect(prepared.media).toEqual(c.media);
      expect(existsSync(prepared.storedPath)).toBe(true);
    }
  });

  test("with ffmpeg every image gets a re-encoded JPEG model copy, long edge at most 1568", async () => {
    const dataDir = tempDir();
    const ffmpeg = writeFakeFfmpeg(tempDir());
    for (const [name, bytes] of [
      ["small.png", pngBytes(10, 10)],
      ["huge.png", pngBytes(7000, 7000)],
      ["odd.jpg", Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])],
    ] as const) {
      rmSync(`${ffmpeg}.log`, { force: true });
      const prepared = await prepareOwnerMedia(accepted({ name, bytes }), { db: db(), dataDir, ffmpeg });
      if (!prepared.ok) throw new Error(prepared.error);
      prepared.release();
      expect(prepared.media.modelCopy?.mimeType).toBe("image/jpeg");
      expect(prepared.media.note).toBeUndefined();
      expect(prepared.files.map((f) => f.mimeType)).toEqual([accepted({ name, bytes }).mimeType, "image/jpeg"]);
      expect(existsSync(storedAttachmentPath(dataDir, prepared.media.modelCopy!.sha256, "image/jpeg"))).toBe(true);
      const run = readFileSync(`${ffmpeg}.log`, "utf8");
      expect(run).toContain("-threads 1 -max_pixels 50331648 -f ");
      expect(run).toContain("-threads 1 -frames:v 1 -vf scale='min(1568,iw)':'min(1568,ih)':force_original_aspect_ratio=decrease -c:v mjpeg -q:v 5");
    }
  });

  test("an image whose header is over 16384 px a side or 50 megapixels is refused before any decode", () => {
    const limit = "images can be at most 50 megapixels and 16384 pixels a side";
    const cases: Array<{ w: number; h: number; ok: boolean }> = [
      { w: 16385, h: 10, ok: false },
      { w: 10, h: 16385, ok: false },
      { w: 8192, h: 6144, ok: true },
      { w: 8193, h: 6144, ok: false },
      { w: 16384, h: 10, ok: true },
    ];
    for (const c of cases) {
      const v = validateOwnerUpload({ name: "big.png", bytes: pngBytes(c.w, c.h) });
      expect(v.ok).toBe(c.ok);
      if (!c.ok) expect(v).toEqual({ ok: false, status: 400, error: `big.png is ${c.w}×${c.h} pixels; ${limit}` });
    }
  });

  test("at most FFMPEG_CONCURRENCY ffmpeg processes run at once; the rest wait their turn", async () => {
    const ffmpeg = writeFakeFfmpeg(tempDir(), { delaySec: 0.15 });
    const results = await Promise.all(
      [1, 2, 3, 4].map((i) => prepareOwnerMedia(accepted({ name: `p${i}.png`, bytes: pngBytes(i, i) }), { db: db(), dataDir: tempDir(), ffmpeg }))
    );
    expect(results.every((r) => r.ok)).toBe(true);
    for (const r of results) if (r.ok) r.release();
    let running = 0;
    let most = 0;
    for (const event of readFileSync(`${ffmpeg}.events`, "utf8").trim().split("\n")) {
      running += event.startsWith("start") ? 1 : -1;
      most = Math.max(most, running);
    }
    expect(most).toBe(FFMPEG_CONCURRENCY);
  });

  test("stale cleanup keeps the files of uploads still in progress", async () => {
    const store = db();
    const dataDir = tempDir();
    const ffmpeg = writeFakeFfmpeg(tempDir());
    const upload = accepted({ name: "a.png", bytes: pngBytes(3, 3) });
    const prepared = await prepareOwnerMedia(upload, { db: store, dataDir, ffmpeg });
    if (!prepared.ok) throw new Error(prepared.error);
    // A stale row with the same bytes is pruned while this upload is unstaged.
    const stale = stageOwnerUpload(store, {
      owner: "me",
      threadId: "t",
      sha256: upload.sha256,
      mimeType: upload.mimeType,
      bytes: 1,
      name: "old.png",
      media: { modelCopy: prepared.media.modelCopy! },
    });
    store.run("UPDATE persona_attachments SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", [stale.id]);
    expect(removeStaleOwnerUploads(store, dataDir, "me", new Date())).toBe(1);
    for (const file of prepared.files) expect(existsSync(storedAttachmentPath(dataDir, file.sha256, file.mimeType))).toBe(true);
    prepared.release();
    expect(isDigestInFlight(upload.sha256)).toBe(false);
  });
});
