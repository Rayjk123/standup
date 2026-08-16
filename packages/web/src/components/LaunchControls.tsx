import { useState } from "react";
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from "@headlessui/react";
import type { ClaudeEffort, ClaudeModel, Launch } from "@standup/shared";

const MODELS: ClaudeModel[] = ["opus", "sonnet", "haiku", "fable"];
const EFFORTS: ClaudeEffort[] = ["low", "medium", "high", "xhigh", "max"];

interface LaunchControlsProps {
  launch: Launch;
  onStopped: () => void;
}

const linkButtonClass = "cursor-pointer border-none bg-transparent p-0 text-xs text-faint";

/**
 * A dropdown that fires an action on pick and doesn't retain a selected
 * value — mirrors the old `<select defaultValue="">` + reset-after-change
 * pattern, since these are commands ("/model opus") rather than settings.
 */
function ActionMenu<T extends string>({
  placeholder,
  options,
  disabled,
  title,
  onSelect,
}: {
  placeholder: string;
  options: readonly T[];
  disabled: boolean;
  title: string;
  onSelect: (value: T) => void;
}) {
  return (
    <Listbox value={null} onChange={(v: T | null) => v && onSelect(v)} disabled={disabled}>
      <ListboxButton
        title={title}
        className={`${linkButtonClass} rounded border border-edge px-1 py-px disabled:cursor-default`}
      >
        {placeholder}
      </ListboxButton>
      <ListboxOptions
        anchor="bottom start"
        className="z-10 mt-1 rounded-md border border-edge bg-raised py-1 text-xs text-text shadow-lg focus:outline-none"
      >
        {options.map((opt) => (
          <ListboxOption
            key={opt}
            value={opt}
            className="cursor-pointer px-3 py-1 data-focus:bg-hover"
          >
            {opt}
          </ListboxOption>
        ))}
      </ListboxOptions>
    </Listbox>
  );
}

/**
 * Controls that exist only for launched sessions.
 *
 * Standup owns this session's tmux pane, so unlike a monitored session it
 * can show the screen, type into it, and stop it. That matters most here:
 * you have a terminal for a session you started yourself, and none for one
 * the console started for you.
 */
export function LaunchControls({ launch, onStopped }: LaunchControlsProps) {
  const [output, setOutput] = useState<string | null>(null);
  const [alive, setAlive] = useState(true);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  const [composing, setComposing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [busy, setBusy] = useState(false);

  async function loadOutput() {
    setError(null);
    try {
      const res = await fetch(`/api/launches/${launch.id}/output`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not read the session");
        return;
      }
      setAlive(data.alive);
      setOutput(data.output || "(nothing on screen yet)");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function sendText(text: string) {
    if (!text.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/launches/${launch.id}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Send failed");
        return;
      }
      // Give the agent a beat to react, then show the result — otherwise
      // you'd see the screen from before your input landed.
      setTimeout(() => void loadOutput(), 1200);
    } finally {
      setSending(false);
    }
  }

  async function send() {
    if (!draft.trim()) return;
    await sendText(draft);
    setDraft("");
    setComposing(false);
  }

  // `/model` and `/effort` are real Claude Code slash commands — typed at
  // the prompt exactly like sendText does, so switching mid-session reuses
  // the same literal-keystroke path rather than a new mechanism.
  async function switchModel(model: ClaudeModel) {
    await sendText(`/model ${model}`);
  }

  async function switchEffort(effort: ClaudeEffort) {
    await sendText(`/effort ${effort}`);
  }

  async function stop() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/launches/${launch.id}/stop`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Stop failed");
        return;
      }
      setConfirmStop(false);
      onStopped();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-[9px]">
      <div className="flex flex-wrap items-center gap-3.5">
        <button onClick={() => (output ? setOutput(null) : void loadOutput())} className={linkButtonClass}>
          {output ? "▾ hide output" : "▸ view output"}
        </button>

        <button onClick={() => setComposing((v) => !v)} className={linkButtonClass}>
          ↩ send input
        </button>

        <ActionMenu
          placeholder="model…"
          options={MODELS}
          disabled={sending}
          title="Switch this running session's model — sends /model at its prompt"
          onSelect={(m) => void switchModel(m)}
        />

        <ActionMenu
          placeholder="effort…"
          options={EFFORTS}
          disabled={sending}
          title="Switch this running session's effort — sends /effort at its prompt"
          onSelect={(e) => void switchEffort(e)}
        />

        <span className="flex-1" />

        {confirmStop ? (
          <span className="flex items-center gap-2">
            <span className="text-[11.5px] text-dim">Worktree is kept.</span>
            <button
              onClick={() => void stop()}
              disabled={busy}
              className="cursor-pointer rounded-md border-none bg-waiting px-2.5 py-[5px] text-xs font-semibold text-ground"
            >
              Stop agent
            </button>
            <button onClick={() => setConfirmStop(false)} className={linkButtonClass}>
              cancel
            </button>
          </span>
        ) : (
          <button onClick={() => setConfirmStop(true)} className={`${linkButtonClass} text-waiting`}>
            ■ stop
          </button>
        )}
      </div>

      {composing && (
        <input
          autoFocus
          value={draft}
          disabled={sending}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void send();
            if (e.key === "Escape") setComposing(false);
          }}
          placeholder="Typed straight into the session — lands immediately, unlike a steer…"
          className="mt-2 w-full rounded-md border border-edge bg-ground px-2.5 py-2 text-sm text-text outline-none"
        />
      )}

      {output !== null && (
        <div className="mt-2">
          <pre className="m-0 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-edge-soft bg-ground px-3 py-2.5 font-mono text-[11px] leading-relaxed text-dim">
            {output}
          </pre>
          <div className="mt-1.5 flex items-center gap-3">
            <button onClick={() => void loadOutput()} className={linkButtonClass}>
              ↻ refresh
            </button>
            {!alive && (
              <span className="font-mono text-[10.5px] text-faint">session no longer running</span>
            )}
          </div>
        </div>
      )}

      {error && <div className="mt-[7px] font-mono text-[11px] text-waiting">{error}</div>}
    </div>
  );
}
