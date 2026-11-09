import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AttachmentError } from "../persona/attachments.js";
import {
  REVIEW_MEDIA_MIMES,
  REVIEW_MEDIA_STREAM_IDLE_MS,
  REVIEW_MEDIA_UNAVAILABLE,
  ReviewMediaError,
  deleteStoredReviewMedia,
  discardStagedReviewMedia,
  ensureReviewScratchDir,
  extForReviewMime,
  openStoredReviewMedia,
  readMediaForReview,
  reviewMediaDir,
  reviewMediaStream,
  reviewScratchDir,
  sniffReviewMediaMime,
  sniffVideoMime,
  stageReviewMedia,
  statMediaForReview,
  storeReviewMediaCopy,
  storedReviewMediaPath,
} from "./media.js";
import type { ReadReviewMediaOptions } from "./media.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const text = (s: string) => new TextEncoder().encode(s);

/** The stored copy's bytes, read whole, when it is a regular file still matching its digest; else null. */
function readStoredReviewMedia(dataDir: string, sha256: string, mime: string): Uint8Array | null {
  const path = storedReviewMediaPath(dataDir, sha256, mime);
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) return null;
  const bytes = new Uint8Array(readFileSync(path));
  return createHash("sha256").update(bytes).digest("hex") === sha256 ? bytes : null;
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const GIF = text("GIF89a\x01\x00\x01\x00");
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 26, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);

/** An EBML header with DocType `docType`, followed by the start of a Segment. */
function ebml(docType: string): Uint8Array {
  const dt = [...text(docType)];
  const body = [
    0x42, 0x86, 0x81, 0x01, // EBMLVersion 1
    0x42, 0xf7, 0x81, 0x01, // EBMLReadVersion 1
    0x42, 0xf2, 0x81, 0x04, // EBMLMaxIDLength 4
    0x42, 0xf3, 0x81, 0x08, // EBMLMaxSizeLength 8
    0x42, 0x82, 0x80 | dt.length, ...dt, // DocType
    0x42, 0x87, 0x81, 0x04, // DocTypeVersion 4
    0x42, 0x85, 0x81, 0x02, // DocTypeReadVersion 2
  ];
  return Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x80 | body.length, ...body, 0x18, 0x53, 0x80, 0x67, 0x01, 0, 0, 0]);
}
const WEBM = ebml("webm");
const MKV = ebml("matroska");

/** An `ftyp` box with the given major and compatible brands, then padding. */
function ftyp(major: string, ...compatible: string[]): Uint8Array {
  const size = 16 + compatible.length * 4;
  return Uint8Array.from([
    0, 0, 0, size,
    ...text("ftyp"),
    ...text(major),
    0, 0, 0x02, 0x00,
    ...compatible.flatMap((b) => [...text(b)]),
    0, 0, 0, 8, ...text("free"),
  ]);
}
const MP4 = ftyp("isom", "isom", "mp41");

/** A fake home, data dir and work dir; nothing here touches the real ones. */
function world() {
  const root = mkdtempSync(join(tmpdir(), "review-media-"));
  dirs.push(root);
  const home = join(root, "home");
  const dataDir = join(home, ".local", "share", "standup");
  const work = join(root, "work");
  for (const d of [home, dataDir, work]) mkdirSync(d, { recursive: true });
  const env = { DB_PATH: join(dataDir, "standup.db") } as NodeJS.ProcessEnv;
  const write = (path: string, bytes: Uint8Array) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, bytes);
    return path;
  };
  const read = (path: string, extra: Partial<ReadReviewMediaOptions> = {}) =>
    readMediaForReview(path, { home, dataDir, env, ...extra });
  const refusal = (path: string, extra: Partial<ReadReviewMediaOptions> = {}): string => {
    try {
      read(path, extra);
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewMediaError);
      expect(err).toBeInstanceOf(AttachmentError);
      return (err as Error).message;
    }
    throw new Error(`expected ${path} to be refused`);
  };
  const opts = (extra: Partial<ReadReviewMediaOptions> = {}): ReadReviewMediaOptions => ({ home, dataDir, env, ...extra });
  return { root, home, dataDir, work, env, write, read, refusal, opts };
}

