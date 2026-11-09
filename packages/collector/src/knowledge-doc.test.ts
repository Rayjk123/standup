import { expect, test, describe, afterAll } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { attachSessionToLaunch, createLaunch, createSession, createStore, recordRetrievals, upsertProject } from "@standup/store";
import type { Store } from "@standup/store";
import { writeKnowledgeFile } from "@standup/knowledge";
import { createServer } from "./server.js";
import { KnowledgeSync } from "./knowledge-sync.js";

/**
 * GET-a-full-doc route (POST /api/knowledge/doc). search_knowledge only surfaces
 * an elided excerpt; this returns the whole markdown body by stable id or by
 * (project, slug), with offset/limit paging. The load-bearing property is that
 * the scoped agent path returns ONLY a doc the caller could already retrieve —
 * an out-of-scope id must 404 exactly as search withholds it, leaking nothing.
 */

const ALPHA = `doc-test-alpha-${randomUUID().slice(0, 8)}`;
const BETA = `doc-test-beta-${randomUUID().slice(0, 8)}`;
const GLOBAL_BODY = "Global body: the full text a search excerpt would elide with an ellipsis.";

const cleanupDirs: string[] = [];
afterAll(async () => {
  for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
});

async function setUp(): Promise<{ app: ReturnType<typeof createServer>; store: Store }> {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: ALPHA, name: "Alpha", branch: "main", repos: [] });
  upsertProject(store.db, { id: BETA, name: "Beta", branch: "main", repos: [] });

  const knowledgeDir = await mkdtemp(join(tmpdir(), "standup-doc-"));
  cleanupDirs.push(knowledgeDir);

  await writeKnowledgeFile(knowledgeDir, ALPHA, {
    slug: "global-doc",
    title: "Global Doc",
    body: GLOBAL_BODY,
    scope: "global",
  });
  await writeKnowledgeFile(knowledgeDir, ALPHA, {
    slug: "alpha-proj",
    title: "Alpha Project Doc",
    body: "Alpha project-scoped body.",
    scope: "project",
  });
  await writeKnowledgeFile(knowledgeDir, BETA, {
    slug: "beta-proj",
    title: "Beta Project Doc",
    body: "Beta project-scoped body — private to project beta.",
    scope: "project",
  });

  // A runbook a scratch session wrote, and a doc of beta's that shares its slug.
  await writeKnowledgeFile(knowledgeDir, "scratch", {
    slug: "rotate-staging-tls-certs-runbook",
    title: "Rotating the staging TLS certificates",
    body: "Scratch runbook: issue the new certificate, swap it on the load balancer, then revoke the old one.",
    scope: "project",
    sourceKind: "runbook",
  });
  await writeKnowledgeFile(knowledgeDir, BETA, {
    slug: "rotate-staging-tls-certs-runbook",
    title: "Beta's certificate notes",
    body: "Beta's own notes under the same slug.",
    scope: "project",
  });

  await writeKnowledgeFile(knowledgeDir, BETA, {
    slug: "bob-notes",
    title: "Bob's notes",
    body: "Bob's personal notes.",
    scope: "user",
    ownerUser: "bob",
  });

  const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
  const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
  return { app, store };
}

