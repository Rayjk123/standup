import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { KnowledgeStore, recordJudgment, verdictFlipRate, type KnowledgeDocFile } from "@standup/knowledge";
import type { DraftDispute } from "./draft-verify.js";
import { UNDECIDED_BASIS, contradictionDispute, type ContradictionJudgment } from "./knowledge-coherence.js";
import { rebaselineDisputes, type RebaselineDeps } from "./knowledge-dispute-rebaseline.js";

interface Doc {
  slug: string;
  verdict: string | null;
  disputes: DraftDispute[];
  originClass?: string;
  lastVerifiedAt?: string;
  generatedAt?: string;
}

function seed(docs: Doc[]): Database {
  const db = new Database(":memory:");
  new KnowledgeStore(db);
  for (const d of docs) {
    db.run(
      `INSERT INTO knowledge (id, project_id, slug, title, body, file_path, origin_class, verdict, disputes_json,
                              last_verified_at, generated_at)
       VALUES (?, 'p', ?, ?, 'body', ?, ?, ?, ?, ?, ?)`,
      [
        `p/${d.slug}`,
        d.slug,
        d.slug,
        `/k/${d.slug}.md`,
        d.originClass ?? "agent",
        d.verdict,
        JSON.stringify(d.disputes),
        d.lastVerifiedAt ?? null,
        d.generatedAt ?? null,
      ]
    );
  }
  return db;
}

function state(db: Database, slug: string): { verdict: string | null; claims: string[] } {
  const row = db.query("SELECT verdict, disputes_json FROM knowledge WHERE slug = ?").get(slug) as {
    verdict: string | null;
    disputes_json: string | null;
  };
  const disputes = JSON.parse(row.disputes_json ?? "[]") as DraftDispute[];
  return { verdict: row.verdict, claims: disputes.map((d) => d.claim) };
}

function sqlDeps(db: Database, extra: Partial<RebaselineDeps> = {}): RebaselineDeps & { queued: string[] } {
  const queued: string[] = [];
  return {
    db,
    setVerdict: (projectId, slug, verdict, disputes) =>
      db.run("UPDATE knowledge SET verdict = ?, disputes_json = ? WHERE project_id = ? AND slug = ?", [
        verdict,
        verdict === null ? null : JSON.stringify(disputes),
        projectId,
        slug,
      ]),
    queueReverify: (projectId, slug) => queued.push(`${projectId}/${slug}`),
    queued,
    ...extra,
  };
}

const cite = (claim: string, quote: string): DraftDispute => ({
  kind: "contradicted",
  claim,
  finding: "differs",
  evidence: "rg",
  citations: [{ file: "/repo/graph.ts", line: 3, quote }],
});

const tieDispute = (other: string) => contradictionDispute(other, "they disagree", UNDECIDED_BASIS);

function corpus(): Doc[] {
  return [
    { slug: "refuted", verdict: "disputed", disputes: [cite("CO_CITATION_FANOUT = 6", "const CO_CITATION_FANOUT = 6;")] },
    { slug: "real", verdict: "disputed", disputes: [cite("CO_CITATION_FANOUT = 6", "const CO_CITATION_FANOUT = 9;")] },
    { slug: "tie-a", verdict: "disputed", disputes: [tieDispute("tie-b")] },
    { slug: "tie-b", verdict: "disputed", disputes: [tieDispute("tie-a")] },
    { slug: "plan", verdict: "contradicted", disputes: [contradictionDispute("outcome", "r", "outcome was kept")] },
    { slug: "outcome", verdict: "contradicted", disputes: [contradictionDispute("plan", "r", "plan was kept")] },
    { slug: "live-a", verdict: "contradicted", disputes: [contradictionDispute("live-b", "r", "live-b was kept")] },
    { slug: "live-b", verdict: null, disputes: [] },
  ];
}

