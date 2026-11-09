import { expect, test, describe } from "bun:test";
import { DEFAULT_IDENTITY_HEADER } from "@standup/shared";
import {
  createStore,
  upsertProject,
  createSession,
  setSessionCreatedActor,
  getActor,
} from "@standup/store";
import type { Store } from "@standup/store";
import type { Session } from "@standup/shared";
import { createServer } from "./server.js";

/**
 * assign-owner: POST /api/sessions/:id/assign-owner claims
 * or reassigns the owner from the acting tunnel user (or an explicit body
 * actor), touching only owner_actor and leaving created_actor as it was.
 */

function setUp(): { store: Store; app: ReturnType<typeof createServer> } {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  createSession(store.db, {
    id: "S1",
    projectId: "p",
    title: "",
    cwd: "/tmp/S1",
    status: "running",
  });
  setSessionCreatedActor(store.db, "S1", "alice");
  return { store, app: createServer(store, () => {}, null) };
}

describe("POST /api/sessions/:id/assign-owner", () => {
  test("claims the session for the tunnel user, leaving created_actor untouched", async () => {
    const { store, app } = setUp();
    const res = await app.request("/api/sessions/S1/assign-owner", {
      method: "POST",
      headers: { [DEFAULT_IDENTITY_HEADER]: "bob" },
    });

    expect(res.status).toBe(200);
    const s = (await res.json()) as Session;
    expect(s.ownerActor).toBe("bob");
    expect(s.createdActor).toBe("alice");
    // The owner was seeded into the actor table.
    expect(getActor(store.db, "bob")).not.toBeNull();
    store.close();
  });

  test("an explicit body actor wins over the header", async () => {
    const { store, app } = setUp();
    const res = await app.request("/api/sessions/S1/assign-owner", {
      method: "POST",
      headers: { [DEFAULT_IDENTITY_HEADER]: "bob", "content-type": "application/json" },
      body: JSON.stringify({ actor: "carol" }),
    });

    const s = (await res.json()) as Session;
    expect(s.ownerActor).toBe("carol");
    store.close();
  });

  test("404 for an unknown session", async () => {
    const { store, app } = setUp();
    const res = await app.request("/api/sessions/nope/assign-owner", { method: "POST" });
    expect(res.status).toBe(404);
    store.close();
  });
});
