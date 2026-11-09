import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import {
  MIGRATIONS,
  VERSIONED_MIGRATIONS,
  LATEST_SCHEMA_VERSION,
  RESERVED_MIGRATION_VERSIONS,
  allMigrations,
  duplicateMigrationVersions,
  ensurePersonaAttachmentsShape,
  ensurePersonaMessageJobsShape,
  ensurePersonaUserAccessShape,
  rebuildTable,
  runMigrations,
  type VersionedMigration,
} from "./migrations.js";
import { removePersonaMessageJobTag } from "./queries/persona.js";

/** Column names of `table`, for asserting an additive ALTER landed. */
function projectColumns(db: Database): string[] {
  return (db.query("PRAGMA table_info(projects)").all() as Array<{ name: string }>).map(
    (c) => c.name
  );
}

/** Column names of the `launches` table. */
function launchColumns(db: Database): string[] {
  return (db.query("PRAGMA table_info(launches)").all() as Array<{ name: string }>).map(
    (c) => c.name
  );
}

/** Column names of the `sessions` table. */
function sessionColumns(db: Database): string[] {
  return (db.query("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map(
    (c) => c.name
  );
}

/** Names of every table in the database. */
function tableNames(db: Database): string[] {
  return (
    db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
  ).map((t) => t.name);
}

/**
 * Migration 013 recreates the FK-parent `sessions` table to widen its status
 * CHECK. The real risk is the recreate losing rows or breaking the eight
 * foreign keys that point at it — so this drives the actual migration SQL
 * against a populated pre-013 database and checks both.
 */
describe("migration 013 — sessions.status 'done'", () => {
  test("recreate preserves rows + FKs and accepts 'done'", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");

    // Build the schema as it stood before 013 (migrations 001..012).
    for (let i = 0; i < 12; i++) db.exec(MIGRATIONS[i]);

    // Seed a project, a session, and a child row that FK-references it.
    db.run("INSERT INTO projects (id, name, branch) VALUES ('p', 'p', 'main')");
    db.run(
      "INSERT INTO sessions (id, project_id, cwd, status) VALUES ('s1', 'p', '/x', 'idle')"
    );
    db.run(
      "INSERT INTO events (session_id, seq, type, payload_json) VALUES ('s1', 1, 'Stop', '{}')"
    );

    // Apply migration 013 (index 12).
    db.exec(MIGRATIONS[12]);

    // Row survived the recreate.
    const s = db.query("SELECT status FROM sessions WHERE id = 's1'").get() as {
      status: string;
    } | null;
    expect(s?.status).toBe("idle");

    // Child row still linked.
    expect(db.query("SELECT session_id FROM events WHERE session_id = 's1'").all()).toHaveLength(1);

    // The new status is now allowed.
    db.run("UPDATE sessions SET status = 'done' WHERE id = 's1'");
    expect(
      (db.query("SELECT status FROM sessions WHERE id = 's1'").get() as { status: string }).status
    ).toBe("done");

    // A bogus status is still rejected by the widened CHECK.
    expect(() => db.run("UPDATE sessions SET status = 'bogus' WHERE id = 's1'")).toThrow();

    // Foreign keys are back on: a child pointing at a missing session fails.
    expect(() =>
      db.run("INSERT INTO events (session_id, seq, type, payload_json) VALUES ('ghost', 1, 'Stop', '{}')")
    ).toThrow();

    db.close();
  });
});

/**
 * Migration 043 adds `projects.knowledge_scope` — the per-project default scope
 * for new knowledge. It must be additive (no data loss), idempotent (the live
 * collector re-runs migrations on every source edit), and default every existing
 * project to NULL ("no override"). The ensureSchemaRepairs mirror must recover a
 * database whose schema_version recorded past 043 without the column.
 */
describe("migration 043 — projects.knowledge_scope", () => {
  test("adds the column and defaults existing projects to NULL, idempotently", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");

    // Build the schema as it stood BEFORE 043 (migrations 001..042 = indices
    // 0..41), then seed a project the way one exists before the upgrade.
    for (let i = 0; i < 42; i++) db.exec(MIGRATIONS[i]);
    db.run("INSERT INTO schema_version (version) VALUES (42)");
    db.run("INSERT INTO projects (id, name, branch) VALUES ('p', 'p', 'main')");
    expect(projectColumns(db)).not.toContain("knowledge_scope");

    // Applying 043 adds the column; the pre-existing row reads NULL (no override).
    runMigrations(db);
    expect(projectColumns(db)).toContain("knowledge_scope");
    const row = db.query("SELECT knowledge_scope FROM projects WHERE id = 'p'").get() as {
      knowledge_scope: string | null;
    };
    expect(row.knowledge_scope).toBeNull();

    // The seeded project's other data survived the additive ALTER.
    const name = db.query("SELECT name FROM projects WHERE id = 'p'").get() as { name: string };
    expect(name.name).toBe("p");

    // Idempotent: a second run adds no duplicate column and doesn't throw.
    runMigrations(db);
    expect(projectColumns(db).filter((c) => c === "knowledge_scope")).toHaveLength(1);

    db.close();
  });

  test("ensureSchemaRepairs adds the column when schema_version recorded past 043 without it", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");

    // Aborted upgrade: the schema is pre-043 but schema_version already records
    // 043 as applied, so the versioned migration loop won't re-add the column.
    for (let i = 0; i < 42; i++) db.exec(MIGRATIONS[i]);
    db.run("INSERT INTO schema_version (version) VALUES (43)");
    expect(projectColumns(db)).not.toContain("knowledge_scope");

    // runMigrations runs no versioned migration (already at 43) but its
    // ensureSchemaRepairs mirror must still repair the missing column.
    runMigrations(db);
    expect(projectColumns(db)).toContain("knowledge_scope");

    db.close();
  });
});

/**
 * Migration 044 adds `launches.codex_model` / `launches.codex_effort` — the model
 * and reasoning effort a Codex launch was started with. Additive (no data loss),
 * idempotent (the live collector re-runs migrations on every source edit), and
 * both default NULL on every existing launch (NULL = the Codex CLI's own default).
 * The ensureSchemaRepairs mirror must recover a database whose schema_version
 * recorded past 044 without the columns.
 */
describe("migration 044 — launches.codex_model / codex_effort", () => {
  test("adds both columns and defaults existing launches to NULL, idempotently", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");

    // Build the schema as it stood BEFORE 044 (migrations 001..043 = indices
    // 0..42), then seed a launch the way one exists before the upgrade.
    for (let i = 0; i < 43; i++) db.exec(MIGRATIONS[i]);
    db.run("INSERT INTO schema_version (version) VALUES (43)");
    db.run("INSERT INTO projects (id, name, branch) VALUES ('p', 'p', 'main')");
    db.run(
      "INSERT INTO launches (id, project_id, task, worktree_path, branch) VALUES ('L1', 'p', 't', '/tmp/L1', 'main')"
    );
    expect(launchColumns(db)).not.toContain("codex_model");
    expect(launchColumns(db)).not.toContain("codex_effort");

    // Applying 044 adds both columns; the pre-existing row reads NULL for each.
    runMigrations(db);
    expect(launchColumns(db)).toContain("codex_model");
    expect(launchColumns(db)).toContain("codex_effort");
    const row = db.query("SELECT codex_model, codex_effort FROM launches WHERE id = 'L1'").get() as {
      codex_model: string | null;
      codex_effort: string | null;
    };
    expect(row.codex_model).toBeNull();
    expect(row.codex_effort).toBeNull();

    // The seeded launch's other data survived the additive ALTER.
    const task = db.query("SELECT task FROM launches WHERE id = 'L1'").get() as { task: string };
    expect(task.task).toBe("t");

    // Idempotent: a second run adds no duplicate columns and doesn't throw.
    runMigrations(db);
    expect(launchColumns(db).filter((c) => c === "codex_model")).toHaveLength(1);
    expect(launchColumns(db).filter((c) => c === "codex_effort")).toHaveLength(1);

    db.close();
  });

  test("ensureSchemaRepairs adds the columns when schema_version recorded past 044 without them", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");

    // Aborted upgrade: the schema is pre-044 but schema_version already records
    // 044 as applied, so the versioned migration loop won't re-add the columns.
    for (let i = 0; i < 43; i++) db.exec(MIGRATIONS[i]);
    db.run("INSERT INTO schema_version (version) VALUES (44)");
    expect(launchColumns(db)).not.toContain("codex_model");
    expect(launchColumns(db)).not.toContain("codex_effort");

    // runMigrations runs no versioned migration (already at 44) but its
    // ensureSchemaRepairs mirror must still repair the missing columns.
    runMigrations(db);
    expect(launchColumns(db)).toContain("codex_model");
    expect(launchColumns(db)).toContain("codex_effort");

    db.close();
  });
});

