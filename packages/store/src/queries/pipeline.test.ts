import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { DEFAULT_PIPELINE, type PipelineDefinition } from "@standup/shared";
import { createStore } from "../store.js";
import { ensurePersonaJobStateShape, ensurePipelineShape } from "../migrations.js";
import {
  createPersonaJob,
  createPipelineRun,
  deletePipelineConfig,
  getOrCreatePersonaConsoleThread,
  getPersonaJob,
  getPipelineConfig,
  getPipelineRun,
  getPipelineRunByLaunch,
  listPipelineConfigs,
  listPipelineDecisions,
  listPipelineRunsByLaunches,
  recordPipelineAttempt,
  recordPipelineDecision,
  setPersonaJobPipeline,
  setPipelineConfig,
  setPipelineRunFlaggedJob,
  setPipelineRunReviewHandoff,
  takePipelineRunReviewHandoff,
  updatePipelineRun,
  updatePipelineRunIf,
} from "../index.js";

function tables(db: Database): string[] {
  return (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
    (r) => r.name
  );
}

describe("migration 067", () => {
  test("ensurePipelineShape is idempotent", () => {
    const db = new Database(":memory:");
    ensurePipelineShape(db);
    db.run(
      `INSERT INTO pipeline_configs (owner, project_id, override_json, updated_at) VALUES ('me', '', '{}', 'now')`
    );
    ensurePipelineShape(db);
    expect(tables(db)).toEqual(expect.arrayContaining(["pipeline_configs", "pipeline_runs", "pipeline_stage_attempts"]));
    expect(db.query("SELECT COUNT(*) AS n FROM pipeline_configs").get()).toEqual({ n: 1 });
    db.close();
  });

  test("a fresh store has the pipeline tables and records version 67", () => {
    const store = createStore(":memory:");
    expect(tables(store.db)).toEqual(expect.arrayContaining(["pipeline_configs", "pipeline_runs", "pipeline_stage_attempts"]));
    expect(store.db.query("SELECT version FROM schema_version WHERE version = 67").get()).toEqual({ version: 67 });
    store.close();
  });
});

describe("pipeline configs", () => {
  test("global and project layers are separate and per owner", () => {
    const store = createStore(":memory:");
    const db = store.db;
    expect(getPipelineConfig(db, "me")).toBeNull();

    setPipelineConfig(db, "me", null, { enabled: false });
    setPipelineConfig(db, "me", "proj", { stages: { review: { minReviewers: 3 } } });
    setPipelineConfig(db, "you", null, { stages: { screenshot: { skip: true } } });

    expect(getPipelineConfig(db, "me")).toEqual({ enabled: false });
    expect(getPipelineConfig(db, "me", null)).toEqual({ enabled: false });
    expect(getPipelineConfig(db, "me", "proj")).toEqual({ stages: { review: { minReviewers: 3 } } });
    expect(getPipelineConfig(db, "you", "proj")).toBeNull();
    expect(getPipelineConfig(db, "you")).toEqual({ stages: { screenshot: { skip: true } } });

    const mine = listPipelineConfigs(db, "me");
    expect(mine.map((c) => c.projectId)).toEqual([null, "proj"]);
    expect(typeof mine[0]!.updatedAt).toBe("string");

    setPipelineConfig(db, "me", null, { enabled: true });
    expect(getPipelineConfig(db, "me")).toEqual({ enabled: true });

    expect(deletePipelineConfig(db, "me", "proj")).toBe(true);
    expect(deletePipelineConfig(db, "me", "proj")).toBe(false);
    expect(getPipelineConfig(db, "me", "proj")).toBeNull();
    expect(listPipelineConfigs(db, "you")).toHaveLength(1);
    store.close();
  });
});

