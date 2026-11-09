import type { Database } from "bun:sqlite";
import { existsSync, realpathSync } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, join } from "path";
import { getProjects, getSetting } from "@standup/store";
import type { Project } from "@standup/shared";
import {
  contradictionDisputes,
  parseContradictsClaim,
  withConfidenceDefaults,
  type ConfidenceEvidence,
  type KnowledgeDoc,
} from "@standup/knowledge";

/**
 * Staleness for knowledge docs, measured against the project's repo.
 *
 * Commit drift (computeStaleness) opines only on a doc with a
 * `generated_from_sha`: it is computed on demand by the route that serves the
 * Knowledge tab, two git commands, and a doc with no sha has nothing to count
 * from. Deliberately a plain commit count, not a weighted heuristic over
 * commit and file counts: there is no evidence yet about what correlates with
 * a doc going stale, and inventing a formula before that evidence exists is
 * the kind of cleverness the plan says to resist.
 *
 * Evidence (computeDocEvidence) reaches every doc, whoever wrote it. It
 * anchors the doc to a commit — its sha when it has one, else the commit at
 * the time it was last verified — and reports what the repo shows since then:
 * a named path or symbol that existed at the anchor and is gone at HEAD, churn
 * on the doc's own files, a sha the default branch never merged. All of it is
 * git plumbing, no model, so it is cheap enough to run over a whole corpus.
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

/** Env flag that switches knowledge re-verification off for every project (`0`/`false`/`off`/`no`). */
export const REVERIFY_ENV = "STANDUP_KNOWLEDGE_REVERIFY";
/** Settings key that switches re-verification off for every project when set to an off value. */
export const REVERIFY_SETTING_KEY = "knowledge.reverify";
/** Per-project settings key that opts one project out of re-verification. */
export function reverifyProjectSettingKey(projectId: string): string {
  return `${REVERIFY_SETTING_KEY}:${projectId}`;
}

function isOffFlag(v: string | null | undefined): boolean {
  if (v == null) return false;
  const s = v.trim().toLowerCase();
  return s === "0" || s === "false" || s === "off" || s === "no" || s === "disabled";
}

/**
 * Whether re-verification is switched on for a project. DEFAULT ON: it runs for
 * every project unless the env flag, the global settings key, or the project's
 * own settings key is an off value. Re-verification is the recovery path the
 * decay gate depends on, so it is not something a project has to remember to
 * enable.
 */
export function isReverifyEnabled(db: Database, projectId: string): boolean {
  if (isOffFlag(process.env[REVERIFY_ENV])) return false;
  if (isOffFlag(getSetting(db, REVERIFY_SETTING_KEY))) return false;
  return !isOffFlag(getSetting(db, reverifyProjectSettingKey(projectId)));
}

/** Env flag that switches the model re-verification pass on for every project (`1`/`true`/`on`/`yes`). */
export const REVERIFY_MODEL_ENV = "STANDUP_KNOWLEDGE_REVERIFY_MODEL";
/** Settings key that switches the model pass on for every project. */
export const REVERIFY_MODEL_SETTING_KEY = "knowledge.reverify_model";
/** Per-project settings key that switches the model pass on (or, set to an off value, off) for one project. */
export function reverifyModelProjectSettingKey(projectId: string): string {
  return `${REVERIFY_MODEL_SETTING_KEY}:${projectId}`;
}

function isOnFlag(v: string | null | undefined): boolean {
  if (v == null) return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "on" || s === "yes" || s === "enabled";
}

/**
 * Whether the MODEL re-verification pass (a `claude` fact-check per doc) runs
 * for a project. OPT-IN, because it spends model calls: on when the project's
 * own settings key, the global key or the env flag is on, or the project opted
 * into the daily review (`dailyReviewActive`, the existing switch for
 * background agent passes over its repo). A project's own off value wins over
 * the global switches. The deterministic evidence pass is not governed by this.
 */
export function isModelReverifyEnabled(
  db: Database,
  project: { id: string; dailyReviewActive?: boolean }
): boolean {
  if (!isReverifyEnabled(db, project.id)) return false;
  const own = getSetting(db, reverifyModelProjectSettingKey(project.id));
  if (isOffFlag(own)) return false;
  if (isOnFlag(own) || project.dailyReviewActive) return true;
  return isOnFlag(getSetting(db, REVERIFY_MODEL_SETTING_KEY)) || isOnFlag(process.env[REVERIFY_MODEL_ENV]);
}

/**
 * Whether the re-verification cron (roadmap r5) can ACTUALLY re-verify this
 * project's docs on this host: re-verification is not switched off for it
 * (`enabled`, see isReverifyEnabled) AND its primary repo resolves to a path
 * that exists here. Existence is checked, not just configuration, because a
 * project whose `repos[0]` was moved/symlinked/deleted leaves the cron a no-op.
 *
 * This is the recovery-path signal the injection freshness gate couples to:
 * decay-gating a doc out of injection is only safe when the cron will lift it
 * back. The cron re-verifies any doc of such a project — agent-written, owner,
 * or mirrored from the repo — so the signal is per project, judged for the
 * project that OWNS the doc.
 */
export function projectReverifyOperational(project: { repos: string[] }, enabled = true): boolean {
  if (!enabled) return false;
  const repoPath = primaryRepoPath(project);
  return repoPath !== null && existsSync(repoPath);
}

/**
 * projectReverifyOperational for each project id, resolved from the projects and
 * settings in `db` and memoized for the life of the returned function — one per
 * request, so a search over many hits resolves each owning project once. An
 * unknown project (a doc homed in a project with no registry row, such as the
 * reserved global corpus) has no repo and so no recovery path.
 */
