import { expect, test, describe } from "bun:test";
import type {
  KnowledgeDoc,
  SearchResult,
  SearchOptions,
  DraftDispute,
} from "@standup/knowledge";
import { createStore, getSetting } from "@standup/store";
import type { DocVerdictState } from "./knowledge-coherence.js";
import type {
  ResolveDeps,
  ResolutionRecord,
  ContradictionResolver,
  ClaimRecord,
} from "./knowledge-resolve.js";
import type { ReverifyCoherenceDeps } from "./knowledge-reverify.js";
import type { KnowledgeSync } from "./knowledge-sync.js";
import {
  isNightlySweepEnabled,
  collectFlaggedPairs,
  selectBackfillPairs,
  makeSpawnBudget,
  budgetedJudge,
  budgetedResolver,
  runBackfillForProject,
  runDetectionForProject,
  runGraphAudit,
  rotateProjectsByCursor,
  inDetectCooldown,
  tick,
  AUDIT_LAST_RUN_KEY,
  AUDIT_CURSOR_KEY,
  AUDIT_DETECT_COOLDOWN_DAYS,
} from "./knowledge-graph-audit.js";
import type { GraphAuditDeps } from "./knowledge-graph-audit.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function doc(over: Partial<KnowledgeDoc>): KnowledgeDoc {
  return {
    id: over.slug ?? "id",
    projectId: "p",
    slug: "s",
    title: "T",
    body: "B",
    updatedAt: new Date(),
    filePath: "/x",
    ...over,
  };
}

/** A `Contradicts <slug>` dispute — the flag the coherence pass writes. */
function contradicts(slug: string): DraftDispute {
  return { claim: `Contradicts ${slug}`, finding: "opposing", evidence: "e" };
}

/** A doc flagged as contradicting `others`. */
function flagged(slug: string, others: string[], over: Partial<KnowledgeDoc> = {}): KnowledgeDoc {
  return doc({
    slug,
    verdict: "contradicted",
    disputes: others.map(contradicts),
    ...over,
  });
}

function claim(slug: string, over: Partial<ClaimRecord> = {}): ClaimRecord {
  return {
    slug,
    title: slug,
    body: `body ${slug}`,
    originClass: "agent",
    sourceKind: "code",
    confidence: 0.2,
    ...over,
  };
}

function searchHit(slug: string, rawScore: number): SearchResult {
  return {
    id: `id-${slug}`,
    projectId: "p",
    slug,
    title: slug,
    excerpt: "",
    score: rawScore,
    rawScore,
    source: "embedding",
    originClass: "owner",
    sourceKind: "code",
    generated: true,
  };
}

function acceptedDoc(title: string, body: string) {
  return { slug: title, title, body, tags: [], updatedAt: new Date(), sourceKind: "code" as const };
}

interface Rec {
  deps: ResolveDeps;
  records: ResolutionRecord[];
  reviews: ResolutionRecord[];
  verdicts: Array<{ slug: string; verdict: string | null; disputes: DraftDispute[] }>;
}

/**
 * A recording ResolveDeps over in-memory claims/verdicts. The `resolve` seam is
 * passed through verbatim so a caller can budget-wrap it and see exactly how many
 * times the underlying resolver spawns; every write is captured for assertions.
 * No network, filesystem, or `claude` spawn is touched.
 */
function makeResolveDeps(
  claims: Record<string, ClaimRecord | undefined>,
  resolve: ContradictionResolver,
  verdictStates: Record<string, DocVerdictState | null> = {}
): Rec {
  const rec: Rec = {
    deps: undefined as unknown as ResolveDeps,
    records: [],
    reviews: [],
    verdicts: [],
  };
  rec.deps = {
    loadClaim: (_p, slug) => claims[slug] ?? null,
    getVerdictState: (_p, slug) => verdictStates[slug] ?? null,
    search: async () => [],
    resolve,
    decayConfidence: async () => {},
    setVerdict: (_p, slug, verdict, disputes) => {
      rec.verdicts.push({ slug, verdict, disputes: disputes as DraftDispute[] });
    },
    rescopeBody: async () => {},
    mergeBody: async () => {},
    resync: async () => {},
    findContradictors: () => [],
    recordResolution: (r) => rec.records.push(r),
    getExistingResolution: () => null,
    onNeedsReview: (r) => rec.reviews.push(r),
  };
  return rec;
}

// ── Gating (DEFAULT ON) ────────────────────────────────────────────────────────

