/**
 * Which branch a launch's worktree is cut from, for repos whose default
 * branch isn't `main` (an older default, or another name some repos use). The project's `branch` setting is a default-filled column (`main`
 * when the project never set one), so it can't be trusted to name a branch
 * the repo has: it wins only when it resolves, and the repo itself decides
 * otherwise.
 */
import { existsSync } from "fs";

/** Runs `git <args>` in `cwd`; its trimmed stdout, or null when git fails (review/stage.ts GitRunner). */
export type BaseBranchGit = (args: string[], cwd: string) => string | null;

/** The conventional default-branch names, in the order they are tried. */
export const DEFAULT_BRANCH_NAMES = ["main", "mainline", "master"] as const;

export type BaseBranchSource = "configured" | "current" | "origin-head" | "fallback";

export interface BaseBranch {
  /** The branch name recorded as the launch's base, e.g. `main`. */
  branch: string;
  /** The commit-ish `git worktree add` starts from: `branch`, or `origin/<branch>` when only the remote copy exists. */
  ref: string;
  source: BaseBranchSource;
  /** Set when the configured branch was skipped: why, for the launch log. */
  note?: string;
}

/** Whether `dir` is inside a git work tree. */
export function isGitWorkTree(dir: string, git: BaseBranchGit): boolean {
  return git(["rev-parse", "--is-inside-work-tree"], dir) === "true";
}

function isCommit(dir: string, ref: string, git: BaseBranchGit): boolean {
  if (!ref || ref.startsWith("-")) return false;
  return git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], dir) !== null;
}

/** `name` as a ref this repo has: the local branch, else `origin/<name>`; null when neither exists. */
function refFor(dir: string, name: string, git: BaseBranchGit): string | null {
  if (isCommit(dir, `refs/heads/${name}`, git)) return name;
  if (isCommit(dir, `refs/remotes/origin/${name}`, git)) return `origin/${name}`;
  return null;
}

/** The branch `origin/HEAD` points at (`trunk` for `origin/trunk`), or null when it is unset. */
function originHead(dir: string, git: BaseBranchGit): string | null {
  const target = git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], dir);
  if (!target?.startsWith("origin/")) return null;
  const name = target.slice("origin/".length);
  return name && name !== "HEAD" ? name : null;
}

/**
 * The base to record for a launch that reuses an existing tree (in-place, a
 * fixer's reused worktree) or builds its own (a provision command): the
 * configured branch when `dir` has it, else whatever resolveBaseBranch
 * picks there, else the configured branch unchanged. Never throws, because
 * these launches don't cut a worktree from the base.
 */
export function recordedBaseBranch(dir: string, configured: string, git: BaseBranchGit): string {
  try {
    return dir && existsSync(dir) ? resolveBaseBranch(dir, configured, git).branch : configured;
  } catch {
    return configured;
  }
}

/**
 * The base for a new worktree of `repo`. In order:
 * 1. the project's configured branch, when the repo has it (a name, its
 *    `origin/` form, or any other commit-ish such as a tag);
 * 2. the branch `origin/HEAD` names;
 * 3. the first of main, mainline, master that exists;
 * 4. the repo's checked-out branch, last because a checkout is often on its
 *    owner's own topic branch, which a new launch must not inherit.
 * Throws an error naming every step that failed, with the fix, when none
 * resolves (a detached HEAD in a repo with no remote and no conventional
 * branch, for one).
 */
export function resolveBaseBranch(
  repo: string,
  configured: string | undefined,
  git: BaseBranchGit,
  projectId?: string
): BaseBranch {
  if (!isGitWorkTree(repo, git)) {
    throw new Error(`Not a git repository: ${repo}`);
  }
  const wanted = configured?.trim();
  const tried: string[] = [];
  if (wanted) {
    const name = wanted.startsWith("origin/") ? wanted.slice("origin/".length) : wanted;
    const ref = refFor(repo, name, git);
    if (ref) return { branch: name, ref, source: "configured" };
    if (isCommit(repo, wanted, git)) return { branch: wanted, ref: wanted, source: "configured" };
    tried.push(`the configured branch "${wanted}" does not exist (locally or on origin)`);
  }
  const skipped = wanted ? `configured branch "${wanted}" does not exist in ${repo}` : undefined;
  const withNote = (base: Omit<BaseBranch, "note">): BaseBranch => (skipped ? { ...base, note: skipped } : base);

  const head = originHead(repo, git);
  const headRef = head ? refFor(repo, head, git) : null;
  if (head && headRef) return withNote({ branch: head, ref: headRef, source: "origin-head" });
  tried.push(head ? `origin/HEAD names "${head}", which does not resolve` : "it has no origin/HEAD");

  for (const name of DEFAULT_BRANCH_NAMES) {
    const ref = refFor(repo, name, git);
    if (ref) return withNote({ branch: name, ref, source: "fallback" });
  }
  tried.push(`none of ${DEFAULT_BRANCH_NAMES.join(", ")} exist`);

  const current = git(["symbolic-ref", "--quiet", "--short", "HEAD"], repo);
  if (current && isCommit(repo, `refs/heads/${current}`, git)) {
    return withNote({ branch: current, ref: current, source: "current" });
  }
  tried.push(current ? `its checked-out branch "${current}" has no commits` : "its HEAD is detached");

  const where = projectId ? `project "${projectId}"'s` : "the project's";
  throw new Error(
    `Cannot pick a base branch for ${repo}: ${tried.join("; ")}. ` +
      `Set ${where} branch to one the repo has (Projects → Edit, or branch = "<name>" in projects.toml), ` +
      `or check out a branch in ${repo}.`
  );
}
