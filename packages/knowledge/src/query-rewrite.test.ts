import { afterEach, describe, expect, test } from "bun:test";
import {
  activityAdmissible,
  classifyTaskType,
  cleanBrief,
  codeReviewTerms,
  forbiddenActionRules,
  forbiddenActions,
  forbiddenRunbookAction,
  foreignIntentAdmissible,
  fuseInjectionResults,
  fuseRankedLists,
  injectionPlanGate,
  mergeActivityHits,
  namedIdentifiers,
  parseModelRewrite,
  planInjection,
  setCodeReviewTerms,
  ACTIVITY_INJECT_MAX_AGE_DAYS,
  ACTIVITY_INJECT_MIN_RELEVANCE,
  FOREIGN_INTENT_INJECT_MIN_RELEVANCE,
  MAX_INJECTION_QUERIES,
  type ForbiddenAction,
  type InjectionTaskType,
} from "./query-rewrite.js";
import type { SearchResult } from "./search.js";
import type { SourceKind } from "./types.js";

const PREFS =
  "<!-- standup:owner-preferences 3fa2c1d09b7e -->\n" +
  "- Prefer table-driven tests over one-off probes\n" +
  "- Keep log lines free of emoji\n" +
  "<!-- /standup:owner-preferences 3fa2c1d09b7e -->";

function hit(overrides: Partial<SearchResult> & { slug: string }): SearchResult {
  return {
    id: overrides.slug,
    projectId: "proj",
    title: overrides.slug,
    excerpt: "",
    score: 0.5,
    source: "text",
    originClass: "owner",
    sourceKind: "code",
    generated: false,
    relevance: 0.6,
    ...overrides,
  };
}

describe("cleanBrief", () => {
  const cases: { name: string; brief: string; keeps: string[]; drops: string[] }[] = [
    {
      name: "appended steering after a --- separator",
      brief:
        "Fix the Slack retry schedule in postWithRetry.\n\n---\nYou start at the WORKSPACE ROOT. Use the code-first knowledge tools above.",
      keeps: ["Slack retry schedule", "postWithRetry"],
      drops: ["WORKSPACE ROOT", "knowledge tools"],
    },
    {
      name: "an owner-preferences block",
      brief: `Add a per-locale fallback chain to the Quillstack i18n config.\n\n${PREFS}\n\nKeep ResolveLocale backwards compatible.`,
      keeps: ["per-locale fallback chain", "ResolveLocale backwards compatible"],
      drops: ["table-driven", "free of emoji", "standup:owner-preferences"],
    },
    {
      name: "a cut-off owner-preferences block",
      brief: "Rebalance search ranking.\n<!-- standup:owner-preferences 3fa2c1d09b7e -->\n- prefer short commits",
      keeps: ["Rebalance search ranking"],
      drops: ["short commits"],
    },
    {
      name: "a playbook block",
      brief: "Add ListCollections.\n<!-- standup:playbook ab12cd34ef56 -->\nStep 1: open the pull request\n<!-- /standup:playbook ab12cd34ef56 -->",
      keeps: ["ListCollections"],
      drops: ["open the pull request"],
    },
    {
      name: "delivery-pipeline and knowledge-tool instruction lines",
      brief:
        "Implement this fix.\nRefunds must reconcile nightly.\nThe delivery pipeline will ask for a review packet.\nCall pipeline_advance when done.\nUse search_knowledge first.",
      keeps: ["Refunds must reconcile nightly"],
      drops: ["Implement this fix", "delivery pipeline", "pipeline_advance", "search_knowledge"],
    },
    {
      name: "prohibition clauses",
      brief: "Research how Codex and Claude load project memory. Don't open PRs. Do not deploy anything.",
      keeps: ["Codex and Claude load project memory"],
      drops: ["open PRs", "deploy"],
    },
  ];
  for (const c of cases) {
    test(`strips ${c.name}`, () => {
      const cleaned = cleanBrief(c.brief);
      for (const k of c.keeps) expect(cleaned).toContain(k);
      for (const d of c.drops) expect(cleaned).not.toContain(d);
    });
  }

  test("a brief that is only a separator block keeps its text rather than going empty", () => {
    expect(cleanBrief("---\nAdd pagination")).toContain("Add pagination");
  });
});

