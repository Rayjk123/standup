import { expect, test, describe } from "bun:test";
import {
  deriveConfidence,
  isConfidenceEligibleForInjection,
  isStatusLike,
  statusSignals,
  withConfidenceDefaults,
  belowFloorSince,
  MIN_INJECTION_CONFIDENCE,
  DISPUTED_CONFIDENCE,
  DEFAULT_BASE_CONFIDENCE,
  STATUS_HALF_LIFE_DAYS,
} from "./confidence.js";
import { confidenceUnderEvidence, EVIDENCE_CONFIDENCE_CAPS, PROVISIONAL_CONFIDENCE } from "./evidence.js";
import { isVerdictEligibleForInjection } from "./types.js";

const VERIFIED = "2026-01-01T00:00:00.000Z";
const verifiedMs = Date.parse(VERIFIED);
const day = 86_400_000;
const at = (days: number) => new Date(verifiedMs + days * day);

describe("deriveConfidence — half-life decay", () => {
  test("at the verification instant, current confidence equals the base", () => {
    expect(deriveConfidence({ confidence: 1, lastVerifiedAt: VERIFIED, halfLifeDays: 90 }, at(0))).toBe(1);
    expect(deriveConfidence({ confidence: 0.8, lastVerifiedAt: VERIFIED, halfLifeDays: 90 }, at(0))).toBe(0.8);
  });

  test("after exactly one half-life the base is halved", () => {
    const c = deriveConfidence({ confidence: 1, lastVerifiedAt: VERIFIED, halfLifeDays: 90 }, at(90));
    expect(c).toBeCloseTo(0.5, 10);
  });

  test("after two half-lives it is a quarter, three an eighth", () => {
    expect(
      deriveConfidence({ confidence: 1, lastVerifiedAt: VERIFIED, halfLifeDays: 90 }, at(180))
    ).toBeCloseTo(0.25, 10);
    expect(
      deriveConfidence({ confidence: 1, lastVerifiedAt: VERIFIED, halfLifeDays: 90 }, at(270))
    ).toBeCloseTo(0.125, 10);
  });

  test("decay scales off the base, not off 1 — a base of 0.6 halves to 0.3", () => {
    expect(
      deriveConfidence({ confidence: 0.6, lastVerifiedAt: VERIFIED, halfLifeDays: 30 }, at(30))
    ).toBeCloseTo(0.3, 10);
  });

  test("a shorter half-life decays faster for the same elapsed time", () => {
    const fast = deriveConfidence({ confidence: 1, lastVerifiedAt: VERIFIED, halfLifeDays: 10 }, at(10))!;
    const slow = deriveConfidence({ confidence: 1, lastVerifiedAt: VERIFIED, halfLifeDays: 90 }, at(10))!;
    expect(fast).toBeCloseTo(0.5, 10);
    expect(slow).toBeGreaterThan(fast);
  });
});

describe("deriveConfidence — degenerate inputs", () => {
  test("no base confidence yields undefined (a doc with no opinion stays opinion-less)", () => {
    expect(deriveConfidence({ lastVerifiedAt: VERIFIED, halfLifeDays: 90 }, at(90))).toBeUndefined();
    expect(deriveConfidence({}, at(90))).toBeUndefined();
  });

  test("a base with no lastVerifiedAt is returned unchanged (decay is opt-in)", () => {
    expect(deriveConfidence({ confidence: 0.7, halfLifeDays: 90 }, at(90))).toBe(0.7);
  });

  test("a non-positive half-life disables decay", () => {
    expect(
      deriveConfidence({ confidence: 0.7, lastVerifiedAt: VERIFIED, halfLifeDays: 0 }, at(90))
    ).toBe(0.7);
  });

  test("an absent half-life falls back to the 90-day default", () => {
    const c = deriveConfidence({ confidence: 1, lastVerifiedAt: VERIFIED }, at(90));
    expect(c).toBeCloseTo(0.5, 10);
  });

  test("a future lastVerifiedAt (clock skew) never extrapolates above the base", () => {
    expect(
      deriveConfidence({ confidence: 0.9, lastVerifiedAt: VERIFIED, halfLifeDays: 90 }, at(-30))
    ).toBe(0.9);
  });

  test("an unparseable lastVerifiedAt degrades to the base rather than NaN", () => {
    expect(
      deriveConfidence({ confidence: 0.9, lastVerifiedAt: "not-a-date", halfLifeDays: 90 }, at(90))
    ).toBe(0.9);
  });

  test("a base outside 0..1 is clamped before decaying", () => {
    expect(deriveConfidence({ confidence: 5, lastVerifiedAt: VERIFIED, halfLifeDays: 90 }, at(0))).toBe(1);
    expect(deriveConfidence({ confidence: -2, lastVerifiedAt: VERIFIED, halfLifeDays: 90 }, at(0))).toBe(0);
  });
});

