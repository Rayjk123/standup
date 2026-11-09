import { describe, expect, test } from "bun:test";
import { classifyToolCall, type FloorProbes } from "./classify.js";
import type { FloorCategory, FloorConfig, FloorVerdict } from "./gate.js";

/*
 * A browser probe that only loads pages off the loopback, and aborts every
 * request that isn't a GET, reaches nothing past this host: the floor runs it
 * whether the script sits in the worktree, in scratch, or inline in `node -e`.
 * A browser script that sends a POST to a remote host stays held as outward.
 */

const HOME = "/home/alice";
const DATA = `${HOME}/.local/share/standup`;
const ROOT = `${DATA}/worktrees/standup/feat-1`;
const INSTALL = "/opt/standup";
const FLOOR = `${INSTALL}/packages/collector/src/floor`;
const SCRATCH = "/tmp/tmp.probe1";

const config: FloorConfig = {
  v: 1,
  collectorUrl: "http://localhost:7777",
  launchId: "launch-1",
  root: ROOT,
  sharedBranches: ["main", "mainline"],
  personalAwsAccounts: ["111122223333"],
  nonProdAwsAccounts: ["444455556666"],
  ownerHosts: ["devbox-alice-*"],
  worktreeRoots: [`${DATA}/worktrees`],
  waitSeconds: 60,
  standupDataDir: DATA,
  floorPaths: [FLOOR],
  installDir: INSTALL,
  protectedPaths: [`${DATA}/secrets`],
  tmpDirs: ["/tmp"],
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
  readOnlyMcpTools: [],
};

const probeScript = (url: string, out: string) =>
  [
    `import { chromium } from "playwright";`,
    `const browser = await chromium.launch();`,
    `const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });`,
    `await page.route("**/*", (r) => (r.request().method() !== "GET" ? r.abort() : r.continue()));`,
    `await page.goto("${url}", { waitUntil: "networkidle" });`,
    `await page.screenshot({ path: "${out}", fullPage: true });`,
    `console.log(await page.title());`,
    `await browser.close();`,
    ``,
  ].join("\n");

const postScript = (url: string) =>
  [
    `import { chromium } from "playwright";`,
    `const browser = await chromium.launch();`,
    `const page = await browser.newPage();`,
    `await page.goto("http://127.0.0.1:5199/");`,
    `await page.request.post("${url}", { data: { a: 1 } });`,
    `await browser.close();`,
    ``,
  ].join("\n");

const fetchPostScript = (url: string) =>
  [
    `import { chromium } from "playwright";`,
    `const browser = await chromium.launch();`,
    `const page = await browser.newPage();`,
    `await page.goto("http://localhost:5199/");`,
    `await page.evaluate(() => fetch("${url}", { method: "POST", body: "x" }));`,
    `await browser.close();`,
    ``,
  ].join("\n");

/** A probe whose address comes off the env with a fallback, then reads the page's own API from inside it. */
const envProbe = (decls: string, url: string, request = `page.evaluate(() => fetch("/api/health").then((r) => r.status))`) =>
  [
    `import { chromium } from "playwright";`,
    decls,
    `const browser = await chromium.launch();`,
    `const page = await browser.newPage();`,
    `await page.route("**/*", (r) => (r.request().method() !== "GET" ? r.abort() : r.continue()));`,
    `await page.goto(${url}, { waitUntil: "networkidle" });`,
    `console.log(await ${request});`,
    `await page.screenshot({ path: "${SCRATCH}/env.png" });`,
    `await browser.close();`,
    ``,
  ].join("\n");
const HOST_PORT = `const HOST = process.env.HOST || "127.0.0.1";\nconst PORT = process.env.PORT ?? "5199";`;
const ENVDIR = "/tmp/tmp.envdir";
const HOST_DECL = `const HOST = process.env.HOST || "127.0.0.1";`;
const HOST_READ = "const r = await fetch(`http://${HOST}:5199/api/items`);\nconsole.log(r.status);\n";

