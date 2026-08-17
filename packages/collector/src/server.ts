import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Store } from "@standup/store";
import {
  createSession,
  updateSessionStatus,
  updateSessionTitle,
  resetSessionTitle,
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
  rehomeScratchSessions,
  findProjectByCwd,
  getPendingAsks,
  createAsk,
  getAsk,
  resolveAsk,
  cancelAsk,
  cancelPromptAsks,
  cancelAllPendingAsks,
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
  getRecentEventsBySession,
} from "@standup/store";
import {
  searchKnowledge,
  listKnowledgeFiles,
  readKnowledgeFile,
  writeKnowledgeFile,
  deleteKnowledgeFile,
  writeDraftFile,
  acceptDraftFile,
  deleteDraftFile,
  isValidSlug,
  type EmbeddingProvider,
} from "@standup/knowledge";
import { resolveAcceptMode, isAcceptAllEligible } from "./draft-accept.js";
import { computeStaleness, hasProvenance, primaryRepoPath } from "./knowledge-staleness.js";
import type {
  ClaudeEffort,
  ClaudeModel,
  HookPayload,
  Project,
  Session,
  ToolUsePayload,
  WsMessage,
} from "@standup/shared";

const CLAUDE_MODELS: ClaudeModel[] = ["opus", "sonnet", "haiku", "fable"];
const CLAUDE_EFFORTS: ClaudeEffort[] = ["low", "medium", "high", "xhigh", "max"];
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
  adoptSession,
  captureLaunchOutput,
  sendToLaunch,
} from "./launcher.js";
import { askExpert, loadRegions } from "./expert.js";
import { bootstrapPrompt } from "./bootstrap-prompt.js";
import { isInternalCwd } from "./internal-cwd.js";
import { verifyDraft } from "./draft-verify.js";
import {
  readTranscript,
  transcriptPathForSession,
  currentEffortForSession,
  currentModelForSession,
} from "./transcript.js";
import {
  maybeNudge,
  isNudgingEnabled,
  resetTurnNudges,
  clearNudgeState,
} from "./nudge.js";
import {
  maybeAutoCheckpoint,
  isAutoCheckpointEnabled,
  setAutoCheckpointEnabled,
  clearAutoCheckpointState,
} from "./auto-checkpoint.js";

