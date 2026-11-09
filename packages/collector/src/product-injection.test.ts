import { expect, test, describe } from "bun:test";
import { createStore } from "@standup/store";
import { KnowledgeStore, type KnowledgeDoc, type SearchResult } from "@standup/knowledge";
import {
  retrieveProductKnowledge,
  retrieveCodeKnowledge,
  formatProductKnowledgeInjection,
  formatCodeKnowledgeInjection,
  buildInjectRetrievalRecords,
  buildOpeningPrompt,
  resolveRetrievalQuery,
  PRODUCT_KNOWLEDGE_KINDS,
  CODE_KNOWLEDGE_KINDS,
} from "./launcher.js";

/**
 * Code-first + product-knowledge injection (roadmap r8): at launch, the highest-
 * relevance product/spec docs for the task are retrieved and injected alongside
 * the code-first knowledge steering, clearly labeled and bounded, so the agent
 * has product intent while implementing. Code vs product knowledge stay
 * distinguishable (the SearchResult carries source_kind).
 */

function doc(overrides: Partial<KnowledgeDoc> = {}): KnowledgeDoc {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    projectId: "proj",
    slug: "doc",
    title: "Doc",
    body: "body",
    updatedAt: new Date("2026-08-16T00:00:00Z"),
    filePath: "/x/doc.md",
    originClass: "owner",
    ...overrides,
  };
}

/**
 * Unrelated, unclassified docs (never injected) that give the index enough
 * docs for idf to mean something: in a three-doc corpus every shared word is in
 * most docs, so bm25 carries no evidence and nothing clears the relevance floor.
 */
function seedFiller(knowledge: KnowledgeStore, extra = 0): void {
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
  for (let i = 0; i < extra; i++) topics.push(`unrelated housekeeping note number ${i}`);
  topics.forEach((body, i) =>
    knowledge.upsertDoc(doc({ id: `filler-${i}`, slug: `filler-${i}`, title: `Filler ${i}`, body, sourceKind: "unclassified" }))
  );
}

