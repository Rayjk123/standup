import { describe, expect, test } from "bun:test";
import { createStore } from "@standup/store";
import { GLOBAL_PROJECT_ID } from "@standup/shared";
import {
  KnowledgeStore,
  planInjection,
  ACTIVITY_INJECT_MIN_RELEVANCE,
  FOREIGN_INTENT_INJECT_MIN_RELEVANCE,
  type KnowledgeDoc,
  type SearchResult,
} from "@standup/knowledge";
import { retrieveCodeKnowledge, retrieveProductKnowledge } from "./launcher.js";
import type { GatedCandidate } from "./retrieval-telemetry.js";

/**
 * Task-aware launch injection: the brief's injection plan (queries, task type,
 * forbidden actions) drives retrieveCodeKnowledge / retrieveProductKnowledge —
 * per-query results fused, forbidden runbooks and weak or old activity notes
 * held back, and global-corpus product intent in reach of the product block.
 */

const DAY = 86_400_000;

function doc(overrides: Partial<KnowledgeDoc> = {}): KnowledgeDoc {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    projectId: "proj",
    slug: "doc",
    title: "Doc",
    body: "body",
    updatedAt: new Date(Date.now() - 2 * DAY),
    filePath: "/x/doc.md",
    originClass: "owner",
    ...overrides,
  };
}

/** Unrelated docs so idf carries evidence and the relevance floor means something. */
function seedFiller(knowledge: KnowledgeStore): void {
  [
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
  ].forEach((body, i) =>
    knowledge.upsertDoc(doc({ id: `filler-${i}`, slug: `filler-${i}`, title: `Filler ${i}`, body, sourceKind: "unclassified" }))
  );
}

function seeded() {
  const store = createStore(":memory:");
  const knowledge = new KnowledgeStore(store.db);
  seedFiller(knowledge);
  return { store, knowledge };
}

describe("forbidden runbooks", () => {
  function seedRunbooks(knowledge: KnowledgeStore) {
    knowledge.upsertDoc(
      doc({
        id: "review-runbook",
        slug: "pull-request-workflow",
        title: "Widget catalog preview editor pull request workflow",
        body: "To open the pull request for a widget catalog preview editor change with live HTML checking: rebase, squash, then gh pr create.",
        sourceKind: "runbook",
        tags: ["pull-request", "code-review"],
      })
    );
    knowledge.upsertDoc(
      doc({
        id: "editor-code",
        slug: "preview-editor",
        title: "Widget catalog preview editor",
        body: "The widget catalog preview editor is a CodeMirror instance with live HTML checking for the preview.",
        sourceKind: "code",
      })
    );
  }

  test("a runbook about opening pull requests is held back when the brief forbids them", async () => {
    const { store, knowledge } = seeded();
    seedRunbooks(knowledge);
    const gated: GatedCandidate<SearchResult>[] = [];
    const brief = "Build the widget catalog preview editor with live HTML checking. Don't open PRs for the preview change.";
    const got = await retrieveCodeKnowledge(store.db, "proj", brief, null, {}, undefined, gated);
    expect(got.map((r) => r.slug)).toEqual(["preview-editor"]);
    expect(gated.filter((g) => g.reason === "forbidden").map((g) => g.hit.slug)).toEqual(["pull-request-workflow"]);
    store.close();
  });

  test("the same runbook is injected when the brief asks for the pull request", async () => {
    const { store, knowledge } = seeded();
    seedRunbooks(knowledge);
    const brief = "Build the widget catalog preview editor with live HTML checking, then open the pull request for the preview change.";
    const got = await retrieveCodeKnowledge(store.db, "proj", brief);
    expect(got.map((r) => r.slug)).toContain("pull-request-workflow");
    store.close();
  });
});

