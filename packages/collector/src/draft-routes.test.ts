import { expect, test, describe, afterAll } from "bun:test";
import { DEFAULT_IDENTITY_HEADER } from "@standup/shared";
import { mkdtemp, rm, readdir, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { createStore, upsertProject, createSession, createLaunch } from "@standup/store";
import type { Store } from "@standup/store";
import {
  writeDraftFile,
  writeKnowledgeFile,
  readKnowledgeFile,
  KnowledgeStore,
  DISPUTED_CONFIDENCE,
  MIN_INJECTION_CONFIDENCE,
  isConfidenceEligibleForInjection,
} from "@standup/knowledge";
import { createServer } from "./server.js";
import { KnowledgeSync } from "./knowledge-sync.js";
import { USER_CHANNEL_HEADER, userChannelToken } from "@standup/shared/owner-token";
import { activeOwnerSecrets } from "./owner-secret.js";

/** `alias`'s signed-in headers: its tunnel identity and its user channel token. */
const signedIn = (alias: string): Record<string, string> => ({
  [DEFAULT_IDENTITY_HEADER]: alias,
  [USER_CHANNEL_HEADER]: userChannelToken(activeOwnerSecrets().ownerToken, alias),
});

/**
 * The Step 5 review-UI routes (phase-7.md): GET/PUT/accept/discard/accept-all
 * over knowledge_drafts. Exercises them directly against the running app,
 * not just the pure decision helpers in draft-accept.test.ts — a green
 * unit test for resolveAcceptMode proves nothing about whether the route
 * actually wires it up correctly.
 */

function projectId(): string {
  return `draft-routes-test-${randomUUID().slice(0, 8)}`;
}

async function tempKnowledgeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "standup-draft-routes-"));
}

function setUp(id: string): { store: Store } {
  const store = createStore(":memory:");
  upsertProject(store.db, { id, name: "Draft Routes Test", branch: "main", repos: [] });
  return { store };
}