describe("isConfidenceEligibleForInjection — freshness gate (roadmap r5)", () => {
  test("a doc with no confidence opinion is never gated out on freshness", () => {
    // The loader gives every indexed doc an opinion (withConfidenceDefaults);
    // this covers a doc that reached the gate some other way.
    expect(isConfidenceEligibleForInjection({}, { now: at(1000), reverifyActive: true })).toBe(true);
    expect(
      isConfidenceEligibleForInjection(
        { lastVerifiedAt: VERIFIED },
        { now: at(1000), reverifyActive: true }
      )
    ).toBe(true);
  });

  test("a freshly-verified full-confidence doc is eligible", () => {
    expect(
      isConfidenceEligibleForInjection(
        { confidence: 1, lastVerifiedAt: VERIFIED, halfLifeDays: 90 },
        { now: at(0), reverifyActive: true }
      )
    ).toBe(true);
  });

  test("with re-verification active, confidence decays until the doc drops out of the gate", () => {
    const inputs = { confidence: 1, lastVerifiedAt: VERIFIED, halfLifeDays: 90 };
    // One half-life (0.5) still clears the 0.25 floor; two half-lives (0.25)
    // sits exactly on it; just past that it falls below and is excluded.
    expect(isConfidenceEligibleForInjection(inputs, { now: at(90), reverifyActive: true })).toBe(true);
    expect(isConfidenceEligibleForInjection(inputs, { now: at(180), reverifyActive: true })).toBe(true);
    expect(isConfidenceEligibleForInjection(inputs, { now: at(181), reverifyActive: true })).toBe(false);
    expect(isConfidenceEligibleForInjection(inputs, { now: at(365), reverifyActive: true })).toBe(false);
  });

  test("with re-verification OFF (the default), a merely time-decayed doc stays eligible", () => {
    // The decay clock runs always, but its only cure — the re-verification cron
    // — cannot run for a project that opted out or has no repo here. Gating a
    // decayed doc out when there is no path to lift it back would silently and
    // permanently drop it from injection; so with the cron off, time-decay
    // alone never gates.
    const inputs = { confidence: 1, lastVerifiedAt: VERIFIED, halfLifeDays: 90 };
    expect(isConfidenceEligibleForInjection(inputs, { now: at(365) })).toBe(true);
    expect(isConfidenceEligibleForInjection(inputs, { now: at(1000) })).toBe(true);
  });

  test("a disputed doc (DISPUTED_CONFIDENCE base) is gated out regardless of re-verification state", () => {
    // A stored base below the floor is an explicit refutation, not decay — it
    // stays gated even when the project later disables re-verification, because
    // only a human re-accepting the doc should lift a refuted fact back.
    expect(DISPUTED_CONFIDENCE).toBeLessThan(MIN_INJECTION_CONFIDENCE);
    const disputed = { confidence: DISPUTED_CONFIDENCE, lastVerifiedAt: VERIFIED, halfLifeDays: 90 };
    expect(isConfidenceEligibleForInjection(disputed, { now: at(0), reverifyActive: true })).toBe(false);
    expect(isConfidenceEligibleForInjection(disputed, { now: at(0) })).toBe(false);
  });
});

describe("isVerdictEligibleForInjection — coherence gate", () => {
  test("holds out a contradicted doc even at full confidence", () => {
    // The r7 gap: a contradicted doc carries no confidence penalty, so only the
    // verdict gate keeps it out of injection.
    expect(isVerdictEligibleForInjection("contradicted")).toBe(false);
    expect(
      isConfidenceEligibleForInjection({ confidence: 1, lastVerifiedAt: VERIFIED, halfLifeDays: 90 })
    ).toBe(true);
  });

  test("holds out a disputed doc", () => {
    expect(isVerdictEligibleForInjection("disputed")).toBe(false);
  });

  test("admits a never-verified, clean, or transient-verdict doc", () => {
    expect(isVerdictEligibleForInjection(undefined)).toBe(true);
    expect(isVerdictEligibleForInjection("clean")).toBe(true);
    expect(isVerdictEligibleForInjection("unverified")).toBe(true);
    expect(isVerdictEligibleForInjection("error")).toBe(true);
  });
});