/**
 * Migration 045 adds `sessions.kind` / `sessions.agent_type` / `sessions.agent_id`
 * plus the parent index — the subagent-subsession dimension. Additive (no data
 * loss), idempotent (the live collector re-runs migrations on every source edit),
 * and every existing session reads NULL kind (unset = a root). The
 * ensureSchemaRepairs mirror must recover a database whose schema_version
 * recorded past 045 without the columns.
 */
describe("migration 045 — subagent subsessions (sessions.kind / agent_type / agent_id)", () => {
  test("adds the columns + parent index and defaults existing sessions to NULL, idempotently", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");

    // Build the schema as it stood BEFORE 045 (migrations 001..044 = indices
    // 0..43), then seed a session the way one exists before the upgrade.
    for (let i = 0; i < 44; i++) db.exec(MIGRATIONS[i]);
    db.run("INSERT INTO schema_version (version) VALUES (44)");
    db.run("INSERT INTO projects (id, name, branch) VALUES ('p', 'p', 'main')");
    db.run("INSERT INTO sessions (id, project_id, cwd, status) VALUES ('s1', 'p', '/x', 'running')");
    expect(sessionColumns(db)).not.toContain("kind");
    expect(sessionColumns(db)).not.toContain("agent_type");
    expect(sessionColumns(db)).not.toContain("agent_id");

    // Applying 045 adds the columns; the pre-existing row reads NULL kind — a
    // root by default, exactly as it behaved before subsessions existed.
    runMigrations(db);
    expect(sessionColumns(db)).toContain("kind");
    expect(sessionColumns(db)).toContain("agent_type");
    expect(sessionColumns(db)).toContain("agent_id");
    const row = db.query("SELECT kind, agent_type, agent_id FROM sessions WHERE id = 's1'").get() as {
      kind: string | null;
      agent_type: string | null;
      agent_id: string | null;
    };
    expect(row.kind).toBeNull();
    expect(row.agent_type).toBeNull();
    expect(row.agent_id).toBeNull();

    // The parent index landed.
    const indexes = (db.query("PRAGMA index_list(sessions)").all() as Array<{ name: string }>).map(
      (i) => i.name
    );
    expect(indexes).toContain("idx_sessions_parent");

    // Idempotent: a second run adds no duplicate columns and doesn't throw.
    runMigrations(db);
    expect(sessionColumns(db).filter((c) => c === "kind")).toHaveLength(1);
    expect(sessionColumns(db).filter((c) => c === "agent_id")).toHaveLength(1);

    db.close();
  });

  test("ensureSchemaRepairs adds the columns when schema_version recorded past 045 without them", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");

    // Aborted upgrade: the schema is pre-045 but schema_version already records
    // 045 as applied, so the versioned migration loop won't re-add the columns.
    for (let i = 0; i < 44; i++) db.exec(MIGRATIONS[i]);
    db.run("INSERT INTO schema_version (version) VALUES (45)");
    expect(sessionColumns(db)).not.toContain("kind");

    // runMigrations runs no versioned migration (already at 45) but its
    // ensureSchemaRepairs mirror must still repair the missing columns + index.
    runMigrations(db);
    expect(sessionColumns(db)).toContain("kind");
    expect(sessionColumns(db)).toContain("agent_type");
    expect(sessionColumns(db)).toContain("agent_id");

    db.close();
  });
});

/**
 * Migration 046 adds the `digests` table — the durable backing for the daily
 * morning digest. A pure additive CREATE TABLE (O(1), live-safe): it must land
 * on both a fresh database and an existing one that is upgrading, preserve
 * everything already there, and be idempotent (the live collector re-runs
 * migrations on every source edit).
 */
describe("migration 046 — digests table", () => {
  test("creates the table on an upgrading database, preserving existing data, idempotently", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");

    // Build the schema as it stood BEFORE 046 (migrations 001..045 = indices
    // 0..44), then seed a project the way one exists before the upgrade.
    for (let i = 0; i < 45; i++) db.exec(MIGRATIONS[i]);
    db.run("INSERT INTO schema_version (version) VALUES (45)");
    db.run("INSERT INTO projects (id, name, branch) VALUES ('p', 'p', 'main')");
    expect(tableNames(db)).not.toContain("digests");

    // Applying 046 creates the table; the pre-existing project survived.
    runMigrations(db);
    expect(tableNames(db)).toContain("digests");
    expect((db.query("SELECT name FROM projects WHERE id = 'p'").get() as { name: string }).name).toBe(
      "p"
    );

    // The table accepts a row with the expected shape.
    db.run(
      `INSERT INTO digests (id, period_start, period_end, body, projects_json, counts_json)
       VALUES ('d1', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 'body', '["p"]', '{}')`
    );
    expect(db.query("SELECT id FROM digests").all()).toHaveLength(1);

    // Idempotent: a second run doesn't drop the table or its row.
    runMigrations(db);
    expect(tableNames(db)).toContain("digests");
    expect(db.query("SELECT id FROM digests").all()).toHaveLength(1);

    db.close();
  });

  test("fresh database ends at the latest schema version with the digests table", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    runMigrations(db);

    const version = (db.query("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v;
    expect(version).toBe(LATEST_SCHEMA_VERSION);
    expect(tableNames(db)).toContain("digests");

    db.close();
  });
});

/**
 * Migration 048 adds `knowledge_retrievals.injected` / `knowledge_retrievals.launch_id`
 * plus the launch index — the injected-vs-dropped retrieval-usage dimension (K2).
 * Additive (no data loss), idempotent (the live collector re-runs migrations on
 * every source edit), and every existing retrieval reads NULL injected (a
 * ranking-only row). The ensureSchemaRepairs mirror must recover a database whose
 * schema_version recorded past 048 without the columns.
 */
describe("migration 048 — knowledge_retrievals.injected / launch_id", () => {
  const retrievalColumns = (db: Database) =>
    (db.query("PRAGMA table_info(knowledge_retrievals)").all() as Array<{ name: string }>).map(
      (c) => c.name
    );

  test("adds both columns + launch index and defaults existing rows to NULL, idempotently", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");

    // Build the schema as it stood BEFORE 048 (migrations 001..047 = indices
    // 0..46), then seed a retrieval the way one exists before the upgrade.
    for (let i = 0; i < 47; i++) db.exec(MIGRATIONS[i]);
    db.run("INSERT INTO schema_version (version) VALUES (47)");
    db.run(
      "INSERT INTO knowledge_retrievals (doc_project, doc_slug, query, rank, surface) VALUES ('p', 'd', 'q', 0, 'search')"
    );
    expect(retrievalColumns(db)).not.toContain("injected");
    expect(retrievalColumns(db)).not.toContain("launch_id");

    // Applying 048 adds the columns; the pre-existing row reads NULL for both — a
    // ranking-only retrieval by default, exactly as it behaved before K2.
    runMigrations(db);
    expect(retrievalColumns(db)).toContain("injected");
    expect(retrievalColumns(db)).toContain("launch_id");
    const row = db.query("SELECT injected, launch_id FROM knowledge_retrievals").get() as {
      injected: number | null;
      launch_id: string | null;
    };
    expect(row.injected).toBeNull();
    expect(row.launch_id).toBeNull();

    // The launch index landed.
    const indexes = (
      db.query("PRAGMA index_list(knowledge_retrievals)").all() as Array<{ name: string }>
    ).map((i) => i.name);
    expect(indexes).toContain("idx_knowledge_retrievals_launch");

    // Idempotent: a second run adds no duplicate columns and doesn't throw.
    runMigrations(db);
    expect(retrievalColumns(db).filter((c) => c === "injected")).toHaveLength(1);
    expect(retrievalColumns(db).filter((c) => c === "launch_id")).toHaveLength(1);

    db.close();
  });

  test("ensureSchemaRepairs adds the columns when schema_version recorded past 048 without them", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");

    // Aborted upgrade: the schema is pre-048 but schema_version already records
    // 048 as applied, so the versioned migration loop won't re-add the columns.
    for (let i = 0; i < 47; i++) db.exec(MIGRATIONS[i]);
    db.run("INSERT INTO schema_version (version) VALUES (48)");
    expect(retrievalColumns(db)).not.toContain("injected");

    // runMigrations runs no versioned migration (already at 48) but its
    // ensureSchemaRepairs mirror must still repair the missing columns + index.
    runMigrations(db);
    expect(retrievalColumns(db)).toContain("injected");
    expect(retrievalColumns(db)).toContain("launch_id");
    const indexes = (
      db.query("PRAGMA index_list(knowledge_retrievals)").all() as Array<{ name: string }>
    ).map((i) => i.name);
    expect(indexes).toContain("idx_knowledge_retrievals_launch");

    db.close();
  });
});