describe("retrieveProductKnowledge", () => {
  test("returns only product/spec docs for a matching task, not code knowledge", async () => {
    const store = createStore(":memory:");
    const knowledge = new KnowledgeStore(store.db);
    seedFiller(knowledge);

    knowledge.upsertDoc(
      doc({
        id: "spec",
        slug: "checkout-spec",
        title: "Checkout flow spec",
        body: "The checkout flow must support guest checkout and saved payment methods.",
        sourceKind: "spec",
      })
    );
    knowledge.upsertDoc(
      doc({
        id: "product",
        slug: "checkout-product",
        title: "Checkout product intent",
        body: "Users abandon checkout when guest checkout is missing; product wants it prioritized.",
        sourceKind: "product",
      })
    );
    knowledge.upsertDoc(
      doc({
        id: "code",
        slug: "checkout-code",
        title: "Checkout code notes",
        body: "The checkout module lives in packages/checkout and uses the payments client.",
        sourceKind: "code",
      })
    );

    const results = await retrieveProductKnowledge(
      store.db,
      "proj",
      "implement guest checkout flow"
    );

    // Both product/spec docs come back; the code doc is filtered out.
    const kinds = new Set(results.map((r) => r.sourceKind));
    expect(results.length).toBeGreaterThan(0);
    for (const k of kinds) expect(PRODUCT_KNOWLEDGE_KINDS).toContain(k);
    // The spec matches most of the task; the product note shares only "guest
    // checkout" with it and sits just under the injection floor.
    expect(results.map((r) => r.slug)).toContain("checkout-spec");
    expect(results.map((r) => r.slug)).not.toContain("checkout-code");
    store.close();
  });

  test("product docs survive a code-heavy corpus (source_kind filter is pushed into SQL, not a post-filter on a mixed top-N)", async () => {
    // The crowd-out case the review flagged: many code docs strongly matching
    // the task, a couple of relevant product/spec docs. If retrieval pulled a
    // small mixed top-N and only THEN filtered to product/spec, the code
    // majority would fill the window and the product docs would be dropped.
    // Pushing source_kind IN ('product','spec') into the query draws the
    // product candidates from their own pool, so they survive regardless.
    const store = createStore(":memory:");
    const knowledge = new KnowledgeStore(store.db);
    // Enough unrelated docs that the 25 code docs are a minority of the index,
    // so the task's words still carry lexical evidence.
    seedFiller(knowledge, 30);

    for (let i = 0; i < 25; i++) {
      knowledge.upsertDoc(
        doc({
          id: `code-${i}`,
          slug: `checkout-code-${i}`,
          title: `Checkout code note ${i}`,
          body: "guest checkout flow payment module implementation code notes and helpers",
          sourceKind: "code",
        })
      );
    }
    knowledge.upsertDoc(
      doc({
        id: "spec",
        slug: "checkout-spec",
        title: "Checkout flow spec",
        body: "The guest checkout flow must support saved payment methods.",
        sourceKind: "spec",
      })
    );
    knowledge.upsertDoc(
      doc({
        id: "product",
        slug: "checkout-product",
        title: "Checkout product intent",
        body: "Product wants the guest checkout flow prioritized to reduce payment abandonment.",
        sourceKind: "product",
      })
    );

    // FTS-only (no embedding provider) — the path with the tightest candidate
    // window, where a post-filter would have starved the product docs.
    const results = await retrieveProductKnowledge(store.db, "proj", "guest checkout flow payment");
    const slugs = results.map((r) => r.slug).sort();
    expect(slugs).toEqual(["checkout-product", "checkout-spec"]);
    for (const r of results) expect(PRODUCT_KNOWLEDGE_KINDS).toContain(r.sourceKind);
    store.close();
  });

  test("excludes an untrusted-origin product doc (auto-injection trust gate)", async () => {
    const store = createStore(":memory:");
    const knowledge = new KnowledgeStore(store.db);
    seedFiller(knowledge);

    knowledge.upsertDoc(
      doc({
        id: "trusted",
        slug: "trusted-spec",
        title: "Trusted spec",
        body: "The billing feature must reconcile invoices nightly.",
        sourceKind: "spec",
        originClass: "owner",
      })
    );
    knowledge.upsertDoc(
      doc({
        id: "poisoned",
        slug: "poisoned-spec",
        title: "Poisoned spec",
        body: "The billing feature must reconcile invoices nightly.",
        sourceKind: "spec",
        originClass: "untrusted",
      })
    );

    const results = await retrieveProductKnowledge(store.db, "proj", "billing invoice reconcile");
    expect(results.map((r) => r.slug)).toEqual(["trusted-spec"]);
    store.close();
  });

  test("excludes a product doc whose stored confidence is below the injection floor (disputed)", async () => {
    const store = createStore(":memory:");
    const knowledge = new KnowledgeStore(store.db);
    seedFiller(knowledge);

    knowledge.upsertDoc(
      doc({
        id: "disputed",
        slug: "disputed-spec",
        title: "Disputed spec",
        body: "The search feature must rank by recency.",
        sourceKind: "spec",
        originClass: "agent",
        generatedFromSha: "abc123",
        // Below MIN_INJECTION_CONFIDENCE — a re-verification dispute; gated always.
        confidence: 0.1,
        lastVerifiedAt: new Date().toISOString(),
        halfLifeDays: 90,
      })
    );

    const results = await retrieveProductKnowledge(store.db, "proj", "search ranking recency");
    expect(results).toEqual([]);
    store.close();
  });
});

