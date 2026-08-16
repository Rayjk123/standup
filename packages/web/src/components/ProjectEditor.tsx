import { useState } from "react";
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from "@headlessui/react";
import type { Project } from "@standup/shared";

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

const labelClass = "mb-[5px] block font-mono text-[9.5px] tracking-[0.14em] text-faint uppercase";

const fieldClass =
  "w-full rounded-md border border-edge bg-ground px-2.5 py-2 text-[13px] text-text outline-none";

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

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);

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
    };
    if (isNew) patch.id = id.trim();

    try {
      const result = await onSave(patch);
      if (result.error) setError(result.error);
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
    <div className="max-w-[620px] px-5 pb-[26px] pt-[18px]">
      {/* Same reasoning as the knowledge editor: the way out shouldn't be
          below the fold, and "Cancel" reads as discard rather than back. */}
      <button
        onClick={onCancel}
        className="mb-3 cursor-pointer border-none bg-transparent p-0 text-[12.5px] text-faint"
      >
        ← Back
      </button>

      <div className="mb-[18px] text-[17px] font-bold">
        {isNew ? "New project" : `Configure ${project!.name}`}
      </div>

      <div className="grid gap-4">
        <div className="flex gap-3">
          <div className="flex-none">
            <span className={labelClass}>Icon</span>
            <Listbox value={emoji} onChange={setEmoji}>
              <ListboxButton
                className={`${fieldClass} w-[70px] cursor-pointer px-2 py-1.5 text-left text-lg`}
              >
                {emoji}
              </ListboxButton>
              <ListboxOptions
                anchor="bottom start"
                className="z-10 mt-1 max-h-60 overflow-auto rounded-md border border-edge bg-raised py-1 text-lg shadow-lg focus:outline-none"
              >
                {[...new Set([emoji, ...EMOJI_SET])].map((e) => (
                  <ListboxOption
                    key={e}
                    value={e}
                    className="cursor-pointer px-3 py-1 data-focus:bg-hover"
                  >
                    {e}
                  </ListboxOption>
                ))}
              </ListboxOptions>
            </Listbox>
          </div>

          <div className="flex-1">
            <span className={labelClass}>Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="fusion-api"
              className={fieldClass}
            />
          </div>
        </div>

        {isNew && (
          <div>
            <span className={labelClass}>Id</span>
            <input
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="fusion-api"
              className={fieldClass}
            />
            <div className="mt-[5px] text-[11.5px] text-faint">
              Used in worktree paths and branch names. Letters, numbers, and
              hyphens only — it can't be changed later.
            </div>
          </div>
        )}

        <div>
          <span className={labelClass}>Repos — one per line</span>
          <textarea
            value={repos}
            onChange={(e) => setRepos(e.target.value)}
            rows={3}
            placeholder={"~/src/fusion-api\n~/src/fusion-graph"}
            className={`${fieldClass} resize-y font-mono text-xs`}
          />
          <div className="mt-[5px] text-[11.5px] text-faint">
            Sessions are matched to this project by comparing their working
            directory against these paths. The first repo is what launches
            check out from.
          </div>
        </div>

        <div className="flex gap-3">
          <div className="flex-1">
            <span className={labelClass}>Base branch</span>
            <input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="main"
              className={fieldClass}
            />
          </div>
          <div className="flex-1">
            <span className={labelClass}>Expert index (unused)</span>
            <input
              value={expert}
              onChange={(e) => setExpert(e.target.value)}
              placeholder="—"
              className={`${fieldClass} opacity-60`}
            />
            <div className="mt-[5px] text-[11.5px] text-faint">
              Reserved. Retrieval scopes knowledge by project id and attributes
              regions from experts.toml; nothing reads this yet.
            </div>
          </div>
        </div>

        <div>
          <span className={labelClass}>Setup command (optional)</span>
          <input
            value={setup}
            onChange={(e) => setSetup(e.target.value)}
            placeholder="bun install && docker compose up -d"
            className={`${fieldClass} font-mono text-xs`}
          />
          <div className="mt-[5px] text-[11.5px] text-faint">
            Runs in a freshly created worktree before the agent starts. Runs as
            you, with your permissions.
          </div>
        </div>
      </div>

      {error && (
        <div className="mt-4 font-mono text-[11.5px] leading-relaxed text-waiting">{error}</div>
      )}

      <div className="mt-[22px] flex items-center gap-2">
        <button
          onClick={() => void save()}
          disabled={busy || (isNew && !id.trim())}
          className={`rounded-md border-none bg-checkpoint px-[18px] py-[9px] text-[13px] font-semibold text-ground ${
            busy ? "cursor-not-allowed" : "cursor-pointer"
          } ${busy || (isNew && !id.trim()) ? "opacity-50" : "opacity-100"}`}
        >
          {busy ? "Saving…" : isNew ? "Create project" : "Save changes"}
        </button>

        <button
          onClick={onCancel}
          disabled={busy}
          className="cursor-pointer rounded-md border border-edge bg-transparent px-4 py-[9px] text-[13px] text-dim"
        >
          Cancel
        </button>

        <span className="flex-1" />

        {onDelete && project?.id !== "scratch" && (
          confirmDelete ? (
            <span className="flex items-center gap-2">
              <span className="text-xs text-dim">Sessions move to scratch.</span>
              <button
                onClick={() => void remove()}
                disabled={busy}
                className="cursor-pointer rounded-md border-none bg-waiting px-3.5 py-2 text-[12.5px] font-semibold text-ground"
              >
                Delete
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="cursor-pointer border-none bg-transparent text-[12.5px] text-dim"
              >
                Keep
              </button>
            </span>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="cursor-pointer border-none bg-transparent text-[12.5px] text-faint"
            >
              Delete project
            </button>
          )
        )}
      </div>
    </div>
  );
}
