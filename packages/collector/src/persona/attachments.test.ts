import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { exampleCorpProfile } from "../org-profile/fixtures/example-corp.js";
import { setActiveOrgProfile } from "../org-profile/load.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  AttachmentError,
  attachmentsDir,
  deniedRoots,
  readImageForAttachment,
  readStoredAttachment,
  sniffImageMime,
  storeAttachmentCopy,
  storedAttachmentPath,
} from "./attachments.js";

// The example.corp fixture profile: its SSO dir `.corp-sso` is a credential location too.
beforeAll(() => setActiveOrgProfile(exampleCorpProfile()));
afterAll(() => setActiveOrgProfile());

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const GIF = new TextEncoder().encode("GIF89a\x01\x00\x01\x00");
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 26, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);

/** A fake home, data dir and work dir; nothing here touches the real ones. */
function world() {
  const root = tempDir("persona-attach-");
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
  const read = (path: string, maxBytes?: number) => readImageForAttachment(path, { home, dataDir, env, maxBytes });
  const refusal = (path: string, maxBytes?: number): string => {
    try {
      read(path, maxBytes);
    } catch (err) {
      expect(err).toBeInstanceOf(AttachmentError);
      return (err as Error).message;
    }
    throw new Error(`expected ${path} to be refused`);
  };
  return { root, home, dataDir, work, env, write, read, refusal };
}

