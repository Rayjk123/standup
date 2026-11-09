import { expect, test, describe, afterAll } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { createStore, upsertProject } from "@standup/store";
import { GLOBAL_PROJECT_ID, type HarnessId, type Project } from "@standup/shared";
import { KnowledgeStore, type KnowledgeDoc } from "@standup/knowledge";
import {
  formatCodeKnowledgeInjection,
  launchSession,
  resolveNamedPins,
  type SpawnArgvSpec,
} from "./launcher.js";
import { findNamedDocs, namedSlugTokens } from "./knowledge-named-pins.js";

const dirs: string[] = [];
const savedEnv = {
  HOME: process.env.HOME,
  WORKTREE_ROOT: process.env.STANDUP_WORKTREE_ROOT,
};
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  if (savedEnv.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = savedEnv.HOME;
  if (savedEnv.WORKTREE_ROOT === undefined) delete process.env.STANDUP_WORKTREE_ROOT;
  else process.env.STANDUP_WORKTREE_ROOT = savedEnv.WORKTREE_ROOT;
});

function doc(overrides: Partial<KnowledgeDoc>): KnowledgeDoc {
  return {
    id: randomUUID(),
    projectId: "proj",
    slug: "doc",
    title: "Doc",
    body: "body",
    updatedAt: new Date("2026-08-16T00:00:00Z"),
    filePath: "/x/doc.md",
    sourceKind: "code",
    originClass: "owner",
    ...overrides,
  };
}

/**
 * A scratch project, plus docs homed elsewhere whose
 * bodies share nothing with the task, so only naming them can inject them.
 * HOME + worktree root are sandboxed so the claude folder-trust pre-accept
 * can't touch the real home.
 */
async function seededStore() {
  const root = await mkdtemp(join(tmpdir(), "standup-pin-root-"));
  dirs.push(root);
  process.env.STANDUP_WORKTREE_ROOT = root;
  const home = await mkdtemp(join(tmpdir(), "standup-pin-home-"));
  dirs.push(home);
  process.env.HOME = home;

  const store = createStore(":memory:");
  const id = `pin-${randomUUID().slice(0, 8)}`;
  upsertProject(store.db, { id, name: "Pin", branch: "main", repos: [] });

  const k = new KnowledgeStore(store.db);
  const unrelated = "zebra quartz lantern harbor";
  // A product doc homed in the global corpus: outside the product pass's
  // corpus partition, inside the scope gate.
  k.upsertDoc(
    doc({
      projectId: GLOBAL_PROJECT_ID,
      slug: "billing-platform-overview",
      title: "OverviewMarker",
      body: unrelated,
      sourceKind: "product",
      scope: "global",
    })
  );
  // An unclassified doc homed in another project, shared globally.
  k.upsertDoc(
    doc({
      projectId: "other",
      slug: "billing-platform-frozen-contracts",
      title: "FrozenMarker",
      body: unrelated,
      sourceKind: "unclassified",
      scope: "global",
    })
  );
  // Another project's own doc: out of scope for this launch.
  k.upsertDoc(
    doc({
      projectId: "other",
      slug: "other-private-design",
      title: "OutOfScopeMarker",
      body: unrelated,
      scope: "project",
    })
  );
  for (const [slug, title, verdict] of [
    ["contradicted-named-doc", "ContradictedMarker", "contradicted"],
    ["superseded-named-doc", "SupersededMarker", "superseded"],
    ["disputed-named-doc", "DisputedMarker", "disputed"],
  ] as const) {
    k.upsertDoc(doc({ projectId: id, slug, title, body: unrelated, scope: "project" }));
    store.db.run("UPDATE knowledge SET verdict = ? WHERE project_id = ? AND slug = ?", [verdict, id, slug]);
  }
  // A doc the task both names and matches on its words.
  k.upsertDoc(
    doc({
      projectId: id,
      slug: "retry-handler-design",
      title: "RankedMarker",
      body: "authwidget handler retry logic backoff",
      scope: "project",
    })
  );

  return { store, project: { id, name: "Pin", branch: "main", repos: [] } as Project };
}

function recordingSeam() {
  const calls: { harness: HarnessId; spec: SpawnArgvSpec }[] = [];
  const buildSpawnArgv = (harness: HarnessId, spec: SpawnArgvSpec): string[] => {
    calls.push({ harness, spec });
    return ["true"];
  };
  return { calls, deps: { buildSpawnArgv } };
}

