import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { MIGRATIONS } from "./migrations.js";

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
