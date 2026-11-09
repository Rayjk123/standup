import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import {
  claimReviewTunnel,
  createLaunch,
  createPersonaJob,
  createSession,
  createStore,
  getOrCreatePersonaConsoleThread,
  getReviewTunnel,
  linkPersonaJobLaunch,
  listLiveReviewTunnels,
  setPipelineConfig,
  updateLaunchStatus,
  updatePersonaJob,
  updatePipelineRun,
  upsertProject,
} from "@standup/store";
import type { Store } from "@standup/store";
import type { PipelineOverride, PipelineRun, ReviewTunnel, ReviewTunnelConfig } from "@standup/shared";
import { startPipelineForLaunch } from "../pipeline/engine.js";
import { commandTunnelProvider, disabledTunnelProvider } from "../tunnels/provider.js";
import { FakeTunnelSystem, fakeTunnelUrl } from "./fake-system.js";
import {
  RESERVED_PORTS_ENV,
  RESERVED_SUFFIXES_ENV,
  ReviewTunnels,
  STANDUP_OWN_PORTS,
  commandArgv,
  isReservedTunnelName,
  reservedTunnelsFromEnv,
  serveDir,
} from "./manager.js";

const OWNER = "alice";
/** A standing tunnel the owner keeps open by hand: `<host user>-kiosk` on 5250, reserved through the settings. */
const STANDING = reservedTunnelsFromEnv({ [RESERVED_PORTS_ENV]: "5250", [RESERVED_SUFFIXES_ENV]: "kiosk" });
const SERVE = "node node_modules/.bin/vite --host 127.0.0.1 --port {port} --strictPort";

interface Harness {
  store: Store;
  sys: FakeTunnelSystem;
  tunnels: ReviewTunnels;
  checkpoints: Array<{ sessionId: string; text: string }>;
  worktree: string;
  /** A launch (and its run) in "proj" with `config` as the owner's project layer. */
  launch: (config?: ReviewTunnelConfig | null, opts?: { job?: string; branch?: string }) => { launchId: string; run: PipelineRun; jobId?: string };
}

function harness(): Harness {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "proj", name: "P", branch: "main", repos: [] });
  const sys = new FakeTunnelSystem();
  const checkpoints: Harness["checkpoints"] = [];
  const tunnels = new ReviewTunnels(store.db, sys, { checkpoint: (sessionId, text) => checkpoints.push({ sessionId, text }) });
  // Real path: the manager resolves the dirs it serves from, and TMPDIR may sit behind a symlink.
  const worktree = realpathSync(mkdtempSync(join(tmpdir(), "standup-rt-wt-")));
  mkdirSync(join(worktree, "ui"));
  const launch: Harness["launch"] = (config = { serve: SERVE, dir: "ui" }, opts = {}) => {
    const layer: PipelineOverride = config ? { reviewTunnel: config } : {};
    setPipelineConfig(store.db, OWNER, "proj", layer);
    const sessionId = `sess-${randomUUID().slice(0, 8)}`;
    createSession(store.db, { id: sessionId, projectId: "proj", title: "Worker", cwd: worktree, status: "running" });
    const l = createLaunch(store.db, {
      id: randomUUID(),
      projectId: "proj",
      task: "ship",
      worktreePath: worktree,
      branch: opts.branch ?? "standup/acme-web",
      baseBranch: "main",
      status: "running",
      sessionId,
      requester: OWNER,
      launchedBy: OWNER,
    });
    let jobId: string | undefined;
    if (opts.job) {
      const thread = getOrCreatePersonaConsoleThread(store.db, OWNER);
      jobId = createPersonaJob(store.db, { owner: OWNER, threadId: thread.id, title: opts.job, goal: "g" }).id;
      linkPersonaJobLaunch(store.db, jobId, l.id);
    }
    const run = startPipelineForLaunch(store.db, { launchId: l.id, owner: OWNER, projectId: "proj" });
    return { launchId: l.id, run, jobId };
  };
  return { store, sys, tunnels, checkpoints, worktree, launch };
}

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(() => {
  rmSync(h.worktree, { recursive: true, force: true });
});

