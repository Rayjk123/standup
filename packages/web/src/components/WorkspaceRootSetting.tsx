import { useEffect, useState } from "react";
import { LuCheck } from "react-icons/lu";
import { theme } from "./theme";

/**
 * Global default for where launched worktrees are created — the persisted
 * equivalent of the STANDUP_WORKTREE_ROOT env var, applied to every project
 * that doesn't set its own `worktreeRoot`. Empty means "fall back to the env
 * var, then the built-in ~/.local/share default" (see resolveWorktreeRoot in
 * the collector). Saved on blur/Enter rather than per keystroke.
 */
export function WorkspaceRootSetting() {
  const [value, setValue] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then((res) => res.json())
      .then((data) => setValue(data.worktreeRoot ?? ""))
      .catch(() => setValue(""));
  }, []);

  if (value === null) return null;

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ worktreeRoot: value }),
      });
      const data = await res.json();
      setValue(data.worktreeRoot ?? "");
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ padding: "10px 14px", borderTop: `1px solid ${theme.edgeSoft}` }}>
      <span
        style={{
          fontFamily: theme.mono,
          fontSize: 9.5,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: theme.faint,
          display: "block",
          marginBottom: 5,
        }}
      >
        Workspace root · all projects
      </span>
      <input
        value={value}
        disabled={saving}
        onChange={(e) => {
          setValue(e.target.value);
          setSaved(false);
        }}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        placeholder="~/.local/share/standup/worktrees"
        title="Default location for launched worktrees. A per-project Workspace root overrides this. Leave blank for the built-in default (or STANDUP_WORKTREE_ROOT if set)."
        style={{
          width: "100%",
          fontFamily: theme.mono,
          fontSize: 11.5,
          color: theme.text,
          background: theme.ground,
          border: `1px solid ${theme.edge}`,
          borderRadius: 6,
          padding: "6px 9px",
          outline: "none",
        }}
      />
      {saved && (
        <div
          style={{
            fontFamily: theme.mono,
            fontSize: 10,
            color: theme.checkpoint,
            marginTop: 4,
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <LuCheck /> Saved — applies to new launches.
        </div>
      )}
    </div>
  );
}
