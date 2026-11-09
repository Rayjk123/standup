import { expect, test, describe, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DEFAULT_PIPELINE } from "@standup/shared";
import {
  UnrecognizedStoredValuesError,
  assertRecognizedStoredValues,
  knownStoredValues,
  runMigrations,
  unrecognizedStoredValues,
} from "./migrations.js";

const NOW = "2026-01-01T00:00:00.000Z";

/** A migrated in-memory database with one project. */
function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  runMigrations(db);
  db.run("INSERT INTO projects (id, name) VALUES ('proj', 'Proj')");
  return db;
}

function insertRun(db: Database, opts: { id?: string; definition?: unknown; currentStage?: string; launchOverride?: unknown } = {}): string {
  const id = opts.id ?? "run-1";
  db.run(
    `INSERT INTO pipeline_runs (id, launch_id, owner, project_id, definition_json, definition_hash, current_stage, status,
       stage_entered_at, created_at, updated_at, launch_override_json)
     VALUES (?, ?, 'owner', 'proj', ?, 'hash', ?, 'active', ?, ?, ?, ?)`,
    [
      id,
      `launch-${id}`,
      typeof opts.definition === "string" ? opts.definition : JSON.stringify(opts.definition ?? DEFAULT_PIPELINE),
      opts.currentStage ?? "coding",
      NOW,
      NOW,
      NOW,
      opts.launchOverride === undefined ? null : JSON.stringify(opts.launchOverride),
    ]
  );
  return id;
}

function insertAttempt(db: Database, runId: string, stageId: string): void {
  db.run(
    `INSERT INTO pipeline_stage_attempts (id, run_id, stage_id, attempt, status, created_at)
     VALUES (?, ?, ?, 1, 'passed', ?)`,
    [`${runId}-${stageId}`, runId, stageId, NOW]
  );
}

function insertConfig(db: Database, override: unknown, projectId = "proj"): void {
  db.run("INSERT INTO pipeline_configs (owner, project_id, override_json, updated_at) VALUES ('owner', ?, ?, ?)", [
    projectId,
    typeof override === "string" ? override : JSON.stringify(override),
    NOW,
  ]);
}

function insertJob(db: Database, override: unknown): void {
  db.run(
    `INSERT INTO persona_jobs (id, owner, thread_id, title, goal, created_at, updated_at, pipeline_override_json)
     VALUES ('job-1', 'owner', 'thread-1', 'Job', 'Goal', ?, ?, ?)`,
    [NOW, NOW, JSON.stringify(override)]
  );
}

function insertTicket(db: Database, lens: string, taskUrl: string | null): void {
  db.run("INSERT INTO tickets (id, project_id, lens, title, task_url) VALUES (?, 'proj', ?, 'T', ?)", [
    `t-${lens}-${taskUrl ?? "none"}`,
    lens,
    taskUrl,
  ]);
}

function insertBoardCard(db: Database, links: unknown): void {
  db.run(
    `INSERT INTO board_tasks (id, source, source_id, title, status, links_json, created_at, updated_at)
     VALUES ('backlog:b1', 'backlog', 'b1', 'Card', 'queued', ?, ?, ?)`,
    [typeof links === "string" ? links : JSON.stringify(links), NOW, NOW]
  );
}

function insertPacket(db: Database, links: unknown): void {
  db.run("INSERT INTO review_packets (id, owner, links_json, created_at, updated_at) VALUES ('p1', 'owner', ?, ?, ?)", [
    typeof links === "string" ? links : JSON.stringify(links),
    NOW,
    NOW,
  ]);
}

/** The definition with the stage `id` given another kind. */
function definitionWithKind(id: string, kind: string): unknown {
  return { ...DEFAULT_PIPELINE, stages: DEFAULT_PIPELINE.stages.map((s) => (s.id === id ? { ...s, kind } : s)) };
}

/** The definition with one more stage, `id` of kind review, at the end. */
function definitionWithStage(id: string): unknown {
  return { ...DEFAULT_PIPELINE, stages: [...DEFAULT_PIPELINE.stages, { id, kind: "review" }] };
}

/** Runs `fn` with console.warn captured; returns what it was given. */
function capturingConsoleWarn(fn: () => void): string[] {
  const seen: string[] = [];
  const spy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    seen.push(args.map(String).join(" "));
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return seen;
}

interface Case {
  name: string;
  seed: (db: Database) => void;
  where: string;
  value: string;
}