describe("activity notes", () => {
  const TASK = "codex harness adapter design";
  const NOTE_BODY = "Codex harness adapter design: the adapter maps codex events onto the claude session model.";
  const note = (id: string, ageDays: number) =>
    doc({
      id,
      slug: `native-mem-memory-${id}`,
      title: "Codex harness adapter design",
      body: NOTE_BODY,
      sourceKind: "native-memory",
      updatedAt: new Date(Date.now() - ageDays * DAY),
      generatedAt: new Date(Date.now() - ageDays * DAY).toISOString(),
    });

  test("a relevant activity note from this week is injected in the code block", async () => {
    const { store, knowledge } = seeded();
    knowledge.upsertDoc(note("recent", 3));
    const got = await retrieveCodeKnowledge(store.db, "proj", TASK);
    expect(got.map((r) => r.slug)).toEqual(["native-mem-memory-recent"]);
    expect(got[0]!.relevance!).toBeGreaterThanOrEqual(ACTIVITY_INJECT_MIN_RELEVANCE);
    store.close();
  });

  test("the same note written two months ago is held back as activity", async () => {
    const { store, knowledge } = seeded();
    knowledge.upsertDoc(note("old", 60));
    const gated: GatedCandidate<SearchResult>[] = [];
    const got = await retrieveCodeKnowledge(store.db, "proj", TASK, null, {}, undefined, gated);
    expect(got).toEqual([]);
    const held = gated.find((g) => g.hit.slug === "native-mem-memory-old");
    expect(held?.reason).toBe("activity");
    // Held for its age: it clears the relevance bar.
    expect(held!.hit.relevance!).toBeGreaterThanOrEqual(ACTIVITY_INJECT_MIN_RELEVANCE);
    store.close();
  });

  test("a recent note below the relevance bar is held back as activity", async () => {
    const { store, knowledge } = seeded();
    knowledge.upsertDoc(note("weak", 3));
    const gated: GatedCandidate<SearchResult>[] = [];
    const got = await retrieveCodeKnowledge(store.db, "proj", "codex harness adapter design for codex events in the claude session console", null, {}, undefined, gated);
    expect(got).toEqual([]);
    const held = gated.find((g) => g.hit.slug === "native-mem-memory-weak");
    expect(held?.reason).toBe("activity");
    expect(held!.hit.relevance!).toBeLessThan(ACTIVITY_INJECT_MIN_RELEVANCE);
    store.close();
  });

  test("a native-memory CLAUDE.md mirror is never injected", async () => {
    const { store, knowledge } = seeded();
    knowledge.upsertDoc(
      doc({
        id: "mirror",
        slug: "native-mem-claude-md",
        title: "Project CLAUDE.md",
        body: NOTE_BODY,
        sourceKind: "native-memory",
      })
    );
    const got = await retrieveCodeKnowledge(store.db, "proj", TASK);
    expect(got).toEqual([]);
    store.close();
  });

  test("the product block never takes activity notes", async () => {
    const { store, knowledge } = seeded();
    knowledge.upsertDoc(note("recent", 3));
    expect(await retrieveProductKnowledge(store.db, "proj", TASK)).toEqual([]);
    store.close();
  });
});

