import { useMemo, useState } from "react";
import { LuCheck } from "react-icons/lu";
import { theme } from "./theme";
import type { AskQuestion } from "./AskQuestionView";

function isRecommended(label: string): boolean {
  return /recommended/i.test(label);
}

/** The option indices to pre-select: the recommended one(s), else the first. */
function defaultSelection(q: AskQuestion): number[] {
  const recommended = q.options
    .map((o, i) => (isRecommended(o.label) ? i : -1))
    .filter((i) => i >= 0);
  if (recommended.length > 0) return q.multiSelect ? recommended : [recommended[0]];
  return q.options.length > 0 ? [0] : [];
}

/**
 * The interactive answer for an `AskUserQuestion` the agent is blocked inside,
 * shown inline in the transcript so the human never has to hunt for the
 * question on a raw terminal screenshot. Options are real controls — radios
 * for single-select, checkboxes for multi — pre-set to the recommended choice,
 * and Submit drives them into the modal as keystrokes (see the server's
 * /asks/:id/resolve `selections` path). This replaces the free-text reply box
 * while a modal is pending, because typed text can't answer a menu — it gets
 * swallowed and the agent stays stuck.
 */
export function AskAnswerPanel({
  askId,
  questions,
  owned,
  onResolved,
  inline = false,
}: {
  askId: string;
  questions: AskQuestion[];
  owned: boolean;
  onResolved: () => void;
  /** Rendered inline in the transcript scroll flow (against its tool call)
   * rather than in the fixed bottom slot. Inline, the panel sizes to its
   * content and rides the transcript's own scroll, so it never caps its own
   * height or steals the transcript's — the bottom-slot variant must cap
   * itself to keep its controls on screen. */
  inline?: boolean;
}) {
  const [selections, setSelections] = useState<number[][]>(() =>
    questions.map(defaultSelection)
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Free-text override draft: sent as a fresh instruction instead of a choice.
  const [override, setOverride] = useState("");

  const ready = useMemo(
    () => selections.every((s) => s.length > 0),
    [selections]
  );

  function toggle(qi: number, oi: number) {
    setSelections((prev) => {
      const next = prev.map((s) => [...s]);
      if (questions[qi].multiSelect) {
        const at = next[qi].indexOf(oi);
        if (at >= 0) next[qi].splice(at, 1);
        else next[qi].push(oi);
      } else {
        next[qi] = [oi];
      }
      return next;
    });
  }

  async function submit() {
    if (!ready || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/asks/${askId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selections }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Could not submit (${res.status})`);
      }
      onResolved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  async function sendOverride() {
    const text = override.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/asks/${askId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: text, override: true }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Could not send (${res.status})`);
      }
      onResolved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        // In the bottom slot the panel must cap to the column and scroll its
        // questions internally, or an unbounded panel overflows the fixed-height
        // column and shoves the Submit/override controls off screen. Inline in
        // the transcript there's no fixed column to fight — it flows with the
        // surrounding cards and the transcript's own scroll carries it.
        minHeight: 0,
        ...(inline ? {} : { flexShrink: 1 }),
        margin: inline ? "8px 0 6px" : "10px 20px 16px",
        border: `1px solid ${theme.running}`,
        borderRadius: 8,
        background: theme.raised,
        padding: "12px 14px",
      }}
    >
      <div
        style={{
          flexShrink: 0,
          fontSize: 10.5,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: 0.4,
          color: theme.running,
          marginBottom: 10,
        }}
      >
        Agent is waiting on your answer
      </div>

      <div style={inline ? undefined : { minHeight: 0, overflowY: "auto" }}>
      {questions.map((q, qi) => (
        <div key={qi} style={{ marginBottom: qi < questions.length - 1 ? 16 : 4 }}>
          {q.header && (
            <div
              style={{
                color: theme.faint,
                fontSize: 10.5,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: 0.4,
              }}
            >
              {q.header}
            </div>
          )}
          <div style={{ color: theme.text, fontWeight: 600, margin: "2px 0 8px", wordBreak: "break-word" }}>
            {q.question}
            {q.multiSelect && (
              <span style={{ color: theme.faint, fontWeight: 400 }}> · choose any</span>
            )}
          </div>
          {q.options.map((o, oi) => {
            const chosen = selections[qi]?.includes(oi);
            return (
              <button
                key={oi}
                onClick={() => toggle(qi, oi)}
                disabled={!owned || sending}
                style={{
                  display: "flex",
                  gap: 8,
                  width: "100%",
                  textAlign: "left",
                  alignItems: "flex-start",
                  marginBottom: 6,
                  padding: "7px 9px",
                  borderRadius: 6,
                  border: `1px solid ${chosen ? theme.checkpoint : theme.edge}`,
                  background: chosen ? theme.ground : "transparent",
                  cursor: !owned || sending ? "default" : "pointer",
                }}
              >
                <span style={{ flexShrink: 0, color: chosen ? theme.checkpoint : theme.dim }}>
                  {chosen ? "◉" : q.multiSelect ? "☐" : "○"}
                </span>
                <span style={{ minWidth: 0 }}>
                  <span
                    style={{
                      color: theme.text,
                      fontWeight: chosen ? 700 : 500,
                      wordBreak: "break-word",
                    }}
                  >
                    {o.label}
                  </span>
                  {o.description && (
                    <div
                      style={{
                        color: theme.faint,
                        fontSize: 12,
                        marginTop: 3,
                        lineHeight: 1.45,
                        wordBreak: "break-word",
                      }}
                    >
                      {o.description}
                    </div>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      ))}
      </div>

      {owned ? (
        <div style={{ flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 10 }}>
            <button
              onClick={submit}
              disabled={!ready || sending}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 13,
                fontWeight: 600,
                color: theme.ground,
                background: theme.checkpoint,
                border: "none",
                borderRadius: 6,
                padding: "8px 16px",
                cursor: !ready || sending ? "not-allowed" : "pointer",
                opacity: !ready || sending ? 0.6 : 1,
              }}
            >
              <LuCheck /> {sending ? "Submitting…" : "Submit answer"}
            </button>
            {error && (
              <span style={{ fontSize: 11.5, color: theme.waiting }}>{error}</span>
            )}
          </div>

          {/* Escape hatch: skip the options and redirect the agent. This cancels
              the question in its pane and sends the text as a new instruction. */}
          <div style={{ marginTop: 14, borderTop: `1px solid ${theme.edge}`, paddingTop: 12 }}>
            <div style={{ color: theme.faint, fontSize: 12, marginBottom: 6, lineHeight: 1.45 }}>
              Or override the question — send your own instruction to the agent instead.
            </div>
            <textarea
              value={override}
              disabled={sending}
              rows={2}
              onChange={(e) => setOverride(e.target.value)}
              placeholder="Type an instruction — dismisses the question and sends this instead…"
              style={{
                width: "100%",
                boxSizing: "border-box",
                fontSize: 13,
                lineHeight: 1.5,
                fontFamily: "inherit",
                color: theme.text,
                background: theme.ground,
                border: `1px solid ${theme.edge}`,
                borderRadius: 6,
                padding: "7px 9px",
                outline: "none",
                resize: "vertical",
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
              }}
            />
            <button
              onClick={sendOverride}
              disabled={sending || override.trim().length === 0}
              style={{
                marginTop: 8,
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 13,
                fontWeight: 600,
                color: theme.ground,
                background: theme.running,
                border: "none",
                borderRadius: 6,
                padding: "8px 16px",
                cursor: sending || override.trim().length === 0 ? "not-allowed" : "pointer",
                opacity: sending || override.trim().length === 0 ? 0.6 : 1,
              }}
            >
              {sending ? "Sending…" : "Send response to agent"}
            </button>
          </div>
        </div>
      ) : (
        <div style={{ flexShrink: 0, fontSize: 11.5, color: theme.faint, marginTop: 4 }}>
          This session runs in its own terminal — answer the prompt there.
        </div>
      )}
    </div>
  );
}
