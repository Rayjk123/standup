import type { Database } from "bun:sqlite";
import type { SessionMessage } from "@standup/shared";
import { claimPendingMessages } from "@standup/store";

/**
 * The label a delivered message is attributed to — the sender's human-readable
 * title when it carried one, else a short form of its session id, else a
 * generic "a teammate agent" when the sender is unknown. Keeps the recipient
 * reading who it is coordinating with rather than an anonymous instruction.
 */
function senderLabel(message: SessionMessage): string {
  if (message.fromLabel?.trim()) return message.fromLabel.trim();
  if (message.fromSessionId) return `session ${message.fromSessionId.slice(0, 8)}`;
  return "a teammate agent";
}

/**
 * Full attribution for a delivered message: the human label plus the sender's
 * exact session id when it registered one, e.g. "Session A (session id sess-a)".
 * The exact id is what makes a reply possible — message_session.to_session does
 * an exact-id match, so a title or an 8-char prefix alone cannot address one
 * back. The id clause is dropped for an unattributed (headless/external) sender
 * that carries no session row.
 */
function senderAttribution(message: SessionMessage): string {
  const label = senderLabel(message);
  const id = message.fromSessionId?.trim();
  return id ? `${label} (session id ${id})` : label;
}

/**
 * Renders claimed mailbox messages as context text for the recipient agent.
 * Framed as coming from a teammate agent (not the human) and attributed to the
 * sender — including the sender's exact session id and how to reply — so the
 * agent treats it as real cross-session coordination it can act on and answer,
 * rather than ambient background it can ignore. The agent-to-agent counterpart
 * to formatSteers.
 */
export function formatSessionMessages(messages: SessionMessage[]): string {
  if (messages.length === 1) {
    const m = messages[0];
    const replyId = m.fromSessionId?.trim();
    const reply = replyId
      ? `\n\nTo reply, call message_session with to_session "${replyId}".`
      : "";
    return (
      `[Message from ${senderAttribution(m)}, sent via the Standup console]\n` +
      `${m.body}` +
      reply
    );
  }

  const numbered = messages
    .map((m, i) => `${i + 1}. (from ${senderAttribution(m)}) ${m.body}`)
    .join("\n");
  const reply = messages.some((m) => m.fromSessionId?.trim())
    ? `\n\nTo reply to any of these, call message_session with the sender's session id shown above.`
    : "";
  return (
    `[${messages.length} messages from teammate agents, sent via the Standup console]\n` +
    numbered +
    reply
  );
}

/**
 * Claims and formats a session's mailbox in one step. Returns null when the
 * mailbox is empty, so callers can skip adding an empty context block. Mirrors
 * takeSteerContext, and is drained at the same turn-boundary injection points
 * (UserPromptSubmit hook, checkpoint call) so a message reaches the target on
 * its next turn.
 */
export function takeMailboxContext(
  db: Database,
  sessionId: string
): { text: string; messages: SessionMessage[] } | null {
  const messages = claimPendingMessages(db, sessionId);
  if (messages.length === 0) return null;
  return { text: formatSessionMessages(messages), messages };
}
