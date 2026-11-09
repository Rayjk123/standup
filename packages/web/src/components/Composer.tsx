import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  ClaudeEffort,
  ClaudeModel,
  CodexEffort,
  HarnessId,
  LaunchPipelineMode,
  LaunchSuggestion,
  Project,
} from "@standup/shared";
import { alpha, theme } from "./theme";
import { ProjectIcon } from "./ProjectIcon";
import {
  CODEX_DEFAULT_EFFORT_VALUE,
  CODEX_MODEL_PLACEHOLDER,
  LAUNCH_MODEL_GROUPS,
  codexEffortFor,
  codexEffortOptions,
  launchClaudeModel,
  launchCodexModel,
  launchControlKind,
  launchModelHarness,
  launchModelLabel,
} from "../lib/launchOptions";

interface ComposerProps {
  projects: Project[];
  onLaunch: (
    projectId: string,
    task: string,
    model?: ClaudeModel,
    effort?: ClaudeEffort,
    inPlace?: boolean,
    planGate?: boolean,
    harness?: HarnessId,
    codexModel?: string,
    codexEffort?: CodexEffort,
    bypassPermissions?: boolean,
    pipeline?: LaunchPipelineMode | boolean
  ) => Promise<{ error?: string }>;
  /**
   * Bump this to focus the task input — e.g. from a "+ new chat" button
   * elsewhere on the page. A plain autoFocus attribute only fires once on
   * mount, which misses the case where the composer is already on screen
   * and the tab/route just switched to it without remounting.
   */
  focusSignal?: number;
}

const EFFORT_OPTIONS: { value: ClaudeEffort | ""; label: string }[] = [
  { value: "", label: "Default effort" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "X-high" },
  { value: "max", label: "Max" },
];

// The task field grows with its content up to this height (about seven rows at
// its line-height), then scrolls — a long task stays visible and editable
// without pushing the composer off-screen.
const TASK_MAX_HEIGHT = 170;

// A static (non-interactive) default pill — used to show a fixed value the user
// can't change here, like the sole project of a scoped composer. Same muted look
// as the interactive pills so the row reads as one ambient band.
const staticPillStyle: React.CSSProperties = {
  fontFamily: theme.sans,
  fontSize: 11.5,
  lineHeight: 1.2,
  color: theme.dim,
  background: "transparent",
  border: "1px solid transparent",
  borderRadius: 999,
  padding: "3px 10px",
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  whiteSpace: "nowrap",
  userSelect: "none",
};

const pillRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 5,
  marginBottom: 9,
};

// Popovers open UPWARD: the composer can sit at the bottom of the feed, where a
// downward panel would fall off-screen. Anchored above the pill it belongs to.
const popoverStyle: React.CSSProperties = {
  position: "absolute",
  bottom: "calc(100% + 6px)",
  left: 0,
  zIndex: 30,
  minWidth: 172,
  maxHeight: 280,
  overflowY: "auto",
  background: theme.raised,
  border: `1px solid ${theme.edge}`,
  borderRadius: 9,
  padding: 5,
  boxShadow: `0 10px 30px ${alpha(theme.shadow, 0.4)}`,
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

// A quiet text button inside a popover — the way back from the free-text entry
// to the list of offered options.
const linkButtonStyle: React.CSSProperties = {
  fontFamily: theme.sans,
  fontSize: 11,
  color: theme.faint,
  background: "none",
  border: "none",
  padding: "2px 0 0",
  cursor: "pointer",
  outline: "none",
};

const popoverInputStyle: React.CSSProperties = {
  fontSize: 12.5,
  color: theme.text,
  background: theme.surface,
  border: `1px solid ${theme.edge}`,
  borderRadius: 6,
  padding: "7px 9px",
  outline: "none",
};

/**
 * A launch-default pill: muted and borderless so it recedes into the
 * background, brightening only on hover or when active (a popover is open, a
 * toggle is on). `label` is the dimmer key ("model:"), `value` the current
 * setting.
 */
function PillButton({
  label,
  value,
  active,
  disabled,
  title,
  caret,
  ariaLabel,
  onClick,
}: {
  label?: string;
  value: ReactNode;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  caret?: boolean;
  ariaLabel?: string;
  onClick?: () => void;
}) {
  const [hover, setHover] = useState(false);
  const lit = (hover && !disabled) || !!active;
  return (
    <button
      type="button"
      title={title}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        fontFamily: theme.sans,
        fontSize: 11.5,
        lineHeight: 1.2,
        color: lit ? theme.text : theme.dim,
        background: active ? theme.raised : hover && !disabled ? theme.hover : "transparent",
        border: `1px solid ${active ? theme.edge : "transparent"}`,
        borderRadius: 999,
        padding: "3px 10px",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
        outline: "none",
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        whiteSpace: "nowrap",
        transition: "background 120ms ease, color 120ms ease, border-color 120ms ease",
        userSelect: "none",
      }}
    >
      {label && <span style={{ color: theme.faint }}>{label}</span>}
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>{value}</span>
      {caret && <span style={{ color: theme.faint, fontSize: 8.5, marginLeft: 1 }}>▾</span>}
    </button>
  );
}

