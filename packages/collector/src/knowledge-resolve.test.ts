import { expect, test, describe, afterAll } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { DISPUTED_CONFIDENCE, type DraftDispute } from "@standup/knowledge";
import { parseContradictsClaim } from "@standup/knowledge";
import {
  writeKnowledgeFile,
  readKnowledgeFile,
  KnowledgeStore,
} from "@standup/knowledge";
import { createStore, upsertProject } from "@standup/store";
import type { DocVerdictState } from "./knowledge-coherence.js";
import { KnowledgeSync } from "./knowledge-sync.js";
import {
  resolveContradiction,
  acceptResolution,
  classifyResolution,
  clearContradictionEdge,
  parseResolverOutput,
  proposalFromResolution,
  supersededTombstone,
  buildResolveDeps,
  SUPERSEDED_CLAIM_PREFIX,
  HIGH_CONFIDENCE_THRESHOLD,
  type ClaimRecord,
  type ResolveDeps,
  type ResolutionProposal,
  type ResolutionRecord,
  type ContradictionResolver,
} from "./knowledge-resolve.js";

/** A ClaimRecord fixture with sensible defaults; override what a case cares about. */
function claim(slug: string, over: Partial<ClaimRecord> = {}): ClaimRecord {
  return {
    slug,
    title: slug,
    body: `body of ${slug}`,
    originClass: "agent",
    sourceKind: "code",
    confidence: 0.2,
    ...over,
  };
}

interface Recorder {
  deps: ResolveDeps;
  decayed: Array<{ slug: string; confidence: number }>;
  verdicts: Array<{ slug: string; verdict: string | null; disputes: DraftDispute[] }>;
  rescoped: Array<{ slug: string; qualifier: string }>;
  merged: Array<{ slug: string; body: string }>;
  resyncs: string[];
  records: ResolutionRecord[];
  reviews: ResolutionRecord[];
  resolverCalls: Array<{ aSlug: string; bSlug: string; grounding: string }>;
}

/**
 * Builds a recording ResolveDeps over an in-memory pair of claims. Every seam
 * captures its calls so a test can assert exactly what the resolver mutated —
 * and the resolver LLM seam is a plain stub, so no network or `claude` spawn is
 * ever touched.
 */
function makeRecorder(
  claims: Record<string, ClaimRecord | undefined>,
  resolve: ContradictionResolver,
  verdictStates: Record<string, DocVerdictState | null> = {},
  contradictors: Record<string, string[]> = {}
): Recorder {
  const r: Recorder = {
    decayed: [],
    verdicts: [],
    rescoped: [],
    merged: [],
    resyncs: [],
    records: [],
    reviews: [],
    resolverCalls: [],
    deps: undefined as unknown as ResolveDeps,
  };
  r.deps = {
    loadClaim: (_p, slug) => claims[slug] ?? null,
    getVerdictState: (_p, slug) => verdictStates[slug] ?? null,
    findContradictors: (_p, slug) => contradictors[slug] ?? [],
    search: async () => [],
    resolve: (input) => {
      r.resolverCalls.push({ aSlug: input.a.slug, bSlug: input.b.slug, grounding: input.grounding });
      return resolve(input);
    },
    decayConfidence: async (_p, slug, confidence) => {
      r.decayed.push({ slug, confidence });
    },
    setVerdict: (_p, slug, verdict, disputes) => {
      r.verdicts.push({ slug, verdict, disputes });
    },
    rescopeBody: async (_p, slug, qualifier) => {
      r.rescoped.push({ slug, qualifier });
    },
    mergeBody: async (_p, slug, body) => {
      r.merged.push({ slug, body });
    },
    resync: async (p) => {
      r.resyncs.push(p);
    },
    recordResolution: (record) => {
      r.records.push(record);
    },
    onNeedsReview: (record) => {
      r.reviews.push(record);
    },
  };
  return r;
}

