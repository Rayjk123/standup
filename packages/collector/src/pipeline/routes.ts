import type { Context, Hono } from "hono";
import type { Database } from "bun:sqlite";
import { DEFAULT_PIPELINE, PIPELINE_CATALOG, pipelineLayerFromInput, pipelineStageSummary, specProjectRefusal } from "@standup/shared";
import type { PipelineOverride, Session } from "@standup/shared";
import {
  deletePipelineConfig,
  findLaunchByCwd,
  getPersonaJob,
  getPipelineConfig,
  getPipelineConfigVersion,
  getPipelineRun,
  getPipelineRunByLaunch,
  getProject,
  listPipelineDecisions,
  listPipelineRunsByLaunches,
  liveReviewTunnelForLaunch,
  setPipelineConfig,
} from "@standup/store";
import {
  PERSONA_DECISION_KINDS,
  acceptWontfixReview,
  advancePipeline,
  checkPipelineLayers,
  decidePipelineStage,
  parkPipelineRun,
  personaParkDecision,
  pipelineRunForSession,
  pipelineStatusView,
  projectSeedLayer,
  projectsBrokenByGlobal,
  publishPipelineConfig,
  unparkPipelineRun,
  resolvePipelineFor,
  setPipelineLayerByPersona,
  waivePipelineStage,
  type AdvanceResult,
  type PersonaDecisionKind,
  type PipelineDeps,
  type PipelineLayerScope,
} from "./engine.js";
import { screenshotCopyName } from "./runners.js";

export interface PipelineRoutesOptions {
  db: Database;
  deps: PipelineDeps;
  /** The calling session for an MCP request, by id and then by cwd (server.ts resolveCallingSession). */
  resolveCallingSession: (sessionId: string | null | undefined, cwd: string) => Session | null;
  /**
   * A refusal Response unless the request is a human's through the console
   * (it carries the owner token no worker holds); null when it may proceed.
   */
  humanRefusal: (c: Context, what: string) => Response | null;
  /** The request's own identity — never a body-supplied actor. */
  identityOf: (c: Context) => string;
  /** The owner of the Persona whose credential the request carries, or undefined when it carries none. */
  personaOwnerOf?: (c: Context) => string | undefined;
  /**
   * The owner of the Persona runtime whose in-process writer secret the
   * request carries — a call made by Persona's tool layer itself, never by
   * its turn's MCP proxy — or undefined. Only such a call may say the owner
   * approved it (`ownerApproved`).
   */
  personaRuntimeCallOf?: (c: Context) => string | undefined;
}

/**
 * The delivery-pipeline API: the worker's status/advance calls (through the
 * standup MCP server), the console's run reads, screenshot serving and stage
 * waivers, Persona's decisions on blocked runs and the layers it sets (with
 * their audit), and each owner's pipeline configuration.
 */
