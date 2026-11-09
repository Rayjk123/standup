import { expect, test, describe } from "bun:test";
import { createStore, getUser } from "@standup/store";
import type { Store } from "@standup/store";
import type { IdentityProviderConfig, WhoAmI } from "@standup/shared";
import { DEFAULT_IDENTITY_HEADER, defaultIdentityConfig, resolveIdentityHeader, tunnelIdentityFromEnv } from "@standup/shared";
import {
  createServer,
  resolveIdentity,
  resolveIdentityConfigFromEnv,
  resolveUserAlias,
  tunnelHeaderTrust,
  ANONYMOUS_ALIAS,
} from "./server.js";
import { disabledTunnelProvider, resolveTunnelProvider, type TunnelProvider } from "./tunnels/provider.js";

/**
 * Pluggable identity provider: the config shape/defaults, the env resolver, the
 * merged resolveIdentity seam, and REST/WS parity. The hard requirement is that
 * the DEFAULT config reproduces the authenticating-tunnel behavior the whoami/
 * scope/write-gate suites already pin, so these tests assert the default path
 * reads the default identity header and only the header + trust knobs are
 * configurable.
 */

/** A header name no default config reads, for the custom-header cases. */
const CUSTOM_HEADER = "x-custom-identity-user";

/** A header lookup over a plain map — how both c.req.header(name) (REST) and
 *  req.headers.get(name) (WS) resolve a header by the configured name. */
function headerGetter(headers: Record<string, string | undefined>) {
  return (name: string) => headers[name];
}

describe("defaultIdentityConfig", () => {
  test("is the authenticating-tunnel instance, reading the default identity header", () => {
    expect(defaultIdentityConfig()).toEqual({
      auth: "none",
      userIdentifier: { type: "http-header", header: DEFAULT_IDENTITY_HEADER },
      trustedProxies: [],
      loopbackIsTrusted: true,
    });
    // The default header is pinned: an install behind a tunnel or proxy that
    // stamps another header names it (STANDUP_TUNNEL_IDENTITY_HEADER or
    // STANDUP_IDENTITY_HEADER), so a change here is a change every other
    // install must follow.
    expect(DEFAULT_IDENTITY_HEADER).toBe("x-tunnel-user");
    expect(DEFAULT_IDENTITY_HEADER).not.toBe(CUSTOM_HEADER);
  });

  test("returns a fresh object each call so a caller can't mutate the shared default", () => {
    const a = defaultIdentityConfig();
    const b = defaultIdentityConfig();
    expect(a).not.toBe(b);
    a.userIdentifier.header = "x-other";
    a.trustedProxies.push("10.0.0.5");
    expect(b.userIdentifier.header).toBe(DEFAULT_IDENTITY_HEADER);
    expect(b.trustedProxies).toEqual([]);
  });
});