async function launchPrompt(task: string) {
  const { store, project } = await seededStore();
  const { calls, deps } = recordingSeam();
  const result = await launchSession(store.db, { project, task, retrievalUser: undefined }, undefined, undefined, deps);
  await result.done;
  expect(calls).toHaveLength(1);
  return { prompt: calls[0].spec.prompt, store, project };
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("namedSlugTokens", () => {
  test("takes backticked slugs and bare kebab-case words with two or more hyphens, in order", () => {
    expect(
      namedSlugTokens("Read `billing-platform-frozen-contracts`, then billing-platform-overview. Also `glossary` and re-try.")
    ).toEqual(["billing-platform-frozen-contracts", "billing-platform-overview", "glossary"]);
  });

  test("a single-hyphen bare word is not a candidate", () => {
    expect(namedSlugTokens("fix the follow-up in read-only mode")).toEqual([]);
  });
});

describe("launch injection pins docs the task names", () => {
  test("an in-scope doc homed in another project is injected into its block, marked named", async () => {
    const { prompt, store } = await launchPrompt(
      "Implement drafts per `billing-platform-frozen-contracts` and billing-platform-overview."
    );
    expect(prompt).toContain("OverviewMarker");
    expect(prompt).toContain("FrozenMarker");
    expect(prompt).toContain(`(${GLOBAL_PROJECT_ID}/billing-platform-overview) (named in task)`);
    expect(prompt).toContain("(other/billing-platform-frozen-contracts) (named in task)");
    // The product doc lands in the product block, the unclassified one in the code block.
    const productAt = prompt.indexOf("Product & spec context");
    const codeAt = prompt.indexOf("Relevant code knowledge");
    expect(prompt.indexOf("OverviewMarker")).toBeGreaterThan(productAt);
    expect(prompt.indexOf("FrozenMarker")).toBeGreaterThan(codeAt);
    expect(prompt.indexOf("FrozenMarker")).toBeLessThan(productAt);
    store.close();
  });

  test("a named doc outside the scope gate is not injected", async () => {
    const { prompt, store } = await launchPrompt("Follow other-private-design for this change.");
    expect(prompt).not.toContain("OutOfScopeMarker");
    store.close();
  });

  test("a contradicted or superseded named doc is not injected", async () => {
    const { prompt, store } = await launchPrompt("Check contradicted-named-doc and superseded-named-doc first.");
    expect(prompt).not.toContain("ContradictedMarker");
    expect(prompt).not.toContain("SupersededMarker");
    store.close();
  });

  test("a disputed named doc is injected with its dispute banner", async () => {
    const { prompt, store } = await launchPrompt("Revisit disputed-named-doc.");
    expect(prompt).toContain("DisputedMarker");
    expect(prompt).toContain("⚠ DISPUTED by re-verification");
    store.close();
  });

  test("a doc both named and ranked is injected and recorded once, as named", async () => {
    const { prompt, store } = await launchPrompt("authwidget handler retry logic, see retry-handler-design");
    expect(count(prompt, "RankedMarker")).toBe(1);
    expect(prompt).toContain("/retry-handler-design) (named in task)");
    const rows = store.db
      .query("SELECT injected, components_json, drop_reason FROM knowledge_retrievals WHERE doc_slug = ?")
      .all("retry-handler-design") as Array<{ injected: number; components_json: string | null; drop_reason: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].injected).toBe(1);
    expect(JSON.parse(rows[0].components_json ?? "{}").namedInTask).toBe(1);
    store.close();
  });
});

describe("resolveNamedPins", () => {
  test("pins at most three docs, in the order the task names them", async () => {
    const { store, project } = await seededStore();
    const pins = resolveNamedPins(
      store.db,
      "disputed-named-doc retry-handler-design billing-platform-overview billing-platform-frozen-contracts",
      { projectId: project.id }
    );
    expect([...pins.code, ...pins.product].map((d) => d.slug).sort()).toEqual(
      ["disputed-named-doc", "retry-handler-design", "billing-platform-overview"].sort()
    );
    expect(pins.product.map((d) => d.slug)).toEqual(["billing-platform-overview"]);
    expect(pins.ids.size).toBe(3);
    store.close();
  });

  test("a product pin is limited to the launching, related and global homes", async () => {
    const { store, project } = await seededStore();
    const k = new KnowledgeStore(store.db);
    const sibling = `${project.id}-sibling`;
    upsertProject(store.db, { id: sibling, name: "Sibling", branch: "main", repos: [] });
    for (const [projectId, slug, sourceKind] of [
      ["other", "foreign-product-spec", "spec"],
      [sibling, "sibling-product-spec", "spec"],
      ["other", "foreign-global-runbook", "runbook"],
    ] as const) {
      k.upsertDoc(doc({ projectId, slug, title: slug, sourceKind, scope: "global" }));
    }
    const pins = resolveNamedPins(store.db, "foreign-product-spec sibling-product-spec foreign-global-runbook", {
      projectId: project.id,
      relatedProjectIds: [sibling],
    });
    expect(pins.product.map((d) => d.slug)).toEqual(["sibling-product-spec"]);
    expect(pins.code.map((d) => d.slug)).toEqual(["foreign-global-runbook"]);
    store.close();
  });

  test("the first pinned doc is admitted even when it alone overflows the budget", async () => {
    const { store, project } = await seededStore();
    const [first, second] = findNamedDocs(store.db, "retry-handler-design disputed-named-doc", { projectId: project.id });
    const block = formatCodeKnowledgeInjection([first, second], 10);
    expect(block.includedDocs).toEqual([first]);
    expect(block.text).toContain("(named in task)");
    store.close();
  });
});
