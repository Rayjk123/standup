import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "@standup/store";
import { detectStuckness } from "./stuckness.js";

/**
 * Synthetic stuck-session fixtures.
 *
 * The demo-mode report showing "0 sessions would be nudged" is only
 * meaningful if the heuristics can fire at all — a detector that never
 * triggers has a perfect false-positive rate and no value. These construct
 * each stuck pattern deliberately and assert it's caught, so the real-data
 * quiet result can be trusted as signal rather than breakage.
 */

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  db.run(
    "INSERT INTO projects (id, name, branch, repos_json) VALUES ('p', 'p', 'main', '[]')"
  );
  db.run(
    "INSERT INTO sessions (id, project_id, cwd, status) VALUES ('s', 'p', '/tmp', 'running')"
  );
  return db;
}

let seq = 0;
function addToolEvent(
  db: Database,
  type: "PreToolUse" | "PostToolUse",
  payload: Record<string, unknown>
) {
  db.run(
    "INSERT INTO events (session_id, seq, type, payload_json) VALUES ('s', ?, ?, ?)",
    [++seq, type, JSON.stringify(payload)]
  );
}

describe("stuckness detection", () => {
  test("fires on the same search returning nothing repeatedly", () => {
    const db = freshDb();
    seq = 0;

    for (let i = 0; i < 4; i++) {
      addToolEvent(db, "PreToolUse", {
        tool_name: "Grep",
        tool_input: { pattern: "handleRetryPolicy" },
      });
      addToolEvent(db, "PostToolUse", {
        tool_name: "Grep",
        tool_input: { pattern: "handleRetryPolicy" },
        tool_response: "No matches found",
      });
    }

    const signal = detectStuckness(db, "s");
    expect(signal?.topic).toBe("search");
    db.close();
  });

  test("fires on consecutive failing shell commands", () => {
    const db = freshDb();
    seq = 0;

    for (let i = 0; i < 6; i++) {
      addToolEvent(db, "PreToolUse", {
        tool_name: "Bash",
        tool_input: { command: "bun test" },
      });
      addToolEvent(db, "PostToolUse", {
        tool_name: "Bash",
        tool_input: { command: "bun test" },
        tool_response: { is_error: true, output: "exit code 1" },
      });
    }

    const signal = detectStuckness(db, "s");
    expect(signal?.topic).toBe("bash");
    db.close();
  });

  test("fires on the same file read over and over", () => {
    const db = freshDb();
    seq = 0;

    for (let i = 0; i < 5; i++) {
      addToolEvent(db, "PreToolUse", {
        tool_name: "Read",
        tool_input: { file_path: "/repo/src/policy.ts" },
      });
    }

    const signal = detectStuckness(db, "s");
    expect(signal?.topic).toBe("reread");
    db.close();
  });

  test("fires on a long read-only chain", () => {
    const db = freshDb();
    seq = 0;

    // Distinct files, so this is the read-only heuristic rather than reread.
    for (let i = 0; i < 25; i++) {
      addToolEvent(db, "PreToolUse", {
        tool_name: "Read",
        tool_input: { file_path: `/repo/src/file-${i}.ts` },
      });
    }

    const signal = detectStuckness(db, "s");
    expect(signal?.topic).toBe("reading");
    db.close();
  });

  test("an edit resets the read-only chain", () => {
    const db = freshDb();
    seq = 0;

    for (let i = 0; i < 15; i++) {
      addToolEvent(db, "PreToolUse", {
        tool_name: "Read",
        tool_input: { file_path: `/repo/src/a-${i}.ts` },
      });
    }
    addToolEvent(db, "PreToolUse", {
      tool_name: "Edit",
      tool_input: { file_path: "/repo/src/a-0.ts" },
    });
    for (let i = 0; i < 5; i++) {
      addToolEvent(db, "PreToolUse", {
        tool_name: "Read",
        tool_input: { file_path: `/repo/src/b-${i}.ts` },
      });
    }

    expect(detectStuckness(db, "s")).toBeNull();
    db.close();
  });

  test("stays quiet on healthy read-then-edit work", () => {
    const db = freshDb();
    seq = 0;

    for (let i = 0; i < 10; i++) {
      addToolEvent(db, "PreToolUse", {
        tool_name: "Read",
        tool_input: { file_path: `/repo/src/x-${i}.ts` },
      });
      addToolEvent(db, "PreToolUse", {
        tool_name: "Edit",
        tool_input: { file_path: `/repo/src/x-${i}.ts` },
      });
      addToolEvent(db, "PostToolUse", {
        tool_name: "Bash",
        tool_input: { command: "bun test" },
        tool_response: "2 pass, 0 fail",
      });
    }

    expect(detectStuckness(db, "s")).toBeNull();
    db.close();
  });

  test("stays quiet when searches actually find things", () => {
    const db = freshDb();
    seq = 0;

    for (let i = 0; i < 5; i++) {
      addToolEvent(db, "PostToolUse", {
        tool_name: "Grep",
        tool_input: { pattern: "retry" },
        tool_response: "src/policy.ts:14: export function retry()",
      });
    }

    expect(detectStuckness(db, "s")).toBeNull();
    db.close();
  });
});
