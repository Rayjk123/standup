import { expect, test, describe, afterAll, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { createStore, upsertProject, touchUser } from "@standup/store";
import type { Store } from "@standup/store";
import { writeKnowledgeFile, readKnowledgeFile } from "@standup/knowledge";
import { DEFAULT_IDENTITY_HEADER, GLOBAL_PROJECT_ID } from "@standup/shared";
import { createServer } from "./server.js";
import { KnowledgeSync } from "./knowledge-sync.js";

/**
 * POST /api/knowledge/ingest-url is the automatic product-knowledge ingestion
 * path (roadmap r8 / named gap #3): it fetches an external URL, reduces it to
 * text, and lands a PRODUCT/SPEC draft through the KnowledgeBackend seam WITHOUT
 * requiring a running launch — the half the earlier r8 rounds left deferred. A
 * human still accepts the draft before it is searchable/injectable; these tests
 * drive the route with a stubbed fetch to confirm a real product source lands
 * with the right classification and provenance, and that the failure paths are
 * rejected rather than silently landing junk.
 */

const realFetch = globalThis.fetch;
const cleanupDirs: string[] = [];

afterEach(() => {
  globalThis.fetch = realFetch;
});
afterAll(async () => {
  for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
});

async function setUp(): Promise<{ store: Store; knowledgeDir: string; projectId: string }> {
  const projectId = `ingest-test-${randomUUID().slice(0, 8)}`;
  const store = createStore(":memory:");
  upsertProject(store.db, { id: projectId, name: "Ingest Test", branch: "main", repos: [] });
  const knowledgeDir = await mkdtemp(join(tmpdir(), "standup-knowledge-ingest-"));
  cleanupDirs.push(knowledgeDir);
  return { store, knowledgeDir, projectId };
}

function stubFetch(body: string, init: { status?: number; contentType?: string } = {}): void {
  globalThis.fetch = (async () =>
    new Response(body, {
      status: init.status ?? 200,
      headers: { "content-type": init.contentType ?? "text/html" },
    })) as unknown as typeof fetch;
}

function serverFor(store: Store, knowledgeDir: string) {
  const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
  return createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
}

describe("POST /api/knowledge/ingest-url", () => {
  test("fetches HTML and lands a product draft with owner trust + source provenance", async () => {
    const { store, knowledgeDir, projectId } = await setUp();
    stubFetch(
      "<html><head><title>Guest Checkout Spec</title></head><body><h1>Guest Checkout</h1><p>Allow purchase without an account.</p></body></html>"
    );
    const app = serverFor(store, knowledgeDir);

    const res = await app.request("/api/knowledge/ingest-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId, url: "https://docs.test/guest-checkout" }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; slug: string; sourceKind: string };
    expect(json.ok).toBe(true);
    expect(json.sourceKind).toBe("product");

    const draftPath = join(knowledgeDir, projectId, ".drafts", `${json.slug}.md`);
    expect(existsSync(draftPath)).toBe(true);
    const contents = await readFile(draftPath, "utf-8");
    expect(contents).toContain("source_kind: product");
    expect(contents).toContain("origin_class: owner");
    expect(contents).toContain("Allow purchase without an account.");
    expect(contents).toContain("> Ingested from https://docs.test/guest-checkout");
    // Extraction dropped the non-prose <title> markup, not the heading text.
    expect(contents).toContain("Guest Checkout");

    store.close();
  });

  test("honors source_kind=spec and an explicit slug", async () => {
    const { store, knowledgeDir, projectId } = await setUp();
    stubFetch("plain requirements text", { contentType: "text/plain" });
    const app = serverFor(store, knowledgeDir);

    const res = await app.request("/api/knowledge/ingest-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: projectId,
        url: "https://x.test/whatever",
        slug: "requirements-doc",
        source_kind: "spec",
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { slug: string; sourceKind: string };
    expect(json.slug).toBe("requirements-doc");
    expect(json.sourceKind).toBe("spec");
    const contents = await readFile(
      join(knowledgeDir, projectId, ".drafts", "requirements-doc.md"),
      "utf-8"
    );
    expect(contents).toContain("source_kind: spec");
    expect(contents).toContain("plain requirements text");

    store.close();
  });

  test("rejects an unknown project", async () => {
    const { store, knowledgeDir } = await setUp();
    stubFetch("<p>x</p>");
    const app = serverFor(store, knowledgeDir);
    const res = await app.request("/api/knowledge/ingest-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: "nope", url: "https://x.test/a" }),
    });
    expect(res.status).toBe(400);
    store.close();
  });

  test("rejects a non-http URL without fetching", async () => {
    const { store, knowledgeDir, projectId } = await setUp();
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response("");
    }) as unknown as typeof fetch;
    const app = serverFor(store, knowledgeDir);
    const res = await app.request("/api/knowledge/ingest-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId, url: "file:///etc/passwd" }),
    });
    expect(res.status).toBe(400);
    expect(fetched).toBe(false);
    store.close();
  });

  test("returns 502 when the source responds non-OK", async () => {
    const { store, knowledgeDir, projectId } = await setUp();
    stubFetch("nope", { status: 404 });
    const app = serverFor(store, knowledgeDir);
    const res = await app.request("/api/knowledge/ingest-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId, url: "https://x.test/missing" }),
    });
    expect(res.status).toBe(502);
    store.close();
  });

  test("returns 422 when no readable text can be extracted", async () => {
    const { store, knowledgeDir, projectId } = await setUp();
    stubFetch("<html><head><style>.a{}</style></head><body><script>x()</script></body></html>");
    const app = serverFor(store, knowledgeDir);
    const res = await app.request("/api/knowledge/ingest-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId, url: "https://x.test/empty" }),
    });
    expect(res.status).toBe(422);
    store.close();
  });

  // A re-ingest of a URL whose slug already names an accepted doc is a REPLACE. A
  // scope='user' doc is in the personal layer, which only Persona writes, so the
  // ingest is refused before any draft is written and the doc keeps its body and
  // audience.
  test("an ingest-url onto a scope='user' doc's slug is refused and leaves the doc as it was", async () => {
    const { store, knowledgeDir, projectId } = await setUp();
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);

    // Alice's accepted private doc at the slug the ingest below will resolve to.
    await writeKnowledgeFile(knowledgeDir, projectId, {
      slug: "guest-checkout",
      title: "Guest Checkout",
      body: "alice's private notes on guest checkout",
      scope: "user",
      ownerUser: "alice",
    });
    await knowledgeSync.syncProject(projectId);

    stubFetch(
      "<html><head><title>Guest Checkout</title></head><body><p>Refreshed external guidance.</p></body></html>"
    );
    const ingest = await app.request("/api/knowledge/ingest-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: projectId,
        url: "https://docs.test/guest-checkout",
        slug: "guest-checkout",
      }),
    });
    expect(ingest.status).toBe(400);
    expect(knowledgeSync.getDrafts(projectId)).toEqual([]);

    const doc = await readKnowledgeFile(knowledgeDir, projectId, "guest-checkout");
    expect(doc?.body).toBe("alice's private notes on guest checkout");
    expect(doc?.scope).toBe("user");
    expect(doc?.ownerUser).toBe("alice");

    store.close();
  });

  // Ingesting into the reserved GLOBAL corpus homes a doc that reaches EVERY
  // project. Under the tunnel-authenticated model this is a desired team-wide
  // contribution, so an AUTHENTICATED tunnel caller may ingest there (the draft
  // still awaits a human accept before it is searchable). The write token would
  // only matter for a caller with no authenticated identity (a raw non-tunnel
  // bind), which the in-process harness cannot produce.
  test("an authenticated caller may ingest into the reserved GLOBAL corpus (no token)", async () => {
    const savedToken = process.env.STANDUP_WRITE_TOKEN;
    const savedBind = process.env.STANDUP_BIND_HOST;
    delete process.env.STANDUP_WRITE_TOKEN;
    delete process.env.STANDUP_BIND_HOST;
    try {
      const store = createStore(":memory:");
      upsertProject(store.db, {
        id: GLOBAL_PROJECT_ID,
        name: "Global",
        branch: "main",
        repos: [],
        reserved: true,
      });
      // Two tunnel identities → multiplayer; each is authenticated by the tunnel.
      touchUser(store.db, "alice", { viaTunnel: true });
      touchUser(store.db, "bob", { viaTunnel: true });
      const knowledgeDir = await mkdtemp(join(tmpdir(), "standup-knowledge-ingest-"));
      cleanupDirs.push(knowledgeDir);
      const app = serverFor(store, knowledgeDir);

      stubFetch("<html><body><p>corpus-wide payload</p></body></html>");
      const res = await app.request("/api/knowledge/ingest-url", {
        method: "POST",
        headers: { "Content-Type": "application/json", [DEFAULT_IDENTITY_HEADER]: "bob" },
        body: JSON.stringify({
          project_id: GLOBAL_PROJECT_ID,
          url: "https://docs.test/anything",
          slug: "team-doc",
        }),
      });
      expect(res.status).toBe(200);

      // The draft landed in the reserved corpus, awaiting a human accept.
      const draftPath = join(knowledgeDir, GLOBAL_PROJECT_ID, ".drafts", "team-doc.md");
      expect(existsSync(draftPath)).toBe(true);

      store.close();
    } finally {
      if (savedToken === undefined) delete process.env.STANDUP_WRITE_TOKEN;
      else process.env.STANDUP_WRITE_TOKEN = savedToken;
      if (savedBind === undefined) delete process.env.STANDUP_BIND_HOST;
      else process.env.STANDUP_BIND_HOST = savedBind;
    }
  });
});
