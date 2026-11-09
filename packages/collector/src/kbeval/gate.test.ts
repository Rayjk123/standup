import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { detectCodeSearchBackend } from "../code-search.js";
import { gateRunOptions, gateViolations } from "./cli.js";
import { codeSearchHostViolations, type CodeSearchHost } from "./compare.js";
import { probeCodeSearchHost, runEval, tierPaths, type EvalResults } from "./runner.js";

/**
 * The fixture-tier gate: the full synthetic corpus through every surface,
 * compared against accepted.json (else baseline.json). Skips until the corpus
 * and a reference run exist.
 *
 * The run is made on a simulated host that has `rg` (STANDUP_RG_PATH names an
 * executable), the case where the host's engine differs from a reference
 * recorded without ripgrep; gateRunOptions pins the run to the reference's
 * engine, so the result does not depend on what the host has installed.
 */
const EVAL_DIR = join(import.meta.dir, "..", "..", "..", "knowledge", "eval");
const paths = tierPaths(EVAL_DIR, "fixture");
const referencePath = existsSync(paths.acceptedPath)
  ? paths.acceptedPath
  : existsSync(paths.baselinePath)
    ? paths.baselinePath
    : null;
const referenceName = referencePath?.endsWith("accepted.json") ? "accepted.json" : "baseline.json";
const corpusReady = existsSync(join(EVAL_DIR, "corpus", "projects.json")) && existsSync(paths.casesDir);
const skipReason = !corpusReady
  ? "packages/knowledge/eval/corpus is not present yet"
  : !referencePath
    ? "no accepted.json or baseline.json yet (write one with `bun run eval:kb --write-baseline`)"
    : null;

describe("gateRunOptions", () => {
  test("hides ripgrep for a reference recorded without it", () => {
    expect(gateRunOptions({ config: { codeSearchBackend: "git-grep", vec: false } })).toEqual({ ripgrep: false });
    expect(gateRunOptions({ config: { codeSearchBackend: "js", vec: false } })).toEqual({ ripgrep: false });
  });

  test("pins nothing for an rg reference, one with no recorded backend, or no reference", () => {
    expect(gateRunOptions({ config: { codeSearchBackend: "rg", vec: false } })).toEqual({});
    expect(gateRunOptions({ config: { vec: false } })).toEqual({});
    expect(gateRunOptions(null)).toEqual({});
  });
});