describe("planInjection (heuristic rewrite)", () => {
  test("named code paths and identifiers survive into their own query", () => {
    const brief =
      "Fix postWithRetry in src/slack/mirror.ts so rate-limited attempts honour Retry-After, and keep MAX_ATTEMPTS and `retry_after_ms` as they are.";
    const ids = namedIdentifiers(cleanBrief(brief));
    for (const id of ["postWithRetry", "src/slack/mirror.ts", "MAX_ATTEMPTS", "retry_after_ms"]) expect(ids).toContain(id);
    const plan = planInjection(brief);
    expect(plan.queries.some((q) => q.includes("postWithRetry") && q.includes("src/slack/mirror.ts") && q !== plan.queries[0])).toBe(true);
  });

  test("at most MAX_INJECTION_QUERIES distinct queries, the cleaned brief first", () => {
    const brief =
      "# Turn the Blocks view into the live night map\n\nTurn the Frost Watch night map prototype's Blocks view (#/blocks) into the live night map: " +
      "block tiles shaded by their margin, a 12-hour uPlot chart per block fed by fetchReadings, and an Acknowledge button on each open alert.\n\n" +
      `${PREFS}\n\n---\nKnowledge-first steering text.`;
    const plan = planInjection(brief);
    expect(plan.queries.length).toBeGreaterThanOrEqual(2);
    expect(plan.queries.length).toBeLessThanOrEqual(MAX_INJECTION_QUERIES);
    expect(plan.queries[0]).toBe(cleanBrief(brief));
    expect(new Set(plan.queries.map((q) => q.toLowerCase())).size).toBe(plan.queries.length);
    expect(plan.queries).toContain("Turn the Blocks view into the live night map");
    expect(plan.queries.some((q) => q.includes("uPlot") && q.includes("fetchReadings"))).toBe(true);
    for (const q of plan.queries) {
      expect(q).not.toContain("free of emoji");
      expect(q).not.toContain("steering");
    }
    expect(plan.source).toBe("heuristic");
  });

  test("a one-word task is its own single query", () => {
    expect(planInjection("freshterm").queries).toEqual(["freshterm"]);
  });

  test("a model rewrite replaces the focused queries and task type but keeps the brief first and the forbidden actions", () => {
    const brief = "Compare Codex and Claude session memory. Don't open a PR.";
    const plan = planInjection(brief, { taskType: "research", queries: ["codex session memory", "claude auto memory"] });
    expect(plan).toEqual({
      queries: [cleanBrief(brief), "codex session memory", "claude auto memory"],
      taskType: "research",
      forbidden: ["code_review", "deploy", "push", "commit"],
      source: "model",
    });
  });
});

describe("classifyTaskType", () => {
  const cases: [string, InjectionTaskType][] = [
    ["Research how Codex loads AGENTS.md compared with Claude's CLAUDE.md", "research"],
    ["Investigate why launches stall at provisioning", "research"],
    ["Fix postWithRetry so rate-limited attempts honour Retry-After", "fix"],
    ["Slack mirror posts are dropped during bursts of 429 responses. Fix postWithRetry.", "fix"],
    ["Deploy the collector to the beta stack and verify the health check", "deploy"],
    ["Review the PR for the ranking change and list defects", "review"],
    ["Review the pull request for the ranking change", "review"],
    ["Add a per-locale fallback chain to the Quillstack i18n config. Test it before sending the review.", "implement"],
    ["Rebalance knowledge search ranking so the boosts are additive", "implement"],
  ];
  for (const [brief, type] of cases) {
    test(`${type}: ${brief.slice(0, 50)}`, () => {
      expect(classifyTaskType(cleanBrief(brief))).toBe(type);
    });
  }
});

