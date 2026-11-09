import type { PersonaJobNeed, PersonaJobState } from "@standup/shared";
import { theme } from "./theme";

/** How each derived job state (PersonaJob.view, see jobState) reads and is colored, everywhere a job is shown. */
export const JOB_STATE: Record<PersonaJobState, { label: string; color: string }> = {
  needs_you: { label: "needs you", color: theme.stalled },
  running: { label: "running", color: theme.running },
  idle: { label: "idle", color: theme.dim },
  done: { label: "done", color: theme.done },
  failed: { label: "failed", color: theme.waiting },
  cancelled: { label: "cancelled", color: theme.faint },
};

/** What each reason a job needs its owner reads as. */
export const JOB_NEED: Record<PersonaJobNeed, string> = {
  approval: "approval waiting",
  question: "question for you",
  waiting: "waiting on you",
};

/** The console route that opens one review packet (see ReviewView). */
export function reviewPath(reviewId: string): string {
  return `/review/${encodeURIComponent(reviewId)}`;
}

/** The console route that opens one worker session's transcript. */
export function sessionPath(sessionId: string): string {
  return `/work/s/${encodeURIComponent(sessionId)}`;
}
