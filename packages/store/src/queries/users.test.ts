import { expect, test, describe } from "bun:test";
import { createStore } from "../store.js";
import { touchUser, getUser, getUsers, countDistinctUsers } from "../index.js";

describe("touchUser", () => {
  test("creates a row on first sighting, display unset", () => {
    const store = createStore(":memory:");
    const u = touchUser(store.db, "alice");
    expect(u.alias).toBe("alice");
    expect(u.display).toBeUndefined();
    expect(u.firstSeen).toBeInstanceOf(Date);
    expect(u.lastSeen).toBeInstanceOf(Date);
    expect(getUser(store.db, "alice")?.alias).toBe("alice");
    store.close();
  });

  test("is idempotent per alias — one row, first_seen fixed, last_seen advances", () => {
    const store = createStore(":memory:");
    const first = touchUser(store.db, "bob");
    const firstSeen = first.firstSeen.toISOString();

    // Backdate last_seen so the next touch is observably later than a stored value.
    store.db.run("UPDATE users SET last_seen = datetime('now','-5 minutes') WHERE alias = 'bob'");
    const stale = getUser(store.db, "bob")!.lastSeen.getTime();

    const again = touchUser(store.db, "bob");
    expect(getUsers(store.db)).toHaveLength(1);
    expect(again.firstSeen.toISOString()).toBe(firstSeen);
    expect(again.lastSeen.getTime()).toBeGreaterThan(stale);
    store.close();
  });

  test("stores a display when given and preserves it on a later touch without one", () => {
    const store = createStore(":memory:");
    touchUser(store.db, "carol");
    expect(getUser(store.db, "carol")?.display).toBeUndefined();

    touchUser(store.db, "carol", { display: "Carol X" });
    expect(getUser(store.db, "carol")?.display).toBe("Carol X");

    // A later request that omits display must not blank it (COALESCE).
    touchUser(store.db, "carol");
    expect(getUser(store.db, "carol")?.display).toBe("Carol X");
    store.close();
  });

  test("getUser returns null for an unknown alias", () => {
    const store = createStore(":memory:");
    expect(getUser(store.db, "nobody")).toBeNull();
    store.close();
  });
});

/**
 * countDistinctUsers powers the multiplayer signal, so it must count PEOPLE who
 * connected through the gateway (via_tunnel set), not agent/MCP phone-home
 * traffic that resolves to the host `$USER`. Otherwise a single solo human whose
 * agent identity differs from their browser's tunnel alias trips the ≥2 count.
 */
describe("countDistinctUsers / via_tunnel", () => {
  test("agent phone-home rows (no tunnel header) are not counted as people", () => {
    const store = createStore(":memory:");
    // A solo human: their browser arrives via the tunnel, their own agents phone
    // home under the host $USER with no header. Two rows, ONE person.
    touchUser(store.db, "alice", { viaTunnel: true });
    touchUser(store.db, "hostuser"); // agent/MCP under host $USER
    touchUser(store.db, "local"); // agent env with no USER
    expect(getUsers(store.db)).toHaveLength(3);
    expect(countDistinctUsers(store.db)).toBe(1);
    store.close();
  });

  test("counts distinct tunnel-connected people", () => {
    const store = createStore(":memory:");
    touchUser(store.db, "alice", { viaTunnel: true });
    touchUser(store.db, "bob", { viaTunnel: true });
    expect(countDistinctUsers(store.db)).toBe(2);
    store.close();
  });

  test("via_tunnel is sticky — a later header-less touch does not downgrade a person", () => {
    const store = createStore(":memory:");
    // The same alias seen first via the tunnel, then again by a header-less
    // request (e.g. an agent running as the same host $USER) must stay a person.
    touchUser(store.db, "sameName", { viaTunnel: true });
    touchUser(store.db, "sameName"); // no header
    expect(countDistinctUsers(store.db)).toBe(1);
    store.close();
  });

  test("via_tunnel upgrades once a header is seen for an alias first seen without one", () => {
    const store = createStore(":memory:");
    touchUser(store.db, "sameName"); // agent first, no header
    expect(countDistinctUsers(store.db)).toBe(0);
    touchUser(store.db, "sameName", { viaTunnel: true }); // then a real browser
    expect(countDistinctUsers(store.db)).toBe(1);
    store.close();
  });
});