describe("isNightlySweepEnabled — DEFAULT ON", () => {
  test("neither env nor setting → enabled (default on)", () => {
    expect(isNightlySweepEnabled(undefined, null)).toBe(true);
    expect(isNightlySweepEnabled("", null)).toBe(true);
    expect(isNightlySweepEnabled(undefined, "")).toBe(true);
  });

  test("env truthy → enabled", () => {
    expect(isNightlySweepEnabled("1", null)).toBe(true);
    expect(isNightlySweepEnabled("true", null)).toBe(true);
    expect(isNightlySweepEnabled("on", null)).toBe(true);
  });

  test("settings key truthy (no env) → enabled", () => {
    expect(isNightlySweepEnabled(undefined, "true")).toBe(true);
    expect(isNightlySweepEnabled(undefined, "on")).toBe(true);
  });

  test("explicit falsy setting (no env) opts out over the default", () => {
    expect(isNightlySweepEnabled(undefined, "false")).toBe(false);
    expect(isNightlySweepEnabled(undefined, "0")).toBe(false);
    expect(isNightlySweepEnabled(undefined, "off")).toBe(false);
    expect(isNightlySweepEnabled(undefined, "no")).toBe(false);
  });

  test("explicit env off hard-disables even when the setting is on", () => {
    expect(isNightlySweepEnabled("off", "true")).toBe(false);
    expect(isNightlySweepEnabled("0", "on")).toBe(false);
    expect(isNightlySweepEnabled("false", "1")).toBe(false);
  });
});

// ── Flagged-pair enumeration + backfill selection ──────────────────────────────

describe("collectFlaggedPairs", () => {
  test("a mutual flag surfaces the pair exactly once", () => {
    const pairs = collectFlaggedPairs([flagged("a", ["b"]), flagged("b", ["a"])]);
    expect(pairs).toEqual([{ a: "a", b: "b" }]);
  });

  test("a pair whose other endpoint no longer exists is dropped", () => {
    // "a" claims to contradict "gone", but "gone" is not among the live docs.
    const pairs = collectFlaggedPairs([flagged("a", ["gone"])]);
    expect(pairs).toEqual([]);
  });

  test("a pair whose endpoint is already superseded is dropped (already resolved)", () => {
    const pairs = collectFlaggedPairs([
      flagged("keep", ["drop"]),
      flagged("drop", ["keep"], { verdict: "superseded" }),
    ]);
    expect(pairs).toEqual([]);
  });

  test("ignores docs with no contradiction disputes", () => {
    const pairs = collectFlaggedPairs([doc({ slug: "solo" }), doc({ slug: "solo2" })]);
    expect(pairs).toEqual([]);
  });
});

describe("selectBackfillPairs", () => {
  const docs = [
    flagged("a", ["b"]),
    flagged("b", ["a"]),
    flagged("c", ["d"]),
    flagged("d", ["c"]),
  ];

  test("selects only flagged pairs with NO resolution row of any status", () => {
    // (a,b) already has a resolution; (c,d) does not.
    const hasResolution = (x: string, y: string) => [x, y].sort().join("") === "ab";
    const sel = selectBackfillPairs(docs, hasResolution, 100);
    expect(sel.pairs).toEqual([{ a: "c", b: "d" }]);
    expect(sel.capped).toBe(0);
  });

  test("a pair with a needs_review OR applied row is treated identically (skipped)", () => {
    // Both pairs already resolved (any status) → nothing to backfill.
    const sel = selectBackfillPairs(docs, () => true, 100);
    expect(sel.pairs).toEqual([]);
  });

  test("honors the per-run pair cap and reports how many it dropped", () => {
    const sel = selectBackfillPairs(docs, () => false, 1);
    expect(sel.pairs).toHaveLength(1);
    expect(sel.capped).toBe(1); // 2 unresolved pairs, 1 kept, 1 dropped by the cap
  });
});

// ── Spawn budget ───────────────────────────────────────────────────────────────

describe("makeSpawnBudget", () => {
  test("hands out exactly `limit` slots, then counts every miss", () => {
    const b = makeSpawnBudget(2);
    expect(b.tryConsume()).toBe(true);
    expect(b.tryConsume()).toBe(true);
    expect(b.tryConsume()).toBe(false);
    expect(b.tryConsume()).toBe(false);
    expect(b.spawned()).toBe(2);
    expect(b.skipped()).toBe(2);
    expect(b.remaining()).toBe(0);
  });
});

describe("budgeted wrappers stop spawning at the cap", () => {
  test("budgetedJudge fail-closes without calling the real judge past the cap", async () => {
    const b = makeSpawnBudget(1);
    let realCalls = 0;
    const judge = budgetedJudge(async () => {
      realCalls++;
      return { contradicts: true, reason: "r" };
    }, b);
    const a = { slug: "a", title: "a", body: "a" };
    const c = { slug: "c", title: "c", body: "c" };
    expect((await judge(a, c)).contradicts).toBe(true); // within budget
    const cut = await judge(a, c); // budget gone → unjudged, never a judged "no"
    expect(cut.contradicts).toBe(false);
    expect(cut.error).toContain("budget");
    expect(realCalls).toBe(1);
  });

  test("budgetedResolver returns null without calling the real resolver past the cap", async () => {
    const b = makeSpawnBudget(1);
    let realCalls = 0;
    const resolve = budgetedResolver(async () => {
      realCalls++;
      return { type: "supersede", winnerSlug: "a", loserSlug: "c", rationale: "r" };
    }, b);
    const input = { projectId: "p", a: claim("a"), b: claim("c"), grounding: "" };
    expect(await resolve(input)).not.toBeNull(); // within budget
    expect(await resolve(input)).toBeNull(); // budget gone → no spawn
    expect(realCalls).toBe(1);
  });
});

