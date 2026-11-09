import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import matter from "gray-matter";
import { KnowledgeStore } from "./store.js";
import { KnowledgeLoader } from "./loader.js";
import { searchKnowledge } from "./search.js";
import {
  HISTORY_VERSIONS_KEPT,
  acceptDraftFile,
  archiveDocVersion,
  deleteKnowledgeFile,
  writeDraftFile,
  writeKnowledgeFile,
} from "./writer.js";
import {
  HISTORY_SUBDIR,
  historySlugOf,
  historyStamp,
  isValidAt,
  normalizeInstant,
  parseAsOf,
  supersededByFromDisputes,
} from "./temporal.js";
import type { ScopeAudience } from "./types.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "standup-temporal-"));
}

/** Indexes every doc and history version of `projectId` the way KnowledgeSync does. */
async function index(db: Database, dir: string, projectId: string): Promise<KnowledgeStore> {
  const store = new KnowledgeStore(db);
  const loader = new KnowledgeLoader(dir);
  for (const doc of await loader.loadProject(projectId)) store.upsertDoc(doc);
  store.syncHistory(projectId, await loader.loadHistory(projectId));
  return store;
}

/** Docs that make the test queries' terms informative (in under half the corpus). */
async function writeFiller(dir: string, projectId: string): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await writeKnowledgeFile(dir, projectId, {
      slug: `filler-${i}`,
      title: `Filler ${i}`,
      body: `Unrelated note number ${i} about logging, metrics and dashboards.`,
    });
  }
}

const AUDIENCE: ScopeAudience = { projectId: "proj" };

describe("temporal helpers", () => {
  test.each([
    ["2026-01-02", "2026-01-02T00:00:00.000Z"],
    ["2026-01-02T03:04:05Z", "2026-01-02T03:04:05.000Z"],
    [new Date("2026-05-01T00:00:00Z"), "2026-05-01T00:00:00.000Z"],
    ["not a date", undefined],
    ["", undefined],
    [undefined, undefined],
  ])("normalizeInstant(%p) = %p", (value, expected) => {
    expect(normalizeInstant(value)).toBe(expected);
  });

  test.each([
    [undefined, { ok: true, asOf: undefined }],
    ["2026-03-01", { ok: true, asOf: "2026-03-01T00:00:00.000Z" }],
    ["yesterday-ish", { ok: false }],
    [42, { ok: false }],
  ])("parseAsOf(%p)", (value, expected) => {
    expect(parseAsOf(value)).toMatchObject(expected);
  });

  test.each([
    [{}, "2026-01-01T00:00:00.000Z", true],
    [{ validFrom: "2026-02-01T00:00:00.000Z" }, "2026-01-01T00:00:00.000Z", false],
    [{ validTo: "2026-02-01T00:00:00.000Z" }, "2026-01-31T00:00:00.000Z", true],
    [{ validTo: "2026-02-01T00:00:00.000Z" }, "2026-02-01T00:00:00.000Z", false],
  ])("isValidAt(%p, %p) = %p", (interval, at, expected) => {
    expect(isValidAt(interval, at)).toBe(expected);
  });

  test.each([
    [[{ claim: "Superseded by winner" }], "proj/winner"],
    [[{ claim: "Contradicts x" }, { claim: "Superseded by other/canon" }], "other/canon"],
    [[{ claim: "Contradicts x" }], undefined],
    [[], undefined],
  ])("supersededByFromDisputes(%p) = %p", (disputes, expected) => {
    expect(supersededByFromDisputes("proj", disputes)).toBe(expected);
  });

  test("a history file name keeps its slug and sorts by time", () => {
    const stamp = historyStamp("2026-01-02T03:04:05.678Z");
    expect(stamp).toBe("2026-01-02T03-04-05-678Z");
    expect(historySlugOf(`retry-policy.${stamp}.md`)).toBe("retry-policy");
  });
});

