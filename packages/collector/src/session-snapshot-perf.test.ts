import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createLaunch,
  createStore,
  deleteSession,
  getActor,
  getAllSessions,
  getLaunchBySession,
  getParticipants,
  getSilenceTicks,
  getSubagentSessions,
  insertEvent,
  isLaunchedSession,
  mergeActors,
  recordParticipant,
  upsertProject,
  type Store,
} from "@standup/store";
import { KnowledgeStore } from "@standup/knowledge";
import type { LaunchStatus, Session } from "@standup/shared";
import { buildSnapshot } from "./server.js";
import { isOpenPersonaWorker } from "./session-close.js";
import {
  currentEffortForSession,
  currentModelForSession,
  transcriptMemoSize,
  transcriptPathForSession,
} from "./transcript.js";

/**
 * The session decoration behind hello-ok and /api/sessions, over a history
 * shaped like a long-lived install: hundreds of sessions with thousands of
 * events each, half of them never carrying `$.effort`. Pins that a snapshot
 * costs a fixed number of queries rather than a handful per session, and that
 * the batched decoration reads exactly what the per-session lookups read.
 */

const SESSIONS = 500;
const SUBAGENTS = 40;
const LAUNCHES = 100;
const ITERATIONS = 20;

/** Deterministic PRNG so the fixture is identical run to run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function seed(store: Store): string[] {
  const db = store.db;
  const rand = rng(42);
  // buildSnapshot counts docs per project, so the knowledge tables must exist.
  new KnowledgeStore(db);
  upsertProject(db, { id: "perf", name: "perf", repos: [], branch: "main" } as never);

  const realTranscripts = mkdtempSync(join(tmpdir(), "standup-perf-transcripts-"));
  const missingTranscripts = join(realTranscripts, "missing");
  const ids: string[] = [];
  const insertSession = db.prepare(
    `INSERT INTO sessions (id, project_id, title, cwd, parent_session_id, status, kind, agent_type, agent_id, created_actor, owner_actor, started_at)
     VALUES (?, 'perf', ?, '/tmp/perf', ?, ?, ?, ?, ?, ?, ?, datetime('now', ?))`
  );
  const insertEventRow = db.prepare(
    "INSERT INTO events (session_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, datetime('now', ?))"
  );

  db.transaction(() => {
    for (let i = 0; i < SESSIONS + SUBAGENTS; i++) {
      const id = `s${String(i).padStart(4, "0")}`;
      const child = i >= SESSIONS;
      ids.push(id);
      insertSession.run(
        id,
        `session ${i}`,
        child ? `s${String(i - SESSIONS).padStart(4, "0")}` : null,
        i % 7 === 0 ? "running" : "done",
        child ? "subagent" : null,
        child ? "Explore" : null,
        child ? `agent-${i}` : null,
        i % 5 === 0 ? `alias${i % 4}` : null,
        i % 9 === 0 ? `slack:U${Math.floor(i / 9) % 3}` : null,
        `-${(SESSIONS - (i % SESSIONS)) * 60} minutes`
      );

      const events = 1000 + Math.floor(rand() * 1000);
      // Half the sessions never report effort (Codex, older payloads); a
      // tenth never report a transcript path. Both force the json_extract
      // lookups to scan the whole session.
      const hasEffort = i % 2 === 0;
      const hasPath = i % 10 !== 3;
      // Recent sessions land events inside the silence-meter window.
      const recent = i % 11 === 0;
      // A quarter of the sessions have real transcripts, a different model in
      // each half's file, so a wrong path reads as a wrong liveModel.
      const transcriptDir = i % 4 === 1 ? realTranscripts : missingTranscripts;
      if (hasPath && i % 4 === 1) {
        for (const half of ["a", "b"]) {
          const line = { type: "assistant", message: { role: "assistant", model: `model-${half}`, content: [] } };
          writeFileSync(join(realTranscripts, `${id}-${half}.jsonl`), `${JSON.stringify(line)}\n`);
        }
      }
      for (let seq = 1; seq <= events; seq++) {
        const payload: Record<string, unknown> = {
          session_id: id,
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: { command: `echo ${seq}` },
        };
        if (hasPath) payload.transcript_path = join(transcriptDir, `${id}-${seq > events / 2 ? "b" : "a"}.jsonl`);
        if (hasEffort && seq % 50 !== 0) payload.effort = { level: seq > events - 100 ? "high" : "medium" };
        const ageMinutes = recent ? Math.max(0, Math.floor((events - seq) / 40)) : 60 * 24 + (events - seq);
        insertEventRow.run(id, seq, "PostToolUse", JSON.stringify(payload), `-${ageMinutes} minutes`);
      }
    }
  })();

  // Launches: one per launched session, plus adopted duplicates sharing a
  // session id so the live-row preference is exercised.
  const harnesses = [undefined, "codex"] as const;
  const statuses: LaunchStatus[] = ["running", "cleaned", "failed", "starting"];
  for (let n = 0; n < LAUNCHES; n++) {
    const sessionId = ids[(n * 5) % SESSIONS]!;
    createLaunch(db, {
      id: `launch-${n}`,
      projectId: "perf",
      task: `task ${n}`,
      worktreePath: `/tmp/perf/wt-${n}`,
      branch: `b${n}`,
      sessionId,
      status: statuses[n % statuses.length],
      model: n % 3 === 0 ? "opus" : undefined,
      effort: n % 4 === 0 ? "high" : undefined,
      harness: harnesses[n % 2],
    } as never);
  }
  for (let n = 0; n < 10; n++) {
    db.run(
      "UPDATE launches SET created_at = datetime('now', ?) WHERE id = ?",
      [`-${n + 1} days`, `launch-${n}`]
    );
    createLaunch(db, {
      id: `adopted-${n}`,
      kind: "adopted",
      projectId: "perf",
      task: `adopted ${n}`,
      worktreePath: `/tmp/perf/wt-${n}`,
      branch: `b${n}`,
      sessionId: ids[(n * 5) % SESSIONS]!,
      status: n % 2 === 0 ? "cleaned" : "running",
    } as never);
  }

  // Participants and actor merges: a Slack identity folded into a user alias
  // must read as the alias wherever it appears.
  for (let n = 0; n < 150; n++) {
    const sessionId = ids[(n * 3) % ids.length]!;
    recordParticipant(db, sessionId, `alias${n % 4}`);
    recordParticipant(db, sessionId, `slack:U${n % 3}`);
  }
  mergeActors(db, "slack:U0", "alias0");
  mergeActors(db, "slack:U1", "alias1");

  return ids;
}

/** The per-session decoration as it read before batching: the reference output. */
function legacyTranscriptPath(db: Database, sessionId: string): string | null {
  const row = db
    .query(
      `SELECT json_extract(payload_json, '$.transcript_path') AS path FROM events
        WHERE session_id = ? AND json_extract(payload_json, '$.transcript_path') IS NOT NULL
        ORDER BY seq DESC LIMIT 1`
    )
    .get(sessionId) as { path: string | null } | null;
  return row?.path ?? null;
}

