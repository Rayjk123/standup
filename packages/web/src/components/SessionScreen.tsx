import { useState, useEffect } from "react";

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
      <div className="mt-2.5 font-mono text-[11px] text-faint">
        reading session…
      </div>
    );
  }

  if (!screen?.owned) {
    return (
      <div className="mt-2.5 text-xs leading-relaxed text-faint">
        This session runs in your own terminal — Standup can't read its screen.
        Check there to see what it's asking.
      </div>
    );
  }

  if (!screen.alive) {
    return (
      <div className="mt-2.5 text-xs text-faint">
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
    <div className="mt-2.5">
      <div className="mb-[5px] font-mono text-[9.5px] uppercase tracking-[0.14em] text-faint">
        On screen now
      </div>
      <pre className="m-0 max-h-[280px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-edge-soft bg-ground px-3 py-2.5 font-mono text-[11px] leading-relaxed text-dim">
        {visible || "(nothing on screen)"}
      </pre>
    </div>
  );
}
