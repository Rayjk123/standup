import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GLOBAL_PROJECT_ID } from "@standup/shared";
import {
  GROUP_CACHE_MS,
  GROUP_FAILURE_CACHE_MS,
  PUBLIC_KB_IDENTITY_HEADER_ENV,
  cachedGroupResolver,
  isAllowed,
  publicCallerAlias,
  publicIdentityHeader,
  publicIdentityHeaderProblem,
} from "./identity.js";
import { isPubliclyShareable, isPubliclyTrusted } from "./scope.js";
import {
  PUBLIC_KB_MAX_BODY_BYTES,
  publicKnowledgeSocketPath,
  socketAnswers,
  socketDirRefusal,
  startPublicKnowledgeListener,
} from "./listener.js";
import { REFUSED_LOGGED_PER_ALIAS, REFUSED_LOGGED_TOTAL, REFUSED_LOG_WINDOW_MS, refusedLogThrottle } from "./log-throttle.js";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "pkb-u-"));
  tmpDirs.push(d);
  return d;
};

describe("publicCallerAlias", () => {
  test("accepts an alias-shaped header, trimmed and lowercased; rejects the rest", () => {
    expect(publicCallerAlias(" alice ")).toBe("alice");
    expect(publicCallerAlias("Alice")).toBe("alice");
    expect(publicCallerAlias("a.b-c_d")).toBe("a.b-c_d");
    for (const bad of [undefined, null, "", "  ", "a b", "-x", ".x", "a/b", "a\nb", "x".repeat(65)]) {
      expect(publicCallerAlias(bad)).toBeNull();
    }
  });
});

describe("isAllowed / cachedGroupResolver", () => {
  test("an alias is allowed by name (any case) or by group; groups are looked up only when needed", async () => {
    const asked: string[] = [];
    const groups = async (a: string) => {
      asked.push(a);
      return a === "carol" ? ["kb"] : [];
    };
    expect(await isAllowed("Alice", { aliases: ["alice"], posixGroups: ["kb"] }, groups)).toBe(true);
    expect(asked).toEqual([]);
    expect(await isAllowed("carol", { aliases: [], posixGroups: ["kb"] }, groups)).toBe(true);
    expect(await isAllowed("bob", { aliases: [], posixGroups: ["kb"] }, groups)).toBe(false);
    expect(await isAllowed("carol", { aliases: [], posixGroups: [] }, groups)).toBe(false);
  });

  test("caches found and not-found lookups for five minutes; a failing lookup reads as no groups", async () => {
    let now = 0;
    let calls = 0;
    const resolve = cachedGroupResolver(async (a) => {
      calls++;
      if (a === "boom") throw new Error("spawn failed");
      return a === "carol" ? ["kb"] : [];
    }, () => now);
    expect(await resolve("carol")).toEqual(["kb"]);
    expect(await resolve("carol")).toEqual(["kb"]);
    expect(await resolve("bob")).toEqual([]);
    expect(await resolve("bob")).toEqual([]);
    expect(calls).toBe(2);
    expect(await resolve("boom")).toEqual([]);
    now += 5 * 60_000 + 1;
    await resolve("carol");
    expect(calls).toBe(4);
  });

  test("a failed lookup is retried after GROUP_FAILURE_CACHE_MS, not five minutes", async () => {
    let now = 0;
    let calls = 0;
    let failing = true;
    const resolve = cachedGroupResolver(async () => {
      calls++;
      if (failing) throw new Error("id -Gn timed out");
      return ["kb"];
    }, () => now);
    expect(await resolve("carol")).toEqual([]);
    expect(await resolve("carol")).toEqual([]);
    expect(calls).toBe(1);
    failing = false;
    now += GROUP_FAILURE_CACHE_MS;
    expect(await resolve("carol")).toEqual(["kb"]);
    expect(calls).toBe(2);
    now += GROUP_CACHE_MS - 1;
    expect(await resolve("carol")).toEqual(["kb"]);
    expect(calls).toBe(2);
  });

  test("holds at most maxEntries aliases, evicting the least recently used", async () => {
    let calls = 0;
    const resolve = cachedGroupResolver(async () => {
      calls++;
      return [];
    }, () => 0, 2);
    await resolve("a");
    await resolve("b");
    await resolve("a");
    await resolve("c");
    expect(calls).toBe(3);
    await resolve("a");
    expect(calls).toBe(3);
    await resolve("b");
    expect(calls).toBe(4);
  });

  test("the default resolver runs id without a shell", async () => {
    const resolve = cachedGroupResolver();
    const me = process.env.USER;
    if (me && /^[a-z0-9][a-z0-9._-]*$/i.test(me)) expect((await resolve(me)).length).toBeGreaterThan(0);
    expect(await resolve("no-such-user-zqxj")).toEqual([]);
    expect(await resolve("$(touch /tmp/pkb-pwned)")).toEqual([]);
  });
});

