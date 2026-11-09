import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { GLOBAL_PROJECT_ID } from "@standup/shared";
import { KnowledgeStore } from "./store.js";
import {
  buildVecTableDDL,
  vecTableDeclaresPartitionKeys,
  VEC_OWNER_NONE,
  VEC_TABLE,
} from "./vec.js";
import {
  scopeAudiencePartitionSpecs,
  partitionSpecsForGate,
  type VecPartitionSpec,
  type KnowledgeDoc,
  type ScopeAudience,
  type Scope,
} from "./types.js";

// These tests exercise the vec0 partition-key DDL, the scope/owner gate → vec0
// partition-spec decomposition, and the inert-when-disabled contract WITHOUT the
// sqlite-vec extension, so they run everywhere the parity harness (vec.test.ts)
// returns vacuous. The extension-backed parity/no-leak check lives there.

function doc(overrides: Partial<KnowledgeDoc> = {}): KnowledgeDoc {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    projectId: "proj",
    slug: "doc",
    title: "Doc",
    body: "body",
    updatedAt: new Date("2026-08-16T00:00:00Z"),
    filePath: "/x/doc.md",
    ...overrides,
  };
}

describe("vec0 partition-key DDL", () => {
  test("declares project_id, scope, and owner_user as partition keys at the fixed width", () => {
    const ddl = buildVecTableDDL(384);
    expect(ddl).toContain(`CREATE VIRTUAL TABLE ${VEC_TABLE} USING vec0(`);
    expect(ddl).toContain("project_id text partition key");
    expect(ddl).toContain("scope text partition key");
    expect(ddl).toContain("owner_user text partition key");
    // source_kind stays a filterable metadata column, chunk_id an auxiliary one.
    expect(ddl).toContain("source_kind text");
    expect(ddl).toContain("+chunk_id text");
    expect(ddl).toContain("embedding float[384] distance_metric=cosine");
  });

  test("stays within vec0's four-partition-key limit", () => {
    const count = (buildVecTableDDL(3).match(/partition key/g) ?? []).length;
    expect(count).toBe(3);
    expect(count).toBeLessThanOrEqual(4);
  });

  test("VEC_OWNER_NONE is a non-null sentinel a trimmed alias can never equal", () => {
    expect(typeof VEC_OWNER_NONE).toBe("string");
    expect(VEC_OWNER_NONE.trim()).toBe("");
  });
});

describe("vecTableDeclaresPartitionKeys — the stale-mirror schema check", () => {
  test("false for a mirror partitioned only by project_id (older build)", () => {
    const oldDdl = `CREATE VIRTUAL TABLE ${VEC_TABLE} USING vec0(
      project_id text partition key,
      source_kind text,
      +chunk_id text,
      embedding float[3] distance_metric=cosine
    )`;
    expect(vecTableDeclaresPartitionKeys(oldDdl)).toBe(false);
  });

  test("true for the current scope/owner-partitioned mirror", () => {
    expect(vecTableDeclaresPartitionKeys(buildVecTableDDL(3))).toBe(true);
  });

  test("false for a missing/empty stored statement", () => {
    expect(vecTableDeclaresPartitionKeys(null)).toBe(false);
    expect(vecTableDeclaresPartitionKeys(undefined)).toBe(false);
    expect(vecTableDeclaresPartitionKeys("")).toBe(false);
  });
});

describe("scopeAudiencePartitionSpecs — the scope-gate disjuncts as equality specs", () => {
  test("resolved user yields the four disjuncts", () => {
    const specs = scopeAudiencePartitionSpecs({ projectId: "alpha", user: "alice" });
    expect(specs).toEqual([
      { scope: "global" },
      { scope: "project", projectId: GLOBAL_PROJECT_ID },
      { scope: "project", projectId: "alpha" },
      { scope: "user", ownerUser: "alice" },
    ]);
  });

  test("unresolved identity drops the user disjunct (safe global ∪ project)", () => {
    const specs = scopeAudiencePartitionSpecs({ projectId: "alpha" });
    expect(specs).toEqual([
      { scope: "global" },
      { scope: "project", projectId: GLOBAL_PROJECT_ID },
      { scope: "project", projectId: "alpha" },
    ]);
    // A blank alias is treated as unresolved, never as an owner_user value.
    expect(scopeAudiencePartitionSpecs({ projectId: "alpha", user: "  " })).toEqual(
      specs
    );
  });

  test("a browse audience spans every project's shared docs plus the user's own", () => {
    expect(scopeAudiencePartitionSpecs({ projectId: "alpha", user: "alice", browse: true })).toEqual([
      { scope: "global" },
      { scope: "project" },
      { scope: "user", ownerUser: "alice" },
    ]);
  });
});

