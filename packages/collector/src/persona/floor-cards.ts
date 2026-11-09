import type { Database } from "bun:sqlite";
import type { PersonaApproval, PersonaApprovalStatus } from "@standup/shared";
import { getAsk, getFloorAskState, listPersonaApprovals, transitionPersonaApproval } from "@standup/store";
import { floorAnswerAllows, isFloorGate } from "../floor/gate.js";

/*
 * An answer_ask card on a safety-floor hold decides that hold only while it is
 * pending. Once the hold is settled some other way (answered in the console,
 * timed out, withdrawn), approving or denying the card would report a decision
 * that never happened, so the card is closed with what did.
 */

/** The safety-floor ask an answer_ask card answers, or null for any other card. */
function floorAskOf(db: Database, card: PersonaApproval) {
  if (card.action !== "answer_ask" || typeof card.args.askId !== "string") return null;
  const ask = getAsk(db, card.args.askId);
  return ask && isFloorGate(ask.gate) ? ask : null;
}

/**
 * Whether one of `owner`'s answer_ask cards puts ask `askId` in front of them:
 * one waiting on their decision, or approved and being carried out. The card
 * reaches the owner on its own (console, Slack, push), so the ask's other
 * surfaces leave it to the card.
 */
export function ownerCardHoldsAsk(db: Database, owner: string, askId: string): boolean {
  return ownerCardDecider(db, owner, askId) !== undefined;
}

/**
 * Who decides the card of `owner`'s that holds ask `askId` (ownerCardHoldsAsk):
 * its approver (the host, for a guest's floor allow) or else `owner`. That is
 * whom the card is delivered to. Undefined when no such card holds the ask.
 * A card that would allow the hold wins over one that would deny it: only
 * the allow needs the hold's owner-reserved decider.
 */
export function ownerCardDecider(db: Database, owner: string, askId: string): string | undefined {
  const holding = [...listPersonaApprovals(db, owner, "pending"), ...listPersonaApprovals(db, owner, "approved")].filter(
    (card) => card.action === "answer_ask" && card.args.askId === askId
  );
  const card = holding.find(floorCardDeniesHold) ?? holding[0];
  return card ? card.approver || card.owner : undefined;
}

/** Whether denying `card` denies the hold it answers: only a card that would allow it ("Allow once"). */
export function floorCardDeniesHold(card: PersonaApproval): boolean {
  return card.action === "answer_ask" && floorAnswerAllows(typeof card.args.answer === "string" ? card.args.answer : "");
}

/**
 * How `card` ends when the safety-floor hold it answers is no longer pending,
 * or null while it is (or the card answers no floor hold).
 */
export function settledFloorCard(db: Database, card: PersonaApproval): { status: PersonaApprovalStatus; result: string } | null {
  const ask = floorAskOf(db, card);
  if (!ask || ask.status === "pending") return null;
  if (ask.status === "timeout") {
    return { status: "expired", result: "The safety-floor hold timed out before it was decided, so the call was denied." };
  }
  if (ask.status === "cancelled") {
    return { status: "superseded", result: "The safety-floor hold was withdrawn before it was decided, so the call didn't run." };
  }
  const by = ask.answeredBy ? ` by ${ask.answeredBy.startsWith("persona:") ? "Persona" : ask.answeredBy}` : "";
  if (!floorAnswerAllows(ask.answer)) {
    return { status: "superseded", result: `The safety-floor hold was already denied${by}, so the call didn't run.` };
  }
  return { status: "superseded", result: `The safety-floor hold was already allowed${by}${allowedOutcome(db, ask.id)}` };
}

/**
 * What became of an allowed hold's call. Undelivered, the allow waits on the
 * worker: its hook may have given up waiting, so the call runs only when the
 * worker makes it again.
 */
function allowedOutcome(db: Database, askId: string): string {
  return getFloorAskState(db, askId)?.deliveredAt
    ? ", and the call ran."
    : "; the call runs only if its worker makes it (or retries it) and picks the allow up.";
}

/**
 * How an answer_ask card left `approved` by a collector restart ends, read
 * from its safety-floor hold, or null when it answers no floor hold. A hold
 * still pending is left to Persona, which decides it afresh.
 */
export function interruptedFloorCard(
  db: Database,
  card: PersonaApproval
): { status: PersonaApprovalStatus; result: string } | null {
  const ask = floorAskOf(db, card);
  if (!ask) return null;
  if (ask.status === "pending") {
    return {
      status: "failed",
      result: "A collector restart interrupted this approval before it reached the safety-floor hold, which is still waiting.",
    };
  }
  // The hold was decided the way the card decides it: the card's answer landed.
  if (ask.status === "answered" && floorAnswerAllows(ask.answer) === floorCardDeniesHold(card)) {
    return {
      status: "executed",
      result: floorCardDeniesHold(card)
        ? `The safety-floor hold was allowed${allowedOutcome(db, ask.id)}`
        : "The safety-floor hold was denied, so the call didn't run.",
    };
  }
  return settledFloorCard(db, card);
}

/**
 * Settles `owner`'s answer_ask cards a collector restart left `approved`
 * against their safety-floor holds (see interruptedFloorCard) and returns the
 * settled cards. Other approved cards are left for
 * failInterruptedPersonaApprovals.
 */
export function settleInterruptedFloorCards(db: Database, owner: string): PersonaApproval[] {
  const out: PersonaApproval[] = [];
  for (const card of listPersonaApprovals(db, owner, "approved")) {
    const outcome = interruptedFloorCard(db, card);
    if (!outcome) continue;
    const settled = transitionPersonaApproval(db, card.id, "approved", outcome.status, { result: outcome.result });
    if (settled) out.push(settled);
  }
  return out;
}

/** Closes `card` with settledFloorCard's outcome; the closed card, or null when it still decides its hold. */
export function closeSettledFloorCard(db: Database, card: PersonaApproval): PersonaApproval | null {
  const settled = settledFloorCard(db, card);
  if (!settled) return null;
  return transitionPersonaApproval(db, card.id, "pending", settled.status, { result: settled.result });
}
