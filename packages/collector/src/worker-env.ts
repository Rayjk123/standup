import { SLOT_ENV_VARS } from "@standup/shared/topology";
import { scrubSecretEnv } from "./owner-secret.js";

const SLOT_ENV: ReadonlySet<string> = new Set(SLOT_ENV_VARS);

/** The tmux pane of the collector's own terminal: with it a bare `tmux …` reaches the server the collector runs in. */
const TMUX_PANE_ENV: ReadonlySet<string> = new Set(["TMUX", "TMUX_PANE"]);

/**
 * `env` without the collector's slot vars (SLOT_ENV_VARS) and without the
 * `$TMUX` and `$TMUX_PANE` of a tmux the collector itself may run in. The slot
 * vars name the slot and ports this collector process binds; a process it
 * launches is not that collector and must not learn its private listen ports
 * from them, nor reach its terminal's tmux server by default.
 */
export function withoutSlotEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !SLOT_ENV.has(key) && !TMUX_PANE_ENV.has(key)) out[key] = value;
  }
  return out;
}

/**
 * The environment a worker the collector launches starts with: no owner-side
 * secret (scrubSecretEnv) and none of withoutSlotEnv's vars. The launcher
 * spawns tmux with this, so a tmux server the launch starts hands none of them
 * to the panes it hosts.
 */
export function workerEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return withoutSlotEnv(scrubSecretEnv(env));
}
