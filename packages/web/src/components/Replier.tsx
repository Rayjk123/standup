import { useState } from "react";
import { LuCheck } from "react-icons/lu";
import { theme } from "./theme";

interface ReplierProps {
  /** Predefined answers. */
  options?: string[];
  /** What the human already sent, if anything. Renders the resolved state. */
  reply?: string;
  onReply: (body: string) => Promise<void> | void;
}

/**
 * The answer to an ask: resolves the tool call the agent is blocked inside,
 * so it lands now. One button per option, or a free-text box when the ask
 * offers none.
 */
export function Replier({ options, reply, onReply }: ReplierProps) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(body: string) {
    if (!body.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      await onReply(body);
      setDraft("");
    } catch (err) {
      // Keep the draft so a failed send doesn't lose what was typed.
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  const errorNode = error ? (
    <div
      style={{
        fontFamily: theme.mono,
        fontSize: 11,
        color: theme.waiting,
        marginTop: 6,
        lineHeight: 1.5,
      }}
    >
      {error}
    </div>
  ) : null;

  if (reply) {
    return (
      <div
        style={{
          marginTop: 9,
          paddingLeft: 11,
          borderLeft: `2px solid ${theme.checkpoint}`,
        }}
      >
        <div style={{ fontSize: 13.5, color: theme.text }}>
          <span style={{ fontWeight: 700, color: theme.dim }}>you </span>
          {reply}
        </div>
        <div
          style={{
            fontFamily: theme.mono,
            fontSize: 10,
            marginTop: 4,
            color: theme.checkpoint,
            display: "flex",
            alignItems: "center",
            gap: 5,
          }}
        >
          <LuCheck /> delivered · agent unblocked
        </div>
      </div>
    );
  }

  // Not every ask carries options. `ask_human` may omit them, and asks
  // raised from a Notification hook never have them — the hook reports
  // that the agent is waiting, not what it's waiting on. Rendering only
  // buttons left those asks with no way to answer at all.
  if (!options || options.length === 0) {
    return (
      <div style={{ marginTop: 11 }}>
        <textarea
          value={draft}
          disabled={sending}
          rows={1}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(draft);
            }
          }}
          placeholder="Type your answer and press Enter…"
          style={{
            width: "100%",
            fontSize: 13,
            fontFamily: "inherit",
            color: theme.text,
            background: theme.ground,
            border: `1px solid ${theme.edge}`,
            borderRadius: 6,
            padding: "8px 11px",
            outline: "none",
            resize: "vertical",
          }}
        />
        <div style={{ fontSize: 11.5, color: theme.faint, marginTop: 5 }}>
          Sent straight to the agent. For a menu prompt, the option number
          (e.g. <code>2</code>) is what it expects. A question with several
          parts needs one answer per line — Shift+Enter for a new line,
          Enter to send.
        </div>
        {errorNode}
      </div>
    );
  }

  return (
    <div style={{ marginTop: 11 }}>
      <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
        {options.map((opt) => (
          <button
            key={opt}
            onClick={() => send(opt)}
            disabled={sending}
            style={{
              fontSize: 12.5,
              fontWeight: 500,
              color: theme.text,
              background: theme.raised,
              border: `1px solid ${theme.edge}`,
              borderRadius: 5,
              padding: "7px 13px",
              cursor: sending ? "not-allowed" : "pointer",
              opacity: sending ? 0.6 : 1,
            }}
          >
            {opt}
          </button>
        ))}
      </div>
      {errorNode}
    </div>
  );
}
