import { expect, test, describe } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createStore, upsertProject } from "@standup/store";
import type { Store } from "@standup/store";
import { KnowledgeStore, type KnowledgeDoc } from "@standup/knowledge";
import { DEFAULT_IDENTITY_HEADER, GLOBAL_PROJECT_ID } from "@standup/shared";
import { USER_CHANNEL_HEADER, userChannelToken } from "@standup/shared/owner-token";
import { createServer } from "./server.js";
import { activeOwnerSecrets } from "./owner-secret.js";

/** `alias`'s signed-in headers: its tunnel identity and its user channel token. */
const signedIn = (alias: string): Record<string, string> => ({
  [DEFAULT_IDENTITY_HEADER]: alias,
  [USER_CHANNEL_HEADER]: userChannelToken(activeOwnerSecrets().ownerToken, alias),
});

/**
 * The scoped search route (MCP search_knowledge, Persona's recall) leaves the
 * personal layer — scope=user docs and the home CLAUDE.md / rules mirrors — out
 * of its default results. The caller's own personal docs come back only when it
 * asks for its own personal context: an explicit owner filter, the reserved
 * global project (the owner's cross-project view), or `includePersonal`.
 */

const PROJECT = "alpha";
const QUERY = "layermarker";

function doc(overrides: Partial<KnowledgeDoc>): KnowledgeDoc {
  return {
    id: crypto.randomUUID(),
    projectId: PROJECT,
    slug: "doc",
    title: "Doc",
    body: `${QUERY} body`,
    updatedAt: new Date("2026-08-16T00:00:00Z"),
    filePath: "/x/doc.md",
    sourceKind: "code",
    originClass: "owner",
    ...overrides,
  };
}

function setUp(): { store: Store; app: ReturnType<typeof createServer> } {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: PROJECT, name: "Alpha", branch: "main", repos: [] });
  const k = new KnowledgeStore(store.db);
  k.upsertDoc(doc({ slug: "team-doc", scope: "project" }));
  k.upsertDoc(doc({ slug: "alice-note", scope: "user", ownerUser: "alice" }));
  k.upsertDoc(doc({ slug: "bob-note", scope: "user", ownerUser: "bob" }));
  k.upsertDoc(
    doc({
      projectId: GLOBAL_PROJECT_ID,
      slug: "native-mem-home-claude-md",
      scope: "global",
      sourceKind: "native-memory",
    })
  );
  return { store, app: createServer(store, () => {}, null) };
}

/** Runs `fn` with `$USER` — the host identity — pinned to `alias`. */
async function withHostUser<T>(alias: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.USER;
  process.env.USER = alias;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.USER;
    else process.env.USER = saved;
  }
}

async function search(
  app: ReturnType<typeof createServer>,
  body: Record<string, unknown>
): Promise<string[]> {
  const res = await app.request("/api/knowledge/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...signedIn("alice") },
    body: JSON.stringify({ cwd: "/tmp/none", query: QUERY, scoped: true, ...body }),
  });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { results: Array<{ slug: string }> };
  return json.results.map((r) => r.slug).sort();
}

