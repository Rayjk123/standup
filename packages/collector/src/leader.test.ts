import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  leaderFilePath,
  readJsonFile,
  standbyDirPath,
  standbyFilePath,
  type LeaderInfo,
  type StandbyInfo,
} from "@standup/shared/topology";
import {
  acquireLeadership,
  ForeignLeaderError,
  libcLocker,
  LeadershipUnavailableError,
  readInstallHead,
  standbyPidFilePath,
  StandbyOrphanedError,
  type FileLocker,
  type Leadership,
} from "./leader.js";

const quiet = () => {};
// Recorded in the leader file only; nothing binds them.
const HTTP_PORT = 1;
const WS_PORT = 2;
let dataDir: string;
const held: Leadership[] = [];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "standup-leader-"));
});

afterEach(() => {
  for (const l of held.splice(0)) l.release();
  rmSync(dataDir, { recursive: true, force: true });
});

function acquire(extra: Partial<Parameters<typeof acquireLeadership>[0]> = {}): Promise<Leadership> {
  return acquireLeadership({
    dataDir,
    httpPort: HTTP_PORT,
    wsPort: WS_PORT,
    installDir: dataDir,
    pollMs: 10,
    log: quiet,
    ...extra,
  }).then((l) => {
    held.push(l);
    return l;
  });
}

/** Resolves true once `p` settles, false if it is still pending after `ms`. */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let settled = false;
  void p.then(() => (settled = true), () => (settled = true));
  await Bun.sleep(ms);
  return settled;
}