const FILES: Record<string, string> = {
  [`${SCRATCH}/env-host.mjs`]: envProbe(HOST_PORT, "`http://${HOST}:${PORT}/`"),
  [`${ROOT}/env-host.ts`]: envProbe(`const HOST = process.env.PROBE_HOST ?? "localhost";\nconst PORT = Number(process.env.PORT ?? 5199);`, "`http://${HOST}:${PORT}/sessions`"),
  [`${SCRATCH}/env-remote.mjs`]: envProbe(`const HOST = process.env.HOST || "example.com";\nconst PORT = process.env.PORT ?? "443";`, "`https://${HOST}:${PORT}/`"),
  [`${SCRATCH}/env-remote-base.mjs`]: envProbe(`const BASE = process.env.BASE_URL ?? "https://example.com";`, "`${BASE}/`", "fetch(`${BASE}/api/items`).then((r) => r.status)"),
  [`${SCRATCH}/env-post.mjs`]: envProbe(HOST_PORT, "`http://${HOST}:${PORT}/`", `fetch(\`http://\${HOST}:\${PORT}/api/items\`, { method: "POST", body: "{}" }).then((r) => r.status)`),
  [`${SCRATCH}/literal-remote.mjs`]: envProbe(HOST_PORT, "`http://${HOST}:${PORT}/`", `fetch("https://example.com/api/items").then((r) => r.status)`),
  [`${SCRATCH}/env-read.mjs`]: `${HOST_DECL}\n${HOST_READ}`,
  [`${SCRATCH}/env-mutate.mjs`]: `process.env.HOST = "example.com";\n${HOST_DECL}\n${HOST_READ}`,
  [`${SCRATCH}/env-mutate-write.mjs`]: `process.env.HOST = "example.com";\n${HOST_DECL}\nawait fetch(\`http://\${HOST}:5199/api/items\`, JSON.parse('{"method":"POST","body":"secret"}'));\n`,
  [`${SCRATCH}/env-shadow.mjs`]: `const process = { env: { HOST: "example.com" } };\n${HOST_DECL}\n${HOST_READ}`,
  [`${SCRATCH}/env-param.mjs`]: `${HOST_DECL}\nconst get = (HOST) => fetch(\`http://\${HOST}:5199/api/items\`);\nawait get("example.com");\n`,
  [`${SCRATCH}/env-destructure.mjs`]: `${HOST_DECL}\nfunction go() {\nconst { HOST } = { HOST: "example.com" };\nreturn fetch(\`http://\${HOST}:5199/api/items\`);\n}\nawait go();\n`,
  [`${SCRATCH}/.envfile`]: "HOST=example.com\n",
  [`${ENVDIR}/env-read.mjs`]: `${HOST_DECL}\n${HOST_READ}`,
  [`${ENVDIR}/.env`]: "HOST=example.com\n",
  [`${ROOT}/.git`]: "gitdir: /srv/standup/.git/worktrees/feat-1\n",
  [`${ROOT}/package.json`]: '{"name":"x","type":"module"}\n',
  [`${ROOT}/probe.mjs`]: probeScript("http://127.0.0.1:5199/", `${SCRATCH}/shot.png`),
  [`${ROOT}/probe.ts`]: probeScript("http://localhost:5199/sessions", `${SCRATCH}/sessions.png`),
  [`${SCRATCH}/probe.mjs`]: probeScript("http://127.0.0.1:5199/", `${SCRATCH}/shot.png`),
  [`${SCRATCH}/probe.ts`]: probeScript("http://localhost:5199/review", `${SCRATCH}/review.png`),
  [`${SCRATCH}/post.mjs`]: postScript("https://example.com/api/items"),
  [`${SCRATCH}/post-internal.mjs`]: postScript("https://tickets.corp.example.internal/api/create"),
  [`${ROOT}/post.ts`]: postScript("https://example.com/api/items"),
  [`${SCRATCH}/fetch-post.mjs`]: fetchPostScript("https://example.com/api/items"),
};
const DIRS = new Set<string>([ROOT, SCRATCH, ENVDIR, "/tmp", "/"]);
for (const f of [...Object.keys(FILES), ...DIRS]) {
  for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) DIRS.add(d);
}

