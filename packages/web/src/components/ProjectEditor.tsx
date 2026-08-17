import { useState, useEffect, useRef } from "react";
import type { Project } from "@standup/shared";
import { theme } from "./theme";

const EMOJI_SET = [
  "🧭","🛰️","🧬","📚","🪴","🔭","⚙️","🧊","🦑","🛠️","📡","🌗","🪵","🐙","🔩","🌾","📖","🌍",
];

interface ProjectEditorProps {
  /** Omitted when creating. */
  project?: Project;
  onSave: (patch: Partial<Project>) => Promise<{ error?: string }>;
  onDelete?: () => Promise<{ error?: string }>;
  onCancel: () => void;
}

const label: React.CSSProperties = {
  fontFamily: theme.mono,
  fontSize: 9.5,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: theme.faint,
  display: "block",
  marginBottom: 5,
};

const field: React.CSSProperties = {
  width: "100%",
  fontSize: 13,
  color: theme.text,
  background: theme.ground,
  border: `1px solid ${theme.edge}`,
  borderRadius: 6,
  padding: "8px 10px",
  outline: "none",
};

export function ProjectEditor({
  project,
  onSave,
  onDelete,
  onCancel,
}: ProjectEditorProps) {
  const isNew = !project;

  const [id, setId] = useState(project?.id ?? "");
  const [name, setName] = useState(project?.name ?? "");
  const [emoji, setEmoji] = useState(project?.emoji ?? "📦");
  // Repos are one-per-line rather than a chip editor: a project can back
  // onto several repos, and paths are long enough that inline chips wrap
  // badly.
  const [repos, setRepos] = useState((project?.repos ?? []).join("\n"));
  const [setup, setSetup] = useState(project?.setup ?? "");
  const [branch, setBranch] = useState(project?.branch ?? "main");
  const [expert, setExpert] = useState(project?.expert ?? "");
  const [launchArgs, setLaunchArgs] = useState(project?.launchArgs ?? "");
  const [worktreeRoot, setWorktreeRoot] = useState(project?.worktreeRoot ?? "");
  const [provision, setProvision] = useState(project?.provision ?? "");
  const [launchSubdir, setLaunchSubdir] = useState(project?.launchSubdir ?? "");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Shown briefly after a successful save. The "Configure" tab keeps this
  // editor mounted after saving (unlike the new-project flow, which closes
  // it), so without an explicit confirmation a save there produced no visible
  // change at all — no way to tell it worked.
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Clear the pending "Saved" auto-hide if the editor unmounts first.
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    };
  }, []);

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);

    const patch: Partial<Project> = {
      name: name.trim() || id.trim(),
      emoji,
      repos: repos
        .split("\n")
        .map((r) => r.trim())
        .filter(Boolean),
      setup: setup.trim(),
      branch: branch.trim() || "main",
      expert: expert.trim(),
      launchArgs: launchArgs.trim(),
      worktreeRoot: worktreeRoot.trim(),
      provision: provision.trim(),
      launchSubdir: launchSubdir.trim(),
    };
    if (isNew) patch.id = id.trim();

    try {
      const result = await onSave(patch);
      if (result.error) {
        setError(result.error);
      } else {
        setSaved(true);
        if (savedTimer.current) clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => setSaved(false), 2500);
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!onDelete || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await onDelete();
      if (result.error) setError(result.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: "18px 20px 26px", maxWidth: 620 }}>
      {/* Same reasoning as the knowledge editor: the way out shouldn't be
          below the fold, and "Cancel" reads as discard rather than back. */}
      <button
        onClick={onCancel}
        style={{
          background: "none",
          border: "none",
          padding: 0,
          marginBottom: 12,
          cursor: "pointer",
          fontSize: 12.5,
          color: theme.faint,
        }}
      >
        ← Back
      </button>

      <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 18 }}>
        {isNew ? "New project" : `Configure ${project!.name}`}
      </div>

      <div style={{ display: "grid", gap: 16 }}>
        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ flex: "0 0 auto" }}>
            <span style={label}>Icon</span>
            <select
              value={emoji}
              onChange={(e) => setEmoji(e.target.value)}
              style={{ ...field, width: 70, fontSize: 18, padding: "6px 8px" }}
            >
              {[...new Set([emoji, ...EMOJI_SET])].map((e) => (
                <option key={e} value={e} style={{ background: theme.raised }}>
                  {e}
                </option>
              ))}
            </select>
          </div>

          <div style={{ flex: 1 }}>
            <span style={label}>Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="fusion-api"
              style={field}
            />
          </div>
        </div>

        {isNew && (
          <div>
            <span style={label}>Id</span>
            <input
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="fusion-api"
              style={field}
            />
            <div style={{ fontSize: 11.5, color: theme.faint, marginTop: 5 }}>
              Used in worktree paths and branch names. Letters, numbers, and
              hyphens only — it can't be changed later.
            </div>
          </div>
        )}

        <div>
          <span style={label}>Repos — one per line</span>
          <textarea
            value={repos}
            onChange={(e) => setRepos(e.target.value)}
            rows={3}
            placeholder={"~/src/fusion-api\n~/src/fusion-graph"}
            style={{ ...field, resize: "vertical", fontFamily: theme.mono, fontSize: 12 }}
          />
          <div style={{ fontSize: 11.5, color: theme.faint, marginTop: 5 }}>
            Sessions are matched to this project by comparing their working
            directory against these paths. The first repo is what launches
            check out from.
          </div>
        </div>

        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <span style={label}>Base branch</span>
            <input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="main"
              style={field}
            />
          </div>
          <div style={{ flex: 1 }}>
            <span style={label}>Expert index (unused)</span>
            <input
              value={expert}
              onChange={(e) => setExpert(e.target.value)}
              placeholder="—"
              style={{ ...field, opacity: 0.6 }}
            />
            <div style={{ fontSize: 11.5, color: theme.faint, marginTop: 5 }}>
              Reserved. Retrieval scopes knowledge by project id and attributes
              regions from experts.toml; nothing reads this yet.
            </div>
          </div>
        </div>

        <div>
          <span style={label}>Setup command (optional)</span>
          <input
            value={setup}
            onChange={(e) => setSetup(e.target.value)}
            placeholder="bun install && docker compose up -d"
            style={{ ...field, fontFamily: theme.mono, fontSize: 12 }}
          />
          <div style={{ fontSize: 11.5, color: theme.faint, marginTop: 5 }}>
            Runs in a freshly created worktree before the agent starts. Runs as
            you, with your permissions.
          </div>
        </div>

        <div>
          <span style={label}>Extra claude flags (optional)</span>
          <input
            value={launchArgs}
            onChange={(e) => setLaunchArgs(e.target.value)}
            placeholder="--permission-mode acceptEdits"
            style={{ ...field, fontFamily: theme.mono, fontSize: 12 }}
          />
          <div style={{ fontSize: 11.5, color: theme.faint, marginTop: 5 }}>
            Passed to <code>claude</code> when the console launches a session
            for this project. Model and effort are chosen per-launch, so set
            them in the composer, not here.
          </div>
        </div>

        <div>
          <span style={label}>Workspace root (optional)</span>
          <input
            value={worktreeRoot}
            onChange={(e) => setWorktreeRoot(e.target.value)}
            placeholder="~/workplace/standup-worktrees"
            style={{ ...field, fontFamily: theme.mono, fontSize: 12 }}
          />
          <div style={{ fontSize: 11.5, color: theme.faint, marginTop: 5 }}>
            Where this project's launched worktrees are created. Overrides the
            global default; leave blank to use it. Handy for checking out onto a
            case-sensitive volume. A leading ~ is expanded.
          </div>
        </div>

        <div>
          <span style={label}>Provision command (optional)</span>
          <textarea
            value={provision}
            onChange={(e) => setProvision(e.target.value)}
            rows={3}
            placeholder={
              'brazil workspace create --name "$STANDUP_WORKDIR_NAME" \\\n' +
              "  --versionSet MyVS/mainline --package MyPackage --package MyPackageTests"
            }
            style={{ ...field, fontFamily: theme.mono, fontSize: 12, resize: "vertical" }}
          />
          <div style={{ fontSize: 11.5, color: theme.faint, marginTop: 5 }}>
            Replaces <code>git worktree add</code> for launches. Must create the
            directory <code>$STANDUP_WORKDIR</code> (pass{" "}
            <code>--name "$STANDUP_WORKDIR_NAME"</code>). Also gets{" "}
            <code>$STANDUP_REPO</code>, <code>$STANDUP_BRANCH</code>,{" "}
            <code>$STANDUP_PROJECT</code>. Leave blank for a normal git worktree.
          </div>
        </div>

        <div>
          <span style={label}>Launch subdirectory (optional)</span>
          <input
            value={launchSubdir}
            onChange={(e) => setLaunchSubdir(e.target.value)}
            placeholder="src/MyPackage"
            style={{ ...field, fontFamily: theme.mono, fontSize: 12 }}
          />
          <div style={{ fontSize: 11.5, color: theme.faint, marginTop: 5 }}>
            Where inside the working dir the agent starts and setup runs. For a
            provisioned Brazil workspace, the package dir (e.g.{" "}
            <code>src/MyPackage</code>). Leave blank for the working dir itself.
          </div>
        </div>
      </div>

      {error && (
        <div
          style={{
            fontFamily: theme.mono,
            fontSize: 11.5,
            color: theme.waiting,
            marginTop: 16,
            lineHeight: 1.5,
          }}
        >
          {error}
        </div>
      )}

      {saved && !error && (
        <div
          style={{
            fontFamily: theme.mono,
            fontSize: 11.5,
            color: theme.checkpoint,
            marginTop: 16,
            lineHeight: 1.5,
          }}
        >
          ✓ Saved
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 22, alignItems: "center" }}>
        <button
          onClick={() => void save()}
          disabled={busy || (isNew && !id.trim())}
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: theme.ground,
            background: theme.checkpoint,
            border: "none",
            borderRadius: 6,
            padding: "9px 18px",
            cursor: busy ? "not-allowed" : "pointer",
            opacity: busy || (isNew && !id.trim()) ? 0.5 : 1,
          }}
        >
          {busy ? "Saving…" : isNew ? "Create project" : "Save changes"}
        </button>

        <button
          onClick={onCancel}
          disabled={busy}
          style={{
            fontSize: 13,
            color: theme.dim,
            background: "none",
            border: `1px solid ${theme.edge}`,
            borderRadius: 6,
            padding: "9px 16px",
            cursor: "pointer",
          }}
        >
          Cancel
        </button>

        <span style={{ flex: 1 }} />

        {onDelete && project?.id !== "scratch" && (
          confirmDelete ? (
            <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ fontSize: 12, color: theme.dim }}>
                Sessions move to scratch.
              </span>
              <button
                onClick={() => void remove()}
                disabled={busy}
                style={{
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: theme.ground,
                  background: theme.waiting,
                  border: "none",
                  borderRadius: 6,
                  padding: "8px 14px",
                  cursor: "pointer",
                }}
              >
                Delete
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                style={{
                  fontSize: 12.5,
                  color: theme.dim,
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                }}
              >
                Keep
              </button>
            </span>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              style={{
                fontSize: 12.5,
                color: theme.faint,
                background: "none",
                border: "none",
                cursor: "pointer",
              }}
            >
              Delete project
            </button>
          )
        )}
      </div>
    </div>
  );
}
