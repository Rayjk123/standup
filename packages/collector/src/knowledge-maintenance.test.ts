import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { join, relative } from "path";
import { createStore, getSetting, setSetting, upsertProject, type Store } from "@standup/store";
import { DISPUTED_CONFIDENCE, EVIDENCE_CONFIDENCE_CAPS, KnowledgeStore, type KnowledgeDoc } from "@standup/knowledge";
import type { DraftDispute } from "./draft-verify.js";
import { UNDECIDED_BASIS, contradictionDispute } from "./knowledge-coherence.js";
import {
  MAX_REVERIFY_ATTEMPTS,
  readProjectFreshness,
  readProjectReverifyAttempts,
  recordReverifyAttempt,
  replaceProjectFreshness,
} from "./knowledge-freshness.js";
import {
  MAINTENANCE_ENV,
  MAINTENANCE_JUDGE_ENV,
  MAINTENANCE_VERSION,
  STEP_INCOMPLETE_KEY,
  completedMaintenanceSteps,
  edgeCountsByKind,
  syncCorpusThenMaintain,
  maintenanceJudgeEnabled,
  maintenanceRunOf,
  markReverifyDue,
  runKnowledgeMaintenance,
  type KnowledgeMaintenanceDeps,
  type KnowledgeMaintenanceResult,
  type MaintenanceCounts,
} from "./knowledge-maintenance.js";
import { readLandedClaims } from "./knowledge-repo-claims.js";
import { lastRunKey } from "./knowledge-reverify.js";
import { NIGHTLY_SWEEP_ENV, NIGHTLY_SWEEP_SETTING_KEY } from "./knowledge-graph-audit.js";

/**
 * The maintenance routine proven on a scratch copy built from fixtures: a
 * file-backed store, knowledge dir and git repo, all under one /tmp root.
 * The fixture reproduces each problem the routine repairs — standup-self
 * copies of standup docs, a "not yet merged" claim whose branch landed as a
 * rebased copy, both-sides dispute ties and a dispute refuted by its own
 * quote, and `[[slug]]` / same-session docs the persisted graph lacks.
 */

const SCRATCH_PARENT = "/tmp";
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const CHUNKING =
  "The chunker splits a doc body into pieces of about 512 characters and neighbouring chunks overlap by ten words.";
const ROADMAP_A =
  "Roadmap October to February: persona orchestration, knowledge push hooks, reranker provider, mirror collapse, review drafts.";
const ROADMAP_B =
  "Roadmap October to February: persona orchestration, knowledge push hooks, reranker provider, mirror collapse, review queue.";

let clock = Date.parse("2026-09-01T00:00:00Z");

function git(dir: string, ...args: string[]): string {
  const iso = new Date(clock).toISOString();
  const res = Bun.spawnSync(["git", ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
  });
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
  return res.stdout.toString().trim();
}

function commit(dir: string, path: string, text: string, message: string): string {
  clock += 3_600_000;
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), text);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

/** main ← base; `feature/x` adds src/x.ts in two commits that land on main as cherry-picks, and the branch is deleted. */
function landedRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "T");
  git(dir, "config", "commit.gpgsign", "false");
  commit(dir, "README.md", "repo\n", "base");
  git(dir, "checkout", "-q", "-b", "feature/x");
  const first = commit(dir, "src/x.ts", "export function parseThing() {\n  return 1;\n}\n", "Add parseThing");
  const tip = commit(dir, "src/x.ts", "export function parseThing() {\n  return 2;\n}\n", "Tune parseThing");
  git(dir, "checkout", "-q", "main");
  commit(dir, "docs/notes.md", "notes\n", "Unrelated main work");
  clock += 3_600_000;
  git(dir, "cherry-pick", first, tip);
  git(dir, "branch", "-D", "feature/x");
  return tip;
}

interface Scratch {
  root: string;
  dbPath: string;
  knowledgeDir: string;
  repoDir: string;
  store: Store;
  knowledge: KnowledgeStore;
}

const cite = (claim: string, quote: string, file: string): DraftDispute => ({
  kind: "contradicted",
  claim,
  finding: "differs",
  evidence: "rg",
  citations: [{ file, line: 3, quote }],
});