/**
 * The active-ticket unique index (idx_orch_runs_active_ticket) is built in
 * ensureSchemaRepairs, which runs on every boot. A database written under earlier
 * code that lacked the guard may already hold duplicate active runs for one
 * ticket, so the repair must reconcile them BEFORE creating the index — otherwise
 * CREATE UNIQUE INDEX throws and bricks startup.
 */
describe("ensureSchemaRepairs — active-run guard index self-heal", () => {
  const insertRun = (db: Database, id: string, status: string, createdAt: string) =>
    db.run(
      `INSERT INTO orchestration_runs
         (id, profile_name, scope, owner_key, ticket_id, status, round, max_rounds,
          last_event_at, created_at)
       VALUES (?, 'ci', 'project', 'p', 'TK1', ?, 0, 3, ?, ?)`,
      [id, status, createdAt, createdAt]
    );

  test("dedups pre-existing duplicate active runs, then creates the index, without bricking boot", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    runMigrations(db); // full schema incl. the guard index on a clean db

    // Simulate a database written under earlier code that lacked the guard: drop
    // the index and seed TWO active runs for one ticket — a state CREATE UNIQUE
    // INDEX would otherwise reject on the next boot.
    db.exec("DROP INDEX IF EXISTS idx_orch_runs_active_ticket");
    insertRun(db, "older", "running", "2026-01-01T00:00:00Z");
    insertRun(db, "newer", "running", "2026-01-02T00:00:00Z");

    // Boot again: ensureSchemaRepairs must reconcile the duplicates then create
    // the index — never throw.
    expect(() => runMigrations(db)).not.toThrow();

    // The most-recent active run stays; the older one is retired to `lost`.
    const status = (id: string) =>
      (db.query("SELECT status FROM orchestration_runs WHERE id = ?").get(id) as { status: string })
        .status;
    expect(status("newer")).toBe("running");
    expect(status("older")).toBe("lost");

    // The guard index now exists and re-enforces one active run per ticket.
    expect(
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_orch_runs_active_ticket'"
        )
        .all()
    ).toHaveLength(1);
    expect(() => insertRun(db, "third", "running", "2026-01-03T00:00:00Z")).toThrow();

    db.close();
  });

  test("is a no-op on a database that already holds a single active run", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    runMigrations(db);
    insertRun(db, "solo", "running", "2026-01-01T00:00:00Z");

    expect(() => runMigrations(db)).not.toThrow();
    expect(
      (db.query("SELECT status FROM orchestration_runs WHERE id = 'solo'").get() as {
        status: string;
      }).status
    ).toBe("running");

    db.close();
  });
});

/**
 * Migration 051 binds Persona threads to outside channels: a unique
 * (owner, channel, external_ref) index for ref'd threads, and
 * persona_approvals.thread_id, whose ensureSchemaRepairs mirror heals a database
 * that recorded past 051 without it.
 */
