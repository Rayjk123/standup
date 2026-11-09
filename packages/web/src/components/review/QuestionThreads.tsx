import type { ReviewComment } from "@standup/shared";
import { alpha, theme } from "../theme";
import { Badge } from "./StatusBadge";
import type { FollowUpTarget } from "./DecisionBar";
import { relativeAge, shortSessionId } from "./format";

/** One question thread: the opening question, then its follow-ups and answers in order. */
export interface QuestionThread {
  opening: ReviewComment;
  replies: ReviewComment[];
}

/** The packet's questions and answers grouped into threads, oldest first. */
export function questionThreads(comments: readonly ReviewComment[]): QuestionThread[] {
  const threads: QuestionThread[] = [];
  const byId = new Map<string, QuestionThread>();
  // A follow-up names its thread's opening question; an answer, the question it answers.
  for (const c of comments) {
    if (c.kind === "comment") continue;
    const thread = c.replyTo ? byId.get(c.replyTo) : undefined;
    if (thread) {
      thread.replies.push(c);
      if (c.kind === "question") byId.set(c.id, thread);
    } else if (c.kind === "question" && c.replyTo === null) {
      const opened = { opening: c, replies: [] };
      threads.push(opened);
      byId.set(c.id, opened);
    }
  }
  return threads;
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;

/** Who wrote a row, as the thread names them. */
function authorOf(c: ReviewComment): { name: string; session?: string } {
  if (c.kind !== "answer") return { name: c.author };
  if (c.via === "persona") return { name: "Persona" };
  return { name: "Worker", ...(SESSION_ID.test(c.author) ? { session: shortSessionId(c.author) } : {}) };
}

const WAITING_TEXT: Record<string, string> = {
  worker: "Sent to the worker — waiting for its answer. The review stays pending.",
  persona: "The worker can't take it, so Persona is answering from its transcript. The review stays pending.",
  none: "The worker can't take it and Persona isn't running, so nobody can answer this yet. The review stays pending.",
};
const UNANSWERED_TEXT = "Not answered before the review was decided.";

/** A question's opening words for the follow-up banner, cut at a word with an ellipsis. */
function excerptOf(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 79).replace(/\s+\S*$/, "")}…` : flat;
}

function Row({ comment, now, narrow, opening }: { comment: ReviewComment; now?: Date; narrow: boolean; opening: boolean }) {
  const who = authorOf(comment);
  return (
    <div
      data-testid={comment.kind === "answer" ? "review-answer" : "review-question"}
      style={
        opening
          ? { padding: "12px 14px" }
          : {
              margin: "0 14px 12px 28px",
              padding: "10px 12px",
              borderLeft: `2px solid ${comment.kind === "answer" ? theme.expert : theme.edge}`,
              background: theme.ground,
              borderRadius: "0 6px 6px 0",
            }
      }
    >
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, fontSize: narrow ? 14 : 12.5, color: theme.dim }}>
        <span style={{ color: theme.text, fontWeight: 600 }}>{who.name}</span>
        {who.session && <span style={{ fontFamily: theme.mono, color: theme.faint }}>{who.session}</span>}
        {opening && <Badge text="Ask" color={theme.expert} />}
        <span title={comment.createdAt}>{relativeAge(comment.createdAt, now)}</span>
      </div>
      <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.5, overflowWrap: "anywhere", marginTop: 6 }}>{comment.body}</div>
    </div>
  );
}

/**
 * The owner's questions on a packet, each with its answers threaded beneath
 * like code-review comments. While the packet is `pending`, a thread whose
 * last word is a question shows who it went to and that its answer is awaited;
 * `onFollowUp` lets the owner ask on in a thread.
 */
export function QuestionThreads({
  threads,
  pending,
  now,
  narrow,
  onFollowUp,
}: {
  threads: QuestionThread[];
  pending: boolean;
  now?: Date;
  narrow: boolean;
  onFollowUp?: (target: FollowUpTarget) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {threads.map(({ opening, replies }) => {
        // A question is answered once an answer names it, the rule the list's count uses.
        const answered = new Set(replies.filter((r) => r.kind === "answer").map((r) => r.replyTo));
        const last = [opening, ...replies].filter((r) => r.kind === "question" && !answered.has(r.id)).pop();
        const waiting = !!last;
        const pulse = pending && last?.via !== "none";
        return (
          <div
            key={opening.id}
            data-testid="review-thread"
            data-thread={opening.id}
            style={{ border: `1px solid ${theme.edge}`, borderRadius: 8, background: theme.surface, overflow: "hidden" }}
          >
            <Row comment={opening} now={now} narrow={narrow} opening />
            {replies.map((r) => (
              <Row key={r.id} comment={r} now={now} narrow={narrow} opening={false} />
            ))}
            {last && (
              <div
                data-testid="review-thread-waiting"
                role="status"
                style={{
                  margin: "0 14px 12px 28px",
                  padding: "10px 12px",
                  borderLeft: `2px solid ${theme.faint}`,
                  background: theme.ground,
                  borderRadius: "0 6px 6px 0",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  color: theme.dim,
                  fontSize: narrow ? 14 : 13,
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    flexShrink: 0,
                    background: pulse ? theme.expert : theme.faint,
                    boxShadow: pulse ? `0 0 0 4px ${alpha(theme.expert, 0x2a)}` : undefined,
                    // The console's skeleton pulse, which holds still under prefers-reduced-motion.
                    animation: pulse ? "standup-pulse 1.8s ease-in-out infinite" : undefined,
                  }}
                />
                <span>{pending ? WAITING_TEXT[last.via ?? "worker"] : UNANSWERED_TEXT}</span>
              </div>
            )}
            {onFollowUp && !waiting && (
              <div style={{ padding: "0 14px 10px 28px" }}>
                <button
                  type="button"
                  aria-label={`Follow up on “${excerptOf(opening.body)}”`}
                  onClick={() => onFollowUp({ id: opening.id, excerpt: excerptOf(opening.body) })}
                  style={{
                    border: "none",
                    background: "transparent",
                    color: theme.expert,
                    cursor: "pointer",
                    fontSize: narrow ? 14 : 12.5,
                    fontWeight: 600,
                    padding: "4px 0",
                    minHeight: narrow ? 44 : 28,
                  }}
                >
                  Follow up
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
