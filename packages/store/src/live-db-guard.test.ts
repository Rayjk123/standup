import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "fs";
import { tmpdir, userInfo } from "os";
import { join } from "path";
import { createStore } from "./store.js";
import { assertNotLiveDbInTest, isLiveDbPath, isTestRun, scratchDataDirBase, sqliteFilePath } from "./live-db-guard.js";

// Every path below is built under a mkdtemp fake home, so even a broken guard
// only ever opens a scratch file.
let root: string;
let fakeHome: string;
let savedHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "live-db-guard-"));
  fakeHome = join(root, "home");
  mkdirSync(fakeHome);
  savedHome = process.env.HOME;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

const data = (home: string, ...rest: string[]) => join(home, ".local", "share", "standup", ...rest);

describe("isTestRun", () => {
  test.each([
    [{ STANDUP_TEST: "1" }, true],
    [{ NODE_ENV: "test" }, true],
    [{ NODE_ENV: "production" }, false],
    [{}, false],
  ] as const)("%p -> %p", (env, want) => {
    expect(isTestRun(env as NodeJS.ProcessEnv)).toBe(want);
  });

  test("bun test marks this process as a test run", () => {
    expect(isTestRun()).toBe(true);
  });
});

describe("isLiveDbPath", () => {
  test.each([
    ["the default DB", ["standup.db"], true],
    ["another DB in the data dir", ["other.db"], true],
    ["a DB deeper in the data dir", ["internal", "x.db"], true],
    ["a scratch DB in a worktree", ["worktrees", "proj", "feat", "t.db"], false],
  ])("%s -> %p", (_why, rest, want) => {
    expect(isLiveDbPath(data(fakeHome, ...rest), [fakeHome])).toBe(want);
  });

  test("relative and dot-dot spellings resolve to the live dir", () => {
    expect(isLiveDbPath(join(fakeHome, "x", "..", ".local", "share", "standup", "standup.db"), [fakeHome])).toBe(true);
  });

  test("a symlink into the data dir is the live dir", () => {
    mkdirSync(data(fakeHome), { recursive: true });
    const link = join(root, "link");
    symlinkSync(data(fakeHome), link);
    expect(isLiveDbPath(join(link, "standup.db"), [fakeHome])).toBe(true);
  });

  test("the account's real home counts even when HOME points elsewhere", () => {
    expect(isLiveDbPath(data(userInfo().homedir, "standup.db"), [fakeHome])).toBe(true);
  });

  test.each([":memory:", "", "/tmp/elsewhere/standup.db"])("%p is not live", (p) => {
    expect(isLiveDbPath(p, [fakeHome])).toBe(false);
  });

  test("a sibling dir whose name starts like the data dir's is not it", () => {
    expect(isLiveDbPath(join(fakeHome, ".local", "share", "standup-other", "standup.db"), [fakeHome])).toBe(false);
  });

  test("a dangling link to the live DB (SQLite would create the file through it) is live", () => {
    mkdirSync(data(fakeHome), { recursive: true });
    const link = join(root, "x.db");
    symlinkSync(data(fakeHome, "standup.db"), link);
    expect(existsSync(link)).toBe(false);
    expect(isLiveDbPath(link, [fakeHome])).toBe(true);
  });

  test("a relative dangling link inside a linked dir resolves from the link's real dir", () => {
    // root/a/l -> <data dir>/sub, and root/a/l/x.db -> ../standup.db, which the
    // kernel resolves from <data dir>/sub: <data dir>/standup.db.
    mkdirSync(data(fakeHome, "sub"), { recursive: true });
    mkdirSync(join(root, "a"));
    symlinkSync(data(fakeHome, "sub"), join(root, "a", "l"));
    symlinkSync("../standup.db", data(fakeHome, "sub", "x.db"));
    expect(isLiveDbPath(join(root, "a", "l", "x.db"), [fakeHome])).toBe(true);
  });

  test("an inherited DB_PATH given as a file: URI still names the live file", () => {
    const elsewhere = join(root, "srv", "standup.db");
    expect(isLiveDbPath(elsewhere, [fakeHome], `file:${elsewhere}?mode=rwc`)).toBe(true);
  });

  test("the DB_PATH the preload found inherited is live wherever it is", () => {
    const elsewhere = join(root, "srv", "standup.db");
    expect(isLiveDbPath(elsewhere, [fakeHome], elsewhere)).toBe(true);
    expect(isLiveDbPath(join(root, "srv", "other.db"), [fakeHome], elsewhere)).toBe(false);
  });
});

