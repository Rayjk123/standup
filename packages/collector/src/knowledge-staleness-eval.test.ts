// Offline eval for file-scoped staleness. Deterministic + git-free: spawning a
// real temp repo is slow and has hung the runner twice, and the git command
// (rev-list --count -- <paths>) is stock — what we own is (a) the derivation
// primitives and (b) whether the file-scoped RANKING KEY helps the REAL
// consumer, selectReverifyCandidates, spend its bounded top-K budget on docs
// that truly need re-checking.
//
// It measures the shipped decision, not a stand-in: it calls the real
// selectReverifyCandidates and the real deriveOwnedPaths/computeFileScopedStaleness.
// Known heuristic failure modes (an unanchored stale doc, an over-matched fresh
// doc) are IN the fixture and reported, not assumed away.

import { describe, expect, test } from "bun:test";
import {
  computeFileScopedStaleness,
  deriveOwnedPaths,
  FILE_SCOPED_STALENESS_THRESHOLD_COMMITS,
  type GitRunner,
  type Staleness,
  type FileScopedStaleness,
} from "./knowledge-staleness.js";
import { selectReverifyCandidates, type ReverifyTarget } from "./knowledge-reverify.js";
import type { KnowledgeDoc } from "@standup/knowledge";

// ── Primitive: deriveOwnedPaths ──────────────────────────────────────────────

describe("deriveOwnedPaths", () => {
  test("extracts source-rooted FILE paths a doc names, ignoring prose", () => {
    expect(
      deriveOwnedPaths("Covers `packages/x/a.ts` and src/util/fmt.ts here.").sort(),
    ).toEqual(["packages/x/a.ts", "src/util/fmt.ts"]);
  });
  test("a bare directory token is NOT matched (would re-widen to repo-global)", () => {
    expect(deriveOwnedPaths("This doc is about packages/collector broadly.")).toEqual([]);
  });
  test("a doc that names no path is unanchored (empty)", () => {
    expect(deriveOwnedPaths("A conceptual note on the retry policy, no files.")).toEqual([]);
  });
  test("over-match is real: a foreign file mentioned in passing is captured", () => {
    // Honest exposure of the heuristic's precision hole — "paths mentioned" is
    // not "paths the doc is about".
    expect(deriveOwnedPaths("Mostly about src/a.ts, but see packages/y/api.ts too.").sort()).toEqual(
      ["packages/y/api.ts", "src/a.ts"],
    );
  });
});

// ── Primitive: computeFileScopedStaleness (faithful git oracle) ──────────────

// A commit is the set of files it touched. `git rev-list --count sha..HEAD -- P`
// counts DISTINCT commits touching any path in P (a commit touching two of P's
// files counts once) — so the fake counts commit-membership, never sums per file.
function gitFrom(commits: string[][], total = commits.length): GitRunner {
  return async (_repo, args) => {
    if (args[0] === "rev-list" && args[1] === "--count") {
      const dashDash = args.indexOf("--");
      if (dashDash === -1) return String(total); // repo-global
      const paths = new Set(args.slice(dashDash + 1));
      return String(commits.filter((c) => c.some((f) => paths.has(f))).length);
    }
    if (args[0] === "diff") return "";
    return null;
  };
}

describe("computeFileScopedStaleness", () => {
  const commits = [
    ["packages/y/api.ts"],
    ["packages/y/api.ts", "packages/x/a.ts"], // touches BOTH — one commit, counted once
    ["packages/y/api.ts"],
    ["packages/x/a.ts"],
    ["README.md"],
  ];
  const git = gitFrom(commits, 60);

  test("counts distinct commits touching the doc's own files (union, not sum)", async () => {
    const r = await computeFileScopedStaleness("repo", "base", ["packages/y/api.ts"], 3, git);
    expect(r.commitsSince).toBe(3); // 3 distinct commits, though one also touched x/a.ts
    expect(r.anchored).toBe(true);
    expect(r.stale).toBe(true); // 3 >= 3
  });
  test("unanchored (no paths) → anchored:false, stale:false so the caller falls back", async () => {
    const r = await computeFileScopedStaleness("repo", "base", [], 5, git);
    expect(r.anchored).toBe(false);
    expect(r.stale).toBe(false);
    expect(r.commitsSince).toBeNull();
  });
  test("git failure degrades to reachable:false (mirrors computeStaleness)", async () => {
    const r = await computeFileScopedStaleness("repo", "base", ["src/a.ts"], 5, async () => null);
    expect(r.reachable).toBe(false);
    expect(r.stale).toBe(false);
  });
});

