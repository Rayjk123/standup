// The console's public base URL and the links built on it, shared by the
// collector's Persona doc tools and the Slack bridge.

import { describe, expect, test } from "bun:test";
import {
  consoleAllowedHosts,
  consoleBaseUrl,
  consoleBaseUrlFromEnv,
  consoleLink,
  consoleOriginFromEnv,
  isConsoleLinkPath,
  isLoopbackHost,
  tunnelAuthenticatesFromEnv,
  tunnelIdentityFromEnv,
} from "./console-url.js";
import { DEFAULT_IDENTITY_HEADER, resolveIdentityHeader } from "./constants.js";

/**
 * The tunnel settings as a process without the collector's TunnelProvider
 * reads them: whether the service authenticates, and the provider's identity
 * for resolveIdentityHeader, so the console proxy binds a user session to the
 * header the collector reads.
 */
describe("tunnel identity from the environment", () => {
  const command = { STANDUP_TUNNEL_PROVIDER: "command" };
  test.each([
    ["no tunnel settings", {}, false],
    ["a header name", { STANDUP_TUNNEL_IDENTITY_HEADER: " x-review-user " }, true],
    ["a header that is not a header name", { STANDUP_TUNNEL_IDENTITY_HEADER: "x review user" }, false],
    ["the unauthenticated flag alone", { STANDUP_TUNNEL_UNAUTHENTICATED: "1" }, false],
    ["a header and the unauthenticated flag", { STANDUP_TUNNEL_IDENTITY_HEADER: "x-review-user", STANDUP_TUNNEL_UNAUTHENTICATED: "yes" }, false],
    ["a header with the provider disabled", { STANDUP_TUNNEL_PROVIDER: "disabled", STANDUP_TUNNEL_IDENTITY_HEADER: "x-review-user" }, true],
  ] as const)("tunnelAuthenticatesFromEnv, %s", (_label, env, authenticates) => {
    expect(tunnelAuthenticatesFromEnv(env)).toBe(authenticates);
  });

  test.each([
    ["no tunnel settings", {}, { enabled: false }],
    ["a command tunnel stamping a header", { ...command, STANDUP_TUNNEL_IDENTITY_HEADER: " X-Review-User " }, { enabled: true, identityHeader: "x-review-user" }],
    ["the provider kind in another case", { STANDUP_TUNNEL_PROVIDER: " Command ", STANDUP_TUNNEL_IDENTITY_HEADER: "x-review-user" }, { enabled: true, identityHeader: "x-review-user" }],
    ["an unauthenticated command tunnel", { ...command, STANDUP_TUNNEL_UNAUTHENTICATED: "true" }, { enabled: true }],
    ["a header and the unauthenticated flag", { ...command, STANDUP_TUNNEL_IDENTITY_HEADER: "x-review-user", STANDUP_TUNNEL_UNAUTHENTICATED: "yes" }, { enabled: true }],
    ["a header that is not a header name", { ...command, STANDUP_TUNNEL_IDENTITY_HEADER: "x review user" }, { enabled: true }],
    ["a tunnel header with the provider disabled", { STANDUP_TUNNEL_PROVIDER: "disabled", STANDUP_TUNNEL_IDENTITY_HEADER: "x-review-user" }, { enabled: false }],
    ["a tunnel header with no provider", { STANDUP_TUNNEL_IDENTITY_HEADER: "x-review-user" }, { enabled: false }],
  ] as const)("tunnelIdentityFromEnv, %s", (_label, env, identity) => {
    expect(tunnelIdentityFromEnv(env)).toEqual(identity);
  });

  test.each([
    ["only STANDUP_TUNNEL_IDENTITY_HEADER, on an authenticating provider", { ...command, STANDUP_TUNNEL_IDENTITY_HEADER: "x-review-user" }, "x-review-user"],
    ["STANDUP_IDENTITY_HEADER overriding the tunnel's", { ...command, STANDUP_TUNNEL_IDENTITY_HEADER: "x-review-user", STANDUP_IDENTITY_HEADER: "x-forwarded-user" }, "x-forwarded-user"],
    ["an unauthenticated provider", { ...command, STANDUP_TUNNEL_UNAUTHENTICATED: "1" }, DEFAULT_IDENTITY_HEADER],
    ["nothing set", {}, DEFAULT_IDENTITY_HEADER],
  ] as const)("the identity header, %s", (_label, env: Record<string, string | undefined>, header) => {
    expect(resolveIdentityHeader(env.STANDUP_IDENTITY_HEADER, tunnelIdentityFromEnv(env))).toBe(header);
  });
});

