import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Store } from "@standup/store";
import {
  createSession,
  updateSessionStatus,
  updateSessionTitle,
  endSession,
  getSession,
  reviveSession,
  getMostRecentActiveSessionByCwd,
  getActiveSessions,
  getAllSessions,
  getSessionsByProject,
  deleteSession,
  insertEvent,
  getSilenceTicks,
  getProjects,
  getProject,
  upsertProject,
  deleteProject,
  findProjectByCwd,
  getPendingAsks,
  createAsk,
  getAsk,
  resolveAsk,
  cancelPromptAsks,
  createCheckpoint,
  getRecentCheckpoints,
  createSteer,
  getPendingSteers,
  getLaunches,
  getLaunch,
  findLaunchByCwd,
  attachSessionToLaunch,
  isLaunchedSession,
  getLaunchBySession,
  recordExpertExchange,
  getRecentExpertExchanges,
} from "@standup/store";
import { searchKnowledge, type EmbeddingProvider } from "@standup/knowledge";
import type {
  HookPayload,
  Project,
  Session,
  ToolUsePayload,
  WsMessage,
} from "@standup/shared";
import type { ProjectsRegistry } from "./projects-registry.js";
import { runRipgrep } from "./ripgrep.js";
import { waitForAskResolution } from "./asks.js";
import { pushNotification } from "./push.js";
import { checkpointCompletedTodos, clearTodoCheckpointState } from "./todo-checkpoints.js";
import { takeSteerContext } from "./steers.js";
import {
  launchSession,
  cleanupLaunch,
  stopLaunch,
  captureLaunchOutput,
  sendToLaunch,
} from "./launcher.js";
import { askExpert, loadRegions } from "./expert.js";
import {
  maybeNudge,
  isNudgingEnabled,
  resetTurnNudges,
  clearNudgeState,
} from "./nudge.js";

/** Standup's own MCP tools — nudging on these would feed back on itself. */
function isExpertTool(toolName: string): boolean {
  return /(^|__)(ask_expert|search_knowledge|ripgrep|checkpoint|ask_human)$/.test(
    toolName ?? ""
  );
}
import type { KnowledgeSync } from "./knowledge-sync.js";

type WsBroadcast = (message: WsMessage) => void;

