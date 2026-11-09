#!/usr/bin/env bun
/**
 * Memory load test for a scratch collector: drives the hook and poll traffic a
 * busy host produces and samples the collector's RSS while it runs.
 *
 *   bun scripts/collector-memory-load.ts --port 7871 --pid <collector pid> --dir /tmp/x/load
 *     [--big 6] [--big-mb 300] [--small 1500] [--small-kb 600]
 *     [--duration 60] [--hook-ms 100] [--viewers 2] [--rss-cap-gb 40] [--report out.json]
 *
 * It writes `--big` large and `--small` small Claude Code-shaped JSONL
 * transcripts under `--dir` (reused when already there), registers one session
 * per transcript with a SessionStart hook, then for `--duration` seconds:
 *   - fires a PostToolUse hook for every big session each `--hook-ms`, without
 *     waiting for earlier ones, and appends a record to its transcript each
 *     500 ms, as an agent in a tool loop does;
 *   - runs `--viewers` console viewers, each polling /api/sessions?all=1 and
 *     /api/task-runs once a second and every big session's transcript events
 *     every 10 s.
 * RSS is read from /proc/<pid>/status every 200 ms. Peak RSS is the highest
 * sample; steady RSS is the median of the second half of the run. If RSS
 * passes `--rss-cap-gb` the collector is killed so the host is never put at
 * risk, and the report says so.
 *
 * Point it only at a scratch collector: it creates sessions and grows files.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_COLLECTOR_PORT } from "@standup/shared";
import { collectorPortSet } from "../packages/shared/src/topology.js";

const { values } = parseArgs({
  options: {
    port: { type: "string" },
    pid: { type: "string" },
    dir: { type: "string" },
    big: { type: "string", default: "6" },
    "big-mb": { type: "string", default: "300" },
    small: { type: "string", default: "1500" },
    "small-kb": { type: "string", default: "600" },
    duration: { type: "string", default: "60" },
    "hook-ms": { type: "string", default: "100" },
    viewers: { type: "string", default: "2" },
    "rss-cap-gb": { type: "string", default: "40" },
    report: { type: "string" },
  },
});

if (!values.port || !values.pid || !values.dir) {
  console.error("usage: --port <collector port> --pid <collector pid> --dir <scratch dir> (see header)");
  process.exit(2);
}
// Every port a live collector binds (public and WS, default and this env's,
// and each gateway slot's) is never a load target, nor the range just above
// the defaults; there is no default port to fall back to.
const port = Number(values.port);
const livePorts = collectorPortSet(process.env);
if (!Number.isInteger(port) || port <= 0 || port > 65_535 || livePorts.has(port) || (port >= DEFAULT_COLLECTOR_PORT && port <= DEFAULT_COLLECTOR_PORT + 10)) {
  console.error(`refusing --port ${values.port}: not a scratch collector port`);
  process.exit(2);
}

const base = `http://127.0.0.1:${port}`;
const pid = Number(values.pid);
const dir = values.dir;
const bigCount = Number(values.big);
const bigBytes = Number(values["big-mb"]) * 1024 * 1024;
const smallCount = Number(values.small);
const smallBytes = Number(values["small-kb"]) * 1024;
const durationMs = Number(values.duration) * 1000;
const hookMs = Number(values["hook-ms"]);
const viewers = Number(values.viewers);
const rssCapKb = Number(values["rss-cap-gb"]) * 1024 * 1024;

const transcriptsDir = join(dir, "transcripts");
const workDir = join(dir, "work");
mkdirSync(transcriptsDir, { recursive: true });
mkdirSync(workDir, { recursive: true });

/** One JSONL record shaped like Claude Code's: an assistant turn or a tool result. */
function record(sessionId: string, i: number): string {
  const uuid = `${sessionId.slice(0, 8)}-0000-4000-8000-${String(i).padStart(12, "0")}`;
  const timestamp = new Date().toISOString();
  if (i % 2 === 0) {
    return JSON.stringify({
      type: "assistant",
      uuid,
      sessionId,
      timestamp,
      message: {
        role: "assistant",
        model: "claude-opus-5-5",
        content: [
          { type: "text", text: `Step ${i}: `.padEnd(1200, "reasoning about the change ") },
          { type: "tool_use", id: `toolu_${i}`, name: "Bash", input: { command: "bun test" } },
        ],
        usage: { input_tokens: 1200, output_tokens: 300 },
      },
    });
  }
  return JSON.stringify({
    type: "user",
    uuid,
    sessionId,
    timestamp,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `toolu_${i - 1}`, content: "x".repeat(14_000) }],
    },
  });
}