describe("partitionSpecsForGate — composing project pin + gate + owner filter", () => {
  test("ungated: a bare unconstrained spec, optionally pinned to one project", () => {
    expect(partitionSpecsForGate(undefined, undefined, undefined)).toEqual([{}]);
    expect(partitionSpecsForGate("alpha", undefined, undefined)).toEqual([
      { projectId: "alpha" },
    ]);
  });

  test("a project pin drops a spec fixed to a different project", () => {
    // corpus=project under audience alpha/alice: the GLOBAL-home spec is dropped
    // (its project_id can never equal alpha), the alpha spec keeps its project.
    const specs = partitionSpecsForGate(
      "alpha",
      { projectId: "alpha", user: "alice" },
      undefined
    );
    expect(specs).toEqual([
      { scope: "global", projectId: "alpha" },
      { scope: "project", projectId: "alpha" },
      { scope: "user", ownerUser: "alice", projectId: "alpha" },
    ]);
  });

  test("an owner filter fans each spec out per owner and drops owner conflicts", () => {
    const specs = partitionSpecsForGate(
      undefined,
      { projectId: "alpha", user: "alice" },
      ["alice", "bob"]
    );
    // Every base spec is ANDed with each owner; the user spec (owner_user=alice)
    // survives only for the matching owner. Blank owners are dropped.
    expect(specs).toEqual([
      { scope: "global", ownerUser: "alice" },
      { scope: "global", ownerUser: "bob" },
      { scope: "project", projectId: GLOBAL_PROJECT_ID, ownerUser: "alice" },
      { scope: "project", projectId: GLOBAL_PROJECT_ID, ownerUser: "bob" },
      { scope: "project", projectId: "alpha", ownerUser: "alice" },
      { scope: "project", projectId: "alpha", ownerUser: "bob" },
      { scope: "user", ownerUser: "alice" },
    ]);
  });
});

