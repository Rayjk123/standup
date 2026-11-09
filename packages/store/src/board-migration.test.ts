import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureBoardShape, runMigrations } from "./migrations.js";
import { createStore } from "./store.js";
import {
  DEFAULT_CLOSED_BOARD_TASKS,
  boardJobIdsToReconcile,
  boardJobLinkedByBacklog,
  boardTicketIdsToReconcile,
  boardUnrefinedJobIds,
  getBoardTask,
  listBoardTaskPage,
  listBoardTasks,
  listBoardTasksByJob,
  upsertBoardTask,
} from "./queries/board.js";

const REVIEW_URL = "https://git.example.com/acme/app/pull/1";

function seeded() {
  const store = createStore(":memory:");
  const db = store.db;
  db.run("INSERT INTO projects (id, name) VALUES ('p1', 'Project one')");
  const ticket = (id: string, status: string, extra: Record<string, string | null> = {}) => {
    db.run(
      `INSERT INTO tickets (id, project_id, lens, title, body, status, launch_id, session_id, review_url, shipped_at, dismissed_at, created_at, updated_at)
       VALUES (?, 'p1', 'bugs', ?, 'ticket body', ?, ?, ?, ?, ?, ?, '2026-10-01 10:00:00', '2026-10-02 11:00:00')`,
      [
        id,
        `Ticket ${id}`,
        status,
        extra.launch_id ?? null,
        extra.session_id ?? null,
        extra.review_url ?? null,
        extra.shipped_at ?? null,
        extra.dismissed_at ?? null,
      ]
    );
  };
  ticket("t-proposed", "proposed");
  ticket("t-approved", "approved");
  ticket("t-developing", "developing", { launch_id: "L1", session_id: "S1" });
  ticket("t-review", "needs_review", { review_url: REVIEW_URL });
  ticket("t-shipped", "shipped", { shipped_at: "2026-10-03 09:00:00" });
  ticket("t-dismissed", "dismissed", { dismissed_at: "2026-10-04 09:00:00" });
  const job = (id: string, status: string) =>
    db.run(
      `INSERT INTO persona_jobs (id, owner, thread_id, title, goal, status, created_at, updated_at)
       VALUES (?, 'alice', 'th', ?, 'the goal', ?, '2026-10-01T00:00:00.000Z', '2026-10-05T00:00:00.000Z')`,
      [id, `Job ${id}`, status]
    );
  for (const s of ["active", "waiting_user", "done", "failed", "cancelled"]) job(`j-${s}`, s);
  db.run(
    "INSERT INTO launches (id, project_id, task, worktree_path, branch) VALUES ('LJ', 'p1', 'task', '/tmp/board-wt-LJ', 'b')"
  );
  db.run("INSERT INTO persona_job_launches (job_id, launch_id, created_at) VALUES ('j-active', 'LJ', '2026-10-01T00:00:00.000Z')");
  return { store, db };
}

const snapshot = (db: Database) => db.query("SELECT * FROM board_tasks ORDER BY id").all();