describe("migration 051 — persona channel threads", () => {
  test("adds the unique ref index and the approval thread column", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const indexes = (db.query("PRAGMA index_list(persona_threads)").all() as Array<{ name: string; unique: number }>);
    expect(indexes.find((i) => i.name === "idx_persona_threads_external_ref")?.unique).toBe(1);
    const cols = (db.query("PRAGMA table_info(persona_approvals)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("thread_id");
    const threadCols = (db.query("PRAGMA table_info(persona_threads)").all() as Array<{ name: string; dflt_value: string | null }>);
    expect(threadCols.find((c) => c.name === "audience")?.dflt_value).toBe("'private'");
    expect(threadCols.map((c) => c.name)).toContain("claude_session_id");
    db.close();
  });

  test("a database recorded past 051 without the column self-heals", () => {
    const db = new Database(":memory:");
    for (let i = 0; i < 50; i++) db.exec(MIGRATIONS[i]);
    db.run("INSERT OR IGNORE INTO schema_version (version) VALUES (?)", [MIGRATIONS.length]);
    runMigrations(db);
    const cols = (db.query("PRAGMA table_info(persona_approvals)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("thread_id");
    const threadCols = (db.query("PRAGMA table_info(persona_threads)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(threadCols).toContain("audience");
    expect(threadCols).toContain("claude_session_id");
    db.close();
  });
});

/**
 * Migration 053 rebuilds knowledge_retrievals (a widened surface CHECK plus the
 * observability columns) and expert_exchanges (a nullable session_id plus the
 * exchange columns), and adds the knowledge_changes privacy columns. The risks
 * are losing or renumbering rows in the rebuild, breaking the sessions FK, and
 * a database whose schema_version already reads 053 in the old shape.
 */
describe("migration 053 — retrieval observability", () => {
  const columnsOf = (db: Database, table: string) =>
    (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number }>);

  /** A database at 051 holding a retrieval of every surface, an exchange and a change. */
  function seededPre053(): Database {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    for (let i = 0; i < 51; i++) db.exec(MIGRATIONS[i]);
    db.run("INSERT INTO schema_version (version) VALUES (51)");
    db.run("INSERT INTO projects (id, name, branch) VALUES ('p', 'p', 'main')");
    db.run("INSERT INTO sessions (id, project_id, cwd) VALUES ('s1', 'p', '/x')");
    db.run(
      `INSERT INTO knowledge_retrievals (id, doc_project, doc_slug, query, rank, score, surface, session_id, query_project, created_at, injected, launch_id)
       VALUES (7, 'p', 'a', 'q1', 0, 0.5, 'search', 's1', 'p', '2026-01-01 00:00:00', NULL, NULL),
              (9, 'p', 'b', 'q2', 1, 0.25, 'expert', 's1', 'p', '2026-01-02 00:00:00', 1, NULL),
              (12, 'p', 'c', 'q3', 0, NULL, 'inject', NULL, 'p', '2026-01-03 00:00:00', 0, 'L1')`
    );
    db.run(
      "INSERT INTO expert_exchanges (id, session_id, question, answer, region, sources_json) VALUES ('e1', 's1', 'why', 'because', 'core', '[\"knowledge/a\"]')"
    );
    db.run(
      "INSERT INTO knowledge_changes (id, project_id, slug, kind, title, created_at) VALUES ('k1', 'p', 'a', 'accepted', 'A', '2026-01-01T00:00:00Z')"
    );
    return db;
  }

  function expect053Shape(db: Database): void {
    const retrievalCols = columnsOf(db, "knowledge_retrievals").map((c) => c.name);
    for (const c of ["components_json", "algo_version", "raw_score", "relevance", "layer", "source_kind", "scope", "doc_owner", "drop_reason"]) {
      expect(retrievalCols).toContain(c);
    }
    const exchangeCols = columnsOf(db, "expert_exchanges");
    expect(exchangeCols.find((c) => c.name === "session_id")?.notnull).toBe(0);
    for (const c of ["synthesized", "fallback_reason", "retrieved_json", "project", "actor"]) {
      expect(exchangeCols.map((e) => e.name)).toContain(c);
    }
    const changeCols = columnsOf(db, "knowledge_changes").map((c) => c.name);
    expect(changeCols).toContain("personal");
    expect(changeCols).toContain("owner_user");
  }

  function expectRowsPreserved(db: Database): void {
    const rows = db
      .query("SELECT id, doc_slug, score, surface, session_id, created_at, injected, launch_id FROM knowledge_retrievals ORDER BY id")
      .all();
    expect(rows).toEqual([
      { id: 7, doc_slug: "a", score: 0.5, surface: "search", session_id: "s1", created_at: "2026-01-01 00:00:00", injected: null, launch_id: null },
      { id: 9, doc_slug: "b", score: 0.25, surface: "expert", session_id: "s1", created_at: "2026-01-02 00:00:00", injected: 1, launch_id: null },
      { id: 12, doc_slug: "c", score: null, surface: "inject", session_id: null, created_at: "2026-01-03 00:00:00", injected: 0, launch_id: "L1" },
    ]);
    expect(db.query("SELECT id, session_id, question, sources_json FROM expert_exchanges").all()).toEqual([
      { id: "e1", session_id: "s1", question: "why", sources_json: '["knowledge/a"]' },
    ]);
    expect((db.query("SELECT COUNT(*) AS n FROM knowledge_changes").get() as { n: number }).n).toBe(1);
  }

  test("upgrades a populated database, keeping every row and id, and widens the constraints", () => {
    const db = seededPre053();
    runMigrations(db);
    expect053Shape(db);
    expectRowsPreserved(db);

    // The doc_get surface is accepted; a bogus one is still rejected.
    db.run("INSERT INTO knowledge_retrievals (doc_project, doc_slug, query, rank, surface) VALUES ('p', 'a', 'a', 0, 'doc_get')");
    expect(() =>
      db.run("INSERT INTO knowledge_retrievals (doc_project, doc_slug, query, rank, surface) VALUES ('p', 'a', 'a', 0, 'bogus')")
    ).toThrow();
    // AUTOINCREMENT continues past the highest copied id.
    const newest = db.query("SELECT MAX(id) AS id FROM knowledge_retrievals").get() as { id: number };
    expect(newest.id).toBe(13);

    // A sessionless exchange is accepted; a dangling session is still an FK violation.
    db.run("INSERT INTO expert_exchanges (id, session_id, question, answer) VALUES ('e2', NULL, 'q', 'a')");
    expect(() =>
      db.run("INSERT INTO expert_exchanges (id, session_id, question, answer) VALUES ('e3', 'ghost', 'q', 'a')")
    ).toThrow();
    expect((db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);

    // The indexes are back.
    const retrievalIndexes = (db.query("PRAGMA index_list(knowledge_retrievals)").all() as Array<{ name: string }>).map((i) => i.name);
    expect(retrievalIndexes).toEqual(
      expect.arrayContaining([
        "idx_knowledge_retrievals_doc",
        "idx_knowledge_retrievals_created",
        "idx_knowledge_retrievals_launch",
        "idx_knowledge_retrievals_session",
      ])
    );
    const exchangeIndexes = (db.query("PRAGMA index_list(expert_exchanges)").all() as Array<{ name: string }>).map((i) => i.name);
    expect(exchangeIndexes).toContain("idx_expert_session");

    // Idempotent: a second boot rebuilds nothing and keeps the new rows.
    runMigrations(db);
    expect((db.query("SELECT COUNT(*) AS n FROM knowledge_retrievals").get() as { n: number }).n).toBe(4);
    expect((db.query("SELECT COUNT(*) AS n FROM expert_exchanges").get() as { n: number }).n).toBe(2);
    db.close();
  });

  test("a database recorded past 053 in the old shape self-heals with its rows", () => {
    const db = seededPre053();
    db.run("INSERT INTO schema_version (version) VALUES (?)", [LATEST_SCHEMA_VERSION]);
    runMigrations(db);
    expect053Shape(db);
    expectRowsPreserved(db);
    db.close();
  });

  test("a rebuild that would drop a column refuses and leaves the table intact", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, keep TEXT, extra TEXT)");
    db.run("INSERT INTO t (keep, extra) VALUES ('k', 'e')");
    const narrower = (name: string) => `CREATE TABLE ${name} (id INTEGER PRIMARY KEY, keep TEXT)`;
    expect(() => rebuildTable(db, "t", narrower, "")).toThrow(/drop column\(s\) extra/);
    expect(db.query("SELECT keep, extra FROM t").get()).toEqual({ keep: "k", extra: "e" });
    expect(tableNames(db)).not.toContain("t_rebuild");
    // Named as dropped, the same rebuild goes through.
    rebuildTable(db, "t", narrower, "", ["extra"]);
    expect(db.query("SELECT * FROM t").get()).toEqual({ id: 1, keep: "k" });
    db.close();
  });

  test("an interrupted 053 (one ALTER done) re-runs cleanly on the next boot", () => {
    const db = seededPre053();
    db.exec("ALTER TABLE knowledge_changes ADD COLUMN personal INTEGER");
    runMigrations(db);
    expect053Shape(db);
    expectRowsPreserved(db);
    db.close();
  });

  test("an aborted upgrade missing the 048 columns still reaches the 053 shape", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    for (let i = 0; i < 47; i++) db.exec(MIGRATIONS[i]);
    db.run("INSERT INTO schema_version (version) VALUES (48)");
    db.run("INSERT INTO knowledge_retrievals (doc_project, doc_slug, query, rank, surface) VALUES ('p', 'd', 'q', 0, 'search')");
    runMigrations(db);
    expect053Shape(db);
    const row = db.query("SELECT doc_slug, injected, launch_id, drop_reason FROM knowledge_retrievals").get();
    expect(row).toEqual({ doc_slug: "d", injected: null, launch_id: null, drop_reason: null });
    db.close();
  });
});

describe("migration 078 — knowledge_retrievals push surfaces", () => {
  /** A migrated database whose knowledge_retrievals carries the pre-078 surface CHECK and two rows. */
  function seededPre078(recordedVersions: "without-078" | "with-078"): Database {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    runMigrations(db);
    db.exec("DROP TABLE knowledge_retrievals");
    db.exec(`CREATE TABLE knowledge_retrievals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_project TEXT NOT NULL, doc_slug TEXT NOT NULL, query TEXT NOT NULL, rank INTEGER NOT NULL, score REAL,
      surface TEXT NOT NULL CHECK (surface IN ('search', 'expert', 'inject', 'doc_get')),
      session_id TEXT, query_project TEXT, created_at TEXT DEFAULT (datetime('now')), injected INTEGER, launch_id TEXT,
      components_json TEXT, algo_version TEXT, raw_score REAL, relevance REAL, layer TEXT, source_kind TEXT,
      scope TEXT, doc_owner TEXT, drop_reason TEXT, latency_ms INTEGER
    )`);
    db.run(
      `INSERT INTO knowledge_retrievals (id, doc_project, doc_slug, query, rank, surface, session_id, latency_ms)
       VALUES (3, 'p', 'a', 'q', 0, 'search', 's1', 12), (5, 'p', 'b', 'q', 1, 'doc_get', 's1', NULL)`
    );
    if (recordedVersions === "without-078") db.run("DELETE FROM schema_version WHERE version = 78");
    return db;
  }

  const insertSurface = (db: Database, surface: string) =>
    db.run("INSERT INTO knowledge_retrievals (doc_project, doc_slug, query, rank, surface) VALUES ('p', 'x', 'q', 0, ?)", [surface]);

  for (const recorded of ["without-078", "with-078"] as const) {
    test(`widens the CHECK keeping every row and id (${recorded} recorded)`, () => {
      const db = seededPre078(recorded);
      expect(() => insertSurface(db, "push:SessionStart")).toThrow();
      runMigrations(db);
      expect(db.query("SELECT id, doc_slug, surface, latency_ms FROM knowledge_retrievals ORDER BY id").all()).toEqual([
        { id: 3, doc_slug: "a", surface: "search", latency_ms: 12 },
        { id: 5, doc_slug: "b", surface: "doc_get", latency_ms: null },
      ]);
      for (const surface of ["push:SessionStart", "push:UserPromptSubmit", "push:PreToolUse", "push:launch"]) {
        insertSurface(db, surface);
      }
      expect(() => insertSurface(db, "push:Bogus")).toThrow();
      const indexes = (db.query("PRAGMA index_list(knowledge_retrievals)").all() as Array<{ name: string }>).map((i) => i.name);
      expect(indexes).toContain("idx_knowledge_retrievals_session");
      // Idempotent: a second boot rebuilds nothing and keeps the new rows.
      runMigrations(db);
      expect((db.query("SELECT COUNT(*) AS n FROM knowledge_retrievals").get() as { n: number }).n).toBe(6);
      db.close();
    });
  }

  test("a fresh database takes the push surfaces from the start", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    insertSurface(db, "push:PreToolUse");
    expect(VERSIONED_MIGRATIONS.some((m) => m.version === 78)).toBe(true);
    db.close();
  });
});

describe("migration 081 — worker hygiene (launch reaping, launch_processes)", () => {
  const indexesOf = (db: Database) =>
    (db.query("PRAGMA index_list(launch_processes)").all() as Array<{ name: string }>).map((i) => i.name);

  test("a fresh database has the launch columns and the process registry", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    expect(launchColumns(db)).toEqual(
      expect.arrayContaining(["reaped_at", "reap_reason", "keep_alive", "bypass_permissions"])
    );
    expect(tableNames(db)).toContain("launch_processes");
    expect(indexesOf(db)).toEqual(expect.arrayContaining(["idx_launch_processes_launch", "idx_launch_processes_job"]));
    expect(() =>
      db.run("INSERT INTO launch_processes (id, launch_id, kind, label) VALUES ('p1', 'L1', 'socket', 'x')")
    ).toThrow();
    db.run("INSERT INTO launch_processes (id, launch_id, kind, label, pid) VALUES ('p2', 'L1', 'pid', 'srv', 42)");
    const row = db.query("SELECT registered_at, stopped_at FROM launch_processes WHERE id = 'p2'").get() as {
      registered_at: string | null;
      stopped_at: string | null;
    };
    expect(row.registered_at).not.toBeNull();
    expect(row.stopped_at).toBeNull();
    db.close();
  });

  test("an existing launch defaults to not kept alive and not reaped", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    db.exec("ALTER TABLE launches DROP COLUMN keep_alive");
    db.exec("ALTER TABLE launches DROP COLUMN reaped_at");
    db.exec("ALTER TABLE launches DROP COLUMN reap_reason");
    db.exec("ALTER TABLE launches DROP COLUMN bypass_permissions");
    db.exec("DROP TABLE launch_processes");
    db.run("INSERT INTO projects (id, name) VALUES ('p', 'P')");
    db.run("INSERT INTO launches (id, project_id, task, worktree_path, branch) VALUES ('L1', 'p', 't', '/wt', 'b')");
    db.run("DELETE FROM schema_version WHERE version = 81");
    runMigrations(db);
    expect(
      db.query("SELECT keep_alive, reaped_at, reap_reason, bypass_permissions FROM launches WHERE id = 'L1'").get()
    ).toEqual({
      keep_alive: 0,
      reaped_at: null,
      reap_reason: null,
      bypass_permissions: null,
    });
    expect(tableNames(db)).toContain("launch_processes");
    db.close();
  });

  test("re-running it, recorded or not, is a no-op", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    db.run("INSERT INTO launch_processes (id, launch_id, kind, label, unit) VALUES ('u1', 'L1', 'unit', 'tunnel', 'x.service')");
    db.run("DELETE FROM schema_version WHERE version = 81");
    runMigrations(db);
    runMigrations(db);
    expect((db.query("SELECT COUNT(*) AS n FROM launch_processes").get() as { n: number }).n).toBe(1);
    expect(VERSIONED_MIGRATIONS.some((m) => m.version === 81)).toBe(true);
    db.close();
  });
});

