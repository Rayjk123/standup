import { expect, test, describe } from "bun:test";
import { createStore } from "../store.js";
import { upsertProject } from "./projects.js";
import { insertEvent } from "./events.js";
import {
  createSession,
  getSession,
  getChildSessions,
  getSubagentSessions,
  getActiveSessions,
  getAllSessions,
  getSessionsByProject,
  getMostRecentActiveSessionByCwd,
  endSubagentSession,
  deleteSession,
  getActiveWork,
  setSessionCreatedActor,
  assignSessionOwner,
  updateSessionTitle,
  upgradeSessionTitle,
} from "./sessions.js";

/**
 * Subagent subsessions (OpenClaw-style parent -> child). A subagent gets its own
 * child session row (synthetic id, parent_session_id set, kind='subagent') that
 * nests under its parent: it is excluded from the flat top-level lists and from
 * the cwd correlation lookup, but read explicitly via getChildSessions, and it
 * comes down with its parent on delete (the self-FK has no ON DELETE).
 */
function seed() {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  createSession(store.db, {
    id: "parent",
    projectId: "p",
    title: "root task",
    cwd: "/repo",
    status: "running",
  });
  return store;
}

function seedChild(store: ReturnType<typeof seed>, id = "parent:agent-1") {
  createSession(store.db, {
    id,
    projectId: "p",
    title: "code-reviewer",
    cwd: "/repo",
    parentSessionId: "parent",
    status: "running",
    kind: "subagent",
    agentType: "code-reviewer",
    agentId: "agent-1",
  });
}

describe("createSession — subagent fields", () => {
  test("threads kind/agentType/agentId and reads them back", () => {
    const store = seed();
    seedChild(store);

    const child = getSession(store.db, "parent:agent-1");
    expect(child?.kind).toBe("subagent");
    expect(child?.agentType).toBe("code-reviewer");
    expect(child?.agentId).toBe("agent-1");
    expect(child?.parentSessionId).toBe("parent");

    // A plain root reads unset kind — the honest default for every ordinary session.
    const parent = getSession(store.db, "parent");
    expect(parent?.kind).toBeUndefined();
    expect(parent?.parentSessionId).toBeUndefined();
    store.close();
  });
});

describe("getChildSessions / getSubagentSessions", () => {
  test("getChildSessions returns a parent's children; getSubagentSessions returns all children", () => {
    const store = seed();
    seedChild(store, "parent:agent-1");
    seedChild2(store);

    const children = getChildSessions(store.db, "parent");
    expect(children.map((c) => c.id).sort()).toEqual(["parent:agent-1", "parent:agent-2"]);

    expect(getSubagentSessions(store.db).map((c) => c.id).sort()).toEqual([
      "parent:agent-1",
      "parent:agent-2",
    ]);

    // A parent with no children yields none.
    expect(getChildSessions(store.db, "parent:agent-1")).toHaveLength(0);
    store.close();
  });
});

function seedChild2(store: ReturnType<typeof seed>) {
  createSession(store.db, {
    id: "parent:agent-2",
    projectId: "p",
    title: "tester",
    cwd: "/repo",
    parentSessionId: "parent",
    status: "running",
    kind: "subagent",
    agentType: "tester",
    agentId: "agent-2",
  });
}

describe("flat lists exclude children", () => {
  test("getActiveSessions / getAllSessions / getSessionsByProject return roots only", () => {
    const store = seed();
    seedChild(store);

    expect(getActiveSessions(store.db).map((s) => s.id)).toEqual(["parent"]);
    expect(getAllSessions(store.db).map((s) => s.id)).toEqual(["parent"]);
    expect(getSessionsByProject(store.db, "p").map((s) => s.id)).toEqual(["parent"]);
    store.close();
  });
});

