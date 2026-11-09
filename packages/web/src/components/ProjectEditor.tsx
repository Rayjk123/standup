import { useState, useEffect, useRef } from "react";
import { LuArrowLeft, LuCheck, LuUpload } from "react-icons/lu";
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
  // A custom uploaded image, shown in place of the emoji everywhere the project
  // appears once set. Stored server-side by its own endpoint (a file upload,
  // not part of the JSON patch), so this only mirrors the current value for the
  // preview and is set from the upload response — not sent back in `save`.
  const [iconPath, setIconPath] = useState<string | undefined>(project?.iconPath);
  const [uploadingIcon, setUploadingIcon] = useState(false);
  const iconInputRef = useRef<HTMLInputElement>(null);
  // Repos are one-per-line rather than a chip editor: a project can back
  // onto several repos, and paths are long enough that inline chips wrap
  // badly.
  const [repos, setRepos] = useState((project?.repos ?? []).join("\n"));
  const [setup, setSetup] = useState(project?.setup ?? "");
  const [branch, setBranch] = useState(project?.branch ?? "main");
  const [launchArgs, setLaunchArgs] = useState(project?.launchArgs ?? "");
  const [worktreeRoot, setWorktreeRoot] = useState(project?.worktreeRoot ?? "");
  const [provision, setProvision] = useState(project?.provision ?? "");
  const [launchSubdir, setLaunchSubdir] = useState(project?.launchSubdir ?? "");
  const [inPlace, setInPlace] = useState<boolean>(!!project?.inPlace);
  // Unset means on: only an explicit false opts the project out.
  const [bypassPermissions, setBypassPermissions] = useState<boolean>(
    project?.bypassPermissions !== false
  );

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
      launchArgs: launchArgs.trim(),
      worktreeRoot: worktreeRoot.trim(),
      provision: provision.trim(),
      launchSubdir: launchSubdir.trim(),
      inPlace,
      bypassPermissions,
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

  // A project must exist before it can hold an icon file — the endpoint keys the
  // stored image by project id, so uploads are offered only for a saved project.
  async function uploadIcon(file: File) {
    if (!project || uploadingIcon) return;
    setUploadingIcon(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("icon", file);
      const res = await fetch(`/api/projects/${project.id}/icon`, {
        method: "POST",
        body: form,
      });
      const data = (await res.json().catch(() => ({}))) as {
        iconPath?: string;
        error?: string;
      };
      if (!res.ok) {
        setError(data.error ?? "Icon upload failed");
      } else if (data.iconPath) {
        setIconPath(data.iconPath);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploadingIcon(false);
    }
  }

  async function removeIcon() {
    if (!project || uploadingIcon) return;
    setUploadingIcon(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${project.id}/icon`, {
        method: "DELETE",
      });
      if (res.ok) setIconPath(undefined);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploadingIcon(false);
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
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
        }}
      >
        <LuArrowLeft /> Back
      </button>

      <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 18 }}>
        {isNew ? "New project" : `Configure ${project!.name}`}
      </div>

      <div style={{ display: "grid", gap: 16 }}>
        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ flex: "0 0 auto" }}>
            <span style={label}>Icon</span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
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

              {/* Custom image upload — offered only once the project exists,
                  since the icon file is keyed by project id. When set, the
                  image is what shows across the app in place of the emoji. */}
              {!isNew && (
                <>
                  <button
                    type="button"
                    onClick={() => iconInputRef.current?.click()}
                    disabled={uploadingIcon}
                    title="Upload a custom image; shown instead of the emoji when set"
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 8,
                      border: `1px solid ${theme.edge}`,
                      background: theme.ground,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      padding: 0,
                      overflow: "hidden",
                      color: theme.faint,
                      fontSize: 16,
                      cursor: uploadingIcon ? "wait" : "pointer",
                    }}
                  >
                    {iconPath ? (
                      <img
                        src={iconPath}
                        alt=""
                        style={{ width: "100%", height: "100%", objectFit: "cover" }}
                      />
                    ) : (
                      <LuUpload />
                    )}
                  </button>
                  {iconPath && (
                    <button
                      type="button"
                      onClick={() => void removeIcon()}
                      disabled={uploadingIcon}
                      style={{
                        background: "none",
                        border: "none",
                        padding: 0,
                        cursor: "pointer",
                        color: theme.faint,
                        fontSize: 11.5,
                      }}
                    >
                      Remove
                    </button>
                  )}
                  <input
                    ref={iconInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
                    style={{ display: "none" }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void uploadIcon(f);
                      e.currentTarget.value = "";
                    }}
                  />
                </>
              )}
            </div>
            <div style={{ fontSize: 11.5, color: theme.faint, marginTop: 5 }}>
              {isNew
                ? "Save the project first to upload a custom image."
                : "Upload an image to use instead of the emoji, or keep the emoji."}
            </div>
          </div>

          <div style={{ flex: 1 }}>
            <span style={label}>Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="catalog-api"
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
              placeholder="catalog-api"
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
            placeholder={"~/src/catalog-api\n~/src/catalog-graph"}
            style={{ ...field, resize: "vertical", fontFamily: theme.mono, fontSize: 12 }}
          />
          <div style={{ fontSize: 11.5, color: theme.faint, marginTop: 5 }}>
            Sessions are matched to this project by comparing their working
            directory against these paths. The first repo is what launches
            check out from.
          </div>
        </div>

        <div>
          <span style={label}>Base branch</span>
          <input
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="main"
            style={field}
          />
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
            placeholder="~/src/standup-worktrees"
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
              'my-workspace-tool new --name "$STANDUP_WORKDIR_NAME" \\\n' +
              "  --package api --package api-tests"
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
            placeholder="packages/api"
            style={{ ...field, fontFamily: theme.mono, fontSize: 12 }}
          />
          <div style={{ fontSize: 11.5, color: theme.faint, marginTop: 5 }}>
            Where inside the working dir the agent starts and setup runs. For a
            provisioned workspace of several checkouts, the package dir (e.g.{" "}
            <code>packages/api</code>). Leave blank for the working dir itself.
          </div>
        </div>

        <div>
          <span style={label}>Reuse existing workspace by default</span>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 13,
              color: theme.text,
              cursor: "pointer",
              userSelect: "none",
            }}
          >
            <input
              type="checkbox"
              checked={inPlace}
              onChange={(e) => setInPlace(e.target.checked)}
              style={{ margin: 0 }}
            />
            Skip `git worktree add` and setup — launches run in the repo itself
          </label>
          <div style={{ fontSize: 11.5, color: theme.faint, marginTop: 5 }}>
            The composer starts each launch this way unless you uncheck it there.
            Cleanup won't touch the working dir. Ignored when a provision command
            is set (that path always builds its own dir).
          </div>
        </div>

        <div>
          <span style={label}>Bypass permissions (safety floor)</span>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 13,
              color: theme.text,
              cursor: "pointer",
              userSelect: "none",
            }}
          >
            <input
              type="checkbox"
              checked={bypassPermissions}
              onChange={(e) => setBypassPermissions(e.target.checked)}
              style={{ margin: 0 }}
            />
            Launch Claude with permissions bypassed behind Standup's safety floor
          </label>
          <div style={{ fontSize: 11.5, color: theme.faint, marginTop: 5 }}>
            Outward-facing and destructive steps are still routed to Persona or you.
            Unchecked runs <code>--permission-mode auto</code> with normal prompting.
            A <code>--permission-mode</code> in launch args wins.
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
            display: "flex",
            alignItems: "center",
            gap: 5,
          }}
        >
          <LuCheck /> Saved
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
