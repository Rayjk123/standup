import { describe, expect, test } from "bun:test";
import { DEFAULT_IDENTITY_HEADER } from "@standup/shared/constants";
import { OWNER_TOKEN_HEADER, PERSONA_USER_HEADER, USER_CHANNEL_HEADER, userChannelToken } from "@standup/shared/owner-token";
import {
  LOGIN_CODE_TTL_SECONDS,
  LOGIN_PATH,
  SESSION_COOKIE,
  USER_SESSION_COOKIE,
  applyOwnerToken,
  dropSameOriginOrigin,
  identityHeaderName,
  isSameOrigin,
  isValidAlias,
  loginMiddleware,
  loginUrl,
  mintLoginCode,
  mintSessionValue,
  mintUserLoginCode,
  mintUserSessionValue,
  ownerTokenProxyConfigure,
  ownerTokenWsProxyConfigure,
  isConsoleHost,
  parseConsoleLoginArgs,
  upgradeTokensFor,
  readCookie,
  sessionCookieHeader,
  userChannelTokenFor,
  userLoginUrl,
  userSessionCookieHeader,
  verifyLoginCode,
  verifySessionValue,
  verifyUserLoginCode,
  verifyUserSessionValue,
  type IncomingRequest,
  type LoginResponse,
  type ProxiedRequest,
} from "./owner-proxy";

/**
 * The console's dev-server proxy as an owner channel: the owner token goes only
 * to a signed-in browser (and, for state-changing calls, a same-origin one), is
 * re-read per request, and a client-sent header is stripped otherwise.
 */

const TOKEN = "t".repeat(64);
const OTHER = "u".repeat(64);
const NOW = 1_700_000_000_000;

function fakeRequest(initial: Record<string, string> = {}): ProxiedRequest & { headers: Record<string, string> } {
  const headers = { ...initial };
  return {
    headers,
    setHeader: (name, value) => {
      headers[name] = value;
    },
    removeHeader: (name) => {
      delete headers[name];
    },
  };
}

function incoming(method: string, headers: IncomingRequest["headers"] = {}): IncomingRequest {
  return { method, headers: { host: "localhost:5173", ...headers } };
}

function forwardAll(token: string | undefined, req: IncomingRequest): Record<string, string> {
  let listener: ((proxyReq: ProxiedRequest, req: IncomingRequest) => void) | undefined;
  ownerTokenProxyConfigure(() => token, DEFAULT_IDENTITY_HEADER)({ on: (_event, l) => (listener = l) });
  const out = fakeRequest({
    [OWNER_TOKEN_HEADER]: "forged-by-browser",
    [USER_CHANNEL_HEADER]: "forged-by-browser",
    [PERSONA_USER_HEADER]: "forged-by-browser",
  });
  listener!(out, req);
  return out.headers;
}

function forward(token: string | undefined, req: IncomingRequest): string | undefined {
  return forwardAll(token, req)[OWNER_TOKEN_HEADER];
}

describe("login codes", () => {
  test("a fresh code verifies", () => {
    expect(verifyLoginCode(TOKEN, mintLoginCode(TOKEN, NOW), NOW)).toBe(true);
  });

  test("a code expires after its TTL", () => {
    const code = mintLoginCode(TOKEN, NOW);
    expect(verifyLoginCode(TOKEN, code, NOW + (LOGIN_CODE_TTL_SECONDS - 1) * 1000)).toBe(true);
    expect(verifyLoginCode(TOKEN, code, NOW + (LOGIN_CODE_TTL_SECONDS + 1) * 1000)).toBe(false);
  });

  test("a code minted with another key, or with a forged expiry, is rejected", () => {
    expect(verifyLoginCode(TOKEN, mintLoginCode(OTHER, NOW), NOW)).toBe(false);
    const [expiry, mac] = mintLoginCode(TOKEN, NOW).split(".");
    expect(verifyLoginCode(TOKEN, `${Number(expiry) + 3600}.${mac}`, NOW)).toBe(false);
  });

  test("malformed codes are rejected", () => {
    for (const code of [undefined, null, "", "abc", ".abc", "12.", "x.y"]) expect(verifyLoginCode(TOKEN, code, NOW)).toBe(false);
  });

  test("the login URL carries a verifiable code", () => {
    const url = new URL(loginUrl(TOKEN, "http://localhost:5173", NOW));
    expect(url.pathname).toBe(LOGIN_PATH);
    expect(verifyLoginCode(TOKEN, url.searchParams.get("code"), NOW)).toBe(true);
  });
});

