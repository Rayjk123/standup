// Authority gate for the channel-config commands (feed here / standup off /
// feature + feed-kind toggles). The gate is composed by the SAME factory the
// steer/launch/answer gate uses (wireSlackAuthority), so this exercises the REAL
// wiring — mayConfigure = authorityConfigured ? authorized(user) : open. The
// read-only classifier (isReadOnlyChannelCommand) decides which commands are
// routed through the gate at all. No live Slack/HTTP: an idle /send sink stands
// in for the collector.

import { describe, expect, test } from "bun:test";
import { wireSlackAuthority, type SteerSink } from "./steer.js";
import { isReadOnlyChannelCommand, parseChannelCommand } from "./channel-features.js";
import type { SlackEnv } from "./env.js";

/** Steer only needs a /send sink for onThreadReply; the config gate never touches it. */
const idleSteerSink: SteerSink = { sendToSession: async () => ({ ok: true }) };

/** The operator-config slice wireSlackAuthority reads; defaults model a fresh install. */
function env(
  over: Partial<Pick<SlackEnv, "askUser" | "steerAllowlist" | "ownerMap">> = {},
): Pick<SlackEnv, "askUser" | "steerAllowlist" | "ownerMap"> {
  return {
    askUser: over.askUser,
    steerAllowlist: over.steerAllowlist ?? [],
    ownerMap: over.ownerMap ?? new Map<string, string>(),
  };
}

describe("mayConfigure — the channel-config authority gate", () => {
  test("open mode: NO authority configured ⇒ anyone may configure (fail open)", () => {
    const { authorityConfigured, mayConfigure } = wireSlackAuthority(env(), idleSteerSink);
    expect(authorityConfigured).toBe(false);
    expect(mayConfigure("Uanyone")).toBe(true);
    expect(mayConfigure(undefined)).toBe(true); // even an unknown actor, matching today's open behavior
  });

  test("allowlist set ⇒ an allowlisted user may configure, a stranger is refused", () => {
    const { authorityConfigured, mayConfigure } = wireSlackAuthority(
      env({ steerAllowlist: ["Ufriend"] }),
      idleSteerSink,
    );
    expect(authorityConfigured).toBe(true);
    expect(mayConfigure("Ufriend")).toBe(true);
    expect(mayConfigure("Ustranger")).toBe(false);
    expect(mayConfigure(undefined)).toBe(false);
  });

  test("owner (SLACK_ASK_USER) set ⇒ only the owner may configure", () => {
    const { mayConfigure } = wireSlackAuthority(env({ askUser: "Uowner" }), idleSteerSink);
    expect(mayConfigure("Uowner")).toBe(true);
    expect(mayConfigure("Ustranger")).toBe(false);
  });

  test("owner map (SLACK_OWNER_MAP) set ⇒ a mapped owner may configure, others refused", () => {
    const { authorityConfigured, mayConfigure } = wireSlackAuthority(
      env({ ownerMap: new Map([["alice", "U-ALICE"]]) }),
      idleSteerSink,
    );
    expect(authorityConfigured).toBe(true);
    expect(mayConfigure("U-ALICE")).toBe(true);
    expect(mayConfigure("Ustranger")).toBe(false);
  });

  test("mayConfigure matches the steer/launch/answer gate exactly when configured", () => {
    const { authorized, mayConfigure } = wireSlackAuthority(
      env({ steerAllowlist: ["Ufriend"], askUser: "Uowner" }),
      idleSteerSink,
    );
    for (const u of ["Uowner", "Ufriend", "Ustranger", undefined]) {
      expect(mayConfigure(u)).toBe(authorized(u));
    }
  });
});

describe("mayViewActivityInDm — the private DM activity gate", () => {
  test("open mode: NO authority configured ⇒ the single operator sees its own DM view (fail open)", () => {
    const { authorized, authorityConfigured, mayViewActivityInDm } = wireSlackAuthority(env(), idleSteerSink);
    expect(authorityConfigured).toBe(false);
    // The strict gate denies everyone in open mode — that blanket deny is exactly
    // what would (wrongly) lock the host operator out of its own DM view …
    expect(authorized("Uoperator")).toBe(false);
    // … so the DM path fails OPEN instead, letting the operator see its own view
    // over the safe private path (the collector's per-caller scoping is the second gate).
    expect(mayViewActivityInDm("Uoperator")).toBe(true);
    expect(mayViewActivityInDm(undefined)).toBe(true);
  });

  test("configured: gated exactly like steer/launch/answer — only the authorized set may view in DM", () => {
    const { authorized, mayViewActivityInDm } = wireSlackAuthority(
      env({ steerAllowlist: ["Ufriend"], askUser: "Uowner" }),
      idleSteerSink,
    );
    for (const u of ["Uowner", "Ufriend", "Ustranger", undefined]) {
      expect(mayViewActivityInDm(u)).toBe(authorized(u));
    }
    expect(mayViewActivityInDm("Ustranger")).toBe(false);
  });

  test("asymmetry: the DM gate fails open in open mode but the strict channel gate (authorized) does not", () => {
    // The channel/@-mention activity paths use `authorized` directly, which stays
    // closed in open mode — so an open install can't broadcast a caller-scoped
    // snapshot into a shared channel, while the private DM path still works.
    const { authorized, mayViewActivityInDm } = wireSlackAuthority(env(), idleSteerSink);
    expect(mayViewActivityInDm("Uanyone")).toBe(true);
    expect(authorized("Uanyone")).toBe(false);
  });
});

describe("isReadOnlyChannelCommand — which commands the gate covers", () => {
  test("feed status is read-only (never gated)", () => {
    expect(isReadOnlyChannelCommand(parseChannelCommand("feed status")!)).toBe(true);
  });

  test("the mutating commands are NOT read-only (routed through the gate)", () => {
    for (const raw of [
      "feed here",
      "standup off",
      "off",
      "feed on",
      "feed off",
      "feed stop",
      "feed checkpoint off",
      "mirror off",
      "asks on",
    ]) {
      const cmd = parseChannelCommand(raw);
      expect(cmd).not.toBeNull();
      expect(isReadOnlyChannelCommand(cmd!)).toBe(false);
    }
  });
});
