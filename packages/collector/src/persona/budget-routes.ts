import type { Context, Hono } from "hono";
import type { Database } from "bun:sqlite";
import { JOB_BUDGET_DEFAULTS, jobBudgetValueError } from "@standup/shared";
import type { JobBudgetLayer, PersonaUsage } from "@standup/shared";
import {
  deleteJobBudgetPrefs,
  getJobBudgetPrefs,
  getProject,
  listPersonaJobs,
  personaJobBudget,
  personaTurnTotals,
  resolveOwnerJobBudget,
  setJobBudgetPrefs,
} from "@standup/store";

/** Closed jobs stay in the default per-job breakdown this long after they close. */
const RECENT_CLOSED_JOB_MS = 24 * 60 * 60 * 1000;

/**
 * `user`'s own Persona spend for /api/usage/me: their turns' totals and their
 * jobs' budgets — open jobs and those closed in the last day, or every job
 * with `all`. Rows are matched on the stored owner alias only, so another
 * user's Persona turns and jobs never appear.
 */
export function personaUsageFor(db: Database, user: string, opts: { all?: boolean; now?: Date } = {}): PersonaUsage {
  const now = opts.now ?? new Date();
  const totals = personaTurnTotals(db, user);
  const jobs = listPersonaJobs(db, user, {
    ...(opts.all ? {} : { status: ["active", "waiting_user"], closedSince: new Date(now.getTime() - RECENT_CLOSED_JOB_MS).toISOString() }),
    limit: 100,
  });
  return {
    ...totals,
    jobs: jobs.flatMap((job) => {
      const budget = job.budget ?? personaJobBudget(db, job.id, now);
      return budget ? [{ jobId: job.id, title: job.title, status: job.status, budget }] : [];
    }),
  };
}

export interface JobBudgetRoutesOptions {
  db: Database;
  /**
   * A refusal Response unless the request is a human's through the console
   * (it carries the owner token no worker holds); null when it may proceed.
   */
  humanRefusal: (c: Context, what: string) => Response | null;
  /** The request's own identity — never a body-supplied actor. */
  identityOf: (c: Context) => string;
  /** Called after a layer changes, so open jobs are re-checked against it. */
  onChange?: (owner: string) => void;
}

/**
 * Each user's default Persona job budget, by layer: `GET/PUT/DELETE
 * /api/job-budget` edits the user's global layer, `?project=<id>` their layer
 * for that project, which overrides it. Every layer is the requester's own
 * (identityOf); nobody reads or writes another user's.
 */
export function mountJobBudgetRoutes(app: Hono, opts: JobBudgetRoutesOptions): void {
  const { db } = opts;

  const projectParam = (c: Context): { projectId: string | null } | Response => {
    const projectId = c.req.query("project")?.trim() || null;
    if (projectId && !getProject(db, projectId)) return c.json({ error: `Unknown project: ${projectId}` }, 404);
    return { projectId };
  };

  const view = (owner: string, projectId: string | null) => ({
    global: getJobBudgetPrefs(db, owner, null),
    project: projectId ? getJobBudgetPrefs(db, owner, projectId) : null,
    resolved: resolveOwnerJobBudget(db, owner, projectId),
    defaults: JOB_BUDGET_DEFAULTS,
  });

  app.get("/api/job-budget", (c) => {
    const refused = opts.humanRefusal(c, "read your job budget");
    if (refused) return refused;
    const param = projectParam(c);
    if (param instanceof Response) return param;
    return c.json(view(opts.identityOf(c), param.projectId));
  });

  app.put("/api/job-budget", async (c) => {
    const refused = opts.humanRefusal(c, "change your job budget");
    if (refused) return refused;
    const param = projectParam(c);
    if (param instanceof Response) return param;
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "body must be {usd?: number | null, minutes?: number | null}" }, 400);
    }
    const layer: JobBudgetLayer = {};
    for (const key of ["usd", "minutes"] as const) {
      const error = jobBudgetValueError(key, body[key]);
      if (error) return c.json({ error }, 400);
      layer[key] = (body[key] as number | null | undefined) ?? null;
    }
    const owner = opts.identityOf(c);
    setJobBudgetPrefs(db, owner, param.projectId, layer);
    opts.onChange?.(owner);
    return c.json(view(owner, param.projectId));
  });

  app.delete("/api/job-budget", (c) => {
    const refused = opts.humanRefusal(c, "change your job budget");
    if (refused) return refused;
    const param = projectParam(c);
    if (param instanceof Response) return param;
    const owner = opts.identityOf(c);
    deleteJobBudgetPrefs(db, owner, param.projectId);
    opts.onChange?.(owner);
    return c.json(view(owner, param.projectId));
  });
}
