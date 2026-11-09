import { describe, expect, test } from "bun:test";
import type { Ask } from "@standup/shared";
import { FLOOR_ALLOW_ANSWER, FLOOR_DENY_ANSWER, floorAskAnswers, isFloorAsk, isHighRiskFloorAsk } from "./floorAsk";

const HIGH_RISK_QUESTION =
  "Safety floor held a Bash call (floor-tamper): HIGH RISK — it reaches Standup's or the owner's secrets, Standup's database, another process's memory, or the floor hook or install, and one allowed call there can outlast the allow: starts a Standup collector\n\nenv -i HOME=/tmp/r/home bun run packages/collector/src/index.ts";

function ask(over: Partial<Ask> = {}): Pick<Ask, "gate" | "status" | "question"> {
  return { gate: "safety_floor_owner", status: "pending", question: HIGH_RISK_QUESTION, ...over };
}

describe("floor hold answers", () => {
  test("a pending high-risk owner-gate hold offers Allow once and Deny", () => {
    expect(isHighRiskFloorAsk(ask())).toBe(true);
    expect(floorAskAnswers(ask())).toEqual([FLOOR_ALLOW_ANSWER, FLOOR_DENY_ANSWER]);
  });

  test("every pending floor hold offers both, on either gate", () => {
    const plain = "Safety floor held a Bash call (outward): pushes to a remote\n\ngit push origin HEAD";
    for (const gate of ["safety_floor", "safety_floor_owner"]) {
      expect(floorAskAnswers(ask({ gate, question: plain }))).toEqual(["Allow once", "Deny"]);
      expect(isHighRiskFloorAsk(ask({ gate, question: plain }))).toBe(false);
    }
  });

  test("an answered floor hold and any other ask offer none", () => {
    expect(floorAskAnswers(ask({ status: "answered" }))).toEqual([]);
    expect(floorAskAnswers(ask({ gate: undefined }))).toEqual([]);
    expect(floorAskAnswers(ask({ gate: "standup_improvement" }))).toEqual([]);
    expect(isFloorAsk({ gate: "idle_notice" })).toBe(false);
  });

  test("the high-risk label counts only right after the hold's opening", () => {
    expect(isHighRiskFloorAsk(ask({ question: `Safety floor held a Bash call (outward): echo "HIGH RISK — x"` }))).toBe(false);
    expect(isHighRiskFloorAsk(ask({ gate: "confirm" }))).toBe(false);
  });
});
