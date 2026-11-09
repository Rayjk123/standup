import { describe, expect, test } from "bun:test";
import { BOARD_STATUSES, type BoardConflict, type BoardTaskWithConflicts } from "@standup/shared";
import {
  BOARD_CONFLICT_REFRESH_MAX_WAIT_MS,
  BOARD_CONFLICT_REFRESH_MS,
  appendClosedPage,
  applyFrameToOlder,
  boardListOf,
  boardRefreshDueAt,
  boardFilterKey,
  boardTasksOf,
  cardLinks,
  CLOSED_COLUMN_CAP,
  closedOrder,
  closedPagePath,
  EMPTY_BOARD_FILTER,
  filterBoardTasks,
  groupByColumn,
  mergeBoardList,
  oldestClosedCursor,
  olderCursor,
  parseBoardFilter,
  readClosedPage,
  settleBoardRead,
  ticketIdOf,
  upsertBoardTask,
  waitingCount,
  waitingOnLine,
  withOlderClosed,
  writeBoardFilter,
  type BoardFilter,
  type BoardListBody,
  type ClosedCursor,
  type HeldBoard,
  type WaitingOnTone,
} from "./board";

const at = (m: number) => new Date(Date.UTC(2026, 9, 1, 0, m)).toISOString();

function task(id: string, over: Partial<BoardTaskWithConflicts> = {}): BoardTaskWithConflicts {
  return {
    id,
    source: "job",
    sourceId: `src-${id}`,
    owner: "owner",
    projectId: "standup",
    title: `Task ${id}`,
    status: "coding",
    links: {},
    areas: { files: [], packages: [] },
    createdAt: at(0),
    updatedAt: at(1),
    ...over,
  };
}

const conflict: BoardConflict = {
  taskId: "other",
  title: "Other task",
  status: "coding",
  reasons: [{ kind: "files", overlap: ["packages/web/src/App.tsx"] }],
  score: 0.7,
};

describe("upsertBoardTask", () => {
  test("adds an unseen task at the front", () => {
    const list = [task("a")];
    expect(upsertBoardTask(list, { task: task("b") }).map((t) => t.id)).toEqual(["b", "a"]);
  });

  test("replaces a held task in place, keeping its listed conflicts while it stays open", () => {
    const list = [task("a", { conflicts: [conflict] }), task("b")];
    const next = upsertBoardTask(list, { task: task("a", { status: "validation" }) });
    expect(next.map((t) => t.id)).toEqual(["a", "b"]);
    expect(next[0].status).toBe("validation");
    expect(next[0].conflicts).toEqual([conflict]);
  });

  test("a task that closes drops its conflicts", () => {
    const next = upsertBoardTask([task("a", { conflicts: [conflict] })], { task: task("a", { status: "done" }) });
    expect(next[0].conflicts).toBeUndefined();
  });

  test("a removal drops the task; an unknown removal or an empty frame changes nothing", () => {
    const list = [task("a"), task("b")];
    expect(upsertBoardTask(list, { removed: { id: "a" } }).map((t) => t.id)).toEqual(["b"]);
    expect(upsertBoardTask(list, { removed: { id: "zzz" } })).toBe(list);
    expect(upsertBoardTask(list, {})).toBe(list);
  });
});

