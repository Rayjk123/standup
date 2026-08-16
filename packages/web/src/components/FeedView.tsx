import { useState } from "react";
import type { Checkpoint, Ask, Session, Project, ExpertExchange } from "@standup/shared";
import { theme } from "./theme";
import { Replier } from "./Replier";
import { Composer } from "./Composer";

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
        <div
          style={{
            fontFamily: theme.mono,
            fontSize: 11.5,
            lineHeight: 1.55,
            color: theme.text,
            whiteSpace: "pre-wrap",
            maxHeight: 260,
            overflowY: "auto",
          }}
        >
          {exchange.answer}
        </div>
      </div>
    </>
  );
}

interface FeedViewProps {
  checkpoints: Checkpoint[];
  asks: Ask[];
  expertExchanges: ExpertExchange[];
  sessions: Session[];
  projects: Project[];
  onSteer: (sessionId: string, body: string) => Promise<void>;
  onResolveAsk: (askId: string, answer: string) => Promise<void>;
  onLaunch: (projectId: string, task: string) => Promise<{ error?: string }>;
}

export function FeedView({
  checkpoints,
  asks,
  expertExchanges,
  sessions,
  projects,
  onSteer,
  onResolveAsk,
  onLaunch,
}: FeedViewProps) {
  // What the human has sent this session, keyed by feed item id. Optimistic:
  // asks disappear from `asks` once resolved server-side, so without this the
  // confirmation would vanish the instant it succeeded.
  const [replies, setReplies] = useState<Record<string, string>>({});

  // The merged feed carries checkpoints, asks, and expert exchanges — never
  // raw tool calls. That separation is enforced here, at the query, not in
  // the rendering: an activity tier that reaches this array has already
  // made the feed unreadable.
  type FeedItem =
    | { type: "checkpoint"; data: Checkpoint }
    | { type: "ask"; data: Ask }
    | { type: "expert"; data: ExpertExchange };

  const feedItems: FeedItem[] = [
    ...checkpoints.map((c) => ({ type: "checkpoint" as const, data: c })),
    ...asks.map((a) => ({ type: "ask" as const, data: a })),
    ...expertExchanges.map((e) => ({ type: "expert" as const, data: e })),
  ].sort(
    (a, b) =>
      new Date(b.data.createdAt).getTime() -
      new Date(a.data.createdAt).getTime()
  );

  const getSession = (sessionId: string) =>
    sessions.find((s) => s.id === sessionId);
  const getProject = (projectId: string) =>
    projects.find((p) => p.id === projectId);

  // Column layout so the composer stays pinned below a scrolling feed
  // rather than scrolling away with it.
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {feedItems.length === 0 ? (
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
          <div style={{ fontSize: 30, marginBottom: 10 }}>📭</div>
          <div style={{ fontSize: 14 }}>No activity yet.</div>
          <div style={{ fontSize: 12.5, color: theme.faint, marginTop: 4 }}>
            Checkpoints and asks from agents will appear here — or start work below.
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "8px 0" }}>
          {feedItems.map((item) => {
        const session = getSession(item.data.sessionId);
        const project = session ? getProject(session.projectId) : null;
        const isAsk = item.type === "ask";
        const isExpert = item.type === "expert";
        const accent = isAsk
          ? theme.waiting
          : isExpert
            ? theme.expert
            : theme.checkpoint;

        return (
          <div
            key={item.data.id}
            style={{
              display: "flex",
              gap: 12,
              padding: "9px 20px 5px",
            }}
          >
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
              {project?.emoji ?? "📦"}
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
                  {project?.name ?? "Unknown"}
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

              {(isAsk || isExpert) && (
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
                    {isAsk ? "Needs you" : "Expert consulted"}
                  </span>
                </div>
              )}

              {isExpert ? (
                <ExpertBody exchange={item.data as ExpertExchange} />
              ) : (
                <div style={{ fontSize: 14, lineHeight: 1.55, color: theme.text }}>
                  {item.type === "checkpoint"
                    ? (item.data as Checkpoint).summary
                    : (item.data as Ask).question}
                </div>
              )}

              {/* Expert exchanges are a record of what the agent asked and
                  got back — there's no counterpart action for the human, so
                  no reply affordance. */}
              {!isExpert && (
                <Replier
                  target={isAsk ? "ask" : "checkpoint"}
                  options={isAsk ? (item.data as Ask).options : undefined}
                  reply={replies[item.data.id]}
                  onReply={async (body) => {
                    if (isAsk) {
                      await onResolveAsk(item.data.id, body);
                    } else {
                      await onSteer(item.data.sessionId, body);
                    }
                    setReplies((prev) => ({ ...prev, [item.data.id]: body }));
                  }}
                />
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
