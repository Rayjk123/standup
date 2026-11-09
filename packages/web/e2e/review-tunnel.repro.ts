#!/usr/bin/env bun
/*
 * Live check of review tunnels on a throwaway install: a scratch collector
 * (its own data dir, owner token and ports, SLACK_* and NTFY_* stripped) whose
 * tunnel provider is the `command` provider driving a stub CLI, a git worktree
 * whose branch carries a UI change, and the console's dev server for
 * screenshots. No real tunnel is created: the stub logs its arguments and,
 * on `open`, holds on as a process naming the port, as a tunnel CLI does.
 *
 *   bun packages/web/e2e/review-tunnel.repro.ts --scratch /tmp/x --playwright /path/to/node_modules/playwright \
 *     [--api-port 5431] [--ws-port 5432] [--web-port 5433] [--screenshots /tmp/x/shots]
 *
 * Cases: (a) entering screenshot opens a tunnel serving the branch build; (b)
 * the config UI and the job drawer show it; (c) "Tear down" in the drawer stops
 * it; (d) a closed job's tunnel is swept; (e) a tunnel whose CLI died while the
 * collector was down is reconciled at start; (f) a stale one expires; (g) the
 * start reconcile stops a leaked tunnel process and leaves decoys of a
 * reserved standing tunnel and the Standup tunnel alone. The stub tunnel service stamps a non-default
 * identity header, and the identity checks show the collector and the console
 * proxy both read it: a teammate's user session sent through the console
 * proxy reaches the collector as that teammate.
 */
import { createHmac, randomBytes, randomUUID } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import type { Subprocess } from "bun";
import { DEFAULT_IDENTITY_HEADER } from "@standup/shared/constants";
import { USER_CHANNEL_HEADER, userChannelToken } from "@standup/shared/owner-token";
import { USER_SESSION_COOKIE, identityHeaderName, mintUserSessionValue, ownerTokenProxyConfigure, type IncomingRequest, type ProxiedRequest } from "../owner-proxy";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : fallback;
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

const SCRATCH = resolve(arg("scratch"));
const PLAYWRIGHT = arg("playwright");
const API_PORT = arg("api-port", "5431");
const WS_PORT = arg("ws-port", "5432");
const WEB_PORT = arg("web-port", "5433");
const SHOTS = arg("screenshots", join(SCRATCH, "shots"));
const ORIGIN = `http://localhost:${WEB_PORT}`;
const API = `http://127.0.0.1:${API_PORT}`;
const WEB_DIR = resolve(import.meta.dir, "..");
const COLLECTOR_DIR = resolve(WEB_DIR, "../collector");
const PROJECT = "acme-console";
const UI_DIR = "packages/console-ui";
const TUNNEL_DOMAIN = "tunnels.example.com";
/** The header the stub tunnel service stamps with the user it authenticated: not the default, so both the collector and the console proxy must take it from the tunnel settings. */
const TUNNEL_IDENTITY_HEADER = "x-review-tunnel-user";
/** A teammate reaching the console through the tunnel. */
const REVIEWER = "reviewer-teammate";
const PORT_RANGE: [number, number] = [5420, 5429];

if (!SCRATCH.startsWith("/tmp/")) throw new Error("the scratch dir must live under /tmp");
if (existsSync(SCRATCH)) throw new Error(`${SCRATCH} already exists: pick a fresh scratch dir`);
const LIVE_PORTS = new Set(["5173", "7777", "7778"]);
/** A standing tunnel of the host's own, reserved through the scratch collector's environment. */
const STANDING_SUFFIX = "kiosk";
const STANDING_PORT = 5419;
/** Whether nothing holds 127.0.0.1:`port` — a bind check, so a non-HTTP listener (Postgres on 5432) counts as taken. */
function tcpFree(port: number): boolean {
  try {
    const probe = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    probe.stop(true);
    return true;
  } catch {
    return false;
  }
}
for (const p of [API_PORT, WS_PORT, WEB_PORT, ...Array.from({ length: PORT_RANGE[1] - PORT_RANGE[0] + 1 }, (_, i) => String(PORT_RANGE[0] + i))]) {
  if (LIVE_PORTS.has(p)) throw new Error(`port ${p} belongs to the live install`);
  if (!tcpFree(Number(p))) throw new Error(`port ${p} is already in use`);
}
for (const d of ["data/secrets", "knowledge", "icons", "internal", "bin"]) mkdirSync(join(SCRATCH, d), { recursive: true, mode: 0o700 });
mkdirSync(SHOTS, { recursive: true, mode: 0o700 });
writeFileSync(join(SCRATCH, "projects.toml"), "");
const DB_PATH = join(SCRATCH, "data/standup.db");
if (existsSync(DB_PATH)) throw new Error(`${DB_PATH} exists: use a fresh scratch dir`);

