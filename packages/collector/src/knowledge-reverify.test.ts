import { expect, test, describe } from "bun:test";
import { INITIAL_CONFIDENCE, DISPUTED_CONFIDENCE, type KnowledgeDoc } from "@standup/knowledge";
import { UNVERIFIED_CONFIDENCE, type DraftVerification } from "./draft-verify.js";
import { MAX_REVERIFY_ATTEMPTS } from "./knowledge-freshness.js";
import type { Staleness } from "./knowledge-staleness.js";
import {
  REVERIFY_RETRY_COOLDOWN_DAYS,
  selectReverifyCandidates,
  stalenessRisk,
  reverifyPriority,
  reverifyDoc,
  runReverifyContradictionPass,
  type ReverifyTarget,
  type ReverifyDeps,
  type ReverifyCoherenceDeps,
} from "./knowledge-reverify.js";
import type { SearchResult } from "@standup/knowledge";

function doc(overrides: Partial<KnowledgeDoc>): KnowledgeDoc {
  return {
    id: overrides.slug ?? "id",
    projectId: "p",
    slug: "s",
    title: "T",
    body: "B",
    updatedAt: new Date(),
    filePath: "/x",
    generatedFromSha: "abc123",
    ...overrides,
  };
}

function reachable(stale: boolean): Staleness {
  return { sha: "abc123", reachable: true, commitsSince: stale ? 99 : 1, filesChanged: 1, stale };
}

const OLD = "2026-01-01T00:00:00.000Z";
const NEW = "2026-06-01T00:00:00.000Z";

