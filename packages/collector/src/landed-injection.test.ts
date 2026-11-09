import { expect, test, describe } from "bun:test";
import { createStore } from "@standup/store";
import { KnowledgeStore, type KnowledgeDoc } from "@standup/knowledge";
import { formatCodeKnowledgeInjection, retrieveCodeKnowledge } from "./launcher.js";
import { bodyHash, LANDING_RULES, landedClaimMarker, recordLandedClaim } from "./knowledge-repo-claims.js";

/**
 * Launch injection of a doc whose "not yet merged" claims have landed: it is
 * headed with the landed marker in place of its stale date, since its
 * merge-status wording is what is out of date.
 */

const BODY = "The webhook retry worker replays failed deliveries with exponential backoff, on branch feat/webhook-retry, not yet merged.";
const QUERY = "webhook retry worker exponential backoff failed deliveries";

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

/** Unrelated docs so idf means something and the matching doc clears the relevance floor. */
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

/** A doc long past its half-life with nothing to re-verify it: injected, dated stale. */
function setUp() {
  const store = createStore(":memory:");
  const knowledge = new KnowledgeStore(store.db);
  seedFiller(knowledge);
  knowledge.upsertDoc(
    doc({
      id: "retry-plan",
      slug: "retry-plan",
      title: "Webhook retry plan",
      body: BODY,
      confidence: 0.3,
      lastVerifiedAt: "2025-01-01T00:00:00.000Z",
      halfLifeDays: 30,
    })
  );
  return store;
}

describe("launch injection — landed claims", () => {
  test("without a landed record the decayed doc is dated stale", async () => {
    const store = setUp();
    const injected = await retrieveCodeKnowledge(store.db, "proj", QUERY);
    const plan = injected.find((d) => d.slug === "retry-plan");
    expect(plan?.title).toContain("(stale since ");
    expect(plan?.landed).toBeUndefined();
    store.close();
  });

  test("a landed record for the current body replaces the stale date with the landed marker", async () => {
    const store = setUp();
    recordLandedClaim(store.db, "proj", {
      slug: "retry-plan",
      bodyHash: bodyHash(BODY),
      branch: "feat/webhook-retry",
      mainline: "main",
      how: "squash",
      landedAt: "2026-10-01T00:00:00.000Z",
      draftWritten: false,
      via: "squash",
      rules: LANDING_RULES,
    });
    const injected = await retrieveCodeKnowledge(store.db, "proj", QUERY);
    const plan = injected.find((d) => d.slug === "retry-plan");
    const marker = landedClaimMarker({ branch: "feat/webhook-retry", mainline: "main" });
    expect(plan?.landed).toBe(marker);
    expect(plan?.title).toBe("Webhook retry plan");
    const heading = formatCodeKnowledgeInjection(injected).text.split("\n").find((l) => l.includes("proj/retry-plan"));
    expect(heading).toContain(`(${marker})`);
    expect(heading).not.toContain("stale since");
    store.close();
  });
});