const TOKEN_FILE = join(SCRATCH, "data/secrets/owner.token");
writeFileSync(TOKEN_FILE, randomBytes(32).toString("hex"), { mode: 0o600 });
const token = readFileSync(TOKEN_FILE, "utf8").trim();
const OWNER = process.env.USER ?? "owner";

// The stub tunnel CLI: `open` logs its argv and holds on as a process whose
// command line names the port (as a tunnel CLI's does); `ls --json` reports
// what tunnel-list.json says.
const STUB = join(SCRATCH, "bin/stub-tunnel");
const STUB_LOG = join(SCRATCH, "tunnel-stub.log");
const LIST_FILE = join(SCRATCH, "tunnel-list.json");
writeFileSync(
  STUB,
  `#!/bin/bash
echo "$(date -u +%FT%TZ) pid=$$ $*" >> ${STUB_LOG}
case "$1" in
  open) exec -a "stub-tunnel $*" sleep 100000 ;;
  ls) if [ -f ${LIST_FILE} ]; then cat ${LIST_FILE}; else echo '{"tunnels":[]}'; fi ;;
  *) echo "stub: unsupported $1" >&2; exit 2 ;;
esac
`
);
chmodSync(STUB, 0o755);
const claudeShim = join(SCRATCH, "bin/claude");
writeFileSync(claudeShim, `#!/bin/sh\nexec bun ${join(import.meta.dir, "fake-claude.ts")} "$@"\n`);
chmodSync(claudeShim, 0o755);

// A worktree whose branch adds a UI page under the console-ui package dir.
const WT = join(SCRATCH, "wt");
const git = (...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd: WT, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
};
mkdirSync(join(WT, UI_DIR, "src"), { recursive: true });
git("init", "-q", "-b", "main");
writeFileSync(join(WT, "README.md"), "base\n");
git("add", ".");
git("commit", "-q", "-m", "base");
git("checkout", "-q", "-b", "standup/status-chips");
writeFileSync(join(WT, UI_DIR, "index.html"), "<!doctype html><title>console-ui branch build</title><h1>Status chips (branch build)</h1>\n");
writeFileSync(join(WT, UI_DIR, "src/StatusChips.tsx"), "export const StatusChips = () => null;\n");
git("add", ".");
git("commit", "-q", "-m", "status chips");