describe("migration 082 board backfill", () => {
  test("every ticket and job gets a card with its stored status's column", () => {
    const { db } = seeded();
    ensureBoardShape(db);
    const col = (id: string) => getBoardTask(db, id);

    expect(col("ticket:t-proposed")).toMatchObject({ status: "queued", waitingOn: "owner approval", owner: "", projectId: "p1" });
    expect(col("ticket:t-approved")?.status).toBe("queued");
    expect(col("ticket:t-approved")?.waitingOn).toBeUndefined();
    expect(col("ticket:t-developing")).toMatchObject({
      status: "coding",
      links: { ticketId: "t-developing", launchIds: ["L1"], sessionIds: ["S1"] },
    });
    expect(col("ticket:t-review")).toMatchObject({
      status: "in_review",
      waitingOn: "owner review",
      links: { ticketId: "t-review", codeReview: { url: REVIEW_URL } },
    });
    expect(col("ticket:t-shipped")).toMatchObject({ status: "done", closedAt: "2026-10-03T09:00:00.000Z" });
    expect(col("ticket:t-dismissed")).toMatchObject({ status: "failed", flag: "cancelled", closedAt: "2026-10-04T09:00:00.000Z" });
    expect(col("ticket:t-proposed")?.createdAt).toBe("2026-10-01T10:00:00.000Z");
    expect(col("ticket:t-proposed")?.goal).toBe("ticket body");
    expect(col("ticket:t-proposed")?.areas).toEqual({ files: [], packages: [] });

    expect(col("job:j-active")).toMatchObject({ status: "queued", owner: "alice", projectId: "p1", links: { jobId: "j-active" } });
    expect(col("job:j-active")?.closedAt).toBeUndefined();
    expect(col("job:j-waiting_user")).toMatchObject({ status: "waiting", waitingOn: "the owner" });
    expect(col("job:j-done")).toMatchObject({ status: "done", closedAt: "2026-10-05T00:00:00.000Z" });
    expect(col("job:j-failed")?.status).toBe("failed");
    expect(col("job:j-cancelled")).toMatchObject({ status: "failed", flag: "cancelled" });
    expect(listBoardTasks(db)).toHaveLength(11);
  });

  test("re-running adds nothing and changes nothing", () => {
    const { db } = seeded();
    ensureBoardShape(db);
    const before = snapshot(db);
    ensureBoardShape(db);
    expect(snapshot(db)).toEqual(before);
  });

  test("a card the adapter refined is not clobbered by a re-run", () => {
    const { db } = seeded();
    ensureBoardShape(db);
    upsertBoardTask(db, {
      source: "job",
      sourceId: "j-active",
      owner: "alice",
      projectId: "p1",
      title: "Job j-active",
      status: "validation",
      stage: "validation",
      links: { jobId: "j-active", runId: "r1" },
      areas: { files: ["packages/a/src/x.ts"], packages: ["packages/a"] },
    });
    ensureBoardShape(db);
    expect(getBoardTask(db, "job:j-active")).toMatchObject({ status: "validation", stage: "validation", links: { runId: "r1" } });
  });

  test("a closed backfilled card refined by reconcile keeps its updated_at and its place", () => {
    const { db } = seeded();
    ensureBoardShape(db);
    upsertBoardTask(db, { source: "job", sourceId: "newer", owner: "alice", title: "Newer", status: "done", links: { jobId: "newer" }, areas: { files: [], packages: [] } }, "2026-10-06T00:00:00.000Z");
    const closedOrder = () => listBoardTasks(db, { owner: "alice", status: ["done", "failed"] }).map((t) => t.id);
    const before = getBoardTask(db, "job:j-done")!;
    const order = closedOrder();
    expect(order[0]).toBe("job:newer");
    // The adapter's projection: the same column, now with its stage, links and areas filled in.
    const refined = upsertBoardTask(
      db,
      {
        source: "job",
        sourceId: "j-done",
        owner: "alice",
        projectId: "p1",
        title: "Job j-done",
        goal: "the goal",
        status: "done",
        stage: "complete",
        links: { jobId: "j-done", launchIds: [], runId: "r9" },
        areas: { files: ["packages/a/src/x.ts"], packages: ["packages/a"] },
      },
      "2026-10-12T00:00:00.000Z"
    );
    expect(refined.changed).toBe(true);
    expect(refined.task).toMatchObject({ stage: "complete", links: { runId: "r9" }, updatedAt: before.updatedAt, closedAt: before.closedAt });
    expect(boardUnrefinedJobIds(db)).not.toContain("j-done");
    expect(closedOrder()).toEqual(order);
    // Moving to another closed column is a change of place.
    const failed = upsertBoardTask(db, { ...refined.task, status: "failed" }, "2026-10-12T01:00:00.000Z");
    expect(failed.task.updatedAt).toBe("2026-10-12T01:00:00.000Z");
    expect(closedOrder()[0]).toBe("job:j-done");
  });

  test("an empty database and one without the source tables backfill nothing", () => {
    const { db } = { db: createStore(":memory:").db };
    ensureBoardShape(db);
    expect(listBoardTasks(db)).toEqual([]);

    const bare = new Database(":memory:");
    ensureBoardShape(bare);
    ensureBoardShape(bare);
    expect(bare.query("SELECT COUNT(*) AS n FROM board_tasks").get()).toEqual({ n: 0 });
  });

  test("runMigrations on a migrated database (ensureSchemaRepairs) leaves the cards as they are", () => {
    const { db } = seeded();
    ensureBoardShape(db);
    const before = snapshot(db);
    runMigrations(db);
    runMigrations(db);
    expect(snapshot(db)).toEqual(before);
    expect(db.query("SELECT version FROM schema_version WHERE version = 82").get()).toEqual({ version: 82 });
  });
});

