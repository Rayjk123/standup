import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createStore, upsertProject } from "@standup/store";
import type { Store } from "@standup/store";
import type { ProjectWithCounts, WsMessage } from "@standup/shared";
import { OWNER_TOKEN_HEADER } from "@standup/shared/owner-token";
import { createServer } from "./server.js";
import { KnowledgeSync } from "./knowledge-sync.js";
import { generateOwnerSecrets } from "./owner-secret.js";

/**
 * The console replaces its project list with a projects:updated payload, so the
 * frame must carry the same computed counts as GET /api/projects: without them
 * every sidebar's knowledge-doc badge vanishes on any project edit.
 */

let root: string;
let store: Store;
let knowledgeSync: KnowledgeSync;
const savedHome = process.env.HOME;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "projects-broadcast-"));
  process.env.HOME = join(root, "home");
  mkdirSync(process.env.HOME);
  mkdirSync(join(root, "repo"));
  mkdirSync(join(root, "knowledge", "proj"), { recursive: true });
  for (const slug of ["a", "b"]) writeFileSync(join(root, "knowledge", "proj", `${slug}.md`), `# Doc ${slug}\n\nBody ${slug}.\n`);
  store = createStore(":memory:");
  knowledgeSync = new KnowledgeSync(store.db, join(root, "knowledge"), null);
  upsertProject(store.db, { id: "proj", name: "proj", branch: "main", repos: [join(root, "repo")] });
  await knowledgeSync.syncProject("proj");
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("a project edit broadcasts the list with its knowledge-doc counts", async () => {
  const frames: WsMessage[] = [];
  const secrets = generateOwnerSecrets();
  const app = createServer(store, (m) => frames.push(m), null, knowledgeSync, undefined, join(root, "knowledge"), "", {}, undefined, undefined, undefined, undefined, {
    ownerSecrets: secrets,
  });
  const res = await app.request("/api/projects/proj", {
    method: "PATCH",
    headers: { "content-type": "application/json", [OWNER_TOKEN_HEADER]: secrets.ownerToken },
    body: JSON.stringify({ name: "Renamed" }),
  });
  expect(res.status).toBe(200);
  const frame = frames.find((f) => f.type === "projects:updated");
  expect(frame).toBeDefined();
  const project = (frame!.payload as ProjectWithCounts[]).find((p) => p.id === "proj")!;
  expect(project.name).toBe("Renamed");
  expect(project.knowledgeDocs).toBe(2);
  expect(project.pendingDrafts).toBe(0);
  const listed = (await (await app.request("/api/projects")).json()) as ProjectWithCounts[];
  expect(frame!.payload).toEqual(listed);
});
