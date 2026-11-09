import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createStore, upsertProject } from "@standup/store";
import type { Store } from "@standup/store";
import { KnowledgeStore, type KnowledgeDoc } from "@standup/knowledge";
import { DEFAULT_IDENTITY_HEADER, GLOBAL_PROJECT_ID } from "@standup/shared";
import { USER_CHANNEL_HEADER, userChannelToken } from "@standup/shared/owner-token";
import { createServer } from "./server.js";
import { activeOwnerSecrets } from "./owner-secret.js";
import { resetSessionProjectCaches } from "./session-project.js";

/**
 * How the knowledge routes treat the project and corpus a caller names: an
 * explicit project Standup does not know is never searched (the session's
 * project is used and the reply warns), a corpus:"project" search of a project
 * with nothing the caller can retrieve searches every project and says so, and
 * a search that recalls nothing says whether its corpus was empty.
 */

const QUERY = "projectmarker";

const signedIn = (alias: string): Record<string, string> => ({
  [DEFAULT_IDENTITY_HEADER]: alias,
  [USER_CHANNEL_HEADER]: userChannelToken(activeOwnerSecrets().ownerToken, alias),
});

function doc(overrides: Partial<KnowledgeDoc>): KnowledgeDoc {
  return {
    id: crypto.randomUUID(),
    projectId: "alpha",
    slug: "doc",
    title: "Doc",
    body: `${QUERY} body`,
    updatedAt: new Date("2026-08-16T00:00:00Z"),
    filePath: "/x/doc.md",
    sourceKind: "code",
    originClass: "owner",
    scope: "project",
    ...overrides,
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  resetSessionProjectCaches();
});

interface Fixture {
  store: Store;
  app: ReturnType<typeof createServer>;
  knowledge: KnowledgeStore;
  /** A directory inside alpha's registered repo. */
  alphaCwd: string;
}

function setUp(withDocs = true): Fixture {
  const repo = mkdtempSync(join(tmpdir(), "kb-search-project-"));
  const store = createStore(":memory:");
  cleanups.push(() => {
    store.close();
    rmSync(repo, { recursive: true, force: true });
  });
  upsertProject(store.db, { id: "alpha", name: "Alpha", branch: "main", repos: [repo] });
  upsertProject(store.db, { id: "alpha-cp", name: "Alpha control plane", branch: "main", repos: [] });
  upsertProject(store.db, { id: "empty", name: "Empty", branch: "main", repos: [] });
  upsertProject(store.db, { id: "zeta", name: "Zeta", branch: "main", repos: [] });
  const knowledge = new KnowledgeStore(store.db);
  if (withDocs) {
    knowledge.upsertDoc(doc({ slug: "alpha-doc" }));
    knowledge.upsertDoc(doc({ projectId: "zeta", slug: "zeta-doc" }));
    knowledge.upsertDoc(doc({ projectId: GLOBAL_PROJECT_ID, slug: "global-doc", scope: "global" }));
    knowledge.upsertDoc(doc({ projectId: "empty", slug: "alice-note", scope: "user", ownerUser: "alice" }));
  }
  return { store, app: createServer(store, () => {}, null), knowledge, alphaCwd: repo };
}

interface SearchReply {
  results: Array<{ slug: string; projectId: string }>;
  project: string;
  corpus: "project" | "all";
  corpusFallback?: string;
  emptyCorpus?: boolean;
  projectWarning?: string;
}