describe("sniffImageMime", () => {
  test("knows PNG, JPEG, GIF and WebP by their leading bytes, and nothing else", () => {
    expect(sniffImageMime(PNG)).toBe("image/png");
    expect(sniffImageMime(JPEG)).toBe("image/jpeg");
    expect(sniffImageMime(GIF)).toBe("image/gif");
    expect(sniffImageMime(new TextEncoder().encode("GIF87a.."))).toBe("image/gif");
    expect(sniffImageMime(WEBP)).toBe("image/webp");
    expect(sniffImageMime(new TextEncoder().encode("RIFF....WAVEfmt "))).toBeNull();
    expect(sniffImageMime(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffImageMime(new TextEncoder().encode("-----BEGIN OPENSSH PRIVATE KEY-----"))).toBeNull();
    expect(sniffImageMime(PNG.slice(0, 4))).toBeNull();
    expect(sniffImageMime(new Uint8Array())).toBeNull();
  });
});

describe("readImageForAttachment", () => {
  test("reads each image type, by content, with its digest and base name", () => {
    const w = world();
    for (const [name, bytes, mime] of [
      ["shot.png", PNG, "image/png"],
      ["photo.JPG", JPEG, "image/jpeg"],
      ["photo.jpeg", JPEG, "image/jpeg"],
      ["anim.gif", GIF, "image/gif"],
      ["pic.webp", WEBP, "image/webp"],
    ] as const) {
      const image = w.read(w.write(join(w.work, name), bytes));
      expect(image.mimeType).toBe(mime);
      expect(image.name).toBe(name);
      expect([...image.bytes]).toEqual([...bytes]);
      expect(image.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("the type comes from the content: a PNG named .jpg is a PNG, and a disguised file is refused", () => {
    const w = world();
    expect(w.read(w.write(join(w.work, "really-a-png.jpg"), PNG)).mimeType).toBe("image/png");
    expect(w.refusal(w.write(join(w.work, "notes.png"), new TextEncoder().encode("just text")))).toMatch(/not a PNG, JPEG, GIF or WebP/);
    expect(w.refusal(w.write(join(w.work, "icon.png"), new TextEncoder().encode("<svg/>")))).toMatch(/checked by content/);
  });

  test("only image extensions are taken", () => {
    const w = world();
    expect(w.refusal(w.write(join(w.work, "shot.svg"), PNG))).toMatch(/only \.png, \.jpg/);
    expect(w.refusal(w.write(join(w.work, "id_rsa"), PNG))).toMatch(/only \.png, \.jpg/);
    expect(w.refusal(w.write(join(w.work, "x.png.txt"), PNG))).toMatch(/only \.png, \.jpg/);
  });

  test("size is capped, and empty files are refused", () => {
    const w = world();
    const big = new Uint8Array(2048);
    big.set(PNG);
    const path = w.write(join(w.work, "big.png"), big);
    expect(w.refusal(path, 1024)).toMatch(/over 1 KB can't be attached/);
    expect(w.read(path, 4096).bytes.length).toBe(2048);
    expect(w.refusal(w.write(join(w.work, "empty.png"), new Uint8Array()))).toMatch(/is empty/);
  });

  test("the path must be absolute (or ~/), must exist and must be a regular file", () => {
    const w = world();
    expect(w.refusal("shot.png")).toMatch(/must be absolute/);
    expect(w.refusal("./shot.png")).toMatch(/must be absolute/);
    expect(w.refusal("   ")).toMatch(/path is required/);
    expect(w.refusal(join(w.work, "missing.png"))).toMatch(/no such file/);
    mkdirSync(join(w.work, "dir.png"));
    expect(w.refusal(join(w.work, "dir.png"))).toMatch(/not a regular file/);
    expect(w.refusal(`${w.work}/a\0.png`)).toMatch(/not a valid file path/);
  });

  test("~/ expands to the owner's home", () => {
    const w = world();
    w.write(join(w.home, "Pictures", "shot.png"), PNG);
    expect(w.read("~/Pictures/shot.png").mimeType).toBe("image/png");
  });

  test("credential directories in the home are refused, even holding a real image", () => {
    const w = world();
    for (const dir of [".aws", ".ssh", ".corp-sso", ".gnupg", ".kube", ".docker", join(".config", "standup")]) {
      const path = w.write(join(w.home, dir, "looks-like.png"), PNG);
      expect(w.refusal(path)).toMatch(/refused: that path is under a location Standup never reads images from/);
      expect(w.refusal(`~/${dir}/looks-like.png`)).toMatch(/refused/);
    }
  });

  test("the org profile's SSO dirs are refused roots, the active profile's by default", () => {
    expect(deniedRoots({ home: "/h", dataDir: "/d", env: {}, ssoDirs: [".team-sso"] })).toContain("/h/.team-sso");
    expect(deniedRoots({ home: "/h", dataDir: "/d", env: {} })).toContain("/h/.corp-sso");
    expect(deniedRoots({ home: "/h", dataDir: "/d", env: {}, ssoDirs: [] }).some((r) => r.includes("sso"))).toBe(false);
  });

  test("Standup's own secrets and database are refused; the rest of the data dir (worktrees) is not", () => {
    const w = world();
    expect(w.refusal(w.write(join(w.dataDir, "secrets", "owner.png"), PNG))).toMatch(/refused/);
    // A database path that happens to look like an image is still the database.
    const dbLike = join(w.work, "db.png");
    w.write(dbLike, PNG);
    expect(() => readImageForAttachment(dbLike, { home: w.home, dataDir: w.dataDir, env: { DB_PATH: dbLike } })).toThrow(/refused/);
    const worktreeShot = w.write(join(w.dataDir, "worktrees", "proj", "branch", "screenshot.png"), PNG);
    expect(w.read(worktreeShot).mimeType).toBe("image/png");
  });

  test("system pseudo-filesystems and /etc are refused", () => {
    const w = world();
    expect(w.refusal("/proc/self/root/tmp/x.png")).toMatch(/refused|no such file/);
    expect(w.refusal("/proc/1/x.png")).toMatch(/refused|no such file/);
    expect(w.refusal("/etc/x.png")).toMatch(/refused|no such file/);
    expect(w.refusal("/dev/null.png")).toMatch(/refused|no such file/);
  });

  test("a symlink is judged by where it really points", () => {
    const w = world();
    const secret = w.write(join(w.home, ".ssh", "key.png"), PNG);
    const link = join(w.work, "innocent.png");
    symlinkSync(secret, link);
    expect(w.refusal(link)).toMatch(/refused/);

    // A symlinked directory into a denied root too.
    const awsDir = join(w.home, ".aws");
    w.write(join(awsDir, "creds.png"), PNG);
    symlinkSync(awsDir, join(w.work, "pics"));
    expect(w.refusal(join(w.work, "pics", "creds.png"))).toMatch(/refused/);

    // A symlink to an ordinary image is fine, named by its target.
    const real = w.write(join(w.work, "real.png"), PNG);
    symlinkSync(real, join(w.work, "alias.png"));
    expect(w.read(join(w.work, "alias.png")).name).toBe("real.png");
  });

  test("the error never carries the file's bytes", () => {
    const w = world();
    const path = w.write(join(w.work, "fake.png"), new TextEncoder().encode("AKIASECRETSECRETSECRET"));
    expect(w.refusal(path)).not.toContain("AKIA");
  });
});

describe("stored copies", () => {
  test("are content-addressed under the data dir, owner-only, written once", () => {
    const w = world();
    const image = w.read(w.write(join(w.work, "a.png"), PNG));
    const path = storeAttachmentCopy(w.dataDir, image);
    expect(path).toBe(join(attachmentsDir(w.dataDir), `${image.sha256}.png`));
    expect([...readFileSync(path)]).toEqual([...PNG]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(attachmentsDir(w.dataDir)).mode & 0o777).toBe(0o700);

    const again = w.read(w.write(join(w.work, "copy-of-a.png"), PNG));
    expect(storeAttachmentCopy(w.dataDir, again)).toBe(path);
    expect([...readStoredAttachment(w.dataDir, image.sha256, "image/png")!]).toEqual([...PNG]);
  });

  test("a copy that no longer matches its digest, or is missing, is not served", () => {
    const w = world();
    const image = w.read(w.write(join(w.work, "b.png"), PNG));
    const path = storeAttachmentCopy(w.dataDir, image);
    writeFileSync(path, JPEG);
    expect(readStoredAttachment(w.dataDir, image.sha256, "image/png")).toBeNull();
    // Storing again repairs it.
    storeAttachmentCopy(w.dataDir, image);
    expect(readStoredAttachment(w.dataDir, image.sha256, "image/png")).not.toBeNull();
    expect(readStoredAttachment(w.dataDir, "0".repeat(64), "image/png")).toBeNull();
  });

  test("a digest that isn't one can't name a path", () => {
    expect(() => storedAttachmentPath("/data", "../../etc/passwd", "image/png")).toThrow(AttachmentError);
    expect(readStoredAttachment("/data", "../secrets/owner", "image/png")).toBeNull();
  });

  test("each media type is stored under its own extension", () => {
    const sha = "a".repeat(64);
    const cases: Array<[Parameters<typeof storedAttachmentPath>[2], string]> = [
      ["image/png", "png"],
      ["image/jpeg", "jpg"],
      ["image/gif", "gif"],
      ["image/webp", "webp"],
      ["video/mp4", "mp4"],
      ["video/quicktime", "mov"],
      ["video/webm", "webm"],
    ];
    for (const [mime, ext] of cases) expect(storedAttachmentPath("/data", sha, mime)).toBe(`/data/persona-attachments/${sha}.${ext}`);
    expect(() => storedAttachmentPath("/data", sha, "text/html" as never)).toThrow(AttachmentError);
  });
});