// ── Calibration: threshold sweep over OVERLAPPING churn (non-circular) ───────

describe("FILE_SCOPED_STALENESS_THRESHOLD_COMMITS is the sweep's F1 argmax", () => {
  test("derived from an overlapping-churn fixture + a fine grid, not asserted by membership", () => {
    // Owned-file churn per doc, with the classes OVERLAPPING (fresh reaches 6,
    // stale starts at 5) so no threshold is trivially perfect — the best is a
    // genuine tradeoff, unlike a separable fixture where any mid value "wins".
    const fresh = [1, 2, 3, 4, 6];
    const stale = [5, 7, 8, 10, 12];
    const grid = Array.from({ length: 15 }, (_, i) => i + 1); // 1..15, fine
    const f1At = (t: number) => {
      let tp = 0, fp = 0, fn = 0;
      for (const c of stale) c >= t ? tp++ : fn++;
      for (const c of fresh) if (c >= t) fp++;
      const p = tp + fp === 0 ? 0 : tp / (tp + fp);
      const r = tp + fn === 0 ? 0 : tp / (tp + fn);
      return p + r === 0 ? 0 : (2 * p * r) / (p + r);
    };
    let best = grid[0]!;
    for (const t of grid) if (f1At(t) > f1At(best)) best = t;
    console.log(
      `\nthreshold sweep (overlapping churn): F1 argmax = ${best} (F1=${f1At(best).toFixed(3)}); shipped default = ${FILE_SCOPED_STALENESS_THRESHOLD_COMMITS}`,
    );
    // The constant is the value the independent sweep selects — change the churn
    // and the constant would have to move with the argmax, not the other way round.
    expect(FILE_SCOPED_STALENESS_THRESHOLD_COMMITS).toBe(best);
  });
});

// ── Real consumer: does the file-scoped key improve recall/precision @budget? ─

function doc(id: string): KnowledgeDoc {
  // generatedFromSha present so it passes selectReverifyCandidates' provenance
  // filter; no lastVerifiedAt so it's never in cooldown; no disputes so it's not
  // a contradiction endpoint (that key would otherwise dominate the sort).
  return { id, slug: id, projectId: "p", disputes: [], generatedFromSha: "base" } as unknown as KnowledgeDoc;
}
const repoStale: Staleness = { sha: "base", reachable: true, commitsSince: 60, filesChanged: 9, stale: true };
const repoFresh: Staleness = { sha: "base", reachable: true, commitsSince: 3, filesChanged: 1, stale: false };
const fsStale = (anchored: boolean, stale: boolean): FileScopedStaleness => ({
  sha: "base", reachable: true, ownedPaths: anchored ? ["packages/x/a.ts"] : [], anchored, commitsSince: anchored ? (stale ? 9 : 1) : null, stale,
});

