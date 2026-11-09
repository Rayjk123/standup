import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import {
  KnowledgeStore,
  isVerdictEligibleForInjection,
  DISPUTED_CONFIDENCE,
  type KnowledgeDoc,
  type SearchResult,
} from "@standup/knowledge";
import { searchKnowledge } from "@standup/knowledge";
import { parseJudgeOutput } from "./knowledge-coherence.js";
import {
  resolveContradiction,
  parseResolverOutput,
  SUPERSEDED_CLAIM_PREFIX,
} from "./knowledge-resolve.js";
import {
  CONTRADICTION_GOLDEN_SET,
  RESOLUTION_GOLDEN_SET,
  EVAL_PROJECT,
  oracleJudge,
  naiveSimilarityJudge,
  ruleBasedResolver,
  pickWinnerByRules,
  scoreContradictionDetection,
  scoreResolutionAccuracy,
  memoryResolveDeps,
  storeResolveDeps,
} from "./knowledge-contradiction-eval.js";

/**
 * Deterministic eval of the contradiction + temporal pipeline. Every LLM seam is
 * a stub, every DB is in-memory — no spawn, no network, no live DB — so this
 * measures the pipeline's gating / flag-fold / resolution logic reproducibly.
 */

describe("contradiction detection — precision / recall / F1 over the golden set", () => {
  test("the golden set carries genuine contradictions, non-contradictions, and hard negatives", () => {
    const byCat = (cat: string) => CONTRADICTION_GOLDEN_SET.filter((c) => c.category === cat).length;
    expect(byCat("contradiction")).toBeGreaterThanOrEqual(2);
    expect(byCat("non-contradiction")).toBeGreaterThanOrEqual(1);
    // The hard negatives are the discriminating cases — same topic, reconciled by
    // scope / time / subject rather than opposing.
    expect(byCat("hard-negative")).toBeGreaterThanOrEqual(3);
    // Every labeled non-contradiction is recalled ABOVE the floor, so it reaches
    // the judge — the metric measures detection, not a recall miss.
    for (const c of CONTRADICTION_GOLDEN_SET) expect(c.similarity).toBeGreaterThan(0.5);
  });

  test("the real detect+flag pipeline with an oracle judge is perfect: precision = recall = F1 = 1", async () => {
    const score = await scoreContradictionDetection(CONTRADICTION_GOLDEN_SET, oracleJudge(CONTRADICTION_GOLDEN_SET));
    // Every genuine contradiction is flagged (recall) and nothing else is (precision):
    // the candidate-gating + flag/fold logic neither drops a true conflict nor
    // fabricates one on a same-topic non-conflict.
    expect(score.recall).toBe(1);
    expect(score.precision).toBe(1);
    expect(score.f1).toBe(1);
    expect(score.fp).toBe(0);
    expect(score.fn).toBe(0);
  });

  test("a naive similarity-only judge fabricates on the hard negatives — the judge step is load-bearing", async () => {
    // Flagging anything that clears the recall floor (no LLM discrimination) keeps
    // recall at 1 but tanks precision, because every hard negative becomes a false
    // positive. That gap is exactly what the golden set is designed to expose, and
    // it proves the P/R/F1 metric has teeth.
    const naive = await scoreContradictionDetection(CONTRADICTION_GOLDEN_SET, naiveSimilarityJudge());
    const oracle = await scoreContradictionDetection(CONTRADICTION_GOLDEN_SET, oracleJudge(CONTRADICTION_GOLDEN_SET));
    expect(naive.recall).toBe(1);
    expect(naive.fp).toBeGreaterThan(0);
    expect(naive.precision).toBeLessThan(oracle.precision);
    // Every fabricated flag is a hard negative or a plain non-contradiction.
    const fabricated = naive.perCase.filter((p) => p.predicted && !p.label);
    expect(fabricated.every((p) => p.category !== "contradiction")).toBe(true);
  });
});