describe("classifyResolution", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  /** A safe (low-confidence agent) winner, so a case isolates the loser gate. */
  const safeWinner = claim("a", { originClass: "agent", confidence: 0.2 });

  test("rescope of two low-confidence agent claims WITH both qualifiers is auto-applicable", () => {
    const decision = classifyResolution(
      {
        type: "rescope",
        winnerSlug: "a",
        loserSlug: "b",
        rescope: { winnerQualifier: "in prod", loserQualifier: "on beta" },
        rationale: "",
      },
      claim("b", { originClass: "agent", confidence: 0.2 }),
      claim("a", { originClass: "agent", confidence: 0.2 }),
      now
    );
    expect(decision.autoApply).toBe(true);
  });

  test("rescope touching an OWNER claim needs review — its body would be rewritten", () => {
    // rescope appends a qualifier to BOTH bodies, so an owner doc on either side
    // is as protected as a merge winner. Owner on the LOSING side here.
    const decision = classifyResolution(
      {
        type: "rescope",
        winnerSlug: "a",
        loserSlug: "b",
        rescope: { winnerQualifier: "in prod", loserQualifier: "on beta" },
        rationale: "",
      },
      claim("b", { originClass: "owner", confidence: 0.2 }),
      safeWinner,
      now
    );
    expect(decision.autoApply).toBe(false);
    expect(decision.reason).toContain("losing");
  });

  test("rescope touching a HIGH-confidence claim needs review", () => {
    // High-confidence on the WINNING side; both sides verified, so the losing
    // side's low confidence is earned, not an unverified starting value.
    const verified = now.toISOString();
    const decision = classifyResolution(
      {
        type: "rescope",
        winnerSlug: "a",
        loserSlug: "b",
        rescope: { winnerQualifier: "in prod", loserQualifier: "on beta" },
        rationale: "",
      },
      claim("b", { originClass: "agent", confidence: 0.2, lastVerifiedAt: verified }),
      claim("a", { originClass: "agent", confidence: 1, lastVerifiedAt: verified }),
      now
    );
    expect(decision.autoApply).toBe(false);
    expect(decision.reason).toContain("winning");
  });

  test("rescope WITHOUT scoping qualifiers is NOT auto-applicable", () => {
    const decision = classifyResolution(
      { type: "rescope", winnerSlug: "a", loserSlug: "b", rationale: "" },
      claim("b", { confidence: 0.2 }),
      safeWinner,
      now
    );
    expect(decision.autoApply).toBe(false);
  });

  test("rescope with a BLANK qualifier is NOT auto-applicable", () => {
    const decision = classifyResolution(
      {
        type: "rescope",
        winnerSlug: "a",
        loserSlug: "b",
        rescope: { winnerQualifier: "in prod", loserQualifier: "   " },
        rationale: "",
      },
      claim("b", { confidence: 0.2 }),
      safeWinner,
      now
    );
    expect(decision.autoApply).toBe(false);
  });

  test("supersede of a low-confidence agent claim is auto-applicable", () => {
    const decision = classifyResolution(
      { type: "supersede", winnerSlug: "a", loserSlug: "b", rationale: "" },
      claim("b", { originClass: "agent", confidence: 0.2 }),
      safeWinner,
      now
    );
    expect(decision.autoApply).toBe(true);
  });

  test("supersede of a human-authored (owner) claim needs review", () => {
    const decision = classifyResolution(
      { type: "supersede", winnerSlug: "a", loserSlug: "b", rationale: "" },
      claim("b", { originClass: "owner", confidence: 0.2 }),
      safeWinner,
      now
    );
    expect(decision.autoApply).toBe(false);
  });

  test("supersede of a verified high-confidence claim needs review", () => {
    const decision = classifyResolution(
      { type: "supersede", winnerSlug: "a", loserSlug: "b", rationale: "" },
      claim("b", { originClass: "agent", confidence: 1, lastVerifiedAt: now.toISOString() }),
      safeWinner,
      now
    );
    expect(decision.autoApply).toBe(false);
    expect(HIGH_CONFIDENCE_THRESHOLD).toBeLessThan(1);
  });

  test("supersede of a verified claim with no confidence opinion needs review (conservative)", () => {
    const decision = classifyResolution(
      { type: "merge", winnerSlug: "a", loserSlug: "b", rationale: "" },
      claim("b", { confidence: undefined, lastVerifiedAt: now.toISOString() }),
      safeWinner,
      now
    );
    expect(decision.autoApply).toBe(false);
  });

  test("merge with an owner WINNER needs review — its body would be overwritten", () => {
    const decision = classifyResolution(
      { type: "merge", winnerSlug: "a", loserSlug: "b", mergedBody: "x", rationale: "" },
      claim("b", { originClass: "agent", confidence: 0.2 }),
      claim("a", { originClass: "owner", confidence: 0.2 }),
      now
    );
    expect(decision.autoApply).toBe(false);
    expect(decision.reason).toContain("winning");
  });

  test("merge with a high-confidence WINNER needs review when the loser is verified", () => {
    const decision = classifyResolution(
      { type: "merge", winnerSlug: "a", loserSlug: "b", mergedBody: "x", rationale: "" },
      claim("b", { originClass: "agent", confidence: 0.2, lastVerifiedAt: now.toISOString() }),
      claim("a", { originClass: "agent", confidence: 1, lastVerifiedAt: now.toISOString() }),
      now
    );
    expect(decision.autoApply).toBe(false);
  });

  test("an unverified agent loser is released whatever confidence it was published at", () => {
    const unverifiedLoser = claim("b", { originClass: "agent", confidence: 1, lastVerifiedAt: undefined });
    const verifiedWinner = claim("a", { originClass: "agent", confidence: 1, lastVerifiedAt: now.toISOString() });
    const decision = classifyResolution(
      { type: "supersede", winnerSlug: "a", loserSlug: "b", rationale: "" },
      unverifiedLoser,
      verifiedWinner,
      now
    );
    expect(decision.autoApply).toBe(true);
    expect(decision.reason).toContain("unverified");
    // A rescope or merge also rewrites the winner, which keeps its own gate: a
    // low-confidence winner may be rewritten…
    const lowWinner = claim("a", { originClass: "agent", confidence: 0.2, lastVerifiedAt: now.toISOString() });
    for (const type of ["merge", "rescope"] as const) {
      expect(
        classifyResolution(
          {
            type,
            winnerSlug: "a",
            loserSlug: "b",
            mergedBody: "x",
            rescope: { winnerQualifier: "in prod", loserQualifier: "on beta" },
            rationale: "",
          },
          unverifiedLoser,
          lowWinner,
          now
        ).autoApply
      ).toBe(true);
    }
  });

  test("an unverified loser never releases a rewrite of a verified high-confidence or untrusted winner", () => {
    const unverifiedLoser = claim("b", { originClass: "agent", confidence: 0.6 });
    const winners = [
      claim("a", { originClass: "agent", confidence: 1, lastVerifiedAt: now.toISOString() }),
      claim("a", { originClass: "untrusted", confidence: undefined }),
    ];
    for (const winner of winners) {
      for (const type of ["merge", "rescope"] as const) {
        const decision = classifyResolution(
          {
            type,
            winnerSlug: "a",
            loserSlug: "b",
            mergedBody: "x",
            rescope: { winnerQualifier: "in prod", loserQualifier: "on beta" },
            rationale: "",
          },
          unverifiedLoser,
          winner,
          now
        );
        expect(decision.autoApply).toBe(false);
        expect(decision.reason).toContain("winning");
      }
    }
  });

  test("a pair whose doc is mid fact-check is left for later", async () => {
    const rec = makeRecorder(
      { a: claim("a"), b: claim("b", { originClass: "agent", confidence: 0.6 }) },
      async () => ({ type: "supersede", winnerSlug: "a", loserSlug: "b", rationale: "" })
    );
    rec.deps.isVerificationPending = (_p, slug) => slug === "b";
    const outcome = await resolveContradiction(rec.deps, "p-pending", "a", "b");
    expect(outcome).toMatchObject({ status: "skipped" });
    expect(rec.resolverCalls).toHaveLength(0);
  });

  test("an unverified agent loser still needs review against an owner winner whose body would change", () => {
    const decision = classifyResolution(
      { type: "merge", winnerSlug: "a", loserSlug: "b", mergedBody: "x", rationale: "" },
      claim("b", { originClass: "agent", confidence: 0.6 }),
      claim("a", { originClass: "owner", confidence: 1 }),
      now
    );
    expect(decision.autoApply).toBe(false);
    expect(decision.reason).toContain("owner");
  });

  test("an owner claim is never released by being unverified, and delete never auto-applies", () => {
    expect(
      classifyResolution(
        { type: "supersede", winnerSlug: "a", loserSlug: "b", rationale: "" },
        claim("b", { originClass: "owner", confidence: 0.6 }),
        safeWinner,
        now
      ).autoApply
    ).toBe(false);
    expect(
      classifyResolution(
        { type: "delete", winnerSlug: "a", loserSlug: "b", rationale: "" },
        claim("b", { originClass: "agent", confidence: 0.6 }),
        safeWinner,
        now
      ).autoApply
    ).toBe(false);
  });

  test("a SUPERSEDE (not merge) with an owner winner is still auto-applied — no body rewrite", () => {
    const decision = classifyResolution(
      { type: "supersede", winnerSlug: "a", loserSlug: "b", rationale: "" },
      claim("b", { originClass: "agent", confidence: 0.2 }),
      claim("a", { originClass: "owner", confidence: 1 }),
      now
    );
    expect(decision.autoApply).toBe(true);
  });

  test("hard delete is never auto-applied", () => {
    const decision = classifyResolution(
      { type: "delete", winnerSlug: "a", loserSlug: "b", rationale: "" },
      claim("b", { originClass: "agent", confidence: 0.01 }),
      safeWinner,
      now
    );
    expect(decision.autoApply).toBe(false);
  });
});