// Ground truth: ts1..ts4 truly need re-checking; the rest are fresh. The repo is
// busy, so repo-global flags all of ts* AND the fresh fp* stale — it can't tell
// them apart. Confidence is deliberately UNCORRELATED with true staleness (a doc
// ages regardless of whether its subject changed), so the existing confidence
// tiebreak can't do file-scoping's job. ts4 is unanchored (heuristic miss); fp3
// is over-matched (names a churned foreign file → falsely file-scoped-stale).
interface Row { id: string; truthStale: boolean; repo: Staleness; conf: number; fileScoped: FileScopedStaleness }
const ROWS: Row[] = [
  { id: "ts1", truthStale: true, repo: repoStale, conf: 0.3, fileScoped: fsStale(true, true) },
  { id: "ts2", truthStale: true, repo: repoStale, conf: 0.5, fileScoped: fsStale(true, true) },
  { id: "ts3", truthStale: true, repo: repoStale, conf: 0.6, fileScoped: fsStale(true, true) },
  { id: "ts4", truthStale: true, repo: repoStale, conf: 0.55, fileScoped: fsStale(false, false) }, // unanchored miss
  { id: "fp1", truthStale: false, repo: repoStale, conf: 0.35, fileScoped: fsStale(true, false) },
  { id: "fp2", truthStale: false, repo: repoStale, conf: 0.4, fileScoped: fsStale(true, false) },
  { id: "fp3", truthStale: false, repo: repoStale, conf: 0.65, fileScoped: fsStale(true, true) }, // over-match FP
  { id: "fp4", truthStale: false, repo: repoStale, conf: 0.45, fileScoped: fsStale(true, false) },
  { id: "fp5", truthStale: false, repo: repoStale, conf: 0.7, fileScoped: fsStale(true, false) },
  { id: "c1", truthStale: false, repo: repoFresh, conf: 0.8, fileScoped: fsStale(true, false) },
  { id: "c2", truthStale: false, repo: repoFresh, conf: 0.85, fileScoped: fsStale(true, false) },
  { id: "c3", truthStale: false, repo: repoFresh, conf: 0.9, fileScoped: fsStale(true, false) },
];
const NOW = new Date("2026-02-01T00:00:00Z");
const BUDGET = 3;
const truthById = new Map(ROWS.map((r) => [r.id, r.truthStale]));
const totalTrulyStale = ROWS.filter((r) => r.truthStale).length;

function selectAt(useFileScoped: boolean): string[] {
  const targets: ReverifyTarget[] = ROWS.map((r) => ({
    doc: doc(r.id),
    staleness: r.repo,
    fileScopedStaleness: useFileScoped ? r.fileScoped : undefined,
    currentConfidence: r.conf,
  }));
  return selectReverifyCandidates(targets, BUDGET, NOW).map((t) => t.doc.id);
}
function scoreSelection(ids: string[]) {
  const tp = ids.filter((id) => truthById.get(id)).length;
  return { precision: tp / ids.length, recall: tp / totalTrulyStale, selected: ids };
}

describe("file-scoped ranking key vs repo-global-only, through the REAL selectReverifyCandidates", () => {
  test("file-scoping raises recall AND precision @budget over the repo-global baseline", () => {
    const baseline = scoreSelection(selectAt(false)); // mainline: no file-scoped key
    const withFs = scoreSelection(selectAt(true)); // item 3
    console.log(
      `\nrecall@${BUDGET}/precision@${BUDGET} through selectReverifyCandidates (budget=${BUDGET}, ${totalTrulyStale} truly stale):`,
    );
    console.log(`  repo-global only: recall=${baseline.recall.toFixed(2)} precision=${baseline.precision.toFixed(2)}  [${baseline.selected.join(",")}]`);
    console.log(`  + file-scoped:    recall=${withFs.recall.toFixed(2)} precision=${withFs.precision.toFixed(2)}  [${withFs.selected.join(",")}]`);
    console.log(
      `  caveats: misses ts4 (unanchored — the anchoring-rate cost); fp3 (over-match) stays out of the top-${BUDGET} only because its confidence outranks the truly-stale docs.`,
    );
    expect(withFs.recall).toBeGreaterThan(baseline.recall);
    expect(withFs.precision).toBeGreaterThan(baseline.precision);
  });

  test("the file-scoped key actually fires in the sort (regression guard for the shipped branch)", () => {
    // Two targets identical except one is file-scoped-stale: it MUST be selected
    // first. Guards knowledge-reverify.ts's fileScoped sort key from silently
    // going dead (repo-global equal, confidence equal, so only the fs key decides).
    const targets: ReverifyTarget[] = [
      { doc: doc("plain"), staleness: repoStale, fileScopedStaleness: fsStale(true, false), currentConfidence: 0.5 },
      { doc: doc("fscoped"), staleness: repoStale, fileScopedStaleness: fsStale(true, true), currentConfidence: 0.5 },
    ];
    expect(selectReverifyCandidates(targets, 1, NOW).map((t) => t.doc.id)).toEqual(["fscoped"]);
  });
});
