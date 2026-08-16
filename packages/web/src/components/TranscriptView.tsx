import { useState, useEffect, useCallback } from "react";
import { theme } from "./theme";

interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface Message {
  uuid: string;
  role: "user" | "assistant";
  timestamp: string;
  text: string;
  toolCalls: ToolCall[];
  outputTokens?: number;
  model?: string;
}

interface TranscriptPage {
  messages: Message[];
  hasMore: boolean;
  totalMessages: number;
  outputTokens: number;
  contextTokens: number;
  /** Standup owns this session's pane, so it can be replied to. */
  owned: boolean;
}

const PAGE = 40;

/** One-line summary of a tool call — the arguments that identify it. */
function describeToolCall(call: ToolCall): string {
  const i = call.input;
  const detail =
    (i.file_path as string) ??
    (i.command as string) ??
    (i.pattern as string) ??
    (i.query as string) ??
    (i.description as string) ??
    "";
  return detail ? `${call.name} · ${String(detail).slice(0, 90)}` : call.name;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/**
 * The session's real conversation, read from Claude Code's transcript.
 *
 * Works for monitored sessions as well as launched ones — the transcript is
 * complete regardless of when Standup started observing. Replying is only
 * offered when Standup owns the pane; a monitored session belongs to the
 * human's own terminal.
 */
export function TranscriptView({
  sessionId,
  sessionStatus,
}: {
  sessionId: string;
  sessionStatus: string;
}) {
  const [page, setPage] = useState<TranscriptPage | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/sessions/${sessionId}/transcript?limit=${limit}`
      );
      if (res.ok) setPage(await res.json());
    } catch {
      // Leave the previous page on screen rather than blanking it.
    } finally {
      setLoading(false);
    }
  }, [sessionId, limit]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  // Poll only while the session is live; an ended session's transcript is
  // final and re-reading an 8MB file for nothing is pure waste.
  useEffect(() => {
    if (sessionStatus === "idle") return;
    const timer = setInterval(load, 6000);
    return () => clearInterval(timer);
  }, [load, sessionStatus]);

  async function send() {
    if (!draft.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: draft.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Send failed");
        return;
      }
      setDraft("");
      // Give the agent a moment to react before re-reading.
      setTimeout(() => void load(), 1500);
    } finally {
      setSending(false);
    }
  }

  if (loading && !page) {
    return (
      <div style={{ padding: "20px", fontSize: 12.5, color: theme.faint }}>
        Reading transcript…
      </div>
    );
  }

  if (!page || page.totalMessages === 0) {
    return (
      <div style={{ padding: "20px", fontSize: 13, color: theme.faint }}>
        No transcript found for this session. Standup reads Claude Code's own
        transcript file, which appears once the session has produced a turn.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      <div
        style={{
          display: "flex",
          gap: 14,
          alignItems: "center",
          padding: "10px 20px",
          fontFamily: theme.mono,
          fontSize: 10.5,
          color: theme.faint,
          borderBottom: `1px solid ${theme.edgeSoft}`,
          flexWrap: "wrap",
        }}
      >
        <span>{page.totalMessages} messages</span>
        <span>{formatTokens(page.outputTokens)} output</span>
        <span>{formatTokens(page.contextTokens)} context</span>
        <span style={{ flex: 1 }} />
        {page.hasMore && (
          <button
            onClick={() => setLimit((n) => n + PAGE)}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              cursor: "pointer",
              fontFamily: theme.mono,
              fontSize: 10.5,
              color: theme.running,
            }}
          >
            ↑ load earlier
          </button>
        )}
      </div>

      <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "6px 0 16px" }}>
        {page.messages.map((m) => {
          const isUser = m.role === "user";
          return (
            <div
              key={m.uuid}
              style={{
                padding: "10px 20px",
                borderLeft: `2px solid ${isUser ? theme.edge : theme.checkpoint}`,
                background: isUser ? theme.surface : "transparent",
                marginBottom: 2,
              }}
            >
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "baseline",
                  marginBottom: 5,
                }}
              >
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: isUser ? theme.dim : theme.checkpoint,
                  }}
                >
                  {isUser ? "you" : "claude"}
                </span>
                <span style={{ fontFamily: theme.mono, fontSize: 10, color: theme.faint }}>
                  {m.timestamp
                    ? new Date(m.timestamp).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : ""}
                </span>
              </div>

              {m.text && (
                <div
                  style={{
                    fontSize: 13,
                    lineHeight: 1.55,
                    color: theme.text,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {m.text}
                </div>
              )}

              {/* Collapsed to one line each: the feed is a conversation, and
                  full tool payloads would bury it. */}
              {m.toolCalls.map((call) => (
                <div
                  key={call.id}
                  style={{
                    fontFamily: theme.mono,
                    fontSize: 10.5,
                    color: theme.faint,
                    marginTop: 5,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  ⟩ {describeToolCall(call)}
                </div>
              ))}
            </div>
          );
        })}
      </div>

      <div style={{ borderTop: `1px solid ${theme.edge}`, padding: "10px 20px 14px" }}>
        {page.owned ? (
          <>
            <input
              value={draft}
              disabled={sending}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void send();
              }}
              placeholder="Reply to this agent — types straight into its session…"
              style={{
                width: "100%",
                fontSize: 13,
                color: theme.text,
                background: theme.ground,
                border: `1px solid ${theme.edge}`,
                borderRadius: 6,
                padding: "9px 11px",
                outline: "none",
              }}
            />
            {error && (
              <div
                style={{
                  fontFamily: theme.mono,
                  fontSize: 11,
                  color: theme.waiting,
                  marginTop: 7,
                }}
              >
                {error}
              </div>
            )}
          </>
        ) : (
          <div style={{ fontSize: 12, color: theme.faint, lineHeight: 1.5 }}>
            Read-only — Standup didn't launch this session, so it can't type
            into it. Reply in its own terminal.
          </div>
        )}
      </div>
    </div>
  );
}