describe("session cookie", () => {
  test("a minted value verifies only under the same key", () => {
    const value = mintSessionValue(TOKEN);
    expect(verifySessionValue(TOKEN, value)).toBe(true);
    expect(verifySessionValue(OTHER, value)).toBe(false);
  });

  test("tampered or malformed values are rejected", () => {
    const [id, mac] = mintSessionValue(TOKEN).split(".");
    expect(verifySessionValue(TOKEN, `other-id.${mac}`)).toBe(false);
    expect(verifySessionValue(TOKEN, `${id}.`)).toBe(false);
    for (const value of [undefined, "", "nodot", ".mac"]) expect(verifySessionValue(TOKEN, value)).toBe(false);
  });

  test("a code is not a session value", () => {
    expect(verifySessionValue(TOKEN, mintLoginCode(TOKEN, NOW))).toBe(false);
  });

  test("the cookie header is HttpOnly, SameSite=Strict, site-wide, 30 days", () => {
    const header = sessionCookieHeader("v");
    expect(header).toBe(`${SESSION_COOKIE}=v; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`);
  });

  test("readCookie finds a cookie among several", () => {
    expect(readCookie("a=1; standup_owner=xyz; b=2", SESSION_COOKIE)).toBe("xyz");
    expect(readCookie("a=1", SESSION_COOKIE)).toBeUndefined();
    expect(readCookie(undefined, SESSION_COOKIE)).toBeUndefined();
  });
});

describe("owner-token injection", () => {
  const cookie = `${SESSION_COOKIE}=${mintSessionValue(TOKEN)}`;

  test("no cookie: no header, and a client-sent header is stripped", () => {
    expect(forward(TOKEN, incoming("GET"))).toBeUndefined();
  });

  test("a cookie signed with a different key: no header", () => {
    expect(forward(TOKEN, incoming("GET", { cookie: `${SESSION_COOKIE}=${mintSessionValue(OTHER)}` }))).toBeUndefined();
  });

  test("valid cookie on a GET: header set", () => {
    expect(forward(TOKEN, incoming("GET", { cookie }))).toBe(TOKEN);
  });

  test("valid cookie on a cross-origin POST: no header", () => {
    expect(forward(TOKEN, incoming("POST", { cookie, origin: "http://evil.example" }))).toBeUndefined();
    expect(forward(TOKEN, incoming("POST", { cookie, "sec-fetch-site": "cross-site" }))).toBeUndefined();
    expect(forward(TOKEN, incoming("POST", { cookie }))).toBeUndefined();
  });

  test("valid cookie on a same-origin POST: header set", () => {
    expect(forward(TOKEN, incoming("POST", { cookie, origin: "http://localhost:5173" }))).toBe(TOKEN);
    expect(forward(TOKEN, incoming("DELETE", { cookie, "sec-fetch-site": "same-origin" }))).toBe(TOKEN);
  });

  test("the token file is read per request and may be absent", () => {
    expect(forward(undefined, incoming("GET", { cookie }))).toBeUndefined();
    expect(forward(TOKEN, incoming("GET", { cookie }))).toBe(TOKEN);
  });

  test("applyOwnerToken sets or strips", () => {
    const req = fakeRequest();
    applyOwnerToken(req, "abc");
    expect(req.headers[OWNER_TOKEN_HEADER]).toBe("abc");
    applyOwnerToken(req, undefined);
    expect(req.headers[OWNER_TOKEN_HEADER]).toBeUndefined();
  });
});

