import { afterEach, expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LATEST_SCHEMA_VERSION, runMigrations } from "./migrations.js";

/**
 * Migration 059 replayed on the schema of a real production database at
 * version 58 (fixtures/schema-58-live.sql), rather than on a schema this code
 * built itself. A production database carries the accumulated shape of every
 * past upgrade — columns appended by ALTER, tables rebuilt under quoted names,
 * a reserved version (52) never recorded — which a fresh runMigrations never
 * reproduces. The database is a file in a temp dir so it runs with the same
 * on-disk journaling a real store uses.
 *
 * The fixture omits the sqlite-vec table knowledge_chunks_vec and its shadow
 * tables. Neither migration 059 nor ensureSchemaRepairs touches them, so no
 * stand-in is needed.
 */

const FIXTURE = fileURLToPath(new URL("./fixtures/schema-58-live.sql", import.meta.url));

const OWNER = "alice";
const NOW = "2026-10-01T12:00:00.000Z";

type Row = Record<string, unknown>;

const openDbs: Database[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Opens a file-backed database in a fresh temp dir holding the version-58 production schema. */
function liveSchemaDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "standup-migrations-per-user-"));
  tempDirs.push(dir);
  const db = new Database(join(dir, "standup.db"));
  openDbs.push(db);
  db.exec(readFileSync(FIXTURE, "utf8"));
  return db;
}