describe("resolveIdentityConfigFromEnv", () => {
  test("with no env set, reproduces the default (tunnel) config exactly", () => {
    expect(resolveIdentityConfigFromEnv({})).toEqual(defaultIdentityConfig());
  });

  test("STANDUP_IDENTITY_HEADER overrides the identifier header name", () => {
    const config = resolveIdentityConfigFromEnv({ STANDUP_IDENTITY_HEADER: CUSTOM_HEADER });
    expect(config.userIdentifier).toEqual({ type: "http-header", header: CUSTOM_HEADER });
    // A blank/whitespace override falls back to the default header.
    expect(
      resolveIdentityConfigFromEnv({ STANDUP_IDENTITY_HEADER: "   " }).userIdentifier.header
    ).toBe(DEFAULT_IDENTITY_HEADER);
  });

  test("with no header set, an enabled authenticating tunnel's header is the identifier", () => {
    const tunnel: TunnelProvider = { ...disabledTunnelProvider, id: "command", enabled: true, identityHeader: CUSTOM_HEADER };
    const config = resolveIdentityConfigFromEnv({}, tunnel);
    expect(config.userIdentifier.header).toBe(CUSTOM_HEADER);
    expect(config.loopbackIsTrusted).toBe(true);
    // STANDUP_IDENTITY_HEADER still wins, and a tunnel that doesn't stamp it
    // leaves loopback untrusted.
    const other = resolveIdentityConfigFromEnv({ STANDUP_IDENTITY_HEADER: "x-other-user" }, tunnel);
    expect(other.userIdentifier.header).toBe("x-other-user");
    expect(other.loopbackIsTrusted).toBe(false);
    // A disabled provider's header is never read.
    const disabled = resolveIdentityConfigFromEnv({}, { ...disabledTunnelProvider, identityHeader: CUSTOM_HEADER });
    expect(disabled.userIdentifier.header).toBe(DEFAULT_IDENTITY_HEADER);
  });

  const commandTunnel = {
    STANDUP_TUNNEL_PROVIDER: "command",
    STANDUP_TUNNEL_CREATE: "tunnel-cli open {port} --name {name}",
    STANDUP_TUNNEL_URL: "https://{name}.tunnels.example.com",
  };
  test.each([
    ["only STANDUP_TUNNEL_IDENTITY_HEADER, on an authenticating provider", { ...commandTunnel, STANDUP_TUNNEL_IDENTITY_HEADER: "X-Review-User" }, "x-review-user", true],
    [
      "STANDUP_IDENTITY_HEADER overriding the tunnel's header",
      { ...commandTunnel, STANDUP_TUNNEL_IDENTITY_HEADER: "x-review-user", STANDUP_IDENTITY_HEADER: "x-forwarded-user" },
      "x-forwarded-user",
      false,
    ],
    ["an unauthenticated provider", { ...commandTunnel, STANDUP_TUNNEL_UNAUTHENTICATED: "1" }, DEFAULT_IDENTITY_HEADER, false],
    ["nothing set", {}, DEFAULT_IDENTITY_HEADER, true],
  ] as const)("from env, %s: the console proxy's header, trusted on loopback only when the tunnel vouches", (_label, env: Record<string, string | undefined>, header, loopbackTrusted) => {
    const config = resolveIdentityConfigFromEnv(env);
    expect(config.userIdentifier.header).toBe(header);
    expect(config.loopbackIsTrusted).toBe(loopbackTrusted);
    expect(resolveIdentityHeader(env.STANDUP_IDENTITY_HEADER, tunnelIdentityFromEnv(env))).toBe(header);
  });

  // The console's dev server reads the provider from the environment
  // (tunnelIdentityFromEnv) because it can't resolve the collector's
  // TunnelProvider; on settings whose templates validate, the two agree.
  test.each([
    ["no tunnel settings", {}],
    ["a command tunnel stamping a header", { ...commandTunnel, STANDUP_TUNNEL_IDENTITY_HEADER: " X-Review-User " }],
    ["the provider kind in another case", { ...commandTunnel, STANDUP_TUNNEL_PROVIDER: " Command ", STANDUP_TUNNEL_IDENTITY_HEADER: "x-review-user" }],
    ["an unauthenticated command tunnel", { ...commandTunnel, STANDUP_TUNNEL_UNAUTHENTICATED: "yes" }],
    ["a header and the unauthenticated flag", { ...commandTunnel, STANDUP_TUNNEL_IDENTITY_HEADER: "x-review-user", STANDUP_TUNNEL_UNAUTHENTICATED: "1" }],
    ["a header that is not a header name", { ...commandTunnel, STANDUP_TUNNEL_IDENTITY_HEADER: "x review user" }],
    ["neither a header nor the unauthenticated flag", commandTunnel],
    ["a tunnel header with the provider disabled", { ...commandTunnel, STANDUP_TUNNEL_PROVIDER: "disabled", STANDUP_TUNNEL_IDENTITY_HEADER: "x-review-user" }],
    ["a tunnel header with an unknown provider", { ...commandTunnel, STANDUP_TUNNEL_PROVIDER: "other", STANDUP_TUNNEL_IDENTITY_HEADER: "x-review-user" }],
  ] as const)("from env, %s: the console proxy and the collector pick the same header", (_label, env: Record<string, string | undefined>) => {
    const provider = resolveTunnelProvider(env, () => {});
    const fromEnv = tunnelIdentityFromEnv(env);
    expect(resolveIdentityHeader(env.STANDUP_IDENTITY_HEADER, fromEnv)).toBe(resolveIdentityConfigFromEnv(env, provider).userIdentifier.header);
    if (fromEnv.identityHeader) expect(provider).toMatchObject({ enabled: true, identityHeader: fromEnv.identityHeader });
    else expect(provider.identityHeader).toBeUndefined();
  });

  test("STANDUP_TRUSTED_PROXIES seeds the trusted-proxy list", () => {
    const config = resolveIdentityConfigFromEnv({
      STANDUP_TRUSTED_PROXIES: "10.0.0.5, 10.0.0.6",
    });
    expect(config.trustedProxies).toEqual(["10.0.0.5", "10.0.0.6"]);
  });

  test("STANDUP_IDENTITY_AUTH selects the auth mode; unknown values fall back to none", () => {
    expect(resolveIdentityConfigFromEnv({ STANDUP_IDENTITY_AUTH: "none" }).auth).toBe("none");
    // The only supported mode today is `none`; an unrecognized value must not
    // fail boot — it resolves to `none`.
    expect(resolveIdentityConfigFromEnv({ STANDUP_IDENTITY_AUTH: "oidc" }).auth).toBe("none");
    expect(resolveIdentityConfigFromEnv({}).auth).toBe("none");
  });
});