describe("isStatusLike — status snapshots get the short half-life", () => {
  test("a status table with test counts and a dated run log is status-like", () => {
    const body = [
      "## Summary (as of 2026-08-28)",
      "| Area | State |",
      "|---|---|",
      "| Vector search | NOT STARTED |",
      "| Persona | QUEUED |",
      "| Slack mirror | IN PROGRESS |",
      "Tests: collector 412 pass / 0 fail",
    ].join("\n");
    expect(statusSignals(body).strong).toEqual(expect.arrayContaining(["status-table", "test-count", "work-state"]));
    expect(isStatusLike(body)).toBe(true);
  });

  test("phase headings marked done / in progress are status-like", () => {
    const body = [
      "## Phase 5 — Corpus (done)",
      "## Phase 7 — Expert (in progress)",
      "- Step 5: product block. Not started.",
    ].join("\n");
    expect(isStatusLike(body)).toBe(true);
  });

  test("a list of things not done yet is status-like", () => {
    const body = "1. **sqlite-vec not implemented.**\n2. No product docs at launch yet.\n3. Confidence does not move yet.";
    expect(isStatusLike(body)).toBe(true);
  });

  test("classification is linear in the body: pathological runs of caps, backticks and fences stay fast", () => {
    const bodies = ["AB ".repeat(32_000), "`" + "x".repeat(96_000), "```\n" + "QUEUED → ".repeat(10_000), "A_B ".repeat(30_000)];
    for (const body of bodies) {
      const started = performance.now();
      statusSignals(body);
      expect(performance.now() - started).toBeLessThan(250);
    }
  });

  test("a long analysis that mentions a test count and two open items in passing is not a status report", () => {
    const filler = "This section analyses the retrieval design and its trade-offs in depth. ".repeat(300);
    const body = `${filler}\nThe suite has 412 tests passing.\n- streaming not implemented\n- no warm sessions yet\n${filler}`;
    expect(body.length).toBeGreaterThan(16_000);
    expect(isStatusLike(body)).toBe(false);
    expect(isStatusLike("The suite has 412 tests passing.\n- streaming not implemented\n- no warm sessions yet")).toBe(true);
  });

  test("a reference doc quoting enum states, a lifecycle chain, or states in code is not status-like", () => {
    const reference = [
      "- `ThumbnailJob` — keyed by `imageId`; lifecycle QUEUED → RESIZING → STORED/REJECTED.",
      "2. The upload handler inserts a QUEUED `ThumbnailJob` record, then enqueues the resize.",
      "3. Register the storage bucket by hand (no setup script for it yet).",
      "The state is `IN PROGRESS` while the task runs.",
      "**Date:** as of 2026-09-01.",
    ].join("\n");
    expect(statusSignals(reference).strong).toEqual([]);
    expect(isStatusLike(reference)).toBe(false);
  });

  test("a gotcha with one dated verification, or a decision citing a count once, is not", () => {
    expect(isStatusLike("Bun fetch times out at 360s. Verified on 2026-09-03 against Bun 1.2.")).toBe(false);
    expect(isStatusLike("We chose RRF; it lifted MRR on the 412-doc corpus.")).toBe(false);
    expect(isStatusLike("`knnSearch` is not implemented in the old store.")).toBe(false);
  });
});