describe("forbidden runbooks", () => {
  const detection: [string, ForbiddenAction[]][] = [
    ["Implement the playground. Don't open PRs.", ["code_review"]],
    ["Implement the playground. Never open merge requests.", ["code_review"]],
    ["Implement the playground. Do not commit, and never git push.", ["push", "commit"]],
    ["Add the locale fallback chain; no deploy is needed, do not open a pull request.", ["code_review", "deploy"]],
    ["Implement the playground and open a PR when done.", []],
    ["Change the pull request description template and its tests.", []],
    ["Fix the floor without calling the module.", []],
    // An honorific is not a merge request.
    ["Implement the playground. Don't email Mr Smith or Mrs Jones.", []],
    // A research task forbids every action it does not ask for.
    ["Research how Codex and Claude load memory.", ["code_review", "deploy", "push", "commit"]],
    ["Research how PRs are opened for the docs site.", ["deploy", "push", "commit"]],
  ];
  for (const [brief, actions] of detection) {
    test(`detects ${JSON.stringify(actions)} in: ${brief}`, () => {
      const cleaned = cleanBrief(brief);
      expect(forbiddenActions(brief, classifyTaskType(cleaned))).toEqual(actions);
    });
  }

  const docs: { title: string; slug: string; kind: SourceKind; tags?: string[]; forbidden: ForbiddenAction[]; drops: boolean }[] = [
    { title: "Splitting a large PR into stacked ones", slug: "stacked-pr-splitting", kind: "runbook", forbidden: ["code_review"], drops: true },
    { title: "Opening pull requests", slug: "pull-request-workflow", kind: "runbook", forbidden: ["code_review"], drops: true },
    { title: "Reviewer etiquette", slug: "review-etiquette", kind: "runbook", tags: ["code-review"], forbidden: ["code_review"], drops: true },
    { title: "Delivery pipeline approval currency", slug: "delivery-pipeline-approval-currency", kind: "runbook", forbidden: ["deploy"], drops: true },
    { title: "Collector deploy runbook", slug: "collector-deploy-runbook", kind: "runbook", forbidden: ["code_review"], drops: false },
    { title: "Pull request description conventions", slug: "pr-description", kind: "decision", forbidden: ["code_review"], drops: false },
    { title: "Slack mirror retry policy", slug: "slack-mirror-retry-policy", kind: "runbook", forbidden: ["code_review", "deploy", "push", "commit"], drops: false },
    { title: "Commit message conventions", slug: "commit-message-conventions", kind: "runbook", forbidden: ["commit"], drops: true },
    { title: "Merge request labels", slug: "merge-request-labels", kind: "runbook", forbidden: ["code_review"], drops: true },
    { title: "Escalating to Mr Smith's team", slug: "mrs-escalation-contacts", kind: "runbook", forbidden: ["code_review"], drops: false },
  ];
  for (const d of docs) {
    test(`${d.drops ? "drops" : "keeps"} ${d.kind} ${d.slug} when ${d.forbidden.join(",")} is forbidden`, () => {
      const got = forbiddenRunbookAction({ title: d.title, slug: d.slug, sourceKind: d.kind, tags: d.tags }, d.forbidden);
      expect(got !== null).toBe(d.drops);
    });
  }

  test("injectionPlanGate reads tags only when something is forbidden", () => {
    let reads = 0;
    const tagsOf = () => {
      reads++;
      return ["code-review"];
    };
    const r = hit({ slug: "review-etiquette", sourceKind: "runbook" });
    const now = new Date("2026-10-10T00:00:00Z");
    expect(injectionPlanGate(r, { forbidden: [] }, now, tagsOf)).toBeNull();
    expect(reads).toBe(0);
    expect(injectionPlanGate(r, { forbidden: ["code_review"] }, now, tagsOf)).toBe("forbidden");
  });
});

