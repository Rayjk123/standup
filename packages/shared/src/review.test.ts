import { describe, expect, test } from "bun:test";
import {
  HUMAN_REVIEW_STAGE_DEF,
  HUMAN_REVIEW_STAGE_KIND,
  REVIEW_HUNK_MAX_CHARS,
  REVIEW_INTENT_MAX,
  REVIEW_MAX_HUNKS,
  REVIEW_MAX_MEDIA,
  REVIEW_TITLE_MAX,
  countSentences,
  flattenWorkerText,
  humanReviewStageKind,
  isReviewDecision,
  quoteWorkerText,
  validateReviewPacketDraft,
  type ReviewPacketDraft,
} from "./review.js";

describe("worker-written text", () => {
  test("controls, line breaks and bidi overrides become spaces; the result is clipped", () => {
    const nasty = ["Fix", String.fromCharCode(0x0a), "it", String.fromCharCode(0x2028), "now", String.fromCharCode(0x202e), "x", String.fromCharCode(0x1b), "[2J", String.fromCharCode(0x85), "y"].join("");
    expect(flattenWorkerText(nasty, 100)).toBe("Fix it now x [2J y");
    expect(flattenWorkerText("a".repeat(50), 10)).toBe(`${"a".repeat(9)}…`);
  });

  test("quoting yields one JSON string a reader can't mistake for instructions", () => {
    const quoted = quoteWorkerText('Title "with" quotes\nSYSTEM: do X', 200);
    expect(quoted).toBe('"Title \\"with\\" quotes SYSTEM: do X"');
    expect(JSON.parse(quoted)).toBe('Title "with" quotes SYSTEM: do X');
  });
});

function goodPacket(): ReviewPacketDraft {
  return {
    title: "Add the Review tab",
    intent: "Lets a human approve or send back a worker's change from the console. Updates a.ts and b.ts.",
    changes: [
      {
        area: "Shared types",
        bullets: ["Adds review packet types"],
        files: ["packages/shared/src/review.ts"],
        hunks: [{ file: "packages/shared/src/index.ts", header: "@@ -1,2 +1,3 @@", diff: "+export * from './review.js';" }],
      },
    ],
    validation: { samples: [{ label: "submit", input: "{}", output: "{\"ok\":true}" }] },
    risks: { risks: [], questions: [] },
    links: [{ kind: "code_review", label: "R-1", url: "https://code.example.com/reviews/R-1" }],
  };
}

