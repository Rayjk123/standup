import { useState, useEffect } from "react";
import { Console } from "./components/Console";
import { useWebSocket } from "./hooks/useWebSocket";
import type { Session, Project, Checkpoint, Ask, ExpertExchange } from "@standup/shared";

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [asks, setAsks] = useState<Ask[]>([]);
  const [expertExchanges, setExpertExchanges] = useState<ExpertExchange[]>([]);
  const [loading, setLoading] = useState(true);

  // WebSocket for real-time updates
  const { lastMessage } = useWebSocket("ws://localhost:7778");

  // Initial data fetch
  useEffect(() => {
    async function fetchData() {
      try {
        const [projectsRes, sessionsRes, checkpointsRes, asksRes, expertRes] =
          await Promise.all([
            fetch("/api/projects"),
            fetch("/api/sessions"),
            fetch("/api/checkpoints"),
            fetch("/api/asks/pending"),
            fetch("/api/expert/exchanges"),
          ]);

        setProjects(await projectsRes.json());
        setSessions(await sessionsRes.json());
        setCheckpoints(await checkpointsRes.json());
        setAsks(await asksRes.json());
        setExpertExchanges(await expertRes.json());
      } catch (err) {
        console.error("Failed to fetch initial data:", err);
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, []);

  // Handle WebSocket messages
  useEffect(() => {
    if (!lastMessage) return;

    switch (lastMessage.type) {
      case "session:start":
        // Refetch sessions
        fetch("/api/sessions")
          .then((res) => res.json())
          .then(setSessions);
        break;

      case "session:end":
      case "session:status":
        fetch("/api/sessions")
          .then((res) => res.json())
          .then(setSessions);
        break;

      case "checkpoint:new":
        setCheckpoints((prev) => [lastMessage.payload as Checkpoint, ...prev]);
        break;

      case "ask:new":
        setAsks((prev) => [lastMessage.payload as Ask, ...prev]);
        break;

      case "ask:resolved":
        const { askId } = lastMessage.payload as { askId: string };
        setAsks((prev) => prev.filter((a) => a.id !== askId));
        break;

      case "projects:updated":
        setProjects(lastMessage.payload as Project[]);
        break;

      case "expert:exchange":
        setExpertExchanges((prev) => [lastMessage.payload as ExpertExchange, ...prev]);
        break;
    }
  }, [lastMessage]);

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
      onResolveAsk={async (askId, answer) => {
        await fetch(`/api/asks/${askId}/resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answer }),
        });
      }}
      onSteer={async (sessionId, body) => {
        await fetch(`/api/sessions/${sessionId}/steer`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body }),
        });
      }}
      onLaunch={async (projectId, task) => {
        const res = await fetch(`/api/projects/${projectId}/launch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ task }),
        });
        const data = await res.json();

        if (!res.ok) return { error: data.error ?? "Launch failed" };
        // A launch can also fail mid-flight after its row exists — the
        // response is 200 but the launch itself is marked failed.
        if (data.launch?.status === "failed") {
          return { error: data.launch.error ?? "Launch failed" };
        }

        fetch("/api/sessions")
          .then((r) => r.json())
          .then(setSessions);
        return {};
      }}
    />
  );
}