// ── Seed the scratch DB: the project, one Persona job and four launches. ────
const store = (await import(join(COLLECTOR_DIR, "../store/src/index.ts"))) as typeof import("../../store/src/index.ts");
const { startPipelineForLaunch } = await import(join(COLLECTOR_DIR, "src/pipeline/engine.ts"));
const db = store.createStore(DB_PATH).db;
store.upsertProject(db, { id: PROJECT, name: "Acme Console", branch: "main", repos: [WT] });
const thread = store.getOrCreatePersonaConsoleThread(db, OWNER);
const job = store.createPersonaJob(db, {
  owner: OWNER,
  threadId: thread.id,
  title: "Status chips on the order form",
  goal: "Show each line's status as chips on the order form",
  acceptance: "The order form shows status chips; reviewed through the review tunnel",
});
// The owner's project layer: the UI package dir, a serve command (a static server, as the scratch
// worktree has no node_modules), its port range, and null clearing any setup a lower layer set.
const projectLayer = ({ ttlHours, region }: { ttlHours?: number; region?: string } = {}) => ({
  reviewTunnel: {
    dir: UI_DIR,
    serve: "python3 -m http.server {port} --bind 127.0.0.1",
    setup: null,
    portRange: PORT_RANGE,
    ...(ttlHours ? { ttlHours } : {}),
    ...(region ? { region } : {}),
  },
});
/** The region launch 3's run freezes, which its tunnel's open command must carry. */
const LAUNCH_3_REGION = "eu-west-1";
const launches: Array<{ id: string; sessionId: string; runId: string }> = [];
for (let i = 0; i < 4; i++) {
  // Launch 3 sets a region; launch 4 is the stale one: its run freezes a 2-second TTL.
  store.setPipelineConfig(db, OWNER, PROJECT, projectLayer(i === 3 ? { ttlHours: 2 / 3600 } : i === 2 ? { region: LAUNCH_3_REGION } : {}));
  const sessionId = randomUUID();
  store.createSession(db, { id: sessionId, projectId: PROJECT, title: `Status chips worker ${i + 1}`, cwd: WT, status: "running" });
  const launch = store.createLaunch(db, {
    id: randomUUID(),
    projectId: PROJECT,
    task: "status chips",
    worktreePath: WT,
    branch: "standup/status-chips",
    baseBranch: "main",
    status: "running",
    sessionId,
    requester: OWNER,
    launchedBy: OWNER,
  });
  store.linkPersonaJobLaunch(db, job.id, launch.id);
  const run = startPipelineForLaunch(db, { launchId: launch.id, owner: OWNER, projectId: PROJECT });
  launches.push({ id: launch.id, sessionId, runId: run.id });
}
store.setPipelineConfig(db, OWNER, PROJECT, projectLayer());
db.close();

// ── The scratch collector. ──────────────────────────────────────────────────
const inherited = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) =>
      !k.startsWith("SLACK_") &&
      !k.startsWith("NTFY_") &&
      !k.startsWith("STANDUP_TUNNEL_") &&
      k !== "STANDUP_IDENTITY_HEADER" &&
      k !== "STANDUP_BIND_HOST"
  )
);
const scratchEnv = {
  ...inherited,
  PATH: `${join(SCRATCH, "bin")}:${process.env.PATH}`,
  DB_PATH,
  STANDUP_OWNER_TOKEN_FILE: TOKEN_FILE,
  COLLECTOR_PORT: API_PORT,
  WS_PORT,
  KNOWLEDGE_DIR: join(SCRATCH, "knowledge"),
  ICONS_DIR: join(SCRATCH, "icons"),
  STANDUP_PROJECTS_PATH: join(SCRATCH, "projects.toml"),
  STANDUP_INTERNAL_ROOT: join(SCRATCH, "internal"),
  STANDUP_TUNNEL_PROVIDER: "command",
  STANDUP_TUNNEL_CREATE: `${STUB} open {port} --name {name} --region {region} --allow {allow}`,
  STANDUP_TUNNEL_URL: `https://{name}.${TUNNEL_DOMAIN}`,
  STANDUP_TUNNEL_LIST: `${STUB} ls --json`,
  STANDUP_TUNNEL_DOMAIN: TUNNEL_DOMAIN,
  STANDUP_TUNNEL_IDENTITY_HEADER: TUNNEL_IDENTITY_HEADER,
  STANDUP_WEB_URL: `${ORIGIN}/`,
  STANDUP_REVIEW_TUNNEL_RESERVED_PORTS: String(STANDING_PORT),
  STANDUP_REVIEW_TUNNEL_RESERVED_SUFFIXES: STANDING_SUFFIX,
};
// The real-tunnel guard: the scratch collector's tunnel commands must run this run's stub, inside the scratch dir.
if (
  !scratchEnv.STANDUP_TUNNEL_CREATE.startsWith(`${STUB} `) ||
  !scratchEnv.STANDUP_TUNNEL_LIST.startsWith(`${STUB} `) ||
  !STUB.startsWith(`${SCRATCH}/`) ||
  !readFileSync(STUB, "utf8").includes('exec -a "stub-tunnel $*" sleep')
) {
  throw new Error("STANDUP_TUNNEL_CREATE and STANDUP_TUNNEL_LIST must run this run's stub tunnel CLI; refusing to start");
}
let collector: Subprocess | undefined;
function startCollector(): void {
  collector = Bun.spawn(["bun", "run", "src/index.ts"], {
    cwd: COLLECTOR_DIR,
    env: scratchEnv,
    stdout: Bun.file(join(SCRATCH, `collector-${Date.now()}.log`)),
    stderr: Bun.file(join(SCRATCH, `collector-${Date.now()}.err.log`)),
  });
  console.log(`  collector pid ${collector.pid}`);
}
async function waitForHttp(): Promise<void> {
  for (let i = 0; i < 240; i++) {
    if (collector?.exitCode !== null || collector.signalCode !== null) throw new Error(`scratch collector exited (${collector?.exitCode})`);
    try {
      await fetch(`${API}/api/projects`);
      return;
    } catch {
      await Bun.sleep(250);
    }
  }
  throw new Error("scratch collector never came up");
}
async function stopCollector(): Promise<void> {
  if (collector && collector.exitCode === null) {
    collector.kill("SIGTERM");
    await collector.exited;
  }
}