describe("getAllSessions — last-activity ordering", () => {
  test("a fresh message lifts an old-started session above a more-recently-started idle one", () => {
    const store = seed();
    // Idle: started 5h ago, nothing since — its recency is started_at (5h ago).
    makeSession(store, { id: "idle-recent", startedHoursAgo: 5 });
    // Old + long done, but a message landed an hour ago — recency is that
    // transcript event (1h ago), more recent than the idle session's start.
    makeSession(store, {
      id: "old-fresh",
      startedHoursAgo: 72,
      endedHoursAgo: 48,
      status: "done",
    });
    store.db.run(
      `INSERT INTO transcript_events (session_id, seq, event_json, created_at)
         VALUES (?, 1, '{}', ${ago(1)})`,
      ["old-fresh"]
    );

    const sessions = getAllSessions(store.db);
    const ids = sessions.map((s) => s.id);
    // The freshly-messaged session sorts ABOVE the more-recently-started idle
    // one — the reverse of the old started_at ordering.
    expect(ids.indexOf("old-fresh")).toBeLessThan(ids.indexOf("idle-recent"));

    // lastActivityAt is derived onto each row; the message time beats the idle start.
    const fresh = sessions.find((s) => s.id === "old-fresh")!;
    const idle = sessions.find((s) => s.id === "idle-recent")!;
    expect(fresh.lastActivityAt).toBeInstanceOf(Date);
    expect(idle.lastActivityAt).toBeInstanceOf(Date);
    expect(fresh.lastActivityAt!.getTime()).toBeGreaterThan(idle.lastActivityAt!.getTime());
    store.close();
  });
});

describe("getMostRecentActiveSessionByCwd excludes children", () => {
  test("a child sharing the parent's cwd never wins the correlation lookup", () => {
    const store = seed();
    // The child is created AFTER the parent and shares its cwd, so without the
    // exclusion it would be the most-recent match and poison MCP correlation.
    seedChild(store);

    const match = getMostRecentActiveSessionByCwd(store.db, "/repo");
    expect(match?.id).toBe("parent");
    store.close();
  });
});

describe("endSubagentSession", () => {
  test("marks the child done and stamps ended_at", () => {
    const store = seed();
    seedChild(store);

    endSubagentSession(store.db, "parent:agent-1");
    const child = getSession(store.db, "parent:agent-1");
    expect(child?.status).toBe("done");
    expect(child?.endedAt).toBeInstanceOf(Date);
    store.close();
  });
});

/**
 * getActiveWork — the ephemeral, pull-first cross-agent activity view. It reads
 * root sessions whose recency (transcript/event/started_at) is inside the window
 * OR that are still active, most-recent first and bounded, and canonicalizes /
 * self-excludes the actor. These tests drive started_at / ended_at / recency
 * directly (createSession stamps `now`) to exercise the window boundary.
 */
function ago(hours: number): string {
  return `datetime('now', '-${hours} hours')`;
}

function makeSession(
  store: ReturnType<typeof seed>,
  opts: {
    id: string;
    startedHoursAgo?: number;
    endedHoursAgo?: number | null;
    status?: string;
    parentSessionId?: string;
    ownerActor?: string;
    createdActor?: string;
  }
) {
  createSession(store.db, {
    id: opts.id,
    projectId: "p",
    title: opts.id,
    cwd: "/repo",
    status: (opts.status as never) ?? "running",
    parentSessionId: opts.parentSessionId,
    kind: opts.parentSessionId ? "subagent" : undefined,
    agentId: opts.parentSessionId ? opts.id : undefined,
    agentType: opts.parentSessionId ? "worker" : undefined,
  });
  if (opts.startedHoursAgo !== undefined) {
    store.db.run(
      `UPDATE sessions SET started_at = ${ago(opts.startedHoursAgo)} WHERE id = ?`,
      [opts.id]
    );
  }
  if (opts.endedHoursAgo != null) {
    store.db.run(
      `UPDATE sessions SET ended_at = ${ago(opts.endedHoursAgo)} WHERE id = ?`,
      [opts.id]
    );
  }
  if (opts.createdActor) setSessionCreatedActor(store.db, opts.id, opts.createdActor);
  if (opts.ownerActor) assignSessionOwner(store.db, opts.id, opts.ownerActor);
}

