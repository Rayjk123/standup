import { useEffect, useRef, useState } from "react";
import { LuSquare, LuArrowUp } from "react-icons/lu";
import type { ClaudeEffort, ClaudeModel, Session } from "@standup/shared";
import { theme } from "./theme";
import { usePresence } from "../hooks/presence";
import {
  CLAUDE_EFFORTS,
  CLAUDE_MODEL_GROUPS,
  CLAUDE_MODEL_OPTIONS,
  claudeModelLabel,
} from "../lib/launchOptions";

/**
 * A key for the reply's idempotency claim. Prefers crypto.randomUUID, but that
 * is only defined in a secure context (https / localhost); served over a plain
 * http LAN origin it is undefined and would throw, silently dropping the reply.
 * Fall back to a random string so a reply always sends.
 */
function mintIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const rand = () => Math.random().toString(36).slice(2);
  return `k-${Date.now().toString(36)}-${rand()}${rand()}`;
}

/**
 * Per-session storage key for an unsent reply draft. The reply box is
 * conditionally unmounted whenever the user switches the detail tab
 * (transcript ↔ checkpoints ↔ info), flips transcript ↔ terminal, or navigates
 * to another top-level tab, which would otherwise discard the local draft.
 * Persisting it here keeps a half-typed reply alive across those remounts and a
 * full page reload. Keyed only on the session, so the card and terminal views
 * share one draft — flipping views keeps the same text.
 */
function draftStorageKey(sessionId: string): string {
  return `standup:draft:${sessionId}`;
}

/** The reply field grows with its content up to this height, then scrolls. */
const REPLY_MAX_HEIGHT = 160;

/** Guarded read — localStorage is undefined on a plain-http LAN origin / private mode. */
function readDraft(sessionId: string): string {
  try {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem(draftStorageKey(sessionId)) ?? "";
  } catch {
    return "";
  }
}

/** Guarded write — an empty draft clears the key so a sent reply doesn't linger. */
function persistDraft(sessionId: string, text: string): void {
  try {
    if (typeof window === "undefined") return;
    if (text) window.localStorage.setItem(draftStorageKey(sessionId), text);
    else window.localStorage.removeItem(draftStorageKey(sessionId));
  } catch {
    // localStorage can be unavailable or full; a lost draft isn't worth throwing.
  }
}

/** The slice of a session the model/effort switcher reads. */
export type SessionModelSettings = Pick<
  Session,
  "harness" | "liveModel" | "liveEffort" | "launchModel" | "launchEffort"
>;

/**
 * Model + effort switchers for a running Claude session. Each pick posts to
 * `/api/sessions/:id/settings`, which types Claude Code's `/model` or `/effort`
 * at the agent's prompt. The selects show the session's observed live value,
 * falling back to what its launch recorded; a successful switch is held locally
 * until the live value catches up (the model only shows up on the next turn).
 * Disabled mid-turn — a slash command typed into a busy pane is queued behind
 * the turn rather than applied.
 */
