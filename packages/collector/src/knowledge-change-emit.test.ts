import { expect, test, describe, afterAll } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import {
  createStore,
  upsertProject,
  getRecentKnowledgeChanges,
} from "@standup/store";
import type { Store } from "@standup/store";
import type { WsMessage } from "@standup/shared";
import { makeKnowledgeChangeEmitter } from "./knowledge-change-emit.js";
import { KnowledgeSync } from "./knowledge-sync.js";

const cleanupDirs: string[] = [];
afterAll(async () => {
  for (const dir of cleanupDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

// Constructing a KnowledgeSync creates the knowledge corpus schema, exactly as
// the running collector does.
async function setUp(id: string): Promise<Store> {
  const store = createStore(":memory:");
  upsertProject(store.db, { id, name: "KC Emit Test", branch: "main", repos: [] });
  const knowledgeDir = await mkdtemp(join(tmpdir(), "standup-kc-emit-"));
  cleanupDirs.push(knowledgeDir);
  new KnowledgeSync(store.db, knowledgeDir, null);
  return store;
}

/**
 * The single choke point every knowledge:change emit routes through — the
 * request-handling server AND the entrypoint crons (distill, knowledge-reverify)
 * use this exact factory. The guard here is durability: a change must persist
 * BEFORE it broadcasts, so a cron firing unattended (a reverify contradiction
 * with no client connected) survives a reload/reconnect via the ledger
 * instead of living only on the wire. Before the fix, the
 * cron twin only broadcast — these assertions would have found nothing.
 */
describe("makeKnowledgeChangeEmitter — cron emit paths are durable", () => {
  function projectId(): string {
    return `kc-emit-test-${randomUUID().slice(0, 8)}`;
  }

  test("a 'distilled' change (distill cron) lands in the ledger", async () => {
    const id = projectId();
    const store = await setUp(id);
    const broadcasts: WsMessage[] = [];
    const emit = makeKnowledgeChangeEmitter(store.db, (m) => broadcasts.push(m));

    emit("distilled", id, "gotchas", "Gotchas");

    // Broadcast still fires — the live feed leg is unchanged.
    const frame = broadcasts.find((m) => m.type === "knowledge:change");
    expect(frame).toBeDefined();
    expect((frame!.payload as { kind?: string }).kind).toBe("distilled");

    // And it is durable: the ledger the seq-gap resync re-reads holds it.
    const ledger = getRecentKnowledgeChanges(store.db);
    expect(ledger.some((c) => c.kind === "distilled" && c.slug === "gotchas")).toBe(true);

    store.close();
  });

  test("a 'contradiction' change (reverify cron) lands in the ledger, with the contradicted set", async () => {
    const id = projectId();
    const store = await setUp(id);
    const broadcasts: WsMessage[] = [];
    const emit = makeKnowledgeChangeEmitter(store.db, (m) => broadcasts.push(m));

    emit("contradiction", id, "auth-flow", "Auth flow", {
      contradicted: ["token-refresh"],
    });

    const ledger = getRecentKnowledgeChanges(store.db);
    const change = ledger.find((c) => c.kind === "contradiction" && c.slug === "auth-flow");
    expect(change).toBeDefined();
    expect(change!.contradicted).toEqual(["token-refresh"]);

    store.close();
  });
});