const cleanupDirs: string[] = [];
afterAll(async () => {
  for (const dir of cleanupDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("route ordering: GET .../knowledge/drafts is not swallowed by the :slug route", () => {
  test("returns the drafts array, not a 404 for a doc literally named 'drafts'", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    await writeDraftFile(knowledgeDir, id, { slug: "gotchas", title: "Gotchas", body: "watch out" });

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    const res = await app.request(`/api/projects/${id}/knowledge/drafts`);

    expect(res.status).toBe(200);
    const json = (await res.json()) as Array<{ slug: string }>;
    expect(Array.isArray(json)).toBe(true);
    expect(json.find((d) => d.slug === "gotchas")).toBeTruthy();

    store.close();
  });
});

describe("PUT .../knowledge/drafts/:slug", () => {
  test("edit resets a disputed verdict back to unverified with no disputes", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    await writeDraftFile(knowledgeDir, id, { slug: "gotchas", title: "Gotchas", body: "v1" });
    await knowledgeSync.syncDrafts(id);
    knowledgeSync.recordDraftVerdict(id, "gotchas", "disputed", [
      { claim: "v1 has 200 errors", finding: "no such count exists", evidence: "bun run typecheck" },
    ]);

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);

    const before = (await (
      await app.request(`/api/projects/${id}/knowledge/drafts`)
    ).json()) as Array<{ slug: string; verdict: string }>;
    expect(before.find((d) => d.slug === "gotchas")?.verdict).toBe("disputed");

    const putRes = await app.request(`/api/projects/${id}/knowledge/drafts/gotchas`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Gotchas", body: "v2 — corrected" }),
    });
    expect(putRes.status).toBe(200);

    const after = (await (
      await app.request(`/api/projects/${id}/knowledge/drafts`)
    ).json()) as Array<{ slug: string; body: string; verdict: string; disputes: unknown[] }>;
    const gotchas = after.find((d) => d.slug === "gotchas")!;
    expect(gotchas.body).toBe("v2 — corrected");
    expect(gotchas.verdict).toBe("unverified");
    expect(gotchas.disputes).toEqual([]);

    store.close();
  });

  test("preserves provenance frontmatter across an edit rather than dropping it", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    await writeDraftFile(knowledgeDir, id, {
      slug: "toolchain",
      title: "Toolchain",
      body: "v1",
      generatedFromSha: "abc123",
      generatedByLaunchId: "launch-1",
    });
    await knowledgeSync.syncDrafts(id);

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    await app.request(`/api/projects/${id}/knowledge/drafts/toolchain`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Toolchain", body: "v2" }),
    });

    const after = (await (
      await app.request(`/api/projects/${id}/knowledge/drafts`)
    ).json()) as Array<{ slug: string; generatedFromSha?: string; generatedByLaunchId?: string }>;
    const toolchain = after.find((d) => d.slug === "toolchain")!;
    expect(toolchain.generatedFromSha).toBe("abc123");
    expect(toolchain.generatedByLaunchId).toBe("launch-1");

    store.close();
  });

  test("a reviewer can reclassify a draft's source_kind (code -> product); omitting it preserves the kind", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    // A draft stamped 'code' by the default propose path — the state the whole
    // live corpus is in, which left product injection with nothing to retrieve.
    await writeDraftFile(knowledgeDir, id, {
      slug: "intent",
      title: "Product intent",
      body: "v1",
      sourceKind: "code",
    });
    await knowledgeSync.syncDrafts(id);

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);

    // Reclassify to product on edit.
    const reclassify = await app.request(`/api/projects/${id}/knowledge/drafts/intent`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "v2", source_kind: "product" }),
    });
    expect(reclassify.status).toBe(200);
    let intent = (
      (await (
        await app.request(`/api/projects/${id}/knowledge/drafts`)
      ).json()) as Array<{ slug: string; sourceKind?: string }>
    ).find((d) => d.slug === "intent")!;
    expect(intent.sourceKind).toBe("product");

    // A later edit that omits source_kind must not silently drop it back to code.
    const preserve = await app.request(`/api/projects/${id}/knowledge/drafts/intent`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "v3 — typo fix" }),
    });
    expect(preserve.status).toBe(200);
    intent = (
      (await (
        await app.request(`/api/projects/${id}/knowledge/drafts`)
      ).json()) as Array<{ slug: string; sourceKind?: string }>
    ).find((d) => d.slug === "intent")!;
    expect(intent.sourceKind).toBe("product");

    store.close();
  });

  // A scope='user' draft would land in the personal layer, which only Persona
  // writes: neither a body edit nor an accept of it goes through, and the draft
  // keeps its body and authored audience.
  test("a body edit and an accept of a scope='user' draft are refused", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    // Alice's pending, private (scope='user') draft — the propose path stamps
    // scope+owner then keeps it a draft (request_human_review).
    await writeDraftFile(knowledgeDir, id, {
      slug: "note",
      title: "Note",
      body: "v1",
      scope: "user",
      ownerUser: "alice",
    });
    await knowledgeSync.syncDrafts(id);

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);

    // Alice is the draft's owner. (Another user's personal draft is hidden from
    // them — see knowledge-write-quality.test.ts.)
    const asAlice = { "Content-Type": "application/json", ...signedIn("alice") };
    const putRes = await app.request(`/api/projects/${id}/knowledge/drafts/note`, {
      method: "PUT",
      headers: asAlice,
      body: JSON.stringify({ body: "v2 — corrected" }),
    });
    expect(putRes.status).toBe(403);

    // The draft is as written, audience included (loadDrafts round-trips it).
    const draft = (
      (await (
        await app.request(`/api/projects/${id}/knowledge/drafts`, { headers: asAlice })
      ).json()) as Array<{ slug: string; body: string; scope?: string; ownerUser?: string }>
    ).find((d) => d.slug === "note")!;
    expect(draft.body).toBe("v1");
    expect(draft.scope).toBe("user");
    expect(draft.ownerUser).toBe("alice");

    const acceptRes = await app.request(`/api/projects/${id}/knowledge/drafts/note/accept`, {
      method: "POST",
      headers: asAlice,
    });
    expect(acceptRes.status).toBe(403);
    expect(await readKnowledgeFile(knowledgeDir, id, "note")).toBeNull();

    store.close();
  });

  test("a body edit preserves a scope='global' draft (not demoted to project on accept)", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    await writeDraftFile(knowledgeDir, id, {
      slug: "note",
      title: "Note",
      body: "v1",
      scope: "global",
    });
    await knowledgeSync.syncDrafts(id);

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    await app.request(`/api/projects/${id}/knowledge/drafts/note`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "v2" }),
    });

    const draft = (
      (await (
        await app.request(`/api/projects/${id}/knowledge/drafts`)
      ).json()) as Array<{ slug: string; scope?: string }>
    ).find((d) => d.slug === "note")!;
    expect(draft.scope).toBe("global");

    await app.request(`/api/projects/${id}/knowledge/drafts/note/accept`, { method: "POST" });
    const doc = await readKnowledgeFile(knowledgeDir, id, "note");
    expect(doc?.body).toBe("v2");
    expect(doc?.scope).toBe("global");

    store.close();
  });

  test("a scope-less draft edit stays scope-less (defaults to project on accept, unchanged)", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    // A legacy/ordinary draft that never asserted a scope — the edit must not
    // fabricate one, so the fresh accept still defaults to 'project' as before.
    await writeDraftFile(knowledgeDir, id, { slug: "note", title: "Note", body: "v1" });
    await knowledgeSync.syncDrafts(id);

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    await app.request(`/api/projects/${id}/knowledge/drafts/note`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "v2" }),
    });

    const draft = (
      (await (
        await app.request(`/api/projects/${id}/knowledge/drafts`)
      ).json()) as Array<{ slug: string; scope?: string; ownerUser?: string }>
    ).find((d) => d.slug === "note")!;
    expect(draft.scope ?? null).toBeNull();
    expect(draft.ownerUser ?? null).toBeNull();

    await app.request(`/api/projects/${id}/knowledge/drafts/note/accept`, { method: "POST" });
    const doc = await readKnowledgeFile(knowledgeDir, id, "note");
    // Raw off the file: still no scope frontmatter (the loader applies the
    // 'project' default on ingest of the accepted doc).
    expect(doc?.scope).toBeUndefined();

    store.close();
  });
});

