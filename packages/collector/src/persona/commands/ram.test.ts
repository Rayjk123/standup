import { beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import type { RamReport } from "@standup/shared";
import { workerTmuxSocket } from "@standup/shared/owner-token";
import {
  createLaunch,
  createLaunchProcess,
  createPersonaJob,
  createSession,
  createStore,
  endSession,
  getOrCreatePersonaConsoleThread,
  linkPersonaJobLaunch,
  updatePersonaJob,
  upsertProject,
} from "@standup/store";
import type { Store } from "@standup/store";
import { FakeProcessSystem } from "../../process-registry-fake.js";
import { processFingerprint, type ProcessRow } from "../../process-registry.js";
import { buildRamReport, commandSummary, parsePaneList, parseRssTable, processKind, ramCommand, type RamReaders } from "./ram.js";

const INSTALL = "/home/me/src/standup";
const WT = "/home/me/.local/share/standup/worktrees/proj";
const SCRATCH = "/home/me/.cache/standup-scratch";
const MB = 1024 ** 2;
const GB = 1024 ** 3;
const NOW = new Date("2026-10-14T12:00:00Z");
const STARTED = Date.parse("2026-10-14T09:00:00Z") / 1000;

const r = (pid: number, ppid: number, args: string, uid = 1000): ProcessRow => ({ pid, ppid, pgid: pid, uid, started: STARTED, args });

const MEMINFO = ["MemTotal:       67108864 kB", "MemFree:         1048576 kB", "MemAvailable:   16777216 kB", "SwapTotal:       4194304 kB", "SwapFree:        3145728 kB"].join("\n");

describe("/ram attribution", () => {
  let store: Store;
  let rows: ProcessRow[];
  let rss: Map<number, number>;
  let report: RamReport;
  const ids: Record<string, string> = {};

  /** A launch in `wt` with a Persona job of `jobStatus`; a session that is live, ended or absent. */
  const launch = (
    name: string,
    jobStatus: "active" | "done" | null,
    session: "live" | "ended" | "none",
    opts: { tmuxSession?: string; status?: "running" | "failed"; worktree?: string; inPlace?: boolean } = {}
  ) => {
    const sessionId = session === "none" ? undefined : `s-${name}`;
    if (sessionId) {
      createSession(store.db, { id: sessionId, projectId: "proj", title: name, cwd: `${WT}/${name}`, status: "running" });
      if (session === "ended") endSession(store.db, sessionId);
    }
    const l = createLaunch(store.db, {
      id: randomUUID(),
      projectId: "proj",
      task: name,
      worktreePath: opts.worktree ?? `${WT}/${name}`,
      branch: name,
      status: opts.status ?? "running",
      ...(sessionId ? { sessionId } : {}),
      ...(opts.tmuxSession ? { tmuxSession: opts.tmuxSession } : {}),
      ...(opts.inPlace ? { inPlace: true } : {}),
    });
    if (jobStatus) {
      const thread = getOrCreatePersonaConsoleThread(store.db, "alice");
      const job = createPersonaJob(store.db, { owner: "alice", threadId: thread.id, title: `Job ${name}`, goal: "g" });
      linkPersonaJobLaunch(store.db, job.id, l.id);
      if (jobStatus !== "active") updatePersonaJob(store.db, job.id, { status: jobStatus });
    }
    ids[name] = l.id;
    return l;
  };

  const readers = (): RamReaders => ({
    meminfo: () => MEMINFO,
    rss: () => rss,
    panes: () => new Map([["w-live", [2100]], ["w-closed", [2200]]]),
  });
  const run = () =>
    buildRamReport({ db: store.db, owner: "alice", now: NOW, sys: new FakeProcessSystem(rows, { selfPid: 4000, uid: 1000 }), readers: readers(), installDir: INSTALL, scratchRoot: SCRATCH });

  beforeEach(() => {
    store = createStore(":memory:");
    upsertProject(store.db, { id: "proj", name: "P", branch: "main", repos: [] });
    launch("live", "active", "live", { tmuxSession: "w-live" });
    // A closed job whose worker's pane is still up: live by the hygiene rules.
    launch("closed", "done", "ended", { tmuxSession: "w-closed" });
    // A closed job whose worker stopped.
    launch("closed2", "done", "ended", { status: "failed" });
    launch("ended", "active", "ended", { status: "failed" });
    launch("gone", "active", "none", { tmuxSession: "w-gone" });

    rows = [
      r(1, 0, "/usr/lib/systemd/systemd --system", 0),
      r(900, 1, "/usr/lib/systemd/systemd --user"),
      // Standup, as dev.ts runs it: each service's package is only its working directory.
      r(800, 900, "zsh"),
      r(1000, 800, "bun run dev"),
      r(1001, 1000, "bun scripts/dev.ts"),
      r(1002, 1001, "bun run start"),
      r(4000, 1002, "bun run src/index.ts"),
      r(4001, 4000, "claude -p --model haiku"),
      r(4002, 4001, "node /opt/claude-code/2.1/cli.js"),
      // A launch's setup step runs under the collector.
      r(4003, 4000, `git -C ${WT}/live fetch origin`),
      r(1003, 1001, "bun run serve"),
      r(1004, 1003, "bun serve.ts"),
      r(1005, 1001, "bun run dev"),
      r(1006, 1005, "bun run --watch src/index.ts"),
      // The workers' tmux server (its argv keeps its first pane's dir) and its panes.
      r(2000, 900, `tmux -S ${workerTmuxSocket()} new-session -d -s w-live -c ${WT}/live`),
      r(2100, 2000, "bash"),
      r(2101, 2100, "claude --model opus"),
      r(2102, 2101, "node /opt/claude-code/2.1/cli.js"),
      r(2200, 2000, "bash"),
      r(2201, 2200, "claude --model opus"),
      // A closed job's vite server, reparented to the user manager.
      r(5000, 900, `node ${WT}/closed2/node_modules/.bin/vite --port 5200`),
      // An ended session's Gradle daemon.
      r(5100, 900, `java -cp ${WT}/ended/gradle/lib/gradle-launcher.jar org.gradle.launcher.daemon.bootstrap.GradleDaemon`),
      // A launch whose pane is gone left a bun server.
      r(5200, 900, `bun run ${WT}/gone/server.ts`),
      // Unattributed: a shell with a tool holding a token on its command line.
      r(6000, 900, "zsh"),
      r(6001, 6000, "node /home/me/tools/sync.js --api-token supersecretvalue123456"),
      // The user's own editor on a closed job's file: its leftover, but under a shell cleanup leaves alone.
      r(6002, 6000, `vim ${WT}/closed2/notes.md`),
      // Another user's process is never counted.
      r(7000, 1, "postgres", 1001),
    ];
    rss = new Map<number, number>([
      [800, 4 * MB], [1000, 30 * MB], [1001, 40 * MB], [1002, 30 * MB], [4000, 900 * MB], [4001, 10 * MB], [4002, 400 * MB], [4003, 16 * MB],
      [1003, 50 * MB], [1004, 300 * MB], [1005, 20 * MB], [1006, 150 * MB], [2000, 8 * MB], [2100, 4 * MB], [2101, 10 * MB], [2102, 2 * GB],
      [2200, 4 * MB], [2201, 1 * GB], [5000, 600 * MB], [5100, 1.5 * GB], [5200, 200 * MB], [6000, 4 * MB], [6001, 120 * MB], [6002, 10 * MB], [7000, 5 * GB],
    ]);
    report = run();
  });

  test("host totals come from meminfo, and Standup's share sums its own processes, workers and leftovers", () => {
    expect(report.host).toEqual({
      totalBytes: 64 * GB,
      usedBytes: 48 * GB,
      availableBytes: 16 * GB,
      swapTotalBytes: 4 * GB,
      swapUsedBytes: 1 * GB,
      standupBytes: 7390 * MB,
    });
  });

  test("a live session's pane tree, and a setup step naming its worktree, are its worker", () => {
    expect(report.workers).toHaveLength(1);
    expect(report.workers[0]).toMatchObject({
      label: "Job live",
      detail: "Job active · session running",
      pids: [2100, 4003],
      processCount: 4,
      rssBytes: 2078 * MB,
      command: "node …/2.1/cli.js",
      startedAt: "2026-10-14T09:00:00.000Z",
    });
    expect(report.workers[0]!.href).toStartWith("/persona?job=");
  });

  test("Standup's own tree splits into the collector, the Persona runtime, each service and the dev script", () => {
    const byLabel = Object.fromEntries(report.standup.map((g) => [g.label, { pids: g.pids, rss: g.rssBytes / MB }]));
    expect(byLabel).toEqual({
      Collector: { pids: [1002], rss: 930 },
      "Persona runtime and helpers": { pids: [4001], rss: 410 },
      "Web server": { pids: [1003], rss: 350 },
      "Slack bridge": { pids: [1005], rss: 170 },
      "Dev script": { pids: [1000], rss: 70 },
      "Workers' tmux server": { pids: [2000], rss: 8 },
    });
  });

  test("a closed job's stopped worker, an ended session and a gone pane leave leftovers; a live worker's, or one under a running shell, is listed but not freeable", () => {
    const left = report.leftovers.map((l) => ({ pid: l.pids[0], reason: l.reason, kind: l.kind, label: l.label, keep: l.stillLive ? "live" : l.hasParent ? "parent" : "" }));
    expect(left).toEqual([
      { pid: 5100, reason: "session_ended", kind: "Gradle daemon", label: "Job ended", keep: "" },
      { pid: 2200, reason: "job_closed", kind: "Claude CLI", label: "Job closed", keep: "live" },
      { pid: 5000, reason: "job_closed", kind: "vite server", label: "Job closed2", keep: "" },
      { pid: 5200, reason: "pane_gone", kind: "bun process", label: "Job gone", keep: "" },
      { pid: 6002, reason: "job_closed", kind: "vim", label: "Job closed2", keep: "parent" },
    ]);
    expect(report.leftovers.find((l) => l.pids[0] === 2200)!.detail).toBe("Job done · session ended · its worker is still live");
    expect(report.leftovers.find((l) => l.pids[0] === 6002)!.detail).toBe("Job done · session ended · its parent still runs, so cleanup leaves it");
  });

  test("an ended session's launch that the hygiene rules hold live (another launch of its session is starting) is not freeable", () => {
    const l = launch("resumed", "active", "ended", { status: "failed" });
    createLaunch(store.db, { id: randomUUID(), projectId: "proj", task: "t", worktreePath: `${WT}/resumed-2`, branch: "b", status: "starting", sessionId: l.sessionId! });
    rows.push(r(5400, 900, `node ${WT}/resumed/server.js`));
    rss.set(5400, 50 * MB);
    const out = run();
    expect(out.leftovers.find((x) => x.pids.includes(5400))).toMatchObject({ reason: "session_ended", stillLive: true });
    expect(out.freeable.some((f) => f.pids.includes(5400))).toBe(false);
  });

  test("the user's own tmux server started in a closed job's worktree isn't that job's leftover", () => {
    rows.push(r(8000, 900, `tmux new-session -s mine -c ${WT}/closed2`), r(8100, 8000, "zsh"));
    const out = run();
    expect(out.leftovers.some((l) => l.pids.includes(8000) || l.pids.includes(8100))).toBe(false);
    expect(out.other.map((g) => g.pids[0])).toEqual(expect.arrayContaining([8000, 8100]));
  });

  test("everything else is listed as whole trees, without another user's processes", () => {
    expect(report.other.map((g) => ({ pids: g.pids, rss: g.rssBytes, count: g.processCount }))).toEqual([
      { pids: [6000], rss: 124 * MB, count: 2 },
      { pids: [800], rss: 4 * MB, count: 1 },
    ]);
    expect(report.other[0]!.command).toBe("node …/tools/sync.js --api-token [REDACTED]");
    const all = [...report.workers, ...report.standup, ...report.leftovers, ...report.other].flatMap((g) => g.pids);
    expect(all).not.toContain(7000);
  });

  test("what could be freed groups the leftovers that aren't live by kind and reason, naming their pids", () => {
    expect(report.freeable.map((f) => f.line)).toEqual([
      "1 leftover Gradle daemon from an ended session, 1.5 GB (pid 5100)",
      "1 leftover vite server from a closed job, 0.6 GB (pid 5000)",
      "1 leftover bun process whose tmux pane is gone, 0.2 GB (pid 5200)",
    ]);
  });

  test("the top five lead with the heaviest groups, and the summary leads with the totals", () => {
    expect(report.top.map((g) => [g.label, g.section])).toEqual([
      ["Job live", "worker"],
      ["Job ended", "leftover"],
      ["Job closed", "leftover"],
      ["Collector", "standup"],
      ["Job closed2", "leftover"],
    ]);
    expect(report.summary).toBe("48.0 GB used of 64.0 GB · Standup 7.2 GB · 3 leftovers could free 2.3 GB");
  });

  test("a closed job's path that a live in-place launch still uses isn't its leftover", () => {
    launch("fixer", "active", "live", { worktree: `${WT}/closed2`, inPlace: true });
    const out = run();
    expect(out.leftovers.some((l) => l.pids.includes(5000))).toBe(false);
    expect(out.freeable.some((f) => f.pids.includes(5000))).toBe(false);
  });

  test("a registered process counts for its launch only while it is the process that was registered", () => {
    rows.push(r(5300, 900, "python3 -m http.server 9000"), r(5301, 900, "python3 -m http.server 9001"));
    rss.set(5300, 30 * MB).set(5301, 30 * MB);
    createLaunchProcess(store.db, { launchId: ids.gone!, kind: "pid", pid: 5300, label: "py", argsFingerprint: processFingerprint("python3 -m http.server 9000", STARTED) });
    createLaunchProcess(store.db, { launchId: ids.gone!, kind: "pid", pid: 5301, label: "py", argsFingerprint: processFingerprint("python3 -m http.server 8000", STARTED) });
    const out = run();
    expect(out.leftovers.find((l) => l.pids.includes(5300))?.reason).toBe("pane_gone");
    expect(out.leftovers.some((l) => l.pids.includes(5301))).toBe(false);
  });

  test("an unanswered pane read calls no pane gone", () => {
    const out = buildRamReport({
      db: store.db,
      owner: "alice",
      now: NOW,
      sys: new FakeProcessSystem(rows, { selfPid: 4000, uid: 1000 }),
      readers: { ...readers(), panes: () => null },
      installDir: INSTALL,
      scratchRoot: SCRATCH,
    });
    expect(out.leftovers.some((l) => l.reason === "pane_gone")).toBe(false);
  });

  test("a collector started from a Claude session doesn't take that session as Standup's", () => {
    const own = [
      r(900, 1, "/usr/lib/systemd/systemd --user"),
      r(3000, 900, "zsh"),
      r(3001, 3000, "node /opt/claude-code/2.1/cli.js"),
      r(3002, 3001, "node /opt/mcp/server.js"),
      r(3003, 3001, "bun run dev"),
      r(4000, 3003, "bun run src/index.ts"),
    ];
    const sizes = new Map([[3001, 500 * MB], [3002, 100 * MB], [3003, 30 * MB], [4000, 900 * MB]]);
    const out = buildRamReport({ db: store.db, owner: "alice", now: NOW, sys: new FakeProcessSystem(own, { selfPid: 4000 }), readers: { meminfo: () => MEMINFO, rss: () => sizes, panes: () => new Map() }, installDir: INSTALL });
    expect(out.standup.flatMap((g) => g.pids).sort()).toEqual([3003]);
    expect(out.other.map((g) => g.pids[0])).toContain(3000);
  });

  test("an unattributed tmux server's panes are listed as their own trees", () => {
    const own = [r(900, 1, "/usr/lib/systemd/systemd --user"), r(4000, 900, "bun run src/index.ts"), r(8000, 900, "tmux new-session -s mine"), r(8100, 8000, "zsh"), r(8101, 8100, "vim notes.md"), r(8200, 8000, "zsh"), r(8201, 8200, "bun test")];
    const sizes = new Map([[8000, 8 * MB], [8100, 4 * MB], [8101, 40 * MB], [8200, 4 * MB], [8201, 900 * MB]]);
    const out = buildRamReport({ db: store.db, owner: "alice", now: NOW, sys: new FakeProcessSystem(own, { selfPid: 4000 }), readers: { meminfo: () => MEMINFO, rss: () => sizes, panes: () => new Map() }, installDir: INSTALL });
    expect(out.other.map((g) => ({ pids: g.pids, rss: g.rssBytes }))).toEqual([
      { pids: [8200], rss: 904 * MB },
      { pids: [8100], rss: 44 * MB },
      { pids: [8000], rss: 8 * MB },
    ]);
  });

  test("a user who isn't the host's sees the totals only", () => {
    const out = ramCommand.run({
      db: store.db,
      owner: "bob",
      host: "alice",
      now: NOW,
      args: "",
      installDir: INSTALL,
      processes: new FakeProcessSystem([r(9000, 900, "bash")], { selfPid: 9000 }),
      ramReaders: { meminfo: () => MEMINFO, rss: () => new Map(), panes: () => new Map() },
    });
    const data = out.data as RamReport;
    expect(data.workers).toEqual([]);
    expect(data.other).toEqual([]);
    expect(data.processError).toBe("Process details are shown only to the host's owner.");
    expect(out.summary).toBe("48.0 GB used of 64.0 GB · Process details are shown only to the host's owner.");
  });

  test("an unreadable process table still reports the host", () => {
    const sys = new FakeProcessSystem([]);
    sys.processTable = () => null;
    const out = buildRamReport({ db: store.db, owner: "alice", now: NOW, sys, readers: { meminfo: () => MEMINFO, rss: () => new Map(), panes: () => null }, installDir: INSTALL });
    expect(out.host?.totalBytes).toBe(64 * GB);
    expect(out.processError).toBe("The process table couldn't be read.");
  });
});

describe("commandSummary redacts secrets and trims", () => {
  test.each([
    ["node app.js --api-token supersecretvalue123456", "node app.js --api-token [REDACTED]"],
    ["node app.js --client-secret=abcDEF1234567890xyz", "node app.js --client-secret=[REDACTED]"],
    ["mysql --password=hunter2hunter2 -h db", "mysql --password=[REDACTED] -h db"],
    ["git clone https://bob:s3cr3tpass@example.com/repo.git", "git clone https://bob:[REDACTED]@example.com/repo.git"],
    ["curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123' https://api", "curl -H 'Authorization: Bearer [REDACTED]' https://api"],
    ["node x.js ghp_abcdefghijklmnopqrstuvwxyz0123456789", "node x.js [REDACTED]"],
    // Short or word-like values the corpus tier keeps.
    ["node a.js --token=abc123def456", "node a.js --token=[REDACTED]"],
    ["node a.js --api-key s3cr3tkey9", "node a.js --api-key [REDACTED]"],
    ["node a.js --secret abcdefghijklmnopqrstuvwxyz", "node a.js --secret [REDACTED]"],
    ["tool --client-secret hunter2", "tool --client-secret [REDACTED]"],
    ["tool --pass hunter2 --verbose", "tool --pass [REDACTED] --verbose"],
    ["tool --token --verbose", "tool --token --verbose"],
    ["env MY_SECRET=hunter2 cmd", "env MY_SECRET=[REDACTED] cmd"],
    ["bash -c export TOKEN=abc123; run", "bash -c export TOKEN=[REDACTED]; run"],
    ["curl --header X-Api-Key: k3y12345 https://api", "curl --header X-Api-Key: [REDACTED] https://api"],
    ["sshpass -p hunter2 ssh h", "sshpass -p [REDACTED] ssh h"],
    ["redis-cli -a hunter2 ping", "redis-cli -a [REDACTED] ping"],
    ["timeout 30 sshpass -p hunter2 ssh h", "timeout 30 sshpass -p [REDACTED] ssh h"],
    ["curl https://h/x?token=abcdefghij&v=1", "curl https://h/x?token=[REDACTED]&v=1"],
    ["docker run --env=NPM_TOKEN=abc123 img", "docker run --env=NPM_TOKEN=[REDACTED] img"],
    ["helm --set auth.token=abc123 x", "helm --set auth.token=[REDACTED] x"],
    ['tool {"apiKey":"abcd1234"}', 'tool {"apiKey":"[REDACTED]"}'],
    ["wget --header=X-Api-Key: k3y12345 u", "wget --header=X-Api-Key: [REDACTED] u"],
    ["tool --auth Bearer shorttok", "tool --auth Bearer [REDACTED]"],
    ["curl -H Cookie: a=1; sid=xyz789 https://h", "curl -H Cookie: [REDACTED] https://h"],
    ["tool --password=-Xy9abc", "tool --password=[REDACTED]"],
    ["PGPASSWORD=hunter2 psql -h db", "PGPASSWORD=[REDACTED] psql -h db"],
    ["docker login -u me -p hunter2 reg", "docker login -u me -p [REDACTED] reg"],
    ["curl -u admin:hunter2 https://api", "curl -u admin:[REDACTED] https://api"],
    ["curl --user admin:hunter2 https://api", "curl --user admin:[REDACTED] https://api"],
    ["curl --user=admin:hunter2 https://api", "curl --user=admin:[REDACTED] https://api"],
    ["curl --proxy-user p:s3cret https://api", "curl --proxy-user p:[REDACTED] https://api"],
  ])("%s", (args, expected) => {
    expect(commandSummary(args)).toBe(expected);
  });

  test("the program is its name and long paths keep their last two parts", () => {
    expect(commandSummary("/usr/local/bin/node /home/me/a/b/c/server.js --port 3000")).toBe("node …/c/server.js --port 3000");
  });

  test("a long line is cut to the limit after redaction", () => {
    const line = commandSummary(`node ${"x".repeat(300)} --token abc`, 40);
    expect(line).toHaveLength(40);
    expect(line.endsWith("…")).toBe(true);
    expect(commandSummary(`node --token abc ${"x".repeat(300)}`, 40)).toStartWith("node --token [REDACTED]");
  });
});

describe("/ram readers and kinds", () => {
  test("parseRssTable reads kB into bytes", () => {
    expect(parseRssTable("  12  2048\n 13 0\nbad line\n")).toEqual(new Map([[12, 2048 * 1024], [13, 0]]));
  });

  test("parsePaneList groups pane pids by session", () => {
    expect(parsePaneList("w-a 100\nw-a 101\nw-b 200\n\n")).toEqual(new Map([["w-a", [100, 101]], ["w-b", [200]]]));
  });

  test.each([
    ["node /x/node_modules/.bin/vite --port 1", "vite server"],
    ["bun x vite --port 5173", "vite server"],
    ["bun run /tmp/s/packages/collector/src/index.ts", "scratch collector"],
    ["/home/me/.local/bin/claude --model opus", "Claude CLI"],
    ["claude -p fix the vite config and the gradle build", "Claude CLI"],
    ["node /x/server.js --note vite", "node process"],
    ["/home/me/.cache/ms-playwright/chromium-1/chrome --headless", "Chromium"],
    ["java -cp gradle-launcher.jar org.gradle.launcher.daemon.bootstrap.GradleDaemon", "Gradle daemon"],
    ["java -DENVROOT=/x/buildtool/2.0 -jar cli.jar", "Java process"],
    ["java -jar app.jar", "Java process"],
    ["tmux -S /x new-session", "tmux"],
    ["python3 -m http.server", "python3"],
  ])("%s is a %s", (args, kind) => {
    expect(processKind(args)).toBe(kind);
  });
});