describe("groupByColumn", () => {
  test("returns every column in BOARD_STATUSES order, newest first", () => {
    const cols = groupByColumn([
      task("old", { status: "coding", updatedAt: at(1) }),
      task("new", { status: "coding", updatedAt: at(5) }),
      task("w", { status: "waiting" }),
    ]);
    expect(cols.map((c) => c.status)).toEqual([...BOARD_STATUSES]);
    const coding = cols.find((c) => c.status === "coding")!;
    expect(coding.tasks.map((t) => t.id)).toEqual(["new", "old"]);
    expect(coding.label).toBe("Coding");
    expect(cols.find((c) => c.status === "waiting")!.total).toBe(1);
  });

  test("caps the closed columns to their most recent tasks and counts the rest", () => {
    const done = Array.from({ length: CLOSED_COLUMN_CAP + 5 }, (_, i) => task(`d${i}`, { status: "done", updatedAt: at(i) }));
    const open = Array.from({ length: CLOSED_COLUMN_CAP + 5 }, (_, i) => task(`c${i}`, { status: "coding" }));
    const cols = groupByColumn([...done, ...open]);
    const doneCol = cols.find((c) => c.status === "done")!;
    expect(doneCol.tasks.length).toBe(CLOSED_COLUMN_CAP);
    expect(doneCol.hidden).toBe(5);
    expect(doneCol.total).toBe(CLOSED_COLUMN_CAP + 5);
    expect(doneCol.tasks[0].id).toBe(`d${CLOSED_COLUMN_CAP + 4}`);
    const codingCol = cols.find((c) => c.status === "coding")!;
    expect(codingCol.tasks.length).toBe(CLOSED_COLUMN_CAP + 5);
    expect(codingCol.hidden).toBe(0);
  });
});

describe("board filter", () => {
  test("reads the URL query, accepting plural sources and ignoring unknown ones", () => {
    expect(parseBoardFilter(new URLSearchParams("source=ticket&q=auth&project=p1&status=failed"))).toEqual({
      text: "auth",
      projectId: "p1",
      source: "ticket",
      status: "failed",
    });
    expect(parseBoardFilter(new URLSearchParams("source=jobs")).source).toBe("job");
    expect(parseBoardFilter(new URLSearchParams("source=nope")).source).toBe("");
    expect(parseBoardFilter(new URLSearchParams("status=nope")).status).toBe("");
  });

  test("writes the filter back, dropping empty fields and keeping other keys", () => {
    const next = writeBoardFilter(new URLSearchParams("source=ticket&status=done&keep=1"), {
      text: "x",
      projectId: "",
      source: "",
      status: "",
    });
    expect(next.get("q")).toBe("x");
    expect(next.has("source")).toBe(false);
    expect(next.has("status")).toBe(false);
    expect(next.get("keep")).toBe("1");
    expect(writeBoardFilter(new URLSearchParams(), { text: "", projectId: "", source: "", status: "failed" }).get("status")).toBe(
      "failed"
    );
  });

  test("boardFilterKey is equal for equal filters and differs for different ones", () => {
    const f = { text: "x", projectId: "p", source: "ticket" as const, status: "" as const };
    expect(boardFilterKey(f)).toBe(boardFilterKey({ ...f }));
    expect(boardFilterKey(f)).not.toBe(boardFilterKey({ ...f, source: "" }));
    expect(boardFilterKey(EMPTY_BOARD_FILTER)).toBe("");
  });

  test("filters by text, project, source and status", () => {
    const tasks = [
      task("a", { title: "Fix login flow", source: "ticket" }),
      task("b", { title: "Board tab", projectId: "other" }),
      task("c", { title: "Docs", status: "failed", areas: { files: ["packages/web/src/login.ts"], packages: [] } }),
    ];
    const ids = (f: Parameters<typeof filterBoardTasks>[1]) => filterBoardTasks(tasks, f).map((t) => t.id);
    expect(ids({ text: "login", projectId: "", source: "", status: "" })).toEqual(["a", "c"]);
    expect(ids({ text: "", projectId: "other", source: "", status: "" })).toEqual(["b"]);
    expect(ids({ text: "", projectId: "", source: "ticket", status: "" })).toEqual(["a"]);
    expect(ids({ text: "", projectId: "", source: "", status: "failed" })).toEqual(["c"]);
    expect(ids({ text: "", projectId: "", source: "", status: "" })).toEqual(["a", "b", "c"]);
  });
});

describe("groupByColumn uncapped", () => {
  test("a closed column the viewer expanded shows every task", () => {
    const done = Array.from({ length: 5 }, (_, i) => task(`d${i}`, { status: "done", updatedAt: at(i) }));
    const capped = groupByColumn(done, 2).find((c) => c.status === "done")!;
    expect(capped.tasks.length).toBe(2);
    expect(capped.hidden).toBe(3);
    const open = groupByColumn(done, 2, new Set(["done"])).find((c) => c.status === "done")!;
    expect(open.tasks.map((t) => t.id)).toEqual(["d4", "d3", "d2", "d1", "d0"]);
    expect(open.hidden).toBe(0);
  });
});

