import { expect, test, describe } from "bun:test";
import { createStore } from "@standup/store";
import { DISPUTED_CONFIDENCE, KnowledgeStore, type DraftDispute, type KnowledgeDoc, type SearchResult } from "@standup/knowledge";
import {
  DISPUTED_INJECTION_MARKER,
  MAX_QUOTED_DISPUTE_CLAIM,
  formatCodeKnowledgeInjection,
  quotableDisputeClaim,
  retrieveCodeKnowledge,
} from "./launcher.js";
import type { GatedCandidate } from "./retrieval-telemetry.js";

/**
 * Launch injection of a disputed doc: admitted at the rank the search's trust
 * demotion gives it, so it fills a slot only when no clean doc of comparable
 * relevance ranks above it, and always rendered with its dispute marker. A
 * superseded doc stays held out.
 */

const NOW = new Date().toISOString();

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
    sourceKind: "code",
    ...overrides,
  };
}

/** Unrelated docs so idf means something and the matching docs clear the relevance floor. */
function seedFiller(knowledge: KnowledgeStore): void {
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
    knowledge.upsertDoc(doc({ id: `filler-${i}`, slug: `filler-${i}`, title: `Filler ${i}`, body, sourceKind: "unclassified" }))
  );
}

const MATCH = "The webhook retry worker replays failed deliveries with exponential backoff and a dead letter queue.";
const QUERY = "webhook retry worker exponential backoff dead letter queue";
const DISPUTE: DraftDispute = {
  claim: "replays failed deliveries with exponential backoff",
  finding: "the worker uses a fixed delay",
  evidence: "rg backoff src/webhooks",
};

function addDisputed(knowledge: KnowledgeStore, slug: string, body: string, disputes: DraftDispute[] = [DISPUTE]): void {
  knowledge.upsertDoc(
    doc({
      id: slug,
      slug,
      title: "Delivery notes",
      body,
      originClass: "agent",
      confidence: DISPUTED_CONFIDENCE,
      lastVerifiedAt: NOW,
      halfLifeDays: 90,
    })
  );
  knowledge.setDocVerdict("proj", slug, "disputed", disputes);
}

/** Clean docs as relevant to QUERY as MATCH, each worded differently so none is a near-duplicate of another. */
const CLEAN_MATCHES = [
  "Webhook retry worker: a failed delivery is retried with exponential backoff, then moved to the dead letter queue.",
  "Our webhook retry worker applies exponential backoff; a delivery that keeps failing lands in a dead letter queue.",
  "The retry worker behind webhook delivery uses exponential backoff and parks poison messages in a dead letter queue.",
];

function addClean(knowledge: KnowledgeStore, slug: string, body: string): void {
  knowledge.upsertDoc(doc({ id: slug, slug, title: `Notes ${slug}`, body }));
}

