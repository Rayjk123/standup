import { afterAll, beforeAll, expect, test, describe } from "bun:test";
import { decide, outwardMatches, outwardStep, writesCollectorApi } from "./policy.js";
import { DEFAULT_ORG_PROFILE } from "../org-profile/default.js";
import { setActiveOrgProfile } from "../org-profile/load.js";
import { exampleCorpProfile } from "../org-profile/fixtures/example-corp.js";

/** A project budget with room for the launch: 3 of 6 active. */
const budget = { projectLaunchable: true, activeLaunches: 3, maxActiveLaunches: 6 };

const PHRASES = [
  "Step 1, investigate (read-only; never write to the shared staging index):",
  "Any change to stored scores must be a backfill script that is dry-run by default (like the existing ones under scripts/backfill).",
  "Do NOT run it against the staging index; the owner runs backfills.",
  "- a single commit at the end, on this branch",
  "Note: git commands that run hooks are held by the safety floor here. Make one commit when you are done, and change files with the Edit tool, not python/sed scripts.",
  // A report of finished work, which reads like a merge request.
  "Context: The tokenizer was just rewritten and merged into main (4e8d2f1). The staging index was rebuilt with it last night.",
];

/** A launch brief whose prohibitions and past reports name outward steps without asking for them. */
const BRIEF = [
  "Goal: find out why short search queries rank stale pages above fresh ones, then fix the scoring so recency breaks ties.",
  ...PHRASES,
  "Acceptance:",
  "- a short write-up with ranking metrics before and after (computed on a local copy of the index)",
  "- code changes with passing tests for the touched services",
].join("\n");

describe("launch-hold regression (search ranking brief)", () => {
  test.each(PHRASES)("no outward step or collector write in %p", (phrase) => {
    expect(outwardMatches(phrase)).toEqual([]);
    expect(writesCollectorApi(phrase)).toBe(false);
  });

  test("the in-budget launch acts", () => {
    const d = decide("launch_session", { ...budget, text: BRIEF });
    expect(d).toEqual({ rule: "act", reason: "launch within the active cap" });
  });

  test("past-tense reports of finished work are not requests", () => {
    for (const text of [
      "The fix was merged into main yesterday; build on it.",
      "Context: this branch has been pushed to origin already, so start from it.",
      "The stack was deployed to beta last week. Investigate the latency.",
      "PR 12 was recently merged into main and broke the parser.",
    ]) {
      expect(decide("launch_session", { ...budget, text }).rule).toBe("act");
    }
  });

  test("a brief that directs an outward step is still read as one, and the launch acts", () => {
    for (const text of [
      "Fix the parser, then get it merged into main.",
      "The tests were fixed; now push to origin.",
      "It was reviewed, so merge it into main.",
      "Acceptance: open a PR with the fix.",
      "Once it was approved, deploy to prod.",
      "Fix the bug and push to origin when done.",
    ]) {
      expect(outwardMatches(text).length).toBeGreaterThan(0);
      expect(decide("launch_session", { ...budget, text })).toEqual({ rule: "act", reason: "launch within the active cap" });
    }
  });

  test("a worker's report of a merge still names a step when Persona would consent to it, and the answer acts", () => {
    const question = "It was merged into main. OK to deploy to prod?";
    expect(outwardStep(question, { honorNegation: false })).not.toBeNull();
    const d = decide("answer_ask", {
      owned: true,
      askKind: "ask_human",
      text: "Yes",
      authorizes: [question],
    });
    expect(d.rule).toBe("act");
  });
});

/** The example.corp fixture profile: `corp-review` is its review CLI. */
const CORP = exampleCorpProfile();

/** A project budget with room for the launch: no active launches out of 6. */
const ordersBudget = { projectLaunchable: true, activeLaunches: 0, maxActiveLaunches: 6 };

