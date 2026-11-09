import { describe, expect, test } from "bun:test";
import { decide, ownerAskedToKeepPlaybook } from "./policy.js";

describe("save_playbook and decide_playbook verdicts", () => {
  test("never from a thread other people read", () => {
    expect(decide("save_playbook", { privateThread: false, playbookNeedsOwnerWords: false }).rule).toBe("never");
    expect(decide("decide_playbook", { privateThread: false, playbookDecision: "reject" }).rule).toBe("never");
  });

  test("a playbook whose approval notes name no approval is drafted directly", () => {
    expect(decide("save_playbook", { privateThread: true, playbookNeedsOwnerWords: false })).toMatchObject({ rule: "act" });
  });

  test("approval notes in the owner's own words of this turn are drafted directly", () => {
    const notes = "always ask me before you deploy anything to the shared beta stack";
    const d = decide("save_playbook", {
      privateThread: true,
      playbookNeedsOwnerWords: true,
      text: notes,
      ownerTexts: [`remember: ${notes}`],
    });
    expect(d.rule).toBe("act");
  });

  test("rejecting a draft acts; keeping one needs the owner's ask this turn", () => {
    expect(decide("decide_playbook", { privateThread: true, playbookDecision: "reject" }).rule).toBe("act");
    const retire = { privateThread: true, playbookDecision: "retire" as const, title: "Ship a console tab", topic: "playbook-alice--console-tab" };
    expect(decide("decide_playbook", { ...retire, ownerTexts: [] })).toMatchObject({ rule: "ask", holdRule: "playbook-retire" });
    expect(decide("decide_playbook", { ...retire, ownerTexts: ["retire the console tab playbook"] }).rule).toBe("act");
    expect(decide("decide_playbook", { ...retire, ownerTexts: ["don't retire the console playbook"] }).rule).toBe("ask");
    expect(
      decide("decide_playbook", { privateThread: true, playbookDecision: "accept", ownerTexts: ["yes, keep that playbook"], playbookPendingCount: 1 }).rule
    ).toBe("act");
    expect(decide("decide_playbook", { privateThread: true, ownerTexts: [] }).rule).toBe("ask");
  });

  test("with several drafts pending, the owner's keep must name the playbook", () => {
    const ctx = { privateThread: true, playbookDecision: "accept" as const, playbookPendingCount: 2, title: "Ship a console tab", topic: "playbook-alice--console-tab" };
    expect(decide("decide_playbook", { ...ctx, ownerTexts: ["yes, keep that playbook"] }).rule).toBe("ask");
    expect(decide("decide_playbook", { ...ctx, ownerTexts: ["keep the console playbook"] }).rule).toBe("act");
  });
});

describe("ownerAskedToKeepPlaybook", () => {
  const only = { pendingCount: 1 };
  const cases: Array<[string, boolean]> = [
    ["yes, keep that playbook", true],
    ["accept the playbook", true],
    ["save it as a playbook", false],
    ["should we keep a playbook?", false],
    ["don't keep that playbook", false],
    ["reject the playbook", false],
    ["yes, keep it", false],
    ["thanks", false],
  ];
  for (const [text, expected] of cases) {
    test(`${JSON.stringify(text)} → ${expected}`, () => {
      expect(ownerAskedToKeepPlaybook([text], only)).toBe(expected);
    });
  }

  test("naming a word of the title or name picks the playbook among several", () => {
    const target = { title: "Rotate credentials", slug: "playbook-alice--rotate-creds", pendingCount: 3 };
    expect(ownerAskedToKeepPlaybook(["keep the rotate playbook"], target)).toBe(true);
    expect(ownerAskedToKeepPlaybook(["keep the console playbook"], target)).toBe(false);
  });

  test("a title made of the keep vocabulary isn't named by the verb that keeps another", () => {
    const target = { title: "Keep: docs refresh", slug: "playbook-alice--keep-docs", pendingCount: 2 };
    expect(ownerAskedToKeepPlaybook(["keep the console tab playbook"], target)).toBe(false);
    expect(ownerAskedToKeepPlaybook(["keep the docs playbook"], target)).toBe(true);
  });
});
