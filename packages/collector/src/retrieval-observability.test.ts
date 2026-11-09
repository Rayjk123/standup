import { expect, test, describe, afterAll } from "bun:test";
import { DEFAULT_IDENTITY_HEADER } from "@standup/shared";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { createStore, recordRetrievals, upsertProject, type Store } from "@standup/store";
import { effectiveAlgoVersion, writeKnowledgeFile } from "@standup/knowledge";
import type { KnowledgeChange, KnowledgeRetrievalUsage, KnowledgeUsageHealth, WsMessage } from "@standup/shared";
import { USER_CHANNEL_HEADER, userChannelToken } from "@standup/shared/owner-token";
import { createServer } from "./server.js";
import { activeOwnerSecrets } from "./owner-secret.js";

/** `alias`'s signed-in headers: its tunnel identity and its user channel token. */
const signedIn = (alias: string): Record<string, string> => ({
  [DEFAULT_IDENTITY_HEADER]: alias,
  [USER_CHANNEL_HEADER]: userChannelToken(activeOwnerSecrets().ownerToken, alias),
});
import { KnowledgeSync } from "./knowledge-sync.js";
import { makeKnowledgeChangeEmitter } from "./knowledge-change-emit.js";
import { gatedRecords, placementsFor, recordKnowledgeRetrievals, scoreComponents } from "./retrieval-telemetry.js";

/**
 * Retrieval observability over the real routes: every surface records why a
 * doc was or was not returned (components, algorithm version, placement, drop
 * reason), get_knowledge_doc fetches are logged, and the usage / change views
 * never show another user's personal-layer doc.
 */

const cleanupDirs: string[] = [];
afterAll(async () => {
  for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
});

interface Harness {
  store: Store;
  projectId: string;
  app: ReturnType<typeof createServer>;
  broadcasts: WsMessage[];
  sync: KnowledgeSync;
}

async function setUp(): Promise<Harness> {
  const store = createStore(":memory:");
  const projectId = `obs-${randomUUID().slice(0, 8)}`;
  upsertProject(store.db, { id: projectId, name: "Obs", branch: "main", repos: [] });
  const knowledgeDir = await mkdtemp(join(tmpdir(), "standup-obs-"));
  cleanupDirs.push(knowledgeDir);

  await writeKnowledgeFile(knowledgeDir, projectId, {
    slug: "widget-pipeline",
    title: "Widget Pipeline",
    body: "The widget pipeline flushes batches through the collector on a timer.",
    originClass: "owner",
  });
  await writeKnowledgeFile(knowledgeDir, projectId, {
    slug: "widget-rumor",
    title: "Widget Rumor",
    body: "Someone said the widget pipeline flushes batches twice; unverified.",
    originClass: "untrusted",
  });
  await writeKnowledgeFile(knowledgeDir, projectId, {
    slug: "unused-runbook",
    title: "Unused Runbook",
    body: "Restart the frobnicator when the gauge turns red.",
    originClass: "owner",
  });
  await writeKnowledgeFile(knowledgeDir, projectId, {
    slug: "alice-widget-notes",
    title: "Alice Widget Notes",
    body: "Alice prefers terse widget pipeline reviews.",
    scope: "user",
    ownerUser: "alice",
  });

  const sync = new KnowledgeSync(store.db, knowledgeDir, null);
  await sync.syncAll();
  const broadcasts: WsMessage[] = [];
  const app = createServer(store, (m) => broadcasts.push(m), null, sync, undefined, knowledgeDir);
  return { store, projectId, app, broadcasts, sync };
}

const post = (h: Harness, path: string, body: Record<string, unknown>, user = "carol") =>
  h.app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...signedIn(user) },
    body: JSON.stringify(body),
  });
const get = (h: Harness, path: string, user: string) => h.app.request(path, { headers: signedIn(user) });