async function legacyDecorate(db: Database, session: Session): Promise<Session> {
  const transcriptPath = legacyTranscriptPath(db, session.id);
  const effortRow = db
    .query(
      `SELECT json_extract(payload_json, '$.effort.level') AS level FROM events
        WHERE session_id = ? AND json_extract(payload_json, '$.effort.level') IS NOT NULL
        ORDER BY seq DESC LIMIT 1`
    )
    .get(session.id) as { level: string | null } | null;
  const canonical = (id: string | undefined): string | undefined =>
    id ? getActor(db, id)?.id ?? id : id;
  const launch = getLaunchBySession(db, session.id);
  return {
    ...session,
    createdActor: canonical(session.createdActor),
    ownerActor: canonical(session.ownerActor),
    activityTicks: getSilenceTicks(db, session.id),
    participantActors: [
      ...new Set(getParticipants(db, session.id).map((p) => canonical(p.actorId)!)),
    ],
    owned: isLaunchedSession(db, session.id),
    personaWorker: !session.parentSessionId && isOpenPersonaWorker(db, session, launch),
    liveEffort: effortRow?.level ?? undefined,
    liveModel: (await currentModelForSession(transcriptPath)) ?? undefined,
    harness: launch?.harness,
    launchModel: launch?.model,
    launchEffort: launch?.effort,
  };
}

/** Counts statement executions issued through `db.query`. */
function countQueries(db: Database): { count: () => number; reset: () => void } {
  let n = 0;
  const original = db.query.bind(db);
  (db as { query: unknown }).query = (sql: string) => {
    const stmt = original(sql);
    return new Proxy(stmt, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== "function") return value;
        if (prop === "get" || prop === "all" || prop === "run" || prop === "values") {
          return (...args: unknown[]) => {
            n++;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return value.bind(target);
      },
    });
  };
  return { count: () => n, reset: () => (n = 0) };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