// The equivalence guarantee, checked WITHOUT sqlite-vec: the union of the
// partition specs must select EXACTLY the doc set the brute-force gated scan
// selects. Translate each spec to the same equality predicate a vec0 partition
// filter applies and OR them, then compare the matched knowledge ids to
// getAllChunksWithEmbeddings' output over the identical corpus. A mismatch means
// the decomposition and the brute-force gate would diverge on a real KNN.
describe("gated partition specs match the brute-force gate (extension-free)", () => {
  interface Seed {
    id: string;
    projectId: string;
    scope?: Scope;
    ownerUser?: string;
  }
  const SEED: Seed[] = [
    { id: "ap", projectId: "alpha", scope: "project" },
    { id: "ag", projectId: "alpha", scope: "global" },
    { id: "au", projectId: "alpha", scope: "user", ownerUser: "alice" },
    { id: "bp", projectId: "beta", scope: "project" },
    { id: "bua", projectId: "beta", scope: "user", ownerUser: "alice" },
    { id: "bub", projectId: "beta", scope: "user", ownerUser: "bob" },
    { id: "gp", projectId: GLOBAL_PROJECT_ID, scope: "project" },
    { id: "gu", projectId: GLOBAL_PROJECT_ID, scope: "user", ownerUser: "alice" },
  ];

  function seededStore(): { db: Database; store: KnowledgeStore } {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    for (const s of SEED) {
      store.upsertDoc(
        doc({
          id: s.id,
          projectId: s.projectId,
          slug: s.id,
          title: s.id,
          scope: s.scope,
          ownerUser: s.ownerUser,
        })
      );
      store.upsertChunk({
        id: `${s.id}-c`,
        knowledgeId: s.id,
        chunkIndex: 0,
        text: `chunk of ${s.id}`,
        embedding: [1, 0, 0],
      });
    }
    return { db, store };
  }

  // Mirror the vec0 partition-key equality a spec expresses, as SQL over the
  // knowledge table. An unset field is unconstrained; owner_user unset matches a
  // NULL owner (the mirror stores the VEC_OWNER_NONE sentinel there but never
  // queries it), an owner-scoped spec matches only that alias.
  function idsMatchingSpecs(db: Database, specs: VecPartitionSpec[]): Set<string> {
    if (specs.length === 0) return new Set();
    const parts: string[] = [];
    const params: string[] = [];
    for (const s of specs) {
      const cl: string[] = [];
      if (s.projectId !== undefined) {
        cl.push("k.project_id = ?");
        params.push(s.projectId);
      }
      if (s.scope !== undefined) {
        cl.push("k.scope = ?");
        params.push(s.scope);
      }
      if (s.ownerUser !== undefined) {
        cl.push("k.owner_user = ?");
        params.push(s.ownerUser);
      }
      parts.push(cl.length ? `(${cl.join(" AND ")})` : "1");
    }
    const rows = db
      .query(
        `SELECT DISTINCT k.id AS id FROM knowledge_chunks kc
         JOIN knowledge k ON k.id = kc.knowledge_id
         WHERE (${parts.join(" OR ")})`
      )
      .all(...params) as Array<{ id: string }>;
    return new Set(rows.map((r) => r.id));
  }

  interface Combo {
    name: string;
    pin?: string;
    audience?: ScopeAudience;
    owners?: string[];
  }
  const COMBOS: Combo[] = [
    { name: "corpus=all, alpha/alice", audience: { projectId: "alpha", user: "alice" } },
    { name: "corpus=all, beta/bob", audience: { projectId: "beta", user: "bob" } },
    { name: "corpus=all, gamma/dave (no local docs)", audience: { projectId: "gamma", user: "dave" } },
    { name: "corpus=all, alpha/unresolved", audience: { projectId: "alpha" } },
    { name: "corpus=project alpha, alpha/alice", pin: "alpha", audience: { projectId: "alpha", user: "alice" } },
    { name: "corpus=project beta, alpha/alice (cross-project agent)", pin: "beta", audience: { projectId: "alpha", user: "alice" } },
    { name: "corpus=all, owners=[alice] (browse, no audience)", owners: ["alice"] },
    { name: "corpus=all, alpha/alice + owners=[alice]", audience: { projectId: "alpha", user: "alice" }, owners: ["alice"] },
    { name: "corpus=all, alpha/alice + owners=[bob] (empty intersection)", audience: { projectId: "alpha", user: "alice" }, owners: ["bob"] },
  ];

  for (const combo of COMBOS) {
    test(`${combo.name}`, () => {
      const { db, store } = seededStore();
      const brute = new Set(
        store
          .getAllChunksWithEmbeddings(combo.pin, undefined, combo.audience, combo.owners)
          .map((c) => c.knowledgeId)
      );
      const specs = partitionSpecsForGate(combo.pin, combo.audience, combo.owners);
      const viaSpecs = idsMatchingSpecs(db, specs);
      expect([...viaSpecs].sort()).toEqual([...brute].sort());
    });
  }
});

describe("vec0-disabled rebuild is fully inert", () => {
  function vecTableRows(db: Database): number {
    return (
      db
        .query("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(VEC_TABLE) as { n: number }
    ).n;
  }

  test("rebuildVecIndex and incremental upserts never create the mirror when vec0 is off", () => {
    const prev = process.env.STANDUP_DISABLE_VEC;
    process.env.STANDUP_DISABLE_VEC = "1";
    try {
      const db = new Database(":memory:");
      const store = new KnowledgeStore(db);
      store.upsertDoc(doc({ id: "d", projectId: "proj", slug: "d", scope: "user", ownerUser: "alice" }));
      // Incremental index path (upsertChunk → indexChunkVector) must be inert.
      store.upsertChunk({ id: "d-c", knowledgeId: "d", chunkIndex: 0, text: "c", embedding: [1, 0, 0] });
      expect(vecTableRows(db)).toBe(0);

      // The one-time rebuild must be a no-op too — no table, no throw, not ready.
      expect(() => store.rebuildVecIndex()).not.toThrow();
      expect(vecTableRows(db)).toBe(0);
      expect(store.vecReady()).toBe(false);
      // Gated KNN helper stays empty so search falls back to the brute-force scan.
      expect(
        store.vecKnnChunkIds([1, 0, 0], 5, undefined, undefined, { projectId: "proj", user: "alice" })
      ).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.STANDUP_DISABLE_VEC;
      else process.env.STANDUP_DISABLE_VEC = prev;
    }
  });
});
