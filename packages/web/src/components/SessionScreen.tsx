import { useState, useEffect } from "react";
import { theme } from "./theme";

interface SessionScreenProps {
  sessionId: string;
  /** Lines to show. Blocking prompts sit at the bottom of the pane. */
  lines?: number;
}

interface ScreenState {
  output: string;
  alive: boolean;
  owned: boolean;
}

/**
 * Live view of what a session currently has on screen.
 *
 * A Notification hook says *that* an agent is waiting, never *what* it's
 * waiting on — so an ask raised from one is an alert with no content. For a
 * launched session Standup owns the pane and can just show the question.
 *
 * Monitored sessions have no pane to read; that renders as a pointer back to
 * the human's own terminal rather than an error, because it isn't one.
 */
export function SessionScreen({ sessionId, lines = 18 }: SessionScreenProps) {
  const [screen, setScreen] = useState<ScreenState | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/output`);
      setScreen(await res.json());
    } catch {
      setScreen(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // Re-read periodically: the pane is the source of truth and the agent
    // may move on without any hook firing to tell us.
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [sessionId]);

  if (loading) {
    return (
      <div style={{ fontFamily: theme.mono, fontSize: 11, color: theme.faint, marginTop: 10 }}>
        reading session…
      </div>
    );
  }

  if (!screen?.owned) {
    return (
      <div style={{ fontSize: 12, color: theme.faint, marginTop: 10, lineHeight: 1.5 }}>
        This session runs in your own terminal — Standup can't read its screen.
        Check there to see what it's asking.
      </div>
    );
  }

  if (!screen.alive) {
    return (
      <div style={{ fontSize: 12, color: theme.faint, marginTop: 10 }}>
        Session is no longer running.
      </div>
    );
  }

  // Trailing blank lines are normal in a captured pane and just push the
  // interesting part out of view.
  const visible = screen.output
    .split("\n")
    .filter((l, i, arr) => l.trim() !== "" || i < arr.length - 1)
    .slice(-lines)
    .join("\n");

  return (
    <div style={{ marginTop: 10 }}>
      <div
        style={{
          fontFamily: theme.mono,
          fontSize: 9.5,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: theme.faint,
          marginBottom: 5,
        }}
      >
        On screen now
      </div>
      <pre
        style={{
          fontFamily: theme.mono,
          fontSize: 11,
          lineHeight: 1.5,
          color: theme.dim,
          background: theme.ground,
          border: `1px solid ${theme.edgeSoft}`,
          borderRadius: 6,
          padding: "10px 12px",
          margin: 0,
          maxHeight: 280,
          overflow: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {visible || "(nothing on screen)"}
      </pre>
    </div>
  );
}