describe("launch injection of a disputed doc", () => {
  test("a disputed doc of similar relevance is admitted below the clean one, with its marker and claim", async () => {
    const store = createStore(":memory:");
    const knowledge = new KnowledgeStore(store.db);
    seedFiller(knowledge);
    addDisputed(knowledge, "disputed-retry", MATCH);
    addClean(knowledge, "clean-retry", CLEAN_MATCHES[0]);

    const gated: GatedCandidate<SearchResult>[] = [];
    const injected = await retrieveCodeKnowledge(store.db, "proj", QUERY, null, {}, undefined, gated);

    expect(injected.map((r) => r.slug)).toEqual(["clean-retry", "disputed-retry"]);
    const disputed = injected[1];
    expect(disputed.verdict).toBe("disputed");
    expect(disputed.disputeClaim).toBe(DISPUTE.claim);
    // Comparable relevance: the order comes from the trust demotion, not a weaker match.
    expect(disputed.relevance!).toBeGreaterThan(injected[0].relevance! * 0.8);
    // Admitted, so no gate reports it.
    expect(gated.find((g) => g.hit.slug === "disputed-retry")).toBeUndefined();

    const block = formatCodeKnowledgeInjection(injected);
    expect(block.includedDocs.map((d) => d.slug)).toEqual(["clean-retry", "disputed-retry"]);
    expect(block.text).toContain(`(proj/disputed-retry) ${DISPUTED_INJECTION_MARKER}`);
    expect(block.text).toContain(`disputed claim: "${DISPUTE.claim}"`);
    expect(block.text).not.toContain(`(proj/clean-retry) ${DISPUTED_INJECTION_MARKER}`);
    // A disputed doc is not dated stale for its dispute's written-down confidence.
    expect(disputed.title).not.toContain("stale since");
    store.close();
  });

  test("a disputed doc that is the only match is admitted, marked", async () => {
    const store = createStore(":memory:");
    const knowledge = new KnowledgeStore(store.db);
    seedFiller(knowledge);
    addDisputed(knowledge, "disputed-retry", MATCH);

    const injected = await retrieveCodeKnowledge(store.db, "proj", QUERY);
    expect(injected.map((r) => r.slug)).toEqual(["disputed-retry"]);
    expect(formatCodeKnowledgeInjection(injected).text).toContain(DISPUTED_INJECTION_MARKER);
    store.close();
  });

  test("clean comparable docs fill the cap and the disputed one is cut off, not gated for its verdict", async () => {
    const store = createStore(":memory:");
    const knowledge = new KnowledgeStore(store.db);
    seedFiller(knowledge);
    addDisputed(knowledge, "disputed-retry", MATCH);
    ["clean-a", "clean-b", "clean-c"].forEach((slug, i) => addClean(knowledge, slug, CLEAN_MATCHES[i]));

    const gated: GatedCandidate<SearchResult>[] = [];
    const injected = await retrieveCodeKnowledge(store.db, "proj", QUERY, null, {}, undefined, gated);

    expect(injected.map((r) => r.slug).sort()).toEqual(["clean-a", "clean-b", "clean-c"]);
    expect(gated.filter((g) => g.hit.slug === "disputed-retry").map((g) => g.reason)).toEqual(["cutoff"]);
    store.close();
  });

  test("a superseded doc stays held out while a disputed one beside it is admitted", async () => {
    const store = createStore(":memory:");
    const knowledge = new KnowledgeStore(store.db);
    seedFiller(knowledge);
    addClean(knowledge, "superseded-retry", CLEAN_MATCHES[0]);
    knowledge.setDocVerdict("proj", "superseded-retry", "superseded", []);
    addDisputed(knowledge, "disputed-retry", MATCH);

    const injected = await retrieveCodeKnowledge(store.db, "proj", QUERY);
    expect(injected.map((r) => r.slug)).toEqual(["disputed-retry"]);
    store.close();
  });
});

describe("quotableDisputeClaim", () => {
  const long = "x".repeat(MAX_QUOTED_DISPUTE_CLAIM + 1);
  test.each([
    ["a short fact-check claim is quoted", [DISPUTE], DISPUTE.claim],
    ["whitespace is collapsed", [{ ...DISPUTE, claim: "  uses\n exponential   backoff " }], "uses exponential backoff"],
    ["a claim over the limit is not quoted", [{ ...DISPUTE, claim: long }], undefined],
    ["the first claim that fits is quoted", [{ ...DISPUTE, claim: long }, { ...DISPUTE, claim: "short" }], "short"],
    ["a no-checkout note is skipped", [{ ...DISPUTE, claim: "no checkout", origin: "repo" as const }], undefined],
    ["a claim of exactly the limit is quoted", [{ ...DISPUTE, claim: "y".repeat(MAX_QUOTED_DISPUTE_CLAIM) }], "y".repeat(MAX_QUOTED_DISPUTE_CLAIM)],
    ["no disputes", [], undefined],
  ] as const)("%s", (_name, disputes, expected) => {
    expect(quotableDisputeClaim(disputes as readonly DraftDispute[])).toBe(expected);
  });

  test("undefined disputes", () => {
    expect(quotableDisputeClaim(undefined)).toBeUndefined();
  });
});
