import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { mkdtemp, mkdir, writeFile, rm, utimes } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  KnowledgeStore,
  chunkEmbedding,
  registerEmbeddingProvider,
  searchKnowledge,
  CHUNKER_VERSION,
} from "@standup/knowledge";
import { createStore, getSetting, setSetting, upsertProject } from "@standup/store";
import { GLOBAL_PROJECT_ID } from "@standup/shared";
import { KnowledgeSync } from "./knowledge-sync.js";
import { createServer } from "./server.js";

async function tempKnowledgeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "standup-knowledge-sync-"));
}

// Seeds one doc plus a single chunk of the given width, standing in for a
// corpus already embedded by some provider without going through the network.
function seedEmbeddedDoc(store: KnowledgeStore, dimensions: number): string {
  const docId = store.upsertDoc({
    id: randomUUID(),
    projectId: "proj",
    slug: "seeded",
    title: "Seeded",
    body: "a body that was already embedded",
    filePath: "/tmp/seeded.md",
    updatedAt: new Date(),
    originClass: "owner",
  });
  store.upsertChunk({
    id: randomUUID(),
    knowledgeId: docId,
    chunkIndex: 0,
    text: "a body that was already embedded",
    embedding: new Array(dimensions).fill(0.1),
  });
  return docId;
}

function chunkCount(db: Database): number {
  return (
    db.query("SELECT COUNT(*) AS n FROM knowledge_chunks").get() as { n: number }
  ).n;
}