describe("selectReverifyCandidates", () => {
  test("an agent doc awaiting its publish fact-check is left to that check", () => {
    const pending: ReverifyTarget = {
      doc: doc({ slug: "pending", originClass: "agent", confidence: UNVERIFIED_CONFIDENCE, generatedFromSha: undefined }),
      staleness: null,
      currentConfidence: UNVERIFIED_CONFIDENCE,
    };
    const verified: ReverifyTarget = {
      doc: doc({ slug: "verified", originClass: "agent", confidence: UNVERIFIED_CONFIDENCE, lastVerifiedAt: OLD }),
      staleness: null,
      currentConfidence: UNVERIFIED_CONFIDENCE,
    };
    expect(selectReverifyCandidates([pending, verified], 10, new Date(NEW)).map((t) => t.doc.slug)).toEqual(["verified"]);
  });

  test("a doc whose last fact-check reached no verdict waits out a cooldown, and is dropped after the attempt cap", () => {
    const now = new Date(NEW);
    const recently = new Date(now.getTime() - (REVERIFY_RETRY_COOLDOWN_DAYS - 1) * 86_400_000).toISOString();
    const longAgo = new Date(now.getTime() - (REVERIFY_RETRY_COOLDOWN_DAYS + 1) * 86_400_000).toISOString();
    const target = (slug: string, attempts: number, lastAttemptAt: string): ReverifyTarget => ({
      doc: doc({ slug }),
      staleness: null,
      currentConfidence: 0.3,
      attempts: { attempts, lastOutcome: "unverified", lastAttemptAt },
    });
    const picked = selectReverifyCandidates(
      [
        target("cooling", 1, recently),
        target("retry", 1, longAgo),
        target("exhausted", MAX_REVERIFY_ATTEMPTS, longAgo),
        { doc: doc({ slug: "fresh" }), staleness: null, currentConfidence: 0.3, attempts: { attempts: 0 } },
      ],
      10,
      now
    );
    expect(picked.map((t) => t.doc.slug).sort()).toEqual(["fresh", "retry"]);
  });

  test("includes docs with no provenance — owner-written docs are re-verified too", () => {
    const human: ReverifyTarget = {
      doc: doc({ slug: "human", generatedFromSha: undefined }),
      staleness: null,
      currentConfidence: 0.1,
    };
    const generated: ReverifyTarget = {
      doc: doc({ slug: "gen" }),
      staleness: reachable(false),
      currentConfidence: 0.9,
    };
    const picked = selectReverifyCandidates([human, generated], 10);
    expect(picked.map((t) => t.doc.slug)).toEqual(["human", "gen"]);
  });

  test("retrieval frequency lifts a heavily-read doc over an unread one at the same risk", () => {
    const unread: ReverifyTarget = {
      doc: doc({ slug: "unread" }),
      staleness: reachable(false),
      currentConfidence: 0.6,
      retrievals: 0,
    };
    const read: ReverifyTarget = {
      doc: doc({ slug: "read" }),
      staleness: reachable(false),
      currentConfidence: 0.8,
      retrievals: 40,
    };
    const picked = selectReverifyCandidates([unread, read], 1);
    expect(picked.map((t) => t.doc.slug)).toEqual(["read"]);
  });

  test("a deterministic finding raises risk, so it outranks an equally-read doc without one", () => {
    const clean: ReverifyTarget = { doc: doc({ slug: "clean" }), staleness: null, currentConfidence: 0.7, retrievals: 3 };
    const found: ReverifyTarget = {
      doc: doc({ slug: "found" }),
      staleness: null,
      currentConfidence: 0.9,
      retrievals: 3,
      evidence: [{ kind: "missing-path", detail: "src/a.ts" }],
    };
    expect(stalenessRisk(found)).toBeGreaterThan(stalenessRisk(clean));
    expect(reverifyPriority(found)).toBeCloseTo(4 * 0.6, 10);
    expect(selectReverifyCandidates([clean, found], 2).map((t) => t.doc.slug)).toEqual(["found", "clean"]);
  });

  test("drift-flagged docs are selected ahead of fresher, higher-confidence ones", () => {
    const fresh: ReverifyTarget = {
      doc: doc({ slug: "fresh", lastVerifiedAt: NEW }),
      staleness: reachable(false),
      currentConfidence: 0.95,
    };
    const drifted: ReverifyTarget = {
      doc: doc({ slug: "drifted", lastVerifiedAt: NEW }),
      staleness: reachable(true),
      currentConfidence: 0.95,
    };
    const picked = selectReverifyCandidates([fresh, drifted], 10);
    expect(picked[0].doc.slug).toBe("drifted");
  });

  test("among non-drifted docs, the lowest current confidence comes first", () => {
    const high: ReverifyTarget = {
      doc: doc({ slug: "high" }),
      staleness: reachable(false),
      currentConfidence: 0.9,
    };
    const low: ReverifyTarget = {
      doc: doc({ slug: "low" }),
      staleness: reachable(false),
      currentConfidence: 0.2,
    };
    const picked = selectReverifyCandidates([high, low], 10);
    expect(picked.map((t) => t.doc.slug)).toEqual(["low", "high"]);
  });

  test("ties on drift and confidence break to the oldest last-verified", () => {
    const newer: ReverifyTarget = {
      doc: doc({ slug: "newer", lastVerifiedAt: NEW }),
      staleness: reachable(false),
      currentConfidence: 0.5,
    };
    const older: ReverifyTarget = {
      doc: doc({ slug: "older", lastVerifiedAt: OLD }),
      staleness: reachable(false),
      currentConfidence: 0.5,
    };
    const picked = selectReverifyCandidates([newer, older], 10);
    expect(picked.map((t) => t.doc.slug)).toEqual(["older", "newer"]);
  });

  test("honors the limit, keeping the most-urgent docs", () => {
    // Risk: b has lost 0.9 of its confidence; a has lost 0.1 plus repo-wide
    // drift (0.25); c has lost 0.1 only.
    const targets: ReverifyTarget[] = [
      { doc: doc({ slug: "a" }), staleness: reachable(true), currentConfidence: 0.9 },
      { doc: doc({ slug: "b" }), staleness: reachable(false), currentConfidence: 0.1 },
      { doc: doc({ slug: "c" }), staleness: reachable(false), currentConfidence: 0.9 },
    ];
    const picked = selectReverifyCandidates(targets, 2);
    expect(picked.map((t) => t.doc.slug)).toEqual(["b", "a"]);
  });

  test("a doc re-verified within the cooldown window is not re-selected, letting an aging doc through", () => {
    const now = new Date("2026-06-15T00:00:00.000Z");
    // A persistently-disputed doc, verified 3 days ago and pinned at the lowest
    // confidence — without a cooldown it would win the confidence sort every
    // day and monopolize the budget.
    const justDisputed: ReverifyTarget = {
      doc: doc({ slug: "disputed", lastVerifiedAt: "2026-06-12T00:00:00.000Z" }),
      staleness: reachable(false),
      currentConfidence: 0.1,
    };
    // A still-clean doc that is merely aging — verified 100 days ago, so past
    // the cooldown and genuinely due for a re-check.
    const aging: ReverifyTarget = {
      doc: doc({ slug: "aging", lastVerifiedAt: "2026-03-07T00:00:00.000Z" }),
      staleness: reachable(false),
      currentConfidence: 0.5,
    };
    const picked = selectReverifyCandidates([justDisputed, aging], 3, now);
    // The recently-verified disputed doc steps aside; the aging doc gets its turn.
    expect(picked.map((t) => t.doc.slug)).toEqual(["aging"]);
  });

  test("a doc never verified (no last_verified_at) is never in cooldown", () => {
    const now = new Date("2026-06-15T00:00:00.000Z");
    const neverVerified: ReverifyTarget = {
      doc: doc({ slug: "new", lastVerifiedAt: undefined }),
      staleness: reachable(false),
      currentConfidence: 0.9,
    };
    const picked = selectReverifyCandidates([neverVerified], 3, now);
    expect(picked.map((t) => t.doc.slug)).toEqual(["new"]);
  });

  test("a contradiction endpoint sorts ahead of an older, lower-confidence aging doc", () => {
    // A doc flagged as contradicting another accepted doc — full confidence and
    // freshly verified, so no confidence/recency key would surface it — must
    // still win over an older, decayed, merely-aging doc.
    const flagged: ReverifyTarget = {
      doc: doc({
        slug: "conflict",
        lastVerifiedAt: NEW,
        disputes: [{ claim: "Contradicts other", finding: "opposing", evidence: "e" }],
      }),
      staleness: reachable(false),
      currentConfidence: 0.95,
    };
    const aging: ReverifyTarget = {
      doc: doc({ slug: "aging", lastVerifiedAt: OLD }),
      staleness: reachable(false),
      currentConfidence: 0.3,
    };
    const picked = selectReverifyCandidates([aging, flagged], 10);
    expect(picked.map((t) => t.doc.slug)).toEqual(["conflict", "aging"]);
  });
});