function probes(): Partial<FloorProbes> {
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    readFile: (p) => (p in FILES ? { ok: true, text: FILES[p]! } : { ok: false, reason: "missing" }),
    exists: (p) => p in FILES || DIRS.has(p),
    isDirectory: (p) => DIRS.has(p),
    executable: (p) => (p in FILES ? true : null),
    listDir: () => [],
    realpath: (p) => (p in FILES || DIRS.has(p) ? p : null),
    homeDir: () => HOME,
    shellDefinitions: () => ({ aliases: new Map(), functions: new Map() }),
    awsAccount: () => null,
    env: (name) => (name === "TMPDIR" ? SCRATCH : undefined),
    now: () => Date.now(),
  };
}

interface Row {
  command: string;
  cwd?: string;
  /** "held": any verdict but allow. */
  expect: "allow" | "held" | { category: FloorCategory };
}

function run(row: Row): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command: row.command }, cwd: row.cwd ?? ROOT }, config, probes());
}

function check(row: Row): void {
  const v = run(row);
  const label = row.command;
  const got = v.action === "allow" ? "allow" : { category: v.category, reason: v.reason };
  if (row.expect === "allow") expect({ label, got }).toEqual({ label, got: "allow" });
  else if (row.expect === "held") expect({ label, held: v.action !== "allow" }).toEqual({ label, held: true });
  else expect({ label, category: v.action === "hold" ? v.category : "allow" }).toEqual({ label, category: row.expect.category });
}

const inline = (url: string) =>
  `node -e 'const { chromium } = require("playwright"); (async () => { const b = await chromium.launch(); const p = await b.newPage(); await p.route("**/*", (r) => (r.request().method() !== "GET" ? r.abort() : r.continue())); await p.goto("${url}"); await p.screenshot({ path: "${SCRATCH}/inline.png" }); await b.close(); })()'`;

/** Inline code that loads the page its argv names and reads the page's own API from inside it. */
const argvProbe = (program: "node" | "bun", argv: string) =>
  `${program} ${program === "node" ? "--input-type=module " : ""}-e '${[
    `import { chromium } from "playwright";`,
    `const url = process.argv.find((a) => /^https?:/.test(a));`,
    `const browser = await chromium.launch();`,
    `const page = await browser.newPage();`,
    `await page.route("**/*", (r) => (r.request().method() !== "GET" ? r.abort() : r.continue()));`,
    `await page.goto(url, { waitUntil: "networkidle" });`,
    `const health = await page.evaluate(() => fetch("/api/health").then((r) => r.status));`,
    `await page.screenshot({ path: "${SCRATCH}/argv.png" });`,
    `console.log(health);`,
    `await browser.close();`,
  ].join(" ")}' ${argv}`;

/** Browser probes that only reach the loopback. */
const ALLOWED: Row[] = [
  { command: "node probe.mjs", expect: "allow" },
  { command: `node ${ROOT}/probe.mjs`, expect: "allow" },
  { command: "bun probe.ts", expect: "allow" },
  { command: `node ${SCRATCH}/probe.mjs`, expect: "allow" },
  { command: "node $TMPDIR/probe.mjs", expect: "allow" },
  { command: `bun ${SCRATCH}/probe.ts`, expect: "allow" },
  { command: `cd ${SCRATCH} && node probe.mjs`, expect: "allow" },
  { command: inline("http://127.0.0.1:5199/"), expect: "allow" },
  { command: inline("http://localhost:5199/sessions"), expect: "allow" },
  { command: argvProbe("node", "http://127.0.0.1:5199/"), expect: "allow" },
  { command: argvProbe("node", "http://localhost:5199/sessions --full"), expect: "allow" },
  { command: argvProbe("node", "http://[::1]:5199/"), expect: "allow" },
  { command: argvProbe("bun", "http://127.0.0.1:5199/review"), expect: "allow" },
];

