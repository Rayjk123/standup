import { expect, test, describe } from "bun:test";
import { createStore, upsertProject } from "@standup/store";
import type { Store } from "@standup/store";
import { KnowledgeStore, formatContradictsClaim, type KnowledgeDoc } from "@standup/knowledge";
import { createServer } from "./server.js";
import { bodyHash, LANDING_RULES, landedClaimMarker, recordLandedClaim } from "./knowledge-repo-claims.js";

/**
 * The agent-facing search route answers "no confident match" instead of
 * handing back the best of a weak batch, shows weak matches only on request,
 * and marks a contradicted doc as not injection-eligible. The human-browse path
 * (unscoped) still lists everything, each hit flagged.
 */

const PROJECT = "alpha";

function doc(overrides: Partial<KnowledgeDoc>): KnowledgeDoc {
  return {
    id: overrides.slug ?? crypto.randomUUID(),
    projectId: PROJECT,
    slug: "doc",
    title: "Doc",
    body: "body",
    updatedAt: new Date("2026-08-16T00:00:00Z"),
    filePath: "/x/doc.md",
    sourceKind: "runbook",
    originClass: "owner",
    ...overrides,
  };
}

function setUp(): { store: Store; app: ReturnType<typeof createServer> } {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: PROJECT, name: "Alpha", branch: "main", repos: [] });
  const k = new KnowledgeStore(store.db);
  const docs: Array<[string, string, string]> = [
    ["retry-policy", "Slack mirror retry policy", "The Slack mirror retries a failed post three times with jittered backoff."],
    ["deploy-runbook", "Collector deploy runbook", "Deploy the collector by building, migrating the database, then restarting."],
    ["fts-rows", "FTS orphan rows", "Deleting a doc deletes its FTS row in the same transaction."],
    ["scope-gate", "Scope audience gate", "Scoped retrieval admits global, project and the user's own docs."],
    ["old-plan", "Persona orchestrator plan", "The persona orchestrator is uncommitted and not merged."],
    ["new-arch", "Persona orchestrator architecture", "The persona orchestrator was merged."],
  ];
  for (const [slug, title, body] of docs) {
    // The stale plan was written well before the architecture doc it
    // contradicts: it is the losing side.
    k.upsertDoc(
      doc({ slug, title, body, ...(slug === "old-plan" ? { updatedAt: new Date("2026-07-01T00:00:00Z") } : {}) })
    );
  }
  k.setDocVerdict(PROJECT, "old-plan", "contradicted", [
    { claim: formatContradictsClaim("new-arch"), finding: "", evidence: "" },
  ]);
  return { store, app: createServer(store, () => {}, null) };
}

async function search(app: ReturnType<typeof createServer>, body: Record<string, unknown>) {
  const res = await app.request("/api/knowledge/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: "/tmp/none", project: PROJECT, ...body }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    results: Array<{ slug: string; confident: boolean; relevance: number; injectionEligible: boolean; verdict?: string }>;
    lowConfidence?: Array<{ slug: string; confident: boolean }>;
    noConfidentMatch?: boolean;
  };
}

describe("POST /api/knowledge/search — confidence floor", () => {
  const offTopic = "should I retry a failed sourdough rise with more yeast or more time";

  test("a scoped off-topic search returns no confident match", async () => {
    const { store, app } = setUp();
    const json = await search(app, { query: offTopic, scoped: true });
    expect(json.results).toEqual([]);
    expect(json.noConfidentMatch).toBe(true);
    expect(json.lowConfidence).toBeUndefined();
    store.close();
  });

  test("weak matches come back separately, flagged, only when asked for", async () => {
    const { store, app } = setUp();
    const json = await search(app, { query: offTopic, scoped: true, lowConfidence: 2 });
    expect(json.results).toEqual([]);
    expect(json.lowConfidence?.map((r) => r.slug)).toContain("retry-policy");
    expect(json.lowConfidence!.length).toBeLessThanOrEqual(2);
    expect(json.lowConfidence!.every((r) => r.confident === false)).toBe(true);
    store.close();
  });

  test("an on-topic scoped search returns its confident match", async () => {
    const { store, app } = setUp();
    const json = await search(app, { query: "slack mirror retry backoff for failed posts", scoped: true });
    expect(json.results[0].slug).toBe("retry-policy");
    expect(json.results.every((r) => r.confident)).toBe(true);
    expect(json.noConfidentMatch).toBeUndefined();
    store.close();
  });

  test("the browse path lists weak hits too, each flagged", async () => {
    const { store, app } = setUp();
    const json = await search(app, { query: offTopic });
    expect(json.results.map((r) => r.slug)).toContain("retry-policy");
    expect(json.results.find((r) => r.slug === "retry-policy")!.confident).toBe(false);
    store.close();
  });

  test("a contradicted doc is shown as not injection-eligible", async () => {
    const { store, app } = setUp();
    const json = await search(app, { query: "persona orchestrator merged uncommitted", scoped: true });
    const old = json.results.find((r) => r.slug === "old-plan");
    expect(old?.verdict).toBe("contradicted");
    expect(old?.injectionEligible).toBe(false);
    store.close();
  });
});

