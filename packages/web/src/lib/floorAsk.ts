import type { Ask } from "@standup/shared";

/** The gates the safety floor raises its holds under (collector floor/gate.ts). */
const FLOOR_GATES: ReadonlySet<string> = new Set(["safety_floor", "safety_floor_owner"]);

/** The answers the collector reads as allowing and denying a floor hold (FLOOR_OPTIONS). */
export const FLOOR_ALLOW_ANSWER = "Allow once";
export const FLOOR_DENY_ANSWER = "Deny";

/** The collector's opening of a floor hold's question, then the high-risk label it writes right after it. */
const FLOOR_QUESTION_HEAD = /^Safety floor held a \S+ call \([a-z-]+\): /;
const HIGH_RISK_LABEL = "HIGH RISK — ";

/** Whether `ask` is a safety-floor hold. */
export function isFloorAsk(ask: Pick<Ask, "gate">): boolean {
  return !!ask.gate && FLOOR_GATES.has(ask.gate);
}

/** Whether a floor hold's question carries the collector's high-risk label right after its opening. */
export function isHighRiskFloorAsk(ask: Pick<Ask, "gate" | "question">): boolean {
  if (!isFloorAsk(ask)) return false;
  const head = FLOOR_QUESTION_HEAD.exec(ask.question);
  return !!head && ask.question.startsWith(HIGH_RISK_LABEL, head[0].length);
}

/**
 * The answers a pending safety-floor hold's card offers the owner: Allow once
 * and Deny, on every floor gate and high-risk holds included, whatever the
 * stored options say. Any other answer to a floor hold denies the call, so a
 * free-text reply or an emoji reaction is no way to allow one. Empty for an
 * ask that isn't a pending floor hold.
 */
export function floorAskAnswers(ask: Pick<Ask, "gate" | "status">): string[] {
  if (!isFloorAsk(ask) || ask.status !== "pending") return [];
  return [FLOOR_ALLOW_ANSWER, FLOOR_DENY_ANSWER];
}