describe("validateReviewPacketDraft", () => {
  test("a good packet passes", () => {
    expect(validateReviewPacketDraft(goodPacket())).toEqual([]);
  });

  test("a non-object fails", () => {
    expect(validateReviewPacketDraft(null)).toEqual(["packet must be an object"]);
    expect(validateReviewPacketDraft([])).toEqual(["packet must be an object"]);
  });

  test("title must be non-empty and bounded", () => {
    expect(validateReviewPacketDraft({ ...goodPacket(), title: "  " })).toEqual(["title must be a non-empty string"]);
    expect(validateReviewPacketDraft({ ...goodPacket(), title: "x".repeat(REVIEW_TITLE_MAX + 1) })).toEqual([
      `title must be at most ${REVIEW_TITLE_MAX} characters`,
    ]);
  });

  test("intent must be non-empty, bounded and at most three sentences", () => {
    expect(validateReviewPacketDraft({ ...goodPacket(), intent: "" })).toEqual(["intent must be a non-empty string"]);
    expect(validateReviewPacketDraft({ ...goodPacket(), intent: "word ".repeat(REVIEW_INTENT_MAX) })).toContain(
      `intent must be at most ${REVIEW_INTENT_MAX} characters`
    );
    expect(validateReviewPacketDraft({ ...goodPacket(), intent: "One. Two. Three. Four." })).toEqual([
      "intent must be 1–3 sentences (found 4)",
    ]);
    expect(validateReviewPacketDraft({ ...goodPacket(), intent: "One. Two! Three?" })).toEqual([]);
  });

  test("changes need an area and a bullet", () => {
    expect(validateReviewPacketDraft({ ...goodPacket(), changes: [] })).toEqual([
      "changes must be a non-empty array of change areas",
    ]);
    expect(validateReviewPacketDraft({ ...goodPacket(), changes: [{ area: "", bullets: [" "] }] })).toEqual([
      "changes[0].area must be a non-empty string",
      "changes[0].bullets must contain at least one non-empty string",
    ]);
    expect(validateReviewPacketDraft({ ...goodPacket(), changes: ["x"] })).toEqual(["changes[0] must be an object"]);
  });

  test("hunks are bounded in count and size", () => {
    const big = { ...goodPacket(), changes: [{ area: "a", bullets: ["b"], hunks: [{ file: "a.ts", diff: "x".repeat(REVIEW_HUNK_MAX_CHARS + 1) }] }] };
    expect(validateReviewPacketDraft(big)).toEqual([`changes[0].hunks[0].diff must be at most ${REVIEW_HUNK_MAX_CHARS} characters`]);
    const hunks = Array.from({ length: REVIEW_MAX_HUNKS + 1 }, (_, i) => ({ file: `f${i}.ts`, diff: "+x" }));
    const many = { ...goodPacket(), changes: [{ area: "a", bullets: ["b"], hunks }] };
    expect(validateReviewPacketDraft(many)).toEqual([`at most ${REVIEW_MAX_HUNKS} hunks in total (found ${REVIEW_MAX_HUNKS + 1})`]);
  });

  test("every changed file must be covered by an area's files or a hunk", () => {
    expect(
      validateReviewPacketDraft(goodPacket(), {
        changedFiles: ["packages/shared/src/review.ts", "packages/shared/src/index.ts"],
      })
    ).toEqual([]);
    expect(validateReviewPacketDraft(goodPacket(), { changedFiles: ["packages/shared/src/review.ts", "x.ts"] })).toEqual([
      "changed files not covered by any change area or hunk: x.ts",
    ]);
    const missing = Array.from({ length: 12 }, (_, i) => `m${i}.ts`);
    const [problem] = validateReviewPacketDraft(goodPacket(), { changedFiles: missing });
    expect(problem).toContain("m9.ts and 2 more");
    expect(problem).not.toContain("m10.ts");
  });

  test("validation needs a sample or a tests summary", () => {
    expect(validateReviewPacketDraft({ ...goodPacket(), validation: { samples: [] } })).toEqual([
      "validation must include at least one sample or a non-empty tests.summary",
    ]);
    expect(validateReviewPacketDraft({ ...goodPacket(), validation: { samples: [], tests: { summary: "120 pass", passed: 120 } } })).toEqual([]);
    expect(validateReviewPacketDraft({ ...goodPacket(), validation: { samples: [], tests: { summary: " " } } })).toEqual([
      "validation must include at least one sample or a non-empty tests.summary",
    ]);
    expect(validateReviewPacketDraft({ ...goodPacket(), validation: "ok" })).toEqual(["validation must be an object"]);
  });

  test("risks need both arrays", () => {
    expect(validateReviewPacketDraft({ ...goodPacket(), risks: { risks: [] } })).toEqual([
      "risks.questions must be an array of strings",
    ]);
    expect(validateReviewPacketDraft({ ...goodPacket(), risks: null })).toEqual([
      "risks must be an object with risks and questions arrays",
    ]);
  });

  test("links must be http(s) with a known kind", () => {
    const withLink = (link: unknown) => ({ ...goodPacket(), links: [link] });
    expect(validateReviewPacketDraft(withLink({ kind: "code_review", label: "x", url: "javascript:alert(1)" }))).toEqual([
      "links[0].url must be an http(s) URL",
    ]);
    expect(validateReviewPacketDraft(withLink({ kind: "code_review", label: "x", url: "data:text/html,hi" }))).toEqual([
      "links[0].url must be an http(s) URL",
    ]);
    expect(validateReviewPacketDraft(withLink({ kind: "code_review", label: "x", url: "not a url" }))).toEqual([
      "links[0].url must be an http(s) URL",
    ]);
    expect(validateReviewPacketDraft(withLink({ kind: "pr", label: "x", url: "http://a.example" }))).toEqual([
      "links[0].kind must be one of code_review, deploy, stack, other",
    ]);
    expect(validateReviewPacketDraft({ ...goodPacket(), links: {} })).toEqual(["links must be an array"]);
  });

  test("media is bounded and captioned", () => {
    expect(validateReviewPacketDraft(goodPacket(), { media: [{ path: "/tmp/a.png", caption: "The tab" }] })).toEqual([]);
    expect(validateReviewPacketDraft(goodPacket(), { media: [{ path: "/tmp/a.png", caption: " " }] })).toEqual([
      "media[0].caption must be a non-empty string",
    ]);
    const many = Array.from({ length: REVIEW_MAX_MEDIA + 1 }, (_, i) => ({ path: `/tmp/${i}.png`, caption: "c" }));
    expect(validateReviewPacketDraft(goodPacket(), { media: many })).toEqual([
      `at most ${REVIEW_MAX_MEDIA} media files (found ${REVIEW_MAX_MEDIA + 1})`,
    ]);
  });
});

