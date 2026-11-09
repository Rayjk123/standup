import { personaAttachVideoMaxBytes } from "@standup/shared";
import { HOLDABLE } from "./policy.js";
import { resolveDelegateSwitches } from "./delegates.js";

/**
 * Persona's env knobs, resolved once at startup. Every knob has a default so an
 * unset environment runs Persona as designed; `STANDUP_PERSONA=0` turns it off.
 */
export interface PersonaConfig {
  enabled: boolean;
  /** `claude --model` for Persona's own turns. */
  model: string;
  /** `claude --effort` for Persona's own turns. */
  effort: string;
  /** Persona-owned launches allowed in flight at once; past it a launch is queued. */
  maxActive: number;
  /** Hard wall-clock limit on one turn; the subprocess is killed past it. */
  turnTimeoutMs: number;
  /**
   * Context size past which the conversation rotates onto a fresh epoch
   * (`STANDUP_PERSONA_ROTATE_TOKENS`). Unset derives it from the model's
   * window (rotationTokens), so the CLI's auto-compaction runs first.
   */
  rotateTokens?: number;
  /** How long routine worker events wait to be folded into one wake. */
  coalesceMs: number;
  /** Per-turn `--max-budget-usd`; undefined passes no budget flag. */
  turnBudgetUsd?: number;
  /**
   * Routine actions the owner holds for approval (`STANDUP_PERSONA_HOLD`, comma
   * separated; see HOLDABLE). Empty runs routine orchestration on Persona's word.
   */
  hold: string[];
  /** Names in `STANDUP_PERSONA_HOLD` that aren't holdable, reported at startup. */
  unknownHolds: string[];
  /** Claude turns allowed at once across every user's Persona on this host. */
  maxConcurrentTurns: number;
  /** Persona runtimes (the host's included) this host keeps at most. */
  maxUsers: number;
  /**
   * Image blocks one Claude session of Persona's may be sent over its life
   * (`STANDUP_PERSONA_SESSION_IMAGE_BUDGET`); a turn that would pass it
   * starts a fresh session.
   */
  sessionImageBudget: number;
  /** Base64 bytes of images one session may be sent over its life (`STANDUP_PERSONA_SESSION_IMAGE_BYTES`). */
  sessionImageBytesBudget: number;
  /**
   * Percent of the context window at which Persona's own Claude session
   * auto-compacts (`STANDUP_PERSONA_AUTOCOMPACT_PCT`, 1–100). Handed to each
   * turn as `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`; worker sessions never get it.
   */
  autoCompactPct: number;
  /**
   * The second check on Persona's "Allow once" of a safety-floor hold
   * (allow-check.ts); `STANDUP_PERSONA_REVIEW=0` turns it off.
   */
  allowCheck: boolean;
  /**
   * The model layer of that check, run on owner-gate allows:
   * `STANDUP_PERSONA_REVIEW_MODEL` is the `claude --model` it runs on (`off`:
   * rules only). Unset, it is the Haiku id the collector's other ancillary
   * calls use: the CLI's own default model took 27–45s on this short
   * classifier prompt.
   */
  allowCheckModel?: string;
  /** Whether the model layer runs at all (false when the model setting is `off`). */
  allowCheckModelEnabled: boolean;
  /**
   * The model layer's deadline (`STANDUP_PERSONA_REVIEW_TIMEOUT_MS`); past it
   * the owner-gate allow is flagged.
   */
  allowCheckTimeoutMs: number;
  /** Largest video attach_video takes, in bytes (`STANDUP_PERSONA_ATTACH_VIDEO_MAX_MB`; see personaAttachVideoMaxBytes). */
  attachVideoMaxBytes: number;
  /**
   * Which delegate agents (delegates.ts) are on, by id: `STANDUP_PERSONA_DELEGATES=0`
   * turns them all off, `STANDUP_PERSONA_DELEGATE_<ID>` one (see resolveDelegateSwitches).
   * An agent that is off leaves its events to the main Persona.
   */
  delegates: Record<string, boolean>;
}

/** Default of PersonaConfig.autoCompactPct. */
export const PERSONA_AUTOCOMPACT_PCT = 40;
/** Percentage points of the window the derived rotation size sits above the compaction percent. */
export const ROTATE_PCT_MARGIN = 5;
/** Highest percent of the window the derived rotation size takes. */
export const ROTATE_PCT_MAX = 95;
/** Rotation size when neither STANDUP_PERSONA_ROTATE_TOKENS nor the model's window is known. */
export const ROTATE_TOKENS_FALLBACK = 450_000;

