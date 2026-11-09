import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { KnowledgeStore, type KnowledgeDoc } from "@standup/knowledge";
import { DEFAULT_IDENTITY_HEADER, GLOBAL_PROJECT_ID } from "@standup/shared";
import { OWNER_TOKEN_HEADER } from "@standup/shared/owner-token";
import { createStore, getProject, listPublicKbCalls, upsertProject, type Store } from "@standup/store";
import { createServer, resolveUserAlias } from "../server.js";
import { generateOwnerSecrets } from "../owner-secret.js";
import { writeAccess } from "./access.js";
import { PUBLIC_KB_IDENTITY_HEADER_ENV } from "./identity.js";
import {
  createPublicKnowledgeApp,
  PUBLIC_ASK_GONE,
  PUBLIC_KB_NOT_CONFIGURED,
  PUBLIC_KNOWLEDGE_BASE,
  type PublicKnowledgeDeps,
} from "./app.js";
import type { PublicKnowledgeListenerStatus } from "./listener.js";
import { REFUSED_LOGGED_PER_ALIAS, SUCCESS_LOGGED_PER_ALIAS, WHOAMI_LOGGED_PER_ALIAS } from "./log-throttle.js";

/**
 * The header the relay in front of the socket stamps in these tests. Every
 * public app below is made while STANDUP_PUBLIC_KB_IDENTITY_HEADER names it.
 */
const RELAY_HEADER = "x-relay-user";
const savedRelayHeader = process.env[PUBLIC_KB_IDENTITY_HEADER_ENV];
process.env[PUBLIC_KB_IDENTITY_HEADER_ENV] = RELAY_HEADER;
afterAll(() => {
  if (savedRelayHeader === undefined) delete process.env[PUBLIC_KB_IDENTITY_HEADER_ENV];
  else process.env[PUBLIC_KB_IDENTITY_HEADER_ENV] = savedRelayHeader;
});

const secrets = generateOwnerSecrets();
const OWNER = resolveUserAlias(undefined);
const TERM = "zebracanary";
const AT = new Date("2026-09-01T00:00:00Z");

/** Docs every public surface must serve. */
const SHAREABLE = [
  { projectId: GLOBAL_PROJECT_ID, slug: "shared-runbook", scope: "global" as const },
  { projectId: "alpha", slug: "alpha-guide", scope: "project" as const },
  { projectId: "alpha", slug: "alpha-promoted", scope: "global" as const },
];

/** Docs no public surface may serve, each with the rule that withholds it. */
const EXCLUDED: Array<{ projectId: string; slug: string; extra: Partial<KnowledgeDoc>; why: string }> = [
  { projectId: "secret", slug: "secret-plan", extra: { scope: "project" }, why: "unshareable project" },
  { projectId: "secret", slug: "secret-promoted", extra: { scope: "global" }, why: "global doc homed in an unshareable project" },
  { projectId: GLOBAL_PROJECT_ID, slug: "personal-note", extra: { scope: "user", ownerUser: "owner" }, why: "scope=user" },
  { projectId: GLOBAL_PROJECT_ID, slug: "persona-owner-tunnel-prefs", extra: { scope: "user", ownerUser: "owner" }, why: "persona memory" },
  { projectId: GLOBAL_PROJECT_ID, slug: "persona-owner-legacy", extra: { scope: "project" }, why: "persona slug without a user scope" },
  { projectId: GLOBAL_PROJECT_ID, slug: "native-mem-home-claude-md", extra: { scope: "global", sourceKind: "native-memory" }, why: "home mirror" },
  { projectId: "alpha", slug: "native-mem-repo-claude-md", extra: { scope: "project", sourceKind: "native-memory" }, why: "repo mirror" },
  { projectId: "alpha", slug: "native-mem-memory-diary", extra: { scope: "project", sourceKind: "native-memory" }, why: "activity note" },
];

const EXCLUDED_BODY = "PRIVATE-DO-NOT-SHARE";

function seed(): Store {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "alpha", name: "Alpha", branch: "main", repos: [] });
  upsertProject(store.db, { id: "secret", name: "Secret", branch: "main", repos: [], shareable: false });
  upsertProject(store.db, { id: GLOBAL_PROJECT_ID, name: "Global", branch: "main", repos: [], reserved: true });
  const ks = new KnowledgeStore(store.db);
  const put = (projectId: string, slug: string, body: string, extra: Partial<KnowledgeDoc> = {}) =>
    ks.upsertDoc({
      id: `${projectId}-${slug}`,
      projectId,
      slug,
      title: slug,
      body,
      updatedAt: AT,
      filePath: `/x/${projectId}/${slug}.md`,
      originClass: "owner",
      sourceKind: "runbook",
      scope: "project",
      ...extra,
    });
  for (const d of SHAREABLE) put(d.projectId, d.slug, `${d.slug}: the ${TERM} widget rollout checklist`, { scope: d.scope });
  for (const d of EXCLUDED) put(d.projectId, d.slug, `${EXCLUDED_BODY} ${d.slug}: the ${TERM} widget rollout checklist`, d.extra);
  // Distractors give the query terms enough IDF to clear the relevance floor.
  for (let i = 0; i < 80; i++) put("alpha", `filler-${i}`, `billing onboarding laptop editor topic number ${i}`);
  writeAccess(store.db, { aliases: ["alice"], posixGroups: ["kb-readers"] });
  return store;
}

const groupsOf = async (alias: string) => (alias === "carol" ? ["kb-readers"] : []);

function serve(
  store: Store,
  overrides: Partial<Pick<PublicKnowledgeDeps, "now">> & {
    listenerStatus?: () => PublicKnowledgeListenerStatus;
  } = {}
) {
  return createServer(
    store, () => {}, null, undefined, undefined, "", "", {}, undefined, undefined, undefined, undefined,
    { ownerSecrets: secrets }, {}, {}, {}, {},
    { groupsOf, ...overrides }
  );
}

