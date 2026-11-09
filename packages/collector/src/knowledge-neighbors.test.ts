import { expect, test, describe, afterAll } from "bun:test";
import { DEFAULT_IDENTITY_HEADER } from "@standup/shared";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { createStore, upsertProject } from "@standup/store";
import type { Store } from "@standup/store";
import { KnowledgeStore } from "@standup/knowledge";
import { USER_CHANNEL_HEADER, userChannelToken } from "@standup/shared/owner-token";
import { createServer } from "./server.js";
import { KnowledgeSync } from "./knowledge-sync.js";
import { activeOwnerSecrets } from "./owner-secret.js";

/** `alias`'s signed-in headers: its tunnel identity and its user channel token. */
const signedIn = (alias: string): Record<string, string> => ({
  [DEFAULT_IDENTITY_HEADER]: alias,
  [USER_CHANNEL_HEADER]: userChannelToken(activeOwnerSecrets().ownerToken, alias),
});

/**
 * POST /api/knowledge/neighbors is what the MCP graph_neighbors tool proxies.
 * Its load-bearing behavior is that the handler reconciles markdown from disk
 * (syncAll) and *recompiles the graph on read* (compile()) before reading
 * neighbors — the exact agent->tool->endpoint boundary where DOGFOOD saw graph
 * traversal come back empty. graph.test.ts / backend.test.ts stop at the
 * in-process backend; these drive the real HTTP handler over markdown on disk,
 * so a regression that dropped the endpoint's compile() call would fail here.
 */

const P1 = `neighbors-p1-${randomUUID().slice(0, 8)}`;
const P2 = `neighbors-p2-${randomUUID().slice(0, 8)}`;

const cleanupDirs: string[] = [];
afterAll(async () => {
  for (const dir of cleanupDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A knowledge dir with a cross-project `related` link: p1/arch -> p2/intent. */
async function tempKnowledgeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "standup-knowledge-neighbors-"));
  cleanupDirs.push(dir);
  await mkdir(join(dir, P1), { recursive: true });
  await mkdir(join(dir, P2), { recursive: true });
  await writeFile(
    join(dir, P1, "arch.md"),
    `---\ntitle: Architecture\nrelated:\n  - ${P2}/intent\n---\n\nArchitecture notes.\n`
  );
  await writeFile(
    join(dir, P2, "intent.md"),
    `---\ntitle: Intent\n---\n\nWhy it exists.\n`
  );
  return dir;
}

function setUpStore(): Store {
  const store = createStore(":memory:");
  for (const [id, name] of [
    [P1, "Neighbors P1"],
    [P2, "Neighbors P2"],
  ]) {
    upsertProject(store.db, { id, name, branch: "main", repos: [] });
  }
  return store;
}

describe("POST /api/knowledge/neighbors", () => {
  test("recompiles the graph on read and returns the cross-project neighbor", async () => {
    const store = setUpStore();
    const knowledgeDir = await tempKnowledgeDir();
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    // Reconcile markdown into the store to discover the doc's stable id, which
    // the caller passes to graph_neighbors. syncAll loads docs but never
    // compiles edges, so the graph is still empty at this point...
    await knowledgeSync.syncAll();
    const archId = new KnowledgeStore(store.db).getDoc(P1, "arch")?.id;
    expect(typeof archId).toBe("string");

    // ...as this asserts: neighbors the endpoint returns can only come from its
    // own compile()-on-read, not from anything the test pre-built.
    expect(new KnowledgeStore(store.db).getNeighbors(archId!)).toEqual([]);

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);

    const res = await app.request("/api/knowledge/neighbors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ docId: archId }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      neighbors: Array<{ slug: string; projectId: string; kind: string }>;
    };
    expect(json.neighbors).toHaveLength(1);
    expect(json.neighbors[0].slug).toBe("intent");
    expect(json.neighbors[0].projectId).toBe(P2);
    expect(json.neighbors[0].kind).toBe("related");

    store.close();
  });

  test("returns 400 when docId is missing", async () => {
    const store = setUpStore();
    const knowledgeDir = await tempKnowledgeDir();
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);

    const res = await app.request("/api/knowledge/neighbors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    store.close();
  });
});

