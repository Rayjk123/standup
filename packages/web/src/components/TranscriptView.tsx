import { useState, useEffect, useCallback } from "react";
import { theme } from "./theme";
import { Markdown } from "./Markdown";

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
  /** A `/command` run through the CLI passthrough — see server-side LocalCommand. */
  localCommand?: { name: string; args: string; stdout: string };
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
  sessionEnded,
  eventSignal,
}: {
  sessionId: string;
  /** Ended sessions have a final transcript; no need to keep re-reading. */
  sessionEnded: boolean;
  /** Bumped when a hook event arrives for this session. */
  eventSignal: number;
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

  // Refresh when a hook event arrives for this session, rather than on a
  // timer. The previous version polled every 6s *and* skipped polling
  // entirely while status was "idle" — but "idle" means a turn just ended,
  // which is precisely when the agent's reply lands and you are most likely
  // to be reading. The transcript appeared to freeze exactly when it
  // mattered.
  useEffect(() => {
    if (eventSignal === 0) return;
    void load();
  }, [eventSignal, load]);

  // Slow backstop for writes that produce no hook — a long tool result
  // streaming in, say. Only while the session is actually alive.
  useEffect(() => {
    if (sessionEnded) return;
    const timer = setInterval(load, 10000);
    return () => clearInterval(timer);
  }, [load, sessionEnded]);

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

              {m.localCommand ? (
                <div
                  style={{
                    fontFamily: theme.mono,
                    fontSize: 11.5,
                    color: theme.dim,
                    display: "flex",
                    gap: 8,
                    alignItems: "baseline",
                    flexWrap: "wrap",
                  }}
                >
                  <span style={{ color: theme.running }}>
                    {m.localCommand.name}
                    {m.localCommand.args ? ` ${m.localCommand.args}` : ""}
                  </span>
                  {m.localCommand.stdout && (
                    <span style={{ color: theme.faint }}>
                      → {m.localCommand.stdout}
                    </span>
                  )}
                </div>
              ) : (
                m.text && (
                  <div style={{ wordBreak: "break-word" }}>
                    <Markdown>{m.text}</Markdown>
                  </div>
                )
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
