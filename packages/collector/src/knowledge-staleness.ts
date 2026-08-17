import { homedir } from "os";

/**
 * Staleness for generated knowledge docs (phase-7 Step 6).
 *
 * Only a doc with a `generated_from_sha` ever gets an opinion here — a
 * human-authored doc was written on purpose, and second-guessing that is
 * exactly the authority-spending the design warns about. Computed on demand
 * by the route that serves the Knowledge tab, not on a timer or a watcher:
 * it's two git commands, and nobody needs the answer while the tab is
 * closed.
 *
 * Deliberately not a weighted heuristic over commit count and file count.
 * Commit count alone drives the verdict; file count is surfaced as detail
 * only. There's no evidence yet about what actually correlates with a doc
 * going stale, and inventing a formula before that evidence exists is the
 * kind of cleverness the plan explicitly says to resist.
 */

export const STALENESS_THRESHOLD_COMMITS = 50;

export interface Staleness {
  sha: string;
  /** False when the sha can't be resolved in this clone at all — branch
   *  deleted, history rewritten, repos[0] moved, or it's simply not here.
   *  commitsSince/filesChanged are null in that case; there is nothing to
   *  degrade to but "unknown". */
  reachable: boolean;
  commitsSince: number | null;
  filesChanged: number | null;
  stale: boolean;
}

/**
 * True only for a non-empty sha. `generated_from_sha` can be an empty
 * string rather than NULL if something upstream ever writes "" instead of
 * omitting the field (runbook.md's empty-string-is-not-NULL gotcha already
 * bit title-setting once) — treating "" as present would flag every doc
 * such a bug touched as stale.
 */
export function hasProvenance(sha: string | null | undefined): sha is string {
  return typeof sha === "string" && sha.trim().length > 0;
}

export function isStale(commitsSince: number): boolean {
  return commitsSince >= STALENESS_THRESHOLD_COMMITS;
}

/** `project.repos[0]` with `~` expanded, or null if the project has no repo
 *  configured — mirrors the resolution launcher.ts does for a real launch,
 *  but read-only and never asserts the path exists (a missing repo just
 *  means staleness degrades to "unreachable", not an error). */
export function primaryRepoPath(project: { repos: string[] }): string | null {
  const repo = project.repos[0];
  return repo ? repo.replace(/^~/, homedir()) : null;
}

async function runGit(repoPath: string, args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return proc.exitCode === 0 ? stdout : null;
  } catch {
    // Bad cwd (repo path moved or never existed) throws synchronously from
    // spawn rather than producing a nonzero exit — same degrade either way.
    return null;
  }
}

/**
 * `git rev-list --count <sha>..HEAD` and `git diff --name-only <sha>..HEAD`,
 * spawned with an explicit cwd rather than through a shell string so a sha
 * (or a repo path) can't smuggle in shell syntax. Any failure — including a
 * plausible-looking sha that just isn't in this clone — degrades to
 * `reachable: false` rather than throwing. A Knowledge tab that fails to
 * load because git is confused is a worse outcome than a missing badge.
 */
export async function computeStaleness(repoPath: string, sha: string): Promise<Staleness> {
  const countOut = await runGit(repoPath, ["rev-list", "--count", `${sha}..HEAD`]);
  if (countOut === null) {
    return { sha, reachable: false, commitsSince: null, filesChanged: null, stale: false };
  }
  const commitsSince = parseInt(countOut.trim(), 10);
  // git exited 0 but said something we can't read. Treat it as unreachable
  // rather than passing NaN on: JSON.stringify turns NaN into null, which
  // would reach the UI as `reachable: true` with no count — a combination
  // nothing downstream is written to handle.
  if (!Number.isFinite(commitsSince)) {
    return { sha, reachable: false, commitsSince: null, filesChanged: null, stale: false };
  }

  // A second git call can fail independently of the first (rare, but the
  // two commands aren't atomic) — degrade just the file count rather than
  // the whole result, since the commit count is what drives the verdict.
  const diffOut = await runGit(repoPath, ["diff", "--name-only", `${sha}..HEAD`]);
  const filesChanged =
    diffOut === null ? null : diffOut.split("\n").filter((line) => line.trim().length > 0).length;

  return {
    sha,
    reachable: true,
    commitsSince,
    filesChanged,
    stale: isStale(commitsSince),
  };
}