describe("open", () => {
  test("serves the branch build, then tunnels it, and records url, port and pids", async () => {
    const { launchId, run } = h.launch(undefined, { job: "Acme web" });
    const result = await h.tunnels.open(run);
    expect("opened" in result).toBe(true);
    const t = (result as { opened: import("@standup/shared").ReviewTunnel }).opened;
    expect(t).toMatchObject({
      launchId,
      runId: run.id,
      owner: OWNER,
      status: "open",
      port: 5200,
      name: "alice-acme-web",
      url: fakeTunnelUrl("alice-acme-web"),
    });
    const [serve, tunnel] = h.sys.processes;
    expect(serve!.argv).toEqual(["node", "node_modules/.bin/vite", "--host", "127.0.0.1", "--port", "5200", "--strictPort"]);
    expect(serve!.cwd).toBe(join(h.worktree, "ui"));
    // Branch code runs without the owner's credentials; the tunnel CLI keeps them (it signs in as the owner).
    expect(serve!.credentials).toBe(false);
    // The provider's command, its unset optional region and allow dropped with their options.
    expect(tunnel!.argv).toEqual(["/fake/tunnelctl", "open", "5200", "--name", "acme-web"]);
    expect(tunnel!.credentials).toBe(true);
    expect(t.servePid).toBe(serve!.pid);
    expect(t.tunnelPid).toBe(tunnel!.pid);
    expect(Date.parse(t.expiresAt!) - h.sys.clock.getTime()).toBe(24 * 3_600_000);
    expect(h.checkpoints.at(-1)!.text).toContain(`Review tunnel open: ${fakeTunnelUrl("alice-acme-web")}`);
  });

  test("the project's region and allow list reach the provider's command", async () => {
    const { run } = h.launch({ serve: SERVE, dir: "ui", region: "eu-west-1", allow: "bob,group:reviewers" });
    expect("opened" in (await h.tunnels.open(run))).toBe(true);
    expect(h.sys.live()[0]!.argv).toEqual([
      "/fake/tunnelctl", "open", "5200", "--name", "acme-web", "--region", "eu-west-1", "--allow", "bob,group:reviewers",
    ]);
  });

  test("a disabled tunnel provider opens nothing and starts no process", async () => {
    h.sys.provider = disabledTunnelProvider;
    const result = await h.tunnels.open(h.launch().run);
    expect(result).toEqual({ skipped: disabledTunnelProvider.disabledReason! });
    expect(h.sys.processes).toEqual([]);
  });

  test("an audience the provider can't pass fails before setup runs, naming the cause", async () => {
    h.sys.provider = commandTunnelProvider({ create: "/fake/tunnelctl open {port} --name {name} --private", url: fakeTunnelUrl("{name}") });
    const { run } = h.launch({ serve: SERVE, dir: "ui", setup: "npm ci", allow: "bob" });
    const result = await h.tunnels.open(run);
    expect(result).toEqual({ failed: expect.stringContaining("has no {allow}") });
    expect(h.sys.runs).toEqual([]);
    expect(h.sys.processes).toEqual([]);
    expect(listLiveReviewTunnels(h.store.db)).toEqual([]);
    expect(h.checkpoints.at(-1)!.text).toContain('the audience "bob"');
  });

  test("a project with no serve command, or turned off, opens nothing", async () => {
    expect(await h.tunnels.open(h.launch(null).run)).toEqual({ skipped: "the project has no review tunnel configured" });
    expect(await h.tunnels.open(h.launch({ serve: SERVE, enabled: false }).run)).toEqual({
      skipped: "the project has no review tunnel configured",
    });
    expect(h.sys.processes).toEqual([]);
  });

  test("is idempotent per launch, and a second open while one is in flight waits for nothing", async () => {
    const { run } = h.launch();
    const [a, b] = await Promise.all([h.tunnels.open(run), h.tunnels.open(run)]);
    expect("opened" in a).toBe(true);
    expect(b).toEqual({ skipped: "an opening is already in flight" });
    expect("existing" in (await h.tunnels.open(run))).toBe(true);
    expect(h.sys.live().length).toBe(1);
  });

  test("passes --allow and --region through", async () => {
    const { run } = h.launch({ serve: SERVE, allow: "group:reviewers", region: "eu-1" });
    await h.tunnels.open(run);
    expect(h.sys.live()[0]!.argv.slice(-4)).toEqual(["--region", "eu-1", "--allow", "group:reviewers"]);
  });

  test("runs setup unless its skip path exists", async () => {
    const first = h.launch({ serve: SERVE, dir: "ui", setup: "npm ci --no-audit", setupSkipIf: "node_modules" });
    await h.tunnels.open(first.run);
    expect(h.sys.runs.map(({ argv, cwd }) => ({ argv, cwd }))).toEqual([{ argv: ["npm", "ci", "--no-audit"], cwd: join(h.worktree, "ui") }]);
    mkdirSync(join(h.worktree, "ui", "node_modules"));
    const second = h.launch({ serve: SERVE, dir: "ui", setup: "npm ci --no-audit", setupSkipIf: "node_modules" });
    await h.tunnels.open(second.run);
    expect(h.sys.runs.length).toBe(1);
  });

  test("a failing setup fails the opening and frees the port", async () => {
    h.sys.setupCode = 1;
    const { run, launchId } = h.launch({ serve: SERVE, setup: "npm ci" });
    const result = await h.tunnels.open(run);
    expect(result).toMatchObject({ failed: "setup (npm ci) exited 1", tunnel: { status: "failed", launchId } });
    expect(listLiveReviewTunnels(h.store.db)).toEqual([]);
    expect(h.sys.processes.filter((p) => p.alive)).toEqual([]);
  });

  test("a port taken while setup ran fails the opening instead of serving next to it", async () => {
    const { run } = h.launch({ serve: SERVE, setup: "npm ci" });
    h.sys.duringSetup = () => h.sys.busy.add(5200);
    expect(await h.tunnels.open(run)).toMatchObject({ failed: "127.0.0.1:5200 was taken while setup ran" });
    expect(h.sys.live("node")).toEqual([]);
    expect(h.sys.live()).toEqual([]);
  });

  test("a serve that exits while something else answers on its port is never published", async () => {
    h.sys.serveExitsAfterAnswer = true;
    const { run } = h.launch();
    const result = await h.tunnels.open(run);
    expect((result as { failed: string }).failed).toBe("the serve command exited; 127.0.0.1:5200 is held by another process");
    expect(h.sys.processes.some((p) => p.argv[0] === "/fake/tunnelctl")).toBe(false);
  });

  test("the tunnel CLI runs from Standup's own directory, never the worktree", async () => {
    await h.tunnels.open(h.launch().run);
    expect(h.sys.live()[0]!.cwd).toBe("/fake/review-tunnels");
  });

  test("a name the tunnel service already lists (a hand-made tunnel) is never taken over", async () => {
    h.sys.listed = [{ name: "alice-acme-web", pid: 1234, localPort: 6000, hostname: h.sys.hostname }];
    const r = (await h.tunnels.open(h.launch(undefined, { job: "Acme web" }).run)) as { opened: ReviewTunnel };
    expect(r.opened.name).toBe("alice-acme-web-2");
    expect(h.sys.live()[0]!.argv).toContain("acme-web-2");
  });

  test.each([["Alice_Smith"], ["bob.jones"], ["x".repeat(40)]])("host user %p: the suffix handed to --name is the name's own, never a reserved one", async (hostUser) => {
    h.sys.hostUser = hostUser;
    const r = (await h.tunnels.open(h.launch(undefined, { job: "xdemo" }).run)) as { opened: ReviewTunnel };
    const argv = h.sys.live()[0]!.argv;
    const suffix = argv[argv.indexOf("--name") + 1]!;
    expect(r.opened.name.endsWith(`-${suffix}`)).toBe(true);
    expect(suffix).toBe("xdemo");
    expect(r.opened.name.length).toBeLessThanOrEqual(63);
  });

  test("a serve that never answers is killed and the opening fails", async () => {
    h.sys.serveAnswers = false;
    const { run } = h.launch();
    const result = await h.tunnels.open(run);
    expect((result as { failed: string }).failed).toContain("nothing answered on 127.0.0.1:5200");
    expect(h.sys.killed).toEqual([h.sys.processes[0]!.pid]);
    expect(h.sys.live().length).toBe(0);
  });

  test("a tunnel process that exits fails the opening and stops the serve", async () => {
    h.sys.tunnelStays = false;
    const { run } = h.launch();
    const result = await h.tunnels.open(run);
    expect((result as { failed: string }).failed).toContain("the tunnel process exited");
    expect(h.sys.processes[0]!.alive).toBe(false);
  });

  test("a dir that isn't in the worktree fails before anything starts", async () => {
    symlinkSync(tmpdir(), join(h.worktree, "escape"));
    const { run } = h.launch({ serve: SERVE, dir: "escape" });
    expect(await h.tunnels.open(run)).toEqual({ failed: "escape leaves the worktree" });
    expect(await h.tunnels.open(h.launch({ serve: SERVE, dir: "missing" }).run)).toEqual({ failed: "missing does not exist in the worktree" });
    expect(h.sys.processes).toEqual([]);
  });

  test("a cleaned launch gets no tunnel", async () => {
    const { run, launchId } = h.launch();
    updateLaunchStatus(h.store.db, launchId, "cleaned");
    expect(await h.tunnels.open(run)).toEqual({ skipped: "the launch is cleaned" });
  });
});