const as = (alias: string | null, extra: Record<string, string> = {}): Record<string, string> => ({
  ...(alias !== null ? { [RELAY_HEADER]: alias } : {}),
  ...extra,
});

/** Headers naming `alias` to the main app, through the console's identity header. */
const asConsole = (alias: string, extra: Record<string, string> = {}): Record<string, string> => ({
  [DEFAULT_IDENTITY_HEADER]: alias,
  ...extra,
});

const excludedSlugs = EXCLUDED.map((d) => d.slug);

describe("scope: the public API serves only shareable knowledge", () => {
  const store = seed();
  const { publicKnowledgeApp: pub } = serve(store);

  test("search returns the shareable docs and none of the excluded ones", async () => {
    const res = await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/search?q=${TERM}+widget&limit=50`, { headers: as("alice") });
    expect(res.status).toBe(200);
    const { hits } = (await res.json()) as { hits: Array<{ slug: string; project: string; title: string; excerpt: string; score: number }> };
    const slugs = hits.map((h) => h.slug);
    expect(slugs).toEqual(expect.arrayContaining(SHAREABLE.map((d) => d.slug)));
    for (const slug of excludedSlugs) expect(slugs).not.toContain(slug);
    expect(JSON.stringify(hits)).not.toContain(EXCLUDED_BODY);
  });

  test("search within a project stays in that project", async () => {
    const res = await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/search?q=${TERM}&project=alpha`, { headers: as("alice") });
    const { hits } = (await res.json()) as { hits: Array<{ slug: string; project: string }> };
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.project === "alpha")).toBe(true);
    for (const slug of excludedSlugs) expect(hits.map((h) => h.slug)).not.toContain(slug);
  });

  test("search of an unshareable or unknown project is 404; a missing q is 400", async () => {
    expect((await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/search?q=${TERM}&project=secret`, { headers: as("alice") })).status).toBe(404);
    expect((await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/search?q=${TERM}&project=nope`, { headers: as("alice") })).status).toBe(404);
    expect((await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/search`, { headers: as("alice") })).status).toBe(400);
    expect((await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/search?q=%20`, { headers: as("alice") })).status).toBe(400);
  });

  test("search honors limit, capped at 50", async () => {
    const res = await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/search?q=${TERM}&limit=1`, { headers: as("alice") });
    expect(((await res.json()) as { hits: unknown[] }).hits.length).toBe(1);
  });

  test("projects lists the shareable projects with their shareable doc counts", async () => {
    const res = await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/projects`, { headers: as("alice") });
    const { projects } = (await res.json()) as { projects: Array<{ id: string; name: string; docCount: number }> };
    const ids = projects.map((p) => p.id);
    expect(ids).toContain("alpha");
    expect(ids).toContain(GLOBAL_PROJECT_ID);
    expect(ids).not.toContain("secret");
    expect(projects.find((p) => p.id === "alpha")!.docCount).toBe(2 + 80);
    expect(projects.find((p) => p.id === GLOBAL_PROJECT_ID)!.docCount).toBe(1);
  });

  test("a project's doc list omits its excluded docs; an unshareable project is 404", async () => {
    const res = await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/projects/alpha/docs`, { headers: as("alice") });
    expect(res.status).toBe(200);
    const { docs } = (await res.json()) as { docs: Array<{ slug: string; title: string; kind: string; updatedAt: string }> };
    const slugs = docs.map((d) => d.slug);
    expect(slugs).toContain("alpha-guide");
    for (const slug of excludedSlugs) expect(slugs).not.toContain(slug);
    expect(docs[0]).toMatchObject({ kind: "runbook", updatedAt: AT.toISOString() });
    expect((await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/projects/secret/docs`, { headers: as("alice") })).status).toBe(404);
    expect((await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/projects/nope/docs`, { headers: as("alice") })).status).toBe(404);
  });

  test("a shareable doc is served whole", async () => {
    const res = await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/docs/${GLOBAL_PROJECT_ID}/shared-runbook`, { headers: as("alice") });
    expect(res.status).toBe(200);
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc).toMatchObject({ slug: "shared-runbook", project: GLOBAL_PROJECT_ID, title: "shared-runbook", kind: "runbook", scope: "global" });
    expect(String(doc.body)).toContain(TERM);
    expect(doc.filePath).toBeUndefined();
  });

  for (const d of EXCLUDED) {
    test(`an excluded doc by its exact slug is 404, like a missing one (${d.why})`, async () => {
      const res = await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/docs/${d.projectId}/${d.slug}`, { headers: as("alice") });
      expect(res.status).toBe(404);
      const missing = await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/docs/${d.projectId}/no-such-doc`, { headers: as("alice") });
      expect(await res.json()).toEqual(await missing.json());
    });
  }

});