describe("resolveIdentity", () => {
  const config = defaultIdentityConfig();

  test("a trusted (loopback) header resolves to that user and authenticates", () => {
    // undefined remote address = in-process/loopback, the trusted default.
    const r = resolveIdentity(headerGetter({ [DEFAULT_IDENTITY_HEADER]: "erin" }), undefined, config, "hostuser");
    expect(r).toEqual({ user: "erin", authenticated: true });
  });

  test("trims a whitespace-padded header", () => {
    const r = resolveIdentity(headerGetter({ [DEFAULT_IDENTITY_HEADER]: "  erin  " }), "127.0.0.1", config, "hostuser");
    expect(r).toEqual({ user: "erin", authenticated: true });
  });

  test("a loopback request with no header falls back to the host $USER", () => {
    const r = resolveIdentity(headerGetter({}), "::1", config, "hostuser");
    expect(r).toEqual({ user: "hostuser", authenticated: true });
  });

  test("a network request with no header resolves to anonymous (no user)", () => {
    const r = resolveIdentity(headerGetter({}), "10.0.0.5", config, "hostuser");
    expect(r).toEqual({ user: undefined, authenticated: false });
  });

  test("a forged header from an untrusted network source is ignored (anonymous)", () => {
    const r = resolveIdentity(headerGetter({ [DEFAULT_IDENTITY_HEADER]: "victim" }), "203.0.113.7", config, "hostuser");
    expect(r).toEqual({ user: undefined, authenticated: false });
  });

  test("a configured trusted proxy honors the header", () => {
    const withProxy: IdentityProviderConfig = { ...defaultIdentityConfig(), trustedProxies: ["10.0.0.5"] };
    const trusted = resolveIdentity(headerGetter({ [DEFAULT_IDENTITY_HEADER]: "erin" }), "10.0.0.5", withProxy, "hostuser");
    expect(trusted).toEqual({ user: "erin", authenticated: true });
    // A different network source is still untrusted, and header-less through the
    // proxy is still anonymous (a network request, never the host).
    const other = resolveIdentity(headerGetter({ [DEFAULT_IDENTITY_HEADER]: "erin" }), "10.0.0.9", withProxy, "hostuser");
    expect(other).toEqual({ user: undefined, authenticated: false });
    const headerless = resolveIdentity(headerGetter({}), "10.0.0.5", withProxy, "hostuser");
    expect(headerless).toEqual({ user: undefined, authenticated: false });
  });

  test("a custom header name resolves, and only the configured header is read", () => {
    const custom: IdentityProviderConfig = {
      ...defaultIdentityConfig(),
      userIdentifier: { type: "http-header", header: CUSTOM_HEADER },
    };
    const r = resolveIdentity(
      // A value under the DEFAULT header must be ignored — the provider reads
      // ONLY the configured header, so a stray header can't become the identity.
      headerGetter({ [CUSTOM_HEADER]: "alice", [DEFAULT_IDENTITY_HEADER]: "bob" }),
      undefined,
      custom,
      "hostuser"
    );
    expect(r).toEqual({ user: "alice", authenticated: true });
  });

  test("loopbackIsTrusted=false: a loopback header is untrusted and resolves to anonymous, not the host user", () => {
    // With loopback not trusted and no proxy match, a loopback header is a
    // client-supplied header on an untrusted source: the caller named someone
    // the collector can't verify, so it is neither that user nor the host.
    const noLoopbackTrust: IdentityProviderConfig = { ...defaultIdentityConfig(), loopbackIsTrusted: false };
    expect(
      resolveIdentity(headerGetter({ [DEFAULT_IDENTITY_HEADER]: "erin" }), "127.0.0.1", noLoopbackTrust, "hostuser")
    ).toEqual({ user: undefined, authenticated: false });
    // A header-less loopback request keeps the single-user host default.
    expect(resolveIdentity(headerGetter({}), "127.0.0.1", noLoopbackTrust, "hostuser")).toEqual({
      user: "hostuser",
      authenticated: true,
    });
    // A configured trusted proxy is still read.
    const viaProxy: IdentityProviderConfig = { ...noLoopbackTrust, trustedProxies: ["10.0.0.5"] };
    expect(
      resolveIdentity(headerGetter({ [DEFAULT_IDENTITY_HEADER]: "erin" }), "10.0.0.5", viaProxy, "hostuser")
    ).toEqual({ user: "erin", authenticated: true });
  });
});

