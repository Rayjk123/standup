import { expect, test, describe, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { createStore, upsertProject, touchUser } from "@standup/store";
import type { Store } from "@standup/store";
import { KnowledgeLoader } from "@standup/knowledge";
import { DEFAULT_IDENTITY_HEADER, GLOBAL_PROJECT_ID } from "@standup/shared";
import {
  createServer,
  resolveUserAlias,
  tunnelHeaderTrust,
  ANONYMOUS_ALIAS,
} from "./server.js";
import { KnowledgeSync } from "./knowledge-sync.js";
import { USER_CHANNEL_HEADER, userChannelToken } from "@standup/shared/owner-token";
import { activeOwnerSecrets } from "./owner-secret.js";

/** `alias`'s signed-in headers: its tunnel identity and its user channel token. */
const signedIn = (alias: string): Record<string, string> => ({
  [DEFAULT_IDENTITY_HEADER]: alias,
  [USER_CHANNEL_HEADER]: userChannelToken(activeOwnerSecrets().ownerToken, alias),
});

/**
 * PUT /api/projects/:id/knowledge/:slug is the general read-modify-write edit
 * path. scope/owner_user are file-authoritative dimensions (a hand-authored
 * `scope: global` promotion or a `scope: user`/`owner_user:` personal doc), and
 * the route rewrites the whole file through writeKnowledgeFile — which emits
 * only what it is handed. If the route did not carry scope/ownerUser back
 * through from the existing file, a plain typo fix would silently drop the
 * frontmatter and the loader would re-default it to scope='project' on resync,
 * losing the deliberate promotion/ownership. These tests drive the real handler
 * and assert the scope survives an edit (not just the writer unit round-trip).
 * A `scope: user` doc is the exception: it is in the personal layer, which only
 * Persona writes, so this route refuses to edit, create or re-scope one.
 */

const cleanupDirs: string[] = [];
afterAll(async () => {
  for (const dir of cleanupDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempKnowledgeDir(projectId: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "standup-knowledge-edit-scope-"));
  cleanupDirs.push(dir);
  await mkdir(join(dir, projectId), { recursive: true });
  return dir;
}

function setUpStore(projectId: string): Store {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: projectId, name: "Edit Scope", branch: "main", repos: [] });
  return store;
}

describe("PUT /api/projects/:id/knowledge/:slug preserves scope/owner on a body edit", () => {
  test("a hand-promoted scope: global doc keeps its scope after a typo fix", async () => {
    const projectId = `edit-scope-p1-${randomUUID().slice(0, 8)}`;
    const store = setUpStore(projectId);
    const knowledgeDir = await tempKnowledgeDir(projectId);
    await writeFile(
      join(knowledgeDir, projectId, "promoted.md"),
      `---\ntitle: Promoted\nscope: global\n---\n\nOriginal body with a tpyo.\n`
    );

    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);

    const res = await app.request(`/api/projects/${projectId}/knowledge/promoted`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Promoted", body: "Original body with a typo fixed." }),
    });
    expect(res.status).toBe(200);

    // The `scope:` key must survive the full rewrite on disk...
    const raw = await readFile(join(knowledgeDir, projectId, "promoted.md"), "utf-8");
    expect(raw).toContain("scope: global");
    expect(raw).toContain("Original body with a typo fixed.");

    // ...so the loader keeps scope='global' rather than re-defaulting to
    // 'project' on the next resync.
    const [loaded] = await new KnowledgeLoader(knowledgeDir).loadProject(projectId);
    expect(loaded.body).toBe("Original body with a typo fixed.");
    expect(loaded.scope).toBe("global");

    store.close();
  });

  test("a body edit of a scope: user / owner_user doc is refused, leaving the file as it was", async () => {
    const projectId = `edit-scope-p2-${randomUUID().slice(0, 8)}`;
    const store = setUpStore(projectId);
    const knowledgeDir = await tempKnowledgeDir(projectId);
    await writeFile(
      join(knowledgeDir, projectId, "mine.md"),
      `---\ntitle: Mine\nscope: user\nowner_user: alice\n---\n\nAlice's personal note.\n`
    );

    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);

    const res = await app.request(`/api/projects/${projectId}/knowledge/mine`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...signedIn("alice") },
      body: JSON.stringify({ title: "Mine", body: "Alice's personal note, expanded." }),
    });
    // The personal layer is written only by Persona.
    expect(res.status).toBe(403);

    const raw = await readFile(join(knowledgeDir, projectId, "mine.md"), "utf-8");
    expect(raw).toBe(`---\ntitle: Mine\nscope: user\nowner_user: alice\n---\n\nAlice's personal note.\n`);

    store.close();
  });

  test("an unpromoted project doc stays clean — no scope/owner_user fabricated on edit", async () => {
    const projectId = `edit-scope-p3-${randomUUID().slice(0, 8)}`;
    const store = setUpStore(projectId);
    const knowledgeDir = await tempKnowledgeDir(projectId);
    await writeFile(
      join(knowledgeDir, projectId, "plain.md"),
      `---\ntitle: Plain\n---\n\nA project-scoped doc, no scope asserted.\n`
    );

    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);

    const res = await app.request(`/api/projects/${projectId}/knowledge/plain`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Plain", body: "A project-scoped doc, edited." }),
    });
    expect(res.status).toBe(200);

    // The route round-trips undefined for a doc that never carried scope, so the
    // frontmatter stays clean (the loader supplies the 'project' default).
    const raw = await readFile(join(knowledgeDir, projectId, "plain.md"), "utf-8");
    expect(raw).not.toContain("scope:");
    expect(raw).not.toContain("owner_user:");

    const [loaded] = await new KnowledgeLoader(knowledgeDir).loadProject(projectId);
    expect(loaded.body).toBe("A project-scoped doc, edited.");
    expect(loaded.scope).toBe("project");
    expect(loaded.ownerUser).toBeUndefined();

    store.close();
  });
});

/**
 * PUT also accepts an EXPLICIT scope (Item 5): a deliberate change/promotion
 * (project -> global, or scoping to 'user') overrides the preserved value, and a
 * scope='user' change stamps the owner from the SERVER-RESOLVED identity — never
 * a client field. A brand-new doc created through this route with no explicit
 * scope takes the project's default, and an invalid scope is rejected.
 */