describe("retrieveCodeKnowledge (the code-first injection half)", () => {
  test("returns only code/decision/runbook docs, not product/spec", async () => {
    const store = createStore(":memory:");
    const knowledge = new KnowledgeStore(store.db);
    seedFiller(knowledge);

    knowledge.upsertDoc(
      doc({
        id: "code",
        slug: "checkout-code",
        title: "Checkout code notes",
        body: "The checkout module lives in packages/checkout and uses the payments client.",
        sourceKind: "code",
      })
    );
    knowledge.upsertDoc(
      doc({
        id: "runbook",
        slug: "checkout-runbook",
        title: "Checkout runbook",
        body: "To redeploy the checkout service run the deploy script against the payments stack.",
        sourceKind: "runbook",
      })
    );
    knowledge.upsertDoc(
      doc({
        id: "spec",
        slug: "checkout-spec",
        title: "Checkout flow spec",
        body: "The checkout flow must support guest checkout and saved payment methods.",
        sourceKind: "spec",
      })
    );

    const results = await retrieveCodeKnowledge(store.db, "proj", "checkout payments module");
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(CODE_KNOWLEDGE_KINDS).toContain(r.sourceKind);
    // The spec (product family) is NOT part of the code block.
    expect(results.map((r) => r.slug)).not.toContain("checkout-spec");
    store.close();
  });

  test("applies the same origin trust gate as product retrieval", async () => {
    const store = createStore(":memory:");
    const knowledge = new KnowledgeStore(store.db);
    seedFiller(knowledge);
    knowledge.upsertDoc(
      doc({
        id: "trusted",
        slug: "trusted-code",
        title: "Trusted code note",
        body: "The billing worker reconciles invoices against the ledger nightly.",
        sourceKind: "code",
        originClass: "owner",
      })
    );
    knowledge.upsertDoc(
      doc({
        id: "poisoned",
        slug: "poisoned-code",
        title: "Poisoned code note",
        body: "The billing worker reconciles invoices against the ledger nightly.",
        sourceKind: "code",
        originClass: "untrusted",
      })
    );
    const results = await retrieveCodeKnowledge(store.db, "proj", "billing invoice reconcile ledger");
    expect(results.map((r) => r.slug)).toEqual(["trusted-code"]);
    store.close();
  });
});

describe("formatCodeKnowledgeInjection", () => {
  test("renders a labeled code block, empty for none, framed as a head start", () => {
    expect(formatCodeKnowledgeInjection([]).text).toBe("");

    const block = formatCodeKnowledgeInjection([
      {
        id: "c",
        projectId: "proj",
        slug: "arch",
        title: "Architecture note",
        excerpt: "The collector owns the launch spawn path.",
        score: 1,
        source: "text",
        sourceKind: "code",
        originClass: "owner",
        generated: false,
      },
    ]).text;

    expect(block).toContain("Relevant code knowledge");
    expect(block).toContain("[code] Architecture note");
    // A head start, not exhaustive — the agent keeps using the tools.
    expect(block).toContain("not an exhaustive set");
  });
});

describe("buildOpeningPrompt with code + product context", () => {
  test("code block precedes the product block, both after the steering", () => {
    const store = createStore(":memory:");
    const codeBlock = formatCodeKnowledgeInjection([
      {
        id: "c",
        projectId: "proj",
        slug: "arch",
        title: "Architecture note",
        excerpt: "The collector owns the launch spawn path.",
        score: 1,
        source: "text",
        sourceKind: "code",
        originClass: "owner",
        generated: false,
      },
    ]);
    const productBlock = formatProductKnowledgeInjection([
      {
        id: "p",
        projectId: "proj",
        slug: "intent",
        title: "Product intent",
        excerpt: "Ship guest checkout.",
        score: 1,
        source: "text",
        sourceKind: "product",
        originClass: "owner",
        generated: false,
      },
    ]);

    const prompt = buildOpeningPrompt(
      store.db,
      "Do the task",
      undefined,
      "proj",
      undefined,
      productBlock.text,
      codeBlock.text
    );

    expect(prompt).toContain("Relevant code knowledge");
    expect(prompt).toContain("Product & spec context");
    // Steering first, then code, then product.
    const steer = prompt.indexOf("search_knowledge");
    const code = prompt.indexOf("Relevant code knowledge");
    const product = prompt.indexOf("Product & spec context");
    expect(steer).toBeLessThan(code);
    expect(code).toBeLessThan(product);
    store.close();
  });
});

describe("resolveRetrievalQuery (linked-ticket targeting)", () => {
  test("prefers the linked-ticket context over the task string when present", () => {
    // A launch fired from a ticket runs against the ticket's own title+body,
    // not the task with its "Implement this fix." dispatch boilerplate.
    expect(
      resolveRetrievalQuery(
        "Guest checkout\n\nSupport guest checkout.\n\nImplement this fix.",
        "Guest checkout\n\nSupport guest checkout."
      )
    ).toBe("Guest checkout\n\nSupport guest checkout.");
  });

  test("falls back to the task for a plain launch (no context) or a blank one", () => {
    expect(resolveRetrievalQuery("do the task")).toBe("do the task");
    expect(resolveRetrievalQuery("do the task", "   ")).toBe("do the task");
  });
});