function columnsOf(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

function schemaVersions(db: Database): number[] {
  return (db.query("SELECT version FROM schema_version ORDER BY version").all() as Array<{ version: number }>).map(
    (r) => r.version
  );
}

function indexNames(db: Database): string[] {
  return (db.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map(
    (r) => r.name
  );
}

function tableNames(db: Database): string[] {
  return (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
    (r) => r.name
  );
}

function countOf(db: Database, table: string): number {
  return (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** Every row of `table`, ordered by id, restricted to `columns`. */
function rowsOf(db: Database, table: string, columns: string[]): Row[] {
  return db.query(`SELECT ${columns.join(", ")} FROM ${table} ORDER BY id`).all() as Row[];
}

/** The tables seeded below — the ones migration 059 alters or the per-user Persona reads by owner. */
const SEEDED_TABLES = [
  "persona_threads",
  "persona_messages",
  "persona_approvals",
  "persona_schedules",
  "persona_jobs",
  "asks",
] as const;

const SEEDED_IDS: Record<(typeof SEEDED_TABLES)[number], string[]> = {
  persona_threads: ["pt-1", "pt-2"],
  persona_messages: ["pm-1", "pm-2", "pm-3"],
  persona_approvals: ["pa-1", "pa-2", "pa-3"],
  persona_schedules: ["ps-1", "ps-2"],
  persona_jobs: ["pj-1", "pj-2"],
  asks: ["a-1", "a-2", "a-3"],
};

/** Rows owned by OWNER in every SEEDED_TABLES table, using the fixture's real column lists. */
function seed(db: Database): void {
  db.run("INSERT INTO projects (id, name) VALUES ('standup', 'Standup')");
  db.run("INSERT INTO sessions (id, project_id, title, cwd, status) VALUES ('s-1', 'standup', 'work', '/tmp/w', 'running')");

  for (const [id, channel, ref] of [
    ["pt-1", "console", null],
    ["pt-2", "slack", "C123:1700000000.000100"],
  ] as const) {
    db.run(
      `INSERT INTO persona_threads (id, owner, channel, external_ref, title, created_at, updated_at, audience, claude_session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'private', NULL)`,
      [id, OWNER, channel, ref, `thread ${id}`, NOW, NOW]
    );
  }

  for (const [id, seq, role] of [
    ["pm-1", 1, "user"],
    ["pm-2", 2, "persona"],
    ["pm-3", 3, "system"],
  ] as const) {
    db.run(
      `INSERT INTO persona_messages
         (id, thread_id, seq, role, text, actor, options_json, job_ids_json, approval_id,
          idempotency_key, created_at, recommended_option, attachments_json)
       VALUES (?, 'pt-1', ?, ?, ?, ?, '["yes","no"]', '["pj-1"]', 'pa-1', ?, ?, 0, '[]')`,
      [id, seq, role, `message ${id}`, role === "user" ? OWNER : null, `idem-${id}`, NOW]
    );
  }

  db.run(
    `INSERT INTO persona_jobs (id, owner, thread_id, title, goal, acceptance, status, outcome, note, created_at, updated_at)
     VALUES ('pj-1', ?, 'pt-1', 'Ship it', 'merge the branch', 'tests green', 'active', NULL, 'note', ?, ?)`,
    [OWNER, NOW, NOW]
  );
  db.run(
    `INSERT INTO persona_jobs (id, owner, thread_id, title, goal, status, outcome, created_at, updated_at)
     VALUES ('pj-2', ?, 'pt-2', 'Old job', 'done already', 'done', 'merged', ?, ?)`,
    [OWNER, NOW, NOW]
  );

  for (const [id, status, decidedBy] of [
    ["pa-1", "pending", null],
    ["pa-2", "approved", OWNER],
    ["pa-3", "rejected", OWNER],
  ] as const) {
    db.run(
      `INSERT INTO persona_approvals
         (id, owner, job_id, action, summary, reason, args_json, status, result, decided_by,
          created_at, decided_at, thread_id, hold_rule)
       VALUES (?, ?, 'pj-1', 'launch', ?, 'needs a worktree', '{"project":"standup"}', ?, NULL, ?, ?, ?, 'pt-1', 'floor')`,
      [id, OWNER, `approve ${id}`, status, decidedBy, NOW, decidedBy ? NOW : null]
    );
  }

  db.run(
    `INSERT INTO persona_schedules
       (id, owner, thread_id, title, cron, timezone, kind, note, brief, project_id, model, effort,
        enabled, overlap, catch_up, created_by, created_at, updated_at, next_run_at)
     VALUES ('ps-1', ?, 'pt-1', 'Morning standup', '0 9 * * 1-5', 'America/Los_Angeles', 'wake_persona',
             'summarize', NULL, NULL, NULL, NULL, 1, 'skip', 'run_once', ?, ?, ?, ?)`,
    [OWNER, OWNER, NOW, NOW, NOW]
  );
  db.run(
    `INSERT INTO persona_schedules
       (id, owner, title, cron, timezone, kind, brief, project_id, model, effort, enabled, created_by, created_at, updated_at)
     VALUES ('ps-2', ?, 'Nightly review', '0 2 * * *', 'UTC', 'launch_job', 'review main', 'standup',
             'opus', 'high', 0, ?, ?, ?)`,
    [OWNER, OWNER, NOW, NOW]
  );

  for (const [id, kind, status, answer, requestId] of [
    ["a-1", "ask_human", "pending", null, null],
    ["a-2", "ask_human", "answered", "yes", "req-1"],
    ["a-3", "permission_prompt", "answered", "Allow", "req-2"],
  ] as const) {
    db.run(
      `INSERT INTO asks
         (id, session_id, kind, question, options_json, answer, status, created_at, resolved_at,
          gate, request_id, call_hash, floor_expires_at, floor_delivered_at)
       VALUES (?, 's-1', ?, ?, '["yes","no"]', ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      [id, kind, `question ${id}`, answer, status, NOW, answer ? NOW : null, kind === "permission_prompt" ? "floor" : null, requestId]
    );
  }
}

/** Schema objects (with their SQL), recorded versions, and every row of the seeded tables. */
function snapshot(db: Database): unknown {
  return {
    schema: db.query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
    versions: db.query("SELECT version, applied_at FROM schema_version ORDER BY version").all(),
    rows: Object.fromEntries(SEEDED_TABLES.map((t) => [t, rowsOf(db, t, columnsOf(db, t))])),
  };
}

describe("migration 059 on a production version-58 schema", () => {
  test("the fixture loads as a version-58 database without the 059 shape", () => {
    const db = liveSchemaDb();
    expect(Math.max(...schemaVersions(db))).toBe(58);
    expect(schemaVersions(db)).not.toContain(52);
    expect(columnsOf(db, "persona_approvals")).not.toContain("approver");
    expect(columnsOf(db, "asks")).not.toContain("answered_by");
    expect(tableNames(db)).not.toContain("persona_user_access");
    expect(indexNames(db)).not.toContain("idx_persona_approvals_approver");
  });

  test("adds the 059 shape, keeps every row intact, and is idempotent on a second run", () => {
    const db = liveSchemaDb();
    seed(db);

    // Pre-migration column lists, so the after-check compares the same values.
    const before = Object.fromEntries(
      SEEDED_TABLES.map((t) => {
        const columns = columnsOf(db, t);
        return [t, { columns, rows: rowsOf(db, t, columns) }];
      })
    );
    for (const t of SEEDED_TABLES) {
      expect(before[t]!.rows.map((r) => r.id)).toEqual(SEEDED_IDS[t]);
    }

    runMigrations(db);

    expect(schemaVersions(db)).toContain(59);
    expect(Math.max(...schemaVersions(db))).toBe(LATEST_SCHEMA_VERSION);
    expect(columnsOf(db, "persona_approvals")).toContain("approver");
    expect(columnsOf(db, "asks")).toContain("answered_by");
    expect(tableNames(db)).toContain("persona_user_access");
    expect(indexNames(db)).toContain("idx_persona_approvals_approver");

    for (const t of SEEDED_TABLES) {
      const { columns, rows } = before[t]!;
      expect(countOf(db, t)).toBe(SEEDED_IDS[t].length);
      // Every pre-existing column survives, in order; only additive columns follow.
      expect(columnsOf(db, t).slice(0, columns.length)).toEqual(columns);
      expect(rowsOf(db, t, columns)).toEqual(rows);
    }

    expect(db.query("SELECT id, approver FROM persona_approvals ORDER BY id").all()).toEqual([
      { id: "pa-1", approver: null },
      { id: "pa-2", approver: null },
      { id: "pa-3", approver: null },
    ]);
    expect(db.query("SELECT id, answered_by FROM asks ORDER BY id").all()).toEqual([
      { id: "a-1", answered_by: null },
      { id: "a-2", answered_by: null },
      { id: "a-3", answered_by: null },
    ]);
    expect(countOf(db, "persona_user_access")).toBe(0);
    expect(
      db.query("SELECT message_id, job_id, owner, source FROM persona_message_jobs ORDER BY message_id").all()
    ).toEqual(
      ["pm-1", "pm-2", "pm-3"].map((id) => ({ message_id: id, job_id: "pj-1", owner: OWNER, source: "explicit" }))
    );

    // A NULL approver falls back to the owner: every seeded card is still in OWNER's queue.
    const queue = db
      .query("SELECT id FROM persona_approvals WHERE approver = ? OR (approver IS NULL AND owner = ?) ORDER BY id")
      .all(OWNER, OWNER) as Array<{ id: string }>;
    expect(queue.map((r) => r.id)).toEqual(SEEDED_IDS.persona_approvals);

    const afterFirst = snapshot(db);
    expect(() => runMigrations(db)).not.toThrow();
    expect(snapshot(db)).toEqual(afterFirst);
  });
});