/**
 * The agent path (MCP graph_neighbors) sets `scoped: true`; the collector then
 * applies the SAME global ∪ project ∪ requesting-user gate search_knowledge does,
 * resolving the user SERVER-SIDE from the (loopback-trusted, in-test) tunnel
 * header. Without it, a user-scoped doc that co-cites (shared tag) a doc the
 * caller can see would leak its slug/title/project across the scope boundary —
 * the exact hole the pivot from a gated search must not reopen. The default
 * (unscoped) web-browse path stays permissive.
 */
describe("POST /api/knowledge/neighbors scope gate (scoped:true)", () => {
  const PROJ = `neighbors-scope-${randomUUID().slice(0, 8)}`;

  /** A visible (global) doc co-citing Alice's private user-scoped doc via a tag. */
  async function scopeKnowledgeDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "standup-knowledge-neighbors-scope-"));
    cleanupDirs.push(dir);
    await mkdir(join(dir, PROJ), { recursive: true });
    await writeFile(
      join(dir, PROJ, "shared.md"),
      `---\ntitle: Shared\nscope: global\ntags:\n  - authtag\n---\n\nA doc everyone can see.\n`
    );
    await writeFile(
      join(dir, PROJ, "alice-secret.md"),
      `---\ntitle: Alice Secret\nscope: user\nowner_user: alice\ntags:\n  - authtag\n---\n\nAlice's private note.\n`
    );
    return dir;
  }

  function setUpScopeStore(): Store {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: PROJ, name: "Neighbors Scope", branch: "main", repos: [] });
    return store;
  }

  async function sharedDocId(store: Store, knowledgeSync: KnowledgeSync): Promise<string> {
    await knowledgeSync.syncAll();
    const id = new KnowledgeStore(store.db).getDoc(PROJ, "shared")?.id;
    expect(typeof id).toBe("string");
    return id!;
  }

  async function neighborSlugs(
    app: ReturnType<typeof createServer>,
    body: Record<string, unknown>,
    headers: Record<string, string> = {}
  ): Promise<string[]> {
    const res = await app.request("/api/knowledge/neighbors", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { neighbors: Array<{ slug: string }> };
    return json.neighbors.map((n) => n.slug);
  }

  test("a non-owner (scoped) caller does NOT get another user's user-scoped neighbor", async () => {
    const store = setUpScopeStore();
    const knowledgeDir = await scopeKnowledgeDir();
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const sharedId = await sharedDocId(store, knowledgeSync);
    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);

    const slugs = await neighborSlugs(
      app,
      { docId: sharedId, scoped: true, project: PROJ },
      { [DEFAULT_IDENTITY_HEADER]: "bob" }
    );
    expect(slugs).not.toContain("alice-secret");
    store.close();
  });

  test("the owning user (scoped) DOES get their own user-scoped neighbor", async () => {
    const store = setUpScopeStore();
    const knowledgeDir = await scopeKnowledgeDir();
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const sharedId = await sharedDocId(store, knowledgeSync);
    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);

    const slugs = await neighborSlugs(
      app,
      { docId: sharedId, scoped: true, project: PROJ },
      signedIn("alice")
    );
    expect(slugs).toContain("alice-secret");
    // The identity header alone proves nothing a worker couldn't forge.
    const headerOnly = await neighborSlugs(
      app,
      { docId: sharedId, scoped: true, project: PROJ },
      { [DEFAULT_IDENTITY_HEADER]: "alice" }
    );
    expect(headerOnly).not.toContain("alice-secret");
    store.close();
  });

  test("the unscoped web-browse path lists a personal-layer neighbor to its owner only", async () => {
    const store = setUpScopeStore();
    const knowledgeDir = await scopeKnowledgeDir();
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const sharedId = await sharedDocId(store, knowledgeSync);
    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);

    const bob = await neighborSlugs(app, { docId: sharedId }, { [DEFAULT_IDENTITY_HEADER]: "bob" });
    expect(bob).not.toContain("alice-secret");
    const alice = await neighborSlugs(app, { docId: sharedId }, signedIn("alice"));
    expect(alice).toContain("alice-secret");
    expect(await neighborSlugs(app, { docId: sharedId }, { [DEFAULT_IDENTITY_HEADER]: "alice" })).not.toContain("alice-secret");
    store.close();
  });
});