describe("sniffing", () => {
  test("images and videos are known by content", () => {
    expect(sniffReviewMediaMime(PNG)).toEqual({ mime: "image/png", kind: "image" });
    expect(sniffReviewMediaMime(JPEG)).toEqual({ mime: "image/jpeg", kind: "image" });
    expect(sniffReviewMediaMime(GIF)).toEqual({ mime: "image/gif", kind: "image" });
    expect(sniffReviewMediaMime(WEBP)).toEqual({ mime: "image/webp", kind: "image" });
    expect(sniffReviewMediaMime(WEBM)).toEqual({ mime: "video/webm", kind: "video" });
    expect(sniffReviewMediaMime(MP4)).toEqual({ mime: "video/mp4", kind: "video" });
  });

  test("WebM needs the webm DocType; Matroska and a bare EBML magic are refused", () => {
    expect(sniffVideoMime(WEBM)).toBe("video/webm");
    expect(sniffVideoMime(MKV)).toBeNull();
    expect(sniffVideoMime(WEBM.slice(0, 4))).toBeNull();
  });

  test("MP4 needs an ftyp box of sane size with a known brand", () => {
    expect(sniffVideoMime(MP4)).toBe("video/mp4");
    expect(sniffVideoMime(ftyp("qt  ", "M4V "))).toBe("video/mp4");
    expect(sniffVideoMime(ftyp("qt  ", "3gp4"))).toBeNull();
    const huge = MP4.slice();
    huge[3] = 0xff;
    expect(sniffVideoMime(huge)).toBeNull();
    const tiny = MP4.slice();
    tiny[3] = 8;
    expect(sniffVideoMime(tiny)).toBeNull();
  });

  test("SVG and text are nothing", () => {
    expect(sniffReviewMediaMime(text("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffReviewMediaMime(text("-----BEGIN CERTIFICATE-----"))).toBeNull();
    expect(sniffReviewMediaMime(new Uint8Array())).toBeNull();
  });
});

describe("readMediaForReview", () => {
  test("reads each type with its digest and size", () => {
    const w = world();
    for (const [name, bytes, mime, kind] of [
      ["a.png", PNG, "image/png", "image"],
      ["a.JPG", JPEG, "image/jpeg", "image"],
      ["a.gif", GIF, "image/gif", "image"],
      ["a.webp", WEBP, "image/webp", "image"],
      ["clip.webm", WEBM, "video/webm", "video"],
      ["clip.mp4", MP4, "video/mp4", "video"],
      ["clip.m4v", MP4, "video/mp4", "video"],
    ] as const) {
      const media = w.read(w.write(join(w.work, name), bytes));
      expect(media.mime).toBe(mime);
      expect(media.kind).toBe(kind);
      expect(media.size).toBe(bytes.length);
      expect(media.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
  });

  test("an image extension takes any image content, but never video, and a video extension only its own container", () => {
    const w = world();
    expect(w.read(w.write(join(w.work, "really-png.jpg"), PNG)).mime).toBe("image/png");
    expect(w.refusal(w.write(join(w.work, "png.mp4"), PNG))).toMatch(/does not hold what its \.mp4 extension says/);
    expect(w.refusal(w.write(join(w.work, "webm.png"), WEBM))).toMatch(/does not hold what its \.png extension says/);
    expect(w.refusal(w.write(join(w.work, "mp4.webm"), MP4))).toMatch(/\.webm extension/);
    expect(w.refusal(w.write(join(w.work, "webm.mp4"), WEBM))).toMatch(/\.mp4 extension/);
    expect(w.refusal(w.write(join(w.work, "movie.webm"), MKV))).toMatch(/checked by content/);
    expect(w.refusal(w.write(join(w.work, "icon.png"), text("<svg/>")))).toMatch(/checked by content/);
    expect(w.refusal(w.write(join(w.work, "icon.svg"), PNG))).toMatch(/only \.png/);
    expect(w.refusal(w.write(join(w.work, "movie.mkv"), MKV))).toMatch(/only \.png/);
  });

  test("the path must be absolute, NUL-free, and name a non-empty regular file", () => {
    const w = world();
    expect(w.refusal("clip.mp4")).toMatch(/must be absolute/);
    expect(w.refusal(`${w.work}/a\0.mp4`)).toMatch(/not a valid file path/);
    expect(w.refusal(join(w.work, "missing.mp4"))).toMatch(/no such file/);
    mkdirSync(join(w.work, "dir.webm"));
    expect(w.refusal(join(w.work, "dir.webm"))).toMatch(/not a regular file/);
    expect(w.refusal(w.write(join(w.work, "empty.mp4"), new Uint8Array()))).toMatch(/is empty/);
  });

  test("images and videos have their own size caps", () => {
    const w = world();
    const bigPng = new Uint8Array(2048);
    bigPng.set(PNG);
    const bigMp4 = new Uint8Array(4096);
    bigMp4.set(MP4);
    const png = w.write(join(w.work, "big.png"), bigPng);
    const mp4 = w.write(join(w.work, "big.mp4"), bigMp4);
    const caps = { imageMaxBytes: 1024, videoMaxBytes: 8192 };
    expect(w.refusal(png, caps)).toMatch(/over 1 KB can't be attached/);
    expect(w.read(mp4, caps).size).toBe(4096);
    expect(w.refusal(mp4, { imageMaxBytes: 1024 * 1024, videoMaxBytes: 2048 })).toMatch(/over 2 KB can't be attached/);
    expect(w.read(png, { videoMaxBytes: 1 }).size).toBe(2048);
  });

  test("credentials under the home are refused, by path and through a symlink", () => {
    const w = world();
    const key = w.write(join(w.home, ".ssh", "id_rsa.png"), PNG);
    expect(w.refusal(key)).toBe(REVIEW_MEDIA_UNAVAILABLE);
    expect(w.refusal("~/.ssh/id_rsa.png")).toMatch(/refused/);
    const aws = w.write(join(w.home, ".aws", "clip.mp4"), MP4);
    symlinkSync(aws, join(w.work, "innocent.mp4"));
    expect(w.refusal(join(w.work, "innocent.mp4"))).toMatch(/refused/);
    // The refusal names only the path given, never where the link resolved.
    expect(w.refusal(join(w.work, "innocent.mp4"))).not.toContain(".aws");
  });

  test("Standup's secrets and database are refused", () => {
    const w = world();
    expect(w.refusal(w.write(join(w.dataDir, "secrets", "owner.png"), PNG))).toMatch(/refused/);
    const dbLike = w.write(join(w.work, "db.mp4"), MP4);
    expect(() => readMediaForReview(dbLike, { home: w.home, dataDir: w.dataDir, env: { DB_PATH: dbLike } })).toThrow(ReviewMediaError);
    const wal = w.write(join(w.dataDir, "standup.db-wal"), MP4);
    expect(w.refusal(wal)).toMatch(/only \.png/);
  });

  test("allowedRoots confines the file", () => {
    const w = world();
    const inside = w.write(join(w.work, "clip.webm"), WEBM);
    const outside = w.write(join(w.root, "elsewhere", "clip.webm"), WEBM);
    expect(w.read(inside, { allowedRoots: [w.work] }).kind).toBe("video");
    expect(w.refusal(outside, { allowedRoots: [w.work] })).toBe(REVIEW_MEDIA_UNAVAILABLE);
    expect(w.refusal(inside, { allowedRoots: [] })).toMatch(/refused/);
  });

  test("the error never carries the file's bytes", () => {
    const w = world();
    expect(w.refusal(w.write(join(w.work, "fake.mp4"), text("AKIAIOSFODNN7EXAMPLE")))).not.toContain("AKIA");
  });
});

describe("stored copies", () => {
  test("paths are built only from a valid digest and a known type", () => {
    const sha = "a".repeat(64);
    expect(storedReviewMediaPath("/data", sha, "video/webm")).toBe(join(reviewMediaDir("/data"), `${sha}.webm`));
    expect(() => storedReviewMediaPath("/data", "../x", "image/png")).toThrow(ReviewMediaError);
    expect(() => storedReviewMediaPath("/data", "g".repeat(64), "image/png")).toThrow(ReviewMediaError);
    expect(() => storedReviewMediaPath("/data", "A".repeat(64), "image/png")).toThrow(ReviewMediaError);
    expect(() => storedReviewMediaPath("/data", sha, "image/svg+xml")).toThrow(ReviewMediaError);
    expect(() => storedReviewMediaPath("/data", sha, "../../x")).toThrow(ReviewMediaError);
    for (const mime of REVIEW_MEDIA_MIMES) expect(extForReviewMime(mime)).toMatch(/^[a-z0-9]+$/);
  });

  test("store and read round-trip, owner-only and idempotent", () => {
    const w = world();
    const src = w.write(join(w.work, "clip.webm"), WEBM);
    const { path, media } = storeReviewMediaCopy(src, w.opts());
    expect(path).toBe(join(reviewMediaDir(w.dataDir), `${media.sha256}.webm`));
    expect([...readFileSync(path)]).toEqual([...WEBM]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(reviewMediaDir(w.dataDir)).mode & 0o777).toBe(0o700);
    expect(storeReviewMediaCopy(src, w.opts()).path).toBe(path);
    expect([...readStoredReviewMedia(w.dataDir, media.sha256, "video/webm")!]).toEqual([...WEBM]);
    expect(readStoredReviewMedia(w.dataDir, "0".repeat(64), "video/webm")).toBeNull();
    // Nothing staged is left behind.
    expect(readdirSync(reviewMediaDir(w.dataDir))).toEqual([`${media.sha256}.webm`]);
  });

  test("a tampered copy is not served, and storing again repairs it", () => {
    const w = world();
    const src = w.write(join(w.work, "clip.mp4"), MP4);
    const { path, media } = storeReviewMediaCopy(src, w.opts());
    writeFileSync(path, PNG);
    expect(readStoredReviewMedia(w.dataDir, media.sha256, "video/mp4")).toBeNull();
    expect(openStoredReviewMedia(w.dataDir, media.sha256, "video/mp4", media.size)).toBeNull();
    storeReviewMediaCopy(src, w.opts());
    expect(readStoredReviewMedia(w.dataDir, media.sha256, "video/mp4")).not.toBeNull();
  });

  test("a symlink in a copy's place is not followed, and storing replaces it", () => {
    const w = world();
    const src = w.write(join(w.work, "a.png"), PNG);
    const { path, media } = storeReviewMediaCopy(src, w.opts());
    const target = w.write(join(w.work, "same-bytes.png"), PNG);
    unlinkSync(path);
    symlinkSync(target, path);
    expect(readStoredReviewMedia(w.dataDir, media.sha256, "image/png")).toBeNull();
    expect(openStoredReviewMedia(w.dataDir, media.sha256, "image/png", media.size)).toBeNull();
    storeReviewMediaCopy(src, w.opts());
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(readStoredReviewMedia(w.dataDir, media.sha256, "image/png")).not.toBeNull();
  });

  test("a file larger than one chunk is copied and hashed whole", () => {
    const w = world();
    const big = new Uint8Array(2 * 1024 * 1024 + 123);
    big.set(MP4);
    for (let i = MP4.length; i < big.length; i++) big[i] = i % 253;
    const src = w.write(join(w.work, "long.mp4"), big);
    const { path, media } = storeReviewMediaCopy(src, w.opts());
    expect(media.size).toBe(big.length);
    expect(media.sha256).toBe(createHash("sha256").update(big).digest("hex"));
    expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(media.sha256);
  });

  test("a staged copy is invisible until committed and gone when discarded", () => {
    const w = world();
    const staged = stageReviewMedia(w.write(join(w.work, "a.png"), PNG), w.opts());
    expect(existsSync(storedReviewMediaPath(w.dataDir, staged.sha256, staged.mime))).toBe(false);
    discardStagedReviewMedia(staged);
    expect(readdirSync(reviewMediaDir(w.dataDir))).toEqual([]);
  });

  test("a content refusal leaves nothing staged", () => {
    const w = world();
    expect(() => stageReviewMedia(w.write(join(w.work, "fake.png"), text("not an image")), w.opts())).toThrow(ReviewMediaError);
    expect(readdirSync(reviewMediaDir(w.dataDir))).toEqual([]);
  });
});

describe("serving stored copies", () => {
  test("opens a regular file of the recorded size and streams any byte range", async () => {
    const w = world();
    const { media } = storeReviewMediaCopy(w.write(join(w.work, "clip.webm"), WEBM), w.opts());
    expect(openStoredReviewMedia(w.dataDir, media.sha256, media.mime, media.size + 1)).toBeNull();
    const whole = openStoredReviewMedia(w.dataDir, media.sha256, media.mime, media.size)!;
    expect(whole.size).toBe(WEBM.length);
    expect([...new Uint8Array(await new Response(reviewMediaStream(whole.fd, 0, whole.size - 1)).arrayBuffer())]).toEqual([...WEBM]);
    const part = openStoredReviewMedia(w.dataDir, media.sha256, media.mime, media.size)!;
    expect([...new Uint8Array(await new Response(reviewMediaStream(part.fd, 3, 9)).arrayBuffer())]).toEqual([...WEBM.subarray(3, 10)]);
  });

  test("a symlinked stored-copy dir is not served from", () => {
    const w = world();
    const { media } = storeReviewMediaCopy(w.write(join(w.work, "a.png"), PNG), w.opts());
    const moved = join(w.root, "moved-media");
    renameSync(reviewMediaDir(w.dataDir), moved);
    symlinkSync(moved, reviewMediaDir(w.dataDir));
    expect(openStoredReviewMedia(w.dataDir, media.sha256, media.mime, media.size)).toBeNull();
  });

  test("a symlinked stored-copy dir is not deleted through", () => {
    const w = world();
    const { media } = storeReviewMediaCopy(w.write(join(w.work, "a.png"), PNG), w.opts());
    const moved = join(w.root, "moved-media");
    renameSync(reviewMediaDir(w.dataDir), moved);
    symlinkSync(moved, reviewMediaDir(w.dataDir));
    deleteStoredReviewMedia(w.dataDir, media.sha256, media.mime);
    expect(readdirSync(moved)).toHaveLength(1);
    rmSync(reviewMediaDir(w.dataDir));
    renameSync(moved, reviewMediaDir(w.dataDir));
    deleteStoredReviewMedia(w.dataDir, media.sha256, media.mime);
    expect(readdirSync(reviewMediaDir(w.dataDir))).toEqual([]);
  });

  test("a stream read slowly outlives its idle timeout, which every read re-arms; the default allows a long pause", async () => {
    expect(REVIEW_MEDIA_STREAM_IDLE_MS).toBe(15 * 60 * 1000);
    const w = world();
    const bytes = new Uint8Array(3 * 1024 * 1024 + 5).fill(7);
    bytes.set(PNG);
    const { media } = storeReviewMediaCopy(w.write(join(w.work, "big.png"), bytes), w.opts());
    const opened = openStoredReviewMedia(w.dataDir, media.sha256, media.mime, media.size)!;
    const reader = reviewMediaStream(opened.fd, 0, opened.size - 1, 80).getReader();
    let total = 0;
    for (;;) {
      await Bun.sleep(50);
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
    }
    expect(total).toBe(bytes.length);
  });
});

describe("review media hardening", () => {
  test("a hard link to a file outside the allowed roots is refused", () => {
    const w = world();
    const outside = w.write(join(w.root, "outside", "private.png"), PNG);
    const linked = join(w.work, "hl.png");
    linkSync(outside, linked);
    expect(w.refusal(linked, { allowedRoots: [w.work] })).toMatch(/other hard links/);
  });

  test("a FIFO is refused without blocking", () => {
    const w = world();
    const fifo = join(w.work, "pipe.png");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const started = Date.now();
    expect(w.refusal(fifo, { allowedRoots: [w.work] })).toMatch(/not a regular file/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("a denied or out-of-root path gets one refusal whether or not the file exists", () => {
    const w = world();
    w.write(join(w.home, ".aws", "x.png"), PNG);
    const exists = w.refusal(join(w.home, ".aws", "x.png"), { allowedRoots: [w.work] });
    const missing = w.refusal(join(w.home, ".aws", "y.png"), { allowedRoots: [w.work] });
    const outsideMissing = w.refusal(join(w.root, "nowhere", "z.png"), { allowedRoots: [w.work] });
    const insideMissing = w.refusal(join(w.work, "gone.png"), { allowedRoots: [w.work] });
    expect(new Set([exists, missing, outsideMissing, insideMissing])).toEqual(new Set([REVIEW_MEDIA_UNAVAILABLE]));
  });

  test("a symlinked stored-copy dir is refused, not written through", () => {
    const w = world();
    const victim = join(w.root, "victim");
    mkdirSync(victim, { mode: 0o755 });
    symlinkSync(victim, reviewMediaDir(w.dataDir));
    expect(() => storeReviewMediaCopy(w.write(join(w.work, "a.png"), PNG), w.opts())).toThrow(ReviewMediaError);
    expect(readdirSync(victim)).toEqual([]);
    expect(statSync(victim).mode & 0o777).toBe(0o755);
  });

  test("a launch's scratch dir is created owner-only under the data dir; unsafe ids and symlinks are refused", () => {
    const w = world();
    const dir = ensureReviewScratchDir(w.dataDir, "launch-1");
    expect(dir).toBe(join(w.dataDir, "review-scratch", "launch-1"));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(w.dataDir, "review-scratch")).mode & 0o777).toBe(0o700);
    expect(ensureReviewScratchDir(w.dataDir, "launch-1")).toBe(dir);
    for (const bad of ["", "..", ".hidden", "a/b", "../x", "x".repeat(200)]) {
      expect(() => reviewScratchDir(w.dataDir, bad)).toThrow(ReviewMediaError);
    }
    const elsewhere = join(w.root, "elsewhere-scratch");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(w.dataDir, "review-scratch", "launch-2"));
    expect(() => ensureReviewScratchDir(w.dataDir, "launch-2")).toThrow(ReviewMediaError);
  });

  test("a file in the scratch dir is accepted when the scratch dir is an allowed root", () => {
    const w = world();
    const scratch = ensureReviewScratchDir(w.dataDir, "launch-1");
    const shot = w.write(join(scratch, "shot.png"), PNG);
    expect(w.read(shot, { allowedRoots: [scratch], dataDirExcept: [scratch] }).mime).toBe("image/png");
    expect(w.refusal(w.write(join(w.work, "a.png"), PNG), { allowedRoots: [scratch], dataDirExcept: [scratch] })).toBe(REVIEW_MEDIA_UNAVAILABLE);
  });

  test("inside the data dir only the excepted dirs are reachable, whatever the allowed roots say", () => {
    const w = world();
    const scratch = ensureReviewScratchDir(w.dataDir, "launch-1");
    const other = ensureReviewScratchDir(w.dataDir, "launch-2");
    const own = w.write(join(scratch, "shot.png"), PNG);
    const theirs = w.write(join(other, "shot.png"), PNG);
    const loose = w.write(join(w.dataDir, "loose.png"), PNG);
    // A root that contains the whole data dir (an adopted session run from it, say).
    const wide = { allowedRoots: [w.dataDir], dataDirExcept: [scratch] };
    expect(w.read(own, wide).mime).toBe("image/png");
    expect(w.refusal(theirs, wide)).toBe(REVIEW_MEDIA_UNAVAILABLE);
    expect(w.refusal(loose, wide)).toBe(REVIEW_MEDIA_UNAVAILABLE);
    // A symlink from the scratch dir out to elsewhere in the data dir is refused as resolved.
    symlinkSync(loose, join(scratch, "link.png"));
    expect(w.refusal(join(scratch, "link.png"), wide)).toBe(REVIEW_MEDIA_UNAVAILABLE);
    // No exception at all: the scratch dir is refused too.
    expect(w.refusal(own, { allowedRoots: [scratch] })).toBe(REVIEW_MEDIA_UNAVAILABLE);
  });

  test("statMediaForReview reports the size without reading content", () => {
    const w = world();
    expect(statMediaForReview(w.write(join(w.work, "fake.png"), text("not an image at all")), w.opts())).toBe(19);
  });
});
