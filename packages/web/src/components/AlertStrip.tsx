import { useNavigate } from "react-router-dom";
import { LuArrowRight } from "react-icons/lu";
import type { Ask, Session, Project } from "@standup/shared";
import { theme } from "./theme";

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
      <div
        style={{
          padding: "7px 20px",
          borderBottom: `1px solid ${theme.edgeSoft}`,
          display: "flex",
          alignItems: "center",
          gap: 9,
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 6,
            background: theme.checkpoint,
          }}
        />
        <span style={{ fontSize: 12.5, color: theme.faint }}>
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
      onClick={() => navigate("/feed?filter=blocked")}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "9px 20px",
        background: `${theme.waiting}12`,
        border: "none",
        borderBottom: `1px solid ${theme.waiting}44`,
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: 7,
          background: theme.waiting,
          flexShrink: 0,
          animation: "pulse 2s ease-in-out infinite",
        }}
      />
      <span style={{ fontSize: 13, fontWeight: 600, color: theme.text }}>
        {pendingAsks.length} agent{pendingAsks.length > 1 ? "s" : ""} waiting on
        you
      </span>
      <span style={{ display: "flex", gap: 4 }}>
        {blockedProjects.map((p) => (
          <span key={p.id} style={{ fontSize: 13 }}>
            {p.emoji}
          </span>
        ))}
      </span>
      <span style={{ fontSize: 12.5, color: theme.dim }}>
        oldest blocked {formatQuiet(oldestSeconds)}
      </span>
      <span style={{ flex: 1 }} />
      <span
        style={{
          fontSize: 12.5,
          color: theme.waiting,
          fontWeight: 600,
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
        }}
      >
        Review <LuArrowRight />
      </span>
    </button>
  );
}
