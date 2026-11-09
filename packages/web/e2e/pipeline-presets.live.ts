#!/usr/bin/env bun
/*
 * Live check of per-project delivery pipeline presets, on a throwaway install:
 * a scratch collector (own data dir, owner token, projects, ports, and a
 * private tmux server named with -L), the console's dev server proxied to it,
 * and headless Chromium signed in with a login code minted from the scratch
 * owner token. Nothing is launched.
 *
 *   bun packages/web/e2e/pipeline-presets.live.ts [--out /dir] [--shots /dir] [--keep]
 *     [--playwright /path/to/node_modules/playwright]
 *
 * Two fixture projects:
 *   standup-livecheck  a plain git repo on github.com                         → preset light
 *   review-livecheck   a code-host remote, pinned to the generic review adapter → preset full
 * It drives /api/pipeline-config for both (read, a plain-words spec save, an
 * unknown clause refused) and takes desktop screenshots of each project's
 * pipeline settings. Samples (request → response) go to
 * <out>/live-samples.json; screenshots to --shots. Everything else lives in
 * /tmp/standup-livecheck-<run>, removed at the end unless --keep.
 *
 * Isolation: every child gets an environment built from scratch (no Slack,
 * ntfy, Persona, worker-token or tmux settings of the caller), git may only
 * use local transports, the live install's ports are refused, and every tmux
 * call goes to `tmux -L standup-livecheck-<run>` through a shim first on the
 * collector's PATH; teardown kills only that server and this run's processes.
 */
import { createHmac, randomBytes } from "crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import type { Subprocess } from "bun";
import type { Browser, Page } from "playwright";
import { DEFAULT_IDENTITY_HEADER } from "@standup/shared/constants";
import { collectorPortSet } from "@standup/shared/topology";

function opt(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = process.argv[i + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} needs a value`);
  return value;
}

const RUN = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const SCRATCH = `/tmp/standup-livecheck-${RUN}`;
const TMUX_NAME = `standup-livecheck-${RUN}`;
const OUT = resolve(opt("out") ?? `/tmp/standup-livecheck-out-${RUN}`);
const SHOTS = resolve(opt("shots") ?? `/tmp/standup-screenshots-${process.getuid?.() ?? "user"}`);
const KEEP = process.argv.includes("--keep");
const PLAYWRIGHT = opt("playwright") ?? process.env.STANDUP_PLAYWRIGHT ?? "/tmp/standup-pw/node_modules/playwright";
const WEB_DIR = resolve(import.meta.dir, "..");
const COLLECTOR_DIR = resolve(WEB_DIR, "../collector");
const BUN = process.execPath;
const VIEWPORT = { width: 1440, height: 900 };

// The live install's collector ports (public and both slots, by default and as
// this environment sets them), its console and vite ports, and the range its
// second collectors use.
const REFUSED = new Set<number>([...collectorPortSet({}), ...collectorPortSet(process.env), 5173, 5199, 15173]);
const REFUSED_RANGE = { from: 7787, to: 7858 };
const refusedPort = (port: number) => REFUSED.has(port) || (port >= REFUSED_RANGE.from && port <= REFUSED_RANGE.to);

async function portFree(port: number): Promise<boolean> {
  for (const hostname of ["127.0.0.1", "::1"]) {
    const taken = await Bun.connect({ hostname, port, socket: { data() {}, open(s) { s.end(); }, error() {} } }).then(
      () => true,
      () => false
    );
    if (taken) return false;
  }
  return true;
}
async function pickPort(name: string, taken: Set<number>): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = probe.port;
    probe.stop(true);
    if (!refusedPort(port) && !taken.has(port) && (await portFree(port))) {
      taken.add(port);
      return port;
    }
  }
  throw new Error(`no free port for ${name}`);
}

const droppedEnvKey = (k: string) =>
  ["STANDUP_PERSONA", "STANDUP_TEST", "STANDUP_WORKER_TOKEN_FILE", "STANDUP_PERSONAL_AWS_ACCOUNTS", "STANDUP_BIND_HOST", "TMUX", "TMUX_PANE"].includes(k) ||
  k.startsWith("SLACK_") ||
  k.startsWith("NTFY_");
for (const k of Object.keys(process.env)) if (droppedEnvKey(k)) delete process.env[k];

const taken = new Set<number>();
const API_PORT = await pickPort("api", taken);
const WS_PORT = await pickPort("ws", taken);
const WEB_PORT = await pickPort("web", taken);
const ORIGIN = `http://localhost:${WEB_PORT}`;
const API = `http://127.0.0.1:${API_PORT}`;

if (existsSync(SCRATCH)) throw new Error(`${SCRATCH} already exists`);
mkdirSync(SCRATCH, { mode: 0o700 });
for (const d of ["data/secrets", "knowledge", "icons", "internal", "bin", "home", "worktrees", "repos"]) {
  mkdirSync(join(SCRATCH, d), { recursive: true, mode: 0o700 });
}
mkdirSync(OUT, { recursive: true });
if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true, mode: 0o700 });
console.log(`run ${RUN}: scratch ${SCRATCH}, out ${OUT}, shots ${SHOTS}`);
console.log(`ports: collector ${API_PORT}, ws ${WS_PORT}, console ${WEB_PORT}; tmux -L ${TMUX_NAME}`);