describe("KnowledgeSync.syncDrafts", () => {
  test("reconciles .drafts/ into knowledge_drafts without touching search tables", async () => {
    const dir = await tempKnowledgeDir();
    try {
      const projectDir = join(dir, "proj");
      await mkdir(join(projectDir, ".drafts"), { recursive: true });
      await writeFile(
        join(projectDir, ".drafts", "toolchain.md"),
        "---\ntitle: Toolchain\ngenerated_from_sha: abc123\n---\nrun bun test"
      );

      const db = new Database(":memory:");
      // "ollama" so that if syncDrafts ever accidentally started embedding,
      // it would be reaching for a real provider rather than silently no-op
      // via a null provider.
      const sync = new KnowledgeSync(db, dir, "ollama");
      await sync.syncDrafts("proj");

      const store = new KnowledgeStore(db);
      const drafts = store.getDraftsByProject("proj");
      expect(drafts).toHaveLength(1);
      expect(drafts[0].slug).toBe("toolchain");
      expect(drafts[0].generatedFromSha).toBe("abc123");

      // Not chunked, not embedded, not in the accepted table at all.
      const chunkCount = (
        db.query("SELECT COUNT(*) as n FROM knowledge_chunks").get() as { n: number }
      ).n;
      expect(chunkCount).toBe(0);
      expect(store.getDocsByProject("proj")).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("removes rows whose draft file was deleted from disk", async () => {
    const dir = await tempKnowledgeDir();
    try {
      const projectDir = join(dir, "proj");
      await mkdir(join(projectDir, ".drafts"), { recursive: true });
      const filePath = join(projectDir, ".drafts", "gone.md");
      await writeFile(filePath, "---\ntitle: Gone\n---\nbody");

      const db = new Database(":memory:");
      const sync = new KnowledgeSync(db, dir, null);
      await sync.syncDrafts("proj");

      const store = new KnowledgeStore(db);
      expect(store.getDraftsByProject("proj")).toHaveLength(1);

      await rm(filePath);
      await sync.syncDrafts("proj");

      expect(store.getDraftsByProject("proj")).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("drafts never surface from searchText/searchEmbeddings — write a draft and an accepted doc with the same term, only the accepted one is findable", async () => {
    const dir = await tempKnowledgeDir();
    try {
      const projectDir = join(dir, "proj");
      await mkdir(join(projectDir, ".drafts"), { recursive: true });
      await writeFile(
        join(projectDir, ".drafts", "draft-doc.md"),
        "---\ntitle: Draft Doc\n---\nunobtainium is the load-bearing term"
      );
      await writeFile(
        join(projectDir, "real-doc.md"),
        "---\ntitle: Real Doc\n---\nunobtainium is the load-bearing term"
      );

      const db = new Database(":memory:");
      const sync = new KnowledgeSync(db, dir, null);
      await sync.syncProject("proj");
      await sync.syncDrafts("proj");

      const { searchKnowledge } = await import("@standup/knowledge");
      const results = await searchKnowledge(db, "proj", "unobtainium", null);

      expect(results.map((r) => r.slug)).toEqual(["real-doc"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("KnowledgeSync.syncProject provenance reconciliation", () => {
  test("repairs a stale origin_class on an unchanged file (the mtime-skip path) without rewriting the body", async () => {
    const dir = await tempKnowledgeDir();
    try {
      const projectDir = join(dir, "proj");
      await mkdir(projectDir, { recursive: true });
      // A hand-authored doc with no explicit origin_class — the loader resolves
      // this to `owner` (a doc in the user's own knowledge dir).
      await writeFile(
        join(projectDir, "practices.md"),
        "---\ntitle: Conventions\n---\nthe real body on disk"
      );

      const db = new Database(":memory:");
      const store = new KnowledgeStore(db);
      // Simulate a row first written under the old default: origin_class stored
      // as `untrusted`, a DIFFERENT (stale) body, and a mtime in the future so
      // syncProject takes the skip path rather than a full re-upsert.
      store.upsertDoc({
        id: randomUUID(),
        projectId: "proj",
        slug: "practices",
        title: "Conventions",
        body: "an older body the skip path must NOT rewrite",
        filePath: join(projectDir, "practices.md"),
        updatedAt: new Date(Date.now() + 60_000),
        originClass: "untrusted",
      });

      await new KnowledgeSync(db, dir, null).syncProject("proj");

      const got = store.getDoc("proj", "practices");
      // Provenance repaired from the file …
      expect(got?.originClass).toBe("owner");
      // … while the body stayed untouched, proving the skip path ran (a full
      // upsert would have replaced it with the on-disk body).
      expect(got?.body).toBe("an older body the skip path must NOT rewrite");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("repairs a stale scope on an unchanged reserved GLOBAL-corpus doc, so the backfill's reverting a doc to 'project' self-heals to 'global'", async () => {
    const dir = await tempKnowledgeDir();
    try {
      // A best-practice doc physically homed in the reserved GLOBAL corpus, with
      // no scope frontmatter — the loader now infers scope='global' for it.
      const globalDir = join(dir, GLOBAL_PROJECT_ID);
      await mkdir(globalDir, { recursive: true });
      await writeFile(
        join(globalDir, "review-workflow.md"),
        "---\ntitle: Code review workflow\n---\nalways open pull requests as drafts"
      );

      const db = new Database(":memory:");
      const store = new KnowledgeStore(db);
      // Simulate the already-migrated dogfood DB: the scope column pre-exists (so
      // the one-time global backfill won't fire again) and this row was written
      // with the stale scope='project' before the loader inferred 'global'. Future
      // mtime → syncProject takes the skip path, not a re-upsert. Without the
      // reconcile, the row would keep scope='project' forever and — because its
      // project_id is 'global' — fall out of every scope gate.
      store.upsertDoc({
        id: randomUUID(),
        projectId: GLOBAL_PROJECT_ID,
        slug: "review-workflow",
        title: "Code review workflow",
        body: "an older body the skip path must NOT rewrite",
        filePath: join(globalDir, "review-workflow.md"),
        updatedAt: new Date(Date.now() + 60_000),
        originClass: "owner",
        scope: "project",
      });

      await new KnowledgeSync(db, dir, null).syncProject(GLOBAL_PROJECT_ID);

      const got = store.getDoc(GLOBAL_PROJECT_ID, "review-workflow");
      // Scope self-healed to 'global' from the loader's inference …
      expect(got?.scope).toBe("global");
      // … while the body stayed untouched, proving the mtime-skip path ran.
      expect(got?.body).toBe("an older body the skip path must NOT rewrite");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("honors an explicit origin_class in frontmatter — reconciliation follows the file both ways, it is not a blanket promotion", async () => {
    const dir = await tempKnowledgeDir();
    try {
      const projectDir = join(dir, "proj");
      await mkdir(projectDir, { recursive: true });
      // The file explicitly declares an untrusted origin (e.g. a remote ingest).
      await writeFile(
        join(projectDir, "ingested.md"),
        "---\ntitle: Ingested\norigin_class: untrusted\n---\nbody"
      );

      const db = new Database(":memory:");
      const store = new KnowledgeStore(db);
      // A stale row wrongly stored as trusted, future mtime → skip path.
      store.upsertDoc({
        id: randomUUID(),
        projectId: "proj",
        slug: "ingested",
        title: "Ingested",
        body: "body",
        filePath: join(projectDir, "ingested.md"),
        updatedAt: new Date(Date.now() + 60_000),
        originClass: "owner",
      });

      await new KnowledgeSync(db, dir, null).syncProject("proj");

      // Reconciled DOWN to the file's explicit class — the file is authoritative,
      // so this is not a one-way promote-to-owner.
      expect(store.getDoc("proj", "ingested")?.originClass).toBe("untrusted");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// The fingerprint reindexOnProviderChange records for a provider/model/width/digest.
function fingerprint(provider: string, model: string, width: number | string, digest: string): string {
  return `${provider}:${model}:${width}|digest=${digest}|chunker=${CHUNKER_VERSION}`;
}

// Registers a provider on the seam that embeds every text to the same constant
// vector of `dims` (so a stored constant vector re-embeds at cosine 1) and
// reports whatever digest `state.digest` holds at call time.
function registerFake(
  id: string,
  dims: number,
  state: {
    digest?: string | null;
    digestError?: boolean;
    vector?: () => number[] | null;
  } = {}
): void {
  registerEmbeddingProvider({
    id,
    defaultModel: `${id}-model`,
    dimensions: dims,
    embed: async () => (state.vector ? state.vector() : new Array(dims).fill(0.2)),
    modelDigest: async () => {
      if (state.digestError) throw new Error("digest endpoint unreachable");
      return state.digest === undefined ? `sha256-${id}` : state.digest;
    },
  });
}

describe("KnowledgeSync.reindexOnProviderChange", () => {
  test("clears the chunk index when the provider changes, keeping docs for re-embed", async () => {
    const dir = await tempKnowledgeDir();
    const { db, close } = createStore(":memory:");
    try {
      registerFake("fake-switch-a", 768);
      registerFake("fake-switch-b", 1024);
      const store = new KnowledgeStore(db);

      // First boot with an empty corpus records the fingerprint — nothing
      // embedded yet, so nothing to clear.
      await new KnowledgeSync(db, dir, "fake-switch-a").reindexOnProviderChange();
      expect(getSetting(db, "embedding_provider_fingerprint")).toBe(
        fingerprint("fake-switch-a", "fake-switch-a-model", 768, "sha256-fake-switch-a")
      );

      // The corpus is then embedded at 768. Re-running on the same provider
      // matches the recorded fingerprint and leaves the chunk in place.
      const docId = seedEmbeddedDoc(store, 768);
      await new KnowledgeSync(db, dir, "fake-switch-a").reindexOnProviderChange();
      expect(chunkCount(db)).toBe(1);

      // Switching providers must clear every chunk so the corpus is re-embedded
      // rather than left as a mixed index. The doc itself survives so syncAll's
      // backfill re-embeds it.
      await new KnowledgeSync(db, dir, "fake-switch-b").reindexOnProviderChange();
      expect(chunkCount(db)).toBe(0);
      expect(store.getDoc("proj", "seeded")?.id).toBe(docId);
      expect(getSetting(db, "embedding_provider_fingerprint")).toBe(
        fingerprint("fake-switch-b", "fake-switch-b-model", 1024, "sha256-fake-switch-b")
      );
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("leaves the chunk index intact when provider, model and digest are unchanged", async () => {
    const dir = await tempKnowledgeDir();
    const { db, close } = createStore(":memory:");
    try {
      registerFake("fake-stable", 768);
      const store = new KnowledgeStore(db);

      const sync = new KnowledgeSync(db, dir, "fake-stable");
      // Record the fingerprint on the empty corpus, then embed under the same
      // provider; every subsequent same-provider boot is a no-op (the canary
      // reproduces the stored vector).
      await sync.reindexOnProviderChange();
      seedEmbeddedDoc(store, 768);
      await sync.reindexOnProviderChange();
      await sync.reindexOnProviderChange();

      expect(chunkCount(db)).toBe(1);
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a pre-digest fingerprint on the same model keeps its vectors and re-chunks them in the backfill, then stays stable", async () => {
    const dir = await tempKnowledgeDir();
    const { db, close } = createStore(":memory:");
    try {
      registerFake("fake-legacy", 768);
      const store = new KnowledgeStore(db);
      const docId = seedEmbeddedDoc(store, 768);
      // A chunk written before chunker versioning.
      db.run("UPDATE knowledge_chunks SET chunker_version = NULL");
      setSetting(db, "embedding_provider_fingerprint", "fake-legacy:fake-legacy-model");

      const sync = new KnowledgeSync(db, dir, "fake-legacy");
      expect(await sync.reindexOnProviderChange()).toBe("rechunk");
      expect(chunkCount(db)).toBe(1);
      expect(getSetting(db, "embedding_provider_fingerprint")).toBe(
        fingerprint("fake-legacy", "fake-legacy-model", 768, "sha256-fake-legacy")
      );

      // The backfill re-embeds the unversioned chunk even though the doc's chunk
      // count already matches the chunker's.
      const result = await sync.backfillEmbeddings();
      expect(result.embedded).toBe(1);
      expect(store.chunkStates(docId).map((c) => c.chunkerVersion)).toEqual([CHUNKER_VERSION]);
      expect((await sync.backfillEmbeddings()).embedded).toBe(0);
      expect(await new KnowledgeSync(db, dir, "fake-legacy").reindexOnProviderChange()).toBe("current");
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the backfill yields while the host is short on headroom and embeds once it is not", async () => {
    const dir = await tempKnowledgeDir();
    const { db, close } = createStore(":memory:");
    try {
      registerFake("fake-yield", 768);
      const store = new KnowledgeStore(db);
      const docId = seedEmbeddedDoc(store, 768);
      db.run("UPDATE knowledge_chunks SET chunker_version = NULL");
      setSetting(db, "embedding_provider_fingerprint", "fake-yield:fake-yield-model");
      const sync = new KnowledgeSync(db, dir, "fake-yield");
      expect(await sync.reindexOnProviderChange()).toBe("rechunk");

      let pressure: string | null = "memory is low (1.4 GB free, 2.0 GB is kept in reserve)";
      sync.setHostPressure(() => pressure);
      expect(await sync.backfillEmbeddings()).toEqual({ docs: 0, embedded: 0, failed: 0, aborted: true });
      expect(store.chunkStates(docId).map((c) => c.chunkerVersion)).toEqual([null]);

      pressure = null;
      expect((await sync.backfillEmbeddings()).embedded).toBe(1);
      expect(store.chunkStates(docId).map((c) => c.chunkerVersion)).toEqual([CHUNKER_VERSION]);
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a pre-digest fingerprint naming another model clears the corpus", async () => {
    const dir = await tempKnowledgeDir();
    const { db, close } = createStore(":memory:");
    try {
      registerFake("fake-legacy-switch", 768);
      seedEmbeddedDoc(new KnowledgeStore(db), 768);
      setSetting(db, "embedding_provider_fingerprint", "fake-legacy-switch:older-model");

      expect(await new KnowledgeSync(db, dir, "fake-legacy-switch").reindexOnProviderChange()).toBe(
        "respace"
      );
      expect(chunkCount(db)).toBe(0);
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a model digest change under the same model name re-embeds the corpus", async () => {
    const dir = await tempKnowledgeDir();
    const { db, close } = createStore(":memory:");
    try {
      const state = { digest: "sha256-weights-v1" as string | null };
      registerFake("fake-repull", 768, state);
      const store = new KnowledgeStore(db);

      await new KnowledgeSync(db, dir, "fake-repull").reindexOnProviderChange();
      seedEmbeddedDoc(store, 768);
      await new KnowledgeSync(db, dir, "fake-repull").reindexOnProviderChange();
      expect(chunkCount(db)).toBe(1);

      // `ollama pull` of the same tag swapped the weights: same provider, model
      // and width, a different digest.
      state.digest = "sha256-weights-v2";
      await new KnowledgeSync(db, dir, "fake-repull").reindexOnProviderChange();
      expect(chunkCount(db)).toBe(0);
      expect(getSetting(db, "embedding_provider_fingerprint")).toBe(
        fingerprint("fake-repull", "fake-repull-model", 768, "sha256-weights-v2")
      );
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a failed digest lookup degrades: no clear, the recorded digest-bearing fingerprint is kept", async () => {
    const dir = await tempKnowledgeDir();
    const { db, close } = createStore(":memory:");
    try {
      const state: { digest?: string | null; digestError?: boolean } = {};
      registerFake("fake-flaky-digest", 768, state);
      const store = new KnowledgeStore(db);

      await new KnowledgeSync(db, dir, "fake-flaky-digest").reindexOnProviderChange();
      seedEmbeddedDoc(store, 768);
      const recorded = getSetting(db, "embedding_provider_fingerprint");
      expect(recorded).toBe(
        fingerprint("fake-flaky-digest", "fake-flaky-digest-model", 768, "sha256-fake-flaky-digest")
      );

      // The digest endpoint is down this boot: the lookup throws. The rest of
      // the fingerprint matches and the canary reproduces the stored vector, so
      // nothing is cleared, and the digest-bearing fingerprint stays recorded.
      state.digestError = true;
      await new KnowledgeSync(db, dir, "fake-flaky-digest").reindexOnProviderChange();
      expect(chunkCount(db)).toBe(1);
      expect(getSetting(db, "embedding_provider_fingerprint")).toBe(recorded);

      // A lookup that finds nothing degrades the same way.
      state.digestError = false;
      state.digest = null;
      await new KnowledgeSync(db, dir, "fake-flaky-digest").reindexOnProviderChange();
      expect(chunkCount(db)).toBe(1);
      expect(getSetting(db, "embedding_provider_fingerprint")).toBe(recorded);
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a digest that becomes known after a digest-less boot is recorded without a reindex", async () => {
    const dir = await tempKnowledgeDir();
    const { db, close } = createStore(":memory:");
    try {
      const state: { digest?: string | null } = { digest: null };
      registerFake("fake-late-digest", 768, state);
      const store = new KnowledgeStore(db);

      await new KnowledgeSync(db, dir, "fake-late-digest").reindexOnProviderChange();
      expect(getSetting(db, "embedding_provider_fingerprint")).toBe(
        fingerprint("fake-late-digest", "fake-late-digest-model", 768, "unknown")
      );
      seedEmbeddedDoc(store, 768);

      state.digest = "sha256-now-known";
      await new KnowledgeSync(db, dir, "fake-late-digest").reindexOnProviderChange();
      expect(chunkCount(db)).toBe(1);
      expect(getSetting(db, "embedding_provider_fingerprint")).toBe(
        fingerprint("fake-late-digest", "fake-late-digest-model", 768, "sha256-now-known")
      );
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a canary whose fresh embeddings drift from the stored vectors re-embeds the corpus", async () => {
    const dir = await tempKnowledgeDir();
    const { db, close } = createStore(":memory:");
    try {
      // Same name, same digest, same width — yet the provider now embeds into a
      // different direction than the stored vectors (fill(0.1)).
      const drifted = new Array(768).fill(0).map((_, i) => (i % 2 === 0 ? 1 : -1));
      const state: { vector?: () => number[] | null } = {};
      registerFake("fake-drift", 768, state);
      const store = new KnowledgeStore(db);

      await new KnowledgeSync(db, dir, "fake-drift").reindexOnProviderChange();
      seedEmbeddedDoc(store, 768);
      await new KnowledgeSync(db, dir, "fake-drift").reindexOnProviderChange();
      expect(chunkCount(db)).toBe(1);

      state.vector = () => drifted;
      await new KnowledgeSync(db, dir, "fake-drift").reindexOnProviderChange();
      expect(chunkCount(db)).toBe(0);
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a canary that cannot embed is inconclusive and clears nothing", async () => {
    const dir = await tempKnowledgeDir();
    const { db, close } = createStore(":memory:");
    try {
      const state: { vector?: () => number[] | null } = {};
      registerFake("fake-down", 768, state);
      const store = new KnowledgeStore(db);

      await new KnowledgeSync(db, dir, "fake-down").reindexOnProviderChange();
      seedEmbeddedDoc(store, 768);
      state.vector = () => null;
      await new KnowledgeSync(db, dir, "fake-down").reindexOnProviderChange();
      expect(chunkCount(db)).toBe(1);
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("clears on a first boot with no recorded fingerprint", async () => {
    const dir = await tempKnowledgeDir();
    const { db, close } = createStore(":memory:");
    try {
      registerFake("fake-first-boot", 1024);
      const store = new KnowledgeStore(db);
      seedEmbeddedDoc(store, 768); // embedded before any fingerprint was recorded

      await new KnowledgeSync(db, dir, "fake-first-boot").reindexOnProviderChange();

      expect(chunkCount(db)).toBe(0);
      expect(getSetting(db, "embedding_provider_fingerprint")).toBe(
        fingerprint("fake-first-boot", "fake-first-boot-model", 1024, "sha256-fake-first-boot")
      );
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a non-default model whose real width differs from the plugin's declared dimensions does not re-clear on later boots", async () => {
    const dir = await tempKnowledgeDir();
    const { db, close } = createStore(":memory:");
    try {
      // Declares 1024 (its default model's width), but the configured model
      // really embeds at 1536.
      registerFake("fake-declared", 1024, { vector: () => new Array(1536).fill(0.2) });
      const store = new KnowledgeStore(db);
      const config = { model: "wide-model" };

      await new KnowledgeSync(db, dir, "fake-declared", config).reindexOnProviderChange();
      expect(getSetting(db, "embedding_provider_fingerprint")).toBe(
        fingerprint("fake-declared", "wide-model", 1024, "sha256-fake-declared")
      );

      // syncAll then embeds the corpus at the model's true 1536 width.
      seedEmbeddedDoc(store, 1536);

      // Restart: same provider/model, so the fingerprint matches and the 1536
      // chunk must survive even though 1536 !== the declared 1024.
      await new KnowledgeSync(db, dir, "fake-declared", config).reindexOnProviderChange();
      expect(chunkCount(db)).toBe(1);
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a dimensions-only switch on an unchanged model clears the corpus for re-embed", async () => {
    const dir = await tempKnowledgeDir();
    const { db, close } = createStore(":memory:");
    try {
      registerFake("fake-titan", 1024);
      const store = new KnowledgeStore(db);

      await new KnowledgeSync(db, dir, "fake-titan").reindexOnProviderChange();
      seedEmbeddedDoc(store, 1024);
      await new KnowledgeSync(db, dir, "fake-titan").reindexOnProviderChange();
      expect(chunkCount(db)).toBe(1);

      // Narrowing the output to 512 keeps the same model id, so only the width
      // component moves the fingerprint.
      await new KnowledgeSync(db, dir, "fake-titan", { dimensions: 512 }).reindexOnProviderChange();
      expect(chunkCount(db)).toBe(0);
      expect(getSetting(db, "embedding_provider_fingerprint")).toBe(
        fingerprint("fake-titan", "fake-titan-model", 512, "sha256-fake-titan")
      );
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a provider switch clears then re-embeds the whole corpus at the new width, leaving no mixed-dimension chunks", async () => {
    const dir = await tempKnowledgeDir();
    const { db, close } = createStore(":memory:");
    try {
      registerFake("fake-narrow", 8);
      registerFake("fake-wide", 16);

      const projectDir = join(dir, "proj");
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        join(projectDir, "doc-a.md"),
        "---\ntitle: Doc A\n---\nfirst body that must be re-embedded on switch"
      );
      await writeFile(
        join(projectDir, "doc-b.md"),
        "---\ntitle: Doc B\n---\nsecond body that must be re-embedded on switch"
      );

      const store = new KnowledgeStore(db);

      const narrow = new KnowledgeSync(db, dir, "fake-narrow");
      await narrow.reindexOnProviderChange();
      await narrow.syncProject("proj");
      expect(store.storedChunkDimensions()).toBe(8);
      const narrowChunks = chunkCount(db);
      expect(narrowChunks).toBeGreaterThan(0);

      // Switch: reindex clears the 8-dim chunks. A request-path resync embeds
      // nothing for the unchanged files; the backfill re-embeds every doc at 16.
      const wide = new KnowledgeSync(db, dir, "fake-wide");
      await wide.reindexOnProviderChange();
      expect(chunkCount(db)).toBe(0);
      await wide.syncProject("proj");
      expect(chunkCount(db)).toBe(0);
      await wide.backfillEmbeddings();

      expect(chunkCount(db)).toBe(narrowChunks);
      const widths = (
        db
          .query("SELECT embedding_blob, embedding_json FROM knowledge_chunks")
          .all() as { embedding_blob: Uint8Array | null; embedding_json: string }[]
      ).map((r) => chunkEmbedding(r.embedding_blob, r.embedding_json)!.length);
      expect(new Set(widths)).toEqual(new Set([16]));
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a provider that declares no dimensions fingerprints its width as native", async () => {
    const dir = await tempKnowledgeDir();
    const { db, close } = createStore(":memory:");
    try {
      registerEmbeddingProvider({
        id: "fake-dimensionless",
        defaultModel: "dimless-v1",
        embed: async () => new Array(512).fill(0.4),
      });

      const store = new KnowledgeStore(db);
      const docId = seedEmbeddedDoc(store, 768); // embedded before any fingerprint

      await new KnowledgeSync(db, dir, "fake-dimensionless").reindexOnProviderChange();

      expect(chunkCount(db)).toBe(0);
      expect(store.getDoc("proj", "seeded")?.id).toBe(docId);
      // No modelDigest hook: the model id stands in as the digest.
      expect(getSetting(db, "embedding_provider_fingerprint")).toBe(
        fingerprint("fake-dimensionless", "dimless-v1", "native", "dimless-v1")
      );
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an unregistered provider id (typo/case-mismatch) leaves a healthy index and fingerprint untouched", async () => {
    const dir = await tempKnowledgeDir();
    const { db, close } = createStore(":memory:");
    try {
      registerFake("fake-cased", 768);
      const store = new KnowledgeStore(db);

      await new KnowledgeSync(db, dir, "fake-cased").reindexOnProviderChange();
      seedEmbeddedDoc(store, 768);
      await new KnowledgeSync(db, dir, "fake-cased").reindexOnProviderChange();
      expect(chunkCount(db)).toBe(1);
      const recorded = getSetting(db, "embedding_provider_fingerprint");

      // A capitalized (unregistered) id resolves to no plugin and could never
      // re-embed, so the healthy index must NOT be cleared and the recorded
      // fingerprint must stay the working one.
      await new KnowledgeSync(db, dir, "Fake-Cased").reindexOnProviderChange();
      expect(chunkCount(db)).toBe(1);
      expect(getSetting(db, "embedding_provider_fingerprint")).toBe(recorded);

      await new KnowledgeSync(db, dir, "fake-cased").reindexOnProviderChange();
      expect(chunkCount(db)).toBe(1);
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("no-op with no provider configured — stale chunks stay inert, no fingerprint recorded", async () => {
    const dir = await tempKnowledgeDir();
    const { db, close } = createStore(":memory:");
    try {
      const store = new KnowledgeStore(db);
      seedEmbeddedDoc(store, 768);

      await new KnowledgeSync(db, dir, null).reindexOnProviderChange();

      expect(chunkCount(db)).toBe(1);
      expect(getSetting(db, "embedding_provider_fingerprint")).toBeNull();
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("KnowledgeSync.syncProject index exactness", () => {
  function vecRowsFor(db: Database, knowledgeId: string): number {
    return (
      db
        .query(
          `SELECT COUNT(*) AS n FROM knowledge_chunks_vec
           WHERE rowid IN (SELECT rowid FROM knowledge_chunks WHERE knowledge_id = ?)`
        )
        .get(knowledgeId) as { n: number }
    ).n;
  }

  test("an edited doc is found by its new wording and not by its old", async () => {
    const dir = await tempKnowledgeDir();
    const { db, close } = createStore(":memory:");
    try {
      const projectDir = join(dir, "proj");
      await mkdir(projectDir, { recursive: true });
      const file = join(projectDir, "retry-policy.md");
      await writeFile(file, "---\ntitle: Retry policy\n---\nRetry three attempts then give up.");

      const sync = new KnowledgeSync(db, dir, null);
      await sync.syncProject("proj");

      await writeFile(file, "---\ntitle: Retry policy\n---\nRetry FIVE attempts with jitter.");
      const later = new Date(Date.now() + 60_000);
      await utimes(file, later, later);
      await sync.syncProject("proj");

      expect((await searchKnowledge(db, "proj", "jitter", null)).map((r) => r.slug)).toEqual([
        "retry-policy",
      ]);
      expect(await searchKnowledge(db, "proj", "three", null)).toEqual([]);
      const integrity = new KnowledgeStore(db).checkIndexIntegrity();
      expect(integrity.ftsRows).toBe(1);
      expect(integrity.orphanFts + integrity.staleFts + integrity.missingFts).toBe(0);
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a shrinking edit removes the tail chunks and their vec rows", async () => {
    const dir = await tempKnowledgeDir();
    const { db, close } = createStore(":memory:");
    try {
      registerFake("fake-shrink", 8);
      const projectDir = join(dir, "proj");
      await mkdir(projectDir, { recursive: true });
      const file = join(projectDir, "deploy.md");
      const sections = Array.from(
        { length: 6 },
        (_, i) => `## Step ${i + 1}\n\n${`Run deploy command number ${i + 1}. `.repeat(40)}`
      );
      await writeFile(file, `---\ntitle: Deploy\n---\n${sections.join("\n\n")}`);

      const sync = new KnowledgeSync(db, dir, "fake-shrink");
      await sync.syncProject("proj");
      const store = new KnowledgeStore(db);
      const id = store.getDoc("proj", "deploy")!.id;
      store.rebuildVecIndex();
      const before = store.chunkIndexes(id).length;
      expect(before).toBeGreaterThan(2);
      if (store.vecReady()) expect(vecRowsFor(db, id)).toBe(before);

      await writeFile(file, `---\ntitle: Deploy\n---\n${sections[0]}`);
      const later = new Date(Date.now() + 60_000);
      await utimes(file, later, later);
      await sync.syncProject("proj");

      const after = store.chunkIndexes(id);
      expect(after).toEqual([0]);
      expect(store.getChunks(id)[0].text).toContain("Step 1");
      if (store.vecReady()) {
        expect(vecRowsFor(db, id)).toBe(1);
        expect(store.checkIndexIntegrity().vecChunkMismatch).toBe(0);
      }
      expect(store.checkIndexIntegrity().tailChunks).toBe(0);
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a chunk whose re-embed fails is dropped, not left on its old vector, and a later sync fills it", async () => {
    const dir = await tempKnowledgeDir();
    const { db, close } = createStore(":memory:");
    try {
      let failText: string | null = null;
      registerEmbeddingProvider({
        id: "fake-partial",
        defaultModel: "partial-v1",
        dimensions: 4,
        embed: async (text) => (failText && text.includes(failText) ? null : [1, 0, 0, 0]),
      });
      const projectDir = join(dir, "proj");
      await mkdir(projectDir, { recursive: true });
      const file = join(projectDir, "notes.md");
      const body = (second: string) =>
        `---\ntitle: Notes\n---\n## One\n\n${"alpha ".repeat(200)}\n\n## Two\n\n${second}`;
      await writeFile(file, body(`${"beta ".repeat(200)}`));

      const sync = new KnowledgeSync(db, dir, "fake-partial");
      await sync.syncProject("proj");
      const store = new KnowledgeStore(db);
      const id = store.getDoc("proj", "notes")!.id;
      expect(store.chunkIndexes(id)).toEqual([0, 1]);

      // The edit changes chunk 1, and its embedding call fails.
      failText = "gamma";
      await writeFile(file, body(`${"gamma ".repeat(200)}`));
      const later = new Date(Date.now() + 60_000);
      await utimes(file, later, later);
      await sync.syncProject("proj");
      expect(store.chunkIndexes(id)).toEqual([0]);

      // The provider recovers: a request-path resync leaves the unchanged file
      // alone, and the backfill embeds only the gap.
      failText = null;
      await sync.syncProject("proj");
      expect(store.chunkIndexes(id)).toEqual([0]);
      const chunk0 = store.getChunks(id)[0].id;
      await sync.backfillEmbeddings();
      expect(store.chunkIndexes(id)).toEqual([0, 1]);
      expect(store.getChunks(id)[0].id).toBe(chunk0);
      expect(store.getChunks(id)[1].text).toContain("gamma");
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("KnowledgeSync background indexing", () => {
  test("a chunker-only change keeps every vector serving and re-chunks in the backfill", async () => {
    const dir = await tempKnowledgeDir();
    const { db, close } = createStore(":memory:");
    try {
      registerFake("fake-rechunk", 768);
      const store = new KnowledgeStore(db);
      const docId = seedEmbeddedDoc(store, 768);
      db.run("UPDATE knowledge_chunks SET chunker_version = ?", [CHUNKER_VERSION - 1]);
      setSetting(
        db,
        "embedding_provider_fingerprint",
        `fake-rechunk:fake-rechunk-model:768|digest=sha256-fake-rechunk|chunker=${CHUNKER_VERSION - 1}`
      );
      const before = store.getChunks(docId)[0].embedding;

      const sync = new KnowledgeSync(db, dir, "fake-rechunk");
      expect(await sync.reindexOnProviderChange()).toBe("rechunk");
      expect(store.getChunks(docId)[0].embedding).toEqual(before);
      expect(store.vectorSearchSuspended()).toBe(false);
      expect(getSetting(db, "embedding_provider_fingerprint")).toBe(
        fingerprint("fake-rechunk", "fake-rechunk-model", 768, "sha256-fake-rechunk")
      );

      expect((await sync.backfillEmbeddings()).embedded).toBe(1);
      expect(store.chunkStates(docId).map((c) => c.chunkerVersion)).toEqual([CHUNKER_VERSION]);
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a provider that is down at upgrade boot leaves the index intact and the new fingerprint unrecorded", async () => {
    const dir = await tempKnowledgeDir();
    const { db, close } = createStore(":memory:");
    try {
      const state = { up: false };
      registerEmbeddingProvider({
        id: "fake-down",
        defaultModel: "fake-down-model",
        dimensions: 4,
        embed: async () => (state.up ? [0.5, 0.5, 0.5, 0.5] : null),
        modelDigest: async () => {
          if (!state.up) throw new Error("connection refused");
          return "sha256-down";
        },
      });
      const store = new KnowledgeStore(db);
      const docId = seedEmbeddedDoc(store, 4);
      db.run("UPDATE knowledge_chunks SET chunker_version = NULL");
      setSetting(db, "embedding_provider_fingerprint", "fake-down:fake-down-model");

      const sync = new KnowledgeSync(db, dir, "fake-down");
      expect(await sync.reindexOnProviderChange()).toBe("pending");
      expect(chunkCount(db)).toBe(1);
      expect(getSetting(db, "embedding_provider_fingerprint")).toBe("fake-down:fake-down-model");
      // Same model, so the stored vectors still answer queries.
      expect(store.vectorSearchSuspended()).toBe(false);

      // A backfill pass against the down provider replaces nothing and keeps the chunk.
      await sync.backfillEmbeddings();
      expect(chunkCount(db)).toBe(1);
      expect(store.chunkStates(docId)[0].chunkerVersion).toBeNull();

      state.up = true;
      expect(await sync.reindexOnProviderChange()).toBe("rechunk");
      await sync.backfillEmbeddings();
      expect(store.chunkStates(docId)[0].chunkerVersion).toBe(CHUNKER_VERSION);
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a switch to a provider that cannot embed suspends vector search without clearing, and completes once it can", async () => {
    const dir = await tempKnowledgeDir();
    const { db, close } = createStore(":memory:");
    try {
      registerFake("fake-before", 4);
      const state = { up: false };
      registerEmbeddingProvider({
        id: "fake-after",
        defaultModel: "fake-after-model",
        dimensions: 4,
        embed: async () => (state.up ? [0, 1, 0, 0] : null),
      });
      const store = new KnowledgeStore(db);
      const before = new KnowledgeSync(db, dir, "fake-before");
      await before.reindexOnProviderChange();
      seedEmbeddedDoc(store, 4);
      const recorded = getSetting(db, "embedding_provider_fingerprint");

      const after = new KnowledgeSync(db, dir, "fake-after");
      expect(await after.reindexOnProviderChange()).toBe("pending");
      expect(chunkCount(db)).toBe(1);
      expect(getSetting(db, "embedding_provider_fingerprint")).toBe(recorded);
      expect(store.vectorSearchSuspended()).toBe(true);

      // A boot back on the original provider finds its own index current.
      expect(await before.reindexOnProviderChange()).toBe("current");
      expect(store.vectorSearchSuspended()).toBe(false);
      expect(await after.reindexOnProviderChange()).toBe("pending");

      // The provider comes back: a query vector of the new space is never scored
      // against the old-space chunk while the rebuild is pending.
      state.up = true;
      expect(await searchKnowledge(db, "proj", "zzqx no words match", "fake-after")).toEqual([]);

      expect(await after.reindexOnProviderChange()).toBe("respace");
      expect(chunkCount(db)).toBe(0);
      expect(store.vectorSearchSuspended()).toBe(false);
      await after.backfillEmbeddings();
      expect(chunkCount(db)).toBe(1);
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the collector serves requests before the embedding check completes, then the backfill embeds the corpus", async () => {
    const dir = await tempKnowledgeDir();
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "proj", name: "Proj", branch: "main", repos: [] });
    try {
      let releaseDigest: (digest: string) => void = () => {};
      const digestGate = new Promise<string>((resolve) => {
        releaseDigest = resolve;
      });
      registerEmbeddingProvider({
        id: "fake-slow-boot",
        defaultModel: "fake-slow-boot-model",
        dimensions: 4,
        embed: async () => [0.1, 0.2, 0.3, 0.4],
        modelDigest: () => digestGate,
      });
      const projectDir = join(dir, "proj");
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        join(projectDir, "runbook.md"),
        "---\ntitle: Release runbook\n---\nShip the release after the canary bakes."
      );

      const sync = new KnowledgeSync(store.db, dir, "fake-slow-boot");
      sync.deferEmbeddingUntilChecked();
      await sync.syncAll();
      const app = createServer(store, () => {}, "fake-slow-boot", sync, undefined, dir);
      const indexing = sync.startBackgroundIndexing();
      await new Promise((resolve) => setTimeout(resolve, 5));

      const res = await app.request("/api/knowledge/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: "/tmp/none", project: "proj", corpus: "project", query: "canary bakes" }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { results: Array<{ slug: string }> };
      expect(json.results.map((r) => r.slug)).toContain("runbook");
      expect((await app.request("/api/knowledge/stats")).status).toBe(200);
      expect(chunkCount(store.db)).toBe(0);

      releaseDigest("sha256-slow");
      await indexing;
      expect(chunkCount(store.db)).toBeGreaterThan(0);
      sync.stopBackgroundIndexing();
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a doc edited while its backfill embeddings are in flight keeps the edit's chunks", async () => {
    const dir = await tempKnowledgeDir();
    const { db, close } = createStore(":memory:");
    try {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      registerEmbeddingProvider({
        id: "fake-gated",
        defaultModel: "fake-gated-model",
        dimensions: 4,
        embed: async (text) => {
          if (text.includes("first")) await gate;
          return [1, 0, 0, 0];
        },
      });
      const store = new KnowledgeStore(db);
      const base = {
        id: randomUUID(),
        projectId: "proj",
        slug: "edited",
        title: "Edited",
        filePath: "/tmp/edited.md",
        originClass: "owner" as const,
      };
      const docId = store.upsertDoc({ ...base, body: "first body", updatedAt: new Date() });
      const sync = new KnowledgeSync(db, dir, "fake-gated");
      const pass = sync.backfillEmbeddings();
      store.upsertDoc({ ...base, body: "second body", updatedAt: new Date(Date.now() + 1000) });
      release();
      await pass;
      expect(store.chunkStates(docId).map((c) => c.text).join(" ")).not.toContain("first");
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("KnowledgeSync backfill — docs the provider rejects", () => {
  function seedDocs(store: KnowledgeStore, bodies: string[]): string[] {
    return bodies.map((body, i) =>
      store.upsertDoc({
        id: `doc-${String(i).padStart(2, "0")}`,
        projectId: "proj",
        slug: `doc-${i}`,
        title: `Doc ${i}`,
        body,
        filePath: `/tmp/doc-${i}.md`,
        updatedAt: new Date(),
        originClass: "owner",
      })
    );
  }

  test("docs that always fail never stop the rest of the corpus from embedding, and are tried last", async () => {
    const dir = await tempKnowledgeDir();
    const { db, close } = createStore(":memory:");
    try {
      const calls: string[] = [];
      registerEmbeddingProvider({
        id: "fake-poison",
        defaultModel: "fake-poison-model",
        dimensions: 4,
        embed: async (text) => {
          calls.push(text);
          return text.includes("poison") ? null : [0.1, 0.2, 0.3, 0.4];
        },
      });
      const store = new KnowledgeStore(db);
      const bodies = Array.from({ length: 12 }, (_, i) => (i % 4 === 0 ? `poison body ${i}` : `good body ${i}`));
      const ids = seedDocs(store, bodies);
      const sync = new KnowledgeSync(db, dir, "fake-poison");

      for (let pass = 0; pass < 2; pass++) {
        const result = await sync.backfillEmbeddings();
        expect(result.aborted).toBe(false);
        expect(result.failed).toBe(3);
      }
      ids.forEach((id, i) => expect(store.chunkStates(id).length > 0).toBe(i % 4 !== 0));

      // With every good doc needing a re-embed, the rejected docs come after all of them.
      seedDocs(store, bodies.map((b) => `${b} edited`));
      calls.length = 0;
      await sync.backfillEmbeddings();
      const docCalls = calls.filter((t) => t.includes("body"));
      const firstPoison = docCalls.findIndex((t) => t.includes("poison"));
      expect(firstPoison).toBeGreaterThan(0);
      expect(docCalls.slice(firstPoison).every((t) => t.includes("poison"))).toBe(true);
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a provider that cannot embed at all stops the pass at the first failed doc", async () => {
    const dir = await tempKnowledgeDir();
    const { db, close } = createStore(":memory:");
    try {
      registerEmbeddingProvider({ id: "fake-all-down", defaultModel: "m", dimensions: 4, embed: async () => null });
      const store = new KnowledgeStore(db);
      seedDocs(store, ["one body", "two body", "three body"]);
      const result = await new KnowledgeSync(db, dir, "fake-all-down").backfillEmbeddings();
      expect(result).toMatchObject({ docs: 1, failed: 1, aborted: true });
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("KnowledgeSync background indexing — retries and an inconclusive canary", () => {
  type Background = { timer: ReturnType<typeof setTimeout> | null; retryMs: number; checked: boolean };
  const background = (sync: KnowledgeSync) => (sync as unknown as { background: Background }).background;
  const retry = (sync: KnowledgeSync) => (sync as unknown as { scheduleRetry(): void }).scheduleRetry();

  test("a retry already queued is not queued again, and the delay doubles only once", async () => {
    const dir = await tempKnowledgeDir();
    const { db, close } = createStore(":memory:");
    const sync = new KnowledgeSync(db, dir, "fake-retry-once");
    try {
      registerFake("fake-retry-once", 4);
      await sync.startBackgroundIndexing();
      const bg = background(sync);
      bg.retryMs = 60_000;
      retry(sync);
      retry(sync);
      expect(bg.retryMs).toBe(120_000);
    } finally {
      sync.stopBackgroundIndexing();
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a pass that leaves a doc failed queues a follow-up", async () => {
    const dir = await tempKnowledgeDir();
    const { db, close } = createStore(":memory:");
    registerEmbeddingProvider({
      id: "fake-follow-up",
      defaultModel: "m",
      dimensions: 4,
      embed: async (text) => (text.includes("poison") ? null : [0.1, 0.2, 0.3, 0.4]),
    });
    const sync = new KnowledgeSync(db, dir, "fake-follow-up");
    try {
      const store = new KnowledgeStore(db);
      store.upsertDoc({
        id: "p",
        projectId: "proj",
        slug: "p",
        title: "P",
        body: "poison body",
        filePath: "/tmp/p.md",
        updatedAt: new Date(),
        originClass: "owner",
      });
      await sync.startBackgroundIndexing();
      expect(background(sync).timer).not.toBeNull();
    } finally {
      sync.stopBackgroundIndexing();
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a canary that could not embed is re-run once an embedding succeeds, and catches drift then", async () => {
    const dir = await tempKnowledgeDir();
    const { db, close } = createStore(":memory:");
    const state: { vector?: () => number[] | null; digest?: string | null } = { digest: null };
    registerFake("fake-repulled", 768, state);
    const sync = new KnowledgeSync(db, dir, "fake-repulled");
    try {
      const store = new KnowledgeStore(db);
      const projectDir = join(dir, "proj");
      await mkdir(projectDir, { recursive: true });
      await writeFile(join(projectDir, "seeded.md"), "---\ntitle: Seeded\n---\nA doc embedded before the re-pull.");
      const setup = new KnowledgeSync(db, dir, "fake-repulled");
      await setup.reindexOnProviderChange();
      await setup.syncProject("proj");
      const seededChunks = () => store.getChunks(store.getDoc("proj", "seeded")!.id);
      expect(seededChunks().length).toBeGreaterThan(0);

      // The provider is down at boot: the check is inconclusive and nothing is cleared.
      state.vector = () => null;
      await sync.startBackgroundIndexing();
      expect(seededChunks().length).toBeGreaterThan(0);
      expect(background(sync).checked).toBe(false);

      // It comes back re-pulled to other weights under the same name: the first
      // successful embedding re-runs the check, whose canary sees the drift and
      // re-embeds the corpus in the new space.
      const drifted = new Array(768).fill(0).map((_, i) => (i % 2 === 0 ? 1 : -1));
      state.vector = () => drifted;
      await writeFile(join(projectDir, "fresh.md"), "---\ntitle: Fresh\n---\nA doc synced after the provider came back.");
      await sync.syncProject("proj");
      const reembedded = () => seededChunks().length > 0 && seededChunks().every((c) => c.embedding[0] === 1);
      for (let i = 0; i < 100 && !reembedded(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(reembedded()).toBe(true);
      expect(background(sync).checked).toBe(true);
    } finally {
      sync.stopBackgroundIndexing();
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("syncProject sees a rewrite that kept the file's mtime", () => {
  test("a same-millisecond rewrite is re-indexed; a DB-only edit to an unchanged file is kept", async () => {
    const store = createStore(":memory:");
    const dir = await tempKnowledgeDir();
    try {
      await mkdir(join(dir, "proj"), { recursive: true });
      const path = join(dir, "proj", "doc.md");
      const stamp = new Date("2026-09-01T00:00:00.000Z");
      await writeFile(path, "---\ntitle: Doc\nconfidence: 0.6\n---\nbody\n");
      await utimes(path, stamp, stamp);
      const sync = new KnowledgeSync(store.db, dir, null);
      await sync.syncProject("proj");
      const ks = new KnowledgeStore(store.db);
      expect(ks.getDoc("proj", "doc")?.confidence).toBe(0.6);

      // A DB-only edit with the file untouched survives the next sync.
      store.db.run("UPDATE knowledge SET title = 'Edited in the DB' WHERE slug = 'doc'");
      await sync.syncProject("proj");
      expect(ks.getDoc("proj", "doc")?.title).toBe("Edited in the DB");

      // The file is rewritten, but its mtime lands where it was.
      await writeFile(path, "---\ntitle: Doc\nconfidence: 1\n---\nbody\n");
      await utimes(path, stamp, stamp);
      await sync.syncProject("proj");
      expect(ks.getDoc("proj", "doc")?.confidence).toBe(1);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
