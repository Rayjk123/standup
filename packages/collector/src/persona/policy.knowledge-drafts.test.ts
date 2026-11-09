import { describe, expect, test } from "bun:test";
import { HOLDABLE, READ_ACTIONS, decide } from "./policy.js";

describe("knowledge-draft decisions", () => {
  test("listing drafts is a read", () => {
    expect(READ_ACTIONS.has("list_knowledge_drafts")).toBe(true);
    expect(decide("list_knowledge_drafts").rule).toBe("act");
  });

  test("searching knowledge and reading knowledge usage are reads", () => {
    for (const action of ["search_knowledge", "knowledge_usage"]) {
      expect(READ_ACTIONS.has(action)).toBe(true);
      expect(decide(action).rule).toBe("act");
    }
  });

  test("deciding a draft from a private thread acts, with no approval hold", () => {
    expect(decide("decide_knowledge_draft", { privateThread: true, personalLayer: false })).toMatchObject({ rule: "act" });
  });

  test("the owner's personal layer is never decided this way", () => {
    const d = decide("decide_knowledge_draft", { privateThread: true, personalLayer: true });
    expect(d.rule).toBe("never");
    expect(d.reason).toContain("remember or forget");
  });

  test("a thread other people read never decides a draft", () => {
    expect(decide("decide_knowledge_draft", { privateThread: false }).rule).toBe("never");
    expect(decide("decide_knowledge_draft", {}).rule).toBe("never");
  });

  test("the owner can still hold it with STANDUP_PERSONA_HOLD, which never loosens the personal-layer refusal", () => {
    expect(HOLDABLE.has("decide_knowledge_draft")).toBe(true);
    const hold = { hold: new Set(["decide_knowledge_draft"]) };
    expect(decide("decide_knowledge_draft", { privateThread: true }, hold).rule).toBe("ask");
    expect(decide("decide_knowledge_draft", { privateThread: true, personalLayer: true }, hold).rule).toBe("never");
  });
});
