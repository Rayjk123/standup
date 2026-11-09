import { describe, expect, test } from "bun:test";
import { decide, HOLD_ACCEPTANCE_CRITERION } from "./policy.js";
import { FLOOR_ALLOW_OPTION, FLOOR_GATE, FLOOR_OWNER_GATE } from "../floor/gate.js";
import held from "./fixtures/held-approvals.json";

/*
 * Four Persona actions whose prose a text-reading policy would hold (the
 * approvals of fixtures/held-approvals.json, in their stored shape), fed
 * through the structured decision path. None may be held: Persona's actions
 * on its own workers act on structured facts, and what their words make a
 * worker do is enforced at the worker's floor.
 */

/** Launch counts within the cap: 2 of 6 active. */
const recorded = { activeLaunches: 2, maxActiveLaunches: 6 };
const launchable = { projectLaunchable: true, launchHarness: "claude" };

describe("the held-case fixtures act", () => {
  test("a2: launch_session with its full brief (a keep-held list and quoted fixtures)", () => {
    const { args } = held["a2000000-0000-4000-8000-0000000000a2"];
    expect(args.task).toContain("push, deploy, open a pull request, merge or move main");
    const d = decide("launch_session", { ...launchable, ...recorded, text: args.task });
    expect(d).toEqual({ rule: "act", reason: "launch within the active cap" });
  });

  test("a4: launch_session whose brief quotes a past report (\"nothing pushed or deployed\")", () => {
    const { args } = held["a4000000-0000-4000-8000-0000000000a4"];
    expect(args.task).toContain("nothing pushed or deployed and no PR open");
    expect(decide("launch_session", { ...launchable, ...recorded, text: args.task }).rule).toBe("act");
  });

  test("a3: send_to_session (owned, next_turn) with the steering text that quotes the list", () => {
    const { args } = held["a3000000-0000-4000-8000-0000000000a3"];
    expect(args.text).toContain("push, deploy, open a pull request, merge or move main");
    const d = decide("send_to_session", { owned: true, sendMode: args.mode, workerBypassed: true, workerAtPrompt: false, text: args.text });
    expect(d).toEqual({ rule: "act", reason: "owned session" });
  });

  test("a1: approve_plan with the exact note and criterion", () => {
    const { args } = held["a1000000-0000-4000-8000-0000000000a1"];
    expect(args.note).toContain("never with pkill -f");
    expect(args.note).toContain(".git/info/exclude");
    const d = decide("approve_plan", { owned: true, text: args.note, acceptanceCriterion: args.acceptanceCriterion });
    expect(d).toEqual({ rule: "act", reason: "plan of an owned worker" });
    // The owner's acceptance-criterion hold now applies when the criterion runs, not to the approval.
    const knob = decide("approve_plan", { owned: true, text: args.note, acceptanceCriterion: args.acceptanceCriterion }, { hold: new Set([HOLD_ACCEPTANCE_CRITERION]) });
    expect(knob.rule).toBe("act");
  });

  test("the same texts act in every orchestration action", () => {
    const texts = [
      held["a2000000-0000-4000-8000-0000000000a2"].args.task,
      held["a4000000-0000-4000-8000-0000000000a4"].args.task,
      held["a3000000-0000-4000-8000-0000000000a3"].args.text,
      held["a1000000-0000-4000-8000-0000000000a1"].args.note,
    ];
    for (const text of texts) {
      expect(decide("launch_session", { ...launchable, ...recorded, text }).rule).toBe("act");
      expect(decide("send_to_session", { owned: true, sendMode: "next_turn", text }).rule).toBe("act");
      expect(decide("answer_ask", { owned: true, askKind: "ask_human", text, authorizes: [text] }).rule).toBe("act");
      expect(decide("approve_plan", { owned: true, text, acceptanceCriterion: text }).rule).toBe("act");
      expect(decide("reject_plan", { owned: true, text }).rule).toBe("act");
      expect(decide("create_schedule", { ...launchable, scheduleKind: "launch_job", text }).rule).toBe("act");
    }
  });
});

