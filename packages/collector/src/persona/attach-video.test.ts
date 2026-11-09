import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { exampleCorpProfile } from "../org-profile/fixtures/example-corp.js";
import { setActiveOrgProfile } from "../org-profile/load.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PERSONA_VIDEO_MAX_BYTES } from "@standup/shared";
import { createStore } from "@standup/store";
import { AttachmentError, storedAttachmentPath } from "./attachments.js";
import { isDigestInFlight, mp4VideoCodecs, posterTime, prepareAttachedVideo, readVideoForAttachment } from "./media.js";
import type { ValidatedVideo } from "./media.js";
import {
  FAKE_FFMPEG_JPEG,
  movBytes,
  mp4Bytes,
  pngBytes,
  trackedMp4Bytes,
  webmBytes,
  writeFakeFfmpeg,
} from "../test-support/persona-media.js";

// The example.corp fixture profile: its SSO dir `.corp-sso` is a credential location too.
beforeAll(() => setActiveOrgProfile(exampleCorpProfile()));
afterAll(() => setActiveOrgProfile());

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix = "persona-video-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const H264 = trackedMp4Bytes({ codec: "avc1", audio: true });

/** An MP4 whose `moov` holds `n` empty `free` boxes before an H.264 track, which the box limit never reaches. */
function manyBoxes(n: number): Uint8Array {
  const track = trackedMp4Bytes({ codec: "avc1" });
  const view = new DataView(track.buffer);
  // The top-level boxes before `moov` (ftyp, free) are kept as they are.
  let moovAt = 0;
  while (new TextDecoder().decode(track.subarray(moovAt + 4, moovAt + 8)) !== "moov") moovAt += view.getUint32(moovAt);
  const moovSize = view.getUint32(moovAt);
  const out = new Uint8Array(moovAt + 8 + n * 8 + (moovSize - 8));
  out.set(track.subarray(0, moovAt));
  const outView = new DataView(out.buffer);
  outView.setUint32(moovAt, 8 + n * 8 + (moovSize - 8));
  out.set(new TextEncoder().encode("moov"), moovAt + 4);
  for (let i = 0; i < n; i++) {
    outView.setUint32(moovAt + 8 + i * 8, 8);
    out.set(new TextEncoder().encode("free"), moovAt + 12 + i * 8);
  }
  out.set(track.subarray(moovAt + 8, moovAt + moovSize), moovAt + 8 + n * 8);
  return out;
}

/** A fake home, data dir and work dir; nothing here touches the real ones. */
function world() {
  const root = tempDir();
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
  const read = (path: string, maxBytes?: number) => readVideoForAttachment(path, { home, dataDir, env, maxBytes });
  const refusal = (path: string, maxBytes?: number): string => {
    try {
      read(path, maxBytes);
    } catch (err) {
      expect(err).toBeInstanceOf(AttachmentError);
      return (err as Error).message;
    }
    throw new Error(`expected ${path} to be refused`);
  };
  return { home, dataDir, work, write, read, refusal };
}

describe("mp4VideoCodecs", () => {
  test("reads each video track's sample entry from moov/trak/mdia/minf/stbl/stsd, skipping audio", () => {
    const cases: Array<{ label: string; bytes: Uint8Array; want: string[] }> = [
      { label: "H.264 with audio", bytes: H264, want: ["avc1"] },
      { label: "H.264, parameter sets in-band", bytes: trackedMp4Bytes({ codec: "avc3" }), want: ["avc3"] },
      { label: "HEVC", bytes: trackedMp4Bytes({ codec: "hvc1" }), want: ["hvc1"] },
      { label: "audio only", bytes: trackedMp4Bytes({ audio: true }), want: [] },
      { label: "ftyp alone (no moov)", bytes: mp4Bytes(256), want: [] },
      { label: "moov cut short", bytes: H264.slice(0, 120), want: [] },
      { label: "two video tracks", bytes: trackedMp4Bytes({ codec: ["avc1", "hvc1"] }), want: ["avc1", "hvc1"] },
      { label: "a few empty boxes before the track", bytes: manyBoxes(3), want: ["avc1"] },
      { label: "a moov of 100k empty boxes stops at the box limit", bytes: manyBoxes(100_000), want: [] },
    ];
    for (const c of cases) expect({ label: c.label, codecs: mp4VideoCodecs(c.bytes) }).toEqual({ label: c.label, codecs: c.want });
  });
});