describe("PUT /api/projects/:id/knowledge/:slug applies an explicit scope + default on create", () => {
  test("promotes an existing project doc to global when scope: global is sent", async () => {
    const projectId = `edit-scope-p4-${randomUUID().slice(0, 8)}`;
    const store = setUpStore(projectId);
    const knowledgeDir = await tempKnowledgeDir(projectId);
    await writeFile(
      join(knowledgeDir, projectId, "promote-me.md"),
      `---\ntitle: Promote Me\n---\n\nStarts project-scoped.\n`
    );

    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);

    const res = await app.request(`/api/projects/${projectId}/knowledge/promote-me`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Promote Me", body: "Now promoted.", scope: "global" }),
    });
    expect(res.status).toBe(200);

    const raw = await readFile(join(knowledgeDir, projectId, "promote-me.md"), "utf-8");
    expect(raw).toContain("scope: global");

    const [loaded] = await new KnowledgeLoader(knowledgeDir).loadProject(projectId);
    expect(loaded.scope).toBe("global");

    store.close();
  });

  test("an explicit scope='user' on an edit is refused, whatever owner the client names", async () => {
    const projectId = `edit-scope-p5-${randomUUID().slice(0, 8)}`;
    const store = setUpStore(projectId);
    const knowledgeDir = await tempKnowledgeDir(projectId);
    await writeFile(
      join(knowledgeDir, projectId, "make-mine.md"),
      `---\ntitle: Make Mine\n---\n\nA project doc becoming personal.\n`
    );

    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);

    const res = await app.request(`/api/projects/${projectId}/knowledge/make-mine`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...signedIn("alice") },
      // owner_user is a client field the server MUST ignore — the owner is alice.
      body: JSON.stringify({
        title: "Make Mine",
        body: "Now mine.",
        scope: "user",
        owner_user: "mallory",
      }),
    });
    expect(res.status).toBe(403);

    const raw = await readFile(join(knowledgeDir, projectId, "make-mine.md"), "utf-8");
    expect(raw).toBe(`---\ntitle: Make Mine\n---\n\nA project doc becoming personal.\n`);

    store.close();
  });

  test("a brand-new doc with no explicit scope takes the project's default", async () => {
    const projectId = `edit-scope-p6-${randomUUID().slice(0, 8)}`;
    const store = setUpStore(projectId);
    // The project defaults new knowledge to global.
    upsertProject(store.db, {
      id: projectId,
      name: "Edit Scope",
      branch: "main",
      repos: [],
      knowledgeScope: "global",
    });
    const knowledgeDir = await tempKnowledgeDir(projectId);

    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);

    // No file at this slug yet — PUT creates it.
    const res = await app.request(`/api/projects/${projectId}/knowledge/fresh`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Fresh", body: "A brand-new doc." }),
    });
    expect(res.status).toBe(200);

    const raw = await readFile(join(knowledgeDir, projectId, "fresh.md"), "utf-8");
    expect(raw).toContain("scope: global");

    const [loaded] = await new KnowledgeLoader(knowledgeDir).loadProject(projectId);
    expect(loaded.scope).toBe("global");

    store.close();
  });

  test("an invalid scope is rejected without writing", async () => {
    const projectId = `edit-scope-p7-${randomUUID().slice(0, 8)}`;
    const store = setUpStore(projectId);
    const knowledgeDir = await tempKnowledgeDir(projectId);

    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);

    const res = await app.request(`/api/projects/${projectId}/knowledge/bad`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Bad", body: "Should not land.", scope: "everyone" }),
    });
    expect(res.status).toBe(400);

    // Nothing was written.
    await expect(readFile(join(knowledgeDir, projectId, "bad.md"), "utf-8")).rejects.toThrow();

    store.close();
  });
});

/**
 * Regression for the web edit path: the Knowledge editor seeds its scope control
 * from the loaded doc's own scope and re-submits `scope` on EVERY save, so a
 * plain body edit of an already-owned `scope: user` doc arrives at this route as
 * an explicit scope='user' even though the audience is unchanged. Resolving the
 * owner from the editing caller on that no-op re-send would silently reassign the
 * doc (a teammate's typo fix takes it over) or — for an unresolvable caller —
 * demote it to 'project' and widen its audience. Both violate the "a typo fix
 * can't silently alter its audience" invariant. These tests drive the route the
 * way the UI actually does (scope present on every save) rather than omitting it
 * as the preserve-branch tests above do. A user doc is in the personal layer,
 * which only Persona writes: another user's edit is refused as a 409 (the doc
 * reads as absent to them), and any other edit — the owner's included — as a 403.
 */