interface Fixture {
  sessionId: string;
  path: string;
  next: number;
}

/** Writes a transcript of about `bytes` unless one of that size is already there. */
function fixture(kind: string, n: number, bytes: number): Fixture {
  const sessionId = `${kind === "big" ? "b" : "s"}${String(n).padStart(7, "0")}-1111-4111-8111-111111111111`;
  const path = join(transcriptsDir, `${sessionId}.jsonl`);
  const metaPath = `${path}.next`;
  if (existsSync(path) && existsSync(metaPath) && statSync(path).size >= bytes) {
    return { sessionId, path, next: Number(readFileSync(metaPath, "utf8")) };
  }
  const chunk: string[] = [];
  let written = 0;
  let i = 0;
  writeFileSync(path, "");
  while (written < bytes) {
    const line = record(sessionId, i++) + "\n";
    chunk.push(line);
    written += line.length;
    if (chunk.length >= 2000) {
      appendFileSync(path, chunk.join(""));
      chunk.length = 0;
    }
  }
  if (chunk.length) appendFileSync(path, chunk.join(""));
  writeFileSync(metaPath, String(i));
  return { sessionId, path, next: i };
}

console.log(`[load] writing fixtures under ${transcriptsDir}`);
const big = Array.from({ length: bigCount }, (_, n) => fixture("big", n, bigBytes));
const small = Array.from({ length: smallCount }, (_, n) => fixture("small", n, smallBytes));