const TOKEN_FILE = join(SCRATCH, "data/secrets/owner.token");
writeFileSync(TOKEN_FILE, randomBytes(32).toString("hex"), { mode: 0o600 });
const token = readFileSync(TOKEN_FILE, "utf8").trim();
const OWNER = process.env.USER || "owner";

// The collector's startup sweeps call tmux; the shim pins them to this run's server.
const BIN = join(SCRATCH, "bin");
const whichTmux = Bun.which("tmux");
if (!whichTmux) throw new Error("tmux is not on PATH");
const REAL_TMUX = realpathSync(whichTmux);
writeFileSync(join(BIN, "tmux"), `#!/bin/sh\nexec ${REAL_TMUX} -L ${TMUX_NAME} "$@"\n`);
chmodSync(join(BIN, "tmux"), 0o755);

const scratchEnv: Record<string, string> = {
  PATH: `${BIN}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  USER: OWNER,
  LOGNAME: OWNER,
  SHELL: process.env.SHELL || "/bin/sh",
  LANG: process.env.LANG || "C.UTF-8",
  TERM: process.env.TERM || "xterm-256color",
  HOME: join(SCRATCH, "home"),
  DB_PATH: join(SCRATCH, "data/standup.db"),
  STANDUP_OWNER_TOKEN_FILE: TOKEN_FILE,
  COLLECTOR_PORT: String(API_PORT),
  WS_PORT: String(WS_PORT),
  STANDUP_WEB_PORT: String(WEB_PORT),
  KNOWLEDGE_DIR: join(SCRATCH, "knowledge"),
  ICONS_DIR: join(SCRATCH, "icons"),
  STANDUP_PROJECTS_PATH: join(SCRATCH, "projects.toml"),
  STANDUP_INTERNAL_ROOT: join(SCRATCH, "internal"),
  STANDUP_WORKTREE_ROOT: join(SCRATCH, "worktrees"),
  STANDUP_WEB_URL: `${ORIGIN}/`,
  STANDUP_GATEWAY: "0",
  STANDUP_PERSONA: "0",
  // git reads only this run's files: no remote is ever contacted.
  GIT_ALLOW_PROTOCOL: "file",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
};

// Pre-flight: tmux on the scratch PATH is the shim, and no child carries a dropped setting.
{
  const resolved = Bun.spawnSync(["sh", "-c", "command -v tmux"], { env: scratchEnv }).stdout.toString().trim();
  if (resolved !== join(BIN, "tmux")) throw new Error(`tmux on the scratch PATH resolves to ${resolved || "nothing"}, not the shim`);
  const leaked = Object.keys(scratchEnv).filter((k) => droppedEnvKey(k) && k !== "STANDUP_PERSONA");
  if (leaked.length) throw new Error(`scratch env carries ${leaked.join(", ")}`);
  for (const k of ["HOME", "DB_PATH", "STANDUP_OWNER_TOKEN_FILE", "KNOWLEDGE_DIR", "ICONS_DIR", "STANDUP_PROJECTS_PATH", "STANDUP_INTERNAL_ROOT", "STANDUP_WORKTREE_ROOT"]) {
    if (!resolve(scratchEnv[k]!).startsWith(`${SCRATCH}/`)) throw new Error(`${k} ${scratchEnv[k]} is outside the run dir`);
  }
}

const privateTmux = (...args: string[]) => Bun.spawnSync([REAL_TMUX, "-L", TMUX_NAME, ...args], { env: scratchEnv });

/** A git repo with one commit, its origin set by writing .git/config. */
function fixtureRepo(name: string, origin: string): string {
  const dir = join(SCRATCH, "repos", name);
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => {
    const res = Bun.spawnSync(["git", "-c", "user.name=livecheck", "-c", "user.email=livecheck@localhost", ...args], { cwd: dir, env: scratchEnv });
    if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
    return res.stdout.toString();
  };
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), `${name}: fixture for the pipeline presets live check\n`);
  git("add", "README.md");
  git("commit", "-q", "-m", "initial");
  const config = readFileSync(join(dir, ".git/config"), "utf8");
  writeFileSync(join(dir, ".git/config"), `${config}[remote "origin"]\n\turl = ${origin}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  const read = git("remote", "get-url", "origin").trim();
  if (read !== origin) throw new Error(`${name} origin reads ${read}`);
  return dir;
}
const PLAIN = "standup-livecheck";
const REVIEWED = "review-livecheck";
const CODE_REVIEW = "code_review";
const plainRepo = fixtureRepo("standup-like", "https://github.com/example/standup-livecheck.git");
const reviewedRepo = fixtureRepo("reviewed-like", "ssh://git@code.example.corp/acme/livecheck");
const projectToml = (id: string, repo: string, extra: string[] = []) => [
  "[[project]]",
  `id = "${id}"`,
  `name = "${id}"`,
  `repos = ["${repo}"]`,
  `branch = "main"`,
  `worktreeRoot = "${join(SCRATCH, "worktrees")}"`,
  "bypassPermissions = false",
  ...extra,
  "",
];
writeFileSync(
  join(SCRATCH, "projects.toml"),
  [...projectToml(PLAIN, plainRepo), ...projectToml(REVIEWED, reviewedRepo, [`codeReviewAdapter = "generic"`])].join("\n")
);

