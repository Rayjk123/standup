import { Routes, Route, Navigate, NavLink, useLocation } from "react-router-dom";
import type {
  Session,
  Project,
  Checkpoint,
  Ask,
  ExpertExchange,
  Launch,
  ProjectWithCounts,
} from "@standup/shared";
import { FeedView } from "./FeedView";
import { BlockedView } from "./BlockedView";
import { ProjectsView } from "./ProjectsView";
import { AlertStrip } from "./AlertStrip";
import { theme } from "./theme";

const VIEWS = ["feed", "blocked", "projects"] as const;

interface ConsoleProps {
  projects: ProjectWithCounts[];
  sessions: Session[];
  checkpoints: Checkpoint[];
  asks: Ask[];
  expertExchanges: ExpertExchange[];
  launches: Launch[];
  onResolveAsk: (askId: string, answer: string) => Promise<{ error?: string }>;
  onSteer: (sessionId: string, body: string) => Promise<void>;
  onLaunch: (projectId: string, task: string) => Promise<{ error?: string }>;
  onSaveProject: (
    id: string | null,
    patch: Partial<Project>
  ) => Promise<{ error?: string }>;
  onDeleteProject: (id: string) => Promise<{ error?: string }>;
  onLaunchChanged: () => void;
  onSessionChanged: () => void;
  lastEvent: { sessionId: string; n: number };
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
  lastEvent,
}: ConsoleProps) {
  // The alert strip is hidden on Blocked, which is the one place it would be
  // redundant. Read from the route rather than tracked separately.
  const onBlockedView = useLocation().pathname.startsWith("/blocked");

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
          {VIEWS.map((v) => (
            <NavLink
              key={v}
              to={`/${v}`}
              style={({ isActive }) => ({
                fontSize: 12.5,
                fontWeight: 600,
                padding: "5px 12px",
                borderRadius: 5,
                textDecoration: "none",
                background: isActive ? theme.raised : "transparent",
                color: isActive ? theme.text : theme.faint,
                display: "flex",
                alignItems: "center",
                gap: 6,
                textTransform: "capitalize",
              })}
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
            </NavLink>
          ))}
        </div>
      </div>

      {/* Redundant on Blocked, which already lists everything it summarizes */}
      {!onBlockedView && (
        <AlertStrip
          pendingAsks={pendingAsks}
          sessions={sessions}
          projects={projects}
        />
      )}

      {/* Main content */}
      <div style={{ flex: 1, overflow: "hidden" }}>
        <Routes>
          <Route path="/" element={<Navigate to="/feed" replace />} />
          <Route
            path="/feed"
            element={
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
            }
          />
          <Route
            path="/blocked"
            element={
              <BlockedView
                asks={pendingAsks}
                sessions={sessions}
                projects={projects}
                onResolveAsk={onResolveAsk}
              />
            }
          />
          {/* Both project and session selection live in the path so they
              survive a refresh, with distinct prefixes so a project id and a
              session id can never be confused for one another. */}
          <Route
            path="/projects/:kind?/:selectedId?"
            element={
              <ProjectsView
                projects={projects}
                sessions={sessions}
                checkpoints={checkpoints}
                onSaveProject={onSaveProject}
                onDeleteProject={onDeleteProject}
                onSessionChanged={onSessionChanged}
                lastEvent={lastEvent}
              />
            }
          />
          <Route path="*" element={<Navigate to="/feed" replace />} />
        </Routes>
      </div>
    </div>
  );
}
