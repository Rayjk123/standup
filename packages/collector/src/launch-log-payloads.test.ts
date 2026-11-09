import { expect, test, describe, afterAll } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { appendLaunchLog, createLaunch, createStore, upsertProject } from "@standup/store";
import type { Launch } from "@standup/shared";
import { buildSnapshot, createServer } from "./server.js";
import { KnowledgeSync } from "./knowledge-sync.js";

const cleanupDirs: string[] = [];
afterAll(async () => {
  for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
});

/**
 * A launch's build log runs to tens of KB, so it stays out of the payloads the
 * console boots from (the hello-ok snapshot and the launch list) and is read
 * per launch, the way LaunchProgress polls it.
 */
describe("launch logs in the boot payloads", () => {
  async function setUp() {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
    const knowledgeDir = await mkdtemp(join(tmpdir(), "standup-launch-log-"));
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    for (const id of ["L1", "L2"]) {
      createLaunch(store.db, { id, projectId: "p", task: `task ${id}`, worktreePath: `/tmp/${id}`, branch: id, provisioned: true });
      appendLaunchLog(store.db, id, `building ${id}\n`.repeat(2000));
    }
    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    return { store, app };
  }

  test("the hello-ok snapshot's launches carry no log", async () => {
    const { store } = await setUp();
    const snapshot = await buildSnapshot(store);
    expect(snapshot.launches.map((l) => l.id).sort()).toEqual(["L1", "L2"]);
    expect(snapshot.launches.every((l) => l.log === undefined)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("building L1");
    store.close();
  });

  test("GET /api/launches leaves the log out and GET /api/launches/:id has it", async () => {
    const { store, app } = await setUp();
    const listRes = await app.request("/api/launches");
    expect(listRes.status).toBe(200);
    const text = await listRes.text();
    expect(text).not.toContain("building");
    const list = JSON.parse(text) as Launch[];
    expect(list.map((l) => l.task).sort()).toEqual(["task L1", "task L2"]);

    const oneRes = await app.request("/api/launches/L1");
    expect(oneRes.status).toBe(200);
    const one = (await oneRes.json()) as Launch;
    expect(one.log).toBe("building L1\n".repeat(2000));
    store.close();
  });
});