describe("port allocation", () => {
  test("skips reserved, busy and held ports, lowest first", async () => {
    const a = h.launch({ serve: SERVE, portRange: [5172, 5177] });
    h.sys.busy.add(5172);
    // 5173 is the Standup console's: never used, even when free.
    await h.tunnels.open(a.run);
    expect(getReviewTunnel(h.store.db, listLiveReviewTunnels(h.store.db)[0]!.id)!.port).toBe(5174);
    const b = h.launch({ serve: SERVE, portRange: [5172, 5177] }, { branch: "standup/other" });
    await h.tunnels.open(b.run);
    expect(listLiveReviewTunnels(h.store.db).map((t) => t.port)).toEqual([5174, 5175]);
  });

  test("skips the collector's own ports by default", async () => {
    const a = h.launch({ serve: SERVE, portRange: [7777, 7779] });
    await h.tunnels.open(a.run);
    expect(listLiveReviewTunnels(h.store.db).map((t) => t.port)).toEqual([7779]);
  });

  test("by default reserves no port outside Standup's own", async () => {
    const tunnels = new ReviewTunnels(h.store.db, h.sys, { checkpoint: () => {} }, reservedTunnelsFromEnv({}));
    const a = h.launch({ serve: SERVE, portRange: [5250, 5251] });
    await tunnels.open(a.run);
    expect(listLiveReviewTunnels(h.store.db).map((t) => t.port)).toEqual([5250]);
  });

  test("skips a port the owner reserved for a standing tunnel", async () => {
    const tunnels = new ReviewTunnels(h.store.db, h.sys, { checkpoint: () => {} }, STANDING);
    const a = h.launch({ serve: SERVE, portRange: [5250, 5252] });
    await tunnels.open(a.run);
    expect(listLiveReviewTunnels(h.store.db).map((t) => t.port)).toEqual([5251]);
  });

  test("concurrent openings of different launches never share a port or name", async () => {
    const runs = Array.from({ length: 6 }, () => h.launch({ serve: SERVE, portRange: [5200, 5210] }).run);
    const results = await Promise.all(runs.map((r) => h.tunnels.open(r)));
    expect(results.every((r) => "opened" in r)).toBe(true);
    const live = listLiveReviewTunnels(h.store.db);
    expect(new Set(live.map((t) => t.port)).size).toBe(6);
    expect(new Set(live.map((t) => t.name)).size).toBe(6);
    expect(live.map((t) => t.name).sort()[0]).toBe("alice-acme-web");
  });

  test("an exhausted range fails with the range named", async () => {
    const a = h.launch({ serve: SERVE, portRange: [5200, 5200] });
    await h.tunnels.open(a.run);
    const b = h.launch({ serve: SERVE, portRange: [5200, 5200] });
    expect(await h.tunnels.open(b.run)).toEqual({ failed: "no free port in 5200-5200" });
  });

  test("a range of reserved ports only fails naming them, and starts nothing", async () => {
    const a = h.launch({ serve: SERVE, portRange: [5173, 5173] });
    expect(await h.tunnels.open(a.run)).toEqual({
      failed: "port range 5173-5173 holds only reserved ports (5173, 7777, 7778)",
    });
    expect(listLiveReviewTunnels(h.store.db)).toEqual([]);
    expect(h.sys.processes).toEqual([]);
  });

  test("the store refuses a second live row on the same port, name or launch", () => {
    const base = { launchId: "l1", owner: OWNER, name: "alice-a", url: "u", port: 5300 };
    expect("tunnel" in claimReviewTunnel(h.store.db, base)).toBe(true);
    expect(claimReviewTunnel(h.store.db, { ...base, launchId: "l2", name: "alice-b" })).toEqual({ conflict: "port" });
    expect(claimReviewTunnel(h.store.db, { ...base, launchId: "l2", port: 5301 })).toEqual({ conflict: "name" });
    expect(claimReviewTunnel(h.store.db, { ...base, name: "alice-c", port: 5302 })).toEqual({ conflict: "launch" });
  });
});

