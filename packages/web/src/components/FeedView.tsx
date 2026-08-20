import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type {
  Checkpoint,
  Ask,
  Session,
  Project,
  ExpertExchange,
  Launch,
  ClaudeEffort,
  ClaudeModel,
} from "@standup/shared";
import {
  LuReply,
  LuArrowUpRight,
  LuX,
  LuClock,
  LuCircleX,
  LuInbox,
  LuCircleCheck,
  LuBot,
  LuBox,
  LuCheck,
} from "react-icons/lu";
import { theme, friendlyModel } from "./theme";
import { Markdown } from "./Markdown";
import { Replier } from "./Replier";
import { Composer } from "./Composer";
import { LaunchControls } from "./LaunchControls";
import { SessionScreen } from "./SessionScreen";

/** Icon button in the hover action bar. `active` highlights a toggled state. */
function actionBtn(active: boolean): React.CSSProperties {
  return {
    background: active ? theme.edge : "none",
    border: "none",
    cursor: "pointer",
    fontSize: 14,
    lineHeight: 1,
    padding: "4px 5px",
    borderRadius: 5,
    color: active ? theme.text : theme.dim,
    display: "flex",
    alignItems: "center",
  };
}

/**
 * Renders the agent's question and what retrieval returned, attributed to a
 * region. Shown in full rather than collapsed: the design's whole argument
 * for routing expert traffic through the feed is that you need to notice a
 * wrong answer before it turns into a bad edit.
 */
function ExpertBody({ exchange }: { exchange: ExpertExchange }) {
  return (
    <>
      <div style={{ fontSize: 13, color: theme.dim, marginBottom: 8 }}>
        {exchange.question}
      </div>
      <div
        style={{
          background: theme.surface,
          border: `1px solid ${theme.edgeSoft}`,
          borderLeft: `3px solid ${theme.expert}`,
          borderRadius: 6,
          padding: "11px 13px",
        }}
      >
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "baseline",
            marginBottom: 6,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontSize: 13.5, color: theme.expert, fontWeight: 700 }}>
            @{exchange.region || "repo"}-expert
          </span>
          {exchange.sources.length > 0 && (
            <span style={{ fontFamily: theme.mono, fontSize: 10, color: theme.faint }}>
              {exchange.sources.slice(0, 3).join(" · ")}
              {exchange.sources.length > 3 ? ` +${exchange.sources.length - 3}` : ""}
            </span>
          )}
        </div>
        <div style={{ maxHeight: 260, overflowY: "auto" }}>
          <Markdown>{exchange.answer}</Markdown>
        </div>
      </div>
    </>
  );
}

/**
 * A launch the human started from the composer.
 *
 * Surfaces the tmux attach command because the console deliberately does not
 * render agent responses — it carries checkpoints, asks, and expert
 * exchanges, not the conversation. Without this, starting work from the
 * console gives you no way back to what the agent actually said.
 */