const tieDispute = (other: string) => contradictionDispute(other, "they disagree", UNDECIDED_BASIS);

function buildScratch(): Scratch {
  const root = mkdtempSync(join(SCRATCH_PARENT, "kb-maint-test-"));
  roots.push(root);
  const dbPath = join(root, "standup.db");
  const knowledgeDir = join(root, "knowledge");
  const repoDir = join(root, "repo");
  const tip = landedRepo(repoDir);
  const store = createStore(dbPath);
  upsertProject(store.db, { id: "standup", name: "Standup", branch: "main", repos: [repoDir] });
  const knowledge = new KnowledgeStore(store.db);

  const put = (d: Partial<KnowledgeDoc> & { slug: string; body: string }, file?: string): void => {
    const projectId = d.projectId ?? "standup";
    const filePath = join(knowledgeDir, projectId, `${d.slug}.md`);
    knowledge.upsertDoc({
      id: `${projectId}/${d.slug}`,
      projectId,
      title: d.slug,
      updatedAt: new Date("2026-09-01T00:00:00Z"),
      filePath,
      originClass: "owner",
      ...d,
    });
    if (file !== undefined) {
      mkdirSync(join(knowledgeDir, projectId), { recursive: true });
      writeFileSync(filePath, file);
    }
  };
  const file = (title: string, body: string) => `---\ntitle: ${title}\nconfidence: 0.9\n---\n${body}\n`;

  // Mirror copies: one verbatim, one with no canonical counterpart.
  put({ slug: "chunking-strategy", title: "Chunking", body: CHUNKING }, file("Chunking", CHUNKING));
  put({ projectId: "standup-self", slug: "chunking-strategy", title: "Chunking", body: `${CHUNKING}\n` }, file("Chunking", CHUNKING));
  put({ projectId: "standup-self", slug: "self-only", title: "Self only", body: "Only in the mirror project." });
  // A near-duplicate pair inside one project: merged only through a review draft.
  put({ slug: "roadmap-oct-feb", title: "Roadmap", body: ROADMAP_A });
  put({ slug: "product-roadmap", title: "Roadmap", body: ROADMAP_B, originClass: "agent" });
  // A not-merged claim whose branch landed as a rebased copy, with the stale finding it caps.
  put({
    slug: "parser",
    title: "Parser",
    body: "`parseThing` in src/x.ts is on branch `feature/x`, not yet merged.",
    generatedFromSha: tip,
    sourceKind: "code",
  });
  replaceProjectFreshness(
    store.db,
    "standup",
    [{ slug: "parser", cap: EVIDENCE_CONFIDENCE_CAPS.unmerged, findings: [{ kind: "unmerged", detail: "stale" }] }],
    "2026-09-01T00:00:00.000Z"
  );
  // Dispute labels: a both-sides tie, a dispute its own quote refutes, and a real one.
  const graphFile = join(repoDir, "src", "graph.ts");
  put({ slug: "tie-a", body: "Slack posts retry three times before the message is dropped." });
  put({ slug: "tie-b", body: "Slack posts retry five times with jittered backoff." });
  put({ slug: "refuted", body: "CO_CITATION_FANOUT is six in the graph compiler." });
  put({
    slug: "real",
    body: "CO_CITATION_FANOUT is six, which caps shared-tag edges per doc.",
    lastVerifiedAt: "2026-09-30T00:00:00.000Z",
  });
  knowledge.setDocVerdict("standup", "tie-a", "disputed", [tieDispute("tie-b")]);
  knowledge.setDocVerdict("standup", "tie-b", "disputed", [tieDispute("tie-a")]);
  knowledge.setDocVerdict("standup", "refuted", "disputed", [
    cite("CO_CITATION_FANOUT = 6", "const CO_CITATION_FANOUT = 6;", graphFile),
  ]);
  knowledge.setDocVerdict("standup", "real", "disputed", [
    cite("CO_CITATION_FANOUT = 6", "const CO_CITATION_FANOUT = 9;", graphFile),
  ]);
  recordReverifyAttempt(store.db, "standup", "real", "x", "error", "2026-10-09T00:00:00.000Z");
  setSetting(store.db, lastRunKey("standup"), "2026-10-10");
  // Graph: a body wikilink and two docs from one authoring session.
  put({ slug: "wiki-a", body: "The injection gate reads the push budget; see [[wiki-b]] for the hook side." });
  put({ slug: "wiki-b", body: "Session-start hooks push at most three docs into context." });
  put({ slug: "session-one", body: "The digest cron posts once a day at nine.", sourceSessionId: "sess-1" });
  put({ slug: "session-two", body: "The reaper sweeps dead panes every minute.", sourceSessionId: "sess-1" });
  // The graph an earlier compile persisted: one co-citation edge, no wikilink or provenance edges.
  knowledge.replaceAllEdges([
    { id: "old", srcDocId: "standup/tie-a", dstDocId: "standup/tie-b", kind: "co-citation", weight: 0.5, evidence: "shared tags: slack" },
  ]);
  return { root, dbPath, knowledgeDir, repoDir, store, knowledge };
}

