import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { KnowledgeStore } from "./store.js";
import {
  ensureJudgmentSchema,
  hasSuccessfulJudgment,
  judgmentCounts,
  pairJudgment,
  recordJudgment,
  verdictFlipRate,
} from "./judgments.js";

function freshDb(): Database {
  const db = new Database(":memory:");
  new KnowledgeStore(db);
  return db;
}

function insertDoc(db: Database, slug: string, projectId = "p"): void {
  db.run(
    "INSERT INTO knowledge (id, project_id, slug, title, body, file_path) VALUES (?, ?, ?, ?, ?, ?)",
    [`${projectId}/${slug}`, projectId, slug, slug, "body", `/k/${slug}.md`]
  );
}

function setVerdict(db: Database, slug: string, verdict: string | null): void {
  db.run("UPDATE knowledge SET verdict = ? WHERE slug = ?", [verdict, slug]);
}

describe("judgment schema", () => {
  test("widens an existing ledger to the supersedes and complementary outcomes, keeping its rows", () => {
    const db = freshDb();
    recordJudgment(db, { projectId: "p", subjectSlug: "a", candidateSlug: "b", outcome: "contradicts" });
    recordJudgment(db, { projectId: "p", subjectSlug: "a", candidateSlug: "c", outcome: "supersedes" });
    recordJudgment(db, { projectId: "p", subjectSlug: "a", candidateSlug: "d", outcome: "complementary" });
    expect(judgmentCounts(db)).toMatchObject({ contradicts: 1, supersedes: 1, complementary: 1 });
    expect(pairJudgment(db, "p", "c", "p", "a")).toBe("supersedes");
    expect(pairJudgment(db, "p", "a", "p", "zzz")).toBeNull();
    expect(hasSuccessfulJudgment(db, "p", "d")).toBe(true);
    // Idempotent: a second call on a widened ledger is a no-op.
    ensureJudgmentSchema(db);
    expect(judgmentCounts(db).contradicts).toBe(1);
  });
});

describe("verdictFlipRate", () => {
  test("counts docs whose checked verdict changed more than once", () => {
    const db = freshDb();
    ensureJudgmentSchema(db);
    for (const slug of ["steady", "landed", "flipper", "edited", "once"]) insertDoc(db, slug);
    // A first check landing is no change.
    setVerdict(db, "steady", "unverified");
    setVerdict(db, "steady", "clean");
    setVerdict(db, "landed", "clean");
    // clean → disputed → clean: two changes.
    setVerdict(db, "flipper", "clean");
    setVerdict(db, "flipper", "disputed");
    setVerdict(db, "flipper", "clean");
    // A clear between two equal verdicts is no change.
    setVerdict(db, "edited", "disputed");
    setVerdict(db, "edited", null);
    setVerdict(db, "edited", "disputed");
    // One change.
    setVerdict(db, "once", "clean");
    setVerdict(db, "once", "contradicted");

    expect(verdictFlipRate(db)).toEqual({ windowDays: 30, changedDocs: 2, flippedDocs: 1, flipRate: 0.5 });
    expect(verdictFlipRate(db, { projectId: "other" })).toMatchObject({ changedDocs: 0, flipRate: 0 });
    // Changes older than the window are out of it.
    const later = new Date(Date.now() + 40 * 86_400_000);
    expect(verdictFlipRate(db, { now: later })).toMatchObject({ changedDocs: 0, flippedDocs: 0 });
  });

  test("reads as zero before the history exists", () => {
    const db = new Database(":memory:");
    expect(verdictFlipRate(db)).toEqual({ windowDays: 30, changedDocs: 0, flippedDocs: 0, flipRate: 0 });
  });
});
