import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { readFileSync } from "fs";
import { join } from "path";
import { vitePortFor } from "../packages/shared/src/topology.js";
import { LATEST_SCHEMA_VERSION, VERSIONED_MIGRATIONS } from "../packages/store/src/migrations.js";
import {
  ProbeLoop,
  WsObserver,
  assertPortsSafe,
  classifyFetchError,
  formatSummary,
  PROCESS_TABLE_ARGV,
  isRunCommandLine,
  nextReconnect,
  withNoOpMigration,
  parseProcessRows,
  runProcessPids,
  occupiedPorts,
  parseListeners,
  pickPorts,
  probeOnce,
  realClock,
  resumeUrl,
  sleep,
  summarize,
  summarizeSnapshot,
  waitFor,
  type ProbeTarget,
  type ProcessRow,
  type WsLike,
} from "./zero-downtime-probe.js";

const servers: Server<unknown>[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

function serve(fetch: (req: Request) => Response | Promise<Response>): Server<unknown> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch });
  servers.push(s);
  return s;
}

/** A port that was just bound and released: connecting to it is refused. */
function closedPort(): number {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
  const port = s.port!;
  s.stop(true);
  return port;
}

const target = (url: string, extra: Partial<ProbeTarget> = {}): ProbeTarget => ({ name: "t", url, intervalMs: 20, ...extra });
const deps = { fetch: (u: string, i: RequestInit) => fetch(u, i), clock: realClock, timeoutMs: 1_000 };

describe("probeOnce", () => {
  test("ok, non-2xx, unexpected body, timeout and refused are told apart", async () => {
    const s = serve(async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/ok") return new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
      if (path === "/503") return new Response("busy", { status: 503 });
      if (path === "/slow") {
        await sleep(400);
        return new Response("late");
      }
      return new Response("{}", { headers: { "content-type": "application/json" } });
    });
    const base = `http://127.0.0.1:${s.port}`;
    const html = (r: { contentType: string }) => (r.contentType.includes("html") ? null : `not html: ${r.contentType}`);

    expect((await probeOnce(target(`${base}/ok`, { check: html }), deps)).outcome).toBe("ok");
    const st = await probeOnce(target(`${base}/503`), deps);
    expect(st.outcome).toBe("status");
    expect(st.status).toBe(503);
    expect((await probeOnce(target(`${base}/json`, { check: html }), deps)).outcome).toBe("unexpected");
    const slow = await probeOnce(target(`${base}/slow`), { ...deps, timeoutMs: 100 });
    expect(slow.outcome).toBe("timeout");
    expect(slow.ms).toBeLessThan(400);
    const refused = await probeOnce(target(`http://127.0.0.1:${closedPort()}/`), { ...deps, phase: "A" });
    expect(refused.outcome).toBe("refused");
    expect(refused.phase).toBe("A");
  });

  test("POST sends the body", async () => {
    let got = "";
    const s = serve(async (req) => {
      got = await req.text();
      return Response.json({ ok: true });
    });
    const r = await probeOnce(target(`http://127.0.0.1:${s.port}/hook`, { method: "POST", body: '{"a":1}', headers: { "content-type": "application/json" } }), deps);
    expect(r.outcome).toBe("ok");
    expect(got).toBe('{"a":1}');
  });
});

describe("classifyFetchError", () => {
  test("maps codes and messages", () => {
    expect(classifyFetchError({ code: "ConnectionRefused", message: "Unable to connect" }).outcome).toBe("refused");
    expect(classifyFetchError(new Error("connect ECONNREFUSED 127.0.0.1:1")).outcome).toBe("refused");
    expect(classifyFetchError({ code: "ECONNRESET", message: "reset" }).outcome).toBe("reset");
    expect(classifyFetchError({ name: "AbortError", message: "aborted" }).outcome).toBe("timeout");
    expect(classifyFetchError(new Error("weird"), true).outcome).toBe("timeout");
    expect(classifyFetchError(new Error("weird")).outcome).toBe("error");
  });
});