describe("ask: the question-answering route is gone", () => {
  const store = seed();
  const { publicKnowledgeApp: pub } = serve(store);
  const ask = (headers: Record<string, string>, body: string) => pub.request(`${PUBLIC_KNOWLEDGE_BASE}/ask`, { method: "POST", headers, body });

  test("an allowlisted caller gets 410 pointing at /search, whatever the body", async () => {
    for (const body of [JSON.stringify({ question: `${TERM} widget rollout checklist` }), JSON.stringify({ question: TERM, project: "secret" }), "{}", "not json"]) {
      const res = await ask({ ...as("alice"), "content-type": "application/json" }, body);
      expect(res.status).toBe(410);
      const answer = (await res.json()) as typeof PUBLIC_ASK_GONE;
      expect(answer).toEqual(PUBLIC_ASK_GONE);
      expect(answer.search).toBe(`${PUBLIC_KNOWLEDGE_BASE}/search`);
      expect(JSON.stringify(answer)).not.toContain(EXCLUDED_BODY);
    }
  });

  test("the identity check still runs first, and the call is logged", async () => {
    expect((await ask(as(null), "{}")).status).toBe(401);
    expect((await ask(as("bob"), "{}")).status).toBe(403);
    await ask(as("alice"), "{}");
    expect(listPublicKbCalls(store.db, 1)[0]).toMatchObject({ alias: "alice", status: 410, endpoint: `POST ${PUBLIC_KNOWLEDGE_BASE}/ask` });
  });

  test("the search it points at answers the same question from shareable docs only", async () => {
    const res = await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/search?q=${encodeURIComponent(`${TERM} widget rollout checklist`)}`, { headers: as("alice") });
    expect(res.status).toBe(200);
    const { hits } = (await res.json()) as { hits: Array<{ slug: string }> };
    expect(hits.map((h) => h.slug)).toEqual(expect.arrayContaining(SHAREABLE.map((d) => d.slug)));
    for (const slug of excludedSlugs) expect(hits.map((h) => h.slug)).not.toContain(slug);
  });
});

describe("auth: only an allowlisted alias the relay stamped gets in", () => {
  const store = seed();
  const { publicKnowledgeApp: pub } = serve(store);
  const whoami = (headers: Record<string, string>) => pub.request(`${PUBLIC_KNOWLEDGE_BASE}/whoami`, { headers });

  test("no header, an empty header or a malformed alias is 401", async () => {
    for (const headers of [as(null), as(""), as("   "), as("bob smith"), as("../etc"), as("a".repeat(65))]) {
      const res = await whoami(headers);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthenticated" });
    }
  });

  test("an alias off the allowlist is 403", async () => {
    const res = await whoami(as("bob"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  test("an allowlisted alias is 200, trimmed", async () => {
    const res = await whoami(as("  alice "));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ alias: "alice" });
  });

  test("a member of an allowlisted POSIX group is 200", async () => {
    const res = await whoami(as("carol"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ alias: "carol" });
  });

  test("the owner token and Standup's own identity headers grant nothing", async () => {
    const owner = { [OWNER_TOKEN_HEADER]: secrets.ownerToken, "x-standup-persona-user": "alice", cookie: "standup_user=alice" };
    expect((await whoami(as("bob", owner))).status).toBe(403);
    expect((await whoami(as(null, owner))).status).toBe(401);
  });

  test("only the configured relay header names the caller: the console's identity header and other relays' are unread", async () => {
    for (const header of [DEFAULT_IDENTITY_HEADER, "x-tunnel-user", "x-forwarded-user", "x-remote-user", "x-standup-user"]) {
      const res = await whoami({ [header]: "alice" });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthenticated" });
    }
    expect((await whoami({ [RELAY_HEADER.toUpperCase()]: "alice" })).status).toBe(200);
  });

  test("with no relay header configured, every request is refused, whatever it carries", async () => {
    const unconfigured = createPublicKnowledgeApp({ db: store.db, knowledgeStore: new KnowledgeStore(store.db), groupsOf, identityHeader: null });
    for (const headers of [as("alice"), { [DEFAULT_IDENTITY_HEADER]: "alice" }, {}]) {
      for (const path of ["whoami", "projects", `search?q=${TERM}`]) {
        const res = await unconfigured.request(`${PUBLIC_KNOWLEDGE_BASE}/${path}`, { headers });
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual(PUBLIC_KB_NOT_CONFIGURED);
      }
    }
  });

  test("an unset or malformed STANDUP_PUBLIC_KB_IDENTITY_HEADER configures no header", async () => {
    for (const value of [undefined, "", "x relay user"]) {
      if (value === undefined) delete process.env[PUBLIC_KB_IDENTITY_HEADER_ENV];
      else process.env[PUBLIC_KB_IDENTITY_HEADER_ENV] = value;
      try {
        const app = createPublicKnowledgeApp({ db: store.db, knowledgeStore: new KnowledgeStore(store.db), groupsOf });
        expect((await app.request(`${PUBLIC_KNOWLEDGE_BASE}/whoami`, { headers: as("alice") })).status).toBe(503);
      } finally {
        process.env[PUBLIC_KB_IDENTITY_HEADER_ENV] = RELAY_HEADER;
      }
    }
  });

  test("the default allowlist is the host user alone", async () => {
    const fresh = createStore(":memory:");
    const { publicKnowledgeApp } = serve(fresh);
    expect((await publicKnowledgeApp.request(`${PUBLIC_KNOWLEDGE_BASE}/whoami`, { headers: as(OWNER) })).status).toBe(200);
    expect((await publicKnowledgeApp.request(`${PUBLIC_KNOWLEDGE_BASE}/whoami`, { headers: as("alice") })).status).toBe(403);
  });
});

describe("route leakage: the public app serves nothing else", () => {
  const store = seed();
  const app = serve(store);
  const pub = app.publicKnowledgeApp;

  for (const path of [
    "/api/projects",
    "/api/settings",
    "/api/persona/state",
    "/api/knowledge/search",
    "/api/public-knowledge/access",
    "/health",
    "/",
    `${PUBLIC_KNOWLEDGE_BASE}/../../settings`,
    `${PUBLIC_KNOWLEDGE_BASE}/%2e%2e/%2e%2e/%2e%2e/settings`,
    `${PUBLIC_KNOWLEDGE_BASE}/..%2f..%2f..%2fsettings`,
    "/api/public/knowledge/v2/search?q=x",
    `${PUBLIC_KNOWLEDGE_BASE}/docs/alpha/..%2f..%2fsecret%2fsecret-plan`,
  ]) {
    test(`${path} is 404`, async () => {
      for (const method of ["GET", "POST", "PUT"]) {
        const res = await pub.fetch(new Request(`http://localhost${path}`, { method, headers: as("alice") }));
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: "not found" });
      }
    });
  }

  test("a doubled leading slash reaches nothing", async () => {
    const res = await pub.fetch(new Request("http://localhost//api/settings", { headers: as("alice") }));
    expect(res.status).toBe(404);
  });

  test("the main app does not serve the public routes", async () => {
    const res = await app.request(`${PUBLIC_KNOWLEDGE_BASE}/whoami`, { headers: as("alice", asConsole("alice")) });
    expect(res.status).not.toBe(200);
    expect(await res.text()).not.toContain('"alias":"alice"');
  });
});

