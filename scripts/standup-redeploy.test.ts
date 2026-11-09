import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { FullRestartPending } from "../packages/collector/src/restart/state.js";
import type { DevInfo } from "../packages/shared/src/topology.js";
import type { CommandResult, RedeployDeps } from "./standup-redeploy.ts";
import { NO_DEV_SLOT_REFUSAL, handoffWorstCaseMs, planRestart, timingsFromEnv, worstCaseMs } from "../packages/collector/src/restart/supervisor.js";
import {
  DEFAULT_FULL_RESTART,
  FULL_RESTART_WAIT_MS,
  UNCLAIMED_RESTART_MS,
  appendRedeployLog,
  fullRestartWaitMs,
  needsFullRestart,
  redeploy,
  redeployLogPath,
  restartUnderwayIn,
} from "./standup-redeploy.ts";

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);

/** A fake install on NEW whose dev.ts booted on OLD; the collector answers `answer`. */
function fakeDeps(
  over: Partial<RedeployDeps> & { changed?: string[]; answer?: { status: number; body: unknown; headers?: Record<string, string> }; installCode?: number } = {}
) {
  const runs: string[][] = [];
  const shells: string[] = [];
  const posts: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  const logs: string[] = [];
  const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
  const deps: RedeployDeps = {
    installDir: "/install",
    collectorUrl: "http://collector.test",
    run: async (argv) => {
      runs.push([...argv]);
      if (argv[1] === "install") return { code: over.installCode ?? 0, stdout: "", stderr: "lockfile had changes" };
      if (argv[3] === "rev-parse") return ok(`${NEW}\n`);
      if (argv[3] === "diff") return ok((over.changed ?? ["packages/collector/src/server.ts"]).join("\n") + "\n");
      return ok();
    },
    shell: async (command) => {
      shells.push(command);
      return ok();
    },
    post: async (url, body, headers) => {
      posts.push({ url, body, headers });
      const answer = over.answer ?? { status: 202, body: { status: "scheduled", id: "r9", mode: "handoff" } };
      return {
        status: answer.status,
        body: typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body),
        ...(answer.headers ? { headers: answer.headers } : {}),
      };
    },
    readDev: () => ({ pid: 600, head: OLD, startedAt: "t", installDir: "/install", gateway: true }) as DevInfo,
    readWriteToken: () => "tok",
    restartUnderway: () => false,
    sleep: async () => {},
    log: (line) => logs.push(line),
    ...over,
  };
  return { deps, runs, shells, posts, logs };
}

const fullRestarts = (runs: string[][]) => runs.filter((r) => r[0] === "systemctl");

