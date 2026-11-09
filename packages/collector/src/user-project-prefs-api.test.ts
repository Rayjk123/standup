import { expect, test, describe } from "bun:test";
import { DEFAULT_IDENTITY_HEADER } from "@standup/shared";
import {
  createStore,
  upsertProject,
  getUserProjectPrefs,
  putUserProjectPrefs,
} from "@standup/store";
import type { Store } from "@standup/store";
import type { UserPrefs } from "@standup/shared";
import { createServer } from "./server.js";

/**
 * §H API surface: GET/PUT /api/users/me/prefs?project=<id> selects the
 * per-(user, project) overlay; omitting `project` is the global §A profile.
 * The default test env is a single-user loopback bind with no write token, so
 * writes are trusted (see isTrustedProfileWrite) — the gate itself is covered in
 * user-prefs-put.test.ts and re-checked here for the overlay route.
 */

function setUp(...projectIds: string[]): { store: Store; app: ReturnType<typeof createServer> } {
  const store = createStore(":memory:");
  for (const id of projectIds) {
    upsertProject(store.db, { id, name: id, branch: "main", repos: [] });
  }
  return { store, app: createServer(store, () => {}, null) };
}

const JSON_HEADERS = (alias: string) => ({
  [DEFAULT_IDENTITY_HEADER]: alias,
  "content-type": "application/json",
});

describe("GET /api/users/me/prefs?project=<id>", () => {
  test("returns an empty-but-shaped overlay (alias + projectId) when none saved", async () => {
    const { store, app } = setUp("web");
    const res = await app.request("/api/users/me/prefs?project=web", {
      headers: { [DEFAULT_IDENTITY_HEADER]: "alice" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UserPrefs;
    expect(body.alias).toBe("alice");
    expect(body.projectId).toBe("web");
    expect(body.personalInstructions).toBeUndefined();
    store.close();
  });

  test("returns the raw overlay layer, not the merged view", async () => {
    const { store, app } = setUp("web");
    // Global says one thing; the overlay another. The editor edits one layer, so
    // GET must return the overlay's own text, un-merged with the global.
    putUserProjectPrefs(store.db, "alice", "web", { personalInstructions: "WEB only." });
    const res = await app.request("/api/users/me/prefs?project=web", {
      headers: { [DEFAULT_IDENTITY_HEADER]: "alice" },
    });
    const body = (await res.json()) as UserPrefs;
    expect(body.personalInstructions).toBe("WEB only.");
    expect(body.projectId).toBe("web");
    store.close();
  });

  test("the overlay and the global profile are separate rows for the same user", async () => {
    const { store, app } = setUp("web");
    // Write the overlay through the API...
    await app.request("/api/users/me/prefs?project=web", {
      method: "PUT",
      headers: JSON_HEADERS("alice"),
      body: JSON.stringify({ personalInstructions: "WEB overlay." }),
    });
    // ...and read the GLOBAL (no ?project) — it must be untouched/empty.
    const globalRes = await app.request("/api/users/me/prefs", {
      headers: { [DEFAULT_IDENTITY_HEADER]: "alice" },
    });
    const global = (await globalRes.json()) as UserPrefs;
    expect(global.projectId).toBeUndefined();
    expect(global.personalInstructions).toBeUndefined();
    // The overlay round-trips.
    expect(getUserProjectPrefs(store.db, "alice", "web")?.personalInstructions).toBe("WEB overlay.");
    store.close();
  });

  test("each user sees only their own overlay (per-user isolation)", async () => {
    const { store, app } = setUp("web");
    putUserProjectPrefs(store.db, "alice", "web", { personalInstructions: "alice-web" });
    putUserProjectPrefs(store.db, "bob", "web", { personalInstructions: "bob-web" });

    const aliceBody = (await (
      await app.request("/api/users/me/prefs?project=web", { headers: { [DEFAULT_IDENTITY_HEADER]: "alice" } })
    ).json()) as UserPrefs;
    const bobBody = (await (
      await app.request("/api/users/me/prefs?project=web", { headers: { [DEFAULT_IDENTITY_HEADER]: "bob" } })
    ).json()) as UserPrefs;

    expect(aliceBody.personalInstructions).toBe("alice-web");
    expect(bobBody.personalInstructions).toBe("bob-web");
    store.close();
  });
});

describe("PUT /api/users/me/prefs?project=<id>", () => {
  test("stores the overlay for the acting user + project", async () => {
    const { store, app } = setUp("web");
    const res = await app.request("/api/users/me/prefs?project=web", {
      method: "PUT",
      headers: JSON_HEADERS("alice"),
      body: JSON.stringify({
        personalInstructions: "Build first.",
        deployTarget: { account: "444455556666" },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UserPrefs;
    expect(body.projectId).toBe("web");
    expect(body.personalInstructions).toBe("Build first.");
    expect(getUserProjectPrefs(store.db, "alice", "web")?.deployTarget?.account).toBe("444455556666");
    store.close();
  });

  test("an unknown project is rejected 404 and stores nothing", async () => {
    const { store, app } = setUp("web");
    const res = await app.request("/api/users/me/prefs?project=ghost", {
      method: "PUT",
      headers: JSON_HEADERS("alice"),
      body: JSON.stringify({ personalInstructions: "nope" }),
    });
    expect(res.status).toBe(404);
    expect(getUserProjectPrefs(store.db, "alice", "ghost")).toBeNull();
    store.close();
  });

  test("the trusted-write gate still applies to the overlay route", async () => {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "web", name: "web", branch: "main", repos: [] });
    const app = createServer(store, () => {}, null);
    const prevBind = process.env.STANDUP_BIND_HOST;
    const prevToken = process.env.STANDUP_WRITE_TOKEN;
    process.env.STANDUP_BIND_HOST = "0.0.0.0"; // network-exposed
    delete process.env.STANDUP_WRITE_TOKEN; // no out-of-band secret
    try {
      // A forged header naming the victim, aiming to prompt-inject their next
      // agent in this project. It must 403, and nothing is stored.
      const res = await app.request("/api/users/me/prefs?project=web", {
        method: "PUT",
        headers: JSON_HEADERS("victim"),
        body: JSON.stringify({ personalInstructions: "<evil>" }),
      });
      expect(res.status).toBe(403);
      expect(getUserProjectPrefs(store.db, "victim", "web")).toBeNull();
    } finally {
      if (prevBind === undefined) delete process.env.STANDUP_BIND_HOST;
      else process.env.STANDUP_BIND_HOST = prevBind;
      if (prevToken === undefined) delete process.env.STANDUP_WRITE_TOKEN;
      else process.env.STANDUP_WRITE_TOKEN = prevToken;
      store.close();
    }
  });
});