describe("PUT /api/projects/:id/knowledge/:slug keeps an owned user doc's owner when scope is re-sent", () => {
  async function seedUserDoc(): Promise<{
    projectId: string;
    store: Store;
    knowledgeDir: string;
    app: ReturnType<typeof createServer>;
  }> {
    const projectId = `edit-scope-owner-${randomUUID().slice(0, 8)}`;
    const store = setUpStore(projectId);
    const knowledgeDir = await tempKnowledgeDir(projectId);
    await writeFile(
      join(knowledgeDir, projectId, "mine.md"),
      `---\ntitle: Mine\nscope: user\nowner_user: alice\n---\n\nAlice's personal note.\n`
    );
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    return { projectId, store, knowledgeDir, app };
  }

  test("a teammate editing the body (scope re-sent) does NOT take over the owner or widen the audience", async () => {
    const { projectId, store, knowledgeDir, app } = await seedUserDoc();

    // bob is a different trusted tunnel identity (the multi-user tunnel this
    // per-user-knowledge feature targets). He opens alice's doc, fixes a typo,
    // and saves — the editor re-sends scope:"user" unchanged.
    const res = await app.request(`/api/projects/${projectId}/knowledge/mine`, {
      method: "PUT",
      headers: { "content-type": "application/json", [DEFAULT_IDENTITY_HEADER]: "bob" },
      body: JSON.stringify({
        title: "Mine",
        body: "Alice's personal note, typo fixed.",
        scope: "user",
      }),
    });
    // alice's personal doc is private by layer: bob cannot read it, so his
    // write is refused rather than landing on it.
    expect(res.status).toBe(409);

    // Owner stays alice (no silent takeover), scope stays 'user' (no silent
    // widening to project) and the body is alice's.
    const raw = await readFile(join(knowledgeDir, projectId, "mine.md"), "utf-8");
    expect(raw).toContain("scope: user");
    expect(raw).toContain("owner_user: alice");
    expect(raw).not.toContain("bob");

    const [loaded] = await new KnowledgeLoader(knowledgeDir).loadProject(projectId);
    expect(loaded.body).toBe("Alice's personal note.");
    expect(loaded.scope).toBe("user");
    expect(loaded.ownerUser).toBe("alice");

    store.close();
  });

  test("the owner's own edit of their user doc (scope re-sent) is refused too: only Persona writes the personal layer", async () => {
    const { projectId, store, knowledgeDir, app } = await seedUserDoc();

    const res = await app.request(`/api/projects/${projectId}/knowledge/mine`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...signedIn("alice") },
      body: JSON.stringify({
        title: "Mine",
        body: "Alice's own edit.",
        scope: "user",
      }),
    });
    expect(res.status).toBe(403);

    expect(await readFile(join(knowledgeDir, projectId, "mine.md"), "utf-8")).toBe(`---\ntitle: Mine\nscope: user\nowner_user: alice\n---\n\nAlice\'s personal note.\n`);

    store.close();
  });

  test("a scope change out of the personal layer (user -> project) is refused", async () => {
    const { projectId, store, knowledgeDir, app } = await seedUserDoc();

    // The carve-out only preserves the owner when the doc STAYS user-scoped; an
    // actual scope change (the user picks 'project' in the control) must still
    // demote it and drop the owner, so a user doc is never frozen personal.
    const res = await app.request(`/api/projects/${projectId}/knowledge/mine`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...signedIn("alice") },
      body: JSON.stringify({
        title: "Mine",
        body: "No longer personal.",
        scope: "project",
      }),
    });
    expect(res.status).toBe(403);

    expect(await readFile(join(knowledgeDir, projectId, "mine.md"), "utf-8")).toBe(`---\ntitle: Mine\nscope: user\nowner_user: alice\n---\n\nAlice\'s personal note.\n`);

    store.close();
  });

  test("an edit of a black-hole user doc (no owner_user) is refused", async () => {
    const projectId = `edit-scope-blackhole-${randomUUID().slice(0, 8)}`;
    const store = setUpStore(projectId);
    const knowledgeDir = await tempKnowledgeDir(projectId);
    // A malformed/legacy user doc with no resolvable owner lands in no retrieval
    // window; a body edit with a resolvable caller should recover it by stamping
    // an owner rather than preserving the (missing) one.
    await writeFile(
      join(knowledgeDir, projectId, "orphan.md"),
      `---\ntitle: Orphan\nscope: user\n---\n\nAn owner-less user doc.\n`
    );
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);

    const res = await app.request(`/api/projects/${projectId}/knowledge/orphan`, {
      method: "PUT",
      headers: { "content-type": "application/json", [DEFAULT_IDENTITY_HEADER]: "bob" },
      body: JSON.stringify({ title: "Orphan", body: "Now owned.", scope: "user" }),
    });
    expect(res.status).toBe(403);

    expect(await readFile(join(knowledgeDir, projectId, "orphan.md"), "utf-8")).toBe(`---\ntitle: Orphan\nscope: user\n---\n\nAn owner-less user doc.\n`);

    store.close();
  });
});

/**
 * Ownership boundary on the edit path, as DATA HYGIENE under the tunnel-
 * authenticated model. A `scope: user` doc's owner is a SOFT routing boundary, and
 * an authenticating tunnel authenticates the acting teammate — the identity
 * header is unforgeable (see resolveUserAlias in identity.ts) — so `acting === owner` is a trustworthy check that needs NO write
 * token. The OWNER re-scopes their own doc freely on their verified identity; a
 * DIFFERENT teammate editing it keeps its scope + owner (a body refresh must never
 * silently reassign or widen someone else's private doc). The write token matters
 * only for a caller with no authenticated identity (a raw non-tunnel bind), which
 * the in-process harness — always loopback — cannot produce. Above all of this, a
 * user doc is in the personal layer, which only Persona writes: the owner's own
 * re-scope through this route is refused too, and so is recovering an owner-less one.
 */
