import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { GLOBAL_PROJECT_ID } from "@standup/shared";
import { KnowledgeStore } from "./store.js";
import { searchKnowledge, OTHER_PROJECT_PREFERENCE } from "./search.js";
import {
  docInAudience,
  relatedProjectIdsOf,
  scopeAudiencePartitionSpecs,
  type KnowledgeDoc,
  type ScopeAudience,
} from "./types.js";

function doc(overrides: Partial<KnowledgeDoc>): KnowledgeDoc {
  const slug = overrides.slug ?? "doc";
  return {
    id: overrides.id ?? `${overrides.projectId ?? "harbor-berths"}-${slug}`,
    projectId: "harbor-berths",
    slug,
    title: slug,
    body: "tide tables mooring classes relatedterm",
    updatedAt: new Date("2026-08-16T00:00:00Z"),
    filePath: `/x/${slug}.md`,
    originClass: "owner",
    scope: "project",
    sourceKind: "runbook",
    ...overrides,
  };
}

// The berths service and its harbor console share one product; "billing" is an
// unrelated project and "scratch" holds whatever landed nowhere else.
const DOCS: KnowledgeDoc[] = [
  doc({ projectId: "harbor-berths", slug: "tide-tables", sourceKind: "spec" }),
  doc({ projectId: "harbor-berths", slug: "mooring-classes" }),
  doc({ projectId: "harbor-berths", slug: "alice-notes", scope: "user", ownerUser: "alice" }),
  doc({ projectId: "harbor-berths", slug: "bob-notes", scope: "user", ownerUser: "bob" }),
  doc({ projectId: "harbor-console", slug: "console-runbook" }),
  doc({ projectId: "billing", slug: "billing-runbook" }),
  doc({ projectId: "billing", slug: "billing-spec", sourceKind: "spec", scope: "global" }),
  doc({ projectId: "scratch", slug: "scratch-note" }),
];

function seeded(): Database {
  const db = new Database(":memory:");
  const store = new KnowledgeStore(db);
  for (const d of DOCS) store.upsertDoc(d);
  return db;
}

async function slugs(db: Database, projectId: string, audience: ScopeAudience, corpus: "project" | "all" = "all") {
  const hits = await searchKnowledge(db, projectId, "relatedterm", null, { limit: 50, corpus, audience });
  return new Set(hits.map((h) => h.slug));
}

describe("relatedProjectIdsOf", () => {
  test("drops blanks, duplicates, the audience's own project and the reserved global corpus", () => {
    expect(
      relatedProjectIdsOf({
        projectId: "harbor-console",
        relatedProjectIds: ["harbor-berths", " harbor-berths ", "", "harbor-console", GLOBAL_PROJECT_ID],
      })
    ).toEqual(["harbor-berths"]);
    expect(relatedProjectIdsOf(undefined)).toEqual([]);
    expect(relatedProjectIdsOf({ projectId: "x" })).toEqual([]);
  });
});

describe("the audience gate over related projects", () => {
  const related: ScopeAudience = { projectId: "harbor-console", user: "alice", relatedProjectIds: ["harbor-berths"] };
  const unrelated: ScopeAudience = { projectId: "billing", user: "alice" };

  test("a related project's project-scoped docs reach the audience; an unrelated audience never sees them", async () => {
    const db = seeded();
    const forRelated = await slugs(db, "harbor-console", related);
    expect(forRelated.has("tide-tables")).toBe(true);
    expect(forRelated.has("mooring-classes")).toBe(true);
    expect(forRelated.has("console-runbook")).toBe(true);
    expect(forRelated.has("billing-runbook")).toBe(false);

    const forUnrelated = await slugs(db, "billing", unrelated);
    expect(forUnrelated.has("tide-tables")).toBe(false);
    expect(forUnrelated.has("mooring-classes")).toBe(false);
    expect(forUnrelated.has("console-runbook")).toBe(false);

    const withoutRelation = await slugs(db, "harbor-console", { projectId: "harbor-console", user: "alice" });
    expect(withoutRelation.has("mooring-classes")).toBe(false);
  });

  test("scratch docs stay out of every non-scratch audience", async () => {
    const db = seeded();
    expect((await slugs(db, "harbor-console", related)).has("scratch-note")).toBe(false);
    expect((await slugs(db, "harbor-console", related, "project")).has("scratch-note")).toBe(false);
  });

  test("user-scoped docs in a related project reach only their owner", async () => {
    const db = seeded();
    const forAlice = await slugs(db, "harbor-console", related);
    expect(forAlice.has("alice-notes")).toBe(true);
    expect(forAlice.has("bob-notes")).toBe(false);
    const anonymous = await slugs(db, "harbor-console", { projectId: "harbor-console", relatedProjectIds: ["harbor-berths"] });
    expect(anonymous.has("alice-notes")).toBe(false);
    expect(anonymous.has("bob-notes")).toBe(false);
  });

  test("docInAudience and the vec partition specs agree with the SQL gate", async () => {
    const db = seeded();
    const fromSql = await slugs(db, "harbor-console", related);
    expect(new Set(DOCS.filter((d) => docInAudience(d, related)).map((d) => d.slug))).toEqual(fromSql);
    expect(scopeAudiencePartitionSpecs(related)).toContainEqual({ scope: "project", projectId: "harbor-berths" });
  });

  test("excludeForeignIntent keeps a related project's spec and still drops an unrelated one's", async () => {
    const db = seeded();
    const audience: ScopeAudience = { ...related, excludeForeignIntent: true };
    const found = await slugs(db, "harbor-console", audience);
    expect(found.has("tide-tables")).toBe(true);
    expect(found.has("billing-spec")).toBe(false);
    expect(docInAudience(DOCS[0], audience)).toBe(true);
    expect(docInAudience(DOCS[6], audience)).toBe(false);
  });
});

describe("corpus:'project' over related projects", () => {
  test("spans the related projects, and their docs go without the local bonus", async () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    const body = "tide tables revision two relatedterm";
    store.upsertDoc(doc({ projectId: "harbor-console", slug: "own", body }));
    store.upsertDoc(doc({ projectId: "harbor-berths", slug: "sibling", body }));
    store.upsertDoc(doc({ projectId: "billing", slug: "unrelated", body }));
    for (let i = 0; i < 10; i++) {
      store.upsertDoc(doc({ projectId: "harbor-console", slug: `filler-${i}`, body: `unrelated housekeeping ${i}` }));
    }
    const audience: ScopeAudience = { projectId: "harbor-console", relatedProjectIds: ["harbor-berths"] };
    const hits = await searchKnowledge(db, "harbor-console", "tide tables", null, {
      limit: 10,
      corpus: "project",
      audience,
    });
    const bySlug = new Map(hits.map((h) => [h.slug, h]));
    expect(bySlug.has("unrelated")).toBe(false);
    const own = bySlug.get("own")!;
    const sibling = bySlug.get("sibling")!;
    expect(hits[0].slug).toBe("own");
    // Identical text: the gap is the local bonus (plus a rank-position sliver).
    expect(own.score - sibling.score).toBeGreaterThan(OTHER_PROJECT_PREFERENCE - 0.01);
    expect(own.score - sibling.score).toBeLessThan(OTHER_PROJECT_PREFERENCE + 0.01);

    const unrelatedOnly = await searchKnowledge(db, "harbor-console", "tide tables", null, {
      limit: 10,
      corpus: "project",
      audience: { projectId: "harbor-console" },
    });
    expect(unrelatedOnly.map((h) => h.slug)).not.toContain("sibling");
  });
});