/** Values no code path of this build writes: the database is refused. */
const REFUSED: Case[] = [
  {
    name: "a tracker-ingested ticket under another lens",
    seed: (db) => insertTicket(db, "retired-lens", "https://tracker.example.com/T-1"),
    where: "tickets.lens (tickets with a task_url)",
    value: "retired-lens",
  },
  {
    name: "a board link key BoardTaskLinks lacks",
    seed: (db) => insertBoardCard(db, { jobId: "j1", retiredLink: { url: "https://example.com/r/1" } }),
    where: "board_tasks.links_json keys",
    value: "retiredLink",
  },
  {
    name: "a review packet link kind",
    seed: (db) => insertPacket(db, [{ kind: "retired_link", label: "R-1", url: "https://example.com/r/1" }]),
    where: "review_packets.links_json $[*].kind",
    value: "retired_link",
  },
  {
    name: "a run definition's stage kind no code registers",
    seed: (db) => insertRun(db, { definition: definitionWithKind("screenshot", "retired_gate") }),
    where: "pipeline_runs.definition_json $.stages[*].kind",
    value: "retired_gate",
  },
  {
    name: "a run's current stage its definition lacks",
    seed: (db) => insertRun(db, { currentStage: "retired_stage" }),
    where: "pipeline_runs.current_stage",
    value: "retired_stage",
  },
  {
    name: "an attempt at a stage its run's definition lacks",
    seed: (db) => insertAttempt(db, insertRun(db), "retired_stage"),
    where: "pipeline_stage_attempts.stage_id",
    value: "retired_stage",
  },
  {
    name: "an owner layer adding a stage of an unregistered kind",
    seed: (db) => insertConfig(db, { add: [{ after: "review", stage: { id: "extra", kind: "retired_gate" } }] }),
    where: "pipeline_configs.override_json $.add[*].stage.kind",
    value: "retired_gate",
  },
];

/** Values this build's own config or stale layers can leave: reported, and the database is kept. */
const WARNED: Case[] = [
  {
    name: "a code review adapter id no adapter has (a typo in projects.toml)",
    seed: (db) => db.run("UPDATE projects SET review_artifact_provider = 'github' WHERE id = 'proj'"),
    where: "projects.review_artifact_provider",
    value: "github",
  },
  {
    name: "a run definition that is not JSON",
    seed: (db) => insertRun(db, { id: "run-bad", definition: "[1, 2", currentStage: "start" }),
    where: "pipeline_runs.definition_json (run ids)",
    value: "run-bad",
  },
  {
    name: "an owner layer patching a stage no pipeline has",
    seed: (db) => insertConfig(db, { stages: { retired_stage: { required: false } } }),
    where: "pipeline_configs.override_json $.stages keys",
    value: "retired_stage",
  },
  {
    name: "an owner layer adding a stage after one no pipeline has",
    seed: (db) => insertConfig(db, { add: [{ after: "retired_stage", stage: { id: "extra", kind: "review" } }] }),
    where: "pipeline_configs.override_json $.add[*].after",
    value: "retired_stage",
  },
  {
    name: "a job layer patching a stage that a since-removed owner layer added",
    seed: (db) => insertJob(db, { stages: { extra_gate: { skip: true } } }),
    where: "persona_jobs.pipeline_override_json $.stages keys",
    value: "extra_gate",
  },
  {
    name: "a launch layer patching a stage neither the catalog, a layer nor its run's definition has",
    seed: (db) => insertRun(db, { launchOverride: { stages: { retired_stage: { skip: true } } } }),
    where: "pipeline_runs.launch_override_json $.stages keys",
    value: "retired_stage",
  },
  {
    name: "a launch layer adding after a stage its run's definition lacks",
    seed: (db) => insertRun(db, { launchOverride: { add: [{ after: "retired_stage", stage: { id: "x", kind: "review" } }] } }),
    where: "pipeline_runs.launch_override_json $.add[*].after",
    value: "retired_stage",
  },
];

