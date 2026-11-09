import { describe, expect, test } from "bun:test";
import type { BoardConflict, BoardTaskInput, BoardTaskWithConflicts } from "@standup/shared";
import { DEFAULT_IDENTITY_HEADER } from "@standup/shared";
import { USER_CHANNEL_HEADER, userChannelToken } from "@standup/shared/owner-token";
import { createStore, upsertBoardTask } from "@standup/store";
import { Hono } from "hono";
import { PERSONA_TOKEN_HEADER } from "../persona/routes.js";
import { human, makeWorld, post, type World } from "../pipeline/test-world.js";
import { createBoard } from "./board.js";
import { mountBoardRoutes } from "./routes.js";

/** The identity header a signed-in browser's request carries (as human() sends it). */
const IDENTITY_HEADER = DEFAULT_IDENTITY_HEADER;

function task(sourceId: string, over: Partial<BoardTaskInput> = {}): BoardTaskInput {
  return {
    source: "job",
    sourceId,
    owner: "alice",
    projectId: "proj",
    title: `Task ${sourceId}`,
    status: "coding",
    links: { jobId: sourceId },
    areas: { files: [], packages: [] },
    ...over,
  };
}

function seeded(): World {
  const w = makeWorld();
  const db = w.store.db;
  upsertBoardTask(
    db,
    task("retry", {
      title: "Make webhook retries idempotent",
      goal: "Deduplicate webhook delivery retries with an idempotency key",
      areas: { files: ["packages/collector/src/webhook.ts"], packages: ["packages/collector"] },
    })
  );
  upsertBoardTask(
    db,
    task("board", {
      title: "Board tab",
      status: "validation",
      areas: { files: ["packages/web/src/Board.tsx"], packages: ["packages/web"] },
    })
  );
  upsertBoardTask(db, task("old", { title: "Old landed work", status: "done", projectId: "other" }));
  upsertBoardTask(db, task("bobs", { owner: "bob", title: "Bob's webhook work", areas: { files: ["packages/collector/src/webhook.ts"], packages: [] } }));
  upsertBoardTask(db, {
    ...task("t1", { owner: "", title: "Webhook retries not idempotent" }),
    source: "ticket",
    links: { ticketId: "t1" },
    status: "queued",
  });
  return w;
}

async function list(w: World, query = "") {
  const res = await w.app.request(`/api/board/tasks${query}`, { headers: human(w) });
  expect(res.status).toBe(200);
  return ((await res.json()) as { tasks: BoardTaskWithConflicts[] }).tasks;
}

const ids = (tasks: { id: string }[]) => tasks.map((t) => t.id).sort();

/** The board read's response. */
interface BoardRead {
  tasks: BoardTaskWithConflicts[];
  scope: "user" | "team";
  closedMore?: boolean;
  more?: boolean;
}