describe("clearContradictionEdge", () => {
  test("removes the dispute naming the other doc and clears a now-clean verdict", () => {
    const state: DocVerdictState = {
      verdict: "contradicted",
      disputes: [{ claim: "Contradicts loser", finding: "x", evidence: "y" }],
    };
    const cleared = clearContradictionEdge(state, "loser");
    expect(cleared.verdict).toBeNull();
    expect(cleared.disputes).toHaveLength(0);
  });

  test("keeps a fact-check dispute and stays disputed", () => {
    const state: DocVerdictState = {
      verdict: "disputed",
      disputes: [
        { claim: "does A", finding: "no", evidence: "rg" },
        { claim: "Contradicts loser", finding: "x", evidence: "y" },
      ],
    };
    const cleared = clearContradictionEdge(state, "loser");
    expect(cleared.verdict).toBe("disputed");
    expect(cleared.disputes.map((d) => d.claim)).toEqual(["does A"]);
  });

  test("a no-repo or git note left behind is kept as unverified, never revived to disputed", () => {
    const state: DocVerdictState = {
      verdict: "contradicted",
      disputes: [
        { claim: "unverifiable: no repo for project p", finding: "skipped", evidence: "projects.repos_json", origin: "repo" },
        { claim: "branch x exists", finding: "no such branch", evidence: "git branch", origin: "git" },
        { claim: "Contradicts loser", finding: "x", evidence: "y" },
      ],
    };
    const cleared = clearContradictionEdge(state, "loser");
    expect(cleared.verdict).toBe("unverified");
    expect(cleared.disputes).toHaveLength(2);
  });

  test("a no-repo note alone left behind is kept as unverifiable", () => {
    const state: DocVerdictState = {
      verdict: "contradicted",
      disputes: [
        { claim: "unverifiable: no repo for project p", finding: "skipped", evidence: "projects.repos_json", origin: "repo" },
        { claim: "Contradicts loser", finding: "x", evidence: "y" },
      ],
    };
    const cleared = clearContradictionEdge(state, "loser");
    expect(cleared.verdict).toBe("unverifiable");
    expect(cleared.disputes).toHaveLength(1);
  });

  test("stays contradicted when it still opposes a third doc", () => {
    const state: DocVerdictState = {
      verdict: "contradicted",
      disputes: [
        { claim: "Contradicts loser", finding: "x", evidence: "y" },
        { claim: "Contradicts other", finding: "z", evidence: "w" },
      ],
    };
    const cleared = clearContradictionEdge(state, "loser");
    expect(cleared.verdict).toBe("contradicted");
    expect(cleared.disputes.map((d) => d.claim)).toEqual(["Contradicts other"]);
  });

  test("a doc carrying a supersede tombstone STAYS superseded — never revived to disputed", () => {
    // Shared-node 3-way race: a concurrent resolution already tombstoned this doc
    // (dropping its Contradicts edges, stamping "Superseded by A"), and a second
    // resolver clears its now-moot edge to a third doc. The tombstone must not be
    // miscounted as a fact-check dispute and flip the doc back to "disputed".
    const state: DocVerdictState = {
      verdict: "superseded",
      disputes: [
        { claim: `${SUPERSEDED_CLAIM_PREFIX}A`, finding: "x", evidence: "y" },
      ],
    };
    const cleared = clearContradictionEdge(state, "C");
    expect(cleared.verdict).toBe("superseded");
    expect(cleared.disputes.map((d) => d.claim)).toEqual([`${SUPERSEDED_CLAIM_PREFIX}A`]);
  });

  test("a superseded doc that also kept a real fact-check finding stays superseded", () => {
    const state: DocVerdictState = {
      verdict: "superseded",
      disputes: [
        { claim: "does the thing", finding: "no", evidence: "rg" },
        { claim: `${SUPERSEDED_CLAIM_PREFIX}A`, finding: "x", evidence: "y" },
        { claim: "Contradicts C", finding: "opp", evidence: "e" },
      ],
    };
    const cleared = clearContradictionEdge(state, "C");
    expect(cleared.verdict).toBe("superseded");
    // The Contradicts C edge is dropped; the fact-check finding + tombstone remain.
    expect(cleared.disputes.map((d) => d.claim)).toEqual([
      "does the thing",
      `${SUPERSEDED_CLAIM_PREFIX}A`,
    ]);
  });
});

