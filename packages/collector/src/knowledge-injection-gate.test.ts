import { describe, expect, test } from "bun:test";
import type { FreshnessGate } from "./knowledge-freshness.js";
import {
  injectionGateReason,
  injectionStaleSince,
  type InjectionGateHit,
  type InjectionGateReason,
} from "./knowledge-injection-gate.js";

/** A freshness gate that fails every doc and dates it stale, so only the exemptions pass. */
const failingFreshness: FreshnessGate = {
  inputs: () => ({}) as ReturnType<FreshnessGate["inputs"]>,
  currentConfidence: () => 0.01,
  isRecoverable: () => true,
  eligible: () => false,
  staleSince: () => "2026-09-01T00:00:00.000Z",
};

const passingFreshness: FreshnessGate = {
  ...failingFreshness,
  eligible: () => true,
  staleSince: () => undefined,
};

function hit(overrides: Partial<InjectionGateHit>): InjectionGateHit {
  return { projectId: "alpha", slug: "doc", originClass: "owner", ...overrides };
}

describe("injectionGateReason", () => {
  test.each<{ name: string; hit: InjectionGateHit; freshness: FreshnessGate; reason: InjectionGateReason | null }>([
    { name: "a fresh owner doc passes", hit: hit({}), freshness: passingFreshness, reason: null },
    { name: "an untrusted origin is held out", hit: hit({ originClass: "untrusted" }), freshness: passingFreshness, reason: "origin" },
    { name: "a superseded doc is held out", hit: hit({ verdict: "superseded" }), freshness: passingFreshness, reason: "verdict" },
    {
      name: "a losing contradicted doc is held out",
      hit: hit({ verdict: "contradicted", contradiction: { side: "losing", counterparts: [] } }),
      freshness: passingFreshness,
      reason: "verdict",
    },
    { name: "a decayed clean doc is held out", hit: hit({ verdict: "clean" }), freshness: failingFreshness, reason: "freshness" },
    { name: "a disputed doc is exempt from the freshness gate", hit: hit({ verdict: "disputed" }), freshness: failingFreshness, reason: null },
    {
      name: "a disputed doc of an untrusted origin is still held out",
      hit: hit({ verdict: "disputed", originClass: "untrusted" }),
      freshness: failingFreshness,
      reason: "origin",
    },
  ])("$name", ({ hit: h, freshness, reason }) => {
    expect(injectionGateReason(h, freshness)).toBe(reason);
  });
});

describe("injectionStaleSince", () => {
  test("a disputed doc is never dated stale; any other decayed doc is", () => {
    expect(injectionStaleSince(hit({ verdict: "disputed" }), failingFreshness)).toBeUndefined();
    expect(injectionStaleSince(hit({ verdict: "clean" }), failingFreshness)).toBe("2026-09-01T00:00:00.000Z");
  });
});
