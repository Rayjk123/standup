import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import type { Launch, PersonaJob } from "@standup/shared";
import {
  createLaunch,
  createPersonaJob,
  createSession,
  createStore,
  endSession,
  getLaunch,
  getOrCreatePersonaConsoleThread,
  linkPersonaJobLaunch,
  updatePersonaJob,
  upsertProject,
} from "@standup/store";
import type { Store } from "@standup/store";
import { onJobClosed } from "./job-hygiene.js";
import { cleanupLaunch } from "./launcher.js";
import type { ProcessRow } from "./process-registry.js";
import { FakeProcessSystem } from "./process-registry-fake.js";
import type { ListedTunnel } from "./review-tunnel/system.js";
import { ensureScratchDir } from "./scratch-dirs.js";
import { reapWorkerTunnels, workerTunnelLaunchPrefix, workerTunnelSuffix } from "./worker-tunnels.js";

const INSTALL = "/srv/me/standup";
const HOST = "devbox-alice";
const r = (pid: number, ppid: number, pgid: number, args: string): ProcessRow => ({ pid, ppid, pgid, uid: 1000, args });

let store: Store;
let sys: FakeProcessSystem;
let scratchRoot: string;
let notes: string[];
/** What the tunnel service lists; an entry whose pid is gone from the process table drops out, as a closed tunnel does. */
let listed: ListedTunnel[];
let listCalls: number;

beforeEach(() => {
  store = createStore(":memory:");
  upsertProject(store.db, { id: "proj", name: "P", branch: "main", repos: [] });
  sys = new FakeProcessSystem(
    [r(900, 1, 900, "/usr/lib/systemd/systemd --user"), r(4000, 900, 4000, "bun run src/index.ts")],
    { selfPid: 4000, uid: 1000 }
  );
  listed = [];
  listCalls = 0;
  sys.tunnels = {
    hostUser: "alice",
    hostname: HOST,
    list: async () => {
      listCalls++;
      return listed.filter((t) => t.pid === undefined || sys.isAlive(t.pid));
    },
  };
  scratchRoot = mkdtempSync(join(tmpdir(), "standup-worker-tunnels-"));
  notes = [];
});

const opts = () => ({
  installDir: INSTALL,
  scratchRoot,
  graceMs: 0,
  note: (_job: PersonaJob, text: string) => notes.push(text),
  paneAlive: () => false,
});

function job(): PersonaJob {
  const thread = getOrCreatePersonaConsoleThread(store.db, "alice");
  return createPersonaJob(store.db, { owner: "alice", threadId: thread.id, title: "J", goal: "g" });
}

/** A worker of `j`: stopped (launch failed, session ended) unless `running`. */
function workerOf(j: PersonaJob | null, opts: { running?: boolean; id?: string } = {}): Launch {
  const sessionId = `s-${randomUUID().slice(0, 8)}`;
  createSession(store.db, { id: sessionId, projectId: "proj", title: "W", cwd: "/wt/proj/a", status: "running" });
  if (!opts.running) endSession(store.db, sessionId);
  const launch = createLaunch(store.db, {
    id: opts.id ?? randomUUID(),
    projectId: "proj",
    task: "t",
    worktreePath: "/wt/proj/a",
    branch: "b",
    status: opts.running ? "running" : "failed",
    sessionId,
  });
  if (j) linkPersonaJobLaunch(store.db, j.id, launch.id);
  ensureScratchDir(launch.id, scratchRoot);
  return getLaunch(store.db, launch.id)!;
}

/** A hand-opened tunnel process on `port` named `suffix`, listed by the service as `alice-<suffix>`. */
function handTunnel(pid: number, port: number, suffix: string, opts: { hostname?: string } = {}): void {
  sys.rows.push(r(pid, 900, pid, `/home/alice/.local/bin/mytunnel expose ${port} --name ${suffix}`));
  listed.push({ name: `alice-${suffix}`, pid, localPort: port, hostname: opts.hostname ?? HOST });
}

describe("worker tunnel names", () => {
  test("a launch's tunnel suffix carries its sw-<id8>- prefix and reads back to that id8", () => {
    const id = "3f2b8c1e-aaaa-4bbb-8ccc-123456789abc";
    expect(workerTunnelSuffix(id, "Favicon Preview")).toBe("sw-3f2b8c1e-favicon-preview");
    expect(workerTunnelLaunchPrefix("alice-sw-3f2b8c1e-favicon-preview", "alice")).toBe("3f2b8c1e");
  });

  test("names without the prefix, another user's and the standing tunnels read as none", () => {
    for (const name of ["alice-favicon", "alice-standup", "alice-sw-3f2b8c1e", "alice-sw-XYZ12345-x", "bob-sw-3f2b8c1e-x", "alice-sw-3f2b8c1e-"]) {
      expect(workerTunnelLaunchPrefix(name, "alice")).toBeNull();
    }
  });
});