// ── Project audit orchestration ─────────────────────────────────────────────────

describe("runBackfillForProject", () => {
  test("resolves a stranded flagged pair and records an applied resolution", async () => {
    // The confirmed bug: a flagged pair with no ledger row. Backfill must hand it
    // to the resolver so it finally resolves.
    const docs = [flagged("keep", ["drop"]), flagged("drop", ["keep"])];
    const rec = makeResolveDeps(
      { keep: claim("keep", { confidence: 0.3 }), drop: claim("drop") },
      async () => ({ type: "supersede", winnerSlug: "keep", loserSlug: "drop", rationale: "drop outdated" }),
      {
        keep: { verdict: "contradicted", disputes: [contradicts("drop")] },
        drop: { verdict: "contradicted", disputes: [contradicts("keep")] },
      }
    );
    const budget = makeSpawnBudget(50);
    const result = await runBackfillForProject("p", docs, {
      resolveDeps: rec.deps,
      hasResolution: () => false, // no prior resolution → stranded
      budget,
      maxPairs: 100,
    });

    expect(result.selected).toBe(1);
    expect(result.applied).toBe(1);
    expect(rec.records).toHaveLength(1);
    expect(rec.records[0]!.status).toBe("applied");
    // The loser was tombstoned — the pair is no longer stranded.
    expect(rec.verdicts.find((v) => v.slug === "drop")!.verdict).toBe("superseded");
  });

  test("clears the WINNER's verdict and its dispute against the loser (winner stays retrieval-eligible)", async () => {
    // A resolved contradiction must not leave its WINNER hidden. On an applied
    // supersede the resolver tombstones the loser AND clears the winner: it strips
    // the winner's `Contradicts <loser>` dispute and drops the winner's verdict back
    // to null. A winner left at verdict "contradicted" is suppressed from retrieval —
    // the exact opposite of winning the contradiction.
    const docs = [flagged("keep", ["drop"]), flagged("drop", ["keep"])];
    const rec = makeResolveDeps(
      { keep: claim("keep", { confidence: 0.3 }), drop: claim("drop") },
      async () => ({ type: "supersede", winnerSlug: "keep", loserSlug: "drop", rationale: "drop outdated" }),
      {
        keep: { verdict: "contradicted", disputes: [contradicts("drop")] },
        drop: { verdict: "contradicted", disputes: [contradicts("keep")] },
      }
    );
    const budget = makeSpawnBudget(50);
    await runBackfillForProject("p", docs, {
      resolveDeps: rec.deps,
      hasResolution: () => false,
      budget,
      maxPairs: 100,
    });

    // Loser tombstoned...
    expect(rec.verdicts.find((v) => v.slug === "drop")!.verdict).toBe("superseded");
    // ...winner cleared: verdict back to null (re-admitted to retrieval) and NO
    // lingering dispute naming the loser it beat.
    const winner = rec.verdicts.find((v) => v.slug === "keep")!;
    expect(winner.verdict).toBeNull();
    expect(winner.disputes.some((d) => d.claim === "Contradicts drop")).toBe(false);
  });

  test("skips a pair that already has a resolution row — no resolver spawn", async () => {
    // Idempotency at selection: an already-resolved pair is never handed to the
    // resolver, so no model spawns and no fresh ledger row.
    let spawns = 0;
    const docs = [flagged("a", ["b"]), flagged("b", ["a"])];
    const budget = makeSpawnBudget(50);
    const rec = makeResolveDeps(
      { a: claim("a"), b: claim("b") },
      budgetedResolver(async () => {
        spawns++;
        return { type: "supersede", winnerSlug: "a", loserSlug: "b", rationale: "r" };
      }, budget)
    );
    const result = await runBackfillForProject("p", docs, {
      resolveDeps: rec.deps,
      hasResolution: () => true, // this pair already resolved
      budget,
      maxPairs: 100,
    });
    expect(result.selected).toBe(0);
    expect(spawns).toBe(0);
    expect(rec.records).toHaveLength(0);
  });

  test("an already-resolved pair that slips past selection is short-circuited before any spawn", async () => {
    // Runtime idempotency: even if selection hands a pair through, the resolver's
    // getExistingResolution short-circuit skips it before spawning a model.
    let spawns = 0;
    const docs = [flagged("a", ["b"]), flagged("b", ["a"])];
    const budget = makeSpawnBudget(50);
    const rec = makeResolveDeps(
      { a: claim("a"), b: claim("b") },
      budgetedResolver(async () => {
        spawns++;
        return { type: "supersede", winnerSlug: "a", loserSlug: "b", rationale: "r" };
      }, budget),
      {
        a: { verdict: "contradicted", disputes: [contradicts("b")] },
        b: { verdict: "contradicted", disputes: [contradicts("a")] },
      }
    );
    // Ledger says this pair is already resolved (any status).
    rec.deps.getExistingResolution = () => ({ status: "applied" });
    const result = await runBackfillForProject("p", docs, {
      resolveDeps: rec.deps,
      hasResolution: () => false, // selection lets it through...
      budget,
      maxPairs: 100,
    });
    expect(result.selected).toBe(1);
    // ...but the resolver short-circuits before any spawn or ledger write.
    expect(spawns).toBe(0);
    expect(rec.records).toHaveLength(0);
    expect(result.applied).toBe(0);
  });

  test("the spawn budget halts backfill and the rest is counted as skipped", async () => {
    let spawns = 0;
    const docs = [flagged("a", ["b"]), flagged("b", ["a"]), flagged("c", ["d"]), flagged("d", ["c"])];
    const budget = makeSpawnBudget(1); // room for ONE resolver spawn this run
    const rec = makeResolveDeps(
      { a: claim("a"), b: claim("b"), c: claim("c"), d: claim("d") },
      budgetedResolver(async (input) => {
        spawns++;
        return { type: "supersede", winnerSlug: input.a.slug, loserSlug: input.b.slug, rationale: "r" };
      }, budget),
      {
        a: { verdict: "contradicted", disputes: [contradicts("b")] },
        b: { verdict: "contradicted", disputes: [contradicts("a")] },
        c: { verdict: "contradicted", disputes: [contradicts("d")] },
        d: { verdict: "contradicted", disputes: [contradicts("c")] },
      }
    );
    const result = await runBackfillForProject("p", docs, {
      resolveDeps: rec.deps,
      hasResolution: () => false,
      budget,
      maxPairs: 100,
    });
    expect(result.selected).toBe(2); // both pairs were unresolved...
    expect(spawns).toBe(1); // ...but only one spawn was affordable
    expect(result.applied).toBe(1);
    expect(result.skipped).toBe(1); // the other is skipped, not silently dropped
    expect(budget.remaining()).toBe(0);
  });
});