describe("retrieveProductKnowledge — linked-ticket context drives recall", () => {
  test("the ticket's title+body surfaces its spec where a terse task string misses it", async () => {
    const store = createStore(":memory:");
    const knowledge = new KnowledgeStore(store.db);
    seedFiller(knowledge);
    knowledge.upsertDoc(
      doc({
        id: "spec",
        slug: "refund-spec",
        title: "Refund policy spec",
        body: "Refunds must be issued within 30 days and reconciled nightly against the ledger.",
        sourceKind: "spec",
        originClass: "owner",
      })
    );

    // A terse dispatch string shares no vocabulary with the spec → no recall.
    const terse = await retrieveProductKnowledge(store.db, "proj", "fix it");
    expect(terse).toEqual([]);

    // The linked ticket's own title+body (what the ticket path now passes as the
    // retrieval query) does surface the spec.
    const linked = await retrieveProductKnowledge(
      store.db,
      "proj",
      resolveRetrievalQuery("fix it", "Refund reconciliation\n\nRefunds must reconcile against the ledger nightly.")
    );
    expect(linked.map((r) => r.slug)).toContain("refund-spec");
    store.close();
  });
});

describe("formatProductKnowledgeInjection", () => {
  test("renders a labeled block distinguishing product from spec, empty for none", () => {
    expect(formatProductKnowledgeInjection([]).text).toBe("");

    const block = formatProductKnowledgeInjection([
      {
        id: "p",
        projectId: "proj",
        slug: "intent",
        title: "Product intent",
        excerpt: "Guest checkout is the top priority.",
        score: 1,
        source: "text",
        sourceKind: "product",
        originClass: "owner",
        generated: false,
      },
      {
        id: "s",
        projectId: "proj",
        slug: "spec",
        title: "Checkout spec",
        excerpt: "Must support saved cards.",
        score: 0.9,
        source: "text",
        sourceKind: "spec",
        originClass: "owner",
        generated: false,
      },
    ]).text;

    // Clearly labeled as product/spec context, and each doc headed with its kind.
    expect(block).toContain("Product & spec context");
    expect(block).toContain("[product] Product intent");
    expect(block).toContain("[spec] Checkout spec");
    // It positions itself as grounding, not a replacement for the code-first tools.
    expect(block).toContain("does not replace");
  });

  test("caps the block to the character budget (bounded size)", () => {
    const big = (slug: string): SearchResult => ({
      id: slug,
      projectId: "proj",
      slug,
      title: slug,
      excerpt: "x".repeat(500),
      score: 1,
      source: "text",
      sourceKind: "product",
      originClass: "owner",
      generated: false,
    });
    const results = [big("a"), big("b"), big("c")];

    // Budget only fits the first doc plus a little; the rest are dropped.
    const block = formatProductKnowledgeInjection(results, 700).text;
    expect(block).toContain("[product] a");
    expect(block).not.toContain("[product] b");
    expect(block).not.toContain("[product] c");
  });
});

describe("buildOpeningPrompt with product context", () => {
  test("appends the product block after the code-first steering", () => {
    const store = createStore(":memory:");
    const productBlock = formatProductKnowledgeInjection([
      {
        id: "p",
        projectId: "proj",
        slug: "intent",
        title: "Product intent",
        excerpt: "Ship guest checkout.",
        score: 1,
        source: "text",
        sourceKind: "product",
        originClass: "owner",
        generated: false,
      },
    ]);

    const prompt = buildOpeningPrompt(
      store.db,
      "Do the task",
      undefined,
      "proj",
      undefined,
      productBlock.text
    );

    expect(prompt).toContain("Do the task");
    // Code-first steering is still present...
    expect(prompt).toContain("search_knowledge");
    // ...and the product context rides alongside it.
    expect(prompt).toContain("Product & spec context");
    expect(prompt).toContain("[product] Product intent");
    // Ordering: the product block comes after the knowledge-first steering.
    expect(prompt.indexOf("search_knowledge")).toBeLessThan(
      prompt.indexOf("Product & spec context")
    );
    store.close();
  });

  test("no product context passed leaves the prompt exactly as before", () => {
    const store = createStore(":memory:");
    const withEmpty = buildOpeningPrompt(store.db, "Task", undefined, "proj", undefined, "");
    const withoutArg = buildOpeningPrompt(store.db, "Task", undefined, "proj");
    expect(withEmpty).toBe(withoutArg);
    expect(withEmpty).not.toContain("Product & spec context");
    store.close();
  });
});