describe("ProbeLoop", () => {
  test("probes every target at its rate, records results and stops cleanly", async () => {
    const s = serve(() => new Response("ok"));
    const refusedPort = closedPort();
    const seen: string[] = [];
    let phase = "warm";
    const loop = new ProbeLoop({
      targets: [target(`http://127.0.0.1:${s.port}/`, { name: "up" }), target(`http://127.0.0.1:${refusedPort}/`, { name: "down" })],
      fetch: deps.fetch,
      clock: realClock,
      timeoutMs: 500,
      phase: () => phase,
      onResult: (r) => seen.push(r.target),
    });
    loop.start();
    await sleep(150);
    phase = "A";
    await sleep(150);
    await loop.stop();
    const n = loop.results.length;
    await sleep(100);
    expect(loop.results.length).toBe(n);
    const summary = summarize(loop.results, loop.skipped);
    expect(summary.up.ok).toBeGreaterThan(5);
    expect(summary.up.refused).toBe(0);
    expect(summary.down.refused).toBe(summary.down.total);
    expect(loop.results.some((r) => r.phase === "A")).toBe(true);
    expect(seen.length).toBe(n);
  });

  test("skips ticks while too many probes are in flight", async () => {
    const s = serve(async () => {
      await sleep(300);
      return new Response("ok");
    });
    const loop = new ProbeLoop({ targets: [target(`http://127.0.0.1:${s.port}/`)], fetch: deps.fetch, clock: realClock, timeoutMs: 1_000, maxInflight: 2 });
    loop.start();
    await sleep(200);
    await loop.stop();
    expect(loop.skipped.t).toBeGreaterThan(0);
    expect(loop.results.length).toBe(2);
  });

  test("by default keeps at most one probe per target in flight", async () => {
    let concurrent = 0;
    let peak = 0;
    const s = serve(async () => {
      peak = Math.max(peak, ++concurrent);
      await sleep(250);
      concurrent--;
      return new Response("ok");
    });
    const loop = new ProbeLoop({ targets: [target(`http://127.0.0.1:${s.port}/`)], fetch: deps.fetch, clock: realClock, timeoutMs: 5_000 });
    loop.start();
    await sleep(200);
    await loop.stop();
    expect(peak).toBe(1);
    expect(loop.results).toHaveLength(1);
    expect(loop.results[0].outcome).toBe("ok");
    expect(loop.skipped.t).toBeGreaterThan(3);
  });
});

describe("summarize", () => {
  test("counts outcomes and latencies per target", () => {
    const s = summarize(
      [
        { target: "a", at: 0, ms: 10, outcome: "ok" },
        { target: "a", at: 1, ms: 30, outcome: "ok" },
        { target: "a", at: 2, ms: 99, outcome: "timeout" },
        { target: "b", at: 3, ms: 1, outcome: "refused" },
      ],
      { a: 2 }
    );
    expect(s.a).toMatchObject({ total: 3, ok: 2, timeout: 1, skipped: 2, maxMs: 99, maxOkMs: 30, overBudget: 0 });
    expect(s.b).toMatchObject({ total: 1, refused: 1, maxOkMs: 0 });
  });

  test("reports p50/p95 and counts ok probes over the soft budget", () => {
    const results = Array.from({ length: 100 }, (_, i) => ({ target: "a", at: i, ms: i + 1, outcome: "ok" as const }));
    results.push({ target: "a", at: 100, ms: 20_000, outcome: "ok" });
    const s = summarize([...results, { target: "a", at: 101, ms: 30_000, outcome: "timeout" }], {}, 10_000).a;
    expect(s.p50Ms).toBe(52);
    expect(s.p95Ms).toBe(97);
    expect(s.maxMs).toBe(30_000);
    expect(s.overBudget).toBe(1);
  });
});

describe("reconnect plan", () => {
  test("1012 reconnects at 250ms and resets; other closes back off to 2s", () => {
    expect(nextReconnect(1012, 5)).toEqual({ delayMs: 250, attempts: 0 });
    expect(nextReconnect(1006, 0)).toEqual({ delayMs: 250, attempts: 1 });
    expect(nextReconnect(1006, 1)).toEqual({ delayMs: 500, attempts: 2 });
    expect(nextReconnect(1006, 10).delayMs).toBe(2_000);
  });

  test("resumeUrl adds the cursor only when both parts are known", () => {
    expect(resumeUrl("ws://h/ws", undefined, 3)).toBe("ws://h/ws");
    expect(resumeUrl("ws://h/ws", "e1", undefined)).toBe("ws://h/ws");
    expect(resumeUrl("ws://h/ws", "e 1", 7)).toBe("ws://h/ws?epoch=e%201&since=7");
    expect(resumeUrl("ws://h/ws?x=1", "e", 0)).toBe("ws://h/ws?x=1&epoch=e&since=0");
  });
});