describe("judge / resolver parse contract (mocked model replies, real parsers)", () => {
  test("parseJudgeOutput reads the prompt's JSON shape and is fail-closed on garbage", () => {
    expect(parseJudgeOutput('{"contradicts": true, "reason": "opposite runtimes"}')).toEqual({
      contradicts: true,
      reason: "opposite runtimes",
      method: "llm",
    });
    // Prose wrapping the object (a common model habit) is tolerated.
    expect(parseJudgeOutput('Sure:\n{"contradicts": false, "reason": ""}\n').contradicts).toBe(false);
    // Non-JSON / non-boolean never fabricates a contradiction, and is a judge
    // error rather than a judged "no".
    for (const raw of ["no idea", '{"contradicts": "true"}']) {
      const out = parseJudgeOutput(raw);
      expect(out.contradicts).toBe(false);
      expect(out.error).toBeDefined();
    }
  });

  test("parseResolverOutput reads a supersede proposal and rejects an incomplete rescope", () => {
    const supersede = parseResolverOutput('{"type":"supersede","winnerSlug":"a","loserSlug":"b","rationale":"b is stale"}');
    expect(supersede).not.toBeNull();
    expect(supersede!.type).toBe("supersede");
    expect(supersede!.winnerSlug).toBe("a");
    // A rescope with no scoping qualifiers narrows nothing → rejected (fail-closed),
    // so it can never silently re-admit two opposing docs.
    expect(parseResolverOutput('{"type":"rescope","winnerSlug":"a","loserSlug":"b"}')).toBeNull();
    expect(parseResolverOutput("not json")).toBeNull();
  });
});

describe("resolution accuracy — recency / owner rules pick the labeled winner", () => {
  test("pickWinnerByRules: recency dominates, owner breaks a date tie", () => {
    const older = { slug: "old", title: "o", body: "o", originClass: "agent" as const, lastVerifiedAt: "2026-01-01T00:00:00Z", confidence: 0.2 };
    const newer = { slug: "new", title: "n", body: "n", originClass: "agent" as const, lastVerifiedAt: "2026-06-01T00:00:00Z", confidence: 0.2 };
    expect(pickWinnerByRules(older, newer).slug).toBe("new");
    const ownerDoc = { slug: "owner", title: "o", body: "o", originClass: "owner" as const, lastVerifiedAt: "2026-03-01T00:00:00Z", confidence: 0.2 };
    const agentDoc = { slug: "agent", title: "a", body: "a", originClass: "agent" as const, lastVerifiedAt: "2026-03-01T00:00:00Z", confidence: 0.2 };
    expect(pickWinnerByRules(ownerDoc, agentDoc).slug).toBe("owner");
  });

  test("the rule resolver run through resolveContradiction picks the labeled winner every time", async () => {
    const score = await scoreResolutionAccuracy(RESOLUTION_GOLDEN_SET);
    expect(score.accuracy).toBe(1);
    // Each case's auto-apply status matches its label too (the owner-loser case is
    // withheld for review while its winner is still the newer claim).
    expect(score.perCase.every((p) => p.autoApplyOk)).toBe(true);
  });

  test("an auto-applied supersede tombstones the labeled loser and re-admits the winner", async () => {
    const now = new Date("2026-09-01T00:00:00Z");
    const claims = {
      "fact-old": { slug: "fact-old", title: "fact-old", body: "old", originClass: "agent" as const, sourceKind: "code" as const, confidence: 0.2, lastVerifiedAt: "2026-01-01T00:00:00Z" },
      "fact-new": { slug: "fact-new", title: "fact-new", body: "new", originClass: "agent" as const, sourceKind: "code" as const, confidence: 0.2, lastVerifiedAt: "2026-06-01T00:00:00Z" },
    };
    const { deps, verdicts } = memoryResolveDeps(claims, ruleBasedResolver, now);
    const outcome = await resolveContradiction(deps, EVAL_PROJECT, "fact-old", "fact-new");

    expect(outcome.status).toBe("applied");
    if (outcome.status === "applied") {
      expect(outcome.type).toBe("supersede");
      expect(outcome.winnerSlug).toBe("fact-new");
      expect(outcome.loserSlug).toBe("fact-old");
    }
    // The loser carries the supersede tombstone naming the winner.
    const loserVerdict = verdicts.find((v) => v.slug === "fact-old")!;
    expect(loserVerdict.verdict).toBe("superseded");
    expect(loserVerdict.disputes[0]!.claim).toBe(`${SUPERSEDED_CLAIM_PREFIX}fact-new`);
  });
});