async function search(app: Fixture["app"], body: Record<string, unknown>): Promise<SearchReply> {
  const res = await app.request("/api/knowledge/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...signedIn("alice") },
    body: JSON.stringify({ cwd: "/tmp/kb-search-project-none", query: QUERY, scoped: true, ...body }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as SearchReply;
}

describe("POST /api/knowledge/search — an explicit project", () => {
  test("a known project is searched as named, without a warning", async () => {
    const { app } = setUp();
    const reply = await search(app, { project: "alpha", corpus: "project" });
    expect(reply.project).toBe("alpha");
    expect(reply.projectWarning).toBeUndefined();
    expect(reply.results.map((r) => r.slug)).toEqual(["alpha-doc"]);
  });

  test("a known project named in another case resolves to its id", async () => {
    const { app } = setUp();
    const reply = await search(app, { project: "ALPHA", corpus: "project" });
    expect(reply.project).toBe("alpha");
    expect(reply.projectWarning).toBeUndefined();
  });

  test("an unknown project searches the session's project instead and lists known ids, resolved and related first", async () => {
    const { app, alphaCwd } = setUp();
    const reply = await search(app, { project: "wsb-codex", corpus: "project", cwd: alphaCwd });
    expect(reply.project).toBe("alpha");
    expect(reply.results.map((r) => r.slug)).toEqual(["alpha-doc"]);
    expect(reply.projectWarning).toBe(
      `Unknown project "wsb-codex" — searched alpha instead. Known projects: alpha, alpha-cp, empty, global, zeta.`
    );
  });

  test("an unknown project with nothing to resolve from also carries the scratch warning", async () => {
    const { app } = setUp();
    const reply = await search(app, { project: "wsb-codex" });
    expect(reply.project).toBe("scratch");
    expect(reply.projectWarning).toStartWith(`Unknown project "wsb-codex" — searched scratch instead.`);
    expect(reply.projectWarning).toContain(`defaulted to the "scratch" project`);
    expect(reply.projectWarning).not.toContain("Known projects: scratch");
  });

  test("a project known only from its stored docs is not unknown", async () => {
    const { app, knowledge } = setUp();
    knowledge.upsertDoc(doc({ projectId: "unregistered", slug: "synced-doc" }));
    const reply = await search(app, { project: "unregistered", corpus: "project" });
    expect(reply.project).toBe("unregistered");
    expect(reply.projectWarning).toBeUndefined();
    expect(reply.results.map((r) => r.slug)).toEqual(["synced-doc"]);
  });
});

describe("POST /api/knowledge/search — an empty project corpus", () => {
  test("a project corpus with no doc the caller can retrieve searches all projects and says so", async () => {
    const { app } = setUp();
    // `empty` holds only the caller's personal note, which a scoped search leaves out.
    const reply = await search(app, { project: "empty", corpus: "project" });
    expect(reply.corpus).toBe("all");
    expect(reply.corpusFallback).toBe("empty has no knowledge docs; searched all projects instead.");
    // The scope gate still holds: every project's docs the caller may see, which
    // leaves out alpha's and zeta's project-scoped docs.
    expect(reply.results.map((r) => r.slug)).toEqual(["global-doc"]);
    expect(reply.emptyCorpus).toBeUndefined();
  });

  test("a project corpus with docs stays a project search", async () => {
    const { app } = setUp();
    const reply = await search(app, { project: "alpha", corpus: "project" });
    expect(reply.corpus).toBe("project");
    expect(reply.corpusFallback).toBeUndefined();
  });

  test("the caller's own personal doc counts when the owner filter asks for it", async () => {
    const { app } = setUp();
    const reply = await search(app, { project: "empty", corpus: "project", owner: "alice" });
    expect(reply.corpus).toBe("project");
    expect(reply.results.map((r) => r.slug)).toEqual(["alice-note"]);
  });

  test("a search of a knowledge base with no retrievable doc reports an empty corpus", async () => {
    const { app } = setUp(false);
    const reply = await search(app, { project: "alpha" });
    expect(reply.results).toEqual([]);
    expect(reply.emptyCorpus).toBe(true);
  });

  test("a search that matches nothing in a non-empty corpus is not an empty corpus", async () => {
    const { app } = setUp();
    const reply = await search(app, { project: "alpha", query: "zzzunmatchedtoken" });
    expect(reply.results).toEqual([]);
    expect(reply.emptyCorpus).toBeUndefined();
  });
});

describe("doc and neighbors routes — an explicit project", () => {
  test("a doc fetched by slug under an unknown project is looked up in the resolved project, with a warning", async () => {
    const { app, alphaCwd } = setUp();
    const res = await app.request("/api/knowledge/doc", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...signedIn("alice") },
      body: JSON.stringify({ slug: "alpha-doc", project: "wsb-codex", cwd: alphaCwd, scoped: true }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { slug: string; projectWarning?: string };
    expect(json.slug).toBe("alpha-doc");
    expect(json.projectWarning).toStartWith(`Unknown project "wsb-codex" — looked in alpha instead.`);
  });

  test("a doc missing under the resolved project says the named project was unknown", async () => {
    const { app, alphaCwd } = setUp();
    const res = await app.request("/api/knowledge/doc", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...signedIn("alice") },
      body: JSON.stringify({ slug: "zeta-doc", project: "wsb-codex", cwd: alphaCwd, scoped: true }),
    });
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain(`No knowledge doc "zeta-doc" in project "alpha".`);
    expect(json.error).toContain(`Unknown project "wsb-codex"`);
  });

  test("neighbors under an unknown project warn; without a project they do not", async () => {
    const { app, alphaCwd, knowledge } = setUp();
    const id = knowledge.getDoc("alpha", "alpha-doc")!.id;
    const post = async (body: Record<string, unknown>) =>
      (await (
        await app.request("/api/knowledge/neighbors", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...signedIn("alice") },
          body: JSON.stringify({ docId: id, cwd: alphaCwd, scoped: true, ...body }),
        })
      ).json()) as { projectWarning?: string };
    expect((await post({ project: "wsb-codex" })).projectWarning).toStartWith(`Unknown project "wsb-codex"`);
    expect((await post({})).projectWarning).toBeUndefined();
  });
});