/** Every file under `dir`: relative path → content hash. The SQLite shared-memory lock index is left out (readers write it). */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (!p.endsWith("-shm")) out.set(relative(dir, p), Bun.hash(readFileSync(p)).toString(16));
    }
  };
  walk(dir);
  return out;
}

/** Paths whose content differs between two snapshots, or that exist in only one. */
function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].filter((k) => before.get(k) !== after.get(k)).sort();
}

interface Problems {
  mirrorCopiesLive: number;
  landedRecords: number;
  unmergedFindings: number;
  disputedDocs: number;
  disputedTies: number;
  edges: Record<string, number>;
}

function problems(s: Scratch): Problems {
  const count = (sql: string) => (s.store.db.query(sql).get() as { n: number }).n;
  return {
    mirrorCopiesLive: count(
      "SELECT COUNT(*) AS n FROM knowledge WHERE project_id = 'standup-self' AND (verdict IS NULL OR verdict != 'superseded')"
    ),
    landedRecords: readLandedClaims(s.store.db, "standup").size,
    unmergedFindings: [...readProjectFreshness(s.store.db, "standup").values()].reduce(
      (n, r) => n + r.findings.filter((f) => f.kind === "unmerged").length,
      0
    ),
    disputedDocs: count("SELECT COUNT(*) AS n FROM knowledge WHERE verdict = 'disputed'"),
    disputedTies: count(
      `SELECT COUNT(*) AS n FROM knowledge WHERE verdict = 'disputed' AND disputes_json LIKE '%${UNDECIDED_BASIS.replace(/'/g, "''")}%'`
    ),
    edges: edgeCountsByKind(s.store.db),
  };
}

function stepCounts(result: KnowledgeMaintenanceResult): Record<string, MaintenanceCounts | undefined> {
  return Object.fromEntries(result.steps.map((st) => [st.name, st.counts]));
}

function deps(s: Scratch, extra: Partial<KnowledgeMaintenanceDeps> = {}): KnowledgeMaintenanceDeps {
  return { db: s.store.db, knowledgeDir: s.knowledgeDir, env: {}, log: () => {}, ...extra };
}