describe("product block reach", () => {
  function seedIntent(knowledge: KnowledgeStore) {
    knowledge.upsertDoc(
      doc({
        id: "global-brief",
        projectId: GLOBAL_PROJECT_ID,
        slug: "widget-catalog-design-brief",
        title: "Widget catalog design brief",
        body: "The widget catalog console preview checks each widget against every rule in a theme.",
        sourceKind: "spec",
        scope: "global",
      })
    );
    knowledge.upsertDoc(
      doc({
        id: "foreign-brief",
        projectId: "other",
        slug: "other-design-brief",
        title: "Other widget catalog design brief",
        body: "The widget catalog console preview checks each widget against every rule in a theme.",
        sourceKind: "spec",
        scope: "global",
      })
    );
  }

  test("a global-corpus spec reaches the product block; another project's scope=global spec does not", async () => {
    const { store, knowledge } = seeded();
    seedIntent(knowledge);
    const got = await retrieveProductKnowledge(store.db, "proj", "widget catalog console preview theme rule", null, {}, {
      projectId: "proj",
    });
    expect(got.map((r) => `${r.projectId}/${r.slug}`)).toEqual([`${GLOBAL_PROJECT_ID}/widget-catalog-design-brief`]);
    store.close();
  });

  test("the launching project's own spec outranks an equally relevant global one", async () => {
    const { store, knowledge } = seeded();
    seedIntent(knowledge);
    knowledge.upsertDoc(
      doc({
        id: "own-brief",
        slug: "console-preview-spec",
        title: "Widget catalog design brief",
        body: "The widget catalog console preview checks each widget against every rule in a theme.",
        sourceKind: "spec",
      })
    );
    const got = await retrieveProductKnowledge(store.db, "proj", "widget catalog console preview theme rule", null, {}, {
      projectId: "proj",
    });
    expect(got[0]?.slug).toBe("console-preview-spec");
    store.close();
  });

  const CONTRACT = {
    title: "Render API contracts",
    body: "StartRender takes the widget, its format and an optional source label; GetRenderResult gives one answer per rule, polled until none is running.",
    sourceKind: "spec" as const,
  };
  const UNRELATED_BRIEF = "Record the source label of each rule answer in metrics";

  test("a global spec matching only a few words of an unrelated brief is held at the floor", async () => {
    const { store, knowledge } = seeded();
    knowledge.upsertDoc(doc({ id: "global-contract", projectId: GLOBAL_PROJECT_ID, slug: "frozen-contracts", scope: "global", ...CONTRACT }));
    const gated: GatedCandidate<SearchResult>[] = [];
    const got = await retrieveProductKnowledge(store.db, "proj", UNRELATED_BRIEF, null, {}, { projectId: "proj" }, gated);
    expect(got).toEqual([]);
    const held = gated.find((g) => g.hit.slug === "frozen-contracts");
    expect(held?.reason).toBe("floor");
    expect(held!.hit.relevance!).toBeLessThan(FOREIGN_INTENT_INJECT_MIN_RELEVANCE);
    store.close();
  });

  test("the project's own spec with the same weak match is still injected", async () => {
    const { store, knowledge } = seeded();
    knowledge.upsertDoc(doc({ id: "own-contract", slug: "frozen-contracts", ...CONTRACT }));
    const got = await retrieveProductKnowledge(store.db, "proj", UNRELATED_BRIEF, null, {}, { projectId: "proj" });
    expect(got.map((r) => r.slug)).toEqual(["frozen-contracts"]);
    expect(got[0]!.relevance!).toBeLessThan(FOREIGN_INTENT_INJECT_MIN_RELEVANCE);
    store.close();
  });
});

describe("fused queries", () => {
  test("a doc both queries find leads, and each query's own hit is still recalled", async () => {
    const { store, knowledge } = seeded();
    knowledge.upsertDoc(
      doc({ id: "l", slug: "ledger-reconcile", title: "Ledger reconcile", body: "The nightly ledger reconcile job compares invoices.", sourceKind: "code" })
    );
    knowledge.upsertDoc(
      doc({ id: "r", slug: "refund-window", title: "Refund window", body: "Refunds are accepted inside a thirty day refund window.", sourceKind: "code" })
    );
    knowledge.upsertDoc(
      doc({
        id: "b",
        slug: "refund-ledger",
        title: "Refund ledger reconcile",
        body: "The ledger reconcile job posts each refund inside the refund window.",
        sourceKind: "code",
      })
    );
    const plan = { ...planInjection("ledger reconcile"), queries: ["ledger reconcile", "refund window"] };
    const got = await retrieveCodeKnowledge(store.db, "proj", plan);
    expect(got[0]?.slug).toBe("refund-ledger");
    expect(new Set(got.map((r) => r.slug))).toEqual(new Set(["refund-ledger", "ledger-reconcile", "refund-window"]));
    store.close();
  });
});