describe("close and teardown paths", () => {
  async function opened(config?: ReviewTunnelConfig, opts?: { job?: string }) {
    const l = h.launch(config, opts);
    const r = await h.tunnels.open(l.run);
    return { ...l, tunnel: (r as { opened: import("@standup/shared").ReviewTunnel }).opened };
  }

  test("close stops both process groups and records the reason", async () => {
    const { tunnel } = await opened();
    expect(h.tunnels.close(tunnel.id, "manual")).toBe(true);
    expect(h.sys.killed.sort()).toEqual([tunnel.servePid!, tunnel.tunnelPid!].sort());
    expect(getReviewTunnel(h.store.db, tunnel.id)).toMatchObject({ status: "closed", closeReason: "manual" });
    expect(h.checkpoints.at(-1)!.text).toContain("torn down (manual)");
    // Once only.
    expect(h.tunnels.close(tunnel.id, "manual")).toBe(false);
  });

  test("a pid the OS reused for something else is left alone", async () => {
    const { tunnel } = await opened();
    h.sys.crash(tunnel.servePid!);
    h.sys.foreign.set(tunnel.servePid!, "/usr/bin/some-other-program --flag");
    h.tunnels.close(tunnel.id, "manual");
    expect(h.sys.killed).toEqual([tunnel.tunnelPid!]);
  });

  test("closeForJob tears down the job's tunnels only", async () => {
    const mine = await opened(undefined, { job: "Mine" });
    const other = await opened(undefined, { job: "Other" });
    expect(h.tunnels.closeForJob(mine.jobId!, "job_closed")).toEqual([mine.tunnel.id]);
    expect(getReviewTunnel(h.store.db, other.tunnel.id)!.status).toBe("open");
  });

  test("closeForLaunch", async () => {
    const { tunnel, launchId } = await opened();
    expect(h.tunnels.closeForLaunch(launchId, "review_decided")).toEqual([tunnel.id]);
    expect(getReviewTunnel(h.store.db, tunnel.id)!.closeReason).toBe("review_decided");
  });

  test("closing while setup runs stops the setup and leaves no process behind", async () => {
    const l = h.launch({ serve: SERVE, setup: "npm ci" });
    h.sys.duringSetup = () => {
      const live = listLiveReviewTunnels(h.store.db)[0]!;
      h.tunnels.close(live.id, "job_closed");
    };
    const result = await h.tunnels.open(l.run);
    expect(result).toMatchObject({ failed: "closed while opening" });
    expect(h.sys.killed).toEqual([h.sys.runs[0]!.pid]);
    expect(h.sys.processes.filter((p) => p.alive)).toEqual([]);
    // No "failed to open" notice for a tunnel that was closed on purpose.
    expect(h.checkpoints.some((c) => c.text.includes("failed to open"))).toBe(false);
  });

  test("a group whose leader died still serves, so it isn't lost — and teardown still stops it", async () => {
    const { tunnel } = await opened();
    const child = h.sys.child(tunnel.servePid!, ["node", "vite", "--port", String(tunnel.port)]);
    h.sys.crash(tunnel.servePid!);
    expect(h.tunnels.sweep().closed).toEqual([]);
    h.tunnels.close(tunnel.id, "manual");
    expect(h.sys.killed).toContain(tunnel.servePid!);
    expect(h.sys.processes.find((p) => p.pid === child)!.alive).toBe(false);
  });

  test("a teardown while the opening waits for its port posts no false 'failed to open'", async () => {
    const l = h.launch();
    h.sys.waitForPort = async () => {
      h.tunnels.close(listLiveReviewTunnels(h.store.db)[0]!.id, "job_closed");
      return false;
    };
    expect(await h.tunnels.open(l.run)).toMatchObject({ failed: "closed while opening" });
    expect(h.checkpoints.some((c) => c.text.includes("failed to open"))).toBe(false);
  });

  test("when the provider's tunnels can't be listed, the name carries the launch id so it can't collide", async () => {
    h.sys.listed = null;
    const l = h.launch(undefined, { job: "Acme web" });
    const r = (await h.tunnels.open(l.run)) as { opened: ReviewTunnel };
    expect(r.opened.name).toBe(`alice-acme-web-${l.launchId.slice(0, 6)}`);
  });

  test("when ps can't tell, the stop is retried by the next sweep instead of given up", async () => {
    const { tunnel } = await opened();
    h.sys.psBroken = true;
    expect(h.tunnels.close(tunnel.id, "manual")).toBe(true);
    expect(h.sys.killed).toEqual([]);
    // Still unknown: still nothing killed, nothing forgotten.
    h.tunnels.sweep();
    expect(h.sys.killed).toEqual([]);
    h.sys.psBroken = false;
    h.tunnels.sweep();
    expect(h.sys.killed.sort()).toEqual([tunnel.servePid!, tunnel.tunnelPid!].sort());
    h.sys.killed = [];
    h.tunnels.sweep();
    expect(h.sys.killed).toEqual([]);
  });

  test("the reconcile stops a recently closed tunnel's group that still runs (a stop lost to a restart)", async () => {
    const { tunnel } = await opened();
    h.sys.psBroken = true;
    h.tunnels.close(tunnel.id, "manual");
    // A new collector: nothing in memory to retry.
    h.sys.psBroken = false;
    const fresh = new ReviewTunnels(h.store.db, h.sys, { checkpoint: () => {} });
    await fresh.reconcile();
    expect(h.sys.killed.sort()).toEqual([tunnel.servePid!, tunnel.tunnelPid!].sort());
  });

  test("the reconcile never re-checks a tunnel whose stop was verified, even if its ids are reused", async () => {
    const { tunnel } = await opened();
    h.tunnels.close(tunnel.id, "manual");
    h.sys.killed = [];
    // An unrelated group now holds the old ids and happens to name the port.
    h.sys.foreign.set(tunnel.servePid!, `sleep ${tunnel.port}`);
    await new ReviewTunnels(h.store.db, h.sys, { checkpoint: () => {} }).reconcile();
    expect(h.sys.killed).toEqual([]);
  });

  test("an unverified stop from before the host booted is never retried", async () => {
    const { tunnel } = await opened();
    h.sys.psBroken = true;
    h.tunnels.close(tunnel.id, "manual");
    h.sys.psBroken = false;
    // The host rebooted since: the recorded groups can't be Standup's any more.
    h.sys.booted = new Date(Date.now() + 60_000);
    await new ReviewTunnels(h.store.db, h.sys, { checkpoint: () => {} }).reconcile();
    expect(h.sys.killed).toEqual([]);
  });

  test("a teardown during the last tunnel-list check means the credentialed CLI never starts", async () => {
    const l = h.launch();
    let calls = 0;
    h.sys.listTunnels = async () => {
      if (++calls === 2) h.tunnels.close(listLiveReviewTunnels(h.store.db)[0]!.id, "job_closed");
      return [];
    };
    expect(await h.tunnels.open(l.run)).toMatchObject({ failed: "closed while opening" });
    expect(h.sys.processes.some((p) => p.argv[0] === "/fake/tunnelctl")).toBe(false);
    expect(h.sys.live("node")).toEqual([]);
  });

  test("a failed opening whose processes can't be checked is flagged for the retry", async () => {
    h.sys.tunnelStays = false;
    const l = h.launch();
    const origGroup = h.sys.groupMentions;
    h.sys.groupMentions = () => null;
    const r = (await h.tunnels.open(l.run)) as { failed: string; tunnel: ReviewTunnel };
    expect(r.failed).toContain("the tunnel process exited");
    h.sys.groupMentions = origGroup;
    h.tunnels.sweep();
    expect(h.sys.killed).toContain(r.tunnel.servePid!);
  });

  test("a tunnel that took the name while setup ran is never taken over", async () => {
    const l = h.launch({ serve: SERVE, setup: "npm ci" }, { job: "Acme web" });
    h.sys.duringSetup = () => {
      h.sys.listed = [{ name: "alice-acme-web", pid: 777, localPort: 6001, hostname: h.sys.hostname }];
    };
    expect(await h.tunnels.open(l.run)).toMatchObject({ failed: "a tunnel named alice-acme-web appeared while this one was opening" });
    expect(h.sys.processes.some((p) => p.argv[0] === "/fake/tunnelctl")).toBe(false);
  });

  test("a reused pid whose command line merely contains the port's digits is left alone", async () => {
    const { tunnel } = await opened();
    h.sys.crash(tunnel.servePid!);
    h.sys.foreign.set(tunnel.servePid!, `/usr/bin/other --listen ${tunnel.port}1 --started 1${tunnel.port}`);
    h.tunnels.close(tunnel.id, "manual");
    expect(h.sys.killed).toEqual([tunnel.tunnelPid!]);
  });
});

