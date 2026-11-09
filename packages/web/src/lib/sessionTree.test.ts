import { expect, test, describe } from "bun:test";
import type { Session } from "@standup/shared";
import {
  buildSessionTree,
  childSessions,
  consolidatedChildren,
  sortedChildren,
  visibleChildren,
  DEFAULT_VISIBLE_CHILDREN,
  liveAgentCounts,
} from "./sessionTree";

/** A minimal session; only the fields the tree logic reads matter here. */
function session(
  id: string,
  parentSessionId?: string,
  createdActor?: string
): Session {
  return {
    id,
    projectId: "p",
    title: id,
    cwd: "/repo",
    parentSessionId,
    createdActor,
    status: "running",
    startedAt: new Date(),
  };
}

describe("buildSessionTree", () => {
  test("splits roots from children and nests each child under its parent", () => {
    const sessions = [
      session("root-a"),
      session("root-a:agent-1", "root-a"),
      session("root-b"),
      session("root-a:agent-2", "root-a"),
    ];

    const { roots, childrenByParent } = buildSessionTree(sessions);

    // Children never appear as roots.
    expect(roots.map((s) => s.id)).toEqual(["root-a", "root-b"]);

    // Both children nest under their parent, in input order.
    expect(childrenByParent.get("root-a")?.map((s) => s.id)).toEqual([
      "root-a:agent-1",
      "root-a:agent-2",
    ]);
    // A root with no children has no entry.
    expect(childrenByParent.get("root-b")).toBeUndefined();
  });

  test("a list with no children is all roots", () => {
    const { roots, childrenByParent } = buildSessionTree([session("a"), session("b")]);
    expect(roots).toHaveLength(2);
    expect(childrenByParent.size).toBe(0);
  });
});

describe("childSessions", () => {
  test("returns only the direct children of the given parent", () => {
    const sessions = [
      session("root-a"),
      session("root-a:agent-1", "root-a"),
      session("root-b"),
      session("root-b:agent-1", "root-b"),
    ];
    expect(childSessions(sessions, "root-a").map((s) => s.id)).toEqual(["root-a:agent-1"]);
    expect(childSessions(sessions, "root-a:agent-1")).toHaveLength(0);
  });
});

describe("visibleChildren / consolidatedChildren", () => {
  const NOW = Date.now();

  /** A child of "root" with controllable status/recency. */
  function child(id: string, over: Partial<Session> = {}): Session {
    return {
      id,
      projectId: "p",
      title: id,
      cwd: "/repo",
      parentSessionId: "root",
      status: "running",
      startedAt: new Date(NOW),
      ...over,
    } as Session;
  }

  // Two running (different start recency) and two ended (different end recency).
  const mixed = [
    child("done-old", { status: "done", endedAt: new Date(NOW - 50_000) }),
    child("run-old", { startedAt: new Date(NOW - 100_000) }),
    child("done-new", { status: "done", endedAt: new Date(NOW - 1_000) }),
    child("run-new", { startedAt: new Date(NOW - 1_000) }),
  ];

  test("sortedChildren orders running-first, then by recency", () => {
    expect(sortedChildren(mixed, "root").map((s) => s.id)).toEqual([
      "run-new",
      "run-old",
      "done-new",
      "done-old",
    ]);
  });

  test("visibleChildren with no options returns the full sorted set (the show-all expansion)", () => {
    expect(visibleChildren(mixed, "root").map((s) => s.id)).toEqual([
      "run-new",
      "run-old",
      "done-new",
      "done-old",
    ]);
  });

  test("visibleChildren caps to the limit, keeping the running-first order", () => {
    expect(visibleChildren(mixed, "root", { limit: 2 }).map((s) => s.id)).toEqual([
      "run-new",
      "run-old",
    ]);
  });

  test("runningOnly keeps just the live children", () => {
    expect(visibleChildren(mixed, "root", { runningOnly: true }).map((s) => s.id)).toEqual([
      "run-new",
      "run-old",
    ]);
  });

  test("does not mutate the input array's order", () => {
    const before = mixed.map((s) => s.id);
    visibleChildren(mixed, "root", { limit: 1 });
    expect(mixed.map((s) => s.id)).toEqual(before);
  });

  test("consolidatedChildren caps a large finished fan-out to the default (a 50-child parent shows <=5)", () => {
    const kids = Array.from({ length: 50 }, (_, i) =>
      child(`k${i}`, { status: "done", endedAt: new Date(NOW - i * 1_000) })
    );
    const shown = consolidatedChildren(kids, "root");
    expect(shown).toHaveLength(DEFAULT_VISIBLE_CHILDREN);
    // The five most recently ended (k0 ended most recently).
    expect(shown.map((s) => s.id)).toEqual(["k0", "k1", "k2", "k3", "k4"]);
  });

  test("consolidatedChildren shows every running subagent even beyond the default", () => {
    const running = Array.from({ length: 8 }, (_, i) =>
      child(`r${i}`, { startedAt: new Date(NOW - i * 1_000) })
    );
    const done = Array.from({ length: 20 }, (_, i) =>
      child(`d${i}`, { status: "done", endedAt: new Date(NOW - i * 1_000) })
    );
    const shown = consolidatedChildren([...running, ...done], "root");
    expect(shown).toHaveLength(8);
    expect(shown.every((s) => s.status === "running")).toBe(true);
  });

  test("consolidatedChildren of a parent with no children is empty", () => {
    expect(consolidatedChildren([child("only", { parentSessionId: "other" })], "root")).toEqual([]);
  });
});