describe("acquireLeadership", () => {
  test("flock is available on this platform", () => {
    expect(libcLocker()).not.toBeNull();
  });

  test("the first acquirer leads and publishes the leader file", async () => {
    const l = await acquire({ slot: "a" });
    expect(l.locked).toBe(true);
    expect(l.epoch).toMatch(/^[0-9a-f]{16}$/);
    const info = readJsonFile<LeaderInfo>(leaderFilePath(dataDir))!;
    expect(info).toMatchObject({
      pid: process.pid,
      slot: "a",
      httpPort: HTTP_PORT,
      wsPort: WS_PORT,
      epoch: l.epoch,
      acquiredAt: l.acquiredAt.toISOString(),
      installDir: dataDir,
    });
    expect(existsSync(standbyFilePath(dataDir))).toBe(false);
  });

  test("a second acquirer waits as standby and takes over once the leader releases", async () => {
    const leader = await acquire({ slot: "a" });
    let waitingInfo: StandbyInfo | undefined;
    const standby = acquire({ slot: "b", onWaiting: (info) => (waitingInfo = info) });

    expect(await settlesWithin(standby, 100)).toBe(false);
    const file = readJsonFile<StandbyInfo>(standbyFilePath(dataDir));
    expect(file).toMatchObject({ pid: process.pid, slot: "b", installDir: dataDir });
    expect(waitingInfo).toEqual(file);
    // The per-pid marker in the data dir's standby/ carries the same info.
    expect(standbyPidFilePath(dataDir, process.pid)).toBe(join(standbyDirPath(dataDir), `${process.pid}.json`));
    expect(readJsonFile<StandbyInfo>(standbyPidFilePath(dataDir, process.pid))).toEqual(file!);

    const releasedAt = Date.now();
    leader.release();
    const next = await standby;
    expect(Date.now() - releasedAt).toBeLessThan(1000);
    expect(next.epoch).not.toBe(leader.epoch);
    expect(existsSync(standbyFilePath(dataDir))).toBe(false);
    expect(existsSync(standbyPidFilePath(dataDir, process.pid))).toBe(false);
    expect(readJsonFile<LeaderInfo>(leaderFilePath(dataDir))).toMatchObject({ slot: "b", epoch: next.epoch });
  });

  test("the leader file carries the boot phase while one is set, and the same leader info once it is cleared", async () => {
    const l = await acquire({ slot: "a" });
    const before = readJsonFile<LeaderInfo>(leaderFilePath(dataDir))!;
    l.setBootPhase("pre-migrate-backup");
    expect(readJsonFile<LeaderInfo>(leaderFilePath(dataDir))).toMatchObject({ ...before, bootPhase: "pre-migrate-backup", bootPhaseAt: expect.any(String) });
    l.setBootPhase("migrating");
    expect(readJsonFile<LeaderInfo>(leaderFilePath(dataDir))?.bootPhase).toBe("migrating");
    l.setBootPhase(undefined);
    expect(readJsonFile<LeaderInfo>(leaderFilePath(dataDir))).toEqual(before);
  });

  test("release leaves a successor's leader file alone", async () => {
    const first = await acquire();
    first.release();
    const second = await acquire();
    first.release();
    expect(readJsonFile<LeaderInfo>(leaderFilePath(dataDir))?.epoch).toBe(second.epoch);
  });

  test("the kernel releases the lock when the holder is SIGKILLed, even with a child still running", async () => {
    const script = join(dataDir, "holder.ts");
    writeFileSync(
      script,
      [
        `import { acquireLeadership } from ${JSON.stringify(join(import.meta.dir, "leader.ts"))};`,
        `await acquireLeadership({ dataDir: ${JSON.stringify(dataDir)}, httpPort: 1, wsPort: 2, installDir: ${JSON.stringify(dataDir)}, log: () => {} });`,
        `const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });`,
        `console.log("ACQUIRED " + child.pid);`,
        `setInterval(() => {}, 1000);`,
      ].join("\n")
    );
    const holder = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "inherit" });
    let sleepPid: number | undefined;
    try {
      const reader = holder.stdout.getReader();
      let out = "";
      while (!out.includes("\n")) {
        const { value, done } = await reader.read();
        if (done) break;
        out += new TextDecoder().decode(value);
      }
      const match = /ACQUIRED (\d+)/.exec(out);
      expect(match).not.toBeNull();
      sleepPid = Number(match![1]);

      const standby = acquire();
      expect(await settlesWithin(standby, 150)).toBe(false);
      expect(readJsonFile<StandbyInfo>(standbyFilePath(dataDir))?.pid).toBe(process.pid);

      const killedAt = Date.now();
      holder.kill("SIGKILL");
      await holder.exited;
      await standby;
      expect(Date.now() - killedAt).toBeLessThan(1000);
      // The holder's own child outlived it without keeping the lock.
      expect(() => process.kill(sleepPid!, 0)).not.toThrow();
    } finally {
      holder.kill("SIGKILL");
      if (sleepPid) {
        try {
          process.kill(sleepPid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  });

  test("without flock it runs unlocked and still publishes the leader file", async () => {
    const lines: string[] = [];
    const l = await acquire({ locker: null, log: (line) => lines.push(line) });
    expect(l.locked).toBe(false);
    expect(lines.join("\n")).toContain("without the leader lock");
    expect(readJsonFile<LeaderInfo>(leaderFilePath(dataDir))?.epoch).toBe(l.epoch);
  });

  test("a slotted collector refuses to run unlocked", async () => {
    await expect(acquire({ locker: null, slot: "a" })).rejects.toBeInstanceOf(LeadershipUnavailableError);
    expect(existsSync(leaderFilePath(dataDir))).toBe(false);
  });
});

describe("an orphaned standby", () => {
  /** A parent pid source the test moves, and the exits the standby asked for. */
  function family(initial = 4_242) {
    const f = { ppid: initial, alive: new Set([initial]), exits: [] as number[] };
    return {
      f,
      opts: {
        parentPid: () => f.ppid,
        isAlive: (pid: number) => f.alive.has(pid),
        exit: (code: number) => void f.exits.push(code),
      },
    };
  }

  for (const [label, orphan] of [
    ["re-parented to init", (f: { ppid: number }) => (f.ppid = 1)],
    ["re-parented to a subreaper", (f: { ppid: number }) => (f.ppid = 999)],
    ["its parent pid gone", (f: { alive: Set<number> }) => f.alive.clear()],
  ] as const) {
    test(`a slotted standby exits cleanly, leaving the lock and its marker, once ${label}`, async () => {
      const leader = await acquire({ slot: "a" });
      const { f, opts } = family();
      const lines: string[] = [];
      const standby = acquire({ slot: "b", ...opts, log: (line) => lines.push(line) });
      expect(await settlesWithin(standby, 60)).toBe(false);
      expect(readJsonFile<StandbyInfo>(standbyFilePath(dataDir))?.slot).toBe("b");
      orphan(f as { ppid: number; alive: Set<number> });
      await expect(standby).rejects.toBeInstanceOf(StandbyOrphanedError);
      expect(f.exits).toEqual([0]);
      expect(existsSync(standbyFilePath(dataDir))).toBe(false);
      expect(existsSync(standbyPidFilePath(dataDir, process.pid))).toBe(false);
      expect(lines.join("\n")).toContain("Standby (slot b) exiting");
      // The leader keeps the lock and its file.
      expect(readJsonFile<LeaderInfo>(leaderFilePath(dataDir))?.epoch).toBe(leader.epoch);
    });
  }

  test("a waiting standby on SIGTERM exits, removing its markers; the handlers are gone once it leads", async () => {
    const leader = await acquire({ slot: "a" });
    const { f, opts } = family();
    const before = { term: process.listeners("SIGTERM"), int: process.listeners("SIGINT"), exit: process.listeners("exit") };
    const standby = acquire({ slot: "b", ...opts });
    expect(await settlesWithin(standby, 60)).toBe(false);
    expect(existsSync(standbyPidFilePath(dataDir, process.pid))).toBe(true);
    const added = process.listeners("SIGTERM").filter((l) => !before.term.includes(l));
    expect(added).toHaveLength(1);
    (added[0] as (signal: NodeJS.Signals) => void)("SIGTERM");
    expect(f.exits).toEqual([0]);
    expect(existsSync(standbyPidFilePath(dataDir, process.pid))).toBe(false);
    expect(existsSync(standbyFilePath(dataDir))).toBe(false);
    expect(process.listeners("SIGTERM")).toEqual(before.term);
    expect(process.listeners("SIGINT")).toEqual(before.int);
    expect(process.listeners("exit")).toEqual(before.exit);
    // The fake exit returned, so the wait goes on; it leads once the lock is free.
    leader.release();
    expect((await standby).locked).toBe(true);
    expect(existsSync(standbyPidFilePath(dataDir, process.pid))).toBe(false);
  });

  test("an unslotted standby, and a slot whose parent lives, keep waiting and then lead", async () => {
    for (const [slot, orphan] of [
      [undefined, true],
      ["b", false],
    ] as const) {
      const leader = await acquire({ slot: "a" });
      const { f, opts } = family();
      const standby = acquire({ ...(slot ? { slot } : {}), ...opts });
      if (orphan) f.ppid = 1;
      expect(await settlesWithin(standby, 80)).toBe(false);
      expect(f.exits).toEqual([]);
      leader.release();
      expect((await standby).locked).toBe(true);
      (await standby).release();
    }
  });
});

describe("a live leader of another install", () => {
  /** Rewrites the leader file as if `pid`, running from `installDir`, held the lock. */
  const recordLeader = (pid: number, installDir: string) =>
    writeFileSync(leaderFilePath(dataDir), JSON.stringify({ pid, epoch: "other", installDir }));

  test("makes a waiting collector exit with a clear error instead of waiting to lead", async () => {
    await acquire({ slot: "a" });
    // process.ppid stands in for the other install's live leader.
    recordLeader(process.ppid, "/elsewhere/standup");
    const exits: number[] = [];
    const lines: string[] = [];
    const standby = acquire({
      slot: "b",
      exit: (code) => void exits.push(code),
      parentPid: () => process.ppid,
      foreignLeaderGraceMs: 30,
      log: (line) => lines.push(line),
    });
    const err = await standby.then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(ForeignLeaderError);
    expect(exits).toEqual([1]);
    expect(lines.join("\n")).toContain("runs from another install, /elsewhere/standup");
    expect(existsSync(standbyFilePath(dataDir))).toBe(false);
    expect(existsSync(standbyPidFilePath(dataDir, process.pid))).toBe(false);
  });

  test("a leader of the same install (through a symlink), a dead one, or one without an installDir is waited on", async () => {
    const link = join(mkdtempSync(join(tmpdir(), "standup-leader-link-")), "install");
    symlinkSync(dataDir, link);
    try {
      for (const record of [
        () => recordLeader(process.ppid, link),
        () => recordLeader(0x7ffffffe, "/elsewhere/standup"),
        () => writeFileSync(leaderFilePath(dataDir), JSON.stringify({ pid: process.ppid, epoch: "other" })),
      ]) {
        const leader = await acquire({ slot: "a" });
        record();
        const exits: number[] = [];
        const standby = acquire({ slot: "b", exit: (code) => void exits.push(code), parentPid: () => process.ppid, foreignLeaderGraceMs: 10 });
        expect(await settlesWithin(standby, 80)).toBe(false);
        expect(exits).toEqual([]);
        leader.release();
        expect((await standby).locked).toBe(true);
        (await standby).release();
      }
    } finally {
      rmSync(dirname(link), { recursive: true, force: true });
    }
  });

  test("a record that a leader of this install replaces within the grace is not acted on", async () => {
    const leader = await acquire({ slot: "a" });
    recordLeader(process.ppid, "/elsewhere/standup");
    const exits: number[] = [];
    const standby = acquire({ slot: "b", exit: (code) => void exits.push(code), parentPid: () => process.ppid, foreignLeaderGraceMs: 200 });
    await Bun.sleep(40);
    recordLeader(process.ppid, dataDir);
    expect(await settlesWithin(standby, 300)).toBe(false);
    expect(exits).toEqual([]);
    leader.release();
    expect((await standby).locked).toBe(true);
  });
});

describe("the loaded head", () => {
  // A checkout whose real HEAD differs from the head passed in: the files must
  // carry the one passed in, never a read of the checkout.
  const repo = import.meta.dir;
  const loaded = "0123456789abcdef0123456789abcdef01234567";

  test("the standby and leader files carry the head passed in, not the checkout's", async () => {
    expect(readInstallHead(repo)).not.toBe(loaded);
    const leader = await acquire({ slot: "a" });
    const standby = acquire({ slot: "b", installDir: repo, head: loaded });
    expect(await settlesWithin(standby, 60)).toBe(false);
    expect(readJsonFile<StandbyInfo>(standbyFilePath(dataDir))).toMatchObject({ slot: "b", head: loaded });
    leader.release();
    const next = await standby;
    expect(next.head).toBe(loaded);
    expect(readJsonFile<LeaderInfo>(leaderFilePath(dataDir))).toMatchObject({ slot: "b", head: loaded, installDir: repo });
  });

  test("no head passed in leaves it out of the files", async () => {
    const l = await acquire({ installDir: repo });
    expect(l.head).toBeUndefined();
    expect(readJsonFile<LeaderInfo>(leaderFilePath(dataDir))?.head).toBeUndefined();
  });

  test("readInstallHead reads the checkout's HEAD and ignores inherited GIT_* variables", () => {
    const expected = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo, stdout: "pipe" }).stdout.toString().trim();
    expect(expected).toMatch(/^[0-9a-f]{40}$/);
    expect(readInstallHead(repo, { ...process.env, GIT_DIR: join(dataDir, "nope"), GIT_WORK_TREE: dataDir })).toBe(expected);
    expect(readInstallHead(dataDir)).toBeUndefined();
  });
});

