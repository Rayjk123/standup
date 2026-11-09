import type { Context, Hono } from "hono";
import type { Database } from "bun:sqlite";
import type { NotifyOverride } from "@standup/shared";
import { DEFAULT_NOTIFY_PREFS, validateNotifyOverride } from "@standup/shared";
import {
  deleteNotifyPrefs,
  getNotifyPrefs,
  getProject,
  latestPersonaBriefRun,
  listNotifyPrefProjects,
  listPersonaBriefRuns,
  setNotifyPrefs,
} from "@standup/store";
import {
  briefEnabled,
  briefIsEmpty,
  briefSince,
  buildBriefDigest,
  legacyReportSchedules,
  nextBriefSlot,
  renderBriefDigest,
  sameLocalDay,
} from "./brief.js";
import { ownerTimezone } from "./cron.js";
import { notifyPrefsFor } from "./notify.js";
import { privatePushAvailable } from "../push.js";

export interface NotifyRoutesOptions {
  db: Database;
  /** A refusal Response unless the caller is a signed-in human (not Persona, not anonymous). */
  humanRefusal: (c: Context, what: string) => Response | null;
  /** The calling human's alias. */
  identityOf: (c: Context) => string;
  /** The host alias, whose topic the default ntfy topic is (see privatePushAvailable). */
  host: string;
  now?: () => Date;
}

/**
 * Each user's notification prefs, read and written by that user only — the
 * You tab's Notifications section. `?project=<id>` addresses the user's layer
 * for that project; without it, their global layer. Responses carry both
 * layers, the resolved prefs, and the brief's state (on or off and why, the
 * report schedules it would replace, the next slot, recent runs).
 */
export function mountNotifyRoutes(app: Hono, opts: NotifyRoutesOptions): void {
  const { db } = opts;
  const now = opts.now ?? (() => new Date());

  const projectParam = (c: Context): { projectId: string | null } | Response => {
    const projectId = c.req.query("project")?.trim() || null;
    if (projectId && !getProject(db, projectId)) return c.json({ error: `Unknown project: ${projectId}` }, 404);
    return { projectId };
  };

  const view = (owner: string, projectId: string | null) => {
    const global = getNotifyPrefs(db, owner, null);
    const resolved = notifyPrefsFor(db, owner, projectId);
    const timezone = resolved.timezone ?? ownerTimezone();
    const enabled = briefEnabled(db, owner, resolved, now());
    let next = enabled ? nextBriefSlot(resolved.brief.time, timezone, now()) : null;
    // A day that already had its brief skips a later slot (the time was moved), so the next one is tomorrow's.
    const latest = latestPersonaBriefRun(db, owner);
    if (next && latest && latest.slot !== next.toISOString() && sameLocalDay(new Date(latest.slot), next, timezone)) {
      next = nextBriefSlot(resolved.brief.time, timezone, next);
    }
    return {
      global,
      project: projectId ? getNotifyPrefs(db, owner, projectId) : null,
      resolved,
      defaults: DEFAULT_NOTIFY_PREFS,
      projects: listNotifyPrefProjects(db, owner),
      /** Whether push can carry this user's brief and job updates: they have an ntfy topic of their own. */
      privatePush: privatePushAvailable(owner, opts.host),
      brief: {
        enabled,
        /** True when the user hasn't chosen, so `enabled` follows whether a report schedule of theirs still runs. */
        auto: resolved.brief.enabled === undefined,
        timezone,
        nextAt: next ? next.toISOString() : null,
        reportSchedules: legacyReportSchedules(db, owner, now()).map((s) => ({ id: s.id, title: s.title, cron: s.cron, timezone: s.timezone })),
        recent: listPersonaBriefRuns(db, owner, 5),
      },
    };
  };

  app.get("/api/notify-prefs", (c) => {
    const refused = opts.humanRefusal(c, "read your notification settings");
    if (refused) return refused;
    const param = projectParam(c);
    if (param instanceof Response) return param;
    return c.json(view(opts.identityOf(c), param.projectId));
  });

  app.put("/api/notify-prefs", async (c) => {
    const refused = opts.humanRefusal(c, "change your notification settings");
    if (refused) return refused;
    const param = projectParam(c);
    if (param instanceof Response) return param;
    const owner = opts.identityOf(c);
    const body = await c.req.json<{ override?: unknown }>().catch(() => null);
    const checked = validateNotifyOverride(body && typeof body === "object" ? body.override : undefined, {
      projectLayer: param.projectId !== null,
    });
    if (!checked.ok) return c.json({ error: checked.errors.join("; "), errors: checked.errors }, 400);
    setNotifyPrefs(db, owner, param.projectId, checked.value as NotifyOverride);
    return c.json(view(owner, param.projectId));
  });

  app.delete("/api/notify-prefs", (c) => {
    const refused = opts.humanRefusal(c, "change your notification settings");
    if (refused) return refused;
    const param = projectParam(c);
    if (param instanceof Response) return param;
    const owner = opts.identityOf(c);
    deleteNotifyPrefs(db, owner, param.projectId);
    return c.json(view(owner, param.projectId));
  });

  // What the brief's digest holds right now, the same one the next brief
  // would be written from.
  app.get("/api/notify-prefs/brief/preview", (c) => {
    const refused = opts.humanRefusal(c, "preview your brief");
    if (refused) return refused;
    const owner = opts.identityOf(c);
    const at = now();
    const digest = buildBriefDigest(db, owner, { since: briefSince(db, owner, at), now: at });
    return c.json({ digest, lines: renderBriefDigest(digest), empty: briefIsEmpty(digest) });
  });
}