/** A recording set of deps for reverifyDoc. */
function makeDeps(verification: DraftVerification, nowIso = NEW) {
  const calls = {
    updateConfidence: [] as Array<{
      slug: string;
      confidence: number;
      lastVerifiedAt: string;
      generatedFromSha?: string;
    }>,
    resync: [] as string[],
    recordVerdict: [] as Array<{ slug: string; verdict: string; disputes: unknown[] }>,
  };
  const deps: ReverifyDeps = {
    verify: async () => verification,
    updateConfidence: async (_projectId, slug, confidence, lastVerifiedAt, generatedFromSha) => {
      calls.updateConfidence.push({ slug, confidence, lastVerifiedAt, generatedFromSha });
    },
    resync: async (projectId) => {
      calls.resync.push(projectId);
    },
    recordVerdict: (_projectId, slug, verdict, disputes) => {
      calls.recordVerdict.push({ slug, verdict, disputes });
    },
    now: () => new Date(nowIso),
  };
  return { deps, calls };
}

const HEAD = "head9999";

describe("reverifyDoc", () => {
  test("a clean pass resets confidence to full, stamps now, and re-baselines the sha to HEAD", async () => {
    const { deps, calls } = makeDeps({ verdict: "clean", disputes: [] });
    const verdict = await reverifyDoc(deps, "p", doc({ slug: "s" }), "/repo", HEAD);

    expect(verdict).toBe("clean");
    // generated_from_sha advances to current HEAD so the commit-drift signal
    // stops reporting the doc stale against the commit it was distilled from.
    expect(calls.updateConfidence).toEqual([
      { slug: "s", confidence: INITIAL_CONFIDENCE, lastVerifiedAt: NEW, generatedFromSha: HEAD },
    ]);
    // The verdict is recorded AFTER the resync, so the resync's upsert can't
    // clobber it.
    expect(calls.resync).toEqual(["p"]);
    expect(calls.recordVerdict).toEqual([{ slug: "s", verdict: "clean", disputes: [] }]);
  });

  test("a clean pass on an owner-written doc (no sha) lifts confidence without stamping a sha", async () => {
    const { deps, calls } = makeDeps({ verdict: "clean", disputes: [] });
    await reverifyDoc(deps, "p", doc({ slug: "owner", generatedFromSha: undefined }), "/repo", HEAD);
    expect(calls.updateConfidence).toEqual([
      { slug: "owner", confidence: INITIAL_CONFIDENCE, lastVerifiedAt: NEW, generatedFromSha: undefined },
    ]);
  });

  test("a clean pass with no resolvable HEAD leaves the sha unchanged", async () => {
    const { deps, calls } = makeDeps({ verdict: "clean", disputes: [] });
    await reverifyDoc(deps, "p", doc({ slug: "s" }), "/repo", null);
    expect(calls.updateConfidence[0].generatedFromSha).toBeUndefined();
  });

  test("a disproven doc is flagged and does NOT re-baseline its sha", async () => {
    const disputes = [{ claim: "does X", finding: "does not", evidence: "rg" }];
    const { deps, calls } = makeDeps({ verdict: "disputed", disputes });
    const verdict = await reverifyDoc(deps, "p", doc({ slug: "s" }), "/repo", HEAD);

    expect(verdict).toBe("disputed");
    expect(calls.updateConfidence[0].confidence).toBe(DISPUTED_CONFIDENCE);
    expect(DISPUTED_CONFIDENCE).toBeLessThan(0.25); // below MIN_INJECTION_CONFIDENCE
    // The doc is wrong at HEAD — re-baselining would falsely clear its drift flag.
    expect(calls.updateConfidence[0].generatedFromSha).toBeUndefined();
    expect(calls.recordVerdict).toEqual([{ slug: "s", verdict: "disputed", disputes }]);
  });

  test("an errored verification leaves the doc entirely untouched", async () => {
    const { deps, calls } = makeDeps({ verdict: "error", disputes: [] });
    const verdict = await reverifyDoc(deps, "p", doc({ slug: "s" }), "/repo", HEAD);

    expect(verdict).toBe("error");
    expect(calls.updateConfidence).toEqual([]);
    expect(calls.resync).toEqual([]);
    expect(calls.recordVerdict).toEqual([]);
  });

  test("a verification that could not refresh mainline leaves the doc entirely untouched", async () => {
    const note = { claim: "unverifiable: could not refresh mainline of /repo (no origin remote)", finding: "f", evidence: "e", origin: "repo" as const };
    const { deps, calls } = makeDeps({ verdict: "unverifiable", disputes: [note] });
    const verdict = await reverifyDoc(deps, "p", doc({ slug: "s" }), "/repo", HEAD);

    expect(verdict).toBe("unverifiable");
    expect(calls.updateConfidence).toEqual([]);
    expect(calls.recordVerdict).toEqual([]);
  });

  const CONTRADICTION = { claim: "Contradicts other", finding: "opposing", evidence: "e" };

  test("a clean pass on a contradiction endpoint keeps it held out, never re-opening the injection gate", async () => {
    // The code fact-check affirms the doc against code, but it still opposes
    // another accepted doc — a doc<->doc conflict the fact-check cannot see. The
    // "contradicted" verdict and its dispute must survive, so a bare clean write
    // never re-admits a doc that still contradicts another.
    const { deps, calls } = makeDeps({ verdict: "clean", disputes: [] });
    const endpoint = doc({ slug: "s", confidence: 0.9, disputes: [CONTRADICTION] });
    const verdict = await reverifyDoc(deps, "p", endpoint, "/repo", HEAD);

    expect(verdict).toBe("contradicted");
    // Base confidence is preserved (a contradiction carries no confidence
    // penalty) and last_verified_at is bumped so the pass stops re-spawning on it
    // daily; the sha is NOT re-baselined (drift is moot while it is held out).
    expect(calls.updateConfidence).toEqual([
      { slug: "s", confidence: 0.9, lastVerifiedAt: NEW, generatedFromSha: undefined },
    ]);
    // The contradiction verdict + dispute survive the write untouched.
    expect(calls.recordVerdict).toEqual([
      { slug: "s", verdict: "contradicted", disputes: [CONTRADICTION] },
    ]);
  });

  test("a disputed pass on a contradiction endpoint keeps BOTH the code finding and the contradiction dispute", async () => {
    const codeDispute = { claim: "does X", finding: "does not", evidence: "rg" };
    const { deps, calls } = makeDeps({ verdict: "disputed", disputes: [codeDispute] });
    const endpoint = doc({ slug: "s", disputes: [CONTRADICTION] });
    const verdict = await reverifyDoc(deps, "p", endpoint, "/repo", HEAD);

    expect(verdict).toBe("disputed");
    expect(calls.updateConfidence[0].confidence).toBe(DISPUTED_CONFIDENCE);
    expect(calls.updateConfidence[0].generatedFromSha).toBeUndefined();
    // The code finding and the preserved contradiction dispute both land, so the
    // human loses neither the code refutation nor the contradiction reason.
    expect(calls.recordVerdict).toEqual([
      { slug: "s", verdict: "disputed", disputes: [codeDispute, CONTRADICTION] },
    ]);
  });
});

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