describe("resolveContradiction", () => {
  const projectId = "p";

  test("(a) low-confidence agent pair: supersede auto-applied — loser tombstoned + decayed, edge cleared", async () => {
    const proposal: ResolutionProposal = {
      type: "supersede",
      winnerSlug: "keep",
      loserSlug: "drop",
      rationale: "drop is outdated; keep reflects current code",
    };
    const rec = makeRecorder(
      {
        keep: claim("keep", { confidence: 0.3 }),
        drop: claim("drop", { confidence: 0.2 }),
      },
      async () => proposal,
      {
        // Both were just flagged "contradicted" by the coherence pass.
        keep: { verdict: "contradicted", disputes: [{ claim: "Contradicts drop", finding: "opp", evidence: "e" }] },
        drop: { verdict: "contradicted", disputes: [{ claim: "Contradicts keep", finding: "opp", evidence: "e" }] },
      }
    );

    const outcome = await resolveContradiction(rec.deps, projectId, "keep", "drop");
    expect(outcome.status).toBe("applied");

    // Loser tombstoned with a decayed confidence.
    expect(rec.decayed).toEqual([{ slug: "drop", confidence: DISPUTED_CONFIDENCE }]);
    const loserVerdict = rec.verdicts.find((v) => v.slug === "drop")!;
    expect(loserVerdict.verdict).toBe("superseded");
    expect(loserVerdict.disputes[0]!.claim).toBe(`${SUPERSEDED_CLAIM_PREFIX}keep`);
    // The tombstone is NOT a `Contradicts` claim, so the graph won't re-derive an edge.
    expect(parseContradictsClaim(loserVerdict.disputes[0]!.claim)).toBeNull();

    // Winner's contradiction edge cleared → re-admitted to injection.
    const winnerVerdict = rec.verdicts.find((v) => v.slug === "keep")!;
    expect(winnerVerdict.verdict).toBeNull();
    expect(winnerVerdict.disputes).toHaveLength(0);

    // A resolution record was persisted as applied.
    expect(rec.records).toHaveLength(1);
    expect(rec.records[0]!.status).toBe("applied");
    expect(rec.records[0]!.autoApplied).toBe(true);
    expect(rec.records[0]!.type).toBe("supersede");
    // Nothing routed to human review.
    expect(rec.reviews).toHaveLength(0);
  });

  test("(b) owner claim: NO auto-apply — a needs-review entry is recorded instead", async () => {
    const proposal: ResolutionProposal = {
      type: "supersede",
      winnerSlug: "agentdoc",
      loserSlug: "ownerdoc",
      rationale: "agentdoc is newer",
    };
    const rec = makeRecorder(
      {
        agentdoc: claim("agentdoc", { originClass: "agent", confidence: 0.2 }),
        ownerdoc: claim("ownerdoc", { originClass: "owner", confidence: 0.2 }),
      },
      async () => proposal
    );

    const outcome = await resolveContradiction(rec.deps, projectId, "agentdoc", "ownerdoc");
    expect(outcome.status).toBe("needs-review");

    // The docs were left untouched — no tombstone, no confidence decay, no verdict write.
    expect(rec.decayed).toHaveLength(0);
    expect(rec.verdicts).toHaveLength(0);
    expect(rec.merged).toHaveLength(0);

    // A needs-review record was persisted AND surfaced.
    expect(rec.records).toHaveLength(1);
    expect(rec.records[0]!.status).toBe("needs_review");
    expect(rec.records[0]!.autoApplied).toBe(false);
    expect(rec.reviews).toHaveLength(1);
    expect(rec.reviews[0]!.loserSlug).toBe("ownerdoc");
  });

  test("(b') high-confidence claim: NO auto-apply either", async () => {
    const proposal: ResolutionProposal = {
      type: "supersede",
      winnerSlug: "a",
      loserSlug: "b",
      rationale: "",
    };
    const rec = makeRecorder(
      {
        a: claim("a", { confidence: 0.2 }),
        b: claim("b", { originClass: "agent", confidence: 1, lastVerifiedAt: new Date().toISOString() }),
      },
      async () => proposal
    );
    const outcome = await resolveContradiction(rec.deps, projectId, "a", "b");
    expect(outcome.status).toBe("needs-review");
    expect(rec.verdicts).toHaveLength(0);
    expect(rec.records[0]!.status).toBe("needs_review");
  });

  test("a withheld resolution is re-gated on the current claims and released without a model call", async () => {
    let resolverCalls = 0;
    const rec = makeRecorder(
      {
        a: claim("a", { originClass: "agent", confidence: 1, lastVerifiedAt: new Date().toISOString() }),
        // Held when it read as high-confidence; it is an unverified agent claim.
        b: claim("b", { originClass: "agent", confidence: 0.6 }),
      },
      async () => {
        resolverCalls++;
        return null;
      },
      { a: null, b: { verdict: "contradicted", disputes: [{ claim: "Contradicts a", finding: "f", evidence: "e" }] } }
    );
    const released: string[] = [];
    rec.deps.getExistingResolution = () => ({
      status: "needs_review",
      type: "supersede",
      winnerSlug: "a",
      loserSlug: "b",
      rationale: "a is current",
    });
    rec.deps.markAutoApplied = (id) => released.push(id);
    const outcome = await resolveContradiction(rec.deps, projectId, "a", "b");
    expect(outcome.status).toBe("applied");
    expect(resolverCalls).toBe(0);
    expect(released).toHaveLength(1);
    expect(rec.verdicts.find((v) => v.slug === "b")?.verdict).toBe("superseded");
  });

  test("a withheld resolution against an owner claim stays withheld", async () => {
    const rec = makeRecorder(
      { a: claim("a", { originClass: "agent", confidence: 0.6 }), b: claim("b", { originClass: "owner" }) },
      async () => null,
      { b: { verdict: "contradicted", disputes: [{ claim: "Contradicts a", finding: "f", evidence: "e" }] } }
    );
    rec.deps.getExistingResolution = () => ({
      status: "needs_review",
      type: "supersede",
      winnerSlug: "a",
      loserSlug: "b",
      rationale: "",
    });
    rec.deps.markAutoApplied = () => {
      throw new Error("must not release");
    };
    const outcome = await resolveContradiction(rec.deps, projectId, "a", "b");
    expect(outcome.status).toBe("skipped");
    expect(rec.verdicts).toHaveLength(0);
  });

  test("(c) the injected resolver seam is used with both claims + grounding, and no network", async () => {
    let called = 0;
    const resolver: ContradictionResolver = async (input) => {
      called++;
      expect(input.a.slug).toBe("keep");
      expect(input.b.slug).toBe("drop");
      // grounding came from the (stubbed, empty) search seam, not the network.
      expect(typeof input.grounding).toBe("string");
      return { type: "supersede", winnerSlug: "keep", loserSlug: "drop", rationale: "r" };
    };
    const rec = makeRecorder(
      { keep: claim("keep", { confidence: 0.3 }), drop: claim("drop", { confidence: 0.2 }) },
      resolver
    );
    await resolveContradiction(rec.deps, projectId, "keep", "drop");
    expect(called).toBe(1);
    expect(rec.resolverCalls).toHaveLength(1);
  });

  test("rescope: both claims narrowed, edges cleared on both, nothing superseded", async () => {
    const proposal: ResolutionProposal = {
      type: "rescope",
      winnerSlug: "prod",
      loserSlug: "beta",
      rescope: { winnerQualifier: "This holds in production.", loserQualifier: "This holds on the beta stack." },
      rationale: "both true under different scopes",
    };
    const rec = makeRecorder(
      {
        // Two low-confidence agent claims — safe to auto-rescope (kept, narrowed).
        prod: claim("prod", { originClass: "agent", confidence: 0.2 }),
        beta: claim("beta", { confidence: 0.2 }),
      },
      async () => proposal,
      {
        prod: { verdict: "contradicted", disputes: [{ claim: "Contradicts beta", finding: "x", evidence: "e" }] },
        beta: { verdict: "contradicted", disputes: [{ claim: "Contradicts prod", finding: "x", evidence: "e" }] },
      }
    );
    const outcome = await resolveContradiction(rec.deps, projectId, "prod", "beta");
    expect(outcome.status).toBe("applied");
    expect(rec.rescoped.map((x) => x.slug).sort()).toEqual(["beta", "prod"]);
    // Nothing tombstoned.
    expect(rec.decayed).toHaveLength(0);
    expect(rec.verdicts.every((v) => v.verdict !== "superseded")).toBe(true);
    // Both edges cleared.
    const cleared = rec.verdicts.filter((v) => v.verdict === null);
    expect(cleared.map((v) => v.slug).sort()).toEqual(["beta", "prod"]);
  });

  test("rescope touching an OWNER doc is withheld — no body rewritten, needs-review recorded", async () => {
    const proposal: ResolutionProposal = {
      type: "rescope",
      winnerSlug: "prod",
      loserSlug: "beta",
      rescope: { winnerQualifier: "This holds in production.", loserQualifier: "This holds on the beta stack." },
      rationale: "both true under different scopes",
    };
    const rec = makeRecorder(
      {
        // An owner (human-authored) doc must not have its authoritative body
        // silently appended to — the autonomy gate withholds it for a human.
        prod: claim("prod", { originClass: "owner", confidence: 1 }),
        beta: claim("beta", { originClass: "agent", confidence: 0.2 }),
      },
      async () => proposal,
      {
        prod: { verdict: "contradicted", disputes: [{ claim: "Contradicts beta", finding: "x", evidence: "e" }] },
        beta: { verdict: "contradicted", disputes: [{ claim: "Contradicts prod", finding: "x", evidence: "e" }] },
      }
    );
    const outcome = await resolveContradiction(rec.deps, projectId, "prod", "beta");
    expect(outcome.status).toBe("needs-review");
    // Neither body was rewritten and neither edge cleared — the docs stay flagged.
    expect(rec.rescoped).toHaveLength(0);
    expect(rec.verdicts).toHaveLength(0);
    // The proposal is recorded (with its qualifiers) and surfaced for a human.
    expect(rec.records).toHaveLength(1);
    expect(rec.records[0]!.status).toBe("needs_review");
    expect(rec.records[0]!.type).toBe("rescope");
    expect(JSON.parse(rec.records[0]!.detail!).rescope.winnerQualifier).toBe("This holds in production.");
    expect(rec.reviews).toHaveLength(1);
  });

  test("a pair with an EXISTING resolution is skipped — no re-spawn, no re-notify", async () => {
    for (const status of ["needs_review", "applied"] as const) {
      const rec = makeRecorder(
        { a: claim("a", { confidence: 0.2 }), b: claim("b", { confidence: 0.2 }) },
        async () => ({ type: "supersede", winnerSlug: "a", loserSlug: "b", rationale: "r" })
      );
      // A prior resolution for this exact pair is already on the ledger.
      rec.deps.getExistingResolution = () => ({ status });
      const outcome = await resolveContradiction(rec.deps, projectId, "a", "b");
      expect(outcome.status).toBe("skipped");
      // Short-circuits before the resolver spawn AND before any notification.
      expect(rec.resolverCalls).toHaveLength(0);
      expect(rec.verdicts).toHaveLength(0);
      expect(rec.records).toHaveLength(0);
      expect(rec.reviews).toHaveLength(0);
    }
  });

  test("merge: winner body replaced, loser superseded", async () => {
    const proposal: ResolutionProposal = {
      type: "merge",
      winnerSlug: "keep",
      loserSlug: "drop",
      mergedBody: "combined body covering both",
      rationale: "folded together",
    };
    const rec = makeRecorder(
      { keep: claim("keep", { confidence: 0.3 }), drop: claim("drop", { confidence: 0.2 }) },
      async () => proposal,
      { keep: { verdict: "contradicted", disputes: [{ claim: "Contradicts drop", finding: "x", evidence: "e" }] } }
    );
    const outcome = await resolveContradiction(rec.deps, projectId, "keep", "drop");
    expect(outcome.status).toBe("applied");
    expect(rec.merged).toEqual([{ slug: "keep", body: "combined body covering both" }]);
    expect(rec.decayed).toEqual([{ slug: "drop", confidence: DISPUTED_CONFIDENCE }]);
    expect(rec.verdicts.find((v) => v.slug === "drop")!.verdict).toBe("superseded");
  });

  test("merge auto-apply keeps the winner's ORIGINAL body so the merge is reversible", async () => {
    // A merge overwrites the winner's body with LLM-generated text — the one shape
    // that rewrites a KEPT doc. The winner's pre-merge content must survive on the
    // durable ledger row, mirroring the tombstone that preserves the retired loser,
    // so a human can undo the merge.
    const proposal: ResolutionProposal = {
      type: "merge",
      winnerSlug: "keep",
      loserSlug: "drop",
      mergedBody: "combined body covering both",
      rationale: "folded together",
    };
    const rec = makeRecorder(
      {
        keep: claim("keep", { body: "the winner's ORIGINAL authoritative body", confidence: 0.3 }),
        drop: claim("drop", { confidence: 0.2 }),
      },
      async () => proposal,
      { keep: { verdict: "contradicted", disputes: [{ claim: "Contradicts drop", finding: "x", evidence: "e" }] } }
    );
    const outcome = await resolveContradiction(rec.deps, projectId, "keep", "drop");
    expect(outcome.status).toBe("applied");
    // The winner's body was replaced with the merged text...
    expect(rec.merged).toEqual([{ slug: "keep", body: "combined body covering both" }]);
    // ...but its ORIGINAL body is recoverable from the persisted resolution.
    const record = rec.records.find((r) => r.type === "merge")!;
    expect(record.status).toBe("applied");
    const detail = JSON.parse(record.detail!);
    expect(detail.priorWinnerBody).toBe("the winner's ORIGINAL authoritative body");
  });

  test("resolver declined (null): no mutation, no record", async () => {
    const rec = makeRecorder(
      { a: claim("a"), b: claim("b") },
      async () => null
    );
    const outcome = await resolveContradiction(rec.deps, projectId, "a", "b");
    expect(outcome.status).toBe("declined");
    expect(rec.verdicts).toHaveLength(0);
    expect(rec.records).toHaveLength(0);
  });

  test("proposal naming a slug outside the pair is skipped", async () => {
    const rec = makeRecorder(
      { a: claim("a"), b: claim("b") },
      async () => ({ type: "supersede", winnerSlug: "a", loserSlug: "elsewhere", rationale: "" })
    );
    const outcome = await resolveContradiction(rec.deps, projectId, "a", "b");
    expect(outcome.status).toBe("skipped");
    expect(rec.verdicts).toHaveLength(0);
    expect(rec.records).toHaveLength(0);
  });

  test("a missing claim (renamed/removed since flagging) is skipped", async () => {
    const rec = makeRecorder(
      { a: claim("a"), b: undefined },
      async () => ({ type: "supersede", winnerSlug: "a", loserSlug: "b", rationale: "" })
    );
    const outcome = await resolveContradiction(rec.deps, projectId, "a", "b");
    expect(outcome.status).toBe("skipped");
    expect(rec.resolverCalls).toHaveLength(0);
  });

  test("rescope with MISSING qualifiers is skipped — no edge cleared, nothing recorded", async () => {
    const rec = makeRecorder(
      { a: claim("a"), b: claim("b") },
      // A rescope the resolver returned with NO rescope object (common LLM variance).
      async () => ({ type: "rescope", winnerSlug: "a", loserSlug: "b", rationale: "r" }),
      {
        a: { verdict: "contradicted", disputes: [{ claim: "Contradicts b", finding: "x", evidence: "e" }] },
        b: { verdict: "contradicted", disputes: [{ claim: "Contradicts a", finding: "x", evidence: "e" }] },
      }
    );
    const outcome = await resolveContradiction(rec.deps, projectId, "a", "b");
    expect(outcome.status).toBe("skipped");
    // Neither doc was narrowed, and — the corpus-poisoning guard — NEITHER edge
    // was cleared, so both stay flagged for a human.
    expect(rec.rescoped).toHaveLength(0);
    expect(rec.verdicts).toHaveLength(0);
    expect(rec.records).toHaveLength(0);
  });

  test("rescope with a BLANK qualifier is skipped", async () => {
    const rec = makeRecorder(
      { a: claim("a"), b: claim("b") },
      async () => ({
        type: "rescope",
        winnerSlug: "a",
        loserSlug: "b",
        rescope: { winnerQualifier: "in prod", loserQualifier: "  " },
        rationale: "r",
      })
    );
    const outcome = await resolveContradiction(rec.deps, projectId, "a", "b");
    expect(outcome.status).toBe("skipped");
    expect(rec.verdicts).toHaveLength(0);
    expect(rec.records).toHaveLength(0);
  });

  test("a pair whose loser is ALREADY superseded is skipped — no re-resolution, no resolver spawn", async () => {
    const rec = makeRecorder(
      { keep: claim("keep", { confidence: 0.3 }), drop: claim("drop", { confidence: 0.2 }) },
      async () => ({ type: "supersede", winnerSlug: "keep", loserSlug: "drop", rationale: "r" }),
      {
        // drop was already tombstoned by a prior resolution.
        drop: {
          verdict: "superseded",
          disputes: [{ claim: "Superseded by keep", finding: "x", evidence: "e" }],
        },
      }
    );
    const outcome = await resolveContradiction(rec.deps, projectId, "keep", "drop");
    expect(outcome.status).toBe("skipped");
    // Short-circuits before the resolver — no re-supersede, no fresh ledger row.
    expect(rec.resolverCalls).toHaveLength(0);
    expect(rec.verdicts).toHaveLength(0);
    expect(rec.records).toHaveLength(0);
  });

  test("supersede preserves the loser's fact-check disputes and clears a THIRD doc's edge", async () => {
    const proposal: ResolutionProposal = {
      type: "supersede",
      winnerSlug: "keep",
      loserSlug: "drop",
      rationale: "drop is wrong",
    };
    const rec = makeRecorder(
      { keep: claim("keep", { confidence: 0.3 }), drop: claim("drop", { confidence: 0.2 }) },
      async () => proposal,
      {
        keep: { verdict: "contradicted", disputes: [{ claim: "Contradicts drop", finding: "x", evidence: "e" }] },
        // drop carries a real fact-check finding AND opposes a third doc "third".
        drop: {
          verdict: "disputed",
          disputes: [
            { claim: "does the thing", finding: "no it doesn't", evidence: "rg" },
            { claim: "Contradicts keep", finding: "opp", evidence: "e" },
            { claim: "Contradicts third", finding: "opp", evidence: "e" },
          ],
        },
        // "third" points back at drop.
        third: { verdict: "contradicted", disputes: [{ claim: "Contradicts drop", finding: "opp", evidence: "e" }] },
      },
      { drop: ["third"] } // findContradictors(drop) → ["third"]
    );

    const outcome = await resolveContradiction(rec.deps, projectId, "keep", "drop");
    expect(outcome.status).toBe("applied");

    // The loser is superseded but KEEPS its fact-check finding (history), plus the
    // tombstone — and its stale `Contradicts` edges are dropped.
    const loserVerdict = rec.verdicts.find((v) => v.slug === "drop")!;
    expect(loserVerdict.verdict).toBe("superseded");
    const loserClaims = loserVerdict.disputes.map((d) => d.claim);
    expect(loserClaims).toContain("does the thing");
    expect(loserClaims).toContain(`${SUPERSEDED_CLAIM_PREFIX}keep`);
    expect(loserClaims.some((cl) => parseContradictsClaim(cl) !== null)).toBe(false);

    // The third doc's now-moot `Contradicts drop` edge was cleared, so it isn't
    // left flagged forever against a tombstoned doc.
    const thirdVerdict = rec.verdicts.find((v) => v.slug === "third")!;
    expect(thirdVerdict.verdict).toBeNull();
    expect(thirdVerdict.disputes).toHaveLength(0);
  });
});

