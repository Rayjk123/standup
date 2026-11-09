import type { Database } from "bun:sqlite";
import type { PersonaApproval, PersonaAudience, PersonaMessage, PersonaReplyTo } from "@standup/shared";
import {
  getPersonaThread,
  personaMessageBefore,
  personaOptionReplyRecorded,
  personaOwnerActiveNear,
  personaTappedQuestion,
  recordPersonaSignal,
} from "@standup/store";
import type { PersonaSignal } from "@standup/store";

/*
 * Capture of owner-behaviour signals for the preference miner
 * (docs/design/persona-preference-miner.md §1). Every capture here runs at an
 * owner-authenticated entry point (the owner's message route, the approval
 * routes), so its actor is the owner; nothing a worker or Persona writes is
 * read as one. A capture failure is logged and never fails the owner's call.
 */

/** A free-text reply this soon after an options question counts as answering it off-menu. */
export const OFF_MENU_WINDOW_MS = 10 * 60_000;

/** An owner message or decision this close to a hold means the owner was active when it was raised. */
export const OWNER_ACTIVE_WINDOW_MS = 5 * 60_000;

function audienceOf(db: Database, threadId: string): PersonaAudience {
  return getPersonaThread(db, threadId)?.audience ?? "private";
}

/**
 * Records which option of an `ask_user` question the owner's message chose.
 * With `replyTo` (a quick-reply tap), the question must be a Persona message
 * with options in the same thread and the index one of its options; anything
 * else is read as a free-text reply. A free-text reply within
 * OFF_MENU_WINDOW_MS of the thread's latest Persona message, when that
 * message offered options nobody has answered yet, is recorded as off-menu.
 * Returns the signal, or null when the message answers no options question.
 */
export function captureOptionReply(
  db: Database,
  owner: string,
  reply: PersonaMessage,
  replyTo: PersonaReplyTo | undefined,
  now: Date
): PersonaSignal | null {
  try {
    const record = (question: PersonaMessage, optionIndex: number | null) => {
      const recommended = question.recommendedOption;
      return recordPersonaSignal(db, {
        owner,
        kind: "option_reply",
        actor: "owner",
        subject: "ask_user",
        value: {
          optionIndex,
          optionCount: question.options?.length ?? 0,
          ...(recommended !== undefined ? { recommended } : {}),
          ...(recommended !== undefined && optionIndex !== null ? { followedRecommendation: optionIndex === recommended } : {}),
          offMenu: optionIndex === null,
          replyMessageId: reply.id,
        },
        threadId: reply.threadId,
        jobId: question.jobIds?.[0],
        messageId: question.id,
        audience: audienceOf(db, reply.threadId),
        occurredAt: reply.createdAt,
      });
    };

    const tapped = personaTappedQuestion(db, reply.threadId, replyTo);
    if (tapped && replyTo && !personaOptionReplyRecorded(db, owner, tapped.id)) {
      return record(tapped, replyTo.optionIndex);
    }

    const question = personaMessageBefore(db, reply.threadId, reply.seq);
    if (!question?.options) return null;
    const age = now.getTime() - Date.parse(question.createdAt);
    if (!(age >= 0 && age <= OFF_MENU_WINDOW_MS)) return null;
    if (personaOptionReplyRecorded(db, owner, question.id)) return null;
    return record(question, null);
  } catch (err) {
    console.error("[persona] couldn't record option reply signal:", err);
    return null;
  }
}

/**
 * Records the owner's decision on a held action: the rule it was held under,
 * approved or denied, how long it took, and whether the owner was active
 * around the time it was raised. `approval` is the row after the decision.
 */
export function captureApprovalDecision(
  db: Database,
  approval: PersonaApproval,
  outcome: "approved" | "denied"
): PersonaSignal | null {
  try {
    const decidedAt = approval.decidedAt ?? new Date().toISOString();
    const decideMs = Date.parse(decidedAt) - Date.parse(approval.createdAt);
    return recordPersonaSignal(db, {
      owner: approval.owner,
      kind: "approval",
      actor: "owner",
      subject: approval.holdRule ?? approval.action,
      value: {
        action: approval.action,
        outcome,
        ...(approval.holdRule ? { holdRule: approval.holdRule } : {}),
        ...(Number.isFinite(decideMs) && decideMs >= 0 ? { decideMs } : {}),
        ownerActive: personaOwnerActiveNear(db, approval.owner, approval.createdAt, OWNER_ACTIVE_WINDOW_MS, approval.id),
      },
      threadId: approval.threadId,
      jobId: approval.jobId,
      approvalId: approval.id,
      audience: approval.threadId ? audienceOf(db, approval.threadId) : "private",
      occurredAt: decidedAt,
    });
  } catch (err) {
    console.error("[persona] couldn't record approval signal:", err);
    return null;
  }
}