describe("runKnowledgeMaintenance on a fixture scratch copy", () => {
  test("the test's own scratch tree is under /tmp", () => {
    const s = buildScratch();
    for (const p of [s.root, s.dbPath, s.knowledgeDir, s.repoDir, s.store.db.filename]) expect(p.startsWith(`${SCRATCH_PARENT}/`)).toBe(true);
    s.store.close();
  });

  test("dry run, real run, re-run: before/after counts, nothing outside the scratch tree, idempotent", async () => {
    const s = buildScratch();
    const before = problems(s);
    const filesBefore = snapshot(s.root);
    const headBefore = git(s.repoDir, "rev-parse", "HEAD");

    // Dry run: the counts of a real run, and not one byte written.
    const dry = await runKnowledgeMaintenance(deps(s, { dryRun: true }));
    expect(dry).toMatchObject({ status: "ran", dryRun: true, recorded: false });
    expect(changedPaths(filesBefore, snapshot(s.root))).toEqual([]);
    expect(problems(s)).toEqual(before);
    expect(maintenanceRunOf(s.store.db, MAINTENANCE_VERSION)).toBeNull();

    const logs: string[] = [];
    const run = await runKnowledgeMaintenance(deps(s, { log: (l) => logs.push(l) }));
    expect(run).toMatchObject({ status: "ran", dryRun: false, recorded: true });
    expect(run.steps.map((st) => st.status)).toEqual(["ok", "ok", "ok", "ok"]);
    const counts = stepCounts(run);
    const dryCounts = stepCounts(dry);
    expect(counts.mirror).toMatchObject({ superseded: 1, kept: 1, filesPatched: 1, mergeDrafts: 1 });
    expect(dryCounts.mirror).toMatchObject({ superseded: 1, kept: 1, mergeDrafts: 1 });
    expect(counts.landed).toMatchObject({ checked: 1, landed: 1, drafts: 1, findingsCleared: 1 });
    expect(dryCounts.landed).toMatchObject({ checked: 1, landed: 1, drafts: 1, findingsCleared: 1 });
    expect(counts.disputes).toMatchObject({ refutedDisputes: 1, tiesConverted: 2, stillDisputed: 1, reverifyQueued: 1, reverifyMarked: 1 });
    expect(dryCounts.disputes).toEqual(counts.disputes!);
    expect(dryCounts.graph).toEqual(counts.graph!);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(`[knowledge-maintenance] v${MAINTENANCE_VERSION} ran: mirror ok superseded=1`);

    const after = problems(s);
    console.log(`[knowledge-maintenance proof] before ${JSON.stringify(before)}`);
    console.log(`[knowledge-maintenance proof] after  ${JSON.stringify(after)}`);
    console.log(`[knowledge-maintenance proof] steps  ${JSON.stringify(counts)}`);
    expect(before).toMatchObject({ mirrorCopiesLive: 2, landedRecords: 0, unmergedFindings: 1, disputedDocs: 4, disputedTies: 2 });
    expect(after).toMatchObject({ mirrorCopiesLive: 1, landedRecords: 1, unmergedFindings: 0, disputedDocs: 1, disputedTies: 0 });
    expect(before.edges).toEqual({ "co-citation": 1 });
    expect(after.edges.wikilink).toBe(1);
    expect(after.edges.provenance).toBe(1);
    expect(counts.graph).toEqual({ before: before.edges, after: after.edges });

    // The repaired rows and files.
    const copy = s.store.db
      .query("SELECT verdict, confidence FROM knowledge WHERE project_id = 'standup-self' AND slug = 'chunking-strategy'")
      .get() as { verdict: string; confidence: number };
    expect(copy).toEqual({ verdict: "superseded", confidence: DISPUTED_CONFIDENCE });
    expect(readFileSync(join(s.knowledgeDir, "standup-self", "chunking-strategy.md"), "utf-8")).toContain(
      `confidence: ${DISPUTED_CONFIDENCE}`
    );
    expect(readFileSync(join(s.knowledgeDir, "standup", ".drafts", "parser.md"), "utf-8")).not.toContain("not yet merged");
    const tie = s.store.db.query("SELECT verdict FROM knowledge WHERE slug = 'tie-a'").get() as { verdict: string };
    expect(tie.verdict).toBe("contradicted");
    const real = s.store.db.query("SELECT verdict, last_verified_at FROM knowledge WHERE slug = 'real'").get() as {
      verdict: string;
      last_verified_at: string | null;
    };
    expect(real).toEqual({ verdict: "disputed", last_verified_at: null });
    expect(readProjectReverifyAttempts(s.store.db, "standup").get("real")).toMatchObject({
      attempts: 1,
      lastAttemptAt: new Date(0).toISOString(),
    });
    expect(getSetting(s.store.db, lastRunKey("standup"))).toBeNull();
    // Near-duplicates are never retired, only drafted.
    const roadmaps = s.store.db.query("SELECT COUNT(*) AS n FROM knowledge WHERE slug LIKE '%roadmap%' AND verdict IS NULL").get() as {
      n: number;
    };
    expect(roadmaps.n).toBe(2);

    // Every write landed in the scratch knowledge dir or the scratch DB; the repo was only read.
    const written = changedPaths(filesBefore, snapshot(s.root));
    expect(written.length).toBeGreaterThan(0);
    for (const p of written) {
      expect(join(s.root, p).startsWith(`${s.root}/`)).toBe(true);
      expect(p.startsWith("knowledge/") || p.startsWith("standup.db")).toBe(true);
    }
    expect(written).toContain("knowledge/standup/.drafts/parser.md");
    expect(written).toContain("knowledge/standup/.drafts/roadmap-oct-feb.md");
    expect(written).toContain("knowledge/standup-self/chunking-strategy.md");
    expect(git(s.repoDir, "rev-parse", "HEAD")).toBe(headBefore);
    expect(git(s.repoDir, "status", "--porcelain")).toBe("");

    // Recorded: the next boot skips it.
    expect(maintenanceRunOf(s.store.db, MAINTENANCE_VERSION)?.counts).toMatchObject({ mirror: { superseded: 1 } });
    const filesAfter = snapshot(s.root);
    const again = await runKnowledgeMaintenance(deps(s));
    expect(again).toMatchObject({ status: "already-ran", steps: [], recorded: false });
    expect(changedPaths(filesAfter, snapshot(s.root))).toEqual([]);

    // Forced over its own output, every step finds nothing left to do.
    const knowledgeAfter = snapshot(s.knowledgeDir);
    const forced = stepCounts(await runKnowledgeMaintenance(deps(s, { force: true })));
    expect(forced.mirror).toMatchObject({ superseded: 0, alreadySuperseded: 1, filesPatched: 0, mergeDrafts: 0, mergeDraftsPending: 1 });
    expect(forced.landed).toMatchObject({ landed: 0, alreadyLanded: 1, drafts: 0, findingsCleared: 0 });
    expect(forced.disputes).toMatchObject({ docsChanged: 0, refutedDisputes: 0, tiesConverted: 0, edgesCleared: 0, reverifyMarked: 0 });
    expect(forced.graph).toEqual({ before: after.edges, after: after.edges });
    expect(changedPaths(knowledgeAfter, snapshot(s.knowledgeDir))).toEqual([]);
    expect(problems(s)).toEqual(after);
    s.store.close();
  });

  test("STANDUP_KNOWLEDGE_MAINTENANCE=0 skips the routine and writes nothing", async () => {
    const s = buildScratch();
    const filesBefore = snapshot(s.root);
    const result = await runKnowledgeMaintenance(deps(s, { env: { [MAINTENANCE_ENV]: "0" } }));
    expect(result).toMatchObject({ status: "disabled", steps: [], recorded: false });
    expect(changedPaths(filesBefore, snapshot(s.root))).toEqual([]);
    s.store.close();
  });

  test("a failing step is isolated and leaves the version unrecorded; the next boot retries only it", async () => {
    const s = buildScratch();
    const first = await runKnowledgeMaintenance(
      deps(s, {
        steps: {
          landed: async () => {
            throw new Error("git unavailable");
          },
        },
      })
    );
    expect(first.status).toBe("incomplete");
    expect(first.recorded).toBe(false);
    expect(first.steps.map((st) => [st.name, st.status])).toEqual([
      ["mirror", "ok"],
      ["landed", "error"],
      ["disputes", "ok"],
      ["graph", "ok"],
    ]);
    expect(first.steps[1]!.error).toBe("git unavailable");
    expect(maintenanceRunOf(s.store.db, MAINTENANCE_VERSION)).toBeNull();

    const retried = await runKnowledgeMaintenance(deps(s));
    expect(retried.steps.map((st) => [st.name, st.status])).toEqual([
      ["mirror", "done"],
      ["landed", "ok"],
      ["disputes", "done"],
      ["graph", "done"],
    ]);
    expect(stepCounts(retried).landed).toMatchObject({ landed: 1 });
    expect(retried).toMatchObject({ status: "ran", recorded: true });
    // The recorded run carries each step's counts from the run that completed it.
    expect(maintenanceRunOf(s.store.db, MAINTENANCE_VERSION)?.counts).toMatchObject({
      mirror: { superseded: 1 },
      landed: { landed: 1 },
      disputes: { reverifyMarked: 1 },
    });
    s.store.close();
  });

  test("an incomplete run never re-marks docs or resets attempt records on the next boots", async () => {
    const s = buildScratch();
    const failingGraph = {
      graph: async (): Promise<MaintenanceCounts> => {
        throw new Error("compile failed");
      },
    };
    const first = await runKnowledgeMaintenance(deps(s, { steps: failingGraph }));
    expect(first.status).toBe("incomplete");
    expect(stepCounts(first).disputes).toMatchObject({ reverifyQueued: 1, reverifyMarked: 1 });

    // The cron fact-checks the doc again without a verdict and runs for the day.
    recordReverifyAttempt(s.store.db, "standup", "real", "x", "error", "2026-10-10T00:00:00.000Z");
    s.store.db.run("UPDATE knowledge SET last_verified_at = '2026-10-10T00:00:00.000Z' WHERE slug = 'real'");
    setSetting(s.store.db, lastRunKey("standup"), "2026-10-10");

    for (let boot = 0; boot < 3; boot++) {
      const again = await runKnowledgeMaintenance(deps(s, { steps: failingGraph }));
      expect(again.steps.find((st) => st.name === "disputes")!.status).toBe("done");
    }
    // Forced, the dispute step reruns but the doc this version already marked is left alone.
    const forced = await runKnowledgeMaintenance(deps(s, { force: true, steps: failingGraph }));
    expect(stepCounts(forced).disputes).toMatchObject({ reverifyQueued: 0, reverifyMarked: 0 });

    expect(readProjectReverifyAttempts(s.store.db, "standup").get("real")).toMatchObject({
      attempts: 2,
      lastAttemptAt: "2026-10-10T00:00:00.000Z",
    });
    const real = s.store.db.query("SELECT last_verified_at FROM knowledge WHERE slug = 'real'").get() as {
      last_verified_at: string | null;
    };
    expect(real.last_verified_at).toBe("2026-10-10T00:00:00.000Z");
    expect(getSetting(s.store.db, lastRunKey("standup"))).toBe("2026-10-10");
    s.store.close();
  });

  test("a step that stops part-way is not recorded and reruns on the next boot", async () => {
    const s = buildScratch();
    let mirrorRuns = 0;
    const steps = {
      mirror: async (): Promise<MaintenanceCounts> => {
        mirrorRuns++;
        return mirrorRuns === 1 ? { [STEP_INCOMPLETE_KEY]: 1 } : { superseded: 0 };
      },
    };
    const first = await runKnowledgeMaintenance(deps(s, { steps }));
    expect(first.steps[0]).toMatchObject({ name: "mirror", status: "partial" });
    expect(first).toMatchObject({ status: "incomplete", recorded: false });
    expect(completedMaintenanceSteps(s.store.db, MAINTENANCE_VERSION)).toEqual(new Set(["landed", "disputes", "graph"]));
    const second = await runKnowledgeMaintenance(deps(s, { steps }));
    expect(second.steps.map((st) => st.status)).toEqual(["ok", "done", "done", "done"]);
    expect(second.recorded).toBe(true);
    expect(mirrorRuns).toBe(2);
    s.store.close();
  });

  test("the mirror step stops at the budget deadline during the cluster scan", async () => {
    const s = buildScratch();
    let t = 0;
    const result = await runKnowledgeMaintenance(deps(s, { budgetMs: 3, now: () => t++ }));
    const mirror = result.steps[0]!;
    expect(mirror).toMatchObject({ name: "mirror", status: "partial" });
    expect(mirror.counts).toMatchObject({ clusterScanIncomplete: 1, [STEP_INCOMPLETE_KEY]: 1 });
    expect(result.recorded).toBe(false);
    s.store.close();
  });

  test("steps not started within the budget are deferred and the version stays unrecorded", async () => {
    const s = buildScratch();
    let t = 0;
    const result = await runKnowledgeMaintenance(
      deps(s, {
        budgetMs: 100,
        now: () => t,
        steps: {
          mirror: async () => {
            t += 500;
            return { superseded: 0 };
          },
        },
      })
    );
    expect(result.status).toBe("incomplete");
    expect(result.steps.map((st) => st.status)).toEqual(["ok", "deferred", "deferred", "deferred"]);
    expect(maintenanceRunOf(s.store.db, MAINTENANCE_VERSION)).toBeNull();
    s.store.close();
  });
});