export function mountPipelineRoutes(app: Hono, opts: PipelineRoutesOptions): void {
  const { db, deps } = opts;

  /**
   * The run of the calling worker's launch: from its session — across every
   * launch sharing that session id (an adopted or resumed session), subagents
   * through their parents — else from its cwd.
   */
  const runForCaller = (sessionId: string | null | undefined, cwd: string | null | undefined) => {
    const session = opts.resolveCallingSession(sessionId, cwd ?? "");
    let run = session ? pipelineRunForSession(db, session.id) : null;
    if (!run && !session && cwd) {
      const launch = findLaunchByCwd(db, cwd);
      run = launch ? getPipelineRunByLaunch(db, launch.id) : null;
    }
    return { session, run };
  };

  const advanceResponse = (c: Context, result: AdvanceResult) => {
    if (!result.ok) {
      return c.json({ error: result.error, ...(result.missing ? { missing: result.missing } : {}) }, result.status);
    }
    const { run, from, to, outcome, skipped, message } = result;
    return c.json({ run, from, to, outcome, skipped, message });
  };

  app.post("/api/pipeline/status", async (c) => {
    const body = await c.req
      .json<{ session_id?: string | null; cwd?: string | null }>()
      .catch(() => ({}) as { session_id?: string | null; cwd?: string | null });
    const { run } = runForCaller(body.session_id, body.cwd);
    if (!run) return c.json({ error: "This session's launch has no delivery pipeline run" }, 404);
    const tunnel = liveReviewTunnelForLaunch(db, run.launchId);
    return c.json({
      ...pipelineStatusView(run),
      ...(tunnel
        ? { reviewTunnel: { url: tunnel.url, port: tunnel.port, status: tunnel.status, ...(tunnel.expiresAt ? { expiresAt: tunnel.expiresAt } : {}) } }
        : {}),
    });
  });

  app.post("/api/pipeline/advance", async (c) => {
    const body = await c.req
      .json<{ session_id?: string | null; cwd?: string | null; stage?: unknown; evidence?: unknown; skip?: unknown; waive?: unknown }>()
      .catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "malformed request body" }, 400);
    if (typeof body.stage !== "string" || !body.stage.trim()) return c.json({ error: "stage is required" }, 400);
    if (body.skip !== undefined && body.skip !== null && (typeof body.skip !== "object" || Array.isArray(body.skip))) {
      return c.json({ error: "skip must be an object {reason}" }, 400);
    }
    const waive = body.waive ?? undefined;
    if (waive !== undefined && (typeof waive !== "object" || Array.isArray(waive))) {
      return c.json({ error: "waive must be an object {reason}" }, 400);
    }
    if (waive !== undefined && (body.evidence !== undefined || (body.skip !== undefined && body.skip !== null))) {
      return c.json({ error: "waive can't be combined with evidence or skip" }, 400);
    }
    const { session, run } = runForCaller(body.session_id, body.cwd);
    if (!run) return c.json({ error: "This session's launch has no delivery pipeline run" }, 404);
    // A worker reporting a stage is working again, whatever comes of the report.
    unparkPipelineRun(db, run.id, deps);
    if (waive !== undefined) {
      const reason = (waive as { reason?: unknown }).reason;
      const result = await waivePipelineStage(
        db,
        run.id,
        { stage: body.stage.trim(), reason: typeof reason === "string" ? reason : "", actor: "worker", by: "worker", sessionId: session?.id },
        deps
      );
      return advanceResponse(c, result);
    }
    const result = await advancePipeline(
      db,
      run.id,
      {
        stage: body.stage.trim(),
        evidence: body.evidence,
        skip: (body.skip as { reason?: unknown } | null | undefined) ?? undefined,
        sessionId: session?.id,
      },
      deps
    );
    return advanceResponse(c, result);
  });

  // The worker parks its own run while it waits on something outside its
  // launch (another job landing): its Stops go through until a message
  // reaches it, it un-parks, or it advances.
  app.post("/api/pipeline/park", async (c) => {
    const body = await c.req
      .json<{ session_id?: string | null; cwd?: string | null; reason?: unknown; waitingOnJobId?: unknown }>()
      .catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "malformed request body" }, 400);
    const { session, run } = runForCaller(body.session_id, body.cwd);
    if (!run) return c.json({ error: "This session's launch has no delivery pipeline run" }, 404);
    const result = parkPipelineRun(
      db,
      run.id,
      { reason: body.reason, waitingOnJobId: body.waitingOnJobId, by: "worker", actor: session?.id ?? "worker" },
      deps
    );
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ run: result.run, parked: result.run.parked });
  });

  app.post("/api/pipeline/unpark", async (c) => {
    const body = await c.req
      .json<{ session_id?: string | null; cwd?: string | null }>()
      .catch(() => ({}) as { session_id?: string | null; cwd?: string | null });
    const { run } = runForCaller(body.session_id, body.cwd);
    if (!run) return c.json({ error: "This session's launch has no delivery pipeline run" }, 404);
    const result = unparkPipelineRun(db, run.id, deps);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ run: result.run, cleared: result.cleared === true });
  });

  // The owner's Persona parks one of its owner's workers to wait (on another
  // job, say), or lets it go on — each recorded in the owner's audit.
  for (const [path, park] of [
    ["/api/pipeline/park-session", true],
    ["/api/pipeline/unpark-session", false],
  ] as const) {
    app.post(path, async (c) => {
      const personaOwner = opts.personaOwnerOf?.(c);
      if (!personaOwner) return c.json({ error: "Only Persona parks or un-parks a worker through this route" }, 403);
      const body = await c.req
        .json<{ sessionId?: unknown; why?: unknown; waitingOnJobId?: unknown }>()
        .catch(() => ({}) as { sessionId?: unknown; why?: unknown; waitingOnJobId?: unknown });
      if (typeof body.sessionId !== "string" || !body.sessionId.trim()) return c.json({ error: "sessionId is required" }, 400);
      const run = pipelineRunForSession(db, body.sessionId.trim());
      // Another owner's run reads as none.
      if (!run || run.owner !== personaOwner) return c.json({ error: "That session's launch has no delivery pipeline run" }, 404);
      const result = personaParkDecision(
        db,
        run.id,
        { park, why: body.why, waitingOnJobId: body.waitingOnJobId, actor: `${personaOwner}'s Persona` },
        deps
      );
      if (!result.ok) return c.json({ error: result.error }, result.status);
      return c.json({
        run: result.run,
        ...(park ? { parked: result.run.parked } : { cleared: result.cleared === true }),
        ...(result.decision ? { decision: result.decision } : {}),
      });
    });
  }

  // The console's run reads: a signed-in human sees their own runs only.
  // Workers read their run through /api/pipeline/status.
  app.get("/api/pipeline/runs", (c) => {
    const refused = opts.humanRefusal(c, "read pipeline runs");
    if (refused) return refused;
    const owner = opts.identityOf(c);
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
    return c.json({ runs: listPipelineRunsByLaunches(db, launchIds).filter((run) => run.owner === owner) });
  });

  /** The run `id` when the request's human owns it, else null (unknown and not-yours read the same). */
  const ownRun = (c: Context, id: string) => {
    const run = getPipelineRun(db, id);
    return run && run.owner === opts.identityOf(c) ? run : null;
  };

  app.get("/api/pipeline/runs/:id", (c) => {
    const refused = opts.humanRefusal(c, "read pipeline runs");
    if (refused) return refused;
    const run = ownRun(c, c.req.param("id"));
    if (!run) return c.json({ error: "Unknown pipeline run" }, 404);
    return c.json({ run });
  });

  // A screenshot a worker recorded, addressed by run, attempt and index only.
  // What is served is the collector's own stored copy of the bytes it
  // validated when a screenshot stage was advanced, found by those ids alone —
  // never a path from the evidence — so no caller can name a file.
  app.get("/api/pipeline/runs/:id/screenshots/:attemptId/:index", (c) => {
    const refused = opts.humanRefusal(c, "view pipeline screenshots");
    if (refused) return refused;
    const run = ownRun(c, c.req.param("id"));
    const attempt = run?.attempts.find((a) => a.id === c.req.param("attemptId"));
    const kind = attempt ? run?.definition.stages.find((s) => s.id === attempt.stageId)?.kind : undefined;
    const index = Number(c.req.param("index"));
    const shots = (attempt?.evidence as { screenshots?: Array<{ storedPath?: unknown }> } | undefined)?.screenshots;
    const shot = Array.isArray(shots) && Number.isInteger(index) && index >= 0 ? shots[index] : undefined;
    if (!run || !attempt || kind !== "screenshot" || !shot || typeof shot.storedPath !== "string") {
      return c.json({ error: "Unknown screenshot" }, 404);
    }
    const storedPath = deps.screenshots.pathFor(run.id, screenshotCopyName(attempt.id, index));
    const bytes = storedPath ? deps.screenshots.read(storedPath) : null;
    if (!bytes) return c.json({ error: "The screenshot's stored copy is gone" }, 410);
    return new Response(bytes, {
      headers: {
        "content-type": "image/png",
        "content-length": String(bytes.length),
        "content-disposition": `inline; filename="screenshot-${index}.png"`,
        "cache-control": "private, max-age=300",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  });

  app.post("/api/pipeline/runs/:id/waive", async (c) => {
    const refused = opts.humanRefusal(c, "waive a pipeline stage");
    if (refused) return refused;
    const run = getPipelineRun(db, c.req.param("id"));
    if (!run) return c.json({ error: "Unknown pipeline run" }, 404);
    const actor = opts.identityOf(c);
    if (actor !== run.owner) return c.json({ error: `Only the run's owner (${run.owner}) can waive its stages` }, 403);
    const body = await c.req.json<{ stage?: unknown; reason?: unknown }>().catch(() => ({}) as { stage?: unknown; reason?: unknown });
    if (typeof body.stage !== "string" || !body.stage.trim()) return c.json({ error: "stage is required" }, 400);
    if (typeof body.reason !== "string" || !body.reason.trim()) return c.json({ error: "reason is required" }, 400);
    return advanceResponse(c, await waivePipelineStage(db, run.id, { stage: body.stage.trim(), reason: body.reason.trim(), actor }, deps));
  });

  // The owner's Persona waives a stage of one of its owner's runs as not
  // applicable — only on a launch that changed no code (waivePipelineStage).
  app.post("/api/pipeline/waive-not-applicable", async (c) => {
    const personaOwner = opts.personaOwnerOf?.(c);
    if (!personaOwner) return c.json({ error: "Only Persona waives through this route; the owner waives in the console" }, 403);
    const body = await c.req
      .json<{ sessionId?: unknown; stage?: unknown; reason?: unknown }>()
      .catch(() => ({}) as { sessionId?: unknown; stage?: unknown; reason?: unknown });
    if (typeof body.sessionId !== "string" || !body.sessionId.trim()) return c.json({ error: "sessionId is required" }, 400);
    if (typeof body.stage !== "string" || !body.stage.trim()) return c.json({ error: "stage is required" }, 400);
    const run = pipelineRunForSession(db, body.sessionId.trim());
    // Another owner's run reads as none.
    if (!run || run.owner !== personaOwner) return c.json({ error: "That session's launch has no delivery pipeline run" }, 404);
    const reason = typeof body.reason === "string" ? body.reason : "";
    return advanceResponse(
      c,
      await waivePipelineStage(db, run.id, { stage: body.stage.trim(), reason, actor: `${personaOwner}'s Persona`, by: "persona" }, deps)
    );
  });

  // The owner's Persona waives a review held on wontfix findings, accepting
  // them — only while every blocking finding is wontfix (acceptWontfixReview).
  app.post("/api/pipeline/accept-wontfix", async (c) => {
    const personaOwner = opts.personaOwnerOf?.(c);
    if (!personaOwner) return c.json({ error: "Only Persona accepts wontfix findings through this route; the owner waives in the console" }, 403);
    const body = await c.req
      .json<{ sessionId?: unknown; stage?: unknown; reason?: unknown }>()
      .catch(() => ({}) as { sessionId?: unknown; stage?: unknown; reason?: unknown });
    if (typeof body.sessionId !== "string" || !body.sessionId.trim()) return c.json({ error: "sessionId is required" }, 400);
    if (typeof body.stage !== "string" || !body.stage.trim()) return c.json({ error: "stage is required" }, 400);
    const run = pipelineRunForSession(db, body.sessionId.trim());
    // Another owner's run reads as none.
    if (!run || run.owner !== personaOwner) return c.json({ error: "That session's launch has no delivery pipeline run" }, 404);
    const reason = typeof body.reason === "string" ? body.reason : "";
    return advanceResponse(c, await acceptWontfixReview(db, run.id, { stage: body.stage.trim(), reason, actor: `${personaOwner}'s Persona` }, deps));
  });

  // The owner's Persona decides on a stage of one of its owner's runs: skip,
  // waive, close out or escalate (decidePipelineStage, which holds each to
  // the project's current pipeline and what the change touches).
  app.post("/api/pipeline/decide", async (c) => {
    const personaOwner = opts.personaOwnerOf?.(c);
    if (!personaOwner) return c.json({ error: "Only Persona decides through this route; the owner waives in the console" }, 403);
    const body = await c.req
      .json<{ sessionId?: unknown; stage?: unknown; kind?: unknown; reason?: unknown }>()
      .catch(() => ({}) as { sessionId?: unknown; stage?: unknown; kind?: unknown; reason?: unknown });
    if (typeof body.sessionId !== "string" || !body.sessionId.trim()) return c.json({ error: "sessionId is required" }, 400);
    if (typeof body.stage !== "string" || !body.stage.trim()) return c.json({ error: "stage is required" }, 400);
    if (typeof body.kind !== "string" || !(PERSONA_DECISION_KINDS as readonly string[]).includes(body.kind)) {
      return c.json({ error: `kind must be one of ${PERSONA_DECISION_KINDS.join(", ")}` }, 400);
    }
    const run = pipelineRunForSession(db, body.sessionId.trim());
    // Another owner's run reads as none.
    if (!run || run.owner !== personaOwner) return c.json({ error: "That session's launch has no delivery pipeline run" }, 404);
    const result = await decidePipelineStage(
      db,
      run.id,
      {
        stage: body.stage.trim(),
        kind: body.kind as PersonaDecisionKind,
        reason: typeof body.reason === "string" ? body.reason : "",
        actor: `${personaOwner}'s Persona`,
      },
      deps
    );
    if (!result.ok) return c.json({ error: result.error, ...(result.missing ? { missing: result.missing } : {}) }, result.status);
    const { run: updated, kind, from, to, closedOut, skipped, message, decision } = result;
    return c.json({ run: updated, kind, from, to, ...(closedOut ? { closedOut } : {}), skipped, message, decision });
  });

  // The owner's Persona sets one of its owner's pipeline layers — the user's,
  // a project's, a job's, or a launch still at coding (setPipelineLayerByPersona).
  // A change that weakens the pipeline is refused (409 with `weakens`) unless
  // the body says the owner approved it (`ownerApproved: true`, with the
  // weakenings the card showed as `approvedWeakens`), which Persona's tool
  // layer sets only when it carries out a card the owner approved — and which
  // is honored only on its own in-process call (personaRuntimeCallOf), never
  // one through its turn's MCP proxy. A weakening that wasn't on the card is
  // refused 409 all the same.
  app.post("/api/pipeline/config", async (c) => {
    const personaOwner = opts.personaOwnerOf?.(c);
    if (!personaOwner) return c.json({ error: "Only Persona changes a pipeline through this route; the owner uses the console" }, 403);
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "malformed request body" }, 400);
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const ownerApproved = body.ownerApproved === true && opts.personaRuntimeCallOf?.(c) === personaOwner;
    const approvedWeakens = Array.isArray(body.approvedWeakens)
      ? body.approvedWeakens.filter((w): w is string => typeof w === "string")
      : [];
    const result = setPipelineLayerByPersona(
      db,
      personaOwner,
      {
        scope: body.scope as PipelineLayerScope,
        projectId: str(body.projectId),
        jobId: str(body.jobId),
        sessionId: str(body.sessionId),
        spec: body.spec,
        override: body.override,
        reason: typeof body.reason === "string" ? body.reason : "",
        actor: `${personaOwner}'s Persona`,
        ownerApproved,
        ...(ownerApproved ? { approvedWeakens } : {}),
      },
      deps
    );
    if (!result.ok) {
      const { error, unknown, errors, weakens, projects } = result;
      return c.json(
        {
          error,
          ...(unknown ? { unknown } : {}),
          ...(errors ? { errors } : {}),
          ...(weakens ? { weakens } : {}),
          ...(projects ? { projects } : {}),
        },
        result.status
      );
    }
    const { ok: _ok, ...rest } = result;
    return c.json({ ok: true, ...rest });
  });

  // The console's audit of what the owner's Persona decided about their
  // pipelines — of one job or one run when named, or the changes to one of
  // the owner's own layers: `?scope=user` their default, `?projectId=` one
  // project's.
  app.get("/api/pipeline/decisions", (c) => {
    const refused = opts.humanRefusal(c, "read pipeline decisions");
    if (refused) return refused;
    const owner = opts.identityOf(c);
    const jobId = c.req.query("jobId")?.trim() || undefined;
    const runId = c.req.query("runId")?.trim() || undefined;
    const projectId = c.req.query("projectId")?.trim() || undefined;
    const scope = c.req.query("scope")?.trim() || undefined;
    if (scope !== undefined && scope !== "user") return c.json({ error: 'scope must be "user"; name a project with projectId' }, 400);
    if (scope && projectId) return c.json({ error: "give scope=user or a projectId, not both" }, 400);
    const layer = scope ? { scope: "user" as const } : projectId ? { scope: "project" as const, projectId } : undefined;
    return c.json({ decisions: listPipelineDecisions(db, owner, { jobId, runId, layer }) });
  });

  // ── Configuration: each human's own layers ───────────────────────────────

  /** The project a config request names (`?project=`), null for the global layer, or a 404 Response. */
  const projectParam = (c: Context): { projectId: string | null } | Response => {
    const projectId = c.req.query("project")?.trim() || null;
    if (projectId && !getProject(db, projectId)) return c.json({ error: `Unknown project: ${projectId}` }, 404);
    return { projectId };
  };

  /**
   * The owner's layers for `projectId` and what they resolve to: `seed` is
   * the project's built-in layer beneath the owner's project layer
   * (projectSeedLayer), `preset`
   * names the project's own preset (`auto`) and the one its layers resolve to
   * (`effective`), `stages` the resolved stages a person reads, and `version`
   * the requested layer's (the project's, else the global one) — sent back
   * as `ifVersion` so a save over a layer someone else changed meanwhile is
   * refused.
   */
  const configView = (owner: string, projectId: string | null) => {
    const resolved = resolvePipelineFor(db, owner, projectId);
    return {
      global: getPipelineConfig(db, owner, null),
      project: projectId ? getPipelineConfig(db, owner, projectId) : null,
      seed: projectSeedLayer(db, projectId),
      version: getPipelineConfigVersion(db, owner, projectId),
      resolved,
      preset: { auto: resolved.autoPreset, effective: resolved.preset },
      stages: pipelineStageSummary(resolved.definition),
      defaults: DEFAULT_PIPELINE,
      catalog: PIPELINE_CATALOG,
    };
  };

  app.get("/api/pipeline-config", (c) => {
    const refused = opts.humanRefusal(c, "read your pipeline configuration");
    if (refused) return refused;
    const param = projectParam(c);
    if (param instanceof Response) return param;
    return c.json(configView(opts.identityOf(c), param.projectId));
  });

  // The layer is a plain-words `spec`, a structured `override`, or both
  // (pipelineLayerFromInput); a spec clause the phrase table doesn't know is
  // refused with the clauses it couldn't map (`unknown`), and a spec naming
  // another project ("for <project>:") is refused (specProjectRefusal). The
  // owner's own layer must leave each of their project layers merging over
  // it (400 naming the `projects`). With `ifVersion` (the GET's `version`,
  // null for a layer that wasn't set), a save over a layer changed since —
  // by Persona or another tab — is refused 409 with the layer as it is now.
  app.put("/api/pipeline-config", async (c) => {
    const refused = opts.humanRefusal(c, "change your pipeline configuration");
    if (refused) return refused;
    const param = projectParam(c);
    if (param instanceof Response) return param;
    const owner = opts.identityOf(c);
    const body = await c.req.json<{ override?: unknown; spec?: unknown; ifVersion?: unknown }>().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ error: "body must be {spec?, override?: {preset?, enabled?, maxRounds?, stages?, add?, reviewTunnel?}, ifVersion?}" }, 400);
    }
    if (body.ifVersion !== undefined && body.ifVersion !== null && typeof body.ifVersion !== "string") {
      return c.json({ error: "ifVersion must be the version the layer was read at, or null" }, 400);
    }
    const layer = pipelineLayerFromInput({ spec: body.spec, override: body.override });
    if (!layer.ok) return c.json({ error: layer.error, ...(layer.unknown ? { unknown: layer.unknown } : {}) }, 400);
    const wrongProject = specProjectRefusal(layer.compiled, param.projectId ? getProject(db, param.projectId) : null);
    if (wrongProject) return c.json({ error: wrongProject }, 400);
    // The layer must merge cleanly with the layers beneath it (the owner's global one and the project's seed).
    const layers: Array<PipelineOverride | null> = param.projectId
      ? [getPipelineConfig(db, owner, null), projectSeedLayer(db, param.projectId), layer.override]
      : [layer.override];
    const checked = checkPipelineLayers(db, param.projectId, layers);
    if (!checked.ok) return c.json({ error: checked.error, errors: checked.errors }, 400);
    if (!param.projectId) {
      const broken = projectsBrokenByGlobal(db, owner, layer.override);
      if (broken.length > 0) {
        return c.json(
          { error: `This default would break your pipeline for ${broken.join(", ")}: their overrides no longer merge over it`, projects: broken },
          400
        );
      }
    }
    if (body.ifVersion !== undefined && (body.ifVersion ?? null) !== getPipelineConfigVersion(db, owner, param.projectId)) {
      return c.json(
        { error: "This pipeline changed since you loaded it (Persona or another tab) — reload to see it", current: configView(owner, param.projectId) },
        409
      );
    }
    setPipelineConfig(db, owner, param.projectId, layer.override);
    publishPipelineConfig(deps, { owner, projectId: param.projectId, scope: param.projectId ? "project" : "user" });
    return c.json({
      ok: true,
      ...configView(owner, param.projectId),
      override: layer.override,
      ...(layer.compiled ? { compiled: layer.compiled } : {}),
    });
  });

  // With `ifVersion` in the body (as PUT takes it), a reset of a layer
  // changed since it was read is refused 409 with the layer as it is now.
  app.delete("/api/pipeline-config", async (c) => {
    const refused = opts.humanRefusal(c, "change your pipeline configuration");
    if (refused) return refused;
    const param = projectParam(c);
    if (param instanceof Response) return param;
    const owner = opts.identityOf(c);
    const body = await c.req.json<{ ifVersion?: unknown }>().catch(() => ({}) as { ifVersion?: unknown });
    const ifVersion = body && typeof body === "object" && "ifVersion" in body ? body.ifVersion : undefined;
    if (ifVersion !== undefined && ifVersion !== null && typeof ifVersion !== "string") {
      return c.json({ error: "ifVersion must be the version the layer was read at, or null" }, 400);
    }
    if (ifVersion !== undefined && (ifVersion ?? null) !== getPipelineConfigVersion(db, owner, param.projectId)) {
      return c.json(
        { error: "This pipeline changed since you loaded it (Persona or another tab) — reload to see it", current: configView(owner, param.projectId) },
        409
      );
    }
    if (deletePipelineConfig(db, owner, param.projectId)) {
      publishPipelineConfig(deps, { owner, projectId: param.projectId, scope: param.projectId ? "project" : "user" });
    }
    return c.json(configView(owner, param.projectId));
  });
}
