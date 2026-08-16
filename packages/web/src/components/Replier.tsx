import { useState } from "react";

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
      <div className={`mt-2.5 border-l-2 pl-[11px] ${isAsk ? "border-checkpoint" : "border-stalled"}`}>
        <div className="text-[13.5px] text-text">
          <span className="font-bold text-dim">you </span>
          {reply}
        </div>
        <div className={`mt-1 font-mono text-[10px] ${isAsk ? "text-checkpoint" : "text-stalled"}`}>
          {isAsk
            ? "✓ delivered · agent unblocked"
            : "⧖ queued · delivers at the next turn boundary"}
        </div>
      </div>
    );
  }

  if (target === "ask") {
    // Not every ask carries options. `ask_human` may omit them, and asks
    // raised from a Notification hook never have them — the hook reports
    // that the agent is waiting, not what it's waiting on. Rendering only
    // buttons left those asks with no way to answer at all.
    if (!options || options.length === 0) {
      return (
        <div className="mt-[11px]">
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
            className="w-full resize-y rounded-md border border-edge bg-ground px-2.5 py-2 text-sm text-text outline-none [font-family:inherit]"
          />
          <div className="mt-[5px] text-[11.5px] text-faint">
            Sent straight to the agent. For a menu prompt, the option number
            (e.g. <code>2</code>) is what it expects. A question with several
            parts needs one answer per line — Shift+Enter for a new line,
            Enter to send.
          </div>
        </div>
      );
    }

    return (
      <div className="mt-[11px] flex flex-wrap gap-[7px]">
        {options.map((opt) => (
          <button
            key={opt}
            onClick={() => send(opt)}
            disabled={sending}
            className={`rounded-md border border-edge bg-raised px-[13px] py-[7px] text-[12.5px] font-medium text-text ${
              sending ? "cursor-not-allowed opacity-60" : "cursor-pointer"
            }`}
          >
            {opt}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="mt-1.5">
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          className="cursor-pointer border-none bg-transparent p-0 text-[12.5px] text-faint"
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
          className="w-full rounded-md border border-edge bg-ground px-2.5 py-2 text-sm text-text outline-none"
        />
      )}
    </div>
  );
}
