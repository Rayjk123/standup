import { describe, expect, test } from "bun:test";
import type { BoardTaskInput } from "@standup/shared";
import {
  DEFAULT_CLOSED_BOARD_TASKS,
  createLaunch,
  createPersonaJob,
  createStore,
  getOrCreatePersonaThreadByRef,
  personaJobForLaunch,
  upsertBoardTask,
  upsertProject,
} from "@standup/store";
import { createBoard, type Board } from "../board/board.js";
import { resolvePersonaConfig } from "./config.js";
import { READ_ACTIONS, decide } from "./policy.js";
import { PersonaRuntime } from "./runtime.js";
import { PERSONA_TOOLS } from "./tools.js";

const OWNER = "alice";

function task(sourceId: string, over: Partial<BoardTaskInput> = {}): BoardTaskInput {
  return {
    source: "job",
    sourceId,
    owner: OWNER,
    projectId: "p",
    title: `Task ${sourceId}`,
    status: "coding",
    links: { jobId: sourceId },
    areas: { files: [], packages: [] },
    ...over,
  };
}

function harness() {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  const runtime = new PersonaRuntime({
    db: store.db,
    owner: OWNER,
    config: { ...resolvePersonaConfig({}), maxActive: 5 },
    broadcast: () => {},
    turnRunner: async () => ({ ok: true, text: "ok", sessionId: "sid", contextTokens: 1 }),
  });
  runtime.bindApp({
    request: async (path: string, init?: RequestInit) => {
      if (!/\/launch$/.test(path)) return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
      const body = JSON.parse(String(init?.body ?? "{}")) as { task: string };
      createLaunch(store.db, { id: "L1", projectId: "p", task: body.task, worktreePath: "/wt/L1", branch: "b", launchedBy: OWNER });
      return new Response(JSON.stringify({ launch: { id: "L1", projectId: "p", status: "starting", branch: "b" } }), { status: 200 });
    },
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await runtime.tools.call(name, args);
    const text = result.content[0]!.text;
    return { isError: result.isError === true, text, json: () => JSON.parse(text) as Record<string, any> };
  };
  const db = store.db;
  upsertBoardTask(
    db,
    task("retry", {
      title: "Make webhook retries idempotent",
      goal: "Deduplicate webhook delivery retries with an idempotency key",
      status: "in_review",
      waitingOn: "owner review of the packet",
      links: { jobId: "retry", packetId: "pk1", codeReview: { id: "R-9" } },
      areas: { files: Array.from({ length: 12 }, (_, i) => `packages/collector/src/webhook/f${i}.ts`), packages: ["packages/collector"] },
    })
  );
  upsertBoardTask(db, task("ui", { title: "Board tab UI", status: "validation", areas: { files: ["packages/web/src/Board.tsx"], packages: ["packages/web"] } }));
  upsertBoardTask(db, task("landed", { title: "Landed webhook work", status: "done" }));
  upsertBoardTask(db, task("bob", { owner: "bob", title: "Bob's webhook retries" }));
  return { store, call, runtime };
}

describe("search_board", () => {
  test("is a read in Persona's catalog", () => {
    expect(PERSONA_TOOLS.some((t) => t.name === "search_board")).toBe(true);
    expect(READ_ACTIONS.has("search_board")).toBe(true);
    expect(decide("search_board").rule).toBe("act");
  });

  test("returns the owner's open tasks, compact, with files capped; closed only on request", async () => {
    const h = harness();
    const open = (await h.call("search_board")).json();
    expect(open.tasks.map((t: { id: string }) => t.id).sort()).toEqual(["job:retry", "job:ui"]);
    const retry = open.tasks.find((t: { id: string }) => t.id === "job:retry");
    expect(retry).toMatchObject({
      title: "Make webhook retries idempotent",
      project: "p",
      status: "in_review",
      waitingOn: "owner review of the packet",
      jobId: "retry",
      packetId: "pk1",
      codeReview: "R-9",
      moreFiles: 2,
    });
    expect(retry.files).toHaveLength(10);
    const all = (await h.call("search_board", { includeClosed: true })).json();
    expect(all.tasks.map((t: { id: string }) => t.id)).toContain("job:landed");
    expect(JSON.stringify(all)).not.toContain("Bob's");
  });

  test("filters by status, text and files, and refuses an unknown status", async () => {
    const h = harness();
    const ids = async (args: Record<string, unknown>) =>
      (await h.call("search_board", args)).json().tasks.map((t: { id: string }) => t.id).sort();
    expect(await ids({ status: ["validation"] })).toEqual(["job:ui"]);
    expect(await ids({ text: "webhook" })).toEqual(["job:retry"]);
    expect(await ids({ files: ["packages/web"] })).toEqual(["job:ui"]);
    const bad = await h.call("search_board", { status: ["nope"] });
    expect(bad.isError).toBe(true);
  });

  test("conflictsWith ranks colliding open tasks with a reason line", async () => {
    const h = harness();
    const out = (
      await h.call("search_board", {
        conflictsWith: { project: "p", title: "Idempotent webhook retries", files: ["packages/collector/src/webhook/f3.ts"] },
      })
    ).json();
    expect(out.conflicts[0]).toMatchObject({ taskId: "job:retry", jobId: "retry" });
    expect(out.conflicts[0].score).toBeGreaterThanOrEqual(0.6);
    expect(out.conflicts[0].why).toContain("files packages/collector/src/webhook/f3.ts");
    expect(out.conflicts[0].why).toContain("similar goal");
    const own = (await h.call("search_board", { conflictsWith: { title: "Idempotent webhook retries", jobId: "retry" } })).json();
    expect(own.conflicts.map((c: { taskId: string }) => c.taskId)).not.toContain("job:retry");
  });
});

describe("search_board through the collector's Board", () => {
  test("reads the injected Board's list and conflicts, never the store alone", async () => {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
    const real = createBoard({ db: store.db, publish: () => {} });
    const calls: string[] = [];
    const board: Board = {
      ...real,
      list: (q) => {
        calls.push("list");
        return real.list(q);
      },
      conflicts: (owner, probe, scope) => {
        calls.push("conflicts");
        return real.conflicts(owner, probe, scope);
      },
    };
    const runtime = new PersonaRuntime({
      db: store.db,
      owner: OWNER,
      config: resolvePersonaConfig({}),
      broadcast: () => {},
      turnRunner: async () => ({ ok: true, text: "ok", sessionId: "sid", contextTokens: 1 }),
      board,
    });
    board.upsert(task("j1", { title: "Board tab" }));
    // A job card a backlog card links reads as the backlog card.
    board.upsert({ ...task("item-1", { title: "Backlog: board tab", links: { backlogItemId: "item-1", jobId: "j1" } }), source: "backlog" });
    const result = await runtime.tools.call("search_board", { conflictsWith: { title: "Board tab polish" } });
    const out = JSON.parse(result.content[0]!.text) as { tasks: Array<{ id: string }>; conflicts: unknown[] };
    expect(calls).toEqual(["list", "conflicts"]);
    expect(out.tasks.map((t) => t.id)).toEqual(["backlog:item-1"]);
  });
});

describe("search_board in a shared thread", () => {
  test("sees only the thread's own jobs' cards, however many other closed cards are newer", async () => {
    const h = harness();
    const db = h.store.db;
    const thread = getOrCreatePersonaThreadByRef(db, OWNER, "slack", "C1:1.1", "#team", "shared");
    const job = createPersonaJob(db, { owner: OWNER, threadId: thread.id, title: "Thread job", goal: "g" });
    upsertBoardTask(db, task(job.id, { title: "Thread job", status: "done", links: { jobId: job.id } }), "2019-01-01T00:00:00.000Z");
    for (let i = 0; i < DEFAULT_CLOSED_BOARD_TASKS + 20; i++) upsertBoardTask(db, task(`other${i}`, { status: "done" }));
    // The running turn's thread is the shared one.
    (h.runtime as unknown as { turnThreadId?: string }).turnThreadId = thread.id;
    const out = (await h.call("search_board", { includeClosed: true })).json();
    expect(out.tasks.map((t: { id: string }) => t.id)).toEqual([`job:${job.id}`]);
  });
});

describe("launch_session and the board", () => {
  test("a launch whose task collides with work in flight notes it, without refusing", async () => {
    const h = harness();
    const result = await h.call("launch_session", {
      task: "Make the webhook delivery retries idempotent with a dedup key",
      projectId: "p",
    });
    expect(result.isError).toBe(false);
    const out = result.json();
    expect(personaJobForLaunch(h.store.db, "L1")?.job.id).toBe(out.jobId);
    expect(out.boardConflicts).toHaveLength(1);
    expect(out.boardConflicts[0]).toContain("Make webhook retries idempotent [in_review]");
    expect(out.note).toContain("Potential conflicts on the board: Make webhook retries idempotent");
  });

  describe("with realistic multi-paragraph briefs", () => {
    const LIFECYCLE_BRIEF = [
      "Goal: make the Board's task cards in the Standup console show where each Persona job really is. The card's column is derived in deriveBoardStatus (packages/shared/src/board.ts) from the job's pipeline runs, review packets and launches; the projection in packages/collector/src/board/projection.ts gathers those facts and the board adapter reprojects a card on every pipeline, review and launch frame.",
      "Acceptance: a job whose worker submitted its review packet sits In review until the owner decides it; a blocked pipeline run reads Persona deciding in its stage column; a parked run stays in its column flagged parked. Board lifecycle tests in board.test.ts and the adapter tests cover each column.",
      "Constraints: run bun test for the board files and bun run typecheck; don't touch packages/web.",
    ].join("\n\n");
    const SLACK_BRIEF = [
      "Goal: rotate the Slack app's signing secret without dropping events. The Slack relay in packages/slack verifies each request's signature against the signing secret read at startup; accept both the old and the new secret for a grace window, then retire the old one.",
      "Acceptance: a request signed with either secret is accepted during the window and one signed with the retired secret is rejected after it.",
      "Constraints: run bun test and bun run typecheck; never log a secret.",
    ].join("\n\n");
    const CONFLICT_BRIEF = [
      "Goal: tighten how the Board flags work that collides with a Persona job already in flight. When launch_session starts a worker, the board's conflict check compares the new brief with every open task card on the board and notes overlapping jobs; today the goal score never fires because whole briefs are compared. Score goals by the overlap of their distinctive terms, and probe with the job's title plus the head of the brief.",
      "Acceptance: two briefs about the Board's task cards are flagged as a conflict and two briefs about unrelated areas are not. Tests in packages/shared/src/board.test.ts and packages/collector/src/persona/board-tool.test.ts.",
      "Constraints: run bun test and bun run typecheck; keep findConflicts and boardConflictMap fast over 500 open cards.",
    ].join("\n\n");
    const KNOWLEDGE_BRIEF = [
      "Goal: re-verify knowledge docs whose cited files changed since they were written. The nightly reverify cron in packages/knowledge reads each doc's file pointers, diffs them against the repo at main, and marks a doc stale when a cited symbol moved or vanished, proposing a fix as a draft for the owner.",
      "Acceptance: a doc citing a renamed function is marked stale with a drafted correction; a doc whose citations are unchanged is left alone.",
      "Constraints: run bun test and bun run typecheck; keep the cron under a minute for 2,000 docs.",
    ].join("\n\n");
    /** A harness whose board holds two open jobs briefed in full: the Board's lifecycle and Slack. */
    const briefed = () => {
      const h = harness();
      upsertBoardTask(h.store.db, task("lifecycle", { title: "Board card lifecycle: true columns for Persona jobs", goal: LIFECYCLE_BRIEF }));
      upsertBoardTask(h.store.db, task("slack", { title: "Rotate the Slack signing secret", goal: SLACK_BRIEF }));
      return h;
    };

    test("a brief about the same area as an open job's brief notes the conflict", async () => {
      const h = briefed();
      const out = (await h.call("launch_session", { task: CONFLICT_BRIEF, title: "Board conflict detection for launch_session", projectId: "p" })).json();
      expect(out.boardConflicts).toHaveLength(1);
      expect(out.boardConflicts[0]).toContain("Board card lifecycle: true columns for Persona jobs [coding]: similar goal");
      expect(out.note).toContain("Potential conflicts on the board: Board card lifecycle");
    });

    test("the same-area brief notes the conflict without the word it shares by coincidence", async () => {
      const h = briefed();
      const reworded = CONFLICT_BRIEF.replace("flagged as a conflict", "reported as a conflict");
      expect(reworded).not.toContain("flagged");
      const out = (await h.call("launch_session", { task: reworded, title: "Board conflict detection for launch_session", projectId: "p" })).json();
      expect(out.boardConflicts).toHaveLength(1);
      expect(out.boardConflicts[0]).toContain("Board card lifecycle: true columns for Persona jobs [coding]: similar goal");
      expect(out.note).toContain("Potential conflicts on the board: Board card lifecycle");
    });

    test("a brief citing a file an open card touches notes the conflict through the file, with no goal words shared", async () => {
      const h = briefed();
      const brief = [
        "Goal: give the page a keyboard shortcut cheat sheet opened with the question mark key.",
        "Acceptance: pressing ? opens the sheet and Escape closes it; the sheet lists every shortcut. Edit packages/web/src/Board.tsx.",
      ].join("\n\n");
      const out = (await h.call("launch_session", { task: brief, title: "Keyboard shortcut cheat sheet", projectId: "p" })).json();
      expect(out.boardConflicts).toHaveLength(1);
      expect(out.boardConflicts[0]).toContain("Board tab UI [validation]: files packages/web/src/Board.tsx");
      expect(out.boardConflicts[0]).not.toContain("similar goal");
      expect(out.note).toContain("Potential conflicts on the board: Board tab UI");
    });

    test("a brief about an unrelated area carries no note", async () => {
      const h = briefed();
      const out = (await h.call("launch_session", { task: KNOWLEDGE_BRIEF, title: "Reverify stale knowledge docs", projectId: "p" })).json();
      expect(out.boardConflicts).toBeUndefined();
      expect(out.note).not.toContain("Potential conflicts");
    });
  });

  test("a launch that collides with nothing carries no note", async () => {
    const h = harness();
    const out = (await h.call("launch_session", { task: "Write the release notes for October", projectId: "p" })).json();
    expect(out.boardConflicts).toBeUndefined();
    expect(out.note).not.toContain("Potential conflicts");
  });
});
