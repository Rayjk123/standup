import { expect, test, describe, afterEach } from "bun:test";
import { DEFAULT_IDENTITY_HEADER } from "@standup/shared";
import { createStore, getUser } from "@standup/store";
import type { Store } from "@standup/store";
import type { WhoAmI } from "@standup/shared";
import { createServer, resolveUserAlias, tunnelHeaderTrust } from "./server.js";
import { hostUserAlias, hostUserSource } from "./host-user.js";

/**
 * Tunnel identity: resolveUserAlias is the pure
 * header-present/fallback logic, and GET /api/whoami is that logic wired into
 * the app plus the per-request users upsert.
 */

describe("resolveUserAlias", () => {
  test("prefers the tunnel header when present", () => {
    expect(resolveUserAlias("erin", "hostuser")).toBe("erin");
  });

  test("trims a whitespace-padded header", () => {
    expect(resolveUserAlias("  erin  ", "hostuser")).toBe("erin");
  });

  test("falls back to the host user when the header is empty or absent", () => {
    expect(resolveUserAlias(undefined, "hostuser")).toBe("hostuser");
    expect(resolveUserAlias(null, "hostuser")).toBe("hostuser");
    expect(resolveUserAlias("", "hostuser")).toBe("hostuser");
    expect(resolveUserAlias("   ", "hostuser")).toBe("hostuser");
  });

  test("falls back to 'local' when there is no host user either", () => {
    // An explicit empty envUser is the "no $USER" case; passing undefined would
    // trip the default parameter and read the real process.env.USER.
    expect(resolveUserAlias(undefined, "")).toBe("local");
    expect(resolveUserAlias("", "")).toBe("local");
  });

  test("the host user is $STANDUP_HOST_USER, else $USER, else 'local', and names where it came from", () => {
    expect(hostUserAlias({ STANDUP_HOST_USER: " svc ", USER: "alice" })).toBe("svc");
    expect(hostUserSource({ STANDUP_HOST_USER: "svc", USER: "alice" })).toBe("$STANDUP_HOST_USER");
    expect(hostUserAlias({ USER: "alice" })).toBe("alice");
    expect(hostUserSource({ USER: "alice" })).toBe("$USER");
    expect(hostUserAlias({})).toBe("local");
    expect(hostUserSource({ USER: " " })).toBe("default");
  });

  test("on a non-loopback request a missing header resolves to anonymous, not the host user", () => {
    // The interim hardening for a network-exposed collector: a header-less
    // request off loopback must NOT be attributed to the host operator whose
    // credentials every session runs under.
    expect(resolveUserAlias(undefined, "hostuser", false, false)).toBe("anonymous");
    expect(resolveUserAlias("", "hostuser", false, false)).toBe("anonymous");
  });

  test("on a non-loopback request an untrusted tunnel header is ignored, resolving to anonymous", () => {
    // headerTrusted=false: the forgeable header from an untrusted network
    // source cannot name a victim; it is dropped rather than honored.
    expect(resolveUserAlias("victim", "hostuser", false, false)).toBe("anonymous");
  });

  test("on a loopback request an untrusted header resolves to anonymous, not the host user", () => {
    // headerTrusted=false on loopback: the tunnel provider doesn't vouch for the
    // header, so a caller naming anyone (the host included) is not trusted as
    // the host either.
    expect(resolveUserAlias("victim", "hostuser", false, true)).toBe("anonymous");
    expect(resolveUserAlias("hostuser", "hostuser", false, true)).toBe("anonymous");
    // A header-less loopback request keeps the single-user default.
    expect(resolveUserAlias(undefined, "hostuser", false, true)).toBe("hostuser");
    expect(resolveUserAlias("  ", "hostuser", false, true)).toBe("hostuser");
  });

  test("a loopback request keeps the single-user $USER default", () => {
    // The default tunnel deployment (loopback, trusted) is unchanged.
    expect(resolveUserAlias(undefined, "hostuser", true, true)).toBe("hostuser");
    expect(resolveUserAlias("erin", "hostuser", true, true)).toBe("erin");
  });

  test("a trusted proxy honors the header but a missing one is still anonymous, not the host", () => {
    // A trusted non-loopback proxy (headerTrusted=true, sourceLoopback=false)
    // is trusted to have injected a genuine alias, but a header-less request
    // through it is a network request — still anonymous, never the host user.
    expect(resolveUserAlias("erin", "hostuser", true, false)).toBe("erin");
    expect(resolveUserAlias(undefined, "hostuser", true, false)).toBe("anonymous");
  });
});