describe("user login codes", () => {
  test("a fresh code verifies to its alias, including dotted aliases", () => {
    expect(verifyUserLoginCode(TOKEN, mintUserLoginCode(TOKEN, "alice", NOW), NOW)).toBe("alice");
    expect(verifyUserLoginCode(TOKEN, mintUserLoginCode(TOKEN, "a.b-c_d", NOW), NOW)).toBe("a.b-c_d");
  });

  test("the code is <expiry>.<alias>.<hmac>", () => {
    const code = mintUserLoginCode(TOKEN, "alice", NOW);
    expect(code).toMatch(new RegExp(`^${NOW / 1000 + LOGIN_CODE_TTL_SECONDS}\\.alice\\.[0-9a-f]{64}$`));
  });

  test("a code expires after its TTL", () => {
    const code = mintUserLoginCode(TOKEN, "alice", NOW);
    expect(verifyUserLoginCode(TOKEN, code, NOW + (LOGIN_CODE_TTL_SECONDS - 1) * 1000)).toBe("alice");
    expect(verifyUserLoginCode(TOKEN, code, NOW + (LOGIN_CODE_TTL_SECONDS + 1) * 1000)).toBeUndefined();
  });

  test("another key, a swapped alias or a forged expiry is rejected", () => {
    expect(verifyUserLoginCode(TOKEN, mintUserLoginCode(OTHER, "alice", NOW), NOW)).toBeUndefined();
    const [expiry, , mac] = mintUserLoginCode(TOKEN, "alice", NOW).split(".");
    expect(verifyUserLoginCode(TOKEN, `${expiry}.mallory.${mac}`, NOW)).toBeUndefined();
    expect(verifyUserLoginCode(TOKEN, `${Number(expiry) + 3600}.alice.${mac}`, NOW)).toBeUndefined();
  });

  test("owner and user codes are not interchangeable", () => {
    expect(verifyUserLoginCode(TOKEN, mintLoginCode(TOKEN, NOW), NOW)).toBeUndefined();
    expect(verifyLoginCode(TOKEN, mintUserLoginCode(TOKEN, "alice", NOW), NOW)).toBe(false);
  });

  test("malformed codes and invalid aliases are rejected", () => {
    for (const code of [undefined, null, "", "abc", "1..mac", ".alice.mac", "x.alice.mac", "9999999999.al ice.mac", "9999999999.al/ce.mac"]) {
      expect(verifyUserLoginCode(TOKEN, code, NOW)).toBeUndefined();
    }
    for (const alias of ["", "al ice", "a/b", "a:b", "ä"]) {
      expect(isValidAlias(alias)).toBe(false);
      expect(() => mintUserLoginCode(TOKEN, alias, NOW)).toThrow();
    }
  });

  test("the user login URL carries a verifiable code on the login path", () => {
    const url = new URL(userLoginUrl(TOKEN, "alice", "http://localhost:5173", NOW));
    expect(url.pathname).toBe(LOGIN_PATH);
    expect(verifyUserLoginCode(TOKEN, url.searchParams.get("code"), NOW)).toBe("alice");
  });
});

describe("console-login arguments", () => {
  test("no arguments: owner mode", () => {
    expect(parseConsoleLoginArgs([])).toEqual({});
  });

  test("--user <alias> and --user=<alias> name the user", () => {
    expect(parseConsoleLoginArgs(["--user", "bob"])).toEqual({ user: "bob" });
    expect(parseConsoleLoginArgs(["--user=bob"])).toEqual({ user: "bob" });
    expect(parseConsoleLoginArgs(["--user", "a.b-c_d"])).toEqual({ user: "a.b-c_d" });
  });

  test("an invalid alias is an error", () => {
    expect(parseConsoleLoginArgs(["--user", "bad alias"])).toHaveProperty("error");
    expect(parseConsoleLoginArgs(["--user=a/b"])).toHaveProperty("error");
  });

  test("a missing value is an error", () => {
    expect(parseConsoleLoginArgs(["--user"])).toHaveProperty("error");
    expect(parseConsoleLoginArgs(["--user", "--verbose"])).toHaveProperty("error");
    expect(parseConsoleLoginArgs(["--user="])).toHaveProperty("error");
  });
});