describe("validity front matter round-trip", () => {
  test("the writer writes valid_from and the loader reads the whole interval back", async () => {
    const dir = await tempDir();
    try {
      await writeKnowledgeFile(dir, "proj", {
        slug: "interval",
        title: "Interval",
        body: "body",
        validFrom: "2026-01-01T00:00:00.000Z",
      });
      const raw = await readFile(join(dir, "proj", "interval.md"), "utf-8");
      expect(matter(raw).data.valid_from).toBe("2026-01-01T00:00:00.000Z");

      await writeFile(
        join(dir, "proj", "closed.md"),
        "---\ntitle: Closed\nvalid_from: 2026-01-01\nvalid_to: 2026-02-01T00:00:00Z\nsuperseded_by: proj/interval\n---\nold\n"
      );
      const docs = await new KnowledgeLoader(dir).loadProject("proj");
      const closed = docs.find((d) => d.slug === "closed")!;
      expect(closed.validFrom).toBe("2026-01-01T00:00:00.000Z");
      expect(closed.validTo).toBe("2026-02-01T00:00:00.000Z");
      expect(closed.supersededBy).toBe("proj/interval");
      expect(docs.find((d) => d.slug === "interval")!.validTo).toBeUndefined();

      const db = new Database(":memory:");
      const store = await index(db, dir, "proj");
      const row = store.getDoc("proj", "closed")!;
      expect(row.validFrom).toBe("2026-01-01T00:00:00.000Z");
      expect(row.validTo).toBe("2026-02-01T00:00:00.000Z");
      expect(row.supersededBy).toBe("proj/interval");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an undeclared valid_from is the doc's generated_at, else its file time at first index, and survives a rewrite", async () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    const base = {
      projectId: "proj",
      title: "T",
      body: "b",
      updatedAt: new Date("2026-03-01T00:00:00Z"),
      filePath: "/x.md",
    };
    store.upsertDoc({ ...base, id: "g", slug: "generated", generatedAt: "2026-02-01T00:00:00Z" });
    expect(store.getDoc("proj", "generated")!.validFrom).toBe("2026-02-01T00:00:00.000Z");

    store.upsertDoc({ ...base, id: "h", slug: "human" });
    const first = store.getDoc("proj", "human")!.validFrom!;
    expect(first).toBe("2026-03-01T00:00:00.000Z");
    store.upsertDoc({ ...base, id: "h", slug: "human", body: "edited", updatedAt: new Date("2026-04-01T00:00:00Z") });
    expect(store.getDoc("proj", "human")!.validFrom).toBe(first);
  });
});