describe("GET /api/board/tasks", () => {
  test("lists the user's tasks and the team-wide ones, never another user's", async () => {
    const w = seeded();
    expect(ids(await list(w))).toEqual(["job:board", "job:old", "job:retry", "ticket:t1"]);
  });

  test("filters by status, source, project, open, text and files", async () => {
    const w = seeded();
    expect(ids(await list(w, "?status=validation,done"))).toEqual(["job:board", "job:old"]);
    expect(ids(await list(w, "?source=ticket"))).toEqual(["ticket:t1"]);
    expect(ids(await list(w, "?project=other"))).toEqual(["job:old"]);
    expect(ids(await list(w, "?open=1"))).toEqual(["job:board", "job:retry", "ticket:t1"]);
    expect(ids(await list(w, "?q=webhook%20idempotent"))).toEqual(["job:retry", "ticket:t1"]);
    expect(ids(await list(w, "?q=deduplicate"))).toEqual(["job:retry"]);
    expect(ids(await list(w, "?files=packages/web/src"))).toEqual(["job:board"]);
  });

  test("each open task carries the open tasks it may collide with", async () => {
    const w = seeded();
    const tasks = await list(w);
    const retry = tasks.find((t) => t.id === "job:retry")!;
    expect(retry.conflicts?.map((c) => c.taskId)).toContain("ticket:t1");
    expect(tasks.find((t) => t.id === "job:old")!.conflicts).toBeUndefined();
    // Another user's task is never named.
    expect(JSON.stringify(tasks)).not.toContain("Bob's");
  });

  test("an identified caller reads scope user, with whether more closed tasks exist", async () => {
    const w = seeded();
    const res = await w.app.request("/api/board/tasks", { headers: human(w) });
    const body = (await res.json()) as BoardRead;
    expect(body.scope).toBe("user");
    expect(body.closedMore).toBe(false);
  });

  test("a caller who can't be identified reads only the team-wide tasks, scope team", async () => {
    const w = seeded();
    const res = await w.app.request("/api/board/tasks");
    expect(res.status).toBe(200);
    const body = (await res.json()) as BoardRead;
    expect(body.scope).toBe("team");
    expect(ids(body.tasks)).toEqual(["ticket:t1"]);
  });

  test("a signed-in teammate reads their own board through their user channel, without the owner token", async () => {
    const w = seeded();
    const asBob = (alias: string, token: string) =>
      w.app.request("/api/board/tasks", { headers: { [IDENTITY_HEADER]: alias, [USER_CHANNEL_HEADER]: token } });
    const bobToken = userChannelToken(w.secrets.ownerToken, "bob");
    const res = await asBob("bob", bobToken);
    expect(res.status).toBe(200);
    const read = (await res.json()) as BoardRead;
    // Bob's own card and the team-wide ticket, never alice's.
    expect(read.scope).toBe("user");
    expect(ids(read.tasks)).toEqual(["job:bobs", "ticket:t1"]);
    // Bob's token never reads as alice, and a forged token or none reads only the team-wide tasks.
    for (const refused of [await asBob("alice", bobToken), await asBob("bob", "forged"), await w.app.request("/api/board/tasks", { headers: { [IDENTITY_HEADER]: "bob" } })]) {
      expect(refused.status).toBe(200);
      const body = (await refused.json()) as BoardRead;
      expect(body.scope).toBe("team");
      expect(ids(body.tasks)).toEqual(["ticket:t1"]);
    }
    // Checking for conflicts still needs an identified person.
    const forgedProbe = await w.app.request("/api/board/conflicts", {
      method: "POST",
      headers: { "Content-Type": "application/json", [IDENTITY_HEADER]: "bob", [USER_CHANNEL_HEADER]: "forged" },
      body: JSON.stringify({ projectId: "proj" }),
    });
    expect(forgedProbe.status).toBe(403);
    const probe = await w.app.request("/api/board/conflicts", {
      method: "POST",
      headers: { "Content-Type": "application/json", [IDENTITY_HEADER]: "bob", [USER_CHANNEL_HEADER]: bobToken },
      body: JSON.stringify({ projectId: "proj", files: ["packages/collector/src/webhook.ts"] }),
    });
    expect(probe.status).toBe(200);
    expect(((await probe.json()) as { conflicts: BoardConflict[] }).conflicts.map((c) => c.taskId)).toEqual(["job:bobs"]);
  });

  test("refuses a Persona credential even with the owner token, and without one", async () => {
    const w = seeded();
    const res = await w.app.request("/api/board/tasks", { headers: { ...human(w), [PERSONA_TOKEN_HEADER]: "x" } });
    expect(res.status).toBe(403);
    expect((await w.app.request("/api/board/tasks", { headers: { [PERSONA_TOKEN_HEADER]: "x" } })).status).toBe(403);
    expect((await w.app.request("/api/board/tasks?closedBefore=2030-01-01T00:00:00.000Z", { headers: { [PERSONA_TOKEN_HEADER]: "x" } })).status).toBe(403);
  });

  test("closed tasks page by closedBefore and closedLimit, newest first, with whether more exist", async () => {
    const w = seeded();
    const db = w.store.db;
    // Five more closed cards of alice's, one a minute apart (c0 oldest), and an open one.
    for (let i = 0; i < 5; i++) {
      upsertBoardTask(db, task(`c${i}`, { status: "done" }), `2026-01-01T00:0${i}:00.000Z`);
    }
    const read = async (query: string, headers: Record<string, string> = human(w)) => {
      const res = await w.app.request(`/api/board/tasks${query}`, { headers });
      expect(res.status).toBe(200);
      return (await res.json()) as BoardRead;
    };
    // The first page: open tasks and the 3 newest closed ones, with more past the cap.
    const first = await read("?closedLimit=3");
    expect(first.closedMore).toBe(true);
    const closedIds = (b: BoardRead) => b.tasks.filter((t) => t.status === "done" || t.status === "failed").map((t) => t.id);
    expect(closedIds(first)).toEqual(["job:old", "job:c4", "job:c3"]);
    expect(first.tasks.map((t) => t.id)).toEqual(expect.arrayContaining(["job:retry", "job:board", "ticket:t1"]));
    // The next page: only closed tasks updated before the last one shown, newest first.
    const cursor = first.tasks.find((t) => t.id === "job:c3")!.updatedAt;
    const second = await read(`?closedBefore=${encodeURIComponent(cursor)}&closedLimit=2`);
    expect(second.scope).toBe("user");
    expect(second.more).toBe(true);
    expect(second.tasks.map((t) => t.id)).toEqual(["job:c2", "job:c1"]);
    const last = await read(`?closedBefore=${encodeURIComponent(second.tasks.at(-1)!.updatedAt)}`);
    expect(last.more).toBe(false);
    expect(last.tasks.map((t) => t.id)).toEqual(["job:c0"]);
    // The team scope pages only team-wide closed tasks.
    upsertBoardTask(db, { ...task("t-old", { owner: "", status: "done" }), source: "ticket", links: { ticketId: "t-old" } }, "2026-01-01T00:00:30.000Z");
    const team = await read("?closedBefore=2030-01-01T00:00:00.000Z", {});
    expect(team).toMatchObject({ scope: "team", more: false });
    expect(team.tasks.map((t) => t.id)).toEqual(["ticket:t-old"]);
    // The limit defaults to 200 and is capped at 500; a malformed cursor or limit is refused.
    expect((await read("?closedBefore=2030-01-01T00:00:00.000Z&closedLimit=100000")).tasks).toHaveLength(7);
    expect((await w.app.request("/api/board/tasks?closedBefore=yesterday", { headers: human(w) })).status).toBe(400);
    expect((await w.app.request("/api/board/tasks?closedLimit=-1", { headers: human(w) })).status).toBe(400);
  });

  test("closed tasks tied on updatedAt across a page boundary each come back exactly once", async () => {
    const w = seeded();
    const db = w.store.db;
    const tie = "2026-02-01T00:00:00.000Z";
    for (const id of ["a", "b", "c", "d", "e"]) upsertBoardTask(db, task(`tie-${id}`, { status: "done" }), tie);
    upsertBoardTask(db, task("before-tie", { status: "done" }), "2026-01-15T00:00:00.000Z");
    const read = async (query: string) => {
      const res = await w.app.request(`/api/board/tasks${query}`, { headers: human(w) });
      expect(res.status).toBe(200);
      return (await res.json()) as BoardRead;
    };
    const closedIds = (b: BoardRead) => b.tasks.filter((t) => t.status === "done" || t.status === "failed").map((t) => t.id);
    // job:old is the newest closed card; then the five tied ones, by id descending.
    const first = await read("?closedLimit=3");
    expect(closedIds(first)).toEqual(["job:old", "job:tie-e", "job:tie-d"]);
    const seen = [...closedIds(first)];
    let cursor = first.tasks.find((t) => t.id === "job:tie-d")!;
    for (let page = 0; page < 5; page++) {
      const next = await read(`?closedBefore=${encodeURIComponent(cursor.updatedAt)}&closedBeforeId=${encodeURIComponent(cursor.id)}&closedLimit=2`);
      seen.push(...next.tasks.map((t) => t.id));
      if (!next.more) break;
      cursor = next.tasks.at(-1)!;
    }
    expect(seen).toEqual(["job:old", "job:tie-e", "job:tie-d", "job:tie-c", "job:tie-b", "job:tie-a", "job:before-tie"]);
    // Without the id the cursor is strict: every task tied on it is past it.
    expect((await read(`?closedBefore=${encodeURIComponent(tie)}`)).tasks.map((t) => t.id)).toEqual(["job:before-tie"]);
  });

  test("a page of closed tasks honors the list's filters, and its cursor is read as a time", async () => {
    const w = seeded();
    const db = w.store.db;
    upsertBoardTask(db, task("web-done", { title: "Landed web polish", status: "done", areas: { files: ["packages/web/src/x.ts"], packages: ["packages/web"] } }), "2026-03-01T10:00:00.000Z");
    upsertBoardTask(db, task("failed-one", { title: "Failed web attempt", status: "failed", projectId: "other" }), "2026-03-01T09:00:00.000Z");
    upsertBoardTask(db, { ...task("t-done", { owner: "", title: "Landed ticket", status: "done" }), source: "ticket", links: { ticketId: "t-done" } }, "2026-03-01T08:00:00.000Z");
    // Tied with web-done, and before it by id.
    upsertBoardTask(db, task("tied-a", { status: "done" }), "2026-03-01T10:00:00.000Z");
    const page = async (query: string) => {
      const res = await w.app.request(`/api/board/tasks?closedBefore=2030-01-01T00:00:00.000Z&${query}`, { headers: human(w) });
      expect(res.status).toBe(200);
      return ((await res.json()) as BoardRead).tasks.map((t) => t.id);
    };
    expect(await page("status=failed")).toEqual(["job:failed-one"]);
    expect(await page("source=ticket")).toEqual(["ticket:t-done"]);
    // job:old was written now, so it is the newest.
    expect(await page("project=other")).toEqual(["job:old", "job:failed-one"]);
    expect(await page("q=web")).toEqual(["job:web-done", "job:failed-one"]);
    expect(await page("files=packages/web/src")).toEqual(["job:web-done"]);
    const pageIds = async (query: string) => {
      const res = await w.app.request(`/api/board/tasks?${query}`, { headers: human(w) });
      expect(res.status).toBe(200);
      return ((await res.json()) as BoardRead).tasks.map((t) => t.id);
    };
    // An offset time is the same instant in UTC: 11:30+02:00 is 09:30Z, before the 10:00Z cards.
    expect(await pageIds(`closedBefore=${encodeURIComponent("2026-03-01T11:30:00+02:00")}&closedBeforeId=job:zzz`)).toEqual([
      "job:failed-one",
      "ticket:t-done",
    ]);
    // A cursor on web-done written with an offset (12:00+02:00 is 10:00Z) pages past it by id, to its tie.
    expect(await pageIds(`closedBefore=${encodeURIComponent("2026-03-01T12:00:00+02:00")}&closedBeforeId=job:web-done`)).toEqual([
      "job:tied-a",
      "job:failed-one",
      "ticket:t-done",
    ]);
  });

  test("a page carries the next cursor, even when its filter matched nothing", async () => {
    const w = seeded();
    const db = w.store.db;
    for (let i = 0; i < 3; i++) upsertBoardTask(db, task(`p${i}`, { status: "done" }), `2026-04-01T00:0${i}:00.000Z`);
    const read = async (query: string) => {
      const res = await w.app.request(`/api/board/tasks?${query}`, { headers: human(w) });
      expect(res.status).toBe(200);
      return (await res.json()) as BoardRead & { nextClosedBefore?: string; nextClosedBeforeId?: string };
    };
    const cursor = `closedBefore=${encodeURIComponent("2026-04-01T00:02:00.000Z")}&closedBeforeId=job:p2`;
    // A full page with more to come names its last task.
    expect(await read(`${cursor}&closedLimit=1`)).toMatchObject({
      more: true,
      nextClosedBefore: "2026-04-01T00:01:00.000Z",
      nextClosedBeforeId: "job:p1",
    });
    // A filter matching none of the older cards still answers the cursor and more.
    const none = await read(`${cursor}&source=ticket&status=failed`);
    expect(none.tasks).toEqual([]);
    expect(none).toMatchObject({ more: false, nextClosedBefore: "2026-04-01T00:02:00.000Z", nextClosedBeforeId: "job:p2" });
    // open=1 excludes closed tasks, so a page under it is empty.
    const open = await read(`${cursor}&open=1`);
    expect(open.tasks).toEqual([]);
    expect(open.more).toBe(false);
  });

  test("a job card a backlog card links is hidden; the backlog card stands for it", async () => {
    const w = seeded();
    upsertBoardTask(w.store.db, {
      source: "backlog",
      sourceId: "item-9",
      owner: "alice",
      projectId: "proj",
      title: "Backlog: idempotent webhooks",
      status: "coding",
      links: { backlogItemId: "item-9", jobId: "retry" },
      areas: { files: [], packages: [] },
    });
    const tasks = await list(w);
    expect(ids(tasks)).toEqual(["backlog:item-9", "job:board", "job:old", "ticket:t1"]);
  });

  test("the conflict map is recomputed once the board changes", async () => {
    const w = seeded();
    const before = (await list(w)).find((t) => t.id === "job:board")!;
    expect(before.conflicts).toBeUndefined();
    // Reading again with nothing changed serves the same map.
    expect((await list(w)).find((t) => t.id === "job:board")!.conflicts).toBeUndefined();
    upsertBoardTask(w.store.db, task("ui2", { title: "Board view polish", areas: { files: ["packages/web/src/Board.tsx"], packages: ["packages/web"] } }));
    const after = (await list(w)).find((t) => t.id === "job:board")!;
    expect(after.conflicts?.map((c) => c.taskId)).toEqual(["job:ui2"]);
  });
});