describe("isPubliclyShareable / isPubliclyTrusted", () => {
  const ctx = { shareableProjects: new Set([GLOBAL_PROJECT_ID, "alpha"]) };
  test("admits global-corpus and shareable-project docs only", () => {
    expect(isPubliclyShareable({ projectId: GLOBAL_PROJECT_ID, slug: "x", scope: "global" }, ctx)).toBe(true);
    expect(isPubliclyShareable({ projectId: "alpha", slug: "x", scope: "project" }, ctx)).toBe(true);
    expect(isPubliclyShareable({ projectId: "beta", slug: "x", scope: "global" }, ctx)).toBe(false);
    expect(isPubliclyShareable({ projectId: "alpha", slug: "x", scope: "user" }, ctx)).toBe(false);
    expect(isPubliclyShareable({ projectId: GLOBAL_PROJECT_ID, slug: "persona-bob-x", scope: "global" }, ctx)).toBe(false);
    expect(isPubliclyShareable({ projectId: "alpha", slug: "native-mem-repo-x", sourceKind: "native-memory" }, ctx)).toBe(false);
    expect(isPubliclyShareable({ projectId: "alpha", slug: "native-mem-memory-x", sourceKind: "native-memory" }, ctx)).toBe(false);
    expect(isPubliclyShareable({ projectId: "alpha", slug: "native-mem-loose", scope: "project", sourceKind: "runbook" }, ctx)).toBe(false);
  });

  test("a candidate without a scope is not shareable until resolved to its doc", () => {
    expect(isPubliclyShareable({ projectId: GLOBAL_PROJECT_ID, slug: "x" }, ctx)).toBe(false);
    expect(isPubliclyShareable({ projectId: "alpha", slug: "x" }, ctx)).toBe(false);
  });

  test("the trust gate serves owner or agent origin only, and no disputed or superseded doc", () => {
    expect(isPubliclyTrusted({ originClass: "owner" })).toBe(true);
    expect(isPubliclyTrusted({ originClass: "agent", verdict: "clean" })).toBe(true);
    expect(isPubliclyTrusted({ originClass: "owner", verdict: "contradicted" })).toBe(true);
    expect(isPubliclyTrusted({ originClass: "untrusted" })).toBe(false);
    expect(isPubliclyTrusted({})).toBe(false);
    expect(isPubliclyTrusted({ originClass: "owner", verdict: "disputed" })).toBe(false);
    expect(isPubliclyTrusted({ originClass: "owner", verdict: "superseded" })).toBe(false);
  });
});

describe("the caller header", () => {
  const cases: Array<[string, string | undefined, string | null]> = [
    ["unset", undefined, null],
    ["empty", "  ", null],
    ["a header name, lowercased and trimmed", " X-Relay-User ", "x-relay-user"],
    ["not a header name", "x relay user", null],
    ["a header name with a colon", "x-relay-user:", null],
  ];
  for (const [name, value, expected] of cases) {
    test(name, () => {
      const env = value === undefined ? {} : { [PUBLIC_KB_IDENTITY_HEADER_ENV]: value };
      expect(publicIdentityHeader(env)).toBe(expected);
      expect(publicIdentityHeaderProblem(env) === null).toBe(expected !== null);
    });
  }

  test("is read from STANDUP_PUBLIC_KB_IDENTITY_HEADER alone, never the console's identity settings", () => {
    expect(PUBLIC_KB_IDENTITY_HEADER_ENV).toBe("STANDUP_PUBLIC_KB_IDENTITY_HEADER");
    expect(publicIdentityHeader({ STANDUP_IDENTITY_HEADER: "x-relay-user", STANDUP_TUNNEL_IDENTITY_HEADER: "x-relay-user" })).toBeNull();
  });
});

/** The env the listener tests start under: the relay's caller header is named. */
const RELAY_ENV = { [PUBLIC_KB_IDENTITY_HEADER_ENV]: "x-relay-user" };