/**
 * A value pill that opens a popover of options on click, closing on an outside
 * click or Escape. `children` renders the popover body and gets a `close`
 * callback so a selection can dismiss the popover.
 */
function SelectPill({
  label,
  value,
  disabled,
  title,
  children,
}: {
  label?: string;
  value: ReactNode;
  disabled?: boolean;
  title?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  // A launch in flight disables the controls; make sure an open popover closes
  // with them rather than lingering over the busy bar.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  return (
    <div ref={wrapRef} style={{ position: "relative", display: "inline-flex" }}>
      <PillButton
        label={label}
        value={value}
        active={open}
        disabled={disabled}
        title={title}
        caret
        onClick={() => setOpen((o) => !o)}
      />
      {open && <div style={popoverStyle}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

/** A boolean launch-default pill — flips its value directly on click. */
function TogglePill({
  label,
  on,
  disabled,
  title,
  onToggle,
}: {
  label: string;
  on: boolean;
  disabled?: boolean;
  title?: string;
  onToggle: () => void;
}) {
  return (
    <PillButton
      label={label}
      active={on}
      disabled={disabled}
      title={title}
      onClick={onToggle}
      value={<span style={on ? { color: theme.checkpoint } : undefined}>{on ? "on" : "off"}</span>}
    />
  );
}

/**
 * Asks the collector for an effort and a model suggestion for the task typed
 * so far (POST /api/decider/suggest). The suggestion is only shown: the
 * launch's own pickers change only when the user clicks "use". A new task
 * clears a shown suggestion, since it was for different text.
 */
function SuggestPill({
  task,
  disabled,
  onUse,
}: {
  task: string;
  disabled?: boolean;
  onUse: (s: { effort: string | null; model: string | null }) => void;
}) {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ready"; suggestion: LaunchSuggestion; forTask: string }
    | { kind: "error"; forTask: string }
  >({ kind: "idle" });

  const current = state.kind === "ready" && state.forTask === task.trim() ? state.suggestion : null;
  const failed = state.kind === "error" && state.forTask === task.trim();

  const ask = async () => {
    const text = task.trim();
    if (!text) return;
    setState({ kind: "loading" });
    try {
      const res = await fetch("/api/decider/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: text }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setState({ kind: "ready", suggestion: (await res.json()) as LaunchSuggestion, forTask: text });
    } catch {
      setState({ kind: "error", forTask: text });
    }
  };

  const effort = current?.effort?.choice ?? null;
  const model = current?.model?.choice ?? null;
  const value =
    state.kind === "loading"
      ? "…"
      : current
        ? [effort ?? "?", model ?? "?"].join(" · ")
        : failed
          ? "unavailable"
          : "ask";
  const via = current
    ? [current.effort, current.model]
        .filter((d): d is NonNullable<typeof d> => !!d)
        .map((d) => `${d.backend} ${d.latencyMs} ms${d.confidence !== null ? `, confidence ${d.confidence.toFixed(2)}` : ""}`)
        .join("; ")
    : "";

  return (
    <>
      <PillButton
        label="suggest:"
        value={<span style={current ? { color: theme.checkpoint } : undefined}>{value}</span>}
        disabled={disabled || !task.trim() || state.kind === "loading"}
        onClick={() => void ask()}
        title={
          current
            ? `Suggested effort · model for this task (${via}). A suggestion only — click "use" to pick it.`
            : "Suggest an effort and model for this task. A suggestion only: nothing changes until you pick it."
        }
      />
      {current && (effort || model) && (
        <PillButton
          value="use"
          ariaLabel={`Use the suggested effort ${effort ?? "(none)"} and model ${model ?? "(none)"}`}
          disabled={disabled}
          onClick={() => onUse({ effort, model })}
          title="Pick the suggested effort and model"
        />
      )}
    </>
  );
}

/**
 * A heading inside a pill's popover, separating one run of options from the next
 * — the Claude model list groups its pinned versions under their family.
 */
function PopoverGroupLabel({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        fontFamily: theme.sans,
        fontSize: 10,
        letterSpacing: 0.6,
        textTransform: "uppercase",
        color: theme.faint,
        padding: "6px 9px 2px",
      }}
    >
      {children}
    </span>
  );
}

/** A single option row inside a pill's popover. */
function PopoverOption({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        textAlign: "left",
        fontFamily: theme.sans,
        fontSize: 12.5,
        color: selected || hover ? theme.text : theme.dim,
        background: hover ? theme.hover : selected ? theme.surface : "transparent",
        border: "none",
        borderRadius: 6,
        padding: "6px 9px",
        cursor: "pointer",
        outline: "none",
        display: "flex",
        alignItems: "center",
        gap: 7,
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ width: 10, color: theme.checkpoint, fontSize: 11 }}>{selected ? "✓" : ""}</span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>{children}</span>
    </button>
  );
}