describe("user session cookie", () => {
  test("a minted value verifies to its alias only under the same key", () => {
    expect(verifyUserSessionValue(TOKEN, mintUserSessionValue(TOKEN, "alice"))).toBe("alice");
    expect(verifyUserSessionValue(TOKEN, mintUserSessionValue(TOKEN, "a.b"))).toBe("a.b");
    expect(verifyUserSessionValue(OTHER, mintUserSessionValue(TOKEN, "alice"))).toBeUndefined();
  });

  test("a swapped alias, tampered or malformed value is rejected", () => {
    const [, id, mac] = mintUserSessionValue(TOKEN, "alice").split(".");
    expect(verifyUserSessionValue(TOKEN, `mallory.${id}.${mac}`)).toBeUndefined();
    expect(verifyUserSessionValue(TOKEN, `alice.other.${mac}`)).toBeUndefined();
    for (const value of [undefined, "", "nodot", "alice.mac", "alice..mac", ".id.mac"]) {
      expect(verifyUserSessionValue(TOKEN, value)).toBeUndefined();
    }
  });

  test("an owner session value is not a user session, and vice versa", () => {
    expect(verifyUserSessionValue(TOKEN, mintSessionValue(TOKEN))).toBeUndefined();
    expect(verifySessionValue(TOKEN, mintUserSessionValue(TOKEN, "alice"))).toBe(false);
  });

  test("the cookie header is HttpOnly, SameSite=Lax, site-wide, 30 days", () => {
    expect(userSessionCookieHeader("v")).toBe(`${USER_SESSION_COOKIE}=v; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`);
  });
});

