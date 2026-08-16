import { Routes, Route, Navigate, NavLink, useLocation } from "react-router-dom";
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
import { BlockedView } from "./BlockedView";
import { ProjectsView } from "./ProjectsView";
import { AlertStrip } from "./AlertStrip";
import { AutoCheckpointToggle } from "./AutoCheckpointToggle";

const VIEWS = ["feed", "blocked", "projects"] as const;

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
}: ConsoleProps) {
  // The alert strip is hidden on Blocked, which is the one place it would be
  // redundant. Read from the route rather than tracked separately.
  const onBlockedView = useLocation().pathname.startsWith("/blocked");

  const pendingAsks = asks.filter((a) => a.status === "pending");
  const stalledSessions = sessions.filter((s) => s.status === "stalled");

  return (
    // A hard height (not min-h) plus overflow-hidden is what makes the top
    // bar and alert strip genuinely stay put — anything taller than the
    // viewport has to scroll inside "Main content" below, never the
    // document itself. min-h let the whole page grow instead, so the
    // header scrolled away with everything else.
    <div className="flex h-screen flex-col overflow-hidden bg-ground text-text">
      {/* Top bar */}
      <div className="flex items-center gap-4 border-b border-edge bg-surface px-4 py-[11px]">
        <div className="font-mono text-xs font-semibold uppercase tracking-[0.2em]">
          Standup
        </div>
        <div className="flex gap-[13px] text-[12.5px] text-dim">
          <span>
            <span className="font-semibold text-text">{sessions.length}</span> agents
          </span>
          {stalledSessions.length > 0 && (
            <span className="text-stalled">{stalledSessions.length} stalled</span>
          )}
        </div>
        <div className="flex-1" />
        <AutoCheckpointToggle />
        <div className="flex gap-0.5">
          {VIEWS.map((v) => (
            <NavLink
              key={v}
              to={`/${v}`}
              className={({ isActive }) =>
                `flex items-center gap-1.5 rounded-md px-3 py-[5px] text-[12.5px] font-semibold capitalize no-underline ${
                  isActive ? "bg-raised text-text" : "bg-transparent text-faint"
                }`
              }
            >
              {v}
              {v === "blocked" && pendingAsks.length > 0 && (
                <span className="rounded-lg bg-waiting px-1.5 py-px font-mono text-[9.5px] font-bold text-ground">
                  {pendingAsks.length}
                </span>
              )}
            </NavLink>
          ))}
        </div>
      </div>

      {/* Redundant on Blocked, which already lists everything it summarizes */}
      {!onBlockedView && (
        <AlertStrip pendingAsks={pendingAsks} sessions={sessions} projects={projects} />
      )}

      {/* Main content */}
      <div className="flex-1 overflow-hidden">
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
                onDismissAsk={onDismissAsk}
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
                launches={launches}
                onSaveProject={onSaveProject}
                onDeleteProject={onDeleteProject}
                onSessionChanged={onSessionChanged}
                onLaunch={onLaunch}
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