describe("consoleBaseUrl", () => {
  test("accepts an http(s) URL with an optional path and trims trailing slashes", () => {
    const cases: Array<[string | undefined, string | undefined]> = [
      [undefined, undefined],
      ["", undefined],
      ["   ", undefined],
      ["https://h.example", "https://h.example"],
      ["https://h.example/", "https://h.example"],
      ["https://h.example///", "https://h.example"],
      [" http://localhost:5173/ ", "http://localhost:5173"],
      ["HTTPS://H.example", "HTTPS://H.example"],
      ["https://h.example/console", "https://h.example/console"],
      ["https://[::1]:5173", "https://[::1]:5173"],
      // Refused, so a caller falls back to a relative link rather than a broken one.
      ["h.example", undefined],
      ["javascript:alert(1)", undefined],
      ["https://", undefined],
      ["https://h.example?x=1", undefined],
      ["https://h.example/#top", undefined],
      ["https://h .example", undefined],
      ["https://user:pw@h.example", undefined],
      // Shaped like a URL but refused by the URL parser: a bad port or host.
      ["https://host:99999", undefined],
      ["https://host:abc", undefined],
      ["https://exa%mple.com", undefined],
      ["https://[::1", undefined],
      ["https://a<b", undefined],
      ["https://:80", undefined],
    ];
    for (const [raw, want] of cases) expect([raw, consoleBaseUrl(raw)]).toEqual([raw, want]);
  });
});

describe("consoleBaseUrlFromEnv", () => {
  test("takes STANDUP_WEB_URL, else STANDUP_CONSOLE_ORIGIN, skipping one that isn't usable", () => {
    const cases: Array<[Record<string, string | undefined>, string | undefined]> = [
      [{}, undefined],
      [{ STANDUP_WEB_URL: "https://web.example/" }, "https://web.example"],
      [{ STANDUP_CONSOLE_ORIGIN: " https://origin.example " }, "https://origin.example"],
      [{ STANDUP_WEB_URL: "https://web.example", STANDUP_CONSOLE_ORIGIN: "https://origin.example" }, "https://web.example"],
      [{ STANDUP_WEB_URL: "  ", STANDUP_CONSOLE_ORIGIN: "https://origin.example" }, "https://origin.example"],
      [{ STANDUP_WEB_URL: "web.example", STANDUP_CONSOLE_ORIGIN: "https://origin.example" }, "https://origin.example"],
      [{ STANDUP_WEB_URL: "nope", STANDUP_CONSOLE_ORIGIN: "also nope" }, undefined],
    ];
    for (const [env, want] of cases) expect([env, consoleBaseUrlFromEnv(env)]).toEqual([env, want]);
  });
});

describe("consoleOriginFromEnv (console-login's sign-in links)", () => {
  test("STANDUP_WEB_URL, else STANDUP_CONSOLE_ORIGIN, else localhost:5173", () => {
    const cases: Array<[Record<string, string | undefined>, string]> = [
      [{}, "http://localhost:5173"],
      [{ STANDUP_WEB_URL: "https://alice-standup.tunnels.example.com/" }, "https://alice-standup.tunnels.example.com"],
      [{ STANDUP_CONSOLE_ORIGIN: "https://origin.example" }, "https://origin.example"],
      [{ STANDUP_WEB_URL: "https://web.example", STANDUP_CONSOLE_ORIGIN: "https://origin.example" }, "https://web.example"],
      // An unusable STANDUP_WEB_URL doesn't mask a good STANDUP_CONSOLE_ORIGIN, nor send a broken link.
      [{ STANDUP_WEB_URL: "web.example", STANDUP_CONSOLE_ORIGIN: "https://origin.example" }, "https://origin.example"],
      [{ STANDUP_WEB_URL: "nope" }, "http://localhost:5173"],
      [{ STANDUP_WEB_URL: "https://host:99999", STANDUP_CONSOLE_ORIGIN: "https://origin.example" }, "https://origin.example"],
    ];
    for (const [env, want] of cases) expect([env, consoleOriginFromEnv(env)]).toEqual([env, want]);
  });
});

