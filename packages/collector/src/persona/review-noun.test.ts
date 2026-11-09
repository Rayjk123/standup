import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_ORG_PROFILE } from "../org-profile/default.js";
import { mergeOrgProfile, setActiveOrgProfile } from "../org-profile/load.js";
import type { OrgProfile } from "../org-profile/types.js";
import { asksOneStep } from "./allow-check.js";
import { namesHeldCall } from "./consent-target.js";
import { isReviewHandoff } from "./handoff.js";
import { relaxationOf } from "./playbook.js";
import { memoryNeedsOwnerWords, outwardMatches, ownerAskedForPipeline, ownerAskedToForget } from "./policy.js";
import { BUILT_IN_REVIEW_NOUN, reviewNounSource, reviewNounsOf } from "./review-noun.js";

/** The default profile with `extra` merged over it, as a profile file is. */
function profileWith(extra: Record<string, unknown>): OrgProfile {
  const { profile, errors } = mergeOrgProfile(DEFAULT_ORG_PROFILE, { name: "noun-test", ...extra });
  if (errors.length) throw new Error(errors.join("; "));
  return profile;
}

/** An org that calls a review a "CL", a short noun none of the built-in review words cover. */
const CL_PROFILE = profileWith({ codeReview: { noun: "CL" } });
const CHANGE_REQUEST_PROFILE = profileWith({ codeReview: { noun: "change request" } });

afterEach(() => setActiveOrgProfile(DEFAULT_ORG_PROFILE));

describe("reviewNounSource", () => {
  test.each([
    ["CL", String.raw`(?:cls?)`],
    ["  change   request ", String.raw`(?:change\s+requests?)`],
    ["c.l", String.raw`(?:c\.ls?)`],
  ])("%p reads as %p", (noun, source) => {
    expect(reviewNounSource(profileWith({ codeReview: { noun } }))).toBe(source);
  });

  test("a profile with no noun names none", () => {
    expect(reviewNounSource(DEFAULT_ORG_PROFILE)).toBeNull();
  });

  test("every profile reads the built-in noun beside its own", () => {
    expect(reviewNounsOf(DEFAULT_ORG_PROFILE)).toBe(BUILT_IN_REVIEW_NOUN);
    expect(reviewNounsOf(CL_PROFILE)).toBe(`(?:${BUILT_IN_REVIEW_NOUN}|(?:cls?))`);
  });
});

describe("a change request is a review under the default profile", () => {
  test.each([
    "ship the change request",
    "merge the change request",
    "land the change request",
    "get the change request reviewed",
    "post the results on the change request",
    "reply to the change request feedback",
    "OK to submit the change request?",
  ])("outwardMatches(%p) names a step", (text) => {
    expect(outwardMatches(text).length).toBeGreaterThan(0);
  });

  test("the change request template is code, not a step", () => {
    expect(outwardMatches("the change request template is in docs/")).toEqual([]);
  });

  test("a question joining a push to cutting a change request asks two steps", () => {
    setActiveOrgProfile(DEFAULT_ORG_PROFILE);
    expect(asksOneStep("Should I push and cut the change request?")).toBe(false);
  });

  test("a standing ask to ship a change request needs the owner's words", () => {
    setActiveOrgProfile(DEFAULT_ORG_PROFILE);
    expect(memoryNeedsOwnerWords("Always ship the change request without asking.")).toBe(true);
  });

  test("skipping or cutting a change request is a relaxation", () => {
    setActiveOrgProfile(DEFAULT_ORG_PROFILE);
    expect(relaxationOf("you may skip the change request")).toBe("drops a delivery-pipeline stage or check");
    expect(relaxationOf("feel free to cut the change request")).toBe("grants leave for an outward-facing step");
  });

  test("a hand-off asking to review the change request is a review hand-off", () => {
    setActiveOrgProfile(DEFAULT_ORG_PROFILE);
    expect(isReviewHandoff("Please review the change request.")).toBe(true);
  });
});

