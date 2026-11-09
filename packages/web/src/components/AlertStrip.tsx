import { useNavigate } from "react-router-dom";
import { LuArrowRight } from "react-icons/lu";
import type { Ask, Session, Project } from "@standup/shared";
import { alpha, theme } from "./theme";
import { ProjectIcon } from "./ProjectIcon";
import { usePresence } from "../hooks/presence";
import { answerableSession, responsibleActor, isMyResponsibility } from "../lib/attribution";
import { liveWorkersPath } from "../lib/liveWorkers";

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

/** Icons of the projects a set of asks is blocked in, de-duped and stable. */
function blockedProjectsFor(
  asks: Ask[],
  sessionById: Map<string, Session>,
  projects: Project[]
): Project[] {
  const ids = new Set(
    asks.map((a) => sessionById.get(a.sessionId)?.projectId)
  );
  return projects.filter((p) => ids.has(p.id));
}

/**
 * A soft, non-alarming roll-up of asks that are someone else's to answer —
 * grouped by the responsible alias so the current user sees "waiting on alice,
 * bob (2)" rather than an alarm meant for them. Falls back to "someone" for the
 * (defensive) case of an ask with no resolvable owner, which normally routes to
 * everyone's alarm instead.
 */
function summarizeOthers(
  asks: Ask[],
  sessionById: Map<string, Session>
): string {
  const counts = new Map<string, number>();
  for (const a of asks) {
    const who = responsibleActor(answerableSession(a.sessionId, sessionById)) ?? "someone";
    counts.set(who, (counts.get(who) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([who, n]) => (n > 1 ? `${who} (${n})` : who))
    .join(", ");
}

export function AlertStrip({
  pendingAsks,
  sessions,
  projects,
}: AlertStripProps) {
  const navigate = useNavigate();
  const { currentUser } = usePresence();

  const sessionById = new Map(sessions.map((s) => [s.id, s]));

  // Route each blocked/ask event to the human answerable for it (owner →
  // creator → participant). Only asks I'm responsible for fire my alarm; the
  // rest render as a soft "waiting on <alias>" so a teammate's block isn't
  // dressed up as mine.
  const mine: Ask[] = [];
  const others: Ask[] = [];
  for (const a of pendingAsks) {
    (isMyResponsibility(answerableSession(a.sessionId, sessionById), currentUser)
      ? mine
      : others
    ).push(a);
  }

  if (mine.length === 0 && others.length === 0) {
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

  const softStrip =
    others.length > 0 ? (
      <div
        style={{
          padding: "6px 20px",
          borderBottom: `1px solid ${theme.edgeSoft}`,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 6,
            background: theme.dim,
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: 12.5, color: theme.faint }}>
          Waiting on {summarizeOthers(others, sessionById)}
        </span>
      </div>
    ) : null;

  if (mine.length === 0) {
    // Everything blocked belongs to someone else — no alarm, just the soft note.
    return softStrip;
  }

  const oldestAsk = mine.reduce((oldest, ask) =>
    ask.createdAt < oldest.createdAt ? ask : oldest
  );
  const oldestSeconds = Math.floor(
    (Date.now() - new Date(oldestAsk.createdAt).getTime()) / 1000
  );
  const blockedProjects = blockedProjectsFor(mine, sessionById, projects);

  return (
    <>
      <button
        // The oldest block's session, opened on its transcript, which answers its ask.
        onClick={() => navigate(liveWorkersPath({ kind: "s", id: oldestAsk.sessionId }), { state: { answer: true } })}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "9px 20px",
          background: alpha(theme.waiting, 0x12),
          border: "none",
          borderBottom: `1px solid ${alpha(theme.waiting, 0x44)}`,
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
          {mine.length} agent{mine.length > 1 ? "s" : ""} waiting on you
        </span>
        <span style={{ display: "flex", gap: 4 }}>
          {blockedProjects.map((p) => (
            <span key={p.id} style={{ fontSize: 13, display: "inline-flex" }}>
              <ProjectIcon project={p} size={13} />
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
      {softStrip}
    </>
  );
}