export function createServer(
  store: Store,
  broadcast: WsBroadcast,
  embeddingProvider: EmbeddingProvider | null = null,
  knowledgeSync?: KnowledgeSync,
  registry?: ProjectsRegistry
) {
  const app = new Hono();

  // Projects are edited from the UI now, so every mutation has to push the
  // new list to all connected clients.
  function broadcastProjects(): void {
    broadcast({
      type: "projects:updated",
      payload: getProjects(store.db),
      timestamp: new Date().toISOString(),
    });
  }

  // CORS for local development
  app.use("/*", cors({ origin: "http://localhost:5173" }));

  // Health check
  app.get("/health", (c) => c.json({ status: "ok" }));

  // ============================================================================
  // Hook endpoint — Claude Code POSTs here
  // ============================================================================
  app.post("/hook", async (c) => {
    try {
      const payload = (await c.req.json()) as HookPayload;
      // Returns a hook-output body when there's something to hand back to
      // the agent (queued steers); otherwise a bare ack. Still returns
      // immediately either way — the steer lookup is one indexed statement,
      // so this doesn't reintroduce blocking into the agent loop.
      const output = handleHookEvent(store, payload, broadcast);
      return c.json(output ?? { ok: true });
    } catch (err) {
      console.error("[hook] Error processing event:", err);
      // Still return 200 to not block the agent
      return c.json({ ok: true });
    }
  });

  // ============================================================================
  // REST API for the UI
  // ============================================================================

  // Projects — SQLite is authoritative; see ProjectsRegistry for why TOML
  // is only a seed/import path.
  app.get("/api/projects", (c) => {
    const projects = getProjects(store.db);
    return c.json(projects);
  });

  app.post("/api/projects", async (c) => {
    const body = await c.req.json<Partial<Project>>();

    const id = body.id?.trim();
    if (!id) return c.json({ error: "id is required" }, 400);
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) {
      return c.json(
        { error: "id must be alphanumeric with hyphens (it is used in paths and branch names)" },
        400
      );
    }
    if (getProject(store.db, id)) {
      return c.json({ error: `Project "${id}" already exists` }, 409);
    }

    const project: Project = {
      id,
      name: body.name?.trim() || id,
      emoji: body.emoji || undefined,
      repos: body.repos ?? [],
      setup: body.setup || undefined,
      expert: body.expert || undefined,
      branch: body.branch || "main",
    };

    upsertProject(store.db, project);
    broadcastProjects();
    return c.json(project, 201);
  });

  app.patch("/api/projects/:id", async (c) => {
    const id = c.req.param("id");
    const existing = getProject(store.db, id);
    if (!existing) return c.json({ error: "Not found" }, 404);

    const body = await c.req.json<Partial<Project>>();
    // id is intentionally immutable: launches and sessions reference it, and
    // worktree paths are derived from it.
    const updated: Project = {
      ...existing,
      name: body.name?.trim() || existing.name,
      emoji: body.emoji !== undefined ? body.emoji || undefined : existing.emoji,
      repos: body.repos ?? existing.repos,
      setup: body.setup !== undefined ? body.setup || undefined : existing.setup,
      expert: body.expert !== undefined ? body.expert || undefined : existing.expert,
      branch: body.branch || existing.branch,
    };

    upsertProject(store.db, updated);
    broadcastProjects();
    return c.json(updated);
  });

  app.delete("/api/projects/:id", (c) => {
    const id = c.req.param("id");
    if (id === "scratch") {
      return c.json(
        { error: "scratch cannot be deleted — unmatched sessions fall back to it" },
        400
      );
    }
    if (!getProject(store.db, id)) return c.json({ error: "Not found" }, 404);

    deleteProject(store.db, id);
    broadcastProjects();
    return c.json({ ok: true });
  });

  // TOML remains available for dotfile portability, but only on request.
  app.post("/api/projects/import", async (c) => {
    if (!registry) return c.json({ error: "Registry unavailable" }, 503);
    const result = await registry.importFromToml();
    broadcastProjects();
    return c.json(result);
  });

  app.get("/api/projects/export", (c) => {
    if (!registry) return c.json({ error: "Registry unavailable" }, 503);
    return c.text(registry.exportToToml(), 200, { "Content-Type": "text/plain" });
  });

  // Sessions. Ended ones are excluded by default so the console reflects
  // what's live; ?all=1 includes them so they can be reviewed and cleaned up.
  app.get("/api/sessions", (c) => {
    const sessions =
      c.req.query("all") === "1"
        ? getAllSessions(store.db)
        : getActiveSessions(store.db);
    return c.json(sessions.map((s) => withActivityTicks(store, s)));
  });

  app.get("/api/sessions/:id", (c) => {
    const session = getSession(store.db, c.req.param("id"));
    if (!session) return c.json({ error: "Not found" }, 404);
    return c.json(withActivityTicks(store, session));
  });

  app.get("/api/projects/:id/sessions", (c) => {
    const sessions = getSessionsByProject(store.db, c.req.param("id"));
    return c.json(sessions.map((s) => withActivityTicks(store, s)));
  });

  /**
   * Stops the agent behind a session. Only possible for launched sessions —
   * Standup owns their tmux pane. A monitored session belongs to the human's
   * own terminal, and reaching into it is exactly what the design declines
   * to build on.
   */
  app.post("/api/sessions/:id/stop", async (c) => {
    const sessionId = c.req.param("id");
    const session = getSession(store.db, sessionId);
    if (!session) return c.json({ error: "Not found" }, 404);

    const launch = getLaunchBySession(store.db, sessionId);
    if (!launch) {
      return c.json(
        {
          error:
            "This session wasn't launched by the console, so Standup doesn't own it — stop it from its own terminal.",
        },
        409
      );
    }

    const result = await stopLaunch(store.db, launch);
    endSession(store.db, sessionId);

    broadcast({
      type: "session:status",
      payload: { sessionId, status: "idle" },
      timestamp: new Date().toISOString(),
    });
    broadcast({
      type: "launch:stopped",
      payload: { launchId: launch.id },
      timestamp: new Date().toISOString(),
    });

    return c.json(result);
  });

  /** Frees the rows a session accumulated — events dominate the count. */
  app.delete("/api/sessions/:id", (c) => {
    const sessionId = c.req.param("id");
    const session = getSession(store.db, sessionId);
    if (!session) return c.json({ error: "Not found" }, 404);

    // ensureSession recreates a row on the next hook from a live session, so
    // deleting one mid-flight discards its history and changes nothing else.
    if (!session.endedAt) {
      return c.json(
        {
          error:
            "Session is still active — stop or end it first, otherwise its next hook recreates the record.",
        },
        409
      );
    }

    const deleted = deleteSession(store.db, sessionId);
    clearTodoCheckpointState(sessionId);
    clearNudgeState(sessionId);

    broadcast({
      type: "session:deleted",
      payload: { sessionId, deleted },
      timestamp: new Date().toISOString(),
    });

    return c.json({ ok: true, deleted });
  });

  // Asks
  app.get("/api/asks/pending", (c) => {
    const asks = getPendingAsks(store.db);
    return c.json(asks);
  });

  app.post("/api/asks/:id/resolve", async (c) => {
    const askId = c.req.param("id");
    const { answer } = await c.req.json<{ answer: string }>();

    const ask = getAsk(store.db, askId);
    if (!ask) return c.json({ error: "Not found" }, 404);

    // An ask_human is a blocked MCP call: resolving the row is enough,
    // because the tool handler is long-polling for exactly this.
    //
    // A permission_prompt has no such waiter — it came from a Notification
    // hook, and the agent is sitting on a TUI dialog. Marking it answered
    // would clear the badge while leaving the agent just as stuck. For a
    // launched session we own the pane, so the answer can actually be typed
    // in; for a monitored one, only the human at that terminal can act.
    if (ask.kind === "permission_prompt") {
      const launch = getLaunchBySession(store.db, ask.sessionId);
      if (!launch) {
        return c.json(
          {
            error:
              "This session wasn't launched by the console, so Standup can't answer for you — respond in its terminal.",
          },
          409
        );
      }

      const sent = await sendToLaunch(launch, answer);
      if (!sent.ok) {
        return c.json({ error: sent.error ?? "Could not reach the session" }, 409);
      }
    }

    resolveAsk(store.db, askId, answer);
    updateSessionStatus(store.db, ask.sessionId, "running");

    broadcast({
      type: "ask:resolved",
      payload: { askId, answer },
      timestamp: new Date().toISOString(),
    });
    broadcast({
      type: "session:status",
      payload: { sessionId: ask.sessionId, status: "running" },
      timestamp: new Date().toISOString(),
    });

    return c.json({ ok: true });
  });

  // Checkpoints
  app.get("/api/checkpoints", (c) => {
    const limit = parseInt(c.req.query("limit") ?? "50");
    const checkpoints = getRecentCheckpoints(store.db, limit);
    return c.json(checkpoints);
  });

  // Expert exchanges
  app.get("/api/expert/exchanges", (c) => {
    const limit = parseInt(c.req.query("limit") ?? "50");
    return c.json(getRecentExpertExchanges(store.db, limit));
  });

  // Steers
  app.post("/api/sessions/:id/steer", async (c) => {
    const { body } = await c.req.json<{ body: string }>();
    const steer = createSteer(store.db, c.req.param("id"), body);

    // Queued, not delivered — it reaches the agent at its next turn
    // boundary (UserPromptSubmit) or next checkpoint call. The UI shows
    // "delivers at the next checkpoint" off the back of this.
    broadcast({
      type: "steer:queued",
      payload: steer,
      timestamp: new Date().toISOString(),
    });

    return c.json(steer);
  });

  app.get("/api/sessions/:id/steers/pending", (c) => {
    const steers = getPendingSteers(store.db, c.req.param("id"));
    return c.json(steers);
  });

  // ============================================================================
  // Launching (Phase 4)
  // ============================================================================

  app.get("/api/launches", (c) => c.json(getLaunches(store.db)));

  app.post("/api/projects/:id/launch", async (c) => {
    const projectId = c.req.param("id");
    const { task } = await c.req.json<{ task: string }>();

    if (!task?.trim()) {
      return c.json({ error: "task is required" }, 400);
    }

    const project = getProjects(store.db).find((p) => p.id === projectId);
    if (!project) {
      return c.json({ error: `Unknown project: ${projectId}` }, 404);
    }

    try {
      const result = await launchSession(store.db, { project, task: task.trim() });

      broadcast({
        type: "launch:started",
        payload: result.launch,
        timestamp: new Date().toISOString(),
      });

      return c.json(result);
    } catch (err) {
      // Thrown only for misconfiguration caught before a launch row exists
      // (no repos, missing path); in-flight failures resolve to a "failed"
      // launch row instead.
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // Capabilities below exist only for launched sessions — Standup owns their
  // tmux pane. A monitored session has none of these, because the human
  // already has its terminal.

  app.get("/api/launches/:id/output", async (c) => {
    const launch = getLaunch(store.db, c.req.param("id"));
    if (!launch) return c.json({ error: "Not found" }, 404);

    try {
      const result = await captureLaunchOutput(launch);
      return c.json(result);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.post("/api/launches/:id/send", async (c) => {
    const launch = getLaunch(store.db, c.req.param("id"));
    if (!launch) return c.json({ error: "Not found" }, 404);

    const { text } = await c.req.json<{ text: string }>();
    if (!text?.trim()) return c.json({ error: "text is required" }, 400);

    try {
      const result = await sendToLaunch(launch, text.trim());
      if (!result.ok) return c.json({ error: result.error }, 409);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.post("/api/launches/:id/stop", async (c) => {
    const launch = getLaunch(store.db, c.req.param("id"));
    if (!launch) return c.json({ error: "Not found" }, 404);

    const result = await stopLaunch(store.db, launch);

    broadcast({
      type: "launch:stopped",
      payload: { launchId: launch.id },
      timestamp: new Date().toISOString(),
    });

    return c.json(result);
  });

  app.post("/api/launches/:id/cleanup", async (c) => {
    const launch = getLaunch(store.db, c.req.param("id"));
    if (!launch) return c.json({ error: "Not found" }, 404);

    const project = getProjects(store.db).find((p) => p.id === launch.projectId);
    if (!project) return c.json({ error: "Project no longer configured" }, 400);

    const result = await cleanupLaunch(store.db, launch, project);

    broadcast({
      type: "launch:cleaned",
      payload: { launchId: launch.id },
      timestamp: new Date().toISOString(),
    });

    return c.json(result);
  });

  // ============================================================================
  // MCP-facing endpoints — called by the standup MCP server on the agent's behalf
  //
  // The MCP server sends the real session_id when it can resolve one (read
  // from the transcript filename Claude Code writes under
  // ~/.claude/projects/ — see packages/mcp/src/session-id.ts), which is an
  // exact match. cwd is sent alongside as a fallback for when that
  // resolution fails, in which case we fall back to "most recently started
  // active session in this cwd" — a heuristic that can misattribute if two
  // sessions share a cwd, unlike the session_id path.
  // ============================================================================

  function resolveCallingSession(sessionId: string | null | undefined, cwd: string) {
    if (sessionId) {
      const session = getSession(store.db, sessionId);
      if (session) return session;
    }
    return getMostRecentActiveSessionByCwd(store.db, cwd);
  }

  app.post("/api/checkpoint", async (c) => {
    const { session_id, cwd, summary } = await c.req.json<{
      session_id?: string;
      cwd: string;
      summary: string;
    }>();

    const session = resolveCallingSession(session_id, cwd);
    if (!session) {
      return c.json(
        { error: `No active session found for cwd "${cwd}". Is the collector running and did this session register at startup?` },
        400
      );
    }

    const checkpoint = createCheckpoint(store.db, session.id, "self-reported", summary);

    broadcast({
      type: "checkpoint:new",
      payload: checkpoint,
      timestamp: new Date().toISOString(),
    });

    // A checkpoint marks a completed unit of work — the other turn boundary
    // the design nominates for steer delivery, and the one that reaches an
    // agent mid-task that isn't waiting on a new user prompt.
    const pending = takeSteerContext(store.db, session.id);
    if (pending) {
      for (const steer of pending.steers) {
        broadcast({
          type: "steer:delivered",
          payload: steer,
          timestamp: new Date().toISOString(),
        });
      }
      console.log(
        `[steer] Delivered ${pending.steers.length} steer(s) to ${session.id} at checkpoint`
      );
      return c.json({ ok: true, steers: pending.text });
    }

    return c.json({ ok: true });
  });

  app.post("/api/ask", async (c) => {
    const { session_id, cwd, question, options, timeout_s } = await c.req.json<{
      session_id?: string;
      cwd: string;
      question: string;
      options?: string[];
      timeout_s?: number;
    }>();

    const session = resolveCallingSession(session_id, cwd);
    if (!session) {
      return c.json(
        { error: `No active session found for cwd "${cwd}". Is the collector running and did this session register at startup?` },
        400
      );
    }

    const ask = createAsk(store.db, session.id, "ask_human", question, options);

    updateSessionStatus(store.db, session.id, "waiting");
    broadcast({
      type: "ask:new",
      payload: ask,
      timestamp: new Date().toISOString(),
    });
    broadcast({
      type: "session:status",
      payload: { sessionId: session.id, status: "waiting" },
      timestamp: new Date().toISOString(),
    });

    void pushNotification(session.title || "Agent needs you", question);

    // Block the MCP tool call until answered or timed out.
    const result = await waitForAskResolution(store.db, ask.id, timeout_s);

    if (result.timedOut) {
      return c.json({ answer: "", timed_out: true });
    }

    return c.json({ answer: result.answer });
  });

  app.post("/api/knowledge/search", async (c) => {
    const { session_id, cwd, query, project } = await c.req.json<{
      session_id?: string;
      cwd: string;
      query: string;
      project?: string;
    }>();

    // Missing session correlation degrades to "scratch" rather than failing
    // outright — this is a read-only convenience tool, not worth blocking on.
    let projectId = project;
    if (!projectId) {
      const session = resolveCallingSession(session_id, cwd);
      projectId = session?.projectId ?? "scratch";
    }

    // Lazily reconcile this project's knowledge dir against the store before
    // searching — cheap (skips unchanged files via mtime), and it's what
    // lets new/edited docs show up without restarting the collector.
    await knowledgeSync?.syncProject(projectId);

    const results = await searchKnowledge(store.db, projectId, query, embeddingProvider);

    return c.json({ results, project: projectId });
  });

  app.post("/api/ripgrep", async (c) => {
    // ripgrep only ever needed a cwd, not a session identity — use the
    // caller's cwd directly rather than resolving through a session lookup.
    const { cwd, pattern, path, flags } = await c.req.json<{
      cwd: string;
      pattern: string;
      path?: string;
      flags?: string[];
    }>();

    try {
      const result = await runRipgrep(pattern, cwd, path, flags);
      return c.json(result);
    } catch (err) {
      return c.json({ matches: [], truncated: false, error: String(err) }, 500);
    }
  });

  app.post("/api/expert", async (c) => {
    const { session_id, cwd, question } = await c.req.json<{
      session_id?: string;
      cwd: string;
      question: string;
    }>();

    const session = resolveCallingSession(session_id, cwd);
    const projectId = session?.projectId ?? "scratch";

    // Same lazy reconcile as search_knowledge — the expert reads the same
    // corpus, so it must see doc edits without a restart too.
    await knowledgeSync?.syncProject(projectId);

    const result = await askExpert({
      db: store.db,
      projectId,
      cwd,
      question,
      embeddingProvider,
      regions: await loadRegions(),
    });

    // Route every exchange through the feed. The design is explicit about
    // why: you need to see the expert being wrong before it costs a bad
    // edit, and the only way to tune retrieval is to watch it in the open.
    if (session) {
      const exchange = recordExpertExchange(
        store.db,
        session.id,
        question,
        result.answer,
        result.region,
        result.sources
      );
      broadcast({
        type: "expert:exchange",
        payload: exchange,
        timestamp: new Date().toISOString(),
      });
    }

    return c.json(result);
  });

  return app;
}

function withActivityTicks(store: Store, session: Session): Session {
  return { ...session, activityTicks: getSilenceTicks(store.db, session.id) };
}

// ============================================================================
// Hook event handler
// ============================================================================

/**
 * Guarantees a sessions row exists before any FK-dependent insert (events,
 * checkpoints, asks). Normally SessionStart creates it first, but a session
 * that was already running before the collector's DB was reset/restarted
 * never re-fires SessionStart — its later hooks would otherwise violate the
 * events.session_id foreign key. Safe to call unconditionally; no-ops if the
 * row is already there.
 */
function ensureSession(
  store: Store,
  sessionId: string,
  cwd: string,
  eventName: string
): void {
  const existing = getSession(store.db, sessionId);

  if (existing) {
    // Any event other than SessionEnd proves the session is still alive.
    // Clear a stale ended_at from an earlier non-terminal SessionEnd
    // (resume/clear), which would otherwise hide it from the UI forever.
    if (eventName !== "SessionEnd" && existing.endedAt) {
      reviveSession(store.db, sessionId);
    }
    return;
  }

  // A console-launched session runs in a git worktree, which by definition
  // isn't among the project's configured `repos` — so check launches first,
  // or deliberately-launched work would land in `scratch`.
  const launch = findLaunchByCwd(store.db, cwd);
  const project = launch ? null : findProjectByCwd(store.db, cwd);

  createSession(store.db, {
    id: sessionId,
    projectId: launch?.projectId ?? project?.id ?? "scratch",
    title: launch?.task ?? "",
    cwd,
    status: "running",
  });

  if (launch) {
    attachSessionToLaunch(store.db, launch.id, sessionId);
  }
}

function handleHookEvent(
  store: Store,
  payload: HookPayload,
  broadcast: WsBroadcast
): Record<string, unknown> | null {
  const { session_id, hook_event_name, cwd } = payload;

  ensureSession(store, session_id, cwd, hook_event_name);

  // Populated by UserPromptSubmit when steers are waiting; returned to
  // Claude Code as the hook's output.
  let hookOutput: Record<string, unknown> | null = null;

  switch (hook_event_name) {
    case "SessionStart": {
      const session = getSession(store.db, session_id);

      broadcast({
        type: "session:start",
        payload: { sessionId: session_id, projectId: session?.projectId, cwd },
        timestamp: new Date().toISOString(),
      });
      break;
    }

    case "SessionEnd": {
      endSession(store.db, session_id);
      clearTodoCheckpointState(session_id);
      clearNudgeState(session_id);
      broadcast({
        type: "session:end",
        payload: { sessionId: session_id },
        timestamp: new Date().toISOString(),
      });
      break;
    }

    case "UserPromptSubmit": {
      const p = payload as { prompt: string } & typeof payload;
      // First prompt becomes the session title; later prompts don't overwrite it.
      updateSessionTitle(store.db, session_id, p.prompt.slice(0, 100));
      // A new turn is starting — the session is no longer idle/waiting.
      updateSessionStatus(store.db, session_id, "running");
      resetTurnNudges(session_id);

      // The human answered in the terminal rather than through the console,
      // so any prompt-ask we raised is moot. Left pending it would badge the
      // Blocked view forever for a session that has already moved on.
      for (const stale of cancelPromptAsks(store.db, session_id)) {
        broadcast({
          type: "ask:resolved",
          payload: { askId: stale.id, answer: "" },
          timestamp: new Date().toISOString(),
        });
      }
      broadcast({
        type: "session:status",
        payload: { sessionId: session_id, status: "running" },
        timestamp: new Date().toISOString(),
      });

      // Deliver queued steers here: a new prompt is a turn boundary by
      // definition, which is exactly the constraint the design imposes
      // (never inject mid-turn — see "Steer injected mid-turn derails a
      // run" in the failure-modes table).
      const pending = takeSteerContext(store.db, session_id);
      if (pending) {
        hookOutput = {
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: pending.text,
          },
        };

        for (const steer of pending.steers) {
          broadcast({
            type: "steer:delivered",
            payload: steer,
            timestamp: new Date().toISOString(),
          });
        }
        console.log(
          `[steer] Delivered ${pending.steers.length} steer(s) to ${session_id} at turn boundary`
        );
      }
      break;
    }

    case "PostToolUse": {
      const p = payload as ToolUsePayload;

      if (p.tool_name === "TodoWrite") {
        for (const checkpoint of checkpointCompletedTodos(store.db, session_id, p.tool_input)) {
          broadcast({
            type: "checkpoint:new",
            payload: checkpoint,
            timestamp: new Date().toISOString(),
          });
        }
      }

      broadcast({
        type: "event:new",
        payload: { sessionId: session_id, type: hook_event_name },
        timestamp: new Date().toISOString(),
      });

      // Phase 6 — proactive nudging. Off unless STANDUP_NUDGE=1.
      //
      // Deliberately does not fire for the agent's own expert calls: an
      // ask_expert round trip generates PostToolUse events, and nudging on
      // those is precisely the chime-in feedback loop the design warns
      // about. The event is still recorded below either way.
      if (isNudgingEnabled() && !isExpertTool(p.tool_name)) {
        // insertEvent runs at the end of this function, so the event that
        // triggered this check isn't in the window yet. That's fine — it
        // makes detection lag by exactly one tool call rather than miss
        // anything.
        const nudge = maybeNudge(store.db, session_id);
        if (nudge) {
          console.log(
            `[nudge] ${session_id.slice(0, 8)} — ${nudge.signal.reason}`
          );

          // Visible to the human too: the design says the only way to tune
          // the false-positive rate is to watch it happen.
          broadcast({
            type: "stall:detected",
            payload: {
              sessionId: session_id,
              reason: nudge.signal.reason,
              topic: nudge.signal.topic,
              nudged: true,
            },
            timestamp: new Date().toISOString(),
          });

          hookOutput = {
            hookSpecificOutput: {
              hookEventName: "PostToolUse",
              additionalContext: nudge.text,
            },
          };
        }
      }
      break;
    }

    case "Stop": {
      updateSessionStatus(store.db, session_id, "idle");
      broadcast({
        type: "session:status",
        payload: { sessionId: session_id, status: "idle" },
        timestamp: new Date().toISOString(),
      });
      break;
    }

    case "SubagentStop": {
      // Structural checkpoint from subagent completion
      const p = payload as { description?: string } & typeof payload;
      if (p.description) {
        const checkpoint = createCheckpoint(
          store.db,
          session_id,
          "structural",
          p.description
        );

        broadcast({
          type: "checkpoint:new",
          payload: checkpoint,
          timestamp: new Date().toISOString(),
        });
      }
      break;
    }

    case "Notification": {
      const p = payload as { notification_type: string; message?: string } & typeof payload;

      // Verified payloads (see runbook): permission_prompt carries "Claude
      // needs your permission"; idle_prompt carries "Claude is waiting for
      // your input"; auth_success is informational.
      //
      // idle_prompt means different things depending on who started the
      // session, which is why it isn't handled uniformly:
      //   - monitored: routine. You are at that terminal and will type when
      //     ready; badging every turn end would be constant noise.
      //   - launched:  nobody is at that terminal. Left unflagged it waits
      //     forever — exactly the blocked-and-invisible case.
      const isPermission = p.notification_type === "permission_prompt";
      const isIdle = p.notification_type === "idle_prompt";
      const launched = isLaunchedSession(store.db, session_id);

      if (isPermission || (isIdle && launched)) {
        updateSessionStatus(store.db, session_id, "waiting");
        broadcast({
          type: "session:status",
          payload: { sessionId: session_id, status: "waiting" },
          timestamp: new Date().toISOString(),
        });

        const session = getSession(store.db, session_id);
        const detail =
          p.message ??
          (isPermission ? "Permission requested" : "Waiting for your input");

        // Surfaced as an ask so it lands in the Blocked view and the alert
        // strip. Answering it isn't possible from here for a monitored
        // session — but a launched one can be answered with send input.
        const ask = createAsk(
          store.db,
          session_id,
          "permission_prompt",
          launched
            ? `${detail} — this session was launched by the console, so nobody is at its terminal.`
            : detail
        );
        broadcast({
          type: "ask:new",
          payload: ask,
          timestamp: new Date().toISOString(),
        });

        void pushNotification(session?.title || "Agent needs you", detail);
      }
      break;
    }

    default: {
      broadcast({
        type: "event:new",
        payload: { sessionId: session_id, type: hook_event_name },
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Record every event for the silence meter and per-session scrollback.
  // SessionStart always creates the session row above first, so the events
  // table's session_id FK is satisfied no matter which branch ran.
  insertEvent(store.db, session_id, hook_event_name, payload);

  return hookOutput;
}
