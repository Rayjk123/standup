import { afterEach, describe, expect, test } from "bun:test";
import { GATEWAY_HOST, type LeaderInfo } from "@standup/shared/topology";
import { LeaderResolver } from "./leader.js";

const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A /health endpoint whose pid and latency the test controls. */
function startHealth(pid: number) {
  const state = { pid, delayMs: 0 };
  const server = Bun.serve({
    hostname: GATEWAY_HOST,
    port: 0,
    idleTimeout: 0,
    async fetch() {
      if (state.delayMs) await Bun.sleep(state.delayMs);
      return Response.json({ status: "ok", pid: state.pid });
    },
  });
  cleanups.push(() => server.stop(true));
  const info: LeaderInfo = {
    pid,
    httpPort: server.port ?? 0,
    wsPort: 1,
    epoch: `e${pid}`,
    acquiredAt: new Date().toISOString(),
    installDir: "/tmp",
  };
  return { state, server, info };
}

describe("LeaderResolver.check", () => {
  test("a slow /health keeps the cached leader", async () => {
    const health = startHealth(4101);
    const resolver = new LeaderResolver({ source: () => health.info, healthTimeoutMs: 100 });
    expect(await resolver.resolve()).toBeDefined();
    const validAt = resolver.lastValidAt;
    health.state.delayMs = 300;
    expect(await resolver.check()).toBe(false);
    expect(resolver.current()?.leader.pid).toBe(4101);
    expect(resolver.lastValidAt).toBe(validAt);
    health.state.delayMs = 0;
    expect(await resolver.check()).toBe(true);
    expect(resolver.lastValidAt).toBeGreaterThanOrEqual(validAt);
  });

  test("a pid mismatch drops the cached leader", async () => {
    const health = startHealth(4102);
    const resolver = new LeaderResolver({ source: () => health.info, healthTimeoutMs: 300 });
    expect(await resolver.resolve()).toBeDefined();
    health.state.pid = 9999;
    expect(await resolver.check()).toBe(false);
    expect(resolver.current()).toBeUndefined();
  });

  test("a refused connection drops the cached leader", async () => {
    const health = startHealth(4103);
    const resolver = new LeaderResolver({ source: () => health.info, healthTimeoutMs: 300 });
    expect(await resolver.resolve()).toBeDefined();
    health.server.stop(true);
    expect(await resolver.check()).toBe(false);
    expect(resolver.current()).toBeUndefined();
  });

  test("a changed leader file is re-validated rather than served from cache", async () => {
    const a = startHealth(4104);
    const b = startHealth(4105);
    let info = a.info;
    const resolver = new LeaderResolver({ source: () => info, healthTimeoutMs: 300 });
    expect((await resolver.resolve())?.leader.pid).toBe(4104);
    info = b.info;
    expect(await resolver.check()).toBe(true);
    expect(resolver.current()?.leader.pid).toBe(4105);
  });
});