describe("markReverifyDue", () => {
  test("clears the recency backoff, the attempt cooldown and the day gate, once, keeping the attempt count", () => {
    const s = buildScratch();
    expect(markReverifyDue(s.store.db, "standup", "real")).toBe(true);
    const row = s.store.db.query("SELECT last_verified_at FROM knowledge WHERE slug = 'real'").get() as {
      last_verified_at: string | null;
    };
    expect(row.last_verified_at).toBeNull();
    expect(readProjectReverifyAttempts(s.store.db, "standup").get("real")).toMatchObject({
      attempts: 1,
      lastAttemptAt: new Date(0).toISOString(),
    });
    expect(getSetting(s.store.db, lastRunKey("standup"))).toBeNull();
    expect(markReverifyDue(s.store.db, "standup", "real")).toBe(false);
    expect(existsSync(s.dbPath)).toBe(true);
    s.store.close();
  });

  test("leaves the attempt record of a doc that spent its attempts untouched", () => {
    const s = buildScratch();
    for (let n = 0; n < MAX_REVERIFY_ATTEMPTS; n++) {
      recordReverifyAttempt(s.store.db, "standup", "refuted", "y", "error", "2026-10-09T00:00:00.000Z");
    }
    markReverifyDue(s.store.db, "standup", "refuted");
    expect(readProjectReverifyAttempts(s.store.db, "standup").get("refuted")).toMatchObject({
      attempts: MAX_REVERIFY_ATTEMPTS,
      lastAttemptAt: "2026-10-09T00:00:00.000Z",
    });
    s.store.close();
  });
});