describe("the org's review noun counts as a step wherever a review does", () => {
  // Each case: [text, the noun's profile, read as a step with it, read as a step with the default profile].
  const outward: Array<[string, OrgProfile, boolean, boolean]> = [
    ["ship the CL", CL_PROFILE, true, false],
    ["OK to submit the CL?", CL_PROFILE, true, false],
    ["land the CL", CL_PROFILE, true, false],
    ["get the CL reviewed", CL_PROFILE, true, false],
    ["reply to the CL feedback", CL_PROFILE, true, false],
    ["cut a new change request", CHANGE_REQUEST_PROFILE, true, true],
    ["the CL template is in docs/", CL_PROFILE, false, false],
  ];
  test.each(outward)("outwardMatches(%p)", (text, profile, withNoun, withDefault) => {
    expect(outwardMatches(text, { profile }).length > 0).toBe(withNoun);
    expect(outwardMatches(text).length > 0).toBe(withDefault);
  });

  test("a question joining a push to cutting the org's review asks two steps", () => {
    const question = "Should I push and cut the CL?";
    setActiveOrgProfile(DEFAULT_ORG_PROFILE);
    expect(asksOneStep(question)).toBe(true);
    setActiveOrgProfile(CL_PROFILE);
    expect(asksOneStep(question)).toBe(false);
    expect(asksOneStep("Should I push the branch?")).toBe(true);
  });

  test.each([
    ["you may skip the CL", "drops a delivery-pipeline stage or check"],
    ["feel free to cut the CL", "grants leave for an outward-facing step"],
  ])("the playbook relaxation guard refuses %p", (line, why) => {
    setActiveOrgProfile(DEFAULT_ORG_PROFILE);
    expect(relaxationOf(line)).toBeNull();
    setActiveOrgProfile(CL_PROFILE);
    expect(relaxationOf(line)).toBe(why);
  });

  test("never skipping the org's review relaxes nothing", () => {
    setActiveOrgProfile(CL_PROFILE);
    expect(relaxationOf("never skip the CL")).toBeNull();
  });

  test("a hand-off asking to review the org's review is a review hand-off", () => {
    setActiveOrgProfile(DEFAULT_ORG_PROFILE);
    expect(isReviewHandoff("Please review the CL.")).toBe(false);
    setActiveOrgProfile(CL_PROFILE);
    expect(isReviewHandoff("Please review the CL.")).toBe(true);
  });

  test("an owner's pipeline setting may name the stage by the org's noun", () => {
    setActiveOrgProfile(DEFAULT_ORG_PROFILE);
    expect(ownerAskedForPipeline(["for standup: no CL"])).toBe(false);
    setActiveOrgProfile(CL_PROFILE);
    expect(ownerAskedForPipeline(["for standup: no CL"])).toBe(true);
    expect(ownerAskedForPipeline(["for standup: no CL, isolated live check"])).toBe(true);
  });

  test("forgetting a rule for one review of the org's is forgetting it for now", () => {
    const said = ["forget the deploy rule for this CL"];
    setActiveOrgProfile(DEFAULT_ORG_PROFILE);
    expect(ownerAskedToForget("deploy-rule", said)).toBe(true);
    setActiveOrgProfile(CL_PROFILE);
    expect(ownerAskedToForget("deploy-rule", said)).toBe(false);
  });
});

describe("org outward rules in free text", () => {
  const profile = profileWith({
    outwardRules: [
      { program: "corp-x", subcommand: [], category: "outward", reason: "runs the org's tool" },
      { program: "corp-ship", subcommand: ["promote"], category: "outward", reason: "promotes a build" },
    ],
  });

  // A rule with no subcommand would read every mention of its program as the step; the floor reads it against real calls.
  test.each([
    ["the corp-x docs say to wait", false],
    ["run corp-x now", false],
    ["corp-ship promote the build", true],
    ["the corp-ship docs say to wait", false],
  ])("%p reads as a step: %p", (text, step) => {
    expect(outwardMatches(text, { profile }).length > 0).toBe(step);
  });
});

describe("an org CLI's subcommand is the step a yes names", () => {
  const profile = profileWith({
    outwardRules: [{ program: "corp-ship", subcommand: ["promote|rollback"], category: "outward", reason: "moves a build" }],
  });

  test("a yes naming only the program and another subcommand doesn't cover this one", () => {
    const call = "corp-ship rollback orders-api";
    setActiveOrgProfile(DEFAULT_ORG_PROFILE);
    expect(namesHeldCall(["yes, go ahead with corp-ship promote orders-api"], "Bash", call)).toBe(true);
    setActiveOrgProfile(profile);
    expect(namesHeldCall(["yes, go ahead with corp-ship promote orders-api"], "Bash", call)).toBe(false);
    expect(namesHeldCall(["yes, rollback orders-api"], "Bash", call)).toBe(true);
  });
});