describe("an flock whose errno can't be read", () => {
  const unidentified: FileLocker = { tryLock: () => "unidentified", setCloseOnExec: () => {} };

  test("with no live leader recorded, it falls back to running unlocked after maxUnidentified tries", async () => {
    const lines: string[] = [];
    const l = await acquire({ locker: unidentified, maxUnidentified: 5, log: (line) => lines.push(line) });
    expect(l.locked).toBe(false);
    expect(lines.join("\n")).toContain("failed 5 times in a row");
    expect(lines.join("\n")).toContain("without the leader lock");
    expect(existsSync(standbyFilePath(dataDir))).toBe(false);
    expect(readJsonFile<LeaderInfo>(leaderFilePath(dataDir))?.epoch).toBe(l.epoch);
  });

  test("a slotted collector exits instead", async () => {
    await expect(acquire({ locker: unidentified, maxUnidentified: 3, slot: "b" })).rejects.toBeInstanceOf(
      LeadershipUnavailableError
    );
  });

  test("while a live leader is recorded, the failures count as busy and it keeps waiting", async () => {
    writeFileSync(leaderFilePath(dataDir), JSON.stringify({ pid: process.ppid, epoch: "other" }));
    const waiting = acquire({ locker: unidentified, maxUnidentified: 3 });
    expect(await settlesWithin(waiting, 150)).toBe(false);
    expect(readJsonFile<StandbyInfo>(standbyFilePath(dataDir))?.pid).toBe(process.pid);
    // The recorded leader dies: the failures start counting.
    writeFileSync(leaderFilePath(dataDir), JSON.stringify({ pid: 0x7ffffffe, epoch: "other" }));
    const l = await waiting;
    expect(l.locked).toBe(false);
  });
});
