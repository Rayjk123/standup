import { useState } from "react";
import { theme } from "./theme";

export type ReplyTarget = "ask" | "checkpoint";

interface ReplierProps {
  target: ReplyTarget;
  /** Predefined answers — asks only. */
  options?: string[];
  /** What the human already sent, if anything. Renders the resolved state. */
  reply?: string;
  onReply: (body: string) => Promise<void> | void;
}

/**
 * The two reply paths, which look similar but mean opposite things — this
 * distinction is load-bearing (see Component 5 of the design):
 *
 *   ask        → resolves a tool call the agent is blocked inside. Lands now.
 *   checkpoint → unsolicited redirect. Queues, delivers at a turn boundary,
 *                never mid-turn.
 *
 * The copy has to make that difference obvious, or you'd assume a steer
 * landed immediately and wonder why the agent ignored it.
 */
export function Replier({ target, options, reply, onReply }: ReplierProps) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);

  async function send(body: string) {
    if (!body.trim() || sending) return;
    setSending(true);
    try {
      await onReply(body);
      setDraft("");
      setOpen(false);
    } finally {
      setSending(false);
    }
  }

  if (reply) {
    const isAsk = target === "ask";
    return (
      <div
        style={{
          marginTop: 9,
          paddingLeft: 11,
          borderLeft: `2px solid ${isAsk ? theme.checkpoint : theme.stalled}`,
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
            color: isAsk ? theme.checkpoint : theme.stalled,
          }}
        >
          {isAsk
            ? "✓ delivered · agent unblocked"
            : "⧖ queued · delivers at the next turn boundary"}
        </div>
      </div>
    );
  }

  if (target === "ask") {
    return (
      <div style={{ display: "flex", gap: 7, marginTop: 11, flexWrap: "wrap" }}>
        {(options ?? []).map((opt) => (
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
    );
  }

  return (
    <div style={{ marginTop: 6 }}>
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          style={{
            background: "none",
            border: "none",
            padding: 0,
            cursor: "pointer",
            fontSize: 12.5,
            color: theme.faint,
          }}
        >
          ↩ steer
        </button>
      ) : (
        <input
          autoFocus
          value={draft}
          disabled={sending}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void send(draft);
            if (e.key === "Escape") {
              setOpen(false);
              setDraft("");
            }
          }}
          placeholder="Delivers at the next turn boundary, not mid-turn…"
          style={{
            width: "100%",
            fontSize: 13,
            color: theme.text,
            background: theme.ground,
            border: `1px solid ${theme.edge}`,
            borderRadius: 6,
            padding: "8px 11px",
            outline: "none",
          }}
        />
      )}
    </div>
  );
}
