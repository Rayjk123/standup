import { useState } from "react";
import type { Project } from "@standup/shared";
import { theme } from "./theme";

interface ComposerProps {
  projects: Project[];
  onLaunch: (projectId: string, task: string) => Promise<{ error?: string }>;
}

/**
 * Composer-as-launcher: pick a project, describe the work, and the console
 * starts a session for it — worktree, setup command, and a detached tmux
 * session it can attach to. Closes the loop the design describes: you no
 * longer leave the console to begin work.
 */
export function Composer({ projects, onLaunch }: ComposerProps) {
  const [target, setTarget] = useState(projects[0]?.id ?? "");
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A project with no repos can't be checked out — surface that before the
  // user types a task and hits a failure.
  const selected = projects.find((p) => p.id === target);
  const launchable = !!selected && selected.repos.length > 0;

  async function submit() {
    if (!task.trim() || busy || !launchable) return;
    setBusy(true);
    setError(null);
    try {
      const result = await onLaunch(target, task.trim());
      if (result.error) {
        setError(result.error);
      } else {
        setTask("");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ borderTop: `1px solid ${theme.edge}`, padding: "12px 20px 16px" }}>
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          border: `1px solid ${theme.edge}`,
          borderRadius: 9,
          padding: 6,
          background: theme.surface,
        }}
      >
        <select
          value={target}
          onChange={(e) => {
            setTarget(e.target.value);
            setError(null);
          }}
          style={{
            fontSize: 12.5,
            color: theme.text,
            background: theme.raised,
            border: `1px solid ${theme.edge}`,
            borderRadius: 6,
            padding: "8px 9px",
            outline: "none",
          }}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id} style={{ background: theme.raised }}>
              {p.emoji ?? "📦"} {p.name}
            </option>
          ))}
        </select>

        <input
          value={task}
          disabled={busy}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          placeholder={
            launchable
              ? "Describe the work to start a session…"
              : `${selected?.name ?? "This project"} has no repos in projects.toml`
          }
          style={{
            flex: 1,
            fontSize: 13.5,
            color: theme.text,
            background: "transparent",
            border: "none",
            padding: "9px 6px",
            outline: "none",
          }}
        />

        <button
          onClick={() => void submit()}
          disabled={busy || !task.trim() || !launchable}
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: theme.ground,
            background: theme.checkpoint,
            border: `1px solid ${theme.checkpoint}`,
            borderRadius: 6,
            padding: "9px 16px",
            cursor: busy || !launchable ? "not-allowed" : "pointer",
            opacity: busy || !task.trim() || !launchable ? 0.5 : 1,
          }}
        >
          {busy ? "Starting…" : "Start"}
        </button>
      </div>

      {busy && (
        <div style={{ fontFamily: theme.mono, fontSize: 10.5, color: theme.running, marginTop: 8 }}>
          ⧗ creating worktree · running setup · starting agent
        </div>
      )}

      {error && (
        <div
          style={{
            fontFamily: theme.mono,
            fontSize: 11,
            color: theme.waiting,
            marginTop: 8,
            lineHeight: 1.5,
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