describe("WsObserver", () => {
  test("records hello-ok, reconnects after 1012 with the resume cursor", async () => {
    const urls: string[] = [];
    let epoch = "e1";
    const sockets = new Set<import("bun").ServerWebSocket<unknown>>();
    const s = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, server) {
        urls.push(new URL(req.url).search);
        return server.upgrade(req) ? undefined : new Response("no", { status: 400 });
      },
      websocket: {
        open(ws) {
          sockets.add(ws);
          ws.send(JSON.stringify({ type: "hello-ok", payload: { epoch, serverSeq: 4 } }));
          ws.send(JSON.stringify({ type: "x", seq: 5 }));
        },
        message() {},
        close(ws) {
          sockets.delete(ws);
        },
      },
    });
    servers.push(s);
    const events: Array<Record<string, unknown>> = [];
    const obs = new WsObserver({
      baseUrl: `ws://127.0.0.1:${s.port}/ws`,
      create: (url) => new WebSocket(url) as unknown as WsLike,
      clock: realClock,
      connectTimeoutMs: 2_000,
      onEvent: (e) => events.push(e),
    });
    obs.start();
    await waitFor("first hello", () => (obs.open ? true : undefined), { timeoutMs: 3_000, intervalMs: 20 });
    await sleep(50);
    epoch = "e2";
    for (const ws of sockets) ws.close(1012, "service restart");
    await waitFor("second hello", () => (obs.hellos().length >= 2 && obs.open ? true : undefined), { timeoutMs: 3_000, intervalMs: 20 });
    obs.stop();

    expect(urls[0]).toBe("");
    expect(urls[1]).toBe("?epoch=e1&since=5");
    const hellos = obs.hellos();
    expect(hellos.map((h) => h.epoch)).toEqual(["e1", "e2"]);
    const outages = obs.outages();
    expect(outages).toHaveLength(1);
    expect(outages[0].code).toBe(1012);
    expect(outages[0].gapMs).toBeGreaterThanOrEqual(200);
    expect(outages[0].gapMs).toBeLessThan(2_000);
    expect(events.some((e) => e.event === "close" && e.reconnectInMs === 250)).toBe(true);
  });

  test("keeps redialing a refused endpoint with backoff, and an open outage counts up to now", async () => {
    const port = closedPort();
    const obs = new WsObserver({
      baseUrl: `ws://127.0.0.1:${port}/ws`,
      create: (url) => new WebSocket(url) as unknown as WsLike,
      clock: realClock,
      connectTimeoutMs: 500,
    });
    obs.start();
    await sleep(900);
    obs.stop();
    expect(obs.connections.length).toBeGreaterThanOrEqual(2);
    expect(obs.open).toBe(false);
    expect(obs.hellos()).toHaveLength(0);
    expect(obs.neverOpened().length).toBeGreaterThanOrEqual(1);
  });

  test("a deliberate disconnect waits for reconnect(), which resumes and logs the replayed frames", async () => {
    const urls: string[] = [];
    const sockets = new Set<import("bun").ServerWebSocket<{ search: string }>>();
    const s = Bun.serve<{ search: string }>({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, server) {
        const search = new URL(req.url).search;
        urls.push(search);
        return server.upgrade(req, { data: { search } }) ? undefined : new Response("no", { status: 400 });
      },
      websocket: {
        open(ws) {
          sockets.add(ws);
          if (ws.data.search.includes("since=5")) {
            ws.send(JSON.stringify({ type: "hello-ok", payload: { epoch: "e1", serverSeq: 5, resumed: true } }));
            ws.send(JSON.stringify({ type: "checkpoint:new", seq: 6, payload: { id: "c1", sessionId: "s1" } }));
            return;
          }
          const snapshot = {
            sessions: [{ id: "s1" }, { id: "s2", endedAt: "2026-01-01T00:00:00Z" }],
            asks: [{ id: "a1", status: "pending" }, { id: "a2", status: "answered" }],
            checkpoints: [{ id: "c0" }],
          };
          ws.send(JSON.stringify({ type: "hello-ok", payload: { epoch: "e1", serverSeq: 4, snapshot } }));
          ws.send(JSON.stringify({ type: "x", seq: 5 }));
        },
        message() {},
        close(ws) {
          sockets.delete(ws);
        },
      },
    });
    servers.push(s as unknown as Server<unknown>);
    const obs = new WsObserver({
      baseUrl: `ws://127.0.0.1:${s.port}/ws`,
      create: (url) => new WebSocket(url) as unknown as WsLike,
      clock: realClock,
      connectTimeoutMs: 2_000,
    });
    obs.start();
    await waitFor("first hello", () => (obs.open && obs.cursor().lastSeq === 5 ? true : undefined), { timeoutMs: 3_000, intervalMs: 20 });
    expect(obs.hellos()[0].snapshot).toEqual({ sessions: ["s1"], asks: ["a1"], checkpoints: ["c0"] });

    expect(obs.disconnect()).toBe(true);
    await waitFor("closed", () => (obs.connections[0].closedAt !== undefined ? true : undefined), { timeoutMs: 3_000, intervalMs: 20 });
    await sleep(400);
    expect(obs.connections).toHaveLength(1);
    expect(obs.open).toBe(false);

    obs.reconnect();
    await waitFor("resumed", () => (obs.open && obs.frameLog.some((f) => f.id === "c1") ? true : undefined), { timeoutMs: 3_000, intervalMs: 20 });
    obs.stop();

    expect(urls).toEqual(["", "?epoch=e1&since=5"]);
    const resumed = obs.hellos()[1];
    expect(resumed).toMatchObject({ conn: 1, epoch: "e1", resumed: true, serverSeq: 5 });
    expect(obs.frameLog.find((f) => f.id === "c1")).toMatchObject({ conn: 1, type: "checkpoint:new", seq: 6, sessionId: "s1" });
    expect(obs.neverOpened()).toHaveLength(0);
    const outages = obs.outages();
    expect(outages).toHaveLength(1);
    expect(outages[0].deliberate).toBe(true);
    expect(outages[0].resumed).toBe(true);
  });
});