describe("the call log", () => {
  test("every call is logged, refused ones included, with the query cut to 200 characters", async () => {
    const store = seed();
    const { publicKnowledgeApp: pub } = serve(store);
    const long = `${TERM}${"x".repeat(300)}`;
    await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/search?q=${long}`, { headers: as("alice") });
    await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/whoami`, { headers: as(null) });
    await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/whoami`, { headers: as("bob") });
    await pub.request("/api/settings", { headers: as("alice") });
    await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/docs/secret/secret-plan`, { headers: as("alice") });
    const calls = listPublicKbCalls(store.db, 10);
    expect(calls.map((c) => c.status)).toEqual([404, 404, 403, 401, 200]);
    expect(calls[4]).toMatchObject({ alias: "alice", endpoint: `GET ${PUBLIC_KNOWLEDGE_BASE}/search` });
    expect(calls[4]!.query!.length).toBe(200);
    expect(calls[3]!.alias).toBeNull();
    expect(calls[2]!.alias).toBe("bob");
    expect(calls[0]!.query).toBe("secret/secret-plan");
  });
});

describe("owner routes on the main app", () => {
  const store = seed();
  const app = serve(store);
  const owner = { [OWNER_TOKEN_HEADER]: secrets.ownerToken, "content-type": "application/json" };

  test("a teammate, with or without the owner token, is refused every owner route", async () => {
    for (const headers of [asConsole("bob"), asConsole("bob", owner), as("bob"), as(null)]) {
      expect((await app.request("/api/public-knowledge/access", { headers })).status).toBe(403);
      expect((await app.request("/api/public-knowledge/usage", { headers })).status).toBe(403);
      const put = await app.request("/api/public-knowledge/access", {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ aliases: ["bob"], posixGroups: [] }),
      });
      expect(put.status).toBe(403);
    }
    // The refused write changed nothing.
    const res = await app.request("/api/public-knowledge/access", { headers: owner });
    expect(((await res.json()) as { aliases: string[] }).aliases).toEqual(["alice"]);
  });

  test("the owner reads, replaces and validates the allowlist", async () => {
    const put = (body: unknown) =>
      app.request("/api/public-knowledge/access", { method: "PUT", headers: owner, body: JSON.stringify(body) });
    const ok = await put({ aliases: [" dave ", "dave", "erin"], posixGroups: ["team-kb"] });
    expect(ok.status).toBe(200);
    // PUT answers with the same view GET does.
    expect(await ok.json()).toEqual({ aliases: ["dave", "erin"], posixGroups: ["team-kb"], enabled: false });
    const read = await app.request("/api/public-knowledge/access", { headers: owner });
    expect(await read.json()).toMatchObject({ aliases: ["dave", "erin"], posixGroups: ["team-kb"], enabled: false });
    expect((await app.publicKnowledgeApp.request(`${PUBLIC_KNOWLEDGE_BASE}/whoami`, { headers: as("dave") })).status).toBe(200);
    expect((await app.publicKnowledgeApp.request(`${PUBLIC_KNOWLEDGE_BASE}/whoami`, { headers: as("alice") })).status).toBe(403);

    for (const bad of [
      null,
      [],
      { aliases: "dave" },
      { aliases: [1] },
      { aliases: ["bob smith"] },
      { aliases: ["$(id)"] },
      { posixGroups: ["a b"] },
      { aliases: Array.from({ length: 201 }, (_, i) => `u${i}`) },
    ]) {
      expect((await put(bad)).status).toBe(400);
    }
  });

  test("the owner reads the usage log", async () => {
    await app.publicKnowledgeApp.request(`${PUBLIC_KNOWLEDGE_BASE}/whoami`, { headers: as("zed") });
    const res = await app.request("/api/public-knowledge/usage?limit=5", { headers: owner });
    expect(res.status).toBe(200);
    const { calls } = (await res.json()) as { calls: Array<{ alias: string; status: number; endpoint: string; at: string }> };
    expect(calls[0]).toMatchObject({ alias: "zed", status: 403, endpoint: `GET ${PUBLIC_KNOWLEDGE_BASE}/whoami` });
  });

  test("PUT /api/settings cannot write the allowlist", async () => {
    await app.request("/api/settings", {
      method: "PUT",
      headers: owner,
      body: JSON.stringify({ publicKnowledgeAccess: JSON.stringify({ aliases: ["mallory"], posixGroups: [] }) }),
    });
    expect((await app.publicKnowledgeApp.request(`${PUBLIC_KNOWLEDGE_BASE}/whoami`, { headers: as("mallory") })).status).toBe(403);
  });

  test("only the owner changes whether a project is shareable", async () => {
    const patch = (headers: Record<string, string>, body: unknown) =>
      app.request("/api/projects/alpha", { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await patch(asConsole("bob"), { shareable: false })).status).toBe(403);
    expect(getProject(store.db, "alpha")?.shareable).toBe(true);
    expect((await patch(owner, { shareable: "no" })).status).toBe(400);
    expect((await patch(owner, { shareable: false })).status).toBe(200);
    expect(getProject(store.db, "alpha")?.shareable).toBe(false);
    // An unrelated edit keeps it withheld.
    expect((await patch(owner, { name: "Alpha 2" })).status).toBe(200);
    expect(getProject(store.db, "alpha")?.shareable).toBe(false);
    const res = await app.publicKnowledgeApp.request(`${PUBLIC_KNOWLEDGE_BASE}/docs/alpha/alpha-guide`, { headers: as("dave") });
    expect(res.status).toBe(404);
    expect((await patch(owner, { shareable: true })).status).toBe(200);
    expect(getProject(store.db, "alpha")?.shareable).toBe(true);
    const globalPatch = await app.request(`/api/projects/${GLOBAL_PROJECT_ID}`, {
      method: "PATCH",
      headers: owner,
      body: JSON.stringify({ shareable: false }),
    });
    expect(globalPatch.status).toBe(400);
  });
});

