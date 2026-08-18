import { Routes, Route, Navigate, NavLink } from "react-router-dom";
import type {
  Session,
  Project,
  Checkpoint,
  Ask,
  ExpertExchange,
  Launch,
  ProjectWithCounts,
  ClaudeEffort,
  ClaudeModel,
} from "@standup/shared";
import { FeedView } from "./FeedView";
import { ProjectsView } from "./ProjectsView";
import { AlertStrip } from "./AlertStrip";
import { AutoCheckpointToggle } from "./AutoCheckpointToggle";
import { theme } from "./theme";

const VIEWS = ["feed", "projects"] as const;

interface ConsoleProps {
  projects: ProjectWithCounts[];
  sessions: Session[];
  checkpoints: Checkpoint[];
  asks: Ask[];
  expertExchanges: ExpertExchange[];
  launches: Launch[];
  onResolveAsk: (askId: string, answer: string) => Promise<{ error?: string }>;
  onDismissAsk: (askId: string) => Promise<{ error?: string }>;
  onSteer: (sessionId: string, body: string) => Promise<void>;
  onLaunch: (
    projectId: string,
    task: string,
    model?: ClaudeModel,
    effort?: ClaudeEffort
  ) => Promise<{ error?: string }>;
  onSaveProject: (
    id: string | null,
    patch: Partial<Project>
  ) => Promise<{ error?: string }>;
  onDeleteProject: (id: string) => Promise<{ error?: string }>;
  onLaunchChanged: () => void;
  onSessionChanged: () => void;
  lastEvent: { sessionId: string; n: number };
  draftSignal: { projectId: string; n: number };
}

export function Console({
  projects,
  sessions,
  checkpoints,
  asks,
  expertExchanges,
  launches,
  onResolveAsk,
  onDismissAsk,
  onSteer,
  onLaunch,
  onSaveProject,
  onDeleteProject,
  onLaunchChanged,
  onSessionChanged,
  lastEvent,
  draftSignal,
}: ConsoleProps) {
  const pendingAsks = asks.filter((a) => a.status === "pending");
  const stalledSessions = sessions.filter((s) => s.status === "stalled");

  return (
    <div
      style={{
        background: theme.ground,
        color: theme.text,
        // A hard height (not minHeight) plus overflow hidden is what makes
        // the top bar and alert strip genuinely stay put — anything taller
        // than the viewport has to scroll inside "Main content" below,
        // never the document itself. minHeight let the whole page grow
        // instead, so the header scrolled away with everything else.
        height: "100vh",
        overflow: "hidden",
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
        <AutoCheckpointToggle />
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
            </NavLink>
          ))}
        </div>
      </div>

      <AlertStrip
        pendingAsks={pendingAsks}
        sessions={sessions}
        projects={projects}
      />

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
                onDismissAsk={onDismissAsk}
                onLaunch={onLaunch}
                onLaunchChanged={onLaunchChanged}
              />
            }
          />
          {/* /blocked is gone — it's a filter on the feed now. Redirect any
              old links (e.g. the alert strip's) to the filtered feed. */}
          <Route path="/blocked" element={<Navigate to="/feed?filter=blocked" replace />} />
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
                launches={launches}
                onSaveProject={onSaveProject}
                onDeleteProject={onDeleteProject}
                onSessionChanged={onSessionChanged}
                onLaunch={onLaunch}
                lastEvent={lastEvent}
                draftSignal={draftSignal}
              />
            }
          />
          <Route path="*" element={<Navigate to="/feed" replace />} />
        </Routes>
      </div>
    </div>
  );
}
