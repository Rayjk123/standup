import type { Database } from "bun:sqlite";
import { searchKnowledge } from "./search.js";
import type { EmbeddingProvider, EmbeddingConfig } from "./embeddings.js";
import type { SemanticNeighborIndex } from "./graph.js";

/**
 * Retrieval eval harness. A labeled `query → expected-doc(s)` fixture set, run
 * through the REAL search path (searchKnowledge — the same hybrid FTS +
 * embedding retrieval behind /api/knowledge/search), so retrieval quality is
 * measured rather than judged by hand.
 *
 * The default fixtures ({@link STANDUP_EVAL_FIXTURES}) target the seed
 * knowledge base that `bun run kb:seed` copies into every install, so the live
 * GET /api/knowledge/eval endpoint measures docs the store actually holds and
 * the Health panel shows a meaningful recall@5 / top-1 / MRR / Hit-Rate@5.
 * The bun-test guards pass their own fixtures over deterministic seeded
 * corpora (so a change can't silently regress recall — including an
 * embedding-provider switch).
 */

/** A doc is identified across projects by `${projectId}/${slug}`. */
export type DocKey = string;

export interface EvalFixture {
  /** The natural-language or keyword query to run. */
  query: string;
  /** The doc(s) a good search must recall, as `${projectId}/${slug}` keys. */
  expected: DocKey[];
  /**
   * A keyword query must not regress; a paraphrase query is the abstract
   * phrasing precision historically lagged on. Tracking the split lets the
   * Health panel show where retrieval is weak.
   */
  kind: "keyword" | "paraphrase";
  /**
   * The project the query is asked from — the ranking multiplier favors it,
   * mirroring an agent asking about its own project. Defaults to the project of
   * the first expected doc.
   */
  project?: string;
  /** Why this fixture exists / what it guards. */
  note?: string;
}

export interface EvalFixtureResult {
  query: string;
  kind: EvalFixture["kind"];
  expected: DocKey[];
  /** An expected doc appeared in the top-k. */
  hitAtK: boolean;
  /** The top-ranked result was an expected doc. */
  hitTop1: boolean;
  /** The top-k result keys, best-first, for inspection. */
  topResults: DocKey[];
  /** 1-based rank of the first expected doc in the full result window, or null. */
  rank: number | null;
  /**
   * Fraction of THIS fixture's expected docs present in the top-k — the per-
   * fixture recall the aggregate `recallAtK` macro-averages. Equals hitAtK as
   * 0/1 for a single-expected fixture; a genuine fraction once a fixture lists
   * several expected docs.
   */
  recall: number;
  /**
   * 1/rank of the first expected doc, or 0 when none fell in the window — the
   * per-fixture term the aggregate `mrr` averages.
   */
  reciprocalRank: number;
}

export interface EvalResult {
  k: number;
  total: number;
  /**
   * Macro-averaged per-fixture recall@k (mean of {@link EvalFixtureResult.recall}).
   * For the single-expected-doc fixtures shipped here this equals the Hit-Rate@k
   * below; the two diverge only once a fixture carries several expected docs.
   */
  recallAtK: number;
  /** Fraction of fixtures whose top result was an expected doc. */
  top1: number;
  /**
   * Hit-Rate@k — the fraction of fixtures with AT LEAST ONE expected doc in the
   * top-k. Reported alongside recall@k so the Health panel shows "did we surface
   * the answer at all" separately from "how much of the answer set we surfaced".
   */
  hitRateAtK: number;
  /**
   * Mean Reciprocal Rank of the first expected doc across fixtures (MRR@k, since
   * the window is the top-k). Rewards ranking the answer HIGH, not merely inside
   * the window — the signal recall@k and Hit-Rate@k are both blind to. Always
   * ≥ top1 (a rank-1 hit contributes 1 to both) and ≤ 1.
   */
  mrr: number;
  perFixture: EvalFixtureResult[];
}

/**
 * The default fixtures, over the seed knowledge base (`seed/knowledge/` in the
 * repo, copied into an install's knowledge dir by `bun run kb:seed`). Half
 * keyword (must not regress), half abstract paraphrase (the precision edge).
 * eval.test.ts loads the real seed files and holds these to the floors below,
 * so a seed doc edit that breaks one of them fails there.
 */