describe("POST .../knowledge/drafts/:slug/accept", () => {
  test("a first-bootstrap draft (no replaces_slug) moves the file and deletes the row", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    await writeDraftFile(knowledgeDir, id, { slug: "gotchas", title: "Gotchas", body: "watch out" });
    await knowledgeSync.syncDrafts(id);

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    const res = await app.request(`/api/projects/${id}/knowledge/drafts/gotchas/accept`, {
      method: "POST",
    });
    expect(res.status).toBe(200);

    // The draft file is gone from .drafts/...
    await expect(
      readdir(join(knowledgeDir, id, ".drafts")).then((files) => {
        if (files.includes("gotchas.md")) throw new Error("draft file still present");
      })
    ).resolves.toBeUndefined();

    // ...and it's now the accepted doc.
    const doc = await readKnowledgeFile(knowledgeDir, id, "gotchas");
    expect(doc?.body).toBe("watch out");

    // The row is gone too — accept-all should not see it as pending.
    const drafts = (await (
      await app.request(`/api/projects/${id}/knowledge/drafts`)
    ).json()) as Array<{ slug: string }>;
    expect(drafts.find((d) => d.slug === "gotchas")).toBeUndefined();

    store.close();
  });

  test("a regenerated draft (replaces_slug set) requires a merge body by default — no silent overwrite", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    await writeKnowledgeFile(knowledgeDir, id, {
      slug: "gotchas",
      title: "Gotchas",
      body: "human-written original",
    });
    await writeDraftFile(knowledgeDir, id, {
      slug: "gotchas",
      title: "Gotchas",
      body: "regenerated version",
      replacesSlug: "gotchas",
    });
    await knowledgeSync.syncDrafts(id);

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);

    // No mode, no body — must not silently replace the human's doc.
    const noBody = await app.request(`/api/projects/${id}/knowledge/drafts/gotchas/accept`, {
      method: "POST",
    });
    expect(noBody.status).toBe(400);
    const stillOriginal = await readKnowledgeFile(knowledgeDir, id, "gotchas");
    expect(stillOriginal?.body).toBe("human-written original");

    // Supplying merged text accepts it as the new combined doc.
    const merged = await app.request(`/api/projects/${id}/knowledge/drafts/gotchas/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "combined: original + regenerated" }),
    });
    expect(merged.status).toBe(200);
    const mergedDoc = await readKnowledgeFile(knowledgeDir, id, "gotchas");
    expect(mergedDoc?.body).toBe("combined: original + regenerated");

    // The draft is gone either way it lands.
    const drafts = (await (
      await app.request(`/api/projects/${id}/knowledge/drafts`)
    ).json()) as Array<{ slug: string }>;
    expect(drafts.find((d) => d.slug === "gotchas")).toBeUndefined();

    store.close();
  });

  test("mode: replace overwrites the accepted doc with the draft's own text", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    await writeKnowledgeFile(knowledgeDir, id, {
      slug: "gotchas",
      title: "Gotchas",
      body: "human-written original",
    });
    await writeDraftFile(knowledgeDir, id, {
      slug: "gotchas",
      title: "Gotchas",
      body: "regenerated version",
      replacesSlug: "gotchas",
    });
    await knowledgeSync.syncDrafts(id);

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    const res = await app.request(`/api/projects/${id}/knowledge/drafts/gotchas/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "replace" }),
    });
    expect(res.status).toBe(200);

    const doc = await readKnowledgeFile(knowledgeDir, id, "gotchas");
    expect(doc?.body).toBe("regenerated version");

    store.close();
  });

  test("accepting a draft broadcasts a knowledge:change 'accepted' carrying the authoring session (curated feed)", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    // The draft is stamped with the launch that authored it; accept resolves the
    // launch's session so the "doc accepted" transition surfaces as a feed item
    // attributed to the session that proposed it.
    const sessionId = randomUUID();
    createSession(store.db, { id: sessionId, projectId: id, title: "", cwd: "/tmp/wt", status: "running" });
    const launch = createLaunch(store.db, {
      id: randomUUID(),
      kind: "worktree",
      projectId: id,
      task: "author knowledge",
      worktreePath: "/tmp/wt",
      branch: "standup/author",
      status: "running",
      sessionId,
    });

    await writeDraftFile(knowledgeDir, id, {
      slug: "gotchas",
      title: "Gotchas",
      body: "watch out",
      generatedByLaunchId: launch.id,
    });
    await knowledgeSync.syncDrafts(id);

    const broadcasts: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const app = createServer(
      store,
      (msg) => broadcasts.push(msg as { type: string; payload: Record<string, unknown> }),
      null,
      knowledgeSync,
      undefined,
      knowledgeDir
    );
    const res = await app.request(`/api/projects/${id}/knowledge/drafts/gotchas/accept`, {
      method: "POST",
    });
    expect(res.status).toBe(200);

    const change = broadcasts.find(
      (m) =>
        m.type === "knowledge:change" &&
        (m.payload as { kind?: string }).kind === "accepted"
    );
    expect(change).toBeDefined();
    expect((change!.payload as { sessionId?: string }).sessionId).toBe(sessionId);
    expect((change!.payload as { title: string }).title).toBe("Gotchas");
    expect((change!.payload as { slug: string }).slug).toBe("gotchas");

    store.close();
  });

  test("a merge-accept broadcasts a knowledge:change 'reconciled'", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    await writeKnowledgeFile(knowledgeDir, id, {
      slug: "gotchas",
      title: "Gotchas",
      body: "human-written original",
    });
    await writeDraftFile(knowledgeDir, id, {
      slug: "gotchas",
      title: "Gotchas",
      body: "regenerated version",
      replacesSlug: "gotchas",
    });
    await knowledgeSync.syncDrafts(id);

    const broadcasts: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const app = createServer(
      store,
      (msg) => broadcasts.push(msg as { type: string; payload: Record<string, unknown> }),
      null,
      knowledgeSync,
      undefined,
      knowledgeDir
    );
    const res = await app.request(`/api/projects/${id}/knowledge/drafts/gotchas/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "merge", body: "combined text" }),
    });
    expect(res.status).toBe(200);
    expect(
      broadcasts.some(
        (m) =>
          m.type === "knowledge:change" &&
          (m.payload as { kind?: string }).kind === "reconciled"
      )
    ).toBe(true);

    store.close();
  });

  test("accepting a draft with no authoring session still broadcasts a knowledge:change (no session attached)", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    await writeDraftFile(knowledgeDir, id, { slug: "gotchas", title: "Gotchas", body: "watch out" });
    await knowledgeSync.syncDrafts(id);

    const broadcasts: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const app = createServer(
      store,
      (msg) => broadcasts.push(msg as { type: string; payload: Record<string, unknown> }),
      null,
      knowledgeSync,
      undefined,
      knowledgeDir
    );
    const res = await app.request(`/api/projects/${id}/knowledge/drafts/gotchas/accept`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    // A project-scoped change surfaces even without a session — but with no
    // authoring session to attribute it to, and never as a session checkpoint.
    const change = broadcasts.find(
      (m) =>
        m.type === "knowledge:change" &&
        (m.payload as { kind?: string }).kind === "accepted"
    );
    expect(change).toBeDefined();
    expect((change!.payload as { sessionId?: string }).sessionId).toBeUndefined();
    expect(broadcasts.some((m) => m.type === "checkpoint:new")).toBe(false);

    store.close();
  });

  test("an accepted knowledge:change is persisted — it survives a reload via the ledger", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    await writeDraftFile(knowledgeDir, id, { slug: "gotchas", title: "Gotchas", body: "watch out" });
    await knowledgeSync.syncDrafts(id);

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    const res = await app.request(`/api/projects/${id}/knowledge/drafts/gotchas/accept`, {
      method: "POST",
    });
    expect(res.status).toBe(200);

    // The REST ledger the seq-gap resync re-reads holds the change — a WS-only
    // payload would leave this empty.
    const ledgerRes = await app.request("/api/knowledge-changes");
    expect(ledgerRes.status).toBe(200);
    const ledger = (await ledgerRes.json()) as Array<{
      kind: string;
      slug: string;
      title: string;
    }>;
    const accepted = ledger.find((c) => c.kind === "accepted" && c.slug === "gotchas");
    expect(accepted).toBeDefined();
    expect(accepted!.title).toBe("Gotchas");

    store.close();
  });
});

describe("PUT .../knowledge/:slug — provenance on edit (phase-7 Step 6 decision)", () => {
  test("editing an accepted generated doc preserves generated_from_sha", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    await writeKnowledgeFile(knowledgeDir, id, {
      slug: "gotchas",
      title: "Gotchas",
      body: "generated text",
      generatedFromSha: "abc123",
    });

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    const res = await app.request(`/api/projects/${id}/knowledge/gotchas`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Gotchas", body: "fixed a typo" }),
    });
    expect(res.status).toBe(200);

    const doc = await readKnowledgeFile(knowledgeDir, id, "gotchas");
    expect(doc?.body).toBe("fixed a typo");
    // The point: a plain edit is not the same act as disowning where the
    // text came from, so it must not silently exempt the doc from staleness.
    expect(doc?.generatedFromSha).toBe("abc123");

    store.close();
  });

  test("a reviewer can reclassify an accepted doc's source_kind (code -> spec); omitting it preserves the kind", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    await writeKnowledgeFile(knowledgeDir, id, {
      slug: "checkout",
      title: "Checkout",
      body: "v1",
      sourceKind: "code",
    });

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);

    const reclassify = await app.request(`/api/projects/${id}/knowledge/checkout`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Checkout", body: "v2", source_kind: "spec" }),
    });
    expect(reclassify.status).toBe(200);
    expect((await readKnowledgeFile(knowledgeDir, id, "checkout"))?.sourceKind).toBe("spec");

    // A later text-only edit must not silently reset the reclassified kind.
    const preserve = await app.request(`/api/projects/${id}/knowledge/checkout`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Checkout", body: "v3 — typo fix" }),
    });
    expect(preserve.status).toBe(200);
    expect((await readKnowledgeFile(knowledgeDir, id, "checkout"))?.sourceKind).toBe("spec");

    store.close();
  });

  test("editing a human-authored doc still has no provenance to preserve", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    await writeKnowledgeFile(knowledgeDir, id, {
      slug: "conventions",
      title: "Conventions",
      body: "written by a person",
    });

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    await app.request(`/api/projects/${id}/knowledge/conventions`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Conventions", body: "edited by the same person" }),
    });

    const doc = await readKnowledgeFile(knowledgeDir, id, "conventions");
    expect(doc?.generatedFromSha).toBeUndefined();

    store.close();
  });

  test("merge-accept drops provenance on purpose, unlike a plain edit", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    await writeKnowledgeFile(knowledgeDir, id, {
      slug: "gotchas",
      title: "Gotchas",
      body: "human-written original",
      generatedFromSha: "abc123",
    });
    await writeDraftFile(knowledgeDir, id, {
      slug: "gotchas",
      title: "Gotchas",
      body: "regenerated version",
      generatedFromSha: "def456",
      replacesSlug: "gotchas",
    });
    await knowledgeSync.syncDrafts(id);

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    const res = await app.request(`/api/projects/${id}/knowledge/drafts/gotchas/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "merge", body: "combined text" }),
    });
    expect(res.status).toBe(200);

    const doc = await readKnowledgeFile(knowledgeDir, id, "gotchas");
    expect(doc?.body).toBe("combined text");
    expect(doc?.generatedFromSha).toBeUndefined();

    store.close();
  });
});