describe("POST /api/knowledge/search — personal layer", () => {
  test("a scoped project search returns no personal-layer doc, the caller's own included", async () => {
    const { store, app } = setUp();
    expect(await search(app, { project: PROJECT })).toEqual(["team-doc"]);
    store.close();
  });

  test("an owner filter naming the caller returns the caller's own user-scoped docs", async () => {
    const { store, app } = setUp();
    expect(await search(app, { project: PROJECT, owner: "alice" })).toEqual(["alice-note"]);
    store.close();
  });

  test("the owner's global view (Persona's recall) keeps its own personal context", async () => {
    const { store, app } = setUp();
    const slugs = await withHostUser("alice", () => search(app, { project: GLOBAL_PROJECT_ID }));
    expect(slugs).toContain("native-mem-home-claude-md");
    expect(slugs).toContain("alice-note");
    expect(slugs).not.toContain("bob-note");
    store.close();
  });

  test("a legacy home mirror never reaches a caller who is not the host user", async () => {
    const { store, app } = setUp();
    // A stale copy homed in a project, still stamped project-scoped.
    new KnowledgeStore(store.db).upsertDoc(
      doc({ slug: "native-mem-home-rule-x", scope: "project", sourceKind: "native-memory" })
    );
    await withHostUser("host-operator", async () => {
      for (const body of [
        { project: GLOBAL_PROJECT_ID },
        { project: GLOBAL_PROJECT_ID, includePersonal: true },
        { project: PROJECT, includePersonal: true },
        { project: PROJECT, owner: "alice" },
      ]) {
        const slugs = await search(app, body);
        expect(slugs).not.toContain("native-mem-home-claude-md");
        expect(slugs).not.toContain("native-mem-home-rule-x");
      }
    });
    // Even the host user never sees the stale copy outside the global corpus.
    const host = await withHostUser("alice", () => search(app, { project: PROJECT, includePersonal: true }));
    expect(host).not.toContain("native-mem-home-rule-x");
    store.close();
  });

  test("the activity layer is returned, dated, unless the caller opts out", async () => {
    const { store, app } = setUp();
    new KnowledgeStore(store.db).upsertDoc(
      doc({ slug: "native-mem-memory-diary", scope: "project", sourceKind: "native-memory", generatedAt: "2026-09-30T08:00:00Z" })
    );
    expect(await search(app, { project: PROJECT })).toContain("native-mem-memory-diary");
    expect(await search(app, { project: PROJECT, includeActivity: true })).toContain("native-mem-memory-diary");
    expect(await search(app, { project: PROJECT, excludeActivity: true })).not.toContain("native-mem-memory-diary");
    expect(await search(app, { project: PROJECT, includeActivity: false })).not.toContain("native-mem-memory-diary");
    const res = await app.request("/api/knowledge/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", [DEFAULT_IDENTITY_HEADER]: "alice" },
      body: JSON.stringify({ cwd: "/tmp/none", query: QUERY, scoped: true, project: PROJECT }),
    });
    const json = (await res.json()) as { results: Array<{ slug: string; layer?: string; activityDate?: string }> };
    expect(json.results.find((r) => r.slug === "native-mem-memory-diary")).toMatchObject({
      layer: "activity",
      activityDate: "2026-09-30",
    });
    store.close();
  });

  test("excludeUserScope narrows even the global view", async () => {
    const { store, app } = setUp();
    const slugs = await search(app, { project: GLOBAL_PROJECT_ID, excludeUserScope: true });
    expect(slugs).not.toContain("native-mem-home-claude-md");
    expect(slugs).not.toContain("alice-note");
    store.close();
  });

  test("includePersonal opts a project search into the caller's own personal docs", async () => {
    const { store, app } = setUp();
    const slugs = await search(app, { project: PROJECT, includePersonal: true });
    expect(slugs).toContain("alice-note");
    expect(slugs).not.toContain("bob-note");
    // A loopback worker can set the identity header; alone it unlocks no personal doc.
    const forged = await app.request("/api/knowledge/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", [DEFAULT_IDENTITY_HEADER]: "alice" },
      body: JSON.stringify({ cwd: "/tmp/none", query: QUERY, scoped: true, project: PROJECT, includePersonal: true }),
    });
    const forgedSlugs = ((await forged.json()) as { results: Array<{ slug: string }> }).results.map((r) => r.slug);
    expect(forgedSlugs).not.toContain("alice-note");
    store.close();
  });
});

/**
 * The human-browse routes (unscoped search, the doc list and read rail, the
 * full-body fetch, graph neighbors, the graph) see every project and scope but
 * never another user's personal layer: alice's scope=user note and the host
 * user's legacy home mirror reach alice (the host user here) and not bob.
 */