describe("unrecognized stored values", () => {
  test("a fresh database holds none", () => {
    const db = freshDb();
    expect(unrecognizedStoredValues(db)).toEqual([]);
    expect(() => assertRecognizedStoredValues(db)).not.toThrow();
    db.close();
  });

  test("the known stage kinds are the registered ones, built-ins included", () => {
    const known = knownStoredValues();
    for (const kind of ["start", "coding", "review", "code_review", "human_review", "complete"]) {
      expect(known.stageKinds).toContain(kind);
    }
    expect(known.stageIds).toContain("live_check");
    expect(known.codeReviewAdapters).toEqual(["generic", "github-pr"]);
  });

  test("rows this code writes are recognized", () => {
    const db = freshDb();
    db.run("UPDATE projects SET review_artifact_provider = 'github-pr' WHERE id = 'proj'");
    db.run("INSERT INTO projects (id, name, review_artifact_provider) VALUES ('blank', 'Blank', '')");
    insertTicket(db, "tracker", "https://tracker.example.com/T-1");
    // A ticket from a review lens has no task_url, whatever its lens is named.
    insertTicket(db, "custom-lens", null);
    insertBoardCard(db, { jobId: "j1", launchIds: [], codeReview: { url: "https://example.com/r/1" }, runId: "run-1" });
    insertPacket(db, [
      { kind: "code_review", label: "R-1", url: "https://example.com/r/1" },
      { kind: "deploy", label: "Deploy", url: "https://example.com/d/1" },
    ]);
    const run = insertRun(db, { currentStage: "screenshot", launchOverride: { stages: { deploy: { skip: true } } } });
    insertAttempt(db, run, "coding");
    insertAttempt(db, run, "code_review");
    // A stage one layer adds may be patched by another.
    insertConfig(db, { add: [{ after: "review", stage: { id: "extra_gate", kind: "review" } }] }, "");
    insertJob(db, { stages: { extra_gate: { required: false }, live_check: { skip: true } } });
    // A launch layer may patch, or add after, a stage that only its own run's
    // definition has (one a since-removed layer added at launch).
    insertRun(db, {
      id: "run-2",
      definition: definitionWithStage("frozen_gate"),
      currentStage: "frozen_gate",
      launchOverride: {
        stages: { frozen_gate: { required: false } },
        add: [{ after: "frozen_gate", stage: { id: "late_gate", kind: "review" } }],
      },
    });

    expect(unrecognizedStoredValues(db)).toEqual([]);
    expect(capturingConsoleWarn(() => runMigrations(db))).toEqual([]);
    db.close();
  });

  test("a launch layer is not matched against another run's definition", () => {
    const db = freshDb();
    insertRun(db, { id: "run-a", definition: definitionWithStage("frozen_gate") });
    insertRun(db, { id: "run-b", launchOverride: { stages: { frozen_gate: { skip: true } } } });
    expect(unrecognizedStoredValues(db).map((f) => [f.where, f.values])).toEqual([
      ["pipeline_runs.launch_override_json $.stages keys", [{ value: "frozen_gate", count: 1 }]],
    ]);
    db.close();
  });

  test("malformed or mis-shaped JSON is read as empty, never raised on", () => {
    const db = freshDb();
    insertBoardCard(db, "not json");
    insertPacket(db, '{"kind": "deploy"}');
    insertRun(db, { id: "run-bad", definition: "[1, 2", currentStage: "start" });
    insertConfig(db, "{oops");
    insertJob(db, ["not", "an", "object"]);

    // The damaged definition is the one finding: it is reported, its run's
    // current stage is not checked against it, and the database is kept.
    expect(unrecognizedStoredValues(db)).toEqual([
      {
        where: "pipeline_runs.definition_json (run ids)",
        expected: "a JSON object with a $.stages array",
        values: [{ value: "run-bad", count: 1 }],
        severity: "warn",
        effect: expect.stringContaining("damaged"),
      },
    ]);
    expect(capturingConsoleWarn(() => runMigrations(db))).toHaveLength(1);
    db.close();
  });

  for (const c of REFUSED) {
    test(`finds ${c.name}, and runMigrations refuses the database`, () => {
      const db = freshDb();
      c.seed(db);

      const findings = unrecognizedStoredValues(db);
      expect(findings.map((f) => [f.where, f.severity])).toEqual([[c.where, "refuse"]]);
      expect(findings[0]!.values).toEqual([{ value: c.value, count: 1 }]);

      let thrown: unknown;
      const warned = capturingConsoleWarn(() => {
        try {
          runMigrations(db);
        } catch (err) {
          thrown = err;
        }
      });
      expect(warned).toEqual([]);
      expect(thrown).toBeInstanceOf(UnrecognizedStoredValuesError);
      const error = thrown as UnrecognizedStoredValuesError;
      expect(error.findings).toEqual(findings);
      expect(error.message).toContain(c.where);
      expect(error.message).toContain(JSON.stringify(c.value));
      expect(error.message).toContain("Start on a fresh database");
      db.close();
    });
  }

  for (const c of WARNED) {
    test(`reports ${c.name} as a warning, and runMigrations keeps the database on every start`, () => {
      const db = freshDb();
      c.seed(db);

      const findings = unrecognizedStoredValues(db);
      expect(findings.map((f) => [f.where, f.severity])).toEqual([[c.where, "warn"]]);
      expect(findings[0]!.values).toEqual([{ value: c.value, count: 1 }]);
      expect(findings[0]!.effect).toBeTruthy();

      for (let start = 0; start < 2; start++) {
        const warned = capturingConsoleWarn(() => runMigrations(db));
        expect(warned).toHaveLength(1);
        expect(warned[0]).toContain(c.where);
        expect(warned[0]).toContain(JSON.stringify(c.value));
        expect(warned[0]).toContain(findings[0]!.effect!);
        expect(warned[0]).not.toContain("fresh database");
      }
      db.close();
    });
  }

  test("the code review adapter warning says how to fix projects.toml", () => {
    const db = freshDb();
    db.run("UPDATE projects SET review_artifact_provider = 'github' WHERE id = 'proj'");
    const seen: string[] = [];
    assertRecognizedStoredValues(db, knownStoredValues(), (m) => seen.push(m));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("codeReviewAdapter in projects.toml");
    expect(seen[0]).toContain("expected unset or one of generic, github-pr");
    db.close();
  });

  test("with refused values and warnings both, it warns first and refuses with the refused findings only", () => {
    const db = freshDb();
    db.run("UPDATE projects SET review_artifact_provider = 'github' WHERE id = 'proj'");
    insertBoardCard(db, { retiredLink: { url: "https://example.com/r/1" } });
    const seen: string[] = [];
    let thrown: unknown;
    try {
      assertRecognizedStoredValues(db, knownStoredValues(), (m) => seen.push(m));
    } catch (err) {
      thrown = err;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("projects.review_artifact_provider");
    expect(thrown).toBeInstanceOf(UnrecognizedStoredValuesError);
    const error = thrown as UnrecognizedStoredValuesError;
    expect(error.findings.map((f) => f.where)).toEqual(["board_tasks.links_json keys"]);
    expect(error.message).not.toContain("projects.review_artifact_provider");
    db.close();
  });

  test("counts each value and lists the most frequent first", () => {
    const db = freshDb();
    db.run("INSERT INTO projects (id, name, review_artifact_provider) VALUES ('a', 'A', 'old-b'), ('b', 'B', 'old-a'), ('c', 'C', 'old-a')");
    expect(unrecognizedStoredValues(db)).toEqual([
      {
        where: "projects.review_artifact_provider",
        expected: "unset or one of generic, github-pr",
        values: [
          { value: "old-a", count: 2 },
          { value: "old-b", count: 1 },
        ],
        severity: "warn",
        effect: expect.any(String),
      },
    ]);
    db.close();
  });

  test("a stage kind passed as known is recognized", () => {
    const db = freshDb();
    insertRun(db, { definition: definitionWithKind("screenshot", "plugin_gate") });
    expect(unrecognizedStoredValues(db)).toHaveLength(1);
    const known = knownStoredValues();
    expect(unrecognizedStoredValues(db, { ...known, stageKinds: [...known.stageKinds, "plugin_gate"] })).toEqual([]);
    db.close();
  });

  test("a refused database is left as found: no pending migration is applied", () => {
    const db = freshDb();
    db.run("DELETE FROM schema_version WHERE version = 96");
    insertBoardCard(db, { retiredLink: { url: "https://example.com/r/1" } });
    expect(() => runMigrations(db)).toThrow(UnrecognizedStoredValuesError);
    expect(db.query("SELECT 1 AS ok FROM schema_version WHERE version = 96").get()).toBeNull();
    db.close();
  });

  test("tables and columns the database lacks are skipped", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
    db.exec("CREATE TABLE pipeline_runs (id TEXT PRIMARY KEY)");
    expect(unrecognizedStoredValues(db)).toEqual([]);
    db.close();
  });

  test("the error names the database file", () => {
    const dir = mkdtempSync(join(tmpdir(), "stored-values-check-"));
    const path = join(dir, "standup.db");
    const db = new Database(path, { create: true });
    try {
      runMigrations(db);
      insertBoardCard(db, { retiredLink: { url: "https://example.com/r/1" } });
      expect(() => runMigrations(db)).toThrow(`move ${path} and its -wal and -shm files aside`);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
