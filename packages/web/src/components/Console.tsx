import { useState } from "react";
import type {
  Session,
  Project,
  Checkpoint,
  Ask,
  ExpertExchange,
  Launch,
} from "@standup/shared";
import { FeedView } from "./FeedView";
import { BlockedView } from "./BlockedView";
import { ProjectsView } from "./ProjectsView";
import { AlertStrip } from "./AlertStrip";
import { theme } from "./theme";

type View = "feed" | "blocked" | "projects";

interface ConsoleProps {
  projects: Project[];
  sessions: Session[];
  checkpoints: Checkpoint[];
  asks: Ask[];
  expertExchanges: ExpertExchange[];
  launches: Launch[];
  onResolveAsk: (askId: string, answer: string) => Promise<void>;
  onSteer: (sessionId: string, body: string) => Promise<void>;
  onLaunch: (projectId: string, task: string) => Promise<{ error?: string }>;
  onSaveProject: (
    id: string | null,
    patch: Partial<Project>
  ) => Promise<{ error?: string }>;
  onDeleteProject: (id: string) => Promise<{ error?: string }>;
  onLaunchChanged: () => void;
  onSessionChanged: () => void;
}

export function Console({
  projects,
  sessions,
  checkpoints,
  asks,
  expertExchanges,
  launches,
  onResolveAsk,
  onSteer,
  onLaunch,
  onSaveProject,
  onDeleteProject,
  onLaunchChanged,
  onSessionChanged,
}: ConsoleProps) {
  const [view, setView] = useState<View>("feed");

  const pendingAsks = asks.filter((a) => a.status === "pending");
  const stalledSessions = sessions.filter((s) => s.status === "stalled");

  return (
    <div
      style={{
        background: theme.ground,
        color: theme.text,
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Top bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "11px 16px",
          borderBottom: `1px solid ${theme.edge}`,
          background: theme.surface,
        }}
      >
        <div
          style={{
            fontFamily: theme.mono,
            fontSize: 12,
            letterSpacing: "0.2em",
            textTransform: "uppercase",
            fontWeight: 600,
          }}
        >
          Standup
        </div>
        <div
          style={{
            display: "flex",
            gap: 13,
            fontSize: 12.5,
            color: theme.dim,
          }}
        >
          <span>
            <span style={{ color: theme.text, fontWeight: 600 }}>
              {sessions.length}
            </span>{" "}
            agents
          </span>
          {stalledSessions.length > 0 && (
            <span style={{ color: theme.stalled }}>
              {stalledSessions.length} stalled
            </span>
          )}
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", gap: 2 }}>
          {(["feed", "blocked", "projects"] as View[]).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                padding: "5px 12px",
                borderRadius: 5,
                border: "none",
                cursor: "pointer",
                background: view === v ? theme.raised : "transparent",
                color: view === v ? theme.text : theme.faint,
                display: "flex",
                alignItems: "center",
                gap: 6,
                textTransform: "capitalize",
              }}
            >
              {v}
              {v === "blocked" && pendingAsks.length > 0 && (
                <span
                  style={{
                    fontFamily: theme.mono,
                    fontSize: 9.5,
                    background: theme.waiting,
                    color: theme.ground,
                    borderRadius: 8,
                    padding: "1px 6px",
                    fontWeight: 700,
                  }}
                >
                  {pendingAsks.length}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Alert strip (not shown on blocked view) */}
      {view !== "blocked" && (
        <AlertStrip
          pendingAsks={pendingAsks}
          sessions={sessions}
          projects={projects}
          onGoToBlocked={() => setView("blocked")}
        />
      )}

      {/* Main content */}
      <div style={{ flex: 1, overflow: "hidden" }}>
        {view === "feed" && (
          <FeedView
            checkpoints={checkpoints}
            asks={asks}
            expertExchanges={expertExchanges}
            launches={launches}
            sessions={sessions}
            projects={projects}
            onSteer={onSteer}
            onResolveAsk={onResolveAsk}
            onLaunch={onLaunch}
            onLaunchChanged={onLaunchChanged}
          />
        )}
        {view === "blocked" && (
          <BlockedView
            asks={pendingAsks}
            sessions={sessions}
            projects={projects}
            onResolveAsk={onResolveAsk}
            onGoToFeed={() => setView("feed")}
          />
        )}
        {view === "projects" && (
          <ProjectsView
            projects={projects}
            sessions={sessions}
            checkpoints={checkpoints}
            onSaveProject={onSaveProject}
            onDeleteProject={onDeleteProject}
            onSessionChanged={onSessionChanged}
          />
        )}
      </div>
    </div>
  );
}
