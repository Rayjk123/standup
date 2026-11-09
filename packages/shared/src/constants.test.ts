import { describe, expect, test } from "bun:test";
import {
  capTitle,
  CODEX_MODEL_CATALOG,
  CODEX_MODELS,
  DEFAULT_IDENTITY_HEADER,
  defaultIdentityConfig,
  MAX_TITLE_CHARS,
  resolveIdentityHeader,
} from "./constants.js";
import { DECIDER_BACKENDS } from "./decider.js";

/**
 * capTitle is the one shared bound every title write path funnels through, so a
 * stored title is never a wall of text. It collapses whitespace to one line and
 * truncates on a word boundary, falling back to a hard cut when there is no
 * usable boundary — and is idempotent so re-capping an already-capped title is a
 * no-op.
 */
describe("capTitle", () => {
  test("passes a short title through, collapsing whitespace to one line", () => {
    expect(capTitle("Fix the retry backoff")).toBe("Fix the retry backoff");
    expect(capTitle("Fix   the\n  retry\tbackoff")).toBe("Fix the retry backoff");
    expect(capTitle("  trim me  ")).toBe("trim me");
  });

  test("caps a long multi-word title on a word boundary with an ellipsis", () => {
    // 11-char repeating unit so a hard cut at 69 lands mid-word ("abc"), which a
    // word-boundary cut must drop rather than emit as a stump.
    const out = capTitle("abcdefghij ".repeat(10).trim());
    expect(out.length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
    expect(out.endsWith("…")).toBe(true);
    expect(out.endsWith("abcdefghij…")).toBe(true);
    expect(out.endsWith("abc…")).toBe(false);
  });

  test("falls back to a hard cut when there is no word boundary in range", () => {
    const out = capTitle("a".repeat(200));
    expect(out.length).toBe(MAX_TITLE_CHARS);
    expect(out.endsWith("…")).toBe(true);
  });

  test("honors a custom max and never exceeds it", () => {
    const out = capTitle("one two three four five", 10);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out.endsWith("…")).toBe(true);
    expect(out).toBe("one two…");
  });

  test("is idempotent", () => {
    const long = "make it stop being an unreadable wall of text ".repeat(4);
    expect(capTitle(capTitle(long))).toBe(capTitle(long));
  });
});

/**
 * The identity header is read by the collector, the owner proxy and the web
 * console alike, so its default is pinned here: a change to it changes which
 * header an install's proxy must stamp.
 */
describe("identity defaults", () => {
  test("the default identity header is x-tunnel-user", () => {
    expect(DEFAULT_IDENTITY_HEADER).toBe("x-tunnel-user");
  });

  test("the default identity config reads that header and trusts loopback", () => {
    expect(defaultIdentityConfig()).toEqual({
      auth: "none",
      userIdentifier: { type: "http-header", header: "x-tunnel-user" },
      trustedProxies: [],
      loopbackIsTrusted: true,
    });
  });

  test("each call returns a fresh object", () => {
    const a = defaultIdentityConfig();
    a.trustedProxies.push("10.0.0.1");
    expect(defaultIdentityConfig().trustedProxies).toEqual([]);
  });
});

/**
 * The collector and the console proxy resolve the identity header name from the
 * same settings, so a user session is bound to the header the collector reads.
 */
describe("identity header resolution", () => {
  test.each([
    ["nothing set: the default", undefined, undefined, DEFAULT_IDENTITY_HEADER],
    ["an enabled authenticating tunnel: the header it stamps", undefined, { enabled: true, identityHeader: "X-Review-User" }, "x-review-user"],
    ["STANDUP_IDENTITY_HEADER over the tunnel's header", " X-Forwarded-User ", { enabled: true, identityHeader: "x-review-user" }, "x-forwarded-user"],
    ["a blank STANDUP_IDENTITY_HEADER: the tunnel's header", "   ", { enabled: true, identityHeader: "x-review-user" }, "x-review-user"],
    ["a tunnel that authenticates no one: the default", undefined, { enabled: true }, DEFAULT_IDENTITY_HEADER],
    ["a disabled provider's header: the default", undefined, { enabled: false, identityHeader: "x-review-user" }, DEFAULT_IDENTITY_HEADER],
  ] as const)("resolveIdentityHeader, %s", (_label, explicit, tunnel, header) => {
    expect(resolveIdentityHeader(explicit, tunnel)).toBe(header);
  });
});

describe("Codex model catalog", () => {
  test("ships no named models, so the composer offers the CLI's default and a free-text id", () => {
    expect(CODEX_MODEL_CATALOG).toEqual([]);
    expect(CODEX_MODELS).toEqual([]);
  });
});

describe("decider backends", () => {
  test("claude is the only built-in backend", () => {
    expect([...DECIDER_BACKENDS]).toEqual(["claude"]);
  });
});