describe("board task queries", () => {
  const base = {
    source: "job" as const,
    sourceId: "x",
    owner: "alice",
    title: "Board work",
    status: "coding" as const,
    links: { jobId: "x" },
    areas: { files: ["packages/web/src/Board.tsx"], packages: ["packages/web"] },
  };

  test("upsert reports changed only when a stored field differs, keeps created_at and stamps closed_at", () => {
    const db = createStore(":memory:").db;
    const first = upsertBoardTask(db, base, "2026-10-01T00:00:00.000Z");
    expect(first.changed).toBe(true);
    expect(first.task.id).toBe("job:x");
    // Same content with links in another key order and an empty array is no change.
    const same = upsertBoardTask(db, { ...base, links: { sessionIds: [], jobId: "x" } }, "2026-10-02T00:00:00.000Z");
    expect(same.changed).toBe(false);
    expect(same.task.updatedAt).toBe("2026-10-01T00:00:00.000Z");
    // An empty launchIds is kept, though: it marks a card the adapter projected (refined).
    const refined = upsertBoardTask(db, { ...base, links: { launchIds: [], jobId: "x" } }, "2026-10-02T12:00:00.000Z");
    expect(refined.changed).toBe(true);
    expect(refined.task.links).toEqual({ jobId: "x", launchIds: [] });
    expect(boardUnrefinedJobIds(db)).toEqual([]);
    const again = upsertBoardTask(db, { ...base, links: { jobId: "x", launchIds: [] } }, "2026-10-02T18:00:00.000Z");
    expect(again.changed).toBe(false);

    const done = upsertBoardTask(db, { ...base, status: "done" }, "2026-10-03T00:00:00.000Z");
    expect(done).toMatchObject({ changed: true, task: { createdAt: "2026-10-01T00:00:00.000Z", closedAt: "2026-10-03T00:00:00.000Z" } });
    // Staying closed keeps the first close time.
    const failed = upsertBoardTask(db, { ...base, status: "failed" }, "2026-10-04T00:00:00.000Z");
    expect(failed.task.closedAt).toBe("2026-10-03T00:00:00.000Z");
    const reopened = upsertBoardTask(db, base, "2026-10-05T00:00:00.000Z");
    expect(reopened.task.closedAt).toBeUndefined();
  });

  test("a page of closed tasks: before a cursor, capped, with whether more match — filtered or not", () => {
    const db = createStore(":memory:").db;
    for (let i = 0; i < 4; i++) {
      upsertBoardTask(db, { ...base, sourceId: `d${i}`, title: i % 2 ? "Odd landed" : "Even landed", status: "done", links: { jobId: `d${i}` } }, `2026-01-0${i + 1}T00:00:00.000Z`);
    }
    upsertBoardTask(db, { ...base, sourceId: "open", links: { jobId: "open" } });
    const page = listBoardTaskPage(db, { owner: "alice", closedLimit: 2 });
    expect(page.tasks.map((t) => t.sourceId)).toEqual(["open", "d3", "d2"]);
    expect(page.closedMore).toBe(true);
    const older = listBoardTaskPage(db, { owner: "alice", closedBefore: "2026-01-03T00:00:00.000Z", closedLimit: 2 });
    expect(older).toEqual({ tasks: expect.any(Array), closedMore: false });
    expect(older.tasks.map((t) => t.sourceId)).toEqual(["d1", "d0"]);
    // A text filter matches in JS before the cap, and still tells whether more match.
    const odd = listBoardTaskPage(db, { owner: "alice", text: "odd", closedLimit: 1 });
    expect(odd.tasks.map((t) => t.sourceId)).toEqual(["d3"]);
    expect(odd.closedMore).toBe(true);
    expect(listBoardTaskPage(db, { owner: "alice", text: "odd", closedLimit: 2 }).closedMore).toBe(false);
  });

  test("closed tasks tied on updated_at page by id: every one exactly once, in the list's order", () => {
    const db = createStore(":memory:").db;
    const at = "2026-01-01T00:00:00.000Z";
    for (const id of ["c", "a", "e", "b", "d"]) upsertBoardTask(db, { ...base, sourceId: id, status: "done", links: { jobId: id } }, at);
    const listed = listBoardTasks(db, { owner: "alice" }).map((t) => t.id);
    expect(listed).toEqual(["job:e", "job:d", "job:c", "job:b", "job:a"]);
    const seen: string[] = [];
    let cursor: { at: string; id: string } | undefined;
    for (let i = 0; i < 5; i++) {
      const page = listBoardTaskPage(db, {
        owner: "alice",
        closedLimit: 2,
        ...(cursor ? { closedBefore: cursor.at, closedBeforeId: cursor.id } : {}),
      });
      seen.push(...page.tasks.map((t) => t.id));
      if (!page.closedMore) break;
      const last = page.tasks.at(-1)!;
      cursor = { at: last.updatedAt, id: last.id };
    }
    expect(seen).toEqual(listed);
    // A strict cursor (no id) skips everything tied on it.
    expect(listBoardTaskPage(db, { owner: "alice", closedBefore: at }).tasks).toEqual([]);
  });

  test("only a backlog card of the job's owner hides the job's card; a team-wide one never does", () => {
    const db = createStore(":memory:").db;
    upsertBoardTask(db, base);
    upsertBoardTask(db, { ...base, source: "backlog", sourceId: "team-item", owner: "", title: "Team item", links: { backlogItemId: "team-item", jobId: "x" } });
    expect(boardJobLinkedByBacklog(db, "x", "alice")).toBe(false);
    expect(listBoardTasks(db, { owner: "alice", includeShared: true, hideLinkedJobs: true }).map((t) => t.id).sort()).toEqual(["backlog:team-item", "job:x"]);
    upsertBoardTask(db, { ...base, source: "backlog", sourceId: "bobs-item", owner: "bob", title: "Bob's item", links: { backlogItemId: "bobs-item", jobId: "x" } });
    expect(listBoardTasks(db, { owner: "alice", hideLinkedJobs: true }).map((t) => t.id)).toEqual(["job:x"]);
    upsertBoardTask(db, { ...base, source: "backlog", sourceId: "mine", owner: "alice", title: "My item", links: { backlogItemId: "mine", jobId: "x" } });
    expect(boardJobLinkedByBacklog(db, "x", "alice")).toBe(true);
    expect(listBoardTasks(db, { owner: "alice", includeShared: true, hideLinkedJobs: true }).map((t) => t.id).sort()).toEqual(["backlog:mine", "backlog:team-item"]);
  });

  test("backlog cards linking a job: found by job, standing in for its card in scoped and hiding reads", () => {
    const db = createStore(":memory:").db;
    upsertBoardTask(db, base);
    upsertBoardTask(db, { ...base, source: "backlog", sourceId: "item", title: "Backlog item", links: { backlogItemId: "item", jobId: "x" } });
    expect(listBoardTasksByJob(db, "x").map((t) => t.id)).toEqual(["backlog:item"]);
    expect(listBoardTasksByJob(db, "nope")).toEqual([]);
    expect(listBoardTasks(db, { owner: "alice" }).map((t) => t.id).sort()).toEqual(["backlog:item", "job:x"]);
    expect(listBoardTasks(db, { owner: "alice", hideLinkedJobs: true }).map((t) => t.id)).toEqual(["backlog:item"]);
    expect(listBoardTasks(db, { owner: "alice", jobIds: ["x"], hideLinkedJobs: true }).map((t) => t.id)).toEqual(["backlog:item"]);
    // A job a backlog card links is reconciled, which refreshes that card.
    expect(boardJobIdsToReconcile(db, "2099-01-01T00:00:00.000Z")).toContain("x");
  });

  test("list filters by owner (with team-wide tasks), status, source, project, text and files", () => {
    const db = createStore(":memory:").db;
    upsertBoardTask(db, { ...base, projectId: "web" });
    upsertBoardTask(db, { ...base, sourceId: "y", owner: "bob", title: "Bob's work", links: { jobId: "y" } });
    upsertBoardTask(db, {
      ...base,
      source: "ticket",
      sourceId: "t",
      owner: "",
      title: "Team ticket",
      status: "done",
      links: { ticketId: "t" },
      areas: { files: [], packages: [] },
    });
    const ids = (q: Parameters<typeof listBoardTasks>[1]) => listBoardTasks(db, q).map((t) => t.id).sort();
    expect(ids({ owner: "alice" })).toEqual(["job:x"]);
    expect(ids({ owner: "alice", includeShared: true })).toEqual(["job:x", "ticket:t"]);
    expect(ids({ owner: "alice", includeShared: true, includeClosed: false })).toEqual(["job:x"]);
    expect(ids({ status: ["done"] })).toEqual(["ticket:t"]);
    expect(ids({ source: ["job"] })).toEqual(["job:x", "job:y"]);
    expect(ids({ projectId: "web" })).toEqual(["job:x"]);
    expect(ids({ text: "bob" })).toEqual(["job:y"]);
    expect(ids({ owner: "alice", files: ["packages/web/src"] })).toEqual(["job:x"]);
  });

  test("every open task is listed however old, and only the most recent closed ones up to the cap", () => {
    const db = createStore(":memory:").db;
    upsertBoardTask(db, { ...base, sourceId: "old-open", links: { jobId: "old-open" } }, "2020-01-01T00:00:00.000Z");
    for (let i = 0; i < DEFAULT_CLOSED_BOARD_TASKS + 50; i++) {
      const at = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      upsertBoardTask(db, { ...base, sourceId: `c${i}`, status: "done", links: { jobId: `c${i}` } }, at);
    }
    const all = listBoardTasks(db, { owner: "alice" });
    expect(all).toHaveLength(DEFAULT_CLOSED_BOARD_TASKS + 1);
    expect(all.map((t) => t.id)).toContain("job:old-open");
    // Most recently updated first: the newest closed task leads, the old open one comes last.
    expect(all[0]!.id).toBe(`job:c${DEFAULT_CLOSED_BOARD_TASKS + 49}`);
    expect(all.at(-1)!.id).toBe("job:old-open");
    expect(all.map((t) => t.id)).not.toContain("job:c0");
    expect(listBoardTasks(db, { owner: "alice", closedLimit: 5 })).toHaveLength(6);
    // A text filter applies before the closed cap.
    upsertBoardTask(db, { ...base, sourceId: "needle", title: "needle", status: "done", links: { jobId: "needle" } }, "2019-01-01T00:00:00.000Z");
    expect(listBoardTasks(db, { owner: "alice", text: "needle" }).map((t) => t.id)).toEqual(["job:needle"]);
  });

  test("jobIds narrows to those jobs' cards in SQL, before any cap", () => {
    const db = createStore(":memory:").db;
    upsertBoardTask(db, { ...base, sourceId: "mine", status: "done", links: { jobId: "mine" } }, "2019-01-01T00:00:00.000Z");
    for (let i = 0; i < DEFAULT_CLOSED_BOARD_TASKS + 10; i++) {
      upsertBoardTask(db, { ...base, sourceId: `n${i}`, status: "done", links: { jobId: `n${i}` } });
    }
    expect(listBoardTasks(db, { owner: "alice", jobIds: ["mine"] }).map((t) => t.id)).toEqual(["job:mine"]);
    expect(listBoardTasks(db, { owner: "alice", jobIds: [] })).toEqual([]);
  });
});

describe("board reconcile ids", () => {
  test("tickets: every open one, and closed ones whose card disagrees with their status", () => {
    const { db } = seeded();
    ensureBoardShape(db);
    expect(boardTicketIdsToReconcile(db).sort()).toEqual(["t-approved", "t-developing", "t-proposed", "t-review"]);
    db.run("UPDATE board_tasks SET status = 'in_review' WHERE id = 'ticket:t-shipped'");
    db.run("UPDATE board_tasks SET status = 'coding' WHERE id = 'ticket:t-dismissed'");
    expect(boardTicketIdsToReconcile(db)).toEqual(expect.arrayContaining(["t-shipped", "t-dismissed"]));
  });

  test("jobs: open ones, recently closed ones, and long-closed ones whose card is still open", () => {
    const { db } = seeded();
    ensureBoardShape(db);
    expect(boardJobIdsToReconcile(db, "2026-10-06T00:00:00.000Z").sort()).toEqual(["j-active", "j-waiting_user"]);
    db.run("UPDATE board_tasks SET status = 'coding' WHERE id = 'job:j-done'");
    expect(boardJobIdsToReconcile(db, "2026-10-06T00:00:00.000Z").sort()).toEqual(["j-active", "j-done", "j-waiting_user"]);
  });
});