describe("validity backfill and supersede close", () => {
  function legacyDb(): Database {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE knowledge (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL,
        body TEXT NOT NULL, tags_json TEXT, embedding_json TEXT, file_path TEXT NOT NULL,
        updated_at TEXT, generated_at TEXT, verdict TEXT, disputes_json TEXT,
        UNIQUE(project_id, slug)
      );
    `);
    const insert = db.prepare(
      "INSERT INTO knowledge (id, project_id, slug, title, body, tags_json, file_path, updated_at, generated_at, verdict, disputes_json) VALUES (?, 'proj', ?, ?, 'b', ?, '/x', ?, ?, ?, ?)"
    );
    insert.run("plain", "plain", "Plain", null, "2026-01-05T00:00:00.000Z", null, null, null);
    insert.run("gen", "gen", "Gen", null, "2026-01-05T00:00:00.000Z", "2026-01-01T00:00:00Z", null, null);
    insert.run(
      "loser",
      "loser",
      "Loser",
      null,
      "2026-01-05T00:00:00.000Z",
      null,
      "superseded",
      JSON.stringify([{ claim: "Superseded by winner", finding: "f", evidence: "e" }])
    );
    insert.run("memory", "memory", "Memory", JSON.stringify(["superseded"]), "2026-01-05T00:00:00.000Z", null, null, null);
    return db;
  }

  test("a table that predates the columns is backfilled once", () => {
    const db = legacyDb();
    const before = new Date().toISOString();
    const store = new KnowledgeStore(db);
    const plain = store.getDoc("proj", "plain")!;
    expect(plain.validFrom).toBe("2026-01-05T00:00:00.000Z");
    expect(plain.validTo).toBeUndefined();
    expect(store.getDoc("proj", "gen")!.validFrom).toBe("2026-01-01T00:00:00.000Z");

    const loser = store.getDoc("proj", "loser")!;
    expect(loser.validTo! >= before).toBe(true);
    expect(loser.supersededBy).toBe("proj/winner");
    const memory = store.getDoc("proj", "memory")!;
    expect(memory.validTo! >= before).toBe(true);
    expect(memory.supersededBy).toBeUndefined();

    // A second construction finds the columns and leaves the values alone.
    const closedAt = loser.validTo;
    new KnowledgeStore(db);
    expect(store.getDoc("proj", "loser")!.validTo).toBe(closedAt);
  });

  test("a superseded verdict closes the doc, a revive reopens it, and a file resync keeps the close", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    const doc = {
      id: "d",
      projectId: "proj",
      slug: "loser",
      title: "Loser",
      body: "b",
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      filePath: "/x.md",
    };
    store.upsertDoc(doc);
    expect(store.getDoc("proj", "loser")!.validTo).toBeUndefined();

    const before = new Date().toISOString();
    store.setDocVerdict("proj", "loser", "superseded", [{ claim: "Superseded by other/winner" }]);
    const closed = store.getDoc("proj", "loser")!;
    expect(closed.validTo! >= before).toBe(true);
    expect(closed.supersededBy).toBe("other/winner");

    // A raw-SQL writer (the mirror collapse) closes it the same way.
    db.run("UPDATE knowledge SET verdict = NULL WHERE id = 'd'");
    db.run(
      `UPDATE knowledge SET verdict = 'superseded', disputes_json = '[{"claim":"Superseded by canon/loser"}]' WHERE id = 'd'`
    );
    expect(store.getDoc("proj", "loser")!.supersededBy).toBe("canon/loser");

    // A frontmatter write that declares no close does not reopen a superseded doc.
    store.upsertDoc({ ...doc, confidence: 0.2, updatedAt: new Date("2026-01-02T00:00:00Z") });
    expect(store.getDoc("proj", "loser")!.validTo).toBeDefined();

    store.clearDocVerdict("proj", "loser");
    const revived = store.getDoc("proj", "loser")!;
    expect(revived.validTo).toBeUndefined();
    expect(revived.supersededBy).toBeUndefined();
  });
});

describe("a replacing accept closes the prior version", () => {
  test("the old body is kept under .history/ with valid_to + superseded_by, the new one is current from the accept", async () => {
    const dir = await tempDir();
    try {
      await writeKnowledgeFile(dir, "proj", {
        slug: "retry-policy",
        title: "Retry policy",
        body: "Retries use a fixed delay.",
        generatedAt: "2026-01-01T00:00:00.000Z",
        originClass: "agent",
      });
      await writeDraftFile(dir, "proj", {
        slug: "retry-policy",
        title: "Retry policy",
        body: "Retries use exponential backoff.",
        replacesSlug: "retry-policy",
      });
      const acceptedAt = new Date("2026-06-01T00:00:00.000Z");
      expect(await acceptDraftFile(dir, "proj", "retry-policy", { acceptedAt })).toBe(true);

      const current = matter(await readFile(join(dir, "proj", "retry-policy.md"), "utf-8"));
      expect(current.content.trim()).toBe("Retries use exponential backoff.");
      expect(current.data.valid_from).toBe(acceptedAt.toISOString());
      expect(current.data.valid_to).toBeUndefined();

      const history = await readdir(join(dir, "proj", HISTORY_SUBDIR));
      expect(history).toEqual([`retry-policy.${historyStamp("2026-01-01T00:00:00.000Z")}.md`]);
      const old = matter(await readFile(join(dir, "proj", HISTORY_SUBDIR, history[0]), "utf-8"));
      expect(old.content.trim()).toBe("Retries use a fixed delay.");
      expect(old.data).toMatchObject({
        valid_from: "2026-01-01T00:00:00.000Z",
        valid_to: acceptedAt.toISOString(),
        superseded_by: "proj/retry-policy",
        origin_class: "agent",
      });

      // The history file never joins the corpus.
      const loader = new KnowledgeLoader(dir);
      expect((await loader.loadProject("proj")).map((d) => d.slug)).toEqual(["retry-policy"]);
      const versions = await loader.loadHistory("proj");
      expect(versions).toHaveLength(1);
      expect(versions[0]).toMatchObject({ slug: "retry-policy", validTo: acceptedAt.toISOString() });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a replace with the same body keeps no version", async () => {
    const dir = await tempDir();
    try {
      await writeKnowledgeFile(dir, "proj", { slug: "same", title: "Same", body: "unchanged" });
      await writeDraftFile(dir, "proj", { slug: "same", title: "Same v2", body: "unchanged", replacesSlug: "same" });
      expect(await acceptDraftFile(dir, "proj", "same")).toBe(true);
      expect(existsSync(join(dir, "proj", HISTORY_SUBDIR))).toBe(false);
      expect(matter(await readFile(join(dir, "proj", "same.md"), "utf-8")).data.valid_from).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a fresh accept keeps no version; two closes of one start get distinct files", async () => {
    const dir = await tempDir();
    try {
      await writeDraftFile(dir, "proj", { slug: "fresh", title: "Fresh", body: "new" });
      expect(await acceptDraftFile(dir, "proj", "fresh")).toBe(true);
      expect(existsSync(join(dir, "proj", HISTORY_SUBDIR))).toBe(false);

      await writeKnowledgeFile(dir, "proj", { slug: "twice", title: "T", body: "a", validFrom: "2026-01-01T00:00:00.000Z" });
      const first = await archiveDocVersion(dir, "proj", "twice", { closedAt: "2026-02-01T00:00:00.000Z" });
      const second = await archiveDocVersion(dir, "proj", "twice", { closedAt: "2026-03-01T00:00:00.000Z" });
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(first).not.toBe(second);
      expect(await archiveDocVersion(dir, "proj", "missing", { closedAt: "2026-02-01T00:00:00.000Z" })).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("history files: redaction, deletion and retention", () => {
  const ACCOUNT = "123456789012";
  const ARN = `arn:aws:iam::${ACCOUNT}:role/Admin`;

  test("archiving a hand-written doc redacts its title and body in the history copy", async () => {
    const dir = await tempDir();
    try {
      await mkdir(join(dir, "proj"), { recursive: true });
      await writeFile(
        join(dir, "proj", "deploy-role.md"),
        `---\ntitle: Deploy role ${ARN}\nvalid_from: 2026-01-01T00:00:00.000Z\n---\nAssume ${ARN} to deploy.\n`
      );
      const target = await archiveDocVersion(dir, "proj", "deploy-role", { closedAt: "2026-02-01T00:00:00.000Z" });
      const copy = await readFile(target!, "utf-8");
      expect(copy).not.toContain(ACCOUNT);
      const parsed = matter(copy);
      expect(parsed.data.title).toContain("Deploy role arn:aws:iam::");
      expect(parsed.content).toContain("Assume arn:aws:iam::");
      expect(parsed.data.valid_to).toBe("2026-02-01T00:00:00.000Z");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("syncHistory indexes an unredacted history file redacted", async () => {
    const dir = await tempDir();
    try {
      await mkdir(join(dir, "proj", HISTORY_SUBDIR), { recursive: true });
      await writeFile(
        join(dir, "proj", HISTORY_SUBDIR, "deploy-role.2026-01-01T00-00-00-000Z.md"),
        `---\ntitle: Role ${ARN}\nvalid_from: 2026-01-01\nvalid_to: 2026-02-01\n---\nAssume ${ARN} to deploy.\n`
      );
      const db = new Database(":memory:");
      const store = await index(db, dir, "proj");
      const [version] = store.getHistory("proj", "deploy-role");
      expect(version.title).not.toContain(ACCOUNT);
      expect(version.body).not.toContain(ACCOUNT);
      const fts = db.query("SELECT title, body FROM knowledge_history_fts").all() as Array<{ title: string; body: string }>;
      expect(fts.some((r) => r.title.includes(ACCOUNT) || r.body.includes(ACCOUNT))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("deleting a doc deletes its history files and, on sync, its history rows; another slug's are kept", async () => {
    const dir = await tempDir();
    try {
      await writeKnowledgeFile(dir, "proj", { slug: "gone", title: "Gone", body: "v1", validFrom: "2026-01-01T00:00:00.000Z" });
      await writeKnowledgeFile(dir, "proj", { slug: "gone-too", title: "Kept", body: "k1", validFrom: "2026-01-01T00:00:00.000Z" });
      await archiveDocVersion(dir, "proj", "gone", { closedAt: "2026-02-01T00:00:00.000Z" });
      await archiveDocVersion(dir, "proj", "gone", { closedAt: "2026-03-01T00:00:00.000Z" });
      await archiveDocVersion(dir, "proj", "gone-too", { closedAt: "2026-02-01T00:00:00.000Z" });
      const db = new Database(":memory:");
      const store = await index(db, dir, "proj");
      expect(store.getHistory("proj", "gone")).toHaveLength(2);

      expect(await deleteKnowledgeFile(dir, "proj", "gone")).toBe(true);
      const left = await readdir(join(dir, "proj", HISTORY_SUBDIR));
      expect(left.every((f) => historySlugOf(f) === "gone-too")).toBe(true);
      expect(left).toHaveLength(1);

      store.deleteDoc("proj", "gone");
      expect(store.getHistory("proj", "gone")).toHaveLength(0);
      store.syncHistory("proj", await new KnowledgeLoader(dir).loadHistory("proj"));
      expect(store.getHistory("proj", "gone")).toHaveLength(0);
      expect(store.getHistory("proj", "gone-too")).toHaveLength(1);
      const ftsRows = db.query("SELECT slug FROM knowledge_history_fts").all() as Array<{ slug: string }>;
      expect(ftsRows.map((r) => r.slug)).toEqual(["gone-too"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test(`archiving keeps only the newest ${HISTORY_VERSIONS_KEPT} versions of a doc`, async () => {
    const dir = await tempDir();
    try {
      const total = HISTORY_VERSIONS_KEPT + 3;
      for (let i = 0; i < total; i++) {
        const day = String(i + 1).padStart(2, "0");
        await writeKnowledgeFile(dir, "proj", {
          slug: "churn",
          title: "Churn",
          body: `version ${i}`,
          validFrom: `2026-01-${day}T00:00:00.000Z`,
        });
        await archiveDocVersion(dir, "proj", "churn", { closedAt: "2026-03-01T00:00:00.000Z" });
      }
      const files = (await readdir(join(dir, "proj", HISTORY_SUBDIR))).sort();
      expect(files).toHaveLength(HISTORY_VERSIONS_KEPT);
      const bodies = await Promise.all(
        files.map(async (f) => matter(await readFile(join(dir, "proj", HISTORY_SUBDIR, f), "utf-8")).content.trim())
      );
      expect(bodies).toEqual(Array.from({ length: HISTORY_VERSIONS_KEPT }, (_, k) => `version ${k + 3}`));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("retention orders same-stamp collisions by their counter numerically", async () => {
    const dir = await tempDir();
    try {
      await writeKnowledgeFile(dir, "proj", { slug: "same-start", title: "S", body: "b", validFrom: "2026-01-01T00:00:00.000Z" });
      const targets: string[] = [];
      for (let i = 0; i < HISTORY_VERSIONS_KEPT + 2; i++) {
        targets.push((await archiveDocVersion(dir, "proj", "same-start", { closedAt: "2026-02-01T00:00:00.000Z" }))!);
      }
      const files = await readdir(join(dir, "proj", HISTORY_SUBDIR));
      expect(files).toHaveLength(HISTORY_VERSIONS_KEPT);
      // The two oldest (the bare stamp and -2) are gone; the newest (-12) survives.
      expect(existsSync(targets[0])).toBe(false);
      expect(existsSync(targets[1])).toBe(false);
      expect(existsSync(targets[targets.length - 1])).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("search validity", () => {
  async function replacedCorpus(dir: string): Promise<{ db: Database; store: KnowledgeStore }> {
    await writeFiller(dir, "proj");
    await writeKnowledgeFile(dir, "proj", {
      slug: "retry-policy",
      title: "Retry policy",
      body: "Gateway retries use a fixed delay of five seconds.",
      validFrom: "2026-01-01T00:00:00.000Z",
    });
    await writeDraftFile(dir, "proj", {
      slug: "retry-policy",
      title: "Retry policy",
      body: "Gateway retries use exponential backoff with jitter.",
      replacesSlug: "retry-policy",
    });
    await acceptDraftFile(dir, "proj", "retry-policy", { acceptedAt: new Date("2026-06-01T00:00:00.000Z") });
    // A doc closed in its own front matter, still in the corpus directory.
    await writeFile(
      join(dir, "proj", "gateway-timeouts.md"),
      "---\ntitle: Gateway timeouts\nvalid_from: 2026-01-01\nvalid_to: 2026-03-01\nsuperseded_by: proj/retry-policy\n---\nGateway retries time out after thirty seconds.\n"
    );
    const db = new Database(":memory:");
    const store = await index(db, dir, "proj");
    return { db, store };
  }

  test("a default search, gated and ungated, returns only the current version", async () => {
    const dir = await tempDir();
    try {
      const { db, store } = await replacedCorpus(dir);
      const historyIds = new Set(store.getHistory("proj", "retry-policy").map((v) => v.id));
      expect(historyIds.size).toBe(1);

      for (const options of [
        { confidentFor: "search" as const, audience: AUDIENCE },
        { confidentFor: "inject" as const, audience: AUDIENCE },
        { audience: AUDIENCE },
        { corpus: "project" as const, includeSuperseded: false },
      ]) {
        const hits = await searchKnowledge(db, "proj", "gateway retries fixed delay", null, { ...options, limit: 10 });
        expect(hits.some((h) => historyIds.has(h.id))).toBe(false);
        expect(hits.some((h) => h.slug === "gateway-timeouts")).toBe(false);
        // The old body matches this query best, yet only the current row can surface.
        const currentId = store.getDoc("proj", "retry-policy")!.id;
        expect(hits.filter((h) => h.slug === "retry-policy").every((h) => h.id === currentId)).toBe(true);
        expect(hits.some((h) => h.excerpt.includes("fixed delay"))).toBe(false);
        const current = await searchKnowledge(db, "proj", "gateway retries exponential backoff jitter", null, {
          ...options,
          limit: 10,
        });
        expect(current.filter((h) => h.slug === "retry-policy").map((h) => h.id)).toEqual([currentId]);
      }

      // The curation crons' ungated search sees closed docs, never history.
      const curation = await searchKnowledge(db, "proj", "gateway retries", null, { limit: 10 });
      expect(curation.some((h) => h.slug === "gateway-timeouts")).toBe(true);
      expect(curation.some((h) => historyIds.has(h.id))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("asOf returns the version current at that time", async () => {
    const dir = await tempDir();
    try {
      const { db, store } = await replacedCorpus(dir);
      const [old] = store.getHistory("proj", "retry-policy");
      const gated = { confidentFor: "search" as const, audience: AUDIENCE, limit: 10 };

      const before = await searchKnowledge(db, "proj", "gateway retries delay", null, { ...gated, asOf: "2026-02-01" });
      const retry = before.filter((h) => h.slug === "retry-policy");
      expect(retry).toHaveLength(1);
      expect(retry[0].id).toBe(old.id);
      expect(retry[0].excerpt).toContain("fixed delay");
      expect(retry[0].validTo).toBe("2026-06-01T00:00:00.000Z");
      expect(retry[0].supersededBy).toBe("proj/retry-policy");
      // Closed on 2026-03-01, so current on 2026-02-01.
      expect(before.some((h) => h.slug === "gateway-timeouts")).toBe(true);

      const between = await searchKnowledge(db, "proj", "gateway retries delay", null, { ...gated, asOf: "2026-04-01" });
      expect(between.some((h) => h.slug === "gateway-timeouts")).toBe(false);
      expect(between.find((h) => h.slug === "retry-policy")!.id).toBe(old.id);

      const after = await searchKnowledge(db, "proj", "gateway retries backoff", null, { ...gated, asOf: "2026-07-01" });
      const now = after.filter((h) => h.slug === "retry-policy");
      expect(now).toHaveLength(1);
      expect(now[0].id).toBe(store.getDoc("proj", "retry-policy")!.id);
      expect(now[0].validTo).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("asOf history hits keep the scope gate", async () => {
    const dir = await tempDir();
    try {
      await writeFiller(dir, "proj");
      await mkdir(join(dir, "proj", HISTORY_SUBDIR), { recursive: true });
      await writeFile(
        join(dir, "proj", HISTORY_SUBDIR, "private-note.2026-01-01T00-00-00-000Z.md"),
        "---\ntitle: Private note\nscope: user\nowner_user: alice\nvalid_from: 2026-01-01\nvalid_to: 2026-05-01\n---\nGateway retries private reminder.\n"
      );
      const db = new Database(":memory:");
      await index(db, dir, "proj");
      const asOf = "2026-02-01";
      const bob = await searchKnowledge(db, "proj", "gateway retries reminder", null, {
        audience: { projectId: "proj", user: "bob" },
        asOf,
      });
      expect(bob.some((h) => h.slug === "private-note")).toBe(false);
      const alice = await searchKnowledge(db, "proj", "gateway retries reminder", null, {
        audience: { projectId: "proj", user: "alice" },
        asOf,
      });
      expect(alice.some((h) => h.slug === "private-note")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("syncHistory drops a version whose file is gone", async () => {
    const dir = await tempDir();
    try {
      const { db, store } = await replacedCorpus(dir);
      expect(store.getHistory("proj", "retry-policy")).toHaveLength(1);
      await rm(join(dir, "proj", HISTORY_SUBDIR), { recursive: true, force: true });
      store.syncHistory("proj", await new KnowledgeLoader(dir).loadHistory("proj"));
      expect(store.getHistory("proj", "retry-policy")).toHaveLength(0);
      const hits = await searchKnowledge(db, "proj", "fixed delay", null, { asOf: "2026-02-01" });
      expect(hits.some((h) => h.slug === "retry-policy" && h.excerpt.includes("fixed delay"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