describe("sweep", () => {
  async function openedLaunch(opts: { job?: string } = {}, config?: ReviewTunnelConfig) {
    const l = h.launch(config, opts);
    const r = (await h.tunnels.open(l.run)) as { opened: import("@standup/shared").ReviewTunnel };
    return { ...l, tunnel: r.opened };
  }

  test("keeps a healthy tunnel", async () => {
    await openedLaunch({ job: "J" });
    expect(h.tunnels.sweep()).toEqual({ closed: [], leaked: [] });
  });

  test("past its TTL: expired", async () => {
    const { tunnel } = await openedLaunch({}, { serve: SERVE, ttlHours: 1 });
    h.sys.clock = new Date(h.sys.clock.getTime() + 3_600_001);
    expect(h.tunnels.sweep().closed).toEqual([{ id: tunnel.id, reason: "expired" }]);
  });

  test.each(["done", "failed", "cancelled"] as const)("its job %s: job_closed", async (status) => {
    const { tunnel, jobId } = await openedLaunch({ job: "J" });
    updatePersonaJob(h.store.db, jobId!, { status, outcome: "x" });
    expect(h.tunnels.sweep().closed).toEqual([{ id: tunnel.id, reason: "job_closed" }]);
  });

  test("its job closed while the collector was down: the start reconcile of a fresh collector tears it down", async () => {
    const { tunnel, jobId } = await openedLaunch({ job: "J" });
    updatePersonaJob(h.store.db, jobId!, { status: "done", outcome: "x" });
    const fresh = new ReviewTunnels(h.store.db, h.sys, { checkpoint: () => {} });
    expect((await fresh.reconcile()).closed).toEqual([{ id: tunnel.id, reason: "job_closed" }]);
    expect(h.sys.killed.sort()).toEqual([tunnel.servePid!, tunnel.tunnelPid!].sort());
    expect(listLiveReviewTunnels(h.store.db)).toEqual([]);
  });

  test("its launch cleaned: launch_ended; a stopped launch keeps its tunnel", async () => {
    const a = await openedLaunch();
    updateLaunchStatus(h.store.db, a.launchId, "failed", "Stopped by you");
    expect(h.tunnels.sweep().closed).toEqual([]);
    updateLaunchStatus(h.store.db, a.launchId, "cleaned");
    expect(h.tunnels.sweep().closed).toEqual([{ id: a.tunnel.id, reason: "launch_ended" }]);
  });

  test("its run complete (review approved): review_decided", async () => {
    const { tunnel, run } = await openedLaunch();
    updatePipelineRun(h.store.db, run.id, { status: "complete", currentStage: "complete" });
    expect(h.tunnels.sweep().closed).toEqual([{ id: tunnel.id, reason: "review_decided" }]);
  });

  test("its run turned off (a Best-of-N attempt that wasn't picked): run_disabled", async () => {
    const { tunnel, run } = await openedLaunch();
    updatePipelineRun(h.store.db, run.id, { status: "disabled" });
    expect(h.tunnels.sweep().closed).toEqual([{ id: tunnel.id, reason: "run_disabled" }]);
  });

  test("an opening the collector abandoned mid-way is swept as lost once it can't still be opening", async () => {
    const t = claimReviewTunnel(h.store.db, { launchId: h.launch().launchId, owner: OWNER, name: "alice-stuck", url: "u", port: 5299 });
    if (!("tunnel" in t)) throw new Error("claim failed");
    expect(h.tunnels.sweep().closed).toEqual([]);
    h.sys.clock = new Date(Date.parse(t.tunnel.updatedAt) + 13 * 60_000);
    expect(h.tunnels.sweep().closed).toEqual([{ id: t.tunnel.id, reason: "lost" }]);
  });

  test("a dead pid reused by an unrelated process still counts as dead: lost", async () => {
    const { tunnel } = await openedLaunch();
    h.sys.crash(tunnel.tunnelPid!);
    h.sys.foreign.set(tunnel.tunnelPid!, "/usr/sbin/sshd -D");
    expect(h.tunnels.sweep().closed).toEqual([{ id: tunnel.id, reason: "lost" }]);
    expect(h.sys.killed).toEqual([tunnel.servePid!]);
  });

  test("while ps can't tell, a tunnel isn't declared lost", async () => {
    await openedLaunch();
    h.sys.psBroken = true;
    expect(h.tunnels.sweep().closed).toEqual([]);
  });

  test("a process died: lost, and the survivor is stopped", async () => {
    const { tunnel } = await openedLaunch();
    h.sys.crash(tunnel.tunnelPid!);
    expect(h.tunnels.sweep().closed).toEqual([{ id: tunnel.id, reason: "lost" }]);
    expect(h.sys.killed).toEqual([tunnel.servePid!]);
  });
});

