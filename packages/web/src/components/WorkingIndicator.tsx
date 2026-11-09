import { useEffect, useState } from "react";
import { theme } from "./theme";
import { turnPhase, type ActivityTail } from "../lib/turnPhase";

/** Braille spinner frames, the same shape Claude Code's own TUI spinner uses. */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 120;

function humanElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * The transcript's live "…working" line: a spinner, what the agent is currently
 * doing, and a counter that ticks while it does it.
 *
 * It exists because the transcript alone can't show movement — a tool call and
 * its result are two polls apart, and in between the console looked frozen even
 * though Slack's mirror was saying "is running Bash…". The spinner and the
 * counter animate off a local timer, not off the poll, so the UI stays alive
 * between refreshes; the phase itself comes from the transcript tail (see
 * turnPhase). Renders nothing when there's no work to claim — a rested turn, an
 * ended session, or one blocked on a question.
 */
export function WorkingIndicator({
  tail,
  tailAt,
  sessionEnded,
  blocked,
  mono,
}: {
  tail?: ActivityTail;
  tailAt?: string | number;
  sessionEnded: boolean;
  blocked?: boolean;
  /** Match the terminal view's monospace body rather than the card view's sans. */
  mono?: boolean;
}) {
  const [tick, setTick] = useState(0);
  // One timer for both the spinner frame and the elapsed counter. Stopped once
  // there is nothing to animate, so an idle session isn't re-rendering forever.
  const idle = sessionEnded || blocked || !tail;
  useEffect(() => {
    if (idle) return;
    const timer = setInterval(() => setTick((t) => t + 1), FRAME_MS);
    return () => clearInterval(timer);
  }, [idle]);

  const phase = turnPhase({ tail, tailAt, sessionEnded, blocked, now: Date.now() });
  if (!phase) return null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 20px",
        fontFamily: mono ? theme.mono : theme.sans,
        fontSize: 11.5,
        color: theme.running,
        borderTop: `1px solid ${theme.edgeSoft}`,
        background: theme.ground,
      }}
    >
      <span style={{ fontFamily: theme.mono }}>{FRAMES[tick % FRAMES.length]}</span>
      <span>{phase.label}…</span>
      <span style={{ fontFamily: theme.mono, fontSize: 10.5, color: theme.faint }}>
        {humanElapsed(phase.sinceMs)}
      </span>
    </div>
  );
}
