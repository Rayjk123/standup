import { useEffect, useState } from "react";
import type { Ask } from "@standup/shared";
import {
  LuChevronDown,
  LuChevronRight,
  LuArrowUp,
  LuTriangleAlert,
} from "react-icons/lu";
import { theme } from "./theme";
import { CollapsibleText } from "./CollapsibleText";
import { AskQuestionView, type AskQuestion } from "./AskQuestionView";
import { AskAnswerPanel } from "./AskAnswerPanel";
import { Markdown } from "./Markdown";
import { Replier } from "./Replier";
import { TranscriptReply } from "./TranscriptReply";
import type { SessionModelSettings } from "./TranscriptReply";
import { WorkingIndicator } from "./WorkingIndicator";
import { floorAskAnswers, isHighRiskFloorAsk } from "../lib/floorAsk";
import { messageTail, turnPhase } from "../lib/turnPhase";
import { useTranscript, type ToolCall } from "../hooks/useTranscript";
import { useStickyScroll } from "../hooks/useStickyScroll";

/** Normalizes a raw AskUserQuestion `input.questions` into the display shape. */
function askQuestions(call: ToolCall): AskQuestion[] | null {
  if (call.name !== "AskUserQuestion" || !Array.isArray(call.input.questions)) return null;
  return (call.input.questions as Record<string, unknown>[]).map((q) => ({
    question: typeof q.question === "string" ? q.question : "",
    header: typeof q.header === "string" ? q.header : undefined,
    multiSelect: !!q.multiSelect,
    options: Array.isArray(q.options)
      ? (q.options as Record<string, unknown>[]).map((o) => ({
          label: typeof o.label === "string" ? o.label : "",
          description: typeof o.description === "string" ? o.description : undefined,
        }))
      : [],
  }));
}

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
  const questions = askQuestions(call);
  if (questions?.[0]) return `${call.name} · ${questions[0].question.slice(0, 90)}`;
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
  replyFocusSignal = 0,
  onReplyFocused,
  settings,
  readOnly = false,
  readOnlyNote,
}: {
  sessionId: string;
  /** Ended sessions have a final transcript; no need to keep re-reading. */
  sessionEnded: boolean;
  /** Bumped when a hook event arrives for this session. */
  eventSignal: number;
  /** Bumped by a "Jump in" to focus the reply box (spec F). */
  replyFocusSignal?: number;
  /** Called once the reply box has consumed the focus signal, so the owner
   * can reset it and avoid re-focusing on a later remount. */
  onReplyFocused?: () => void;
  /** The session's model/effort, for the reply box's switchers. */
  settings?: SessionModelSettings;
  /**
   * Watch only: no reply box, no answer panel, no interrupt. A pending
   * question shows as text, and `readOnlyNote` closes the view.
   */
  readOnly?: boolean;
  readOnlyNote?: string;
}) {
  const { page, loading, loadMore, reload } = useTranscript({
    sessionId,
    sessionEnded,
    eventSignal,
  });
  // Follow the tail: open on the latest turn and stay pinned to the bottom as
  // the agent streams, unless the reader has scrolled up into history.
  const scrollRef = useStickyScroll(
    `${page?.totalMessages ?? 0}:${page?.outputTokens ?? 0}:${eventSignal}`,
    sessionId
  );
  // The pending prompt-ask for this session, if any, with the structured
  // questions of the modal it's currently blocked inside (server-derived from
  // the live tool call, so a stale answered AskUserQuestion in history can't be
  // mistaken for it). Polled on the same signal that reloads the transcript, so
  // it appears the moment the agent blocks and clears the moment it's answered.
  const [pending, setPending] = useState<{
    ask: Ask;
    questions: AskQuestion[] | null;
  } | null>(null);
  useEffect(() => {
    if (sessionEnded) {
      setPending(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/sessions/${sessionId}/pending-ask`)
      .then((r) => r.json())
      .then((d: { ask: Ask | null; questions: AskQuestion[] | null }) => {
        if (!cancelled) setPending(d.ask ? { ask: d.ask, questions: d.questions } : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sessionId, sessionEnded, eventSignal]);
  // "Expand all" sets a default; individual clicks override it per call,
  // like Claude Code's own transcript view. Toggling the default clears
  // overrides so it always means what it says.
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

  // The newest card is what the live phase is read from — the window is a tail, so
  // its last message is the transcript's last message.
  const lastMessage = page?.messages[page.messages.length - 1];
  // Whether a turn is running right now — the same signal the working indicator
  // draws from, reused to gate the reply box's interrupt affordance.
  const tail = lastMessage ? messageTail(lastMessage) : undefined;
  const working = !!turnPhase({
    tail,
    tailAt: lastMessage?.timestamp,
    sessionEnded,
    blocked: !!pending,
    now: Date.now(),
  });

  // The agent is blocked on an ask_human call (a floor hold included), not on
  // its pane: typed text there wouldn't answer it, so the answer goes to the
  // ask itself. It needs no transcript, so it shows before one loads too.
  const askReply =
    !readOnly && pending && pending.ask.kind === "ask_human" ? (
      <AskReply
        key={pending.ask.id}
        ask={pending.ask}
        onResolved={() => {
          setPending(null);
          reload();
        }}
      />
    ) : null;

  if (loading && !page) {
    return (
      <>
        <div style={{ padding: "20px", fontSize: 12.5, color: theme.faint }}>
          Reading transcript…
        </div>
        {askReply}
      </>
    );
  }

  if (!page || page.totalMessages === 0) {
    return (
      <>
        <div style={{ padding: "20px", fontSize: 13, color: theme.faint }}>
          No transcript found for this session. Standup reads Claude Code's own
          transcript file, which appears once the session has produced a turn.
        </div>
        {askReply}
      </>
    );
  }

  // The transcript tool call the pending AskUserQuestion is blocked inside: the
  // newest AskUserQuestion whose result hasn't been captured yet. The answer
  // panel renders inline against it (below), so the question sits in the
  // transcript flow and the history above it stays scrollable — instead of a
  // bottom-slot panel tall enough to squeeze the transcript out of the column.
  const hasPendingQuestions =
    !!pending && !!pending.questions && pending.questions.length > 0;
  let pendingCallId: string | null = null;
  if (hasPendingQuestions) {
    outer: for (let i = page.messages.length - 1; i >= 0; i--) {
      const calls = page.messages[i].toolCalls;
      for (let j = calls.length - 1; j >= 0; j--) {
        if (calls[j].name === "AskUserQuestion" && !calls[j].output) {
          pendingCallId = calls[j].id;
          break outer;
        }
      }
    }
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
        <button
          onClick={toggleExpandAll}
          style={{
            background: "none",
            border: `1px solid ${theme.edge}`,
            borderRadius: 4,
            padding: "3px 8px",
            cursor: "pointer",
            fontFamily: theme.mono,
            fontSize: 10.5,
            color: expandAll ? theme.text : theme.faint,
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          {expandAll ? <LuChevronDown /> : <LuChevronRight />}
          {expandAll ? "collapse all" : "expand all"}
        </button>
        {page.hasMore && (
          <button
            onClick={loadMore}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              cursor: "pointer",
              fontFamily: theme.mono,
              fontSize: 10.5,
              color: theme.running,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <LuArrowUp /> load earlier
          </button>
        )}
      </div>

      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "6px 0 16px" }}>
        {page.messages.map((m) => {
          if (m.taskNotification) {
            const n = m.taskNotification;
            const statusColor =
              n.status === "completed"
                ? theme.checkpoint
                : /fail|error/i.test(n.status)
                  ? theme.waiting
                  : theme.dim;
            return (
              <div
                key={m.uuid}
                style={{
                  padding: "6px 20px",
                  display: "flex",
                  gap: 8,
                  alignItems: "baseline",
                }}
              >
                <span style={{ color: statusColor, fontSize: 10, flexShrink: 0 }}>●</span>
                <span
                  style={{
                    fontFamily: theme.mono,
                    fontSize: 11.5,
                    color: theme.dim,
                    wordBreak: "break-word",
                    flex: 1,
                    minWidth: 0,
                  }}
                >
                  {n.summary}
                </span>
              </div>
            );
          }
          const isUser = m.role === "user";
          return (
            <div
              key={m.uuid}
              style={{
                padding: "10px 20px",
                borderLeft: `2px solid ${isUser ? theme.edge : theme.checkpoint}`,
                background: isUser ? theme.surface : "transparent",
                marginBottom: 2,
                // Skip layout/paint for off-screen cards so a long transcript
                // (hundreds of cards, some large) doesn't thrash on scroll; the
                // intrinsic-size hint keeps the scrollbar stable before a card
                // is first rendered.
                contentVisibility: "auto",
                containIntrinsicSize: "0 160px",
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
                  {isUser ? (m.sentBy ?? "you") : "claude"}
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
                m.text && <CollapsibleText text={m.text} />
              )}

              {/* Collapsed to one line by default — the feed is a
                  conversation, and full tool payloads would bury it. Click
                  a call, or "expand all", to see it the way Claude Code's
                  own transcript shows it: full input and result. */}
              {m.toolCalls.map((call) => {
                if (hasPendingQuestions && call.id === pendingCallId && readOnly) {
                  return (
                    <div key={call.id} style={{ marginTop: 5 }}>
                      <AskQuestionView questions={pending!.questions!} />
                    </div>
                  );
                }
                if (hasPendingQuestions && call.id === pendingCallId) {
                  // The live question: interactive answer panel, inline in the
                  // transcript flow instead of the bottom slot, so the reader
                  // can still scroll the context behind it.
                  return (
                    <div key={call.id} style={{ marginTop: 5 }}>
                      <AskAnswerPanel
                        inline
                        askId={pending!.ask.id}
                        questions={pending!.questions!}
                        owned={page.owned}
                        onResolved={() => {
                          setPending(null);
                          reload();
                        }}
                      />
                    </div>
                  );
                }
                const expanded = isExpanded(call.id);
                return (
                  <div key={call.id} style={{ marginTop: 5 }}>
                    <div
                      onClick={() => toggleCall(call.id)}
                      style={{
                        fontFamily: theme.mono,
                        fontSize: 10.5,
                        color: theme.faint,
                        cursor: "pointer",
                        userSelect: "none",
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                      }}
                    >
                      {expanded ? (
                        <LuChevronDown style={{ flexShrink: 0 }} />
                      ) : (
                        <LuChevronRight style={{ flexShrink: 0 }} />
                      )}
                      <span
                        style={{
                          overflow: expanded ? "visible" : "hidden",
                          textOverflow: expanded ? "clip" : "ellipsis",
                          whiteSpace: expanded ? "normal" : "nowrap",
                          minWidth: 0,
                        }}
                      >
                        {expanded ? call.name : describeToolCall(call)}
                      </span>
                    </div>
                    {expanded && (
                      <div
                        style={{
                          fontFamily: theme.mono,
                          fontSize: 11,
                          color: theme.dim,
                          background: theme.ground,
                          border: `1px solid ${theme.edgeSoft}`,
                          borderRadius: 6,
                          padding: "9px 11px",
                          marginTop: 4,
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                          maxHeight: 420,
                          overflowY: "auto",
                        }}
                      >
                        {(() => {
                          const bad = unparsedInput(call);
                          if (bad) {
                            return (
                              <div style={{ marginBottom: 6, color: theme.waiting }}>
                                <LuTriangleAlert style={{ verticalAlign: "-2px" }} /> Claude
                                Code couldn't parse this call's input as JSON ({bad.len}{" "}
                                bytes). Raw input:
                                <div style={{ color: theme.dim, marginTop: 4 }}>
                                  {bad.raw}
                                </div>
                              </div>
                            );
                          }
                          const questions = askQuestions(call);
                          if (questions) {
                            return (
                              <div style={{ marginBottom: 6 }}>
                                <AskQuestionView questions={questions} hideStatus />
                              </div>
                            );
                          }
                          return Object.entries(call.input).map(([key, value]) => (
                            <div key={key} style={{ marginBottom: 6 }}>
                              <span style={{ color: theme.faint }}>{key}: </span>
                              {formatInputValue(value)}
                            </div>
                          ));
                        })()}
                        {call.output ? (
                          <div
                            style={{
                              marginTop: 8,
                              paddingTop: 8,
                              borderTop: `1px solid ${theme.edgeSoft}`,
                              color: call.isError ? theme.waiting : theme.faint,
                            }}
                          >
                            {call.output.length > MAX_OUTPUT_CHARS
                              ? `${call.output.slice(0, MAX_OUTPUT_CHARS)}\n… truncated`
                              : call.output}
                          </div>
                        ) : (
                          <div
                            style={{
                              marginTop: 8,
                              paddingTop: 8,
                              borderTop: `1px solid ${theme.edgeSoft}`,
                              color: theme.faint,
                              fontStyle: "italic",
                            }}
                          >
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

      {/* The live phase, above the reply box: the cards alone can't show movement
          between polls, so a busy session would otherwise look frozen. A pending
          ask suppresses it — the agent is waiting on you, not working. */}
      <WorkingIndicator
        tail={tail}
        tailAt={lastMessage?.timestamp}
        sessionEnded={sessionEnded}
        blocked={!!pending}
      />

      {readOnly ? (
        // A watcher's view: nothing here answers, steers or interrupts the
        // agent. The note says where that happens instead.
        <div
          role="note"
          style={{
            padding: "8px 20px",
            fontSize: 11.5,
            color: pending ? theme.waiting : theme.faint,
            borderTop: `1px solid ${theme.edgeSoft}`,
            background: theme.ground,
          }}
        >
          {pending ? `Waiting on an answer: ${pending.ask.question.slice(0, 200)}. ` : ""}
          {readOnlyNote ?? "Read-only view."}
        </div>
      ) : hasPendingQuestions ? (
        // While the agent is blocked inside an AskUserQuestion modal, free text
        // can't answer it — the menu swallows typed characters — so the reply
        // box stays hidden. The interactive panel lives inline in the transcript
        // above (against its tool call); a slim cue here points to it. Only when
        // that anchor isn't in the loaded window yet do we fall back to a
        // bottom-slot panel, so the human always has a way to answer.
        pendingCallId ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 20px",
              fontSize: 11.5,
              color: theme.running,
              borderTop: `1px solid ${theme.edgeSoft}`,
              background: theme.ground,
            }}
          >
            <LuArrowUp style={{ flexShrink: 0 }} />
            Agent is waiting on your answer — respond in the transcript above.
          </div>
        ) : (
          <AskAnswerPanel
            askId={pending!.ask.id}
            questions={pending!.questions!}
            owned={page.owned}
            onResolved={() => {
              setPending(null);
              reload();
            }}
          />
        )
      ) : askReply ? (
        askReply
      ) : (
        <TranscriptReply
          sessionId={sessionId}
          owned={page.owned}
          onSent={reload}
          working={working}
          focusSignal={replyFocusSignal}
          onFocused={onReplyFocused}
          settings={settings}
        />
      )}
    </div>
  );
}

/**
 * The bottom-slot answer to a pending ask_human: its question, then its
 * options or a free-text box. A safety-floor hold offers only Allow once and
 * Deny, since any other answer denies the held call. Dismiss ends the wait
 * without an answer, as if it had timed out.
 */
function AskReply({ ask, onResolved }: { ask: Ask; onResolved: () => void }) {
  const floorAnswers = floorAskAnswers(ask);
  const [dismissError, setDismissError] = useState<string | null>(null);
  async function send(path: string, init: RequestInit) {
    const res = await fetch(path, init);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `Could not send (${res.status})`);
    }
    onResolved();
  }
  const resolve = (answer: string) =>
    send(`/api/asks/${ask.id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer }),
    });
  const dismiss = () => {
    setDismissError(null);
    send(`/api/asks/${ask.id}`, { method: "DELETE" }).catch((err: Error) => setDismissError(err.message));
  };
  return (
    <div
      style={{
        padding: "10px 20px 12px",
        borderTop: `1px solid ${theme.edgeSoft}`,
        background: theme.ground,
        maxHeight: "45%",
        overflowY: "auto",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", marginBottom: 5 }}>
        <span
          style={{
            fontFamily: theme.mono,
            fontSize: 9.5,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: theme.waiting,
            fontWeight: 600,
            flex: 1,
          }}
        >
          {isHighRiskFloorAsk(ask) ? "Needs you · high-risk floor hold" : "Needs you"}
        </span>
        <button
          onClick={dismiss}
          title="Dismiss without answering — the agent's wait ends as if it had timed out."
          style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 11.5, color: theme.faint }}
        >
          Dismiss
        </button>
      </div>
      <Markdown>{ask.question}</Markdown>
      <Replier options={floorAnswers.length > 0 ? floorAnswers : ask.options} onReply={resolve} />
      {dismissError && (
        <div style={{ fontFamily: theme.mono, fontSize: 11, color: theme.waiting, marginTop: 6 }}>{dismissError}</div>
      )}
    </div>
  );
}