describe("browse routes — the personal layer is private to its owner", () => {
  function setUpBrowse(): { store: Store; app: ReturnType<typeof createServer>; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), "browse-personal-"));
    const store = createStore(":memory:");
    upsertProject(store.db, { id: PROJECT, name: "Alpha", branch: "main", repos: [] });
    const k = new KnowledgeStore(store.db);
    k.upsertDoc(doc({ id: "team", slug: "team-doc", scope: "project", related: ["alice-note", "global/native-mem-home-claude-md"] }));
    k.upsertDoc(doc({ id: "alice", slug: "alice-note", scope: "user", ownerUser: "alice" }));
    k.upsertDoc(
      doc({ id: "mirror", projectId: GLOBAL_PROJECT_ID, slug: "native-mem-home-claude-md", scope: "global", sourceKind: "native-memory" })
    );
    const write = (projectId: string, slug: string, frontmatter: string) => {
      mkdirSync(join(dir, projectId), { recursive: true });
      writeFileSync(join(dir, projectId, `${slug}.md`), `---\ntitle: Doc\n${frontmatter}\n---\n\n${QUERY} body\n`);
    };
    write(PROJECT, "team-doc", "source_kind: code");
    write(PROJECT, "alice-note", "source_kind: code\nscope: user\nowner_user: alice");
    write(GLOBAL_PROJECT_ID, "native-mem-home-claude-md", "source_kind: native-memory\nnative_memory_from: /h/.claude/CLAUDE.md");
    const app = createServer(store, () => {}, null, undefined, undefined, dir);
    return { store, app, dir };
  }

  const as = (user: string) => ({ "Content-Type": "application/json", ...signedIn(user) });

  /** Every slug each browse route returns to `user`. */
  async function browse(app: ReturnType<typeof createServer>, user: string): Promise<Record<string, string[]>> {
    const post = (path: string, body: Record<string, unknown>) =>
      app.request(path, { method: "POST", headers: as(user), body: JSON.stringify(body) });
    const get = (path: string) => app.request(path, { headers: as(user) });

    const search = (await (await post("/api/knowledge/search", { cwd: "/tmp/none", query: QUERY, project: PROJECT })).json()) as {
      results: Array<{ slug: string }>;
    };
    const lists: string[] = [];
    for (const projectId of [PROJECT, GLOBAL_PROJECT_ID]) {
      const list = (await (await get(`/api/projects/${projectId}/knowledge`)).json()) as Array<{ slug: string }>;
      lists.push(...list.map((d) => d.slug));
    }
    const reads: string[] = [];
    for (const [projectId, slug] of [
      [PROJECT, "team-doc"],
      [PROJECT, "alice-note"],
      [GLOBAL_PROJECT_ID, "native-mem-home-claude-md"],
    ]) {
      if ((await get(`/api/projects/${projectId}/knowledge/${slug}`)).status === 200) reads.push(slug);
    }
    const fetched: string[] = [];
    for (const id of ["team", "alice", "mirror"]) {
      const res = await post("/api/knowledge/doc", { id, cwd: "/tmp/none", project: PROJECT });
      if (res.status === 200) fetched.push(((await res.json()) as { slug: string }).slug);
    }
    const neighbors = (await (await post("/api/knowledge/neighbors", { docId: "team", cwd: "/tmp/none", project: PROJECT })).json()) as {
      neighbors: Array<{ slug: string }>;
    };
    const fromPersonal = (await (await post("/api/knowledge/neighbors", { docId: "alice", cwd: "/tmp/none", project: PROJECT })).json()) as {
      neighbors: Array<{ slug: string }>;
    };
    const graph = (await (await get("/api/knowledge/graph")).json()) as {
      nodes: Array<{ slug: string }>;
      edges: Array<{ source: string; target: string }>;
    };
    const sorted = (slugs: string[]) => [...new Set(slugs)].sort();
    return {
      search: sorted(search.results.map((r) => r.slug)),
      list: sorted(lists),
      read: sorted(reads),
      doc: sorted(fetched),
      neighbors: sorted(neighbors.neighbors.map((n) => n.slug)),
      neighborsOfPersonal: sorted(fromPersonal.neighbors.map((n) => n.slug)),
      graphNodes: sorted(graph.nodes.map((n) => n.slug)),
      graphEdgeEnds: sorted(graph.edges.flatMap((e) => [e.source, e.target])),
    };
  }

  test("a teammate gets none of another user's personal docs nor the host's legacy mirror", async () => {
    const { store, app, dir } = setUpBrowse();
    const seen = await withHostUser("alice", () => browse(app, "bob"));
    for (const [route, slugs] of Object.entries(seen)) {
      expect({ route, slugs: slugs.filter((s) => s !== "team" && s !== "team-doc") }).toEqual({ route, slugs: [] });
    }
    expect(seen.search).toEqual(["team-doc"]);
    expect(seen.list).toEqual(["team-doc"]);
    expect(seen.read).toEqual(["team-doc"]);
    expect(seen.doc).toEqual(["team-doc"]);
    expect(seen.graphNodes).toEqual(["team-doc"]);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a teammate can neither overwrite nor delete another user's personal doc, and the owner edits it only through Persona", async () => {
    const { store, app, dir } = setUpBrowse();
    upsertProject(store.db, { id: GLOBAL_PROJECT_ID, name: "Global", branch: "main", repos: [] });
    await withHostUser("alice", async () => {
      for (const [projectId, slug] of [
        [PROJECT, "alice-note"],
        [GLOBAL_PROJECT_ID, "native-mem-home-claude-md"],
      ]) {
        const path = `/api/projects/${projectId}/knowledge/${slug}`;
        const put = await app.request(path, { method: "PUT", headers: as("bob"), body: JSON.stringify({ body: "bob was here" }) });
        expect(put.status).toBe(409);
        expect((await app.request(path, { method: "DELETE", headers: as("bob") })).status).toBe(404);
        const read = await app.request(path, { headers: as("alice") });
        expect(((await read.json()) as { body: string }).body).toContain(QUERY);
      }
      // The personal layer is written only by Persona, so the owner's own edit and
      // delete through these routes are refused too, leaving the doc as it was.
      const ownPath = `/api/projects/${PROJECT}/knowledge/alice-note`;
      const own = await app.request(ownPath, {
        method: "PUT",
        headers: as("alice"),
        body: JSON.stringify({ body: "alice edits her own note" }),
      });
      expect(own.status).toBe(403);
      expect((await app.request(ownPath, { method: "DELETE", headers: as("alice") })).status).toBe(403);
      const after = await app.request(ownPath, { headers: as("alice") });
      expect(((await after.json()) as { body: string }).body).toContain(QUERY);
    });
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("the owner still browses their own personal docs", async () => {
    const { store, app, dir } = setUpBrowse();
    const seen = await withHostUser("alice", () => browse(app, "alice"));
    const all = ["alice-note", "native-mem-home-claude-md", "team-doc"];
    expect(seen.search).toEqual(all);
    expect(seen.list).toEqual(all);
    expect(seen.read).toEqual(all);
    expect(seen.doc).toEqual(all);
    expect(seen.neighbors).toEqual(["alice-note", "native-mem-home-claude-md"]);
    expect(seen.neighborsOfPersonal).toEqual(["team-doc"]);
    expect(seen.graphNodes).toEqual(all);
    expect(seen.graphEdgeEnds).toEqual(["alice", "mirror", "team"]);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