describe("injection telemetry — includedDocs + buildInjectRetrievalRecords (K2)", () => {
  const res = (slug: string, chars: number, score = 1): SearchResult => ({
    id: slug,
    projectId: "proj",
    slug,
    title: slug,
    excerpt: "x".repeat(chars),
    score,
    source: "text",
    sourceKind: "product",
    originClass: "owner",
    generated: false,
  });

  test("the format wrapper reports which docs the char budget admitted", () => {
    // Budget fits only the first doc; the trailing two overflow and are dropped.
    const results = [res("a", 500), res("b", 500), res("c", 500)];
    const { text, includedDocs } = formatProductKnowledgeInjection(results, 700);
    expect(text).toContain("[product] a");
    expect(includedDocs.map((d) => d.slug)).toEqual(["a"]);
  });

  test("maps each top-K candidate to an inject row flagged injected-vs-dropped", () => {
    const codeDocs = [res("code-in", 100), res("code-out", 100, 0.5)];
    const productDocs = [res("prod-in", 100, 0.9)];
    const records = buildInjectRetrievalRecords({
      codeDocs,
      codeIncluded: [codeDocs[0]], // the char budget dropped the second code doc
      productDocs,
      productIncluded: productDocs, // the product doc made it in
      launchId: "L1",
      query: "do the task",
      queryProject: "proj",
    });

    expect(records).toHaveLength(3);
    // Every row is an inject-surface row keyed to the launch, not a session
    // (the session doesn't exist yet at prompt-build time).
    expect(records.every((r) => r.surface === "inject")).toBe(true);
    expect(records.every((r) => r.launchId === "L1")).toBe(true);
    expect(records.every((r) => r.sessionId === undefined)).toBe(true);
    expect(records.every((r) => r.queryProject === "proj")).toBe(true);

    // A dropped doc carries injected:false, its rank within its kind's top-K,
    // and the doc's own score.
    const dropped = records.find((r) => r.docSlug === "code-out");
    expect(dropped?.injected).toBe(false);
    expect(dropped?.rank).toBe(1);
    expect(dropped?.score).toBe(0.5);

    // Admitted docs carry injected:true; rank restarts per kind.
    const codeIn = records.find((r) => r.docSlug === "code-in");
    expect(codeIn?.injected).toBe(true);
    expect(codeIn?.rank).toBe(0);
    const prodIn = records.find((r) => r.docSlug === "prod-in");
    expect(prodIn?.injected).toBe(true);
    expect(prodIn?.rank).toBe(0);
    expect(prodIn?.docProject).toBe("proj");

    // The budget drop is named; an admitted doc carries no drop reason.
    expect(dropped?.dropReason).toBe("budget");
    expect(codeIn?.dropReason).toBeUndefined();
    expect(prodIn?.layer).toBe("intent");
    expect(prodIn?.components).toEqual({ score: 0.9 });
  });

  test("gated candidates become inject rows carrying the gate, with placement from the store", () => {
    const records = buildInjectRetrievalRecords({
      codeDocs: [],
      codeIncluded: [],
      productDocs: [res("prod-in", 100)],
      productIncluded: [res("prod-in", 100)],
      productGated: [
        { hit: res("prod-superseded", 100, 0.7), reason: "verdict" },
        { hit: res("prod-sixth", 100, 0.1), reason: "cutoff" },
      ],
      launchId: "L1",
      query: "do the task",
      queryProject: "proj",
      placementOf: () => ({ scope: "project" }),
    });
    const gated = records.filter((r) => r.dropReason && r.dropReason !== "budget");
    expect(gated.map((r) => [r.docSlug, r.dropReason, r.rank])).toEqual([
      ["prod-superseded", "verdict", 0],
      ["prod-sixth", "cutoff", 1],
    ]);
    expect(gated.every((r) => r.surface === "inject" && r.launchId === "L1" && r.injected === undefined)).toBe(true);
    expect(gated[0].scope).toBe("project");
  });

  test("a launch's gated candidates share one per-query bound across both kinds", () => {
    const many = (prefix: string) =>
      Array.from({ length: 15 }, (_, i) => ({ hit: res(`${prefix}-${i}`, 10), reason: "cutoff" as const }));
    const records = buildInjectRetrievalRecords({
      codeDocs: [],
      codeIncluded: [],
      productDocs: [],
      productIncluded: [],
      codeGated: many("code"),
      productGated: many("prod"),
      launchId: "L1",
      query: "q",
      queryProject: "proj",
    });
    expect(records).toHaveLength(10);
  });

  test("a host home-mirror row keeps its owner, the host user", () => {
    const mirror = { ...res("native-mem-home-claude-md", 10), sourceKind: "native-memory" as const };
    const [row] = buildInjectRetrievalRecords({
      codeDocs: [mirror],
      codeIncluded: [mirror],
      productDocs: [],
      productIncluded: [],
      launchId: "L1",
      query: "q",
      queryProject: "proj",
      hostUser: "host",
    });
    expect(row).toMatchObject({ layer: "personal", docOwner: "host" });
  });
});