describe("summarizeSnapshot", () => {
  test("keeps active sessions, pending asks and every checkpoint; tolerates junk", () => {
    expect(summarizeSnapshot(undefined)).toBeUndefined();
    expect(summarizeSnapshot({ sessions: "x", asks: [null, { id: 3 }, { id: "a" }] })).toEqual({ sessions: [], asks: ["a"], checkpoints: [] });
  });
});

describe("process ownership", () => {
  const root = "/tmp/standup-zd-abc123";
  test("a command line is the run's when it runs the scratch install or the supervisor copy", () => {
    expect(isRunCommandLine(`bun run ${root}/install/scripts/dev.ts`, root)).toBe(true);
    expect(isRunCommandLine(`bun ${root}/data/restart/bin/supervisor.ts`, root)).toBe(true);
    expect(isRunCommandLine(`tail -f ${root}/check.log`, root)).toBe(false);
    expect(isRunCommandLine(`git -C ${root}/install status`, root)).toBe(false);
    expect(isRunCommandLine("bun run /opt/standup/scripts/dev.ts", root)).toBe(false);
    // An env-looking word in a command line is just text.
    expect(isRunCommandLine("bun run start STANDUP_ZD_RUN=abc123", root)).toBe(false);
  });

  test("parseProcessRows reads pid, ppid, pgid, sid and the command line", () => {
    const out = "    1     0     1     1 /sbin/init\n  420   300   420   420 bun run src/index.ts --flag a b\n\ngarbage line\n";
    expect(parseProcessRows(out)).toEqual([
      { pid: 1, ppid: 0, pgid: 1, sid: 1, args: "/sbin/init" },
      { pid: 420, ppid: 300, pgid: 420, sid: 420, args: "bun run src/index.ts --flag a b" },
    ]);
    expect(PROCESS_TABLE_ARGV.join(" ")).not.toMatch(/(^|\s)-?[a-z]*e[a-z]*(\s|$)/);
  });

  const row = (pid: number, ppid: number, pgid: number, sid: number, args: string): ProcessRow => ({ pid, ppid, pgid, sid, args });
  const rows: ProcessRow[] = [
    row(1, 0, 1, 1, "/sbin/init"),
    row(50, 1, 50, 50, "/usr/lib/systemd/systemd --user"),
    row(99, 50, 99, 99, "bun run zero-downtime-check.ts"),
    // dev.ts, started by the check in its own session, and a slot collector it runs.
    row(100, 99, 100, 100, `bun run ${root}/install/scripts/dev.ts`),
    row(101, 100, 100, 100, "bun run src/index.ts"),
    // A slot collector left behind by a SIGTERMed dev.ts, reparented to the user manager.
    row(102, 50, 100, 100, "bun run src/index.ts"),
    // The gateway, detached into its own session.
    row(200, 1, 200, 200, `bun run ${root}/install/packages/gateway/src/cli.ts`),
    // The restart supervisor and the standalone collector it starts in a session of its own.
    row(300, 1, 300, 300, `bun ${root}/data/restart/bin/cli.ts ${root}/data/restart/r1.json`),
    row(301, 300, 301, 301, "bun run src/index.ts"),
    row(302, 301, 301, 301, "rg --json needle"),
    // A standalone collector whose supervisor exited, known from an earlier scan.
    row(400, 1, 400, 400, "bun run src/index.ts"),
    // The live install, which must never match.
    row(500, 50, 500, 500, "bun run /opt/standup/scripts/dev.ts"),
    row(501, 500, 500, 500, "bun run src/index.ts"),
    row(600, 1, 600, 600, "bun run src/index.ts"),
  ];

  test("runProcessPids: recorded groups, known pids, scratch command lines and their descendants", () => {
    const ours = runProcessPids(rows, { root, groups: new Set([100]), known: new Map([[400, "bun run src/index.ts"]]), exclude: new Set([99]) });
    expect([...ours].sort((a, b) => a - b)).toEqual([100, 101, 102, 200, 300, 301, 302, 400]);
  });

  test("runProcessPids: a known pid with a different command line is a reused pid, not the run's", () => {
    const ours = runProcessPids(rows, { root, groups: new Set(), known: new Map([[600, "bun run something-else"], [500, "bun run /opt/standup/scripts/dev.ts"]]) });
    expect(ours.has(600)).toBe(false);
    // Known with the same command line it is the run's (the caller only records the run's own).
    expect(ours.has(500)).toBe(true);
  });

  test("runProcessPids: the excluded check and init never pull in their children", () => {
    const ours = runProcessPids(rows, { root, groups: new Set([1, 99]), known: new Map(), exclude: new Set([99]) });
    expect(ours.has(1)).toBe(false);
    expect(ours.has(50)).toBe(false);
    expect(ours.has(99)).toBe(false);
    expect(ours.has(500)).toBe(false);
    expect(ours.has(600)).toBe(false);
  });
});