describe("rebaselineDisputes", () => {
  test("deterministic pass: refutes, converts ties, clears edges the ledger reads as a timeline, queues the disputed", async () => {
    const db = seed(corpus());
    recordJudgment(db, { projectId: "p", subjectSlug: "plan", candidateSlug: "outcome", outcome: "supersedes" });
    recordJudgment(db, { projectId: "p", subjectSlug: "live-a", candidateSlug: "live-b", outcome: "contradicts" });
    const deps = sqlDeps(db);

    const first = await rebaselineDisputes(deps);
    expect(first).toMatchObject({ refutedDisputes: 1, tiesConverted: 2, edgesCleared: 1, superseded: 0, judged: 0 });
    expect(first.reverify).toEqual(["p/real"]);
    expect(deps.queued).toEqual(["p/real"]);

    expect(state(db, "refuted").verdict).toBe("unverified");
    expect(state(db, "real")).toEqual({ verdict: "disputed", claims: ["CO_CITATION_FANOUT = 6"] });
    expect(state(db, "tie-a")).toEqual({ verdict: "contradicted", claims: ["Contradicts tie-b"] });
    expect(state(db, "tie-b").verdict).toBe("contradicted");
    expect(state(db, "plan")).toEqual({ verdict: null, claims: [] });
    expect(state(db, "outcome")).toEqual({ verdict: null, claims: [] });
    // A pair the ledger still reads as a contradiction keeps its edge.
    expect(state(db, "live-a")).toEqual({ verdict: "contradicted", claims: ["Contradicts live-b"] });

    // Idempotent: a second run over its own output writes nothing.
    const second = await rebaselineDisputes(deps);
    expect(second).toMatchObject({ docsChanged: 0, refutedDisputes: 0, tiesConverted: 0, edgesCleared: 0 });
    expect(second.reverify).toEqual(["p/real"]);
  });

  test("a dispute the quote confirms only partly, or under another qualified name, is kept", async () => {
    const partial = cite("TIMEOUT_MS = 30, MAX_RETRIES = 3", "const TIMEOUT_MS = 30;");
    const otherName = cite("client.timeoutMs = 30", "server.timeoutMs = 30");
    const db = seed([
      { slug: "partial", verdict: "disputed", disputes: [partial] },
      { slug: "other-name", verdict: "disputed", disputes: [otherName] },
    ]);
    const result = await rebaselineDisputes(sqlDeps(db));
    expect(result.refutedDisputes).toBe(0);
    expect(state(db, "partial")).toEqual({ verdict: "disputed", claims: [partial.claim] });
    expect(state(db, "other-name")).toEqual({ verdict: "disputed", claims: [otherName.claim] });
  });

  test("with a judge: re-judges each pair, clears complementary edges and retires a confidently superseded doc", async () => {
    const verified = "2026-10-01T00:00:00Z";
    const db = seed([
      { slug: "facet-a", verdict: "contradicted", disputes: [contradictionDispute("facet-b", "r", "kept")] },
      { slug: "facet-b", verdict: "contradicted", disputes: [contradictionDispute("facet-a", "r", "kept")] },
      {
        slug: "new-design",
        verdict: "clean",
        disputes: [],
        lastVerifiedAt: verified,
        generatedAt: verified,
      },
      {
        slug: "old-design",
        verdict: "contradicted",
        disputes: [contradictionDispute("new-design", "r", "new-design was kept")],
        generatedAt: "2026-06-01T00:00:00Z",
      },
      { slug: "real-a", verdict: "contradicted", disputes: [contradictionDispute("real-b", "r", "kept")] },
      { slug: "real-b", verdict: "contradicted", disputes: [contradictionDispute("real-a", "r", "kept")] },
    ]);
    const relations: Record<string, ContradictionJudgment> = {
      "facet-a facet-b": { contradicts: false, relation: "complementary", reason: "different steps" },
      // Pairs are judged in slug order, so A is new-design and B old-design.
      "new-design old-design": {
        contradicts: false,
        relation: "supersedes",
        newer: "a",
        confidence: 0.95,
        reason: "the design shipped",
      },
      "real-a real-b": { contradicts: true, relation: "contradicts", reason: "opposite" },
    };
    const judged: string[] = [];
    const deps = sqlDeps(db, {
      judge: async (a, b) => {
        judged.push(`${a.slug} ${b.slug}`);
        return relations[`${a.slug} ${b.slug}`]!;
      },
      readAcceptedDoc: async (_p, slug): Promise<KnowledgeDocFile> => ({
        slug,
        title: slug,
        body: "body",
        tags: [],
        updatedAt: new Date(),
        sourceKind: "code",
      }),
    });

    const first = await rebaselineDisputes(deps);
    expect(judged.sort()).toEqual(["facet-a facet-b", "new-design old-design", "real-a real-b"]);
    expect(first).toMatchObject({ edgesCleared: 2, superseded: 1, judged: 3 });
    expect(state(db, "facet-a")).toEqual({ verdict: null, claims: [] });
    expect(state(db, "old-design")).toEqual({ verdict: "superseded", claims: ["Superseded by new-design"] });
    expect(state(db, "new-design").verdict).toBe("clean");
    expect(state(db, "real-a").verdict).toBe("contradicted");

    const second = await rebaselineDisputes(deps);
    expect(second).toMatchObject({ docsChanged: 0, edgesCleared: 0, superseded: 0 });
    // The verdict history saw each change once.
    expect(verdictFlipRate(db).flippedDocs).toBe(0);
  });

  test("without a judge, a ledger supersession only clears the edge — no doc is retired", async () => {
    const db = seed([
      { slug: "x", verdict: "contradicted", disputes: [contradictionDispute("y", "r", "kept")] },
      { slug: "y", verdict: "clean", disputes: [], lastVerifiedAt: "2026-10-01T00:00:00Z" },
    ]);
    recordJudgment(db, { projectId: "p", subjectSlug: "x", candidateSlug: "y", outcome: "supersedes" });
    const counts = await rebaselineDisputes(sqlDeps(db));
    expect(counts).toMatchObject({ edgesCleared: 1, superseded: 0 });
    expect(state(db, "x").verdict).toBeNull();
  });
});