describe("PUT /api/projects/:id/knowledge/:slug — owner hygiene on an owned user doc", () => {
  // The write gate reads STANDUP_WRITE_TOKEN / STANDUP_BIND_HOST live per request;
  // force the token-less default unless a test opts in.
  let savedToken: string | undefined;
  let savedBind: string | undefined;
  beforeEach(() => {
    savedToken = process.env.STANDUP_WRITE_TOKEN;
    savedBind = process.env.STANDUP_BIND_HOST;
    delete process.env.STANDUP_WRITE_TOKEN;
    delete process.env.STANDUP_BIND_HOST;
  });
  afterEach(() => {
    if (savedToken === undefined) delete process.env.STANDUP_WRITE_TOKEN;
    else process.env.STANDUP_WRITE_TOKEN = savedToken;
    if (savedBind === undefined) delete process.env.STANDUP_BIND_HOST;
    else process.env.STANDUP_BIND_HOST = savedBind;
  });

  async function seedMultiplayerUserDoc(): Promise<{
    projectId: string;
    store: Store;
    knowledgeDir: string;
    app: ReturnType<typeof createServer>;
  }> {
    const projectId = `edit-scope-guard-${randomUUID().slice(0, 8)}`;
    const store = setUpStore(projectId);
    // Two distinct tunnel identities have connected, so the collector is in
    // multiplayer mode — the deployment this per-user feature targets.
    touchUser(store.db, "alice", { viaTunnel: true });
    touchUser(store.db, "bob", { viaTunnel: true });
    const knowledgeDir = await tempKnowledgeDir(projectId);
    await writeFile(
      join(knowledgeDir, projectId, "mine.md"),
      `---\ntitle: Mine\nscope: user\nowner_user: alice\n---\n\nAlice's personal note.\n`
    );
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    return { projectId, store, knowledgeDir, app };
  }

  test("a different teammate's explicit scope change is ignored — the doc stays user-scoped and owned by alice (no token)", async () => {
    const { projectId, store, knowledgeDir, app } = await seedMultiplayerUserDoc();

    // bob is an authenticated teammate but NOT the owner. He fixes a typo AND picks
    // 'project' in the scope control (a deliberate widen). alice's doc is private
    // by layer, so the whole write is refused — no token is involved.
    const res = await app.request(`/api/projects/${projectId}/knowledge/mine`, {
      method: "PUT",
      headers: { "content-type": "application/json", [DEFAULT_IDENTITY_HEADER]: "bob" },
      body: JSON.stringify({
        title: "Mine",
        body: "Alice's note, typo now fixed.",
        scope: "project",
      }),
    });
    expect(res.status).toBe(409);

    const raw = await readFile(join(knowledgeDir, projectId, "mine.md"), "utf-8");
    expect(raw).toContain("scope: user");
    expect(raw).toContain("owner_user: alice");
    // The owner was NOT reassigned to the editing caller.
    expect(raw).not.toContain("owner_user: bob");

    const [loaded] = await new KnowledgeLoader(knowledgeDir).loadProject(projectId);
    // Neither the body nor the audience changed.
    expect(loaded.body).toBe("Alice's personal note.");
    expect(loaded.scope).toBe("user");
    expect(loaded.ownerUser).toBe("alice");

    store.close();
  });

  test("a different teammate cannot reassign the owner to themselves by re-scoping to user", async () => {
    const { projectId, store, knowledgeDir, app } = await seedMultiplayerUserDoc();

    // bob's write onto alice's personal doc is refused, so he never becomes the owner.
    const res = await app.request(`/api/projects/${projectId}/knowledge/mine`, {
      method: "PUT",
      headers: { "content-type": "application/json", [DEFAULT_IDENTITY_HEADER]: "bob" },
      body: JSON.stringify({ title: "Mine", body: "bob's edit.", scope: "user" }),
    });
    expect(res.status).toBe(409);

    const raw = await readFile(join(knowledgeDir, projectId, "mine.md"), "utf-8");
    expect(raw).toContain("owner_user: alice");
    expect(raw).not.toContain("owner_user: bob");

    store.close();
  });

  test("even a write token does NOT let a different teammate re-aim someone else's user doc (data hygiene)", async () => {
    process.env.STANDUP_WRITE_TOKEN = "s3cret";
    const { projectId, store, knowledgeDir, app } = await seedMultiplayerUserDoc();

    // The owner check — acting === owner — governs a cross-user user-doc edit, NOT
    // the token. bob presents a matching operator token but is still not alice, so
    // his write onto her personal doc is refused: a teammate's regenerate can't
    // re-own, widen or rewrite another's private doc.
    const res = await app.request(`/api/projects/${projectId}/knowledge/mine`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        [DEFAULT_IDENTITY_HEADER]: "bob",
        "x-standup-write-token": "s3cret",
      },
      body: JSON.stringify({
        title: "Mine",
        body: "bob's regenerate.",
        scope: "project",
      }),
    });
    expect(res.status).toBe(409);

    const raw = await readFile(join(knowledgeDir, projectId, "mine.md"), "utf-8");
    expect(raw).toContain("scope: user");
    expect(raw).toContain("owner_user: alice");
    expect(raw).not.toContain("owner_user: bob");

    const [loaded] = await new KnowledgeLoader(knowledgeDir).loadProject(projectId);
    expect(loaded.body).toBe("Alice's personal note.");
    expect(loaded.scope).toBe("user");
    expect(loaded.ownerUser).toBe("alice");

    store.close();
  });

  test("the OWNER re-scoping their own user doc to global is refused (no token)", async () => {
    const { projectId, store, knowledgeDir, app } = await seedMultiplayerUserDoc();

    // alice IS the owner, and her identity header is tunnel-authenticated
    // (unforgeable), so acting === owner authorizes her promotion with no token. The
    // body edit lands and the doc widens to global (user -> global drops the owner).
    const res = await app.request(`/api/projects/${projectId}/knowledge/mine`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...signedIn("alice") },
      body: JSON.stringify({ title: "Mine", body: "Alice promotes it.", scope: "global" }),
    });
    expect(res.status).toBe(403);

    expect(await readFile(join(knowledgeDir, projectId, "mine.md"), "utf-8")).toBe(`---\ntitle: Mine\nscope: user\nowner_user: alice\n---\n\nAlice\'s personal note.\n`);

    store.close();
  });

  test("a different teammate cannot widen someone else's user doc to global (data hygiene, no token)", async () => {
    const { projectId, store, knowledgeDir, app } = await seedMultiplayerUserDoc();

    // bob (authenticated, but not the owner) tries to widen alice's private note to
    // the whole corpus. The doc is private by layer, so the write is refused and
    // the audience is preserved.
    const res = await app.request(`/api/projects/${projectId}/knowledge/mine`, {
      method: "PUT",
      headers: { "content-type": "application/json", [DEFAULT_IDENTITY_HEADER]: "bob" },
      body: JSON.stringify({ title: "Mine", body: "bob's widen attempt.", scope: "global" }),
    });
    expect(res.status).toBe(409);

    const raw = await readFile(join(knowledgeDir, projectId, "mine.md"), "utf-8");
    // alice's private note is NOT globally scoped and her ownership is intact.
    expect(raw).toContain("scope: user");
    expect(raw).toContain("owner_user: alice");
    expect(raw).not.toContain("scope: global");

    const [loaded] = await new KnowledgeLoader(knowledgeDir).loadProject(projectId);
    expect(loaded.scope).toBe("user");
    expect(loaded.ownerUser).toBe("alice");

    store.close();
  });

  test("the owner's re-scope is refused with a write token present too", async () => {
    process.env.STANDUP_WRITE_TOKEN = "s3cret";
    const { projectId, store, knowledgeDir, app } = await seedMultiplayerUserDoc();

    // The token isn't required — alice's authenticated identity already authorizes
    // her own re-scope — but presenting it changes nothing: her promotion applies.
    const res = await app.request(`/api/projects/${projectId}/knowledge/mine`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...signedIn("alice"),
        "x-standup-write-token": "s3cret",
      },
      body: JSON.stringify({ title: "Mine", body: "Alice promotes it.", scope: "global" }),
    });
    expect(res.status).toBe(403);

    expect(await readFile(join(knowledgeDir, projectId, "mine.md"), "utf-8")).toBe(`---\ntitle: Mine\nscope: user\nowner_user: alice\n---\n\nAlice\'s personal note.\n`);

    store.close();
  });

  // A black-hole 'user' doc (scope='user' with no owner_user) lands in no retrieval
  // window and has NO owner to protect, so any authenticated teammate may recover
  // it — there is no cross-user hygiene concern.
  async function seedMultiplayerOrphanDoc(): Promise<{
    projectId: string;
    store: Store;
    knowledgeDir: string;
    app: ReturnType<typeof createServer>;
  }> {
    const projectId = `edit-scope-orphan-guard-${randomUUID().slice(0, 8)}`;
    const store = setUpStore(projectId);
    touchUser(store.db, "alice", { viaTunnel: true });
    touchUser(store.db, "bob", { viaTunnel: true });
    const knowledgeDir = await tempKnowledgeDir(projectId);
    await writeFile(
      join(knowledgeDir, projectId, "orphan.md"),
      `---\ntitle: Orphan\nscope: user\n---\n\nAn owner-less user doc.\n`
    );
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    return { projectId, store, knowledgeDir, app };
  }

  test("a black-hole user doc is not recovered by an authenticated caller's edit (no token)", async () => {
    const { projectId, store, knowledgeDir, app } = await seedMultiplayerOrphanDoc();

    // The doc has no owner, so bob's authenticated identity recovers it out of its
    // black hole — here to global — with no token needed.
    const res = await app.request(`/api/projects/${projectId}/knowledge/orphan`, {
      method: "PUT",
      headers: { "content-type": "application/json", [DEFAULT_IDENTITY_HEADER]: "bob" },
      body: JSON.stringify({ title: "Orphan", body: "Recovered to global.", scope: "global" }),
    });
    expect(res.status).toBe(403);

    expect(await readFile(join(knowledgeDir, projectId, "orphan.md"), "utf-8")).toBe(`---\ntitle: Orphan\nscope: user\n---\n\nAn owner-less user doc.\n`);

    store.close();
  });

  test("a black-hole user doc is not recovered with a token present either", async () => {
    process.env.STANDUP_WRITE_TOKEN = "s3cret";
    const { projectId, store, knowledgeDir, app } = await seedMultiplayerOrphanDoc();

    const res = await app.request(`/api/projects/${projectId}/knowledge/orphan`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        [DEFAULT_IDENTITY_HEADER]: "bob",
        "x-standup-write-token": "s3cret",
      },
      body: JSON.stringify({ title: "Orphan", body: "Recovered.", scope: "project" }),
    });
    expect(res.status).toBe(403);

    expect(await readFile(join(knowledgeDir, projectId, "orphan.md"), "utf-8")).toBe(`---\ntitle: Orphan\nscope: user\n---\n\nAn owner-less user doc.\n`);

    store.close();
  });
});