describe("user channel injection", () => {
  const cookie = `${USER_SESSION_COOKIE}=${mintUserSessionValue(TOKEN, "alice")}`;
  const expected = userChannelToken(TOKEN, "alice");
  const tunnel = (alias: string) => ({ [DEFAULT_IDENTITY_HEADER]: alias });

  test("valid cookie matching the tunnel identity on a GET: user token set, no owner token", () => {
    const out = forwardAll(TOKEN, incoming("GET", { cookie, ...tunnel("alice") }));
    expect(out[USER_CHANNEL_HEADER]).toBe(expected);
    expect(out[OWNER_TOKEN_HEADER]).toBeUndefined();
    expect(out[PERSONA_USER_HEADER]).toBeUndefined();
  });

  test("no cookie: client-sent user, persona-user and owner headers are all stripped", () => {
    const out = forwardAll(TOKEN, incoming("GET", tunnel("alice")));
    expect(out[USER_CHANNEL_HEADER]).toBeUndefined();
    expect(out[PERSONA_USER_HEADER]).toBeUndefined();
    expect(out[OWNER_TOKEN_HEADER]).toBeUndefined();
  });

  test("the cookie's alias must equal the tunnel identity", () => {
    expect(forwardAll(TOKEN, incoming("GET", { cookie, ...tunnel("bob") }))[USER_CHANNEL_HEADER]).toBeUndefined();
    expect(forwardAll(TOKEN, incoming("GET", { cookie }))[USER_CHANNEL_HEADER]).toBeUndefined();
  });

  test("a cookie signed with another key: no user token", () => {
    const forged = `${USER_SESSION_COOKIE}=${mintUserSessionValue(OTHER, "alice")}`;
    expect(forwardAll(TOKEN, incoming("GET", { cookie: forged, ...tunnel("alice") }))[USER_CHANNEL_HEADER]).toBeUndefined();
  });

  test("state-changing calls must be same-origin", () => {
    expect(forwardAll(TOKEN, incoming("POST", { cookie, ...tunnel("alice") }))[USER_CHANNEL_HEADER]).toBeUndefined();
    expect(
      forwardAll(TOKEN, incoming("POST", { cookie, ...tunnel("alice"), origin: "http://evil.example" }))[USER_CHANNEL_HEADER],
    ).toBeUndefined();
    expect(
      forwardAll(TOKEN, incoming("POST", { cookie, ...tunnel("alice"), origin: "http://localhost:5173" }))[USER_CHANNEL_HEADER],
    ).toBe(expected);
    expect(
      forwardAll(TOKEN, incoming("PUT", { cookie, ...tunnel("alice"), "sec-fetch-site": "same-origin" }))[USER_CHANNEL_HEADER],
    ).toBe(expected);
  });

  test("no token file: no user token", () => {
    expect(forwardAll(undefined, incoming("GET", { cookie, ...tunnel("alice") }))[USER_CHANNEL_HEADER]).toBeUndefined();
  });

  test("the owner cookie path is unaffected by a user cookie alongside it", () => {
    const both = `${SESSION_COOKIE}=${mintSessionValue(TOKEN)}; ${cookie}`;
    const out = forwardAll(TOKEN, incoming("GET", { cookie: both, ...tunnel("alice") }));
    expect(out[OWNER_TOKEN_HEADER]).toBe(TOKEN);
    expect(out[USER_CHANNEL_HEADER]).toBe(expected);
  });

  test("the identity header name follows STANDUP_IDENTITY_HEADER", () => {
    expect(identityHeaderName({})).toBe(DEFAULT_IDENTITY_HEADER);
    expect(identityHeaderName({ STANDUP_IDENTITY_HEADER: " X-Forwarded-User " })).toBe("x-forwarded-user");
    expect(userChannelTokenFor(TOKEN, incoming("GET", { cookie, "x-forwarded-user": "alice" }), "x-forwarded-user")).toBe(expected);
    expect(userChannelTokenFor(TOKEN, incoming("GET", { cookie, ...tunnel("alice") }), "x-forwarded-user")).toBeUndefined();
  });

  const commandTunnel = { STANDUP_TUNNEL_PROVIDER: "command", STANDUP_TUNNEL_IDENTITY_HEADER: "X-Review-User" };
  test.each([
    ["no settings: the default header", {}, DEFAULT_IDENTITY_HEADER],
    ["an authenticating command tunnel: the header it stamps", commandTunnel, "x-review-user"],
    ["STANDUP_IDENTITY_HEADER over the tunnel's header", { ...commandTunnel, STANDUP_IDENTITY_HEADER: "x-forwarded-user" }, "x-forwarded-user"],
    ["an unauthenticated tunnel: the default header", { STANDUP_TUNNEL_PROVIDER: "command", STANDUP_TUNNEL_UNAUTHENTICATED: "1" }, DEFAULT_IDENTITY_HEADER],
    ["a tunnel header with the unauthenticated flag too: the default header", { ...commandTunnel, STANDUP_TUNNEL_UNAUTHENTICATED: "1" }, DEFAULT_IDENTITY_HEADER],
    ["a disabled provider's header: the default header", { STANDUP_TUNNEL_IDENTITY_HEADER: "x-review-user" }, DEFAULT_IDENTITY_HEADER],
  ] as const)("identity header name with %s", (_label, env, header) => {
    expect(identityHeaderName(env)).toBe(header);
  });

  test("behind a command tunnel that stamps its own header, the proxy forwards the user token on that header", () => {
    const header = identityHeaderName(commandTunnel);
    let listener: ((proxyReq: ProxiedRequest, req: IncomingRequest) => void) | undefined;
    ownerTokenProxyConfigure(() => TOKEN, header)({ on: (_event, l) => (listener = l) });
    const forward = (req: IncomingRequest) => {
      const proxyReq = fakeRequest();
      listener!(proxyReq, req);
      return proxyReq.headers;
    };
    expect(forward(incoming("GET", { cookie, "x-review-user": "alice" }))[USER_CHANNEL_HEADER]).toBe(expected);
    expect(forward(incoming("GET", { cookie, ...tunnel("alice") }))[USER_CHANNEL_HEADER]).toBeUndefined();
  });
});