// A KnowledgeDoc with the fields retrieval + resolution read; the rest defaulted.
function seededDoc(over: Partial<KnowledgeDoc> & Pick<KnowledgeDoc, "slug" | "title" | "body">): KnowledgeDoc {
  return {
    id: `${EVAL_PROJECT}/${over.slug}`,
    projectId: EVAL_PROJECT,
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    filePath: `/x/${EVAL_PROJECT}/${over.slug}.md`,
    originClass: "agent",
    sourceKind: "code",
    ...over,
  };
}

describe("temporal (FreshQA-style) supersession", () => {
  test("a superseding fact_v2 retires fact_v1: a 'now' query prefers v2 and v1 carries the tombstone", async () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);

    // fact_v1 (older) and the superseding fact_v2 (newer) — opposing claims on the
    // same subject, so a "now" query recalls both and the coherence pass flags
    // them contradicting.
    store.upsertDoc(
      seededDoc({
        slug: "region-v1",
        title: "Deploy region",
        body: "Production deploys to us-east-1.",
        confidence: 0.2,
        lastVerifiedAt: "2026-01-01T00:00:00Z",
      })
    );
    store.upsertDoc(
      seededDoc({
        slug: "region-v2",
        title: "Deploy region",
        body: "Production now deploys to eu-west-1, not us-east-1.",
        confidence: 0.2,
        lastVerifiedAt: "2026-06-01T00:00:00Z",
      })
    );
    // Both flagged contradicted by the coherence pass (mutual edges).
    store.setDocVerdict(EVAL_PROJECT, "region-v1", "contradicted", [
      { claim: "Contradicts region-v2", finding: "opposite region", evidence: "e" },
    ]);
    store.setDocVerdict(EVAL_PROJECT, "region-v2", "contradicted", [
      { claim: "Contradicts region-v1", finding: "opposite region", evidence: "e" },
    ]);

    const now = new Date("2026-09-01T00:00:00Z");
    const deps = storeResolveDeps(db, ruleBasedResolver, now);
    const outcome = await resolveContradiction(deps, EVAL_PROJECT, "region-v2", "region-v1");

    // Recency picks v2; v1 (low-confidence agent) is safely superseded.
    expect(outcome.status).toBe("applied");
    if (outcome.status === "applied") {
      expect(outcome.winnerSlug).toBe("region-v2");
      expect(outcome.loserSlug).toBe("region-v1");
    }

    // The supersede tombstone is set on v1, and its confidence was decayed.
    const v1 = store.getDocById(`${EVAL_PROJECT}/region-v1`)!;
    expect(v1.verdict).toBe("superseded");
    expect((v1.disputes ?? []).some((d) => d.claim.startsWith(SUPERSEDED_CLAIM_PREFIX))).toBe(true);
    expect(v1.confidence).toBe(DISPUTED_CONFIDENCE);
    // The winner's contradiction edge was cleared, re-admitting it.
    const v2 = store.getDocById(`${EVAL_PROJECT}/region-v2`)!;
    expect(isVerdictEligibleForInjection(v2.verdict)).toBe(true);

    // A "now" query still recalls BOTH (invalidate, don't delete), but only v2 is
    // injection-eligible — v1's tombstone holds it out of confident retrieval.
    const results = await searchKnowledge(db, EVAL_PROJECT, "which region does production deploy to now", null, {
      corpus: "project",
      limit: 5,
    });
    const bySlug = new Map(results.map((r: SearchResult) => [r.slug, r]));
    expect(bySlug.has("region-v1")).toBe(true);
    expect(bySlug.has("region-v2")).toBe(true);
    expect(isVerdictEligibleForInjection(bySlug.get("region-v1")!.verdict)).toBe(false);
    expect(isVerdictEligibleForInjection(bySlug.get("region-v2")!.verdict)).toBe(true);

    // "Prefers v2": among the injection-eligible hits, v2 is present and v1 is not.
    const injectable = results.filter((r: SearchResult) => isVerdictEligibleForInjection(r.verdict)).map((r: SearchResult) => r.slug);
    expect(injectable).toContain("region-v2");
    expect(injectable).not.toContain("region-v1");
  });
});