describe("org code-review terms", () => {
  // An org whose reviews go by a short name of their own (the example.corp
  // fixture vocabulary calls one a "changeset", and its tooling a "CL").
  const TERMS = ["changeset", "CL"];
  afterEach(() => setCodeReviewTerms([]));

  const briefs: { brief: string; withTerms: ForbiddenAction[]; builtinOnly: ForbiddenAction[] }[] = [
    { brief: "Implement the playground. Don't cut changesets.", withTerms: ["code_review"], builtinOnly: [] },
    { brief: "Implement the playground. Never send a CL for it.", withTerms: ["code_review"], builtinOnly: [] },
    { brief: "Implement the playground. Don't open PRs.", withTerms: ["code_review"], builtinOnly: ["code_review"] },
    // A term matches as a whole word only: "client" and "CLI" are not "CL".
    { brief: "Implement the playground. Don't touch the client or the CLI.", withTerms: [], builtinOnly: [] },
  ];
  for (const b of briefs) {
    test(`forbids ${JSON.stringify(b.withTerms)} in: ${b.brief}`, () => {
      setCodeReviewTerms(TERMS);
      expect(forbiddenActions(b.brief)).toEqual(b.withTerms);
      setCodeReviewTerms([]);
      expect(forbiddenActions(b.brief)).toEqual(b.builtinOnly);
    });
  }

  test("a runbook named with an org term is about the code_review action", () => {
    const doc = { title: "Changeset checklist for schema migrations", slug: "changeset-checklist", sourceKind: "runbook" as const };
    expect(forbiddenRunbookAction(doc, ["code_review"])).toBeNull();
    setCodeReviewTerms(TERMS);
    expect(forbiddenRunbookAction(doc, ["code_review"])).toBe("code_review");
  });

  test("reviewing an org-named review is a review task", () => {
    const brief = "Look over the ranking change: review the changeset and list defects.";
    expect(classifyTaskType(cleanBrief(brief))).toBe("implement");
    setCodeReviewTerms(TERMS);
    expect(classifyTaskType(cleanBrief(brief))).toBe("review");
  });

  test("a term's regex metacharacters are literal, and blank terms are ignored", () => {
    setCodeReviewTerms(["c+l", "  "]);
    expect(forbiddenActions("Implement it. Don't send a ccl.")).toEqual([]);
    expect(forbiddenActions("Implement it. Don't send a c+l.")).toEqual(["code_review"]);
    expect(forbiddenActionRules()[0]!.action).toBe("code_review");
  });

  test("codeReviewTerms returns the terms last set, and [] once they are cleared", () => {
    expect(codeReviewTerms()).toEqual([]);
    setCodeReviewTerms(TERMS);
    expect(codeReviewTerms()).toEqual(TERMS);
    setCodeReviewTerms([]);
    expect(codeReviewTerms()).toEqual([]);
  });
});

describe("foreign intent admission", () => {
  const spec = (projectId: string, relevance: number, sourceKind: SourceKind = "spec") =>
    hit({ slug: "contracts", projectId, sourceKind, relevance });
  const cases: { name: string; r: SearchResult; admitted: boolean }[] = [
    { name: "a global spec at the bar", r: spec("global", FOREIGN_INTENT_INJECT_MIN_RELEVANCE), admitted: true },
    { name: "a global spec just under the bar", r: spec("global", FOREIGN_INTENT_INJECT_MIN_RELEVANCE - 0.01), admitted: false },
    { name: "a related project's product doc under the bar", r: spec("related", 0.3, "product"), admitted: false },
    { name: "the project's own weak spec", r: spec("proj", 0.21), admitted: true },
    { name: "a weak global code doc", r: spec("global", 0.21, "code"), admitted: true },
  ];
  for (const c of cases) {
    test(`${c.admitted ? "admits" : "holds"} ${c.name}`, () => {
      expect(foreignIntentAdmissible(c.r, "proj")).toBe(c.admitted);
    });
  }
});