/** Standup's own MCP tools — nudging on these would feed back on itself. */
function isExpertTool(toolName: string): boolean {
  return /(^|__)(ask_expert|search_knowledge|ripgrep|checkpoint|ask_human|propose_knowledge)$/.test(
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
  registry?: ProjectsRegistry,
  knowledgeDir = ""
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

  /** Nudges clients to refetch after sessions are reassigned between projects. */
  function broadcastSessions(): void {
    broadcast({
      type: "session:status",
      payload: {},
      timestamp: new Date().toISOString(),
    });
  }

  // CORS for local development
  app.use("/*", cors({ origin: "http://localhost:5173" }));

  // Health check
  app.get("/health", (c) => c.json({ status: "ok" }));

  // ============================================================================
  // Global settings — currently just the auto-checkpoint toggle, kept in
  // its own small key/value table (see migration 006) rather than an env
  // var, so it can flip live without a collector restart.
  // ============================================================================
  app.get("/api/settings", (c) => {
    return c.json({ autoCheckpoint: isAutoCheckpointEnabled(store.db) });
  });

  app.put("/api/settings", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.autoCheckpoint === "boolean") {
      setAutoCheckpointEnabled(store.db, body.autoCheckpoint);
    }
    return c.json({ autoCheckpoint: isAutoCheckpointEnabled(store.db) });
  });

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
    // Knowledge doc counts come along because the UI would otherwise have
    // nothing true to say about a project's knowledge — it previously showed
    // an "indexed" label driven by the `expert` field, which nothing in the
    // retrieval path actually reads.
    const counts = new Map(
      (
        store.db
          .query(
            "SELECT project_id, COUNT(*) AS n FROM knowledge GROUP BY project_id"
          )
          .all() as Array<{ project_id: string; n: number }>
      ).map((r) => [r.project_id, r.n])
    );

    // Same shape as knowledgeDocs above, and for the same reason: a
    // bootstrap run that finishes while the user is on another tab is
    // otherwise invisible until they happen to open Knowledge and look.
    const pendingDraftCounts = new Map(
      (
        store.db
          .query(
            "SELECT project_id, COUNT(*) AS n FROM knowledge_drafts WHERE status = 'pending' GROUP BY project_id"
          )
          .all() as Array<{ project_id: string; n: number }>
      ).map((r) => [r.project_id, r.n])
    );

    return c.json(
      getProjects(store.db).map((p) => ({
        ...p,
        knowledgeDocs: counts.get(p.id) ?? 0,
        pendingDrafts: pendingDraftCounts.get(p.id) ?? 0,
      }))
    );
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

    // Sessions that started in this directory before the project existed are
    // sitting in scratch — which is the common case, since you create a
    // project because work is already happening there.
    const moved = rehomeScratchSessions(store.db, project);
    if (moved.length > 0) {
      console.log(`[registry] Moved ${moved.length} session(s) into ${project.id}`);
      broadcastSessions();
    }

    broadcastProjects();
    return c.json({ ...project, movedSessions: moved.length }, 201);
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

    // Editing repos can newly cover a stranded session.
    const moved = rehomeScratchSessions(store.db, updated);
    if (moved.length > 0) broadcastSessions();

    broadcastProjects();
    return c.json({ ...updated, movedSessions: moved.length });
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

  // ============================================================================
  // Project knowledge — markdown files on disk stay the source of truth; the
  // database is an index rebuilt from them. Every mutation resyncs so a doc
  // is searchable the moment it's saved rather than at the next search.
  // ============================================================================

  // Staleness (phase-7 Step 6) is computed here, on every open of the tab,
  // rather than cached — it's two git commands per generated doc, and
  // nobody needs the answer while the tab is closed. Only docs carrying a
  // real generated_from_sha get an opinion at all; a human-authored doc's
  // staleness is always null.
  app.get("/api/projects/:id/knowledge", async (c) => {
    const projectId = c.req.param("id");
    const docs = await listKnowledgeFiles(knowledgeDir, projectId);

    const project = getProjects(store.db).find((p) => p.id === projectId);
    const repoPath = project ? primaryRepoPath(project) : null;

    const withStaleness = await Promise.all(
      docs.map(async (doc) => {
        if (!hasProvenance(doc.generatedFromSha)) {
          return { ...doc, staleness: null };
        }
        if (!repoPath) {
          // Has a sha but nowhere to check it against — same "can't tell"
          // outcome as a sha git can't resolve, not "not applicable".
          return {
            ...doc,
            staleness: {
              sha: doc.generatedFromSha,
              reachable: false,
              commitsSince: null,
              filesChanged: null,
              stale: false,
            },
          };
        }
        return { ...doc, staleness: await computeStaleness(repoPath, doc.generatedFromSha) };
      })
    );

    return c.json(withStaleness);
  });

  // ============================================================================
  // Drafts (phase-7 Step 5 review UI) — registered before
  // GET/PUT/DELETE /api/projects/:id/knowledge/:slug below on purpose. Hono
  // matches routes in registration order, and ":slug" is a wildcard segment
  // that would otherwise swallow "drafts" as if someone had a document
  // literally named that.
  // ============================================================================

  app.get("/api/projects/:id/knowledge/drafts", async (c) => {
    const projectId = c.req.param("id");
    await knowledgeSync?.syncDrafts(projectId);
    const drafts = knowledgeSync?.getDrafts(projectId) ?? [];

    return c.json(
      drafts.map((d) => ({
        ...d,
        // Resolved here so the review card can link to the launch that
        // generated it with a single fetch — the draft row only carries the
        // launch id, not where that launch's session lives.
        launchSessionId: d.generatedByLaunchId
          ? getLaunch(store.db, d.generatedByLaunchId)?.sessionId ?? null
          : null,
      }))
    );
  });

  app.put("/api/projects/:id/knowledge/drafts/:slug", async (c) => {
    const projectId = c.req.param("id");
    const slug = c.req.param("slug");
    const body = await c.req.json<{ title?: string; body?: string; tags?: string[] }>();

    const existing = knowledgeSync?.getDraft(projectId, slug);
    if (!existing) return c.json({ error: "Not found" }, 404);
    if (!body.body?.trim()) {
      return c.json({ error: "body is required" }, 400);
    }

    try {
      // Provenance frontmatter is carried over explicitly. writeDraftFile
      // only writes what it's given, and the point of an edit is changing
      // the text, not silently dropping where the draft came from.
      await writeDraftFile(knowledgeDir, projectId, {
        slug,
        title: body.title?.trim() || existing.title,
        body: body.body,
        tags: body.tags ?? existing.tags,
        generatedFromSha: existing.generatedFromSha,
        generatedAt: existing.generatedAt,
        generatedByLaunchId: existing.generatedByLaunchId,
        replacesSlug: existing.replacesSlug,
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }

    await knowledgeSync?.syncDrafts(projectId);
    // Edited text is a claim nobody has checked yet — leaving the old
    // verdict attached would have it read as current when it describes a
    // body that no longer exists.
    knowledgeSync?.resetDraftVerdict(projectId, slug);

    broadcast({
      type: "knowledge:draft",
      payload: { projectId, slug },
      timestamp: new Date().toISOString(),
    });

    return c.json({ ok: true });
  });

  app.post("/api/projects/:id/knowledge/drafts/:slug/accept", async (c) => {
    const projectId = c.req.param("id");
    const slug = c.req.param("slug");
    const body = await c.req
      .json<{ mode?: string; title?: string; body?: string; tags?: string[] }>()
      .catch(() => ({ mode: undefined, title: undefined, body: undefined, tags: undefined }));

    const draft = knowledgeSync?.getDraft(projectId, slug);
    if (!draft) return c.json({ error: "Not found" }, 404);

    const mode = resolveAcceptMode(draft.replacesSlug, body.mode);

    if (mode === "merge") {
      // The default for a reason: the first real bootstrap run showed a
      // regenerated draft is usually a supplement to what a human wrote,
      // not a replacement, so accept needs the human's combined text rather
      // than silently picking a side.
      if (!body.body?.trim()) {
        return c.json(
          {
            error:
              "Merging requires a combined body — edit both versions into one before accepting, or choose replace instead.",
          },
          400
        );
      }
      try {
        // Deliberately written without provenance, unlike the replace path
        // below (whose rename carries generated_from_sha through) and unlike
        // a plain PUT .../knowledge/:slug edit (which round-trips it — see
        // writeKnowledgeFile's doc comment). A merged doc is partly the
        // human's own prose in a way a typo fix isn't, and staleness only
        // ever flags docs with a sha — calling someone's merge outdated
        // because the machine half of it aged is the second-guessing the
        // design warns against.
        await writeKnowledgeFile(knowledgeDir, projectId, {
          slug: draft.replacesSlug!,
          title: body.title?.trim() || draft.title,
          body: body.body,
          tags: body.tags ?? draft.tags,
        });
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }
      await deleteDraftFile(knowledgeDir, projectId, slug);
    } else {
      // mode === "replace", or null (nothing to replace — a first-bootstrap
      // draft) — both are a plain move of the draft file into place.
      const moved = await acceptDraftFile(knowledgeDir, projectId, slug);
      if (!moved) return c.json({ error: "Not found" }, 404);
    }

    await knowledgeSync?.syncProject(projectId);
    await knowledgeSync?.syncDrafts(projectId);
    broadcastProjects();
    broadcast({
      type: "knowledge:draft",
      payload: { projectId, slug },
      timestamp: new Date().toISOString(),
    });

    return c.json({ ok: true, mode: mode ?? "accept" });
  });

  app.post("/api/projects/:id/knowledge/drafts/:slug/discard", async (c) => {
    const projectId = c.req.param("id");
    const slug = c.req.param("slug");

    const removed = await deleteDraftFile(knowledgeDir, projectId, slug);
    if (!removed) return c.json({ error: "Not found" }, 404);

    await knowledgeSync?.syncDrafts(projectId);
    broadcast({
      type: "knowledge:draft",
      payload: { projectId, slug },
      timestamp: new Date().toISOString(),
    });

    return c.json({ ok: true });
  });

  // Accepts every pending draft that doesn't need a human decision first.
  // Per phase-7.md Step 5, that is a real subset, not "all of them" —
  // anything with replaces_slug set would silently overwrite existing work,
  // and anything the verifier disputed is exactly what review exists to
  // catch. Both are left pending and reported back so the UI can say why.
  app.post("/api/projects/:id/knowledge/drafts/accept-all", async (c) => {
    const projectId = c.req.param("id");
    const pending = knowledgeSync?.getDrafts(projectId) ?? [];

    const accepted: string[] = [];
    const skipped: Array<{ slug: string; reason: "replaces" | "disputed" }> = [];

    for (const draft of pending) {
      if (!isAcceptAllEligible(draft)) {
        skipped.push({
          slug: draft.slug,
          reason: draft.replacesSlug ? "replaces" : "disputed",
        });
        continue;
      }
      const moved = await acceptDraftFile(knowledgeDir, projectId, draft.slug);
      if (moved) accepted.push(draft.slug);
    }

    await knowledgeSync?.syncProject(projectId);
    await knowledgeSync?.syncDrafts(projectId);
    broadcastProjects();
    broadcast({
      type: "knowledge:draft",
      payload: { projectId, acceptedAll: true },
      timestamp: new Date().toISOString(),
    });

    return c.json({ accepted, skipped });
  });

  app.get("/api/projects/:id/knowledge/:slug", async (c) => {
    const doc = await readKnowledgeFile(
      knowledgeDir,
      c.req.param("id"),
      c.req.param("slug")
    );
    if (!doc) return c.json({ error: "Not found" }, 404);
    return c.json(doc);
  });

  app.put("/api/projects/:id/knowledge/:slug", async (c) => {
    const projectId = c.req.param("id");
    const slug = c.req.param("slug");
    const body = await c.req.json<{ title?: string; body?: string; tags?: string[] }>();

    if (!getProject(store.db, projectId)) {
      return c.json({ error: "Unknown project" }, 404);
    }
    if (!body.body?.trim()) {
      return c.json({ error: "body is required" }, 400);
    }

    // Carried over explicitly (phase-7 Step 6) — see writeKnowledgeFile's
    // doc comment. Editing text is a smaller act than the merge-accept path
    // below (which drops provenance on purpose), and losing it here would
    // make a typo fix silently exempt a generated doc from staleness for
    // good.
    const existing = await readKnowledgeFile(knowledgeDir, projectId, slug);

    try {
      await writeKnowledgeFile(knowledgeDir, projectId, {
        slug,
        title: body.title?.trim() || slug,
        body: body.body,
        tags: body.tags,
        generatedFromSha: existing?.generatedFromSha,
        generatedAt: existing?.generatedAt,
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }

    await knowledgeSync?.syncProject(projectId);
    broadcastProjects();
    return c.json({ ok: true });
  });

  app.delete("/api/projects/:id/knowledge/:slug", async (c) => {
    const projectId = c.req.param("id");
    const removed = await deleteKnowledgeFile(
      knowledgeDir,
      projectId,
      c.req.param("slug")
    );
    if (!removed) return c.json({ error: "Not found" }, 404);

    await knowledgeSync?.syncProject(projectId);
    broadcastProjects();
    return c.json({ ok: true });
  });

  // Sessions. Ended ones are excluded by default so the console reflects
  // what's live; ?all=1 includes them so they can be reviewed and cleaned up.
  app.get("/api/sessions", async (c) => {
    const sessions =
      c.req.query("all") === "1"
        ? getAllSessions(store.db)
        : getActiveSessions(store.db);
    return c.json(await Promise.all(sessions.map((s) => withActivityTicks(store, s))));
  });

  app.get("/api/sessions/:id", async (c) => {
    const session = getSession(store.db, c.req.param("id"));
    if (!session) return c.json({ error: "Not found" }, 404);
    return c.json(await withActivityTicks(store, session));
  });

  app.get("/api/projects/:id/sessions", async (c) => {
    const sessions = getSessionsByProject(store.db, c.req.param("id"));
    return c.json(await Promise.all(sessions.map((s) => withActivityTicks(store, s))));
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

    // The process behind any pending ask is now gone, so nothing will ever
    // resolve it — left pending it would sit in Blocked forever pointing at
    // a session that no longer exists.
    for (const ask of cancelAllPendingAsks(store.db, sessionId)) {
      broadcast({
        type: "ask:resolved",
        payload: { askId: ask.id, answer: "" },
        timestamp: new Date().toISOString(),
      });
    }

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

  /**
   * The session's current screen, when Standup owns its pane.
   *
   * Keyed by session rather than launch so callers holding an ask (which
   * references a session) can show what the agent is actually waiting on. A
   * Notification hook reports *that* an agent is blocked but never *what*
   * it's blocked on — without this, a prompt-ask is an alert with no
   * content, which is not something a human can act on.
   */
  app.get("/api/sessions/:id/output", async (c) => {
    const sessionId = c.req.param("id");
    const launch = getLaunchBySession(store.db, sessionId);

    // Not an error: monitored sessions simply have no pane to read, and the
    // caller renders that as "look at your own terminal".
    if (!launch) return c.json({ output: "", alive: false, owned: false });

    try {
      const result = await captureLaunchOutput(launch, 60);
      return c.json({ ...result, owned: true });
    } catch {
      return c.json({ output: "", alive: false, owned: true });
    }
  });

  /**
   * The session's actual conversation, read from Claude Code's transcript.
   *
   * Works for monitored sessions as well as launched ones, and with full
   * history either way: the transcript covers the whole session including
   * whatever happened before Standup started observing.
   *
   * `owned` tells the client whether replying is possible — Standup can only
   * type into panes it created.
   */
  app.get("/api/sessions/:id/transcript", async (c) => {
    const sessionId = c.req.param("id");
    if (!getSession(store.db, sessionId)) {
      return c.json({ error: "Not found" }, 404);
    }

    const path = transcriptPathForSession(store.db, sessionId);
    if (!path) {
      return c.json({
        messages: [],
        hasMore: false,
        totalMessages: 0,
        totalTokens: 0,
        owned: false,
      });
    }

    // Capped: the reader only tails a fixed slice of the file, so asking for
    // more than it can hold would promise history it cannot return.
    const limit = Math.min(parseInt(c.req.query("limit") ?? "40"), 400);
    const page = await readTranscript(path, limit);

    return c.json({ ...page, owned: !!getLaunchBySession(store.db, sessionId) });
  });

  /**
   * Types into a session, keyed by session rather than launch so the
   * transcript view can reply without knowing about launches.
   */
  app.post("/api/sessions/:id/send", async (c) => {
    const sessionId = c.req.param("id");
    const { text } = await c.req.json<{ text: string }>();
    if (!text?.trim()) return c.json({ error: "text is required" }, 400);

    const launch = getLaunchBySession(store.db, sessionId);
    if (!launch) {
      return c.json(
        {
          error:
            "Standup didn't launch this session, so it can't type into it — reply in its own terminal.",
        },
        409
      );
    }

    const result = await sendToLaunch(launch, text.trim());
    if (!result.ok) return c.json({ error: result.error }, 409);

    updateSessionStatus(store.db, sessionId, "running");
    broadcast({
      type: "session:status",
      payload: { sessionId, status: "running" },
      timestamp: new Date().toISOString(),
    });

    return c.json({ ok: true });
  });

  /**
   * Adopts a monitored session: resumes it under a tmux session Standup
   * owns, so it gains the read/type/stop capabilities a launched session
   * has. `claude --resume` reuses the session id, so existing history stays
   * attached.
   */
  app.post("/api/sessions/:id/adopt", async (c) => {
    const sessionId = c.req.param("id");
    const session = getSession(store.db, sessionId);
    if (!session) return c.json({ error: "Not found" }, 404);

    if (isLaunchedSession(store.db, sessionId)) {
      return c.json({ error: "Standup already owns this session" }, 409);
    }

    try {
      const result = await adoptSession(store.db, session);

      broadcast({
        type: "launch:started",
        payload: result.launch,
        timestamp: new Date().toISOString(),
      });

      if (result.launch.status === "failed") {
        return c.json({ error: result.launch.error ?? "Adoption failed" }, 409);
      }

      // The resumed process reports in as the same session id, so clear the
      // ended marker rather than waiting for its first hook to revive it.
      reviveSession(store.db, sessionId);
      updateSessionStatus(store.db, sessionId, "running");
      broadcast({
        type: "session:status",
        payload: { sessionId, status: "running" },
        timestamp: new Date().toISOString(),
      });

      return c.json(result);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
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

      // A compound AskUserQuestion needs one reply per sub-question — see
      // describePendingTool, which tells the human to send one per line.
      // Each send needs a beat to land before the next one, or the TUI is
      // still animating onto the next question when the second answer
      // arrives and it's dropped.
      const parts = answer
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      for (const [i, part] of parts.entries()) {
        const sent = await sendToLaunch(launch, part);
        if (!sent.ok) {
          return c.json({ error: sent.error ?? "Could not reach the session" }, 409);
        }
        if (i < parts.length - 1) await new Promise((r) => setTimeout(r, 400));
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

  // Dismiss without answering — for when the question is stale, was
  // answered directly in the terminal, or just isn't worth a reply. An
  // ask_human has a real waiter (an MCP tool call long-polling this row),
  // and cancelAsk is the same terminal state waitForAskResolution already
  // treats as "done" for a stopped session, so the waiter unblocks cleanly
  // with an empty answer instead of hanging until its timeout.
  app.delete("/api/asks/:id", (c) => {
    const askId = c.req.param("id");
    const ask = getAsk(store.db, askId);
    if (!ask) return c.json({ error: "Not found" }, 404);

    cancelAsk(store.db, askId);

    broadcast({
      type: "ask:resolved",
      payload: { askId, answer: "" },
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
    const { task, model, effort } = await c.req.json<{
      task: string;
      model?: string;
      effort?: string;
    }>();

    if (!task?.trim()) {
      return c.json({ error: "task is required" }, 400);
    }
    if (model && !CLAUDE_MODELS.includes(model as ClaudeModel)) {
      return c.json({ error: `Unknown model: ${model}` }, 400);
    }
    if (effort && !CLAUDE_EFFORTS.includes(effort as ClaudeEffort)) {
      return c.json({ error: `Unknown effort level: ${effort}` }, 400);
    }

    const project = getProjects(store.db).find((p) => p.id === projectId);
    if (!project) {
      return c.json({ error: `Unknown project: ${projectId}` }, 404);
    }

    try {
      const result = await launchSession(store.db, {
        project,
        task: task.trim(),
        model: model as ClaudeModel | undefined,
        effort: effort as ClaudeEffort | undefined,
      });

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

  // Starts a knowledge-bootstrap run (phase-7 Step 3). Deliberately its own
  // route rather than a `kind` flag on POST /launch — it needs a different
  // model/effort default and, per the design, must never be reachable by
  // anything automatic (no hook, no auto-run on project creation). It reuses
  // launchSession wholesale: a bootstrap run gets a real worktree so its
  // git HEAD is stable for the duration of the run, which is what makes
  // generated_from_sha (stamped by /api/knowledge/propose) mean something.
  //
  // The task string is a Step 4 placeholder — see bootstrap-prompt.ts.
  app.post("/api/projects/:id/bootstrap-knowledge", async (c) => {
    const projectId = c.req.param("id");
    const { model, effort } = await c.req.json<{ model?: string; effort?: string }>().catch(
      () => ({ model: undefined, effort: undefined })
    );

    if (model && !CLAUDE_MODELS.includes(model as ClaudeModel)) {
      return c.json({ error: `Unknown model: ${model}` }, 400);
    }
    if (effort && !CLAUDE_EFFORTS.includes(effort as ClaudeEffort)) {
      return c.json({ error: `Unknown effort level: ${effort}` }, 400);
    }

    const project = getProjects(store.db).find((p) => p.id === projectId);
    if (!project) {
      return c.json({ error: `Unknown project: ${projectId}` }, 404);
    }

    try {
      // Opus at high effort by default — deciding what NOT to write is the
      // whole task (phase-7.md Step 3), so this is judgment work, not the
      // kind of thing the CLI's own default model should be trusted with.
      // The caller can still override, same as a normal launch.
      const result = await launchSession(store.db, {
        project,
        task: bootstrapPrompt(project),
        // Without this the branch would be named after the prompt's first
        // forty characters and the feed would show the whole page of it.
        label: `Bootstrap knowledge for ${project.name}`,
        model: (model as ClaudeModel | undefined) ?? "opus",
        effort: (effort as ClaudeEffort | undefined) ?? "high",
        kind: "bootstrap",
      });

      broadcast({
        type: "launch:started",
        payload: result.launch,
        timestamp: new Date().toISOString(),
      });

      return c.json(result);
    } catch (err) {
      // Same shape as POST /launch: thrown only for misconfiguration caught
      // before a launch row exists (no repos, missing path).
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

    // This endpoint (the Feed's launch control) previously stopped the tmux
    // pane but never touched the session row or its asks — the session kept
    // reading as "running"/"waiting" and any pending ask sat in Blocked
    // pointing at a session that was already gone. Mirrors what
    // /api/sessions/:id/stop does.
    if (launch.sessionId) {
      endSession(store.db, launch.sessionId);
      for (const ask of cancelAllPendingAsks(store.db, launch.sessionId)) {
        broadcast({
          type: "ask:resolved",
          payload: { askId: ask.id, answer: "" },
          timestamp: new Date().toISOString(),
        });
      }
      broadcast({
        type: "session:status",
        payload: { sessionId: launch.sessionId, status: "idle" },
        timestamp: new Date().toISOString(),
      });
    }

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

  // Runs `git rev-parse HEAD` in a launch's own worktree. Provenance is
  // stamped here rather than trusted from the agent's tool call — that is
  // the entire reason propose_knowledge is a collector-mediated tool and not
  // the agent writing a file directly. Returns null (not a thrown error) on
  // any failure so a git hiccup degrades to an unstamped draft rather than
  // losing the draft's content.
  async function gitHeadSha(cwd: string): Promise<string | null> {
    try {
      const proc = Bun.spawn(["git", "rev-parse", "HEAD"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      return proc.exitCode === 0 ? stdout.trim() : null;
    } catch {
      return null;
    }
  }

  app.post("/api/knowledge/propose", async (c) => {
    const { session_id, cwd, slug, title, body, tags } = await c.req.json<{
      session_id?: string;
      cwd: string;
      slug: string;
      title: string;
      body: string;
      tags?: string[];
    }>();

    const session = resolveCallingSession(session_id, cwd);
    if (!session) {
      return c.json(
        { error: `No active session found for cwd "${cwd}". Is the collector running and did this session register at startup?` },
        400
      );
    }

    // The security-relevant gate. Without it, any agent in any session could
    // write a "draft" into any project's knowledge base — the whole point of
    // this being a gated tool rather than the agent writing files itself.
    // Keyed on cwd (a bootstrap launch's worktree), not session_id, so it
    // can't be bypassed by an unrelated session merely claiming one.
    const launch = findLaunchByCwd(store.db, cwd);
    if (!launch || launch.kind !== "bootstrap" || launch.status !== "running") {
      return c.json(
        {
          error:
            "propose_knowledge is only available inside a running bootstrap knowledge run.",
        },
        403
      );
    }

    if (!isValidSlug(slug)) {
      return c.json(
        { error: "Slug must be letters, numbers and hyphens — it becomes a filename." },
        400
      );
    }
    if (!title?.trim()) {
      return c.json({ error: "title is required" }, 400);
    }
    if (!body?.trim()) {
      return c.json({ error: "body is required" }, 400);
    }

    // The launch's own project, not the session's — a bootstrap worktree
    // sits outside the project's configured repos, so this is the only
    // reliable source (see findLaunchByCwd's doc comment in launches.ts).
    const projectId = launch.projectId;

    const generatedFromSha = await gitHeadSha(launch.worktreePath);

    // An accepted doc with this slug already existing means this draft would
    // replace it on accept — the regenerate case, distinct from a first
    // bootstrap where replacesSlug stays unset (see phase-7.md Step 5).
    const existingDoc = await readKnowledgeFile(knowledgeDir, projectId, slug);
    const replacesSlug = existingDoc ? slug : undefined;

    try {
      await writeDraftFile(knowledgeDir, projectId, {
        slug,
        title: title.trim(),
        body,
        tags,
        generatedFromSha: generatedFromSha ?? undefined,
        generatedAt: new Date().toISOString(),
        generatedByLaunchId: launch.id,
        replacesSlug,
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }

    // Write-then-sync, the same pattern PUT /api/projects/:id/knowledge/:slug
    // uses for accepted docs: the file is the source of truth, this just
    // reconciles knowledge_drafts to match what's now on disk.
    await knowledgeSync?.syncDrafts(projectId);

    // Fact-check in the background. Deliberately not awaited: the bootstrap
    // agent is blocked inside this tool call, and making it wait ~a minute
    // per document to be checked would triple the run's wall time for a
    // result it is not the audience for. The human is, at review — and by
    // then it has landed.
    void (async () => {
      const result = await verifyDraft(slug, body, launch.worktreePath);
      knowledgeSync?.recordDraftVerdict(projectId, slug, result.verdict, result.disputes);
      broadcast({
        type: "knowledge:draft",
        payload: { projectId, slug, verdict: result.verdict, disputes: result.disputes },
        timestamp: new Date().toISOString(),
      });
    })();

    broadcast({
      type: "knowledge:draft",
      payload: {
        projectId,
        slug,
        title: title.trim(),
        generatedFromSha,
        launchId: launch.id,
        replacesSlug: replacesSlug ?? null,
      },
      timestamp: new Date().toISOString(),
    });

    return c.json({ ok: true, slug });
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

async function withActivityTicks(store: Store, session: Session): Promise<Session> {
  const transcriptPath = transcriptPathForSession(store.db, session.id);
  return {
    ...session,
    activityTicks: getSilenceTicks(store.db, session.id),
    // Whether Standup owns this session's terminal. Drives which controls
    // the UI offers, so it belongs on every session response rather than
    // being fetched separately per session.
    owned: isLaunchedSession(store.db, session.id),
    liveEffort: currentEffortForSession(store.db, session.id) ?? undefined,
    liveModel: (await currentModelForSession(transcriptPath)) ?? undefined,
  };
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

interface AskUserQuestionInput {
  questions?: Array<{
    question?: string;
    header?: string;
    options?: Array<{ label?: string }>;
  }>;
}

/**
 * The Notification hook reports only *that* an agent is blocked, never
 * *what* it's blocked on — that lives on the PreToolUse event for the tool
 * call it's still sitting inside, which (since nothing else can have run
 * while it's blocked) is guaranteed to be the most recent event recorded.
 * Reading it back turns "Claude needs your permission" into something a
 * human can actually act on, for AskUserQuestion's real questions/options as
 * well as any other tool waiting on approval (Bash, Write, ...).
 */
function describePendingTool(store: Store, sessionId: string): string | null {
  const [last] = getRecentEventsBySession(store.db, sessionId, 1);
  if (!last || last.type !== "PreToolUse") return null;

  const p = last.payload as { tool_name?: string; tool_input?: unknown };
  if (!p.tool_name) return null;

  if (p.tool_name === "AskUserQuestion") {
    const questions = (p.tool_input as AskUserQuestionInput)?.questions ?? [];
    if (questions.length === 0) return null;

    const body = questions
      .map((q, i) => {
        const opts = (q.options ?? [])
          .map((o, j) => `${j + 1}. ${o.label ?? ""}`)
          .join("  ");
        const prefix = questions.length > 1 ? `${i + 1}) ` : "";
        return `${prefix}${q.header ? `${q.header}: ` : ""}${q.question ?? ""}${
          opts ? `\n   ${opts}` : ""
        }`;
      })
      .join("\n");

    return questions.length > 1
      ? `${body}\n\nMultiple questions — reply with one answer per line, in order (option number or free text).`
      : body;
  }

  // Any other tool needing approval — show what it's asking to do, not just
  // that it's asking.
  const input = p.tool_input as Record<string, unknown> | undefined;
  const inputText = input ? JSON.stringify(input) : "";
  return `${p.tool_name}${inputText ? ` — ${inputText.slice(0, 300)}` : ""}`;
}

function handleHookEvent(
  store: Store,
  payload: HookPayload,
  broadcast: WsBroadcast
): Record<string, unknown> | null {
  const { session_id, hook_event_name, cwd } = payload;

  // Standup's own auto-checkpoint summarizer is a real `claude -p`
  // invocation, and Standup's hooks are installed globally — every
  // invocation fires them, not just interactive sessions (see
  // scripts/setup-hooks.ts). It always runs from this one reserved cwd, so
  // that's the signal to ignore it entirely: no session row, no events,
  // nothing. Without this, its own Stop event would trigger another
  // auto-checkpoint call on itself and recurse without bound — verified
  // live, three generations deep, before manually disabling the setting
  // interrupted it.
  // Prefix-matched over the reserved root rather than a single path, so a
  // new internal subprocess is covered by existing;  matching one constant
  // is what would silently reopen the loop for the next one.
  if (isInternalCwd(cwd)) return null;

  ensureSession(store, session_id, cwd, hook_event_name);

  // Populated by UserPromptSubmit when steers are waiting; returned to
  // Claude Code as the hook's output.
  let hookOutput: Record<string, unknown> | null = null;

  switch (hook_event_name) {
    case "SessionStart": {
      // Claude Code reuses the same session_id across /clear, so without
      // this the title stays pinned to whatever the very first prompt was —
      // increasingly stale and unrelated as a long-lived session gets
      // cleared and reused for something new.
      const p = payload as { source?: "startup" | "resume" | "clear" } & typeof payload;
      if (p.source === "clear") {
        resetSessionTitle(store.db, session_id);
      }

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
      clearAutoCheckpointState(session_id);
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

      // PostToolUse firing proves whatever blocked the agent (an
      // AskUserQuestion, a Bash approval, ...) just got resolved — whether
      // through Standup's ask flow or answered directly in the terminal.
      // Same reasoning as cancelPromptAsks in UserPromptSubmit below: left
      // pending, a directly-answered prompt would badge the Blocked view
      // forever for something that's already moved on.
      for (const stale of cancelPromptAsks(store.db, session_id)) {
        broadcast({
          type: "ask:resolved",
          payload: { askId: stale.id, answer: "" },
          timestamp: new Date().toISOString(),
        });
      }

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

      // Auto-checkpointing — off by default (real cost per call, see
      // auto-checkpoint.ts). Fired without awaiting: it shells out to
      // `claude -p` and takes seconds, and the hook response must not wait
      // on that or every turn boundary gets slower for the agent.
      if (isAutoCheckpointEnabled(store.db)) {
        void maybeAutoCheckpoint(store.db, session_id)
          .then((checkpoint) => {
            if (!checkpoint) return;
            broadcast({
              type: "checkpoint:new",
              payload: checkpoint,
              timestamp: new Date().toISOString(),
            });
          })
          .catch((err) => {
            console.error(`[auto-checkpoint] ${session_id.slice(0, 8)}:`, err);
          });
      }
      break;
    }

    case "SubagentStop": {
      // Structural checkpoint from a subagent finishing.
      //
      // There is no `description` field — verified payload carries
      // `agent_type`, `agent_id`, and `last_assistant_message`. An earlier
      // version keyed on `description` and so silently skipped every event.
      //
      // Gated on a non-empty agent_type, which is what the design means by
      // "a *named* subtask". Claude Code fires SubagentStop for internal
      // helpers too (title generation, summarization); those carry an empty
      // agent_type and a last_assistant_message that is often just the
      // human's own words echoed back. Checkpointing those would fill the
      // feed with the user's own messages attributed to an agent.
      const p = payload as {
        agent_type?: string;
        last_assistant_message?: string;
      } & typeof payload;

      const summary = p.last_assistant_message?.trim();
      if (p.agent_type && summary) {
        const checkpoint = createCheckpoint(
          store.db,
          session_id,
          "structural",
          summary.length > 280 ? `${summary.slice(0, 277)}…` : summary
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
          describePendingTool(store, session_id) ??
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
            ? `${detail}\n\n(this session was launched by the console, so nobody is at its terminal)`
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
