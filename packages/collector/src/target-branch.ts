import type { GitRunner } from "./review/stage.js";

/** The branch name used when nothing configured or readable names one. */
export const FALLBACK_BRANCH = "main";

/**
 * The branch work merges into, read in a checkout: `local` is the branch
 * checked out and merged into there (e.g. `main`), `remote` the
 * remote-tracking ref it lands in upstream (`origin/main`, or `origin/trunk`
 * when that `main` tracks it). The two can differ in name, so neither is derived from
 * the other by prefixing `origin/`.
 */
export interface TargetBranch {
  local: string;
  remote: string;
}

/**
 * The local target branch: the configured one, else the checkout's
 * `main` when it has one, else the branch `origin/HEAD` names, else `main`.
 */
export function localTargetBranch(dir: string | null | undefined, configured: string | null | undefined, git: GitRunner): string {
  const named = typeof configured === "string" ? configured.trim() : "";
  if (named) return named;
  if (!dir) return FALLBACK_BRANCH;
  if (git(["rev-parse", "--verify", "--quiet", `refs/heads/${FALLBACK_BRANCH}^{commit}`], dir) !== null) return FALLBACK_BRANCH;
  const head = originHead(dir, git);
  return head ? head.slice("origin/".length) : FALLBACK_BRANCH;
}

/**
 * The target branch of checkout `dir` (localTargetBranch) and the remote ref
 * it lands in: the local branch's upstream when that is on `origin`, else
 * `origin/<local>` when it exists, else — for `main` only, the branch
 * nothing else named — `origin/HEAD`'s branch, else `origin/<local>` (which
 * then resolves to nothing). Any other local branch never falls back to
 * `origin/HEAD`: work merged into the remote default branch has not landed
 * in it. A name starting with `-` is never handed to git; its refs are
 * returned as named.
 */
export function resolveTargetBranch(dir: string | null | undefined, configured: string | null | undefined, git: GitRunner): TargetBranch {
  const local = localTargetBranch(dir, configured, git);
  const named = `origin/${local}`;
  if (!dir || local.startsWith("-")) return { local, remote: named };
  const upstream = git(["rev-parse", "--symbolic-full-name", `${local}@{upstream}`], dir);
  if (upstream?.startsWith("refs/remotes/origin/")) return { local, remote: upstream.slice("refs/remotes/".length) };
  if (git(["rev-parse", "--verify", "--quiet", `refs/remotes/${named}^{commit}`], dir) !== null) return { local, remote: named };
  return { local, remote: (local === FALLBACK_BRANCH ? originHead(dir, git) : null) ?? named };
}

/**
 * The branch `origin/HEAD` points at, as `origin/<name>`, or null — also when
 * that branch is gone, which `symbolic-ref` alone still names.
 */
function originHead(dir: string, git: GitRunner): string | null {
  const ref = git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], dir);
  if (!ref?.startsWith("refs/remotes/origin/")) return null;
  if (git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], dir) === null) return null;
  return ref.slice("refs/remotes/".length);
}
