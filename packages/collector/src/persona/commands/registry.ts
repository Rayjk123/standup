import type { Database } from "bun:sqlite";
import { PERSONA_COMMANDS } from "@standup/shared";
import type { PersonaCommandResult } from "@standup/shared";
import type { HostMonitor } from "../../host-headroom.js";
import type { ProcessSystem } from "../../process-registry.js";
import type { RestartRecord } from "../../restart/state.js";
import type { CollectorHealth } from "../../server.js";
import type { PersonaRuntime } from "../runtime.js";
import { ramCommand, type RamReaders } from "./ram.js";
import { stateCommand } from "./state.js";

// The collector's half of the slash-command registry: one handler per name in
// PERSONA_COMMANDS. A handler is a deterministic read — of the store, the
// collector's in-memory state and the host's process table — never a Persona
// turn, an LLM call or a write.

/** What a handler reads from. Every part is injected, so a test can stub it. */
export interface PersonaCommandContext {
  db: Database;
  /** The user the command runs for; every read is scoped to them. */
  owner: string;
  now: Date;
  args: string;
  /** The owner's Persona, when it is running (its config and capacity). */
  runtime?: PersonaRuntime;
  health?: CollectorHealth;
  /** The newest restart record, read in-process. */
  latestRestart?: () => RestartRecord | null;
  hostMonitor?: HostMonitor;
  /** The host alias; only its user sees the host's processes in `/ram`. */
  host?: string;
  /** The host's processes, for `/ram`; the real host when unset. */
  processes?: ProcessSystem;
  /** Standup's install dir, for `/ram`; resolved from the environment when unset. */
  installDir?: string;
  /** /proc/meminfo, resident memory and the workers' panes, for `/ram`; the real host when unset. */
  ramReaders?: RamReaders;
}

export interface PersonaCommandOutput {
  data: unknown;
  /** One plain-language line: the result message's text. */
  summary: string;
}

export interface PersonaCommandHandler {
  name: string;
  run(ctx: PersonaCommandContext): PersonaCommandOutput;
}

/** Every handler, keyed by command name. */
export const COMMAND_HANDLERS: ReadonlyMap<string, PersonaCommandHandler> = new Map(
  [stateCommand, ramCommand].map((h) => [h.name, h])
);

/** The command names PERSONA_COMMANDS lists without a handler here, or the reverse. */
export function unmatchedCommandNames(): string[] {
  const listed = new Set(PERSONA_COMMANDS.map((c) => c.name));
  return [
    ...[...listed].filter((n) => !COMMAND_HANDLERS.has(n)),
    ...[...COMMAND_HANDLERS.keys()].filter((n) => !listed.has(n)),
  ];
}

/**
 * Runs command `name`. A handler that throws yields a failed result whose
 * summary says so, so the owner always gets a card back.
 */
export function runPersonaCommand(
  name: string,
  ctx: PersonaCommandContext,
  handlers: ReadonlyMap<string, PersonaCommandHandler> = COMMAND_HANDLERS
): PersonaCommandResult | null {
  const handler = handlers.get(name);
  if (!handler) return null;
  const started = performance.now();
  try {
    const out = handler.run(ctx);
    return { ok: true, data: out.data, summary: out.summary, ranAt: ctx.now.toISOString(), ms: Math.round(performance.now() - started) };
  } catch (err) {
    console.error(`[persona] /${name} failed:`, err);
    return {
      ok: false,
      data: null,
      summary: `/${name} couldn't run just now. Try again in a moment.`,
      ranAt: ctx.now.toISOString(),
      ms: Math.round(performance.now() - started),
    };
  }
}