describe("Mine lens nests children in both sidebar layouts", () => {
  // A subagent child carries no `createdActor` (createSession does not stamp one
  // for children), so the "Mine" lens — which keeps only the current user's
  // sessions — filters it out. Both the flat and grouped sidebars therefore
  // source their top-level rows from the narrowed set but their children from
  // the FULL set, so an owned root's subsession still nests under it.
  const ME = "alice";
  const full = [
    session("root-mine", undefined, ME),
    session("root-mine:agent-1", "root-mine"), // child: no createdActor
    session("root-theirs", undefined, "bob"),
    session("root-theirs:agent-1", "root-theirs"),
  ];
  // The "Mine" narrowing the sidebar applies before it lays sessions out.
  const mine = full.filter((s) => s.createdActor === ME);

  test("the narrowed set alone drops the child (the bug the full-set lookup fixes)", () => {
    // Sourcing children from the narrowed set — the pre-fix behavior — loses the
    // child entirely, since it is never "mine".
    expect(childSessions(mine, "root-mine")).toHaveLength(0);
  });

  test("flat layout: root from narrowed set, child from full set, child never a top-level row", () => {
    const { roots } = buildSessionTree(mine);
    expect(roots.map((s) => s.id)).toEqual(["root-mine"]);

    const children = childSessions(full, "root-mine");
    expect(children.map((s) => s.id)).toEqual(["root-mine:agent-1"]);

    // A child is never promoted to a top-level row.
    expect(roots.some((r) => r.parentSessionId)).toBe(false);
  });

  test("grouped layout: root from narrowed set, child from full set, child never a top-level row", () => {
    const projectRoots = mine.filter((s) => s.projectId === "p" && !s.parentSessionId);
    expect(projectRoots.map((s) => s.id)).toEqual(["root-mine"]);

    const children = childSessions(full, "root-mine");
    expect(children.map((s) => s.id)).toEqual(["root-mine:agent-1"]);

    expect(projectRoots.some((r) => r.parentSessionId)).toBe(false);
  });
});

describe("liveAgentCounts", () => {
  /** A root session with the given status, ended when `ended` is set. */
  function root(id: string, status: Session["status"], ended = false): Session {
    return {
      ...session(id),
      status,
      endedAt: ended ? new Date("2026-10-01T00:00:00Z") : undefined,
    };
  }

  test("counts only open roots: ended sessions and subagent children are left out", () => {
    // The console boots from the ?all=1 collection, so ended rows ride along.
    const sessions: Session[] = [
      root("run-1", "running"),
      root("run-2", "running"),
      root("wait-1", "waiting"),
      root("idle-1", "idle"),
      root("idle-2", "idle"),
      root("idle-3", "idle"),
      root("stall-1", "stalled"),
      root("done-1", "done", true),
      root("done-2", "done", true),
      // An idle row stamped by a SessionEnd is not in the Sessions API's live list.
      root("ended-idle", "idle", true),
      root("ended-stalled", "stalled", true),
      // A turn-complete root with no end stamp is still open (the Sessions API
      // lists it), so it counts — in its own bucket, not as idle.
      root("done-unstamped", "done"),
      { ...session("run-1:agent-1", "run-1"), status: "running" },
    ];

    expect(liveAgentCounts(sessions)).toEqual({
      running: 2,
      waiting: 1,
      idle: 3,
      stalled: 1,
      done: 1,
    });
  });

  test("the total matches the Sessions API's default list: roots with no end stamp", () => {
    const sessions: Session[] = [
      root("a", "running"),
      root("b", "idle"),
      root("c", "done"),
      root("d", "done", true),
      root("e", "idle", true),
    ];
    // getActiveSessions: ended_at IS NULL AND parent_session_id IS NULL → a, b, c.
    const counts = liveAgentCounts(sessions);
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(3);
  });

  test("an all-ended collection counts zero live agents", () => {
    const sessions = Array.from({ length: 300 }, (_, i) => root(`old-${i}`, "done", true));
    expect(liveAgentCounts(sessions)).toEqual({
      running: 0,
      waiting: 0,
      idle: 0,
      stalled: 0,
      done: 0,
    });
  });
});
