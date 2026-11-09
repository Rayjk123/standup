#!/usr/bin/env bun
/**
 * Stuckness heuristic report — the "demo mode" the design calls for before
 * nudging becomes default-on.
 *
 * Replays the stored event stream for each session and reports which
 * heuristics would have fired, without sending anything to any agent. The
 * point is to eyeball the false-positive rate: every firing here is a
 * sentence that would have been injected into a working agent's context.
 *
 *   bun run scripts/nudge-report.ts
 *
 * Judging a firing is a human call — look at what the session was actually
 * doing at that point. A "20 tool calls without an edit" on a session that
 * was legitimately exploring a new codebase is a false positive; the same
 * signal on one that had been looping on a failing test is not.
 */

import { homedir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import { detectStuckness } from "../packages/collector/src/stuckness.js";

const DB_PATH =
  process.env.DB_PATH ?? join(homedir(), ".local", "share", "standup", "standup.db");

interface SessionRow {
  id: string;
  title: string | null;
  status: string;
  project_id: string;
}

function main() {
  const db = new Database(DB_PATH, { readonly: true });

  const sessions = db
    .query("SELECT id, title, status, project_id FROM sessions ORDER BY started_at DESC")
    .all() as SessionRow[];

  if (sessions.length === 0) {
    console.log("No sessions recorded yet.");
    return;
  }

  console.log(`Stuckness report — ${sessions.length} session(s)\n${"=".repeat(64)}\n`);

  let fired = 0;

  for (const session of sessions) {
    const eventCount = (
      db
        .query("SELECT COUNT(*) as n FROM events WHERE session_id = ?")
        .get(session.id) as { n: number }
    ).n;

    const signal = detectStuckness(db, session.id);
    const label = `${session.project_id} · ${(session.title ?? "untitled").slice(0, 44)}`;

    if (signal) {
      fired++;
      console.log(`⚑ ${label}`);
      console.log(`    topic:  ${signal.topic}`);
      console.log(`    reason: ${signal.reason}`);
      console.log(`    events: ${eventCount}\n`);
    } else {
      console.log(`· ${label} — quiet (${eventCount} events)\n`);
    }
  }

  console.log("=".repeat(64));
  console.log(`${fired}/${sessions.length} session(s) would have been nudged.`);
  console.log(
    `\nEach firing is one sentence injected into a working agent. Review the` +
      `\nreasons above: if any look like normal work rather than being stuck,` +
      `\nraise the relevant threshold in STUCKNESS (packages/shared/src/constants.ts)` +
      `\nbefore enabling STANDUP_NUDGE=1.`
  );

  db.close();
}

main();
