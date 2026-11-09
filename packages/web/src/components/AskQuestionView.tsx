import { theme } from "./theme";

export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
  /** Chosen option label(s) once answered; undefined while pending. */
  answer?: string;
}

function isChosen(answer: string | undefined, label: string): boolean {
  if (!answer) return false;
  return answer === label || answer.split(/,\s*/).includes(label);
}

/**
 * Renders an AskUserQuestion prompt — the question, its options, and any
 * chosen answer — the way Claude Code's own TUI surfaces it, instead of a raw
 * JSON dump. Shared by the card and terminal transcript views; `mono` matches
 * the surrounding terminal styling.
 */
export function AskQuestionView({
  questions,
  mono,
  hideStatus,
}: {
  questions: AskQuestion[];
  mono?: boolean;
  /** Suppress the ✓/awaiting line when the caller shows the answer separately. */
  hideStatus?: boolean;
}) {
  return (
    <div style={{ fontFamily: mono ? theme.mono : undefined, fontSize: mono ? 12 : 13 }}>
      {questions.map((q, qi) => (
        <div key={qi} style={{ marginBottom: qi < questions.length - 1 ? 14 : 0 }}>
          {q.header && (
            <div
              style={{
                color: theme.running,
                fontSize: 10.5,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: 0.4,
              }}
            >
              {q.header}
            </div>
          )}
          <div style={{ color: theme.text, fontWeight: 600, margin: "2px 0 7px", wordBreak: "break-word" }}>
            {q.question}
          </div>
          {q.options.map((o, oi) => {
            const chosen = isChosen(q.answer, o.label);
            return (
              <div key={oi} style={{ marginBottom: 5 }}>
                <div style={{ display: "flex", gap: 7, color: chosen ? theme.checkpoint : theme.dim }}>
                  <span style={{ flexShrink: 0 }}>
                    {chosen ? "◉" : q.multiSelect ? "☐" : "○"}
                  </span>
                  <span style={{ fontWeight: chosen ? 700 : 400, wordBreak: "break-word" }}>
                    {o.label}
                  </span>
                </div>
                {o.description && (
                  <div
                    style={{
                      color: theme.faint,
                      fontSize: mono ? 11 : 12,
                      paddingLeft: 20,
                      lineHeight: 1.45,
                      wordBreak: "break-word",
                    }}
                  >
                    {o.description}
                  </div>
                )}
              </div>
            );
          })}
          {!hideStatus && (
            <div
              style={{
                marginTop: 5,
                color: q.answer ? theme.checkpoint : theme.faint,
                fontStyle: q.answer ? undefined : "italic",
              }}
            >
              {q.answer ? `✓ ${q.answer}` : `awaiting answer${q.multiSelect ? " · multiple allowed" : ""}`}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
