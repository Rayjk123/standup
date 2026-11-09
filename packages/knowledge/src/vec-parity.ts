/**
 * Brute-force ⇄ sqlite-vec KNN parity harness.
 *
 * Run as its own process (see vec.test.ts) because enabling sqlite-vec means
 * pointing bun:sqlite at an extension-capable SQLite via Database.setCustomSQLite,
 * a one-shot process global that must run before any connection is opened — not
 * something a test sharing the runner's process can guarantee.
 *
 * It seeds one corpus, then runs the SAME searchKnowledge over it twice — once
 * with the KNN index live, once with STANDUP_DISABLE_VEC forcing the linear
 * scan — and checks the ranked doc lists match across a spread of query / corpus
 * / source-kind / limit scenarios. Exit 0 = parity held; 1 = a scenario diverged;
 * 2 = sqlite-vec could not load here (the KNN path is unavailable, so parity is
 * vacuous and the caller documents the fallback instead).
 */
import { Database } from "bun:sqlite";
import { GLOBAL_PROJECT_ID } from "@standup/shared";
import { KnowledgeStore } from "./store.js";
import { searchKnowledge } from "./search.js";
import { registerEmbeddingProvider } from "./embeddings.js";
import { isVecAvailable } from "./vec.js";
import type { KnowledgeDoc, ScopeAudience, Scope, SourceKind } from "./types.js";

const CANDIDATE_SQLITE = [
  process.env.STANDUP_SQLITE_PATH,
  "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
  "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
].filter((p): p is string => !!p);

function enableExtensionLoading(): void {
  for (const path of CANDIDATE_SQLITE) {
    try {
      Database.setCustomSQLite(path);
      return;
    } catch {
      // try next
    }
  }
}

// A 3-D unit vector at cosine `cos` to the query axis [1,0,0], with a tiny
// third-axis jitter so distinct chunks never tie on distance — a tie would let
// the two paths order equal-score docs differently for reasons unrelated to the
// index under test.
function vec(cos: number, jitter = 0): number[] {
  const y = Math.sqrt(Math.max(0, 1 - cos * cos - jitter * jitter));
  return [cos, y, jitter];
}

function doc(overrides: Partial<KnowledgeDoc>): KnowledgeDoc {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    projectId: overrides.projectId ?? "alpha",
    slug: overrides.slug ?? "doc",
    title: overrides.title ?? "Doc",
    body: overrides.body ?? "body",
    updatedAt: new Date("2026-08-16T00:00:00Z"),
    filePath: "/x/doc.md",
    ...overrides,
  };
}

interface DocSpec {
  id: string;
  projectId: string;
  kind: SourceKind;
  scope?: Scope;
  ownerUser?: string;
  chunks: number[]; // one cosine per chunk
}

// Docs across two projects, mixed source kinds, some multi-chunk (so the
// chunk→doc rollup and the KNN over-fetch window are actually exercised), plus
// a scope/owner mix (global, project, user) so the scope-gated scenarios below
// exercise the audience gate on both the KNN and brute-force arms. Module-level
// so the no-leak invariant can resolve each result doc's scope/owner without
// re-deriving the corpus.
const SEED_SPECS: DocSpec[] = [
  { id: "a1", projectId: "alpha", kind: "code", chunks: [0.95, 0.4] },
  { id: "a2", projectId: "alpha", kind: "spec", chunks: [0.82] },
  { id: "a3", projectId: "alpha", kind: "product", chunks: [0.6, 0.55, 0.5] },
  { id: "a4", projectId: "alpha", kind: "code", chunks: [0.3] },
  { id: "b1", projectId: "beta", kind: "code", chunks: [0.9] },
  { id: "b2", projectId: "beta", kind: "spec", chunks: [0.7, 0.65] },
  { id: "b3", projectId: "beta", kind: "product", chunks: [0.45] },
  { id: "b4", projectId: "beta", kind: "decision", chunks: [0.2] },
  // Scope/owner variety. The global doc must reach every audience; the
  // user-scoped docs only their owner; the cross-project user doc (alice's, in
  // beta) must still reach an alpha/alice audience — the exact case the vec KNN
  // post-filter could starve.
  { id: "g1", projectId: "alpha", kind: "code", scope: "global", chunks: [0.88, 0.5] },
  { id: "ua", projectId: "alpha", kind: "code", scope: "user", ownerUser: "alice", chunks: [0.77] },
  { id: "ub", projectId: "beta", kind: "spec", scope: "user", ownerUser: "alice", chunks: [0.72] },
  { id: "uc", projectId: "beta", kind: "code", scope: "user", ownerUser: "bob", chunks: [0.66] },
  // Docs homed in the reserved GLOBAL corpus, so the global-home disjunct is
  // actually exercised on both arms. `gp` (scope='project' in global) must reach
  // every audience — the legacy defense-in-depth case. `gu` (scope='user' in
  // global, owned by alice) must reach ONLY alice: it must NOT leak to bob's or
  // an unresolved audience via the reserved-home shortcut. High cosines so a
  // leak would surface at the top of the recall window rather than hiding below
  // the limit.
  { id: "gp", projectId: GLOBAL_PROJECT_ID, kind: "code", scope: "project", chunks: [0.85] },
  { id: "gu", projectId: GLOBAL_PROJECT_ID, kind: "code", scope: "user", ownerUser: "alice", chunks: [0.83] },
];

