import { useState } from "react";
import type { Ask, Session, Project } from "@standup/shared";
import { theme } from "./theme";
import { Link } from "react-router-dom";
import { Replier } from "./Replier";
import { SessionScreen } from "./SessionScreen";

interface BlockedViewProps {
  asks: Ask[];
  sessions: Session[];
  projects: Project[];
  onResolveAsk: (askId: string, answer: string) => Promise<{ error?: string }>;
}

export function BlockedView({
  asks,
  sessions,
  projects,
  onResolveAsk,
}: BlockedViewProps) {
  const [resolving, setResolving] = useState<string | null>(null);
  // Resolving can legitimately fail — answering a prompt-ask for a monitored
  // session is refused, and a launched session's pane may have exited.
  // Swallowing that made a failed reply look like a dead button.
  const [errors, setErrors] = useState<Record<string, string>>({});

  const getSession = (sessionId: string) =>
    sessions.find((s) => s.id === sessionId);
  const getProject = (projectId: string) =>
    projects.find((p) => p.id === projectId);

  const handleResolve = async (askId: string, answer: string) => {
    setResolving(askId);
    setErrors((prev) => ({ ...prev, [askId]: "" }));
    try {
      const result = await onResolveAsk(askId, answer);
      if (result?.error) {
        setErrors((prev) => ({ ...prev, [askId]: result.error! }));
      }
    } catch (err) {
      setErrors((prev) => ({ ...prev, [askId]: (err as Error).message }));
    } finally {
      setResolving(null);
    }
  };

  if (asks.length === 0) {
    return (
      <div style={{ padding: "22px 20px 30px" }}>
        <div style={{ marginBottom: 4 }}>
          <span style={{ fontSize: 19, fontWeight: 700 }}>Waiting on you</span>
        </div>
        <div style={{ fontSize: 13, color: theme.dim, marginBottom: 20 }}>
          Nothing here. Every agent has what it needs.
        </div>
        <div
          style={{
            border: `1px dashed ${theme.edge}`,
            borderRadius: 8,
            padding: "36px 20px",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 30, marginBottom: 10 }}>🌤️</div>
          <div style={{ fontSize: 14, color: theme.dim }}>Queue clear.</div>
          <Link
            to="/feed"
            style={{
              display: "inline-block",
              marginTop: 12,
              border: `1px solid ${theme.edge}`,
              borderRadius: 6,
              padding: "7px 14px",
              fontSize: 12.5,
              color: theme.dim,
              textDecoration: "none",
            }}
          >
            Back to the feed
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: "22px 20px 30px", overflowY: "auto", maxHeight: "calc(100vh - 100px)" }}>
      <div style={{ marginBottom: 4 }}>
        <span style={{ fontSize: 19, fontWeight: 700 }}>Waiting on you</span>
      </div>
      <div style={{ fontSize: 13, color: theme.dim, marginBottom: 20 }}>
        {/* Two different kinds of blocked: an ask_human is genuinely paused
            inside a tool call, while a prompt-ask is sitting on a dialog in
            its terminal. Saying only the former was misleading. */}
        Each of these agents is waiting on you — paused inside a tool call, or
        sitting on a prompt in its terminal. Answering resumes it.
      </div>

      <div style={{ display: "grid", gap: 12 }}>
        {asks.map((ask) => {
          const session = getSession(ask.sessionId);
          const project = session ? getProject(session.projectId) : null;
          const isResolving = resolving === ask.id;

          return (
            <div
              key={ask.id}
              style={{
                background: theme.surface,
                border: `1px solid ${theme.waiting}44`,
                borderRadius: 9,
                padding: "15px 17px",
                display: "flex",
                gap: 13,
                opacity: isResolving ? 0.6 : 1,
              }}
            >
              {/* Avatar */}
              <div
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 8,
                  background: `${theme.running}1F`,
                  border: `1px solid ${theme.running}55`,
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
                    marginBottom: 4,
                  }}
                >
                  <span style={{ fontSize: 14.5, fontWeight: 700 }}>
                    {project?.name ?? "Unknown"}
                  </span>
                  <span style={{ fontSize: 12.5, color: theme.dim }}>
                    {session?.title ?? "Untitled"}
                  </span>
                  <span style={{ flex: 1 }} />
                  <span
                    style={{
                      fontFamily: theme.mono,
                      fontSize: 11,
                      color: theme.waiting,
                    }}
                  >
                    blocked{" "}
                    {Math.floor(
                      (Date.now() - new Date(ask.createdAt).getTime()) / 60000
                    )}
                    m
                  </span>
                </div>

                <div style={{ fontSize: 14, lineHeight: 1.55, color: theme.text }}>
                  {ask.question}
                </div>

                {/* An ask_human carries its own question. A prompt-ask only
                    knows that the agent is waiting, so the screen is the
                    only place the actual question exists. */}
                {ask.kind === "permission_prompt" && (
                  <SessionScreen sessionId={ask.sessionId} />
                )}

                {/* Shared with the feed so both paths handle option-less
                    asks identically — this view previously rendered nothing
                    at all when an ask had no predefined options. */}
                <Replier
                  target="ask"
                  options={ask.options}
                  onReply={(answer) => handleResolve(ask.id, answer)}
                />

                {errors[ask.id] && (
                  <div
                    style={{
                      fontFamily: theme.mono,
                      fontSize: 11,
                      color: theme.waiting,
                      marginTop: 9,
                      lineHeight: 1.5,
                    }}
                  >
                    {errors[ask.id]}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