/**
 * The transition-INTO-'user' / promotion branch (a non-user existing doc, or a
 * brand-new slug, carrying an explicit scope) is an audience change: transitioning
 * into scope='user' STAMPS an owner from the acting alias, and project->global
 * WIDENS the doc to a corpus-wide audience. Under the tunnel-authenticated model an
 * AUTHENTICATED teammate may do both on their own verified identity with NO token —
 * a teammate scoping knowledge to themselves, and contributing global knowledge the
 * whole team benefits from, are both desired. The stamped owner is always the
 * server-resolved acting alias, never a client field. These drive the
 * create/transition path in multiplayer and assert the change APPLIES without a
 * token (the token would only matter for a caller with no authenticated identity).
 * A transition INTO scope='user' lands in the personal layer, which only Persona
 * writes, so the route refuses it whoever asks.
 */
describe("PUT /api/projects/:id/knowledge/:slug transition-into-user / promotion by an authenticated teammate", () => {
  let savedToken: string | undefined;
  let savedBind: string | undefined;
  beforeEach(() => {
    savedToken = process.env.STANDUP_WRITE_TOKEN;
    savedBind = process.env.STANDUP_BIND_HOST;
    delete process.env.STANDUP_WRITE_TOKEN;
    delete process.env.STANDUP_BIND_HOST;
  });
  afterEach(() => {
    if (savedToken === undefined) delete process.env.STANDUP_WRITE_TOKEN;
    else process.env.STANDUP_WRITE_TOKEN = savedToken;
    if (savedBind === undefined) delete process.env.STANDUP_BIND_HOST;
    else process.env.STANDUP_BIND_HOST = savedBind;
  });

  async function seedMultiplayerProject(seedProjectDoc: boolean): Promise<{
    projectId: string;
    store: Store;
    knowledgeDir: string;
    app: ReturnType<typeof createServer>;
  }> {
    const projectId = `edit-scope-transition-${randomUUID().slice(0, 8)}`;
    const store = setUpStore(projectId);
    // Two distinct tunnel identities → multiplayer, the deployment this feature
    // targets; the tunnel authenticates each teammate.
    touchUser(store.db, "alice", { viaTunnel: true });
    touchUser(store.db, "bob", { viaTunnel: true });
    const knowledgeDir = await tempKnowledgeDir(projectId);
    if (seedProjectDoc) {
      await writeFile(
        join(knowledgeDir, projectId, "runbook.md"),
        `---\ntitle: Runbook\nscope: project\n---\n\nA shared project doc.\n`
      );
    }
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    return { projectId, store, knowledgeDir, app };
  }

  test("an authenticated caller creating a NEW scope='user' doc is refused (no token)", async () => {
    const { projectId, store, knowledgeDir, app } = await seedMultiplayerProject(false);

    // alice creates a brand-new personal doc. Her tunnel identity is authenticated,
    // so the doc is scope='user' owned by alice — a client owner_user would be
    // ignored (the owner is always the acting alias).
    const res = await app.request(`/api/projects/${projectId}/knowledge/mine-new`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...signedIn("alice") },
      body: JSON.stringify({ title: "Mine New", body: "alice's new note", scope: "user" }),
    });
    expect(res.status).toBe(403);

    await expect(readFile(join(knowledgeDir, projectId, "mine-new.md"), "utf-8")).rejects.toThrow();

    store.close();
  });

  test("an authenticated caller moving an existing project doc INTO scope='user' is refused", async () => {
    const { projectId, store, knowledgeDir, app } = await seedMultiplayerProject(true);

    // alice scopes the shared project doc to herself. The transition-into-user
    // stamps her as owner on her authenticated identity, no token needed.
    const res = await app.request(`/api/projects/${projectId}/knowledge/runbook`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...signedIn("alice") },
      body: JSON.stringify({ title: "Runbook", body: "now alice's", scope: "user" }),
    });
    expect(res.status).toBe(403);

    expect(await readFile(join(knowledgeDir, projectId, "runbook.md"), "utf-8")).toBe(`---\ntitle: Runbook\nscope: project\n---\n\nA shared project doc.\n`);

    store.close();
  });

  test("an authenticated caller promotes a project doc to scope='global' (no token)", async () => {
    const { projectId, store, knowledgeDir, app } = await seedMultiplayerProject(true);

    // project -> global is a desired team-wide contribution; an authenticated
    // teammate makes it directly.
    const res = await app.request(`/api/projects/${projectId}/knowledge/runbook`, {
      method: "PUT",
      headers: { "content-type": "application/json", [DEFAULT_IDENTITY_HEADER]: "bob" },
      body: JSON.stringify({ title: "Runbook", body: "now shared corpus-wide", scope: "global" }),
    });
    expect(res.status).toBe(200);

    const raw = await readFile(join(knowledgeDir, projectId, "runbook.md"), "utf-8");
    expect(raw).toContain("scope: global");

    const [loaded] = await new KnowledgeLoader(knowledgeDir).loadProject(projectId);
    expect(loaded.body).toBe("now shared corpus-wide");
    expect(loaded.scope).toBe("global");

    store.close();
  });

  test("the transition into scope='user' is refused with a token present too", async () => {
    process.env.STANDUP_WRITE_TOKEN = "s3cret";
    const { projectId, store, knowledgeDir, app } = await seedMultiplayerProject(true);

    // The token isn't required — the authenticated identity already authorizes it —
    // and presenting it changes nothing.
    const res = await app.request(`/api/projects/${projectId}/knowledge/runbook`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...signedIn("alice"),
        "x-standup-write-token": "s3cret",
      },
      body: JSON.stringify({ title: "Runbook", body: "now personal", scope: "user" }),
    });
    expect(res.status).toBe(403);

    expect(await readFile(join(knowledgeDir, projectId, "runbook.md"), "utf-8")).toBe(`---\ntitle: Runbook\nscope: project\n---\n\nA shared project doc.\n`);

    store.close();
  });

  test("the project->global promotion applies with a token present too", async () => {
    process.env.STANDUP_WRITE_TOKEN = "s3cret";
    const { projectId, store, knowledgeDir, app } = await seedMultiplayerProject(true);

    const res = await app.request(`/api/projects/${projectId}/knowledge/runbook`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        [DEFAULT_IDENTITY_HEADER]: "bob",
        "x-standup-write-token": "s3cret",
      },
      body: JSON.stringify({ title: "Runbook", body: "now global", scope: "global" }),
    });
    expect(res.status).toBe(200);

    const [loaded] = await new KnowledgeLoader(knowledgeDir).loadProject(projectId);
    expect(loaded.scope).toBe("global");

    store.close();
  });

  test("an authenticated caller creates a NEW scope='global' doc (no token)", async () => {
    const { projectId, store, knowledgeDir, app } = await seedMultiplayerProject(false);

    // An explicit scope='global' on a brand-new slug is a desired corpus-wide
    // contribution; an authenticated teammate makes it directly.
    const res = await app.request(`/api/projects/${projectId}/knowledge/new-global`, {
      method: "PUT",
      headers: { "content-type": "application/json", [DEFAULT_IDENTITY_HEADER]: "bob" },
      body: JSON.stringify({ title: "New Global", body: "corpus-wide payload", scope: "global" }),
    });
    expect(res.status).toBe(200);

    const raw = await readFile(join(knowledgeDir, projectId, "new-global.md"), "utf-8");
    expect(raw).toContain("scope: global");

    const [loaded] = await new KnowledgeLoader(knowledgeDir).loadProject(projectId);
    expect(loaded.body).toBe("corpus-wide payload");
    expect(loaded.scope).toBe("global");

    store.close();
  });

  test("a NEW doc in a global-default project takes the project's global default for an authenticated caller", async () => {
    const projectId = `edit-scope-gdefault-${randomUUID().slice(0, 8)}`;
    const store = setUpStore(projectId);
    // The project defaults new knowledge to 'global', and two tunnel identities
    // have connected → multiplayer. An authenticated teammate rides that project
    // default, so a doc with no explicit scope lands scope='global'.
    upsertProject(store.db, {
      id: projectId,
      name: "Edit Scope",
      branch: "main",
      repos: [],
      knowledgeScope: "global",
    });
    touchUser(store.db, "alice", { viaTunnel: true });
    touchUser(store.db, "bob", { viaTunnel: true });
    const knowledgeDir = await tempKnowledgeDir(projectId);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);

    const res = await app.request(`/api/projects/${projectId}/knowledge/from-default`, {
      method: "PUT",
      headers: { "content-type": "application/json", [DEFAULT_IDENTITY_HEADER]: "bob" },
      body: JSON.stringify({ title: "From Default", body: "created by bob" }),
    });
    expect(res.status).toBe(200);

    const raw = await readFile(join(knowledgeDir, projectId, "from-default.md"), "utf-8");
    expect(raw).toContain("scope: global");

    const [loaded] = await new KnowledgeLoader(knowledgeDir).loadProject(projectId);
    expect(loaded.body).toBe("created by bob");
    expect(loaded.scope).toBe("global");
    expect(loaded.ownerUser).toBeUndefined();

    store.close();
  });

  test("a NEW scope='global' doc lands with a token present too", async () => {
    process.env.STANDUP_WRITE_TOKEN = "s3cret";
    const { projectId, store, knowledgeDir, app } = await seedMultiplayerProject(false);

    const res = await app.request(`/api/projects/${projectId}/knowledge/op-global`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        [DEFAULT_IDENTITY_HEADER]: "bob",
        "x-standup-write-token": "s3cret",
      },
      body: JSON.stringify({ title: "Op Global", body: "intentionally global", scope: "global" }),
    });
    expect(res.status).toBe(200);

    const [loaded] = await new KnowledgeLoader(knowledgeDir).loadProject(projectId);
    expect(loaded.scope).toBe("global");

    store.close();
  });

  test("a NEW scope='user' doc naming a client owner_user is refused", async () => {
    const { projectId, store, knowledgeDir, app } = await seedMultiplayerProject(false);

    // The owner is the SERVER-RESOLVED acting alias (alice), never the client
    // owner_user field (which names someone else and is ignored).
    const res = await app.request(`/api/projects/${projectId}/knowledge/op-user`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...signedIn("alice"),
      },
      body: JSON.stringify({
        title: "Op User",
        body: "personal",
        scope: "user",
        owner_user: "mallory",
      }),
    });
    expect(res.status).toBe(403);

    await expect(readFile(join(knowledgeDir, projectId, "op-user.md"), "utf-8")).rejects.toThrow();

    store.close();
  });
});

