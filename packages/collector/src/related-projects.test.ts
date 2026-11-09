import { expect, test, describe } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { createStore, upsertProject, getProject, getProjects } from "@standup/store";
import { KnowledgeStore, LocalMarkdownBackend, type KnowledgeDoc } from "@standup/knowledge";
import { GLOBAL_PROJECT_ID } from "@standup/shared";
import { ProjectsRegistry, SCRATCH_PROJECT_ID, relatedProjects } from "./projects-registry.js";
import { retrieveProductKnowledge } from "./launcher.js";

const project = (id: string, related?: string[]) => ({ id, ...(related ? { related } : {}) });

describe("relatedProjects", () => {
  const all = [
    project("acme-harbor-tide-service"),
    project("acme-harbor-tide-service-console"),
    project("acme-dockyard-tide-service-sandbox", ["acme-harbor-tide-service"]),
    project("acme-harbor-tide"),
    project("billing"),
    project(SCRATCH_PROJECT_ID, ["billing"]),
    project(GLOBAL_PROJECT_ID, ["billing"]),
  ];

  test("relates an id-prefix family in both directions", () => {
    expect(relatedProjects("acme-harbor-tide-service-console", all)).toContain("acme-harbor-tide-service");
    expect(relatedProjects("acme-harbor-tide-service", all)).toContain("acme-harbor-tide-service-console");
  });

  test("a prefix only counts at a '-' boundary", () => {
    const ids = [project("kiln"), project("kilnx"), project("kiln-x")];
    expect(relatedProjects("kiln", ids)).toEqual(["kiln-x"]);
    expect(relatedProjects("kilnx", ids)).toEqual([]);
  });

  test("a `related` listing relates both sides", () => {
    expect(relatedProjects("acme-dockyard-tide-service-sandbox", all)).toEqual(["acme-harbor-tide-service"]);
    expect(relatedProjects("acme-harbor-tide-service", all)).toContain("acme-dockyard-tide-service-sandbox");
  });

  test("the full family of the tide service, sorted, without itself", () => {
    expect(relatedProjects("acme-harbor-tide-service", all)).toEqual([
      "acme-dockyard-tide-service-sandbox",
      "acme-harbor-tide",
      "acme-harbor-tide-service-console",
    ]);
  });

  test("never relates scratch or the reserved global corpus, whatever they list", () => {
    expect(relatedProjects("billing", all)).toEqual([]);
    expect(relatedProjects(SCRATCH_PROJECT_ID, all)).toEqual([]);
    expect(relatedProjects(GLOBAL_PROJECT_ID, all)).toEqual([]);
    const listing = [project("billing", [SCRATCH_PROJECT_ID, GLOBAL_PROJECT_ID]), project(SCRATCH_PROJECT_ID), project(GLOBAL_PROJECT_ID)];
    expect(relatedProjects("billing", listing)).toEqual([]);
    expect(relatedProjects("scratch-tools", [project("scratch-tools"), project(SCRATCH_PROJECT_ID)])).toEqual([]);
  });

  test("never relates a reserved project, so the self-fix copy stays out of its prefix family", () => {
    const ids = [{ id: "standup" }, { id: "standup-self", reserved: true }, { id: "standup-web", related: ["standup-self"] }];
    expect(relatedProjects("standup", ids)).toEqual(["standup-web"]);
    expect(relatedProjects("standup-self", ids)).toEqual([]);
    expect(relatedProjects("standup-web", ids)).toEqual(["standup"]);
  });
});