describe("runReverifyContradictionPass", () => {
  test("flags a clean doc and the accepted doc it contradicts (LLM judge mocked)", async () => {
    const writes: Array<{ slug: string; verdict: string }> = [];
    const coherence: ReverifyCoherenceDeps = {
      backend: {
        embeddingsEnabled: true,
        search: async () => [searchHit("uses-node", 0.8)],
        readAcceptedDoc: async () => acceptedDoc("Runtime", "The project runs on Node, never Bun."),
        getDoc: () => null,
      } as ReverifyCoherenceDeps["backend"],
      judge: async () => ({ contradicts: true, reason: "Bun vs Node" }),
      recordVerdict: (_p, slug, verdict) => writes.push({ slug, verdict }),
    };

    await runReverifyContradictionPass(coherence, "p", [
      doc({ slug: "uses-bun", title: "Runtime", body: "The project runs on Bun." }),
    ]);

    expect(writes.map((w) => w.slug).sort()).toEqual(["uses-bun", "uses-node"]);
    // Nothing tells the two sides apart (no provenance, confidence or age), so
    // both are marked contradicted (undecided) rather than one being trusted,
    // so both stay visible with a conflict marker.
    expect(writes.every((w) => w.verdict === "contradicted")).toBe(true);
  });

  test("fires onContradiction with the subject doc and the flagged slugs (feed seam)", async () => {
    const surfaced: Array<{ slug: string; title: string; contradicted: string[] }> = [];
    const coherence: ReverifyCoherenceDeps = {
      backend: {
        embeddingsEnabled: true,
        search: async () => [searchHit("uses-node", 0.8)],
        readAcceptedDoc: async () => acceptedDoc("Runtime", "The project runs on Node, never Bun."),
        getDoc: () => null,
      } as ReverifyCoherenceDeps["backend"],
      judge: async () => ({ contradicts: true, reason: "Bun vs Node" }),
      recordVerdict: () => {},
      onContradiction: (_p, slug, title, contradicted) =>
        surfaced.push({ slug, title, contradicted }),
    };

    await runReverifyContradictionPass(coherence, "p", [
      doc({ slug: "uses-bun", title: "Runtime", body: "The project runs on Bun." }),
    ]);

    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]!.slug).toBe("uses-bun");
    expect(surfaced[0]!.title).toBe("Runtime");
    expect(surfaced[0]!.contradicted).toContain("uses-node");
  });

  test("fires the resolver over each flagged pair with the contradicted slugs (wiring)", async () => {
    // The detection→resolver fire-and-forget seam: a confirmed contradiction must
    // actually invoke resolveContradictions with the subject and the OPPOSING docs
    // (never the subject itself), or the auto-resolve feature ships disconnected.
    const fired: Array<{ projectId: string; subject: string; contradicted: string[] }> = [];
    const coherence: ReverifyCoherenceDeps = {
      backend: {
        embeddingsEnabled: true,
        search: async () => [searchHit("uses-node", 0.8)],
        readAcceptedDoc: async () => acceptedDoc("Runtime", "The project runs on Node, never Bun."),
        getDoc: () => null,
      } as ReverifyCoherenceDeps["backend"],
      judge: async () => ({ contradicts: true, reason: "Bun vs Node" }),
      recordVerdict: () => {},
      resolveContradictions: (projectId, subject, contradicted) =>
        fired.push({ projectId, subject, contradicted: [...contradicted] }),
    };

    await runReverifyContradictionPass(coherence, "p", [
      doc({ slug: "uses-bun", title: "Runtime", body: "The project runs on Bun." }),
    ]);

    expect(fired).toHaveLength(1);
    expect(fired[0]!.projectId).toBe("p");
    expect(fired[0]!.subject).toBe("uses-bun");
    expect(fired[0]!.contradicted).toEqual(["uses-node"]);
    // The subject is the resolveContradiction subject, never one of its own
    // "contradicted" targets — passing `flagged` (which prepends the subject) here
    // would make the resolver try to resolve the subject against itself.
    expect(fired[0]!.contradicted).not.toContain("uses-bun");
  });

  test("does NOT fire the resolver when no contradiction is confirmed", async () => {
    let fired = 0;
    const coherence: ReverifyCoherenceDeps = {
      backend: {
        embeddingsEnabled: true,
        search: async () => [searchHit("unrelated", 0.8)],
        readAcceptedDoc: async () => acceptedDoc("Other", "An unrelated topic."),
        getDoc: () => null,
      } as ReverifyCoherenceDeps["backend"],
      judge: async () => ({ contradicts: false, reason: "" }),
      recordVerdict: () => {},
      resolveContradictions: () => {
        fired++;
      },
    };

    await runReverifyContradictionPass(coherence, "p", [
      doc({ slug: "solo", title: "Solo", body: "x" }),
    ]);

    expect(fired).toBe(0);
  });

  test("a per-doc failure does not abort the rest of the batch", async () => {
    const writes: string[] = [];
    let firstCall = true;
    const coherence: ReverifyCoherenceDeps = {
      backend: {
        embeddingsEnabled: true,
        search: async () => {
          if (firstCall) {
            firstCall = false;
            throw new Error("search hiccup");
          }
          return [searchHit("opposed", 0.8)];
        },
        readAcceptedDoc: async () => acceptedDoc("x", "y"),
        getDoc: () => null,
      } as ReverifyCoherenceDeps["backend"],
      judge: async () => ({ contradicts: true, reason: "r" }),
      recordVerdict: (_p, slug) => writes.push(slug),
    };

    await runReverifyContradictionPass(coherence, "p", [
      doc({ slug: "boom", title: "A", body: "a" }),
      doc({ slug: "second", title: "B", body: "b" }),
    ]);

    // First doc threw; second still flagged its contradiction.
    expect(writes).toContain("second");
    expect(writes).toContain("opposed");
  });
});