describe("pipeline runs", () => {
  const def = DEFAULT_PIPELINE;

  test("create, read by id and launch, list by launches", () => {
    const store = createStore(":memory:");
    const db = store.db;
    const run = createPipelineRun(db, { launchId: "L1", owner: "me", projectId: "p", definition: def, definitionHash: "h1" });
    expect(run).toMatchObject({
      launchId: "L1",
      owner: "me",
      projectId: "p",
      definitionHash: "h1",
      currentStage: "start",
      status: "active",
      facts: {},
      stopBlocks: 0,
      attempts: [],
    });
    expect(run.definition).toEqual(def);
    expect(run.waitingReason).toBeUndefined();

    const disabled = createPipelineRun(db, {
      launchId: "L2",
      owner: "me",
      definition: def,
      definitionHash: "h1",
      status: "disabled",
      currentStage: "coding",
      facts: { ui_changed: true },
    });
    expect(disabled).toMatchObject({ status: "disabled", currentStage: "coding", facts: { ui_changed: true } });
    expect(disabled.projectId).toBeUndefined();

    expect(getPipelineRun(db, run.id)!.id).toBe(run.id);
    expect(getPipelineRunByLaunch(db, "L2")!.id).toBe(disabled.id);
    expect(getPipelineRun(db, "nope")).toBeNull();
    expect(getPipelineRunByLaunch(db, "nope")).toBeNull();
    expect(listPipelineRunsByLaunches(db, ["L1", "L2", "L3"]).map((r) => r.launchId).sort()).toEqual(["L1", "L2"]);
    expect(listPipelineRunsByLaunches(db, [])).toEqual([]);

    expect(() => createPipelineRun(db, { launchId: "L1", owner: "me", definition: def, definitionHash: "h" })).toThrow();
    store.close();
  });

  test("updatePipelineRun applies only given fields and clears the waiting reason with null", () => {
    const store = createStore(":memory:");
    const db = store.db;
    const run = createPipelineRun(db, { launchId: "L1", owner: "me", definition: def, definitionHash: "h" });
    const waiting = updatePipelineRun(db, run.id, { status: "waiting_user", waitingReason: "needs you", stopBlocks: 3 })!;
    expect(waiting).toMatchObject({ status: "waiting_user", waitingReason: "needs you", stopBlocks: 3, currentStage: "start" });

    const moved = updatePipelineRun(db, run.id, {
      currentStage: "review",
      status: "active",
      waitingReason: null,
      facts: { ui_changed: false, docs_only: true },
      stageEnteredAt: "2026-10-08T00:00:00.000Z",
    })!;
    expect(moved).toMatchObject({
      currentStage: "review",
      status: "active",
      facts: { ui_changed: false, docs_only: true },
      stopBlocks: 3,
      stageEnteredAt: "2026-10-08T00:00:00.000Z",
    });
    expect(moved.waitingReason).toBeUndefined();
    expect(updatePipelineRun(db, "nope", { status: "complete" })).toBeNull();
    expect(() => updatePipelineRun(db, run.id, { status: "bogus" as never })).toThrow();
    store.close();
  });

  test("updatePipelineRunIf writes only while the run is as read, and every write gets a fresh stamp", () => {
    const store = createStore(":memory:");
    const db = store.db;
    const run = createPipelineRun(db, { launchId: "L1", owner: "me", definition: def, definitionHash: "h" });
    const read = { currentStage: run.currentStage, updatedAt: run.updatedAt };
    const first = updatePipelineRunIf(db, run.id, read, {
      currentStage: "coding",
      waitingKind: "owner_input",
      flaggedJob: { id: "job-1", note: "Pipeline needs you: x" },
    })!;
    expect(first).toMatchObject({ currentStage: "coding", waitingKind: "owner_input", flaggedJob: { id: "job-1", note: "Pipeline needs you: x" } });
    expect(first.updatedAt > run.updatedAt).toBe(true);
    // The same stale read loses, and writes nothing.
    expect(updatePipelineRunIf(db, run.id, read, { currentStage: "review" })).toBeNull();
    expect(getPipelineRun(db, run.id)!.currentStage).toBe("coding");
    // Back-to-back writes inside one millisecond still get distinct stamps.
    const a = updatePipelineRun(db, run.id, { stopBlocks: 1 })!;
    const b = updatePipelineRun(db, run.id, { stopBlocks: 2 })!;
    expect(b.updatedAt > a.updatedAt).toBe(true);
    expect(updatePipelineRunIf(db, run.id, { currentStage: "coding", updatedAt: a.updatedAt }, { stopBlocks: 0 })).toBeNull();
    const cleared = updatePipelineRunIf(db, run.id, { currentStage: "coding", updatedAt: b.updatedAt }, { waitingKind: null, flaggedJob: null })!;
    expect(cleared.waitingKind).toBeUndefined();
    expect(cleared.flaggedJob).toBeUndefined();
    store.close();
  });

  test("ensurePipelineShape adds the waiting/flag columns to an older pipeline_runs", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE pipeline_runs (id TEXT PRIMARY KEY, launch_id TEXT NOT NULL UNIQUE, owner TEXT NOT NULL, project_id TEXT,
      definition_json TEXT NOT NULL, definition_hash TEXT NOT NULL, current_stage TEXT NOT NULL, status TEXT NOT NULL,
      waiting_reason TEXT, facts_json TEXT NOT NULL DEFAULT '{}', stop_blocks INTEGER NOT NULL DEFAULT 0,
      stage_entered_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    ensurePipelineShape(db);
    ensurePipelineShape(db);
    const columns = (db.query("PRAGMA table_info(pipeline_runs)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(["waiting_kind", "flagged_job_id", "flagged_job_note"]));
    db.close();
  });

  test("ensurePipelineShape adds the epoch columns to older tables", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE pipeline_runs (id TEXT PRIMARY KEY, launch_id TEXT NOT NULL UNIQUE, owner TEXT NOT NULL, project_id TEXT,
      definition_json TEXT NOT NULL, definition_hash TEXT NOT NULL, current_stage TEXT NOT NULL, status TEXT NOT NULL,
      waiting_reason TEXT, facts_json TEXT NOT NULL DEFAULT '{}', stop_blocks INTEGER NOT NULL DEFAULT 0,
      stage_entered_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE pipeline_stage_attempts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, stage_id TEXT NOT NULL, attempt INTEGER NOT NULL,
      status TEXT NOT NULL, evidence_json TEXT, reason TEXT, session_id TEXT, next_stage TEXT, created_at TEXT NOT NULL)`);
    ensurePipelineShape(db);
    ensurePipelineShape(db);
    const cols = (t: string) => (db.query(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols("pipeline_runs")).toContain("epoch");
    expect(cols("pipeline_stage_attempts")).toContain("epoch");
    db.close();
  });

  test("attempts are recorded in the run's current epoch unless one is given", () => {
    const store = createStore(":memory:");
    const db = store.db;
    const run = createPipelineRun(db, { launchId: "L1", owner: "me", definition: def, definitionHash: "h" });
    expect(run.epoch).toBe(0);
    const first = recordPipelineAttempt(db, run.id, { stageId: "validation", status: "failed", nextStage: "coding" });
    expect(first.epoch).toBe(0);
    expect(updatePipelineRun(db, run.id, { epoch: 1 })!.epoch).toBe(1);
    expect(recordPipelineAttempt(db, run.id, { stageId: "validation", status: "failed" })).toMatchObject({ epoch: 1, attempt: 2 });
    expect(recordPipelineAttempt(db, run.id, { stageId: "code_review", status: "failed", epoch: 0 }).epoch).toBe(0);
    store.close();
  });

  test("setting the flagged job leaves updated_at alone", () => {
    const store = createStore(":memory:");
    const db = store.db;
    const run = createPipelineRun(db, { launchId: "L1", owner: "me", definition: def, definitionHash: "h" });
    setPipelineRunFlaggedJob(db, run.id, { id: "job-1", note: "n" });
    const read = getPipelineRun(db, run.id)!;
    expect(read.flaggedJob).toEqual({ id: "job-1", note: "n" });
    expect(read.updatedAt).toBe(run.updatedAt);
    setPipelineRunFlaggedJob(db, run.id, null);
    expect(getPipelineRun(db, run.id)!.flaggedJob).toBeUndefined();
    store.close();
  });

  test("a disabled run records why it is off; an open one carries no reason", () => {
    const store = createStore(":memory:");
    const db = store.db;
    const off = createPipelineRun(db, { launchId: "L1", owner: "me", definition: def, definitionHash: "h", status: "disabled" });
    expect(off.disabledReason).toBe("other");
    const attempt = createPipelineRun(db, { launchId: "L2", owner: "me", definition: def, definitionHash: "h", status: "disabled", disabledReason: "attempt" });
    expect(attempt.disabledReason).toBe("attempt");
    const on = updatePipelineRun(db, attempt.id, { status: "active", disabledReason: null })!;
    expect(on.disabledReason).toBeUndefined();
    expect(createPipelineRun(db, { launchId: "L3", owner: "me", definition: def, definitionHash: "h", disabledReason: "no_mcp" }).disabledReason).toBeUndefined();
    store.close();
  });

  test("a review hand-off is taken once and leaves updated_at alone", () => {
    const store = createStore(":memory:");
    const db = store.db;
    const run = createPipelineRun(db, { launchId: "L1", owner: "me", definition: def, definitionHash: "h" });
    expect(takePipelineRunReviewHandoff(db, run.id)).toBe(false);
    setPipelineRunReviewHandoff(db, run.id, "2026-10-08T00:00:00.000Z");
    const read = getPipelineRun(db, run.id)!;
    expect(read.reviewHandoffAt).toBe("2026-10-08T00:00:00.000Z");
    expect(read.updatedAt).toBe(run.updatedAt);
    expect(takePipelineRunReviewHandoff(db, run.id)).toBe(true);
    expect(takePipelineRunReviewHandoff(db, run.id)).toBe(false);
    expect(getPipelineRun(db, run.id)!.reviewHandoffAt).toBeUndefined();
    store.close();
  });

  test("an attempt may be recorded under a caller-chosen id", () => {
    const store = createStore(":memory:");
    const run = createPipelineRun(store.db, { launchId: "L1", owner: "me", definition: def, definitionHash: "h" });
    const attempt = recordPipelineAttempt(store.db, run.id, { id: "fixed-id", stageId: "start", status: "passed" });
    expect(attempt.id).toBe("fixed-id");
    store.close();
  });

  test("attempts are numbered per stage and round-trip their evidence", () => {
    const store = createStore(":memory:");
    const db = store.db;
    const run = createPipelineRun(db, { launchId: "L1", owner: "me", definition: def, definitionHash: "h" });
    const evidence = { commands: [{ command: "bun test", exitCode: 1, summary: "2 failed" }], nested: { a: [1, null, "x"] } };
    const v1 = recordPipelineAttempt(db, run.id, {
      stageId: "validation",
      status: "failed",
      evidence,
      reason: "`bun test` exited 1",
      sessionId: "s1",
      nextStage: "coding",
    });
    const c1 = recordPipelineAttempt(db, run.id, { stageId: "coding", status: "passed", nextStage: "validation" });
    const v2 = recordPipelineAttempt(db, run.id, { stageId: "validation", status: "passed", nextStage: "review" });
    expect([v1.attempt, c1.attempt, v2.attempt]).toEqual([1, 1, 2]);
    expect(v1).toMatchObject({ runId: run.id, stageId: "validation", status: "failed", evidence, sessionId: "s1", nextStage: "coding" });
    expect(c1.evidence).toBeUndefined();
    expect(c1.reason).toBeUndefined();

    const read = getPipelineRun(db, run.id)!;
    expect(read.attempts.map((a) => a.id)).toEqual([v1.id, c1.id, v2.id]);
    expect(read.attempts[0]!.evidence).toEqual(evidence);

    // Attempts at another run are numbered independently.
    const other = createPipelineRun(db, { launchId: "L2", owner: "me", definition: def, definitionHash: "h" });
    expect(recordPipelineAttempt(db, other.id, { stageId: "validation", status: "waived" }).attempt).toBe(1);
    expect(() => recordPipelineAttempt(db, run.id, { stageId: "x", status: "bogus" as never })).toThrow();
    store.close();
  });

  test("a run's definition stays frozen after the config changes", () => {
    const store = createStore(":memory:");
    const db = store.db;
    setPipelineConfig(db, "me", null, { stages: { review: { minReviewers: 2 } } });
    const frozen = JSON.parse(JSON.stringify(def)) as PipelineDefinition;
    const run = createPipelineRun(db, { launchId: "L1", owner: "me", definition: frozen, definitionHash: "h" });
    setPipelineConfig(db, "me", null, { stages: { review: { minReviewers: 5 }, deploy: { skip: true } } });
    frozen.stages[0]!.title = "mutated after create";
    const read = getPipelineRun(db, run.id)!;
    expect(read.definition).toEqual(def);
    expect(read.definitionHash).toBe("h");
    store.close();
  });
});

describe("presets, layers and Persona's decisions", () => {
  const def = DEFAULT_PIPELINE;
  const columns = (db: Database, table: string) =>
    (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

  test("the run, job and decision columns are added once, and re-running the shape checks changes nothing", () => {
    const store = createStore(":memory:");
    const db = store.db;
    expect(columns(db, "pipeline_runs")).toEqual(expect.arrayContaining(["launch_override_json", "preset"]));
    expect(columns(db, "persona_jobs")).toContain("pipeline_override_json");
    expect(tables(db)).toContain("pipeline_decisions");
    recordPipelineDecision(db, { owner: "me", kind: "config", reason: "a reason", actor: "me's Persona" });
    ensurePipelineShape(db);
    ensurePipelineShape(db);
    ensurePersonaJobStateShape(db);
    expect(listPipelineDecisions(db, "me")).toHaveLength(1);
    expect(columns(db, "pipeline_runs").filter((c) => c === "preset")).toHaveLength(1);
    expect(
      (db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_pipeline_decisions_owner_job'").all() as unknown[]).length
    ).toBe(1);
    store.close();
  });

  test("a run keeps its preset and launch layer, and a definition patch replaces both with the hash", () => {
    const store = createStore(":memory:");
    const db = store.db;
    const layer = { spec: "no deploy", stages: { deploy: { skip: true } } };
    const run = createPipelineRun(db, { launchId: "L1", owner: "me", definition: def, definitionHash: "h1", preset: "full", launchOverride: layer });
    expect(run).toMatchObject({ preset: "full", launchOverride: layer });
    const bare = createPipelineRun(db, { launchId: "L2", owner: "me", definition: def, definitionHash: "h1" });
    expect(bare.preset).toBeUndefined();
    expect(bare.launchOverride).toBeUndefined();
    const lighter: PipelineDefinition = { version: 1, stages: def.stages.filter((s) => s.id !== "deploy") };
    const moved = updatePipelineRunIf(db, run.id, run, { definition: { definition: lighter, hash: "h2", preset: "light" }, launchOverride: null });
    expect(moved).toMatchObject({ preset: "light", definitionHash: "h2" });
    expect(moved!.definition).toEqual(lighter);
    expect(moved!.launchOverride).toBeUndefined();
    store.close();
  });

  test("a job's pipeline layer is set, read on the job and cleared", () => {
    const store = createStore(":memory:");
    const db = store.db;
    const thread = getOrCreatePersonaConsoleThread(db, "me");
    const job = createPersonaJob(db, { owner: "me", threadId: thread.id, title: "J", goal: "g" });
    expect(job.pipelineOverride).toBeUndefined();
    const before = getPersonaJob(db, job.id)!.updatedAt;
    expect(setPersonaJobPipeline(db, job.id, { preset: "light" })!.pipelineOverride).toEqual({ preset: "light" });
    expect(getPersonaJob(db, job.id)!.updatedAt).toBe(before);
    expect(setPersonaJobPipeline(db, job.id, null)!.pipelineOverride).toBeUndefined();
    store.close();
  });

  test("decisions are listed per owner, and by job or run", () => {
    const store = createStore(":memory:");
    const db = store.db;
    const one = recordPipelineDecision(db, {
      owner: "me",
      runId: "R1",
      jobId: "J1",
      projectId: "p",
      stage: "code_review",
      kind: "close_out",
      reason: "no code review to cut",
      actor: "me's Persona",
      detail: { closedOut: ["code_review"] },
    });
    expect(one).toMatchObject({ owner: "me", runId: "R1", jobId: "J1", projectId: "p", stage: "code_review", kind: "close_out", detail: { closedOut: ["code_review"] } });
    recordPipelineDecision(db, { owner: "me", runId: "R2", jobId: "J2", kind: "skip", reason: "no UI", actor: "me's Persona" });
    recordPipelineDecision(db, { owner: "you", runId: "R1", kind: "waive", reason: "theirs", actor: "you's Persona" });
    expect(listPipelineDecisions(db, "me").map((d) => d.runId)).toEqual(["R1", "R2"]);
    expect(listPipelineDecisions(db, "me", { jobId: "J2" }).map((d) => d.kind)).toEqual(["skip"]);
    expect(listPipelineDecisions(db, "me", { runId: "R1" }).map((d) => d.kind)).toEqual(["close_out"]);
    expect(listPipelineDecisions(db, "you", { runId: "R1" }).map((d) => d.kind)).toEqual(["waive"]);
    store.close();
  });
});