describe("acceptResolution", () => {
  const projectId = "p";

  test("applies a withheld supersede (human override of the autonomy gate)", async () => {
    // A proposal the gate withheld because the loser was owner-authored.
    const rec = makeRecorder(
      {
        agentdoc: claim("agentdoc", { originClass: "agent", confidence: 0.2 }),
        ownerdoc: claim("ownerdoc", { originClass: "owner", confidence: 1 }),
      },
      async () => null,
      {
        ownerdoc: {
          verdict: "contradicted",
          disputes: [{ claim: "Contradicts agentdoc", finding: "x", evidence: "e" }],
        },
      }
    );
    const outcome = await acceptResolution(rec.deps, projectId, {
      type: "supersede",
      winnerSlug: "agentdoc",
      loserSlug: "ownerdoc",
      rationale: "human decided agentdoc wins",
    });
    expect(outcome.status).toBe("applied");
    // Loser tombstoned + decayed even though it is owner/high-confidence — the
    // human is the authority on the accept path. No NEW ledger row here (the
    // caller flips the existing one).
    expect(rec.decayed).toEqual([{ slug: "ownerdoc", confidence: DISPUTED_CONFIDENCE }]);
    expect(rec.verdicts.find((v) => v.slug === "ownerdoc")!.verdict).toBe("superseded");
    expect(rec.records).toHaveLength(0);
  });

  test("accepting a stale withheld resolution whose pair no longer contradicts is a no-op", async () => {
    // The resolution was withheld as needs-review, but a human independently revived
    // ownerdoc since — neither side still carries a `Contradicts` edge to the other.
    // Replaying the supersede would re-tombstone the doc the human just brought back,
    // so the accept must be a no-op.
    const rec = makeRecorder(
      {
        agentdoc: claim("agentdoc", { originClass: "agent", confidence: 0.2 }),
        ownerdoc: claim("ownerdoc", { originClass: "owner", confidence: 1 }),
      },
      async () => null,
      {
        // Revived: verdicts cleared, no contradiction disputes remain on either doc.
        agentdoc: { verdict: undefined, disputes: [] },
        ownerdoc: { verdict: undefined, disputes: [] },
      }
    );
    const outcome = await acceptResolution(rec.deps, projectId, {
      type: "supersede",
      winnerSlug: "agentdoc",
      loserSlug: "ownerdoc",
      rationale: "human decided agentdoc wins",
    });
    expect(outcome.status).toBe("skipped");
    // The revived doc was NOT re-tombstoned — no decay, no verdict write.
    expect(rec.decayed).toHaveLength(0);
    expect(rec.verdicts).toHaveLength(0);
  });

  test("a one-sided loser revival is a no-op — the winner's stale edge must not re-tombstone it", async () => {
    // The realistic revival: a human edits the LOSER (ownerdoc) to bring it back,
    // which clears ONLY that doc's verdict + disputes (clearDocVerdict). The WINNER
    // (agentdoc) is untouched and keeps its now-stale `Contradicts ownerdoc` edge —
    // nothing auto-clears a winner's edge outside a resolution apply. Accepting the
    // still-withheld row must NOT re-tombstone the loser the human just revived: the
    // guard is loser-centric, so the winner's lingering edge alone is not "still
    // contradicting". (An OR across both edges would re-tombstone here.)
    const rec = makeRecorder(
      {
        agentdoc: claim("agentdoc", { originClass: "agent", confidence: 0.2 }),
        ownerdoc: claim("ownerdoc", { originClass: "owner", confidence: 1 }),
      },
      async () => null,
      {
        // Winner keeps its stale edge; loser was revived (verdict + disputes cleared).
        agentdoc: {
          verdict: "contradicted",
          disputes: [{ claim: "Contradicts ownerdoc", finding: "x", evidence: "e" }],
        },
        ownerdoc: { verdict: undefined, disputes: [] },
      }
    );
    const outcome = await acceptResolution(rec.deps, projectId, {
      type: "supersede",
      winnerSlug: "agentdoc",
      loserSlug: "ownerdoc",
      rationale: "human decided agentdoc wins",
    });
    expect(outcome.status).toBe("skipped");
    // The revived loser was NOT re-tombstoned — no decay, no verdict write.
    expect(rec.decayed).toHaveLength(0);
    expect(rec.verdicts).toHaveLength(0);
  });

  test("declines to replay a rescope whose qualifiers were never persisted", async () => {
    const rec = makeRecorder({ a: claim("a"), b: claim("b") }, async () => null);
    const outcome = await acceptResolution(rec.deps, projectId, {
      type: "rescope",
      winnerSlug: "a",
      loserSlug: "b",
      rationale: "r",
    });
    expect(outcome.status).toBe("skipped");
    expect(rec.rescoped).toHaveLength(0);
    expect(rec.verdicts).toHaveLength(0);
  });
});