describe("session snapshot cost", () => {
  const store = createStore(":memory:");
  const ids = seed(store);
  const counter = countQueries(store.db);

  test("buildSnapshot runs a fixed number of queries, independent of session count", async () => {
    const times: number[] = [];
    const queries: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      counter.reset();
      const t0 = performance.now();
      const snap = await buildSnapshot(store);
      times.push(performance.now() - t0);
      queries.push(counter.count());
      expect(snap.sessions.length).toBe(ids.length);
    }
    const sessions = ids.length;
    console.log(
      `[snapshot-perf] sessions=${sessions} events≈${(store.db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n} ` +
        `cold=${times[0]!.toFixed(1)}ms/${queries[0]}q median=${median(times).toFixed(1)}ms ` +
        `medianQueries=${median(queries)} perSession=${(median(queries) / sessions).toFixed(2)}`
    );
    // Steady state: no per-session queries at all once the memo is warm.
    expect(median(queries)).toBeLessThan(40);
  }, 600_000);

  test("batched decoration matches the per-session lookups exactly", async () => {
    // Silence ticks are bucketed by wall-clock minute, so a minute rolling over
    // between the two reads shifts them; a rollover can't happen twice in a
    // row within a few seconds, so a second attempt settles it.
    let actual: Session[] = [];
    let expected: Session[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const minute = Math.floor(Date.now() / 60_000);
      actual = (await buildSnapshot(store)).sessions;
      const sessions = [...getAllSessions(store.db), ...getSubagentSessions(store.db)];
      expected = await Promise.all(sessions.map((s) => legacyDecorate(store.db, s)));
      if (Math.floor(Date.now() / 60_000) === minute) break;
    }
    expect(actual).toEqual(expected);
    // The path itself, memoized, for every session — not only where it resolves a model.
    for (const id of ids) {
      expect(transcriptPathForSession(store.db, id)).toBe(legacyTranscriptPath(store.db, id));
    }
    expect(expected.some((s) => s.liveModel === "model-b")).toBe(true);
    // The fixture actually exercises every field the decoration fills.
    expect(expected.some((s) => s.owned)).toBe(true);
    expect(expected.some((s) => s.harness === "codex")).toBe(true);
    expect(expected.some((s) => s.liveEffort === "high")).toBe(true);
    expect(expected.some((s) => s.liveEffort === undefined)).toBe(true);
    expect(expected.some((s) => s.activityTicks?.some(Boolean))).toBe(true);
    expect(expected.some((s) => s.participantActors?.includes("alias0"))).toBe(true);
    expect(expected.some((s) => s.ownerActor === "alias1")).toBe(true);
  }, 600_000);
});

describe("transcript path / effort memo", () => {
  test("picks up a newly arrived event and survives events without the field", () => {
    const store = createStore(":memory:");
    const db = store.db;
    upsertProject(db, { id: "p", name: "p", repos: [], branch: "main" } as never);
    db.run("INSERT INTO sessions (id, project_id, cwd, status) VALUES ('m1', 'p', '/tmp', 'running')");

    expect(transcriptPathForSession(db, "m1")).toBeNull();
    expect(currentEffortForSession(db, "m1")).toBeNull();

    insertEvent(db, "m1", "PostToolUse", { transcript_path: "/tmp/a.jsonl", effort: { level: "low" } });
    expect(transcriptPathForSession(db, "m1")).toBe("/tmp/a.jsonl");
    expect(currentEffortForSession(db, "m1")).toBe("low");

    insertEvent(db, "m1", "PostToolUse", { transcript_path: "/tmp/b.jsonl", effort: { level: "high" } });
    expect(transcriptPathForSession(db, "m1")).toBe("/tmp/b.jsonl");
    expect(currentEffortForSession(db, "m1")).toBe("high");

    // A newer event without either field leaves the last reported values.
    insertEvent(db, "m1", "Notification", { message: "waiting" });
    expect(transcriptPathForSession(db, "m1")).toBe("/tmp/b.jsonl");
    expect(currentEffortForSession(db, "m1")).toBe("high");
  });

  test("a deleted session leaves the memo, and one recreated under its id re-reads", async () => {
    const store = createStore(":memory:");
    const db = store.db;
    new KnowledgeStore(db);
    upsertProject(db, { id: "p", name: "p", repos: [], branch: "main" } as never);
    for (const id of ["d1", "d2"]) {
      db.run("INSERT INTO sessions (id, project_id, cwd, status) VALUES (?, 'p', '/tmp', 'done')", [id]);
      insertEvent(db, id, "PostToolUse", { transcript_path: `/tmp/${id}.jsonl`, effort: { level: "low" } });
    }
    await buildSnapshot(store);
    expect(transcriptMemoSize(db)).toBe(2);

    deleteSession(db, "d1");
    await buildSnapshot(store);
    expect(transcriptMemoSize(db)).toBe(1);

    // Same id, same seq as before the delete: the newest event's row id differs,
    // so the memo can't answer from the deleted session's events.
    expect(currentEffortForSession(db, "d2")).toBe("low");
    deleteSession(db, "d2");
    db.run("INSERT INTO sessions (id, project_id, cwd, status) VALUES ('d2', 'p', '/tmp', 'done')");
    insertEvent(db, "d2", "PostToolUse", { transcript_path: "/tmp/d2-new.jsonl" });
    expect(transcriptPathForSession(db, "d2")).toBe("/tmp/d2-new.jsonl");
    expect(currentEffortForSession(db, "d2")).toBeNull();
  });
});