describe("live-state guard", () => {
  test("parseListeners keeps the asked ports and their pids", () => {
    const out = [
      'LISTEN 0 512 127.0.0.1:5173 0.0.0.0:* users:(("bun",pid=11,fd=3),("bun",pid=12,fd=3))',
      "LISTEN 0 512 [::1]:7777 [::]:*",
      'LISTEN 0 512 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))',
      "",
    ].join("\n");
    const m = parseListeners(out, new Set([5173, 7777, 7778]));
    expect([...m.entries()]).toEqual([
      [5173, [11, 12]],
      [7777, []],
    ]);
  });
});

describe("waitFor", () => {
  test("returns the first defined value", async () => {
    let n = 0;
    expect(await waitFor("n", () => (++n >= 3 ? n : undefined), { timeoutMs: 1_000, intervalMs: 5 })).toBe(3);
  });

  test("times out naming what it waited for and the last error", async () => {
    await expect(
      waitFor(
        "the thing",
        () => {
          throw new Error("still booting");
        },
        { timeoutMs: 50, intervalMs: 10 }
      )
    ).rejects.toThrow(/the thing \(last: still booting\)/);
  });
});

describe("ports", () => {
  const forbidden = new Set([5173, 5174, 5199, 15173, 7777, 7778, 17777, 17778, 27777, 27778]);

  test("occupiedPorts includes both slots", () => {
    expect(occupiedPorts({ web: 35000, vite: 35001, collector: 30000, ws: 30001 })).toEqual([35000, 35001, 30000, 30001, 40000, 40001, 50000, 50001]);
  });

  test("assertPortsSafe refuses live ports, duplicates and out-of-range", () => {
    expect(() => assertPortsSafe({ web: 5173, vite: 35001, collector: 30000, ws: 30001 }, forbidden)).toThrow(/live install/);
    expect(() => assertPortsSafe({ web: 35000, vite: 35001, collector: 7777 - 10_000 + 20_000, ws: 30001 }, forbidden)).toThrow(/live install/);
    expect(() => assertPortsSafe({ web: 35000, vite: 35000, collector: 30000, ws: 30001 }, forbidden)).toThrow(/duplicates/);
    expect(() => assertPortsSafe({ web: 35000, vite: 35001, collector: 50000, ws: 50001 }, forbidden)).toThrow(/out of range/);
  });

  test("pickPorts skips busy candidates and stays in range", async () => {
    let calls = 0;
    const p = await pickPorts({
      // The first two candidate sets each hit a busy port.
      isFree: async () => ++calls > 2,
      forbidden,
      collectorRange: [30000, 35000],
      webRange: [35000, 40000],
    });
    expect(calls).toBe(2 + occupiedPorts(p).length);
    for (const port of occupiedPorts(p)) expect(port).toBeLessThan(65536);
    expect(p.collector).toBeGreaterThanOrEqual(30000);
    expect(p.collector + 20_001).toBeLessThan(55000);
    expect(p.web).toBeGreaterThanOrEqual(35000);
    expect(p.web).toBeLessThan(40000);
    expect(p.vite).toBe(vitePortFor(p.web));
  });

  test("maxPort keeps every occupied port below the ephemeral range", async () => {
    expect(() => assertPortsSafe({ web: 13000, vite: 13001, collector: 12800, ws: 12801 }, forbidden, 32_767)).toThrow(/out of range/);
    for (let i = 0; i < 50; i++) {
      // The ranges zero-downtime-check.ts picks from.
      const p = await pickPorts({ isFree: async () => true, forbidden, collectorRange: [10_000, 12_700], webRange: [13_000, 15_000], maxPort: 32_767 });
      for (const port of occupiedPorts(p)) {
        expect(port).toBeLessThanOrEqual(32_767);
        expect(forbidden.has(port)).toBe(false);
      }
      expect(p.collector).toBeGreaterThanOrEqual(10_000);
      expect(p.web).toBeGreaterThanOrEqual(13_000);
      expect(p.web).toBeLessThan(15_000);
      expect(p.vite).toBe(vitePortFor(p.web));
    }
  });

  test("every web port of the check's range leaves vite clear of the slot ports", () => {
    for (let web = 13_000; web < 15_000; web++) {
      const vite = vitePortFor(web);
      expect(vite).toBeLessThanOrEqual(32_767);
      // Slot a spans 20000–22699 and slot b 30000–32699 for collector ports 10000–12699.
      expect(vite >= 20_000 && vite < 22_700).toBe(false);
      expect(vite >= 30_000 && vite < 32_700).toBe(false);
    }
  });

  test("pickPorts gives up after its attempts", async () => {
    await expect(pickPorts({ isFree: async () => false, forbidden, collectorRange: [30000, 35000], webRange: [35000, 40000], attempts: 3 })).rejects.toThrow(/free port set/);
  });
});