describe("supersededTombstone", () => {
  test("names the winner and falls back to a default finding", () => {
    const t = supersededTombstone("winner", "");
    expect(t.claim).toBe(`${SUPERSEDED_CLAIM_PREFIX}winner`);
    expect(t.finding.length).toBeGreaterThan(0);
    expect(parseContradictsClaim(t.claim)).toBeNull();
  });
});

describe("parseResolverOutput", () => {
  test("parses a supersede proposal", () => {
    const p = parseResolverOutput('{"type":"supersede","winnerSlug":"a","loserSlug":"b","rationale":"b wrong"}');
    expect(p).toEqual({ type: "supersede", winnerSlug: "a", loserSlug: "b", rationale: "b wrong" });
  });

  test("parses a rescope proposal with qualifiers", () => {
    const p = parseResolverOutput(
      '{"type":"rescope","winnerSlug":"a","loserSlug":"b","rescope":{"winnerQualifier":"prod","loserQualifier":"beta"},"rationale":"scopes"}'
    );
    expect(p?.type).toBe("rescope");
    expect(p?.rescope).toEqual({ winnerQualifier: "prod", loserQualifier: "beta" });
  });

  test("tolerates prose around the JSON", () => {
    const p = parseResolverOutput('Sure:\n{"type":"merge","winnerSlug":"a","loserSlug":"b","mergedBody":"x","rationale":"y"}\nDone');
    expect(p?.type).toBe("merge");
    expect(p?.mergedBody).toBe("x");
  });

  test("fail-closed on garbage or an unknown type", () => {
    expect(parseResolverOutput("not json")).toBeNull();
    expect(parseResolverOutput('{"type":"frobnicate","winnerSlug":"a","loserSlug":"b"}')).toBeNull();
    expect(parseResolverOutput('{"type":"supersede","winnerSlug":"a"}')).toBeNull();
    expect(parseResolverOutput("")).toBeNull();
  });

  test("fail-closed on a rescope missing its qualifiers", () => {
    // A rescope object entirely absent — the resolver named a type but gave nothing
    // to narrow with, so it must not become an applyable proposal.
    expect(
      parseResolverOutput('{"type":"rescope","winnerSlug":"a","loserSlug":"b","rationale":"r"}')
    ).toBeNull();
    // A rescope with a blank qualifier narrows nothing either.
    expect(
      parseResolverOutput(
        '{"type":"rescope","winnerSlug":"a","loserSlug":"b","rescope":{"winnerQualifier":"prod","loserQualifier":""},"rationale":"r"}'
      )
    ).toBeNull();
  });
});