describe("the socket listener", () => {
  test("defaults to <dataDir>/public/kb.sock; STANDUP_PUBLIC_KB_SOCKET overrides", () => {
    expect(publicKnowledgeSocketPath("/d", {})).toBe("/d/public/kb.sock");
    expect(publicKnowledgeSocketPath("/d", { STANDUP_PUBLIC_KB_SOCKET: "/s/k.sock" })).toBe("/s/k.sock");
  });

  test("refuses to listen while no caller header is named, and creates nothing", async () => {
    const data = tmp();
    const socket = join(data, "public", "kb.sock");
    for (const env of [{}, { [PUBLIC_KB_IDENTITY_HEADER_ENV]: "not a header" }]) {
      const refused = await startPublicKnowledgeListener({ socketPath: socket, managedDir: true, fetch: () => new Response(""), env });
      expect(refused.server).toBeNull();
      expect(refused.status.enabled).toBe(false);
      expect(refused.status.error).toContain(PUBLIC_KB_IDENTITY_HEADER_ENV);
      expect(existsSync(join(data, "public"))).toBe(false);
    }
  });

  test("creates its directory 0700, tightens it, replaces a stale socket, and makes the socket 0600", async () => {
    const data = tmp();
    const dir = join(data, "public");
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    const socket = join(dir, "kb.sock");
    const fetch1 = () => new Response("one");
    const first = await startPublicKnowledgeListener({ socketPath: socket, managedDir: true, fetch: fetch1, env: RELAY_ENV });
    expect(first.server).not.toBeNull();
    expect(first.status).toEqual({ enabled: true, socketPath: socket });
    first.server!.stop(true);
    // The stopped server can leave its socket file behind; nothing answers on it, so the next start removes it.
    const second = await startPublicKnowledgeListener({ socketPath: socket, managedDir: true, fetch: () => new Response("two"), env: RELAY_ENV });
    try {
      expect(second.status.enabled).toBe(true);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(socket).mode & 0o777).toBe(0o600);
      const res = await fetch("http://localhost/", { unix: socket });
      expect(await res.text()).toBe("two");
    } finally {
      second.server?.stop(true);
    }
  });

  test("leaves a socket another process answers on alone, and reports why it isn't serving", async () => {
    const dir = tmp();
    chmodSync(dir, 0o700);
    const socket = join(dir, "kb.sock");
    const live = Bun.serve({ unix: socket, fetch: () => new Response("live") });
    try {
      expect(await socketAnswers(socket)).toBe(true);
      const second = await startPublicKnowledgeListener({ socketPath: socket, managedDir: false, fetch: () => new Response("scratch"), env: RELAY_ENV });
      expect(second.server).toBeNull();
      expect(second.status.enabled).toBe(false);
      expect(second.status.socketPath).toBe(socket);
      expect(second.status.error).toContain("already listening");
      // The live server still owns the socket.
      const res = await fetch("http://localhost/", { unix: socket });
      expect(await res.text()).toBe("live");
    } finally {
      live.stop(true);
    }
  });

  test("caps a request body at PUBLIC_KB_MAX_BODY_BYTES", async () => {
    const dir = tmp();
    chmodSync(dir, 0o700);
    const socket = join(dir, "kb.sock");
    const { server } = await startPublicKnowledgeListener({
      socketPath: socket,
      managedDir: false,
      fetch: async (req) => new Response(String((await req.text()).length)),
      env: RELAY_ENV,
    });
    try {
      const small = await fetch("http://localhost/", { unix: socket, method: "POST", body: "x".repeat(1000) });
      expect(await small.text()).toBe("1000");
      const big = await fetch("http://localhost/", { unix: socket, method: "POST", body: "x".repeat(PUBLIC_KB_MAX_BODY_BYTES * 4) });
      expect(big.status).toBe(413);
    } finally {
      server?.stop(true);
    }
  });

  test("refuses a named socket whose directory others can enter, and a path that is not a socket", async () => {
    const open = tmp();
    chmodSync(open, 0o750);
    expect(socketDirRefusal(open)).toContain("0700");
    const refused = await startPublicKnowledgeListener({ socketPath: join(open, "kb.sock"), managedDir: false, fetch: () => new Response(""), env: RELAY_ENV });
    expect(refused.server).toBeNull();
    expect(refused.status.error).toContain("0700");
    expect(statSync(open).mode & 0o777).toBe(0o750);

    const closed = tmp();
    chmodSync(closed, 0o700);
    writeFileSync(join(closed, "kb.sock"), "not a socket");
    const notSocket = await startPublicKnowledgeListener({ socketPath: join(closed, "kb.sock"), managedDir: false, fetch: () => new Response(""), env: RELAY_ENV });
    expect(notSocket.server).toBeNull();
    expect(notSocket.status.error).toContain("not a socket");
    expect(socketDirRefusal(join(closed, "missing"))).not.toBeNull();
  });
});

describe("refusedLogThrottle", () => {
  test("logs the first refusals per alias and in all, then counts the rest into one row per alias when the window closes", () => {
    const throttle = refusedLogThrottle();
    let logged = 0;
    for (let i = 0; i < REFUSED_LOGGED_PER_ALIAS + 5; i++) if (throttle.admit("mallory", 403, 1_000)) logged++;
    expect(logged).toBe(REFUSED_LOGGED_PER_ALIAS);
    expect(throttle.admit("alice", 404, 1_000)).toBe(true);
    expect(throttle.closed(1_000 + REFUSED_LOG_WINDOW_MS - 1)).toEqual([]);
    const rows = throttle.closed(1_000 + REFUSED_LOG_WINDOW_MS);
    expect(rows).toEqual([{ alias: "mallory", count: 5, status: 403, since: new Date(1_000).toISOString() }]);
    // A new window starts afresh.
    expect(throttle.admit("mallory", 403, 1_000 + REFUSED_LOG_WINDOW_MS)).toBe(true);
  });

  test("forged aliases share the total cap", () => {
    const throttle = refusedLogThrottle();
    let logged = 0;
    for (let i = 0; i < REFUSED_LOGGED_TOTAL + 50; i++) if (throttle.admit(`u${i}`, 403, 0)) logged++;
    expect(logged).toBe(REFUSED_LOGGED_TOTAL);
    const rows = throttle.closed(REFUSED_LOG_WINDOW_MS);
    expect(rows.reduce((n, r) => n + r.count, 0)).toBe(50);
  });
});
