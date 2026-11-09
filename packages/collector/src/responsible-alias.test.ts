// The routing key behind owner-routed attention: a push/alert for a session is
// keyed on its RESPONSIBLE human, resolved owner → creator → earliest
// participant — NOT owner_actor alone, which is unset until a human explicitly
// claims a session. These lock in that a self-launched session (creator set,
// owner unclaimed) still resolves to the responsible human, so its ask/plan/
// alert routes to them instead of being suppressed as "owner-less".

import { expect, test, describe } from "bun:test";
import {
  createStore,
  upsertProject,
  createSession,
  setSessionCreatedActor,
  assignSessionOwner,
  upsertActor,
  recordParticipant,
  getSession,
} from "@standup/store";
import type { Store } from "@standup/store";
import { responsibleAlias } from "./server.js";

function setUp(): Store {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  createSession(store.db, {
    id: "S1",
    projectId: "p",
    title: "",
    cwd: "/tmp/S1",
    status: "running",
  });
  return store;
}

describe("responsibleAlias — who a push/alert routes to", () => {
  test("prefers the explicitly-claimed owner", () => {
    const store = setUp();
    setSessionCreatedActor(store.db, "S1", "alice");
    upsertActor(store.db, "bob");
    assignSessionOwner(store.db, "S1", "bob");
    expect(responsibleAlias(store.db, getSession(store.db, "S1"))).toBe("bob");
    store.close();
  });

  test("falls back to the creator when no owner is claimed (the common self-launched session)", () => {
    const store = setUp();
    // owner_actor is NULL — the state of essentially every session until someone
    // uses the assign-owner action. The responsible human is still the creator.
    setSessionCreatedActor(store.db, "S1", "alice");
    expect(responsibleAlias(store.db, getSession(store.db, "S1"))).toBe("alice");
    store.close();
  });

  test("falls back to the earliest participant when neither owner nor creator is set", () => {
    const store = setUp();
    recordParticipant(store.db, "S1", "carol");
    expect(responsibleAlias(store.db, getSession(store.db, "S1"))).toBe("carol");
    store.close();
  });

  test("undefined for a wholly unattributed session — the only case a push is suppressed", () => {
    const store = setUp();
    expect(responsibleAlias(store.db, getSession(store.db, "S1"))).toBeUndefined();
    store.close();
  });
});