describe("proposalFromResolution", () => {
  test("rebuilds a supersede from the ledger columns", () => {
    const p = proposalFromResolution({
      type: "supersede",
      winnerSlug: "a",
      loserSlug: "b",
      rationale: "b is wrong",
      detail: JSON.stringify({ reason: "low-confidence agent doc" }),
    });
    expect(p).toEqual({ type: "supersede", winnerSlug: "a", loserSlug: "b", rationale: "b is wrong" });
  });

  test("rebuilds a merge including its persisted body", () => {
    const p = proposalFromResolution({
      type: "merge",
      winnerSlug: "a",
      loserSlug: "b",
      rationale: "folded",
      detail: JSON.stringify({ reason: "r", mergedBody: "the combined doc" }),
    });
    expect(p?.mergedBody).toBe("the combined doc");
  });

  test("rebuilds a rescope from persisted qualifiers", () => {
    const p = proposalFromResolution({
      type: "rescope",
      winnerSlug: "a",
      loserSlug: "b",
      rationale: "scopes",
      detail: JSON.stringify({ reason: "r", rescope: { winnerQualifier: "prod", loserQualifier: "beta" } }),
    });
    expect(p?.rescope).toEqual({ winnerQualifier: "prod", loserQualifier: "beta" });
  });

  test("returns null for a rescope whose qualifiers were never persisted (legacy row)", () => {
    const p = proposalFromResolution({
      type: "rescope",
      winnerSlug: "a",
      loserSlug: "b",
      rationale: "r",
      detail: JSON.stringify({ reason: "r" }),
    });
    expect(p).toBeNull();
  });
});

