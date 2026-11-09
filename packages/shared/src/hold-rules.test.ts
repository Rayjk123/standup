import { describe, expect, test } from "bun:test";
import {
  HOLD_FLOOR_CATEGORIES,
  HOLD_RULES,
  RETIRED_HOLD_RULES,
  floorHoldRule,
  holdKnobRule,
  holdRuleExclusion,
  inferHoldRule,
  isKnownHoldRule,
  isLoosenableHoldRule,
  isRetiredHoldRule,
} from "./hold-rules.js";

describe("hold rule vocabulary", () => {
  test("parameterized rules are built and recognized", () => {
    expect(holdKnobRule("approve_plan")).toBe("hold-knob:approve_plan");
    expect(floorHoldRule("destructive")).toBe("floor:destructive");
    expect(floorHoldRule(undefined)).toBe("floor:unknown");
    expect(floorHoldRule("  ")).toBe("floor:unknown");
    for (const rule of HOLD_RULES) expect(isKnownHoldRule(rule)).toBe(true);
    for (const c of HOLD_FLOOR_CATEGORIES) expect(isKnownHoldRule(`floor:${c}`)).toBe(true);
    expect(isKnownHoldRule("hold-knob:remember")).toBe(true);
    expect(isKnownHoldRule("hold-knob:")).toBe(false);
    expect(isKnownHoldRule("floor:made-up")).toBe(false);
    expect(isKnownHoldRule("text:outward")).toBe(false);
    for (const rule of RETIRED_HOLD_RULES) expect(isRetiredHoldRule(rule)).toBe(true);
  });

  test("owner-only floor categories, permission prompts, confirmation gates and shared-thread memories are never loosenable", () => {
    for (const c of ["outward", "aws", "collector-api", "floor-tamper", "unknown"]) {
      expect(isLoosenableHoldRule(`floor:${c}`)).toBe(false);
      expect(holdRuleExclusion(`floor:${c}`)).not.toBeNull();
    }
    expect(isLoosenableHoldRule("permission-prompt")).toBe(false);
    expect(isLoosenableHoldRule("confirmation-gate")).toBe(false);
    expect(isLoosenableHoldRule("memory-shared-thread")).toBe(false);
    expect(isLoosenableHoldRule("project-repos")).toBe(false);
    // The pipeline hold names every stage the owner holds, not just a full project's delivery stages.
    const pipeline = holdRuleExclusion("pipeline-turns-off")!;
    for (const held of ["validation", "review", "human review", "code review", "deploy", "screenshots", "validation checks", "UI paths"]) {
      expect(pipeline).toContain(held);
    }
  });

  test("owner knobs, memory and restart rules and Persona-decidable floor categories may be suggested", () => {
    for (const rule of ["hold-knob:approve_plan", "memory-owner-words", "forget-owner-words", "restart-shared", "memory-collector-api", "floor:destructive", "floor:unclassified"]) {
      expect(isLoosenableHoldRule(rule)).toBe(true);
    }
    // A retired rule has nothing left to loosen.
    expect(isLoosenableHoldRule("text:outward")).toBe(false);
  });
});

describe("inferHoldRule — attributing older approvals by their reason text", () => {
  const cases: Array<[string, string, string | null]> = [
    ["approve_plan", "the owner holds approve_plan for approval (STANDUP_PERSONA_HOLD)", "hold-knob:approve_plan"],
    ["launch_session", "go (held: the owner holds launch_session for approval (STANDUP_PERSONA_HOLD))", "hold-knob:launch_session"],
    ["answer_ask", "a safety-floor hold of an outward-facing step (outward): only the owner may allow it", "floor:outward"],
    ["answer_ask", "a safety-floor hold (destructive) Persona can't place; the owner decides whether it runs", "floor:destructive"],
    ["answer_ask", "a safety-floor hold Persona can't place; the owner decides whether it runs", "floor:unknown"],
    ["answer_ask", "tool-permission prompts are held for the owner", "permission-prompt"],
    ["answer_ask", "a confirmation gate asks the owner, not Persona", "confirmation-gate"],
    ["restart_standup", "a restart asked for from a thread other people read needs the owner's approval", "restart-shared"],
    ["remember", "a memory saved from a thread other people read needs the owner's approval", "memory-shared-thread"],
    ["forget", "no message from the owner this turn asks Persona to forget this memory", "forget-owner-words"],
    ["update_project_repos", "a project's repos decide where workers launch; only the owner changes them", "project-repos"],
    ["remember", "the memory writes to Standup's HTTP API", "memory-collector-api"],
    ["remember", "the memory changes what agents may do on their own, and no message from the owner this turn asks to remember it in these words", "memory-owner-words"],
    ["launch_session", "daily launch budget reached (20/20)", "budget"],
    ["launch_session", "active launch cap reached (6/6)", "cap"],
    ["approve_plan", "the plan's acceptance criterion isn't a plain build or test command", "criterion"],
    ["send_to_session", "the text writes to Standup's HTTP API; workers must use the standup MCP tools", "text:collector-api"],
    ["send_to_session", 'the text names an outward-facing step ("git push")', "text:outward"],
    ["answer_ask", 'approves a worker\'s request to "git push origin HEAD", an outward-facing step the owner decides on', "text:outward"],
    ["launch_session", "something no rule ever said", null],
  ];
  for (const [action, reason, expected] of cases) {
    test(`${action}: ${reason.slice(0, 60)}`, () => {
      expect(inferHoldRule(action, reason)).toBe(expected);
    });
  }

  test("Persona's own reason before the policy's never decides the rule", () => {
    expect(inferHoldRule("send_to_session", "tell it to deploy via the HTTP API (held: tool-permission prompts are held for the owner)")).toBe(
      "permission-prompt"
    );
  });

  test("no reason, no rule", () => {
    expect(inferHoldRule("remember", undefined)).toBeNull();
    expect(inferHoldRule("remember", "")).toBeNull();
  });
});