function ModelEffortSwitcher({
  sessionId,
  settings,
  working,
  terminal,
  onError,
}: {
  sessionId: string;
  settings: SessionModelSettings;
  working: boolean;
  terminal: boolean;
  onError: (message: string | null) => void;
}) {
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // A newly observed live value is ground truth again — it reflects the switch
  // (or a /model typed in the pane itself), so drop the local hold.
  useEffect(() => setModel(null), [settings.liveModel]);
  useEffect(() => setEffort(null), [settings.liveEffort]);

  const currentModel = model ?? settings.liveModel ?? settings.launchModel ?? "";
  const currentEffort = effort ?? settings.liveEffort ?? settings.launchEffort ?? "";
  const knownModel = CLAUDE_MODEL_OPTIONS.some((o) => o.value === currentModel);
  const knownEffort = (CLAUDE_EFFORTS as string[]).includes(currentEffort);
  const disabled = working || saving;

  async function apply(change: { model?: ClaudeModel; effort?: ClaudeEffort }) {
    setSaving(true);
    onError(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(change),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        onError(data.error ?? "Couldn't change the session's settings");
        return;
      }
      if (change.model) setModel(change.model);
      if (change.effort) setEffort(change.effort);
    } catch {
      onError("Couldn't reach the collector — settings not changed.");
    } finally {
      setSaving(false);
    }
  }

  const idleHint = "Applies when the agent is idle — wait for the current turn to finish.";
  const selectStyle: React.CSSProperties = {
    fontSize: 11.5,
    fontFamily: theme.mono,
    color: theme.faint,
    background: "none",
    border: `1px solid ${theme.edge}`,
    borderRadius: terminal ? 3 : 4,
    padding: "1px 4px",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.6 : 1,
  };

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 7 }}>
      <select
        value={currentModel}
        disabled={disabled}
        onChange={(e) => {
          if (e.target.value) void apply({ model: e.target.value as ClaudeModel });
        }}
        title={
          working
            ? idleHint
            : "Switch this session's model — sends /model at its prompt. A family (latest) tracks the newest model; a version pins the session to it."
        }
        style={selectStyle}
      >
        {!currentModel && <option value="">model: default</option>}
        {currentModel && !knownModel && (
          <option value={currentModel}>{claudeModelLabel(currentModel)}</option>
        )}
        {CLAUDE_MODEL_GROUPS.map((group) => (
          <optgroup key={group.family} label={group.family}>
            {group.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <select
        value={currentEffort}
        disabled={disabled}
        onChange={(e) => {
          if (e.target.value) void apply({ effort: e.target.value as ClaudeEffort });
        }}
        title={working ? idleHint : "Switch this session's effort — sends /effort at its prompt"}
        style={selectStyle}
      >
        {!currentEffort && <option value="">effort: default</option>}
        {currentEffort && !knownEffort && <option value={currentEffort}>{currentEffort}</option>}
        {CLAUDE_EFFORTS.map((level) => (
          <option key={level} value={level}>
            effort: {level}
          </option>
        ))}
      </select>
      {saving && (
        <span style={{ fontFamily: theme.mono, fontSize: 10.5, color: theme.faint }}>
          switching…
        </span>
      )}
    </div>
  );
}

/**
 * The reply box shared by every rendering of a session's conversation. Typing
 * here goes straight into the agent's pane, so it is only offered when Standup
 * owns the session; a monitored session belongs to the human's own terminal.
 *
 * `terminal` swaps the card-style input for a `>`-prompt monospace line to
 * match the surrounding TerminalView.
 */
export function TranscriptReply({
  sessionId,
  owned,
  onSent,
  working = false,
  terminal = false,
  focusSignal = 0,
  onFocused,
  settings,
}: {
  sessionId: string;
  owned: boolean;
  /**
   * The session's model/effort, when known. Shown as switchers under the reply
   * box for a Claude session; omitted (or a non-Claude harness) hides them.
   */
  settings?: SessionModelSettings;
  /** Called after a successful send so the caller can re-read the transcript. */
  onSent: () => void;
  /**
   * Whether a turn is currently running. Gates the interrupt affordance: Esc
   * and the stop button only act while there's a turn to interrupt, mirroring
   * Claude Code (Esc is a no-op at an idle prompt).
   */
  working?: boolean;
  terminal?: boolean;
  /**
   * Bumped to pull focus into the input — the "Jump in" affordance lands you
   * straight in the reply box (spec F) rather than leaving you to hunt for it.
   */
  focusSignal?: number;
  /**
   * Called once the signal has been acted on, so the owner can reset it back to
   * 0. Without this reset the leftover value would re-grab focus on a later
   * remount (opening another session, toggling transcript/terminal).
   */
  onFocused?: () => void;
}) {
  const [draft, setDraft] = useState(() => readDraft(sessionId));
  const [sending, setSending] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { setTyping } = usePresence();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // The idempotency key for the reply in flight. Minted once per distinct send
  // and held across a failed attempt so a retry reuses it — the server dedups on
  // the key, so a double-click or retry types into the pane exactly once. Cleared
  // on success, so the next reply gets a fresh key.
  const keyRef = useRef<string | null>(null);

  // Only a live "jump in" (focusSignal > 0) pulls focus into the input. We then
  // notify the owner so it clears the signal to 0 — a stale positive value read
  // on a fresh mount (a different session, or a transcript/terminal toggle,
  // both of which remount this box) must not steal the keyboard.
  useEffect(() => {
    if (focusSignal > 0) {
      inputRef.current?.focus();
      onFocused?.();
    }
  }, [focusSignal]);

  // Keep the draft alive across the remounts caused by tab / view switches (and
  // a page reload) by mirroring it to localStorage under the session's key.
  useEffect(() => {
    persistDraft(sessionId, draft);
  }, [draft, sessionId]);

  // Grow the field with its content: collapse to measure the natural height,
  // then set it to that height capped at REPLY_MAX_HEIGHT (it scrolls past the
  // cap). Keyed on `draft`, so clearing it on a send snaps back to one row.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, REPLY_MAX_HEIGHT)}px`;
  }, [draft]);

  async function send() {
    if (!draft.trim() || sending) return;
    const text = draft.trim();
    if (!keyRef.current) keyRef.current = mintIdempotencyKey();
    const idempotencyKey = keyRef.current;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, idempotencyKey }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Keep keyRef so a retry reuses the same key and the server dedups it.
        setError(data.error ?? "Send failed");
        return;
      }
      setDraft("");
      keyRef.current = null;
      setTyping(false);
      // Give the agent a moment to react before re-reading.
      setTimeout(onSent, 1500);
    } catch {
      // A rejected fetch (collector unreachable, dropped connection) never
      // hits the !res.ok branch, so surface it rather than failing silently.
      setError("Couldn't reach the collector — reply not sent.");
    } finally {
      setSending(false);
    }
  }

  async function interrupt() {
    if (interrupting) return;
    setInterrupting(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/interrupt`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Interrupt failed");
        return;
      }
      // Pull the transcript so the interrupted turn settles in the view.
      setTimeout(onSent, 800);
    } catch {
      setError("Couldn't reach the collector — interrupt not sent.");
    } finally {
      setInterrupting(false);
    }
  }

  const borderTop = `1px solid ${terminal ? theme.edgeSoft : theme.edge}`;

  if (!owned) {
    return (
      <div style={{ borderTop, padding: "10px 20px 14px" }}>
        <div
          style={{
            fontSize: 12,
            fontFamily: terminal ? theme.mono : undefined,
            color: theme.faint,
            lineHeight: 1.5,
          }}
        >
          Read-only — Standup didn't launch this session, so it can't type into
          it. Reply in its own terminal.
        </div>
      </div>
    );
  }

  return (
    <div style={{ borderTop, padding: "10px 20px 14px" }}>
      <div
        style={{
          display: "flex",
          // Anchor the buttons to the bottom of the box so they stay put as the
          // textarea grows taller with a multi-line draft.
          alignItems: "flex-end",
          gap: 8,
          border: terminal ? "none" : `1px solid ${theme.edge}`,
          borderRadius: terminal ? 0 : 6,
          background: theme.ground,
          padding: terminal ? "4px 0" : "5px 5px 5px 11px",
        }}
      >
        {terminal && (
          <span style={{ fontFamily: theme.mono, fontSize: 13, color: theme.checkpoint, padding: "6px 0" }}>
            &gt;
          </span>
        )}
        <textarea
          ref={inputRef}
          value={draft}
          disabled={sending}
          rows={1}
          onChange={(e) => {
            setDraft(e.target.value);
            // Presence typing signal: on while there's a draft, off when empty.
            setTyping(e.target.value.trim().length > 0);
          }}
          onBlur={() => setTyping(false)}
          onKeyDown={(e) => {
            // Enter submits; Shift+Enter falls through to insert a newline.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
            // Esc interrupts the running turn, the way it does in Claude Code —
            // but only while a turn is running, so an idle prompt keeps Esc free
            // to do nothing (and not swallow it from the surrounding UI).
            else if (e.key === "Escape" && working) {
              e.preventDefault();
              e.stopPropagation();
              void interrupt();
            }
          }}
          placeholder={
            working
              ? "Reply, or press Esc to interrupt…"
              : "Reply to this agent — types straight into its session…"
          }
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 13,
            lineHeight: 1.5,
            fontFamily: terminal ? theme.mono : "inherit",
            color: theme.text,
            background: "transparent",
            border: "none",
            padding: terminal ? 0 : "6px 0",
            outline: "none",
            resize: "none",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            wordBreak: "break-word",
            overflowY: "auto",
          }}
        />
        {/* Visible twin of the Esc shortcut — the button covers the reader who
            isn't focused in the input, and labels the keystroke for the one who
            is. Only offered while a turn is running. */}
        {working && (
          <button
            onClick={() => void interrupt()}
            disabled={interrupting}
            title="Interrupt the current turn (Esc)"
            style={{
              flexShrink: 0,
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              fontSize: 11.5,
              fontFamily: theme.mono,
              color: theme.ground,
              background: theme.waiting,
              border: "none",
              borderRadius: terminal ? 3 : 5,
              padding: "6px 10px",
              cursor: interrupting ? "not-allowed" : "pointer",
              opacity: interrupting ? 0.6 : 1,
            }}
          >
            <LuSquare style={{ verticalAlign: "-1px" }} />
            {interrupting ? "interrupting…" : "esc to interrupt"}
          </button>
        )}
        {/* Send is the visible twin of Enter — for the reader who'd rather click,
            and so the affordance is discoverable at all. Disabled with nothing
            to send so a stray click can't fire an empty reply. */}
        <button
          onClick={() => void send()}
          disabled={sending || draft.trim().length === 0}
          title="Send reply (Enter)"
          style={{
            flexShrink: 0,
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: 11.5,
            fontFamily: theme.mono,
            color: theme.ground,
            background: theme.running,
            border: "none",
            borderRadius: terminal ? 3 : 5,
            padding: "6px 10px",
            cursor: sending || draft.trim().length === 0 ? "not-allowed" : "pointer",
            opacity: sending || draft.trim().length === 0 ? 0.5 : 1,
          }}
        >
          <LuArrowUp style={{ verticalAlign: "-1px" }} />
          {sending ? "sending…" : "send"}
        </button>
      </div>
      {settings && (settings.harness ?? "claude") === "claude" && (
        <ModelEffortSwitcher
          key={sessionId}
          sessionId={sessionId}
          settings={settings}
          working={working}
          terminal={terminal}
          onError={setError}
        />
      )}
      {error && (
        <div
          style={{
            fontFamily: theme.mono,
            fontSize: 11,
            color: theme.waiting,
            marginTop: 7,
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
