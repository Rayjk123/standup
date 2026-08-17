import { useState, useEffect, useCallback } from "react";
import { Console } from "./components/Console";
import { useWebSocket } from "./hooks/useWebSocket";
import type {
  Session,
  Checkpoint,
  Ask,
  ExpertExchange,
  Launch,
  ProjectWithCounts,
  WsMessage,
} from "@standup/shared";

export default function App() {
  const [projects, setProjects] = useState<ProjectWithCounts[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [asks, setAsks] = useState<Ask[]>([]);
  const [expertExchanges, setExpertExchanges] = useState<ExpertExchange[]>([]);
  const [launches, setLaunches] = useState<Launch[]>([]);
  // Which session last produced a hook event, and a counter so repeated
  // events for the same session still trigger a refresh. Lets a transcript
  // update as events arrive instead of on a timer.
  const [lastEvent, setLastEvent] = useState<{ sessionId: string; n: number }>({
    sessionId: "",
    n: 0,
  });
  // Same shape as lastEvent, but for knowledge:draft — lets the Knowledge
  // tab's draft list fill in live while a bootstrap run is in progress
  // instead of only on next mount.
  const [draftSignal, setDraftSignal] = useState<{ projectId: string; n: number }>({
    projectId: "",
    n: 0,
  });
  const [loading, setLoading] = useState(true);

  // `all=1` includes ended sessions. They're needed in the Projects tab so
  // their stored rows can be reviewed and cleaned up — an ended session that
  // never appears can never be deleted.
  const refreshSessions = () =>
    fetch("/api/sessions?all=1")
      .then((r) => r.json())
      .then(setSessions)
      .catch(() => {});

  const refreshAsks = () =>
    fetch("/api/asks/pending")
      .then((r) => r.json())
      .then(setAsks)
      .catch(() => {});

  const refreshLaunches = () =>
    fetch("/api/launches")
      .then((r) => r.json())
      .then(setLaunches)
      .catch(() => {});

  // Projects carry computed counts (knowledgeDocs, pendingDrafts) that only
  // this endpoint fills in — projects:updated broadcasts the raw registry
  // list without them, so anything that changes a count refetches here
  // rather than trusting the socket payload.
  const refreshProjects = () =>
    fetch("/api/projects")
      .then((r) => r.json())
      .then(setProjects)
      .catch(() => {});

  // Runs synchronously per message — unlike storing just the latest message
  // in state, this can't coalesce two broadcasts that land in the same task
  // (e.g. a hook firing ask:resolved immediately followed by checkpoint:new)
  // into only the last one being handled.
  const handleWsMessage = useCallback((message: WsMessage) => {
    switch (message.type) {
      case "session:start":
      case "session:end":
      case "session:status":
        refreshSessions();
        break;

      case "event:new": {
        const { sessionId } = message.payload as { sessionId: string };
        setLastEvent((prev) => ({ sessionId, n: prev.n + 1 }));
        break;
      }

      case "checkpoint:new":
        setCheckpoints((prev) => [message.payload as Checkpoint, ...prev]);
        break;

      case "ask:new":
        setAsks((prev) => [message.payload as Ask, ...prev]);
        break;

      case "ask:resolved": {
        const { askId } = message.payload as { askId: string };
        setAsks((prev) => prev.filter((a) => a.id !== askId));
        break;
      }

      case "projects:updated":
        setProjects(message.payload as ProjectWithCounts[]);
        break;

      case "expert:exchange":
        setExpertExchanges((prev) => [message.payload as ExpertExchange, ...prev]);
        break;

      case "session:deleted":
        refreshSessions();
        break;

      case "launch:started":
      case "launch:stopped":
      case "launch:cleaned":
        refreshLaunches();
        break;

      case "knowledge:draft": {
        const { projectId } = message.payload as { projectId: string };
        setDraftSignal((prev) => ({ projectId, n: prev.n + 1 }));
        // Covers both directions: a draft landing bumps pendingDrafts, an
        // accept bumps knowledgeDocs back down. Either way the sidebar
        // badge is stale until this runs.
        refreshProjects();
        break;
      }
    }
  }, []);

  // The blocked/asks feed in particular needs to end up correct even if a
  // broadcast was missed while disconnected (tab backgrounded, laptop slept,
  // server restarted) — the socket has no replay/backlog, so resync pending
  // asks (and anything else that isn't purely append-only) from the server
  // whenever the connection comes back, instead of only on initial page load.
  const handleWsReconnect = useCallback(() => {
    refreshAsks();
    refreshSessions();
    refreshLaunches();
  }, []);

  // WebSocket for real-time updates
  useWebSocket("ws://localhost:7778", handleWsMessage, handleWsReconnect);

  // Initial data fetch
  useEffect(() => {
    async function fetchData() {
      try {
        const [
          projectsRes,
          sessionsRes,
          checkpointsRes,
          asksRes,
          expertRes,
          launchesRes,
        ] = await Promise.all([
          fetch("/api/projects"),
          fetch("/api/sessions?all=1"),
          fetch("/api/checkpoints"),
          fetch("/api/asks/pending"),
          fetch("/api/expert/exchanges"),
          fetch("/api/launches"),
        ]);

        setProjects(await projectsRes.json());
        setSessions(await sessionsRes.json());
        setCheckpoints(await checkpointsRes.json());
        setAsks(await asksRes.json());
        setExpertExchanges(await expertRes.json());
        setLaunches(await launchesRes.json());
      } catch (err) {
        console.error("Failed to fetch initial data:", err);
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, []);

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh" }}>
        <div style={{ color: "#8A97AD" }}>Loading...</div>
      </div>
    );
  }

  return (
    <Console
      projects={projects}
      sessions={sessions}
      checkpoints={checkpoints}
      asks={asks}
      expertExchanges={expertExchanges}
      launches={launches}
      lastEvent={lastEvent}
      draftSignal={draftSignal}
      onSessionChanged={refreshSessions}
      onLaunchChanged={() => {
        refreshLaunches();
        refreshSessions();
      }}
      onResolveAsk={async (askId, answer) => {
        // Resolving genuinely fails sometimes — a prompt-ask on a monitored
        // session is refused, and a launched session's pane may have exited.
        // Returning the reason is what makes the button feel alive.
        const res = await fetch(`/api/asks/${askId}/resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answer }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          return { error: data.error ?? `Reply failed (${res.status})` };
        }
        setAsks((prev) => prev.filter((a) => a.id !== askId));
        return {};
      }}
      onDismissAsk={async (askId) => {
        const res = await fetch(`/api/asks/${askId}`, { method: "DELETE" });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          return { error: data.error ?? `Dismiss failed (${res.status})` };
        }
        setAsks((prev) => prev.filter((a) => a.id !== askId));
        return {};
      }}
      onSteer={async (sessionId, body) => {
        await fetch(`/api/sessions/${sessionId}/steer`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body }),
        });
      }}
      onSaveProject={async (id, patch) => {
        // Projects are broadcast back over the WebSocket on every mutation,
        // so there's no local state update here — the server is the source
        // of truth and pushes the new list to every connected client.
        const res = await fetch(id ? `/api/projects/${id}` : "/api/projects", {
          method: id ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          return { error: data.error ?? `Save failed (${res.status})` };
        }
        return {};
      }}
      onDeleteProject={async (id) => {
        const res = await fetch(`/api/projects/${id}`, { method: "DELETE" });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          return { error: data.error ?? `Delete failed (${res.status})` };
        }
        refreshSessions();
        return {};
      }}
      onLaunch={async (projectId, task, model, effort) => {
        const res = await fetch(`/api/projects/${projectId}/launch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ task, model, effort }),
        });
        const data = await res.json();

        if (!res.ok) return { error: data.error ?? "Launch failed" };
        // A launch can also fail mid-flight after its row exists — the
        // response is 200 but the launch itself is marked failed.
        if (data.launch?.status === "failed") {
          return { error: data.launch.error ?? "Launch failed" };
        }

        refreshSessions();
        return {};
      }}
    />
  );
}
