import { expect, test, describe, beforeAll } from "bun:test";
import { createHash } from "crypto";
import { mkdtemp, rm, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  KnowledgeStore,
  KnowledgeLoader,
  LocalMarkdownBackend,
  registerEmbeddingProvider,
  chunkText,
  embedChunks,
  isVecAvailable,
  VEC_TABLE,
  writeKnowledgeFile,
  writeDraftFile,
  exportKnowledgeBundle,
  importKnowledgeBundle,
  EMBEDDING_FINGERPRINT_KEY,
  CHUNKER_VERSION,
} from "./index.js";
import {
  createStore,
  getSetting,
  setSetting,
  getProject,
  getKnowledgeDefaultScope,
  createKnowledgeResolution,
  getKnowledgeResolutions,
  getPendingResolutions,
  createKnowledgeChange,
  getRecentKnowledgeChanges,
  getRetrievalUsage,
} from "@standup/store";

// A deterministic, call-counting embedding provider: a fixed-width bag-of-words
// hash so the same text always embeds to the same vector (no network), which is
// what lets the round-trip assert identical search ordering. `embedCalls` is the
// instrument for the core invariant — import must make ZERO embedding calls.
const EMBED_DIM = 24;
const PROVIDER_ID = "bundle-test-embed";
const FINGERPRINT = "bundle-test-embed:bt-v1";
let embedCalls = 0;

function deterministicEmbed(text: string): number[] {
  const v = new Array(EMBED_DIM).fill(0);
  for (const tok of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    v[h % EMBED_DIM] += 1;
  }
  // A non-zero vector so cosine similarity is defined for an empty/odd chunk.
  if (v.every((x) => x === 0)) v[0] = 1;
  return v;
}

beforeAll(() => {
  registerEmbeddingProvider({
    id: PROVIDER_ID,
    defaultModel: "bt-v1",
    dimensions: EMBED_DIM,
    embed: async (text) => {
      embedCalls++;
      return deterministicEmbed(text);
    },
  });
});

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Loads a project's accepted docs, upserts them, and embeds each into chunks —
 *  the same doc-row + chunk-per-doc shape the collector's sync produces, without
 *  a network. Embeds the SAME doc objects it upserted so the chunk foreign key
 *  resolves to the stored row (a reload would mint fresh ids). */
async function loadAndEmbed(
  store: KnowledgeStore,
  loader: KnowledgeLoader,
  projectId: string
): Promise<void> {
  const docs = await loader.loadProject(projectId);
  for (const doc of docs) {
    store.upsertDoc(doc);
    const chunks = chunkText(doc.body);
    const embeddings = await embedChunks(chunks, PROVIDER_ID, {});
    chunks.forEach((text, i) => {
      const embedding = embeddings[i];
      if (!embedding) return;
      store.upsertChunk({
        id: `${projectId}-${doc.slug}-${i}`,
        knowledgeId: doc.id,
        chunkIndex: i,
        text,
        embedding,
      });
    });
  }
  for (const draft of await loader.loadDrafts(projectId)) store.upsertDraft(draft);
}

/**
 * Seeds a source KNOWLEDGE_DIR + DB with the full spread the round-trip must
 * preserve: an ordinary doc, a `disputed` doc (verdict + disputes), a
 * `superseded` tombstone, a native-memory mirror doc, a verdicted draft,
 * retrieval telemetry (with past timestamps), the resolution ledger (applied +
 * needs_review), the changes feed, per-project knowledge_scope, and embedded
 * chunks. Returns the source chunk count for the carry assertion.
 */
