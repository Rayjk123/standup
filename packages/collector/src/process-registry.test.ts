import { beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { mkdtempSync, realpathSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Launch } from "@standup/shared";
import { createLaunch, createStore, listLiveProcessesForLaunch, upsertProject } from "@standup/store";
import type { Store } from "@standup/store";
import {
  argsReferencePath,
  installDirForms,
  isLaunchUnit,
  panePidArgv,
  parseFingerprint,
  parseLstart,
  parsePsTable,
  processFingerprint,
  protectedArgsReason,
  registerProcess,
  standingTunnelPattern,
  terminateRegistered,
  unitPrefix,
  type ProcessRow,
} from "./process-registry.js";
import { FakeProcessSystem } from "./process-registry-fake.js";
import { workerTmux } from "./tmux-launch.js";

const INSTALL = "/srv/me/standup";
const WT = "/home/me/.local/share/standup/worktrees/proj/feat-1";

/**
 * A host as `ps` shows it: init, the user manager, Standup's own tree under
 * it (the collector is pid 4000), the shared worker tmux server with one
 * pane, the worker's dev servers, and a few processes that must never be
 * stopped.
 */
function table(): ProcessRow[] {
  const r = (pid: number, ppid: number, pgid: number, args: string, uid = 1000): ProcessRow => ({ pid, ppid, pgid, uid, args });
  return [
    r(1, 0, 1, "/usr/lib/systemd/systemd --switched-root --system", 0),
    r(900, 1, 900, "/usr/lib/systemd/systemd --user"),
    r(1000, 900, 1000, "bun run dev"),
    r(1001, 1000, 1000, "bun scripts/dev.ts"),
    r(1002, 1001, 1000, "node node_modules/.bin/vite"),
    r(4000, 1001, 1000, "bun run src/index.ts"),
    r(4001, 4000, 4001, "claude -p --strict-mcp-config"),
    r(2000, 900, 2000, `tmux -S /home/me/.local/share/standup/tmux/workers new-session -d -s w1 -c ${WT}`),
    r(2001, 2000, 2001, "claude --session-id abc"),
    r(2002, 2001, 2001, "node /home/me/.local/share/claude-code/1.0.0/claude"),
    r(2003, 2002, 2003, "bash -c npm run dev"),
    r(2004, 2003, 2003, `node ${WT}/node_modules/.bin/vite --port 5200`),
    r(2010, 2002, 2001, `node ${WT}/server.js`),
    r(3000, 900, 3000, "python3 -m http.server", 1001),
    r(3100, 900, 3100, `bun run ${INSTALL}/packages/gateway/src/cli.ts`),
    r(3200, 900, 3200, "/home/me/.local/bin/tunnelctl open 5173 --name standup"),
    r(3300, 900, 3300, "setsid bash -c work"),
    r(3301, 3300, 3300, "claude --resume xyz"),
  ];
}

let store: Store;
let sys: FakeProcessSystem;
let launch: Launch;
const opts = { installDir: INSTALL };

let scratch: string;

beforeEach(() => {
  store = createStore(":memory:");
  upsertProject(store.db, { id: "proj", name: "P", branch: "main", repos: [] });
  launch = createLaunch(store.db, { id: randomUUID(), projectId: "proj", task: "t", worktreePath: WT, branch: "b", status: "running", tmuxSession: "w1" });
  sys = new FakeProcessSystem(table(), { selfPid: 4000, uid: 1000 });
  // The pane of session w1 is its claude, pid 2001.
  sys.panes.set("w1", 2001);
  scratch = mkdtempSync(join(tmpdir(), "standup-scratch-reg-"));
});

const reg = (input: { pid?: number; unit?: string; port?: number }, label = "dev server") =>
  registerProcess(store.db, sys, { launch, jobId: "job-1", label, ...input }, { ...opts, scratchRoot: scratch });

/** A unit name the launch may register. */
const unit = (name: string) => `${unitPrefix(launch.id)}${name}`;

describe("registerProcess refusals", () => {
  test.each([
    [0, "above 1"],
    [1, "above 1"],
    [4000, "the collector"],
    [1001, "ancestor of the collector"],
    [1000, "ancestor of the collector"],
    [1002, "Standup's own"],
    [4001, "Standup's own"],
    [3000, "another user"],
    [3100, "install dir"],
    [2000, "tmux"],
    [2001, "Claude agent"],
    [2002, "Claude agent"],
    [3200, "standing tunnels"],
    [3300, "process group holding"],
    [9999, "no process 9999"],
  ])("pid %d is refused (%s)", (pid, why) => {
    const res = reg({ pid });
    expect(res.ok).toBe(false);
    expect(res.ok ? "" : res.reason).toContain(why);
  });

  test("a pane's own process is refused even when its args look harmless", () => {
    sys.rows.push({ pid: 2100, ppid: 2000, pgid: 2100, uid: 1000, args: "bash" });
    const res = reg({ pid: 2100 });
    expect(res.ok ? "" : res.reason).toContain("tmux pane");
  });

  test("exactly one of pid or unit, a label, and a valid port are required", () => {
    expect(reg({}).ok).toBe(false);
    expect(reg({ pid: 2004, unit: unit("a.service") }).ok).toBe(false);
    expect(reg({ pid: 2004 }, "  ").ok).toBe(false);
    expect(reg({ pid: 2004, port: 70000 }).ok).toBe(false);
  });

  test.each(["standup.service", "standup-tunnel.service", "kiosk-tunnel.service", "user@1000.service", "systemd-tmpfiles.service", "dbus.service", "init.scope", "session-3.scope", "tmux-spawn-1.scope", "foo.timer", "bad unit.service", "../x.service", "my-dev.service", "sw-00000000-dev.service"])(
    "unit %s is refused",
    (name) => {
      expect(reg({ unit: name }).ok).toBe(false);
    }
  );

  test.each(["foo.timer", "bad unit.service", "../x.service", ".x.service", "a/b.service", "-x.service", "x.socket", ""])("prefixed unit with a bad name %p is refused", (name) => {
    expect(reg({ unit: unit(name) }).ok).toBe(false);
  });

  test("an unprefixed unit's refusal names the prefix to use", () => {
    const res = reg({ unit: "my-dev.service" });
    expect(res.ok ? "" : res.reason).toContain(`systemd-run --user --unit=${unitPrefix(launch.id)}<name>`);
  });

  test("a reserved unit named by the caller is refused", () => {
    expect(registerProcess(store.db, sys, { launch, label: "x", unit: unit("mine.service") }, { installDir: INSTALL, reservedUnits: [unit("mine.service")] }).ok).toBe(false);
  });
});

describe("registerProcess ownership", () => {
  test("a process under another launch's pane is refused", () => {
    sys.rows.push(
      { pid: 2500, ppid: 2000, pgid: 2500, uid: 1000, args: "claude --session-id other" },
      { pid: 2501, ppid: 2500, pgid: 2501, uid: 1000, args: "node /home/me/other/server.js" }
    );
    const res = reg({ pid: 2501 });
    expect(res.ok ? "" : res.reason).toContain("not a process this launch started");
  });

  test("a launch whose pane can't be found registers nothing under a pane", () => {
    sys.panes.clear();
    const res = reg({ pid: 2010 });
    expect(res.ok ? "" : res.reason).toContain("not a process this launch started");
  });

  test("a process reparented to the service manager is the launch's when it names the worktree", () => {
    sys.rows.push({ pid: 2600, ppid: 900, pgid: 2600, uid: 1000, args: `node ${WT}/server.js` });
    expect(reg({ pid: 2600 }).ok).toBe(true);
  });

  test("a process reparented to init is the launch's when it names its scratch dir", () => {
    sys.rows.push({ pid: 2601, ppid: 1, pgid: 2601, uid: 1000, args: `python3 -m http.server -d ${join(scratch, launch.id)}` });
    expect(reg({ pid: 2601 }).ok).toBe(true);
  });

  test("a reparented process naming neither is refused", () => {
    sys.rows.push({ pid: 2602, ppid: 900, pgid: 2602, uid: 1000, args: "node /home/me/elsewhere/proj/server.js" });
    const res = reg({ pid: 2602 });
    expect(res.ok ? "" : res.reason).toContain("not a process this launch started");
  });

  test("a reparented process naming another launch's worktree is refused", () => {
    sys.rows.push({ pid: 2603, ppid: 900, pgid: 2603, uid: 1000, args: `node ${WT}-other/server.js` });
    expect(reg({ pid: 2603 }).ok).toBe(false);
  });

  test("an adopted launch's worktree is the user's checkout, so only its scratch dir counts", () => {
    const adopted = createLaunch(store.db, { id: randomUUID(), kind: "adopted", projectId: "proj", task: "t", worktreePath: "/home/me/src/proj", branch: "b", status: "running" });
    sys.rows.push(
      { pid: 2700, ppid: 900, pgid: 2700, uid: 1000, args: "node /home/me/src/proj/server.js" },
      { pid: 2701, ppid: 900, pgid: 2701, uid: 1000, args: `node ${join(scratch, adopted.id)}/x.js` }
    );
    const regAdopted = (pid: number) => registerProcess(store.db, sys, { launch: adopted, label: "x", pid }, { ...opts, scratchRoot: scratch });
    expect(regAdopted(2700).ok).toBe(false);
    expect(regAdopted(2701).ok).toBe(true);
  });

  test("a reparented process whose parent is another user's systemd isn't reparented to ours", () => {
    sys.rows.push({ pid: 950, ppid: 1, pgid: 950, uid: 1001, args: "/usr/lib/systemd/systemd --user" }, { pid: 2604, ppid: 950, pgid: 2604, uid: 1000, args: `node ${WT}/server.js` });
    expect(reg({ pid: 2604 }).ok).toBe(false);
  });

  test("the install dir is protected through a symlink to it as well", () => {
    const real = mkdtempSync(join(tmpdir(), "standup-install-real-"));
    const link = join(mkdtempSync(join(tmpdir(), "standup-install-link-")), "standup");
    symlinkSync(real, link);
    const dirs = installDirForms(link);
    expect(dirs).toEqual([link, realpathSync(real)]);
    expect(protectedArgsReason(`bun run ${realpathSync(real)}/packages/collector/src/index.ts`, link)).toContain("install dir");
    expect(protectedArgsReason(`bun run ${link}/packages/collector/src/index.ts`, link)).toContain("install dir");
  });
});

describe("registerProcess records", () => {
  test("a worker's dev server, with its process group and exact command line", () => {
    const res = reg({ pid: 2004, port: 5200 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.process).toMatchObject({ kind: "pid", pid: 2004, pgid: 2003, port: 5200, jobId: "job-1", label: "dev server" });
    expect(res.process.argsFingerprint).toBe(`node ${WT}/node_modules/.bin/vite --port 5200`);
  });

  test("a group leader whose group holds only the worker's processes", () => {
    const res = reg({ pid: 2003 });
    expect(res.ok && res.process.pgid).toBe(2003);
  });

  test("registering the same live pid twice returns the first row", () => {
    const a = reg({ pid: 2004 });
    const b = reg({ pid: 2004 });
    expect(a.ok && b.ok && a.process.id === b.process.id).toBe(true);
    expect(listLiveProcessesForLaunch(store.db, launch.id)).toHaveLength(1);
  });

  test("a user unit named with the launch's prefix", () => {
    const res = reg({ unit: unit("my-dev.service") });
    expect(res.ok && res.process).toMatchObject({ kind: "unit", unit: unit("my-dev.service") });
    expect(reg({ unit: unit("shell.scope") }).ok).toBe(true);
  });

  test("a process's start time goes into its fingerprint", () => {
    sys.rows.find((r) => r.pid === 2004)!.started = 1_760_000_000;
    const res = reg({ pid: 2004 });
    expect(res.ok && res.process.argsFingerprint).toBe(`1760000000\tnode ${WT}/node_modules/.bin/vite --port 5200`);
    expect(res.ok && parseFingerprint(res.process.argsFingerprint!)).toEqual({ args: `node ${WT}/node_modules/.bin/vite --port 5200`, started: 1_760_000_000 });
    const again = reg({ pid: 2004 });
    expect(res.ok && again.ok && res.process.id === again.process.id).toBe(true);
  });
});

describe("terminateRegistered", () => {
  test("SIGTERMs a group leader's group and a non-leader's pid alone, then marks both stopped", async () => {
    reg({ pid: 2003 });
    reg({ pid: 2010 });
    const results = await terminateRegistered(store.db, sys, { jobId: "job-1" }, "job_closed", opts);
    expect(results.map((r) => r.outcome)).toEqual(["terminated", "terminated"]);
    expect(sys.signals).toEqual([
      { target: -2003, sig: "SIGTERM" },
      { target: 2010, sig: "SIGTERM" },
    ]);
    expect(listLiveProcessesForLaunch(store.db, launch.id)).toHaveLength(0);
    // The pane and its claude are untouched.
    expect(sys.isAlive(2001) && sys.isAlive(2002)).toBe(true);
  });

  test("SIGKILLs what outlives the grace period", async () => {
    reg({ pid: 2010 });
    sys.ignoresTerm.add(2010);
    const results = await terminateRegistered(store.db, sys, { launchId: launch.id }, "job_closed", { ...opts, graceMs: 300 });
    expect(results[0]!.outcome).toBe("killed");
    expect(sys.signals).toEqual([
      { target: 2010, sig: "SIGTERM" },
      { target: 2010, sig: "SIGKILL" },
    ]);
    expect(sys.sleeps.reduce((a, b) => a + b, 0)).toBe(300);
  });

  test("a reused pid is marked reused and not signalled", async () => {
    reg({ pid: 2010 });
    sys.reuse(2010, "node /somewhere/else.js");
    const results = await terminateRegistered(store.db, sys, { jobId: "job-1" }, "job_closed", opts);
    expect(results[0]!.outcome).toBe("reused");
    expect(sys.signals).toEqual([]);
    const row = store.db.query("SELECT stop_reason FROM launch_processes").get() as { stop_reason: string };
    expect(row.stop_reason).toBe("reused");
  });

  test("a pid reused with the same command line but a new start time is marked reused", async () => {
    sys.rows.find((r) => r.pid === 2010)!.started = 1_760_000_000;
    reg({ pid: 2010 });
    sys.reuse(2010, `node ${WT}/server.js`, 1_760_000_500);
    const results = await terminateRegistered(store.db, sys, { jobId: "job-1" }, "job_closed", opts);
    expect(results[0]!.outcome).toBe("reused");
    expect(sys.signals).toEqual([]);
  });

  test("the same command line and start time is stopped", async () => {
    sys.rows.find((r) => r.pid === 2010)!.started = 1_760_000_000;
    reg({ pid: 2010 });
    const results = await terminateRegistered(store.db, sys, { jobId: "job-1" }, "job_closed", opts);
    expect(results[0]!.outcome).toBe("terminated");
  });

  test("a start time read 1s off (a clock step) is still the same process and is stopped", async () => {
    sys.rows.find((r) => r.pid === 2010)!.started = 1_760_000_000;
    reg({ pid: 2010 });
    sys.reuse(2010, `node ${WT}/server.js`, 1_760_000_001);
    const results = await terminateRegistered(store.db, sys, { jobId: "job-1" }, "job_closed", opts);
    expect(results[0]!.outcome).toBe("terminated");
  });

  test("a start time read 10s off is a reused pid and is left alone", async () => {
    sys.rows.find((r) => r.pid === 2010)!.started = 1_760_000_000;
    reg({ pid: 2010 });
    sys.reuse(2010, `node ${WT}/server.js`, 1_760_000_010);
    const results = await terminateRegistered(store.db, sys, { jobId: "job-1" }, "job_closed", opts);
    expect(results[0]!.outcome).toBe("reused");
    expect(sys.signals).toEqual([]);
  });

  test("a start time within tolerance but a different command line is a reused pid", async () => {
    sys.rows.find((r) => r.pid === 2010)!.started = 1_760_000_000;
    reg({ pid: 2010 });
    sys.reuse(2010, "node /somewhere/else.js", 1_760_000_001);
    const results = await terminateRegistered(store.db, sys, { jobId: "job-1" }, "job_closed", opts);
    expect(results[0]!.outcome).toBe("reused");
  });

  test("a row recorded without a start time still stops on its command line", async () => {
    reg({ pid: 2010 });
    sys.rows.find((r) => r.pid === 2010)!.started = 1_760_000_000;
    const results = await terminateRegistered(store.db, sys, { jobId: "job-1" }, "job_closed", opts);
    expect(results[0]!.outcome).toBe("terminated");
  });

  test("a process already gone is marked gone", async () => {
    reg({ pid: 2010 });
    sys.rows = sys.rows.filter((r) => r.pid !== 2010);
    const results = await terminateRegistered(store.db, sys, { jobId: "job-1" }, "job_closed", opts);
    expect(results[0]!.outcome).toBe("gone");
    expect(sys.signals).toEqual([]);
  });

  test("a gone group leader whose group lives on has the group signalled", async () => {
    reg({ pid: 2003 });
    sys.rows = sys.rows.filter((r) => r.pid !== 2003);
    const results = await terminateRegistered(store.db, sys, { jobId: "job-1" }, "job_closed", opts);
    expect(results[0]!.outcome).toBe("terminated");
    expect(sys.signals).toEqual([{ target: -2003, sig: "SIGTERM" }]);
    expect(sys.isAlive(2004)).toBe(false);
  });

  test("a gone group leader's group that gained a protected member is left alone", async () => {
    reg({ pid: 2003 });
    sys.rows = sys.rows.filter((r) => r.pid !== 2003);
    sys.rows.push({ pid: 2050, ppid: 2004, pgid: 2003, uid: 1000, args: "claude --resume q" });
    const results = await terminateRegistered(store.db, sys, { jobId: "job-1" }, "job_closed", opts);
    expect(results[0]!.outcome).toBe("gone");
    expect(sys.signals).toEqual([]);
  });

  test("a gone non-leader's group is never signalled", async () => {
    reg({ pid: 2004 });
    sys.rows = sys.rows.filter((r) => r.pid !== 2004);
    const results = await terminateRegistered(store.db, sys, { jobId: "job-1" }, "job_closed", opts);
    expect(results[0]!.outcome).toBe("gone");
    expect(sys.signals).toEqual([]);
  });

  test("a group that gained a protected member is signalled by pid only", async () => {
    reg({ pid: 2003 });
    sys.rows.push({ pid: 2050, ppid: 2003, pgid: 2003, uid: 1000, args: "claude --resume q" });
    await terminateRegistered(store.db, sys, { jobId: "job-1" }, "job_closed", opts);
    expect(sys.signals[0]).toEqual({ target: 2003, sig: "SIGTERM" });
  });

  test("units are stopped through systemctl; a failed stop is recorded", async () => {
    reg({ unit: unit("my-dev.service") });
    reg({ unit: unit("broken.service") });
    sys.failingUnits.add(unit("broken.service"));
    const results = await terminateRegistered(store.db, sys, { jobId: "job-1" }, "job_closed", opts);
    expect(sys.stoppedUnits).toEqual([unit("my-dev.service"), unit("broken.service")]);
    expect(results.map((r) => r.outcome)).toEqual(["unit_stopped", "unit_failed"]);
  });

  test("closing twice is a no-op the second time", async () => {
    reg({ pid: 2010 });
    reg({ unit: unit("my-dev.service") });
    await terminateRegistered(store.db, sys, { jobId: "job-1" }, "job_closed", opts);
    const signals = sys.signals.length;
    const again = await terminateRegistered(store.db, sys, { jobId: "job-1" }, "job_closed", opts);
    expect(again).toEqual([]);
    expect(sys.signals.length).toBe(signals);
    expect(sys.stoppedUnits).toEqual([unit("my-dev.service")]);
  });
});

describe("matchers", () => {
  test("argsReferencePath matches whole paths only", () => {
    expect(argsReferencePath(`node ${WT}/a.js`, WT)).toBe(true);
    expect(argsReferencePath(`cd ${WT}`, WT)).toBe(true);
    expect(argsReferencePath(`x --dir="${WT}"`, WT)).toBe(true);
    expect(argsReferencePath(`x --dir=${WT}`, WT)).toBe(true);
    expect(argsReferencePath(`node ${WT}-other/a.js`, WT)).toBe(false);
    expect(argsReferencePath(`node /mnt${WT}/a.js`, WT)).toBe(false);
    expect(argsReferencePath("anything", "/")).toBe(false);
  });

  const OWN_ONLY: ReadonlySet<string> = new Set(["standup"]);
  const WITH_KIOSK: ReadonlySet<string> = new Set(["standup", "kiosk"]);
  const standingCases: Array<[string, ReadonlySet<string>, boolean]> = [
    // args, reserved suffixes, protected
    ["tunnelctl open 5173 --name standup", OWN_ONLY, true],
    ["tunnelctl open 5173 --name=standup", OWN_ONLY, true],
    ["tunnelctl open 5201 --name ui-review", OWN_ONLY, false],
    ["tunnelctl proxy https://alice-standup.tunnels.example.com/", OWN_ONLY, true],
    ["tunnelctl proxy https://alice-standup.share.example.net/", OWN_ONLY, true],
    ["tunnelctl proxy https://alice-ui-review.tunnels.example.com/", OWN_ONLY, false],
    ["vite --host alice-standup.local", OWN_ONLY, false],
    // A host's own standing tunnel is protected only once its suffix is reserved.
    ["tunnelctl open 5250 --name kiosk", OWN_ONLY, false],
    ["tunnelctl open 5250 --name kiosk", WITH_KIOSK, true],
    ["tunnelctl open 5250 --name=kiosk", WITH_KIOSK, true],
    ["tunnelctl proxy https://alice-kiosk.v.tunnels.example.com/", OWN_ONLY, false],
    ["tunnelctl proxy https://alice-kiosk.v.tunnels.example.com/", WITH_KIOSK, true],
    ["tunnelctl open 5251 --name kiosk-review", WITH_KIOSK, false],
    ["vite --host alice-kiosk.local", WITH_KIOSK, false],
    ["tunnelctl open 5250 --name kiosk", new Set<string>(), false],
  ];
  test.each(standingCases)("protectedArgsReason(%p) with suffixes %p protects: %p", (args, suffixes, isProtected) => {
    const reason = protectedArgsReason(args, INSTALL, suffixes);
    if (isProtected) expect(reason).toContain("standing tunnels");
    else expect(reason).toBeNull();
  });

  test("protectedArgsReason by default protects Standup's console tunnel", () => {
    expect(protectedArgsReason("tunnelctl open 5173 --name standup", INSTALL)).toContain("standing tunnels");
    expect(protectedArgsReason("tunnelctl open 5201 --name ui-review", INSTALL)).toBeNull();
  });

  test("standingTunnelPattern escapes its suffixes and is null for none", () => {
    expect(standingTunnelPattern([])).toBeNull();
    expect(standingTunnelPattern(["a.b"])!.test("tunnelctl open 1 --name axb")).toBe(false);
  });

  test("parsePsTable reads pid, ppid, pgid, uid and args (args may be empty)", () => {
    expect(parsePsTable("  12   1  12 1000 node a.js --x 1\n   2   0   0    0 \n")).toEqual([
      { pid: 12, ppid: 1, pgid: 12, uid: 1000, args: "node a.js --x 1" },
      { pid: 2, ppid: 0, pgid: 0, uid: 0, args: "" },
    ]);
  });

  test("parsePsTable reads lstart's five fields as a UTC start time", () => {
    const out = "  12   1  12 1000 Mon Oct 12 09:05:03 2026 node a.js Tue 1\n   7   1   7 1000 Thu Jan  1 00:00:00 1970 \n  9 1 9 1000 node Mon Oct 12\n";
    expect(parsePsTable(out)).toEqual([
      { pid: 12, ppid: 1, pgid: 12, uid: 1000, started: Date.UTC(2026, 9, 12, 9, 5, 3) / 1000, args: "node a.js Tue 1" },
      { pid: 7, ppid: 1, pgid: 7, uid: 1000, started: 0, args: "" },
      { pid: 9, ppid: 1, pgid: 9, uid: 1000, args: "node Mon Oct 12" },
    ]);
  });

  test("parseLstart refuses anything but one lstart value", () => {
    expect(parseLstart(" Mon Oct 12 09:05:03 2026\n")).toBe(Date.UTC(2026, 9, 12, 9, 5, 3) / 1000);
    expect(parseLstart("Mon Foo 12 09:05:03 2026")).toBeNull();
    expect(parseLstart("Mon Oct 12 09:05:03 2026 extra")).toBeNull();
    expect(parseLstart("")).toBeNull();
  });

  test("fingerprints round-trip, and an args-only one has no start time", () => {
    expect(parseFingerprint(processFingerprint(" node a.js ", 42))).toEqual({ args: "node a.js", started: 42 });
    expect(parseFingerprint(processFingerprint("node a.js"))).toEqual({ args: "node a.js" });
    expect(parseFingerprint("node a.js")).toEqual({ args: "node a.js" });
  });

  test("isLaunchUnit wants sw-<id8>-<name> and a .service or .scope", () => {
    const id = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";
    expect(unitPrefix(id)).toBe("sw-3f2b8c1e-");
    expect(isLaunchUnit("sw-3f2b8c1e-vite.service", id)).toBe(true);
    expect(isLaunchUnit("sw-3f2b8c1e-vite_2.scope", id)).toBe(true);
    expect(isLaunchUnit("sw-3f2b8c1f-vite.service", id)).toBe(false);
    expect(isLaunchUnit("sw-3f2b8c1e-.service", id)).toBe(false);
    expect(isLaunchUnit("sw-3f2b8c1e-vite.timer", id)).toBe(false);
    expect(isLaunchUnit("vite.service", id)).toBe(false);
  });

  test("the pane pid is read from the workers' server by exact session name", () => {
    expect(panePidArgv("w1")).toEqual([...workerTmux("display-message", "-p", "-t", "=w1:", "#{pane_pid}")]);
    expect(panePidArgv("w1")).toContain("-S");
  });
});