/**
 * Migrations carry explicit versions so two branches that each add one land
 * in either order: a version is applied when it is not yet recorded, in
 * ascending order, and the positional 001..051 keep replaying exactly as before.
 */
describe("migration versions", () => {
  test("no version is declared twice", () => {
    expect(duplicateMigrationVersions()).toEqual([]);
    expect(VERSIONED_MIGRATIONS.every((m) => m.version > MIGRATIONS.length)).toBe(true);
  });

  test("a duplicated version is detected and refused by the runner", () => {
    const list: VersionedMigration[] = [
      ...allMigrations(),
      { version: 53, apply: "CREATE TABLE twice_53 (id INTEGER)" },
    ];
    expect(duplicateMigrationVersions(list)).toEqual([53]);
    const db = new Database(":memory:");
    expect(() => runMigrations(db, list)).toThrow(/declared twice or reserved: 53/);
    db.close();
  });

  test("a reserved version cannot be declared", () => {
    expect(RESERVED_MIGRATION_VERSIONS).toContain(52);
    const list: VersionedMigration[] = [...allMigrations(), { version: 52, apply: "CREATE TABLE r52 (id INTEGER)" }];
    expect(duplicateMigrationVersions(list)).toEqual([52]);
    const db = new Database(":memory:");
    expect(() => runMigrations(db, list)).toThrow(/declared twice or reserved: 52/);
    expect(tableNames(db)).not.toContain("r52");
    db.close();
  });

  test("097 stays declared as a no-op, and a fresh database records it", () => {
    expect(allMigrations().find((m) => m.version === 97)?.apply).toBe("SELECT 1");
    const db = new Database(":memory:");
    runMigrations(db);
    expect(db.query("SELECT 1 AS ok FROM schema_version WHERE version = 97").get()).toEqual({ ok: 1 });
    db.close();
  });

  test("no reserved version sits above the highest declared one", () => {
    // The next migration is numbered one past the highest declared version;
    // a reserved number there would be handed out again.
    expect(RESERVED_MIGRATION_VERSIONS.every((v) => v < LATEST_SCHEMA_VERSION)).toBe(true);
  });

  // The two tests below exercise the runner's ordering with a lower version
  // landing late. 52 is the only number below 53, so they lift its reservation.
  test("053 applied first, then a 052 landing later, both run once and are recorded", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    // As shipped by this branch alone: positional 001..051 plus 053.
    runMigrations(db);
    const versions = () =>
      (db.query("SELECT version FROM schema_version ORDER BY version").all() as Array<{ version: number }>).map(
        (r) => r.version
      );
    expect(versions()).toContain(53);
    expect(versions()).not.toContain(52);

    // The other branch's 052 lands, explicit or positional: either way it runs
    // on this database even though 053 is already recorded.
    for (const late of [
      { version: 52, apply: "CREATE TABLE late_52 (id INTEGER)" },
      { version: 52, apply: "CREATE TABLE late_52 (id INTEGER)", positional: true },
    ] as VersionedMigration[]) {
      db.exec("DROP TABLE IF EXISTS late_52");
      db.run("DELETE FROM schema_version WHERE version = 52");
      runMigrations(db, [...allMigrations(), late], []);
      expect(versions()).toContain(52);
      expect(tableNames(db)).toContain("late_52");
      // A second boot applies nothing more.
      db.exec("DROP TABLE late_52");
      runMigrations(db, [...allMigrations(), late], []);
      expect(tableNames(db)).not.toContain("late_52");
    }
    db.close();
  });

  test("052 then 053 in version order on a fresh database", () => {
    const db = new Database(":memory:");
    const order: number[] = [];
    runMigrations(db, [
      ...allMigrations().filter((m) => m.positional),
      { version: 53, apply: () => order.push(53) },
      { version: 52, apply: () => order.push(52) },
    ], []);
    expect(order).toEqual([52, 53]);
    db.close();
  });

  test("an existing database at 051 replays nothing positional and gains only the versioned migrations", () => {
    const db = new Database(":memory:");
    for (let i = 0; i < 51; i++) db.exec(MIGRATIONS[i]);
    for (let v = 1; v <= 51; v++) db.run("INSERT INTO schema_version (version) VALUES (?)", [v]);
    const applied: number[] = [];
    runMigrations(
      db,
      allMigrations().map((m) => ({
        ...m,
        apply: (d) => {
          applied.push(m.version);
          if (typeof m.apply === "string") d.exec(m.apply);
          else m.apply(d);
        },
      }))
    );
    expect(applied).toEqual(VERSIONED_MIGRATIONS.map((m) => m.version).sort((a, b) => a - b));
    db.close();
  });
});