describe("file: URI filenames", () => {
  test.each([
    ["file:<path>", (p: string) => `file:${p}`],
    ["file://<path>", (p: string) => `file://${p}`],
    ["file://localhost<path>", (p: string) => `file://localhost${p}`],
    ["file:<path>?mode=rwc", (p: string) => `file:${p}?mode=rwc`],
    ["file://<path>?mode=rwc&cache=shared", (p: string) => `file://${p}?mode=rwc&cache=shared`],
    ["percent-encoded", (p: string) => `file:${p.replaceAll("/", "%2F")}`],
  ])("%s to the live DB is live", (_form, uri) => {
    expect(isLiveDbPath(uri(data(fakeHome, "standup.db")), [fakeHome])).toBe(true);
  });

  test.each([
    ["file:<path>", (p: string) => `file:${p}`],
    ["file://<path>?mode=rwc", (p: string) => `file://${p}?mode=rwc`],
  ])("%s to a scratch DB is not", (_form, uri) => {
    expect(isLiveDbPath(uri(join(root, "scratch.db")), [fakeHome])).toBe(false);
  });

  test.each(["file::memory:", "file::memory:?cache=shared", `file:x.db?mode=memory`])("%p is in memory", (uri) => {
    expect(sqliteFilePath(uri)).toBeNull();
  });

  test("createStore refuses a file:?mode=rwc URI to the live DB, without creating it", () => {
    process.env.HOME = fakeHome;
    mkdirSync(data(fakeHome), { recursive: true });
    const live = data(fakeHome, "standup.db");
    expect(() => createStore(`file:${live}?mode=rwc`)).toThrow(/live Standup database/);
    expect(existsSync(live)).toBe(false);
  });
});

describe("scratchDataDirBase", () => {
  test("keeps a short temp dir, and falls back to /tmp when the tmux socket under it wouldn't fit", () => {
    const saved = process.env.TMPDIR;
    try {
      process.env.TMPDIR = "/tmp/short";
      expect(scratchDataDirBase("standup-x-")).toBe("/tmp/short");
      process.env.TMPDIR = join("/tmp", "d".repeat(100));
      expect(scratchDataDirBase("standup-x-")).toBe("/tmp");
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });
});

describe("assertNotLiveDbInTest", () => {
  test("throws for the live DB under a test run", () => {
    expect(() => assertNotLiveDbInTest(data(fakeHome, "standup.db"), { STANDUP_TEST: "1" }, [fakeHome])).toThrow(
      /live Standup database/
    );
  });

  test("lets the collector itself (no test run) open its DB", () => {
    expect(() => assertNotLiveDbInTest(data(fakeHome, "standup.db"), {}, [fakeHome])).not.toThrow();
  });

  test("lets a test open a scratch DB", () => {
    expect(() => assertNotLiveDbInTest(join(root, "scratch.db"), { STANDUP_TEST: "1" }, [fakeHome])).not.toThrow();
  });
});

describe("createStore under bun test", () => {
  test("refuses the default DB path HOME resolves to, without creating it", () => {
    process.env.HOME = fakeHome;
    const live = data(fakeHome, "standup.db");
    mkdirSync(data(fakeHome), { recursive: true });
    expect(() => createStore(live)).toThrow(/live Standup database/);
    expect(existsSync(live)).toBe(false);
  });

  test("opens a scratch DB under a mkdtemp dir", () => {
    const store = createStore(join(root, "scratch.db"));
    store.close();
    expect(existsSync(join(root, "scratch.db"))).toBe(true);
  });

  test("the preload always gives DB_PATH a scratch data dir of its own", () => {
    expect(process.env.DB_PATH).toBeDefined();
    expect(isLiveDbPath(process.env.DB_PATH!)).toBe(false);
    expect(process.env.DB_PATH).toContain("standup-test-data-");
  });

  test("the guard refuses the DB_PATH the preload replaced", () => {
    const inherited = join(root, "srv", "standup.db");
    expect(() => assertNotLiveDbInTest(inherited, { STANDUP_TEST: "1", STANDUP_INHERITED_DB_PATH: inherited }, [fakeHome])).toThrow(
      /live Standup database/
    );
  });
});
