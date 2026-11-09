import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import { SessionThreads, type SessionThread } from "./session-threads.js";

// s3-link: the thread↔session link is persisted durably and its reverse index
// (rootTs→session) is rebuilt on startup, so links survive a collector restart
// and a thread reply routes back to its session. Unlink clears BOTH directions.

const cleanups: string[] = [];
let seq = 0;

/** A fresh throwaway state-file path (never the real one). */
function tmpPath(): string {
  const path = join(tmpdir(), `standup-slack-threads-${process.pid}-${++seq}.json`);
  cleanups.push(path);
  return path;
}

/** Open a SessionThreads bound to `path` — call again on the same path to simulate a restart. */
function openAt(path: string): SessionThreads {
  process.env.STANDUP_SLACK_STATE = path;
  return new SessionThreads();
}

function binding(sessionId: string, rootTs: string, channel = "C1"): SessionThread {
  return {
    sessionId,
    channel,
    rootTs,
    title: sessionId.slice(0, 8),
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
  };
}

/** Write a raw state file with explicit lastActivityAt values (bypasses set()'s clock). */
function writeState(path: string, sessions: SessionThread[]): void {
  writeFileSync(path, JSON.stringify({ sessions }, null, 2));
}

afterAll(() => {
  for (const p of cleanups) {
    try {
      rmSync(p, { force: true });
    } catch {
      /* best effort */
    }
  }
});

