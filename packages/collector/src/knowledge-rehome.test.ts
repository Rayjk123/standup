import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  DISPUTED_RANK_WEIGHT,
  KnowledgeStore,
  compileGraph,
  isVerdictAdmissible,
  searchKnowledge,
  trustMultiplier,
} from "@standup/knowledge";
import { createSession, createStore, getSession, upsertProject } from "@standup/store";
import type { Store } from "@standup/store";
import { rehomeSessionKnowledge } from "./knowledge-rehome.js";
import { KnowledgeSync } from "./knowledge-sync.js";
import { resetSessionProjectCaches, resolveSessionProject } from "./session-project.js";

const PROJECT = "billing-platform";
const OTHER = "other-project";

let dir: string;
let store: Store;
let sync: KnowledgeSync;

function docFile(title: string, frontmatter: Record<string, string>): string {
  const lines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`);
  return `---\ntitle: ${title}\n${lines.join("\n")}\n---\n${title} body\n`;
}

async function writeDoc(projectId: string, slug: string, contents: string): Promise<string> {
  await mkdir(join(dir, projectId), { recursive: true });
  const path = join(dir, projectId, `${slug}.md`);
  await writeFile(path, contents);
  return path;
}

function docPath(projectId: string, slug: string): string {
  return join(dir, projectId, `${slug}.md`);
}

beforeEach(async () => {
  resetSessionProjectCaches();
  dir = await mkdtemp(join(tmpdir(), "standup-knowledge-rehome-"));
  store = createStore(":memory:");
  upsertProject(store.db, { id: "scratch", name: "scratch", branch: "main", repos: [] });
  upsertProject(store.db, { id: PROJECT, name: "Billing Platform", branch: "main", repos: [join(dir, "repo")] });
  upsertProject(store.db, { id: OTHER, name: "Other", branch: "main", repos: [] });
  sync = new KnowledgeSync(store.db, dir, null);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("rehomeSessionKnowledge", () => {
  test("moves a scratch doc the session or its child authored, file and index included, scope kept", async () => {
    createSession(store.db, { id: "s1", projectId: PROJECT, title: "s1", cwd: dir, status: "running" });
    createSession(store.db, {
      id: "s1-child",
      projectId: PROJECT,
      title: "child",
      cwd: dir,
      status: "running",
      parentSessionId: "s1",
    });
    const own = docFile("Own", { source_session_id: "s1", origin_class: "agent", scope: "global" });
    await writeDoc("scratch", "own-doc", own);
    await writeDoc("scratch", "child-doc", docFile("Child", { source_session_id: "s1-child", origin_class: "agent" }));
    await sync.syncAll();

    const result = await rehomeSessionKnowledge(store.db, dir, ["s1"], PROJECT, sync);

    expect(result.moved.sort()).toEqual(["child-doc", "own-doc"]);
    expect(result.collisions).toEqual([]);
    expect(existsSync(docPath("scratch", "own-doc"))).toBe(false);
    expect(readFileSync(docPath(PROJECT, "own-doc"), "utf-8")).toBe(own);
    expect(existsSync(docPath(PROJECT, "child-doc"))).toBe(true);
    const index = new KnowledgeStore(store.db);
    expect(index.getDoc("scratch", "own-doc")).toBeNull();
    const moved = index.getDoc(PROJECT, "own-doc");
    expect(moved?.scope).toBe("global");
    expect(moved?.sourceSessionId).toBe("s1");
  });

  test("leaves a scratch doc another session wrote where it is", async () => {
    createSession(store.db, { id: "s1", projectId: PROJECT, title: "s1", cwd: dir, status: "running" });
    await writeDoc("scratch", "foreign", docFile("Foreign", { source_session_id: "someone-else" }));
    await writeDoc("scratch", "unattributed", docFile("Unattributed", {}));

    const result = await rehomeSessionKnowledge(store.db, dir, ["s1"], PROJECT, sync);

    expect(result.moved).toEqual([]);
    expect(existsSync(docPath("scratch", "foreign"))).toBe(true);
    expect(existsSync(docPath("scratch", "unattributed"))).toBe(true);
    expect(existsSync(docPath(PROJECT, "foreign"))).toBe(false);
  });

  test("a slug the target already holds is left in scratch and the target doc is untouched", async () => {
    createSession(store.db, { id: "s1", projectId: PROJECT, title: "s1", cwd: dir, status: "running" });
    const scratchDoc = docFile("Scratch copy", { source_session_id: "s1" });
    const existing = docFile("Project original", { origin_class: "owner" });
    await writeDoc("scratch", "shared-slug", scratchDoc);
    await writeDoc(PROJECT, "shared-slug", existing);

    const result = await rehomeSessionKnowledge(store.db, dir, ["s1"], PROJECT, sync);

    expect(result.moved).toEqual([]);
    expect(result.collisions).toEqual(["shared-slug"]);
    expect(readFileSync(docPath(PROJECT, "shared-slug"), "utf-8")).toBe(existing);
    expect(readFileSync(docPath("scratch", "shared-slug"), "utf-8")).toBe(scratchDoc);
  });

  test("moves nothing between two real projects or into scratch", async () => {
    createSession(store.db, { id: "s1", projectId: OTHER, title: "s1", cwd: dir, status: "running" });
    await writeDoc(OTHER, "real-doc", docFile("Real", { source_session_id: "s1" }));
    await writeDoc("scratch", "scratch-doc", docFile("Scratch", { source_session_id: "s1" }));

    // A session already homed in a real project is never re-homed, so no move is reported.
    const notified: string[] = [];
    const resolution = resolveSessionProject(store.db, "s1", {
      paths: [join(dir, "repo")],
      onRehomed: (id) => notified.push(id),
    });
    expect(resolution).toEqual({ projectId: OTHER, moved: false });
    expect(notified).toEqual([]);

    // Called directly, the only source is ever scratch: OTHER's doc never moves.
    const intoProject = await rehomeSessionKnowledge(store.db, dir, ["s1"], PROJECT, sync);
    expect(intoProject.moved).toEqual(["scratch-doc"]);
    expect(existsSync(docPath(OTHER, "real-doc"))).toBe(true);
    expect(existsSync(docPath(PROJECT, "real-doc"))).toBe(false);

    const intoScratch = await rehomeSessionKnowledge(store.db, dir, ["s1"], "scratch", sync);
    expect(intoScratch.moved).toEqual([]);
  });

  test("a disputed scratch doc keeps its verdict and fact-check state, so it stays demoted and marked", async () => {
    createSession(store.db, { id: "s1", projectId: PROJECT, title: "s1", cwd: dir, status: "running" });
    await writeDoc(
      "scratch",
      "flaky-claim",
      docFile("Flaky claim about rollout widgets", { source_session_id: "s1", origin_class: "agent" })
    );
    await sync.syncAll();
    const index = new KnowledgeStore(store.db);
    const before = index.getDoc("scratch", "flaky-claim");
    const dispute = { claim: "widgets roll out hourly", finding: "they roll out daily", evidence: "rg rollout" };
    index.setDocVerdict("scratch", "flaky-claim", "disputed", [dispute], "/checkout/repo");
    store.db.run(
      `INSERT INTO knowledge_verifications (id, project_id, slug, body_hash, attempts, repo_path, last_outcome)
       VALUES (?, 'scratch', 'flaky-claim', 'h', 2, '/checkout/repo', 'disputed')`,
      ["scratch/flaky-claim"]
    );

    const result = await rehomeSessionKnowledge(store.db, dir, ["s1"], PROJECT, sync);

    expect(result.moved).toEqual(["flaky-claim"]);
    expect(index.getDoc("scratch", "flaky-claim")).toBeNull();
    const moved = index.getDoc(PROJECT, "flaky-claim");
    expect(moved?.id).toBe(before!.id);
    expect(moved?.verdict).toBe("disputed");
    expect(moved?.disputes).toEqual([dispute]);
    expect(index.getDocVerdictRepo(PROJECT, "flaky-claim")).toBe("/checkout/repo");
    expect(trustMultiplier(moved!)).toBeCloseTo(DISPUTED_RANK_WEIGHT, 10);
    const verification = store.db
      .query("SELECT id, project_id, attempts FROM knowledge_verifications WHERE slug = 'flaky-claim'")
      .all();
    expect(verification).toEqual([{ id: `${PROJECT}/flaky-claim`, project_id: PROJECT, attempts: 2 }]);

    const hits = await searchKnowledge(store.db, PROJECT, "flaky claim rollout widgets", null);
    for (const hit of hits.filter((h) => h.slug === "flaky-claim")) {
      expect(hit.verdict).toBe("disputed");
      expect(trustMultiplier(hit)).toBeCloseTo(DISPUTED_RANK_WEIGHT, 10);
    }
  });

  test("a contradicted doc keeps its verdict, judgments and contradiction edges", async () => {
    createSession(store.db, { id: "s1", projectId: PROJECT, title: "s1", cwd: dir, status: "running" });
    await writeDoc("scratch", "cache-ttl", docFile("Cache TTL", { source_session_id: "s1", origin_class: "agent" }));
    await writeDoc("scratch", "cache-rule", docFile("Cache rule", { source_session_id: "other", origin_class: "agent" }));
    // A same-slug doc in the target that a bare `cache-rule` target would resolve to after the move.
    await writeDoc(PROJECT, "cache-rule", docFile("Unrelated rule", { origin_class: "owner" }));
    await sync.syncAll();
    const index = new KnowledgeStore(store.db);
    const contradicts = (target: string) => [{ claim: `Contradicts ${target}`, finding: "conflict", evidence: "judge" }];
    index.setDocVerdict("scratch", "cache-ttl", "contradicted", contradicts("cache-rule"));
    index.setDocVerdict("scratch", "cache-rule", "contradicted", contradicts("cache-ttl"));
    store.db.run(
      `INSERT INTO knowledge_judgments (id, project_id, subject_slug, candidate_project_id, candidate_slug, outcome)
       VALUES ('j1', 'scratch', 'cache-ttl', 'scratch', 'cache-rule', 'contradicts'),
              ('j2', 'scratch', 'cache-rule', 'scratch', 'cache-ttl', 'contradicts')`
    );
    const ttlId = index.getDoc("scratch", "cache-ttl")!.id;
    const ruleId = index.getDoc("scratch", "cache-rule")!.id;
    const contradictionPairs = () =>
      compileGraph(index)
        .filter((e) => e.kind === "contradicts")
        .map((e) => `${e.srcDocId}->${e.dstDocId}`)
        .sort();
    const pairsBefore = contradictionPairs();
    expect(pairsBefore).toEqual([`${ruleId}->${ttlId}`, `${ttlId}->${ruleId}`].sort());

    const result = await rehomeSessionKnowledge(store.db, dir, ["s1"], PROJECT, sync);

    expect(result.moved).toEqual(["cache-ttl"]);
    const moved = index.getDoc(PROJECT, "cache-ttl");
    expect(moved?.id).toBe(ttlId);
    expect(moved?.verdict).toBe("contradicted");
    expect(moved?.disputes?.[0]?.claim).toBe("Contradicts scratch/cache-rule");
    expect(index.getDoc("scratch", "cache-rule")?.disputes?.[0]?.claim).toBe(`Contradicts ${PROJECT}/cache-ttl`);
    expect(contradictionPairs()).toEqual(pairsBefore);
    const judgments = store.db
      .query("SELECT id, project_id, candidate_project_id FROM knowledge_judgments ORDER BY id")
      .all();
    expect(judgments).toEqual([
      { id: "j1", project_id: PROJECT, candidate_project_id: "scratch" },
      { id: "j2", project_id: "scratch", candidate_project_id: PROJECT },
    ]);
  });

  test("a clean doc stays clean", async () => {
    createSession(store.db, { id: "s1", projectId: PROJECT, title: "s1", cwd: dir, status: "running" });
    await writeDoc("scratch", "clean-doc", docFile("Clean", { source_session_id: "s1", origin_class: "agent" }));
    await sync.syncAll();

    const result = await rehomeSessionKnowledge(store.db, dir, ["s1"], PROJECT, sync);

    expect(result.moved).toEqual(["clean-doc"]);
    const index = new KnowledgeStore(store.db);
    const moved = index.getDoc(PROJECT, "clean-doc");
    expect(moved?.verdict).toBeUndefined();
    expect(moved?.disputes).toBeUndefined();
    expect(index.getDocVerdictRepo(PROJECT, "clean-doc")).toBeNull();
    expect(isVerdictAdmissible(moved!, "inject")).toBe(true);
  });

  test("a doc whose state cannot be re-homed stays in scratch with its verdict", async () => {
    createSession(store.db, { id: "s1", projectId: PROJECT, title: "s1", cwd: dir, status: "running" });
    const contents = docFile("Stuck", { source_session_id: "s1", origin_class: "agent" });
    await writeDoc("scratch", "stuck-doc", contents);
    await sync.syncAll();
    const index = new KnowledgeStore(store.db);
    index.setDocVerdict("scratch", "stuck-doc", "disputed", [{ claim: "c", finding: "f", evidence: "e" }]);
    store.db.exec(
      `CREATE TRIGGER block_rehome BEFORE UPDATE OF project_id ON knowledge
       BEGIN SELECT RAISE(ABORT, 'blocked'); END`
    );

    const result = await rehomeSessionKnowledge(store.db, dir, ["s1"], PROJECT, sync);

    expect(result.moved).toEqual([]);
    expect(result.failed).toEqual(["stuck-doc"]);
    expect(existsSync(docPath(PROJECT, "stuck-doc"))).toBe(false);
    expect(readFileSync(docPath("scratch", "stuck-doc"), "utf-8")).toBe(contents);
    expect(index.getDoc(PROJECT, "stuck-doc")).toBeNull();
    expect(index.getDoc("scratch", "stuck-doc")?.verdict).toBe("disputed");
  });

  test("a scratch session resolved to a project reports itself to onRehomed", async () => {
    await mkdir(join(dir, "repo"), { recursive: true });
    createSession(store.db, { id: "s2", projectId: "scratch", title: "s2", cwd: dir, status: "running" });
    await writeDoc("scratch", "s2-doc", docFile("S2", { source_session_id: "s2" }));

    const notified: Array<[string, string]> = [];
    const resolution = resolveSessionProject(store.db, "s2", {
      paths: [join(dir, "repo")],
      transcript: false,
      eventCwds: false,
      onRehomed: (id, projectId) => notified.push([id, projectId]),
    });
    expect(resolution).toEqual({ projectId: PROJECT, moved: true });
    expect(getSession(store.db, "s2")?.projectId).toBe(PROJECT);
    expect(notified).toEqual([["s2", PROJECT]]);

    const result = await rehomeSessionKnowledge(store.db, dir, ["s2"], PROJECT, sync);
    expect(result.moved).toEqual(["s2-doc"]);
    expect(existsSync(docPath(PROJECT, "s2-doc"))).toBe(true);
  });
});