async function getDoc(
  app: ReturnType<typeof createServer>,
  payload: Record<string, unknown>
): Promise<{ status: number; json: any }> {
  const res = await app.request("/api/knowledge/doc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

describe("POST /api/knowledge/doc", () => {
  test("returns a doc's full body by (project, slug)", async () => {
    const { app, store } = await setUp();
    const { status, json } = await getDoc(app, { project: ALPHA, slug: "global-doc", scoped: true });
    expect(status).toBe(200);
    expect(json.body).toBe(GLOBAL_BODY);
    expect(json.totalLength).toBe(GLOBAL_BODY.length);
    expect(json.slug).toBe("global-doc");
    expect(json.hasMore).toBe(false);
    store.close();
  });

  test("returns a doc's full body by stable id", async () => {
    const { app, store } = await setUp();
    const bySlug = await getDoc(app, { project: ALPHA, slug: "global-doc", scoped: true });
    const byId = await getDoc(app, { id: bySlug.json.id, scoped: true });
    expect(byId.status).toBe(200);
    expect(byId.json.body).toBe(GLOBAL_BODY);
    expect(byId.json.slug).toBe("global-doc");
    store.close();
  });

  test("offset/limit page a body, and limit 0 returns nothing", async () => {
    const { app, store } = await setUp();
    const page = await getDoc(app, { project: ALPHA, slug: "global-doc", offset: 7, limit: 10, scoped: true });
    expect(page.status).toBe(200);
    expect(page.json.body).toBe(GLOBAL_BODY.slice(7, 17));
    expect(page.json.offset).toBe(7);
    expect(page.json.returnedLength).toBe(10);
    expect(page.json.hasMore).toBe(true);

    // limit 0 returns an empty slice (metadata probe), not the whole body.
    const empty = await getDoc(app, { project: ALPHA, slug: "global-doc", limit: 0, scoped: true });
    expect(empty.json.body).toBe("");
    expect(empty.json.returnedLength).toBe(0);
    expect(empty.json.hasMore).toBe(true);

    // The final page reports no more.
    const tail = await getDoc(app, { project: ALPHA, slug: "global-doc", offset: GLOBAL_BODY.length - 3, scoped: true });
    expect(tail.json.body).toBe(GLOBAL_BODY.slice(-3));
    expect(tail.json.hasMore).toBe(false);
    store.close();
  });

  test("scoped fetch 404s an out-of-scope doc — an id leaks nothing search withheld", async () => {
    const { app, store } = await setUp();
    // Resolve beta-proj's id via the permissive (unscoped) path.
    const betaDoc = await getDoc(app, { project: BETA, slug: "beta-proj" });
    expect(betaDoc.status).toBe(200);
    const betaId = betaDoc.json.id;

    // An agent whose audience is project alpha cannot fetch beta's project-scoped
    // doc by its id, and gets a 404 (not a 403), so the id reveals nothing. This
    // is the leak vector an id opens over a slug: a slug lookup is confined to the
    // audience's own project, but an id names a doc in any project.
    const byId = await getDoc(app, { id: betaId, project: ALPHA, scoped: true });
    expect(byId.status).toBe(404);

    // A global doc, by contrast, is in every project's audience.
    const global = await getDoc(app, { project: ALPHA, slug: "global-doc", scoped: true });
    expect(global.status).toBe(200);
    store.close();
  });

  test("scoped fetch returns a related project's project-scoped doc, as search does", async () => {
    const { app, store } = await setUp();
    const gamma = `doc-test-gamma-${randomUUID().slice(0, 8)}`;
    upsertProject(store.db, { id: gamma, name: "Gamma", branch: "main", repos: [], related: [BETA] });
    const betaId = (await getDoc(app, { project: BETA, slug: "beta-proj" })).json.id;

    const fromRelated = await getDoc(app, { id: betaId, project: gamma, scoped: true });
    expect(fromRelated.status).toBe(200);
    expect(fromRelated.json.slug).toBe("beta-proj");

    const fromUnrelated = await getDoc(app, { id: betaId, project: ALPHA, scoped: true });
    expect(fromUnrelated.status).toBe(404);
    store.close();
  });

  test("a scratch session opens the doc its brief was injected with, though the doc lives in another project", async () => {
    const { app, store } = await setUp();
    upsertProject(store.db, { id: "scratch", name: "scratch", branch: "main", repos: [] });
    // The launch's brief carried beta's runbook; the session runs in scratch.
    createLaunch(store.db, { id: "L-scratch", projectId: "scratch", task: "sync", worktreePath: "/tmp/scratch-wt", branch: "b" });
    createSession(store.db, { id: "s-scratch", projectId: "scratch", title: "sync", cwd: "/tmp/scratch-wt", status: "running" });
    attachSessionToLaunch(store.db, "L-scratch", "s-scratch");
    recordRetrievals(store.db, [
      { docProject: BETA, docSlug: "beta-proj", query: "sync", rank: 0, surface: "inject", injected: true, launchId: "L-scratch" },
      // A row naming another user's personal doc opens nothing.
      { docProject: BETA, docSlug: "bob-notes", query: "sync", rank: 1, surface: "inject", injected: true, launchId: "L-scratch" },
    ]);
    expect((await getDoc(app, { session_id: "s-scratch", slug: "bob-notes", scoped: true })).status).toBe(404);
    expect((await getDoc(app, { session_id: "s-scratch", slug: `${BETA}/bob-notes`, scoped: true })).status).toBe(404);
    // A subagent of that session reads with its parent's brief.
    createSession(store.db, {
      id: "s-scratch:agent-1",
      projectId: "scratch",
      title: "deploy",
      cwd: "/tmp/scratch-wt",
      parentSessionId: "s-scratch",
      status: "running",
      kind: "subagent",
      agentType: "executor",
      agentId: "agent-1",
    });
    const asked = [
      { session_id: "s-scratch", slug: "beta-proj" },
      // The project the session resolves to, as an agent passes it by default.
      { session_id: "s-scratch", slug: "beta-proj", project: "scratch" },
      // The `project/slug` ref the brief prints.
      { session_id: "s-scratch", slug: `${BETA}/beta-proj` },
      { session_id: "s-scratch:agent-1", slug: "beta-proj" },
    ];
    for (const payload of asked) {
      const { status, json } = await getDoc(app, { ...payload, scoped: true });
      expect({ payload, status }).toEqual({ payload, status: 200 });
      expect(json.body).toBe("Beta project-scoped body — private to project beta.");
      expect(json.projectId).toBe(BETA);
    }
    const id = (await getDoc(app, { session_id: "s-scratch", slug: "beta-proj", scoped: true })).json.id;
    expect((await getDoc(app, { session_id: "s-scratch", id, scoped: true })).status).toBe(200);

    // A scratch session whose brief did not carry it still gets the 404.
    createSession(store.db, { id: "s-other", projectId: "scratch", title: "other", cwd: "/tmp/other-wt", status: "running" });
    expect((await getDoc(app, { session_id: "s-other", slug: "beta-proj", scoped: true })).status).toBe(404);
    expect((await getDoc(app, { session_id: "s-other", id, scoped: true })).status).toBe(404);
    store.close();
  });

  test("a scratch launch's session moved into a project opens the scratch doc its brief carried", async () => {
    const { app, store } = await setUp();
    upsertProject(store.db, { id: "scratch", name: "scratch", branch: "main", repos: [] });
    const slug = "rotate-staging-tls-certs-runbook";
    // Launched in scratch and briefed with scratch's runbook; the session now resolves to beta.
    createLaunch(store.db, { id: "L-moved", projectId: "scratch", task: "sync", worktreePath: "/tmp/moved-wt", branch: "b" });
    createSession(store.db, { id: "s-moved", projectId: BETA, title: "sync", cwd: "/tmp/moved-wt", status: "running" });
    attachSessionToLaunch(store.db, "L-moved", "s-moved");
    recordRetrievals(store.db, [
      { docProject: "scratch", docSlug: slug, query: "sync", rank: 0, surface: "inject", injected: true, launchId: "L-moved" },
    ]);
    const scratchBody = "Scratch runbook: issue the new certificate, swap it on the load balancer, then revoke the old one.";
    for (const payload of [{ slug }, { slug: `scratch/${slug}` }, { slug: `Scratch/${slug}` }, { slug, project: "scratch" }]) {
      const { status, json } = await getDoc(app, { session_id: "s-moved", ...payload, scoped: true });
      expect({ payload, status, body: json.body }).toEqual({ payload, status: 200, body: scratchBody });
    }
    // Naming the session's own project still reads that project's doc of the same slug.
    const own = await getDoc(app, { session_id: "s-moved", slug, project: BETA, scoped: true });
    expect(own.json.body).toBe("Beta's own notes under the same slug.");
    store.close();
  });

  test("400 without id or slug, 404 for an unknown id", async () => {
    const { app, store } = await setUp();
    const missing = await getDoc(app, { scoped: true });
    expect(missing.status).toBe(400);
    const unknown = await getDoc(app, { id: randomUUID(), scoped: true });
    expect(unknown.status).toBe(404);
    store.close();
  });
});