/** A brief that extends a code review the owner opened, in the example.corp review vocabulary. */
const ORDERS_BRIEF = `Goal: let the browser frontend call the OrdersApi APIs. Add a role the frontend uses to call them, plus CORS support. The owner just cut code review R-123 (https://code.example.corp/reviews/R-123). This work extends that change.

Context:
- The project is orders-api, likely ~/src/orders-api. Run \`ls ~/src/orders-api\` to confirm.
- First read R-123 to see what it changes. Use the local branch and/or the review CLI read-only. Then find how the admin API already configures CORS, and mirror that pattern.
- Use search_knowledge/get_knowledge_doc for prior CORS decisions.

Build:
1. A least-privilege role the frontend uses to call the APIs, following the existing role pattern.
2. CORS on the APIs:
   - preflight OPTIONS
   - allowed origins limited to the frontend's per-environment domains
   - CORS headers on every response, including error responses
3. Tests for the role and the CORS config.

Validation:
- Run the build and the tests.
- Render the infrastructure config locally and show the role and CORS snippets.
- Don't deploy anything to any account. Use read-only credentials only if you need to inspect something.

Delivery:
- Commit locally on the branch of R-123, so it can become a revision of that code review. Don't run \`corp-review\` yourself.
- Report:
  - files changed
  - build/test results
  - the exact \`corp-review --revise R-123 --description d.md\` command the owner would run
  - a draft description update

Constraints:
- No parallel subagent fan-out. Run one build at a time.`;

describe("launch-hold regression (Orders API browser role + CORS)", () => {
  beforeAll(() => setActiveOrgProfile(CORP));
  afterAll(() => setActiveOrgProfile(DEFAULT_ORG_PROFILE));

  test("every line of the brief is free of outward steps, the profile's review CLI read too", () => {
    const flagged = ORDERS_BRIEF.split("\n").filter((line) => outwardMatches(line, { profile: CORP }).length > 0);
    expect(flagged).toEqual([]);
  });

  test("the in-budget launch acts", () => {
    const d = decide("launch_session", { ...ordersBudget, text: ORDERS_BRIEF });
    expect(d).toEqual({ rule: "act", reason: "launch within the active cap" });
  });

  test("an irregular past report of a cut review is not a request", () => {
    for (const text of [
      "The owner just cut code review R-123. This work extends that change.",
      "I already cut a PR for the parser; build on it.",
      "A code review was cut yesterday for this.",
      "The owner has cut R-123.",
    ]) {
      expect(outwardMatches(text, { profile: CORP })).toEqual([]);
      expect(decide("launch_session", { ...ordersBudget, text }).rule).toBe("act");
    }
  });

  test("prohibitions, hand-offs and local steps launch directly", () => {
    for (const text of [
      "Don't deploy",
      "Don't deploy anything to any account.",
      "give the owner the corp-review command to run",
      "Commit locally on the branch of R-123, so it can become a revision of that code review. Don't run `corp-review` yourself.",
      "Report a draft description update.",
      "- the exact `corp-review --revise R-123 --description d.md` command the owner would run",
      "Give me the `corp-review --revise R-123 --description d.md` command for me to run.",
    ]) {
      expect(outwardMatches(text, { profile: CORP })).toEqual([]);
      expect(decide("launch_session", { ...ordersBudget, text }).rule).toBe("act");
    }
  });

  test("a brief that directs an outward step is still read as one, and the launch acts", () => {
    for (const text of [
      "Run `corp-review --revise R-123 --description d.md` to post the revision",
      "deploy it to beta",
      "Fix the handler, then run corp-review --revise R-123 --description d.md.",
      "Just cut a PR for the fix.",
      "Please just cut a PR when done.",
      "Cut a PR with the change.",
      "Run `corp-review --revise R-123`, the command the owner would run.",
      "Write the `corp-review --revise R-123` command you can run, then run it.",
    ]) {
      expect(outwardMatches(text, { profile: CORP }).length).toBeGreaterThan(0);
      expect(decide("launch_session", { ...ordersBudget, text })).toEqual({ rule: "act", reason: "launch within the active cap" });
    }
  });

  test("past the active cap the same brief queues; it is never held for the owner", () => {
    const capped = decide("launch_session", { ...ordersBudget, activeLaunches: 6, text: ORDERS_BRIEF });
    expect(capped.rule).toBe("act");
    expect(capped.queued).toMatch(/active launch cap reached \(6\/6\)/);
  });
});