describe("re-verification verdict is cleared by human accept/edit (r5 review)", () => {
  // Reads the DB-only verdict the way the Knowledge tab route does.
  async function verdictOf(
    app: ReturnType<typeof createServer>,
    id: string,
    slug: string
  ): Promise<string | null | undefined> {
    const docs = (await (await app.request(`/api/projects/${id}/knowledge`)).json()) as Array<{
      slug: string;
      verdict?: string | null;
    }>;
    return docs.find((d) => d.slug === slug)?.verdict;
  }

  test("PUT edit of an accepted doc clears a stale disputed verdict", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    await writeKnowledgeFile(knowledgeDir, id, {
      slug: "gotchas",
      title: "Gotchas",
      body: "generated text",
      generatedFromSha: "abc123",
    });
    await knowledgeSync.syncProject(id);
    new KnowledgeStore(store.db).setDocVerdict(id, "gotchas", "disputed", [{ claim: "wrong" }]);

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    expect(await verdictOf(app, id, "gotchas")).toBe("disputed");

    const res = await app.request(`/api/projects/${id}/knowledge/gotchas`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Gotchas", body: "rewritten to be correct" }),
    });
    expect(res.status).toBe(200);
    // The verdict described the old body; the human just asserted a new one.
    expect(await verdictOf(app, id, "gotchas")).toBeFalsy();

    store.close();
  });

  test("PUT edit of a REFUTED doc lifts its sub-floor confidence back into injection", async () => {
    // The dispute path writes BOTH a DB verdict AND a sub-floor confidence into
    // frontmatter (DISPUTED_CONFIDENCE). Clearing the verdict alone leaves the
    // confidence below the floor, which gates the doc out of auto-injection
    // ALWAYS (independent of re-verification) — so a human editing to fix the
    // refuted claim must also restore the confidence, or the doc is silently
    // withheld with no recovery path.
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    await writeKnowledgeFile(knowledgeDir, id, {
      slug: "gotchas",
      title: "Gotchas",
      body: "generated text",
      generatedFromSha: "abc123",
      confidence: DISPUTED_CONFIDENCE,
      lastVerifiedAt: "2020-01-01T00:00:00.000Z",
    });
    await knowledgeSync.syncProject(id);
    new KnowledgeStore(store.db).setDocVerdict(id, "gotchas", "disputed", [{ claim: "wrong" }]);

    // Before the edit: the on-disk base is below the floor, so injection is
    // gated out regardless of whether re-verification is active for the doc.
    const before = await readKnowledgeFile(knowledgeDir, id, "gotchas");
    expect(before?.confidence).toBe(DISPUTED_CONFIDENCE);
    expect(
      isConfidenceEligibleForInjection(
        { confidence: before?.confidence, lastVerifiedAt: before?.lastVerifiedAt },
        { reverifyActive: true }
      )
    ).toBe(false);

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    const res = await app.request(`/api/projects/${id}/knowledge/gotchas`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Gotchas", body: "rewritten to be correct" }),
    });
    expect(res.status).toBe(200);

    // The verdict is cleared AND the confidence is lifted back above the floor,
    // stamped fresh — so the doc is injection-eligible again.
    expect(await verdictOf(app, id, "gotchas")).toBeFalsy();
    const after = await readKnowledgeFile(knowledgeDir, id, "gotchas");
    expect(after?.confidence).toBeGreaterThanOrEqual(MIN_INJECTION_CONFIDENCE);
    expect(new Date(after!.lastVerifiedAt!).getTime()).toBeGreaterThan(
      new Date("2020-01-01T00:00:00.000Z").getTime()
    );
    expect(
      isConfidenceEligibleForInjection(
        { confidence: after?.confidence, lastVerifiedAt: after?.lastVerifiedAt },
        { reverifyActive: true }
      )
    ).toBe(true);
    // Provenance is preserved — the edit re-asserts the claim, it doesn't strip
    // the doc's source anchor.
    expect(after?.generatedFromSha).toBe("abc123");

    store.close();
  });

  test("PUT edit of a time-decayed doc restarts its clock on a body change, not on a title-only change", async () => {
    // Changing the body is the author restating the doc as current, so its decay
    // clock restarts; an edit that leaves the body alone keeps the stamp.
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    await writeKnowledgeFile(knowledgeDir, id, {
      slug: "gotchas",
      title: "Gotchas",
      body: "generated text",
      generatedFromSha: "abc123",
      confidence: 1,
      lastVerifiedAt: "2020-01-01T00:00:00.000Z",
    });
    await knowledgeSync.syncProject(id);

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    const put = (title: string, body: string) =>
      app.request(`/api/projects/${id}/knowledge/gotchas`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, body }),
      });

    expect((await put("Gotchas (renamed)", "generated text")).status).toBe(200);
    const renamed = await readKnowledgeFile(knowledgeDir, id, "gotchas");
    expect(renamed?.confidence).toBe(1);
    expect(renamed?.lastVerifiedAt).toBe("2020-01-01T00:00:00.000Z");

    const before = Date.now();
    expect((await put("Gotchas", "fixed a typo")).status).toBe(200);
    const after = await readKnowledgeFile(knowledgeDir, id, "gotchas");
    expect(after?.confidence).toBe(1);
    expect(Date.parse(after?.lastVerifiedAt ?? "")).toBeGreaterThanOrEqual(before - 1000);

    store.close();
  });

  test("PUT edit of an accepted distilled doc preserves related edges + origin_class + source_session_id", async () => {
    // The distiller's headline artifact is the cross-project `related:` edges it
    // derives and the session→doc provenance it stamps. A full rewrite through
    // writeKnowledgeFile emits only what it is handed, so the edit route must
    // read these off the existing file and pass them back — otherwise a routine
    // human typo-fix silently severs the graph edges and reverts origin_class to
    // the loader's `owner` default, destroying the self-grown connectivity.
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    await writeKnowledgeFile(knowledgeDir, id, {
      slug: "gotchas",
      title: "Gotchas",
      body: "distilled text",
      related: ["projB/foo"],
      originClass: "agent",
      sourceSessionId: "sess-123",
      generatedFromSha: "abc123",
    });
    await knowledgeSync.syncProject(id);

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    const res = await app.request(`/api/projects/${id}/knowledge/gotchas`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Gotchas", body: "fixed a typo" }),
    });
    expect(res.status).toBe(200);

    const after = await readKnowledgeFile(knowledgeDir, id, "gotchas");
    expect(after?.body).toBe("fixed a typo");
    expect(after?.related).toEqual(["projB/foo"]);
    expect(after?.originClass).toBe("agent");
    expect(after?.sourceSessionId).toBe("sess-123");
    expect(after?.generatedFromSha).toBe("abc123");

    store.close();
  });

  test("merge-accept over a disputed doc clears the verdict (the permanent-DISPUTED bug)", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    await writeKnowledgeFile(knowledgeDir, id, {
      slug: "gotchas",
      title: "Gotchas",
      body: "human-written original",
      generatedFromSha: "abc123",
    });
    await knowledgeSync.syncProject(id);
    new KnowledgeStore(store.db).setDocVerdict(id, "gotchas", "disputed", [{ claim: "stale" }]);

    await writeDraftFile(knowledgeDir, id, {
      slug: "gotchas",
      title: "Gotchas",
      body: "regenerated version",
      generatedFromSha: "def456",
      replacesSlug: "gotchas",
    });
    await knowledgeSync.syncDrafts(id);

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    const res = await app.request(`/api/projects/${id}/knowledge/drafts/gotchas/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "merge", body: "combined text" }),
    });
    expect(res.status).toBe(200);
    // The merge path drops provenance, so the cron can never re-check it — the
    // clear on accept is the ONLY thing that lifts the stale verdict.
    expect(await verdictOf(app, id, "gotchas")).toBeFalsy();

    store.close();
  });

  test("accept-all clears a stale verdict on a freshly accepted doc", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    // A doc already exists at this slug carrying a disputed verdict; a plain
    // (non-replacing) draft of the same name is accepted over it by accept-all.
    await writeKnowledgeFile(knowledgeDir, id, {
      slug: "overview",
      title: "Overview",
      body: "old",
    });
    await knowledgeSync.syncProject(id);
    new KnowledgeStore(store.db).setDocVerdict(id, "overview", "disputed", []);
    await writeDraftFile(knowledgeDir, id, { slug: "overview", title: "Overview", body: "new" });
    await knowledgeSync.syncDrafts(id);

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    const res = await app.request(`/api/projects/${id}/knowledge/drafts/accept-all`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(await verdictOf(app, id, "overview")).toBeFalsy();

    store.close();
  });
});

describe("POST .../knowledge/drafts/:slug/discard", () => {
  test("removes both the file and the row", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    await writeDraftFile(knowledgeDir, id, { slug: "gotchas", title: "Gotchas", body: "watch out" });
    await knowledgeSync.syncDrafts(id);

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    const res = await app.request(`/api/projects/${id}/knowledge/drafts/gotchas/discard`, {
      method: "POST",
    });
    expect(res.status).toBe(200);

    await expect(
      readdir(join(knowledgeDir, id, ".drafts")).then((files) => {
        if (files.includes("gotchas.md")) throw new Error("draft file still present");
      })
    ).resolves.toBeUndefined();

    const drafts = (await (
      await app.request(`/api/projects/${id}/knowledge/drafts`)
    ).json()) as Array<{ slug: string }>;
    expect(drafts.find((d) => d.slug === "gotchas")).toBeUndefined();

    store.close();
  });

  test("discarding a slug with no draft is a 404", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const app = createServer(store, () => {}, null, new KnowledgeSync(store.db, knowledgeDir, null), undefined, knowledgeDir);

    const res = await app.request(`/api/projects/${id}/knowledge/drafts/nope/discard`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
    store.close();
  });
});

describe("DELETE .../knowledge/:slug", () => {
  test("removing an accepted doc broadcasts a knowledge:change 'removed' naming the doc", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    await writeKnowledgeFile(knowledgeDir, id, { slug: "gotchas", title: "Gotchas", body: "watch out" });
    await knowledgeSync.syncProject(id);

    const broadcasts: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const app = createServer(
      store,
      (msg) => broadcasts.push(msg as { type: string; payload: Record<string, unknown> }),
      null,
      knowledgeSync,
      undefined,
      knowledgeDir
    );
    const res = await app.request(`/api/projects/${id}/knowledge/gotchas`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const change = broadcasts.find(
      (m) => m.type === "knowledge:change" && (m.payload as { kind?: string }).kind === "removed"
    );
    expect(change).toBeDefined();
    // The title is read before the file is deleted, so the feed names the doc.
    expect((change!.payload as { title: string }).title).toBe("Gotchas");

    store.close();
  });
});

describe("POST .../knowledge/drafts/accept-all", () => {
  test("accepts only plain drafts — leaves replacing and disputed drafts pending, and says why", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    await writeKnowledgeFile(knowledgeDir, id, { slug: "practices", title: "Practices", body: "existing" });

    await writeDraftFile(knowledgeDir, id, { slug: "overview", title: "Overview", body: "new doc" });
    await writeDraftFile(knowledgeDir, id, {
      slug: "practices",
      title: "Practices",
      body: "regenerated",
      replacesSlug: "practices",
    });
    await writeDraftFile(knowledgeDir, id, { slug: "gotchas", title: "Gotchas", body: "disputed one" });
    await knowledgeSync.syncDrafts(id);
    knowledgeSync.recordDraftVerdict(id, "gotchas", "disputed", [
      { claim: "x", finding: "y", evidence: "z" },
    ]);

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    const res = await app.request(`/api/projects/${id}/knowledge/drafts/accept-all`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      accepted: string[];
      skipped: Array<{ slug: string; reason: string }>;
    };

    expect(json.accepted).toEqual(["overview"]);
    expect(json.skipped).toEqual(
      expect.arrayContaining([
        { slug: "practices", reason: "replaces" },
        { slug: "gotchas", reason: "disputed" },
      ])
    );

    // overview landed as an accepted doc...
    expect((await readKnowledgeFile(knowledgeDir, id, "overview"))?.body).toBe("new doc");
    // ...practices was NOT overwritten...
    expect((await readKnowledgeFile(knowledgeDir, id, "practices"))?.body).toBe("existing");

    // ...and both practices and gotchas are still pending drafts.
    const remaining = (await (
      await app.request(`/api/projects/${id}/knowledge/drafts`)
    ).json()) as Array<{ slug: string }>;
    expect(remaining.map((d) => d.slug).sort()).toEqual(["gotchas", "practices"]);

    store.close();
  });

  test("dedups two near-duplicate fresh drafts within the same batch", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    // Text-only (no embedding provider) — the lexical near-dup arm carries dedup,
    // which is exactly the supported zero-config default.
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    // Two fresh drafts with near-identical bodies. Neither exists in the corpus
    // yet, so both are only visible to each other once accepted+synced — the
    // same-batch case that slips through if the index isn't kept current inside
    // the accept loop.
    const body =
      "The collector distills a session transcript into a knowledge draft through the backend seam and indexes each accepted document for later retrieval by hybrid search.";
    await writeDraftFile(knowledgeDir, id, { slug: "distill-a", title: "Distiller overview", body });
    await writeDraftFile(knowledgeDir, id, { slug: "distill-b", title: "Distiller overview", body });
    await knowledgeSync.syncDrafts(id);

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    const res = await app.request(`/api/projects/${id}/knowledge/drafts/accept-all`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      accepted: string[];
      skipped: Array<{ slug: string; reason: string }>;
    };

    // Exactly one landed; the other was suppressed as a same-batch duplicate.
    expect(json.accepted).toHaveLength(1);
    expect(json.skipped).toHaveLength(1);
    expect(json.skipped[0]!.reason).toBe("duplicate");
    // The accepted and the deduped are the two drafts (order-independent).
    expect([json.accepted[0], json.skipped[0]!.slug].sort()).toEqual(["distill-a", "distill-b"]);

    store.close();
  });
});

/**
 * A merge/replace accept overwrites an EXISTING accepted doc, and scope/owner_user
 * are that doc's RETRIEVAL AUDIENCE, not content. A regenerate is a body change, so
 * accepting one must never silently reset the target's audience to the 'project'
 * default — that would expose a scope='user' private doc to the whole project (or
 * demote a scope='global' doc). The merge branch rewrites via writeKnowledgeFile
 * (which emits only what it is handed) and the replace branch renames a draft file
 * that may carry no scope of its own (an ingest-url regenerate) — both must carry
 * the target doc's scope/owner through. A scope='user' target is in the personal
 * layer, which only Persona writes, so a merge or replace onto one is refused: 409
 * for another user's doc (it reads as absent to the caller), 403 for the caller's own.
 */
describe("accepting a regenerate preserves the target doc's scope/owner (audience is not reset)", () => {
  test("MERGE onto a scope='user' doc is refused, for its owner and for anyone else", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    // Alice's accepted, private (scope='user') note.
    await writeKnowledgeFile(knowledgeDir, id, {
      slug: "note",
      title: "Note",
      body: "alice's original private note",
      scope: "user",
      ownerUser: "alice",
    });
    // A regenerate draft with NO scope of its own, targeting the same slug.
    await writeDraftFile(knowledgeDir, id, {
      slug: "note",
      title: "Note",
      body: "regenerated note",
      replacesSlug: "note",
    });
    await knowledgeSync.syncDrafts(id);

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    // Default mode (merge) with a human-combined body: from another user, then from alice.
    for (const [headers, status] of [
      [{}, 409],
      [signedIn("alice"), 403],
    ] as const) {
      const res = await app.request(`/api/projects/${id}/knowledge/drafts/note/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ body: "combined: original + regenerated" }),
      });
      expect(res.status).toBe(status);
    }

    const doc = await readKnowledgeFile(knowledgeDir, id, "note");
    expect(doc?.body).toBe("alice's original private note");
    expect(doc?.scope).toBe("user");
    expect(doc?.ownerUser).toBe("alice");
    expect(knowledgeSync.getDraft(id, "note")?.body).toBe("regenerated note");

    store.close();
  });

  test("MERGE of a scope='global' doc keeps scope='global'", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    await writeKnowledgeFile(knowledgeDir, id, {
      slug: "note",
      title: "Note",
      body: "corpus-wide guidance",
      scope: "global",
    });
    await writeDraftFile(knowledgeDir, id, {
      slug: "note",
      title: "Note",
      body: "regenerated",
      replacesSlug: "note",
    });
    await knowledgeSync.syncDrafts(id);

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    const res = await app.request(`/api/projects/${id}/knowledge/drafts/note/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "combined corpus-wide guidance" }),
    });
    expect(res.status).toBe(200);

    const doc = await readKnowledgeFile(knowledgeDir, id, "note");
    expect(doc?.body).toBe("combined corpus-wide guidance");
    // A global doc is not silently demoted to project on merge.
    expect(doc?.scope).toBe("global");

    store.close();
  });

  test("REPLACE of a scope='user' doc with a scope-less draft is refused, for its owner and for anyone else", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    // Alice's private note.
    await writeKnowledgeFile(knowledgeDir, id, {
      slug: "note",
      title: "Note",
      body: "alice's original private note",
      scope: "user",
      ownerUser: "alice",
    });
    // A regenerate draft with NO scope of its own — e.g. an ingest-url refresh.
    // acceptDraftFile is a plain rename, so without the preserve-on-publish path
    // this would land the file scope-less and demote it to the project default.
    await writeDraftFile(knowledgeDir, id, {
      slug: "note",
      title: "Note",
      body: "refreshed body",
      replacesSlug: "note",
    });
    await knowledgeSync.syncDrafts(id);

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    for (const [headers, status] of [
      [{}, 409],
      [signedIn("alice"), 403],
    ] as const) {
      const res = await app.request(`/api/projects/${id}/knowledge/drafts/note/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ mode: "replace" }),
      });
      expect(res.status).toBe(status);
    }

    const doc = await readKnowledgeFile(knowledgeDir, id, "note");
    expect(doc?.body).toBe("alice's original private note");
    expect(doc?.scope).toBe("user");
    expect(doc?.ownerUser).toBe("alice");

    store.close();
  });
});