describe("projects.toml `related`", () => {
  test("is read from TOML, persisted, and written back on export", async () => {
    const dir = await mkdtemp(join(tmpdir(), "standup-related-"));
    try {
      const store = createStore(":memory:");
      const path = join(dir, "projects.toml");
      await writeFile(
        path,
        [
          "[[project]]",
          'id = "sandbox"',
          'name = "Sandbox"',
          "repos = []",
          'related = ["harbor-berths", "", 7]',
          "",
          "[[project]]",
          'id = "harbor-berths"',
          'name = "Harbor berths"',
          "repos = []",
        ].join("\n")
      );
      const registry = new ProjectsRegistry(store.db, path);
      await registry.bootstrap();
      expect(getProject(store.db, "sandbox")?.related).toEqual(["harbor-berths"]);
      expect(getProject(store.db, "harbor-berths")?.related).toBeUndefined();
      expect(relatedProjects("harbor-berths", getProjects(store.db))).toEqual(["sandbox"]);
      expect(registry.exportToToml()).toContain('related = ["harbor-berths"]');
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an import that omits `related` keeps the stored list", async () => {
    const dir = await mkdtemp(join(tmpdir(), "standup-related-import-"));
    try {
      const store = createStore(":memory:");
      upsertProject(store.db, { id: "sandbox", name: "Sandbox", branch: "main", repos: [], related: ["harbor-berths"] });
      const path = join(dir, "projects.toml");
      await writeFile(path, ["[[project]]", 'id = "sandbox"', 'name = "Renamed"', "repos = []"].join("\n"));
      await new ProjectsRegistry(store.db, path).importFromToml();
      expect(getProject(store.db, "sandbox")?.related).toEqual(["harbor-berths"]);
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function doc(overrides: Partial<KnowledgeDoc>): KnowledgeDoc {
  const projectId = overrides.projectId ?? "harbor-berths";
  const slug = overrides.slug ?? "doc";
  return {
    id: `${projectId}-${slug}`,
    projectId,
    slug,
    title: slug,
    body: "body",
    updatedAt: new Date("2026-08-16T00:00:00Z"),
    filePath: `/x/${projectId}/${slug}.md`,
    originClass: "owner",
    scope: "project",
    sourceKind: "runbook",
    ...overrides,
  };
}

// The harbor product: the berths project holds the current tide-tables spec,
// the console asks about it. Filler gives bm25 a real idf.
function seedHarbor(knowledge: KnowledgeStore): void {
  knowledge.upsertDoc(
    doc({
      slug: "harbor-tide-tables",
      title: "Harbor tide tables",
      body: "The tide tables v0.2 pin the arrival window and mooring classes for every berth scheduler caller.",
      sourceKind: "spec",
    })
  );
  knowledge.upsertDoc(
    doc({
      projectId: "billing",
      slug: "billing-tide-tables",
      title: "Billing tide tables",
      body: "The tide tables for billing pin the arrival window and mooring classes for invoices.",
      sourceKind: "spec",
    })
  );
  const topics = [
    "office plants watering schedule",
    "team offsite travel booking",
    "holiday calendar for the year",
    "coffee machine descaling steps",
    "parking garage access cards",
    "desk booking etiquette",
    "printer toner replacement",
    "visitor badge process",
    "recycling bins on each floor",
    "conference room naming",
  ];
  topics.forEach((body, i) =>
    knowledge.upsertDoc(doc({ projectId: "harbor-console", slug: `filler-${i}`, body, sourceKind: "unclassified" }))
  );
}

describe("retrieval over related projects", () => {
  function seeded() {
    const store = createStore(":memory:");
    for (const id of ["harbor-berths", "harbor-console", "billing"]) {
      upsertProject(store.db, { id, name: id, branch: "main", repos: [], ...(id === "harbor-console" ? { related: ["harbor-berths"] } : {}) });
    }
    const knowledge = new KnowledgeStore(store.db);
    seedHarbor(knowledge);
    return { store, knowledge };
  }

  test("launch injection's product pass picks up a related project's spec, not an unrelated one's", async () => {
    const { store } = seeded();
    const relatedProjectIds = relatedProjects("harbor-console", getProjects(store.db));
    expect(relatedProjectIds).toEqual(["harbor-berths"]);
    const query = "tide tables arrival window mooring classes";
    const related = await retrieveProductKnowledge(store.db, "harbor-console", query, null, {}, {
      projectId: "harbor-console",
      relatedProjectIds,
    });
    expect(related.map((r) => r.slug)).toEqual(["harbor-tide-tables"]);
    const alone = await retrieveProductKnowledge(store.db, "harbor-console", query, null, {}, { projectId: "harbor-console" });
    expect(alone).toEqual([]);
    store.close();
  });

  test("an agent's search reaches a related project's spec and still withholds an unrelated project's", async () => {
    const { store } = seeded();
    const search = async (relatedProjectIds?: string[]) =>
      (
        await new LocalMarkdownBackend(store.db).search("harbor-console", "tide tables mooring classes", {
          corpus: "all",
          limit: 20,
          audience: { projectId: "harbor-console", ...(relatedProjectIds ? { relatedProjectIds } : {}) },
        })
      ).map((h) => `${h.projectId}/${h.slug}`);
    const withRelation = await search(relatedProjects("harbor-console", getProjects(store.db)));
    expect(withRelation).toContain("harbor-berths/harbor-tide-tables");
    expect(withRelation.some((ref) => ref.startsWith("billing/"))).toBe(false);
    const withoutRelation = await search();
    expect(withoutRelation).not.toContain("harbor-berths/harbor-tide-tables");
    store.close();
  });
});