const putDoc = (store: Store, projectId: string, slug: string, body: string, extra: Partial<KnowledgeDoc> = {}) =>
  new KnowledgeStore(store.db).upsertDoc({
    id: `${projectId}-${slug}`,
    projectId,
    slug,
    title: slug,
    body,
    updatedAt: AT,
    filePath: `/x/${projectId}/${slug}.md`,
    originClass: "owner",
    sourceKind: "runbook",
    scope: "project",
    ...extra,
  });

describe("doc references in a served doc name only served docs", () => {
  test("GET /docs keeps only the related entries that resolve to a served doc", async () => {
    const store = seed();
    putDoc(store, "alpha", "linked-doc", `the ${TERM} hub`, {
      related: [
        "secret/secret-plan",
        `${GLOBAL_PROJECT_ID}/persona-owner-tunnel-prefs`,
        `${GLOBAL_PROJECT_ID}/personal-note`,
        "native-mem-repo-claude-md",
        "no-such-doc",
        `${GLOBAL_PROJECT_ID}/shared-runbook`,
        "alpha-guide",
      ],
    });
    const { publicKnowledgeApp: pub } = serve(store);
    const res = await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/docs/alpha/linked-doc`, { headers: as("alice") });
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { related?: string[] };
    expect(doc.related).toEqual([`${GLOBAL_PROJECT_ID}/shared-runbook`, "alpha-guide"]);
  });

  test("a doc whose related entries are all withheld has no related field", async () => {
    const store = seed();
    putDoc(store, "alpha", "lonely-doc", `the ${TERM} hub`, { related: ["secret/secret-plan"] });
    const { publicKnowledgeApp: pub } = serve(store);
    const doc = (await (await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/docs/alpha/lonely-doc`, { headers: as("alice") })).json()) as Record<string, unknown>;
    expect(doc.related).toBeUndefined();
    expect(JSON.stringify(doc)).not.toContain("secret-plan");
  });
});

describe("every returned text goes through the full redaction tier", () => {
  const SECRETS = "Deploy to account 123456789012 first. db_password: hunter2hunter2";
  const seeded = () => {
    const store = seed();
    // Indexed directly, as a hand-edited file is: no write-path redaction ran.
    putDoc(store, "alpha", "deploy-runbook", `The ${TERM} widget rollout checklist. ${SECRETS}`, { title: "Runbook for account 123456789012" });
    return store;
  };

  test("/docs body and title", async () => {
    const { publicKnowledgeApp: pub } = serve(seeded());
    const doc = (await (await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/docs/alpha/deploy-runbook`, { headers: as("alice") })).json()) as { body: string; title: string };
    expect(doc.body).not.toContain("123456789012");
    expect(doc.body).not.toContain("hunter2hunter2");
    expect(doc.body).toContain("[REDACTED]");
    expect(doc.title).not.toContain("123456789012");
  });

  test("/search excerpt", async () => {
    const { publicKnowledgeApp: pub } = serve(seeded());
    const { hits } = (await (await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/search?q=${TERM}+widget&project=alpha&limit=50`, { headers: as("alice") })).json()) as {
      hits: Array<{ slug: string; excerpt: string; title: string }>;
    };
    const hit = hits.find((h) => h.slug === "deploy-runbook");
    expect(hit).toBeDefined();
    expect(JSON.stringify(hits)).not.toContain("123456789012");
    expect(JSON.stringify(hits)).not.toContain("hunter2hunter2");
  });
});

describe("/search and /docs serve trusted docs only", () => {
  test("an untrusted-origin, disputed or superseded doc is neither listed, found nor served", async () => {
    const store = seed();
    putDoc(store, "alpha", "untrusted-doc", `the ${TERM} widget rollout checklist`, { originClass: "untrusted" });
    putDoc(store, "alpha", "disputed-doc", `the ${TERM} widget rollout checklist`);
    putDoc(store, "alpha", "superseded-doc", `the ${TERM} widget rollout checklist`);
    putDoc(store, "alpha", "contradicted-doc", `the ${TERM} widget rollout checklist`);
    store.db.run("UPDATE knowledge SET verdict = 'disputed' WHERE slug = 'disputed-doc'");
    store.db.run("UPDATE knowledge SET verdict = 'superseded' WHERE slug = 'superseded-doc'");
    store.db.run("UPDATE knowledge SET verdict = 'contradicted' WHERE slug = 'contradicted-doc'");
    const { publicKnowledgeApp: pub } = serve(store);
    const gated = ["untrusted-doc", "disputed-doc", "superseded-doc"];
    const { hits } = (await (await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/search?q=${TERM}+widget&limit=50`, { headers: as("alice") })).json()) as {
      hits: Array<{ slug: string; verdict?: string }>;
    };
    for (const slug of gated) expect(hits.map((h) => h.slug)).not.toContain(slug);
    const { docs } = (await (await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/projects/alpha/docs`, { headers: as("alice") })).json()) as { docs: Array<{ slug: string }> };
    for (const slug of gated) {
      expect(docs.map((d) => d.slug)).not.toContain(slug);
      expect((await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/docs/alpha/${slug}`, { headers: as("alice") })).status).toBe(404);
    }
    // A contradicted doc is served, labeled.
    const contradicted = (await (await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/docs/alpha/contradicted-doc`, { headers: as("alice") })).json()) as { verdict?: string };
    expect(contradicted.verdict).toBe("contradicted");
  });
});