export function reverifyOperationalResolver(db: Database): (projectId: string) => boolean {
  // A DB with no projects table (a knowledge-only DB) has no project a repo
  // could resolve for. Failing soft matters: the launch retrieval swallows
  // errors, so a throw here would silently inject nothing.
  let projects: Map<string, Project>;
  try {
    projects = new Map(getProjects(db).map((p) => [p.id, p]));
  } catch {
    projects = new Map();
  }
  const memo = new Map<string, boolean>();
  return (projectId) => {
    let known = memo.get(projectId);
    if (known === undefined) {
      const project = projects.get(projectId);
      known = project ? projectReverifyOperational(project, isReverifyEnabled(db, projectId)) : false;
      memo.set(projectId, known);
    }
    return known;
  };
}

/** One-off reverifyOperationalResolver lookup for a single project. */
export function isReverifyOperational(db: Database, projectId: string): boolean {
  return reverifyOperationalResolver(db)(projectId);
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
/**
 * Current HEAD commit of the repo, or null when it can't be resolved (bad path,
 * detached/empty repo, git failure). The re-verification pass (roadmap r5)
 * stamps this onto a doc it re-affirmed CLEAN, so the shipped commit-drift
 * signal (computeStaleness) re-baselines to the commit the doc was just verified
 * against instead of reporting the doc stale forever against its original sha.
 */
export async function resolveHeadSha(repoPath: string): Promise<string | null> {
  const out = await runGit(repoPath, ["rev-parse", "HEAD"]);
  const sha = out?.trim();
  return sha && sha.length > 0 ? sha : null;
}

/** The git runner shape — injectable so the staleness logic is testable without
 *  spawning git (a real temp-repo test is slow and can hang the runner). */
export type GitRunner = (repoPath: string, args: string[]) => Promise<string | null>;

export async function computeStaleness(
  repoPath: string,
  sha: string,
  git: GitRunner = runGit
): Promise<Staleness> {
  const countOut = await git(repoPath, ["rev-list", "--count", `${sha}..HEAD`]);
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
  const diffOut = await git(repoPath, ["diff", "--name-only", `${sha}..HEAD`]);
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

// ── File-scoped staleness ────────────────────────────────────────────────────
//
// Repo-global drift (computeStaleness) flags a doc stale once HEAD is 50 commits
// past its sha — even when every one of those commits touched files the doc has
// nothing to do with. File-scoped drift instead counts only commits that touched
// the doc's OWN files, so the bounded re-verify budget is spent on docs whose
// subject actually changed. It stays a plain commit count (no weighted formula):
// the only added judgment is WHICH files to count over, which the doc itself names.

/**
 * The file-scoped commit bar. Commits touching a single doc's own files are far
 * rarer than repo-wide churn, so the repo-global 50 would essentially never fire
 * per-doc — defeating the point. 5 is the bar the eval sweep settles on: it lifts
 * precision over the repo-global signal while holding recall on the seeded corpus
 * (packages/collector/src/knowledge-staleness-eval.test.ts reports the curve).
 */
export const FILE_SCOPED_STALENESS_THRESHOLD_COMMITS = 5;

export interface FileScopedStaleness {
  sha: string;
  reachable: boolean;
  /** The doc's own paths this drift was scoped to; empty when the heuristic pinned none. */
  ownedPaths: string[];
  /** True iff `ownedPaths` is non-empty. When false the caller must fall back to the
   *  repo-global signal rather than trust a file-scoped verdict built from zero paths. */
  anchored: boolean;
  /** Commits since `sha` touching `ownedPaths`; null when unreachable or unanchored. */
  commitsSince: number | null;
  stale: boolean;
}

/**
 * The repo-relative FILE paths a doc names in its body — the files it is "about".
 * A deliberate heuristic with known failure modes the eval exercises: a doc may
 * name no path (under-match → unanchored → the caller falls back to repo-global),
 * or quote an unrelated file in passing (over-match → inherits that file's churn).
 * Requires a file extension so a bare directory token (e.g. `packages/collector`)
 * is NOT matched — a directory pathspec would re-widen file-scoped drift back to
 * near-repo-global, defeating the point.
 */
const OWNED_PATH_RE =
  /\b(?:packages|src|apps|lib|scripts|tests?)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.[A-Za-z]{1,6}\b/g;

export function deriveOwnedPaths(body: string): string[] {
  const found = new Set<string>();
  for (const m of (body ?? "").matchAll(OWNED_PATH_RE)) {
    const p = m[0].replace(/[.,;:)\]]+$/, ""); // trim trailing prose punctuation
    if (p.length > 3) found.add(p);
  }
  return [...found];
}

/**
 * `git rev-list --count <sha>..HEAD -- <ownedPaths>` — commits since `sha` that
 * touched the doc's own files. The `--` fences the pathspecs so a sha or a path
 * can't smuggle in git options. Unanchored (no paths) → `stale:false` +
 * `anchored:false` so the caller falls back to repo-global. Any git failure
 * degrades to `reachable:false`, mirroring computeStaleness. `git` is injectable
 * so the decision logic is testable without spawning git.
 */
export async function computeFileScopedStaleness(
  repoPath: string,
  sha: string,
  ownedPaths: string[],
  threshold: number = FILE_SCOPED_STALENESS_THRESHOLD_COMMITS,
  git: GitRunner = runGit
): Promise<FileScopedStaleness> {
  if (ownedPaths.length === 0) {
    return { sha, reachable: true, ownedPaths, anchored: false, commitsSince: null, stale: false };
  }
  const out = await git(repoPath, ["rev-list", "--count", `${sha}..HEAD`, "--", ...ownedPaths]);
  if (out === null) {
    return { sha, reachable: false, ownedPaths, anchored: true, commitsSince: null, stale: false };
  }
  const commitsSince = parseInt(out.trim(), 10);
  if (!Number.isFinite(commitsSince)) {
    return { sha, reachable: false, ownedPaths, anchored: true, commitsSince: null, stale: false };
  }
  return {
    sha,
    reachable: true,
    ownedPaths,
    anchored: true,
    commitsSince,
    stale: commitsSince >= threshold,
  };
}

// ── Evidence ─────────────────────────────────────────────────────────────────

