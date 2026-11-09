import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { GLOBAL_PROJECT_ID } from "@standup/shared";
import { KnowledgeStore } from "./store.js";
import { searchKnowledge } from "./search.js";
import { registerEmbeddingProvider } from "./embeddings.js";
import {
  LAYERS,
  docInAudience,
  layerOf,
  layerSql,
  scopeAudienceSql,
  scopeAudiencePartitionSpecs,
  type KnowledgeDoc,
  type Scope,
  type SourceKind,
} from "./types.js";

function doc(overrides: Partial<KnowledgeDoc>): KnowledgeDoc {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    projectId: "alpha",
    slug: "doc",
    title: "Doc",
    body: "layerterm body",
    updatedAt: new Date("2026-08-16T00:00:00Z"),
    filePath: "/x/doc.md",
    originClass: "owner",
    ...overrides,
  };
}

describe("layerOf", () => {
  test("places each doc by scope, native-memory stem, then kind", () => {
    expect(layerOf({ scope: "user", sourceKind: "code", slug: "x" })).toBe("personal");
    expect(layerOf({ scope: "global", sourceKind: "native-memory", slug: "native-mem-home-claude-md" })).toBe(
      "personal"
    );
    expect(layerOf({ scope: "project", sourceKind: "native-memory", slug: "native-mem-memory-diary" })).toBe(
      "activity"
    );
    expect(layerOf({ scope: "project", sourceKind: "native-memory", slug: "native-mem-project-claude-md" })).toBe(
      "docs"
    );
    expect(layerOf({ scope: "project", sourceKind: "native-memory", slug: "native-mem-note-build" })).toBe("docs");
    expect(layerOf({ scope: "global", sourceKind: "spec", slug: "plan" })).toBe("intent");
    expect(layerOf({ scope: "project", sourceKind: "product", slug: "plan" })).toBe("intent");
    for (const kind of ["code", "decision", "runbook", "unclassified"] as const) {
      expect(layerOf({ scope: "project", sourceKind: kind, slug: "x" })).toBe("docs");
    }
    expect(layerOf({ slug: "x" })).toBe("docs");
  });

  test("layerSql agrees with layerOf on every (scope, kind, stem) combination", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE k (scope TEXT, source_kind TEXT, slug TEXT)");
    const scopes: Scope[] = ["global", "project", "user"];
    const kinds: SourceKind[] = ["code", "product", "spec", "decision", "runbook", "native-memory", "unclassified"];
    const slugs = ["native-mem-home-rule-x", "native-mem-memory-x", "native-mem-project-claude-md", "native-mem-note-x", "plain"];
    for (const scope of scopes) {
      for (const kind of kinds) {
        for (const slug of slugs) db.run("INSERT INTO k VALUES (?, ?, ?)", [scope, kind, slug]);
      }
    }
    for (const layer of LAYERS) {
      const rows = db
        .query(`SELECT scope, source_kind, slug FROM k WHERE ${layerSql(layer, "k")}`)
        .all() as Array<{ scope: string; source_kind: string; slug: string }>;
      const expected = scopes.length * kinds.length * slugs.length;
      const all = db.query("SELECT scope, source_kind, slug FROM k").all() as typeof rows;
      expect(all).toHaveLength(expected);
      const want = all.filter((r) => layerOf({ scope: r.scope, sourceKind: r.source_kind, slug: r.slug }) === layer);
      expect(rows).toEqual(want);
    }
  });
});