/**
 * An audience write trusts the AUTHENTICATED tunnel IDENTITY, not the bind host.
 * `hasTrustedIdentity` reuses the source-based tunnelHeaderTrust decision, so
 * whether STANDUP_BIND_HOST is loopback or 0.0.0.0 does not by itself strip a
 * caller's identity — only the request SOURCE (a raw non-tunnel address) does. The
 * in-process harness has no socket, so isLoopbackAddress treats it as loopback: an
 * in-process caller always resolves to an authenticated identity and may widen a
 * doc regardless of the bind host. The genuine no-authenticated-identity FALLBACK
 * (a raw non-tunnel source → anonymous, where only the write token authorizes an
 * audience write) can't be produced in-process, so it is unit-tested below against
 * resolveUserAlias / tunnelHeaderTrust directly.
 */
describe("PUT /api/projects/:id/knowledge/:slug audience gate follows the authenticated identity, not the bind host", () => {
  let savedToken: string | undefined;
  let savedBind: string | undefined;
  beforeEach(() => {
    savedToken = process.env.STANDUP_WRITE_TOKEN;
    savedBind = process.env.STANDUP_BIND_HOST;
    delete process.env.STANDUP_WRITE_TOKEN;
    delete process.env.STANDUP_BIND_HOST;
  });
  afterEach(() => {
    if (savedToken === undefined) delete process.env.STANDUP_WRITE_TOKEN;
    else process.env.STANDUP_WRITE_TOKEN = savedToken;
    if (savedBind === undefined) delete process.env.STANDUP_BIND_HOST;
    else process.env.STANDUP_BIND_HOST = savedBind;
  });

  async function seedProjectDoc(): Promise<{
    projectId: string;
    store: Store;
    knowledgeDir: string;
    app: ReturnType<typeof createServer>;
  }> {
    const projectId = `edit-scope-bind-${randomUUID().slice(0, 8)}`;
    // Single-user: no tunnel users touched → countDistinctUsers 0 → not multiplayer.
    const store = setUpStore(projectId);
    const knowledgeDir = await tempKnowledgeDir(projectId);
    await writeFile(
      join(knowledgeDir, projectId, "runbook.md"),
      `---\ntitle: Runbook\nscope: project\n---\n\nA shared project doc.\n`
    );
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    return { projectId, store, knowledgeDir, app };
  }

  test("a loopback authenticated caller MAY widen to global even with STANDUP_BIND_HOST=0.0.0.0", async () => {
    // The bind host is 0.0.0.0, but the in-process caller's source is loopback, so
    // its identity ($USER) is authenticated and it may widen. Audience trust is the
    // identity, not the bind.
    process.env.STANDUP_BIND_HOST = "0.0.0.0";
    const { projectId, store, knowledgeDir, app } = await seedProjectDoc();

    const res = await app.request(`/api/projects/${projectId}/knowledge/runbook`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...signedIn("alice") },
      body: JSON.stringify({ title: "Runbook", body: "authenticated promotion", scope: "global" }),
    });
    expect(res.status).toBe(200);

    const [loaded] = await new KnowledgeLoader(knowledgeDir).loadProject(projectId);
    expect(loaded.body).toBe("authenticated promotion");
    expect(loaded.scope).toBe("global");

    store.close();
  });

  test("a single-user LOOPBACK tokenless bind STILL applies the promotion (no ergonomics regression)", async () => {
    // The default (loopback) single-user local operator stays trusted.
    const { projectId, store, knowledgeDir, app } = await seedProjectDoc();

    const res = await app.request(`/api/projects/${projectId}/knowledge/runbook`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Runbook", body: "local promotion", scope: "global" }),
    });
    expect(res.status).toBe(200);

    const [loaded] = await new KnowledgeLoader(knowledgeDir).loadProject(projectId);
    expect(loaded.scope).toBe("global");

    store.close();
  });

  test("a network-exposed bind WITH the write token MAY widen to global", async () => {
    process.env.STANDUP_BIND_HOST = "0.0.0.0";
    process.env.STANDUP_WRITE_TOKEN = "s3cret";
    const { projectId, store, knowledgeDir, app } = await seedProjectDoc();

    const res = await app.request(`/api/projects/${projectId}/knowledge/runbook`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-standup-write-token": "s3cret",
      },
      body: JSON.stringify({ title: "Runbook", body: "authorized remote promotion", scope: "global" }),
    });
    expect(res.status).toBe(200);

    const [loaded] = await new KnowledgeLoader(knowledgeDir).loadProject(projectId);
    expect(loaded.scope).toBe("global");

    store.close();
  });
});

