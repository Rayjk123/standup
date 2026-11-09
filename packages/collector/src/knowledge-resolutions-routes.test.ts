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
  type Store,
} from "@standup/store";
import { writeKnowledgeFile, KnowledgeStore } from "@standup/knowledge";
import { createServer } from "./server.js";
import { KnowledgeSync } from "./knowledge-sync.js";

/**
 * The contradiction-resolver human-review HTTP surface (roadmap r7): the list
 * route that surfaces the withheld proposals, and the accept route that applies a
 * withheld resolution (the spec's "record the proposed resolution for a human to
 * accept" — exercised end to end against the running app, not just the pure
 * apply helper).
 */

function projectId(): string {
  return `resolutions-routes-${randomUUID().slice(0, 8)}`;
}

const cleanupDirs: string[] = [];
afterAll(async () => {
  for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
});

async function setup(): Promise<{ store: Store; id: string; sync: KnowledgeSync; dir: string }> {
  const store = createStore(":memory:");
  const id = projectId();
  upsertProject(store.db, { id, name: "Resolutions Test", branch: "main", repos: [] });
  const dir = await mkdtemp(join(tmpdir(), "standup-resolutions-"));
  cleanupDirs.push(dir);
  const sync = new KnowledgeSync(store.db, dir, null);
  return { store, id, sync, dir };
}

describe("GET /api/projects/:id/knowledge/resolutions", () => {
  test("lists resolutions, and ?status=needs_review narrows to the review queue", async () => {
    const { store, id, sync, dir } = await setup();
    createKnowledgeResolution(store.db, {
      id: "applied-1",
      projectId: id,
      winnerSlug: "a",
      loserSlug: "b",
      type: "supersede",
      status: "applied",
      autoApplied: true,
      rationale: "auto",
      detail: JSON.stringify({ reason: "low-confidence" }),
    });
    createKnowledgeResolution(store.db, {
      id: "pending-1",
      projectId: id,
      winnerSlug: "c",
      loserSlug: "d",
      type: "supersede",
      status: "needs_review",
      autoApplied: false,
      rationale: "owner claim",
      detail: JSON.stringify({ reason: "owner" }),
    });

    const app = createServer(store, () => {}, null, sync, undefined, dir);

    const all = (await (await app.request(`/api/projects/${id}/knowledge/resolutions`)).json()) as Array<{
      id: string;
      detail?: string;
    }>;
    expect(all.map((r) => r.id).sort()).toEqual(["applied-1", "pending-1"]);
    // The proposal detail is surfaced, not swallowed.
    expect(all.find((r) => r.id === "pending-1")!.detail).toContain("owner");

    const pending = (await (
      await app.request(`/api/projects/${id}/knowledge/resolutions?status=needs_review`)
    ).json()) as Array<{ id: string }>;
    expect(pending.map((r) => r.id)).toEqual(["pending-1"]);

    store.close();
  });
});

describe("POST /api/projects/:id/knowledge/resolutions/:rid/accept", () => {
  test("applies a withheld supersede: loser tombstoned, winner edge cleared, row marked applied", async () => {
    const { store, id, sync, dir } = await setup();
    // Two accepted docs on disk, indexed, and flagged as a live contradiction.
    await writeKnowledgeFile(dir, id, { slug: "keep", title: "Keep", body: "the winner" });
    await writeKnowledgeFile(dir, id, { slug: "drop", title: "Drop", body: "the loser" });
    await sync.syncProject(id);
    sync.recordDocVerdict(id, "keep", "contradicted", [
      { claim: "Contradicts drop", finding: "opp", evidence: "e" },
    ]);
    sync.recordDocVerdict(id, "drop", "contradicted", [
      { claim: "Contradicts keep", finding: "opp", evidence: "e" },
    ]);

    // The resolver withheld this (pretend the loser was owner-authored).
    createKnowledgeResolution(store.db, {
      id: "rid-1",
      projectId: id,
      winnerSlug: "keep",
      loserSlug: "drop",
      type: "supersede",
      status: "needs_review",
      autoApplied: false,
      rationale: "keep reflects current code",
      detail: JSON.stringify({ reason: "owner claim" }),
    });

    const app = createServer(store, () => {}, null, sync, undefined, dir);
    const res = await app.request(`/api/projects/${id}/knowledge/resolutions/rid-1/accept`, {
      method: "POST",
    });
    expect(res.status).toBe(200);

    const knowledgeStore = new KnowledgeStore(store.db);
    // Loser is tombstoned.
    expect(knowledgeStore.getDoc(id, "drop")!.verdict).toBe("superseded");
    // Winner's contradiction edge cleared → re-admitted.
    expect(knowledgeStore.getDoc(id, "keep")!.verdict ?? null).toBeNull();
    // The ledger row is now applied (and no longer pending).
    expect(getKnowledgeResolution(store.db, "rid-1")!.status).toBe("applied");

    store.close();
  });

  test("404 for an unknown id, 409 for an already-applied row", async () => {
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

    expect((await app.request(`/api/projects/${id}/knowledge/resolutions/nope/accept`, { method: "POST" })).status).toBe(404);
    expect((await app.request(`/api/projects/${id}/knowledge/resolutions/already/accept`, { method: "POST" })).status).toBe(409);

    store.close();
  });
});
