import { expect, test, describe } from "bun:test";
import { createStore } from "../store.js";
import type { Store } from "../store.js";
import {
  upsertProject,
  createSession,
  upsertActor,
  getActor,
  getActors,
  mergeActors,
  recordParticipant,
  getParticipants,
  setSessionCreatedActor,
  assignSessionOwner,
  getSession,
  MAX_SESSION_PARTICIPANTS,
} from "../index.js";

/**
 * Collaboration model: actors seeded from the tunnel
 * alias, a write-once session origin, a reassignable owner, and a best-effort
 * participant set that dedups and caps.
 */

function setUp(): Store {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  return store;
}

function newSession(store: Store, id: string): void {
  createSession(store.db, {
    id,
    projectId: "p",
    title: "",
    cwd: `/tmp/${id}`,
    status: "running",
  });
}

describe("upsertActor", () => {
  test("creates a row on first sighting, display/github unset", () => {
    const store = setUp();
    const a = upsertActor(store.db, "alice");
    expect(a.id).toBe("alice");
    expect(a.display).toBeUndefined();
    expect(a.githubLogin).toBeUndefined();
    expect(a.firstSeen).toBeInstanceOf(Date);
    expect(a.lastSeen).toBeInstanceOf(Date);
    store.close();
  });

  test("is idempotent per id — first_seen fixed, last_seen advances", () => {
    const store = setUp();
    const first = upsertActor(store.db, "bob");
    const firstSeen = first.firstSeen.toISOString();

    store.db.run("UPDATE actors SET last_seen = datetime('now','-5 minutes') WHERE id = 'bob'");
    const stale = getActor(store.db, "bob")!.lastSeen.getTime();

    const again = upsertActor(store.db, "bob");
    expect(again.firstSeen.toISOString()).toBe(firstSeen);
    expect(again.lastSeen.getTime()).toBeGreaterThan(stale);
    store.close();
  });

  test("stores display/github when given and preserves them on a later bare call", () => {
    const store = setUp();
    upsertActor(store.db, "carol", { display: "Carol X", githubLogin: "carolx" });
    expect(getActor(store.db, "carol")?.display).toBe("Carol X");
    expect(getActor(store.db, "carol")?.githubLogin).toBe("carolx");

    // A later call that omits them must not blank them (COALESCE).
    upsertActor(store.db, "carol");
    expect(getActor(store.db, "carol")?.display).toBe("Carol X");
    expect(getActor(store.db, "carol")?.githubLogin).toBe("carolx");
    store.close();
  });
});

describe("setSessionCreatedActor (write-once)", () => {
  test("stamps the origin once and never overwrites it", () => {
    const store = setUp();
    newSession(store, "S1");

    setSessionCreatedActor(store.db, "S1", "alice");
    expect(getSession(store.db, "S1")?.createdActor).toBe("alice");

    // A later stamp with a different actor is a no-op.
    setSessionCreatedActor(store.db, "S1", "bob");
    expect(getSession(store.db, "S1")?.createdActor).toBe("alice");
    store.close();
  });
});

describe("assignSessionOwner (updates only owner)", () => {
  test("sets and reassigns owner while leaving created_actor untouched", () => {
    const store = setUp();
    newSession(store, "S1");
    setSessionCreatedActor(store.db, "S1", "alice");

    assignSessionOwner(store.db, "S1", "bob");
    let s = getSession(store.db, "S1")!;
    expect(s.ownerActor).toBe("bob");
    expect(s.createdActor).toBe("alice");

    assignSessionOwner(store.db, "S1", "carol");
    s = getSession(store.db, "S1")!;
    expect(s.ownerActor).toBe("carol");
    expect(s.createdActor).toBe("alice");
    store.close();
  });
});