function LaunchBody({
  launch,
  session,
  onStopped,
}: {
  launch: Launch;
  session?: Session;
  onStopped: () => void;
}) {
  const failed = launch.status === "failed";
  // "starting" spans the whole provision/worktree/setup phase, which for a
  // provisioned Brazil workspace runs for minutes. The tmux session doesn't
  // exist yet, so no attach/controls — just say what's happening.
  const starting = launch.status === "starting";
  const modelLabel = session?.liveModel
    ? friendlyModel(session.liveModel)
    : launch.model ?? "default";
  const effortLabel = session?.liveEffort ?? launch.effort ?? "default";

  return (
    <>
      <div style={{ fontSize: 14, lineHeight: 1.55, color: theme.text }}>
        {launch.task}
      </div>

      {failed ? (
        <div
          style={{
            fontFamily: theme.mono,
            fontSize: 11,
            color: theme.waiting,
            marginTop: 7,
            lineHeight: 1.5,
            display: "flex",
            alignItems: "center",
            gap: 5,
          }}
        >
          <LuCircleX style={{ flexShrink: 0 }} /> {launch.error ?? "Launch failed"}
        </div>
      ) : starting ? (
        <div
          style={{
            fontFamily: theme.mono,
            fontSize: 10.5,
            color: theme.running,
            marginTop: 7,
            display: "flex",
            alignItems: "center",
            gap: 5,
          }}
        >
          <LuClock style={{ flexShrink: 0 }} />{" "}
          {launch.provisioned
            ? "provisioning workspace… this can take a few minutes"
            : "starting…"}
          <span style={{ color: theme.faint }}>
            · {modelLabel} / {effortLabel}
          </span>
        </div>
      ) : (
        <>
          <div
            style={{
              fontFamily: theme.mono,
              fontSize: 10.5,
              color: theme.running,
              marginTop: 7,
              display: "flex",
              alignItems: "center",
              gap: 5,
            }}
          >
            <LuClock style={{ flexShrink: 0 }} /> worktree {launch.branch} · agent running
            <span style={{ color: theme.faint }}>
              · {modelLabel} / {effortLabel}
            </span>
          </div>
          {launch.tmuxSession && (
            <>
              <LaunchControls launch={launch} onStopped={onStopped} />
              <div
                style={{
                  fontFamily: theme.mono,
                  fontSize: 10.5,
                  color: theme.faint,
                  marginTop: 8,
                  userSelect: "all",
                }}
                title="For a full interactive terminal"
              >
                tmux attach -t {launch.tmuxSession}
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}

interface FeedViewProps {
  checkpoints: Checkpoint[];
  asks: Ask[];
  expertExchanges: ExpertExchange[];
  launches: Launch[];
  sessions: Session[];
  projects: Project[];
  onSteer: (sessionId: string, body: string) => Promise<void>;
  onResolveAsk: (askId: string, answer: string) => Promise<{ error?: string }>;
  onDismissAsk: (askId: string) => Promise<{ error?: string }>;
  onLaunch: (
    projectId: string,
    task: string,
    model?: ClaudeModel,
    effort?: ClaudeEffort
  ) => Promise<{ error?: string }>;
  onLaunchChanged: () => void;
}

export function FeedView({
  checkpoints,
  asks,
  expertExchanges,
  launches,
  sessions,
  projects,
  onSteer,
  onResolveAsk,
  onDismissAsk,
  onLaunch,
  onLaunchChanged,
}: FeedViewProps) {
  // What the human has sent this session, keyed by feed item id. Optimistic:
  // asks disappear from `asks` once resolved server-side, so without this the
  // confirmation would vanish the instant it succeeded.
  const [replies, setReplies] = useState<Record<string, string>>({});
  // Slack-style: the row does nothing on click. Hovering reveals an action
  // bar; the reply box only opens when you pick "reply" from it.
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [replyingId, setReplyingId] = useState<string | null>(null);

  const navigate = useNavigate();

  // Send a human response to a feed item — resolves an ask, steers a
  // checkpoint's session. Optimistic (shows the reply instantly, reverts on
  // failure). Shared by the reply box and the one-tap emoji reactions.
  async function handleReply(
    kind: "ask" | "checkpoint",
    id: string,
    sessionId: string,
    body: string
  ) {
    setReplies((prev) => ({ ...prev, [id]: body }));
    try {
      if (kind === "ask") {
        const result = await onResolveAsk(id, body);
        if (result?.error) throw new Error(result.error);
      } else {
        await onSteer(sessionId, body);
      }
    } catch (err) {
      setReplies((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      throw err;
    }
  }

  // "Blocked" is a filter on the feed, not a separate view — the alert strip
  // deep-links here with ?filter=blocked, and the toggle sets/clears it. When
  // on, only asks (agents waiting on you) show.
  const [searchParams, setSearchParams] = useSearchParams();
  const blockedOnly = searchParams.get("filter") === "blocked";
  const pendingAskCount = asks.filter((a) => a.status === "pending").length;

  // The merged feed carries checkpoints, asks, and expert exchanges — never
  // raw tool calls. That separation is enforced here, at the query, not in
  // the rendering: an activity tier that reaches this array has already
  // made the feed unreadable.
  type FeedItem =
    | { type: "checkpoint"; data: Checkpoint }
    | { type: "ask"; data: Ask }
    | { type: "expert"; data: ExpertExchange }
    | { type: "launch"; data: Launch & { sessionId: string } };

  const feedItems: FeedItem[] = [
    ...checkpoints.map((c) => ({ type: "checkpoint" as const, data: c })),
    ...asks.map((a) => ({ type: "ask" as const, data: a })),
    ...expertExchanges.map((e) => ({ type: "expert" as const, data: e })),
    // Launches are what the human started, so they belong in the feed as a
    // record of intent — without this a launch produced no visible trace at
    // all, which reads as the console having swallowed the request.
    ...launches
      .filter((l) => l.status !== "cleaned")
      .map((l) => ({
        type: "launch" as const,
        data: { ...l, sessionId: l.sessionId ?? "" },
      })),
  ].sort(
    // Oldest first, newest last — reads top-to-bottom like a chat thread,
    // with the composer immediately below the most recent item.
    (a, b) =>
      new Date(a.data.createdAt).getTime() -
      new Date(b.data.createdAt).getTime()
  );

  // The "Needs you" filter narrows the same feed to just asks — no separate
  // view, no tab to hunt through.
  const visibleItems = blockedOnly
    ? feedItems.filter((i) => i.type === "ask")
    : feedItems;

  const setFilter = (on: boolean) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (on) next.set("filter", "blocked");
        else next.delete("filter");
        return next;
      },
      { replace: true }
    );
  };

  const getSession = (sessionId: string) =>
    sessions.find((s) => s.id === sessionId);
  const getProject = (projectId: string) =>
    projects.find((p) => p.id === projectId);

  // Keep the newest item in view as the feed grows, rather than leaving the
  // reader scrolled up at the oldest item every time the list re-renders.
  // Not while filtered to blocked — that list is a to-do queue, not a thread,
  // and yanking it to the bottom on every change fights the reader.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (blockedOnly) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visibleItems.length, blockedOnly]);

  // Column layout so the composer stays pinned below a scrolling feed
  // rather than scrolling away with it.
  const tab = (label: string, on: boolean, active: boolean, count?: number) => (
    <button
      onClick={() => setFilter(on)}
      style={{
        fontSize: 12,
        fontWeight: 600,
        padding: "4px 11px",
        borderRadius: 999,
        border: `1px solid ${active ? theme.waiting : theme.edge}`,
        background: active ? `${theme.waiting}1A` : "transparent",
        color: active ? theme.waiting : theme.faint,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      {label}
      {count !== undefined && count > 0 && (
        <span
          style={{
            fontFamily: theme.mono,
            fontSize: 9.5,
            background: active ? theme.waiting : theme.edge,
            color: active ? theme.ground : theme.dim,
            borderRadius: 8,
            padding: "0px 5px",
            fontWeight: 700,
          }}
        >
          {count}
        </span>
      )}
    </button>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* Filter toggle — Blocked is a lens on the feed, not a separate tab. */}
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          padding: "8px 20px",
          borderBottom: `1px solid ${theme.edgeSoft}`,
        }}
      >
        {tab("All", false, !blockedOnly)}
        {tab("Needs you", true, blockedOnly, pendingAskCount)}
      </div>

      {visibleItems.length === 0 ? (
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: 40,
            color: theme.dim,
          }}
        >
          <div style={{ fontSize: 30, marginBottom: 10, display: "flex" }}>
            {blockedOnly ? <LuCircleCheck /> : <LuInbox />}
          </div>
          <div style={{ fontSize: 14 }}>
            {blockedOnly ? "Nothing blocked. Every agent is moving." : "No activity yet."}
          </div>
          {!blockedOnly && (
            <div style={{ fontSize: 12.5, color: theme.faint, marginTop: 4 }}>
              Checkpoints and asks from agents will appear here — or start work below.
            </div>
          )}
        </div>
      ) : (
        <div
          ref={scrollRef}
          style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "8px 0" }}
        >
          {visibleItems.map((item) => {
        const session = getSession(item.data.sessionId);
        const isAsk = item.type === "ask";
        const isExpert = item.type === "expert";
        const isLaunch = item.type === "launch";
        // Haiku-inferred, not agent-reported — see auto-checkpoint.ts.
        // Flagged distinctly since it's a guess about what happened, not a
        // fact the agent stated about itself.
        const isAutoCheckpoint =
          item.type === "checkpoint" && (item.data as Checkpoint).source === "auto";
        // A launch knows its project directly; it may not have a session yet
        // (the agent registers a moment after the worktree is created).
        const project = isLaunch
          ? getProject((item.data as Launch).projectId)
          : session
            ? getProject(session.projectId)
            : null;
        const accent = isAsk
          ? theme.waiting
          : isExpert || isAutoCheckpoint
            ? theme.expert
            : isLaunch
              ? theme.running
              : theme.checkpoint;

        // Opens the session this item belongs to in Projects, where the full
        // transcript and controls live. A launch may not have a session yet
        // (the agent registers a moment after the worktree is created) — its
        // project is still worth opening.
        const openInProjects = () => {
          if (session) navigate(`/projects/s/${session.id}`);
          else if (isLaunch) navigate(`/projects/p/${(item.data as Launch).projectId}`);
        };

        // Steerable = something the human can respond to: an ask (resolve) or
        // a checkpoint (steer the session). Expert exchanges and launches are
        // records, not prompts.
        const steerable =
          (isAsk || item.type === "checkpoint") && !!item.data.sessionId;
        const canOpen = !!session || isLaunch;
        const showActions =
          hoveredId === item.data.id || replyingId === item.data.id;

        return (
          <div
            key={item.data.id}
            onMouseEnter={() => setHoveredId(item.data.id)}
            onMouseLeave={() => setHoveredId(null)}
            style={{
              position: "relative",
              display: "flex",
              gap: 12,
              padding: "9px 20px 5px",
              background: showActions ? theme.surface : "transparent",
            }}
          >
            {/* Hover action bar — Slack-style: the row itself does nothing,
                these are the only ways to act on an item. */}
            {showActions && (steerable || canOpen || isAsk) && (
              <div
                style={{
                  position: "absolute",
                  top: 2,
                  right: 16,
                  display: "flex",
                  gap: 4,
                  alignItems: "center",
                  background: theme.raised,
                  border: `1px solid ${theme.edge}`,
                  borderRadius: 7,
                  padding: "3px 4px",
                  boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
                  zIndex: 2,
                }}
              >
                {steerable &&
                  ["👍", "✅", "👀"].map((emoji) => (
                    <button
                      key={emoji}
                      onClick={() =>
                        void handleReply(
                          isAsk ? "ask" : "checkpoint",
                          item.data.id,
                          item.data.sessionId,
                          emoji
                        )
                      }
                      title={`React ${emoji} — sends it to the agent`}
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        fontSize: 15,
                        lineHeight: 1,
                        padding: "2px 3px",
                        borderRadius: 5,
                      }}
                    >
                      {emoji}
                    </button>
                  ))}
                {steerable && (
                  <button
                    onClick={() =>
                      setReplyingId((cur) => (cur === item.data.id ? null : item.data.id))
                    }
                    title="Reply / steer"
                    style={actionBtn(replyingId === item.data.id)}
                  >
                    <LuReply />
                  </button>
                )}
                {canOpen && (
                  <button onClick={openInProjects} title="Open in Projects" style={actionBtn(false)}>
                    <LuArrowUpRight />
                  </button>
                )}
                {isAsk && (
                  <button
                    onClick={() => void onDismissAsk(item.data.id)}
                    title="Dismiss without answering — the agent's wait ends as if it had timed out."
                    style={actionBtn(false)}
                  >
                    <LuX />
                  </button>
                )}
              </div>
            )}

            {/* Avatar */}
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 8,
                background: project ? `${project.emoji ? theme.running : theme.surface}1F` : theme.surface,
                border: `1px solid ${theme.edge}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 17,
                flexShrink: 0,
              }}
            >
              {isAutoCheckpoint ? <LuBot /> : (project?.emoji ?? <LuBox />)}
            </div>

            {/* Content */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "baseline",
                  flexWrap: "wrap",
                  marginBottom: 3,
                }}
              >
                <span style={{ fontSize: 14.5, fontWeight: 700, color: theme.text }}>
                  {/* Auto-checkpoints are Standup's own inference, not a
                      claim about who did the work — attributed to "System"
                      rather than falling through to "Unknown". */}
                  {isAutoCheckpoint ? "System" : (project?.name ?? "Unknown")}
                </span>
                <span
                  style={{
                    fontFamily: theme.mono,
                    fontSize: 9,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    color: theme.running,
                    border: `1px solid ${theme.running}44`,
                    borderRadius: 3,
                    padding: "1px 5px",
                  }}
                >
                  agent
                </span>
                <span style={{ fontSize: 12.5, color: theme.dim }}>
                  {session?.title ?? "Untitled"}
                </span>
                <span style={{ fontSize: 11.5, color: theme.faint }}>
                  {new Date(item.data.createdAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>

              {(isAsk || isExpert || isLaunch || isAutoCheckpoint) && (
                <div style={{ marginBottom: 5 }}>
                  <span
                    style={{
                      fontFamily: theme.mono,
                      fontSize: 9.5,
                      letterSpacing: "0.16em",
                      textTransform: "uppercase",
                      color: accent,
                      fontWeight: 600,
                    }}
                  >
                    {isAsk
                      ? "Needs you"
                      : isExpert
                        ? "Expert consulted"
                        : isAutoCheckpoint
                          ? "Auto-checkpoint"
                          : "You started this"}
                  </span>
                </div>
              )}

              {/* For a blocked ask: an at-a-glance read of why it stopped —
                  a Haiku "why it's blocked / options" summary (only when
                  auto-checkpoint is on) and the last couple of transcript
                  messages — shown above the question so you have context
                  before you answer. */}
              {isAsk && item.data.sessionId && (
                <div onClick={(e) => e.stopPropagation()}>
                  <BlockSummary askId={item.data.id} />
                  <AskContext sessionId={item.data.sessionId} />
                </div>
              )}

              {isExpert ? (
                <ExpertBody exchange={item.data as ExpertExchange} />
              ) : isLaunch ? (
                <div onClick={(e) => e.stopPropagation()}>
                  <LaunchBody
                    launch={item.data as Launch}
                    session={getSession((item.data as Launch).sessionId ?? "")}
                    onStopped={onLaunchChanged}
                  />
                </div>
              ) : (
                <Markdown>
                  {item.type === "checkpoint"
                    ? (item.data as Checkpoint).summary
                    : (item.data as Ask).question}
                </Markdown>
              )}

              {/* A prompt-ask only knows the agent is waiting; the actual
                  question is on its terminal, so show the pane inline. */}
              {isAsk && (item.data as Ask).kind === "permission_prompt" && (
                <SessionScreen sessionId={item.data.sessionId} />
              )}

              {/* Confirmation of a reply/reaction already sent, when the reply
                  box isn't open (e.g. a one-tap emoji reaction). */}
              {steerable && replies[item.data.id] && replyingId !== item.data.id && (
                <div
                  style={{
                    fontSize: 11.5,
                    color: theme.checkpoint,
                    marginTop: 5,
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <LuCheck /> you: {replies[item.data.id]}
                </div>
              )}

              {/* The reply box, revealed by the hover bar's 💬 action. */}
              {steerable && replyingId === item.data.id && (
                <div style={{ marginTop: 6 }}>
                  <Replier
                    target={isAsk ? "ask" : "checkpoint"}
                    options={isAsk ? (item.data as Ask).options : undefined}
                    reply={replies[item.data.id]}
                    onReply={(body) =>
                      handleReply(
                        isAsk ? "ask" : "checkpoint",
                        item.data.id,
                        item.data.sessionId,
                        body
                      )
                    }
                  />
                </div>
              )}
            </div>
          </div>
        );
          })}
        </div>
      )}

      <Composer projects={projects} onLaunch={onLaunch} />
    </div>
  );
}

/**
 * The last couple of real messages from a blocked session's transcript —
 * quick context on what the agent was doing when it stopped to ask, so you
 * can answer without opening the full session. Read-only; a failure just
 * renders nothing.
 */
function AskContext({ sessionId }: { sessionId: string }) {
  const [msgs, setMsgs] = useState<{ role: string; text: string }[] | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/sessions/${sessionId}/transcript?limit=6`)
      .then((r) => (r.ok ? r.json() : null))
      .then((page) => {
        if (!alive || !page) return;
        const recent = (page.messages ?? [])
          .filter((m: { text?: string }) => m.text?.trim())
          .slice(-3)
          .map((m: { role: string; text: string }) => ({ role: m.role, text: m.text }));
        setMsgs(recent);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [sessionId]);

  if (!msgs || msgs.length === 0) return null;

  return (
    <div
      style={{
        background: theme.ground,
        border: `1px solid ${theme.edgeSoft}`,
        borderRadius: 6,
        padding: "8px 10px",
        margin: "6px 0",
        maxHeight: 150,
        overflowY: "auto",
      }}
    >
      {msgs.map((m, i) => (
        <div
          key={i}
          style={{
            fontSize: 12,
            lineHeight: 1.5,
            color: theme.dim,
            marginBottom: i === msgs.length - 1 ? 0 : 6,
          }}
        >
          <span
            style={{
              fontWeight: 600,
              color: m.role === "user" ? theme.faint : theme.checkpoint,
            }}
          >
            {m.role === "user" ? "you: " : "claude: "}
          </span>
          {m.text.length > 240 ? `${m.text.slice(0, 240)}…` : m.text}
        </div>
      ))}
    </div>
  );
}

/**
 * A cheap-model summary of why a session is blocked and what the options are.
 * Only present when auto-checkpoint is on — the endpoint returns null (and
 * spends no model call) otherwise — so this quietly renders nothing when off.
 */
function BlockSummary({ askId }: { askId: string }) {
  const [summary, setSummary] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/asks/${askId}/explain`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d?.summary) setSummary(d.summary);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [askId]);

  if (!summary) return null;

  return (
    <div
      style={{
        background: theme.surface,
        border: `1px solid ${theme.edgeSoft}`,
        borderLeft: `3px solid ${theme.expert}`,
        borderRadius: 6,
        padding: "8px 11px",
        margin: "6px 0",
      }}
    >
      <div
        style={{
          fontFamily: theme.mono,
          fontSize: 9,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: theme.expert,
          fontWeight: 600,
          marginBottom: 4,
          display: "flex",
          alignItems: "center",
          gap: 5,
        }}
      >
        <LuBot /> why it's blocked
      </div>
      <Markdown>{summary}</Markdown>
    </div>
  );
}