// ── Collector and API ───────────────────────────────────────────────────────

const pids: number[] = [];
let collector: Subprocess | undefined;
function startCollector(): void {
  collector = Bun.spawn([BUN, "run", "src/index.ts"], {
    cwd: COLLECTOR_DIR,
    env: scratchEnv,
    stdout: Bun.file(join(SCRATCH, "collector.log")),
    stderr: Bun.file(join(SCRATCH, "collector.err.log")),
  });
  pids.push(collector.pid);
  console.log(`  collector pid ${collector.pid}`);
}
async function waitForHttp(): Promise<void> {
  for (let i = 0; i < 240; i++) {
    if (collector?.exitCode !== null || collector.signalCode !== null) {
      throw new Error(`scratch collector exited (${collector?.exitCode ?? collector?.signalCode})`);
    }
    try {
      await fetch(`${API}/api/projects`);
      return;
    } catch {
      await Bun.sleep(250);
    }
  }
  throw new Error("scratch collector never came up");
}

type Json = Record<string, any>;
type Sample = { request: string; status: number; response: Json; ok: boolean; problems?: string[] };
const samples: Sample[] = [];
async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-standup-owner-token": token, [DEFAULT_IDENTITY_HEADER]: OWNER },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, json: { raw: text.slice(0, 300) } };
  }
}
/** Calls the API, records the sample with the fields `pick` keeps, and checks it with `expect` (problems, empty when it holds). */
async function sample(method: string, path: string, body: unknown, pick: (j: Json) => Json, expect: (status: number, j: Json) => string[]): Promise<Json> {
  const { status, json } = await call(method, path, body);
  const problems = expect(status, json);
  const s: Sample = {
    request: `${method} ${path}${body === undefined ? "" : ` ${JSON.stringify(body)}`}`,
    status,
    response: pick(json),
    ok: problems.length === 0,
    ...(problems.length ? { problems } : {}),
  };
  samples.push(s);
  console.log(`  ${s.ok ? "PASS" : "FAIL"} ${s.request} → ${status} ${JSON.stringify(s.response).slice(0, 220)}${problems.length ? ` (${problems.join("; ")})` : ""}`);
  return json;
}
const stageIds = (j: Json): string[] => (Array.isArray(j.stages) ? j.stages.map((s: Json) => s.id) : []);
const configPick = (j: Json): Json => ({
  preset: j.preset,
  stages: stageIds(j),
  ...(j.compiled ? { compiled: j.compiled } : {}),
  ...(j.error ? { error: j.error } : {}),
  ...(j.unknown ? { unknown: j.unknown } : {}),
});
const checks = (...pairs: Array<[boolean, string]>) => pairs.filter(([ok]) => !ok).map(([, why]) => why);

