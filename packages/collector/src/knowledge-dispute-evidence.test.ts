import { describe, expect, test } from "bun:test";
import type { DraftDispute } from "./draft-verify.js";
import {
  disputeEntailment,
  extractBindings,
  filterEntailedDisputes,
  type Entailment,
} from "./knowledge-dispute-evidence.js";

function cited(claim: string, quote: string, extra: Partial<DraftDispute> = {}): DraftDispute {
  return {
    kind: "contradicted",
    claim,
    finding: "the code says otherwise",
    evidence: "rg",
    citations: [{ file: "/repo/src/graph.ts", line: 10, quote }],
    ...extra,
  };
}

describe("dispute entailment", () => {
  const table: Array<[string, DraftDispute, Entailment]> = [
    [
      "same constant → refuted",
      cited("`CO_CITATION_MAX_TAG_DOCS=8` caps a tag's docs", "export const CO_CITATION_MAX_TAG_DOCS = 8;"),
      "refuted",
    ],
    [
      "same constants, several, digit separators → refuted",
      cited(
        "CO_CITATION_FANOUT is 6 and JUDGE_TIMEOUT_MS is 60000",
        "export const CO_CITATION_FANOUT = 6;\nconst JUDGE_TIMEOUT_MS = 60_000;"
      ),
      "refuted",
    ],
    [
      "typed declaration with the same value → refuted",
      cited("MIN_COSINE: 0.7", "export const MIN_COSINE: number = 0.7;"),
      "refuted",
    ],
    [
      "same quoted string → refuted",
      cited('JUDGE_MODEL = "claude-haiku-4-5"', 'const JUDGE_MODEL = "claude-haiku-4-5";'),
      "refuted",
    ],
    [
      "different value → kept",
      cited("`CO_CITATION_MAX_TAG_DOCS=8`", "export const CO_CITATION_MAX_TAG_DOCS = 12;"),
      "contradicts",
    ],
    [
      "one shared name differs among matches → kept",
      cited("maxJudged = 3, searchLimit = 5", "const maxJudged = 3;\nconst searchLimit = 9;"),
      "contradicts",
    ],
    [
      "different string → kept",
      cited("defaultCorpus: 'all'", "const defaultCorpus = 'project';"),
      "contradicts",
    ],
    [
      "no shared name → undecided",
      cited("the cron runs every ten minutes", "setInterval(tick, 10 * 60_000);"),
      "undecided",
    ],
    [
      "English words are not bindings → undecided",
      cited("the result is 5 files", "the result = 6"),
      "undecided",
    ],
    [
      "a file:line location is not a binding → undecided",
      cited("graph.ts:138 builds the edges", "const graph = 138;"),
      "undecided",
    ],
    [
      "the verifier's own values agree and appear in the quote → refuted",
      cited("the limit is eight", "const LIMIT_TAG_DOCS = 8;", { draftValue: "8", codeValue: "8" }),
      "refuted",
    ],
    [
      "the verifier's own values differ → kept",
      cited("the limit is eight", "const LIMIT_TAG_DOCS = 12;", { draftValue: "8", codeValue: "12" }),
      "contradicts",
    ],
    [
      "a code value found only inside a longer number is ignored → undecided",
      cited("the limit is eight", "const LIMIT_TAG_DOCS = 128;", { draftValue: "8", codeValue: "8" }),
      "undecided",
    ],
    [
      "a code value missing from the quote is ignored → undecided",
      cited("the limit is eight", "const LIMIT = compute();", { draftValue: "8", codeValue: "8" }),
      "undecided",
    ],
    [
      "the quote confirms only one of two claimed bindings → undecided",
      cited("TIMEOUT_MS = 30, MAX_RETRIES = 3", "const TIMEOUT_MS = 30;"),
      "undecided",
    ],
    [
      "same last segment, different qualified names → undecided",
      cited("client.timeoutMs = 30", "server.timeoutMs = 30"),
      "undecided",
    ],
    [
      "same qualified name and value → refuted",
      cited("client.timeoutMs = 30", "client.timeoutMs = 30;"),
      "refuted",
    ],
    [
      "names compare case-sensitively → undecided",
      cited("maxRetries = 3", "MAXRETRIES = 3"),
      "undecided",
    ],
    [
      "an absence dispute is never decided here",
      { kind: "absent", claim: "FOO_BAR = 1", finding: "missing", evidence: "rg", symbol: "FOO_BAR", searched: ["/r"] },
      "undecided",
    ],
  ];
  for (const [name, dispute, expected] of table) {
    test(name, () => {
      expect(disputeEntailment(dispute).entailment).toBe(expected);
    });
  }

  test("bindings keep names as written and normalize quotes and digit separators in values", () => {
    expect([...extractBindings("const TIMEOUT_MS = 60_000; `myFlag` is true; client.timeoutMs = 5")]).toEqual([
      ["TIMEOUT_MS", "60000"],
      ["client.timeoutMs", "5"],
      ["myFlag", "true"],
    ]);
  });
});

describe("filterEntailedDisputes", () => {
  const refutable = cited("MAX_JUDGED = 3", "const MAX_JUDGED = 3;");
  const contradicting = cited("MAX_JUDGED = 3", "const MAX_JUDGED = 5;");
  const undecided = cited("the judge runs at most three times", "for (let i = 0; i < attempts; i++) {");

  test("drops refuted disputes with a reason and keeps the rest without a judge", async () => {
    const { kept, refuted } = await filterEntailedDisputes([refutable, contradicting, undecided]);
    expect(kept).toEqual([contradicting, undecided]);
    expect(refuted).toHaveLength(1);
    expect(refuted[0]).toContain("refuted");
  });

  test("an entailment judge decides only the undecided remainder", async () => {
    const asked: string[] = [];
    const judge = async (d: DraftDispute) => (asked.push(d.claim), "consistent" as const);
    const { kept, refuted } = await filterEntailedDisputes([refutable, contradicting, undecided], judge);
    expect(asked).toEqual([undecided.claim]);
    expect(kept).toEqual([contradicting]);
    expect(refuted).toHaveLength(2);
  });

  test("a judge that cannot answer or throws leaves the dispute kept", async () => {
    const silent = await filterEntailedDisputes([undecided], async () => null);
    expect(silent.kept).toEqual([undecided]);
    const throwing = await filterEntailedDisputes([undecided], async () => {
      throw new Error("spawn failed");
    });
    expect(throwing.kept).toEqual([undecided]);
  });
});
