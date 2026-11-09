import { createHash } from "crypto";
import { existsSync, realpathSync } from "fs";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { internalRoot } from "./internal-cwd.js";
import { codeReviewRemote } from "./code-review/adapter.js";

/**
 * The tree a knowledge doc is fact-checked against: its repository's default
 * branch as the remote has it now, or as the local default branch has it when
 * that is strictly ahead (newestMainline) — never a checkout's HEAD. A checkout
 * can hold a worker's unmerged branch (which would pass a doc describing that
 * work) or remote-tracking refs fetched days ago (which would dispute a doc
 * about what has merged since). So each check fetches `origin/<default>` and
 * reads that commit, or the local `<default>` ahead of it: the working tree of
 * a private clone for the model verifier, and `git show` / `git grep` at the
 * commit for the mechanical checks on its
 * findings. A repository whose mainline cannot be refreshed is not checked.
 * The default branch is asked of the remote (`ls-remote` from the private
 * clone); the source's own origin/HEAD, which can be stale, is only a fallback.
 *
 * The source repository is only ever read (`rev-parse`, `symbolic-ref`,
 * `remote get-url`); nothing is fetched into it or checked out from it. Each
 * source repository has one persistent private clone under
 * `<internal root>/verify-mainline/`, made with `--shared` so it borrows the
 * source's objects through alternates instead of copying them, with `origin`
 * pointed at the source's own origin. A check fetches the default branch into
 * that clone and checks it out there, so later checks are incremental. Should
 * the source drop objects the clone borrows (a gc), the clone is deleted and
 * made again once.
 */

/** How long one fetch of a repository's mainline serves later checks. */
export const MAINLINE_FETCH_CACHE_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 60_000;
const CHECKOUT_TIMEOUT_MS = 180_000;
const GIT_TIMEOUT_MS = 20_000;
/** How long a whole-tree search or listing at a commit may take. */
const SEARCH_TIMEOUT_MS = 60_000;
/** Default branch names tried, in order, when neither the remote nor origin/HEAD names one. */
const DEFAULT_BRANCH_CANDIDATES = ["mainline", "main", "master"];

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs `git <args>` non-interactively, killed after `timeoutMs`. */
export type GitRun = (args: string[], timeoutMs?: number) => Promise<GitResult>;