describe("SessionThreads persistence + reverse index", () => {
  test("link survives a simulated restart with the reverse index rebuilt", () => {
    const path = tmpPath();
    const a = openAt(path);
    // A brand-new binding flushes synchronously, so the file is on disk already.
    a.set(binding("session-alpha", "1700000000.0001"));
    a.set(binding("session-beta", "1700000000.0002", "C2"));

    // Restart: a fresh instance reads the same file and rebuilds byRoot on load.
    const b = openAt(path);
    expect(b.get("session-alpha")?.rootTs).toBe("1700000000.0001");
    expect(b.get("session-beta")?.channel).toBe("C2");
    // Forward AND reverse routes both come back.
    expect(b.sessionForRoot("1700000000.0001")).toBe("session-alpha");
    expect(b.sessionForRoot("1700000000.0002")).toBe("session-beta");
    expect(b.all()).toHaveLength(2);
  });

  test("persisted live-turn fields (s2) round-trip too", () => {
    const path = tmpPath();
    const a = openAt(path);
    const t = binding("session-live", "1700000000.0003");
    t.liveTs = "1700000000.9999";
    t.liveMode = "stream";
    t.liveEmitted = 3;
    t.lastTurnKey = "a4:0";
    a.set(t);

    const restored = openAt(path).get("session-live");
    expect(restored?.liveTs).toBe("1700000000.9999");
    expect(restored?.liveMode).toBe("stream");
    expect(restored?.liveEmitted).toBe(3);
    expect(restored?.lastTurnKey).toBe("a4:0");
  });

  test("unlink clears BOTH directions and the removal survives a restart", () => {
    const path = tmpPath();
    const a = openAt(path);
    a.set(binding("session-gamma", "1700000000.0004"));
    expect(a.sessionForRoot("1700000000.0004")).toBe("session-gamma");

    a.delete("session-gamma");
    // Both directions cleared in memory immediately.
    expect(a.get("session-gamma")).toBeUndefined();
    expect(a.sessionForRoot("1700000000.0004")).toBeUndefined();

    // delete() persists on a debounce — flush so the removal is durable, then restart.
    a.flush();
    const b = openAt(path);
    expect(b.get("session-gamma")).toBeUndefined();
    expect(b.sessionForRoot("1700000000.0004")).toBeUndefined();
    expect(b.all()).toHaveLength(0);
  });

  test("deleting a session does not steal a rootTs a newer session re-bound", () => {
    // A recycled rootTs (unusual, but the guard exists for it): the reverse route
    // belongs to whoever bound it last, and unlinking the stale owner must not
    // clear the live route.
    const path = tmpPath();
    const a = openAt(path);
    a.set(binding("session-old", "1700000000.0005"));
    a.set(binding("session-new", "1700000000.0005"));
    expect(a.sessionForRoot("1700000000.0005")).toBe("session-new");

    a.delete("session-old");
    expect(a.get("session-old")).toBeUndefined();
    // The reverse route still points at the current owner.
    expect(a.sessionForRoot("1700000000.0005")).toBe("session-new");
    expect(a.get("session-new")?.rootTs).toBe("1700000000.0005");
  });

  test("a missing state file loads as empty, not a crash", () => {
    const path = tmpPath(); // never written
    const a = openAt(path);
    expect(a.all()).toHaveLength(0);
    expect(a.sessionForRoot("nope")).toBeUndefined();
  });

  // ---- reverse-index hardening (s3): one live session per rootTs -----------

  test("(a) a shared rootTs resolves to the most-recently-active owner after reload, not the oldest", () => {
    // LOAD-vs-RUNTIME consistency: two bindings forward-own the same rootTs. On
    // disk (array order is deliberately oldest-first to trip the old iterate-last
    // bug), the reload must name the most-recently-active owner — identical to
    // runtime last-write-wins — never the oldest-active flip.
    const path = tmpPath();
    writeState(path, [
      { ...binding("session-older", "R"), lastActivityAt: "2026-01-01T00:00:00Z" },
      { ...binding("session-newer", "R"), lastActivityAt: "2026-06-01T00:00:00Z" },
    ]);
    const b = openAt(path);
    expect(b.sessionForRoot("R")).toBe("session-newer");
    expect(b.ownsRoot("session-newer", "R")).toBe(true);
  });

  test("(a) a runtime set→rebind→reload cycle resolves to the current owner both before and after reload", () => {
    const path = tmpPath();
    const a = openAt(path);
    a.set(binding("session-x", "OLD"));
    expect(a.sessionForRoot("OLD")).toBe("session-x");

    // Channel change mints a fresh rootTs for the SAME session.
    a.set(binding("session-x", "NEW"));
    expect(a.sessionForRoot("NEW")).toBe("session-x");
    // The stale OLD thread no longer routes anywhere — its reverse entry was unlinked.
    expect(a.sessionForRoot("OLD")).toBeUndefined();

    a.flush();
    const b = openAt(path);
    expect(b.sessionForRoot("NEW")).toBe("session-x");
    expect(b.sessionForRoot("OLD")).toBeUndefined();
  });

  test("(b) a recycled/shared rootTs never routes to a session whose current rootTs differs", () => {
    const path = tmpPath();
    const a = openAt(path);
    a.set(binding("S2", "R1")); // S2 first bound to R1
    a.set(binding("S1", "R1")); // S1 takes R1 (newest wins the reverse route)
    a.set(binding("S2", "R2")); // S2 moves on to its own rootTs

    // A reply on R1 routes to the CURRENT owner S1, never the recycled S2.
    expect(a.sessionForRoot("R1")).toBe("S1");
    expect(a.sessionForRoot("R2")).toBe("S2");
    // The cross-check refuses to name S2 for R1 even though S2 once held it.
    expect(a.ownsRoot("S2", "R1")).toBe(false);
    expect(a.ownsRoot("S1", "R1")).toBe(true);
  });

  test("(c) delete + channel-change leave no orphan reverse route", () => {
    const path = tmpPath();
    const a = openAt(path);

    // Channel change: the OLD rootTs must not survive as an orphan pointing at the session.
    a.set(binding("sess-move", "root-old"));
    a.set(binding("sess-move", "root-new"));
    expect(a.sessionForRoot("root-old")).toBeUndefined();
    expect(a.sessionForRoot("root-new")).toBe("sess-move");

    // Delete clears the session's reverse route unconditionally (its current rootTs).
    a.delete("sess-move");
    expect(a.sessionForRoot("root-new")).toBeUndefined();
    expect(a.all()).toHaveLength(0);

    // No stale reverse entry lingers for either rootTs after a reload.
    a.flush();
    const b = openAt(path);
    expect(b.sessionForRoot("root-old")).toBeUndefined();
    expect(b.sessionForRoot("root-new")).toBeUndefined();
  });

  test("(c) delete never steals a rootTs a newer session re-bound", () => {
    // Same rootTs, two sessions: deleting the stale one must not clear the live route.
    const path = tmpPath();
    const a = openAt(path);
    a.set(binding("session-old", "SHARED"));
    a.set(binding("session-new", "SHARED"));
    expect(a.sessionForRoot("SHARED")).toBe("session-new");

    a.delete("session-old");
    expect(a.get("session-old")).toBeUndefined();
    expect(a.sessionForRoot("SHARED")).toBe("session-new"); // live route intact
  });
});
