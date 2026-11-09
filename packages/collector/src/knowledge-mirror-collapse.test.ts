import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DISPUTED_CONFIDENCE, KnowledgeStore, type KnowledgeDoc } from "@standup/knowledge";
import { isLexicalNearDup } from "./knowledge-dedup.js";
import { collapseMirrorDuplicates, detectNearDuplicateClusters } from "./knowledge-mirror-collapse.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function doc(overrides: Partial<KnowledgeDoc>): KnowledgeDoc {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    projectId: "standup",
    slug: "doc",
    title: "Doc",
    body: "body",
    updatedAt: new Date("2026-08-16T00:00:00Z"),
    filePath: "/x/doc.md",
    originClass: "owner",
    ...overrides,
  };
}

const CHUNKING =
  "The chunker splits a doc body into pieces of about 512 characters and neighbouring chunks overlap by ten words.";
const RETRY_OLD = "Slack posts retry three times with exponential backoff and then the message is dropped.";
const RETRY_NEW = "Slack posts retry five times with jittered exponential backoff and honor Retry-After headers.";
const ROADMAP_A =
  "Roadmap October to February: persona orchestration, knowledge push hooks, reranker provider, mirror collapse, review drafts.";
const ROADMAP_B =
  "Roadmap October to February: persona orchestration, knowledge push hooks, reranker provider, mirror collapse, review queue.";

/**
 * standup: chunking (copied verbatim), retry (copied, then rewritten), two
 * near-duplicate roadmaps, an unrelated doc. standup-self: the two copies and
 * a doc with no canonical counterpart.
 */
function fixture(): { db: Database; store: KnowledgeStore } {
  const db = new Database(":memory:");
  const store = new KnowledgeStore(db);
  store.upsertDoc(doc({ id: "s-chunk", slug: "chunking-strategy", title: "Chunking", body: CHUNKING }));
  store.upsertDoc(doc({ id: "s-retry", slug: "slack-retry", title: "Slack retry", body: RETRY_NEW }));
  store.upsertDoc(doc({ id: "s-road-a", slug: "roadmap-oct-feb", title: "Roadmap", body: ROADMAP_A }));
  store.upsertDoc(doc({ id: "s-road-b", slug: "product-roadmap", title: "Roadmap", body: ROADMAP_B, originClass: "agent" }));
  store.upsertDoc(doc({ id: "s-other", slug: "deploy", title: "Deploy", body: "Deploy the collector by restarting the service." }));
  store.upsertDoc(doc({ id: "m-chunk", projectId: "standup-self", slug: "chunking-strategy", title: "Chunking", body: `${CHUNKING}\n` }));
  store.upsertDoc(doc({ id: "m-retry", projectId: "standup-self", slug: "slack-retry", title: "Slack retry", body: RETRY_OLD }));
  store.upsertDoc(doc({ id: "m-only", projectId: "standup-self", slug: "self-only", title: "Self only", body: "Only here." }));
  return { db, store };
}

function knowledgeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mirror-collapse-"));
  dirs.push(dir);
  mkdirSync(join(dir, "standup-self"), { recursive: true });
  writeFileSync(
    join(dir, "standup-self", "chunking-strategy.md"),
    `---\ntitle: Chunking\nconfidence: 0.9\n---\n${CHUNKING}\n`
  );
  return dir;
}

