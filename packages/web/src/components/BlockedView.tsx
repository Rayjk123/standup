import { useState } from "react";
import type { Ask, Session, Project } from "@standup/shared";
import { theme } from "./theme";

interface BlockedViewProps {
  asks: Ask[];
  sessions: Session[];
  projects: Project[];
  onResolveAsk: (askId: string, answer: string) => Promise<void>;
  onGoToFeed: () => void;
}

export function BlockedView({
  asks,
  sessions,
  projects,
  onResolveAsk,
  onGoToFeed,
}: BlockedViewProps) {
  const [resolving, setResolving] = useState<string | null>(null);

  const getSession = (sessionId: string) =>
    sessions.find((s) => s.id === sessionId);
  const getProject = (projectId: string) =>
    projects.find((p) => p.id === projectId);

  const handleResolve = async (askId: string, answer: string) => {
    setResolving(askId);
    try {
      await onResolveAsk(askId, answer);
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
          <button
            onClick={onGoToFeed}
            style={{
              marginTop: 12,
              background: "none",
              border: `1px solid ${theme.edge}`,
              borderRadius: 6,
              padding: "7px 14px",
              cursor: "pointer",
              fontSize: 12.5,
              color: theme.dim,
            }}
          >
            Back to the feed
          </button>
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
        Each of these agents is paused inside a tool call. Answering resumes it
        immediately.
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

                {ask.options && (
                  <div
                    style={{
                      display: "flex",
                      gap: 7,
                      marginTop: 11,
                      flexWrap: "wrap",
                    }}
                  >
                    {ask.options.map((opt) => (
                      <button
                        key={opt}
                        onClick={() => handleResolve(ask.id, opt)}
                        disabled={isResolving}
                        style={{
                          fontSize: 12.5,
                          fontWeight: 500,
                          color: theme.text,
                          background: theme.raised,
                          border: `1px solid ${theme.edge}`,
                          borderRadius: 5,
                          padding: "7px 13px",
                          cursor: isResolving ? "not-allowed" : "pointer",
                        }}
                      >
                        {opt}
                      </button>
                    ))}
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
