import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ensurePersonaBudgetShape } from "./migrations.js";

/** The persona_jobs shape before the budget columns (migration 073). */
function preBudgetDb(): Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE persona_jobs (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, thread_id TEXT NOT NULL, title TEXT NOT NULL, goal TEXT NOT NULL,
    acceptance TEXT, status TEXT NOT NULL DEFAULT 'active', outcome TEXT, note TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, waiting_since TEXT
  )`);
  db.run(
    "INSERT INTO persona_jobs (id, owner, thread_id, title, goal, created_at, updated_at) VALUES ('old', 'alice', 't', 'old job', 'g', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')"
  );
  return db;
}

describe("ensurePersonaBudgetShape", () => {
  test("jobs that exist when budgets arrive get no limit, so none is over budget on deploy; re-running changes nothing", () => {
    const db = preBudgetDb();
    ensurePersonaBudgetShape(db);
    expect(db.query("SELECT budget_usd, budget_minutes FROM persona_jobs WHERE id = 'old'").get()).toEqual({
      budget_usd: 0,
      budget_minutes: 0,
    });
    // A job opened afterwards inherits the owner's layers (NULL), and a re-run leaves it so.
    db.run(
      "INSERT INTO persona_jobs (id, owner, thread_id, title, goal, created_at, updated_at) VALUES ('new', 'alice', 't', 'new job', 'g', '2026-10-08T00:00:00.000Z', '2026-10-08T00:00:00.000Z')"
    );
    ensurePersonaBudgetShape(db);
    expect(db.query("SELECT budget_usd, budget_minutes FROM persona_jobs WHERE id = 'new'").get()).toEqual({
      budget_usd: null,
      budget_minutes: null,
    });
    for (const table of ["persona_turns", "persona_turn_jobs", "persona_budget_prefs"]) {
      expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)).toEqual({ name: table });
    }
  });

  test("ending a waiting period adds it to waiting_ms", () => {
    const db = preBudgetDb();
    ensurePersonaBudgetShape(db);
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    db.run("UPDATE persona_jobs SET waiting_since = ? WHERE id = 'old'", [twoHoursAgo]);
    db.run("UPDATE persona_jobs SET waiting_since = NULL WHERE id = 'old'");
    const { waiting_ms } = db.query("SELECT waiting_ms FROM persona_jobs WHERE id = 'old'").get() as { waiting_ms: number };
    expect(waiting_ms).toBeGreaterThan(2 * 3_600_000 - 60_000);
    expect(waiting_ms).toBeLessThan(2 * 3_600_000 + 60_000);
  });
});
