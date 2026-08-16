import { useState, useEffect, useCallback } from "react";
import { Markdown } from "./Markdown";

interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output?: string;
  isError?: boolean;
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

/**
 * Claude Code's own marker for a tool call whose input JSON failed to
 * parse — passed through verbatim from the transcript. Not meant to be
 * read as ordinary tool arguments, so it's rendered specially.
 */
function unparsedInput(call: ToolCall): { raw: string; len: number } | null {
  const u = call.input.__unparsedToolInput;
  if (u && typeof u === "object" && typeof (u as Record<string, unknown>).raw === "string") {
    return u as { raw: string; len: number };
  }
  return null;
}

/** One-line summary of a tool call — the arguments that identify it. */
function describeToolCall(call: ToolCall): string {
  if (unparsedInput(call)) return `${call.name} · ⚠ malformed input`;
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

/** Truncated defensively — a tool result can be megabytes (full file reads, huge diffs). */
const MAX_OUTPUT_CHARS = 6000;

function formatInputValue(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
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
  // "Expand all" sets a default; individual clicks override it per call,
  // like Claude Code's own transcript view. Toggling the default clears
  // overrides so it always means what it says.
  //
  // This per-id-override-over-a-global-default shape doesn't map onto
  // Headless UI's Disclosure (which owns its open state internally, with no
  // controlled open/onChange API), so expand/collapse stays plain state +
  // Tailwind classes rather than forcing Disclosure in.
  const [expandAll, setExpandAll] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  function isExpanded(id: string): boolean {
    return overrides[id] ?? expandAll;
  }

  function toggleCall(id: string) {
    setOverrides((prev) => ({ ...prev, [id]: !isExpanded(id) }));
  }

  function toggleExpandAll() {
    setExpandAll((v) => !v);
    setOverrides({});
  }

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
    return <div className="p-5 text-[12.5px] text-faint">Reading transcript…</div>;
  }

  if (!page || page.totalMessages === 0) {
    return (
      <div className="p-5 text-[13px] text-faint">
        No transcript found for this session. Standup reads Claude Code's own
        transcript file, which appears once the session has produced a turn.
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="flex gap-3.5 items-center px-5 py-2.5 font-mono text-[10.5px] text-faint border-b border-edge-soft flex-wrap">
        <span>{page.totalMessages} messages</span>
        <span>{formatTokens(page.outputTokens)} output</span>
        <span>{formatTokens(page.contextTokens)} context</span>
        <span className="flex-1" />
        <button
          onClick={toggleExpandAll}
          className={`bg-transparent border border-edge rounded px-2 py-[3px] cursor-pointer font-mono text-[10.5px] ${
            expandAll ? "text-text" : "text-faint"
          }`}
        >
          {expandAll ? "▾ collapse all" : "▸ expand all"}
        </button>
        {page.hasMore && (
          <button
            onClick={() => setLimit((n) => n + PAGE)}
            className="bg-transparent border-none p-0 cursor-pointer font-mono text-[10.5px] text-running"
          >
            ↑ load earlier
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 pt-1.5 pb-4">
        {page.messages.map((m) => {
          const isUser = m.role === "user";
          return (
            <div
              key={m.uuid}
              className={`px-5 py-2.5 border-l-2 mb-0.5 ${
                isUser ? "border-edge" : "border-checkpoint"
              } ${isUser ? "bg-surface" : "bg-transparent"}`}
            >
              <div className="flex gap-2 items-baseline mb-[5px]">
                <span
                  className={`text-xs font-bold ${isUser ? "text-dim" : "text-checkpoint"}`}
                >
                  {isUser ? "you" : "claude"}
                </span>
                <span className="font-mono text-[10px] text-faint">
                  {m.timestamp
                    ? new Date(m.timestamp).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : ""}
                </span>
              </div>

              {m.localCommand ? (
                <div className="font-mono text-[11.5px] text-dim flex gap-2 items-baseline flex-wrap">
                  <span className="text-running">
                    {m.localCommand.name}
                    {m.localCommand.args ? ` ${m.localCommand.args}` : ""}
                  </span>
                  {m.localCommand.stdout && (
                    <span className="text-faint">→ {m.localCommand.stdout}</span>
                  )}
                </div>
              ) : (
                m.text && (
                  <div className="break-words">
                    <Markdown>{m.text}</Markdown>
                  </div>
                )
              )}

              {/* Collapsed to one line by default — the feed is a
                  conversation, and full tool payloads would bury it. Click
                  a call, or "expand all", to see it the way Claude Code's
                  own transcript shows it: full input and result. */}
              {m.toolCalls.map((call) => {
                const expanded = isExpanded(call.id);
                return (
                  <div key={call.id} className="mt-[5px]">
                    <div
                      onClick={() => toggleCall(call.id)}
                      className={`font-mono text-[10.5px] text-faint cursor-pointer select-none ${
                        expanded
                          ? "overflow-visible text-clip whitespace-normal"
                          : "overflow-hidden text-ellipsis whitespace-nowrap"
                      }`}
                    >
                      {expanded ? "⌄" : "⟩"}{" "}
                      {expanded ? call.name : describeToolCall(call)}
                    </div>
                    {expanded && (
                      <div className="font-mono text-[11px] text-dim bg-ground border border-edge-soft rounded-md px-[11px] py-[9px] mt-1 whitespace-pre-wrap break-words max-h-[420px] overflow-y-auto">
                        {(() => {
                          const bad = unparsedInput(call);
                          if (bad) {
                            return (
                              <div className="mb-1.5 text-waiting">
                                ⚠ Claude Code couldn't parse this call's input as
                                JSON ({bad.len} bytes). Raw input:
                                <div className="text-dim mt-1">{bad.raw}</div>
                              </div>
                            );
                          }
                          return Object.entries(call.input).map(([key, value]) => (
                            <div key={key} className="mb-1.5">
                              <span className="text-faint">{key}: </span>
                              {formatInputValue(value)}
                            </div>
                          ));
                        })()}
                        {call.output ? (
                          <div
                            className={`mt-2 pt-2 border-t border-edge-soft ${
                              call.isError ? "text-waiting" : "text-faint"
                            }`}
                          >
                            {call.output.length > MAX_OUTPUT_CHARS
                              ? `${call.output.slice(0, MAX_OUTPUT_CHARS)}\n… truncated`
                              : call.output}
                          </div>
                        ) : (
                          <div className="mt-2 pt-2 border-t border-edge-soft text-faint italic">
                            no result captured
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      <div className="border-t border-edge px-5 pt-2.5 pb-3.5">
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
              className="w-full text-[13px] text-text bg-ground border border-edge rounded-md px-[11px] py-[9px] outline-none"
            />
            {error && <div className="font-mono text-[11px] text-waiting mt-[7px]">{error}</div>}
          </>
        ) : (
          <div className="text-xs text-faint leading-relaxed">
            Read-only — Standup didn't launch this session, so it can't type
            into it. Reply in its own terminal.
          </div>
        )}
      </div>
    </div>
  );
}