// The strict scope gate, computed independently of the SQL predicate under test,
// so the no-leak assertion catches a KNN result that agrees with the brute-force
// scan yet is wrongly IN-scope (a bug parity alone would miss). Mirrors
// scopeAudienceSql: global scope, OR the reserved GLOBAL-corpus home, OR this
// project's project-scoped docs, OR the resolved user's own user-scoped docs.
const SPEC_BY_ID = new Map(SEED_SPECS.map((s) => [s.id, s]));

function specInAudience(spec: DocSpec, audience: ScopeAudience): boolean {
  const scope = spec.scope ?? "project";
  if (scope === "global") return true;
  // The reserved-home shortcut excludes scope='user' — a user-scoped doc homed
  // in the GLOBAL corpus reaches only its owner (via the owner check below),
  // never every audience. Mirrors scopeAudienceSql's `scope != 'user'` guard;
  // without this exclusion the oracle would bless the very cross-user leak the
  // SCOPE LEAK assertion is meant to catch.
  if (spec.projectId === GLOBAL_PROJECT_ID && scope !== "user") return true;
  if (scope === "project" && spec.projectId === audience.projectId) return true;
  if (scope === "project" && (audience.relatedProjectIds ?? []).includes(spec.projectId)) return true;
  if (scope === "user" && audience.user !== undefined && spec.ownerUser === audience.user) {
    return true;
  }
  return false;
}

function seed(db: Database): void {
  const store = new KnowledgeStore(db);

  let jitter = 1;
  for (const s of SEED_SPECS) {
    store.upsertDoc(
      doc({
        id: s.id,
        projectId: s.projectId,
        slug: s.id,
        title: `Title ${s.id}`,
        body: `body of ${s.id}`,
        sourceKind: s.kind,
        scope: s.scope,
        ownerUser: s.ownerUser,
      })
    );
    s.chunks.forEach((cos, i) => {
      store.upsertChunk({
        id: `${s.id}-c${i}`,
        knowledgeId: s.id,
        chunkIndex: i,
        text: `chunk ${i} of ${s.id}`,
        embedding: vec(cos, jitter++ * 1e-4),
      });
    });
  }

  // Every third doc's chunks hold their vector as JSON with no blob, the shape
  // of a row written before the blob column existed, so both the rebuild and
  // the brute-force scan read the JSON fallback for some of the corpus.
  SEED_SPECS.forEach((s, i) => {
    if (i % 3 !== 0) return;
    for (const chunk of store.getChunks(s.id)) {
      db.run("UPDATE knowledge_chunks SET embedding_json = ?, embedding_blob = NULL WHERE id = ?", [
        JSON.stringify(chunk.embedding),
        chunk.id,
      ]);
    }
  });

  // Index the corpus (no-op if sqlite-vec is unavailable).
  store.rebuildVecIndex();

  // Re-embed a few docs' chunks through the INCREMENTAL upsertChunk path with
  // FRESH ids and identical vectors — the exact runtime shape (embedDoc mints a
  // new randomUUID per chunk on every re-embed, while ON CONFLICT leaves
  // knowledge_chunks.id untouched). This exercises indexChunkVector's mapping
  // of the vec chunk_id back to the STORED id rather than the incoming one; a
  // regression there drops the re-embedded chunks from the KNN candidate set,
  // and the scenarios below then diverge from the brute-force scan.
  for (const id of ["a1", "a3", "b2"]) {
    const stored = store.getChunks(id);
    for (const chunk of stored) {
      store.upsertChunk({
        id: crypto.randomUUID(),
        knowledgeId: chunk.knowledgeId,
        chunkIndex: chunk.chunkIndex,
        text: chunk.text,
        embedding: chunk.embedding,
      });
    }
  }
}

interface Scenario {
  project: string;
  corpus: "project" | "all";
  sourceKinds?: SourceKind[];
  audience?: ScopeAudience;
  owners?: string[];
  limit: number;
}