describe("collapseMirrorDuplicates", () => {
  test("retires a mirror copy of a canonical doc with a tombstone, keeps the rest", async () => {
    const { db, store } = fixture();
    const counts = await collapseMirrorDuplicates({ db, clusters: [] });
    expect(counts).toMatchObject({ superseded: 1, alreadySuperseded: 0, kept: 2, mergeDrafts: 0 });

    const copy = store.getDoc("standup-self", "chunking-strategy")!;
    expect(copy.verdict).toBe("superseded");
    const row = db.query("SELECT disputes_json, confidence, body FROM knowledge WHERE id = 'm-chunk'").get() as {
      disputes_json: string;
      confidence: number;
      body: string;
    };
    expect(JSON.parse(row.disputes_json)[0].claim).toBe("Superseded by standup/chunking-strategy");
    expect(row.confidence).toBe(DISPUTED_CONFIDENCE);
    expect(row.body.trim()).toBe(CHUNKING);
    // A copy that diverged from its canonical doc, and one with no counterpart, stay live.
    expect(store.getDoc("standup-self", "slack-retry")!.verdict).toBeUndefined();
    expect(store.getDoc("standup-self", "self-only")!.verdict).toBeUndefined();
    expect(store.getDoc("standup", "chunking-strategy")!.verdict).toBeUndefined();
  });

  test("is idempotent", async () => {
    const { db } = fixture();
    const dir = knowledgeDir();
    const first = await collapseMirrorDuplicates({ db, knowledgeDir: dir });
    const snapshot = db.query("SELECT id, verdict, disputes_json, confidence FROM knowledge ORDER BY id").all();
    const second = await collapseMirrorDuplicates({ db, knowledgeDir: dir });
    expect(first).toMatchObject({ superseded: 1, filesPatched: 1, mergeDrafts: 1, mergeDraftsPending: 0 });
    expect(second).toMatchObject({
      superseded: 0,
      alreadySuperseded: 1,
      filesPatched: 0,
      mergeDrafts: 0,
      mergeDraftsPending: 1,
    });
    expect(db.query("SELECT id, verdict, disputes_json, confidence FROM knowledge ORDER BY id").all()).toEqual(snapshot);
  });

  test("splices the retired copy's file confidence", async () => {
    const { db } = fixture();
    const dir = knowledgeDir();
    await collapseMirrorDuplicates({ db, knowledgeDir: dir, clusters: [] });
    expect(readFileSync(join(dir, "standup-self", "chunking-strategy.md"), "utf-8")).toContain(
      `confidence: ${DISPUTED_CONFIDENCE}`
    );
  });

  test("merges a near-duplicate cluster only through a review draft at the kept slug", async () => {
    const { db, store } = fixture();
    const dir = knowledgeDir();
    const counts = await collapseMirrorDuplicates({ db, knowledgeDir: dir });
    expect(counts.mergeDrafts).toBe(1);
    // The owner-written roadmap is kept; the draft carries both bodies.
    const draft = readFileSync(join(dir, "standup", ".drafts", "roadmap-oct-feb.md"), "utf-8");
    expect(draft).toContain(ROADMAP_A);
    expect(draft).toContain("## Merged from `product-roadmap`");
    expect(draft).toContain(ROADMAP_B);
    expect(draft).toContain("product-roadmap");
    // Nothing in the cluster is retired or deleted.
    expect(store.getDoc("standup", "roadmap-oct-feb")!.verdict).toBeUndefined();
    expect(store.getDoc("standup", "product-roadmap")!.verdict).toBeUndefined();
  });

  test("without a knowledge dir no draft is filed and the run is DB-only", async () => {
    const { db } = fixture();
    const counts = await collapseMirrorDuplicates({ db });
    expect(counts).toMatchObject({ superseded: 1, filesPatched: 0, mergeDrafts: 0 });
  });

  test("named clusters: a settled cluster is skipped", async () => {
    const { db } = fixture();
    const dir = knowledgeDir();
    const counts = await collapseMirrorDuplicates({
      db,
      knowledgeDir: dir,
      clusters: [
        { projectId: "standup", slugs: ["roadmap-oct-feb", "product-roadmap"] },
        { projectId: "standup", slugs: ["deploy", "missing-slug"] },
      ],
    });
    expect(counts).toMatchObject({ mergeDrafts: 1, clustersSettled: 1 });
    expect(existsSync(join(dir, "standup", ".drafts", "deploy.md"))).toBe(false);
  });
});

const SHARED_DEPLOY =
  "Deploy the collector by building the bundle, stopping the running service, copying the bundle into the release directory, " +
  "restarting the service under the supervisor, then checking the health endpoint until it reports ready and the hooks reconnect.";

describe("collapseMirrorDuplicates — mirror copies", () => {
  test("a copy naming a different value is kept; a whitespace-only copy is retired", async () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    const base = "The digest cron posts the daily summary to the team channel at 09:00 local time, every weekday morning.";
    store.upsertDoc(doc({ id: "c-digest", slug: "digest", title: "Digest", body: base }));
    store.upsertDoc(doc({ id: "c-ttl", slug: "ttl", title: "TTL", body: "Cached sessions expire after `30m` of idle time in the store." }));
    store.upsertDoc(doc({ id: "m-digest", projectId: "standup-self", slug: "digest", title: "Digest", body: base.replace("09:00", "10:00") }));
    store.upsertDoc(doc({ id: "m-ttl", projectId: "standup-self", slug: "ttl", title: "TTL", body: "Cached  sessions expire after `30m` of idle time in the store.\n" }));
    const counts = await collapseMirrorDuplicates({ db, clusters: [] });
    expect(counts).toMatchObject({ superseded: 1, kept: 1 });
    expect(store.getDoc("standup-self", "digest")!.verdict).toBeUndefined();
    expect(store.getDoc("standup-self", "ttl")!.verdict).toBe("superseded");
  });

  test("a copy with another scope or owner than the canonical doc is kept", async () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc({ id: "c", slug: "deploy", title: "Deploy", body: SHARED_DEPLOY }));
    store.upsertDoc(
      doc({ id: "m", projectId: "standup-self", slug: "deploy", title: "Deploy", body: SHARED_DEPLOY, scope: "user", ownerUser: "alice" })
    );
    expect(await collapseMirrorDuplicates({ db, clusters: [] })).toMatchObject({ superseded: 0, kept: 1 });
  });
});