describe("migration 054 — Persona schedules", () => {
  test("creates the schedule tables, and re-running it is a no-op", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      (r) => r.name
    );
    expect(tables).toContain("persona_schedules");
    expect(tables).toContain("persona_schedule_runs");
    const m54 = VERSIONED_MIGRATIONS.find((m) => m.version === 54)!;
    expect(() => db.exec(m54.apply as string)).not.toThrow();
    db.close();
  });

  test("a slot can be recorded once per schedule; manual runs are not slots", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    db.run(
      `INSERT INTO persona_schedules (id, owner, title, cron, timezone, kind, note, created_by, created_at, updated_at)
       VALUES ('s1', 'me', 't', '0 9 * * *', 'UTC', 'wake_persona', 'n', 'me', '2026-01-01', '2026-01-01')`
    );
    const insert = (id: string, trigger: string) =>
      db.run(
        `INSERT OR IGNORE INTO persona_schedule_runs (id, schedule_id, owner, scheduled_for, trigger, status, started_at)
         VALUES (?, 's1', 'me', '2026-01-02T09:00:00.000Z', ?, 'starting', '2026-01-02T09:00:00.000Z')`,
        [id, trigger]
      ).changes;
    expect(insert("r1", "cron")).toBe(1);
    expect(insert("r2", "catch_up")).toBe(0);
    expect(insert("r3", "manual")).toBe(1);
    expect(insert("r4", "manual")).toBe(1);
    db.close();
  });

  test("a database from before the end bound gets its columns, an existing schedule unbounded with no runs counted", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    for (const column of ["ends_at", "max_runs", "run_count", "ended_at", "end_reason"]) {
      db.exec(`ALTER TABLE persona_schedules DROP COLUMN ${column}`);
    }
    db.exec("ALTER TABLE persona_schedule_runs DROP COLUMN counted");
    db.run(
      `INSERT INTO persona_schedules (id, owner, title, cron, timezone, kind, note, created_by, created_at, updated_at)
       VALUES ('s1', 'me', 't', '0 9 * * *', 'UTC', 'wake_persona', 'n', 'me', '2026-01-01', '2026-01-01')`
    );
    runMigrations(db);
    const row = db.query("SELECT ends_at, max_runs, run_count, ended_at, end_reason FROM persona_schedules WHERE id = 's1'").get();
    expect(row).toEqual({ ends_at: null, max_runs: null, run_count: 0, ended_at: null, end_reason: null });
    const runColumns = (db.query("PRAGMA table_info(persona_schedule_runs)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(runColumns).toContain("counted");
    db.close();
  });

  test("a database from before schedule watches gets their columns, an existing schedule unwatched", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    for (const column of ["watch", "watch_state", "watch_pending", "watch_skips", "watch_changed_at"]) {
      db.exec(`ALTER TABLE persona_schedules DROP COLUMN ${column}`);
    }
    db.run(
      `INSERT INTO persona_schedules (id, owner, title, cron, timezone, kind, note, created_by, created_at, updated_at)
       VALUES ('s1', 'me', 't', '0 9 * * *', 'UTC', 'wake_persona', 'n', 'me', '2026-01-01', '2026-01-01')`
    );
    runMigrations(db);
    const row = db
      .query("SELECT watch, watch_state, watch_pending, watch_skips, watch_changed_at FROM persona_schedules WHERE id = 's1'")
      .get();
    expect(row).toEqual({ watch: null, watch_state: null, watch_pending: null, watch_skips: 0, watch_changed_at: null });
    db.close();
  });
});

/**
 * Migration 056 creates persona_signals and adds persona_approvals.hold_rule
 * and persona_messages.recommended_option. The risks are a re-run (it can land
 * after higher-numbered migrations), a database recorded past 056 without the
 * shape, and a signal written with a worker as its actor.
 */
describe("migration 056 — Persona preference signals", () => {
  const cols = (db: Database, table: string) =>
    (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  const signal = (db: Database, id: string, actor: string, kind = "approval") =>
    db.run(
      `INSERT INTO persona_signals (id, owner, kind, actor, value_json, occurred_at, created_at)
       VALUES (?, 'me', ?, ?, '{}', '2026-10-06T00:00:00.000Z', '2026-10-06T00:00:00.000Z')`,
      [id, kind, actor]
    );

  test("is version 056, recorded on a fresh database, with the table, indexes and columns", () => {
    expect(VERSIONED_MIGRATIONS.some((m) => m.version === 56)).toBe(true);
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(56);
    const db = new Database(":memory:");
    runMigrations(db);
    expect(db.query("SELECT 1 FROM schema_version WHERE version = 56").get()).not.toBeNull();
    expect(tableNames(db)).toContain("persona_signals");
    const indexes = (db.query("PRAGMA index_list(persona_signals)").all() as Array<{ name: string }>).map((i) => i.name);
    expect(indexes).toContain("idx_persona_signals_kind");
    expect(indexes).toContain("idx_persona_signals_subject");
    expect(cols(db, "persona_approvals")).toContain("hold_rule");
    expect(cols(db, "persona_messages")).toContain("recommended_option");
    db.close();
  });

  test("re-running it, and booting again, is a no-op that keeps rows", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    signal(db, "s1", "owner");
    const m56 = VERSIONED_MIGRATIONS.find((m) => m.version === 56)!;
    expect(() => (m56.apply as (d: Database) => void)(db)).not.toThrow();
    runMigrations(db);
    expect((db.query("SELECT COUNT(*) AS n FROM persona_signals").get() as { n: number }).n).toBe(1);
    db.close();
  });

  test("actor is only ever the owner or the system, and kind is from the design's list", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    expect(() => signal(db, "a", "owner")).not.toThrow();
    expect(() => signal(db, "b", "system", "persona_action")).not.toThrow();
    expect(() => signal(db, "c", "worker")).toThrow();
    expect(() => signal(db, "d", "persona")).toThrow();
    expect(() => signal(db, "e", "owner", "made_up")).toThrow();
    db.close();
  });

  test("a database recorded past 056 in the old shape self-heals", () => {
    const db = new Database(":memory:");
    for (const sql of MIGRATIONS) db.exec(sql);
    for (const m of VERSIONED_MIGRATIONS.filter((v) => v.version < 56)) {
      if (typeof m.apply === "string") db.exec(m.apply);
      else m.apply(db);
    }
    for (const m of allMigrations()) db.run("INSERT OR IGNORE INTO schema_version (version) VALUES (?)", [m.version]);
    expect(tableNames(db)).not.toContain("persona_signals");
    expect(cols(db, "persona_approvals")).not.toContain("hold_rule");
    runMigrations(db);
    expect(tableNames(db)).toContain("persona_signals");
    expect(cols(db, "persona_approvals")).toContain("hold_rule");
    expect(cols(db, "persona_messages")).toContain("recommended_option");
    db.close();
  });

  test("existing approvals and messages keep their rows, with NULL in the new columns", () => {
    const db = new Database(":memory:");
    for (const sql of MIGRATIONS) db.exec(sql);
    db.run("INSERT OR IGNORE INTO schema_version (version) VALUES (?)", [MIGRATIONS.length]);
    db.run(
      `INSERT INTO persona_approvals (id, owner, action, summary, reason, args_json, created_at)
       VALUES ('ap', 'me', 'remember', 's', 'r', '{}', '2026-10-05')`
    );
    runMigrations(db);
    expect(db.query("SELECT hold_rule FROM persona_approvals WHERE id = 'ap'").get()).toEqual({ hold_rule: null });
    db.close();
  });
});

describe("migration 057 — Persona knowledge-draft decisions", () => {
  test("creates the table and its indexes, is recorded, and re-running it is a no-op that keeps rows", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    expect(tableNames(db)).toContain("persona_knowledge_decisions");
    expect(db.query("SELECT 1 FROM schema_version WHERE version = 57").get()).not.toBeNull();
    const indexes = (db.query("PRAGMA index_list(persona_knowledge_decisions)").all() as Array<{ name: string }>).map((i) => i.name);
    expect(indexes).toContain("idx_persona_knowledge_decisions_owner");
    expect(indexes).toContain("idx_persona_knowledge_decisions_doc");
    db.run(
      `INSERT INTO persona_knowledge_decisions (id, owner, project_id, draft_slug, title, decision, mode, reason, created_at)
       VALUES ('d', 'me', 'p', 's', 't', 'reject', 'new', 'r', '2026-10-06')`
    );
    const m57 = VERSIONED_MIGRATIONS.find((m) => m.version === 57)!;
    expect(() => db.exec(m57.apply as string)).not.toThrow();
    runMigrations(db);
    expect((db.query("SELECT COUNT(*) AS n FROM persona_knowledge_decisions").get() as { n: number }).n).toBe(1);
    db.close();
  });
});

