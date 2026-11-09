import type { Database } from "bun:sqlite";
import type { ReviewTunnel, ReviewTunnelUpdatedPayload, WsMessage } from "@standup/shared";
import { createCheckpoint, getSession } from "@standup/store";
import { ReviewTunnels } from "./manager.js";
import type { ReviewTunnelSystem } from "./system.js";

export { ReviewTunnels } from "./manager.js";
export { createReviewTunnelSystem, type ReviewTunnelSystem } from "./system.js";
export { mountReviewTunnelRoutes } from "./routes.js";

/** How often live tunnels are checked for staleness (TTL, closed job, ended launch, dead processes). */
export const REVIEW_TUNNEL_SWEEP_MS = 60_000;

/** Whether review tunnels may open on this collector: STANDUP_REVIEW_TUNNELS=0/off/false turns them off. */
export function reviewTunnelsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.STANDUP_REVIEW_TUNNELS?.trim().toLowerCase();
  return !(v === "0" || v === "off" || v === "false" || v === "no");
}

/** The `review_tunnel:updated` frame for a tunnel's changed record: to its owner alone, with proof, so unsequenced. */
export function reviewTunnelFrame(tunnel: ReviewTunnel): WsMessage<ReviewTunnelUpdatedPayload> | null {
  if (!tunnel.owner) return null;
  return {
    type: "review_tunnel:updated",
    payload: {
      ...(tunnel.jobId ? { jobId: tunnel.jobId } : {}),
      ...(tunnel.launchId ? { launchId: tunnel.launchId } : {}),
      status: tunnel.status,
    },
    timestamp: new Date().toISOString(),
    audience: tunnel.owner,
    requireProof: true,
  };
}

/**
 * A ReviewTunnels whose notices are structural checkpoints on the launch's
 * session, and whose every record change is pushed as `review_tunnel:updated`.
 */
export function createReviewTunnels(db: Database, system: ReviewTunnelSystem, broadcast: (message: WsMessage) => void): ReviewTunnels {
  return new ReviewTunnels(db, system, {
    checkpoint: (sessionId, text) => {
      if (!getSession(db, sessionId)) return;
      const checkpoint = createCheckpoint(db, sessionId, "structural", text);
      broadcast({ type: "checkpoint:new", payload: checkpoint, timestamp: new Date().toISOString() });
    },
    changed: (tunnel) => {
      const frame = reviewTunnelFrame(tunnel);
      if (frame) broadcast(frame);
    },
  });
}

/** Milliseconds from `now` to the next 03:00 local time — when the nightly reconcile runs. */
export function msUntilNightly(now: Date = new Date(), hour = 3): number {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

/**
 * Starts the periodic sweep and the nightly reconcile, and reconciles once
 * now (the collector's start: tunnels whose job closed or whose processes
 * died while it was down, and leaked tunnel processes). Returns a stop
 * function that clears the timers.
 */
export function startReviewTunnelMaintenance(tunnels: ReviewTunnels, opts: { sweepMs?: number } = {}): () => void {
  const log = (what: string, result: { closed: unknown[]; leaked: unknown[] }) => {
    if (result.closed.length > 0 || result.leaked.length > 0) {
      console.log(`[review-tunnels] ${what}: closed ${JSON.stringify(result.closed)}, stopped leaked ${JSON.stringify(result.leaked)}`);
    }
  };
  const reconcile = (what: string) =>
    void tunnels
      .reconcile()
      .then((r) => log(what, r))
      .catch((err) => console.error(`[review-tunnels] ${what} failed:`, err));
  reconcile("start reconcile");
  const sweep = setInterval(() => {
    try {
      log("sweep", tunnels.sweep());
    } catch (err) {
      console.error("[review-tunnels] sweep failed:", err);
    }
  }, opts.sweepMs ?? REVIEW_TUNNEL_SWEEP_MS);
  let nightly: ReturnType<typeof setTimeout>;
  const scheduleNightly = () => {
    nightly = setTimeout(() => {
      reconcile("nightly reconcile");
      scheduleNightly();
    }, msUntilNightly());
  };
  scheduleNightly();
  return () => {
    clearInterval(sweep);
    clearTimeout(nightly);
  };
}