const SCENARIOS: Scenario[] = [
  { project: "alpha", corpus: "all", limit: 5 },
  { project: "beta", corpus: "all", limit: 5 },
  { project: "alpha", corpus: "project", limit: 5 },
  { project: "beta", corpus: "project", limit: 3 },
  { project: "alpha", corpus: "all", sourceKinds: ["spec", "product"], limit: 5 },
  { project: "beta", corpus: "project", sourceKinds: ["code", "spec"], limit: 4 },
  { project: "alpha", corpus: "all", limit: 2 },
  // Scope-gated scenarios: a vec-enabled host must return the SAME gated set as
  // an FTS/brute-force host. The vec0 mirror carries scope/owner partition keys,
  // so the gated KNN pre-filters within partition (a union of per-partition
  // subqueries) rather than post-filtering a fixed top-K — this locks that the
  // partitioned KNN and the scan agree and that no in-scope doc is starved.
  // Alice's alpha agent must see global + alpha-project + her own docs (including
  // her cross-project one in beta), never bob's or beta's project docs.
  { project: "alpha", corpus: "all", audience: { projectId: "alpha", user: "alice" }, limit: 6 },
  { project: "beta", corpus: "all", audience: { projectId: "beta", user: "bob" }, limit: 6 },
  // A project with no docs of its own, so the whole recall window is drawn from
  // the global corpus — nothing local dilutes it below the limit. This is where
  // a user-scoped doc homed in GLOBAL (gu) would surface for a NON-owner if the
  // reserved-home disjunct failed to exclude scope='user'; dave is not gu's
  // owner, so the SCOPE LEAK assertion flags it unless the gate isolates it. gp
  // (project-scoped, global-homed) must still reach dave.
  { project: "gamma", corpus: "all", audience: { projectId: "gamma", user: "dave" }, limit: 6 },
  // Unresolved identity → global ∪ project only, no user docs.
  { project: "alpha", corpus: "all", audience: { projectId: "alpha" }, limit: 6 },
  // Gate + kind filter compose.
  { project: "alpha", corpus: "all", audience: { projectId: "alpha", user: "alice" }, sourceKinds: ["code"], limit: 6 },
  // Permissive owner filter (browse) — pushed into the KNN as an owner_user
  // partition pre-filter (one subquery per owner); parity must hold.
  { project: "alpha", corpus: "all", owners: ["alice"], limit: 6 },
];

async function idsFor(db: Database, s: Scenario): Promise<string> {
  const results = await searchKnowledge(db, s.project, "the query term", "parity-fake", {
    limit: s.limit,
    corpus: s.corpus,
    sourceKinds: s.sourceKinds,
    audience: s.audience,
    owners: s.owners,
  });
  return results.map((r) => `${r.projectId}/${r.slug}`).join(",");
}

export async function runParity(): Promise<0 | 1 | 2> {
  enableExtensionLoading();

  registerEmbeddingProvider({
    id: "parity-fake",
    defaultModel: "m",
    // The query sits on the [1,0,0] axis; each chunk's cosine to it is fixed by
    // its seeded vector, so ranking is fully determined by the data.
    async embed() {
      return [1, 0, 0];
    },
  });

  const db = new Database(":memory:");
  seed(db);

  const store = new KnowledgeStore(db);
  if (!isVecAvailable(db) || !store.vecReady()) {
    console.log("PARITY: unavailable — sqlite-vec did not load on this host");
    return 2;
  }

  let mismatch = false;
  for (const s of SCENARIOS) {
    delete process.env.STANDUP_DISABLE_VEC;
    const knn = await idsFor(db, s);

    process.env.STANDUP_DISABLE_VEC = "1";
    const brute = await idsFor(db, s);
    delete process.env.STANDUP_DISABLE_VEC;

    const aud = s.audience
      ? `${s.audience.projectId}/${s.audience.user ?? "-"}`
      : "-";
    const tag = `${s.project} corpus=${s.corpus} kinds=${s.sourceKinds?.join("|") ?? "*"} aud=${aud} owners=${s.owners?.join("|") ?? "-"} limit=${s.limit}`;
    if (knn !== brute) {
      mismatch = true;
      console.log(`PARITY MISMATCH [${tag}]\n  knn=[${knn}]\n  brute=[${brute}]`);
    } else {
      console.log(`PARITY OK [${tag}] -> [${knn}]`);
    }

    // The vec-path scope assertion: parity alone would pass even if the KNN and
    // the scan agreed on a WRONGLY in-scope doc, so for a gated scenario check
    // the KNN result directly against the independently-computed audience. Every
    // returned doc must be in-audience — an out-of-scope hit is a cross-user or
    // cross-project leak on the vec path, which no in-scope doc being starved
    // must ever be allowed to hide.
    if (s.audience) {
      const leaked = knn
        .split(",")
        .filter(Boolean)
        .map((coord) => coord.split("/")[1])
        .filter((id) => {
          const spec = SPEC_BY_ID.get(id);
          return spec !== undefined && !specInAudience(spec, s.audience!);
        });
      if (leaked.length > 0) {
        mismatch = true;
        console.log(`SCOPE LEAK [${tag}] out-of-audience docs on the vec path: [${leaked.join(",")}]`);
      }
    }
  }

  return mismatch ? 1 : 0;
}

if (import.meta.main) {
  runParity()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("PARITY ERROR:", err);
      process.exit(1);
    });
}