describe("GET /api/board/version", () => {
  /** The board routes over a board of their own; `x-test-user` names the caller, who holds the owner channel. */
  function versioned() {
    const store = createStore(":memory:");
    const board = createBoard({ db: store.db, publish: () => {} });
    const app = new Hono();
    mountBoardRoutes(app, {
      board,
      identityOf: (c) => c.req.header("x-test-user") ?? "",
      ownerChannel: (c) => !!c.req.header("x-test-user"),
      userChannel: () => false,
    });
    const read = async (path: string, user?: string) => {
      const res = await app.request(path, { headers: user ? { "x-test-user": user } : {} });
      expect(res.status).toBe(200);
      return ((await res.json()) as { version: string }).version;
    };
    return { board, app, version: (user?: string) => read("/api/board/version", user), listVersion: (user?: string) => read("/api/board/tasks", user) };
  }

  test("matches the list read's version, moves with the reader's own and team-wide changes, and not with another owner's", async () => {
    const h = versioned();
    h.board.upsert(task("a"));
    const at = await h.version("alice");
    expect(await h.listVersion("alice")).toBe(at);
    // Rewriting a task unchanged sends no frame and leaves the version where it was.
    h.board.upsert(task("a"));
    expect(await h.version("alice")).toBe(at);
    // Another owner's change is no frame alice is sent.
    h.board.upsert(task("b", { owner: "bob" }));
    expect(await h.version("alice")).toBe(at);
    h.board.upsert(task("a", { status: "in_review" }));
    const moved = await h.version("alice");
    expect(moved).not.toBe(at);
    expect(await h.listVersion("alice")).toBe(moved);
    // A team-wide change reaches every reader, the unidentified one too.
    const team = await h.version();
    h.board.upsert({ ...task("t1", { owner: "" }), source: "ticket", links: { ticketId: "t1" }, status: "queued" });
    expect(await h.version("alice")).not.toBe(moved);
    expect(await h.version()).not.toBe(team);
  });

  test("a task handed to another owner leaves its old owner's board, and both versions move", async () => {
    const frames: { audience?: string; payload: unknown }[] = [];
    const store = createStore(":memory:");
    const board = createBoard({ db: store.db, publish: (m) => frames.push({ audience: m.audience, payload: m.payload }) });
    board.upsert({ ...task("b1", { owner: "alice" }), source: "backlog", links: { backlogItemId: "b1" } });
    const alice = board.viewerVersion("alice");
    const bob = board.viewerVersion("bob");
    frames.length = 0;
    board.upsert({ ...task("b1", { owner: "bob" }), source: "backlog", links: { backlogItemId: "b1" } });
    expect(frames).toEqual([
      { audience: "alice", payload: { removed: { id: "backlog:b1" } } },
      { audience: "bob", payload: { task: expect.objectContaining({ id: "backlog:b1", owner: "bob" }) } },
    ]);
    expect(board.viewerVersion("alice")).not.toBe(alice);
    expect(board.viewerVersion("bob")).not.toBe(bob);
  });

  test("a new board (a collector restart) never answers a version an earlier one did", async () => {
    const first = versioned();
    const second = versioned();
    expect(await first.version("alice")).not.toBe(await second.version("alice"));
  });

  test("refuses a Persona credential", async () => {
    const w = seeded();
    const res = await w.app.request("/api/board/version", { headers: { ...human(w), [PERSONA_TOKEN_HEADER]: "x" } });
    expect(res.status).toBe(403);
  });
});