describe("codeSearchHostViolations", () => {
  const clean: CodeSearchHost = { gitVersion: "2.50.1", insideWorkTree: true, untracked: [] };

  test("a host that reproduces a git-grep reference passes", () => {
    expect(codeSearchHostViolations("git-grep", clean)).toEqual([]);
    expect(codeSearchHostViolations("git-grep", { ...clean, gitVersion: "2.38.0" })).toEqual([]);
  });

  test("names why a git-grep reference cannot be reproduced", () => {
    expect(codeSearchHostViolations("git-grep", { ...clean, gitVersion: null })).toEqual([
      "reference code-search engine git-grep is unavailable on this host: git cannot run; the code surface is not comparable",
    ]);
    expect(codeSearchHostViolations("git-grep", { ...clean, gitVersion: "2.37.9" })).toEqual([
      "reference code-search engine git-grep is unavailable on this host: git 2.37.9 lacks `git grep -m` (needs 2.38+); the code surface is not comparable",
    ]);
    expect(codeSearchHostViolations("git-grep", { ...clean, gitVersion: "1.99.0" })).toHaveLength(1);
    expect(codeSearchHostViolations("git-grep", { ...clean, insideWorkTree: false })).toEqual([
      "reference code-search engine git-grep is unavailable on this host: the fixture repo is not inside a git checkout; the code surface is not comparable",
    ]);
  });

  test("git requirements apply only to a git-grep reference", () => {
    const noGit: CodeSearchHost = { gitVersion: null, insideWorkTree: false, untracked: [] };
    expect(codeSearchHostViolations("rg", noGit)).toEqual([]);
    expect(codeSearchHostViolations("js", noGit)).toEqual([]);
    expect(codeSearchHostViolations(undefined, noGit)).toEqual([]);
  });

  test("untracked fixture files fail whatever the reference's engine", () => {
    const untracked = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"];
    for (const backend of ["git-grep", "js", "rg", undefined]) {
      expect(codeSearchHostViolations(backend, { ...clean, untracked })).toEqual([
        "fixture repo has 6 untracked file(s) the code search reads (a.ts, b.ts, c.ts, d.ts, e.ts, …); commit or remove them",
      ]);
    }
  });

  test("probeCodeSearchHost reports a directory outside any git checkout", () => {
    const dir = mkdtempSync(join(tmpdir(), "kbeval-gate-nogit-"));
    try {
      const host = probeCodeSearchHost(dir);
      expect(host.insideWorkTree).toBe(false);
      expect(host.untracked).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("probeCodeSearchHost lists untracked, non-ignored files in a git checkout", () => {
    const dir = mkdtempSync(join(tmpdir(), "kbeval-gate-git-"));
    try {
      expect(Bun.spawnSync(["git", "init", "-q"], { cwd: dir }).exitCode).toBe(0);
      writeFileSync(join(dir, ".gitignore"), "ignored.ts\n");
      writeFileSync(join(dir, "stray.ts"), "x\n");
      writeFileSync(join(dir, "ignored.ts"), "x\n");
      const host = probeCodeSearchHost(dir);
      expect(host.insideWorkTree).toBe(true);
      expect(host.gitVersion).toMatch(/^\d+\.\d+/);
      expect(host.untracked).toEqual([".gitignore", "stray.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("knowledge eval gate (fixture tier)", () => {
  if (skipReason) console.log(`[kbeval gate] skipped: ${skipReason}`);

  let reference: EvalResults;
  let results: EvalResults;
  let hostBackend: string;
  let fakeRgDir: string | null = null;

  beforeAll(async () => {
    if (skipReason) return;
    reference = JSON.parse(readFileSync(referencePath!, "utf-8")) as EvalResults;
    fakeRgDir = mkdtempSync(join(tmpdir(), "kbeval-gate-rg-"));
    const fakeRg = join(fakeRgDir, "rg");
    writeFileSync(fakeRg, "#!/bin/sh\nexit 2\n");
    chmodSync(fakeRg, 0o755);
    const previous = process.env.STANDUP_RG_PATH;
    process.env.STANDUP_RG_PATH = fakeRg;
    try {
      hostBackend = detectCodeSearchBackend(join(EVAL_DIR, "fixture-repo")).backend;
      results = await runEval({
        tier: "fixture",
        evalDir: EVAL_DIR,
        label: "gate-test",
        writeResults: false,
        ...gateRunOptions(reference),
      });
    } finally {
      if (previous === undefined) delete process.env.STANDUP_RG_PATH;
      else process.env.STANDUP_RG_PATH = previous;
    }
  }, 60_000);

  afterAll(() => {
    if (fakeRgDir) rmSync(fakeRgDir, { recursive: true, force: true });
  });

  test.skipIf(skipReason !== null)("no regression against the accepted run, on a host with rg", () => {
    expect(hostBackend).toBe("rg");
    const host = probeCodeSearchHost(join(EVAL_DIR, "fixture-repo"));
    const violations = gateViolations(results, reference, referenceName, host);
    if (violations.length > 0) console.error(violations.join("\n"));
    expect(violations).toEqual([]);
    expect(results.config.codeSearchBackend).toBe(reference.config.codeSearchBackend);
  });

  test.skipIf(skipReason !== null)("a metric regression in the pinned run still fails the gate", () => {
    const regressed = structuredClone(results);
    const search = regressed.metrics.bySurface.search;
    expect(search.mrrAt10).not.toBeNull();
    search.mrrAt10 = search.mrrAt10! - 0.1;
    regressed.metrics.overall.leakedHits += 1;
    const violations = gateViolations(regressed, reference, referenceName);
    expect(violations.some((v) => v.startsWith("search.mrrAt10 dropped"))).toBe(true);
    expect(violations.some((v) => v.startsWith("overall.leakedHits increased"))).toBe(true);
  });

  test.skipIf(skipReason !== null)("a run on a different engine than the reference still fails the gate", () => {
    const otherEngine = structuredClone(results);
    otherEngine.config.codeSearchBackend = "rg";
    otherEngine.codeSearch.byBackend = { rg: otherEngine.codeSearch.cases };
    const violations = gateViolations(otherEngine, reference, referenceName);
    expect(violations.some((v) => v.startsWith("code-search backend differs"))).toBe(true);
    expect(violations.some((v) => v.startsWith("code-search backend mix differs"))).toBe(true);
  });

  test.skipIf(skipReason !== null)("a host that cannot reproduce the reference's engine fails with its cause", () => {
    const host: CodeSearchHost = { gitVersion: "2.30.0", insideWorkTree: true, untracked: [] };
    const violations = gateViolations(results, reference, referenceName, host);
    expect(violations).toEqual(codeSearchHostViolations(reference.config.codeSearchBackend, host));
    if (reference.config.codeSearchBackend === "git-grep") expect(violations).toHaveLength(1);
  });
});