export const STANDUP_EVAL_FIXTURES: EvalFixture[] = [
  {
    query: "Bun fetch TimeoutError long-poll timeout false",
    expected: ["global/bun-fetch-default-timeout"],
    kind: "keyword",
    note: "the 360-second fetch limit and its opt-out",
  },
  {
    query: "TODO issue commented-out code workaround comment",
    expected: ["global/comments-explain-why-not-what"],
    kind: "keyword",
    note: "the comment-style convention",
  },
  {
    query: "rebase origin main force-with-lease autosquash fixup",
    expected: ["global/rebase-before-opening-a-review"],
    kind: "keyword",
    note: "the pre-review branch hygiene runbook",
  },
  {
    query: "frontmatter origin_class source_kind half_life_days",
    expected: ["standup/knowledge-doc-format"],
    kind: "keyword",
    note: "the knowledge doc format spec",
  },
  {
    query: "why does a call that waits on a human answer fail after six minutes",
    expected: ["global/bun-fetch-default-timeout"],
    kind: "paraphrase",
    note: "the symptom of the fetch limit, phrased without its name",
  },
  {
    query: "when is it worth writing a note in the source next to a line",
    expected: ["global/comments-explain-why-not-what"],
    kind: "paraphrase",
  },
  {
    query: "how do I bring my branch up to date before someone looks at it",
    expected: ["global/rebase-before-opening-a-review"],
    kind: "paraphrase",
  },
  {
    query: "where does a knowledge file live and which metadata goes on top",
    expected: ["standup/knowledge-doc-format"],
    kind: "paraphrase",
  },
];

/**
 * The documented floors the bun-test guards assert. Set below the measured
 * scores with margin: a guard catches a real regression, not normal score
 * drift, so it must not hard-fail on drift. Raise these as retrieval improves;
 * never lower them to make a red build pass.
 */
export const RECALL_AT_5_FLOOR = 0.8;
export const TOP_1_FLOOR = 0.5;

function keyOf(projectId: string, slug: string): DocKey {
  return `${projectId}/${slug}`;
}

/**
 * Runs the fixtures through searchKnowledge and computes recall@k + top-1.
 * `provider` is passed straight through, so a null provider exercises the
 * FTS-only path (what bun test runs, offline) and a real provider exercises the
 * full hybrid path (what the live endpoint runs).
 */
export async function runRetrievalEval(
  db: Database,
  provider: EmbeddingProvider | null,
  options: {
    fixtures?: EvalFixture[];
    k?: number;
    embeddingConfig?: EmbeddingConfig;
    /**
     * When supplied, the graph-rerank arm is exercised: the neighbor index is
     * passed through and `graphRerank` decides whether it applies. Lets the
     * B2 gate measure recall/top-1/MRR with the graph arm on vs off through the
     * same real search path — omitted, the eval runs the two-arm merge exactly
     * as before.
     */
    graphNeighbors?: SemanticNeighborIndex;
    graphRerank?: boolean;
  } = {}
): Promise<EvalResult> {
  const fixtures = options.fixtures ?? STANDUP_EVAL_FIXTURES;
  const k = options.k ?? 5;
  const embeddingConfig = options.embeddingConfig ?? {};

  const perFixture: EvalFixtureResult[] = [];
  for (const fixture of fixtures) {
    const project = fixture.project ?? fixture.expected[0]?.split("/")[0] ?? "scratch";
    const results = await searchKnowledge(
      db,
      project,
      fixture.query,
      provider,
      {
        limit: k,
        corpus: "all",
        graphNeighbors: options.graphNeighbors,
        graphRerank: options.graphRerank,
      },
      embeddingConfig
    );
    const resultKeys = results.map((r) => keyOf(r.projectId, r.slug));
    const expected = new Set(fixture.expected);

    const rankIndex = resultKeys.findIndex((key) => expected.has(key));
    // Per-fixture recall: how many of THIS fixture's expected docs landed in the
    // window, over how many it named. A single-expected fixture yields 0 or 1, so
    // its mean matches the historical "fraction of fixtures that hit" exactly.
    const foundExpected = resultKeys.filter((key) => expected.has(key));
    const recall = expected.size === 0 ? 0 : new Set(foundExpected).size / expected.size;
    perFixture.push({
      query: fixture.query,
      kind: fixture.kind,
      expected: fixture.expected,
      hitAtK: rankIndex !== -1,
      hitTop1: resultKeys.length > 0 && expected.has(resultKeys[0]),
      topResults: resultKeys,
      rank: rankIndex === -1 ? null : rankIndex + 1,
      recall,
      reciprocalRank: rankIndex === -1 ? 0 : 1 / (rankIndex + 1),
    });
  }

  const total = perFixture.length;
  const mean = (pick: (r: EvalFixtureResult) => number) =>
    total === 0 ? 0 : perFixture.reduce((sum, r) => sum + pick(r), 0) / total;
  const recallAtK = mean((r) => r.recall);
  const top1 = total === 0 ? 0 : perFixture.filter((r) => r.hitTop1).length / total;
  const hitRateAtK = total === 0 ? 0 : perFixture.filter((r) => r.hitAtK).length / total;
  const mrr = mean((r) => r.reciprocalRank);

  return { k, total, recallAtK, top1, hitRateAtK, mrr, perFixture };
}