/** Browser scripts that send a non-GET request to a host past the loopback. */
const HELD: Row[] = [
  // A host off the env with a loopback fallback: what the env holds when the code reads it isn't read from the run.
  { command: `node ${SCRATCH}/env-host.mjs`, expect: "held" },
  { command: `HOST=127.0.0.1 PORT=5200 node ${SCRATCH}/env-host.mjs`, expect: "held" },
  { command: "bun env-host.ts", expect: "held" },
  { command: `node ${SCRATCH}/env-read.mjs`, expect: "held" },
  { command: `node ${SCRATCH}/post.mjs`, expect: { category: "outward" } },
  { command: `node ${SCRATCH}/post-internal.mjs`, expect: { category: "outward" } },
  { command: "bun post.ts", expect: { category: "outward" } },
  { command: `node ${SCRATCH}/fetch-post.mjs`, expect: { category: "outward" } },
  {
    command: `node -e 'const { chromium } = require("playwright"); (async () => { const b = await chromium.launch(); const p = await b.newPage(); await p.goto("http://127.0.0.1:5199/"); await p.request.post("https://example.com/api/items", { data: { a: 1 } }); await b.close(); })()'`,
    expect: { category: "outward" },
  },
  // Inline code whose request URL comes from its argv: held unless every URL there is on the loopback.
  { command: argvProbe("node", "https://example.com/"), expect: { category: "outward" } },
  { command: argvProbe("bun", "https://example.com/"), expect: { category: "outward" } },
  { command: argvProbe("node", "http://127.0.0.1:5199/ https://example.com/"), expect: { category: "outward" } },
  { command: argvProbe("node", "http://127.0.0.1@example.com/"), expect: { category: "outward" } },
  { command: argvProbe("node", "--url=https://example.com/ http://127.0.0.1:5199/"), expect: { category: "outward" } },
  { command: argvProbe("node", '"$(cat url.txt)"'), expect: { category: "outward" } },
  { command: argvProbe("node", ""), expect: { category: "outward" } },
  // An env fallback off the loopback, a run that sets the var off it, a write, or a literal remote URL beside the loopback page.
  { command: `node ${SCRATCH}/env-remote.mjs`, expect: { category: "outward" } },
  { command: `node ${SCRATCH}/env-remote-base.mjs`, expect: { category: "outward" } },
  { command: `HOST=example.com node ${SCRATCH}/env-host.mjs`, expect: { category: "outward" } },
  { command: `node ${SCRATCH}/env-post.mjs`, expect: { category: "outward" } },
  { command: `node ${SCRATCH}/literal-remote.mjs`, expect: { category: "outward" } },
  // A run that may load the var from an env file: bun's `.env` in the cwd, `--env-file`, NODE_OPTIONS, or `set -a` over a sourced file.
  { command: `cd ${ENVDIR} && bun env-read.mjs`, cwd: ENVDIR, expect: "held" },
  { command: `node --env-file=${SCRATCH}/.envfile ${SCRATCH}/env-read.mjs`, expect: "held" },
  { command: `NODE_OPTIONS=--env-file=${SCRATCH}/.envfile node ${SCRATCH}/env-read.mjs`, expect: "held" },
  { command: `bun --env-file=${SCRATCH}/.envfile ${SCRATCH}/env-read.mjs`, expect: "held" },
  { command: `set -a; . ${SCRATCH}/.envfile; node ${SCRATCH}/env-read.mjs`, expect: "held" },
  // Code that changes the env before it reads it, or loads dotenv.
  { command: `node ${SCRATCH}/env-mutate.mjs`, expect: "held" },
  { command: `node ${SCRATCH}/env-mutate-write.mjs`, expect: "held" },
  { command: "node --input-type=module -e 'process.env.HOST = \"example.com\"; const HOST = process.env.HOST || \"127.0.0.1\"; await fetch(`http://${HOST}:5199/api`);'", expect: "held" },
  { command: "node --input-type=module -e 'import \"dotenv/config\"; const HOST = process.env.HOST || \"127.0.0.1\"; await fetch(`http://${HOST}:5199/api`);'", expect: "held" },
  // A `process` of the code's own, or another binding of the constant's name where the template reads it.
  { command: `node ${SCRATCH}/env-shadow.mjs`, expect: "held" },
  { command: `node ${SCRATCH}/env-param.mjs`, expect: "held" },
  { command: `node ${SCRATCH}/env-destructure.mjs`, expect: "held" },
  // Inline code that reads its argv but takes its URL from elsewhere: decoded, from the env or a file.
  { command: `node -e 'process.argv; fetch(atob("${Buffer.from("https://example.com/").toString("base64")}"))' http://127.0.0.1:5199/`, expect: "held" },
  { command: `U=https://example.com/ node -e 'process.argv; fetch(process.env.U)' http://127.0.0.1:5199/`, expect: "held" },
  { command: `node -e 'process.argv; fetch(require("fs").readFileSync("/tmp/u", "utf8"))' http://127.0.0.1:5199/`, expect: "held" },
  // An argv word a URL parser reads as a remote URL though it isn't spelled `scheme://host`, or one resolved against a loopback base.
  { command: `node -e 'fetch(process.argv.find((a) => a.startsWith("https:")))' https:example.com http://127.0.0.1:5199/`, expect: "held" },
  { command: `node -e 'fetch(process.argv[1])' https:/example.com/x http://127.0.0.1:5199/`, expect: "held" },
  { command: `node -e 'fetch(process.argv[1])' 'https:\\\\example.com\\x' http://127.0.0.1:5199/`, expect: "held" },
  { command: `node -e 'const [, a, b] = process.argv; fetch(new URL(b, a))' http://127.0.0.1:5199/ //example.com/x`, expect: "held" },
  { command: `bun -e 'fetch(Bun.argv.at(-1))' -- http://127.0.0.1:5199/ https:example.com`, expect: "held" },
  // A request init from the argv, which may set a write's method and body.
  { command: `node -e 'fetch(process.argv[1], JSON.parse(process.argv[2]))' https:example.com '{"method":"POST","body":"x"}' http://127.0.0.1:5199/`, expect: "held" },
  { command: `node -e 'const [, u, i] = process.argv; fetch(u, i)' http://127.0.0.1:5199/ x`, expect: "held" },
  // A loopback URL from the argv pointed at another host once parsed.
  { command: `node -e 'const u = new URL(process.argv[1]); u.host = process.argv[2]; fetch(u)' http://127.0.0.1:5199/ example.com`, expect: "held" },
  { command: `node -e 'fetch(Object.assign(new URL(process.argv[1]), {host: process.argv[2]}))' http://127.0.0.1:5199/ example.com`, expect: "held" },
  { command: `bun -e 'const u = new URL(Bun.argv[1]); u.hostname = Bun.argv[2]; await fetch(u)' http://127.0.0.1:5199/ example.com`, expect: "held" },
  // A URL from the env, a command or a file, however spelled.
  { command: `U=https://example.com/ node -e 'process.argv; const { env } = process; fetch(env.U)' http://127.0.0.1:5199/`, expect: "held" },
  { command: `U=https://example.com/ node -e 'process.argv; fetch(process["env"].U)' http://127.0.0.1:5199/`, expect: "held" },
  { command: `node -e 'process.argv; fetch(require("child_process").execSync("cat /tmp/u").toString())' http://127.0.0.1:5199/`, expect: "held" },
  // A literal a URL parser reads as a remote URL once it drops a tab or a leading control character.
  { command: `node -e 'process.argv; fetch("htt${String.fromCharCode(9)}ps://example.com/x")' http://127.0.0.1:5199/`, expect: "held" },
  { command: `node -e 'process.argv; fetch("${String.fromCharCode(31)}https://example.com/x")' http://127.0.0.1:5199/`, expect: "held" },
  // A request callee handed on as a value.
  { command: `node -e 'fetch(process.argv[1]); const f = fetch; f(atob("aHR0cHM6Ly9leGFtcGxlLmNvbS8="))' http://127.0.0.1:5199/`, expect: "held" },
  { command: `node -e 'fetch(process.argv[1]); fetch?.(process.argv[2])' http://127.0.0.1:5199/`, expect: "held" },
  // Words a wrapper adds to the argv.
  { command: `find https:example.com -maxdepth 0 -exec node -e 'fetch(process.argv.at(-1))' http://127.0.0.1:5199/ {} +`, expect: "held" },
];

describe("a browser probe on the loopback runs", () => {
  for (const row of ALLOWED) test(row.command, () => check(row));
});

describe("a browser script that posts past the loopback stays held", () => {
  for (const row of HELD) test(row.command, () => check(row));
});

describe("inline code with deeply nested request calls", () => {
  test("is read in time", () => {
    const started = Date.now();
    check({ command: `node -e 'process.argv; fetch(${"get(".repeat(16000)}process.argv[1]${")".repeat(16001)}' http://127.0.0.1:5199/`, expect: "held" });
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