describe("tunnelHeaderTrust", () => {
  const savedProxies = process.env.STANDUP_TRUSTED_PROXIES;
  afterEach(() => {
    if (savedProxies === undefined) delete process.env.STANDUP_TRUSTED_PROXIES;
    else process.env.STANDUP_TRUSTED_PROXIES = savedProxies;
  });

  test("a loopback source trusts the header and keeps the host fallback", () => {
    // The default same-host tunnel deployment.
    expect(tunnelHeaderTrust("127.0.0.1")).toEqual({ loopback: true, headerTrusted: true });
    expect(tunnelHeaderTrust("::1")).toEqual({ loopback: true, headerTrusted: true });
  });

  test("an unknown (in-process, no socket) source is treated as loopback", () => {
    expect(tunnelHeaderTrust(undefined)).toEqual({ loopback: true, headerTrusted: true });
    expect(tunnelHeaderTrust(null)).toEqual({ loopback: true, headerTrusted: true });
  });

  test("a raw network source neither trusts the header nor keeps the host fallback", () => {
    // The BIND_HOST=0.0.0.0 attacker: not loopback, not a configured proxy.
    delete process.env.STANDUP_TRUSTED_PROXIES;
    expect(tunnelHeaderTrust("10.0.0.5")).toEqual({ loopback: false, headerTrusted: false });
  });

  test("a configured trusted proxy trusts the header but is not loopback", () => {
    process.env.STANDUP_TRUSTED_PROXIES = "10.0.0.5, 10.0.0.6";
    expect(tunnelHeaderTrust("10.0.0.5")).toEqual({ loopback: false, headerTrusted: true });
    // A different network source is still untrusted.
    expect(tunnelHeaderTrust("10.0.0.9")).toEqual({ loopback: false, headerTrusted: false });
  });

  test("composed with resolveUserAlias, a forged header from a raw network source is dropped", () => {
    // This is exactly what the WS upgrade path does: gate the forgeable header
    // by source, then resolve. A network attacker naming a victim gets anonymous.
    delete process.env.STANDUP_TRUSTED_PROXIES;
    const { loopback, headerTrusted } = tunnelHeaderTrust("203.0.113.7");
    expect(resolveUserAlias("victim", "hostuser", headerTrusted, loopback)).toBe("anonymous");
    // And a header-less network client is not silently attributed to the host.
    expect(resolveUserAlias(undefined, "hostuser", headerTrusted, loopback)).toBe("anonymous");
  });
});

describe("GET /api/whoami", () => {
  function setUp(): { store: Store; app: ReturnType<typeof createServer> } {
    const store = createStore(":memory:");
    return { store, app: createServer(store, () => {}, null) };
  }

  test("reports the tunnel alias, marks tunnel true, and upserts the row", async () => {
    const { store, app } = setUp();
    const res = await app.request("/api/whoami", {
      headers: { [DEFAULT_IDENTITY_HEADER]: "erin" },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as WhoAmI;
    expect(body.user).toBe("erin");
    expect(body.tunnel).toBe(true);
    expect(body.record.alias).toBe("erin");
    // The request recorded the visitor.
    expect(getUser(store.db, "erin")?.alias).toBe("erin");
    store.close();
  });

  test("falls back to the host user and marks tunnel false when the header is absent", async () => {
    const { store, app } = setUp();
    const res = await app.request("/api/whoami");

    expect(res.status).toBe(200);
    const body = (await res.json()) as WhoAmI;
    expect(body.tunnel).toBe(false);
    expect(body.user).toBe(process.env.USER || "local");
    expect(body.record.alias).toBe(body.user);
    store.close();
  });
});