describe("boardRefreshDueAt", () => {
  test("debounces after the latest frame but never past the max wait from the burst's first", () => {
    expect(boardRefreshDueAt(0, 0)).toBe(BOARD_CONFLICT_REFRESH_MS);
    expect(boardRefreshDueAt(0, 1000)).toBe(1000 + BOARD_CONFLICT_REFRESH_MS);
    expect(boardRefreshDueAt(0, BOARD_CONFLICT_REFRESH_MAX_WAIT_MS - 100)).toBe(BOARD_CONFLICT_REFRESH_MAX_WAIT_MS);
    expect(boardRefreshDueAt(0, 60_000)).toBe(BOARD_CONFLICT_REFRESH_MAX_WAIT_MS);
  });
});

describe("mergeBoardList", () => {
  test("takes the listed tasks, but keeps the held version of a task framed after the read was issued", () => {
    const listed = [task("a", { status: "coding", conflicts: [conflict] }), task("b", { status: "queued" }), task("gone")];
    const held = [task("a", { status: "in_review" }), task("b", { status: "coding" }), task("new", { status: "queued" })];
    const merged = mergeBoardList(listed, held, new Set(["a", "gone", "new"]));
    const byId = new Map(merged.map((t) => [t.id, t]));
    // Framed late: the held version wins.
    expect(byId.get("a")?.status).toBe("in_review");
    // Not framed late: as listed.
    expect(byId.get("b")?.status).toBe("queued");
    // Removed by a late frame: stays removed.
    expect(byId.has("gone")).toBe(false);
    // Created by a late frame the read predates: kept.
    expect(byId.get("new")?.status).toBe("queued");
    expect(mergeBoardList(listed, held, new Set()).map((t) => t.id)).toEqual(["a", "b", "gone"]);
  });
});

describe("list responses", () => {
  test("boardListOf reads the scope and whether more closed tasks remain", () => {
    const cases: { name: string; body: unknown; want: { ids: string[]; scope: BoardListBody["scope"]; more: boolean } }[] = [
      { name: "a viewer's list", body: { tasks: [task("a")], scope: "user", closedMore: true }, want: { ids: ["a"], scope: "user", more: true } },
      { name: "a team-scoped list", body: { tasks: [task("ticket:t")], scope: "team" }, want: { ids: ["ticket:t"], scope: "team", more: false } },
      { name: "a closed page", body: { tasks: [task("d", { status: "done" })], scope: "user", more: true }, want: { ids: ["d"], scope: "user", more: true } },
      { name: "a list without a scope", body: { tasks: [] }, want: { ids: [], scope: "user", more: false } },
      { name: "a non-boolean closedMore", body: { tasks: [], closedMore: "yes" }, want: { ids: [], scope: "user", more: false } },
      { name: "no body", body: null, want: { ids: [], scope: "user", more: false } },
    ];
    for (const c of cases) {
      const got = boardListOf(c.body);
      expect({ name: c.name, ids: got.tasks.map((t) => t.id), scope: got.scope, more: got.more }).toEqual({ name: c.name, ...c.want });
    }
  });

  test("boardListOf reads a page's next cursor, and none without one", () => {
    expect(boardListOf({ tasks: [], more: true, nextClosedBefore: at(3), nextClosedBeforeId: "d-a" }).next).toEqual({ before: at(3), beforeId: "d-a" });
    expect(boardListOf({ tasks: [], more: false, nextClosedBefore: at(3) }).next).toEqual({ before: at(3), beforeId: "" });
    expect(boardListOf({ tasks: [], more: false }).next).toBeUndefined();
    expect(boardListOf({ tasks: [], nextClosedBefore: 7 }).next).toBeUndefined();
  });
});