/** A git call's exit code and stdout, or null when git could not be spawned at all. */
export type GitStatusRunner = (
  repoPath: string,
  args: string[]
) => Promise<{ code: number; stdout: string } | null>;

export const runGitStatus: GitStatusRunner = async (repoPath, args) => {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd: repoPath, stdout: "pipe", stderr: "pipe" });
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { code: proc.exitCode ?? -1, stdout };
  } catch {
    return null;
  }
};

/** Most paths and most symbols checked per doc, so one mega-doc cannot dominate a pass. */
const MAX_REFS_PER_DOC = 24;

/**
 * A line that talks about a name as already gone, replaced, or not merged. A
 * name on such a line is not a claim that it exists, so it is never evidence
 * against the doc when it is missing.
 */
const RETIRED_CONTEXT =
  /\b(?:removed|deleted|renamed|replaced|retired|dropped|deprecated|gone|no longer|instead of|formerly|used to|was called|old|unmerged|would)\b/i;

/** Backticked spans, and the identifier shape a code symbol has. */
const BACKTICKED = /`([^`\n]{3,80})`/g;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
/** Every identifier-shaped word in a text, for the in-process symbol scan. */
const WORD_RE = /[A-Za-z_$][\w$]*/g;
/** Files larger than this are not scanned for symbols (generated bundles, fixtures, lockfiles). */
const MAX_SCANNED_FILE_BYTES = 1_000_000;

/** Whether a line's prose (its code spans and paths blanked out, so `src/old/x.ts` is not "old") reads as RETIRED_CONTEXT. */
function isRetiredLine(line: string): boolean {
  return RETIRED_CONTEXT.test(line.replace(BACKTICKED, " ").replace(OWNED_PATH_RE, " "));
}

/**
 * The code symbols a doc names: backticked identifiers that look like code
 * (contain `_`, an inner capital, or are written as a call, `name()` or
 * `name(args)`), skipping lines that describe the name as removed, replaced or
 * not yet merged. Plain words in backticks (`scope`,
 * `claude`) are not symbols — a missing one says nothing about the code.
 */
export function deriveNamedSymbols(body: string): string[] {
  const found = new Set<string>();
  for (const line of (body ?? "").split("\n")) {
    if (isRetiredLine(line)) continue;
    for (const m of line.matchAll(BACKTICKED)) {
      const raw = m[1].trim();
      const call = /^([A-Za-z_$][\w$]*)\([^()]*\)$/.exec(raw);
      const name = call ? call[1] : raw;
      if (name.length < 4 || !IDENTIFIER.test(name)) continue;
      if (name.includes("_") || /[a-z][A-Z]/.test(name) || call) found.add(name);
    }
  }
  return [...found].slice(0, MAX_REFS_PER_DOC);
}

/** deriveOwnedPaths minus paths on lines that describe them as removed or replaced. */
export function deriveNamedPaths(body: string): string[] {
  const lines = (body ?? "").split("\n").filter((line) => !isRetiredLine(line));
  return deriveOwnedPaths(lines.join("\n")).slice(0, MAX_REFS_PER_DOC);
}

/** The filesystem roots a checkout usually sits under, on any host. */
const BUILT_IN_PATH_ROOTS = ["/Users", "/home", "/Volumes", "/opt"];

/** Extra roots, comma-separated (`/srv,/data/work`), for hosts that keep checkouts elsewhere. */
export const KNOWLEDGE_PATH_ROOTS_ENV = "STANDUP_KNOWLEDGE_PATH_ROOTS";

const PATH_ROOT = /^\/[\w.@+-]+(?:\/[\w.@+-]+)*$/;

/**
 * The roots deriveAbsolutePaths reads a path under: the built-in ones, the
 * directory the host's home dir sits in (so a host that mounts homes under
 * `/mnt/homes` reads its own users' paths), and KNOWLEDGE_PATH_ROOTS_ENV.
 */
export function absolutePathRoots(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  const extra = (env[KNOWLEDGE_PATH_ROOTS_ENV] ?? "").split(",").map((r) => r.trim().replace(/\/+$/, ""));
  const homeParent = dirname(home);
  return [...new Set([...BUILT_IN_PATH_ROOTS, homeParent, ...extra])].filter((r) => PATH_ROOT.test(r));
}

let absolutePathPattern: { key: string; re: RegExp } | null = null;

function absolutePathRe(roots: readonly string[]): RegExp {
  const key = roots.join("\n");
  if (absolutePathPattern?.key !== key) {
    const alternatives = roots.map((r) => r.replace(/[.+]/g, "\\$&")).join("|");
    absolutePathPattern = {
      key,
      re: new RegExp(`(?:^|[\\s\`'"(])((?:${alternatives}|~)\\/[\\w.@+-]+(?:\\/[\\w.@+-]+)*)`, "g"),
    };
  }
  return absolutePathPattern.re;
}

/** Absolute filesystem paths a doc names (`/Users/…`, `/home/…`, `~/…`): a doc naming them describes a checkout, often not this one. */
export function deriveAbsolutePaths(body: string, roots: readonly string[] = absolutePathRoots()): string[] {
  const found = new Set<string>();
  for (const m of (body ?? "").matchAll(absolutePathRe(roots))) found.add(m[1]!.replace(/[.,;:)\]]+$/, ""));
  return [...found];
}

/**
 * Lines git prints for `args`, streamed and handed to `onLine` one at a time
 * so a large `grep -o` result is never buffered whole. Returns the exit code,
 * or null when git could not be spawned.
 */
export type GitLineRunner = (
  repoPath: string,
  args: string[],
  onLine: (line: string) => void
) => Promise<number | null>;

export const runGitLines: GitLineRunner = async (repoPath, args, onLine) => {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd: repoPath, stdout: "pipe", stderr: "ignore" });
    const decoder = new TextDecoder();
    let rest = "";
    for await (const chunk of proc.stdout) {
      const text = rest + decoder.decode(chunk, { stream: true });
      const lines = text.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    }
    if (rest) onLine(rest);
    await proc.exited;
    return proc.exitCode ?? -1;
  } catch {
    return null;
  }
};

