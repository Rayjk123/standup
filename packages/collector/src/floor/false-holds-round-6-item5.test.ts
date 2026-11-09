import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * A module that only names the collector's port beside a loopback host, as
 * shared constants (topology.ts's DEFAULT_COLLECTOR_PORT and GATEWAY_HOST),
 * opens no connection: with nothing in it that can reach the network or run
 * a program, importing it, testing it or editing its notes is not a call to
 * the collector. Code that can send the address anywhere still holds.
 */

const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const COMMON = join("/", "fake", "repo", ".git");

const config: FloorConfig = {
  v: 1,
  collectorUrl: "http://127.0.0.1:17777",
  launchId: "launch-1",
  root: ROOT,
  sharedBranches: ["main", "mainline"],
  personalAwsAccounts: [],
  waitSeconds: 60,
  standupDataDir: DATA,
  floorPaths: [join(INSTALL, "packages", "collector", "src", "floor")],
  installDir: INSTALL,
  protectedPaths: [join(DATA, "secrets")],
  tmpDirs: ["/tmp"],
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
};

const PORT = String(7000 + 777);
const HEAD = [
  'import { readFileSync, writeFileSync } from "node:fs";',
  'import { homedir } from "node:os";',
  'import { dirname, join } from "node:path";',
  "",
  "/** Same value as constants.ts's DEFAULT_COLLECTOR_PORT (a test pins it). */",
  `const DEFAULT_COLLECTOR_PORT = ${PORT};`,
  '/** The loopback address the gateway binds; clients that resolve `localhost` reach it. */',
  'export const GATEWAY_HOST = "127.0.0.1";',
  "export function collectorPort(env: NodeJS.ProcessEnv = process.env): number {",
  "  return Number(env.COLLECTOR_PORT ?? DEFAULT_COLLECTOR_PORT);",
  "}",
  "export function publish(path: string, value: unknown): void {",
  "  const tmp = `${path}.${process.pid}.tmp`;",
  "  writeFileSync(tmp, JSON.stringify(value));",
  "}",
  "export const ROOT = join(homedir(), dirname(readFileSync.name));",
  "",
].join("\n");

const ADDR = '{ host: GATEWAY_HOST, port: DEFAULT_COLLECTOR_PORT, method: "POST", path: "/api/x" }';
const URL_TEXT = '"http://" + GATEWAY_HOST + ":" + DEFAULT_COLLECTOR_PORT + "/api/x"';

/** Module bodies that hand the address to a function or object their importer passes in. */
const PASSED: Record<string, string> = {
  "client-param.ts": `export function post(client: any) { return client.request(${ADDR}); }`,
  "fn-param.ts": `export function post(send: (o: object) => unknown) { return send(${ADDR}); }`,
  "member-param.ts": `export function post(deps: { http: any }) { return deps.http.request(${ADDR}); }`,
  "map-name.ts": `export function post(client: any) { return client.get(${URL_TEXT}); }`,
  "alias.ts": `export function post(client: any) { const c = client; return c.request(${ADDR}); }`,
  "destructured.ts": `export function post({ request }: any) { return request(${ADDR}); }`,
  "optional-call.ts": `export function post(send?: (o: object) => unknown) { return send?.(${ADDR}); }`,
  "callback.ts": `export function post(cb: (u: string) => void) { [${URL_TEXT}].forEach(cb); }`,
  "setter.ts": `export function post(target: any) { target.url = ${URL_TEXT}; }`,
  "tagged.ts": "export function post(tag: any) { return tag`http://${GATEWAY_HOST}:${DEFAULT_COLLECTOR_PORT}/api/x`; }",
  "interpolated.ts": "export function post(client: any) { return `${client.request(" + ADDR + ")}`; }",
  "unbound.ts": `export function post() { return request(${ADDR}); }`,
  "returned.ts": `export function post(make: () => any) { return make()(${ADDR}); }`,
};

/** Module bodies whose one computed member read JS_COMPUTED_MEMBER must match. */
const COMPUTED: Record<string, string> = {
  "destructure-key.ts": 'const k = "a"; export const { [k]: picked } = { a: 1 };',
  "destructure-key-later.ts": 'const k = "b"; export const { a, [k]: picked } = { a: 1, b: 2 };',
  "optional-index.ts": "const o: Record<string, number> = {}; export const v = o?.[GATEWAY_HOST];",
  "keyword-do.ts": 'const o = { do: { a: 1 } }; const k = "a"; export const v = o.do[k];',
  "keyword-in.ts": 'const o = { in: { a: 1 } }; const k = "a"; export const v = o.in[k];',
  "named-number.ts": "const number = 0; export const v = [1][number];",
  "named-keyof.ts": 'const keyof = "a"; export const v = { a: 1 }[keyof];',
};

const FILES: Record<string, string> = {
  [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
  [join(ROOT, "src", "topology.ts")]: HEAD,
  [join(ROOT, "src", "topology.test.ts")]: 'import { expect, test } from "bun:test";\nimport { collectorPort, GATEWAY_HOST } from "./topology.ts";\ntest("ports", () => { expect(collectorPort({})).toBe(' + PORT + '); expect(GATEWAY_HOST).toBe("127.0.0.1"); });\n',
  [join(ROOT, "src", "fetch-later.ts")]: `${HEAD}export function ping() { return fetch(\`http://\${GATEWAY_HOST}:\${DEFAULT_COLLECTOR_PORT}/api/x\`, { method: "POST", body: "{}" }); }\n`,
  [join(ROOT, "src", "fetch-now.ts")]: `${HEAD}fetch("http://" + GATEWAY_HOST + ":" + DEFAULT_COLLECTOR_PORT + "/api/x", { method: "POST", body: "{}" });\n`,
  [join(ROOT, "src", "ws.ts")]: `${HEAD}new WebSocket("ws://" + GATEWAY_HOST + ":" + DEFAULT_COLLECTOR_PORT);\n`,
  [join(ROOT, "src", "bun-connect.ts")]: `${HEAD}Bun.connect({ hostname: GATEWAY_HOST, port: DEFAULT_COLLECTOR_PORT, socket: { data() {} } });\n`,
  [join(ROOT, "src", "send.ts")]: "export function send(host: string, port: number) { return fetch(`http://${host}:${port}/api/x`, { method: \"POST\", body: \"{}\" }); }\n",
  [join(ROOT, "src", "relay.ts")]: `import { send } from "./send.ts";\n${HEAD}send(GATEWAY_HOST, DEFAULT_COLLECTOR_PORT);\n`,
  [join(ROOT, "src", "pkg.ts")]: `import axios from "axios";\n${HEAD}axios.post("http://" + GATEWAY_HOST + ":" + DEFAULT_COLLECTOR_PORT + "/api/x", {});\n`,
  [join(ROOT, "src", "ctor.ts")]: `${HEAD}""["con" + "structor"]["con" + "structor"]("return fe" + "tch")()("http://" + GATEWAY_HOST + ":" + DEFAULT_COLLECTOR_PORT + "/api/x", { method: "POST" });\n`,
  [join(ROOT, "src", "global.ts")]: `${HEAD}globalThis["fe" + "tch"]("http://" + GATEWAY_HOST + ":" + DEFAULT_COLLECTOR_PORT + "/api/x", { method: "POST" });\n`,
  [join(ROOT, "src", "binding.ts")]: `${HEAD}const t = process["bin" + "ding"]("tcp_wrap"); new t.TCP(0).connect({}, GATEWAY_HOST, DEFAULT_COLLECTOR_PORT);\n`,
  [join(ROOT, "src", "dyn.ts")]: `${HEAD}import("./se" + "nd.ts").then((m) => m.send(GATEWAY_HOST, DEFAULT_COLLECTOR_PORT));\n`,
  [join(ROOT, "src", "spawn.ts")]: `${HEAD}import { spawnSync } from "node:child_process";\nspawnSync("cu" + "rl", ["-X", "POST", GATEWAY_HOST + ":" + DEFAULT_COLLECTOR_PORT + "/api/x"]);\n`,
  [join(ROOT, "src", "descriptor.ts")]: `${HEAD}Object.getOwnPropertyDescriptor(Object.getPrototypeOf(() => 0), "constructor").value("return fe" + "tch")()("http://" + GATEWAY_HOST + ":" + DEFAULT_COLLECTOR_PORT + "/api/x", { method: "POST" });\n`,
  [join(ROOT, "src", "sloppy.js")]: `const DEFAULT_COLLECTOR_PORT = ${PORT};\nconst GATEWAY_HOST = "127.0.0.1";\nconst g = (function () { return this; })();\nfor (const f of [1]) g.fetch("http://" + GATEWAY_HOST + ":" + DEFAULT_COLLECTOR_PORT + "/api/x", { method: "POST" });\n`,
  [join(ROOT, "src", "meta.ts")]: `${HEAD}import.meta.require("node:child_process").execSync("curl -X POST " + GATEWAY_HOST + ":" + DEFAULT_COLLECTOR_PORT + "/api/x");\n`,
  [join(ROOT, "src", "alias-smuggle.js")]: `const DEFAULT_COLLECTOR_PORT = ${PORT};\nconst GATEWAY_HOST = "127.0.0.1";\nvar type;\ntype\n_ = ""["con" + "structor"]["con" + "structor"]("return fe" + "tch")()("http://" + GATEWAY_HOST + ":" + DEFAULT_COLLECTOR_PORT + "/api/x", { method: "POST" });\n`,
  [join(ROOT, "src", "keyed.ts")]: `${HEAD}const k = ["fe", "tch"].join(""); const o = { [k]: 1 }; (0, o)[k];\n`,
  [join(ROOT, "src", "http.ts")]: `import { request } from "node:http";\n${HEAD}request({ host: GATEWAY_HOST, port: DEFAULT_COLLECTOR_PORT, method: "POST", path: "/api/x" }).end("{}");\n`,
  // Entries that import topology.ts's host and port and send to a URL they build from them at run time.
  [join(ROOT, "src", "post-joined.ts")]: 'import { GATEWAY_HOST, collectorPort } from "./topology.ts";\nconst url = ["http:/", GATEWAY_HOST + ":" + collectorPort(), "api", "x"].join("/");\nfetch(url, { method: "POST", body: "{}" });\n',
  [join(ROOT, "src", "post-request.ts")]: 'import { request } from "node:http";\nimport { GATEWAY_HOST, collectorPort } from "./topology.ts";\nrequest({ host: GATEWAY_HOST, port: collectorPort(), method: "POST", path: "/api/x" }).end("{}");\n',
  [join(ROOT, "src", "post-spawn.ts")]: 'import { spawnSync } from "node:child_process";\nimport { GATEWAY_HOST, collectorPort } from "./topology.ts";\nconst url = [GATEWAY_HOST, collectorPort()].join(":");\nspawnSync("curl", ["-X", "POST", url]);\n',
  // Modules that import only fs/os/path but call what an importer hands them.
  ...Object.fromEntries(
    Object.entries(PASSED).map(([name, body]) => [join(ROOT, "src", name), `${HEAD}${body}\n`]),
  ),
  // Modules whose only reach is a computed member read the scan must see.
  ...Object.fromEntries(
    Object.entries(COMPUTED).map(([name, body]) => [join(ROOT, "src", name), `${HEAD}${body}\n`]),
  ),
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

function bash(command: string): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, probes());
}

function tool(toolName: string, toolInput: Record<string, unknown>): FloorVerdict {
  return classifyToolCall({ toolName, toolInput, cwd: ROOT }, config, probes());
}

function expectHeld(v: FloorVerdict, categories: string[]): void {
  expect(v.action).toBe("hold");
  expect(categories).toContain((v as { category: string }).category);
}

const NOTE = "/** Same value as constants.ts's DEFAULT_COLLECTOR_PORT (a test pins it). */";

describe("5. a module that only names the collector's port beside a loopback host", () => {
  test.each([
    `bun -e 'import { collectorPort } from "./src/topology.ts"; console.log(collectorPort())'`,
    `bun -e 'import { GATEWAY_HOST, collectorPort } from "./src/topology.ts"; console.log(GATEWAY_HOST, collectorPort({}))'`,
    `node --input-type=module -e 'import { collectorPort } from "./src/topology.ts"; console.log(collectorPort())'`,
    "bun test src/topology.test.ts",
    "bun src/topology.ts",
    "grep -n DEFAULT_COLLECTOR_PORT src/topology.ts",
  ])("allows %p", (command) => {
    expect(bash(command)).toEqual({ action: "allow" });
  });

  test.each<[string, Record<string, unknown>]>([
    ["Edit", { file_path: join(ROOT, "src", "topology.ts"), old_string: NOTE, new_string: "/** The collector's default port, 127.0.0.1:" + PORT + "; same as constants.ts's (a test pins it). */" }],
    ["Edit", { file_path: join(ROOT, "src", "topology.ts"), old_string: `const DEFAULT_COLLECTOR_PORT = ${PORT};`, new_string: `const DEFAULT_COLLECTOR_PORT = ${PORT}; // the public collector port` }],
    ["Write", { file_path: join(ROOT, "src", "topology.ts"), content: HEAD }],
    ["Read", { file_path: join(ROOT, "src", "topology.ts") }],
  ])("allows %s of the module", (name, input) => {
    expect(tool(name, input)).toEqual({ action: "allow" });
  });

  // Each of these can carry the address to the collector: a network call, a
  // runner, an import the floor follows or can't read, or a callee it computes.
  test.each([
    "fetch-now.ts",
    "ws.ts",
    "bun-connect.ts",
    "relay.ts",
    "pkg.ts",
    "ctor.ts",
    "global.ts",
    "binding.ts",
    "dyn.ts",
    "spawn.ts",
    "http.ts",
    "descriptor.ts",
    "meta.ts",
  ])("still holds importing %p", (file) => {
    expect(bash(`bun -e 'import * as m from "./src/${file}"; console.log(m.GATEWAY_HOST)'`).action).toBe("hold");
  });

  test("still holds calling an imported function that sends to the address", () => {
    expect(bash(`bun -e 'import { ping } from "./src/fetch-later.ts"; await ping()'`).action).toBe("hold");
  });

  test.each(["fetch-now.ts", "ws.ts", "bun-connect.ts", "relay.ts", "http.ts", "spawn.ts", "global.ts", "ctor.ts", "descriptor.ts", "sloppy.js", "meta.ts", "alias-smuggle.js", "keyed.ts"])(
    "still holds running %p",
    (file) => {
      expect(bash(`bun src/${file}`).action).toBe("hold");
    },
  );

  // The importer's own code is read for what it does with the values it imports.
  test.each([
    `bun -e 'import { GATEWAY_HOST } from "./src/topology.ts"; fetch("http://" + GATEWAY_HOST + ":${PORT}/api/x", { method: "POST", body: "{}" })'`,
    `bun -e 'import { GATEWAY_HOST, collectorPort } from "./src/topology.ts"; fetch(\`http://\${GATEWAY_HOST}:\${collectorPort()}/api/x\`, { method: "POST", body: "{}" })'`,
    `bun -e 'import { GATEWAY_HOST, collectorPort } from "./src/topology.ts"; Bun.connect({ hostname: GATEWAY_HOST, port: collectorPort(), socket: { data() {} } })'`,
    `bun -e 'import { GATEWAY_HOST, collectorPort } from "./src/topology.ts"; require("net").connect(collectorPort(), GATEWAY_HOST).end("POST /api/x")'`,
    `bun -e 'import { GATEWAY_HOST as hostname, collectorPort } from "./src/topology.ts"; const port = collectorPort(); Bun.connect({ hostname, port, socket: { data() {} } })'`,
    `bun -e 'import { GATEWAY_HOST, collectorPort } from "./src/topology.ts"; new WebSocket(\`ws://\${GATEWAY_HOST}:\${collectorPort()}\`).onopen = (e) => e.target.send("x")'`,
  ])("still holds %p, which sends to the imported address", (command) => {
    expect(bash(command).action).toBe("hold");
  });

  // Read from a file, the importer's request to a URL built at run time names no address: the module's host and port
  // hold, as an imported module's finding (Persona's).
  test.each(["post-joined.ts", "post-request.ts"])("still holds running %p, which sends to a URL built from the imported address", (file) => {
    const v = bash(`bun src/${file}`);
    expect(v).toMatchObject({ action: "hold", category: "unclassified" });
    expect(v.action === "hold" ? v.reason : "").toContain(`code in ${join(ROOT, "src", "topology.ts")} opens a connection on Standup's collector port`);
  });

  test("still names the imported address beside a program run on a URL built from it", () => {
    const v = bash("bun src/post-spawn.ts");
    expect(v.action).toBe("hold");
    expect(v.action === "hold" ? v.reason : "").toContain(`code in ${join(ROOT, "src", "topology.ts")} opens a connection on Standup's collector port`);
  });

  test("a raw connection to another loopback port written out is still allowed", () => {
    expect(bash(`bun -e 'Bun.connect({ hostname: "127.0.0.1", port: 5432, socket: { data() {} } })'`)).toEqual({ action: "allow" });
  });

  test("code that writes to the collector API still holds as collector-api", () => {
    expectHeld(bash(`curl -X POST localhost:${PORT}/api/x -d '{}'`), ["collector-api"]);
    expectHeld(bash(`curl -X POST http://127.0.0.1:${PORT}/api/x -d '{}'`), ["collector-api"]);
    expectHeld(bash(`bun -e 'fetch("http://127.0.0.1:${PORT}/api/x", { method: "POST", body: "{}" })'`), ["collector-api"]);
    expectHeld(bash(`bun -e 'const h = "127.0.0.1", p = ${PORT}; fetch("http://" + h + ":" + p + "/api/x", { method: "POST" })'`), ["collector-api"]);
    expectHeld(bash(`node -e 'require("net").connect(${PORT}, "127.0.0.1").end("POST /api/x HTTP/1.1\\r\\n\\r\\n")'`), ["collector-api"]);
    expectHeld(bash("bun src/fetch-now.ts"), ["collector-api"]);
  });

  test("an inline program that only names the address still holds: it is the code that runs", () => {
    expect(bash(`bun -e 'const h = "127.0.0.1", p = ${PORT}; console.log(h, p)'`).action).toBe("hold");
  });

  // The importer hands the module a network client; the module's own call on it opens the connection.
  test.each(Object.keys(PASSED))("still holds an importer passing node:http to %p", (file) => {
    expect(bash(`bun -e 'import * as http from "node:http"; import { post } from "./src/${file}"; post(http)'`).action).toBe("hold");
  });

  test.each(Object.keys(COMPUTED))("still holds importing %p, which reads a member by a computed name", (file) => {
    expect(bash(`bun -e 'import * as m from "./src/${file}"; console.log(m.GATEWAY_HOST)'`).action).toBe("hold");
  });
});

describe("the repository's own topology module", () => {
  const REPO = resolve(import.meta.dir, "..", "..", "..", "..");
  const TOPOLOGY = join(REPO, "packages", "shared", "src", "topology.ts");
  const real: FloorConfig = { ...config, root: REPO, floorPaths: [join(DATA, "floor")], installDir: join(DATA, "install") };
  const run = (toolName: string, toolInput: Record<string, unknown>) =>
    classifyToolCall({ toolName, toolInput, cwd: REPO }, real, { gitBranch: () => "standup/feat-1", homeDir: () => HOME });

  test.each([
    `bun -e 'import { publicPorts } from "./packages/shared/src/topology.ts"; console.log(publicPorts())'`,
    `bun -e 'import { collectorPortSet } from "./packages/shared/src/topology.ts"; console.log([...collectorPortSet()])'`,
    "bun test packages/shared/src/topology.test.ts",
  ])("allows %p", (command) => {
    expect(run("Bash", { command })).toEqual({ action: "allow" });
  });

  test("editing its collector-port note is allowed", () => {
    const text = readFileSync(TOPOLOGY, "utf8");
    const note = text.split("\n").find((l) => l.includes("DEFAULT_COLLECTOR_PORT /"))!;
    expect(run("Edit", { file_path: TOPOLOGY, old_string: note, new_string: note.replace("Same values", "The same values") })).toEqual({ action: "allow" });
  });
});
