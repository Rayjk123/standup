import { afterEach, describe, expect, test } from "bun:test";
import { cleanBrief, forbiddenActions, planInjection } from "@standup/knowledge";
import { claudeTextArgv } from "./claude-cli.js";
import { DEFAULT_ORG_PROFILE } from "./org-profile/default.js";
import type { OrgProfile } from "./org-profile/types.js";
import {
  applyOrgReviewTerms,
  INJECTION_QUERY_CALL_OPTIONS,
  INJECTION_QUERY_MODEL_ENV,
  isInjectionQueryModelEnabled,
  rewriteInjectionQueries,
  type RewriteModelCall,
} from "./knowledge-query-rewrite.js";

const BRIEF =
  "Fix postWithRetry so rate-limited Slack mirror posts honour Retry-After. Don't open a pull request.\n\n" +
  "<!-- standup:owner-preferences 3fa2c1d09b7e -->\n- Never set a ticket priority in the tracker\n<!-- /standup:owner-preferences 3fa2c1d09b7e -->";

const ON = { [INJECTION_QUERY_MODEL_ENV]: "1" };

describe("rewriteInjectionQueries", () => {
  test("off by default: the heuristic plan, and the model is never called", async () => {
    let calls = 0;
    const callModel: RewriteModelCall = async () => {
      calls++;
      return null;
    };
    expect(isInjectionQueryModelEnabled({})).toBe(false);
    expect(await rewriteInjectionQueries(BRIEF, { env: {}, callModel })).toEqual(planInjection(BRIEF));
    expect(calls).toBe(0);
  });

  test("on: a valid answer supplies the focused queries and task type; the prompt carries no owner preferences", async () => {
    let prompt = "";
    const callModel: RewriteModelCall = async (p) => {
      prompt = p;
      return '{"taskType":"fix","queries":["slack mirror retry policy","Retry-After handling"]}';
    };
    const plan = await rewriteInjectionQueries(BRIEF, { env: ON, callModel });
    expect(plan.source).toBe("model");
    expect(plan.taskType).toBe("fix");
    expect(plan.queries).toEqual([cleanBrief(BRIEF), "slack mirror retry policy", "Retry-After handling"]);
    expect(plan.forbidden).toEqual(["code_review"]);
    expect(prompt).toContain("postWithRetry");
    expect(prompt).not.toContain("ticket priority");
  });

  const failures: { name: string; callModel: RewriteModelCall }[] = [
    { name: "a failed call (null)", callModel: async () => null },
    { name: "a thrown error", callModel: async () => Promise.reject(new Error("spawn failed")) },
    { name: "prose instead of JSON", callModel: async () => "Sure! Search for slack retries." },
    { name: "an unknown task type", callModel: async () => '{"taskType":"chat","queries":["a b"]}' },
  ];
  for (const f of failures) {
    test(`on: ${f.name} falls back to the heuristic plan`, async () => {
      expect(await rewriteInjectionQueries(BRIEF, { env: ON, callModel: f.callModel })).toEqual(planInjection(BRIEF));
    });
  }

  test("the model call runs with no tools, bare, no MCP and never with bypassPermissions", () => {
    const argv = claudeTextArgv(INJECTION_QUERY_CALL_OPTIONS, []);
    expect(argv.slice(0, 4)).toEqual(["claude", "-p", "--tools", ""]);
    expect(argv).toContain("--bare");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv.join(" ")).not.toContain("bypassPermissions");
    expect(argv.join(" ")).not.toContain("--dangerously-skip-permissions");
    expect(INJECTION_QUERY_CALL_OPTIONS.noThinking).toBe(true);
    expect(INJECTION_QUERY_CALL_OPTIONS.timeoutMs).toBeLessThanOrEqual(10_000);
  });
});

describe("applyOrgReviewTerms", () => {
  const withNoun = (noun: string | undefined): OrgProfile => ({
    ...DEFAULT_ORG_PROFILE,
    codeReview: { ...DEFAULT_ORG_PROFILE.codeReview, noun },
  });
  afterEach(() => applyOrgReviewTerms(DEFAULT_ORG_PROFILE));

  test("the profile's review noun makes a brief that forbids one forbid the code_review action", () => {
    const brief = "Fix the retry loop. Don't cut a changeset.";
    applyOrgReviewTerms(DEFAULT_ORG_PROFILE);
    expect(forbiddenActions(brief)).toEqual([]);
    applyOrgReviewTerms(withNoun("changeset"));
    expect(forbiddenActions(brief)).toEqual(["code_review"]);
  });

  test.each(["change", "Change", "patch", "review"])("an everyday noun (%s) adds no term", (noun) => {
    const brief = `Fix the retry loop. Don't ${noun.toLowerCase()} the API, and no new ${noun.toLowerCase()}s.`;
    applyOrgReviewTerms(DEFAULT_ORG_PROFILE);
    const builtIn = forbiddenActions(brief);
    applyOrgReviewTerms(withNoun(noun));
    expect(forbiddenActions(brief)).toEqual(builtIn);
    expect(forbiddenActions("Fix the retry loop. Don't open a pull request.")).toEqual(["code_review"]);
  });

  test("the returned function puts back the terms in force before the call", () => {
    const brief = "Fix the retry loop. Don't cut a changeset.";
    applyOrgReviewTerms(withNoun("changeset"));
    const restore = applyOrgReviewTerms(DEFAULT_ORG_PROFILE);
    expect(forbiddenActions(brief)).toEqual([]);
    restore();
    expect(forbiddenActions(brief)).toEqual(["code_review"]);
    applyOrgReviewTerms(DEFAULT_ORG_PROFILE)();
    expect(forbiddenActions(brief)).toEqual(["code_review"]);
  });

  test("a profile with no noun (or a blank one) leaves only the built-in review words", () => {
    for (const noun of [undefined, "  "]) {
      applyOrgReviewTerms(withNoun(noun));
      expect(forbiddenActions("Fix the retry loop. Don't cut a changeset.")).toEqual([]);
      expect(forbiddenActions("Fix the retry loop. Don't open a pull request.")).toEqual(["code_review"]);
    }
  });
});
