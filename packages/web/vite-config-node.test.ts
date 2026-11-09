import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { consoleAllowedHosts } from "@standup/shared/console-url";
import { publicPorts, vitePortFor } from "@standup/shared/topology";

/*
 * The dev server loads vite.config.ts under Node, not Bun: vite bundles the
 * config's own relative imports, but leaves packages (the workspace's
 * `@standup/shared` included) for Node to import itself. Node strips types but
 * doesn't map a `./x.js` specifier to `x.ts`, so any shared module the config
 * reaches that value-imports a sibling that way stops the console from starting.
 * Bun resolves those specifiers, which is why the rest of the suite can't see it.
 */

const WEB_DIR = import.meta.dir;
const SHARED_DIR = resolve(WEB_DIR, "..", "shared");
const sharedExports = JSON.parse(readFileSync(join(SHARED_DIR, "package.json"), "utf8")).exports as Record<string, string>;

/** The value imports and re-exports in `source` (type-only ones are erased and never load). */
function valueSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const pattern = /^\s*(import|export)\s+(type\s+)?(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm;
  for (const m of source.matchAll(pattern)) {
    if (m[2]) continue;
    specs.push(m[3]);
  }
  return specs;
}

/** The file a `@standup/shared[/sub]` specifier resolves to through the package's exports. */
function sharedEntry(spec: string): string | undefined {
  const sub = spec === "@standup/shared" ? "." : `.${spec.slice("@standup/shared".length)}`;
  const target = sharedExports[sub];
  return target ? join(SHARED_DIR, target) : undefined;
}

/**
 * Every problem Node would hit loading the config: walks the config's bundled
 * relative imports, then each shared module Node itself loads and its relative
 * imports, reporting specifiers Node can't resolve.
 */
function nodeLoadProblems(entry: string): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const visit = (file: string, loadedByNode: boolean) => {
    const key = `${file}:${loadedByNode}`;
    if (seen.has(key)) return;
    seen.add(key);
    for (const spec of valueSpecifiers(readFileSync(file, "utf8"))) {
      if (spec.startsWith("@standup/shared")) {
        const target = sharedEntry(spec);
        if (!target) problems.push(`${file}: "${spec}" is not an export of @standup/shared`);
        else visit(target, true);
        continue;
      }
      if (!spec.startsWith(".")) continue;
      const base = resolve(dirname(file), spec);
      if (loadedByNode) {
        if (existsSync(base)) visit(base, true);
        else problems.push(`${file}: Node can't resolve "${spec}" (it doesn't map .js to .ts)`);
        continue;
      }
      const bundled = [base, `${base}.ts`, base.replace(/\.js$/, ".ts")].find((p) => existsSync(p) && p.endsWith(".ts"));
      if (bundled) visit(bundled, false);
    }
  };
  visit(entry, false);
  return problems;
}