describe("syncCorpusThenMaintain", () => {
  const cases: Array<{
    name: string;
    syncThrows: boolean;
    drainingAt?: "start" | "after-sync";
    want: Awaited<ReturnType<typeof syncCorpusThenMaintain>>;
    maintained: boolean;
  }> = [
    { name: "sync ok → maintenance runs", syncThrows: false, want: "maintained", maintained: true },
    { name: "sync failed → maintenance skipped", syncThrows: true, want: "sync-failed", maintained: false },
    { name: "draining before the sync → nothing runs", syncThrows: false, drainingAt: "start", want: "draining", maintained: false },
    { name: "draining after the sync → maintenance skipped", syncThrows: false, drainingAt: "after-sync", want: "draining", maintained: false },
  ];
  for (const c of cases) {
    test(c.name, async () => {
      let draining = c.drainingAt === "start";
      let maintained = false;
      const errors: string[] = [];
      const outcome = await syncCorpusThenMaintain({
        sync: async () => {
          if (c.drainingAt === "after-sync") draining = true;
          if (c.syncThrows) throw new Error("disk gone");
        },
        maintain: async () => {
          maintained = true;
        },
        draining: () => draining,
        error: (line) => errors.push(line),
      });
      expect(outcome).toBe(c.want);
      expect(maintained).toBe(c.maintained);
      expect(errors.length).toBe(c.syncThrows ? 1 : 0);
    });
  }
});

describe("maintenanceJudgeEnabled", () => {
  const cases: Array<{ env: Record<string, string>; setting?: string; want: boolean }> = [
    { env: {}, want: false },
    { env: { [MAINTENANCE_JUDGE_ENV]: "1" }, want: true },
    { env: { [MAINTENANCE_JUDGE_ENV]: "0" }, want: false },
    { env: { [MAINTENANCE_JUDGE_ENV]: "1", [NIGHTLY_SWEEP_ENV]: "0" }, want: false },
    { env: { [MAINTENANCE_JUDGE_ENV]: "1" }, setting: "false", want: false },
    { env: { [NIGHTLY_SWEEP_ENV]: "1" }, want: false },
  ];
  for (const c of cases) {
    test(`${JSON.stringify(c.env)} setting=${c.setting ?? "unset"} → ${c.want}`, () => {
      const store = createStore(":memory:");
      if (c.setting !== undefined) setSetting(store.db, NIGHTLY_SWEEP_SETTING_KEY, c.setting);
      expect(maintenanceJudgeEnabled(store.db, c.env)).toBe(c.want);
      store.close();
    });
  }
});
