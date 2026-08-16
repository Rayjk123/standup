import { useNavigate } from "react-router-dom";
import type { Ask, Session, Project } from "@standup/shared";

interface AlertStripProps {
  pendingAsks: Ask[];
  sessions: Session[];
  projects: Project[];
}

function formatQuiet(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

export function AlertStrip({
  pendingAsks,
  sessions,
  projects,
}: AlertStripProps) {
  const navigate = useNavigate();
  if (pendingAsks.length === 0) {
    return (
      <div className="flex items-center gap-[9px] border-b border-edge-soft px-5 py-[7px]">
        <span className="h-1.5 w-1.5 rounded-full bg-checkpoint" />
        <span className="text-[12.5px] text-faint">
          Nothing blocked. Every agent is moving.
        </span>
      </div>
    );
  }

  // Find projects with blocked sessions
  const blockedProjectIds = new Set(
    pendingAsks.map((a) => {
      const session = sessions.find((s) => s.id === a.sessionId);
      return session?.projectId;
    })
  );
  const blockedProjects = projects.filter((p) => blockedProjectIds.has(p.id));

  // Find oldest blocked time
  const oldestAsk = pendingAsks.reduce((oldest, ask) => {
    return ask.createdAt < oldest.createdAt ? ask : oldest;
  });
  const oldestSeconds = Math.floor(
    (Date.now() - new Date(oldestAsk.createdAt).getTime()) / 1000
  );

  return (
    <button
      onClick={() => navigate("/blocked")}
      className="flex w-full items-center gap-2.5 border-none border-b border-waiting/[27%] bg-waiting/[7%] px-5 py-[9px] text-left cursor-pointer"
    >
      <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-waiting" />
      <span className="text-sm font-semibold text-text">
        {pendingAsks.length} agent{pendingAsks.length > 1 ? "s" : ""} waiting on
        you
      </span>
      <span className="flex gap-1">
        {blockedProjects.map((p) => (
          <span key={p.id} className="text-sm">
            {p.emoji}
          </span>
        ))}
      </span>
      <span className="text-[12.5px] text-dim">
        oldest blocked {formatQuiet(oldestSeconds)}
      </span>
      <span className="flex-1" />
      <span className="text-[12.5px] font-semibold text-waiting">
        Review →
      </span>
    </button>
  );
}