function hook(f: Fixture, event: string): Promise<Response> {
  return fetch(`${base}/hook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: f.sessionId,
      cwd: workDir,
      transcript_path: f.path,
      hook_event_name: event,
      ...(event === "SessionStart" ? { source: "startup" } : {}),
      ...(event === "PostToolUse" ? { tool_name: "Bash", tool_input: { command: "true" }, tool_response: {} } : {}),
    }),
  });
}

// ---- RSS sampling --------------------------------------------------------

interface Sample {
  t: number;
  rssKb: number;
}
const samples: Sample[] = [];
let killed = false;
const started = Date.now();

function readRssKb(): number | null {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const m = /VmRSS:\s+(\d+) kB/.exec(status);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

let died = false;
const sampler = setInterval(() => {
  const rssKb = readRssKb();
  if (rssKb === null) {
    if (!killed) died = true;
    return;
  }
  samples.push({ t: Date.now() - started, rssKb });
  if (rssKb > rssCapKb && !killed) {
    killed = true;
    console.error(`[load] collector RSS ${(rssKb / 1048576).toFixed(1)} GB passed the cap; killing pid ${pid}`);
    process.kill(pid, "SIGKILL");
  }
}, 200);

// ---- traffic -------------------------------------------------------------

const stats = {
  hooks: 0,
  hookErrors: 0,
  polls: 0,
  pollErrors: 0,
  sessionsAllMs: [] as number[],
  sessionsAllBytes: 0,
};
let inFlight = 0;
const MAX_IN_FLIGHT = 2000;

function track(p: Promise<Response>, onOk?: (r: Response) => Promise<void>, kind: "hook" | "poll" = "hook"): void {
  inFlight++;
  p.then(async (r) => {
    if (!r.ok) throw new Error(String(r.status));
    if (onOk) await onOk(r);
    else await r.arrayBuffer();
  })
    .catch(() => {
      if (kind === "hook") stats.hookErrors++;
      else stats.pollErrors++;
    })
    .finally(() => inFlight--);
}

console.log(`[load] registering ${big.length + small.length} sessions`);
const registerStart = Date.now();
for (const f of [...big, ...small]) {
  stats.hooks++;
  track(hook(f, "SessionStart"));
  while (inFlight > 200) await Bun.sleep(5);
}
console.log(`[load] registered in ${Date.now() - registerStart} ms; driving load for ${durationMs / 1000}s`);

const loadStart = Date.now();
const timers: Timer[] = [];

timers.push(
  setInterval(() => {
    for (const f of big) {
      if (inFlight >= MAX_IN_FLIGHT) return;
      stats.hooks++;
      track(hook(f, "PostToolUse"));
    }
  }, hookMs)
);

timers.push(
  setInterval(() => {
    for (const f of big) appendFileSync(f.path, record(f.sessionId, f.next++) + "\n");
  }, 500)
);

for (let v = 0; v < viewers; v++) {
  timers.push(
    setInterval(() => {
      const t0 = Date.now();
      stats.polls++;
      track(
        fetch(`${base}/api/sessions?all=1`),
        async (r) => {
          const body = await r.arrayBuffer();
          stats.sessionsAllBytes = body.byteLength;
          stats.sessionsAllMs.push(Date.now() - t0);
        },
        "poll"
      );
      stats.polls++;
      track(fetch(`${base}/api/task-runs`), undefined, "poll");
    }, 1000)
  );
  timers.push(
    setInterval(() => {
      for (const f of big) {
        stats.polls++;
        track(fetch(`${base}/api/sessions/${f.sessionId}/transcript/events?before=0&limit=200`), undefined, "poll");
      }
    }, 10_000)
  );
}

while (Date.now() - loadStart < durationMs && !killed && !died) await Bun.sleep(250);
for (const t of timers) clearInterval(t);
const drainUntil = Date.now() + 15_000;
while (inFlight > 0 && Date.now() < drainUntil) await Bun.sleep(100);
clearInterval(sampler);

// ---- report --------------------------------------------------------------

const gb = (kb: number) => Number((kb / 1048576).toFixed(2));
const loadSamples = samples.filter((s) => s.t >= loadStart - started);
const half = loadSamples.slice(Math.floor(loadSamples.length / 2)).map((s) => s.rssKb).sort((a, b) => a - b);
const peak = samples.reduce((m, s) => Math.max(m, s.rssKb), 0);
const lat = [...stats.sessionsAllMs].sort((a, b) => a - b);
const pct = (p: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] : null);

const report = {
  fixtures: { big: bigCount, bigMb: bigBytes / 1048576, small: smallCount, smallKb: smallBytes / 1024 },
  durationS: durationMs / 1000,
  killedAtCap: killed,
  collectorDied: died,
  peakRssGb: gb(peak),
  steadyRssGb: half.length ? gb(half[Math.floor(half.length / 2)]) : null,
  startRssGb: samples.length ? gb(samples[0].rssKb) : null,
  hooks: stats.hooks,
  hookErrors: stats.hookErrors,
  polls: stats.polls,
  pollErrors: stats.pollErrors,
  sessionsAll: { bytes: stats.sessionsAllBytes, p50Ms: pct(0.5), p95Ms: pct(0.95), count: lat.length },
  inFlightAtEnd: inFlight,
  timeline: samples.filter((_, i) => i % 5 === 0).map((s) => [Math.round(s.t / 1000), gb(s.rssKb)]),
};

console.log(JSON.stringify({ ...report, timeline: undefined }, null, 2));
if (values.report) writeFileSync(values.report, JSON.stringify(report, null, 2));
process.exit(0);
