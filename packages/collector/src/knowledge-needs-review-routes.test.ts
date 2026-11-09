import { expect, test, describe, afterAll } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import {
  createStore,
  upsertProject,
  createKnowledgeResolution,
  getKnowledgeResolution,
  setSetting,
  type Store,
} from "@standup/store";
import { writeKnowledgeFile, KnowledgeStore } from "@standup/knowledge";
import { createServer } from "./server.js";
import { KnowledgeSync } from "./knowledge-sync.js";
import { MULTIPLAYER_OVERRIDE_SETTING } from "./multiplayer.js";

/**
 * The cross-project needs-review HTTP surface for held contradiction resolutions:
 * the id-keyed confirm / reject / swap routes a human uses to release (or dismiss)
 * a resolution the autonomy gate withheld, plus the queue-listing route. Exercised
 * end to end against the running app, asserting the corpus effect (tombstone / edge
 * clear) and the ledger transition, not just the pure apply helper.
 */

function projectId(): string {
  return `needs-review-${randomUUID().slice(0, 8)}`;
}

const cleanupDirs: string[] = [];
afterAll(async () => {
  for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
});

async function setup(): Promise<{ store: Store; id: string; sync: KnowledgeSync; dir: string }> {
  const store = createStore(":memory:");
  const id = projectId();
  upsertProject(store.db, { id, name: "Needs Review Test", branch: "main", repos: [] });
  const dir = await mkdtemp(join(tmpdir(), "standup-needs-review-"));
  cleanupDirs.push(dir);
  const sync = new KnowledgeSync(store.db, dir, null);
  return { store, id, sync, dir };
}

/**
 * Two accepted docs flagged as a live mutual contradiction, plus a withheld
 * (needs_review) supersede row proposing `keep` beats `drop`.
 */
async function seedContradiction(
  store: Store,
  id: string,
  sync: KnowledgeSync,
  dir: string,
  rid = "rid-1",
): Promise<void> {
  await writeKnowledgeFile(dir, id, { slug: "keep", title: "Keep This", body: "the winner" });
  await writeKnowledgeFile(dir, id, { slug: "drop", title: "Drop This", body: "the loser" });
  await sync.syncProject(id);
  sync.recordDocVerdict(id, "keep", "contradicted", [
    { claim: "Contradicts drop", finding: "opp", evidence: "e" },
  ]);
  sync.recordDocVerdict(id, "drop", "contradicted", [
    { claim: "Contradicts keep", finding: "opp", evidence: "e" },
  ]);
  createKnowledgeResolution(store.db, {
    id: rid,
    projectId: id,
    winnerSlug: "keep",
    loserSlug: "drop",
    type: "supersede",
    status: "needs_review",
    autoApplied: false,
    rationale: "keep reflects current code",
    detail: JSON.stringify({ reason: "owner claim" }),
  });
}

describe("GET /api/knowledge/needs-review", () => {
  test("lists needs_review rows across projects, joined with winner/loser titles", async () => {
    const { store, id, sync, dir } = await setup();
    await seedContradiction(store, id, sync, dir);
    // An already-applied row must NOT appear in the review queue.
    createKnowledgeResolution(store.db, {
      id: "applied-1",
      projectId: id,
      winnerSlug: "keep",
      loserSlug: "other",
      type: "supersede",
      status: "applied",
      autoApplied: true,
      rationale: "auto",
    });

    const app = createServer(store, () => {}, null, sync, undefined, dir);
    const rows = (await (await app.request("/api/knowledge/needs-review")).json()) as Array<{
      id: string;
      winnerTitle: string;
      loserTitle: string;
      rationale: string;
    }>;
    expect(rows.map((r) => r.id)).toEqual(["rid-1"]);
    expect(rows[0]!.winnerTitle).toBe("Keep This");
    expect(rows[0]!.loserTitle).toBe("Drop This");
    expect(rows[0]!.rationale).toContain("current code");

    store.close();
  });
});

