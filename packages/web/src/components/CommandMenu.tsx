import { useCallback, useEffect, useState } from "react";
import type { KeyboardEvent } from "react";
import { PERSONA_COMMANDS } from "@standup/shared";
import type { PersonaCommandSpec } from "@standup/shared";
import { alpha, theme } from "./theme";

/**
 * The command word being typed, when the whole draft is `/word` (no space
 * yet): the `/` menu opens only at the start of a message.
 */
export function slashQuery(text: string): string | null {
  const m = /^\/([a-z0-9-]*)$/i.exec(text);
  return m ? m[1]!.toLowerCase() : null;
}

/** The commands whose name starts with `query`. */
export function matchCommands(query: string, commands: readonly PersonaCommandSpec[] = PERSONA_COMMANDS): PersonaCommandSpec[] {
  return commands.filter((c) => c.name.startsWith(query));
}

/**
 * The `/` command menu's state for one composer. Route the textarea's keydown
 * through `onKeyDown` first (it returns true when it consumed the key).
 * Enter or a click runs the highlighted command; Tab completes it into the
 * draft; Esc closes the menu until the draft changes.
 */
export function useSlashCommandPicker({
  text,
  setText,
  onRun,
  enabled = true,
  commands = PERSONA_COMMANDS,
}: {
  text: string;
  setText: (text: string) => void;
  /** Runs `/name`; the composer clears its draft. */
  onRun: (text: string) => void;
  enabled?: boolean;
  commands?: readonly PersonaCommandSpec[];
}) {
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const query = enabled ? slashQuery(text) : null;
  const matches = query === null ? [] : matchCommands(query, commands);
  const open = query !== null && dismissed !== text && matches.length > 0;
  const current = open ? matches[Math.min(active, matches.length - 1)] : undefined;

  useEffect(() => setActive(0), [query]);
  // Esc closes the menu for this draft only; any edit lets a `/` open it again.
  useEffect(() => {
    if (dismissed !== null && dismissed !== text) setDismissed(null);
  }, [text, dismissed]);

  const run = useCallback((c: PersonaCommandSpec) => onRun(`/${c.name}`), [onRun]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open || !current || e.nativeEvent.isComposing) return false;
      if (e.key === "Escape") {
        // The menu's Esc is spent here, not on a drawer listening on the window.
        e.stopPropagation();
        setDismissed(text);
        return true;
      }
      if (e.key === "ArrowDown") {
        setActive((i) => (i + 1) % matches.length);
        return true;
      }
      if (e.key === "ArrowUp") {
        setActive((i) => (i - 1 + matches.length) % matches.length);
        return true;
      }
      // Tab completes once; on a completed draft (or with Shift) focus moves on as usual.
      if (e.key === "Tab" && !e.shiftKey && text !== `/${current.name}`) {
        setText(`/${current.name}`);
        return true;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        run(current);
        return true;
      }
      return false;
    },
    [open, current, matches.length, text, setText, run]
  );

  return { open, matches, active, current, run, onKeyDown };
}

/** The DOM id of the menu's option for `name`, for the textarea's aria-activedescendant. */
export function commandOptionId(name: string): string {
  return `slash-command-${name}`;
}

export const COMMAND_MENU_ID = "slash-command-menu";

/** The `/` menu, floated above the composer. */
export function SlashCommandMenu({
  matches,
  active,
  onRun,
}: {
  matches: PersonaCommandSpec[];
  active: number;
  onRun: (command: PersonaCommandSpec) => void;
}) {
  return (
    <div
      role="listbox"
      id={COMMAND_MENU_ID}
      aria-label="Commands"
      data-testid="slash-command-menu"
      style={{
        position: "absolute",
        left: 12,
        right: 12,
        bottom: "100%",
        marginBottom: 4,
        maxHeight: 260,
        overflowY: "auto",
        background: theme.surface,
        border: `1px solid ${theme.edge}`,
        borderRadius: 8,
        boxShadow: `0 6px 24px ${alpha(theme.shadow, 0.35)}`,
        padding: 4,
        zIndex: 20,
      }}
    >
      <div style={{ padding: "4px 8px 6px", fontSize: 10.5, color: theme.faint }}>
        Commands run instantly and don't go to Persona · ↑↓ to choose, Enter to run, Esc to close
      </div>
      {matches.map((c, i) => (
        <div
          key={c.name}
          id={commandOptionId(c.name)}
          role="option"
          aria-selected={i === active}
          // mousedown, not click: the textarea keeps focus.
          onMouseDown={(e) => {
            e.preventDefault();
            onRun(c);
          }}
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 10,
            padding: "6px 8px",
            borderRadius: 5,
            cursor: "pointer",
            background: i === active ? theme.ground : "transparent",
          }}
        >
          <span style={{ flexShrink: 0, fontFamily: theme.mono, fontSize: 12.5, fontWeight: 600, color: theme.accent }}>/{c.name}</span>
          <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: theme.dim }}>{c.description}</span>
        </div>
      ))}
    </div>
  );
}