async function seedSource(knowledgeDir: string, dbPath: string): Promise<number> {
  await writeKnowledgeFile(knowledgeDir, "acme", {
    slug: "auth-flow",
    title: "Auth Flow",
    body: "Authentication uses signed login tokens. The secure session token is validated on every request.",
    tags: ["auth", "security"],
    originClass: "owner",
  });
  await writeKnowledgeFile(knowledgeDir, "acme", {
    slug: "cache-policy",
    title: "Cache Policy",
    body: "The cache eviction policy is LRU with a ten minute TTL for cached entries.",
    tags: ["cache"],
    originClass: "owner",
  });
  await writeKnowledgeFile(knowledgeDir, "acme", {
    slug: "disputed-doc",
    title: "Disputed Doc",
    body: "This claim about the retry budget is contested by the current code.",
    originClass: "owner",
  });
  await writeKnowledgeFile(knowledgeDir, "acme", {
    slug: "old-claim",
    title: "Old Claim",
    body: "The legacy deployment used a blue green rollout across two fleets.",
    originClass: "owner",
  });
  await writeKnowledgeFile(knowledgeDir, "global", {
    slug: "native-notes",
    title: "Native Notes",
    body: "Global engineering conventions mirrored from native memory surfaces.",
    sourceKind: "native-memory",
    nativeMemoryFrom: "/home/user/.claude/CLAUDE.md",
    originClass: "agent",
  });
  await writeDraftFile(knowledgeDir, "acme", {
    slug: "draft-idea",
    title: "Draft Idea",
    body: "A proposed convention still awaiting review.",
    generatedFromSha: "deadbeef",
    originClass: "agent",
  });

  const store = createStore(dbPath);
  const knowledgeStore = new KnowledgeStore(store.db);
  const loader = new KnowledgeLoader(knowledgeDir);

  for (const projectId of ["acme", "global"]) {
    await loadAndEmbed(knowledgeStore, loader, projectId);
  }

  // Verdicts (DB-only, cron-owned).
  knowledgeStore.setDocVerdict("acme", "disputed-doc", "disputed", [
    { claim: "retry budget", finding: "refuted against code", evidence: "grep retry" },
  ]);
  knowledgeStore.setDocVerdict("acme", "old-claim", "superseded", []);
  knowledgeStore.setDraftVerdict("acme", "draft-idea", "disputed", [
    { claim: "the convention", finding: "conflicts with an accepted doc", evidence: "see auth-flow" },
  ]);

  // Retrieval telemetry with fixed PAST timestamps, so the move can be shown to
  // preserve created_at (the staleness/recency signal) rather than reset it.
  const insertRetrieval = store.db.prepare(
    `INSERT INTO knowledge_retrievals
       (doc_project, doc_slug, query, rank, score, surface, session_id, query_project, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insertRetrieval.run("acme", "auth-flow", "login token", 0, 0.9, "search", null, "acme", "2025-01-02T03:04:05.000Z");
  insertRetrieval.run("acme", "auth-flow", "auth", 1, 0.5, "expert", "sess-1", "acme", "2025-01-03T03:04:05.000Z");
  insertRetrieval.run("acme", "cache-policy", "eviction", 0, 0.7, "inject", "sess-2", "acme", "2025-01-05T03:04:05.000Z");

  // Contradiction-resolution ledger: one auto-applied, one withheld for review.
  createKnowledgeResolution(store.db, {
    id: "res-1",
    projectId: "acme",
    winnerSlug: "auth-flow",
    loserSlug: "old-claim",
    type: "supersede",
    status: "applied",
    autoApplied: true,
    rationale: "newer claim wins",
  });
  createKnowledgeResolution(store.db, {
    id: "res-2",
    projectId: "acme",
    winnerSlug: "cache-policy",
    loserSlug: "disputed-doc",
    type: "merge",
    status: "needs_review",
    autoApplied: false,
    rationale: "destructive — needs a human",
    detail: JSON.stringify({ note: "merge into cache-policy" }),
  });

  // Changes feed.
  createKnowledgeChange(store.db, {
    id: "chg-1",
    projectId: "acme",
    slug: "auth-flow",
    kind: "accepted",
    title: "Auth Flow",
    createdAt: "2025-01-01T00:00:00.000Z",
  });
  createKnowledgeChange(store.db, {
    id: "chg-2",
    projectId: "acme",
    slug: "old-claim",
    kind: "contradiction",
    title: "Old Claim",
    contradicted: ["auth-flow"],
    createdAt: "2025-01-04T00:00:00.000Z",
  });

  // Per-project authoring default (projects.knowledge_scope).
  store.db.run(
    "INSERT INTO projects (id, name, knowledge_scope) VALUES ('acme', 'Acme', 'global')"
  );

  // The embedding fingerprint the chunks were produced under — carried so the
  // target boots search-ready without treating them as stale.
  setSetting(store.db, EMBEDDING_FINGERPRINT_KEY, FINGERPRINT);

  const chunkCount = (
    store.db.query("SELECT COUNT(*) AS n FROM knowledge_chunks").get() as { n: number }
  ).n;

  // Checkpoint WAL into the main DB file so the read-only export sees everything
  // from the main file and the read-only assertion is stable.
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  store.close();
  return chunkCount;
}

async function hashFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

describe("knowledge bundle export/import round-trip", () => {
  test("preserves full fidelity and makes ZERO embedding calls on import", async () => {
    const srcDir = await tempDir("kb-src-");
    const srcDbDir = await tempDir("kb-srcdb-");
    const bundleDir = await tempDir("kb-bundle-");
    const dstDir = await tempDir("kb-dst-");
    const dstDbDir = await tempDir("kb-dstdb-");
    const srcDbPath = join(srcDbDir, "source.db");
    const dstDbPath = join(dstDbDir, "target.db");

    try {
      const sourceChunks = await seedSource(srcDir, srcDbPath);
      expect(sourceChunks).toBeGreaterThan(0);

      // Export, proving the source DB is untouched (byte-identical before/after).
      const beforeHash = await hashFile(srcDbPath);
      const manifest = await exportKnowledgeBundle({
        dbPath: srcDbPath,
        knowledgeDir: srcDir,
        outDir: bundleDir,
        exportedAt: "2026-01-01T00:00:00.000Z",
      });
      const afterHash = await hashFile(srcDbPath);
      expect(afterHash).toBe(beforeHash);

      expect(manifest.embeddingFingerprint).toBe(FINGERPRINT);
      expect(manifest.counts.chunks).toBe(sourceChunks);
      expect(manifest.counts.docs).toBe(5);
      expect(manifest.counts.docVerdicts).toBe(2);
      expect(manifest.counts.draftVerdicts).toBe(1);
      expect(manifest.counts.retrievals).toBe(3);
      expect(manifest.counts.resolutions).toBe(2);
      expect(manifest.counts.changes).toBe(2);
      expect(manifest.counts.knowledgeScopes).toBe(1);

      // Import into a FRESH location, asserting no embedding call happens.
      const callsBefore = embedCalls;
      const result = await importKnowledgeBundle({
        bundleDir,
        knowledgeDir: dstDir,
        dbPath: dstDbPath,
      });
      expect(embedCalls).toBe(callsBefore);
      expect(result.skippedChunks).toBe(0);
      expect(result.chunks).toBe(sourceChunks);

      // Markdown carried verbatim (bytes identical), incl. the native-memory marker.
      const srcAuth = await readFile(join(srcDir, "acme", "auth-flow.md"), "utf-8");
      const dstAuth = await readFile(join(dstDir, "acme", "auth-flow.md"), "utf-8");
      expect(dstAuth).toBe(srcAuth);
      const dstNative = await readFile(join(dstDir, "global", "native-notes.md"), "utf-8");
      expect(dstNative).toContain("native_memory_from: /home/user/.claude/CLAUDE.md");

      const target = createStore(dstDbPath);
      try {
        const store = new KnowledgeStore(target.db);

        // Embedding fingerprint restored, so a later boot on the same provider
        // recognizes the carried chunks as current rather than wiping them.
        expect(getSetting(target.db, EMBEDDING_FINGERPRINT_KEY)).toBe(FINGERPRINT);

        // Docs loaded from markdown.
        const auth = store.getDoc("acme", "auth-flow");
        expect(auth?.body).toContain("signed login tokens");
        expect(store.getDoc("global", "native-notes")?.sourceKind).toBe("native-memory");

        // Verdicts + disputes restored.
        const disputed = store.getDoc("acme", "disputed-doc");
        expect(disputed?.verdict).toBe("disputed");
        expect(disputed?.disputes).toHaveLength(1);
        expect(disputed?.disputes?.[0].claim).toBe("retry budget");
        expect(store.getDoc("acme", "old-claim")?.verdict).toBe("superseded");
        expect(store.getDraft("acme", "draft-idea")?.verdict).toBe("disputed");

        // Chunks + embeddings CARRIED (each vector equals the real deterministic
        // embed of its chunk text — proving no re-embed and no zeroing).
        const chunkTotal = (
          target.db.query("SELECT COUNT(*) AS n FROM knowledge_chunks").get() as { n: number }
        ).n;
        expect(chunkTotal).toBe(sourceChunks);
        // Each chunk keeps the chunker version it was written under, so the
        // backfill finds nothing to re-chunk.
        expect(store.chunkStates(auth!.id).every((c) => c.chunkerVersion === CHUNKER_VERSION)).toBe(true);
        for (const chunk of store.getChunks(auth!.id)) {
          expect(chunk.embedding).toEqual(deterministicEmbed(chunk.text));
        }

        // Resolutions (applied + needs_review) restored.
        expect(getKnowledgeResolutions(target.db, "acme")).toHaveLength(2);
        const pending = getPendingResolutions(target.db, "acme");
        expect(pending).toHaveLength(1);
        expect(pending[0].id).toBe("res-2");

        // Retrievals restored with created_at preserved (recency intact).
        const retrievals = target.db
          .query(
            "SELECT doc_slug, created_at FROM knowledge_retrievals ORDER BY created_at"
          )
          .all() as Array<{ doc_slug: string; created_at: string }>;
        expect(retrievals).toHaveLength(3);
        expect(retrievals[0].created_at).toBe("2025-01-02T03:04:05.000Z");
        const usage = getRetrievalUsage(target.db, "acme").find((u) => u.docSlug === "auth-flow");
        expect(usage?.retrievals).toBe(2);
        expect(usage?.lastRetrievedAt).toBe("2025-01-03T03:04:05.000Z");

        // Changes restored, incl. the contradiction's opposing slugs + created_at.
        const changes = getRecentKnowledgeChanges(target.db);
        expect(changes).toHaveLength(2);
        const contradiction = changes.find((c) => c.id === "chg-2");
        expect(contradiction?.contradicted).toEqual(["auth-flow"]);
        expect(changes.find((c) => c.id === "chg-1")?.createdAt).toBe(
          "2025-01-01T00:00:00.000Z"
        );

        // knowledge_scope restored.
        expect(getProject(target.db, "acme")?.knowledgeScope).toBe("global");
        expect(getKnowledgeDefaultScope(target.db, "acme")).toBe("global");

        // Vec index rebuilt from carried vectors (only when sqlite-vec is loadable
        // on this connection; otherwise search runs the brute-force scan).
        if (isVecAvailable(target.db)) {
          expect(result.vecRebuilt).toBe(true);
          const vecRows = (
            target.db.query(`SELECT COUNT(*) AS n FROM ${VEC_TABLE}`).get() as { n: number }
          ).n;
          expect(vecRows).toBe(sourceChunks);
        }
      } finally {
        target.close();
      }

      // Search returns the SAME top hits on both hosts (identical carried
      // embeddings + identical deterministic query embedding).
      const srcStore = createStore(srcDbPath);
      const dstStore = createStore(dstDbPath);
      try {
        const query = "authentication login token secure session";
        const srcBackend = new LocalMarkdownBackend(srcStore.db, PROVIDER_ID, {}, srcDir);
        const dstBackend = new LocalMarkdownBackend(dstStore.db, PROVIDER_ID, {}, dstDir);
        const srcHits = (await srcBackend.search("acme", query)).map((r) => r.slug);
        const dstHits = (await dstBackend.search("acme", query)).map((r) => r.slug);
        expect(dstHits.length).toBeGreaterThan(0);
        expect(dstHits).toEqual(srcHits);
      } finally {
        srcStore.close();
        dstStore.close();
      }
    } finally {
      for (const d of [srcDir, srcDbDir, bundleDir, dstDir, dstDbDir]) {
        await rm(d, { recursive: true, force: true });
      }
    }
  });

  test("refuses a non-empty target without force, then overwrites with force", async () => {
    const srcDir = await tempDir("kb-src-");
    const srcDbDir = await tempDir("kb-srcdb-");
    const bundleDir = await tempDir("kb-bundle-");
    const dstDir = await tempDir("kb-dst-");
    const dstDbDir = await tempDir("kb-dstdb-");
    const srcDbPath = join(srcDbDir, "source.db");
    const dstDbPath = join(dstDbDir, "target.db");

    try {
      await seedSource(srcDir, srcDbPath);
      await exportKnowledgeBundle({ dbPath: srcDbPath, knowledgeDir: srcDir, outDir: bundleDir });

      // First import populates the fresh target.
      await importKnowledgeBundle({ bundleDir, knowledgeDir: dstDir, dbPath: dstDbPath });

      // A second unforced import must refuse the now-non-empty target.
      await expect(
        importKnowledgeBundle({ bundleDir, knowledgeDir: dstDir, dbPath: dstDbPath })
      ).rejects.toThrow(/not empty/i);

      // With force it re-applies without throwing.
      const forced = await importKnowledgeBundle({
        bundleDir,
        knowledgeDir: dstDir,
        dbPath: dstDbPath,
        force: true,
      });
      expect(forced.docs).toBe(5);
      expect(forced.retrievals).toBe(3);

      const target = createStore(dstDbPath);
      try {
        // Idempotent id-keyed ledgers — force didn't duplicate resolutions/changes.
        expect(getKnowledgeResolutions(target.db, "acme")).toHaveLength(2);
        expect(getRecentKnowledgeChanges(target.db)).toHaveLength(2);

        // knowledge_retrievals is NOT id-keyed in the bundle, so a plain replay
        // would double it on every force re-import and inflate the usage/recency
        // signal. The clear-then-replay must keep it idempotent: still 3 rows
        // (not 6), still 2 for auth-flow (not 4), with created_at recency intact.
        const retrievalRows = (
          target.db.query("SELECT COUNT(*) AS n FROM knowledge_retrievals").get() as {
            n: number;
          }
        ).n;
        expect(retrievalRows).toBe(3);
        const authUsage = getRetrievalUsage(target.db, "acme").find(
          (u) => u.docSlug === "auth-flow"
        );
        expect(authUsage?.retrievals).toBe(2);
        expect(authUsage?.lastRetrievedAt).toBe("2025-01-03T03:04:05.000Z");
        const cacheUsage = getRetrievalUsage(target.db, "acme").find(
          (u) => u.docSlug === "cache-policy"
        );
        expect(cacheUsage?.retrievals).toBe(1);
      } finally {
        target.close();
      }
    } finally {
      for (const d of [srcDir, srcDbDir, bundleDir, dstDir, dstDbDir]) {
        await rm(d, { recursive: true, force: true });
      }
    }
  });

  test("imports an older-schema bundle (migrations bring the target current)", async () => {
    const srcDir = await tempDir("kb-src-");
    const srcDbDir = await tempDir("kb-srcdb-");
    const bundleDir = await tempDir("kb-bundle-");
    const dstDir = await tempDir("kb-dst-");
    const dstDbDir = await tempDir("kb-dstdb-");
    const srcDbPath = join(srcDbDir, "source.db");
    const dstDbPath = join(dstDbDir, "target.db");

    try {
      await seedSource(srcDir, srcDbPath);
      await exportKnowledgeBundle({ dbPath: srcDbPath, knowledgeDir: srcDir, outDir: bundleDir });

      // Rewrite the manifest to claim an OLDER source schema. The content
      // checksum covers the payload (markdown + db-state + chunks), not the
      // manifest, so lowering the schema version leaves it valid — this stands in
      // for a bundle produced by an earlier build.
      const manifestPath = join(bundleDir, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
      manifest.sourceSchemaVersion = 30;
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

      const result = await importKnowledgeBundle({
        bundleDir,
        knowledgeDir: dstDir,
        dbPath: dstDbPath,
      });
      expect(result.docs).toBe(5);

      const target = createStore(dstDbPath);
      try {
        // The target migrated to the current schema and the older-schema state
        // landed cleanly.
        expect(new KnowledgeStore(target.db).getDoc("acme", "auth-flow")?.body).toContain(
          "login tokens"
        );
        expect(getProject(target.db, "acme")?.knowledgeScope).toBe("global");
      } finally {
        target.close();
      }
    } finally {
      for (const d of [srcDir, srcDbDir, bundleDir, dstDir, dstDbDir]) {
        await rm(d, { recursive: true, force: true });
      }
    }
  });

  test("refuses a bundle whose payload checksum does not match the manifest", async () => {
    const srcDir = await tempDir("kb-src-");
    const srcDbDir = await tempDir("kb-srcdb-");
    const bundleDir = await tempDir("kb-bundle-");
    const dstDir = await tempDir("kb-dst-");
    const dstDbDir = await tempDir("kb-dstdb-");
    const srcDbPath = join(srcDbDir, "source.db");
    const dstDbPath = join(dstDbDir, "target.db");

    try {
      await seedSource(srcDir, srcDbPath);
      await exportKnowledgeBundle({ dbPath: srcDbPath, knowledgeDir: srcDir, outDir: bundleDir });

      // Tamper with a carried markdown file after export — the manifest checksum
      // no longer matches, so import must refuse rather than restore corrupt data.
      await writeFile(
        join(bundleDir, "knowledge", "acme", "auth-flow.md"),
        "---\ntitle: Tampered\n---\nrewritten body\n",
        "utf-8"
      );

      await expect(
        importKnowledgeBundle({ bundleDir, knowledgeDir: dstDir, dbPath: dstDbPath })
      ).rejects.toThrow(/checksum mismatch/i);
    } finally {
      for (const d of [srcDir, srcDbDir, bundleDir, dstDir, dstDbDir]) {
        await rm(d, { recursive: true, force: true });
      }
    }
  });
});

describe("knowledge bundle import and writer stamps", () => {
  test("an imported doc carries no writer stamp, and a forced import over a stamped doc clears it", async () => {
    const srcDir = await tempDir("kb-src-");
    const srcDbDir = await tempDir("kb-srcdb-");
    const bundleDir = await tempDir("kb-bundle-");
    const dstDir = await tempDir("kb-dst-");
    const dstDbDir = await tempDir("kb-dstdb-");
    const srcDbPath = join(srcDbDir, "source.db");
    const dstDbPath = join(dstDbDir, "target.db");
    const memory = (body: string) => ({
      slug: "persona-owner-deploys",
      title: "deploys",
      body,
      tags: ["persona", "preference"],
      scope: "user" as const,
      ownerUser: "owner",
      originClass: "agent" as const,
    });
    const stampOf = (dbPath: string) => {
      const s = createStore(dbPath);
      try {
        return new KnowledgeStore(s.db).writerOf("global", "persona-owner-deploys");
      } finally {
        s.close();
      }
    };
    try {
      // The source holds the doc stamped as a trusted writer's.
      await writeKnowledgeFile(srcDir, "global", memory("Deploy straight to prod."));
      const src = createStore(srcDbPath);
      try {
        const k = new KnowledgeStore(src.db);
        for (const doc of await new KnowledgeLoader(srcDir).loadProject("global")) k.upsertDoc(doc);
        expect(k.stampWriter("global", "persona-owner-deploys", "persona")).toBe(true);
        expect(k.writerOf("global", "persona-owner-deploys")).toBe("persona");
      } finally {
        src.close();
      }
      await exportKnowledgeBundle({ dbPath: srcDbPath, knowledgeDir: srcDir, outDir: bundleDir });

      await importKnowledgeBundle({ bundleDir, knowledgeDir: dstDir, dbPath: dstDbPath });
      expect(stampOf(dstDbPath)).toBeNull();

      // A target whose own doc is stamped for other content loses the stamp to the import.
      await writeKnowledgeFile(dstDir, "global", memory("Ask before deploying."));
      const dst = createStore(dstDbPath);
      try {
        const k = new KnowledgeStore(dst.db);
        for (const doc of await new KnowledgeLoader(dstDir).loadProject("global")) k.upsertDoc(doc);
        k.stampWriter("global", "persona-owner-deploys", "persona");
      } finally {
        dst.close();
      }
      expect(stampOf(dstDbPath)).toBe("persona");
      await importKnowledgeBundle({ bundleDir, knowledgeDir: dstDir, dbPath: dstDbPath, force: true });
      expect(stampOf(dstDbPath)).toBeNull();
    } finally {
      for (const d of [srcDir, srcDbDir, bundleDir, dstDir, dstDbDir]) {
        await rm(d, { recursive: true, force: true });
      }
    }
  });
});

describe("knowledge bundle — retrieval observability and change privacy", () => {
  /** A source with a team doc and alice's personal doc, embedded, plus the given telemetry. */
  async function seedObservability(knowledgeDir: string, dbPath: string, seed: (db: import("bun:sqlite").Database) => void) {
    await writeKnowledgeFile(knowledgeDir, "acme", {
      slug: "team-doc",
      title: "Team Doc",
      body: "The deploy train leaves at noon.",
      originClass: "owner",
    });
    await writeKnowledgeFile(knowledgeDir, "acme", {
      slug: "alice-legal",
      title: "Alice divorce lawyer notes",
      body: "Private notes.",
      scope: "user",
      ownerUser: "alice",
    });
    const store = createStore(dbPath);
    await loadAndEmbed(new KnowledgeStore(store.db), new KnowledgeLoader(knowledgeDir), "acme");
    setSetting(store.db, EMBEDDING_FINGERPRINT_KEY, FINGERPRINT);
    seed(store.db);
    store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    store.close();
  }

  async function roundTrip(seed: (db: import("bun:sqlite").Database) => void) {
    const dirs = await Promise.all(["kb-src-", "kb-srcdb-", "kb-bundle-", "kb-dst-", "kb-dstdb-"].map(tempDir));
    const [srcDir, srcDbDir, bundleDir, dstDir, dstDbDir] = dirs;
    const dstDbPath = join(dstDbDir, "target.db");
    await seedObservability(srcDir, join(srcDbDir, "source.db"), seed);
    const manifest = await exportKnowledgeBundle({ dbPath: join(srcDbDir, "source.db"), knowledgeDir: srcDir, outDir: bundleDir });
    await importKnowledgeBundle({ bundleDir, knowledgeDir: dstDir, dbPath: dstDbPath });
    return {
      manifest,
      target: createStore(dstDbPath),
      cleanup: async () => {
        for (const d of dirs) await rm(d, { recursive: true, force: true });
      },
    };
  }

  test("every observability field and the change privacy flag survive the move", async () => {
    const { manifest, target, cleanup } = await roundTrip((db) => {
      db.run(
        `INSERT INTO knowledge_retrievals
           (doc_project, doc_slug, query, rank, score, surface, created_at, injected, launch_id, components_json,
            algo_version, raw_score, relevance, layer, source_kind, scope, doc_owner, drop_reason)
         VALUES ('acme', 'team-doc', 'deploy', 0, 0.02, 'expert', '2025-02-01 00:00:00', NULL, NULL,
                 '{"score":0.02,"rawScore":0.01}', '2026-10-05.1', 0.01, 0.01, 'docs', 'unclassified', 'project', NULL, 'floor'),
                ('acme', 'team-doc', 'deploy', 0, 0.03, 'inject', '2025-02-02 00:00:00', 0, 'L1', NULL,
                 '2026-10-05.1', NULL, NULL, 'docs', 'unclassified', 'project', NULL, 'budget'),
                ('acme', 'alice-legal', 'lawyer', 0, 0.5, 'search', '2025-02-03 00:00:00', NULL, NULL, NULL,
                 '2026-10-05.1', NULL, NULL, 'personal', 'unclassified', 'user', 'alice', NULL)`
      );
      createKnowledgeChange(db, {
        id: "chg-personal",
        projectId: "acme",
        slug: "alice-legal",
        kind: "accepted",
        title: "Alice divorce lawyer notes",
        createdAt: "2025-02-03T00:00:00.000Z",
        personal: true,
        ownerUser: "alice",
      });
    });
    try {
      expect(manifest.bundleVersion).toBe(2);
      const rows = target.db
        .query(
          "SELECT doc_slug, injected, launch_id, components_json, algo_version, raw_score, layer, doc_owner, drop_reason FROM knowledge_retrievals ORDER BY created_at"
        )
        .all();
      expect(rows).toEqual([
        { doc_slug: "team-doc", injected: null, launch_id: null, components_json: '{"score":0.02,"rawScore":0.01}', algo_version: "2026-10-05.1", raw_score: 0.01, layer: "docs", doc_owner: null, drop_reason: "floor" },
        { doc_slug: "team-doc", injected: 0, launch_id: "L1", components_json: null, algo_version: "2026-10-05.1", raw_score: null, layer: "docs", doc_owner: null, drop_reason: "budget" },
        { doc_slug: "alice-legal", injected: null, launch_id: null, components_json: null, algo_version: "2026-10-05.1", raw_score: null, layer: "personal", doc_owner: "alice", drop_reason: null },
      ]);
      // The floor-gated row stays a gated candidate, not a retrieval.
      const team = getRetrievalUsage(target.db, "acme").find((u) => u.docSlug === "team-doc");
      expect(team).toMatchObject({ retrievals: 1, gated: 1 });
      expect(getRetrievalUsage(target.db, "acme", { viewer: "bob" }).map((u) => u.docSlug)).toEqual(["team-doc"]);
      expect(getRecentKnowledgeChanges(target.db, 50, "bob")).toEqual([]);
      expect(getRecentKnowledgeChanges(target.db, 50, "alice").map((c) => c.id)).toEqual(["chg-personal"]);
    } finally {
      target.close();
      await cleanup();
    }
  });

  test("rows carried without placement (an older bundle or source) take it from the imported doc", async () => {
    const { target, cleanup } = await roundTrip((db) => {
      db.run(
        `INSERT INTO knowledge_retrievals (doc_project, doc_slug, query, rank, surface, created_at)
         VALUES ('acme', 'alice-legal', 'lawyer', 0, 'search', '2025-02-03 00:00:00'),
                ('acme', 'team-doc', 'deploy', 0, 'search', '2025-02-04 00:00:00')`
      );
      db.run(
        `INSERT INTO knowledge_changes (id, project_id, slug, kind, title, created_at, personal)
         VALUES ('legacy', 'acme', 'alice-legal', 'accepted', 'Alice divorce lawyer notes', '2025-02-03', NULL),
                ('home', 'global', 'native-mem-home-claude-md', 'accepted', 'owner private CLAUDE.md', '2025-02-04', NULL)`
      );
    });
    try {
      const rows = target.db
        .query("SELECT doc_slug, layer, scope, doc_owner FROM knowledge_retrievals ORDER BY created_at")
        .all();
      expect(rows).toEqual([
        { doc_slug: "alice-legal", layer: "personal", scope: "user", doc_owner: "alice" },
        { doc_slug: "team-doc", layer: "docs", scope: "project", doc_owner: null },
      ]);
      expect(getRetrievalUsage(target.db, "acme", { viewer: "bob" }).map((u) => u.docSlug)).toEqual(["team-doc"]);
      const change = target.db.query("SELECT personal, owner_user FROM knowledge_changes WHERE id = 'legacy'").get();
      expect(change).toEqual({ personal: 1, owner_user: "alice" });
      // The home mirror's doc is not in the bundle: its flag stays unknown, and
      // the home-mirror slug rule keeps it out of every view but nobody's.
      const home = target.db.query("SELECT personal, owner_user FROM knowledge_changes WHERE id = 'home'").get();
      expect(home).toEqual({ personal: null, owner_user: null });
      for (const viewer of [null, "bob", "owner"]) {
        expect(getRecentKnowledgeChanges(target.db, 50, viewer).map((c) => c.id)).not.toContain("home");
      }
    } finally {
      target.close();
      await cleanup();
    }
  });
});