describe("WebSocket upgrade channel tokens", () => {
  const ownerCookie = `${SESSION_COOKIE}=${mintSessionValue(TOKEN)}`;
  const userCookie = `${USER_SESSION_COOKIE}=${mintUserSessionValue(TOKEN, "alice")}`;
  const sameOrigin = { origin: "http://localhost:5173" };
  const upgrade = (headers: IncomingRequest["headers"]) => incoming("GET", headers);

  function forwardUpgrade(token: string | undefined, req: IncomingRequest): Record<string, string> {
    let listener: ((proxyReq: ProxiedRequest, req: IncomingRequest) => void) | undefined;
    let event: string | undefined;
    ownerTokenWsProxyConfigure(() => token, DEFAULT_IDENTITY_HEADER)({
      on: (e, l) => {
        event = e;
        listener = l;
      },
    });
    expect(event).toBe("proxyReqWs");
    const out = fakeRequest({
      [OWNER_TOKEN_HEADER]: "forged-by-browser",
      [USER_CHANNEL_HEADER]: "forged-by-browser",
      [PERSONA_USER_HEADER]: "forged-by-browser",
    });
    listener!(out, req);
    return out.headers;
  }

  test("an owner cookie on a same-origin upgrade carries the owner token", () => {
    expect(upgradeTokensFor(TOKEN, upgrade({ cookie: ownerCookie, ...sameOrigin }), DEFAULT_IDENTITY_HEADER)).toEqual({ owner: TOKEN });
    const out = forwardUpgrade(TOKEN, upgrade({ cookie: ownerCookie, ...sameOrigin }));
    expect(out[OWNER_TOKEN_HEADER]).toBe(TOKEN);
    expect(out[USER_CHANNEL_HEADER]).toBeUndefined();
    expect(out[PERSONA_USER_HEADER]).toBeUndefined();
  });

  test("a user cookie carries the user token only when its alias is the tunnel identity", () => {
    const expected = userChannelToken(TOKEN, "alice");
    expect(
      upgradeTokensFor(TOKEN, upgrade({ cookie: userCookie, [DEFAULT_IDENTITY_HEADER]: "alice", ...sameOrigin }), DEFAULT_IDENTITY_HEADER),
    ).toEqual({ user: expected });
    expect(
      upgradeTokensFor(TOKEN, upgrade({ cookie: userCookie, [DEFAULT_IDENTITY_HEADER]: "bob", ...sameOrigin }), DEFAULT_IDENTITY_HEADER),
    ).toEqual({});
    expect(upgradeTokensFor(TOKEN, upgrade({ cookie: userCookie, ...sameOrigin }), DEFAULT_IDENTITY_HEADER)).toEqual({});
    const out = forwardUpgrade(TOKEN, upgrade({ cookie: userCookie, [DEFAULT_IDENTITY_HEADER]: "alice", ...sameOrigin }));
    expect(out[USER_CHANNEL_HEADER]).toBe(expected);
    expect(out[OWNER_TOKEN_HEADER]).toBeUndefined();
  });

  test("an upgrade from another origin, or naming none, gets no token", () => {
    const both = `${ownerCookie}; ${userCookie}`;
    for (const headers of [
      { cookie: both, [DEFAULT_IDENTITY_HEADER]: "alice", origin: "http://evil.example" },
      { cookie: both, [DEFAULT_IDENTITY_HEADER]: "alice" },
      { cookie: both, [DEFAULT_IDENTITY_HEADER]: "alice", origin: "not a url" },
    ]) {
      expect(upgradeTokensFor(TOKEN, upgrade(headers), DEFAULT_IDENTITY_HEADER)).toEqual({});
      const out = forwardUpgrade(TOKEN, upgrade(headers));
      expect(out[OWNER_TOKEN_HEADER]).toBeUndefined();
      expect(out[USER_CHANNEL_HEADER]).toBeUndefined();
      expect(out[PERSONA_USER_HEADER]).toBeUndefined();
    }
    expect(
      upgradeTokensFor(TOKEN, upgrade({ cookie: ownerCookie, "sec-fetch-site": "same-origin" }), DEFAULT_IDENTITY_HEADER),
    ).toEqual({ owner: TOKEN });
  });

  test("the console's own page loses its Origin, which the collector can't match once Host is rewritten; another origin keeps it", () => {
    const forwardOrigin = (
      configure: typeof ownerTokenProxyConfigure | typeof ownerTokenWsProxyConfigure,
      origin: string,
      host = "localhost:5173",
    ) => {
      let listener: ((proxyReq: ProxiedRequest, req: IncomingRequest) => void) | undefined;
      configure(() => TOKEN, DEFAULT_IDENTITY_HEADER)({ on: (_e: string, l: typeof listener) => (listener = l) } as never);
      const out = fakeRequest({ origin });
      listener!(out, upgrade({ origin, host }));
      return out.headers.origin;
    };
    /** The Sec-Fetch-Site forwarded for a browser-marked same-origin request under `host`. */
    const forwardSite = (configure: typeof ownerTokenProxyConfigure | typeof ownerTokenWsProxyConfigure, host: string) => {
      let listener: ((proxyReq: ProxiedRequest, req: IncomingRequest) => void) | undefined;
      configure(() => TOKEN, DEFAULT_IDENTITY_HEADER)({ on: (_e: string, l: typeof listener) => (listener = l) } as never);
      const origin = `http://${host}`;
      const out = fakeRequest({ origin, "sec-fetch-site": "same-origin" });
      listener!(out, upgrade({ origin, host, "sec-fetch-site": "same-origin" }));
      return { site: out.headers["sec-fetch-site"], origin: out.headers.origin };
    };
    for (const configure of [ownerTokenProxyConfigure, ownerTokenWsProxyConfigure]) {
      // A rebinding page's same-origin is its own: the guard must judge its Origin instead.
      expect(forwardSite(configure, "evil.example:5173")).toEqual({ site: undefined, origin: "http://evil.example:5173" });
      expect(forwardSite(configure, "localhost:5173")).toEqual({ site: "same-origin", origin: undefined });
    }
    const prev = process.env.STANDUP_WEB_URL;
    process.env.STANDUP_WEB_URL = "https://owner.tunnel.example";
    try {
      for (const configure of [ownerTokenProxyConfigure, ownerTokenWsProxyConfigure]) {
        expect(forwardOrigin(configure, "http://localhost:5173")).toBeUndefined();
        expect(forwardOrigin(configure, "http://127.0.0.1:5173", "127.0.0.1:5173")).toBeUndefined();
        expect(forwardOrigin(configure, "https://owner.tunnel.example", "owner.tunnel.example")).toBeUndefined();
        expect(forwardOrigin(configure, "http://evil.example")).toBe("http://evil.example");
        expect(forwardOrigin(configure, "http://localhost:3000")).toBe("http://localhost:3000");
        // A page whose DNS name rebinds here is same-origin with itself, but not the console.
        expect(forwardOrigin(configure, "http://evil.example:5173", "evil.example:5173")).toBe("http://evil.example:5173");
      }
    } finally {
      if (prev === undefined) delete process.env.STANDUP_WEB_URL;
      else process.env.STANDUP_WEB_URL = prev;
    }
  });

  test("the console's page through a tunnel is same-origin by its forwarded host", () => {
    // The tunnel dials localhost:5173 and names the public host in X-Forwarded-Host;
    // Chromium sends no Sec-Fetch-Site on a WebSocket upgrade.
    const tunnel = {
      host: "localhost:5173",
      upgrade: "websocket",
      origin: "https://owner-standup.tunnels.example",
      "x-forwarded-host": "owner-standup.tunnels.example",
    };
    expect(isSameOrigin(tunnel)).toBe(true);
    // Only a proxy can set the forwarded host on an upgrade; a fetch can set it but can't claim to be one.
    expect(isSameOrigin({ ...tunnel, upgrade: undefined })).toBe(false);
    expect(isSameOrigin({ ...tunnel, upgrade: undefined, origin: "http://localhost:3000", "x-forwarded-host": "localhost:3000" })).toBe(false);
    expect(isSameOrigin({ ...tunnel, "x-forwarded-host": "Owner-Standup.Tunnels.Example" })).toBe(true);
    expect(upgradeTokensFor(TOKEN, upgrade({ cookie: ownerCookie, ...tunnel }), DEFAULT_IDENTITY_HEADER)).toEqual({ owner: TOKEN });
    const out = fakeRequest({ origin: tunnel.origin });
    dropSameOriginOrigin(out, upgrade(tunnel));
    expect(out.headers.origin).toBeUndefined();
    for (const headers of [
      { ...tunnel, origin: "https://evil.example" },
      { ...tunnel, "x-forwarded-host": "evil.example" },
      { ...tunnel, "x-forwarded-host": "evil.example, owner-standup.tunnels.example" },
      { ...tunnel, "x-forwarded-host": undefined },
    ]) {
      expect(isSameOrigin(headers)).toBe(false);
      expect(upgradeTokensFor(TOKEN, upgrade({ cookie: ownerCookie, ...headers }), DEFAULT_IDENTITY_HEADER)).toEqual({});
    }
  });

  test("isConsoleHost admits Vite's default names and the console's public host only", () => {
    const env = { STANDUP_WEB_URL: "https://owner.tunnel.example" };
    for (const host of ["localhost:5173", "app.localhost:5173", "127.0.0.1:5173", "[::1]:5173", "10.0.0.5:5173", "owner.tunnel.example"]) {
      expect(isConsoleHost(host, env)).toBe(true);
    }
    for (const host of ["evil.example:5173", "owner.tunnel.example.evil.example", "localhost.evil.example", undefined]) {
      expect(isConsoleHost(host, env)).toBe(false);
    }
  });

  test("no cookie, a forged cookie, or no token file: client-sent headers are stripped", () => {
    const forged = `${SESSION_COOKIE}=${mintSessionValue(OTHER)}`;
    for (const [token, headers] of [
      [TOKEN, { ...sameOrigin }],
      [TOKEN, { cookie: forged, ...sameOrigin }],
      [undefined, { cookie: ownerCookie, ...sameOrigin }],
    ] as const) {
      const out = forwardUpgrade(token, upgrade(headers));
      expect(out[OWNER_TOKEN_HEADER]).toBeUndefined();
      expect(out[USER_CHANNEL_HEADER]).toBeUndefined();
      expect(out[PERSONA_USER_HEADER]).toBeUndefined();
    }
  });
});