type RowShape = Record<string, unknown>;
const rows = (h: Harness, where = "1=1"): RowShape[] =>
  h.store.db.query(`SELECT * FROM knowledge_retrievals WHERE ${where} ORDER BY id`).all() as RowShape[];

describe("retrieval-telemetry helpers", () => {
  test("scoreComponents keeps every score-named number and the signal breakdowns, nothing else", () => {
    expect(
      scoreComponents({
        score: 0.03,
        rawScore: 0.6,
        relevance: 0.55,
        titleBoost: 1.2,
        confidence: 0.9,
        halfLifeDays: 30,
        rank: 2,
        title: "x",
        signals: { text: 0.4, embedding: 0.7, note: "n" },
        components: { rrf: { text: 0.01 } },
      })
    ).toEqual({
      score: 0.03,
      rawScore: 0.6,
      relevance: 0.55,
      titleBoost: 1.2,
      signals: { text: 0.4, embedding: 0.7 },
      components: { rrf: { text: 0.01 } },
    });
  });

  test("gated rows are bounded per query; recording stamps the algorithm and drops other users' personal rows", () => {
    const store = createStore(":memory:");
    const gated = Array.from({ length: 25 }, (_, i) => ({
      hit: { projectId: "p", slug: `g${i}`, score: 0.1 },
      reason: "floor" as const,
    }));
    const records = gatedRecords(gated, { query: "q", surface: "search" }, () => null);
    expect(records).toHaveLength(10);
    expect(records.every((r) => r.dropReason === "floor")).toBe(true);

    recordKnowledgeRetrievals(
      store.db,
      [
        ...records,
        { docProject: "p", docSlug: "mine", query: "q", rank: 0, surface: "search", layer: "personal", docOwner: "alice" },
        { docProject: "p", docSlug: "theirs", query: "q", rank: 1, surface: "search", layer: "personal", docOwner: "bob" },
        { docProject: "p", docSlug: "unowned", query: "q", rank: 2, surface: "search", layer: "personal" },
      ],
      "alice"
    );
    const stored = store.db.query("SELECT doc_slug, algo_version FROM knowledge_retrievals").all() as Array<{
      doc_slug: string;
      algo_version: string;
    }>;
    expect(stored.map((r) => r.doc_slug)).not.toContain("theirs");
    expect(stored.map((r) => r.doc_slug)).not.toContain("unowned");
    expect(stored.map((r) => r.doc_slug)).toContain("mine");
    expect(new Set(stored.map((r) => r.algo_version))).toEqual(new Set([effectiveAlgoVersion()]));
    store.close();
  });
});

describe("placementsFor", () => {
  test("reads every doc's placement in batched queries; an unknown doc or a missing index reads null", async () => {
    const h = await setUp();
    const refs = [
      { projectId: h.projectId, slug: "alice-widget-notes" },
      { projectId: h.projectId, slug: "widget-pipeline" },
      { projectId: h.projectId, slug: "nope" },
      ...Array.from({ length: 450 }, (_, i) => ({ projectId: h.projectId, slug: `absent-${i}` })),
    ];
    const placement = placementsFor(h.store.db, refs);
    expect(placement(h.projectId, "alice-widget-notes")).toMatchObject({ scope: "user", ownerUser: "alice" });
    expect(placement(h.projectId, "widget-pipeline")).toMatchObject({ scope: "project" });
    expect(placement(h.projectId, "nope")).toBeNull();
    h.store.close();

    const bare = createStore(":memory:");
    bare.db.exec("DROP TABLE IF EXISTS knowledge");
    expect(placementsFor(bare.db, refs.slice(0, 2))(h.projectId, "widget-pipeline")).toBeNull();
    bare.close();
  });
});