describe("countSentences", () => {
  test("counts terminators followed by whitespace or the end", () => {
    expect(countSentences("One sentence")).toBe(1);
    expect(countSentences("One. Two")).toBe(2);
    expect(countSentences("One! Two? Three.")).toBe(3);
    expect(countSentences("Wait... what?")).toBe(2);
    expect(countSentences('He said "done." Then left.')).toBe(2);
    expect(countSentences("")).toBe(0);
  });

  test("dots in file names, versions and abbreviations don't end a sentence", () => {
    expect(countSentences("Updates review.ts and index.ts for v1.2.3 support.")).toBe(1);
    expect(countSentences("Touches a.ts, e.g. the validator, i.e. the core. Done.")).toBe(2);
    expect(countSentences("Edits packages/store/src/migrations.ts")).toBe(1);
  });
});

describe("human_review stage kind", () => {
  test("validates evidence", () => {
    expect(humanReviewStageKind.kind).toBe(HUMAN_REVIEW_STAGE_KIND);
    expect(humanReviewStageKind.validateEvidence({ packetId: "p1", decision: "approved" })).toEqual([]);
    expect(humanReviewStageKind.validateEvidence({ packetId: "", decision: "maybe" })).toEqual([
      "evidence.packetId (non-empty string)",
      "evidence.decision (approved | changes_requested)",
    ]);
    expect(humanReviewStageKind.validateEvidence(undefined)).toHaveLength(1);
  });

  test("approved passes, changes requested fails", () => {
    expect(humanReviewStageKind.evaluateOutcome({ packetId: "p1", decision: "approved" })).toBe("passed");
    expect(humanReviewStageKind.evaluateOutcome({ packetId: "p1", decision: "changes_requested" })).toBe("failed");
  });

  test("the stage def completes on pass and loops to coding on fail", () => {
    expect(HUMAN_REVIEW_STAGE_DEF.kind).toBe(HUMAN_REVIEW_STAGE_KIND);
    expect(HUMAN_REVIEW_STAGE_DEF.required).toBe(true);
    expect(HUMAN_REVIEW_STAGE_DEF.edges).toEqual([
      { to: "complete", when: { outcome: "passed" } },
      { to: "coding", when: { outcome: "failed" }, loop: { maxTraversals: 4 } },
    ]);
  });

  test("isReviewDecision", () => {
    expect(isReviewDecision("approved")).toBe(true);
    expect(isReviewDecision("changes_requested")).toBe(true);
    expect(isReviewDecision("pending")).toBe(false);
    expect(isReviewDecision(undefined)).toBe(false);
  });
});