describe("an alias is one caller whatever its case", () => {
  test("/whoami answers the lowercased alias", async () => {
    const { publicKnowledgeApp: pub } = serve(seed());
    expect((await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/whoami`, { headers: as("ALICE") })).status).toBe(200);
    expect(await (await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/whoami`, { headers: as("Alice") })).json()).toEqual({ alias: "alice" });
  });
});

describe("search limit", () => {
  test("limit=500 is clamped to 50", async () => {
    const store = seed();
    for (let i = 0; i < 60; i++) putDoc(store, "alpha", `many-${i}`, `the ${TERM} widget rollout checklist number ${i}`);
    const app = createPublicKnowledgeApp({ db: store.db, knowledgeStore: new KnowledgeStore(store.db), groupsOf });
    const { hits } = (await (await app.request(`${PUBLIC_KNOWLEDGE_BASE}/search?q=${TERM}+widget&limit=500`, { headers: as("alice") })).json()) as { hits: unknown[] };
    expect(hits.length).toBe(50);
  });
});

describe("the call log can't be flushed by refused calls", () => {
  test("refused calls from one alias past the per-window cap are not logged one row each", async () => {
    const store = seed();
    const { publicKnowledgeApp: pub } = serve(store);
    for (let i = 0; i < REFUSED_LOGGED_PER_ALIAS + 15; i++) await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/whoami`, { headers: as("mallory") });
    await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/whoami`, { headers: as("alice") });
    const calls = listPublicKbCalls(store.db, 100);
    expect(calls.filter((c) => c.alias === "mallory").length).toBe(REFUSED_LOGGED_PER_ALIAS);
    expect(calls[0]).toMatchObject({ alias: "alice", status: 200 });
  });
});

describe("owner view of the listener", () => {
  const owner = { [OWNER_TOKEN_HEADER]: secrets.ownerToken, "content-type": "application/json" };
  test("GET and PUT report the listener's real state: bound, or the reason it isn't", async () => {
    let status: PublicKnowledgeListenerStatus = { enabled: true, socketPath: "/d/public/kb.sock" };
    const app = serve(seed(), { listenerStatus: () => status });
    const get = async () => (await app.request("/api/public-knowledge/access", { headers: owner })).json();
    expect(await get()).toEqual({ aliases: ["alice"], posixGroups: ["kb-readers"], enabled: true, socketPath: "/d/public/kb.sock" });
    const put = await app.request("/api/public-knowledge/access", {
      method: "PUT",
      headers: owner,
      body: JSON.stringify({ aliases: ["Dave"], posixGroups: ["_kb-team"] }),
    });
    expect(await put.json()).toEqual({ aliases: ["dave"], posixGroups: ["_kb-team"], enabled: true, socketPath: "/d/public/kb.sock" });
    status = { enabled: false, socketPath: "/d/public/kb.sock", error: "another process is already listening on /d/public/kb.sock" };
    expect(await get()).toEqual({
      aliases: ["dave"],
      posixGroups: ["_kb-team"],
      enabled: false,
      socketPath: "/d/public/kb.sock",
      error: "another process is already listening on /d/public/kb.sock",
    });
  });
});

describe("the call log throttles every non-2xx answer and /whoami", () => {
  test("refusals of every status share one per-alias cap and collapse into one row; /whoami rows are capped too", async () => {
    let t = Date.parse("2026-10-01T00:00:00Z");
    const store = seed();
    const { publicKnowledgeApp: pub } = serve(store, { now: () => t });
    const refusals: Array<() => Response | Promise<Response>> = [
      () => pub.request(`${PUBLIC_KNOWLEDGE_BASE}/docs/secret/secret-plan`, { headers: as("alice") }), // 404
      () => pub.request(`${PUBLIC_KNOWLEDGE_BASE}/search`, { headers: as("alice") }), // 400
      () => pub.request(`${PUBLIC_KNOWLEDGE_BASE}/ask`, { method: "POST", headers: as("alice"), body: "{}" }), // 410
    ];
    const statuses = new Set<number>();
    for (let i = 0; i < REFUSED_LOGGED_PER_ALIAS + 7; i++) statuses.add((await refusals[i % refusals.length]!()).status);
    expect([...statuses].sort()).toEqual([400, 404, 410]);
    for (let i = 0; i < WHOAMI_LOGGED_PER_ALIAS + 3; i++) expect((await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/whoami`, { headers: as("alice") })).status).toBe(200);
    let calls = listPublicKbCalls(store.db, 500);
    expect(calls.filter((c) => c.status !== 200).length).toBe(REFUSED_LOGGED_PER_ALIAS);
    expect(calls.filter((c) => c.endpoint === `GET ${PUBLIC_KNOWLEDGE_BASE}/whoami`).length).toBe(WHOAMI_LOGGED_PER_ALIAS);

    // The first call after the window closes writes the summary rows.
    t += 61_000;
    await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/search?q=${TERM}`, { headers: as("alice") });
    calls = listPublicKbCalls(store.db, 500);
    const refused = calls.find((c) => c.endpoint === "refused calls (collapsed)");
    expect(refused).toMatchObject({ alias: "alice", query: "7 more refused calls since 2026-10-01T00:00:00.000Z" });
    const whoami = calls.find((c) => c.endpoint === "whoami calls (collapsed)");
    expect(whoami).toMatchObject({ alias: "alice", status: 200, query: "3 more whoami calls since 2026-10-01T00:00:00.000Z" });
    expect(calls[0]).toMatchObject({ endpoint: `GET ${PUBLIC_KNOWLEDGE_BASE}/search`, status: 200 });
  });
});

describe("tags and project names go through the full redaction tier too", () => {
  test("/docs tags and /projects names", async () => {
    const store = seed();
    upsertProject(store.db, { id: "acct", name: "Team for account 123456789012", branch: "main", repos: [] });
    putDoc(store, "acct", "tagged-doc", `the ${TERM} widget rollout checklist`, { tags: ["deploy", "account 123456789012"] });
    const { publicKnowledgeApp: pub } = serve(store);
    const doc = (await (await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/docs/acct/tagged-doc`, { headers: as("alice") })).json()) as { tags: string[] };
    expect(doc.tags[0]).toBe("deploy");
    expect(JSON.stringify(doc.tags)).not.toContain("123456789012");
    const { projects } = (await (await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/projects`, { headers: as("alice") })).json()) as { projects: Array<{ id: string; name: string }> };
    const acct = projects.find((p) => p.id === "acct");
    expect(acct).toBeDefined();
    expect(acct!.name).not.toContain("123456789012");
  });
});