describe("login middleware", () => {
  function run(url: string, token: string | undefined) {
    const headers: Record<string, string> = {};
    const res: LoginResponse & { body?: string } = {
      statusCode: 200,
      setHeader: (name, value) => {
        headers[name.toLowerCase()] = value;
      },
      end: (body) => {
        res.body = body;
      },
    };
    let passed = false;
    loginMiddleware(() => token, () => NOW)({ url }, res, () => (passed = true));
    return { res, headers, passed };
  }

  test("a valid code sets the session cookie and redirects home", () => {
    const { res, headers } = run(`${LOGIN_PATH}?code=${mintLoginCode(TOKEN, NOW)}`, TOKEN);
    expect(res.statusCode).toBe(302);
    expect(headers.location).toBe("/");
    const value = /standup_owner=([^;]+)/.exec(headers["set-cookie"])![1];
    expect(verifySessionValue(TOKEN, value)).toBe(true);
    expect(headers["set-cookie"]).toContain("HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000");
  });

  test("a valid user code sets that user's session cookie, not the owner's", () => {
    const { res, headers } = run(`${LOGIN_PATH}?code=${mintUserLoginCode(TOKEN, "alice", NOW)}`, TOKEN);
    expect(res.statusCode).toBe(302);
    expect(headers.location).toBe("/");
    expect(headers["set-cookie"]).not.toContain(`${SESSION_COOKIE}=`);
    const value = /standup_user=([^;]+)/.exec(headers["set-cookie"])![1];
    expect(verifyUserSessionValue(TOKEN, value)).toBe("alice");
    expect(headers["set-cookie"]).toContain("HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000");
  });

  test("an expired, wrong or missing code is refused without a cookie", () => {
    for (const url of [
      `${LOGIN_PATH}?code=${mintLoginCode(TOKEN, NOW - 2 * LOGIN_CODE_TTL_SECONDS * 1000)}`,
      `${LOGIN_PATH}?code=${mintLoginCode(OTHER, NOW)}`,
      `${LOGIN_PATH}?code=${mintUserLoginCode(TOKEN, "alice", NOW - 2 * LOGIN_CODE_TTL_SECONDS * 1000)}`,
      `${LOGIN_PATH}?code=${mintUserLoginCode(OTHER, "alice", NOW)}`,
      LOGIN_PATH,
    ]) {
      const { res, headers } = run(url, TOKEN);
      expect(res.statusCode).toBe(403);
      expect(headers["set-cookie"]).toBeUndefined();
    }
  });

  test("no token file yet: 503", () => {
    expect(run(`${LOGIN_PATH}?code=x`, undefined).res.statusCode).toBe(503);
  });

  test("other paths fall through", () => {
    expect(run("/api/sessions", TOKEN).passed).toBe(true);
  });
});