/**
 * Composer-as-launcher: pick a project, describe the work, and the console
 * starts a session for it — worktree, setup command, and a detached tmux
 * session it can attach to. Closes the loop the design describes: you no
 * longer leave the console to begin work.
 *
 * The chat bar itself carries only the task input + Start. Everything that
 * configures the launch — project, model, effort, plan approval, workspace reuse
 * — floats above it as a row of subtle "default" pills, so the defaults are
 * visible and adjustable without cluttering the input. The model pill also
 * decides the harness: Claude's and Codex's model spaces are disjoint, so one
 * list covers both and a separate harness pill could only disagree with it.
 */
export function Composer({ projects, onLaunch, focusSignal }: ComposerProps) {
  // Reserved projects (the GLOBAL best-practices corpus) have no repo to launch
  // against and must never appear in a new-session picker. Filtering here — at
  // the launcher itself — keeps that invariant regardless of which surface
  // passes the list in (the Work sidebar, or a future one).
  const launchableProjects = projects.filter((p) => !p.reserved);
  // Offer "no project — auto-detect" only where there's a choice to make (a
  // composer not scoped to one project). A composer scoped to a single project's page launches
  // straight into that project, so it defaults to it and hides the selector.
  const offerAuto = launchableProjects.length > 1;
  const [target, setTarget] = useState(offerAuto ? "" : launchableProjects[0]?.id ?? "");
  const [task, setTask] = useState("");
  // The one model pick, across both harnesses: a Claude value (alias or pinned
  // id), a Codex id, or "" for the project's default. Which CLI the launch drives
  // follows from it, so there is no separate harness control to contradict.
  // `modelOther` opens the free-text entry — the escape hatch for a Codex id the
  // offered list doesn't carry (a differently-provisioned build's).
  const [model, setModel] = useState<string>("");
  const [modelOther, setModelOther] = useState(false);
  const [effort, setEffort] = useState<ClaudeEffort | "">("");
  // Codex's reasoning effort, used only when the launch drives Codex.
  const [codexEffort, setCodexEffort] = useState<CodexEffort>(CODEX_DEFAULT_EFFORT_VALUE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taskInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (focusSignal) taskInputRef.current?.focus();
  }, [focusSignal]);

  // Grow the task field with its content: collapse to measure the natural
  // height, then set it to that height capped at TASK_MAX_HEIGHT (it scrolls
  // past the cap). Keyed on `task`, so clearing it on a successful submit also
  // snaps the field back to a single row.
  useEffect(() => {
    const el = taskInputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, TASK_MAX_HEIGHT)}px`;
  }, [task]);

  const selected = launchableProjects.find((p) => p.id === target);
  // Empty target = no project chosen: the launch starts as a scratch run and
  // the server infers the real project with Haiku once the session reports in.
  const isAuto = target === "";
  // No repo and no provision command → a scratch run: the agent starts in a
  // fresh empty directory. Anything selectable is launchable now — a repo
  // gets a worktree, a provision command builds a workspace, and everything
  // else is a scratch session. Auto also begins as a scratch run.
  const isScratch =
    isAuto || (!!selected && selected.repos.length === 0 && !selected.provision);
  const launchable = isAuto ? offerAuto : !!selected;

  // Which harness this launch drives, and so which effort ladder to show: the
  // picked model names it, else the selected project's own default, else Claude.
  const modelHarness = launchModelHarness(model.trim());
  const controlKind = launchControlKind(modelHarness ?? "", selected?.harness);

  // Multiplayer flips the in-place default off (see below). Only drives what
  // the toggle *shows* as its default — the launch decision itself stays with
  // the collector (see submit()). Polled, not fetched once, so cycling the
  // MultiplayerToggle elsewhere updates the shown default live rather than
  // waiting for a page reload; a failed poll keeps the last known value rather
  // than snapping to a stale false.
  const [multiplayer, setMultiplayer] = useState(false);
  useEffect(() => {
    const load = () =>
      fetch("/api/settings")
        .then((res) => res.json())
        .then((data) => setMultiplayer(!!data.multiplayer))
        .catch(() => {});
    void load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  // "Reuse the existing workspace" — skips `git worktree add` and setup, runs
  // claude directly in the project's repo. Only meaningful when a repo exists
  // and there is no provision command (a provisioned build has no single repo
  // to reuse). `inPlaceChoice` is the user's explicit pick, or null when they
  // haven't touched the toggle. Null means the launch sends no inPlace flag at
  // all, so the collector's live detection is authoritative — it applies the
  // project's own default solo and flips to a fresh worktree in multiplayer so
  // shared launches don't collide on one tree. Sending an explicit boolean is
  // reserved for a deliberate check/uncheck, which the collector then honors
  // verbatim. Cleared when the target project changes so a new pick falls back
  // to the collector's default again.
  const canInPlace = !!selected && selected.repos.length > 0 && !selected.provision;
  const [inPlaceChoice, setInPlaceChoice] = useState<boolean | null>(null);
  useEffect(() => {
    setInPlaceChoice(null);
  }, [target]);
  // What the toggle shows while untouched: mirror the collector's default so
  // the UI matches what a launch would actually do — the project's preference
  // solo, off in multiplayer. Recomputes when multiplayer flips, so the shown
  // default tracks the live setting.
  const inPlaceDefault = canInPlace && !multiplayer ? !!selected?.inPlace : false;
  const inPlace = inPlaceChoice ?? inPlaceDefault;

  // Plan-approval gate: pause this launch until a human approves the agent's
  // plan, then hold mark_ready until the acceptance criterion passes. The
  // project's own `planGate` is the shown default; toggling sends an explicit
  // per-launch override (which the collector's resolvePlanGate lets win over the
  // project default). Null = untouched, so the launch sends no flag and the
  // project default applies. Cleared when the target project changes.
  const [planGateChoice, setPlanGateChoice] = useState<boolean | null>(null);
  useEffect(() => {
    setPlanGateChoice(null);
  }, [target]);
  const planGate = planGateChoice ?? !!selected?.planGate;

  // Permission posture: bypassed behind the safety floor unless the project
  // opted out (bypassPermissions === false). Same override rule as the plan
  // gate — null sends no flag, so the project default (then bypass) governs.
  // Claude-only: Codex keeps its own posture, so the toggle hides for it.
  const [bypassChoice, setBypassChoice] = useState<boolean | null>(null);
  useEffect(() => {
    setBypassChoice(null);
  }, [target]);
  const bypassPermissions = bypassChoice ?? selected?.bypassPermissions !== false;

  // Delivery pipeline: the launch's kind decides by default — on for a git
  // worktree of the project's repo, off for a provisioned workspace. Off sends
  // `pipeline: "off"` for research, lookups, read-only or docs work; switching
  // it on for a provisioned project sends `"default"`; untouched sends no flag
  // so the collector decides.
  const provisioned = !!selected?.provision?.trim();
  const [pipelineChoice, setPipelineChoice] = useState<boolean | null>(null);
  useEffect(() => {
    setPipelineChoice(null);
  }, [target]);
  const pipelineOn = pipelineChoice ?? !provisioned;
  const pipelineMode: LaunchPipelineMode | undefined =
    pipelineChoice === null ? undefined : !pipelineChoice ? "off" : provisioned ? "default" : undefined;

  // The Codex levels the picked model takes, and the one a launch sends: the
  // chosen level when this model takes it, so switching models never sends a
  // level the new model rejects.
  const codexModelId = launchCodexModel(model.trim()) ?? "";
  const codexEffortChoices = codexEffortOptions(codexModelId);
  const launchCodexEffort = codexEffortFor(codexModelId, codexEffort);

  // Compact value labels for the default pills.
  const modelValue = launchModelLabel(model.trim());
  const effortValue =
    controlKind === "claude"
      ? effort === ""
        ? "default"
        : EFFORT_OPTIONS.find((o) => o.value === effort)?.label ?? "default"
      : codexEffortChoices.find((o) => o.value === launchCodexEffort)?.label ?? launchCodexEffort;

  async function submit() {
    if (!task.trim() || busy || !launchable) return;
    setBusy(true);
    setError(null);
    try {
      const result = await onLaunch(
        target,
        task.trim(),
        // The model pick is routed to the field its own harness reads: a Claude
        // value to `model`, a Codex id to `codexModel` (below). Sending it to both
        // would mislabel the session, and the two never apply at once.
        launchClaudeModel(model.trim()),
        controlKind === "claude" ? effort || undefined : undefined,
        // Only send an explicit flag when the user actually chose one. Left
        // undefined otherwise so the collector's live multiplayer detection
        // decides — it can't backstop an explicit boolean (an explicit true
        // launches in-place even in multiplayer, the collision we avoid).
        canInPlace ? inPlaceChoice ?? undefined : undefined,
        // Same rule for the plan gate: send an explicit override only when the
        // user touched it, else undefined so the project default governs.
        planGateChoice ?? undefined,
        // The harness the picked model implies; no pick sends none, so the
        // project's default (then claude) governs and the default path is unchanged.
        modelHarness,
        // A Codex id goes to Codex's own model field; "Codex (its own model)"
        // resolves to none, leaving the Codex CLI's configured model in place.
        launchCodexModel(model.trim()),
        controlKind === "codex" ? launchCodexEffort : undefined,
        controlKind === "claude" ? bypassChoice ?? undefined : undefined,
        pipelineMode
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
    <div style={{ borderTop: `1px solid ${theme.edge}`, padding: "12px 20px 16px" }}>
      {/* Floating launch defaults — ambient pills for what the next launch uses.
          They read as muted, receding chips rather than primary controls; a
          click opens each one's options (or toggles it). */}
      <div style={pillRowStyle}>
        {/* Project — auto-detect or a specific repo. A single-project composer
            has nothing to pick between, so it shows the fixed project instead. */}
        {launchableProjects.length > 1 ? (
          <SelectPill
            disabled={busy}
            title="Which project the next launch targets"
            value={
              isAuto ? (
                "✨ auto-detect"
              ) : (
                <>
                  <ProjectIcon project={selected} size={13} fallback="📦" /> {selected?.name}
                </>
              )
            }
          >
            {(close) => (
              <>
                <PopoverOption
                  selected={isAuto}
                  onClick={() => {
                    setTarget("");
                    setError(null);
                    close();
                  }}
                >
                  ✨ No project — auto-detect
                </PopoverOption>
                {launchableProjects.map((p) => (
                  <PopoverOption
                    key={p.id}
                    selected={target === p.id}
                    onClick={() => {
                      setTarget(p.id);
                      setError(null);
                      close();
                    }}
                  >
                    <ProjectIcon project={p} size={13} fallback="📦" /> {p.name}
                  </PopoverOption>
                ))}
              </>
            )}
          </SelectPill>
        ) : (
          selected && (
            <span style={staticPillStyle}>
              <ProjectIcon project={selected} size={13} fallback="📦" /> {selected.name}
            </span>
          )
        )}

        {/* Model — every model in one list: Claude's families and pinned
            versions, then Codex's ids. The pick names the harness too, so there
            is no separate harness control to contradict it. */}
        <SelectPill
          label="model:"
          value={modelValue}
          disabled={busy}
          title="Model to launch with, which also decides the CLI: a Claude value is passed as claude --model (a family tracks the newest model, a version pins the session to it), a Codex id as codex exec -m. Default leaves both to the project."
        >
          {(close) =>
            modelOther ? (
              // The escape hatch: Codex model ids are free-form, so an id the
              // offered list doesn't carry can still be typed. Anything typed here
              // is a Codex id — Claude's model space is the closed list.
              <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 210 }}>
                <input
                  autoFocus
                  value={model}
                  disabled={busy}
                  onChange={(e) => setModel(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && close()}
                  placeholder={CODEX_MODEL_PLACEHOLDER}
                  style={popoverInputStyle}
                />
                <button
                  type="button"
                  onClick={() => setModelOther(false)}
                  style={{ ...linkButtonStyle, alignSelf: "flex-start" }}
                >
                  ← back to the list
                </button>
              </div>
            ) : (
              <>
                <PopoverOption
                  selected={model === ""}
                  onClick={() => {
                    setModel("");
                    close();
                  }}
                >
                  Default model
                </PopoverOption>
                {LAUNCH_MODEL_GROUPS.map((group) => (
                  <div key={group.family} style={{ display: "flex", flexDirection: "column" }}>
                    <PopoverGroupLabel>{group.family}</PopoverGroupLabel>
                    {group.options.map((o) => (
                      <PopoverOption
                        key={o.value}
                        selected={model.trim() === o.value}
                        onClick={() => {
                          setModel(o.value);
                          close();
                        }}
                      >
                        {o.label}
                      </PopoverOption>
                    ))}
                  </div>
                ))}
                <PopoverOption
                  selected={
                    modelHarness === "codex" &&
                    !LAUNCH_MODEL_GROUPS.some((g) => g.options.some((o) => o.value === model.trim()))
                  }
                  // A typed id is a Codex one, so a Claude pick is cleared on the
                  // way in rather than sitting in the input as a bogus Codex id.
                  onClick={() => {
                    if (modelHarness === "claude") setModel("");
                    setModelOther(true);
                  }}
                >
                  Other Codex id…
                </PopoverOption>
              </>
            )
          }
        </SelectPill>

        {/* Effort — Claude's ladder, or Codex's reasoning-effort levels. */}
        {controlKind === "claude" ? (
          <SelectPill
            label="effort:"
            value={effortValue}
            disabled={busy}
            title="Effort level to launch with — passed as claude --effort"
          >
            {(close) =>
              EFFORT_OPTIONS.map((o) => (
                <PopoverOption
                  key={o.value}
                  selected={effort === o.value}
                  onClick={() => {
                    setEffort(o.value as ClaudeEffort | "");
                    close();
                  }}
                >
                  {o.label}
                </PopoverOption>
              ))
            }
          </SelectPill>
        ) : (
          <SelectPill
            label="effort:"
            value={effortValue}
            disabled={busy}
            title="Codex reasoning effort — passed as codex exec -c model_reasoning_effort=…"
          >
            {(close) =>
              codexEffortChoices.map((o) => (
                <PopoverOption
                  key={o.value}
                  selected={launchCodexEffort === o.value}
                  onClick={() => {
                    setCodexEffort(o.value);
                    close();
                  }}
                >
                  {o.label}
                </PopoverOption>
              ))
            }
          </SelectPill>
        )}

        {/* Effort and model suggestions — shown only; "use" is an explicit pick. */}
        {controlKind === "claude" && (
          <SuggestPill
            task={task}
            disabled={busy}
            onUse={(s) => {
              if (s.effort) setEffort(s.effort as ClaudeEffort);
              if (s.model) setModel(s.model);
            }}
          />
        )}

        {/* Plan approval — a toggle default. */}
        {launchable && (
          <TogglePill
            label="plan approval:"
            on={planGate}
            disabled={busy}
            onToggle={() => setPlanGateChoice(!planGate)}
            title={
              "Pause this launch until you approve the agent's plan, then hold mark_ready until its acceptance criterion passes." +
              (selected?.planGate ? " On by default for this project." : "")
            }
          />
        )}

        {/* Permission bypass behind the safety floor — a toggle default, Claude-only. */}
        {launchable && controlKind === "claude" && (
          <TogglePill
            label="bypass permissions:"
            on={bypassPermissions}
            disabled={busy}
            onToggle={() => setBypassChoice(!bypassPermissions)}
            title={
              "Run with permissions bypassed behind Standup's safety floor: outward-facing and destructive steps are still routed to Persona or you. Off runs --permission-mode auto with normal prompting." +
              (selected?.bypassPermissions === false ? " Off by default for this project." : "")
            }
          />
        )}

        {/* Delivery pipeline — a toggle default: on for a repo worktree, off for a provisioned workspace. */}
        {launchable && (
          <TogglePill
            label="delivery pipeline:"
            on={pipelineOn}
            disabled={busy}
            onToggle={() => setPipelineChoice(!pipelineOn)}
            title={
              "Walk this launch through the delivery pipeline (validation, adversarial review, deploy, screenshots, code review) before it can finish. " +
              "Turn off for research, lookups, read-only or docs-drafting work that won't change code." +
              (provisioned ? " Off by default for this project's provisioned workspace; turn on when this launch will ship a change." : "")
            }
          />
        )}

        {/* Reuse existing workspace — a toggle default, only when a repo can host it. */}
        {canInPlace && (
          <TogglePill
            label="reuse workspace:"
            on={inPlace}
            disabled={busy}
            onToggle={() => setInPlaceChoice(!inPlace)}
            title={
              multiplayer && !inPlace
                ? `Skip \`git worktree add\` and setup — run in ${selected?.repos[0]}. Off by default in multiplayer so shared launches don't collide; opt in to reuse the workspace.`
                : `Skip \`git worktree add\` and setup — start claude directly in ${selected?.repos[0]}. Cleanup won't touch the working dir.`
            }
          />
        )}
      </div>

      {/* This sits where a chat input would in a Slack-style feed, but it
          starts a whole new agent in its own worktree. Saying so prevents
          the obvious misread — that typing here messages a running session. */}
      <div
        style={{
          fontFamily: theme.mono,
          fontSize: 9.5,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: theme.faint,
          marginBottom: 7,
        }}
      >
        {isAuto
          ? "Start new work — no project needed; the right one is detected for you"
          : isScratch
            ? "Fire off a scratch agent — a Claude session in a fresh directory"
            : inPlace && canInPlace
              ? "Start new work — reuses the existing workspace, no worktree"
              : "Start new work — launches an agent in its own worktree"}
      </div>

      {/* The chat bar itself: just the task input + Start. Everything else that
          shapes the launch lives in the default pills above. */}
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          padding: "2px 0",
          background: "transparent",
        }}
      >
        <textarea
          ref={taskInputRef}
          value={task}
          disabled={busy}
          rows={1}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => {
            // Enter submits; Shift+Enter falls through to insert a newline.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={
            isAuto
              ? "Describe a task — we'll start an agent and detect the project…"
              : isScratch
                ? "Describe a task to fire off a scratch Claude session…"
                : "Describe a task to start a new agent on it…"
          }
          style={{
            flex: 1,
            fontFamily: "inherit",
            fontSize: 13.5,
            lineHeight: 1.5,
            color: theme.text,
            background: "transparent",
            border: "none",
            padding: "10px 4px",
            outline: "none",
            resize: "none",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            wordBreak: "break-word",
            overflowY: "auto",
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
          {isScratch
            ? "⧗ starting agent"
            : inPlace && canInPlace
              ? "⧗ starting agent in the existing workspace"
              : "⧗ creating worktree · running setup · starting agent"}
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