describe("close_job stops a finished launch's hand-opened tunnels", () => {
  test("an unregistered tunnel named with the launch's prefix is stopped and noted; a second run is a no-op", async () => {
    const j = job();
    const launch = workerOf(j);
    handTunnel(6000, 5291, workerTunnelSuffix(launch.id, "favicon"));
    updatePersonaJob(store.db, j.id, { status: "done" });

    const first = await onJobClosed(store.db, sys, j.id, "job_closed", opts());
    expect(first.tunnels?.map((t) => [t.name, t.outcome])).toEqual([[`alice-sw-${launch.id.slice(0, 8)}-favicon`, "terminated"]]);
    expect(sys.signals).toEqual([{ target: 6000, sig: "SIGTERM" }]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(`tunnel alice-sw-${launch.id.slice(0, 8)}-favicon (pid 6000, port 5291)`);

    const second = await onJobClosed(store.db, sys, j.id, "job_closed", opts());
    expect(second.tunnels).toBeUndefined();
    expect(sys.signals).toHaveLength(1);
  });

  test("an open job, or a closed job whose worker is still running, keeps its tunnel", async () => {
    const open = job();
    const a = workerOf(open);
    handTunnel(6000, 5291, workerTunnelSuffix(a.id, "a"));
    expect(await reapWorkerTunnels(store.db, sys, opts())).toEqual([]);

    const closed = job();
    const b = workerOf(closed, { running: true });
    handTunnel(6100, 5292, workerTunnelSuffix(b.id, "b"));
    updatePersonaJob(store.db, closed.id, { status: "done" });
    const result = await onJobClosed(store.db, sys, closed.id, "job_closed", { ...opts(), paneAlive: () => true });
    expect(result.tunnels).toBeUndefined();
    expect(sys.signals).toEqual([]);
  });

  test("the standing tunnels, untagged hand-made tunnels, another host's and a reused pid are never touched", async () => {
    const j = job();
    const launch = workerOf(j);
    const suffix = workerTunnelSuffix(launch.id, "x");
    sys.rows.push(r(7000, 900, 7000, "/home/alice/.local/bin/tunnelctl open 5173 --name standup"));
    listed.push({ name: "alice-standup", pid: 7000, localPort: 5173, hostname: HOST });
    handTunnel(7200, 5209, "surfaces-picker");
    handTunnel(7300, 5301, suffix, { hostname: "another-host" });
    // The service still lists this one, but its pid now runs something else.
    sys.rows.push(r(7400, 900, 7400, "sleep 600"));
    listed.push({ name: `alice-${workerTunnelSuffix(launch.id, "y")}`, pid: 7400, localPort: 5302, hostname: HOST });
    // A tagged tunnel on a reserved port is refused too.
    handTunnel(7500, 7777, workerTunnelSuffix(launch.id, "z"));
    updatePersonaJob(store.db, j.id, { status: "done" });

    expect(await reapWorkerTunnels(store.db, sys, opts())).toEqual([]);
    expect(sys.signals).toEqual([]);
  });

  test("an id8 another open launch shares keeps the tunnel", async () => {
    const closed = job();
    const id = randomUUID();
    const twin = `${id.slice(0, 8)}${randomUUID().slice(8)}`;
    workerOf(closed, { id });
    workerOf(job(), { id: twin });
    handTunnel(6000, 5291, workerTunnelSuffix(id, "a"));
    updatePersonaJob(store.db, closed.id, { status: "done" });
    expect(await reapWorkerTunnels(store.db, sys, opts())).toEqual([]);
  });

  test("a launch with no job is reaped once it is cleaned up", async () => {
    const launch = workerOf(null);
    handTunnel(6000, 5291, workerTunnelSuffix(launch.id, "a"));
    expect(await reapWorkerTunnels(store.db, sys, opts())).toEqual([]);
    store.db.run("UPDATE launches SET status = 'cleaned' WHERE id = ?", [launch.id]);
    expect((await reapWorkerTunnels(store.db, sys, opts())).map((t) => t.outcome)).toEqual(["terminated"]);
  });

  test("cleaning up a launch with no job stops its hand-opened tunnel once the cleanup hold is released", async () => {
    const launch = workerOf(null);
    handTunnel(6000, 5291, workerTunnelSuffix(launch.id, "preview"));
    const { log } = await cleanupLaunch(store.db, launch, { id: "proj", name: "P", branch: "main", repos: [] } as never, {
      dataDir: join(scratchRoot, ".data"),
      processSystem: sys,
      scratchRoot,
      run: async () => ({ ok: true, output: "" }),
    });
    expect(getLaunch(store.db, launch.id)!.status).toBe("cleaned");
    expect(log).toContain(`Stopped tunnel alice-sw-${launch.id.slice(0, 8)}-preview (pid 6000, port 5291)`);
    expect(sys.signals).toEqual([{ target: 6000, sig: "SIGTERM" }]);
  });

  test("closing one job leaves another finished job's tunnel to that job's own close", async () => {
    const a = job();
    const b = job();
    const la = workerOf(a);
    const lb = workerOf(b);
    handTunnel(6000, 5291, workerTunnelSuffix(la.id, "a"));
    handTunnel(6100, 5292, workerTunnelSuffix(lb.id, "b"));
    updatePersonaJob(store.db, a.id, { status: "done" });
    updatePersonaJob(store.db, b.id, { status: "done" });
    const result = await onJobClosed(store.db, sys, a.id, "job_closed", opts());
    expect(result.tunnels?.map((t) => t.pid)).toEqual([6000]);
    expect(sys.signals).toEqual([{ target: 6000, sig: "SIGTERM" }]);
  });

  test("a name in another case or with unit characters, run through a versioned install of the CLI, is still read and stopped", async () => {
    const j = job();
    const launch = workerOf(j);
    const suffix = `SW-${launch.id.slice(0, 8).toUpperCase()}-Api_v2.1`;
    sys.rows.push(r(6000, 900, 6000, `/home/alice/.local/share/tunnelctl/1.4.0/bin/tunnelctl open 5291 --name ${suffix}`));
    listed.push({ name: `alice-${suffix}`, pid: 6000, localPort: 5291, hostname: HOST });
    updatePersonaJob(store.db, j.id, { status: "done" });
    expect((await reapWorkerTunnels(store.db, sys, opts())).map((t) => [t.launchId, t.outcome])).toEqual([[launch.id, "terminated"]]);
  });
});

describe("the periodic and startup reap", () => {
  test("stops a closed job's tunnel nothing registered (the backstop doesn't see that job)", async () => {
    const j = job();
    const launch = workerOf(j);
    handTunnel(6000, 5291, workerTunnelSuffix(launch.id, "favicon"));
    updatePersonaJob(store.db, j.id, { status: "cancelled" });
    const stops = await reapWorkerTunnels(store.db, sys, opts());
    expect(stops.map((s) => ({ launchId: s.launchId, pid: s.pid, port: s.port, outcome: s.outcome }))).toEqual([
      { launchId: launch.id, pid: 6000, port: 5291, outcome: "terminated" },
    ]);
  });

  test("a tunnel that ignores SIGTERM gets SIGKILL", async () => {
    const j = job();
    const launch = workerOf(j);
    handTunnel(6000, 5291, workerTunnelSuffix(launch.id, "a"));
    sys.ignoresTerm.add(6000);
    updatePersonaJob(store.db, j.id, { status: "done" });
    expect((await reapWorkerTunnels(store.db, sys, opts())).map((s) => s.outcome)).toEqual(["killed"]);
    expect(sys.signals).toEqual([
      { target: 6000, sig: "SIGTERM" },
      { target: 6000, sig: "SIGKILL" },
    ]);
  });

  test("asks the tunnel service nothing when no launch is finished, and does nothing without a service or when it can't list", async () => {
    workerOf(job());
    expect(await reapWorkerTunnels(store.db, sys, opts())).toEqual([]);
    expect(listCalls).toBe(0);

    const j = job();
    const launch = workerOf(j);
    handTunnel(6000, 5291, workerTunnelSuffix(launch.id, "a"));
    updatePersonaJob(store.db, j.id, { status: "done" });
    sys.tunnels = { hostUser: "alice", hostname: HOST, list: async () => null };
    expect(await reapWorkerTunnels(store.db, sys, opts())).toEqual([]);
    delete sys.tunnels;
    expect(await reapWorkerTunnels(store.db, sys, opts())).toEqual([]);
    expect(sys.signals).toEqual([]);
  });
});