describe("activity admission", () => {
  const now = new Date("2026-10-10T00:00:00Z");
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
  const note = (relevance: number, writtenAt?: string) =>
    hit({ slug: "native-mem-memory-head-to-head", sourceKind: "native-memory", relevance, ...(writtenAt ? { writtenAt } : {}) });
  const cases: { name: string; r: SearchResult; admitted: boolean }[] = [
    { name: "relevant and recent", r: note(ACTIVITY_INJECT_MIN_RELEVANCE, daysAgo(2)), admitted: true },
    { name: "just under the relevance bar", r: note(ACTIVITY_INJECT_MIN_RELEVANCE - 0.01, daysAgo(2)), admitted: false },
    { name: "just inside the age bar", r: note(0.9, daysAgo(ACTIVITY_INJECT_MAX_AGE_DAYS - 0.5)), admitted: true },
    { name: "at the age bar", r: note(0.9, daysAgo(ACTIVITY_INJECT_MAX_AGE_DAYS)), admitted: false },
    { name: "with no write date", r: note(0.9), admitted: false },
    { name: "outside the activity layer, however weak or old", r: hit({ slug: "old-code", relevance: 0.2, writtenAt: daysAgo(400) }), admitted: true },
  ];
  for (const c of cases) {
    test(`${c.admitted ? "admits" : "holds"} a note ${c.name}`, () => {
      expect(activityAdmissible(c.r, now)).toBe(c.admitted);
      expect(injectionPlanGate(c.r, { forbidden: [] }, now)).toBe(c.admitted ? null : "activity");
    });
  }

  test("mergeActivityHits keeps only activity-layer notes, merged by score", () => {
    const hits = [hit({ slug: "a", score: 0.9 }), hit({ slug: "b", score: 0.4 })];
    const activity = [
      hit({ slug: "native-mem-memory-diary", sourceKind: "native-memory", score: 0.6 }),
      hit({ slug: "native-mem-claude-md", sourceKind: "native-memory", score: 0.95 }),
    ];
    expect(mergeActivityHits(hits, activity).map((r) => r.slug)).toEqual(["a", "native-mem-memory-diary", "b"]);
  });
});

describe("rank merging", () => {
  test("RRF ranks a doc several queries agree on above one query's top hit", () => {
    const fused = fuseRankedLists(
      [
        ["solo", "shared", "x"],
        ["shared", "y"],
        ["z", "shared"],
      ],
      (s) => s
    );
    expect(fused[0]).toBe("shared");
    // solo and z tie at 1/61 (first appearance breaks it); y at rank 2 beats x at rank 3.
    expect(fused).toEqual(["shared", "solo", "z", "y", "x"]);
  });

  test("ties keep first-appearance order and every doc appears once", () => {
    expect(fuseRankedLists([["a", "b"], ["c", "d"]], (s) => s)).toEqual(["a", "c", "b", "d"]);
  });

  test("fuseInjectionResults keeps each doc's most relevant instance", () => {
    const fused = fuseInjectionResults([
      [hit({ slug: "a", relevance: 0.3 }), hit({ slug: "b", relevance: 0.5 })],
      [hit({ slug: "a", relevance: 0.8 })],
    ]);
    expect(fused.map((r) => [r.slug, r.relevance])).toEqual([
      ["a", 0.8],
      ["b", 0.5],
    ]);
  });
});

describe("parseModelRewrite", () => {
  const cases: { name: string; raw: string | null; ok: boolean }[] = [
    { name: "strict JSON", raw: '{"taskType":"fix","queries":["slack retry policy","Retry-After handling"]}', ok: true },
    { name: "fenced JSON", raw: '```json\n{"taskType":"implement","queries":["locale fallback schema"]}\n```', ok: true },
    { name: "null", raw: null, ok: false },
    { name: "prose", raw: "Here are some queries: slack retry", ok: false },
    { name: "an unknown task type", raw: '{"taskType":"chat","queries":["a b"]}', ok: false },
    { name: "too many queries", raw: '{"taskType":"fix","queries":["a","b","c","d","e"]}', ok: false },
    { name: "no queries", raw: '{"taskType":"fix","queries":[]}', ok: false },
    { name: "a non-string query", raw: '{"taskType":"fix","queries":["a", 3]}', ok: false },
    { name: "an over-long query", raw: JSON.stringify({ taskType: "fix", queries: ["x".repeat(201)] }), ok: false },
    { name: "an array", raw: '["fix"]', ok: false },
  ];
  for (const c of cases) {
    test(`${c.ok ? "accepts" : "rejects"} ${c.name}`, () => {
      expect(parseModelRewrite(c.raw) !== null).toBe(c.ok);
    });
  }
});