describe("getActiveWork", () => {
  test("window: keeps active + recently-ended, drops stale-ended", () => {
    const store = seed(); // "parent" is active (started now)
    // Ended just inside the window — a "just finished" run, kept and labeled done.
    makeSession(store, { id: "recent-done", startedHoursAgo: 2, endedHoursAgo: 1, status: "done" });
    // Active but old — no ended_at, so still shown regardless of the window.
    makeSession(store, { id: "old-active", startedHoursAgo: 48 });
    // Ended long ago and started long ago — outside the 24h window, dropped.
    makeSession(store, { id: "stale-done", startedHoursAgo: 72, endedHoursAgo: 48, status: "done" });

    const ids = getActiveWork(store.db, "p").map((w) => w.sessionId);
    expect(ids).toContain("parent");
    expect(ids).toContain("recent-done");
    expect(ids).toContain("old-active");
    expect(ids).not.toContain("stale-done");

    // The recently-ended row carries its terminal status through.
    const done = getActiveWork(store.db, "p").find((w) => w.sessionId === "recent-done");
    expect(done?.status).toBe("done");
    store.close();
  });

  test("terminal done root with a NULL ended_at is windowed, not active forever", () => {
    const store = seed();
    // Stop cleared ended_at and classifyTurnEnd set status=done without
    // restamping it; its last activity is 30h ago — outside the window, so it
    // is NOT returned as active despite ended_at being NULL.
    makeSession(store, { id: "done-open-stale", startedHoursAgo: 30, status: "done" });
    // A genuinely long-running root (no ended_at, non-terminal) IS still active.
    makeSession(store, { id: "running-open-stale", startedHoursAgo: 30, status: "running" });
    // A done root whose activity is inside the window still shows (labeled done).
    makeSession(store, { id: "done-open-recent", startedHoursAgo: 2, status: "done" });

    const work = getActiveWork(store.db, "p");
    const ids = work.map((w) => w.sessionId);
    expect(ids).not.toContain("done-open-stale");
    expect(ids).toContain("running-open-stale");
    expect(ids).toContain("done-open-recent");
    expect(work.find((w) => w.sessionId === "done-open-recent")?.status).toBe("done");
    store.close();
  });

  test("recency fallback: a fresh transcript event lifts an old-started session into the window", () => {
    const store = seed();
    // Started + ended outside the window, so by started_at alone it would drop.
    makeSession(store, { id: "revived", startedHoursAgo: 72, endedHoursAgo: 48, status: "done" });
    // But a transcript event landed an hour ago — recency is MAX(transcript), inside 24h.
    store.db.run(
      `INSERT INTO transcript_events (session_id, seq, event_json, created_at)
         VALUES (?, 1, '{}', ${ago(1)})`,
      ["revived"]
    );

    const ids = getActiveWork(store.db, "p").map((w) => w.sessionId);
    expect(ids).toContain("revived");
    store.close();
  });

  test("root-only: subagent children never appear as their own row", () => {
    const store = seed();
    makeSession(store, { id: "parent:agent-1", parentSessionId: "parent" });

    const ids = getActiveWork(store.db, "p").map((w) => w.sessionId);
    expect(ids).toEqual(["parent"]);
    store.close();
  });

  test("exclude: drops sessions whose canonical actor matches excludeActor", () => {
    const store = seed();
    assignSessionOwner(store.db, "parent", "alice");
    makeSession(store, { id: "bob-work", ownerActor: "bob" });

    const forAlice = getActiveWork(store.db, "p", { excludeActor: "alice" }).map((w) => w.sessionId);
    expect(forAlice).toContain("bob-work");
    expect(forAlice).not.toContain("parent");

    // No exclusion returns both; the actor is surfaced (owner preferred).
    const all = getActiveWork(store.db, "p");
    expect(all.find((w) => w.sessionId === "parent")?.actor).toBe("alice");
    expect(all.find((w) => w.sessionId === "bob-work")?.actor).toBe("bob");
    store.close();
  });

  test("harness: surfaces the launch's harness, unset when the launch recorded none", () => {
    const store = seed();
    makeSession(store, { id: "codex-sess" });
    makeSession(store, { id: "claude-sess" });
    // A codex launch records its harness; a default Claude launch records none (NULL).
    store.db.run(
      `INSERT INTO launches (id, project_id, task, worktree_path, branch, session_id, harness)
         VALUES ('l-codex', 'p', 't', '/wt/codex', 'main', 'codex-sess', 'codex')`
    );
    store.db.run(
      `INSERT INTO launches (id, project_id, task, worktree_path, branch, session_id, harness)
         VALUES ('l-claude', 'p', 't', '/wt/claude', 'main', 'claude-sess', NULL)`
    );

    const work = getActiveWork(store.db, "p");
    expect(work.find((w) => w.sessionId === "codex-sess")?.harness).toBe("codex");
    expect(work.find((w) => w.sessionId === "claude-sess")?.harness).toBeUndefined();
    // A session with no launch at all also reads unset.
    expect(work.find((w) => w.sessionId === "parent")?.harness).toBeUndefined();
    store.close();
  });

  test("bound: never returns more than the limit, most-recent first", () => {
    const store = seed();
    for (let i = 0; i < 6; i++) {
      makeSession(store, { id: `s${i}`, startedHoursAgo: i });
    }
    const limited = getActiveWork(store.db, "p", { limit: 3 });
    expect(limited).toHaveLength(3);
    // Most-recent first: "parent" (now) then the least-hours-ago sessions.
    expect(limited[0].sessionId).toBe("parent");
    store.close();
  });

  test("scopes to the project — a sibling project's work is not returned", () => {
    const store = seed();
    upsertProject(store.db, { id: "other", name: "other", branch: "main", repos: [] });
    createSession(store.db, {
      id: "other-1",
      projectId: "other",
      title: "elsewhere",
      cwd: "/other",
      status: "running",
    });
    const ids = getActiveWork(store.db, "p").map((w) => w.sessionId);
    expect(ids).not.toContain("other-1");
    store.close();
  });
});

