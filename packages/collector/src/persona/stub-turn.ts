import { randomBytes } from "crypto";
import { realpathSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import type { TurnRunner } from "./turn.js";

/**
 * Set to "1" on a scratch collector to answer every Persona turn with a
 * scripted reply instead of running `claude`: no model, no process, no tool
 * calls. For harnesses that drive Persona's post paths (owner turns, wakeups,
 * schedule runs, worker events) and only need each turn to post something.
 */
export const PERSONA_STUB_TURNS_ENV = "STANDUP_PERSONA_STUB_TURNS";

/**
 * Whether `env` asks for scripted Persona turns and may have them: only a
 * collector with its own DB_PATH, never one on the install's default data dir
 * (`defaultDataDbPath`), whose real inbox items a stub would consume.
 */
export function stubTurnsEnabled(env: Record<string, string | undefined>, defaultDataDbPath: string): boolean {
  if (env[PERSONA_STUB_TURNS_ENV] !== "1") return false;
  const dbPath = env.DB_PATH?.trim();
  return !!dbPath && canonical(dbPath) !== canonical(defaultDataDbPath);
}

/** `path` with its directory's symlinks resolved, so two spellings of one data dir compare equal. */
function canonical(path: string): string {
  const abs = resolve(path);
  try {
    return join(realpathSync(dirname(abs)), basename(abs));
  } catch {
    return abs;
  }
}

/**
 * A turn runner that never spawns anything: each turn resolves at once with
 * "stub reply" and random hex words, distinct enough that Persona's
 * near-duplicate check never drops one.
 */
export function createStubTurnRunner(): TurnRunner {
  return async () => {
    const words = randomBytes(16).toString("hex").match(/.{4}/g)!.join(" ");
    return { ok: true, text: `stub reply ${words}`, sessionId: "stub-session", costUsd: 0 };
  };
}