describe("an unauthenticated tunnel provider", () => {
  // A command tunnel whose service authenticates no one forwards anyone's
  // request to loopback, with whatever identity header the client set.
  const open: TunnelProvider = resolveTunnelProvider(
    {
      STANDUP_TUNNEL_PROVIDER: "command",
      STANDUP_TUNNEL_CREATE: "tunnel-cli serve --port {port} --name {name}",
      STANDUP_TUNNEL_URL: "https://{name}.tunnels.example.com",
      STANDUP_TUNNEL_UNAUTHENTICATED: "1",
    },
    () => {}
  );
  const config = resolveIdentityConfigFromEnv({}, open);

  test("the provider resolves enabled and unauthenticated", () => {
    expect(open.enabled).toBe(true);
    expect(open.identityHeader).toBeUndefined();
    expect(config.loopbackIsTrusted).toBe(false);
  });

  const cases: Array<{ name: string; addr: string | undefined; headers: Record<string, string | undefined>; user: string | undefined }> = [
    { name: "a loopback request naming a user", addr: "127.0.0.1", headers: { [DEFAULT_IDENTITY_HEADER]: "mallory" }, user: undefined },
    { name: "a loopback request naming the host user", addr: "127.0.0.1", headers: { [DEFAULT_IDENTITY_HEADER]: "hostuser" }, user: undefined },
    { name: "an in-process request naming a user", addr: undefined, headers: { [DEFAULT_IDENTITY_HEADER]: "mallory" }, user: undefined },
    { name: "a whitespace-only header on loopback", addr: "127.0.0.1", headers: { [DEFAULT_IDENTITY_HEADER]: "   " }, user: "hostuser" },
    { name: "a header-less loopback request", addr: "127.0.0.1", headers: {}, user: "hostuser" },
    { name: "a raw network request naming a user", addr: "203.0.113.7", headers: { [DEFAULT_IDENTITY_HEADER]: "mallory" }, user: undefined },
  ];
  for (const { name, addr, headers, user } of cases) {
    test(`${name} resolves to ${user ?? "anonymous"}`, () => {
      const r = resolveIdentity(headerGetter(headers), addr, config, "hostuser");
      expect(r).toEqual({ user, authenticated: user !== undefined });
      expect(resolveUserAlias(headers[DEFAULT_IDENTITY_HEADER], "hostuser", tunnelHeaderTrust(addr, config).headerTrusted, tunnelHeaderTrust(addr, config).loopback)).toBe(
        user ?? ANONYMOUS_ALIAS
      );
    });
  }

  test("an authenticating provider stamping the header still honors it on loopback", () => {
    const authenticated = resolveTunnelProvider(
      {
        STANDUP_TUNNEL_PROVIDER: "command",
        STANDUP_TUNNEL_CREATE: "tunnel-cli serve --port {port} --name {name}",
        STANDUP_TUNNEL_URL: "https://{name}.tunnels.example.com",
        STANDUP_TUNNEL_IDENTITY_HEADER: "x-stamped-user",
      },
      () => {}
    );
    const stamped = resolveIdentityConfigFromEnv({}, authenticated);
    expect(stamped.userIdentifier.header).toBe("x-stamped-user");
    expect(resolveIdentity(headerGetter({ "x-stamped-user": "bob" }), "127.0.0.1", stamped, "hostuser")).toEqual({
      user: "bob",
      authenticated: true,
    });
  });
});

describe("tunnelHeaderTrust honors the identity config", () => {
  const cases: Array<{ name: string; addr: string | undefined; config: Pick<IdentityProviderConfig, "loopbackIsTrusted" | "trustedProxies">; expected: { loopback: boolean; headerTrusted: boolean } }> = [
    { name: "loopback, trusted", addr: "127.0.0.1", config: { loopbackIsTrusted: true, trustedProxies: [] }, expected: { loopback: true, headerTrusted: true } },
    { name: "loopback, untrusted", addr: "127.0.0.1", config: { loopbackIsTrusted: false, trustedProxies: [] }, expected: { loopback: true, headerTrusted: false } },
    { name: "no socket, untrusted", addr: undefined, config: { loopbackIsTrusted: false, trustedProxies: [] }, expected: { loopback: true, headerTrusted: false } },
    { name: "trusted proxy, loopback untrusted", addr: " 10.0.0.5 ", config: { loopbackIsTrusted: false, trustedProxies: ["10.0.0.5"] }, expected: { loopback: false, headerTrusted: true } },
    { name: "raw network source", addr: "10.0.0.9", config: { loopbackIsTrusted: true, trustedProxies: ["10.0.0.5"] }, expected: { loopback: false, headerTrusted: false } },
  ];
  for (const { name, addr, config, expected } of cases) {
    test(name, () => {
      expect(tunnelHeaderTrust(addr, config)).toEqual(expected);
    });
  }

  test("with no config it applies the one resolved from the environment", () => {
    expect(tunnelHeaderTrust("127.0.0.1")).toEqual(tunnelHeaderTrust("127.0.0.1", resolveIdentityConfigFromEnv()));
  });
});