describe("the audience gate's layer exclusion", () => {
  function seed(): Database {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc({ id: "proj", slug: "alpha-proj", scope: "project", sourceKind: "code" }));
    store.upsertDoc(doc({ id: "glob", projectId: "beta", slug: "beta-global", scope: "global", sourceKind: "code" }));
    store.upsertDoc(doc({ id: "mine", slug: "alice-note", scope: "user", ownerUser: "alice", sourceKind: "code" }));
    store.upsertDoc(
      doc({
        id: "home",
        projectId: GLOBAL_PROJECT_ID,
        slug: "native-mem-home-claude-md",
        scope: "global",
        sourceKind: "native-memory",
      })
    );
    store.upsertDoc(
      doc({ id: "diary", slug: "native-mem-memory-diary", scope: "project", sourceKind: "native-memory" })
    );
    // Embed every doc so the embedding arm is exercised too.
    for (const id of ["proj", "glob", "mine", "home", "diary"]) {
      store.upsertChunk({ id: `${id}-c`, knowledgeId: id, chunkIndex: 0, text: "layerterm", embedding: [1, 0, 0] });
    }
    return db;
  }

  registerEmbeddingProvider({
    id: "layers-test",
    defaultModel: "m",
    async embed() {
      return [1, 0, 0];
    },
  });

  const ids = async (db: Database, audience: Parameters<typeof scopeAudienceSql>[0], provider: string | null) =>
    new Set((await searchKnowledge(db, "alpha", "layerterm", provider, { limit: 10, audience })).map((r) => r.id));

  for (const provider of [null, "layers-test"]) {
    test(`excluding the personal layer drops user docs and home mirrors on every arm (${provider ?? "fts"})`, async () => {
      const db = seed();
      const open = await ids(db, { projectId: "alpha", user: "alice", hostUser: "alice" }, provider);
      expect(open).toEqual(new Set(["proj", "glob", "mine", "home", "diary"]));

      // The unowned legacy home mirror is the host user's alone.
      const other = await ids(db, { projectId: "alpha", user: "alice", hostUser: "host" }, provider);
      expect(other).toEqual(new Set(["proj", "glob", "mine", "diary"]));
      const anonymous = await ids(db, { projectId: "alpha", hostUser: "host" }, provider);
      expect(anonymous).toEqual(new Set(["proj", "glob", "diary"]));

      const shared = await ids(db, { projectId: "alpha", user: "alice", excludeLayers: ["personal"] }, provider);
      expect(shared).toEqual(new Set(["proj", "glob", "diary"]));

      const injected = await ids(
        db,
        { projectId: "alpha", user: "alice", excludeLayers: ["personal", "activity"] },
        provider
      );
      expect(injected).toEqual(new Set(["proj", "glob"]));
    });
  }

  test("the vec partition specs drop the owner partition when personal is excluded", () => {
    expect(scopeAudiencePartitionSpecs({ projectId: "alpha", user: "alice", excludeLayers: ["personal"] })).toEqual([
      { scope: "global" },
      { scope: "project", projectId: GLOBAL_PROJECT_ID },
      { scope: "project", projectId: "alpha" },
    ]);
  });
});

describe("the audience gate's foreign-intent exclusion", () => {
  const docs = [
    doc({ id: "own-spec", slug: "own-spec", scope: "project", sourceKind: "spec" }),
    doc({ id: "foreign-spec", projectId: "beta", slug: "foreign-spec", scope: "global", sourceKind: "spec" }),
    doc({ id: "foreign-product", projectId: "beta", slug: "foreign-product", scope: "global", sourceKind: "product" }),
    doc({ id: "foreign-runbook", projectId: "beta", slug: "foreign-runbook", scope: "global", sourceKind: "runbook" }),
    doc({ id: "global-product", projectId: GLOBAL_PROJECT_ID, slug: "global-product", scope: "global", sourceKind: "product" }),
  ];

  test("drops another project's product/spec in SQL and in memory alike; its other kinds and global-corpus intent stay", async () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    for (const d of docs) store.upsertDoc(d);
    const audience = { projectId: "alpha", excludeForeignIntent: true };
    const found = new Set(
      (await searchKnowledge(db, "alpha", "layerterm", null, { limit: 10, audience })).map((r) => r.id)
    );
    const expected = new Set(["own-spec", "foreign-runbook", "global-product"]);
    expect(found).toEqual(expected);
    expect(new Set(docs.filter((d) => docInAudience(d, audience)).map((d) => d.id))).toEqual(expected);
    const open = await searchKnowledge(db, "alpha", "layerterm", null, { limit: 10, audience: { projectId: "alpha" } });
    expect(open).toHaveLength(docs.length);
  });
});

describe("playbooks stay out of every agent audience", () => {
  const docs = [
    doc({ id: "own-playbook", projectId: GLOBAL_PROJECT_ID, slug: "playbook-alice-tab", scope: "user", ownerUser: "alice", sourceKind: "playbook" }),
    doc({ id: "own-memory", projectId: GLOBAL_PROJECT_ID, slug: "persona-alice-tabs", scope: "user", ownerUser: "alice", sourceKind: "decision" }),
  ];

  test("its owner's search and in-memory check drop it; the owner's browse keeps it", async () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    for (const d of docs) store.upsertDoc(d);
    const agent = { projectId: "alpha", user: "alice" };
    const found = (await searchKnowledge(db, "alpha", "layerterm", null, { limit: 10, audience: agent })).map((r) => r.id);
    expect(found).toEqual(["own-memory"]);
    expect(docs.filter((d) => docInAudience(d, agent)).map((d) => d.id)).toEqual(["own-memory"]);
    expect(docs.filter((d) => docInAudience(d, { ...agent, browse: true })).map((d) => d.id)).toEqual(["own-playbook", "own-memory"]);
  });
});