const owner = { "content-type": "application/json", "x-standup-owner-token": token, [TUNNEL_IDENTITY_HEADER]: OWNER };
async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = owner) {
  const res = await fetch(`${API}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}
async function advance(launch: { sessionId: string }, stage: string, evidence: unknown) {
  const r = await api("POST", "/api/pipeline/advance", { session_id: launch.sessionId, cwd: WT, stage, evidence }, { "content-type": "application/json" });
  if (r.status !== 200) throw new Error(`advance ${stage}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
async function toScreenshot(launch: { sessionId: string }) {
  await advance(launch, "start", {});
  await advance(launch, "coding", { summary: "status chips", changedFiles: [`${UI_DIR}/src/StatusChips.tsx`] });
  await advance(launch, "validation", { commands: [{ command: "npm test", exitCode: 0, summary: "green" }] });
  await advance(launch, "review", { reviewers: [{ name: "r1", findings: [] }, { name: "r2", findings: [] }] });
  await advance(launch, "deploy", { account: "scratch", stacks: ["none"], liveSamples: [{ request: "GET /", response: "200", ok: true }] });
}
/** The process groups the scratch collector recorded for its tunnels — the only ones cleanup may signal. */
const recordedGroups = new Set<number>();
async function tunnelsOf(launchId: string): Promise<Array<Record<string, any>>> {
  const tunnels: Array<Record<string, any>> = (await api("GET", `/api/review-tunnels?launchIds=${launchId}`)).body.tunnels ?? [];
  for (const t of tunnels) {
    for (const pid of [t.servePid, t.tunnelPid]) if (typeof pid === "number" && pid > 1) recordedGroups.add(pid);
  }
  return tunnels;
}
async function waitFor<T>(label: string, fn: () => Promise<T | undefined | null | false>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await Bun.sleep(250);
  }
  throw new Error(`timed out waiting for ${label}`);
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const results: Array<{ label: string; ok: boolean; detail: string }> = [];
const check = (label: string, ok: boolean, detail = "") => {
  results.push({ label, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

let vite: { listen(): Promise<unknown>; close(): Promise<void> } | undefined;
let browser: { close(): Promise<void> } | undefined;
const decoys: Subprocess[] = [];
const cleanup = async () => {
  await browser?.close().catch(() => {});
  await stopCollector();
  await vite?.close().catch(() => {});
  for (const d of decoys) d.kill("SIGKILL");
  // Only the process groups the scratch collector recorded for its own tunnels, and only while
  // one of their members still names one of this run's review ports.
  const table = Bun.spawnSync(["ps", "-eo", "pgid=,args="]).stdout.toString();
  const ours = new RegExp(`(^|[^0-9])54(2[0-9])([^0-9]|$)`);
  for (const pgid of recordedGroups) {
    const named = table.split("\n").some((line) => {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      return m !== null && Number(m[1]) === pgid && ours.test(m[2]!);
    });
    if (!named) continue;
    try {
      process.kill(-pgid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
};
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.on(signal, () => void cleanup().finally(() => process.exit(code)));
}

try {
  startCollector();
  await waitForHttp();

  // The tunnel's own identity header names the user; the default header does not.
  const viaTunnel = await api("GET", "/api/whoami", undefined, { [TUNNEL_IDENTITY_HEADER]: REVIEWER });
  check("identity: the collector reads the tunnel's identity header", viaTunnel.body.user === REVIEWER && viaTunnel.body.tunnel === true, JSON.stringify(viaTunnel.body));
  const viaDefault = await api("GET", "/api/whoami", undefined, { [DEFAULT_IDENTITY_HEADER]: REVIEWER });
  check("identity: the default header names no one behind this tunnel", viaDefault.body.user !== REVIEWER && viaDefault.body.tunnel === false, JSON.stringify(viaDefault.body));

  // (a) Entering screenshot opens the tunnel.
  const [l1, l2, l3, l4] = launches as [(typeof launches)[0], (typeof launches)[0], (typeof launches)[0], (typeof launches)[0]];
  await toScreenshot(l1);
  const t1 = await waitFor("tunnel 1 open", async () => (await tunnelsOf(l1.id)).find((t) => t.status === "open"));
  console.log(`  tunnel 1: ${t1.url} on 127.0.0.1:${t1.port} (serve ${t1.servePid}, tunnel ${t1.tunnelPid})`);
  check("a: tunnel opened on an allocated port", t1.port === PORT_RANGE[0], `port ${t1.port}`);
  check("a: name follows <owner>-<job-slug>", t1.name === `${OWNER}-status-chips-on-the-order-form`, t1.name);
  const page = await fetch(`http://127.0.0.1:${t1.port}/${UI_DIR.split("/").pop()}/`).then((r) => r.text()).catch(() => "");
  const root = await fetch(`http://127.0.0.1:${t1.port}/`).then((r) => r.text()).catch(() => "");
  check("a: the port serves the branch build", root.includes("Status chips (branch build)") || page.includes("Status chips"), root.slice(0, 80));
  const stubLog = readFileSync(STUB_LOG, "utf8");
  const createLine = stubLog.trim().split("\n").find((l) => l.includes(` open ${t1.port} `)) ?? "";
  check(
    "a: Standup ran the provider's open command `<port> --name <suffix>` itself, owner-only (no --allow, no --region)",
    createLine.endsWith(`open ${t1.port} --name status-chips-on-the-order-form`),
    createLine
  );
  const status = await api("POST", "/api/pipeline/status", { session_id: l1.sessionId }, { "content-type": "application/json" });
  check("a: the worker's pipeline_status names the tunnel", status.body.reviewTunnel?.url === t1.url, JSON.stringify(status.body.reviewTunnel));

  // (b) Screenshots of the config UI and the job drawer.
  Object.assign(process.env, {
    STANDUP_OWNER_TOKEN_FILE: TOKEN_FILE,
    SCRATCH_API_PORT: API_PORT,
    SCRATCH_WS_PORT: WS_PORT,
    SCRATCH_WEB_PORT: WEB_PORT,
    STANDUP_TUNNEL_PROVIDER: scratchEnv.STANDUP_TUNNEL_PROVIDER,
    STANDUP_TUNNEL_IDENTITY_HEADER: scratchEnv.STANDUP_TUNNEL_IDENTITY_HEADER,
  });
  delete process.env.STANDUP_IDENTITY_HEADER;
  delete process.env.STANDUP_TUNNEL_UNAUTHENTICATED;
  // The console proxy, configured from the same settings, binds a user session to the tunnel's header.
  check("identity: the console proxy reads the tunnel's identity header", identityHeaderName() === TUNNEL_IDENTITY_HEADER, identityHeaderName());
  let proxyListener: ((proxyReq: ProxiedRequest, req: IncomingRequest) => void) | undefined;
  ownerTokenProxyConfigure(() => token)({ on: (_event, l) => (proxyListener = l) });
  const proxied: Record<string, string> = {};
  proxyListener!(
    { setHeader: (name, value) => void (proxied[name] = value), removeHeader: (name) => void delete proxied[name] },
    { method: "GET", headers: { host: `localhost:${WEB_PORT}`, cookie: `${USER_SESSION_COOKIE}=${mintUserSessionValue(token, REVIEWER)}`, [TUNNEL_IDENTITY_HEADER]: REVIEWER } }
  );
  check("identity: the console proxy forwards the teammate's user channel token", proxied[USER_CHANNEL_HEADER] === userChannelToken(token, REVIEWER));
  const { createServer } = await import(join(WEB_DIR, "node_modules/vite/dist/node/index.js"));
  const server = await createServer({ configFile: join(import.meta.dir, "vite.scratch.config.ts"), logLevel: "warn" });
  vite = server;
  await server.listen();
  // Through the scratch console proxy to the collector: the teammate's user session, on the tunnel's header, reads as them.
  const usageMe = async (headers: Record<string, string>) => {
    const res = await fetch(`${ORIGIN}/api/usage/me`, { headers });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
  const reviewerSession = `${USER_SESSION_COOKIE}=${mintUserSessionValue(token, REVIEWER)}`;
  const signedIn = await usageMe({ cookie: reviewerSession, [TUNNEL_IDENTITY_HEADER]: REVIEWER });
  check(
    "identity: through the console proxy, the teammate's session names them to the collector",
    signedIn.status === 200 && signedIn.body.user === REVIEWER,
    `${signedIn.status} ${JSON.stringify(signedIn.body).slice(0, 160)}`
  );
  const headerOnly = await usageMe({ [TUNNEL_IDENTITY_HEADER]: REVIEWER });
  check(
    "identity: through the console proxy, the tunnel header without the session proves no one",
    headerOnly.status === 403 && headerOnly.body.reason === "sign-in",
    `${headerOnly.status} ${JSON.stringify(headerOnly.body).slice(0, 160)}`
  );
  const { chromium } = (await import(PLAYWRIGHT)) as typeof import("playwright");
  const chrome = await chromium.launch();
  browser = chrome;
  const ctx = await chrome.newContext({ viewport: { width: 1440, height: 1000 } });
  const tab = await ctx.newPage();
  tab.on("pageerror", (err) => console.log(`  PAGE ERROR: ${err.message}`));
  await tab.route("**/*", (route) => {
    const host = new URL(route.request().url()).host;
    return host === `localhost:${WEB_PORT}` ? route.continue() : route.abort();
  });
  const expiry = String(Math.floor(Date.now() / 1000) + 600);
  const code = `${expiry}.${createHmac("sha256", token).update(`login:${expiry}`).digest("hex")}`;
  await tab.goto(`${ORIGIN}/__standup/login?code=${code}`);
  await tab.waitForLoadState("networkidle").catch(() => {});

  await tab.goto(`${ORIGIN}/projects/p/${PROJECT}`);
  const tunnelSettings = tab.getByTestId("review-tunnel-settings").first();
  await tunnelSettings.waitFor({ timeout: 20_000 });
  await tunnelSettings.scrollIntoViewIfNeeded();
  await tab.waitForTimeout(500);
  await tunnelSettings.screenshot({ path: join(SHOTS, "review-tunnel-config-project.png") });
  const effective = (await tab.getByTestId("review-tunnel-effective").first().textContent()) ?? "";
  check(
    "b: the project's config shows the merged tunnel (your dir + serve command, owner-only)",
    effective.includes("python3 -m http.server {port}") && effective.includes(UI_DIR) && effective.includes("allow you only"),
    effective
  );

  await tab.goto(`${ORIGIN}/you`);
  const globalSettings = tab.getByTestId("review-tunnel-settings").first();
  const hasGlobal = await globalSettings.waitFor({ timeout: 15_000 }).then(() => true, () => false);
  if (hasGlobal) {
    await globalSettings.scrollIntoViewIfNeeded();
    await tab.waitForTimeout(400);
    await globalSettings.screenshot({ path: join(SHOTS, "review-tunnel-config-you-tab.png") });
  }
  check("b: the You tab's pipeline settings carry the review-tunnel section", hasGlobal);

  await tab.goto(`${ORIGIN}/persona?job=${job.id}`);
  const url = tab.getByTestId("review-tunnel-url").first();
  const shown = await url.waitFor({ timeout: 20_000 }).then(() => true, () => false);
  check("b: the job drawer shows the tunnel URL", shown && (await url.getAttribute("href")) === t1.url, shown ? (await url.getAttribute("href")) ?? "" : "not shown");
  // The job has four launches, so four pipeline strips sit above it: bring the tunnel section into view.
  await url.scrollIntoViewIfNeeded();
  await tab.evaluate(() => document.querySelector("[data-testid=review-tunnels]")?.closest("section")?.scrollIntoView({ block: "center" }));
  await tab.waitForTimeout(600);
  await tab.screenshot({ path: join(SHOTS, "review-tunnel-job-drawer.png") });
  const headerLink = tab.getByTestId("job-drawer-review-tunnel").first();
  check("b: the drawer header links the review build", (await headerLink.getAttribute("href").catch(() => null)) === t1.url);
  await tab.locator("[role=dialog]").first().screenshot({ path: join(SHOTS, "review-tunnel-job-drawer-panel.png") });

  // (c) Tear down from the drawer.
  await tab.getByRole("button", { name: "Tear down" }).first().click();
  await waitFor("tunnel 1 closed", async () => (await tunnelsOf(l1.id)).find((t) => t.id === t1.id && t.status === "closed"));
  await waitFor("tunnel 1's processes gone", async () => !alive(t1.servePid) && !alive(t1.tunnelPid), 10_000);
  const c1 = (await tunnelsOf(l1.id)).find((t) => t.id === t1.id)!;
  check("c: Tear down closed it (manual) and stopped serve + tunnel", c1.closeReason === "manual", `serve alive ${alive(t1.servePid)}, tunnel alive ${alive(t1.tunnelPid)}`);
  const ended = tab.getByTestId("review-tunnel-ended").first();
  await ended.waitFor({ timeout: 10_000 }).catch(() => {});
  await ended.scrollIntoViewIfNeeded().catch(() => {});
  await tab.waitForTimeout(400);
  await tab.screenshot({ path: join(SHOTS, "review-tunnel-job-drawer-torn-down.png") });
  const portFreed = await fetch(`http://127.0.0.1:${t1.port}/`).then(() => false, () => true);
  check("c: its port is free again", portFreed);

  // (e, part 1) Open tunnel 2, then take the collector down and let its CLI die meanwhile.
  await toScreenshot(l2);
  const t2 = await waitFor("tunnel 2 open", async () => (await tunnelsOf(l2.id)).find((t) => t.status === "open"));
  check("e: a second launch reuses the freed port", t2.port === PORT_RANGE[0], `port ${t2.port}`);
  // Tunnel 3 opens next to it, on the next port and name.
  await toScreenshot(l3);
  const t3 = await waitFor("tunnel 3 open", async () => (await tunnelsOf(l3.id)).find((t) => t.status === "open"));
  check("a: concurrent tunnels get distinct ports and names", t3.port !== t2.port && t3.name !== t2.name, `${t2.port}/${t2.name} vs ${t3.port}/${t3.name}`);
  const t3Line = readFileSync(STUB_LOG, "utf8").trim().split("\n").find((l) => l.includes(` open ${t3.port} `)) ?? "";
  check(
    "a: a region on the project layer reaches the provider's open command as `--region <region>`",
    t3Line.endsWith(`open ${t3.port} --name ${t3.name.slice(`${OWNER}-`.length)} --region ${LAUNCH_3_REGION}`),
    t3Line
  );

  // (g) Decoys for the reconcile: a leaked copy of a tunnel Standup opened, a reserved standing tunnel, and the Standup tunnel.
  const decoy = (title: string) => {
    const p = Bun.spawn(["bash", "-c", `exec -a "${title}" sleep 100000`], { stdout: "ignore", stderr: "ignore" });
    decoys.push(p);
    return p.pid;
  };
  const leakPid = decoy(`stub-tunnel open ${t1.port} --name status-chips-on-the-order-form`);
  const standingPid = decoy(`stub-tunnel open ${STANDING_PORT} --name ${STANDING_SUFFIX}`);
  const standupPid = decoy("stub-tunnel open 5173 --name standup");
  const host = (await import("os")).hostname();
  writeFileSync(
    LIST_FILE,
    JSON.stringify({
      tunnels: [
        { tunnelName: t1.name, meta: { pid: leakPid, localPort: t1.port, hostname: host } },
        { tunnelName: `${OWNER}-${STANDING_SUFFIX}`, meta: { pid: standingPid, localPort: STANDING_PORT, hostname: host } },
        { tunnelName: `${OWNER}-standup`, meta: { pid: standupPid, localPort: 5173, hostname: host } },
        { tunnelName: t2.name, meta: { pid: t2.tunnelPid, localPort: t2.port, hostname: host } },
      ],
    })
  );

  await stopCollector();
  console.log("  collector stopped");
  check("e: a tunnel survives the collector stopping (detached)", alive(t2.servePid) && alive(t2.tunnelPid));
  process.kill(t2.tunnelPid, "SIGKILL");
  await Bun.sleep(300);
  // (d) The job is closed while the collector is down.
  const db2 = store.createStore(DB_PATH).db;
  db2.run("UPDATE persona_jobs SET status = 'done', outcome = 'shipped' WHERE id = ?", [job.id]);
  db2.close();
  startCollector();
  await waitForHttp();
  const c2 = await waitFor("tunnel 2 reconciled", async () => (await tunnelsOf(l2.id)).find((t) => t.id === t2.id && t.status === "closed"));
  check("e/d: the start reconcile closed the tunnels of the closed job", ["job_closed", "lost"].includes(c2.closeReason), c2.closeReason);
  await waitFor("tunnel 2's serve gone", async () => !alive(t2.servePid), 10_000).catch(() => {});
  check("e: and stopped the orphaned serve", !alive(t2.servePid));
  const c3 = await waitFor("tunnel 3 closed", async () => (await tunnelsOf(l3.id)).find((t) => t.id === t3.id && t.status === "closed"));
  check("d: the closed job's other tunnel closed as job_closed", c3.closeReason === "job_closed", c3.closeReason);
  check("d: and its processes are gone", !alive(t3.servePid) && !alive(t3.tunnelPid));
  await waitFor("leak stopped", async () => !alive(leakPid), 10_000).catch(() => {});
  check("g: the leaked tunnel process was stopped", !alive(leakPid));
  check(`g: the reserved standing tunnel decoy (${STANDING_PORT}, <owner>-${STANDING_SUFFIX}) is untouched`, alive(standingPid));
  check("g: the Standup tunnel decoy (5173, <owner>-standup) is untouched", alive(standupPid));

  // (f) A stale tunnel on a job that is still open: reopen the job, open launch 4's 2-second tunnel, wait for the sweep.
  const db3 = store.createStore(DB_PATH).db;
  db3.run("UPDATE persona_jobs SET status = 'active', outcome = NULL WHERE id = ?", [job.id]);
  db3.close();
  await toScreenshot(l4);
  const t4 = await waitFor("tunnel 4 open", async () => (await tunnelsOf(l4.id)).find((t) => t.status === "open"));
  console.log(`  tunnel 4 expires ${t4.expiresAt}; waiting for the 60s sweep`);
  const c4 = await waitFor("tunnel 4 expired", async () => (await tunnelsOf(l4.id)).find((t) => t.id === t4.id && t.status === "closed"), 90_000);
  check("f: a tunnel past its TTL is swept as expired", c4.closeReason === "expired", c4.closeReason);
  check("f: and its processes are gone", !alive(t4.servePid) && !alive(t4.tunnelPid));
} catch (err) {
  check("run", false, (err as Error).message);
} finally {
  await cleanup();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length > 0 ? 1 : 0);