describe("title write paths cap so a stored title is never a wall of text", () => {
  test("updateSessionTitle caps a long first-prompt title on write", () => {
    const store = seed();
    // "" normalizes to NULL, so the first-write-wins update actually writes.
    createSession(store.db, {
      id: "cap-me",
      projectId: "p",
      title: "",
      cwd: "/repo",
      status: "running",
    });
    updateSessionTitle(store.db, "cap-me", "make ".repeat(60).trim());
    const title = getSession(store.db, "cap-me")!.title;
    expect(title.length).toBeLessThanOrEqual(70);
    expect(title.endsWith("…")).toBe(true);
    store.close();
  });

  test("upgradeSessionTitle overwrites only when the title still matches, and caps", () => {
    const store = seed();
    createSession(store.db, {
      id: "upgrade-me",
      projectId: "p",
      title: "the capped raw title…",
      cwd: "/repo",
      status: "running",
    });

    // A stale expected value (the title moved on, e.g. /clear) is a no-op.
    expect(upgradeSessionTitle(store.db, "upgrade-me", "New Title", "something else")).toBe(false);
    expect(getSession(store.db, "upgrade-me")!.title).toBe("the capped raw title…");

    // Matching expected value overwrites — and the new title is capped too.
    const long = "brand ".repeat(60).trim();
    expect(upgradeSessionTitle(store.db, "upgrade-me", long, "the capped raw title…")).toBe(true);
    const title = getSession(store.db, "upgrade-me")!.title;
    expect(title.length).toBeLessThanOrEqual(70);
    expect(title.endsWith("…")).toBe(true);
    store.close();
  });
});

describe("deleteSession cascades to children", () => {
  test("deleting a parent removes its children and their events (self-FK has no ON DELETE)", () => {
    const store = seed();
    seedChild(store);
    // Give the child an event so the cascade must clear a dependent row too.
    insertEvent(store.db, "parent:agent-1", "SubagentStart", { transcript_path: "/t.jsonl" });

    const counts = deleteSession(store.db, "parent");
    expect(counts.events).toBeGreaterThanOrEqual(1);

    expect(getSession(store.db, "parent")).toBeNull();
    expect(getSession(store.db, "parent:agent-1")).toBeNull();
    expect(getSubagentSessions(store.db)).toHaveLength(0);
    // The child's event row is gone too.
    const remaining = store.db
      .query("SELECT COUNT(*) AS n FROM events WHERE session_id = ?")
      .get("parent:agent-1") as { n: number };
    expect(remaining.n).toBe(0);
    store.close();
  });
});