describe("mergeActors (identity reconciliation)", () => {
  test("folds one row into another: getActor resolves, getActors hides it", () => {
    const store = setUp();
    upsertActor(store.db, "slack:U1");
    upsertActor(store.db, "alice");

    mergeActors(store.db, "slack:U1", "alice");

    // Attribution that pointed at the Slack row now resolves to the human.
    expect(getActor(store.db, "slack:U1")?.id).toBe("alice");
    expect(getActor(store.db, "slack:U1")?.mergedInto).toBeUndefined();
    expect(getActor(store.db, "alice")?.id).toBe("alice");

    // The folded row no longer lists as a separate collaborator.
    const ids = getActors(store.db).map((a) => a.id);
    expect(ids).toContain("alice");
    expect(ids).not.toContain("slack:U1");
    store.close();
  });

  test("canonical adopts identity the folded row has and it lacks (COALESCE)", () => {
    const store = setUp();
    upsertActor(store.db, "slack:U1", { githubLogin: "alicegh" });
    upsertActor(store.db, "alice", { display: "Alice" });

    mergeActors(store.db, "slack:U1", "alice");

    const alice = getActor(store.db, "alice")!;
    expect(alice.display).toBe("Alice"); // kept its own
    expect(alice.githubLogin).toBe("alicegh"); // adopted the folded row's
    store.close();
  });

  test("does not clobber an identity the canonical already carries", () => {
    const store = setUp();
    upsertActor(store.db, "slack:U1", { display: "Slack Alice" });
    upsertActor(store.db, "alice", { display: "Alice" });

    mergeActors(store.db, "slack:U1", "alice");

    expect(getActor(store.db, "alice")?.display).toBe("Alice");
    store.close();
  });

  test("keeps the chain one hop deep — merging b→c repoints a→b onto c", () => {
    const store = setUp();
    upsertActor(store.db, "a");
    upsertActor(store.db, "b");
    upsertActor(store.db, "c");

    mergeActors(store.db, "a", "b");
    mergeActors(store.db, "b", "c");

    // Both former tombstones resolve straight to the head.
    expect(getActor(store.db, "a")?.id).toBe("c");
    expect(getActor(store.db, "b")?.id).toBe("c");
    // And a's pointer was repointed, not left dangling at b.
    const aRow = store.db
      .query("SELECT merged_into FROM actors WHERE id = 'a'")
      .get() as { merged_into: string };
    expect(aRow.merged_into).toBe("c");
    expect(getActors(store.db).map((x) => x.id)).toEqual(["c"]);
    store.close();
  });

  test("self-merge is a no-op", () => {
    const store = setUp();
    upsertActor(store.db, "alice");
    mergeActors(store.db, "alice", "alice");
    expect(getActor(store.db, "alice")?.mergedInto).toBeUndefined();
    expect(getActors(store.db).map((a) => a.id)).toEqual(["alice"]);
    store.close();
  });

  test("merging into an already-folded actor collapses onto its head", () => {
    const store = setUp();
    upsertActor(store.db, "a");
    upsertActor(store.db, "b");
    upsertActor(store.db, "c");
    mergeActors(store.db, "b", "c"); // b folds into c

    // Now fold a into b — but b is already a tombstone for c.
    mergeActors(store.db, "a", "b");

    expect(getActor(store.db, "a")?.id).toBe("c");
    const aRow = store.db
      .query("SELECT merged_into FROM actors WHERE id = 'a'")
      .get() as { merged_into: string };
    expect(aRow.merged_into).toBe("c");
    store.close();
  });
});

describe("recordParticipant (idempotent + capped)", () => {
  test("upserts the actor and records one row per (session, actor)", () => {
    const store = setUp();
    newSession(store, "S1");

    recordParticipant(store.db, "S1", "alice");
    expect(getActor(store.db, "alice")).not.toBeNull();

    // A repeat sighting bumps the count, never a second row.
    recordParticipant(store.db, "S1", "alice");
    const parts = getParticipants(store.db, "S1");
    expect(parts).toHaveLength(1);
    expect(parts[0].actorId).toBe("alice");
    expect(parts[0].contributionCount).toBe(2);
    store.close();
  });

  test("caps distinct participants at MAX_SESSION_PARTICIPANTS", () => {
    const store = setUp();
    newSession(store, "S1");

    for (let i = 0; i < MAX_SESSION_PARTICIPANTS; i++) {
      recordParticipant(store.db, "S1", `a${i}`);
    }
    expect(getParticipants(store.db, "S1")).toHaveLength(MAX_SESSION_PARTICIPANTS);

    // One past the cap is dropped from the participant set.
    recordParticipant(store.db, "S1", "over-the-cap");
    const parts = getParticipants(store.db, "S1");
    expect(parts).toHaveLength(MAX_SESSION_PARTICIPANTS);
    expect(parts.some((p) => p.actorId === "over-the-cap")).toBe(false);
    store.close();
  });
});