/**
 * The context size past which Persona's session rotates: the configured
 * `rotateTokens` when set, else `autoCompactPct + ROTATE_PCT_MARGIN` percent of
 * `contextWindow` (45% by default: about 450k on a 1M window, 90k on 200k),
 * else ROTATE_TOKENS_FALLBACK. The derived percent is capped at
 * ROTATE_PCT_MAX so it stays reachable below the window. Sitting above the
 * compaction percent makes rotation a backstop: the CLI checks its threshold
 * before every model call, so a session only grows this big when compaction
 * fails or is disabled.
 */
export function rotationTokens(
  config: Pick<PersonaConfig, "rotateTokens" | "autoCompactPct">,
  contextWindow?: number
): number {
  if (config.rotateTokens !== undefined) return config.rotateTokens;
  if (contextWindow === undefined || !(contextWindow > 0)) return ROTATE_TOKENS_FALLBACK;
  return Math.floor((contextWindow * Math.min(config.autoCompactPct + ROTATE_PCT_MARGIN, ROTATE_PCT_MAX)) / 100);
}
/** Default of PersonaConfig.sessionImageBudget. */
export const SESSION_IMAGE_BUDGET = 40;
/** Default of PersonaConfig.sessionImageBytesBudget. */
export const SESSION_IMAGE_BYTES_BUDGET = 16 * 1024 * 1024;

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw?.trim() ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function optionalPositiveInt(raw: string | undefined): number | undefined {
  const n = Number.parseInt(raw?.trim() ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** A whole percent in 1..100, else `fallback`. */
function percent(raw: string | undefined, fallback: number): number {
  const n = positiveInt(raw, fallback);
  return n <= 100 ? n : fallback;
}

function positiveNumber(raw: string | undefined): number | undefined {
  const n = Number.parseFloat(raw?.trim() ?? "");
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function holdList(raw: string | undefined): { hold: string[]; unknownHolds: string[] } {
  const names = [...new Set((raw ?? "").split(",").map((n) => n.trim().toLowerCase()).filter(Boolean))];
  return { hold: names.filter((n) => HOLDABLE.has(n)), unknownHolds: names.filter((n) => !HOLDABLE.has(n)) };
}

export function resolvePersonaConfig(env: NodeJS.ProcessEnv = process.env): PersonaConfig {
  return {
    enabled: env.STANDUP_PERSONA?.trim() !== "0",
    model: env.STANDUP_PERSONA_MODEL?.trim() || "opus",
    effort: env.STANDUP_PERSONA_EFFORT?.trim() || "medium",
    maxActive: positiveInt(env.STANDUP_PERSONA_MAX_ACTIVE, 6),
    turnTimeoutMs: positiveInt(env.STANDUP_PERSONA_TURN_TIMEOUT_S, 600) * 1000,
    rotateTokens: optionalPositiveInt(env.STANDUP_PERSONA_ROTATE_TOKENS),
    coalesceMs: positiveInt(env.STANDUP_PERSONA_COALESCE_S, 20) * 1000,
    turnBudgetUsd: positiveNumber(env.STANDUP_PERSONA_TURN_BUDGET_USD),
    ...holdList(env.STANDUP_PERSONA_HOLD),
    maxConcurrentTurns: positiveInt(env.STANDUP_PERSONA_MAX_CONCURRENT_TURNS, 2),
    maxUsers: positiveInt(env.STANDUP_PERSONA_MAX_USERS, 10),
    sessionImageBudget: positiveInt(env.STANDUP_PERSONA_SESSION_IMAGE_BUDGET, SESSION_IMAGE_BUDGET),
    sessionImageBytesBudget: positiveInt(env.STANDUP_PERSONA_SESSION_IMAGE_BYTES, SESSION_IMAGE_BYTES_BUDGET),
    autoCompactPct: percent(env.STANDUP_PERSONA_AUTOCOMPACT_PCT, PERSONA_AUTOCOMPACT_PCT),
    allowCheck: env.STANDUP_PERSONA_REVIEW?.trim() !== "0",
    ...allowCheckModel(env.STANDUP_PERSONA_REVIEW_MODEL),
    allowCheckTimeoutMs: positiveInt(env.STANDUP_PERSONA_REVIEW_TIMEOUT_MS, 8_000),
    attachVideoMaxBytes: personaAttachVideoMaxBytes(env),
    delegates: resolveDelegateSwitches(env),
  };
}

/** The Haiku id the collector's ancillary model calls (checkpoints, distill) default to. */
const ANCILLARY_MODEL = "claude-haiku-4-5-20251001";

function allowCheckModel(raw: string | undefined): { allowCheckModel?: string; allowCheckModelEnabled: boolean } {
  const model = raw?.trim();
  if (model && ["off", "0", "none"].includes(model.toLowerCase())) return { allowCheckModelEnabled: false };
  return { allowCheckModel: model || ANCILLARY_MODEL, allowCheckModelEnabled: true };
}
