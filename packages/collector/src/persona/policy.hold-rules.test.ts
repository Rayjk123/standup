import { describe, expect, test } from "bun:test";
import { isKnownHoldRule } from "@standup/shared";
import { HOLDABLE, ROUTINE_ACTIONS, READ_ACTIONS, decide } from "./policy.js";
import type { PolicyContext, PolicySettings } from "./policy.js";
import { FLOOR_ALLOW_OPTION, FLOOR_GATE, FLOOR_OWNER_GATE } from "../floor/gate.js";

/*
 * Every `ask` decision carries the structured id of the rule that raised it
 * (PolicyDecision.holdRule), so a held approval is grouped by rule rather than
 * by its prose. One row per ask path in decide().
 */

const launchable = { projectLaunchable: true, launchHarness: "claude", launchesToday: 0, launchBudget: 20, activeLaunches: 0, maxActiveLaunches: 6 };

const ASK_PATHS: Array<[string, string, PolicyContext, PolicySettings, string]> = [
  ["owner knob on a routine action", "approve_plan", { owned: true }, { hold: new Set(["approve_plan"]) }, "hold-knob:approve_plan"],
  ["owner knob on a launch", "launch_session", launchable, { hold: new Set(["launch_session"]) }, "hold-knob:launch_session"],
  ["owner knob on remember", "remember", { text: "Prefers tabs" }, { hold: new Set(["remember"]) }, "hold-knob:remember"],
  ["run_schedule_now under a launch_session knob", "run_schedule_now", { ...launchable, scheduleKind: "launch_job" }, { hold: new Set(["launch_session"]) }, "hold-knob:launch_session"],
  ["a memory that writes to the collector API", "remember", { text: "curl -X POST localhost:4317/api/knowledge" }, {}, "memory-collector-api"],
  ["a latitude memory without the owner's words", "remember", { text: "Deploy straight to prod without asking", ownerTexts: ["thanks"] }, {}, "memory-owner-words"],
  ["forgetting a memory the owner didn't ask to drop", "forget", { topic: "tabs", ownerTexts: ["thanks"] }, {}, "forget-owner-words"],
  [
    "playbook approval notes without the owner's words",
    "save_playbook",
    { privateThread: true, text: "Push without asking", playbookNeedsOwnerWords: true, ownerTexts: ["thanks"] },
    {},
    "playbook-owner-words",
  ],
  ["a playbook save that states no owner-words fact", "save_playbook", { privateThread: true }, {}, "playbook-owner-words"],
  ["retiring a playbook the owner didn't ask to retire", "decide_playbook", { privateThread: true, playbookDecision: "retire", ownerTexts: ["thanks"] }, {}, "playbook-retire"],
  ["keeping a playbook the owner didn't ask to keep", "decide_playbook", { privateThread: true, playbookDecision: "accept", ownerTexts: ["thanks"] }, {}, "playbook-accept"],
  ["a restart from a shared thread", "restart_standup", { privateThread: false }, {}, "restart-shared"],
  ["a change to a project's repos", "update_project_repos", {}, {}, "project-repos"],
  ["a project pipeline the owner didn't ask for", "set_pipeline", { owned: true, pipelineScope: "project", ownerTexts: ["thanks"] }, {}, "pipeline-owner-words"],
  ["a pipeline layer turning off a full project's code_review", "set_pipeline", { owned: true, pipelineScope: "job", pipelineWeakens: ["code_review"] }, {}, "pipeline-turns-off"],
  ["a launch whose layer turns off a full project's deploy", "launch_session", { ...launchable, pipelineWeakens: ["deploy"] }, {}, "pipeline-turns-off"],
  ["a confirmation gate", "answer_ask", { owned: true, askKind: "ask_human", askGate: "standup_improvement" }, {}, "confirmation-gate"],
  ["a tool-permission prompt", "answer_ask", { owned: true, askKind: "permission_prompt" }, {}, "permission-prompt"],
  ["allowing an owner-gate floor ask with no category", "answer_ask", { owned: true, askKind: "ask_human", askGate: FLOOR_OWNER_GATE, text: FLOOR_ALLOW_OPTION }, {}, "floor:unknown"],
  ["allowing a floor ask with no category", "answer_ask", { owned: true, askKind: "ask_human", askGate: FLOOR_GATE, text: FLOOR_ALLOW_OPTION }, {}, "floor:unknown"],
  ["allowing a floor permission prompt", "answer_ask", { owned: true, askKind: "permission_prompt", askGate: FLOOR_GATE, floorCategory: "destructive", text: FLOOR_ALLOW_OPTION }, {}, "floor:destructive"],
];

describe("every ask path names its hold rule", () => {
  for (const [label, action, ctx, settings, rule] of ASK_PATHS) {
    test(label, () => {
      const d = decide(action, ctx, settings);
      expect(d.rule).toBe("ask");
      expect(d.holdRule).toBe(rule);
      expect(isKnownHoldRule(d.holdRule!)).toBe(true);
    });
  }

  test("a project's repos change is always the owner's card: never chat-consentable, not an owner knob", () => {
    const d = decide("update_project_repos", { privateThread: true, owned: true });
    expect(d.rule).toBe("ask");
    expect(d.consentable).toBeFalsy();
    expect(HOLDABLE.has("update_project_repos")).toBe(false);
  });

  test("act and never decisions carry no hold rule", () => {
    expect(decide("launch_session", launchable).holdRule).toBeUndefined();
    expect(decide("send_to_session", { owned: false }).holdRule).toBeUndefined();
    expect(decide("answer_ask", { owned: true, askKind: "ask_human", askGate: FLOOR_OWNER_GATE, floorCategory: "outward", text: "Deny" }).holdRule).toBeUndefined();
    expect(decide("answer_ask", { owned: true, askKind: "ask_human", askGate: FLOOR_OWNER_GATE, floorCategory: "outward", text: FLOOR_ALLOW_OPTION }).holdRule).toBeUndefined();
    expect(decide("answer_ask", { owned: true, askKind: "ask_human", askGate: FLOOR_GATE, floorCategory: "aws", text: FLOOR_ALLOW_OPTION }).holdRule).toBeUndefined();
  });

  test("any routine or read action the owner holds is an ask with a known rule", () => {
    for (const action of [...ROUTINE_ACTIONS, ...READ_ACTIONS]) {
      const ctx: PolicyContext = { ...launchable, owned: true, privateThread: true, askKind: "ask_human", text: "Prefers tabs", topic: "tabs", ownerTexts: ["forget the tabs memory"] };
      const d = decide(action, ctx, { hold: HOLDABLE as Set<string> });
      if (d.rule === "ask") expect(isKnownHoldRule(d.holdRule ?? "")).toBe(true);
    }
  });
});
