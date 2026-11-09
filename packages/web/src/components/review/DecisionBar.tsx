import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { ReviewDecision } from "@standup/shared";
import { alpha, theme } from "../theme";

type Result = Promise<{ error?: string }>;

/** The question a follow-up joins: its id and the words it opens with. */
export interface FollowUpTarget {
  id: string;
  excerpt: string;
}

export interface DecisionBarProps {
  onDecide: (decision: ReviewDecision, comment: string) => Result;
  /** Asks the worker the text as a question; the packet stays pending. */
  onAsk?: (question: string, replyTo?: string) => Result;
  /** The thread an Ask joins as a follow-up; a new question when absent. */
  followUp?: FollowUpTarget | null;
  onClearFollowUp?: () => void;
  narrow?: boolean;
}

/**
 * The ask / approve / request-changes controls, pinned to the bottom of the
 * detail pane while the packet awaits a decision. Asking sends the text to the
 * worker as a question and keeps the packet open; requesting changes needs a
 * comment saying what to change; approving takes an optional one.
 */
export function DecisionBar({ onDecide, onAsk, followUp, onClearFollowUp, narrow = false }: DecisionBarProps) {
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState<ReviewDecision | "ask" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Counts questions asked here, so the box takes the cursor back once it is enabled again.
  const [asked, setAsked] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const hasComment = comment.trim().length > 0;

  // Choosing a thread to follow up on, or asking, puts the cursor in the box.
  useEffect(() => {
    if (followUp || asked > 0) input.current?.focus();
  }, [followUp?.id, asked]);

  const submit = async (what: ReviewDecision | "ask", run: (text: string) => Result) => {
    if (submitting) return;
    setSubmitting(what);
    setError(null);
    try {
      const result = await run(comment.trim());
      if (result.error) setError(result.error);
      else {
        setComment("");
        if (what === "ask") {
          onClearFollowUp?.();
          setAsked((n) => n + 1);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(null);
    }
  };
  const decide = (decision: ReviewDecision) => submit(decision, (text) => onDecide(decision, text));

  const button = (color: string, solid: boolean): CSSProperties => ({
    minHeight: 44,
    padding: narrow ? "0 10px" : "0 18px",
    borderRadius: 7,
    fontSize: narrow ? 15 : 14,
    fontWeight: 700,
    cursor: "pointer",
    width: narrow ? "100%" : undefined,
    border: `1px solid ${color}`,
    background: solid ? color : "transparent",
    color: solid ? theme.ground : color,
  });
  // Asking and requesting changes both need words in the box.
  const textDisabled = !hasComment || submitting !== null;

  return (
    <div
      data-testid="decision-bar"
      style={{
        position: "sticky",
        bottom: 0,
        zIndex: 5,
        background: theme.surface,
        borderTop: `1px solid ${theme.edge}`,
        boxShadow: `0 -6px 18px ${alpha(theme.shadow, 0.35)}`,
        padding: narrow ? "10px 12px calc(10px + env(safe-area-inset-bottom))" : "12px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {onAsk && followUp && (
        <div
          data-testid="follow-up-target"
          style={{ display: "flex", alignItems: "center", gap: 8, fontSize: narrow ? 14 : 12.5, color: theme.dim, minWidth: 0 }}
        >
          <span style={{ color: theme.expert, fontWeight: 600, flexShrink: 0 }}>Following up on</span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>“{followUp.excerpt}”</span>
          <button
            type="button"
            aria-label="Ask a new question instead"
            onClick={onClearFollowUp}
            style={{
              border: "none",
              background: "transparent",
              color: theme.dim,
              cursor: "pointer",
              fontSize: 16,
              padding: "0 4px",
              minHeight: narrow ? 44 : 28,
              minWidth: narrow ? 44 : 28,
              flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>
      )}
      <textarea
        ref={input}
        aria-label="Review comment"
        placeholder={onAsk ? "Ask a question, or comment on your decision (required to request changes)" : "Comment (required to request changes)"}
        value={comment}
        disabled={submitting !== null}
        onChange={(e) => setComment(e.target.value)}
        rows={2}
        style={{
          width: "100%",
          boxSizing: "border-box",
          resize: "vertical",
          minHeight: 44,
          padding: "9px 10px",
          borderRadius: 6,
          border: `1px solid ${theme.edge}`,
          background: theme.ground,
          color: theme.text,
          fontFamily: theme.sans,
          fontSize: narrow ? 16 : 14,
        }}
      />
      {error && (
        <div role="alert" style={{ color: theme.waiting, fontSize: narrow ? 14 : 13 }}>
          {error}
        </div>
      )}
      {/* On a phone, Ask and Request changes share a row above a full-width Approve. */}
      <div
        style={
          narrow
            ? { display: "grid", gridTemplateColumns: onAsk ? "1fr 1fr" : "1fr", gap: 8 }
            : { display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 }
        }
      >
        {onAsk && (
          <span style={{ marginRight: narrow ? undefined : "auto", gridColumn: "1 / -1", fontSize: narrow ? 13 : 12, color: theme.dim }}>
            Ask keeps the review open; the worker replies here without changing code.
          </span>
        )}
        {onAsk && (
          <button
            type="button"
            disabled={textDisabled}
            title={hasComment ? undefined : "Type the question to ask"}
            onClick={() => void submit("ask", (text) => onAsk(text, followUp?.id))}
            style={{ ...button(theme.expert, false), opacity: textDisabled ? 0.45 : 1 }}
          >
            {submitting === "ask" ? "Asking…" : "Ask"}
          </button>
        )}
        <button
          type="button"
          disabled={textDisabled}
          title={hasComment ? undefined : "Add a comment saying what to change"}
          onClick={() => void decide("changes_requested")}
          style={{ ...button(theme.stalled, false), opacity: textDisabled ? 0.45 : 1 }}
        >
          {submitting === "changes_requested" ? "Requesting…" : "Request changes"}
        </button>
        <button
          type="button"
          disabled={submitting !== null}
          onClick={() => void decide("approved")}
          style={{ ...button(theme.done, true), gridColumn: "1 / -1", opacity: submitting !== null ? 0.6 : 1 }}
        >
          {submitting === "approved" ? "Approving…" : "Approve"}
        </button>
      </div>
    </div>
  );
}