describe("collapseMirrorDuplicates — merge clusters", () => {
  test("a personal doc never joins a project-scope merge draft", async () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc({ id: "team", slug: "team-deploy", title: "Deploy", body: SHARED_DEPLOY }));
    store.upsertDoc(
      doc({
        id: "mine",
        slug: "my-deploy",
        title: "Deploy",
        body: `${SHARED_DEPLOY} Use my private password hunter2 and account 111122223333.`,
        scope: "user",
        ownerUser: "alice",
        originClass: "agent",
      })
    );
    const scan = await detectNearDuplicateClusters(db);
    expect(scan.complete).toBe(true);
    expect(scan.clusters.filter((c) => c.slugs.includes("team-deploy") && c.slugs.includes("my-deploy"))).toEqual([]);

    const dir = knowledgeDir();
    await collapseMirrorDuplicates({ db, knowledgeDir: dir });
    // A named cluster mixing them is held to the same rule.
    const named = await collapseMirrorDuplicates({
      db,
      knowledgeDir: dir,
      clusters: [{ projectId: "standup", slugs: ["team-deploy", "my-deploy"] }],
    });
    expect(named).toMatchObject({ mergeDrafts: 0, clustersSettled: 1 });
    const draftsDir = join(dir, "standup", ".drafts");
    const drafts = existsSync(draftsDir) ? readdirSync(draftsDir).map((f) => readFileSync(join(draftsDir, f), "utf-8")) : [];
    for (const text of drafts) {
      expect(text).not.toContain("hunter2");
      expect(text).not.toContain("111122223333");
    }
  });

  const ineligible: Array<{ name: string; other: Partial<KnowledgeDoc> }> = [
    { name: "two users' personal docs", other: { scope: "user", ownerUser: "bob" } },
    { name: "a home native-memory mirror", other: { slug: "native-mem-home-claude-md", sourceKind: "native-memory" } },
    { name: "an activity note", other: { slug: "native-mem-memory-2026-10-01", sourceKind: "native-memory" } },
    { name: "a native-memory project mirror", other: { slug: "native-mem-claude-md", sourceKind: "native-memory" } },
    { name: "a doc of another layer", other: { sourceKind: "product" } },
    { name: "a global-scope doc", other: { scope: "global" } },
  ];
  for (const c of ineligible) {
    test(`does not cluster ${c.name} with a project doc`, async () => {
      const db = new Database(":memory:");
      const store = new KnowledgeStore(db);
      store.upsertDoc(
        doc({ id: "a", slug: "deploy-a", title: "Deploy", body: SHARED_DEPLOY, ...(c.name.startsWith("two") ? { scope: "user", ownerUser: "alice" } : {}) })
      );
      store.upsertDoc(doc({ id: "b", slug: "deploy-b", title: "Deploy", body: `${SHARED_DEPLOY} Again.`, ...c.other }));
      expect((await detectNearDuplicateClusters(db)).clusters).toEqual([]);
    });
  }

  test("an ingest-owned doc never clusters", async () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    const dir = knowledgeDir();
    mkdirSync(join(dir, "standup"), { recursive: true });
    const ingested = join(dir, "standup", "deploy-plan.md");
    writeFileSync(ingested, `---\ntitle: Deploy\ningested_from: "/repo/plan/deploy.md"\n---\n${SHARED_DEPLOY}\n`);
    store.upsertDoc(doc({ id: "a", slug: "deploy", title: "Deploy", body: SHARED_DEPLOY }));
    store.upsertDoc(doc({ id: "b", slug: "deploy-plan", title: "Deploy", body: SHARED_DEPLOY, filePath: ingested }));
    expect((await detectNearDuplicateClusters(db)).clusters).toEqual([]);
  });

  test("the merge draft replaces the kept slug, carries its provenance and names the absorbed slugs", async () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(
      doc({ id: "a", slug: "roadmap-oct-feb", title: "Roadmap", body: ROADMAP_A, generatedFromSha: "abc123", sourceSessionId: "sess-9" })
    );
    store.upsertDoc(doc({ id: "b", slug: "product-roadmap", title: "Roadmap", body: ROADMAP_B, originClass: "agent" }));
    const dir = knowledgeDir();
    expect(await collapseMirrorDuplicates({ db, knowledgeDir: dir })).toMatchObject({ mergeDrafts: 1 });
    const draft = readFileSync(join(dir, "standup", ".drafts", "roadmap-oct-feb.md"), "utf-8");
    expect(draft).toContain("replaces_slug: roadmap-oct-feb");
    expect(draft).toContain("generated_from_sha: abc123");
    expect(draft).toContain("source_session_id: sess-9");
    expect(draft).toContain("absorbs `product-roadmap`");
  });

  test("a dry run counts the drafts and file patches a live run writes, writing none", async () => {
    const { db } = fixture();
    const dir = knowledgeDir();
    const counts = await collapseMirrorDuplicates({ db, knowledgeDir: dir, dryRun: true });
    expect(counts).toMatchObject({ superseded: 1, filesPatched: 1, mergeDrafts: 1 });
    expect(existsSync(join(dir, "standup", ".drafts"))).toBe(false);
    expect(readFileSync(join(dir, "standup-self", "chunking-strategy.md"), "utf-8")).toContain("confidence: 0.9");
  });
});