describe("readVideoForAttachment", () => {
  test("accepts an H.264 MP4 and a WebM, by content, with digest and base name", () => {
    const w = world();
    const cases = [
      { name: "flow.mp4", bytes: H264, mime: "video/mp4" },
      { name: "Launch.M4V", bytes: H264, mime: "video/mp4" },
      { name: "cold-load.webm", bytes: webmBytes(), mime: "video/webm" },
    ] as const;
    for (const c of cases) {
      const video = w.read(w.write(join(w.work, c.name), c.bytes));
      expect({ name: video.name, mime: video.mimeType, size: video.bytes.length }).toEqual({ name: c.name, mime: c.mime, size: c.bytes.length });
      expect(video.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("refuses what isn't an H.264 MP4 or a WebM, whatever it is named", () => {
    const w = world();
    const cases: Array<{ label: string; name: string; bytes: Uint8Array; want: RegExp }> = [
      { label: "text renamed .mp4", name: "notes.mp4", bytes: new TextEncoder().encode("just some text, not a video"), want: /not an MP4 or WebM video \(checked by content\)/ },
      { label: "a PNG renamed .mp4", name: "shot.mp4", bytes: pngBytes(), want: /not an MP4 or WebM video/ },
      { label: "a MOV renamed .mp4", name: "clip.mp4", bytes: movBytes(64), want: /not an MP4 or WebM video/ },
      { label: "Matroska renamed .webm", name: "film.webm", bytes: webmBytes("matroska"), want: /not an MP4 or WebM video/ },
      { label: "a WebM renamed .mp4", name: "rec.mp4", bytes: webmBytes(), want: /named \.mp4 but its content is a WebM video/ },
      { label: "an MP4 renamed .webm", name: "rec.webm", bytes: H264, want: /named \.webm but its content is an MP4 \(H\.264\) video/ },
      { label: "HEVC MP4", name: "phone.mp4", bytes: trackedMp4Bytes({ codec: "hvc1" }), want: /has hvc1 video; only H\.264 MP4s \(or WebM\)/ },
      { label: "an HEVC track beside an H.264 one", name: "two.mp4", bytes: trackedMp4Bytes({ codec: ["avc1", "hvc1"] }), want: /has hvc1 video/ },
      { label: "MP4 without a video track", name: "voice.mp4", bytes: trackedMp4Bytes({ audio: true }), want: /no video track/ },
      { label: "MP4 header without moov", name: "stub.mp4", bytes: mp4Bytes(256), want: /no video track/ },
      { label: "a video extension it doesn't take", name: "clip.mov", bytes: H264, want: /only \.mp4, \.m4v and \.webm/ },
      { label: "no extension", name: "clip", bytes: H264, want: /only \.mp4, \.m4v and \.webm/ },
      { label: "empty", name: "empty.mp4", bytes: new Uint8Array(), want: /is empty/ },
    ];
    for (const c of cases) {
      expect({ label: c.label, refused: w.refusal(w.write(join(w.work, c.name), c.bytes)) }).toEqual({
        label: c.label,
        refused: expect.stringMatching(c.want),
      });
    }
  });

  test("an oversize video is refused before it is read; the cap defaults to 50 MB and can be set", () => {
    const w = world();
    const big = new Uint8Array(4096);
    big.set(H264);
    const path = w.write(join(w.work, "big.mp4"), big);
    expect(w.refusal(path, 2048)).toMatch(/big\.mp4 is 4 KB; videos over 2 KB can't be attached/);
    expect(w.read(path, 8192).bytes.length).toBe(4096);
    // The default cap: a sparse file one byte over it, so nothing is written or read.
    const huge = w.write(join(w.work, "huge.webm"), webmBytes());
    truncateSync(huge, PERSONA_VIDEO_MAX_BYTES + 1);
    expect(w.refusal(huge)).toMatch(/videos over 50\.0 MB can't be attached/);
  });

  test("credential, system and Standup-secret locations are refused, symlinks judged by their target", () => {
    const w = world();
    const cases: Array<{ label: string; path: () => string }> = [
      ...[".aws", ".ssh", ".corp-sso", ".gnupg", ".kube", ".docker", join(".config", "standup")].map((dir) => ({
        label: `~/${dir}`,
        path: () => w.write(join(w.home, dir, "rec.mp4"), H264),
      })),
      { label: "Standup secrets", path: () => w.write(join(w.dataDir, "secrets", "rec.mp4"), H264) },
      { label: "~/ form", path: () => (w.write(join(w.home, ".ssh", "tilde.webm"), webmBytes()), "~/.ssh/tilde.webm") },
      {
        label: "a symlink into ~/.aws",
        path: () => {
          const secret = w.write(join(w.home, ".aws", "creds.webm"), webmBytes());
          const link = join(w.work, "innocent.webm");
          symlinkSync(secret, link);
          return link;
        },
      },
    ];
    for (const c of cases) {
      expect({ label: c.label, refused: w.refusal(c.path()) }).toEqual({
        label: c.label,
        refused: expect.stringMatching(/refused: that path is under a location Persona may not attach from/),
      });
    }
    for (const path of ["/etc/x.mp4", "/proc/self/x.webm", "/dev/x.mp4"]) {
      expect({ path, refused: w.refusal(path) }).toEqual({ path, refused: expect.stringMatching(/refused|no such file/) });
    }
    // A worker's worktree under the data dir is fine.
    expect(w.read(w.write(join(w.dataDir, "worktrees", "proj", "b", "flow.webm"), webmBytes())).mimeType).toBe("video/webm");
  });

  test("a guest's allowed roots hold: a video elsewhere is refused", () => {
    const w = world();
    const outside = w.write(join(w.work, "elsewhere", "rec.webm"), webmBytes());
    const inside = w.write(join(w.work, "mine", "rec.webm"), webmBytes());
    const read = (path: string) => readVideoForAttachment(path, { home: w.home, dataDir: w.dataDir, allowedRoots: [join(w.work, "mine")] });
    expect(read(inside).mimeType).toBe("video/webm");
    expect(() => read(outside)).toThrow(/attaches only videos inside its own workers' worktrees/);
  });
});

describe("posterTime", () => {
  test("a tenth of the way in, at most a second; the start when the length is unknown", () => {
    const cases: Array<{ duration: number | undefined; want: number }> = [
      { duration: undefined, want: 0 },
      { duration: 4, want: 0.4 },
      { duration: 2.345, want: 0.235 },
      { duration: 10, want: 1 },
      { duration: 600, want: 1 },
    ];
    for (const c of cases) expect({ duration: c.duration, at: posterTime(c.duration) }).toEqual({ duration: c.duration, at: c.want });
  });
});

describe("prepareAttachedVideo", () => {
  const video = (bytes: Uint8Array = H264, name = "flow.mp4"): ValidatedVideo => ({
    bytes,
    mimeType: "video/mp4",
    sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    name,
  });

  test("with ffmpeg: stores the copy, reads its length and takes a poster frame at a tenth of the way in", async () => {
    const dataDir = tempDir();
    const ffmpeg = writeFakeFfmpeg(tempDir(), { duration: "00:00:04.00" });
    const v = video();
    const prepared = await prepareAttachedVideo(v, { db: createStore(":memory:").db, dataDir, ffmpeg });
    if (!prepared.ok) throw new Error(prepared.error);
    expect(prepared.media.durationSec).toBe(4);
    const poster = prepared.media.poster!;
    expect(poster.mimeType).toBe("image/jpeg");
    expect([...readFileSync(storedAttachmentPath(dataDir, poster.sha256, "image/jpeg"))]).toEqual([...FAKE_FFMPEG_JPEG]);
    expect([...readFileSync(storedAttachmentPath(dataDir, v.sha256, "video/mp4"))]).toEqual([...H264]);
    const runs = readFileSync(`${ffmpeg}.log`, "utf8").trim().split("\n");
    expect(runs).toHaveLength(2);
    // The frame run seeks to 0.4 s and forces the MP4 demuxer.
    expect(runs[1]).toContain("-ss 0.400");
    expect(runs[1]).toContain("-f mov -i file:");
    // Held from cleanup until the row that references the files is written.
    expect(isDigestInFlight(v.sha256)).toBe(true);
    prepared.release();
    expect(isDigestInFlight(v.sha256)).toBe(false);
  });

  test("without ffmpeg the video is kept with no poster", async () => {
    const dataDir = tempDir();
    const v = video(webmBytes(), "rec.webm");
    const prepared = await prepareAttachedVideo({ ...v, mimeType: "video/webm" }, { db: createStore(":memory:").db, dataDir, ffmpeg: null });
    if (!prepared.ok) throw new Error(prepared.error);
    prepared.release();
    expect(prepared.media).toEqual({});
    expect(existsSync(storedAttachmentPath(dataDir, v.sha256, "video/webm"))).toBe(true);
  });

  test("a video ffmpeg can't decode is refused and leaves no file behind", async () => {
    const dataDir = tempDir();
    const v = video();
    const prepared = await prepareAttachedVideo(v, {
      db: createStore(":memory:").db,
      dataDir,
      ffmpeg: writeFakeFfmpeg(tempDir(), { frames: "fail" }),
    });
    expect(prepared).toEqual({ ok: false, error: "flow.mp4 couldn't be decoded as a video" });
    expect(existsSync(storedAttachmentPath(dataDir, v.sha256, "video/mp4"))).toBe(false);
    expect(isDigestInFlight(v.sha256)).toBe(false);
  });
});