describe("migration 058 — Persona image attachments", () => {
  test("creates persona_attachments and persona_messages.attachments_json, is recorded, and re-running keeps rows", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    expect(tableNames(db)).toContain("persona_attachments");
    expect(db.query("SELECT 1 FROM schema_version WHERE version = 58").get()).not.toBeNull();
    const messageColumns = (db.query("PRAGMA table_info(persona_messages)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(messageColumns).toContain("attachments_json");
    const indexes = (db.query("PRAGMA index_list(persona_attachments)").all() as Array<{ name: string }>).map((i) => i.name);
    expect(indexes).toContain("idx_persona_attachments_turn");
    db.run(
      `INSERT INTO persona_attachments (id, owner, thread_id, batch_key, sha256, mime_type, bytes, name, created_at)
       VALUES ('a', 'me', 't', 'b', 's', 'image/png', 1, 'x.png', '2026-10-06')`
    );
    ensurePersonaAttachmentsShape(db);
    runMigrations(db);
    expect((db.query("SELECT COUNT(*) AS n FROM persona_attachments").get() as { n: number }).n).toBe(1);
    db.close();
  });

  test("repairs a database recorded at 058 but missing the column", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    db.exec("ALTER TABLE persona_messages DROP COLUMN attachments_json");
    db.exec("DROP TABLE persona_attachments");
    runMigrations(db);
    expect(tableNames(db)).toContain("persona_attachments");
    const messageColumns = (db.query("PRAGMA table_info(persona_messages)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(messageColumns).toContain("attachments_json");
    db.close();
  });
});

describe("migration 069 — owner media on Persona messages", () => {
  const attachmentColumns = (db: Database): string[] =>
    (db.query("PRAGMA table_info(persona_attachments)").all() as Array<{ name: string }>).map((c) => c.name);

  test("adds persona_attachments.media_json, is recorded, and re-running keeps rows and values", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    expect(attachmentColumns(db)).toContain("media_json");
    expect(tableNames(db)).toContain("persona_session_images");
    expect(tableNames(db)).toContain("persona_media_shares");
    expect(db.query("SELECT 1 FROM schema_version WHERE version = 69").get()).not.toBeNull();
    db.run(
      `INSERT INTO persona_attachments (id, owner, thread_id, batch_key, sha256, mime_type, bytes, name, created_at, media_json)
       VALUES ('a', 'me', 't', 'upload:x', 's', 'video/mp4', 1, 'x.mp4', '2026-10-09', '{"durationSec":1}')`
    );
    ensurePersonaAttachmentsShape(db);
    runMigrations(db);
    expect(db.query("SELECT media_json FROM persona_attachments WHERE id = 'a'").get()).toEqual({ media_json: '{"durationSec":1}' });
    db.close();
  });

  test("a database that ran owner media as 068 converges: the knowledge API shape and 069 both land", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    // As a dev database from the owner-media branch was left: 068 recorded
    // for owner media, the knowledge API's shape absent, 069 not yet run.
    db.exec("ALTER TABLE projects DROP COLUMN shareable");
    db.exec("DROP TABLE public_kb_calls");
    db.exec("DELETE FROM schema_version WHERE version = 69");
    runMigrations(db);
    const projectColumns = (db.query("PRAGMA table_info(projects)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(projectColumns).toContain("shareable");
    expect(tableNames(db)).toContain("public_kb_calls");
    expect(attachmentColumns(db)).toContain("media_json");
    expect(db.query("SELECT 1 FROM schema_version WHERE version = 69").get()).not.toBeNull();
    db.close();
  });

  test("repairs a database recorded at 069 but missing the column", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    db.exec("ALTER TABLE persona_attachments DROP COLUMN media_json");
    db.exec("DROP TABLE persona_session_images");
    runMigrations(db);
    expect(attachmentColumns(db)).toContain("media_json");
    expect(tableNames(db)).toContain("persona_session_images");
    // A table from before base64_bytes gets the column.
    db.exec("DROP TABLE persona_session_images");
    db.exec("CREATE TABLE persona_session_images (session_id TEXT PRIMARY KEY, images INTEGER NOT NULL, updated_at TEXT NOT NULL)");
    db.run("INSERT INTO persona_session_images VALUES ('s', 3, 'x')");
    ensurePersonaAttachmentsShape(db);
    expect(db.query("SELECT images, base64_bytes FROM persona_session_images").get()).toEqual({ images: 3, base64_bytes: 0 });
    db.close();
  });

  test("adds the column to a table created by 058's original shape", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    db.exec("DROP TABLE persona_attachments");
    db.exec(`CREATE TABLE persona_attachments (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, thread_id TEXT NOT NULL, batch_key TEXT NOT NULL,
      message_id TEXT, sha256 TEXT NOT NULL, mime_type TEXT NOT NULL, bytes INTEGER NOT NULL,
      name TEXT NOT NULL, caption TEXT, created_at TEXT NOT NULL)`);
    ensurePersonaAttachmentsShape(db);
    expect(attachmentColumns(db)).toContain("media_json");
    db.close();
  });
});

