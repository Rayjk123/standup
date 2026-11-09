import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { createLaunch, createStore, setLaunchHookTokenHash, setLaunchReviewTokenHash, upsertProject } from "@standup/store";
import type { Store } from "@standup/store";
import { DEFAULT_IDENTITY_HEADER, WORKER_TOKEN_HEADER } from "@standup/shared";
import { OWNER_TOKEN_HEADER } from "@standup/shared/owner-token";
import { createServer, setLocalWriteToken } from "./server.js";
import { generateOwnerSecrets } from "./owner-secret.js";
import { HOOK_TOKEN_HEADER, workerTokenHash } from "./floor/gate.js";
import { CALLER_GUARD_ERRORS, OPEN_ROUTES } from "./caller-guard.js";
import { createWsServer } from "./ws.js";
import { resolveIdentityConfigFromEnv } from "./identity.js";
import type { Snapshot } from "@standup/shared";
import { ownerTokenWsProxyConfigure, type IncomingRequest, type ProxiedRequest } from "../../web/owner-proxy.js";

/**
 * callerGuard runs ahead of every collector route: a foreign Host and a
 * cross-site browser request are refused, and a caller off this machine needs
 * a credential. The console (through its proxy), a worker's MCP server, the
 * hook and the health probe still get through.
 */

const secrets = generateOwnerSecrets();
const WRITE_TOKEN = "synthetic-write-token-for-tests";
const WORKER_TOKEN = "synthetic-worker-token-for-tests";
const HOOK_TOKEN = "synthetic-hook-token-for-tests";

let store: Store;
let app: ReturnType<typeof createServer>;

beforeEach(() => {
  store = createStore(":memory:");
  app = createServer(store, () => {}, null, undefined, undefined, "", "", {}, undefined, undefined, undefined, undefined, {
    ownerSecrets: secrets,
  });
  setLocalWriteToken(WRITE_TOKEN);
});

afterEach(() => {
  setLocalWriteToken(undefined);
  store.close();
});

/** The connection info of a caller on another machine. */
const REMOTE = { requestIP: () => ({ address: "10.1.2.3", family: "IPv4", port: 40000 }) };

interface Call {
  method?: string;
  host?: string;
  headers?: Record<string, string>;
  body?: unknown;
  remote?: boolean;
}