/**
 * The real disk-backed wiring (buildResolveDeps → rewriteBody), which the mocked
 * ResolveDeps above cannot exercise. An AUTOMATIC rescope/merge must re-emit a
 * doc's scope + owner_user, or the following resync re-derives coerceScope() =
 * 'project' and silently WIDENS a user/global doc's auto-injection audience —
 * the exact regression the honest-injection scope gate must never suffer.
 */
describe("buildResolveDeps rewriteBody preserves a doc's audience", () => {
  const cleanupDirs: string[] = [];
  afterAll(async () => {
    for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
  });

  async function setup(): Promise<{
    deps: ResolveDeps;
    dir: string;
    id: string;
    knowledgeStore: KnowledgeStore;
    close: () => void;
  }> {
    const store = createStore(":memory:");
    const id = `resolve-scope-${randomUUID().slice(0, 8)}`;
    upsertProject(store.db, { id, name: "Resolve Scope Test", branch: "main", repos: [] });
    const dir = await mkdtemp(join(tmpdir(), "standup-resolve-scope-"));
    cleanupDirs.push(dir);
    const sync = new KnowledgeSync(store.db, dir, null);
    const deps = buildResolveDeps({
      db: store.db,
      // rescope/merge + resync never touch the read side, so a stub backend is enough.
      backend: { search: async () => [], getDoc: () => null },
      knowledgeDir: dir,
      recordDocVerdict: (pid, slug, verdict, disputes) =>
        sync.recordDocVerdict(pid, slug, verdict, disputes),
      clearDocVerdict: (pid, slug) => sync.clearDocVerdict(pid, slug),
      syncProject: (pid) => sync.syncProject(pid),
      resolve: (async () => null) as ContradictionResolver,
    });
    return { deps, dir, id, knowledgeStore: new KnowledgeStore(store.db), close: () => store.close() };
  }

  test("auto-rescope keeps a scope='user'/owner doc private on disk AND after resync", async () => {
    const { deps, dir, id, knowledgeStore, close } = await setup();
    await writeKnowledgeFile(dir, id, {
      slug: "note",
      title: "Alice's note",
      body: "the original claim",
      originClass: "agent",
      scope: "user",
      ownerUser: "alice",
    });
    await deps.resync(id);

    await deps.rescopeBody(id, "note", "only on the beta stack");

    // On disk: the rescope appended the qualifier but did NOT drop the audience.
    const file = await readKnowledgeFile(dir, id, "note");
    expect(file!.scope).toBe("user");
    expect(file!.ownerUser).toBe("alice");
    expect(file!.body).toContain("only on the beta stack");

    // After resync the index row is still owned by alice, not widened to 'project'.
    await deps.resync(id);
    const doc = knowledgeStore.getDoc(id, "note")!;
    expect(doc.scope).toBe("user");
    expect(doc.ownerUser).toBe("alice");

    close();
  });

  test("auto-merge keeps a scope='user'/owner doc private on disk AND after resync", async () => {
    const { deps, dir, id, knowledgeStore, close } = await setup();
    await writeKnowledgeFile(dir, id, {
      slug: "note",
      title: "Alice's note",
      body: "the original claim",
      originClass: "agent",
      scope: "user",
      ownerUser: "alice",
    });
    await deps.resync(id);

    await deps.mergeBody(id, "note", "the combined body covering both claims");

    const file = await readKnowledgeFile(dir, id, "note");
    expect(file!.scope).toBe("user");
    expect(file!.ownerUser).toBe("alice");
    expect(file!.body).toBe("the combined body covering both claims");

    await deps.resync(id);
    const doc = knowledgeStore.getDoc(id, "note")!;
    expect(doc.scope).toBe("user");
    expect(doc.ownerUser).toBe("alice");

    close();
  });

  test("auto-rescope keeps a scope='global' doc global (never demoted to 'project')", async () => {
    const { deps, dir, id, knowledgeStore, close } = await setup();
    await writeKnowledgeFile(dir, id, {
      slug: "wide",
      title: "A global fact",
      body: "the original claim",
      originClass: "agent",
      scope: "global",
    });
    await deps.resync(id);

    await deps.rescopeBody(id, "wide", "in production only");

    const file = await readKnowledgeFile(dir, id, "wide");
    expect(file!.scope).toBe("global");

    await deps.resync(id);
    expect(knowledgeStore.getDoc(id, "wide")!.scope).toBe("global");

    close();
  });
});