describe("closed paging", () => {
  test("oldestClosedCursor is the last done or failed task under updatedAt DESC, id DESC", () => {
    const cases: { name: string; tasks: BoardTaskWithConflicts[]; want: ClosedCursor | undefined }[] = [
      {
        name: "the oldest closed task, never an open one",
        tasks: [
          task("open", { status: "coding", updatedAt: at(0) }),
          task("d", { status: "done", updatedAt: at(5) }),
          task("f", { status: "failed", updatedAt: at(3) }),
        ],
        want: { before: at(3), beforeId: "f" },
      },
      {
        name: "a tie on updatedAt goes to the smaller id, whatever the input order",
        tasks: [
          task("d-b", { status: "done", updatedAt: at(3) }),
          task("d-a", { status: "done", updatedAt: at(3) }),
          task("d-c", { status: "failed", updatedAt: at(3) }),
        ],
        want: { before: at(3), beforeId: "d-a" },
      },
      { name: "no closed task", tasks: [task("open")], want: undefined },
    ];
    for (const c of cases) expect({ name: c.name, got: oldestClosedCursor(c.tasks) }).toEqual({ name: c.name, got: c.want });
  });

  test("closedOrder sorts newest first, then by id descending", () => {
    const tasks = [task("a", { updatedAt: at(3) }), task("c", { updatedAt: at(3) }), task("z", { updatedAt: at(1) }), task("b", { updatedAt: at(5) })];
    expect(tasks.slice().sort(closedOrder).map((t) => t.id)).toEqual(["b", "c", "a", "z"]);
  });

  test("closedPagePath asks for the page past the cursor, narrowed by the active filter", () => {
    const cursor = { before: at(3), beforeId: "d-a" };
    const cases: { name: string; filter?: BoardFilter; want: Record<string, string> }[] = [
      { name: "no filter", want: { closedBefore: at(3), closedBeforeId: "d-a", closedLimit: "30" } },
      {
        name: "every filter field",
        filter: { text: "login flow", projectId: "p1", source: "ticket", status: "failed" },
        want: { closedBefore: at(3), closedBeforeId: "d-a", closedLimit: "30", status: "failed", source: "ticket", project: "p1", q: "login flow" },
      },
      { name: "an empty filter adds nothing", filter: EMPTY_BOARD_FILTER, want: { closedBefore: at(3), closedBeforeId: "d-a", closedLimit: "30" } },
    ];
    for (const c of cases) {
      const url = new URL(closedPagePath(cursor, c.filter, 30), "http://localhost");
      expect({ name: c.name, path: url.pathname, params: Object.fromEntries(url.searchParams) }).toEqual({
        name: c.name,
        path: "/api/board/tasks",
        params: c.want,
      });
    }
  });

  test("settleBoardRead keeps a held closed task the re-read pushed past the cap while tasks are paged in", () => {
    const edge = task("d-edge", { status: "done", updatedAt: at(10) });
    const older = [task("d-old", { status: "done", updatedAt: at(5) })];
    const closedNow = task("j", { status: "done", updatedAt: at(20) });
    const cases: { name: string; board: HeldBoard; listed: BoardTaskWithConflicts[]; late: string[]; want: { held: string[]; older: string[] } }[] = [
      {
        name: "the edge task moves into the paged-in set",
        board: { held: [closedNow, edge], older },
        listed: [closedNow],
        late: [],
        want: { held: ["j"], older: ["d-old", "d-edge"] },
      },
      {
        name: "nothing paged in: the read is the list",
        board: { held: [closedNow, edge], older: [] },
        listed: [closedNow],
        late: [],
        want: { held: ["j"], older: [] },
      },
      {
        name: "a dropped open task is not kept",
        board: { held: [task("open"), edge], older },
        listed: [edge],
        late: [],
        want: { held: ["d-edge"], older: ["d-old"] },
      },
      {
        name: "a task removed by a late frame stays gone",
        board: { held: [closedNow], older },
        listed: [closedNow, edge],
        late: ["d-edge"],
        want: { held: ["j"], older: ["d-old"] },
      },
      {
        name: "a dropped task already paged in appears once",
        board: { held: [closedNow, older[0]], older },
        listed: [closedNow],
        late: [],
        want: { held: ["j"], older: ["d-old"] },
      },
    ];
    for (const c of cases) {
      const got = settleBoardRead(c.board, c.listed, new Set(c.late));
      expect({ name: c.name, held: got.held.map((t) => t.id), older: got.older.map((t) => t.id) }).toEqual({ name: c.name, ...c.want });
    }
  });

  test("appendClosedPage and withOlderClosed join each task once, the held version winning", () => {
    const older = appendClosedPage([task("d1", { status: "done" })], [task("d1", { status: "done" }), task("d2", { status: "failed" })]);
    expect(older.map((t) => t.id)).toEqual(["d1", "d2"]);
    const held = [task("a"), task("d2", { status: "done", title: "held" })];
    const shown = withOlderClosed(held, older);
    expect(shown.map((t) => t.id)).toEqual(["a", "d2", "d1"]);
    expect(shown[1].title).toBe("held");
  });

  test("appendClosedPage lets the appended version of a held task replace it in place", () => {
    const older = [task("d1", { status: "done", title: "stale" }), task("d2", { status: "done" })];
    const got = appendClosedPage(older, [task("d1", { status: "failed", title: "fresh" }), task("d3", { status: "done" })]);
    expect(got.map((t) => [t.id, t.title])).toEqual([["d1", "fresh"], ["d2", "Task d2"], ["d3", "Task d3"]]);
    // settleBoardRead moves the held (fresher) version of a dropped edge task over a stale paged-in copy.
    const edge = task("d-edge", { status: "done", title: "held edge", updatedAt: at(10) });
    const settled = settleBoardRead(
      { held: [edge], older: [task("d-edge", { status: "done", title: "stale edge", updatedAt: at(9) })] },
      [],
      new Set(),
    );
    expect(settled.older.map((t) => [t.id, t.title])).toEqual([["d-edge", "held edge"]]);
  });

  test("readClosedPage aborts a read that never answers, and settles", async () => {
    let signal: AbortSignal | undefined;
    const hung = ((_: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    }) as typeof fetch;
    let settled = false;
    const read = readClosedPage("/api/board/tasks?closedBefore=x", 20, hung).finally(() => (settled = true));
    await expect(read).rejects.toThrow("timed out");
    expect(settled).toBe(true);
    expect(signal?.aborted).toBe(true);
    // A body that never arrives is abandoned the same way.
    const hungBody = (async () => ({ ok: true, json: () => new Promise(() => {}) }) as unknown as Response) as unknown as typeof fetch;
    await expect(readClosedPage("/p", 20, hungBody)).rejects.toThrow("timed out");
    // An answered read reads the page; an error status reads as null.
    const ok = (async () => new Response(JSON.stringify({ tasks: [], more: true, nextClosedBefore: at(2), nextClosedBeforeId: "d" }))) as unknown as typeof fetch;
    expect(await readClosedPage("/p", 1000, ok)).toEqual({ tasks: [], scope: "user", more: true, next: { before: at(2), beforeId: "d" } });
    const refused = (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch;
    expect(await readClosedPage("/p", 1000, refused)).toBeNull();
  });

  test("olderCursor picks the cursor further along updatedAt DESC, id DESC", () => {
    const cases: { name: string; a?: ClosedCursor; b?: ClosedCursor; want?: ClosedCursor }[] = [
      { name: "the earlier time", a: { before: at(5), beforeId: "z" }, b: { before: at(3), beforeId: "a" }, want: { before: at(3), beforeId: "a" } },
      { name: "a tie goes to the smaller id", a: { before: at(3), beforeId: "b" }, b: { before: at(3), beforeId: "a" }, want: { before: at(3), beforeId: "a" } },
      { name: "one side missing", a: { before: at(3), beforeId: "a" }, want: { before: at(3), beforeId: "a" } },
      { name: "both missing" },
    ];
    for (const c of cases) expect({ name: c.name, got: olderCursor(c.a, c.b) }).toEqual({ name: c.name, got: c.want });
  });

  test("applyFrameToOlder updates or removes a paged-in task and ignores every other", () => {
    const older = [task("d1", { status: "done" })];
    expect(applyFrameToOlder(older, { task: task("x", { status: "done" }) })).toBe(older);
    expect(applyFrameToOlder(older, { task: task("d1", { status: "failed" }) })[0].status).toBe("failed");
    expect(applyFrameToOlder(older, { removed: { id: "d1" } })).toEqual([]);
  });
});

describe("waitingOnLine", () => {
  test("reads the non-viewer lines in their own tone, and anything else as waiting on the viewer", () => {
    const cases: { waitingOn: string; want: { text: string; tone: WaitingOnTone } }[] = [
      { waitingOn: "owner approval", want: { text: "waiting on owner approval", tone: "viewer" } },
      { waitingOn: "Persona deciding: wontfix waiver", want: { text: "Persona deciding: wontfix waiver", tone: "persona" } },
      { waitingOn: "parked: host restarted", want: { text: "parked: host restarted", tone: "parked" } },
      { waitingOn: "parking lot review", want: { text: "waiting on parking lot review", tone: "viewer" } },
      { waitingOn: "code review in progress", want: { text: "code review in progress", tone: "persona" } },
      { waitingOn: "Persona to close out", want: { text: "waiting on Persona to close out", tone: "persona" } },
      { waitingOn: "plan approval", want: { text: "waiting on plan approval", tone: "viewer" } },
      { waitingOn: "host room to start", want: { text: "waiting on host room to start", tone: "persona" } },
    ];
    for (const c of cases) expect({ in: c.waitingOn, ...waitingOnLine(c.waitingOn) }).toEqual({ in: c.waitingOn, ...c.want });
  });
});

describe("cardLinks", () => {
  test("links the job drawer, each session, the review packet, the code review and the tunnel", () => {
    const links = cardLinks(
      task("a", {
        links: {
          jobId: "job 1",
          sessionIds: ["sess-aaaaaaaaaa", "sess-b"],
          launchIds: ["launch-1"],
          packetId: "pkt-1",
          codeReview: { id: "123", url: "https://git.example.com/acme/app/pull/123" },
          tunnelUrl: "https://tunnel.example.com/x",
        },
      })
    );
    expect(links).toEqual([
      { kind: "job", label: "Job", to: "/persona?job=job%201" },
      { kind: "session", label: "Session sess-aaa", to: "/board?workers=1&session=sess-aaaaaaaaaa", worker: { kind: "s", id: "sess-aaaaaaaaaa" } },
      { kind: "session", label: "Session sess-b", to: "/board?workers=1&session=sess-b", worker: { kind: "s", id: "sess-b" } },
      { kind: "review", label: "Review", to: "/review/pkt-1" },
      { kind: "code_review", label: "123", href: "https://git.example.com/acme/app/pull/123" },
      { kind: "tunnel", label: "Tunnel", href: "https://tunnel.example.com/x" },
    ]);
  });

  test("falls back to launches before a session attaches, and never links an unsafe URL", () => {
    const links = cardLinks(
      task("a", { links: { launchIds: ["l1"], codeReview: { id: "9", url: "javascript:alert(1)" }, tunnelUrl: "data:x" } })
    );
    expect(links).toEqual([
      { kind: "launch", label: "Launch l1", to: "/board?workers=1&launch=l1", worker: { kind: "l", id: "l1" } },
      { kind: "code_review", label: "9", href: undefined },
    ]);
  });
});

describe("helpers", () => {
  test("waitingCount counts the waiting column", () => {
    expect(waitingCount([task("a", { status: "waiting" }), task("b"), task("c", { status: "waiting" })])).toBe(2);
  });

  test("ticketIdOf reads a ticket card's ticket, and nothing for other sources", () => {
    expect(ticketIdOf(task("a", { source: "ticket", sourceId: "t1" }))).toBe("t1");
    expect(ticketIdOf(task("a", { source: "ticket", sourceId: "t1", links: { ticketId: "t2" } }))).toBe("t2");
    expect(ticketIdOf(task("a"))).toBeUndefined();
  });

  test("boardTasksOf reads the list response and treats anything else as empty", () => {
    expect(boardTasksOf({ tasks: [task("a")] }).map((t) => t.id)).toEqual(["a"]);
    expect(boardTasksOf({})).toEqual([]);
    expect(boardTasksOf(null)).toEqual([]);
  });
});