describe("launch injection relevance floor", () => {
  function seed() {
    const store = createStore(":memory:");
    const knowledge = new KnowledgeStore(store.db);
    seedFiller(knowledge);
    const docs: Array<[string, string, string]> = [
      ["retry-runbook", "Slack mirror retry runbook", "The Slack mirror retries a failed post three times with jittered backoff."],
      ["deploy-runbook", "Collector deploy runbook", "Deploy the collector by building, migrating the database, then restarting."],
      ["fts-decision", "FTS orphan rows", "Deleting a doc deletes its FTS row in the same transaction."],
      ["scope-decision", "Scope audience gate", "Scoped retrieval admits global, project and the user's own docs."],
    ];
    for (const [slug, title, body] of docs) {
      knowledge.upsertDoc(
        doc({ id: slug, slug, title, body, sourceKind: slug.endsWith("runbook") ? "runbook" : "decision" })
      );
    }
    return store;
  }

  test("an unrelated task that shares one word with a runbook injects nothing", async () => {
    const store = seed();
    const injected = await retrieveCodeKnowledge(
      store.db,
      "proj",
      "retry the sourdough rise with more yeast and a warmer oven"
    );
    expect(injected).toEqual([]);
    store.close();
  });

  test("a task about the runbook's subject still injects it", async () => {
    const store = seed();
    const injected = await retrieveCodeKnowledge(store.db, "proj", "make the slack mirror retry failed posts with backoff");
    expect(injected.map((r) => r.slug)).toContain("retry-runbook");
    store.close();
  });
});

describe("launch injection of an undecided contradiction", () => {
  test("both sides are injected, each with a conflict marker", () => {
    const side = (slug: string, other: string): SearchResult => ({
      id: slug,
      projectId: "proj",
      slug,
      title: slug,
      excerpt: `${slug} says so`,
      score: 1,
      relevance: 0.6,
      source: "text",
      originClass: slug === "plan" ? "owner" : "agent",
      sourceKind: "spec",
      generated: false,
      verdict: "contradicted",
      contradiction: { side: "undecided", counterparts: [`proj/${other}`] },
    });
    const block = formatProductKnowledgeInjection([side("plan", "arch"), side("arch", "plan")]);
    expect(block.includedDocs.map((d) => d.slug)).toEqual(["plan", "arch"]);
    expect(block.text).toContain("⚠ conflicts with proj/arch — unresolved; weigh both");
    expect(block.text).toContain("⚠ conflicts with proj/plan — unresolved; weigh both");
  });
});
