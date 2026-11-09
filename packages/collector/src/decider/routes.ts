import type { Context, Hono } from "hono";
import type { Database } from "bun:sqlite";
import { DECISION_KINDS, type DeciderConfigView, type DecisionKind, type LaunchSuggestion } from "@standup/shared";
import {
  getGlobalDeciderPrefs,
  getUserDeciderPrefs,
  listDeciderDecisions,
  putGlobalDeciderPrefs,
  putUserDeciderPrefs,
  sanitizeDeciderPrefs,
} from "@standup/store";
import { resolveDeciderConfig } from "./config.js";
import { suggestLaunchSettings } from "./suggest.js";

export interface DeciderRoutesOptions {
  db: Database;
  /**
   * The signed-in person the request comes from — the owner through the
   * console, or a teammate through their own signed-in console browser — or
   * null for anyone else (a worker on the loopback, a Persona token, an
   * unproven identity header).
   */
  personOf: (c: Context) => string | null;
  /** Whether the request is the owner's, through an owner channel. */
  isOwner: (c: Context) => boolean;
  /** Effort/model suggestions; injectable for tests. */
  suggest?: (ctx: { db: Database; alias: string }, task: string) => Promise<LaunchSuggestion>;
}

const MAX_SUGGEST_TASK_CHARS = 20_000;

/** Suggestions each person may ask for per window: each can spend two model calls. */
const SUGGEST_LIMIT = 20;
const SUGGEST_WINDOW_MS = 10 * 60_000;

/** Reads a JSON object body, or null when it is missing, malformed or not an object. */
async function objectBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function signIn(c: Context, what: string): Response {
  return c.json({ error: `Sign in to the console to ${what}.`, reason: "sign-in" }, 403);
}

/**
 * The small-decision port's API: each user's backend routing (the You tab),
 * the global routing (owner only), the decision audit log, and effort/model
 * suggestions for the composer.
 */
export function mountDeciderRoutes(app: Hono, opts: DeciderRoutesOptions): void {
  const { db } = opts;
  const suggest = opts.suggest ?? ((ctx, task) => suggestLaunchSettings(ctx, task));
  const inFlight = new Set<string>();
  const recent = new Map<string, number[]>();

  const configView = (alias: string, isOwner: boolean): DeciderConfigView => ({
    alias,
    isOwner,
    kinds: resolveDeciderConfig(db, alias),
    user: getUserDeciderPrefs(db, alias).backends,
    global: getGlobalDeciderPrefs(db),
  });

  app.get("/api/decider/config", (c) => {
    const alias = opts.personOf(c);
    if (!alias) return signIn(c, "see your decision settings");
    return c.json(configView(alias, opts.isOwner(c)));
  });

  // Full replace of the caller's own layer: a kind left out inherits the global layer.
  app.put("/api/decider/prefs", async (c) => {
    const alias = opts.personOf(c);
    if (!alias) return signIn(c, "change your decision settings");
    const body = await objectBody(c);
    if (!body) return c.json({ error: "request body must be a JSON object" }, 400);
    putUserDeciderPrefs(db, alias, sanitizeDeciderPrefs(body.backends));
    return c.json(configView(alias, opts.isOwner(c)));
  });

  app.put("/api/decider/global", async (c) => {
    const alias = opts.personOf(c);
    if (!alias || !opts.isOwner(c)) {
      return c.json({ error: "Only the owner can change the global decision settings." }, 403);
    }
    const body = await objectBody(c);
    if (!body) return c.json({ error: "request body must be a JSON object" }, 400);
    putGlobalDeciderPrefs(db, sanitizeDeciderPrefs(body.backends));
    return c.json(configView(alias, true));
  });

  // The caller's own decisions; `all=1` (owner only) includes everyone's and unattributed ones.
  app.get("/api/decider/decisions", (c) => {
    const alias = opts.personOf(c);
    if (!alias) return signIn(c, "see your decisions");
    const all = c.req.query("all") === "1";
    if (all && !opts.isOwner(c)) return c.json({ error: "Only the owner can read every user's decisions." }, 403);
    const kindParam = c.req.query("kind");
    const kind = (DECISION_KINDS as readonly string[]).includes(kindParam ?? "")
      ? (kindParam as DecisionKind)
      : undefined;
    const limit = Number.parseInt(c.req.query("limit") ?? "", 10);
    return c.json(
      listDeciderDecisions(db, {
        alias: all ? undefined : alias,
        kind,
        limit: Number.isFinite(limit) ? limit : 50,
      })
    );
  });

  // Effort and model suggestions for a task. Suggestions only: nothing here
  // touches a launch, and the composer leaves its own pickers as they are.
  // One at a time per person, and at most SUGGEST_LIMIT per window, since a
  // suggestion costs two claude -p calls.
  app.post("/api/decider/suggest", async (c) => {
    const alias = opts.personOf(c);
    if (!alias) return signIn(c, "ask for launch suggestions");
    const body = await objectBody(c);
    const task = typeof body?.task === "string" ? body.task.trim() : "";
    if (!task) return c.json({ error: "task is required" }, 400);
    if (task.length > MAX_SUGGEST_TASK_CHARS) return c.json({ error: "task is too long" }, 400);
    if (inFlight.has(alias)) return c.json({ error: "A suggestion is already being worked out." }, 429);
    const now = Date.now();
    const window = (recent.get(alias) ?? []).filter((t) => now - t < SUGGEST_WINDOW_MS);
    if (window.length >= SUGGEST_LIMIT) {
      recent.set(alias, window);
      return c.json({ error: "Too many suggestions; try again in a few minutes." }, 429);
    }
    window.push(now);
    recent.set(alias, window);
    inFlight.add(alias);
    try {
      return c.json(await suggest({ db, alias }, task));
    } finally {
      inFlight.delete(alias);
    }
  });
}