describe("the dev server's config under Node", () => {
  test("every shared module it reaches is loadable by Node", () => {
    expect(nodeLoadProblems(join(WEB_DIR, "vite.config.ts"))).toEqual([]);
  });

  test("the walk flags a shared module that value-imports a sibling as ./x.js", () => {
    // The shared root does exactly that, so a config importing it must be flagged.
    const problems: string[] = [];
    for (const spec of valueSpecifiers(readFileSync(join(SHARED_DIR, "src", "index.ts"), "utf8"))) {
      if (spec.startsWith(".") && !existsSync(resolve(SHARED_DIR, "src", spec))) problems.push(spec);
    }
    expect(problems.length).toBeGreaterThan(0);
  });

  test.skipIf(!Bun.which("node"))("vite loads the config with Node", () => {
    const script = [
      'const { loadConfigFromFile } = await import("vite");',
      'const loaded = await loadConfigFromFile({ command: "serve", mode: "development" }, undefined, process.cwd(), "silent");',
      'console.log(loaded ? "CONFIG_LOADED" : "CONFIG_MISSING");',
    ].join("\n");
    const run = Bun.spawnSync(["node", "--input-type=module", "-e", script], {
      cwd: WEB_DIR,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = `${run.stdout.toString()}${run.stderr.toString()}`;
    expect({ exitCode: run.exitCode, loaded: output.includes("CONFIG_LOADED"), output: run.exitCode === 0 ? "" : output }).toEqual({
      exitCode: 0,
      loaded: true,
      output: "",
    });
  }, 60_000);
});

/** The dev-server settings the config resolves to when vite loads it under Node. */
interface LoadedServer {
  port: number;
  strictPort: boolean;
  host: string | null;
  api: string;
  ws: string;
  allowedHosts: string[] | boolean | null;
  previewAllowedHosts: string[] | boolean | null;
  webUrl: string | null;
}

const SERVER_LOADER = [
  'const { loadConfigFromFile } = await import("vite");',
  'const loaded = await loadConfigFromFile({ command: "serve", mode: "development" }, undefined, process.cwd(), "silent");',
  "const server = loaded.config.server;",
  "console.log(JSON.stringify({",
  "  port: server.port,",
  "  strictPort: server.strictPort ?? false,",
  "  host: server.host ?? null,",
  '  api: server.proxy["/api"].target,',
  '  ws: server.proxy["/ws"].target,',
  "  allowedHosts: server.allowedHosts ?? null,",
  "  previewAllowedHosts: loaded.config.preview?.allowedHosts ?? null,",
  "  webUrl: loaded.config.define?.__STANDUP_WEB_URL__ ?? null,",
  "}));",
].join("\n");

/** Loads the config under Node with only `env` (plus PATH and a scratch HOME) set. */
function loadServerUnderNode(env: Record<string, string>): LoadedServer {
  const home = mkdtempSync(join(tmpdir(), "standup-vite-config-"));
  try {
    const run = Bun.spawnSync(["node", "--input-type=module", "-e", SERVER_LOADER], {
      cwd: WEB_DIR,
      env: { PATH: process.env.PATH ?? "", HOME: home, DB_PATH: join(home, "data", "standup.db"), ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (run.exitCode !== 0) {
      throw new Error(`node failed to load vite.config.ts (exit ${run.exitCode}):\n${run.stderr.toString()}`);
    }
    const line = run.stdout.toString().trim().split("\n").at(-1) ?? "";
    return JSON.parse(line) as LoadedServer;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe.skipIf(!Bun.which("node"))("the dev server's ports and proxy targets under Node", () => {
  test("classic mode serves the public web port and proxies to the public collector and ws ports", () => {
    const server = loadServerUnderNode({ STANDUP_WEB_PORT: "41010", COLLECTOR_PORT: "41011", WS_PORT: "41012" });
    expect(server.port).toBe(41010);
    expect(server.strictPort).toBe(false);
    expect(server.api).toBe("http://127.0.0.1:41011");
    expect(server.ws).toBe("ws://127.0.0.1:41012");
  }, 90_000);

  test("without port env vars it uses the shared topology's default public ports", () => {
    const server = loadServerUnderNode({});
    const defaults = publicPorts({});
    expect(server.port).toBe(defaults.web);
    expect(server.api).toBe(`http://127.0.0.1:${defaults.collector}`);
    expect(server.ws).toBe(`ws://127.0.0.1:${defaults.ws}`);
  }, 90_000);

  test("behind the gateway it binds the strict vite port on the gateway host", () => {
    const server = loadServerUnderNode({
      STANDUP_WEB_PORT: "41010",
      STANDUP_VITE_PORT: "41013",
      COLLECTOR_PORT: "41011",
      WS_PORT: "41012",
    });
    expect(server.port).toBe(41013);
    expect(server.strictPort).toBe(true);
    expect(server.host).toBe("127.0.0.1");
    expect(server.api).toBe("http://127.0.0.1:41011");
  }, 90_000);

  test("behind the gateway with an unusable STANDUP_VITE_PORT it derives the port like dev.ts", () => {
    const server = loadServerUnderNode({ STANDUP_WEB_PORT: "41010", STANDUP_VITE_PORT: "nope", COLLECTOR_PORT: "41011", WS_PORT: "41012" });
    expect(server.port).toBe(vitePortFor(41010));
    expect(server.port).toBe(51010);
    expect(server.strictPort).toBe(true);
  }, 90_000);
});

/*
 * The host list vite.config.ts hands to `server.allowedHosts`, checked without
 * Node so it runs wherever the suite does. A domain-wide pass is a DNS
 * rebinding hole unless the tunnel service authenticates every request.
 */
describe("the allowed hosts the dev server's config is given", () => {
  const AUTHENTICATED = { STANDUP_TUNNEL_DOMAIN: "tunnels.example.com", STANDUP_TUNNEL_IDENTITY_HEADER: "x-tunnel-user" };
  const UNAUTHENTICATED = { STANDUP_TUNNEL_DOMAIN: "tunnels.example.com", STANDUP_TUNNEL_UNAUTHENTICATED: "1" };
  const cases: Array<[string, Record<string, string>, string[]]> = [
    ["no env", {}, []],
    ["an authenticating tunnel domain", AUTHENTICATED, [".tunnels.example.com"]],
    ["a tunnel domain that authenticates no one", UNAUTHENTICATED, []],
    ["a tunnel domain with no trust declared", { STANDUP_TUNNEL_DOMAIN: "tunnels.example.com" }, []],
    ["STANDUP_WEB_URL alone", { STANDUP_WEB_URL: "https://standup.example.com/" }, ["standup.example.com"]],
    ["a loopback STANDUP_WEB_URL", { STANDUP_WEB_URL: "http://localhost:5173" }, []],
    [
      "STANDUP_WEB_URL beside an authenticating tunnel domain",
      { ...AUTHENTICATED, STANDUP_WEB_URL: "https://standup.example.com/" },
      ["standup.example.com", ".tunnels.example.com"],
    ],
    [
      "STANDUP_WEB_URL under an authenticating tunnel domain",
      { ...AUTHENTICATED, STANDUP_WEB_URL: "https://alice-standup.tunnels.example.com" },
      [".tunnels.example.com"],
    ],
    [
      "STANDUP_WEB_URL under a tunnel domain that authenticates no one",
      { ...UNAUTHENTICATED, STANDUP_WEB_URL: "https://alice-standup.tunnels.example.com" },
      ["alice-standup.tunnels.example.com"],
    ],
  ];
  for (const [name, env, expected] of cases) {
    test(`${name} → ${JSON.stringify(expected)}`, () => {
      expect(consoleAllowedHosts(env)).toEqual(expected);
    });
  }
});

describe.skipIf(!Bun.which("node"))("tunnel hosts and the configured console URL under Node", () => {
  const AUTHENTICATED_TUNNEL = { STANDUP_TUNNEL_DOMAIN: "tunnels.example.com", STANDUP_TUNNEL_IDENTITY_HEADER: "x-tunnel-user" };

  test("out of the box it answers no extra host, never any host, and bakes in no console URL", () => {
    const server = loadServerUnderNode({});
    expect(server.allowedHosts).toEqual([]);
    // Preview inherits the server's list, so vite's additional-hosts env var reaches it too.
    expect(server.previewAllowedHosts).toBeNull();
    expect(server.webUrl).toBe('""');
  }, 90_000);

  test("an authenticating tunnel provider's domain is answered", () => {
    const server = loadServerUnderNode(AUTHENTICATED_TUNNEL);
    expect(server.allowedHosts).toEqual([".tunnels.example.com"]);
  }, 90_000);

  test("a tunnel domain whose service authenticates no one gets no domain-wide pass", () => {
    const server = loadServerUnderNode({ STANDUP_TUNNEL_DOMAIN: "tunnels.example.com", STANDUP_TUNNEL_UNAUTHENTICATED: "1" });
    expect(server.allowedHosts).toEqual([]);
  }, 90_000);

  test("STANDUP_WEB_URL's host is answered, and share links are built on it", () => {
    const server = loadServerUnderNode({ ...AUTHENTICATED_TUNNEL, STANDUP_WEB_URL: "https://standup.example.com/" });
    expect(server.allowedHosts).toEqual(["standup.example.com", ".tunnels.example.com"]);
    expect(server.webUrl).toBe('"https://standup.example.com"');
  }, 90_000);

  test("STANDUP_WEB_URL alone answers its own host and nothing else", () => {
    const server = loadServerUnderNode({ STANDUP_WEB_URL: "https://standup.example.com/" });
    expect(server.allowedHosts).toEqual(["standup.example.com"]);
    expect(server.webUrl).toBe('"https://standup.example.com"');
  }, 90_000);

  test("a STANDUP_WEB_URL under a tunnel domain that authenticates no one is answered as itself, not the whole domain", () => {
    const server = loadServerUnderNode({
      STANDUP_TUNNEL_DOMAIN: "tunnels.example.com",
      STANDUP_TUNNEL_UNAUTHENTICATED: "1",
      STANDUP_WEB_URL: "https://alice-standup.tunnels.example.com",
    });
    expect(server.allowedHosts).toEqual(["alice-standup.tunnels.example.com"]);
  }, 90_000);

  test("a tunnel STANDUP_WEB_URL is covered by the tunnel domain", () => {
    const server = loadServerUnderNode({ ...AUTHENTICATED_TUNNEL, STANDUP_WEB_URL: "https://alice-standup.tunnels.example.com" });
    expect(server.allowedHosts).toEqual([".tunnels.example.com"]);
    expect(server.webUrl).toBe('"https://alice-standup.tunnels.example.com"');
  }, 90_000);
});
