import { useEffect, useRef, useState } from "react";
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from "@headlessui/react";
import type { ClaudeEffort, ClaudeModel, Project } from "@standup/shared";

interface ComposerProps {
  projects: Project[];
  onLaunch: (
    projectId: string,
    task: string,
    model?: ClaudeModel,
    effort?: ClaudeEffort
  ) => Promise<{ error?: string }>;
  /**
   * Bump this to focus the task input — e.g. from a "+ new chat" button
   * elsewhere on the page. A plain autoFocus attribute only fires once on
   * mount, which misses the case where the composer is already on screen
   * and the tab/route just switched to it without remounting.
   */
  focusSignal?: number;
}

const MODEL_OPTIONS: { value: ClaudeModel | ""; label: string }[] = [
  { value: "", label: "Default model" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
  { value: "fable", label: "Fable" },
];

const EFFORT_OPTIONS: { value: ClaudeEffort | ""; label: string }[] = [
  { value: "", label: "Default effort" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "X-high" },
  { value: "max", label: "Max" },
];

const selectButtonClass =
  "whitespace-nowrap rounded-md border border-edge bg-raised px-[9px] py-2 text-left text-[12.5px] text-text outline-none disabled:cursor-default disabled:opacity-60";

/** A value-bound dropdown that keeps its selection — for form fields, unlike LaunchControls' fire-and-reset ActionMenu. */
function FieldSelect<T extends string>({
  value,
  options,
  disabled,
  title,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  disabled?: boolean;
  title?: string;
  onChange: (v: T) => void;
}) {
  const current = options.find((o) => o.value === value);
  return (
    <Listbox value={value} onChange={onChange} disabled={disabled}>
      <ListboxButton title={title} className={selectButtonClass}>
        {current?.label}
      </ListboxButton>
      <ListboxOptions
        anchor="bottom start"
        className="z-10 mt-1 rounded-md border border-edge bg-raised py-1 text-[12.5px] text-text shadow-lg focus:outline-none"
      >
        {options.map((o) => (
          <ListboxOption
            key={o.value}
            value={o.value}
            className="cursor-pointer px-3 py-1 data-focus:bg-hover"
          >
            {o.label}
          </ListboxOption>
        ))}
      </ListboxOptions>
    </Listbox>
  );
}

/**
 * Composer-as-launcher: pick a project, describe the work, and the console
 * starts a session for it — worktree, setup command, and a detached tmux
 * session it can attach to. Closes the loop the design describes: you no
 * longer leave the console to begin work.
 */
export function Composer({ projects, onLaunch, focusSignal }: ComposerProps) {
  const [target, setTarget] = useState(projects[0]?.id ?? "");
  const [task, setTask] = useState("");
  const [model, setModel] = useState<ClaudeModel | "">("");
  const [effort, setEffort] = useState<ClaudeEffort | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taskInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusSignal) taskInputRef.current?.focus();
  }, [focusSignal]);

  // A project with no repos can't be checked out — surface that before the
  // user types a task and hits a failure.
  const selected = projects.find((p) => p.id === target);
  const launchable = !!selected && selected.repos.length > 0;

  const projectOptions = projects.map((p) => ({
    value: p.id,
    label: `${p.emoji ?? "📦"} ${p.name}`,
  }));

  async function submit() {
    if (!task.trim() || busy || !launchable) return;
    setBusy(true);
    setError(null);
    try {
      const result = await onLaunch(
        target,
        task.trim(),
        model || undefined,
        effort || undefined
      );
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
    <div className="border-t border-edge px-5 pb-4 pt-3">
      {/* This sits where a chat input would in a Slack-style feed, but it
          starts a whole new agent in its own worktree. Saying so prevents
          the obvious misread — that typing here messages a running session. */}
      <div className="mb-[7px] font-mono text-[9.5px] uppercase tracking-[0.14em] text-faint">
        Start new work — launches an agent in its own worktree
      </div>
      <div className="flex items-center gap-2 rounded-[9px] border border-edge bg-surface p-1.5">
        {/* A single-project list (e.g. the composer scoped to one project's
            page) has nothing to pick between, so the selector would just be
            a dropdown of one — show the name plainly instead. */}
        {projects.length > 1 ? (
          <FieldSelect
            value={target}
            options={projectOptions}
            onChange={(v) => {
              setTarget(v);
              setError(null);
            }}
          />
        ) : (
          selected && (
            <span className="whitespace-nowrap rounded-md border border-edge bg-raised px-[9px] py-2 text-[12.5px] text-text">
              {selected.emoji ?? "📦"} {selected.name}
            </span>
          )
        )}

        <FieldSelect
          value={model}
          options={MODEL_OPTIONS}
          disabled={busy}
          title="Model to launch with — passed as claude --model"
          onChange={setModel}
        />

        <FieldSelect
          value={effort}
          options={EFFORT_OPTIONS}
          disabled={busy}
          title="Effort level to launch with — passed as claude --effort"
          onChange={setEffort}
        />

        <input
          ref={taskInputRef}
          value={task}
          disabled={busy}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          placeholder={
            launchable
              ? "Describe a task to start a new agent on it…"
              : `${selected?.name ?? "This project"} has no repos configured — add one in Projects`
          }
          className="flex-1 border-none bg-transparent px-1.5 py-[9px] text-[13.5px] text-text outline-none"
        />

        <button
          onClick={() => void submit()}
          disabled={busy || !task.trim() || !launchable}
          className={`rounded-md border border-checkpoint bg-checkpoint px-4 py-[9px] text-[13px] font-semibold text-ground ${
            busy || !launchable ? "cursor-not-allowed" : "cursor-pointer"
          } ${busy || !task.trim() || !launchable ? "opacity-50" : "opacity-100"}`}
        >
          {busy ? "Starting…" : "Start"}
        </button>
      </div>

      {busy && (
        <div className="mt-2 font-mono text-[10.5px] text-running">
          ⧗ creating worktree · running setup · starting agent
        </div>
      )}

      {error && <div className="mt-2 font-mono text-[11px] leading-relaxed text-waiting">{error}</div>}
    </div>
  );
}