/** A deterministic PRNG (mulberry32), so the generated corpora are the same every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomWord(rand: () => number): string {
  let w = "";
  for (let k = 0; k < 6; k++) w += String.fromCharCode(97 + Math.floor(rand() * 26));
  return w;
}

describe("detectNearDuplicateClusters", () => {
  test("finds lexical near-duplicates within a project and skips mirror projects", async () => {
    const { db } = fixture();
    expect(await detectNearDuplicateClusters(db)).toMatchObject({
      complete: true,
      clusters: [{ projectId: "standup", slugs: expect.arrayContaining(["roadmap-oct-feb", "product-roadmap"]) }],
    });
  });

  test("agrees with pairwise isLexicalNearDup on a corpus of overlapping docs", async () => {
    const rand = prng(7);
    const vocab = Array.from({ length: 120 }, () => randomWord(rand));
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    const docs: Array<{ slug: string; text: string }> = [];
    for (let n = 0; n < 80; n++) {
      const size = 8 + Math.floor(rand() * 30);
      const body = Array.from({ length: size }, () => vocab[Math.floor(rand() * 40 + (n % 3) * 40)]!).join(" ");
      const slug = `doc-${n}`;
      store.upsertDoc(doc({ id: slug, slug, title: "T", body }));
      docs.push({ slug, text: `T\n${body}` });
    }
    // Union-find over every pair: the reference components.
    const parent = docs.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
    for (let i = 0; i < docs.length; i++)
      for (let j = i + 1; j < docs.length; j++) if (isLexicalNearDup(docs[i]!.text, docs[j]!.text)) parent[find(i)] = find(j);
    const want = new Map<number, string[]>();
    docs.forEach((d, i) => want.set(find(i), [...(want.get(find(i)) ?? []), d.slug]));
    const norm = (groups: Iterable<readonly string[]>) =>
      [...groups].filter((g) => g.length > 1).map((g) => [...g].sort().join(",")).sort();
    const reference = norm(want.values());
    expect(reference.length).toBeGreaterThan(0);
    expect(norm((await detectNearDuplicateClusters(db)).clusters.map((c) => c.slugs))).toEqual(reference);
  });

  test("600 distinct 600-word docs scan well under the pairwise cost", async () => {
    const rand = prng(42);
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    db.transaction(() => {
      for (let n = 0; n < 600; n++) {
        const body = Array.from({ length: 600 }, () => randomWord(rand)).join(" ");
        store.upsertDoc(doc({ id: `d${n}`, slug: `doc-${n}`, title: `Doc ${n}`, body }));
      }
    })();
    const started = performance.now();
    const scan = await detectNearDuplicateClusters(db);
    const ms = performance.now() - started;
    expect(scan).toMatchObject({ complete: true, clusters: [] });
    expect(scan.comparisons).toBeLessThan(600);
    expect(ms).toBeLessThan(2000);
  });

  test("stops at the deadline with the clusters of the groups it finished", async () => {
    const rand = prng(3);
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    for (let n = 0; n < 50; n++) {
      store.upsertDoc(doc({ id: `d${n}`, slug: `doc-${n}`, body: Array.from({ length: 40 }, () => randomWord(rand)).join(" ") }));
    }
    let t = 0;
    const scan = await detectNearDuplicateClusters(db, undefined, { now: () => t++, deadline: 10 });
    expect(scan).toMatchObject({ complete: false, clusters: [] });
    const counts = await collapseMirrorDuplicates({ db, now: () => t++, deadline: t + 5 });
    expect(counts.clusterScanIncomplete).toBe(1);
  });
});
