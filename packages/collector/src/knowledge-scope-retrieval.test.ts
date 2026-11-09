import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { KnowledgeStore } from "@standup/knowledge";
import type { KnowledgeDoc, ScopeAudience } from "@standup/knowledge";
import { GLOBAL_PROJECT_ID } from "@standup/shared";
import { retrieveCodeKnowledge } from "./launcher.js";

// The launch-injection retrieval and the /api/knowledge/agent-view endpoint call
// the SAME retrieveCodeKnowledge / retrieveProductKnowledge with the same
// audience, so exercising the function here proves the agent-view output equals
// the real injected set for a (project, user) — they cannot diverge. Runs
// FTS-only (null provider), so the recalled set is decided by the scope gate.
function doc(overrides: Partial<KnowledgeDoc>): KnowledgeDoc {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    projectId: "alpha",
    slug: "doc",
    title: "Doc",
    body: `scopeterm content of ${overrides.slug ?? "doc"}`,
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    filePath: "/x/doc.md",
    // Owner-authored so the launch-injection trust gate admits it (the
    // fail-closed default 'untrusted' would drop every doc before the scope
    // gate even mattered). A code fact, so it is in the code-injection family.
    originClass: "owner",
    sourceKind: "code",
    ...overrides,
  };
}

function seed(): Database {
  const db = new Database(":memory:");
  const store = new KnowledgeStore(db);
  store.upsertDoc(doc({ id: "g", slug: "global-doc", title: "Global scopeterm", scope: "global" }));
  store.upsertDoc(doc({ id: "ap", slug: "alpha-proj", title: "Alpha scopeterm", scope: "project" }));
  store.upsertDoc(
    doc({ id: "bp", projectId: "beta", slug: "beta-proj", title: "Beta scopeterm", scope: "project" })
  );
  store.upsertDoc(
    doc({ id: "au", slug: "alice-doc", title: "Alice scopeterm", scope: "user", ownerUser: "alice" })
  );
  store.upsertDoc(
    doc({
      id: "bu",
      projectId: "beta",
      slug: "bob-doc",
      title: "Bob scopeterm",
      scope: "user",
      ownerUser: "bob",
    })
  );
  return db;
}

describe("launch/agent-view retrieval applies the scope gate", () => {
  const slugs = (rs: Array<{ slug: string }>) => new Set(rs.map((r) => r.slug));

  test("an agent's injected set is its global ∪ project docs, never a user-scoped doc", async () => {
    const db = seed();
    const forAlice = await retrieveCodeKnowledge(db, "alpha", "scopeterm", null, {}, {
      projectId: "alpha",
      user: "alice",
    });
    const got = slugs(forAlice);
    expect(got.has("global-doc")).toBe(true); // global reaches everyone
    expect(got.has("alpha-proj")).toBe(true); // this project
    // The requesting user's own doc is personal-layer: it reaches its owner
    // through Persona and the owner filter on search, never a launch block.
    expect(got.has("alice-doc")).toBe(false);
    expect(got.has("beta-proj")).toBe(false); // another project's project doc
    expect(got.has("bob-doc")).toBe(false); // another user's user doc
  });

  test("a different user's launch never injects the first user's docs", async () => {
    const db = seed();
    const forBob = await retrieveCodeKnowledge(db, "alpha", "scopeterm", null, {}, {
      projectId: "alpha",
      user: "bob",
    });
    expect(slugs(forBob).has("alice-doc")).toBe(false);
  });

  test("an automatic launch with no user gets global ∪ project only", async () => {
    const db = seed();
    const audience: ScopeAudience = { projectId: "alpha", user: undefined };
    const forNobody = await retrieveCodeKnowledge(db, "alpha", "scopeterm", null, {}, audience);
    const got = slugs(forNobody);
    expect(got.has("global-doc")).toBe(true);
    expect(got.has("alpha-proj")).toBe(true);
    expect(got.has("alice-doc")).toBe(false);
    expect(got.has("bob-doc")).toBe(false);
  });

  test("a doc homed in the GLOBAL corpus is injected for every launch even with scope='project'", async () => {
    // The defense-in-depth case: a best-practices doc homed in the reserved
    // GLOBAL corpus but stamped scope='project' (a legacy backfill / a write
    // that bypassed the loader's global inference). It must still reach every
    // launch, or the global KB silently drops out of injection.
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(
      doc({
        id: "gh",
        projectId: GLOBAL_PROJECT_ID,
        slug: "global-homed",
        title: "Global homed scopeterm",
        scope: "project",
      })
    );

    for (const audience of [
      { projectId: "alpha", user: "alice" },
      { projectId: "beta", user: "bob" },
      { projectId: "gamma", user: undefined },
    ]) {
      const injected = await retrieveCodeKnowledge(
        db,
        audience.projectId,
        "scopeterm",
        null,
        {},
        audience
      );
      expect(slugs(injected).has("global-homed")).toBe(true);
    }
  });

  test("a user-scoped doc homed in the GLOBAL corpus is never injected, not even for its owner", async () => {
    // The reserved GLOBAL corpus reaches every launch — but a doc explicitly
    // marked scope='user' homed there (the loader honors `scope: user` even
    // under knowledge/global/) must stay isolated to its owner. Without the
    // scope != 'user' guard on the reserved-home disjunct, Alice's private doc
    // would be auto-injected into every user's and project's launch context.
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(
      doc({
        id: "gu",
        projectId: GLOBAL_PROJECT_ID,
        slug: "alice-secret",
        title: "Alice secret scopeterm",
        scope: "user",
        ownerUser: "alice",
      })
    );

    // No audience — the owner, a different user, a different project, or an
    // unresolved identity — has it injected.
    for (const audience of [
      { projectId: "alpha", user: "alice" },
      { projectId: "alpha", user: "bob" },
      { projectId: "beta", user: "carol" },
      { projectId: "gamma", user: undefined },
    ]) {
      const injected = await retrieveCodeKnowledge(
        db,
        audience.projectId,
        "scopeterm",
        null,
        {},
        audience
      );
      expect(slugs(injected).has("alice-secret")).toBe(false);
    }
  });
});