/**
 * Whether `repoPath` is itself the top of a git work tree. A repo path inside
 * another checkout (a fixture directory, a vendored tree) would otherwise run
 * every git question against the enclosing repo's history, which has nothing
 * to do with the docs.
 */
export async function isRepoRoot(repoPath: string, git: GitStatusRunner = runGitStatus): Promise<boolean> {
  const r = await git(repoPath, ["rev-parse", "--show-toplevel"]);
  if (!r || r.code !== 0) return false;
  try {
    return realpathSync(r.stdout.trim()) === realpathSync(repoPath);
  } catch {
    return false;
  }
}

/** The ISO date a doc's claims stand as of — the same date the freshness gate decays it from (withConfidenceDefaults). */
export function docAnchorDate(
  doc: Pick<KnowledgeDoc, "lastVerifiedAt" | "generatedAt" | "updatedAt" | "contentFirstSeen">,
  anchorAt?: string
): string | null {
  return withConfidenceDefaults({ ...doc, anchorAt }).lastVerifiedAt ?? null;
}

/** The commit a doc is anchored to, and whether it came from the doc's own sha or its date. */
export interface DocAnchor {
  sha: string;
  from: "sha" | "date";
}

/**
 * The commit a doc's claims were last checked against: its generated_from_sha
 * when that commit is in this clone, else the last commit at or before the
 * doc's anchor date (docAnchorDate). Null when neither resolves — the doc
 * predates the repo's history, or the repo is not a git checkout — and then
 * nothing can be said about what changed since.
 */
export async function resolveDocAnchor(
  repoPath: string,
  doc: Pick<KnowledgeDoc, "generatedFromSha" | "lastVerifiedAt" | "generatedAt" | "updatedAt" | "contentFirstSeen">,
  git: GitStatusRunner = runGitStatus,
  anchorAt?: string
): Promise<DocAnchor | null> {
  if (hasProvenance(doc.generatedFromSha)) {
    const r = await git(repoPath, ["rev-parse", "-q", "--verify", `${doc.generatedFromSha}^{commit}`]);
    const sha = r && r.code === 0 ? r.stdout.trim() : "";
    if (sha) return { sha, from: "sha" };
  }
  const when = docAnchorDate(doc, anchorAt);
  if (!when) return null;
  const r = await git(repoPath, ["rev-list", "-1", `--before=${when}`, "HEAD"]);
  const sha = r && r.code === 0 ? r.stdout.trim() : "";
  return sha ? { sha, from: "date" } : null;
}