describe("POST /api/knowledge/search — landed claims and disputed docs", () => {
  const PLAN_BODY = "The Slack mirror retry queue is on branch feat/retry-queue, not yet merged.";

  function setUpMarked(): { store: Store; app: ReturnType<typeof createServer> } {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: PROJECT, name: "Alpha", branch: "main", repos: [] });
    const k = new KnowledgeStore(store.db);
    k.upsertDoc(doc({ slug: "retry-queue-plan", title: "Slack mirror retry queue", body: PLAN_BODY }));
    k.upsertDoc(
      doc({
        slug: "retry-backoff",
        title: "Slack mirror retry backoff",
        body: "The Slack mirror retries a failed post three times with jittered backoff.",
        confidence: 0.05,
      })
    );
    k.setDocVerdict(PROJECT, "retry-backoff", "disputed", [
      { claim: "retries three times", finding: "the code retries five times", evidence: "src/mirror.ts" },
    ]);
    return { store, app: createServer(store, () => {}, null) };
  }

  async function browse(app: ReturnType<typeof createServer>, query: string) {
    const res = await app.request("/api/knowledge/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/tmp/none", project: PROJECT, query }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as {
      results: Array<{ slug: string; injectionEligible: boolean; verdict?: string; landed?: string; staleSince?: string }>;
    };
  }

  test("a doc with a landed record for its current body carries the landed marker and no stale date", async () => {
    const { store, app } = setUpMarked();
    recordLandedClaim(store.db, PROJECT, {
      slug: "retry-queue-plan",
      bodyHash: bodyHash(PLAN_BODY),
      branch: "feat/retry-queue",
      mainline: "main",
      how: "squash",
      landedAt: "2026-10-01T00:00:00.000Z",
      draftWritten: false,
      via: "squash",
      rules: LANDING_RULES,
    });
    const hit = (await browse(app, "slack mirror retry queue")).results.find((r) => r.slug === "retry-queue-plan");
    expect(hit?.landed).toBe(landedClaimMarker({ branch: "feat/retry-queue", mainline: "main" }));
    expect(hit?.staleSince).toBeUndefined();
    store.close();
  });

  test("a landing inferred only from content is not shown as landed", async () => {
    const { store, app } = setUpMarked();
    recordLandedClaim(store.db, PROJECT, {
      slug: "retry-queue-plan",
      bodyHash: bodyHash(PLAN_BODY),
      branch: "feat/retry-queue",
      mainline: "main",
      how: "src/retry.ts absent from main earlier and on main now",
      landedAt: "2026-10-01T00:00:00.000Z",
      draftWritten: true,
      via: "content",
      rules: LANDING_RULES,
    });
    const hit = (await browse(app, "slack mirror retry queue")).results.find((r) => r.slug === "retry-queue-plan");
    expect(hit).toBeDefined();
    expect(hit?.landed).toBeUndefined();
    store.close();
  });

  test("a landed record for an older body is not shown", async () => {
    const { store, app } = setUpMarked();
    recordLandedClaim(store.db, PROJECT, {
      slug: "retry-queue-plan",
      bodyHash: bodyHash("an earlier body"),
      branch: "feat/retry-queue",
      mainline: "main",
      how: "squash",
      landedAt: "2026-10-01T00:00:00.000Z",
      draftWritten: false,
      via: "squash",
      rules: LANDING_RULES,
    });
    const hit = (await browse(app, "slack mirror retry queue")).results.find((r) => r.slug === "retry-queue-plan");
    expect(hit).toBeDefined();
    expect(hit?.landed).toBeUndefined();
    store.close();
  });

  test("a disputed doc is injection-eligible, as launch injection admits it", async () => {
    const { store, app } = setUpMarked();
    const hit = (await browse(app, "slack mirror retry backoff")).results.find((r) => r.slug === "retry-backoff");
    expect(hit?.verdict).toBe("disputed");
    expect(hit?.injectionEligible).toBe(true);
    expect(hit?.staleSince).toBeUndefined();
    store.close();
  });
});