describe("REST/WS parity", () => {
  // Both the /api path (actingAlias) and the WS upgrade path (ws.ts) funnel
  // through resolveIdentity with the SAME config, so the same request resolves
  // to the same alias on either channel — the guarantee that they can't drift.
  const config = defaultIdentityConfig();
  const cases: Array<{ addr: string | undefined; headers: Record<string, string | undefined> }> = [
    { addr: undefined, headers: { [DEFAULT_IDENTITY_HEADER]: "erin" } },
    { addr: "127.0.0.1", headers: {} },
    { addr: "10.0.0.5", headers: { [DEFAULT_IDENTITY_HEADER]: "victim" } },
    { addr: "203.0.113.7", headers: {} },
  ];

  test("the same config + request resolves identically whether fetched REST- or WS-style", () => {
    for (const { addr, headers } of cases) {
      // A REST-style getter (Hono c.req.header) and a WS-style getter
      // (req.headers.get) over the same header map must agree.
      const rest = resolveIdentity(headerGetter(headers), addr, config, "hostuser");
      const ws = resolveIdentity((name) => headers[name] ?? null, addr, config, "hostuser");
      expect(ws).toEqual(rest);
    }
  });

  test("resolveIdentity(default config) reproduces the tunnelHeaderTrust + resolveUserAlias composition", () => {
    for (const { addr, headers } of cases) {
      const { loopback, headerTrusted } = tunnelHeaderTrust(addr);
      const composedAlias = resolveUserAlias(headers[DEFAULT_IDENTITY_HEADER], "hostuser", headerTrusted, loopback);
      const composedUser = composedAlias === ANONYMOUS_ALIAS ? undefined : composedAlias;
      const merged = resolveIdentity(headerGetter(headers), addr, config, "hostuser");
      expect(merged.user).toBe(composedUser);
      expect(merged.authenticated).toBe(composedAlias !== ANONYMOUS_ALIAS);
    }
  });
});

describe("createServer honors the identity config (REST path)", () => {
  function serverWithConfig(store: Store, config: IdentityProviderConfig) {
    return createServer(
      store,
      () => {}, // broadcast
      null, // embeddingProvider
      undefined, // knowledgeSync
      undefined, // registry
      "", // knowledgeDir
      "", // iconsDir
      {}, // embeddingConfig
      undefined, // autoReviewDeps
      undefined, // tailer
      undefined, // launchFn -> default
      config
    );
  }

  test("with a custom header, /api/whoami reads the configured header and ignores the default one", async () => {
    const store = createStore(":memory:");
    const app = serverWithConfig(store, {
      ...defaultIdentityConfig(),
      userIdentifier: { type: "http-header", header: CUSTOM_HEADER },
    });
    const res = await app.request("/api/whoami", {
      // The custom header carries identity; a value under the default header
      // is a stray header the provider must not read.
      headers: { [CUSTOM_HEADER]: "alice", [DEFAULT_IDENTITY_HEADER]: "bob" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as WhoAmI;
    expect(body.user).toBe("alice");
    expect(body.tunnel).toBe(true);
    expect(getUser(store.db, "alice")?.alias).toBe("alice");
    // The default-header value never became an identity.
    expect(getUser(store.db, "bob")).toBeNull();
    store.close();
  });

  test("with the default config, /api/whoami reads the default identity header", async () => {
    const store = createStore(":memory:");
    const app = serverWithConfig(store, defaultIdentityConfig());
    const res = await app.request("/api/whoami", {
      headers: { [DEFAULT_IDENTITY_HEADER]: "erin" },
    });
    const body = (await res.json()) as WhoAmI;
    expect(body.user).toBe("erin");
    expect(body.tunnel).toBe(true);
    store.close();
  });
});