describe("cap and host room queue; they never raise a card", () => {
  test("below the active cap the launch starts, however many ran today", () => {
    const d = decide("launch_session", { ...launchable, activeLaunches: 0, maxActiveLaunches: 6 });
    expect(d.rule).toBe("act");
    expect(d.queued).toBeUndefined();
  });

  test("at the active cap the launch acts, queued", () => {
    const d = decide("launch_session", { ...launchable, activeLaunches: 6, maxActiveLaunches: 6 });
    expect(d.rule).toBe("act");
    expect(d.queued).toMatch(/active launch cap reached \(6\/6\)/);
  });

  test("a scheduled run now past the active cap is queued too", () => {
    const d = decide("run_schedule_now", { ...launchable, scheduleKind: "launch_job", activeLaunches: 6, maxActiveLaunches: 6 });
    expect(d.rule).toBe("act");
    expect(d.queued).toMatch(/active launch cap reached \(6\/6\)/);
  });
});

describe("structured refusals and owner holds still apply", () => {
  test("an unowned session, ask or plan is never acted on", () => {
    for (const action of ["send_to_session", "interrupt_session", "stop_session", "answer_ask", "approve_plan", "reject_plan"]) {
      expect(decide(action, { owned: false, askKind: "ask_human", sendMode: "next_turn", text: "hi" }).rule).toBe("never");
    }
  });

  test("an unlaunchable project, or a harness without the safety floor, is never launched into", () => {
    expect(decide("launch_session", { projectLaunchable: false, ...recorded }).rule).toBe("never");
    expect(decide("launch_session", { projectLaunchable: true, launchHarness: "codex", ...recorded }).rule).toBe("never");
    expect(decide("create_schedule", { projectLaunchable: true, launchHarness: "codex", scheduleKind: "launch_job" }).rule).toBe("never");
  });

  test("a leading ! on a bypassed worker, and `now` on a busy pane, are refused", () => {
    expect(decide("send_to_session", { owned: true, sendMode: "next_turn", workerBypassed: true, text: "!git push" }).rule).toBe("never");
    expect(decide("send_to_session", { owned: true, sendMode: "now", workerAtPrompt: false, text: "hi" }).rule).toBe("never");
    expect(decide("send_to_session", { owned: true, sendMode: "now", workerAtPrompt: true, permissionPending: true, text: "hi" }).rule).toBe("never");
  });

  test("a tool-permission prompt is the owner's, and Persona can't answer it", () => {
    const d = decide("answer_ask", { owned: true, askKind: "permission_prompt", text: "Yes" });
    expect(d.rule).toBe("ask");
  });

  test("Persona decides a floor ask on either gate, high-risk ones included", () => {
    expect(decide("answer_ask", { owned: true, askKind: "ask_human", askGate: FLOOR_OWNER_GATE, floorCategory: "outward", text: FLOOR_ALLOW_OPTION }).rule).toBe("act");
    expect(
      decide("answer_ask", {
        owned: true,
        askKind: "ask_human",
        askGate: FLOOR_OWNER_GATE,
        floorCategory: "floor-tamper",
        floorHighRisk: true,
        text: FLOOR_ALLOW_OPTION,
      }).rule
    ).toBe("act");
    expect(decide("answer_ask", { owned: true, askKind: "ask_human", askGate: FLOOR_GATE, floorCategory: "unclassified", text: FLOOR_ALLOW_OPTION }).rule).toBe("act");
    expect(decide("answer_ask", { owned: true, askKind: "ask_human", askGate: FLOOR_OWNER_GATE, floorCategory: "outward", text: "Deny" }).rule).toBe("act");
  });

  test("the owner's STANDUP_PERSONA_HOLD still holds what it names", () => {
    const hold = { hold: new Set(["launch_session", "send_to_session", "approve_plan"]) };
    expect(decide("launch_session", { ...launchable, ...recorded }, hold).rule).toBe("ask");
    expect(decide("send_to_session", { owned: true, sendMode: "next_turn" }, hold).rule).toBe("ask");
    expect(decide("approve_plan", { owned: true }, hold).rule).toBe("ask");
  });
});