describe("POST /api/board/conflicts", () => {
  const conflicts = async (w: World, body: unknown) => {
    const res = await post(w, "/api/board/conflicts", body, human(w));
    expect(res.status).toBe(200);
    return ((await res.json()) as { conflicts: BoardConflict[] }).conflicts;
  };

  test("flags an open task touching the same file", async () => {
    const w = seeded();
    const found = await conflicts(w, { projectId: "proj", title: "Log webhook payloads", files: ["packages/collector/src/webhook.ts"] });
    expect(found[0]).toMatchObject({ taskId: "job:retry" });
    expect(found[0]!.reasons.map((r) => r.kind)).toContain("files");
    expect(found.map((c) => c.taskId)).not.toContain("job:bobs");
  });

  test("flags an open task with a similar goal, and skips the probe's own job and closed tasks", async () => {
    const w = seeded();
    const found = await conflicts(w, { title: "Idempotent webhook retries", goal: "deduplicate webhook delivery retries" });
    expect(found.map((c) => c.taskId)).toContain("job:retry");
    expect(found.find((c) => c.taskId === "job:retry")!.reasons.some((r) => r.kind === "goal")).toBe(true);
    const own = await conflicts(w, { title: "Idempotent webhook retries", excludeJobId: "retry" });
    expect(own.map((c) => c.taskId)).not.toContain("job:retry");
    const closed = await conflicts(w, { title: "Old landed work" });
    expect(closed.map((c) => c.taskId)).not.toContain("job:old");
  });

  test("refuses a malformed body", async () => {
    const w = seeded();
    const res = await w.app.request("/api/board/conflicts", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...human(w) },
      body: "[1]",
    });
    expect(res.status).toBe(400);
  });
});