describe("formatSummary", () => {
  test("prints verdict, targets, failures and assertions", () => {
    const text = formatSummary({
      root: "/tmp/x",
      ok: false,
      targets: summarize([{ target: "web", at: 0, ms: 5, outcome: "refused", detail: "ConnectionRefused" }]),
      failures: [{ target: "web", at: 0, ms: 5, outcome: "refused", detail: "ConnectionRefused", phase: "A" }],
      assertions: [{ name: "no refused", ok: false, detail: "1 refused" }],
      wsOutages: [
        { closedAt: 0, code: 1012, gapMs: 300, resumed: false },
        { closedAt: 1, code: 4000, gapMs: 700, resumed: true, deliberate: true },
      ],
      softBudgetMs: 10,
      warnings: ["live file /x changed"],
      extra: { gateway: { held: 1 } },
    });
    expect(text).toContain("p50 p95 p99 max");
    expect(text).toContain("back after 700ms (resumed) (deliberate)");
    expect(text).toContain("WARNING: live file /x changed");
    expect(text).toContain("FAIL");
    expect(text).toContain("[A] web refused");
    expect(text).toContain("[FAIL] no refused");
    expect(text).toContain("code=1012 back after 300ms");
    expect(text).toContain("/tmp/x");
  });
});

describe("withNoOpMigration", () => {
  const source = readFileSync(join(import.meta.dir, "..", "packages", "store", "src", "migrations.ts"), "utf8");

  test("adds one migration after the last of VERSIONED_MIGRATIONS, numbered one past it", () => {
    const last = VERSIONED_MIGRATIONS.at(-1)!.version;
    expect(last).toBe(LATEST_SCHEMA_VERSION);
    const added = withNoOpMigration(source)!;
    expect(added.version).toBe(last + 1);
    expect(added.source.length - source.length).toBe(`\n  migration(${last + 1}, "SELECT 1"),`.length);
    const at = added.source.indexOf(`migration(${last + 1}, "SELECT 1"),`);
    expect(added.source.slice(at).split("\n")[1]).toBe("];");
    expect(added.source.lastIndexOf(`migration(${last},`)).toBeLessThan(at);
  });

  test("a source without the list is left alone", () => {
    expect(withNoOpMigration("export const x = [\n  1,\n];\n")).toBeNull();
  });
});