// ── Teardown ────────────────────────────────────────────────────────────────

let browser: Browser | undefined;
let vite: { listen(): Promise<unknown>; close(): Promise<void> } | undefined;
let cleaned = false;
async function cleanup(): Promise<void> {
  if (cleaned) return;
  cleaned = true;
  await browser?.close().catch(() => {});
  await vite?.close().catch(() => {});
  if (collector && collector.exitCode === null && collector.signalCode === null) {
    collector.kill("SIGTERM");
    await Promise.race([collector.exited, Bun.sleep(10000)]);
    if (collector.exitCode === null && collector.signalCode === null) collector.kill("SIGKILL");
  }
  privateTmux("kill-server");
  try {
    mkdirSync(join(OUT, "logs"), { recursive: true });
    for (const f of readdirSync(SCRATCH)) if (f.startsWith("collector")) cpSync(join(SCRATCH, f), join(OUT, "logs", f));
  } catch {
    // The logs are a convenience; the samples are already written.
  }
  if (!KEEP) rmSync(SCRATCH, { recursive: true, force: true });
  else console.log(`kept ${SCRATCH}`);
}
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.on(signal, () => void cleanup().finally(() => process.exit(code)));
}

// ── The check ───────────────────────────────────────────────────────────────

const shots: string[] = [];
let fatal: unknown;
try {
  startCollector();
  await waitForHttp();

  console.log("config resolution");
  await sample("GET", `/api/pipeline-config?project=${PLAIN}`, undefined, configPick, (status, j) =>
    checks(
      [status === 200, `status ${status}`],
      [j.preset?.auto === "light", `preset.auto ${j.preset?.auto}`],
      [stageIds(j).includes("live_check"), "no live_check"],
      [stageIds(j).includes("human_review"), "no human_review"],
      [!stageIds(j).includes(CODE_REVIEW), `has ${CODE_REVIEW}`],
      [!stageIds(j).includes("deploy"), "has deploy"]
    )
  );
  await sample("GET", `/api/pipeline-config?project=${REVIEWED}`, undefined, configPick, (status, j) =>
    checks(
      [status === 200, `status ${status}`],
      [j.preset?.auto === "full", `preset.auto ${j.preset?.auto}`],
      ...["deploy", "screenshot", CODE_REVIEW, "human_review"].map((id): [boolean, string] => [stageIds(j).includes(id), `no ${id}`])
    )
  );
  await sample("PUT", `/api/pipeline-config?project=${PLAIN}`, { spec: "no screenshots, 3 reviewers" }, configPick, (status, j) =>
    checks(
      [status === 200, `status ${status}`],
      [!stageIds(j).includes("screenshot"), "still has screenshot"],
      [Array.isArray(j.compiled?.clauses) && j.compiled.clauses.length === 2, `compiled clauses ${JSON.stringify(j.compiled?.clauses)}`],
      [Array.isArray(j.compiled?.unknown) && j.compiled.unknown.length === 0, `compiled unknown ${JSON.stringify(j.compiled?.unknown)}`]
    )
  );
  await sample("PUT", `/api/pipeline-config?project=${PLAIN}`, { spec: "no screenshots, frobnicate the widgets" }, configPick, (status, j) =>
    checks(
      [status === 400, `status ${status}`],
      [Array.isArray(j.unknown) && j.unknown.includes("frobnicate the widgets"), `unknown ${JSON.stringify(j.unknown)}`]
    )
  );
  // The settings page is shown from the project's own preset, with no layer saved.
  await sample("DELETE", `/api/pipeline-config?project=${PLAIN}`, undefined, configPick, (status, j) =>
    checks([status === 200, `status ${status}`], [j.preset?.auto === "light" && stageIds(j).includes("screenshot"), "reset did not restore light"])
  );

  // ── Screenshots ──
  console.log("screenshots");
  Object.assign(process.env, {
    STANDUP_OWNER_TOKEN_FILE: TOKEN_FILE,
    SCRATCH_API_PORT: String(API_PORT),
    SCRATCH_WS_PORT: String(WS_PORT),
    SCRATCH_WEB_PORT: String(WEB_PORT),
  });
  const { createServer } = await import(join(WEB_DIR, "node_modules/vite/dist/node/index.js"));
  vite = await createServer({ configFile: join(import.meta.dir, "vite.scratch.config.ts"), logLevel: "warn", server: { hmr: false, watch: null } });
  await vite!.listen();

  const { chromium } = (await import(PLAYWRIGHT)) as typeof import("playwright");
  browser = await chromium.launch({ env: scratchEnv });
  const context = await browser.newContext({ viewport: VIEWPORT });
  await context.route("**/*", (route) => (new URL(route.request().url()).host === `localhost:${WEB_PORT}` ? route.continue() : route.abort()));
  const expiry = String(Math.floor(Date.now() / 1000) + 600);
  const code = `${expiry}.${createHmac("sha256", token).update(`login:${expiry}`).digest("hex")}`;
  const login = await context.newPage();
  await login.goto(`${ORIGIN}/__standup/login?code=${code}`);
  await login.close();
  const page: Page = await context.newPage();
  page.on("pageerror", (err) => console.log(`  PAGE ERROR: ${err.message}`));

  const settings = () => page.locator('[data-testid="pipeline-settings"]').first();
  const open = async (project: string) => {
    await page.goto(`${ORIGIN}/projects/p/${project}`);
    await settings().waitFor({ timeout: 30000 });
    await page.locator('[data-testid="pipeline-stage-summary"]').first().waitFor({ timeout: 30000 });
  };
  const typeSpec = async (spec: string) => {
    const box = settings().getByLabel("Pipeline spec");
    await box.fill(spec);
    await settings().locator('[data-testid="pipeline-spec-clauses"]').waitFor({ timeout: 10000 });
  };
  /** The pipeline settings in full: the panes holding them stop clipping, then the section is captured. */
  const capture = async (name: string) => {
    await settings().evaluate((el) => {
      for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
        n.style.overflow = "visible";
        n.style.height = "auto";
        n.style.maxHeight = "none";
      }
    });
    const path = join(SHOTS, name);
    await settings().screenshot({ path });
    shots.push(path);
    console.log(`  shot ${path}`);
  };
  const summaryIds = async () => page.locator("[data-summary-stage]").evaluateAll((els) => els.map((e) => e.getAttribute("data-summary-stage")));
  const uiCheck = (label: string, problems: string[]) => {
    samples.push({ request: `UI ${label}`, status: 0, response: {}, ok: problems.length === 0, ...(problems.length ? { problems } : {}) });
    console.log(`  ${problems.length ? "FAIL" : "PASS"} UI ${label}${problems.length ? ` (${problems.join("; ")})` : ""}`);
  };

  await open(PLAIN);
  const plainOption = await settings().getByLabel("Pipeline preset").locator('option[value=""]').textContent();
  await typeSpec("no code review, isolated live check, review packet");
  // Each typed clause maps, plus any it implies ("isolated live check" also turns deploy off).
  const known = (await settings().locator('[data-clause="known"]').allTextContents()).join("\n");
  const unknownTyped = await settings().locator('[data-clause="unknown"]').count();
  uiCheck(
    `${PLAIN} auto light + typed clauses mapped`,
    checks(
      [!!plainOption?.includes("auto: light"), `option ${plainOption}`],
      [["no code review", "isolated live check", "review packet"].every((c) => known.includes(c)), `known clauses ${JSON.stringify(known)}`],
      [unknownTyped === 0, `${unknownTyped} unknown clauses`]
    )
  );
  await capture("pipeline-settings-standup.png");

  await open(REVIEWED);
  const reviewedOption = await settings().getByLabel("Pipeline preset").locator('option[value=""]').textContent();
  const reviewedStages = await summaryIds();
  uiCheck(
    `${REVIEWED} auto full with ${CODE_REVIEW}/deploy/screenshot`,
    checks(
      [!!reviewedOption?.includes("auto: full"), `option ${reviewedOption}`],
      ...[CODE_REVIEW, "deploy", "screenshot"].map((id): [boolean, string] => [reviewedStages.includes(id), `no ${id} in summary`])
    )
  );
  await capture("pipeline-settings-reviewed.png");

  await open(PLAIN);
  await typeSpec("no code review, frobnicate the widgets");
  await settings().getByRole("button", { name: "Save pipeline" }).click();
  await settings().locator('[data-testid="pipeline-settings-unknown"]').waitFor({ timeout: 10000 });
  const unknownShown = await settings().locator('[data-clause="unknown"]').count();
  uiCheck(`${PLAIN} unknown clause highlighted and refused`, checks([unknownShown === 1, `${unknownShown} unknown clauses`]));
  await capture("pipeline-settings-unknown.png");
} catch (err) {
  fatal = err;
  console.error(`FATAL: ${err instanceof Error ? err.stack : String(err)}`);
} finally {
  const tmuxSessions = privateTmux("list-sessions", "-F", "#{session_name}").stdout.toString().split("\n").filter(Boolean);
  writeFileSync(
    join(OUT, "live-samples.json"),
    JSON.stringify(
      {
        run: RUN,
        isolation: {
          ports: { collector: API_PORT, ws: WS_PORT, console: WEB_PORT },
          home: scratchEnv.HOME,
          dbPath: scratchEnv.DB_PATH,
          tmux: `-L ${TMUX_NAME}`,
          tmuxSessions,
          pids,
        },
        samples,
        screenshots: shots,
        ...(fatal ? { fatal: String(fatal) } : {}),
      },
      null,
      2
    )
  );
  await cleanup();
}
const failed = samples.filter((s) => !s.ok).length;
console.log(`\n${samples.length - failed}/${samples.length} checks passed${fatal ? " (aborted)" : ""}; samples at ${join(OUT, "live-samples.json")}`);
process.exit(failed || fatal ? 1 : 0);