describe("excerpts are cut from the redacted body", () => {
  const BODY = `Deploy to account 123456789012 first. The ${TERM} widget rollout checklist.`;
  const seeded = () => {
    const store = seed();
    putDoc(store, "alpha", "deploy-runbook", BODY);
    return store;
  };

  test("/search: no fragment of a secret the excerpt's edge would split survives", async () => {
    const store = seeded();
    const pub = createPublicKnowledgeApp({ db: store.db, knowledgeStore: new KnowledgeStore(store.db), groupsOf });
    const { hits } = (await (await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/search?q=${TERM}+widget&project=alpha&limit=50`, { headers: as("alice") })).json()) as {
      hits: Array<{ slug: string; excerpt: string }>;
    };
    const hit = hits.find((h) => h.slug === "deploy-runbook");
    expect(hit).toBeDefined();
    expect(hit!.excerpt).not.toContain("56789012");
    expect(hit!.excerpt).toContain("[REDACTED]");
  });
});

describe("public scores and order are a function of the served corpus alone", () => {
  /** Where a private doc lives, cycled through as more are added. */
  const PRIVATE_HOMES: Array<{ projectId: string; slugOf: (i: number) => string; extra: Partial<KnowledgeDoc> }> = [
    { projectId: GLOBAL_PROJECT_ID, slugOf: (i) => `private-note-${i}`, extra: { scope: "user", ownerUser: "owner" } },
    { projectId: "secret", slugOf: (i) => `secret-doc-${i}`, extra: { scope: "global" } },
    { projectId: GLOBAL_PROJECT_ID, slugOf: (i) => `persona-owner-probe-${i}`, extra: { scope: "user", ownerUser: "owner" } },
  ];

  /** A corpus of the given served docs, fillers, and `privates` private docs whose bodies hold `privateBody`. */
  function probeStore(shared: Array<[string, string]>, privates: number, privateBody: string, fillers = 12): Store {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "alpha", name: "Alpha", branch: "main", repos: [] });
    upsertProject(store.db, { id: "secret", name: "Secret", branch: "main", repos: [], shareable: false });
    upsertProject(store.db, { id: GLOBAL_PROJECT_ID, name: "Global", branch: "main", repos: [], reserved: true });
    writeAccess(store.db, { aliases: ["alice"], posixGroups: [] });
    for (const [slug, body] of shared) putDoc(store, "alpha", slug, body);
    for (let i = 0; i < fillers; i++) putDoc(store, "alpha", `filler-${i}`, `billing onboarding laptop editor topic number ${i}`);
    for (let i = 0; i < privates; i++) {
      const home = PRIVATE_HOMES[i % PRIVATE_HOMES.length]!;
      putDoc(store, home.projectId, home.slugOf(i), privateBody, home.extra);
    }
    return store;
  }

  const app = (store: Store) => createPublicKnowledgeApp({ db: store.db, knowledgeStore: new KnowledgeStore(store.db), groupsOf });
  const search = async (store: Store, q: string, limit = 10) =>
    (await app(store).request(`${PUBLIC_KNOWLEDGE_BASE}/search?q=${encodeURIComponent(q)}&limit=${limit}`, { headers: as("alice") })).text();

  const ONE_SHARED: Array<[string, string]> = [["zorblax-guide", "the zorblax rollout guide: drain the zorblax queue first"]];
  const MIXED: Array<[string, string]> = [
    ["zorblax-guide", "the zorblax rollout guide: drain the zorblax queue first"],
    ["zorblax-notes", "notes on zorblax, quuxword-free, with a long tail about laptops editors onboarding and billing topics"],
    ["zorblax-faq", "zorblax zorblax zorblax faq"],
    ["queue-runbook", "drain the queue, then the zorblax"],
  ];

  test("the reviewer's probe: one served doc, a word only 0, 1 or 5 private docs hold — /search is byte-identical", async () => {
    const readings = await Promise.all([0, 1, 5].map((n) => search(probeStore(ONE_SHARED, n, "quuxword private notes"), "zorblax quuxword")));
    expect(readings[0]).toContain("zorblax-guide");
    expect(readings[1]).toBe(readings[0]);
    expect(readings[2]).toBe(readings[0]);
    const { hits } = JSON.parse(readings[0]!) as { hits: Array<Record<string, unknown>> };
    expect(Object.keys(hits[0]!).sort()).toEqual(["excerpt", "project", "score", "slug", "title"]);
    expect(typeof hits[0]!.score).toBe("number");
  });

  test("several served docs: hits, order and scores are byte-identical however many private docs share the query's words", async () => {
    const queries = ["zorblax quuxword", "drain zorblax queue", "quuxword"];
    for (const q of queries) {
      const readings = await Promise.all(
        [0, 1, 5].map((n) => search(probeStore(MIXED, n, "quuxword zorblax queue drain, the private zorblax plan"), q, 50))
      );
      expect(readings[1]).toBe(readings[0]);
      expect(readings[2]).toBe(readings[0]);
    }
    const { hits } = JSON.parse(await search(probeStore(MIXED, 0, ""), "drain zorblax queue", 50)) as { hits: Array<{ slug: string }> };
    expect(hits.map((h) => h.slug)).toEqual(expect.arrayContaining(["zorblax-guide", "queue-runbook"]));
  });

  test("withheld docs that match strongly never crowd a served match out of limit=1", async () => {
    const store = probeStore([["zorblax-long", `a long guide ${"about billing and onboarding ".repeat(30)} that mentions zorblax once`]], 0, "");
    for (let i = 0; i < 8; i++) putDoc(store, "secret", `secret-zorblax-${i}`, "zorblax zorblax zorblax", { scope: "global" });
    for (let i = 0; i < 4; i++) putDoc(store, GLOBAL_PROJECT_ID, `user-zorblax-${i}`, "zorblax zorblax zorblax", { scope: "user", ownerUser: "owner" });
    const { hits } = JSON.parse(await search(store, "zorblax", 1)) as { hits: Array<{ slug: string }> };
    expect(hits.map((h) => h.slug)).toEqual(["zorblax-long"]);
  });
});

describe("an embedding match is excerpted at its own chunk", () => {
  const OPENING = "# Overview\nThis guide opens with general setup notes that say nothing about the match.";
  const DEEP = "## Carburetor tuning\nTurn the idle screw a quarter turn; the bench rig is in account 123456789012.";
  const BODY = `${OPENING}\n\n${"filler line about other things\n".repeat(80)}\n${DEEP}\n\n## Afterwards\nPut the tools away.`;

  test("/search returns the matched chunk deep in the body, redacted, not the doc's opening", async () => {
    const store = seed();
    putDoc(store, "alpha", "engine-guide", BODY);
    const ks = new KnowledgeStore(store.db);
    ks.upsertChunk({ id: "engine-guide-0", knowledgeId: "alpha-engine-guide", chunkIndex: 0, text: OPENING, embedding: [0, 1] });
    ks.upsertChunk({ id: "engine-guide-1", knowledgeId: "alpha-engine-guide", chunkIndex: 1, text: DEEP, embedding: [1, 0] });
    const pub = createPublicKnowledgeApp({
      db: store.db,
      knowledgeStore: ks,
      groupsOf,
      embedQuery: async () => [1, 0],
    });
    const { hits } = (await (await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/search?q=adjusting+motors`, { headers: as("alice") })).json()) as {
      hits: Array<{ slug: string; excerpt: string }>;
    };
    const hit = hits.find((h) => h.slug === "engine-guide");
    expect(hit).toBeDefined();
    expect(hit!.excerpt).toContain("Turn the idle screw a quarter turn");
    expect(hit!.excerpt).not.toContain("general setup notes");
    expect(hit!.excerpt).not.toContain("123456789012");
    expect(hit!.excerpt).toContain("[REDACTED]");
  });
});

describe("the call log can't be flushed by successful calls either", () => {
  test("answered calls past the per-alias cap collapse into one summary row when the window closes", async () => {
    let t = Date.parse("2026-10-02T00:00:00Z");
    const store = seed();
    const { publicKnowledgeApp: pub } = serve(store, { now: () => t });
    for (let i = 0; i < SUCCESS_LOGGED_PER_ALIAS + 9; i++) {
      expect((await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/projects`, { headers: as("alice") })).status).toBe(200);
    }
    let calls = listPublicKbCalls(store.db, 500);
    expect(calls.filter((c) => c.endpoint === `GET ${PUBLIC_KNOWLEDGE_BASE}/projects`).length).toBe(SUCCESS_LOGGED_PER_ALIAS);
    // Another alias keeps its own rows.
    expect((await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/projects`, { headers: as("carol") })).status).toBe(200);
    expect(listPublicKbCalls(store.db, 1)[0]).toMatchObject({ alias: "carol", status: 200 });
    t += 61_000;
    await pub.request(`${PUBLIC_KNOWLEDGE_BASE}/projects`, { headers: as("alice") });
    calls = listPublicKbCalls(store.db, 500);
    expect(calls.find((c) => c.endpoint === "answered calls (collapsed)")).toMatchObject({
      alias: "alice",
      status: 200,
      query: "9 more answered calls since 2026-10-02T00:00:00.000Z",
    });
    expect(calls[0]).toMatchObject({ alias: "alice", endpoint: `GET ${PUBLIC_KNOWLEDGE_BASE}/projects` });
  });
});

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe("over a real Unix socket", () => {
  test("the public app answers on a socket and refuses an unknown route there", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pkb-"));
    tmpDirs.push(dir);
    const socket = join(dir, "kb.sock");
    const store = seed();
    const { publicKnowledgeApp } = serve(store);
    const server = Bun.serve({ unix: socket, fetch: publicKnowledgeApp.fetch });
    try {
      const res = await fetch(`http://localhost${PUBLIC_KNOWLEDGE_BASE}/whoami`, { unix: socket, headers: as("alice") });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ alias: "alice" });
      const projects = await fetch("http://localhost/api/projects", { unix: socket, headers: as("alice") });
      expect(projects.status).toBe(404);
      const anon = await fetch(`http://localhost${PUBLIC_KNOWLEDGE_BASE}/whoami`, { unix: socket });
      expect(anon.status).toBe(401);
    } finally {
      server.stop(true);
    }
  });
});