describe("retrieval observability routes", () => {
  test("a scoped search records components, algorithm version and placement for each hit", async () => {
    const h = await setUp();
    const res = await post(h, "/api/knowledge/search", {
      cwd: "/tmp/none",
      query: "widget pipeline batches",
      project: h.projectId,
      scoped: true,
    });
    expect(res.status).toBe(200);
    const recorded = rows(h, "surface = 'search'");
    expect(recorded.length).toBeGreaterThan(0);
    for (const r of recorded) {
      expect(r.algo_version).toBe(effectiveAlgoVersion());
      expect(r.drop_reason).toBeNull();
      expect(r.layer).toBe("docs");
      expect(r.scope).toBe("project");
      expect(JSON.parse(r.components_json as string)).toHaveProperty("score");
    }
    // Nobody else's personal doc rides into carol's log.
    expect(recorded.map((r) => r.doc_slug)).not.toContain("alice-widget-notes");
    h.store.close();
  });

  test("get_knowledge_doc logs one doc_get per read; the browse fetch is not logged", async () => {
    const h = await setUp();
    const fetch = (body: Record<string, unknown>) =>
      post(h, "/api/knowledge/doc", { slug: "widget-pipeline", project: h.projectId, ...body });

    expect((await fetch({ scoped: true })).status).toBe(200);
    expect((await fetch({ scoped: true, offset: 20, limit: 10 })).status).toBe(200);
    expect((await fetch({})).status).toBe(200);

    const fetches = rows(h, "surface = 'doc_get'");
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toMatchObject({ doc_project: h.projectId, doc_slug: "widget-pipeline", algo_version: effectiveAlgoVersion() });

    const usage = (await (await get(h, `/api/knowledge/usage?projectId=${h.projectId}`, "carol")).json()) as {
      usage: KnowledgeRetrievalUsage[];
    };
    const row = usage.usage.find((u) => u.docSlug === "widget-pipeline");
    expect(row?.docGets).toBe(1);
    expect(row?.retrievals).toBe(0);
    h.store.close();
  });

  test("usage, stats and the health view never show another user's personal doc", async () => {
    const h = await setUp();
    recordRetrievals(h.store.db, [
      // A row stamped with the owner, and one recorded before rows carried a layer.
      { docProject: h.projectId, docSlug: "alice-widget-notes", query: "q", rank: 0, surface: "search", layer: "personal", docOwner: "alice" },
      { docProject: h.projectId, docSlug: "alice-widget-notes", query: "q2", rank: 0, surface: "search" },
      { docProject: h.projectId, docSlug: "widget-pipeline", query: "q", rank: 1, surface: "inject", injected: true },
      // A deleted home mirror with no recorded layer: its owner is unknown.
      { docProject: h.projectId, docSlug: "native-mem-home-claude-md", query: "q", rank: 2, surface: "search" },
    ]);

    const usageFor = async (user: string) =>
      ((await (await get(h, `/api/knowledge/usage?projectId=${h.projectId}`, user)).json()) as {
        usage: KnowledgeRetrievalUsage[];
        health: KnowledgeUsageHealth;
        breakdown: { byLayer: Array<{ layer: string }> };
      });

    const bob = await usageFor("bob");
    expect(bob.usage.map((u) => u.docSlug)).toEqual(["widget-pipeline"]);
    expect(bob.breakdown.byLayer.map((r) => r.layer)).not.toContain("personal");
    const bobListed = [...bob.health.neverRetrieved, ...bob.health.neverCited, ...bob.health.hubs].map((d) => d.slug);
    expect(bobListed).not.toContain("alice-widget-notes");

    const alice = await usageFor("alice");
    const aliceRow = alice.usage.find((u) => u.docSlug === "alice-widget-notes");
    expect(aliceRow?.retrievals).toBe(2);
    expect(alice.usage.map((u) => u.docSlug)).not.toContain("native-mem-home-claude-md");

    const stats = (await (await get(h, `/api/knowledge/stats?projectId=${h.projectId}`, "bob")).json()) as {
      retrievalUsage: KnowledgeRetrievalUsage[];
      usageHealth: KnowledgeUsageHealth;
    };
    expect(stats.retrievalUsage.map((u) => u.docSlug)).toEqual(["widget-pipeline"]);
    expect(stats.usageHealth.docs).toBe(3);
    h.store.close();
  });

  test("the health view lists unused and never-opened docs and the hubs", async () => {
    const h = await setUp();
    recordRetrievals(h.store.db, [
      // widget-pipeline is searched and then opened in the same session; widget-rumor
      // is surfaced but never opened.
      { docProject: h.projectId, docSlug: "widget-pipeline", query: "q", rank: 0, surface: "search", sessionId: "s-health" },
      { docProject: h.projectId, docSlug: "widget-pipeline", query: "q", rank: 0, surface: "search" },
      { docProject: h.projectId, docSlug: "widget-rumor", query: "q", rank: 1, surface: "search", sessionId: "s-health" },
      { docProject: h.projectId, docSlug: "widget-rumor", query: "q", rank: 1, surface: "search", dropReason: "origin" },
      { docProject: h.projectId, docSlug: "renamed-away", query: "q", rank: 2, surface: "search" },
      { docProject: h.projectId, docSlug: "widget-pipeline", query: "widget-pipeline", rank: 0, surface: "doc_get", sessionId: "s-health" },
    ]);
    const { health } = (await (await get(h, `/api/knowledge/usage?projectId=${h.projectId}`, "carol")).json()) as {
      health: KnowledgeUsageHealth;
    };
    expect(health.neverRetrieved.map((d) => d.slug)).toEqual(["unused-runbook"]);
    expect(health.neverCitedCount).toBe(2);
    expect(health.neverCited.map((d) => d.slug).sort()).toEqual(["unused-runbook", "widget-rumor"]);
    expect(health.hubs.map((d) => [d.slug, d.retrievals])).toEqual([
      ["widget-pipeline", 2],
      ["widget-rumor", 1],
    ]);
    expect(health.hubs[0].share).toBeCloseTo(2 / 3);
    expect(health.orphanedUsageDocs).toBe(1);
    h.store.close();
  });

  test("a personal doc's change reaches only its owner: frame and ledger", async () => {
    const h = await setUp();
    const frames: WsMessage[] = [];
    const emit = makeKnowledgeChangeEmitter(h.store.db, (m) => frames.push(m));
    emit("accepted", h.projectId, "alice-widget-notes", "Alice Widget Notes");
    emit("accepted", h.projectId, "widget-pipeline", "Widget Pipeline");

    const personalFrame = frames.find((m) => (m.payload as KnowledgeChange).slug === "alice-widget-notes");
    expect(personalFrame?.audience).toBe("alice");
    expect(frames.find((m) => (m.payload as KnowledgeChange).slug === "widget-pipeline")?.audience).toBeUndefined();

    // A change recorded before changes carried the flag, for the same doc.
    h.store.db.run(
      `INSERT INTO knowledge_changes (id, project_id, slug, kind, title, created_at, personal)
       VALUES ('legacy', ?, 'alice-widget-notes', 'reconciled', 'Alice Widget Notes', '2026-01-01T00:00:00Z', NULL)`,
      [h.projectId]
    );

    const ledger = async (user: string) =>
      ((await (await get(h, "/api/knowledge-changes", user)).json()) as KnowledgeChange[]).map((c) => c.slug);
    expect(await ledger("bob")).toEqual(["widget-pipeline"]);
    expect((await ledger("alice")).filter((s) => s === "alice-widget-notes")).toHaveLength(2);
    // The identity header alone, which a loopback worker can set, reads no personal change.
    const forged = (await (await h.app.request("/api/knowledge-changes", { headers: { [DEFAULT_IDENTITY_HEADER]: "alice" } })).json()) as KnowledgeChange[];
    expect(forged.map((c) => c.slug)).not.toContain("alice-widget-notes");
    h.store.close();
  });
});