/**
 * Which drafts the personal-layer write guard holds back. A worker's draft
 * about a project is in the docs or intent layer whatever its scope (project,
 * global or unset) or slug wording, so the owner accepts it like any other. A
 * draft that would land in or over the personal layer stays Persona's alone.
 */
describe("accepting worker drafts vs the personal-layer guard", () => {
  test("a worker's project drafts replacing agent docs are accepted", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    const cases = [
      { slug: "personal-stack-deploy-target", sourceKind: "runbook" as const, scope: undefined },
      { slug: "first-release-scope", sourceKind: "spec" as const, scope: "global" as const },
      { slug: "list-widgets-api", sourceKind: "code" as const, scope: "project" as const },
    ];
    for (const c of cases) {
      await writeKnowledgeFile(knowledgeDir, id, {
        slug: c.slug,
        title: c.slug,
        body: "earlier agent version",
        originClass: "agent",
        sourceSessionId: randomUUID(),
        sourceKind: c.sourceKind,
        scope: c.scope,
      });
      await writeDraftFile(knowledgeDir, id, {
        slug: c.slug,
        title: c.slug,
        body: "worker's refreshed version",
        replacesSlug: c.slug,
        generatedByLaunchId: randomUUID(),
        originClass: "agent",
        sourceSessionId: randomUUID(),
        sourceKind: c.sourceKind,
        scope: c.scope,
      });
    }
    await knowledgeSync.syncDrafts(id);

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    for (const c of cases) {
      const res = await app.request(`/api/projects/${id}/knowledge/drafts/${c.slug}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "replace" }),
      });
      expect(res.status).toBe(200);
      expect((await readKnowledgeFile(knowledgeDir, id, c.slug))?.body).toBe("worker's refreshed version");
    }

    store.close();
  });

  test("a draft over a personal doc, or under a Persona memory slug, is refused", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    await writeKnowledgeFile(knowledgeDir, id, {
      slug: "owner-note",
      title: "Owner note",
      body: "the owner's personal doc",
      scope: "user",
    });
    await writeDraftFile(knowledgeDir, id, {
      slug: "owner-note",
      title: "Owner note",
      body: "a worker's rewrite",
      replacesSlug: "owner-note",
      originClass: "agent",
      sourceKind: "code",
      scope: "project",
    });
    await writeDraftFile(knowledgeDir, id, {
      slug: "persona-prefers-short-replies",
      title: "Prefers short replies",
      body: "not a memory Persona wrote",
      originClass: "agent",
    });
    await knowledgeSync.syncDrafts(id);

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    for (const [slug, mode] of [
      ["owner-note", "replace"],
      ["persona-prefers-short-replies", undefined],
    ] as const) {
      const res = await app.request(`/api/projects/${id}/knowledge/drafts/${slug}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode ? { mode } : {}),
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toContain("written only by Persona");
    }
    expect((await readKnowledgeFile(knowledgeDir, id, "owner-note"))?.body).toBe("the owner's personal doc");
    expect(await readKnowledgeFile(knowledgeDir, id, "persona-prefers-short-replies")).toBeNull();

    store.close();
  });

  test("a draft whose tags are one comma-joined string is accepted with its tags split", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    await mkdir(join(knowledgeDir, id, ".drafts"), { recursive: true });
    await writeFile(
      join(knowledgeDir, id, ".drafts", "promotion-order.md"),
      "---\ntitle: Promotion order\ntags: 'widget-catalog,render-service, v1'\nsource_kind: code\n---\nThe pointer is written last.\n",
      "utf-8"
    );
    await knowledgeSync.syncDrafts(id);

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    const res = await app.request(`/api/projects/${id}/knowledge/drafts/promotion-order/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);

    const docs = (await (await app.request(`/api/projects/${id}/knowledge`)).json()) as Array<{
      slug: string;
      tags?: string[];
    }>;
    expect(docs.find((d) => d.slug === "promotion-order")?.tags).toEqual(["widget-catalog", "render-service", "v1"]);

    store.close();
  });
});