describe("withConfidenceDefaults — every doc decays", () => {
  test("a doc that asserts nothing is held to the default base as of generated_at", () => {
    expect(withConfidenceDefaults({ generatedAt: VERIFIED, updatedAt: new Date(0), body: "a durable fact" })).toEqual({
      confidence: DEFAULT_BASE_CONFIDENCE,
      lastVerifiedAt: VERIFIED,
    });
  });

  test("with no date of its own it falls back to the file time", () => {
    const updatedAt = new Date("2026-03-01T00:00:00.000Z");
    expect(withConfidenceDefaults({ updatedAt, body: "x" }).lastVerifiedAt).toBe(updatedAt.toISOString());
  });

  test("the content clock, not the file time, dates an unasserted doc; a rewrite that keeps the body moves nothing", () => {
    const firstSeen = "2026-09-20T00:00:00.000Z";
    const rewritten = new Date("2026-10-01T00:00:00.000Z");
    // A changed body (first seen after generated_at) is the author restating it.
    expect(withConfidenceDefaults({ generatedAt: VERIFIED, contentFirstSeen: firstSeen, updatedAt: rewritten, body: "x" }).lastVerifiedAt).toBe(firstSeen);
    // The file time is ignored once the doc has any content date.
    expect(withConfidenceDefaults({ generatedAt: VERIFIED, updatedAt: rewritten, body: "x" }).lastVerifiedAt).toBe(VERIFIED);
  });

  test("a source that changed after the last verification restarts the clock; an older anchor does not", () => {
    const verified = "2026-09-01T00:00:00.000Z";
    expect(withConfidenceDefaults({ lastVerifiedAt: verified, anchorAt: "2026-09-20T00:00:00.000Z", body: "x" }).lastVerifiedAt).toBe(
      "2026-09-20T00:00:00.000Z"
    );
    expect(withConfidenceDefaults({ lastVerifiedAt: verified, anchorAt: "2026-08-01T00:00:00.000Z", body: "x" }).lastVerifiedAt).toBe(verified);
  });

  test("belowFloorSince is the moment decay crosses the injection floor", () => {
    const inputs = { confidence: 1, lastVerifiedAt: VERIFIED, halfLifeDays: 90 };
    expect(belowFloorSince(inputs)).toBe(at(180).toISOString());
    expect(belowFloorSince({ confidence: DISPUTED_CONFIDENCE, lastVerifiedAt: VERIFIED })).toBeUndefined();
    expect(belowFloorSince({ confidence: 1 })).toBeUndefined();
  });

  test("a stamped default half-life does not stop a status doc from getting the short one", () => {
    const status = "| A | DONE |\n| B | QUEUED |\n412 tests green";
    expect(withConfidenceDefaults({ body: status, halfLifeDays: 90 }).halfLifeDays).toBe(STATUS_HALF_LIFE_DAYS);
    expect(withConfidenceDefaults({ body: "a durable fact", halfLifeDays: 90 }).halfLifeDays).toBe(90);
  });

  test("a status-like body gets the short half-life; an asserted half-life is kept", () => {
    const status = "| A | DONE |\n| B | QUEUED |\n412 tests green";
    expect(withConfidenceDefaults({ body: status, generatedAt: VERIFIED }).halfLifeDays).toBe(STATUS_HALF_LIFE_DAYS);
    expect(withConfidenceDefaults({ body: status, generatedAt: VERIFIED, halfLifeDays: 60 }).halfLifeDays).toBe(60);
  });

  test("asserted fields are never overwritten", () => {
    const asserted = { confidence: 0.4, lastVerifiedAt: VERIFIED, halfLifeDays: 30 };
    expect(withConfidenceDefaults({ ...asserted, generatedAt: "2020-01-01T00:00:00Z", body: "x" })).toEqual(asserted);
  });

  test("an owner doc on the default base decays out of the gate when re-verification is active", () => {
    const inputs = withConfidenceDefaults({ generatedAt: VERIFIED, body: "a durable fact" });
    expect(isConfidenceEligibleForInjection(inputs, { now: at(120), reverifyActive: true })).toBe(true);
    expect(isConfidenceEligibleForInjection(inputs, { now: at(170), reverifyActive: true })).toBe(false);
    expect(isConfidenceEligibleForInjection(inputs, { now: at(170) })).toBe(true);
  });

  test("a default-base status doc drops out within about four weeks", () => {
    const inputs = withConfidenceDefaults({ generatedAt: VERIFIED, body: "| A | DONE |\n| B | QUEUED |" });
    expect(isConfidenceEligibleForInjection(inputs, { now: at(20), reverifyActive: true })).toBe(true);
    expect(isConfidenceEligibleForInjection(inputs, { now: at(30), reverifyActive: true })).toBe(false);
  });
});

describe("confidenceUnderEvidence — evidence caps the base", () => {
  test("the lowest applicable cap wins, and a base already below every cap is kept", () => {
    expect(confidenceUnderEvidence(1, [])).toBe(1);
    // File drift raises re-verification priority only; it caps nothing.
    expect(confidenceUnderEvidence(1, [{ kind: "file-drift", detail: "" }])).toBe(1);
    expect(
      confidenceUnderEvidence(0.9, [
        { kind: "file-drift", detail: "" },
        { kind: "missing-path", detail: "" },
      ])
    ).toBe(EVIDENCE_CONFIDENCE_CAPS["missing-path"]!);
    expect(confidenceUnderEvidence(0.2, [{ kind: "unmerged", detail: "" }])).toBe(0.2);
  });

  test("re-applying the same findings is a no-op", () => {
    const evidence = [{ kind: "unmerged" as const, detail: "" }];
    const once = confidenceUnderEvidence(1, evidence);
    expect(once).toBe(PROVISIONAL_CONFIDENCE);
    expect(confidenceUnderEvidence(once, evidence)).toBe(once);
  });

  test("no deterministic finding is a refutation: every cap stays above DISPUTED_CONFIDENCE", () => {
    for (const cap of Object.values(EVIDENCE_CONFIDENCE_CAPS)) expect(cap!).toBeGreaterThan(DISPUTED_CONFIDENCE);
  });
});