describe("reconcile", () => {
  test("stops a leaked tunnel process Standup opened but no live row holds", async () => {
    const l = h.launch();
    const r = (await h.tunnels.open(l.run)) as { opened: import("@standup/shared").ReviewTunnel };
    h.tunnels.close(r.opened.id, "manual");
    h.sys.killed = [];
    // The tunnel service still lists it: a respawned or orphaned copy on this host.
    h.sys.foreign.set(91_001, "/fake/tunnelctl open 5200 --name acme-web");
    h.sys.listed = [{ name: r.opened.name, pid: 91_001, localPort: 5200, hostname: h.sys.hostname }];
    expect((await h.tunnels.reconcile()).leaked).toEqual([{ name: r.opened.name, pid: 91_001 }]);
    expect(h.sys.killed).toEqual([91_001]);
  });

  test("never touches a reserved standing tunnel, Standup's own, other hosts' or names Standup didn't open", async () => {
    const tunnels = new ReviewTunnels(h.store.db, h.sys, { checkpoint: () => {} }, STANDING);
    const l = h.launch();
    const r = (await tunnels.open(l.run)) as { opened: import("@standup/shared").ReviewTunnel };
    tunnels.close(r.opened.id, "manual");
    h.sys.killed = [];
    // Even a review_tunnels row under a reserved name can't make the standing tunnel a target.
    claimReviewTunnel(h.store.db, { launchId: "x", owner: OWNER, name: "alice-kiosk", url: "u", port: 5250 });
    h.store.db.run("UPDATE review_tunnels SET status = 'closed' WHERE name = 'alice-kiosk'");
    for (const [pid, cmd] of [
      [91_002, "/fake/tunnelctl open 5250 --name kiosk"],
      [91_003, "/fake/tunnelctl open 5173 --name standup"],
      [91_004, "/fake/tunnelctl open 5200 --name acme-web"],
      [91_005, "/fake/tunnelctl open 5400 --name something-else"],
    ] as const) {
      h.sys.foreign.set(pid, cmd);
    }
    h.sys.listed = [
      { name: "alice-kiosk", pid: 91_002, localPort: 5250, hostname: h.sys.hostname },
      { name: "alice-standup", pid: 91_003, localPort: 5173, hostname: h.sys.hostname },
      { name: r.opened.name, pid: 91_004, localPort: 5200, hostname: "alice-elsewhere-host" },
      { name: "alice-something-else", pid: 91_005, localPort: 5400, hostname: h.sys.hostname },
    ];
    expect((await tunnels.reconcile()).leaked).toEqual([]);
    expect(h.sys.killed).toEqual([]);
  });

  test("by default never touches Standup's console tunnel, by its name or by Standup's ports", async () => {
    // Rows that make each endpoint a known one: the console tunnel's own name, and a review name on each of Standup's ports.
    for (const [name, port] of [["alice-standup", 5173], ["alice-old-ui", 5173], ["alice-old-api", 7777]] as const) {
      claimReviewTunnel(h.store.db, { launchId: `x-${name}`, owner: OWNER, name, url: "u", port });
      h.store.db.run("UPDATE review_tunnels SET status = 'closed' WHERE name = ?", [name]);
    }
    for (const [pid, cmd] of [
      [92_001, "/fake/tunnelctl open 5173 --name standup"],
      [92_002, "/fake/tunnelctl open 5173 --name old-ui"],
      [92_003, "/fake/tunnelctl open 7777 --name old-api"],
    ] as const) {
      h.sys.foreign.set(pid, cmd);
    }
    h.sys.listed = [
      { name: "alice-standup", pid: 92_001, localPort: 5173, hostname: h.sys.hostname },
      { name: "alice-old-ui", pid: 92_002, localPort: 5173, hostname: h.sys.hostname },
      { name: "alice-old-api", pid: 92_003, localPort: 7777, hostname: h.sys.hostname },
    ];
    expect((await h.tunnels.reconcile()).leaked).toEqual([]);
    expect(h.sys.killed).toEqual([]);
  });

  test("leaves a live row's own tunnel alone, even when the service reports another pid (a launcher)", async () => {
    const l = h.launch();
    const r = (await h.tunnels.open(l.run)) as { opened: import("@standup/shared").ReviewTunnel };
    h.sys.foreign.set(95_000, `/real/tunnelctl open ${r.opened.port} --name acme-web`);
    for (const pid of [r.opened.tunnelPid, 95_000]) {
      h.sys.listed = [{ name: r.opened.name, pid, localPort: r.opened.port, hostname: h.sys.hostname }];
      expect(await h.tunnels.reconcile()).toEqual({ closed: [], leaked: [] });
    }
    expect(h.sys.killed).toEqual([]);
  });

  test("an old review tunnel's name, reused by hand on another port or with no hostname, is left alone", async () => {
    const l = h.launch();
    const r = (await h.tunnels.open(l.run)) as { opened: import("@standup/shared").ReviewTunnel };
    h.tunnels.close(r.opened.id, "manual");
    h.sys.killed = [];
    h.sys.foreign.set(96_000, "/fake/tunnelctl open 6100 --name acme-web");
    h.sys.foreign.set(96_001, `/fake/tunnelctl open ${r.opened.port} --name acme-web`);
    h.sys.listed = [
      { name: r.opened.name, pid: 96_000, localPort: 6100, hostname: h.sys.hostname },
      { name: r.opened.name, pid: 96_001, localPort: r.opened.port },
    ];
    expect((await h.tunnels.reconcile()).leaked).toEqual([]);
    expect(h.sys.killed).toEqual([]);
  });

  test("runs the sweep first (start-up after the collector was down)", async () => {
    const { run, jobId } = h.launch(undefined, { job: "J" });
    const r = (await h.tunnels.open(run)) as { opened: import("@standup/shared").ReviewTunnel };
    updatePersonaJob(h.store.db, jobId!, { status: "done", outcome: "x" });
    h.sys.listed = null;
    expect((await h.tunnels.reconcile()).closed).toEqual([{ id: r.opened.id, reason: "job_closed" }]);
  });
});