/** A request for `path` under `host` (the URL's host is the request's Host). */
function call(path: string, { method = "GET", host = "127.0.0.1:7777", headers = {}, body, remote = false }: Call = {}) {
  return app.request(
    `http://${host}${path}`,
    {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
    remote ? REMOTE : undefined
  );
}

const GUARD_ERRORS = new Set<string>(Object.values(CALLER_GUARD_ERRORS));

/** Which guard check refused `res`, or null when the request reached its route. */
async function refusedBy(res: Response): Promise<string | null> {
  if (res.status !== 403) return null;
  const error = ((await res.json()) as { error?: string }).error ?? "";
  if (!GUARD_ERRORS.has(error)) return null;
  return Object.entries(CALLER_GUARD_ERRORS).find(([, v]) => v === error)![0];
}

/** What the console's proxy forwards for the signed-in owner's browser on the tunnel origin. */
const CONSOLE = {
  [OWNER_TOKEN_HEADER]: secrets.ownerToken,
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "cors",
  origin: "https://owner.tunnel.example",
};

describe("refused", () => {
  test("a Host that doesn't name the collector (DNS rebinding), on a read and a write", async () => {
    expect(await refusedBy(await call("/api/sessions", { host: "evil.example:7777" }))).toBe("host");
    expect(await refusedBy(await call("/api/launch", { method: "POST", host: "evil.example:7777", body: {} }))).toBe("host");
    // Even with the owner's token.
    expect(await refusedBy(await call("/api/sessions", { host: "evil.example:7777", headers: CONSOLE }))).toBe("host");
  });

  test("a cross-site POST, by Sec-Fetch-Site or by Origin alone", async () => {
    const crossSite = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors", origin: "https://evil.example" };
    expect(await refusedBy(await call("/api/launch", { method: "POST", headers: crossSite, body: {} }))).toBe("site");
    expect(await refusedBy(await call("/api/launch", { method: "POST", headers: { origin: "https://evil.example" }, body: {} }))).toBe("site");
    expect(await refusedBy(await call("/api/launch", { method: "POST", headers: { origin: "null" }, body: {} }))).toBe("site");
    // Another port on localhost is the same site but not the console.
    const sameSite = { "sec-fetch-site": "same-site", origin: "http://localhost:3000" };
    expect(await refusedBy(await call("/api/launch", { method: "POST", headers: sameSite, body: {} }))).toBe("site");
  });

  test("a cross-origin read of transcripts, sessions or an image", async () => {
    const fetched = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors", origin: "https://evil.example" };
    expect(await refusedBy(await call("/api/sessions", { headers: fetched }))).toBe("site");
    expect(await refusedBy(await call("/api/sessions/s1/transcript", { headers: fetched }))).toBe("site");
    const img = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" };
    expect(await refusedBy(await call("/api/docs/assets/a1", { headers: img }))).toBe("site");
  });

  test("a caller on another machine with no credential, or a wrong one", async () => {
    expect(await refusedBy(await call("/api/sessions", { remote: true }))).toBe("credential");
    expect(await refusedBy(await call("/api/launch", { method: "POST", remote: true, body: {} }))).toBe("credential");
    expect(await refusedBy(await call("/api/sessions", { remote: true, headers: { [OWNER_TOKEN_HEADER]: "not-the-owner-token" } }))).toBe("credential");
    expect(await refusedBy(await call("/api/sessions", { remote: true, headers: { "x-standup-write-token": "wrong" } }))).toBe("credential");
    // A bare identity header from an untrusted source proves nothing.
    expect(await refusedBy(await call("/api/sessions", { remote: true, headers: { [DEFAULT_IDENTITY_HEADER]: "alice" } }))).toBe("credential");
    // The hook token counts only on /hook.
    expect(await refusedBy(await call("/api/sessions", { remote: true, headers: { [HOOK_TOKEN_HEADER]: "x" } }))).toBe("credential");
    expect(await refusedBy(await call("/hook", { method: "POST", remote: true, body: { hook_event_name: "Stop", session_id: "s1" } }))).toBe("credential");
  });
});

describe("still allowed", () => {
  test("the console through its proxy: Host rewritten to loopback, same-origin, owner token", async () => {
    expect(await refusedBy(await call("/api/sessions", { headers: CONSOLE }))).toBeNull();
    expect(await refusedBy(await call("/api/launch", { method: "POST", headers: CONSOLE, body: {} }))).toBeNull();
    // An unsigned console (no token) on this machine still reads.
    expect(await refusedBy(await call("/api/sessions", { headers: { "sec-fetch-site": "same-origin" } }))).toBeNull();
    // The configured console URL as a cross-origin Origin, from a browser with no Sec-Fetch-Site.
    const prev = process.env.STANDUP_WEB_URL;
    process.env.STANDUP_WEB_URL = "https://owner.tunnel.example";
    try {
      expect(await refusedBy(await call("/api/launch", { method: "POST", headers: { origin: "https://owner.tunnel.example" }, body: {} }))).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.STANDUP_WEB_URL;
      else process.env.STANDUP_WEB_URL = prev;
    }
    // The dev server's own origin, which the collector admits by CORS.
    expect(await refusedBy(await call("/api/sessions", { headers: { "sec-fetch-site": "same-site", origin: "http://localhost:5173" } }))).toBeNull();
  });

  test("the console from another machine with the owner token", async () => {
    expect(await refusedBy(await call("/api/sessions", { remote: true, headers: CONSOLE }))).toBeNull();
  });

  test("a worker's MCP server: no Origin, the write token, the worker token", async () => {
    expect(await refusedBy(await call("/api/sessions", { host: "localhost:7777", headers: { "x-standup-write-token": WRITE_TOKEN } }))).toBeNull();
    expect(await refusedBy(await call("/api/launch", { method: "POST", host: "localhost:7777", body: {} }))).toBeNull();
    expect(await refusedBy(await call("/api/sessions", { remote: true, headers: { "x-standup-write-token": WRITE_TOKEN } }))).toBeNull();
    upsertProject(store.db, { id: "p", name: "P", branch: "main", repos: [] });
    const launch = createLaunch(store.db, { id: randomUUID(), projectId: "p", task: "t", worktreePath: "/tmp/wt", branch: "b", status: "running", launchedBy: "alice" });
    setLaunchReviewTokenHash(store.db, launch.id, workerTokenHash(WORKER_TOKEN));
    expect(await refusedBy(await call("/api/sessions", { remote: true, headers: { [WORKER_TOKEN_HEADER]: WORKER_TOKEN } }))).toBeNull();
  });

  test("the hook: tokenless on this machine, with a live launch's hook token from another", async () => {
    const event = { hook_event_name: "Stop", session_id: "s1", cwd: "/tmp" };
    expect(await refusedBy(await call("/hook", { method: "POST", host: "localhost:7777", body: event }))).toBeNull();
    upsertProject(store.db, { id: "p", name: "P", branch: "main", repos: [] });
    const launch = createLaunch(store.db, { id: randomUUID(), projectId: "p", task: "t", worktreePath: "/tmp/wt", branch: "b", status: "running", launchedBy: "alice" });
    setLaunchHookTokenHash(store.db, launch.id, workerTokenHash(HOOK_TOKEN));
    expect(await refusedBy(await call("/hook", { method: "POST", remote: true, headers: { [HOOK_TOKEN_HEADER]: HOOK_TOKEN }, body: event }))).toBeNull();
    // A token no live launch holds, or one the handler trims to nothing (a no-break space), is no credential.
    for (const token of ["not-a-launch-token", " "]) {
      expect(await refusedBy(await call("/hook", { method: "POST", remote: true, headers: { [HOOK_TOKEN_HEADER]: token }, body: event }))).toBe("credential");
    }
  });

  test("the health probe under any name, a share link from anywhere, a cross-site navigation", async () => {
    expect((await call("/health", { host: "10.9.9.9:7777", remote: true })).status).toBe(200);
    // A share link's token is its credential; the handler answers 404 for an unknown one.
    expect(await refusedBy(await call("/api/share/docs/0123456789abcdef", { remote: true }))).toBeNull();
    const nav = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
    expect(await refusedBy(await call("/api/sessions", { headers: nav }))).toBeNull();
    expect(await refusedBy(await call("/api/launch", { method: "POST", headers: nav, body: {} }))).toBe("site");
  });

  test("an allowed tunnel Host and the collector's specific bind address", async () => {
    const prev = { allowed: process.env.STANDUP_ALLOWED_HOSTS, bind: process.env.STANDUP_BIND_HOST };
    process.env.STANDUP_ALLOWED_HOSTS = "collector.tunnel.example";
    process.env.STANDUP_BIND_HOST = "10.1.2.3";
    try {
      expect(await refusedBy(await call("/api/sessions", { host: "collector.tunnel.example" }))).toBeNull();
      // The collector dialing its own bind address is a local call.
      expect(await refusedBy(await call("/api/sessions", { host: "10.1.2.3:7777", remote: true }))).toBeNull();
    } finally {
      for (const [k, v] of [["STANDUP_ALLOWED_HOSTS", prev.allowed], ["STANDUP_BIND_HOST", prev.bind]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("the WebSocket server", () => {
  /** Whether a socket opened with `headers` gets its hello-ok frame (true) or is refused (false). */
  async function opens(headers: Record<string, string>): Promise<boolean> {
    const handle = createWsServer(0, async () => ({}) as Snapshot, () => {}, resolveIdentityConfigFromEnv({}), {
      epoch: "e",
      hostname: "127.0.0.1",
      ownerSecrets: () => secrets,
    });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/`, { headers } as unknown as string[]);
      return await new Promise<boolean>((resolve) => {
        ws.addEventListener("message", (e) => {
          if ((JSON.parse(String(e.data)) as { type: string }).type === "hello-ok") resolve(true);
        });
        ws.addEventListener("error", () => resolve(false));
        ws.addEventListener("close", () => resolve(false));
      }).finally(() => ws.close());
    } finally {
      await handle.close(1000, 200);
    }
  }

  /** The guard check that refused an upgrade request with `headers` on `path`, or null when none did. */
  async function upgradeRefusedBy(path: string, headers: Record<string, string>): Promise<string | null> {
    const handle = createWsServer(0, async () => ({}) as Snapshot, () => {}, resolveIdentityConfigFromEnv({}), {
      epoch: "e",
      hostname: "127.0.0.1",
      ownerSecrets: () => secrets,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
        headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13", ...headers },
      });
      return res.status === 403 ? await refusedBy(res) : null;
    } finally {
      await handle.close(1000, 200);
    }
  }

  test("refuses a page on another site and a foreign Host, on any path", async () => {
    expect(await opens({ origin: "https://evil.example", "sec-fetch-site": "cross-site" })).toBe(false);
    for (const path of ["/", "/health", "/api/share/docs/0123456789abcdef"]) {
      expect(await upgradeRefusedBy(path, { origin: "https://evil.example", "sec-fetch-site": "cross-site" })).toBe("site");
      expect(await upgradeRefusedBy(path, { origin: "https://evil.example" })).toBe("site");
      expect(await upgradeRefusedBy(path, { host: "evil.example:7778" })).toBe("host");
    }
  });

  test("opens for the console's proxy and the Slack relay", async () => {
    expect(await opens({ origin: "http://localhost:5173", "sec-fetch-site": "same-site" })).toBe(true);
    expect(await opens({ [OWNER_TOKEN_HEADER]: secrets.ownerToken })).toBe(true);
    expect(await opens({})).toBe(true);
  });

  /**
   * The headers a browser's upgrade reaches the collector with once the
   * console's /ws proxy (ownerTokenWsProxyConfigure) has forwarded it: the
   * proxy copies the incoming headers, its hook adjusts them, and
   * `changeOrigin` sets `Host` to the collector's address.
   */
  function throughConsoleProxy(browser: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = { ...browser };
    let hook: ((proxyReq: ProxiedRequest, req: IncomingRequest) => void) | undefined;
    ownerTokenWsProxyConfigure(() => undefined, DEFAULT_IDENTITY_HEADER)({ on: (_event, listener) => (hook = listener) });
    hook!(
      { setHeader: (name, value) => (out[name.toLowerCase()] = value), removeHeader: (name) => delete out[name.toLowerCase()] },
      { method: "GET", headers: browser }
    );
    delete out.host;
    delete out.upgrade;
    return out;
  }

  // The console's public URL would admit the tunnel's Origin by itself; these tests run without one.
  let consoleUrlEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    consoleUrlEnv = { STANDUP_WEB_URL: process.env.STANDUP_WEB_URL, STANDUP_CONSOLE_ORIGIN: process.env.STANDUP_CONSOLE_ORIGIN };
    delete process.env.STANDUP_WEB_URL;
    delete process.env.STANDUP_CONSOLE_ORIGIN;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(consoleUrlEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // A tunnel dials the console as localhost:5173, names its public host
  // in X-Forwarded-Host, and passes on the browser's Origin; Chromium sends no
  // Sec-Fetch-Site on a WebSocket upgrade.
  const TUNNEL = "alice-standup.tunnels.example.com";
  const tunnelUpgrade = { host: "localhost:5173", upgrade: "websocket", origin: `https://${TUNNEL}`, "x-forwarded-host": TUNNEL, "x-forwarded-proto": "https", [DEFAULT_IDENTITY_HEADER]: "alice" };

  test("opens for the console's own page through the tunnel", async () => {
    expect(await opens(throughConsoleProxy(tunnelUpgrade))).toBe(true);
    expect(await opens(throughConsoleProxy({ ...tunnelUpgrade, "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(await opens(throughConsoleProxy({ host: "localhost:5173", origin: "http://localhost:5173" }))).toBe(true);
  });

  test("still refuses another site's page, through the tunnel or a rebinding name", async () => {
    expect(await upgradeRefusedBy("/ws", throughConsoleProxy({ ...tunnelUpgrade, origin: "https://evil.example" }))).toBe("site");
    expect(await upgradeRefusedBy("/ws", throughConsoleProxy({ ...tunnelUpgrade, "x-forwarded-host": `evil.example, ${TUNNEL}` }))).toBe("site");
    expect(
      await upgradeRefusedBy("/ws", throughConsoleProxy({ host: "evil.example:5173", origin: "http://evil.example:5173", "sec-fetch-site": "same-origin" }))
    ).toBe("site");
  });
});

describe("every registered route", () => {
  /** A concrete path for a route pattern: each parameter and wildcard filled in. */
  const concrete = (pattern: string) => pattern.replace(/:[A-Za-z_]+(\{[^}]*\})?\??/g, "1").replace(/\*/g, "x");
  const routes = () => {
    const seen = new Set<string>();
    return app.routes
      .filter((r) => !(r.method === "ALL" && r.path.includes("*")))
      .map((r) => ({ method: r.method === "ALL" ? "GET" : r.method, path: r.path }))
      .filter((r) => !seen.has(`${r.method} ${r.path}`) && !!seen.add(`${r.method} ${r.path}`));
  };
  const open = (r: { method: string; path: string }) => OPEN_ROUTES.find((o) => o.method === r.method && o.path === r.path);

  test("is guarded, unless it is on OPEN_ROUTES", async () => {
    const all = routes();
    expect(all.length).toBeGreaterThan(200);
    const unguarded: string[] = [];
    for (const r of all) {
      const listed = open(r);
      const path = concrete(r.path);
      const body = r.method === "GET" || r.method === "HEAD" ? undefined : {};
      if (listed?.skips !== "all" && (await refusedBy(await call(path, { method: r.method, host: "evil.example", body }))) !== "host") {
        unguarded.push(`${r.method} ${r.path}: a foreign Host reached it`);
      }
      if (!listed && (await refusedBy(await call(path, { method: r.method, remote: true, body }))) !== "credential") {
        unguarded.push(`${r.method} ${r.path}: a caller off this machine reached it with no credential`);
      }
    }
    expect(unguarded).toEqual([]);
  });

  test("OPEN_ROUTES names only registered routes, each with a reason", () => {
    const registered = new Set(routes().map((r) => `${r.method} ${r.path}`));
    for (const o of OPEN_ROUTES) {
      expect(registered.has(`${o.method} ${o.path}`)).toBe(true);
      expect(o.why.length).toBeGreaterThan(20);
    }
  });
});