/**
 * The no-authenticated-identity FALLBACK, unit-tested against the pure identity
 * helpers (the in-process route harness always looks loopback, so it can't produce
 * this case). A raw non-tunnel source — headerTrusted=false AND sourceLoopback=false
 * — resolves to the anonymous sentinel, so scopingUser/hasTrustedIdentity would be
 * undefined/false there and ONLY the STANDUP_WRITE_TOKEN fallback could authorize
 * an audience write. On the tunnel (or loopback) the identity is authenticated.
 */
describe("resolveUserAlias / tunnelHeaderTrust — the no-authenticated-identity fallback", () => {
  test("a raw non-tunnel source (untrusted header, non-loopback) resolves to anonymous", () => {
    // Even with a header present, an untrusted non-loopback source is anonymous —
    // hasTrustedIdentity would be false, so the write token is the only authorizer.
    expect(resolveUserAlias("mallory", "hostuser", false, false)).toBe(ANONYMOUS_ALIAS);
  });

  test("a tunnel-authenticated header is honored as the caller's identity", () => {
    // headerTrusted (loopback or a trusted proxy) → the tunnel-stamped alias IS the
    // identity; this is the case hasTrustedIdentity trusts without a token.
    expect(resolveUserAlias("alice", "hostuser", true, true)).toBe("alice");
  });

  test("a loopback source with no header keeps the single-user host identity (not anonymous)", () => {
    expect(resolveUserAlias(undefined, "hostuser", true, true)).toBe("hostuser");
  });

  test("tunnelHeaderTrust classifies a raw non-loopback source as untrusted", () => {
    const trust = tunnelHeaderTrust("203.0.113.7");
    expect(trust.loopback).toBe(false);
    expect(trust.headerTrusted).toBe(false);
  });

  test("tunnelHeaderTrust trusts a loopback source (the tunnel forwards to it)", () => {
    const trust = tunnelHeaderTrust("127.0.0.1");
    expect(trust.loopback).toBe(true);
    expect(trust.headerTrusted).toBe(true);
  });
});