describe("helpers", () => {
  test("isReservedTunnelName", () => {
    expect(isReservedTunnelName("owner-preview", "owner")).toBe(false);
    expect(isReservedTunnelName("owner-standup", "owner")).toBe(true);
    expect(isReservedTunnelName("someone-x", "owner")).toBe(true);
    expect(isReservedTunnelName("owner-standup-review", "owner")).toBe(false);
    expect(isReservedTunnelName("owner-kiosk", "owner", STANDING.suffixes)).toBe(true);
    expect(isReservedTunnelName("owner-kiosk-review", "owner", STANDING.suffixes)).toBe(false);
  });

  test("the reserved ports and suffixes are only Standup's own unless the owner adds some", () => {
    const own = reservedTunnelsFromEnv({});
    expect([...own.ports].sort((a, b) => a - b)).toEqual([5173, 7777, 7778]);
    expect([...own.suffixes].sort()).toEqual(["standup"]);
    expect(own.invalid).toEqual([]);
    expect([...STANDUP_OWN_PORTS].sort((a, b) => a - b)).toEqual([5173, 7777, 7778]);
  });

  const reservedCases: Array<[string, string | undefined, string | undefined, number[], string[], string[]]> = [
    // name, ports setting, suffixes setting, ports added, suffixes added, entries refused
    ["unset", undefined, undefined, [], [], []],
    ["a port and a suffix", "5300", "kiosk", [5300], ["kiosk"], []],
    ["lists, spaced, with empties", " 5300, 9300 ,,", "Kiosk , kiosk-ui", [5300, 9300], ["kiosk", "kiosk-ui"], []],
    [
      "entries that don't parse are refused",
      "0,65536,52x,-1",
      "bad suffix,-x,x-,a.b",
      [],
      [],
      [
        `${RESERVED_PORTS_ENV}: 0`,
        `${RESERVED_PORTS_ENV}: 65536`,
        `${RESERVED_PORTS_ENV}: 52x`,
        `${RESERVED_PORTS_ENV}: -1`,
        `${RESERVED_SUFFIXES_ENV}: bad suffix`,
        `${RESERVED_SUFFIXES_ENV}: -x`,
        `${RESERVED_SUFFIXES_ENV}: x-`,
        `${RESERVED_SUFFIXES_ENV}: a.b`,
      ],
    ],
  ];
  for (const [name, ports, suffixes, addedPorts, addedSuffixes, invalid] of reservedCases) {
    test(`reservedTunnelsFromEnv: ${name}`, () => {
      const env: Record<string, string> = {};
      if (ports !== undefined) env[RESERVED_PORTS_ENV] = ports;
      if (suffixes !== undefined) env[RESERVED_SUFFIXES_ENV] = suffixes;
      const got = reservedTunnelsFromEnv(env);
      const own = reservedTunnelsFromEnv({});
      expect([...got.ports].filter((p) => !own.ports.has(p))).toEqual(addedPorts);
      expect([...got.suffixes].filter((s) => !own.suffixes.has(s))).toEqual(addedSuffixes);
      for (const p of own.ports) expect(got.ports.has(p)).toBe(true);
      for (const s of own.suffixes) expect(got.suffixes.has(s)).toBe(true);
      expect(got.invalid).toEqual(invalid);
    });
  }

  test("commandArgv fills every {port}", () => {
    expect(commandArgv("serve --port={port} --url http://127.0.0.1:{port}", 5201)).toEqual([
      "serve",
      "--port=5201",
      "--url",
      "http://127.0.0.1:5201",
    ]);
  });

  test("serveDir: the worktree is the package itself", () => {
    const wt = realpathSync(mkdtempSync(join(tmpdir(), "WidgetUI-")));
    try {
      const pkg = join(wt, "WidgetUI");
      mkdirSync(pkg);
      expect(serveDir(pkg, "packages/WidgetUI")).toEqual({ dir: pkg });
      expect(serveDir("", "x")).toEqual({ error: "the launch has no worktree" });
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});