describe("standup-redeploy", () => {
  test("collector-only changes ask the collector for a redeploy with the write token", async () => {
    const f = fakeDeps();
    const outcome = await redeploy("post-merge", f.deps);
    expect(outcome).toMatchObject({ kind: "scheduled", exitCode: 0 });
    expect(outcome.line).toBe("standup-redeploy (post-merge): redeploying bbbbbbb (restart r9, handoff)");
    // The bun running this script, not whatever `bun` PATH finds.
    expect(f.runs[0]).toEqual([process.execPath, "install", "--frozen-lockfile"]);
    expect(f.runs).toContainEqual(["git", "-C", "/install", "diff", "--name-only", OLD, NEW]);
    expect(f.posts).toEqual([
      {
        url: "http://collector.test/api/standup/restart",
        body: { source: "redeploy", reason: "redeploy (post-merge) to bbbbbbb" },
        headers: { "x-standup-write-token": "tok" },
      },
    ]);
    expect(fullRestarts(f.runs)).toEqual([]);
  });

  test("a failed bun install is logged and the redeploy goes on", async () => {
    const f = fakeDeps({ installCode: 1 });
    expect((await redeploy("post-merge", f.deps)).kind).toBe("scheduled");
    expect(f.logs[0]).toContain("bun install --frozen-lockfile exited 1; continuing");
  });

  test("dev.ts, its topology, the gateway or the shared topology changing since dev.ts booted needs a full restart, overridable by a shell command", async () => {
    for (const changed of [["scripts/dev.ts"], ["scripts/dev-topology.ts"], ["README.md", "packages/gateway/src/proxy.ts"], ["packages/shared/src/topology.ts"]]) {
      const f = fakeDeps({ changed });
      const outcome = await redeploy("post-merge", f.deps);
      expect(outcome.kind).toBe("full");
      expect(outcome.line).toContain(`${changed[changed.length - 1]} changed since aaaaaaa`);
      expect(fullRestarts(f.runs)).toEqual([[...DEFAULT_FULL_RESTART]]);
      expect(f.posts).toEqual([]);
    }
    const custom = fakeDeps({ changed: ["scripts/dev.ts"], fullRestartCmd: "touch /tmp/restarted" });
    expect((await redeploy("post-merge", custom.deps)).line).toContain("via STANDUP_REDEPLOY_FULL_RESTART_CMD");
    expect(custom.shells).toEqual(["touch /tmp/restarted"]);
    expect(fullRestarts(custom.runs)).toEqual([]);
    expect(needsFullRestart(["scripts/dev.test.ts", "packages/gatewayish/x.ts", "packages/shared/src/topology.test.ts", "scripts/dev.ts"])).toEqual(["scripts/dev.ts"]);
  });

  test("dev.ts on HEAD already: nothing to diff, the collector is asked", async () => {
    const f = fakeDeps({ readDev: () => ({ pid: 600, head: NEW, startedAt: "t", installDir: "/install", gateway: true }) });
    expect((await redeploy("post-merge", f.deps)).kind).toBe("scheduled");
    expect(f.runs.some((r) => r[3] === "diff")).toBe(false);
  });

  test("an unknown dev.ts commit (no dev.json, as on a first rollout) gets the full restart", async () => {
    for (const readDev of [() => undefined, () => ({ pid: 600, startedAt: "t", installDir: "/install", gateway: false })]) {
      const f = fakeDeps({ readDev });
      const outcome = await redeploy("post-merge", f.deps);
      expect(outcome.kind).toBe("full");
      expect(outcome.line).toContain("the commit dev.ts runs is unknown");
      expect(f.posts).toEqual([]);
    }
  });

  test("only nothing answering, or the gateway with no leader, gets the full restart; other refusals exit non-zero", async () => {
    const down = fakeDeps({ answer: { status: 0, body: "Unable to connect" } });
    const outcome = await redeploy("post-merge", down.deps);
    expect(outcome.kind).toBe("full");
    expect(outcome.line).toContain("the collector is unreachable");
    expect(fullRestarts(down.runs)).toHaveLength(1);
    const leaderless = fakeDeps({ answer: { status: 503, body: "no collector leader", headers: { "x-standup-gateway": "no-leader" } } });
    const viaGateway = await redeploy("post-merge", leaderless.deps);
    expect(viaGateway.kind).toBe("full");
    expect(viaGateway.line).toContain("the gateway has no collector leader to ask (no-leader)");
    for (const answer of [
      { status: 503, body: { error: "Persona is disabled" } },
      { status: 503, body: "gateway busy", headers: { "x-standup-gateway": "held-cap" } },
      { status: 500, body: { error: "boom" } },
      { status: 409, body: { error: "the install is on a detached HEAD, not main" } },
      { status: 429, body: { error: "redeployed 20 times" } },
      { status: 401, body: { error: "a redeploy needs the local write token" } },
    ]) {
      const refused = fakeDeps({ answer });
      const r = await redeploy("post-merge", refused.deps);
      expect(r).toMatchObject({ kind: "failed", exitCode: 1 });
      expect(r.line).toContain(`(HTTP ${answer.status})`);
      expect(fullRestarts(refused.runs)).toEqual([]);
      expect(refused.shells).toEqual([]);
    }
  });

  test("a slot collector refused for want of a dev.ts to hand off through gets the full restart", async () => {
    const plan = planRestart({ latest: null, latestActive: false, headBefore: NEW, goodHeads: [], supervision: {}, slotted: true, source: "redeploy" });
    expect(plan).toMatchObject({ kind: "refuse", status: 409 });
    const error = (plan as { error: string }).error;
    expect(error.startsWith(NO_DEV_SLOT_REFUSAL)).toBe(true);
    const f = fakeDeps({ answer: { status: 409, body: { error } } });
    const outcome = await redeploy("post-merge", f.deps);
    expect(outcome).toMatchObject({ kind: "full", exitCode: 0 });
    expect(outcome.line).toContain("runs as a slot with no dev.ts to hand off through");
    expect(fullRestarts(f.runs)).toEqual([[...DEFAULT_FULL_RESTART]]);
  });

  test("reports a no-op and a coalesced redeploy", async () => {
    const noop = fakeDeps({ answer: { status: 200, body: { status: "noop", head: NEW } } });
    expect(await redeploy("post-checkout", noop.deps)).toMatchObject({ kind: "noop", line: "standup-redeploy (post-checkout): nothing to do — Standup already runs bbbbbbb" });
    const coalesced = fakeDeps({ answer: { status: 202, body: { status: "coalesced", id: "r8" } } });
    expect((await redeploy("post-merge", coalesced.deps)).line).toContain("a restart is under way (r8); bbbbbbb follows once it is done");
  });

  test("without a write token it restarts fully", async () => {
    const noToken = fakeDeps({ readWriteToken: () => undefined });
    expect((await redeploy("post-merge", noToken.deps)).line).toContain("no local write token");
    expect(noToken.posts).toEqual([]);
  });

  test("a full restart waits out a restart under way, and gives up rather than cut one off", async () => {
    let polls = 0;
    const finishing = fakeDeps({ changed: ["scripts/dev.ts"], restartUnderway: () => polls++ < 3 });
    expect((await redeploy("post-merge", finishing.deps)).kind).toBe("full");
    expect(finishing.logs.join(" ")).toContain(`a restart is under way; waiting up to ${Math.round(FULL_RESTART_WAIT_MS / 1000)}s`);
    const stuck = fakeDeps({ changed: ["scripts/dev.ts"], restartUnderway: () => true, waitMs: 20_000 });
    const outcome = await redeploy("post-merge", stuck.deps);
    expect(outcome).toMatchObject({ kind: "failed", exitCode: 1 });
    expect(outcome.line).toContain("a restart was still under way after 20s");
    expect(fullRestarts(stuck.runs)).toEqual([]);
  });

  test("a full restart waits at least as long as a handoff restart can run, with the supervisor's own timings", () => {
    expect(FULL_RESTART_WAIT_MS).toBeGreaterThanOrEqual(handoffWorstCaseMs(timingsFromEnv()));
    expect(FULL_RESTART_WAIT_MS).toBeGreaterThanOrEqual(worstCaseMs(timingsFromEnv()));
    const slow = { STANDUP_RESTART_PREFLIGHT_TIMEOUT_S: "3600" };
    expect(fullRestartWaitMs(slow)).toBeGreaterThanOrEqual(handoffWorstCaseMs(timingsFromEnv(slow)));
    expect(fullRestartWaitMs(slow)).toBeGreaterThan(FULL_RESTART_WAIT_MS);
  });

  test("an async dev.json reader is awaited", async () => {
    const f = fakeDeps({ readDev: async () => ({ pid: 600, head: NEW, startedAt: "t", installDir: "/install", gateway: true }) });
    expect((await redeploy("post-merge", f.deps)).kind).toBe("scheduled");
    expect(f.runs.some((r) => r[3] === "diff")).toBe(false);
  });

  test("every phase but done is under way: before a supervisor while the record is fresh, after one while it lives", () => {
    const now = Date.parse("2026-10-08T12:00:00.000Z");
    const fresh = new Date(now - 60_000).toISOString();
    const stale = new Date(now - UNCLAIMED_RESTART_MS - 1).toISOString();
    const alive = (pid: number) => pid === 7;
    for (const phase of ["scheduled", "quiescing", "handed_off"]) {
      expect(restartUnderwayIn({ phase, updatedAt: fresh }, now, alive)).toBe(true);
      expect(restartUnderwayIn({ phase, updatedAt: stale }, now, alive)).toBe(false);
    }
    expect(restartUnderwayIn({ phase: "checking", supervisorPid: 7, updatedAt: stale }, now, alive)).toBe(true);
    expect(restartUnderwayIn({ phase: "checking", supervisorPid: 8, updatedAt: fresh }, now, alive)).toBe(false);
    expect(restartUnderwayIn({ phase: "done", supervisorPid: 7, updatedAt: fresh }, now, alive)).toBe(false);
    expect(restartUnderwayIn(undefined, now, alive)).toBe(false);
  });

  test("every outcome, and every line logged on the way, goes to the redeploy log", async () => {
    const answers = [
      { status: 202, body: { status: "scheduled", id: "r9", mode: "handoff" } },
      { status: 202, body: { status: "coalesced", id: "r8" } },
      { status: 200, body: { status: "noop", head: NEW } },
      { status: 409, body: { error: "the install is on a detached HEAD, not main" } },
      { status: 0, body: "Unable to connect" },
    ];
    for (const answer of answers) {
      const appended: string[] = [];
      const f = fakeDeps({ answer, installCode: 1, appendLog: (line) => appended.push(line) });
      const outcome = await redeploy("post-merge", f.deps);
      expect(appended[0]).toContain("bun install --frozen-lockfile exited 1");
      expect(appended[appended.length - 1]).toBe(outcome.line);
    }
    const dir = mkdtempSync(join(tmpdir(), "redeploy-log-"));
    try {
      const path = redeployLogPath(dir);
      appendRedeployLog(path, "first", new Date("2026-10-08T12:00:00.000Z"));
      appendRedeployLog(path, "second\nline", new Date("2026-10-08T12:00:01.000Z"));
      expect(readFileSync(path, "utf8")).toBe("2026-10-08T12:00:00.000Z first\n2026-10-08T12:00:01.000Z second line\n");
      expect(path).toBe(join(dir, "restart", "redeploy.log"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("run from an install dev.json doesn't name (a worktree), it refuses and restarts nothing", async () => {
    const f = fakeDeps({ devInstallDir: () => "/primary", changed: ["scripts/dev.ts"] });
    const outcome = await redeploy("post-merge", f.deps);
    expect(outcome).toMatchObject({ kind: "refused", exitCode: 1 });
    expect(outcome.line).toContain("dev.json names the install /primary");
    expect(f.runs).toEqual([]);
    expect(f.posts).toEqual([]);
    expect(f.shells).toEqual([]);
    // dev.json naming this very install, or none at all, goes ahead.
    expect((await redeploy("post-merge", fakeDeps({ devInstallDir: () => "/install" }).deps)).kind).toBe("scheduled");
    expect((await redeploy("post-merge", fakeDeps({ devInstallDir: () => undefined }).deps)).kind).toBe("scheduled");
  });

  test("a full restart is followed until a new dev.ts and a healthy leader run HEAD; one that doesn't come back is logged as unhealthy", async () => {
    let restarted = false;
    let polls = 0;
    const healthy = fakeDeps({
      changed: ["scripts/dev.ts"],
      run: async (argv) => {
        if (argv[0] === "systemctl") restarted = true;
        if (argv[3] === "rev-parse") return { code: 0, stdout: `${NEW}\n`, stderr: "" };
        if (argv[3] === "diff") return { code: 0, stdout: "scripts/dev.ts\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
      readDev: () =>
        (restarted && polls++ > 1
          ? { pid: 601, head: NEW, startedAt: "t", installDir: "/install", gateway: true }
          : { pid: 600, head: OLD, startedAt: "t", installDir: "/install", gateway: true }) as DevInfo,
      readHealth: async () => ({ status: 200, body: JSON.stringify({ status: "ok", pid: 700, head: NEW }) }),
    });
    const ok = await redeploy("post-merge", healthy.deps);
    expect(ok).toMatchObject({ kind: "full", exitCode: 0 });
    expect(ok.line).toContain("dev.ts (pid 601) and the collector leader (pid 700) are back on bbbbbbb");
    expect(healthy.logs.join(" ")).toContain("waiting up to 300s for dev.ts and a healthy collector on bbbbbbb");

    const appended: string[] = [];
    const stale = fakeDeps({
      changed: ["scripts/dev.ts"],
      // dev.ts never comes back on NEW: the one from before stays.
      readDev: () => ({ pid: 601, head: OLD, startedAt: "t", installDir: "/install", gateway: true }) as DevInfo,
      readHealth: async () => ({ status: 200, body: JSON.stringify({ status: "ok", pid: 700, head: OLD }) }),
      settleMs: 20_000,
      appendLog: (line) => appended.push(line),
    });
    const unhealthy = await redeploy("post-merge", stale.deps);
    expect(unhealthy).toMatchObject({ kind: "full-unhealthy", exitCode: 1 });
    expect(unhealthy.line).toContain("but Standup is UNHEALTHY: after 20s");
    expect(unhealthy.line).toContain("is still the one from before (pid 601)");
    expect(unhealthy.line).toContain("Nothing was rolled back");
    expect(appended[appended.length - 1]).toBe(unhealthy.line);
    expect(fullRestarts(stale.runs)).toHaveLength(1);

    // A new dev.ts on HEAD whose leader still runs the old commit is unhealthy too.
    let issued = false;
    const oldLeader = fakeDeps({
      changed: ["scripts/dev.ts"],
      readDev: () => (issued ? { pid: 602, head: NEW, startedAt: "t", installDir: "/install", gateway: true } : { pid: 601, head: OLD, startedAt: "t", installDir: "/install", gateway: true }) as DevInfo,
      readHealth: async () => ({ status: 200, body: JSON.stringify({ status: "ok", pid: 700, head: OLD }) }),
      settleMs: 10_000,
    });
    const run = oldLeader.deps.run;
    oldLeader.deps.run = async (argv, cwd) => {
      if (argv[0] === "systemctl") issued = true;
      return run(argv, cwd);
    };
    const stuck = await redeploy("post-merge", oldLeader.deps);
    expect(stuck.kind).toBe("full-unhealthy");
    expect(stuck.line).toContain("the collector leader (pid 700) runs aaaaaaa, not bbbbbbb");
  });

  test("with no dev.json before the full restart, a healthy leader on HEAD is enough", async () => {
    let restarted = false;
    const f = fakeDeps({
      readDev: () => undefined,
      readHealth: async () => ({ status: 200, body: JSON.stringify({ status: "ok", pid: restarted ? 701 : 700, ...(restarted ? { head: NEW } : {}) }) }),
    });
    const run = f.deps.run;
    f.deps.run = async (argv, cwd) => {
      if (argv[0] === "systemctl") restarted = true;
      return run(argv, cwd);
    };
    const outcome = await redeploy("post-merge", f.deps);
    expect(outcome).toMatchObject({ kind: "full", exitCode: 0 });
    expect(outcome.line).toContain("the collector leader (pid 701) is back on bbbbbbb");
    expect(f.logs.join(" ")).toContain("waiting up to 300s for a healthy collector leader on bbbbbbb");

    // A leader reporting no head counts only once it is another collector than the one before.
    let issued = false;
    const headless = fakeDeps({
      readDev: () => undefined,
      readHealth: async () => ({ status: 200, body: JSON.stringify({ status: "ok", pid: 700 }) }),
      settleMs: 10_000,
    });
    const run2 = headless.deps.run;
    headless.deps.run = async (argv, cwd) => {
      if (argv[0] === "systemctl") issued = true;
      return run2(argv, cwd);
    };
    const same = await redeploy("post-merge", headless.deps);
    expect(issued).toBe(true);
    expect(same.kind).toBe("full-unhealthy");
    expect(same.line).toContain("the collector (pid 700) is still the one from before");
  });

  test("a pending line is logged and recorded before the full restart; the next run logs the outcome of one its issuer never saw through", async () => {
    let stored: FullRestartPending | null = null;
    const writes: FullRestartPending[] = [];
    const pending = {
      read: () => stored,
      write: (p: FullRestartPending) => {
        stored = p;
        writes.push(p);
      },
      clear: () => {
        stored = null;
      },
    };
    let pendingWhenIssued: FullRestartPending | null = null;
    const appended: string[] = [];
    const f = fakeDeps({ changed: ["scripts/dev.ts"], pending, pid: 4242, appendLog: (line) => appended.push(line) });
    const run = f.deps.run;
    f.deps.run = async (argv, cwd) => {
      if (argv[0] === "systemctl") pendingWhenIssued = stored;
      return run(argv, cwd);
    };
    expect((await redeploy("post-merge", f.deps)).kind).toBe("full");
    expect(pendingWhenIssued).toMatchObject({ pid: 4242, head: NEW, why: expect.stringContaining("scripts/dev.ts changed") });
    expect(appended.some((l) => l.includes("full restart (scripts/dev.ts changed since aaaaaaa) to bbbbbbb pending: running systemctl"))).toBe(true);
    expect(stored).toBeNull();

    // A run the restart stopped left its record behind; the next run logs what came back.
    stored = { pid: 4242, at: "2026-10-08T12:00:00.000Z", head: NEW, why: "scripts/dev.ts changed since aaaaaaa" };
    const next = fakeDeps({
      readDev: () => ({ pid: 601, head: NEW, startedAt: "t", installDir: "/install", gateway: true }),
      pending,
      pid: 5000,
      isAlive: () => false,
      readHealth: async () => ({ status: 200, body: JSON.stringify({ status: "ok", pid: 700, head: NEW }) }),
    });
    await redeploy("post-merge", next.deps);
    expect(next.logs[0]).toContain("the full restart (scripts/dev.ts changed since aaaaaaa) to bbbbbbb issued at 2026-10-08T12:00:00.000Z stopped the run that issued it");
    expect(next.logs[0]).toContain("the collector leader (pid 700) answers healthy on bbbbbbb now");
    expect(stored).toBeNull();
    // One whose issuer still runs is left to it.
    stored = { pid: 4242, at: "t", head: NEW, why: "w" };
    const live = fakeDeps({ readDev: () => ({ pid: 601, head: NEW, startedAt: "t", installDir: "/install", gateway: true }), pending, pid: 5000, isAlive: () => true });
    await redeploy("post-merge", live.deps);
    expect(stored).not.toBeNull();
    expect(writes).toHaveLength(1);
  });

  test("a dev.ts head git can't diff against is restarted fully", async () => {
    const f = fakeDeps();
    const run = f.deps.run;
    f.deps.run = async (argv, cwd) => (argv[3] === "diff" ? { code: 128, stdout: "", stderr: "bad object" } : run(argv, cwd));
    const outcome = await redeploy("post-merge", f.deps);
    expect(outcome.kind).toBe("full");
    expect(outcome.line).toContain("cannot diff dev.ts's aaaaaaa against bbbbbbb");
  });
});