/** Commit date (ISO) of the last commit touching `path`, or null when it has none or git fails. */
export async function lastCommitDate(
  repoPath: string,
  path: string,
  git: GitStatusRunner = runGitStatus
): Promise<string | null> {
  const target = isAbsolute(path) ? path : join(repoPath, path);
  const r = await git(repoPath, ["log", "-1", "--format=%cI", "--", target]);
  const ms = r && r.code === 0 ? Date.parse(r.stdout.trim()) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Branch names treated as a repo's default branch, locally and on any remote, in preference order. */
export const DEFAULT_BRANCH_NAMES = ["main", "master", "mainline", "trunk", "develop"] as const;

/**
 * Every default-branch ref the clone has — local `main`/`master`/`mainline`/
 * `trunk`/`develop`, the same names on every remote, and each remote's HEAD
 * target — most authoritative first: the branch HEAD is on (when it is a
 * default branch), then by name preference, local before remote, then the
 * freshest. Empty when there are none, and then the unmerged check is skipped.
 */
export async function resolveDefaultRefs(
  repoPath: string,
  git: GitStatusRunner = runGitStatus
): Promise<string[]> {
  const r = await git(repoPath, [
    "for-each-ref",
    "--format=%(refname)\t%(symref)\t%(committerdate:unix)",
    "refs/heads",
    "refs/remotes",
  ]);
  if (!r || r.code !== 0) return [];
  const head = await git(repoPath, ["symbolic-ref", "-q", "HEAD"]);
  const headRef = head && head.code === 0 ? head.stdout.trim() : "";
  const shortName = (ref: string) => ref.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\/[^/]+\//, "");
  const dateOf = new Map<string, number>();
  const refs = new Set<string>();
  for (const line of r.stdout.split("\n")) {
    const [ref, symref, date] = line.split("\t");
    if (!ref) continue;
    dateOf.set(ref, Number(date) || 0);
    if (ref.endsWith("/HEAD") && symref) refs.add(symref);
    if ((DEFAULT_BRANCH_NAMES as readonly string[]).includes(shortName(ref))) refs.add(ref);
  }
  const rank = (ref: string) => {
    const name = (DEFAULT_BRANCH_NAMES as readonly string[]).indexOf(shortName(ref));
    return name === -1 ? DEFAULT_BRANCH_NAMES.length : name;
  };
  return [...refs].sort((a, b) => {
    if ((a === headRef) !== (b === headRef)) return a === headRef ? -1 : 1;
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const localA = a.startsWith("refs/heads/") ? 0 : 1;
    const localB = b.startsWith("refs/heads/") ? 0 : 1;
    if (localA !== localB) return localA - localB;
    const fresher = (dateOf.get(b) ?? 0) - (dateOf.get(a) ?? 0);
    return fresher !== 0 ? fresher : a.localeCompare(b);
  });
}

/** Max default-branch commits whose patch-ids or messages are compared when a sha is not an ancestor of a default ref. */
export const MERGE_SEARCH_WINDOW = 400;
/** Most unmerged branches whose tips are searched for symbols missing at HEAD. */
const UNMERGED_BRANCH_LIMIT = 30;
/**
 * The files of an unmerged branch whose words count as that branch's code:
 * docs, data (JSON), eval corpora and fixtures are excluded — they quote names
 * from everywhere, so a symbol found only there says nothing about what the
 * branch implements.
 */
export const BRANCH_CODE_PATHSPEC = [
  ".",
  ":(glob,exclude)**/*.md",
  ":(glob,exclude)**/*.mdx",
  ":(glob,exclude)**/*.json",
  ":(glob,exclude)**/*.jsonl",
  ":(glob,exclude)**/eval/**",
  ":(glob,exclude)**/evals/**",
  ":(glob,exclude)**/*fixture*/**",
  ":(glob,exclude)**/testdata/**",
] as const;
/** A combined diff larger than this is not patch-id'd: too big to be one squash, and too costly to hash per pass. */
const MAX_PATCH_BYTES = 2_000_000;
/** A commit subject shorter than this is too generic ("fix", "wip") to identify a squash by message. */
const MIN_SUBJECT_CHARS = 12;

/** The stable patch-ids of every patch in `diff` (one `git log -p` or `git diff` output). */
export async function patchIds(repoPath: string, diff: string): Promise<Set<string>> {
  try {
    const proc = Bun.spawn(["git", "patch-id", "--stable"], {
      cwd: repoPath,
      stdin: new Blob([diff]),
      stdout: "pipe",
      stderr: "ignore",
    });
    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return new Set(out.split("\n").map((l) => l.split(" ")[0]).filter(Boolean));
  } catch {
    return new Set();
  }
}

/** Memo tables shared by the merge checks of one pass (see RepoEvidenceContext). */
export interface MergeCheckCache {
  /** `${ref} ${mergeBase}` → patch-ids of the ref's commits since that base. */
  refPatchIds: Map<string, Promise<Set<string>>>;
}

export function newMergeCheckCache(): MergeCheckCache {
  return { refPatchIds: new Map() };
}

/** Patch-ids of up to MERGE_SEARCH_WINDOW commits on `ref` since `mergeBase`, memoized in `cache`. */
export function refPatchIdsSince(
  repoPath: string,
  ref: string,
  mergeBase: string,
  git: GitStatusRunner,
  cache: MergeCheckCache
): Promise<Set<string>> {
  const key = `${ref} ${mergeBase}`;
  let ids = cache.refPatchIds.get(key);
  if (!ids) {
    ids = (async () => {
      const log = await git(repoPath, ["log", "-p", `-n${MERGE_SEARCH_WINDOW}`, "--format=commit %H", `${mergeBase}..${ref}`]);
      if (!log || log.code !== 0 || log.stdout.length > MAX_PATCH_BYTES * 4) return new Set<string>();
      return patchIds(repoPath, log.stdout);
    })();
    cache.refPatchIds.set(key, ids);
  }
  return ids;
}

/** Most files of a patch whose added lines are looked up on the default branch. */
const MAX_PRESENCE_FILES = 50;

/**
 * Whether `ref`'s tree already holds the changes `mergeBase..sha` makes: for
 * every file the patch touches, every substantive line it adds (trimmed;
 * blank and punctuation-only lines skipped) is a line of that file at `ref`.
 * Line containment rather than a patch replay, so a commit in the middle of a
 * branch that later commits extended — then squash-merged and deleted — is
 * still recognized. A patch that only deletes, or adds nothing substantive,
 * is never judged present.
 */
export async function changesPresentIn(
  repoPath: string,
  mergeBase: string,
  sha: string,
  ref: string,
  git: GitStatusRunner
): Promise<boolean> {
  const patch = await git(repoPath, ["diff", "--no-renames", "--unified=0", mergeBase, sha]);
  if (!patch || patch.code !== 0 || !patch.stdout.trim() || patch.stdout.length > MAX_PATCH_BYTES) return false;
  const added = new Map<string, string[]>();
  let file: string | null = null;
  for (const line of patch.stdout.split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line === "+++ /dev/null" ? null : line.replace(/^\+\+\+ b\//, "");
      continue;
    }
    if (!file || !line.startsWith("+")) continue;
    const text = line.slice(1).trim();
    if (text.replace(/[\s{}()[\];,]/g, "").length === 0) continue;
    const lines = added.get(file) ?? [];
    lines.push(text);
    added.set(file, lines);
  }
  if (added.size === 0 || added.size > MAX_PRESENCE_FILES) return false;
  for (const [path, lines] of added) {
    const shown = await git(repoPath, ["show", `${ref}:${path}`]);
    if (!shown || shown.code !== 0) return false;
    const there = new Set(shown.stdout.split("\n").map((l) => l.trim()));
    if (!lines.every((l) => there.has(l))) return false;
  }
  return true;
}
/** Whether `tip`'s combined diff since its merge base with `ref` is patch-identical to one commit on `ref` (a squash merge). */
export async function squashedInto(
  repoPath: string,
  tip: string,
  ref: string,
  git: GitStatusRunner,
  cache: MergeCheckCache
): Promise<boolean> {
  const base = await git(repoPath, ["merge-base", ref, tip]);
  const mergeBase = base && base.code === 0 ? base.stdout.trim() : "";
  if (!mergeBase) return false;
  const combined = await git(repoPath, ["diff", mergeBase, tip]);
  if (!combined || combined.code !== 0 || !combined.stdout.trim() || combined.stdout.length > MAX_PATCH_BYTES) {
    return false;
  }
  const [mine] = [...(await patchIds(repoPath, combined.stdout))];
  return !!mine && (await refPatchIdsSince(repoPath, ref, mergeBase, git, cache)).has(mine);
}

/**
 * Whether `sha`'s work is on a default branch (resolveDefaultRefs). Any of:
 *
 * - a default ref contains it;
 * - every commit from the merge base to it has a patch-equivalent commit on
 *   the ref (`git cherry`, bounded by the merge base): a rebase or cherry-pick
 *   merge;
 * - it, or the tip of any other branch that contains it, was squash-merged:
 *   that tip's combined diff since the merge base is patch-identical to a
 *   commit on the ref — so a doc distilled mid-branch counts once the branch
 *   lands;
 * - its branch is gone and a commit on the ref since `sha` was made carries
 *   its subject line (a squash commit's message lists the commits it folds).
 *
 * Null when there are no default refs or git cannot answer, which is never
 * treated as unmerged. Bounded: at most MERGE_SEARCH_WINDOW commits per ref
 * are compared, and patch-ids are memoized in `cache` across a pass.
 */
export async function isOnDefaultBranch(
  repoPath: string,
  sha: string,
  defaultRefs: readonly string[],
  git: GitStatusRunner = runGitStatus,
  cache: MergeCheckCache = newMergeCheckCache()
): Promise<boolean | null> {
  if (defaultRefs.length === 0) return null;
  const containing = await git(repoPath, ["for-each-ref", "--contains", sha, "--format=%(refname)", ...defaultRefs]);
  if (!containing || containing.code !== 0) return null;
  if (containing.stdout.trim()) return true;

  const branches = await git(repoPath, ["for-each-ref", "--contains", sha, "--format=%(objectname)", "refs/heads", "refs/remotes"]);
  const tips = new Set<string>([sha]);
  if (branches && branches.code === 0) {
    for (const line of branches.stdout.split("\n")) if (line.trim()) tips.add(line.trim());
  }
  const meta = await git(repoPath, ["log", "-1", "--format=%ct%x09%s", sha]);
  const [shaTime, subject] = meta && meta.code === 0 ? meta.stdout.trim().split("\t") : ["", ""];

  for (const ref of defaultRefs) {
    const base = await git(repoPath, ["merge-base", ref, sha]);
    const mergeBase = base && base.code === 0 ? base.stdout.trim() : "";
    if (mergeBase) {
      const cherry = await git(repoPath, ["cherry", ref, sha, mergeBase]);
      const lines = cherry && cherry.code === 0 ? cherry.stdout.split("\n").filter(Boolean) : [];
      if (lines.length > 0 && lines.every((l) => l.startsWith("-"))) return true;
    }
    for (const tip of tips) {
      if (await squashedInto(repoPath, tip, ref, git, cache)) return true;
    }
    if (mergeBase && (await changesPresentIn(repoPath, mergeBase, sha, ref, git))) return true;
    if (tips.size === 1 && subject && subject.length >= MIN_SUBJECT_CHARS && shaTime) {
      const found = await git(repoPath, [
        "log",
        ref,
        `-n${MERGE_SEARCH_WINDOW}`,
        `--since=@${shaTime}`,
        "-F",
        `--grep=${subject}`,
        "--format=%H",
      ]);
      if (found && found.code === 0 && found.stdout.trim()) return true;
    }
  }
  return false;
}

/**
 * The commit a clean re-verification re-baselines a doc to: HEAD when a
 * default branch contains it, else HEAD's merge base with the most
 * authoritative default ref (resolveDefaultRefs orders them) — a commit on the
 * default branch, so the unmerged check never flags a sha the pass itself
 * wrote. HEAD when there is no default ref.
 */
export async function rebaselineSha(
  repoPath: string,
  headSha: string,
  defaultRefs: readonly string[],
  git: GitStatusRunner = runGitStatus
): Promise<string> {
  if (defaultRefs.length === 0) return headSha;
  const containing = await git(repoPath, ["for-each-ref", "--contains", headSha, "--format=%(refname)", ...defaultRefs]);
  if (containing && containing.code === 0 && containing.stdout.trim()) return headSha;
  const base = await git(repoPath, ["merge-base", defaultRefs[0], headSha]);
  const mergeBase = base && base.code === 0 ? base.stdout.trim() : "";
  return mergeBase || headSha;
}

/**
 * What an evidence pass knows about the repo, resolved once and shared across
 * a project's docs: the default refs, every path in the tree at HEAD and at
 * each anchor commit asked about, and which named symbols occur at each — one
 * scan of the checkout for every symbol any doc names, then one streamed
 * `git grep` per anchor commit for just the names missing at HEAD, not one per
 * doc.
 */
export class RepoEvidenceContext {
  readonly git: GitStatusRunner;
  private readonly lines: GitLineRunner;
  private readonly trees = new Map<string, Promise<Set<string> | null>>();
  private readonly symbolSets = new Map<string, Promise<Set<string> | null>>();

  constructor(
    readonly repoPath: string,
    readonly defaultRefs: readonly string[],
    /** Every symbol the pass will ask about, grepped together once per commit. */
    readonly symbols: readonly string[],
    opts: { git?: GitStatusRunner; lines?: GitLineRunner; driftThreshold?: number } = {}
  ) {
    this.git = opts.git ?? runGitStatus;
    this.lines = opts.lines ?? runGitLines;
    this.driftThreshold = opts.driftThreshold ?? FILE_SCOPED_STALENESS_THRESHOLD_COMMITS;
  }

  readonly driftThreshold: number;

  /** Every path in the tree at `commit` (relative to the repo path), or null when git fails. */
  treeAt(commit: string): Promise<Set<string> | null> {
    let tree = this.trees.get(commit);
    if (!tree) {
      tree = (async () => {
        const out = new Set<string>();
        const code = await this.lines(this.repoPath, ["ls-tree", "-r", "--name-only", commit], (l) => {
          if (l) out.add(l);
        });
        return code === 0 ? out : null;
      })();
      this.trees.set(commit, tree);
    }
    return tree;
  }

  /** Which of the pass's symbols occur as whole words in the tracked tree at `commit`, or null when git fails. */
  symbolsAt(commit: string): Promise<Set<string> | null> {
    let found = this.symbolSets.get(commit);
    if (!found) {
      found = (async () => {
        // HEAD is answered from the checked-out tracked files; any other commit
        // is only ever asked about names missing at HEAD, so only those are
        // grepped there.
        if (commit === "HEAD") return this.symbolsInCheckout();
        const atHead = await this.symbolsAt("HEAD");
        if (!atHead) return null;
        const names = this.symbols.filter((s) => !atHead.has(s));
        if (names.length === 0) return new Set<string>();
        const out = new Set<string>();
        const args = ["grep", "-F", "-w", "-o", "-h", "-I"];
        for (const sym of names) args.push("-e", sym);
        const code = await this.lines(this.repoPath, [...args, commit, "--", "."], (l) => {
          if (l) out.add(l.trim());
        });
        // Exit 1 is git grep's "no match", an answer rather than a failure.
        return code === 0 || code === 1 ? out : null;
      })();
      this.symbolSets.set(commit, found);
    }
    return found;
  }

  /**
   * Which of the pass's symbols occur as whole words in the checked-out tracked
   * files. Tokenized in-process: `git grep -F -w` with hundreds of patterns
   * takes tens of seconds on a mid-sized repo, reading the files once does not.
   * Files over MAX_SCANNED_FILE_BYTES and binary files are skipped.
   */
  private async symbolsInCheckout(): Promise<Set<string> | null> {
    const wanted = new Set(this.symbols);
    const out = new Set<string>();
    if (wanted.size === 0) return out;
    const files: string[] = [];
    const code = await this.lines(this.repoPath, ["ls-files"], (l) => {
      if (l) files.push(l);
    });
    if (code !== 0) return null;
    for (const file of files) {
      if (out.size === wanted.size) break;
      const handle = Bun.file(join(this.repoPath, file));
      if (handle.size > MAX_SCANNED_FILE_BYTES) continue;
      let text: string;
      try {
        text = await handle.text();
      } catch {
        continue;
      }
      if (text.includes("\0")) continue;
      for (const m of text.matchAll(WORD_RE)) if (wanted.has(m[0])) out.add(m[0]);
    }
    return out;
  }

  private readonly merged = new Map<string, Promise<boolean | null>>();
  private readonly mergeCache = newMergeCheckCache();

  private unmergedSymbolsMemo: Promise<Map<string, string>> | null = null;

  /**
   * The pass's symbols that are missing at HEAD but present in the code
   * (BRANCH_CODE_PATHSPEC) on the tip of a branch no default branch has
   * merged, each with that branch's name (the UNMERGED_BRANCH_LIMIT most
   * recently committed such branches are checked, one grep per branch). A
   * branch whose tip was squash-merged is skipped: `--no-merged` still lists
   * it, but its work is on the default branch. A doc that names one describes work that never
   * landed — the unmerged-claim case for a doc with no sha of its own.
   */
  unmergedSymbols(): Promise<Map<string, string>> {
    if (!this.unmergedSymbolsMemo) {
      this.unmergedSymbolsMemo = (async () => {
        const found = new Map<string, string>();
        const atHead = await this.symbolsAt("HEAD");
        if (!atHead || this.defaultRefs.length === 0) return found;
        const missing = this.symbols.filter((s) => !atHead.has(s));
        if (missing.length === 0) return found;
        const branches = await this.git(this.repoPath, [
          "for-each-ref",
          "--sort=-committerdate",
          `--count=${UNMERGED_BRANCH_LIMIT}`,
          `--no-merged=${this.defaultRefs[0]}`,
          "--format=%(refname)",
          "refs/heads",
          "refs/remotes",
        ]);
        if (!branches || branches.code !== 0) return found;
        for (const ref of branches.stdout.split("\n").map((l) => l.trim())) {
          if (!ref || ref.endsWith("/HEAD") || this.defaultRefs.includes(ref)) continue;
          const wanted = missing.filter((s) => !found.has(s));
          if (wanted.length === 0) break;
          if (await this.isSquashMerged(ref)) continue;
          const args = ["grep", "-F", "-w", "-o", "-h", "-I"];
          for (const sym of wanted) args.push("-e", sym);
          await this.lines(this.repoPath, [...args, ref, "--", ...BRANCH_CODE_PATHSPEC], (l) => {
            const sym = l.trim();
            if (sym && !found.has(sym)) found.set(sym, ref.replace(/^refs\/(?:heads|remotes)\//, ""));
          });
        }
        return found;
      })();
    }
    return this.unmergedSymbolsMemo;
  }

  /** Whether branch `ref`'s tip was squash-merged into any default ref (squashedInto). */
  private async isSquashMerged(ref: string): Promise<boolean> {
    for (const target of this.defaultRefs) {
      if (await squashedInto(this.repoPath, ref, target, this.git, this.mergeCache)) return true;
    }
    return false;
  }

  /** isOnDefaultBranch for `sha`, memoized: docs distilled in one session share a sha. */
  isMerged(sha: string): Promise<boolean | null> {
    let known = this.merged.get(sha);
    if (!known) {
      known = isOnDefaultBranch(this.repoPath, sha, this.defaultRefs, this.git, this.mergeCache);
      this.merged.set(sha, known);
    }
    return known;
  }

  /** A context over `docs`: their default refs and the union of the symbols they name. */
  static async forDocs(
    repoPath: string,
    docs: readonly Pick<KnowledgeDoc, "body">[],
    opts: { git?: GitStatusRunner; lines?: GitLineRunner; driftThreshold?: number } = {}
  ): Promise<RepoEvidenceContext> {
    const symbols = new Set<string>();
    for (const d of docs) for (const s of deriveNamedSymbols(d.body)) symbols.add(s);
    const defaultRefs = await resolveDefaultRefs(repoPath, opts.git);
    return new RepoEvidenceContext(repoPath, defaultRefs, [...symbols].sort(), opts);
  }
}

/** A doc's content date: when it says it was last verified, else when it was written, else when the index first saw its body. File times are not content. */
export function contentDate(doc: Pick<KnowledgeDoc, "lastVerifiedAt" | "generatedAt" | "contentFirstSeen">): number {
  for (const c of [doc.lastVerifiedAt, doc.generatedAt, doc.contentFirstSeen]) {
    const ms = c ? Date.parse(c) : NaN;
    if (Number.isFinite(ms)) return ms;
  }
  return NaN;
}

/**
 * The deterministic findings against one doc (see ConfidenceEvidenceKind),
 * computed from git alone:
 *
 * - missing-path / missing-symbol: a path or symbol the doc names that was in
 *   the tree at the doc's anchor and is not at HEAD. A name that was not in the
 *   tree at the anchor is not evidence — the doc may describe another
 *   codebase, a runtime builtin, or something planned — so a doc is held only
 *   to the names its anchor commit shows it was written against.
 * - file-drift: at least the file-scoped threshold of commits touching the
 *   doc's named paths since the anchor. Raises re-verification priority only.
 * - unmerged: a generated_from_sha present in this clone whose work no default
 *   branch contains (isOnDefaultBranch). A sha absent from the clone is not
 *   judged: an unfetched clone would make every newer merged sha look unmerged.
 *   Only for a doc with no sha at all: a named symbol missing at HEAD that
 *   exists only in the code of an unmerged branch
 *   (RepoEvidenceContext.unmergedSymbols). A doc with a sha is judged by its
 *   sha alone — a merged sha means its work landed.
 * - contradicted-by-newer: a recorded `Contradicts <slug>` dispute whose
 *   counterpart (looked up in `peers` by `project/slug`) has a later content
 *   date (last verified, else written) than this doc. File times are ignored:
 *   a re-mirror or sync touches them without changing what the doc says.
 *
 * `anchorAt` is the date the doc stands as of when something knows better than
 * its file time (a repo mirror's source commit). Every git failure degrades to
 * "no finding": evidence only ever lowers confidence, so an unanswered
 * question must not.
 */
export async function computeDocEvidence(
  ctx: RepoEvidenceContext,
  doc: KnowledgeDoc,
  peers: ReadonlyMap<string, KnowledgeDoc> = new Map(),
  anchorAt?: string
): Promise<ConfidenceEvidence[]> {
  const git = ctx.git;
  const evidence: ConfidenceEvidence[] = [];
  const paths = deriveNamedPaths(doc.body);
  const symbols = deriveNamedSymbols(doc.body);
  const anchor =
    paths.length > 0 || symbols.length > 0 || hasProvenance(doc.generatedFromSha)
      ? await resolveDocAnchor(ctx.repoPath, doc, git, anchorAt)
      : null;

  if (anchor && (paths.length > 0 || symbols.length > 0)) {
    const [treeAtHead, symbolsAtHead] = await Promise.all([ctx.treeAt("HEAD"), ctx.symbolsAt("HEAD")]);
    const missingPaths = treeAtHead ? paths.filter((p) => !treeAtHead.has(p)) : [];
    const missingSymbols = symbolsAtHead ? symbols.filter((s) => !symbolsAtHead.has(s)) : [];
    if (missingPaths.length > 0) {
      const then = await ctx.treeAt(anchor.sha);
      const gone = then ? missingPaths.filter((p) => then.has(p)) : [];
      if (gone.length > 0) evidence.push({ kind: "missing-path", detail: gone.join(", ") });
    }
    if (missingSymbols.length > 0) {
      const then = await ctx.symbolsAt(anchor.sha);
      const gone = then ? missingSymbols.filter((s) => then.has(s)) : [];
      if (gone.length > 0) evidence.push({ kind: "missing-symbol", detail: gone.join(", ") });
    }
    if (paths.length > 0) {
      const r = await git(ctx.repoPath, ["rev-list", "--count", `${anchor.sha}..HEAD`, "--", ...paths]);
      const commits = r && r.code === 0 ? parseInt(r.stdout.trim(), 10) : NaN;
      if (Number.isFinite(commits) && commits >= ctx.driftThreshold) {
        evidence.push({
          kind: "file-drift",
          detail: `${commits} commits to ${paths.join(", ")} since ${anchor.sha.slice(0, 12)}`,
        });
      }
    }
  }

  if (anchor?.from === "sha" && (await ctx.isMerged(anchor.sha)) === false) {
    evidence.push({ kind: "unmerged", detail: `${anchor.sha.slice(0, 12)} is on no default branch` });
  } else if (!hasProvenance(doc.generatedFromSha) && symbols.length > 0) {
    const onlyOnBranches = await ctx.unmergedSymbols();
    const claimed = symbols.filter((s) => onlyOnBranches.has(s));
    if (claimed.length > 0) {
      evidence.push({
        kind: "unmerged",
        detail: claimed.map((s) => `${s} only on ${onlyOnBranches.get(s)}`).join(", "),
      });
    }
  }

  const ownDate = contentDate(doc);
  const newer: string[] = [];
  for (const dispute of contradictionDisputes(doc)) {
    const target = parseContradictsClaim(dispute.claim);
    if (!target) continue;
    const peer = peers.get(target.includes("/") ? target : `${doc.projectId}/${target}`);
    const peerDate = peer ? contentDate(peer) : NaN;
    if (Number.isFinite(peerDate) && Number.isFinite(ownDate) && peerDate > ownDate) newer.push(target);
  }
  if (newer.length > 0) evidence.push({ kind: "contradicted-by-newer", detail: newer.join(", ") });

  return evidence;
}

/**
 * Whether the model re-verification pass can usefully fact-check this doc
 * against the project's repo. A doc with provenance (generated_from_sha) was
 * distilled from this repo. Otherwise the doc must be ABOUT this repo: it names
 * repo-relative paths and absolute paths, and most of them resolve in the tree
 * at HEAD. A doc that names none, or mostly names paths absent from this repo
 * (another service, another checkout), describes something the repo cannot
 * confirm — a fact-check would only "refute" it for not being here.
 */
export function isAboutRepo(doc: Pick<KnowledgeDoc, "body" | "generatedFromSha">, treeAtHead: ReadonlySet<string>): boolean {
  if (hasProvenance(doc.generatedFromSha)) return true;
  const relative = deriveNamedPaths(doc.body);
  const absolute = deriveAbsolutePaths(doc.body);
  const named = relative.length + absolute.length;
  if (named === 0) return false;
  const present = relative.filter((p) => treeAtHead.has(p)).length;
  return present * 2 > named;
}