export const runGit: GitRun = async (args, timeoutMs = GIT_TIMEOUT_MS) => {
  const proc = Bun.spawn(["git", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" },
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exitCode = await proc.exited;
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
};

/** Fetches `branch` from origin into the private clone whose git directory is
 *  `gitDir`, leaving it at FETCH_HEAD; null on success, else the error. */
export type MainlineFetch = (gitDir: string, branch: string) => Promise<string | null>;

export function gitFetch(git: GitRun): MainlineFetch {
  return async (gitDir, branch) => {
    const res = await git(
      ["--git-dir", gitDir, "fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
      FETCH_TIMEOUT_MS
    );
    return res.exitCode === 0 ? null : res.stderr.trim() || `exit ${res.exitCode}`;
  };
}

/** The outcome of one refresh of a private clone: the default branch, the ref
 *  read (`origin/<branch>`, or the local `<branch>` when it is ahead) and the
 *  commit it checked out, or why it could not. */
type CloneSync = { branch: string; ref: string; sha: string; local: string | null } | { error: string };

export interface MainlineDeps {
  git?: GitRun;
  fetch?: MainlineFetch;
  now?: () => number;
  /** Refresh results by private clone, shared across checks. */
  cache?: Map<string, { at: number; result: Promise<CloneSync> }>;
  /** The directory private clones live in; `<internal root>/verify-mainline` by default. */
  cloneRoot?: string;
}

const sharedFetchCache = new Map<string, { at: number; result: Promise<CloneSync> }>();

/** The directory holding one private clone per source repository. */
export function defaultCloneRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(internalRoot(env), "verify-mainline");
}

/** The private clone for the source repository whose shared git directory is `gitDir`. */
export function privateClonePath(gitDir: string, cloneRoot: string = defaultCloneRoot()): string {
  let real = gitDir;
  try {
    real = realpathSync(gitDir);
  } catch {
    // An unresolvable path keys on its spelling.
  }
  return join(cloneRoot, createHash("sha1").update(real).digest("hex"));
}

const cloneLocks = new Map<string, Promise<void>>();

/** Waits for exclusive use of the private clone at `clone`; the returned
 *  function gives it up. */
async function lockClone(clone: string): Promise<() => void> {
  const prior = cloneLocks.get(clone) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const tail = prior.then(() => held);
  cloneLocks.set(clone, tail);
  await prior;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
    if (cloneLocks.get(clone) === tail) cloneLocks.delete(clone);
  };
}

/** A repository's freshly fetched mainline commit. */
export interface MainlineRef {
  /** The checkout the doc was resolved to. */
  repo: string;
  /** The top of that checkout's work tree. */
  toplevel: string;
  /** Where `repo` sits inside the work tree ("" at the top, else ending in "/"). */
  prefix: string;
  /** The private clone the commit is checked out in. */
  clone: string;
  /** The private clone's git directory, which `readAtRef` / `foundAtRef` / `pathAtRef` read. */
  gitDir: string;
  /** The ref read: the remote-tracking ref, e.g. `origin/main`, or the local default branch, e.g. `main`, when it is ahead. */
  ref: string;
  sha: string;
}

export type MainlineRefresh = { ok: true; ref: MainlineRef } | { ok: false; reason: string };

/** The reason recorded on a doc whose repository's mainline could not be refreshed. */
export function mainlineRefreshReason(repo: string, detail: string): string {
  return `unverifiable: could not refresh mainline of ${repo} (${detail})`;
}

async function gitLine(git: GitRun, args: string[]): Promise<string | null> {
  const res = await git(args);
  return res.exitCode === 0 ? res.stdout.trim() : null;
}

/**
 * The default branch of origin, asked of the remote itself from the private
 * clone at `cloneGitDir` (`ls-remote`, which writes nothing). Only when the
 * remote cannot be asked is it read from the source repository's own refs at
 * `sourceGitDir`: its origin/HEAD, which may be stale, else the first
 * candidate it has.
 */
async function defaultBranch(git: GitRun, cloneGitDir: string, sourceGitDir: string): Promise<string | null> {
  const remote = await git(["--git-dir", cloneGitDir, "ls-remote", "--symref", "origin", "HEAD"], FETCH_TIMEOUT_MS);
  const match = remote.exitCode === 0 ? /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(remote.stdout) : null;
  if (match?.[1]) return match[1];
  const head = await gitLine(git, ["--git-dir", sourceGitDir, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (head?.startsWith("refs/remotes/origin/")) return head.slice("refs/remotes/origin/".length);
  for (const name of DEFAULT_BRANCH_CANDIDATES) {
    if ((await git(["--git-dir", sourceGitDir, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}`])).exitCode === 0) {
      return name;
    }
  }
  return null;
}

function firstLine(res: GitResult): string {
  return (res.stderr.trim() || `exit ${res.exitCode}`).split("\n")[0]!;
}

/** Makes the private clone of the source repository at `sourceGitDir` afresh,
 *  with `origin` at `url`; null on success, else the error. */
async function makeClone(git: GitRun, sourceGitDir: string, clone: string, url: string): Promise<string | null> {
  await rm(clone, { recursive: true, force: true });
  await mkdir(join(clone, ".."), { recursive: true });
  const made = await git(["clone", "--quiet", "--no-checkout", "--shared", "--no-tags", sourceGitDir, clone], FETCH_TIMEOUT_MS);
  if (made.exitCode !== 0) return `git clone failed: ${firstLine(made)}`;
  const set = await git(["--git-dir", join(clone, ".git"), "remote", "set-url", "origin", url]);
  return set.exitCode === 0 ? null : `git remote set-url failed: ${firstLine(set)}`;
}

/** Whether `clone` is a usable private clone, with `origin` pointed at `url`
 *  (re-pointed when the source's origin has moved). */
async function cloneUsable(git: GitRun, clone: string, url: string): Promise<boolean> {
  if (!existsSync(join(clone, ".git"))) return false;
  const gitDir = join(clone, ".git");
  if ((await git(["--git-dir", gitDir, "rev-parse", "--git-dir"])).exitCode !== 0) return false;
  if ((await gitLine(git, ["--git-dir", gitDir, "remote", "get-url", "origin"])) === url) return true;
  return (await git(["--git-dir", gitDir, "remote", "set-url", "origin", url])).exitCode === 0;
}

/** Checks `target` out, detached and forced, in the private clone's working
 *  tree, with untracked files removed; null on success, else the error. The
 *  git dir and work tree are both explicit so a clone missing its `.git` can
 *  never fall through to an enclosing repository. */
async function checkoutClone(git: GitRun, clone: string, target: string): Promise<string | null> {
  const gitDir = join(clone, ".git");
  if (!existsSync(gitDir)) return "private clone has no .git";
  const base = ["-c", "core.hooksPath=/dev/null", "--git-dir", gitDir, "--work-tree", clone, "-C", clone];
  const co = await git([...base, "checkout", "--quiet", "--detach", "--force", target], CHECKOUT_TIMEOUT_MS);
  if (co.exitCode !== 0) return `git checkout failed: ${firstLine(co)}`;
  const clean = await git([...base, "clean", "-ffdxq"], CHECKOUT_TIMEOUT_MS);
  return clean.exitCode === 0 ? null : `git clean failed: ${firstLine(clean)}`;
}

/** The source repository's local `branch` commit, or null when it has none. */
function localTip(git: GitRun, sourceGitDir: string, branch: string): Promise<string | null> {
  return gitLine(git, ["--git-dir", sourceGitDir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
}

/**
 * The commit to read once origin's `branch` is fetched (FETCH_HEAD in the
 * private clone): the source's local `branch` when it holds everything origin
 * has and more, else the fetched commit (null). A host that merges into its
 * local default branch and never pushes, so that origin falls far behind,
 * would otherwise have every doc about work merged since disputed as naming
 * files that "don't exist". A local
 * branch that is behind or has diverged from origin is not read: its extra
 * commits are not on the remote's mainline. Nor is one whose origin is on a
 * code-review host (codeReviewRemote): there a change is pushed only once its
 * review is approved, so local commits ahead of origin are work still in
 * review. The local commit's
 * objects are the source's, which the clone borrows through alternates.
 */
async function newestMainline(
  git: GitRun,
  cloneGitDir: string,
  sourceGitDir: string,
  branch: string,
  url: string
): Promise<{ ref: string; sha: string } | null> {
  if (codeReviewRemote(url)) return null;
  const local = await localTip(git, sourceGitDir, branch);
  const fetched = await gitLine(git, ["--git-dir", cloneGitDir, "rev-parse", "--verify", "--quiet", "FETCH_HEAD^{commit}"]);
  if (!local || !fetched || local === fetched) return null;
  const ahead = await git(["--git-dir", cloneGitDir, "merge-base", "--is-ancestor", fetched, local]);
  return ahead.exitCode === 0 ? { ref: branch, sha: local } : null;
}

/**
 * Resolves origin's default branch, fetches it into the private clone and
 * checks it out, making the clone first when it is missing or unusable. A
 * failed fetch or checkout in a clone that already existed deletes it and
 * makes it again once, since the cause may be objects the source has since
 * dropped.
 */
async function syncClone(
  git: GitRun,
  fetch: MainlineFetch,
  sourceGitDir: string,
  clone: string,
  url: string
): Promise<CloneSync> {
  let reused = await cloneUsable(git, clone, url);
  for (;;) {
    if (!reused) {
      const made = await makeClone(git, sourceGitDir, clone, url);
      if (made !== null) return { error: made };
    }
    const branch = await defaultBranch(git, join(clone, ".git"), sourceGitDir);
    if (!branch) return { error: "no default branch on origin" };
    const fetchError = await fetch(join(clone, ".git"), branch).catch((err) => String(err));
    const local = await localTip(git, sourceGitDir, branch);
    const target = fetchError === null ? await newestMainline(git, join(clone, ".git"), sourceGitDir, branch, url) : null;
    const ref = target?.ref ?? `origin/${branch}`;
    const error =
      fetchError !== null
        ? `git fetch origin ${branch} failed: ${fetchError.split("\n")[0]}`
        : await checkoutClone(git, clone, target?.sha ?? "FETCH_HEAD");
    if (error === null) {
      const sha = await gitLine(git, ["--git-dir", join(clone, ".git"), "rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
      return sha ? { branch, ref, sha, local } : { error: `${ref} did not resolve after the fetch` };
    }
    if (!reused) return { error };
    reused = false;
  }
}

/**
 * Fetches the default branch of the repository `repo` is a checkout of into
 * that repository's private clone, checks it out there, and resolves the
 * commit. The source repository is only read. One refresh per repository
 * serves every check for MAINLINE_FETCH_CACHE_MS, and checks of one
 * repository take turns with its clone.
 */
export async function refreshMainline(repo: string, deps: MainlineDeps = {}): Promise<MainlineRefresh> {
  const git = deps.git ?? runGit;
  const toplevel = await gitLine(git, ["-C", repo, "rev-parse", "--show-toplevel"]);
  if (!toplevel) return { ok: false, reason: "not a git checkout" };
  const prefix = (await gitLine(git, ["-C", repo, "rev-parse", "--show-prefix"])) ?? "";
  const sourceGitDir = await gitLine(git, ["-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!sourceGitDir) return { ok: false, reason: "no git directory" };
  const url = await gitLine(git, ["--git-dir", sourceGitDir, "remote", "get-url", "origin"]);
  if (!url) return { ok: false, reason: "no origin remote" };

  const clone = privateClonePath(sourceGitDir, deps.cloneRoot);
  const cache = deps.cache ?? sharedFetchCache;
  const release = await lockClone(clone);
  let outcome: CloneSync;
  try {
    const now = (deps.now ?? Date.now)();
    let entry = cache.get(clone);
    // A merge into the local default branch since the last refresh moves the
    // tree read (newestMainline), so it ends the cached refresh early.
    const prior = entry ? await entry.result.catch(() => null) : null;
    const localMoved = !!prior && "branch" in prior && (await localTip(git, sourceGitDir, prior.branch)) !== prior.local;
    if (!entry || localMoved || now - entry.at >= MAINLINE_FETCH_CACHE_MS) {
      entry = { at: now, result: syncClone(git, deps.fetch ?? gitFetch(git), sourceGitDir, clone, url) };
      cache.set(clone, entry);
    }
    outcome = await entry.result.catch((err): CloneSync => ({ error: String(err) }));
  } finally {
    release();
  }
  if ("error" in outcome) return { ok: false, reason: outcome.error };
  return {
    ok: true,
    ref: { repo, toplevel, prefix, clone, gitDir: join(clone, ".git"), ref: outcome.ref, sha: outcome.sha },
  };
}

/** A mainline commit checked out in its private clone, held for one check. */
export interface MainlineSnapshot {
  ref: MainlineRef;
  /** The checkout's work-tree root: the private clone. */
  root: string;
  /** The path matching the resolved checkout (`root` + prefix). */
  dir: string;
}

/** The snapshots of one check, and the hold on their clones it releases. */
export interface MainlineSnapshots {
  /** One per ref, in order: null where the commit could not be checked out. */
  snapshots: Array<MainlineSnapshot | null>;
  close: () => void;
}

/**
 * Holds each ref's private clone at the ref's commit for one check: no other
 * check of the same repository moves the working tree until `close`. Clones
 * are taken in path order, so checks spanning several repositories cannot
 * deadlock; refs sharing a clone share one hold.
 */
export async function openSnapshots(refs: readonly MainlineRef[], deps: MainlineDeps = {}): Promise<MainlineSnapshots> {
  const git = deps.git ?? runGit;
  const clones = [...new Set(refs.map((r) => r.clone))].sort();
  const releases: Array<() => void> = [];
  for (const clone of clones) releases.push(await lockClone(clone));
  const close = () => releases.forEach((release) => release());
  try {
    const snapshots: Array<MainlineSnapshot | null> = [];
    for (const ref of refs) {
      // Even at the right commit the working tree may hold edits or untracked
      // files left by an earlier check, so it is always reset and cleaned.
      const ready = (await checkoutClone(git, ref.clone, ref.sha)) === null;
      snapshots.push(ready ? { ref, root: ref.clone, dir: ref.prefix ? join(ref.clone, ref.prefix) : ref.clone } : null);
    }
    return { snapshots, close };
  } catch (err) {
    close();
    throw err;
  }
}

/** The text of `path` (relative to the work-tree root) at the ref, or null. */
export async function readAtRef(ref: MainlineRef, path: string, deps: MainlineDeps = {}): Promise<string | null> {
  const git = deps.git ?? runGit;
  const res = await git(["--git-dir", ref.gitDir, "show", `${ref.sha}:${path}`]);
  return res.exitCode === 0 ? res.stdout : null;
}

/** Whether a search at a ref found its target, did not, or could not tell
 *  (git failed or timed out). */
export type Presence = "present" | "absent" | "unknown";

/** Whether `text` occurs anywhere in the tree at the ref. `git grep` exits 1
 *  for no match; any other failure, or a timeout, is `unknown`. */
export async function foundAtRef(ref: MainlineRef, text: string, deps: MainlineDeps = {}): Promise<Presence> {
  const git = deps.git ?? runGit;
  const res = await git(["--git-dir", ref.gitDir, "grep", "-q", "-F", "-e", text, ref.sha, "--"], SEARCH_TIMEOUT_MS);
  return res.exitCode === 0 ? "present" : res.exitCode === 1 ? "absent" : "unknown";
}

/**
 * Whether a file or directory `path` (relative to the work-tree root, or a
 * trailing part of such a path) exists in the tree at the ref: an exact
 * `cat-file -e`, else any tracked path equal to it, ending in `/<path>`, or
 * lying under such a directory. A failed listing is `unknown`.
 */
export async function pathAtRef(ref: MainlineRef, path: string, deps: MainlineDeps = {}): Promise<Presence> {
  const git = deps.git ?? runGit;
  const rel = path.replace(/^\.\//, "").replace(/\/+$/, "");
  if (!rel) return "unknown";
  if ((await git(["--git-dir", ref.gitDir, "cat-file", "-e", `${ref.sha}:${rel}`])).exitCode === 0) return "present";
  const listing = await git(["--git-dir", ref.gitDir, "ls-tree", "-r", "--name-only", "-z", ref.sha], SEARCH_TIMEOUT_MS);
  if (listing.exitCode !== 0) return "unknown";
  const found = listing.stdout
    .split("\0")
    .some((name) => name === rel || name.endsWith(`/${rel}`) || name.startsWith(`${rel}/`) || name.includes(`/${rel}/`));
  return found ? "present" : "absent";
}
