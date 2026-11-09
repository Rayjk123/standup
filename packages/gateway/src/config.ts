/**
 * The gateway's settings, read from the environment dev.ts spawns it with:
 * the public ports (`publicPorts`), vite's upstream port (`vitePortFromEnv`),
 * and the STANDUP_GATEWAY_HOLD_MS / _MAX_HELD / _IDLE_EXIT_MS / _ORPHAN_EXIT_MS
 * limits below, each falling back to its default when unset or not a positive
 * integer.
 */
import { publicPorts, vitePortFromEnv, type PublicPorts } from "@standup/shared/topology";
import { DEFAULT_ORPHAN_EXIT_MS } from "./startup.js";

export { DEFAULT_ORPHAN_EXIT_MS };
export const DEFAULT_HOLD_MS = 60_000;
export const DEFAULT_MAX_HELD = 500;
export const DEFAULT_IDLE_EXIT_MS = 10 * 60_000;

export interface GatewayConfig {
  /** The public ports the gateway owns. */
  ports: PublicPorts;
  /** Vite's own port: the web listener's upstream. */
  vitePort: number;
  holdMs: number;
  maxHeld: number;
  idleExitMs: number;
  /** How long the gateway outlives its dev.ts with no collector leader (STANDUP_GATEWAY_ORPHAN_EXIT_MS). */
  orphanExitMs: number;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function gatewayConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  return {
    ports: publicPorts(env),
    vitePort: vitePortFromEnv(env),
    holdMs: positiveInt(env.STANDUP_GATEWAY_HOLD_MS, DEFAULT_HOLD_MS),
    maxHeld: positiveInt(env.STANDUP_GATEWAY_MAX_HELD, DEFAULT_MAX_HELD),
    idleExitMs: positiveInt(env.STANDUP_GATEWAY_IDLE_EXIT_MS, DEFAULT_IDLE_EXIT_MS),
    orphanExitMs: positiveInt(env.STANDUP_GATEWAY_ORPHAN_EXIT_MS, DEFAULT_ORPHAN_EXIT_MS),
  };
}