describe("POST /api/knowledge/resolutions/:id/confirm", () => {
  test("applies the held supersede: loser tombstoned, winner edge cleared, row applied", async () => {
    const { store, id, sync, dir } = await setup();
    await seedContradiction(store, id, sync, dir);

    const app = createServer(store, () => {}, null, sync, undefined, dir);
    const res = await app.request("/api/knowledge/resolutions/rid-1/confirm", { method: "POST" });
    expect(res.status).toBe(200);

    const ks = new KnowledgeStore(store.db);
    expect(ks.getDoc(id, "drop")!.verdict).toBe("superseded");
    expect(ks.getDoc(id, "keep")!.verdict ?? null).toBeNull();
    const row = getKnowledgeResolution(store.db, "rid-1")!;
    expect(row.status).toBe("applied");
    // A human, not the gate, released it — auto_applied stays false.
    expect(row.autoApplied).toBe(false);

    store.close();
  });

  test("404 unknown id, 409 already-applied", async () => {
    const { store, id, sync, dir } = await setup();
    createKnowledgeResolution(store.db, {
      id: "already",
      projectId: id,
      winnerSlug: "a",
      loserSlug: "b",
      type: "supersede",
      status: "applied",
      autoApplied: true,
      rationale: "",
    });
    const app = createServer(store, () => {}, null, sync, undefined, dir);
    expect((await app.request("/api/knowledge/resolutions/nope/confirm", { method: "POST" })).status).toBe(404);
    expect((await app.request("/api/knowledge/resolutions/already/confirm", { method: "POST" })).status).toBe(409);
    store.close();
  });
});

describe("POST /api/knowledge/resolutions/:id/reject", () => {
  test("clears the contradiction edge on BOTH docs without superseding, and voids the row", async () => {
    const { store, id, sync, dir } = await setup();
    await seedContradiction(store, id, sync, dir);

    const app = createServer(store, () => {}, null, sync, undefined, dir);
    const res = await app.request("/api/knowledge/resolutions/rid-1/reject", { method: "POST" });
    expect(res.status).toBe(200);

    const ks = new KnowledgeStore(store.db);
    // Neither doc is superseded, and neither stays flagged contradicted.
    expect(ks.getDoc(id, "keep")!.verdict ?? null).toBeNull();
    expect(ks.getDoc(id, "drop")!.verdict ?? null).toBeNull();
    // The row is voided (re-detection may re-surface the pair later).
    expect(getKnowledgeResolution(store.db, "rid-1")).toBeNull();

    store.close();
  });
});

describe("POST /api/knowledge/resolutions/:id/swap", () => {
  test("applies with winner/loser reversed: original winner tombstoned, row records the swap", async () => {
    const { store, id, sync, dir } = await setup();
    await seedContradiction(store, id, sync, dir);

    const app = createServer(store, () => {}, null, sync, undefined, dir);
    const res = await app.request("/api/knowledge/resolutions/rid-1/swap", { method: "POST" });
    expect(res.status).toBe(200);

    const ks = new KnowledgeStore(store.db);
    // Swap flips who wins: the original winner "keep" is now tombstoned, "drop" cleared.
    expect(ks.getDoc(id, "keep")!.verdict).toBe("superseded");
    expect(ks.getDoc(id, "drop")!.verdict ?? null).toBeNull();
    const row = getKnowledgeResolution(store.db, "rid-1")!;
    expect(row.status).toBe("applied");
    expect(row.winnerSlug).toBe("drop");
    expect(row.loserSlug).toBe("keep");

    store.close();
  });
});

describe("multiplayer gating", () => {
  test("confirm/reject/swap succeed tokenlessly for an authenticated caller when multiplayer", async () => {
    // isTrustedCoordinationWrite trusts an authenticated identity even in
    // multiplayer, and the in-process caller resolves to the host's identity — so
    // the release goes through with no token. Each action mutates the row, so seed
    // a fresh one per action.
    for (const action of ["confirm", "reject", "swap"]) {
      const { store, id, sync, dir } = await setup();
      await seedContradiction(store, id, sync, dir);
      setSetting(store.db, MULTIPLAYER_OVERRIDE_SETTING, "on");

      const app = createServer(store, () => {}, null, sync, undefined, dir);
      const res = await app.request(`/api/knowledge/resolutions/rid-1/${action}`, { method: "POST" });
      expect(res.status).toBe(200);
      // The write applied — the row is no longer awaiting review (reject voids it).
      expect(getKnowledgeResolution(store.db, "rid-1")?.status ?? null).not.toBe("needs_review");

      store.close();
    }
  });
});