describe("runDetectionForProject", () => {
  test("runs detection over unflagged docs with widened recall, and skips flagged ones", async () => {
    // "solo" carries no contradiction flag → a missed-detection subject.
    // The flagged (a,b) pair is owned by backfill and excluded from detection.
    let judgeCalls = 0;
    let capturedLimit = -1;
    const coherence: ReverifyCoherenceDeps = {
      backend: {
        embeddingsEnabled: true,
        search: async (_p: string, _q: string, options?: SearchOptions) => {
          capturedLimit = options?.limit ?? -1;
          return [searchHit("opposed", 0.8)];
        },
        readAcceptedDoc: async () => acceptedDoc("Opposed", "An opposing claim."),
        getDoc: () => null,
      } as ReverifyCoherenceDeps["backend"],
      judge: async () => {
        judgeCalls++;
        return { contradicts: true, reason: "opposes" };
      },
      recordVerdict: () => {},
    };
    const docs = [doc({ slug: "solo", title: "Solo", body: "x" }), flagged("a", ["b"]), flagged("b", ["a"])];
    const budget = makeSpawnBudget(50);
    const result = await runDetectionForProject("p", docs, {
      coherence,
      budget,
      detectSearchLimit: 7,
    });

    // Only "solo" is fed to detection; the flagged endpoints are excluded.
    expect(result.subjects).toBe(1);
    expect(judgeCalls).toBeGreaterThan(0);
    // The widened recall breadth is threaded through to the search seam.
    expect(capturedLimit).toBe(7);
  });

  test("a playbook is never a detection subject", async () => {
    let judgeCalls = 0;
    const coherence: ReverifyCoherenceDeps = {
      backend: {
        embeddingsEnabled: true,
        search: async () => [searchHit("deploy-runbook", 0.9)],
        readAcceptedDoc: async () => acceptedDoc("Deploy runbook", "Always use the canary."),
        getDoc: () => null,
      } as ReverifyCoherenceDeps["backend"],
      judge: async () => {
        judgeCalls++;
        return { contradicts: true, reason: "opposes" };
      },
      recordVerdict: () => {},
    };
    const docs = [doc({ slug: "playbook-alice--deploy", title: "Deploy", body: "deploy without the canary", sourceKind: "playbook", scope: "user", ownerUser: "alice" })];
    const result = await runDetectionForProject("p", docs, { coherence, budget: makeSpawnBudget(50), detectSearchLimit: 7 });
    expect(result.subjects).toBe(0);
    expect(judgeCalls).toBe(0);
  });

  test("detection stops feeding subjects once the spawn budget is exhausted", async () => {
    let judgeCalls = 0;
    // ONE budget shared by the run-level guard and the wrapped judge, single slot.
    const budget = makeSpawnBudget(1);
    const coherence: ReverifyCoherenceDeps = {
      backend: {
        embeddingsEnabled: true,
        search: async () => [searchHit("opposed", 0.8)],
        readAcceptedDoc: async () => acceptedDoc("Opposed", "An opposing claim."),
        getDoc: () => null,
      } as ReverifyCoherenceDeps["backend"],
      judge: budgetedJudge(async () => {
        judgeCalls++;
        return { contradicts: false, reason: "" };
      }, budget),
      recordVerdict: () => {},
    };
    const docs = [
      doc({ slug: "s1", title: "S1", body: "x" }),
      doc({ slug: "s2", title: "S2", body: "y" }),
      doc({ slug: "s3", title: "S3", body: "z" }),
    ];
    const result = await runDetectionForProject("p", docs, {
      coherence,
      budget,
      detectSearchLimit: 12,
    });
    // Only the first subject could spend the single judge slot; the rest are
    // skipped once the budget is gone, never silently processed for free.
    expect(judgeCalls).toBe(1);
    expect(result.subjects).toBeLessThan(docs.length);
    expect(result.skipped).toBeGreaterThan(0);
  });

  test("re-reads the LIVE verdict and skips a subject backfill superseded after the snapshot", async () => {
    // The stale-snapshot revival bug (findings 1 & 5): `docs` was snapshotted before
    // backfill tombstoned "loser". The snapshot still shows it clean + non-endpoint,
    // but its LIVE verdict is now "superseded". Feeding it to detection would
    // re-recall its opposing doc and the re-flag would strip the tombstone.
    let judgeCalls = 0;
    const staleSubject = doc({ slug: "loser", title: "Loser", body: "x" });
    const coherence: ReverifyCoherenceDeps = {
      backend: {
        embeddingsEnabled: true,
        search: async () => [searchHit("winner", 0.9)],
        readAcceptedDoc: async () => acceptedDoc("Winner", "The opposing, still-live claim."),
        // The LIVE index says "loser" was tombstoned by a backfill this run.
        getDoc: (_p: string, slug: string) =>
          slug === "loser" ? ({ verdict: "superseded" } as KnowledgeDoc) : null,
      } as ReverifyCoherenceDeps["backend"],
      judge: async () => {
        judgeCalls++;
        return { contradicts: true, reason: "opposes" };
      },
      recordVerdict: () => {},
    };
    const budget = makeSpawnBudget(50);
    const result = await runDetectionForProject("p", [staleSubject], {
      coherence,
      budget,
      detectSearchLimit: 12,
    });
    // The superseded subject is skipped before any judge spawn — no revival.
    expect(judgeCalls).toBe(0);
    expect(result.subjects).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test("re-reads the LIVE doc and skips a subject an earlier detection flagged as a contradiction endpoint", async () => {
    // FIX A, other half of the snapshot subject guard: "subj" was clean and a
    // non-endpoint when the snapshot was taken, but an earlier subject's detection
    // this run has since flagged it (it now carries a Contradicts dispute). The
    // flagged pair is the backfill phase's to own; re-judging it here would only
    // re-spend the budget, so the live re-read must skip it before any judge spawn.
    let judgeCalls = 0;
    const staleSubject = doc({ slug: "subj", title: "Subj", body: "x" }); // clean in snapshot
    const coherence: ReverifyCoherenceDeps = {
      backend: {
        embeddingsEnabled: true,
        search: async () => [searchHit("other", 0.9)],
        readAcceptedDoc: async () => acceptedDoc("Other", "An opposing claim."),
        // The LIVE index shows "subj" freshly flagged as a contradiction endpoint.
        getDoc: (_p: string, slug: string) =>
          slug === "subj"
            ? ({ verdict: "contradicted", disputes: [contradicts("other")] } as unknown as KnowledgeDoc)
            : null,
      } as ReverifyCoherenceDeps["backend"],
      judge: async () => {
        judgeCalls++;
        return { contradicts: true, reason: "opposes" };
      },
      recordVerdict: () => {},
    };
    const budget = makeSpawnBudget(50);
    const result = await runDetectionForProject("p", [staleSubject], {
      coherence,
      budget,
      detectSearchLimit: 12,
    });
    expect(judgeCalls).toBe(0);
    expect(result.subjects).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test("skips a subject swept within the cooldown window without spawning", async () => {
    let judgeCalls = 0;
    const coherence: ReverifyCoherenceDeps = {
      backend: {
        embeddingsEnabled: true,
        search: async () => [searchHit("opposed", 0.8)],
        readAcceptedDoc: async () => acceptedDoc("Opposed", "An opposing claim."),
        getDoc: () => null,
      } as ReverifyCoherenceDeps["backend"],
      judge: async () => {
        judgeCalls++;
        return { contradicts: false, reason: "" };
      },
      recordVerdict: () => {},
    };
    const swept: string[] = [];
    const budget = makeSpawnBudget(50);
    const docs = [
      doc({ slug: "cool", title: "Cool", body: "x" }), // in cooldown → skipped
      doc({ slug: "fresh", title: "Fresh", body: "y" }), // never swept → judged
    ];
    const result = await runDetectionForProject("p", docs, {
      coherence,
      budget,
      detectSearchLimit: 12,
      inCooldown: (slug) => slug === "cool",
      markSwept: (slug) => swept.push(slug),
    });
    // "cool" stepped aside (no spawn); only "fresh" was judged and recorded swept.
    expect(result.subjects).toBe(1);
    expect(result.skipped).toBe(1);
    expect(swept).toEqual(["fresh"]);
    expect(judgeCalls).toBe(1);
  });

  test("a doc edited after being swept is NOT skipped by cooldown on the next sweep", async () => {
    // Edit-aware cooldown: both docs were swept 2 days ago (well inside the 14-day
    // window), but one was edited AFTER that sweep. The real inDetectCooldown decides,
    // so the edited doc re-opens for a re-check while the unchanged one steps aside.
    const now = new Date("2026-02-01T00:00:00Z");
    const cooldownMs = AUDIT_DETECT_COOLDOWN_DAYS * 86_400_000;
    const sweptStamp = "2026-01-30"; // both docs last swept on this date
    const swept: string[] = [];
    let judgeCalls = 0;
    const coherence: ReverifyCoherenceDeps = {
      backend: {
        embeddingsEnabled: true,
        search: async () => [searchHit("opposed", 0.8)],
        readAcceptedDoc: async () => acceptedDoc("Opposed", "An opposing claim."),
        getDoc: () => null,
      } as ReverifyCoherenceDeps["backend"],
      judge: async () => {
        judgeCalls++;
        return { contradicts: false, reason: "" };
      },
      recordVerdict: () => {},
    };
    const docs = [
      // Unchanged since the sweep → still in cooldown, skipped.
      doc({ slug: "unchanged", title: "U", body: "x", updatedAt: new Date("2026-01-29T00:00:00Z") }),
      // Edited AFTER the sweep → cooldown re-opens it, judged again.
      doc({ slug: "edited", title: "E", body: "y", updatedAt: new Date("2026-01-31T00:00:00Z") }),
    ];
    const budget = makeSpawnBudget(50);
    const result = await runDetectionForProject("p", docs, {
      coherence,
      budget,
      detectSearchLimit: 12,
      inCooldown: (_slug, updatedAt) => inDetectCooldown(sweptStamp, updatedAt, now, cooldownMs),
      markSwept: (slug) => swept.push(slug),
    });
    // Only the edited doc is re-judged; the unchanged one stays in cooldown.
    expect(swept).toEqual(["edited"]);
    expect(result.subjects).toBe(1);
    expect(result.skipped).toBe(1);
    expect(judgeCalls).toBe(1);
  });

  test("a subject whose detection errored is NOT marked swept and stays eligible next run", async () => {
    // A transient search failure inside runReverifyContradictionPass is swallowed and
    // the pass still returns — but the subject must NOT be marked swept, so it stays
    // eligible next run rather than entering the 14-day cooldown on a transient error.
    const swept: string[] = [];
    let searchCalls = 0;
    const coherence: ReverifyCoherenceDeps = {
      backend: {
        embeddingsEnabled: true,
        search: async () => {
          searchCalls++;
          throw new Error("transient search failure");
        },
        readAcceptedDoc: async () => acceptedDoc("Opposed", "An opposing claim."),
        getDoc: () => null,
      } as ReverifyCoherenceDeps["backend"],
      judge: async () => ({ contradicts: false, reason: "" }),
      recordVerdict: () => {},
    };
    const budget = makeSpawnBudget(50);
    const docs = [doc({ slug: "boom", title: "Boom", body: "x" })];
    const result = await runDetectionForProject("p", docs, {
      coherence,
      budget,
      detectSearchLimit: 12,
      markSwept: (slug) => swept.push(slug),
    });
    // No swept stamp written for the errored subject → still eligible next run.
    expect(swept).toEqual([]);
    expect(result.subjects).toBe(0);
    expect(result.skipped).toBe(1);
    expect(searchCalls).toBe(1);
  });
});

// ── Edit-aware missed-detection cooldown ────────────────────────────────────────

describe("inDetectCooldown", () => {
  const cooldownMs = AUDIT_DETECT_COOLDOWN_DAYS * 86_400_000;
  const now = new Date("2026-02-01T00:00:00Z");

  test("swept recently and unchanged since → in cooldown", () => {
    expect(inDetectCooldown("2026-01-30", new Date("2026-01-20T00:00:00Z"), now, cooldownMs)).toBe(true);
  });

  test("edited after the sweep re-opens the doc even inside the window", () => {
    expect(inDetectCooldown("2026-01-30", new Date("2026-01-31T00:00:00Z"), now, cooldownMs)).toBe(false);
  });

  test("swept outside the window → not in cooldown", () => {
    expect(inDetectCooldown("2026-01-01", new Date("2025-12-01T00:00:00Z"), now, cooldownMs)).toBe(false);
  });

  test("absent or unparseable stamp → never in cooldown", () => {
    expect(inDetectCooldown(null, new Date("2026-01-01T00:00:00Z"), now, cooldownMs)).toBe(false);
    expect(inDetectCooldown("not-a-date", new Date("2026-01-01T00:00:00Z"), now, cooldownMs)).toBe(false);
  });
});

// ── Project rotation (starvation fix) ───────────────────────────────────────────

describe("rotateProjectsByCursor", () => {
  test("rotates the start so every project leads within N nights", () => {
    const ids = ["aaa", "mmm", "zzz"];
    expect(rotateProjectsByCursor(ids, 0)).toEqual(["aaa", "mmm", "zzz"]);
    expect(rotateProjectsByCursor(ids, 1)).toEqual(["mmm", "zzz", "aaa"]);
    expect(rotateProjectsByCursor(ids, 2)).toEqual(["zzz", "aaa", "mmm"]);
    expect(rotateProjectsByCursor(ids, 3)).toEqual(["aaa", "mmm", "zzz"]); // wraps
  });

  test("empty / single project and a corrupt cursor are handled", () => {
    expect(rotateProjectsByCursor([], 5)).toEqual([]);
    expect(rotateProjectsByCursor(["only"], 7)).toEqual(["only"]);
    expect(rotateProjectsByCursor(["a", "b"], NaN)).toEqual(["a", "b"]); // NaN → 0
    expect(rotateProjectsByCursor(["a", "b"], -1)).toEqual(["b", "a"]); // negative safe
  });
});

// ── Whole-graph orchestration (budget starvation fix) ───────────────────────────

describe("runGraphAudit — two-phase, cursor, budget fairness", () => {
  /** A coherence whose search always surfaces one opposing candidate the judge
   *  confirms, so every unflagged subject costs exactly one judge spawn. */
  function detectingCoherence(judgeCalls: { n: number }, budget: ReturnType<typeof makeSpawnBudget>): ReverifyCoherenceDeps {
    return {
      backend: {
        embeddingsEnabled: true,
        // Echo the searched project id so the candidate isn't filtered out as
        // cross-project (searchHit hardcodes "p").
        search: async (pid: string) => [{ ...searchHit("opp", 0.9), projectId: pid }],
        readAcceptedDoc: async () => acceptedDoc("Opp", "opposing"),
        getDoc: () => null,
      } as ReverifyCoherenceDeps["backend"],
      judge: budgetedJudge(async () => {
        judgeCalls.n++;
        return { contradicts: false, reason: "" };
      }, budget),
      recordVerdict: () => {},
    };
  }

  function unflagged(project: string, n: number): KnowledgeDoc[] {
    return Array.from({ length: n }, (_i, k) =>
      doc({ projectId: project, slug: `${project}-d${k}`, title: `${project} ${k}`, body: "x" })
    );
  }

  test("runs EVERY project's backfill before ANY project's detection (backfill never starved)", async () => {
    // 'aaa' has 100 unflagged docs (detection fodder); 'zzz' holds a stranded
    // flagged pair (the primary target). Budget only fits a handful of spawns. Under
    // the prior per-project shape, 'aaa' detection drained the budget and 'zzz'
    // backfill never ran. The global backfill-first phase must resolve 'zzz' first.
    const budget = makeSpawnBudget(3);
    const judgeCalls = { n: 0 };
    let resolverSpawns = 0;
    const byProject = new Map<string, KnowledgeDoc[]>([
      ["aaa", unflagged("aaa", 100)],
      [
        "zzz",
        [
          flagged("z-keep", ["z-drop"], { projectId: "zzz" }),
          flagged("z-drop", ["z-keep"], { projectId: "zzz" }),
        ],
      ],
    ]);
    const rec = makeResolveDeps(
      { "z-keep": claim("z-keep", { confidence: 0.3 }), "z-drop": claim("z-drop") },
      budgetedResolver(async () => {
        resolverSpawns++;
        return { type: "supersede", winnerSlug: "z-keep", loserSlug: "z-drop", rationale: "outdated" };
      }, budget),
      {
        "z-keep": { verdict: "contradicted", disputes: [contradicts("z-drop")] },
        "z-drop": { verdict: "contradicted", disputes: [contradicts("z-keep")] },
      }
    );
    const deps: GraphAuditDeps = {
      resolveDeps: rec.deps,
      coherence: detectingCoherence(judgeCalls, budget),
      hasResolution: () => false,
      budget,
      maxPairs: 100,
      detectSearchLimit: 12,
      cursor: 0,
    };
    const result = await runGraphAudit(byProject, deps);

    // The stranded pair in 'zzz' was backfilled before 'aaa' detection could drain
    // the budget — the primary goal is no longer starved by speculative detection.
    expect(resolverSpawns).toBe(1);
    expect(result.backfillApplied).toBe(1);
    expect(rec.verdicts.find((v) => v.slug === "z-drop")!.verdict).toBe("superseded");
    // Only the leftover budget went to detection.
    expect(judgeCalls.n).toBeLessThanOrEqual(2);
    expect(result.nextCursor).toBe(1);
  });

  test("cursor rotation lets a starved project lead the next night", async () => {
    // Two projects, each with more detection docs than the budget can sweep in one
    // night. Night 1 (cursor 0) sweeps 'aaa'; night 2 (cursor 1) must start at 'bbb'
    // so the previously-starved project is no longer perpetually last.
    const byProject = new Map<string, KnowledgeDoc[]>([
      ["aaa", unflagged("aaa", 10)],
      ["bbb", unflagged("bbb", 10)],
    ]);
    const seen: string[] = [];
    function depsFor(cursor: number, budget: ReturnType<typeof makeSpawnBudget>): GraphAuditDeps {
      const rec = makeResolveDeps({}, async () => null);
      return {
        resolveDeps: rec.deps,
        coherence: {
          backend: {
            embeddingsEnabled: true,
            search: async (pid: string) => [{ ...searchHit("opp", 0.9), projectId: pid }],
            readAcceptedDoc: async () => acceptedDoc("Opp", "opposing"),
            getDoc: () => null,
          } as ReverifyCoherenceDeps["backend"],
          judge: budgetedJudge(async () => ({ contradicts: false, reason: "" }), budget),
          recordVerdict: () => {},
        },
        hasResolution: () => false,
        budget,
        maxPairs: 100,
        detectSearchLimit: 12,
        cursor,
        // Record which project each swept doc belongs to, and never cool down.
        markSwept: (projectId) => seen.push(projectId),
      };
    }

    const night1 = makeSpawnBudget(3);
    const r1 = await runGraphAudit(byProject, depsFor(0, night1));
    expect(seen.every((p) => p === "aaa")).toBe(true); // night 1 swept only 'aaa'
    expect(r1.nextCursor).toBe(1);

    seen.length = 0;
    const night2 = makeSpawnBudget(3);
    await runGraphAudit(byProject, depsFor(r1.nextCursor, night2));
    // Night 2 starts at 'bbb' (rotation), so the previously-starved project leads.
    expect(seen[0]).toBe("bbb");
  });
});

// ── Daily gate + cursor persistence under an injectable clock (FIX C) ────────────

describe("tick — injectable clock gates the daily run and persists the rotation cursor", () => {
  /** A no-op KnowledgeSync: an empty corpus never reaches these write seams, so the
   *  tick exercises only the gate + cursor persistence, with no model spawn. */
  const sync = {
    recordDocVerdict: () => {},
    clearDocVerdict: () => {},
    syncProject: async () => {},
  } as unknown as KnowledgeSync;
  /** Judge/resolver stubs so a hypothetical spawn never shells out to `claude`. */
  const opts = {
    contradictionJudge: async () => ({ contradicts: false, reason: "" }),
    contradictionResolver: async () => null,
  };

  test("the daily gate reads opts.now, and the cursor advances only on a non-gated run", async () => {
    const store = createStore(":memory:");
    try {
      // Day 1, first run: sweeps, records the day, advances the cursor 0 → 1.
      await tick(store.db, sync, "", { ...opts, now: () => new Date("2026-01-15T03:00:00") });
      expect(getSetting(store.db, AUDIT_LAST_RUN_KEY)).toBe("2026-01-15");
      expect(getSetting(store.db, AUDIT_CURSOR_KEY)).toBe("1");

      // Same day (e.g. a `bun --watch` restart): the injected clock still reads
      // 2026-01-15, so the daily gate holds — no re-sweep, cursor unchanged.
      await tick(store.db, sync, "", { ...opts, now: () => new Date("2026-01-15T23:00:00") });
      expect(getSetting(store.db, AUDIT_CURSOR_KEY)).toBe("1");

      // Next day: the clock advances, the gate opens, the cursor advances 1 → 2.
      await tick(store.db, sync, "", { ...opts, now: () => new Date("2026-01-16T03:00:00") });
      expect(getSetting(store.db, AUDIT_LAST_RUN_KEY)).toBe("2026-01-16");
      expect(getSetting(store.db, AUDIT_CURSOR_KEY)).toBe("2");
    } finally {
      store.close();
    }
  });
});
