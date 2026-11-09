import type { Context, Hono } from "hono";
import type { Database } from "bun:sqlite";
import type { ReviewTunnel } from "@standup/shared";
import { getPersonaJob, getReviewTunnel, listReviewTunnelsByLaunches, liveReviewTunnelsForJob } from "@standup/store";
import type { ReviewTunnels } from "./manager.js";

export interface ReviewTunnelRoutesOptions {
  db: Database;
  tunnels: ReviewTunnels;
  /** A refusal unless the request is a human's through the console (server.ts humanRefusal). */
  humanRefusal: (c: Context, what: string) => Response | null;
  /** The request's own identity — never a body-supplied actor. */
  identityOf: (c: Context) => string;
  /** The owner whose Persona made the request, or undefined when it isn't Persona's. */
  personaOwnerOf: (c: Context) => string | undefined;
}

/**
 * The review-tunnel API: the console's and Persona's reads of a job's or
 * launch's tunnels, and their manual teardown. A human sees and closes only
 * their own tunnels; Persona only its owner's. Opening is never an API call —
 * the pipeline opens a tunnel when a run enters its screenshot stage.
 */
export function mountReviewTunnelRoutes(app: Hono, opts: ReviewTunnelRoutesOptions): void {
  const { db, tunnels } = opts;

  /** Who the request acts for: Persona's owner, or the signed-in human; a refusal otherwise. */
  const actorOf = (c: Context, what: string): { owner: string } | Response => {
    const personaOwner = opts.personaOwnerOf(c);
    if (personaOwner) return { owner: personaOwner };
    const refused = opts.humanRefusal(c, what);
    return refused ?? { owner: opts.identityOf(c) };
  };

  app.get("/api/review-tunnels", (c) => {
    const actor = actorOf(c, "read review tunnels");
    if (actor instanceof Response) return actor;
    const jobId = c.req.query("jobId")?.trim();
    let launchIds: string[];
    if (jobId) {
      const job = getPersonaJob(db, jobId);
      if (!job) return c.json({ error: "Unknown job" }, 404);
      launchIds = job.launchIds;
    } else {
      launchIds = (c.req.query("launchIds") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 200);
    }
    const own = (t: ReviewTunnel) => t.owner === actor.owner;
    return c.json({ tunnels: listReviewTunnelsByLaunches(db, launchIds).filter(own) });
  });

  app.post("/api/review-tunnels/:id/close", (c) => {
    const actor = actorOf(c, "close a review tunnel");
    if (actor instanceof Response) return actor;
    const tunnel = getReviewTunnel(db, c.req.param("id") ?? "");
    if (!tunnel || tunnel.owner !== actor.owner) return c.json({ error: "Unknown review tunnel" }, 404);
    const closed = tunnels.close(tunnel.id, "manual");
    return c.json({ closed, tunnel: getReviewTunnel(db, tunnel.id) });
  });

  // Every live tunnel of a job, torn down at once (Persona's close_job, and a manual "close all").
  app.post("/api/review-tunnels/close", async (c) => {
    const actor = actorOf(c, "close review tunnels");
    if (actor instanceof Response) return actor;
    const body = await c.req.json<{ jobId?: unknown; reason?: unknown }>().catch(() => ({}) as { jobId?: unknown; reason?: unknown });
    if (typeof body.jobId !== "string" || !body.jobId.trim()) return c.json({ error: "jobId is required" }, 400);
    const job = getPersonaJob(db, body.jobId.trim(), { withView: false });
    if (!job || job.owner !== actor.owner) return c.json({ error: "Unknown job" }, 404);
    const reason = body.reason === "job_closed" ? "job_closed" : "manual";
    const mine = liveReviewTunnelsForJob(db, job.id).filter((t) => t.owner === actor.owner);
    const closed = mine.filter((t) => tunnels.close(t.id, reason)).map((t) => t.id);
    return c.json({ closed });
  });
}