describe("migration 059 — per-user Persona", () => {
  const columnsOf = (db: Database, table: string): string[] =>
    (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  const indexesOf = (db: Database, table: string): string[] =>
    (db.query(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>).map((i) => i.name);

  /** Takes a database migrated through 058 back to the shape 058 left it in. */
  function stripTo058(db: Database): void {
    db.exec("DROP INDEX IF EXISTS idx_persona_approvals_approver");
    db.exec("ALTER TABLE persona_approvals DROP COLUMN approver");
    db.exec("ALTER TABLE asks DROP COLUMN answered_by");
    db.exec("DROP TABLE persona_user_access");
  }

  function schemaAt058(): Database {
    const db = new Database(":memory:");
    runMigrations(db, allMigrations().filter((m) => m.version <= 58));
    stripTo058(db);
    expect(db.query("SELECT MAX(version) AS v FROM schema_version").get()).toEqual({ v: 58 });
    expect(columnsOf(db, "persona_approvals")).not.toContain("approver");
    expect(columnsOf(db, "asks")).not.toContain("answered_by");
    expect(tableNames(db)).not.toContain("persona_user_access");
    return db;
  }

  test("upgrades a 058 database in place: new columns, table and index, seeded rows intact, re-run a no-op", () => {
    const db = schemaAt058();
    db.run(
      `INSERT INTO projects (id, name, branch, repos_json) VALUES ('p', 'p', 'main', '[]')`
    );
    db.run(
      `INSERT INTO sessions (id, project_id, title, cwd, status) VALUES ('s1', 'p', 't', '/tmp', 'running')`
    );
    db.run(
      `INSERT INTO persona_threads (id, owner, channel, title, created_at, updated_at)
       VALUES ('t1', 'alice', 'console', 'Console', '2026-10-06', '2026-10-06')`
    );
    db.run(
      `INSERT INTO persona_approvals (id, owner, thread_id, action, summary, args_json, created_at)
       VALUES ('a1', 'alice', 't1', 'launch_session', 's', '{}', '2026-10-06')`
    );
    db.run(
      `INSERT INTO asks (id, session_id, kind, question, answer, status)
       VALUES ('q1', 's1', 'ask_human', 'q', 'yes', 'answered')`
    );

    runMigrations(db);

    expect(db.query("SELECT 1 FROM schema_version WHERE version = 59").get()).not.toBeNull();
    expect(columnsOf(db, "persona_approvals")).toContain("approver");
    expect(columnsOf(db, "asks")).toContain("answered_by");
    expect(tableNames(db)).toContain("persona_user_access");
    expect(columnsOf(db, "persona_user_access")).toEqual([
      "alias",
      "enabled",
      "launch_projects_json",
      "updated_by",
      "updated_at",
    ]);
    expect(indexesOf(db, "persona_approvals")).toContain("idx_persona_approvals_approver");

    expect(db.query("SELECT owner, approver, status FROM persona_approvals WHERE id = 'a1'").get()).toEqual({
      owner: "alice",
      approver: null,
      status: "pending",
    });
    expect(db.query("SELECT answer, answered_by FROM asks WHERE id = 'q1'").get()).toEqual({
      answer: "yes",
      answered_by: null,
    });
    expect(db.query("SELECT owner FROM persona_threads WHERE id = 't1'").get()).toEqual({ owner: "alice" });

    db.run("INSERT INTO persona_user_access (alias) VALUES ('bob')");
    expect(db.query("SELECT enabled, launch_projects_json FROM persona_user_access").get()).toEqual({
      enabled: 1,
      launch_projects_json: "[]",
    });

    const versionsBefore = db.query("SELECT version FROM schema_version ORDER BY version").all();
    runMigrations(db);
    ensurePersonaUserAccessShape(db);
    expect(db.query("SELECT version FROM schema_version ORDER BY version").all()).toEqual(versionsBefore);
    expect((db.query("SELECT COUNT(*) AS n FROM persona_approvals").get() as { n: number }).n).toBe(1);
    expect((db.query("SELECT COUNT(*) AS n FROM asks").get() as { n: number }).n).toBe(1);
    expect((db.query("SELECT COUNT(*) AS n FROM persona_user_access").get() as { n: number }).n).toBe(1);
    db.close();
  });

  test("repairs a database recorded at 059 but missing its columns and table", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(59);
    stripTo058(db);
    expect(db.query("SELECT 1 FROM schema_version WHERE version = 59").get()).not.toBeNull();
    runMigrations(db);
    expect(columnsOf(db, "persona_approvals")).toContain("approver");
    expect(columnsOf(db, "asks")).toContain("answered_by");
    expect(tableNames(db)).toContain("persona_user_access");
    expect(indexesOf(db, "persona_approvals")).toContain("idx_persona_approvals_approver");
    db.close();
  });
});

describe("migration 066 — Persona message job tags", () => {
  const indexesOf = (db: Database, table: string): string[] =>
    (db.query(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>).map((i) => i.name);
  const tagsOf = (db: Database) =>
    db
      .query("SELECT message_id, job_id, owner, source, created_at FROM persona_message_jobs ORDER BY message_id, job_id")
      .all();

  /** A database migrated through 059, as a build without 066 left it. */
  function schemaAt059(): Database {
    const db = new Database(":memory:");
    runMigrations(db, allMigrations().filter((m) => m.version <= 59));
    db.exec("DROP TABLE persona_message_jobs");
    expect(db.query("SELECT 1 FROM schema_version WHERE version = 66").get()).toBeNull();
    expect(tableNames(db)).not.toContain("persona_message_jobs");
    return db;
  }

  function seedMessages(db: Database): void {
    db.run(
      `INSERT INTO persona_threads (id, owner, channel, created_at, updated_at)
       VALUES ('t1', 'alice', 'console', '2026-10-06', '2026-10-06')`
    );
    const insert = db.query(
      `INSERT INTO persona_messages (id, thread_id, seq, role, text, job_ids_json, created_at)
       VALUES (?, ?, ?, 'persona', 'x', ?, ?)`
    );
    insert.run("m1", "t1", 1, '["j1","j2"]', "2026-10-06T01:00:00.000Z");
    insert.run("m2", "t1", 2, null, "2026-10-06T02:00:00.000Z");
    insert.run("m3", "t1", 3, "not json", "2026-10-06T03:00:00.000Z");
    insert.run("m4", "t1", 4, '{"j":"x"}', "2026-10-06T04:00:00.000Z");
    insert.run("m5", "t1", 5, '["j1", 7, "", "j1"]', "2026-10-06T05:00:00.000Z");
    // A message whose thread is gone has no owner to tag for.
    insert.run("m6", "gone", 1, '["j3"]', "2026-10-06T06:00:00.000Z");
  }

  test("a fresh database has the table, keyed by (message_id, job_id) with no other index, and 066 is recorded", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    expect(tableNames(db)).toContain("persona_message_jobs");
    expect(db.query("SELECT 1 FROM schema_version WHERE version = 66").get()).not.toBeNull();
    expect(indexesOf(db, "persona_message_jobs")).toEqual(["sqlite_autoindex_persona_message_jobs_1"]);
    expect(() =>
      db.run(
        `INSERT INTO persona_message_jobs (message_id, job_id, owner, source, created_at)
         VALUES ('m', 'j', 'me', 'guessed', '2026-10-06')`
      )
    ).toThrow();
    db.close();
  });

  test("upgrades a 059 database: backfills explicit tags with the thread owner, skipping malformed and orphaned rows", () => {
    const db = schemaAt059();
    seedMessages(db);
    runMigrations(db);
    expect(db.query("SELECT 1 FROM schema_version WHERE version = 66").get()).not.toBeNull();
    expect(tagsOf(db)).toEqual([
      { message_id: "m1", job_id: "j1", owner: "alice", source: "explicit", created_at: "2026-10-06T01:00:00.000Z" },
      { message_id: "m1", job_id: "j2", owner: "alice", source: "explicit", created_at: "2026-10-06T01:00:00.000Z" },
      { message_id: "m5", job_id: "j1", owner: "alice", source: "explicit", created_at: "2026-10-06T05:00:00.000Z" },
    ]);
    db.close();
  });

  test("re-running is idempotent and keeps existing tags as they are", () => {
    const db = schemaAt059();
    seedMessages(db);
    runMigrations(db);
    db.run("UPDATE persona_message_jobs SET source = 'inferred' WHERE message_id = 'm1' AND job_id = 'j2'");
    const before = tagsOf(db);
    const m66 = VERSIONED_MIGRATIONS.find((m) => m.version === 66)!;
    expect(() => (m66.apply as (db: Database) => void)(db)).not.toThrow();
    ensurePersonaMessageJobsShape(db);
    runMigrations(db);
    expect(tagsOf(db)).toEqual(before);
    // A message missing one of its tags gets just that one back; the other keeps its source.
    db.run("DELETE FROM persona_message_jobs WHERE message_id = 'm1' AND job_id = 'j1'");
    ensurePersonaMessageJobsShape(db);
    expect(tagsOf(db)).toEqual(before);
    db.close();
  });

  test("re-running backfills a message written with job_ids_json but no tags", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    seedMessages(db);
    expect(tagsOf(db)).toEqual([]);
    ensurePersonaMessageJobsShape(db);
    expect((tagsOf(db) as Array<{ message_id: string; job_id: string; source: string }>).map((t) => [t.message_id, t.job_id, t.source])).toEqual([
      ["m1", "j1", "explicit"],
      ["m1", "j2", "explicit"],
      ["m5", "j1", "explicit"],
    ]);
    db.close();
  });

  test("a tag the owner removed is not brought back by a later run", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    seedMessages(db);
    runMigrations(db);
    expect(removePersonaMessageJobTag(db, { messageId: "m1", jobId: "j2", owner: "alice" })?.jobIds).toEqual(["j1"]);
    runMigrations(db);
    ensurePersonaMessageJobsShape(db);
    expect((tagsOf(db) as Array<{ message_id: string; job_id: string }>).map((t) => [t.message_id, t.job_id])).toEqual([
      ["m1", "j1"],
      ["m5", "j1"],
    ]);
    db.close();
  });

  test("repairs a database recorded at 066 but missing the table, backfilling it again", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    seedMessages(db);
    db.exec("DROP TABLE persona_message_jobs");
    expect(db.query("SELECT 1 FROM schema_version WHERE version = 66").get()).not.toBeNull();
    runMigrations(db);
    expect(tableNames(db)).toContain("persona_message_jobs");
    expect((tagsOf(db) as Array<{ message_id: string }>).map((t) => t.message_id)).toEqual(["m1", "m1", "m5"]);
    db.close();
  });
});

describe("migration 070 — review tunnels", () => {
  test("creates review_tunnels with its live-row unique indexes, and is recorded", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    expect(db.query("SELECT 1 FROM schema_version WHERE version = 70").get()).not.toBeNull();
    expect(tableNames(db)).toContain("review_tunnels");
    const indexes = (db.query("PRAGMA index_list(review_tunnels)").all() as Array<{ name: string }>).map((i) => i.name);
    expect(indexes).toEqual(
      expect.arrayContaining(["idx_review_tunnels_live_port", "idx_review_tunnels_live_name", "idx_review_tunnels_live_launch"])
    );
    db.close();
  });

  test("a closed row frees its port for a new live one; two live rows can't share it", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const insert = (id: string, status: string, launch: string) =>
      db.run(
        "INSERT INTO review_tunnels (id, launch_id, owner, name, url, port, status, created_at, updated_at) VALUES (?, ?, 'a', ?, 'u', 5200, ?, 'now', 'now')",
        [id, launch, `a-${id}`, status]
      );
    insert("t1", "closed", "l1");
    insert("t2", "open", "l2");
    expect(() => insert("t3", "opening", "l3")).toThrow(/UNIQUE constraint failed: review_tunnels.port/);
    db.close();
  });

  test("re-running it on a database that already has the table is a no-op", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    db.run("DELETE FROM schema_version WHERE version = 70");
    runMigrations(db);
    expect(tableNames(db)).toContain("review_tunnels");
    db.close();
  });
});