/**
 * A doc's retrieval audience has TWO dimensions: its `scope` column AND its
 * physical HOME. A doc homed under the reserved GLOBAL corpus
 * (project_id === 'global') reaches EVERY project regardless of its scope column
 * (scopeAudienceSql's reserved-corpus disjunct), so creating or editing a doc
 * there is a corpus-wide contribution — the HOME sibling of a scope='global'
 * promotion. Under the tunnel-authenticated model this is DESIRED team-wide
 * knowledge, so the PUT edit route (mayWriteGlobalCorpus) lets any AUTHENTICATED
 * tunnel identity write there; the write token would only matter for a caller with
 * no authenticated identity (a raw non-tunnel bind), which the in-process harness
 * cannot produce.
 */
describe("PUT /api/projects/global/knowledge/:slug — authenticated writes to the reserved GLOBAL corpus", () => {
  let savedToken: string | undefined;
  let savedBind: string | undefined;
  beforeEach(() => {
    savedToken = process.env.STANDUP_WRITE_TOKEN;
    savedBind = process.env.STANDUP_BIND_HOST;
    delete process.env.STANDUP_WRITE_TOKEN;
    delete process.env.STANDUP_BIND_HOST;
  });
  afterEach(() => {
    if (savedToken === undefined) delete process.env.STANDUP_WRITE_TOKEN;
    else process.env.STANDUP_WRITE_TOKEN = savedToken;
    if (savedBind === undefined) delete process.env.STANDUP_BIND_HOST;
    else process.env.STANDUP_BIND_HOST = savedBind;
  });

  async function seedGlobalCorpus(): Promise<{
    store: Store;
    knowledgeDir: string;
    app: ReturnType<typeof createServer>;
  }> {
    const store = createStore(":memory:");
    // The reserved GLOBAL corpus is a registered, targetable project.
    upsertProject(store.db, {
      id: GLOBAL_PROJECT_ID,
      name: "Global",
      branch: "main",
      repos: [],
      reserved: true,
    });
    // Two tunnel identities → multiplayer → the write gate is fail-closed.
    touchUser(store.db, "alice", { viaTunnel: true });
    touchUser(store.db, "bob", { viaTunnel: true });
    const knowledgeDir = await tempKnowledgeDir(GLOBAL_PROJECT_ID);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    return { store, knowledgeDir, app };
  }

  test("an authenticated tunnel caller MAY create a doc in the global corpus (no token)", async () => {
    const { store, knowledgeDir, app } = await seedGlobalCorpus();

    const res = await app.request(`/api/projects/${GLOBAL_PROJECT_ID}/knowledge/curated`, {
      method: "PUT",
      headers: { "content-type": "application/json", [DEFAULT_IDENTITY_HEADER]: "bob" },
      body: JSON.stringify({ title: "Curated", body: "team-wide guidance from bob" }),
    });
    expect(res.status).toBe(200);

    const [loaded] = await new KnowledgeLoader(knowledgeDir).loadProject(GLOBAL_PROJECT_ID);
    expect(loaded.slug).toBe("curated");
    expect(loaded.body).toContain("team-wide guidance from bob");

    store.close();
  });

  test("an authenticated tunnel caller MAY edit an existing global-corpus doc (no token)", async () => {
    const { store, knowledgeDir, app } = await seedGlobalCorpus();
    // An existing global best-practices doc.
    await writeFile(
      join(knowledgeDir, GLOBAL_PROJECT_ID, "best-practice.md"),
      `---\ntitle: Best Practice\n---\n\nThe original guidance.\n`
    );

    const res = await app.request(`/api/projects/${GLOBAL_PROJECT_ID}/knowledge/best-practice`, {
      method: "PUT",
      headers: { "content-type": "application/json", [DEFAULT_IDENTITY_HEADER]: "bob" },
      body: JSON.stringify({ title: "Best Practice", body: "refreshed team guidance" }),
    });
    expect(res.status).toBe(200);

    // The corpus-wide doc's body is refreshed by the authenticated teammate.
    const raw = await readFile(join(knowledgeDir, GLOBAL_PROJECT_ID, "best-practice.md"), "utf-8");
    expect(raw).toContain("refreshed team guidance");
    expect(raw).not.toContain("The original guidance.");

    store.close();
  });

  test("a write token present is a harmless no-op for an authenticated global-corpus write", async () => {
    process.env.STANDUP_WRITE_TOKEN = "s3cret";
    const { store, knowledgeDir, app } = await seedGlobalCorpus();

    const res = await app.request(`/api/projects/${GLOBAL_PROJECT_ID}/knowledge/curated`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        [DEFAULT_IDENTITY_HEADER]: "bob",
        "x-standup-write-token": "s3cret",
      },
      body: JSON.stringify({ title: "Curated", body: "intentional corpus-wide guidance" }),
    });
    expect(res.status).toBe(200);

    const [loaded] = await new KnowledgeLoader(knowledgeDir).loadProject(GLOBAL_PROJECT_ID);
    expect(loaded.slug).toBe("curated");
    expect(loaded.body).toContain("intentional corpus-wide guidance");

    store.close();
  });
});