describe("consoleAllowedHosts", () => {
  test("a tunnel service that authenticates no one gets no pass for its domain", () => {
    const D = { STANDUP_TUNNEL_DOMAIN: "tunnels.example.com" };
    const cases: Array<[Record<string, string | undefined>, string[]]> = [
      [D, []],
      [{ ...D, STANDUP_TUNNEL_UNAUTHENTICATED: "1" }, []],
      [{ ...D, STANDUP_TUNNEL_IDENTITY_HEADER: "not a header" }, []],
      // Both a header and the unauthenticated flag: the collector refuses the pair, so no pass.
      [{ ...D, STANDUP_TUNNEL_IDENTITY_HEADER: "x-tunnel-user", STANDUP_TUNNEL_UNAUTHENTICATED: "1" }, []],
      // The console's own host is allowed as itself, even under the tunnel domain.
      [{ ...D, STANDUP_WEB_URL: "https://alice-standup.tunnels.example.com" }, ["alice-standup.tunnels.example.com"]],
      [{ ...D, STANDUP_TUNNEL_IDENTITY_HEADER: "x-tunnel-user" }, [".tunnels.example.com"]],
    ];
    for (const [env, want] of cases) expect([env, consoleAllowedHosts(env)]).toEqual([env, want]);
  });

  test("the configured console host plus an authenticating tunnel provider's domain, never every host", () => {
    const D = { STANDUP_TUNNEL_DOMAIN: "tunnels.example.com", STANDUP_TUNNEL_IDENTITY_HEADER: "x-tunnel-user" };
    const tunnel = ".tunnels.example.com";
    const cases: Array<[Record<string, string | undefined>, string[]]> = [
      // No tunnel domain configured: only the console's own host.
      [{}, []],
      [{ STANDUP_WEB_URL: "https://Standup.Example.com:8443/console" }, ["standup.example.com"]],
      [D, [tunnel]],
      [{ ...D, STANDUP_WEB_URL: "https://Standup.Example.org:8443/console" }, ["standup.example.org", tunnel]],
      [{ ...D, STANDUP_CONSOLE_ORIGIN: "https://origin.example" }, ["origin.example", tunnel]],
      // A tunnel URL is already covered by the domain; a loopback one needs nothing (vite always allows it).
      [{ ...D, STANDUP_WEB_URL: "https://alice-standup.tunnels.example.com" }, [tunnel]],
      [{ ...D, STANDUP_WEB_URL: "http://localhost:5173" }, [tunnel]],
      [{ ...D, STANDUP_WEB_URL: "http://127.0.0.1:5173" }, [tunnel]],
      // An unusable value adds nothing.
      [{ ...D, STANDUP_WEB_URL: "not a url" }, [tunnel]],
      // A typo'd port no longer throws while vite loads its config.
      [{ ...D, STANDUP_WEB_URL: "https://host:9x9" }, [tunnel]],
      // A trailing-dot host is allowed in the dotless form browsers send.
      [{ ...D, STANDUP_WEB_URL: "https://Host.Example.COM." }, ["host.example.com", tunnel]],
      // A look-alike outside the tunnel domain is only allowed as itself.
      [{ ...D, STANDUP_WEB_URL: "https://eviltunnels.example.com" }, ["eviltunnels.example.com", tunnel]],
      // A tunnel domain that isn't a domain is ignored.
      [{ STANDUP_TUNNEL_DOMAIN: "not a domain", STANDUP_TUNNEL_IDENTITY_HEADER: "x-tunnel-user" }, []],
    ];
    for (const [env, want] of cases) expect([env, consoleAllowedHosts(env)]).toEqual([env, want]);
  });
});

describe("isConsoleLinkPath", () => {
  test("holds for a doc or review page with an id, and nothing else", () => {
    for (const path of ["/docs/abc", "/review/r1"]) expect([path, isConsoleLinkPath(path)]).toEqual([path, true]);
    for (const path of ["/docs/", "/review/", "/docs", "/", "/api/knowledge/eval", "/asks/1/resolve", "docs/abc", "//docs/abc"]) {
      expect([path, isConsoleLinkPath(path)]).toEqual([path, false]);
    }
  });

  test("a dot segment, in any form the URL parser resolves, makes it false", () => {
    for (const path of [
      "/docs/../api/knowledge/eval",
      "/docs/%2e%2e/api/knowledge/eval",
      "/docs/%2E%2E/api",
      "/docs/./x",
      "/docs/%2e/x",
      "/review/r1/../../api",
    ]) {
      expect([path, isConsoleLinkPath(path)]).toEqual([path, false]);
    }
    // A dot inside a segment is just part of an id.
    expect(isConsoleLinkPath("/docs/a.b.c")).toBe(true);
  });
});

describe("isLoopbackHost", () => {
  test("holds for the hosts only the console's own machine reaches", () => {
    for (const host of [
      "localhost",
      "LOCALHOST:5173",
      "localhost.",
      "127.0.0.1",
      "127.0.0.1:7777",
      "127.0.0.2",
      "127.1.2.3",
      "0.0.0.0",
      "[::1]",
      "[::1]:5173",
      "[::]",
      "app.localhost",
    ]) {
      expect([host, isLoopbackHost(host)]).toEqual([host, true]);
    }
    for (const host of ["owner-standup.tunnels.example.com", "example.test", "notlocalhost.example"]) {
      expect([host, isLoopbackHost(host)]).toEqual([host, false]);
    }
  });
});

describe("consoleLink", () => {
  test("joins a usable base, and returns the bare path otherwise", () => {
    expect(consoleLink("https://h.example/", "/docs/d1")).toBe("https://h.example/docs/d1");
    expect(consoleLink("https://h.example/console", "/docs/d1")).toBe("https://h.example/console/docs/d1");
    expect(consoleLink(undefined, "/docs/d1")).toBe("/docs/d1");
    expect(consoleLink("h.example", "/docs/d1")).toBe("/docs/d1");
  });
});
