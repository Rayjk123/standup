import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import type { Launch } from "@standup/shared";

/**
 * The project-layout seam: what a launch's working dir is made of — which git
 * checkouts it holds (whose changes the pipeline reads, each against its own
 * base) and which dir, if any, is the root of a multi-checkout workspace (the
 * safety floor treats a job root inside one as the whole workspace).
 *
 * The built-in default is `gitProjectLayout`: the working dir is one git
 * repository — the launch's worktree, or the repo itself in place — read
 * against the launch's base branch. `workspaceProjectLayout` is a generic
 * monorepo-of-checkouts layout: a provisioned working dir that isn't a git
 * repo holds its checkouts as subdirs of one packages dir, each read against
 * its remote's default branch.
 */

/** One git checkout in a launch's working dir. */
export interface LaunchCheckout {
  path: string;
  /** Its dir relative to the working dir, prefixed to its changed files ("" for the working dir itself). */
  label: string;
  /** What its changes are read against. */
  baseBranch: string | undefined;
  /** What they are read against when `baseBranch` doesn't resolve. */
  fallbackBase?: string;
  /** Its git dir's inode and birth time, which tell a re-clone at the same commit apart; set for a workspace checkout. */
  gitDirId?: string;
}

export interface ProjectLayout {
  /** `git`, `workspace`, or a custom layout's id. */
  readonly id: string;
  /**
   * A file whose presence marks a dir as the root of a multi-checkout
   * workspace; null when the layout has no workspaces (a job root is never
   * widened to an enclosing dir).
   */
  readonly workspaceMarker: string | null;
  /** The git checkouts `launch`'s working dir holds. Empty when a workspace has none, or can't be listed. */
  checkouts(launch: Pick<Launch, "worktreePath" | "provisioned" | "baseBranch">): LaunchCheckout[];
}

/**
 * The built-in default: the working dir is one git repository, read against
 * the launch's base branch. A provisioned working dir that isn't a git repo
 * (a multi-checkout workspace, which this layout doesn't read) holds no
 * checkout here, so reading its changes fails rather than reading a dir git
 * doesn't know.
 */
export const gitProjectLayout: ProjectLayout = {
  id: "git",
  workspaceMarker: null,
  checkouts: (launch) =>
    launch.provisioned && !existsSync(join(launch.worktreePath, ".git")) ? [] : [{ path: launch.worktreePath, label: "", baseBranch: launch.baseBranch }],
};

/**
 * The working dirs among `dirs` (provisioned launches') that `layout` reads
 * no checkout in: under the git layout, a dir on disk that isn't a git repo.
 * At boot these are named in a warning, since an install that provisions
 * multi-checkout workspaces needs the workspace layout (resolveProjectLayout).
 */
export function unreadWorkingDirs(layout: ProjectLayout, dirs: readonly string[]): string[] {
  return dirs.filter((dir) => existsSync(dir) && layout.checkouts({ worktreePath: dir, provisioned: true, baseBranch: undefined }).length === 0);
}

/** The boot warning for unreadWorkingDirs' result, or null when there are none. */
export function unreadWorkingDirsWarning(layout: ProjectLayout, unread: readonly string[]): string | null {
  if (unread.length === 0) return null;
  const shown = unread.slice(0, 3).join(", ");
  const more = unread.length > 3 ? ` and ${unread.length - 3} more` : "";
  return (
    `[project-layout] ${unread.length} provisioned working dir(s) hold no checkout the ${layout.id} layout reads (${shown}${more}): ` +
    "their changed files can't be read, so their pipeline stages fail. A workspace of several git checkouts needs " +
    "STANDUP_PROJECT_LAYOUT=workspace, with STANDUP_WORKSPACE_PACKAGES_DIR (the dir holding the checkouts), " +
    "STANDUP_WORKSPACE_MARKER (the file marking the workspace root) and STANDUP_WORKSPACE_FALLBACK_BASE (the base when a remote has no default branch)."
  );
}

/** A workspace layout's settings (see workspaceProjectLayout). */
export interface WorkspaceLayoutOptions {
  /** The dir, relative to the working dir, whose subdirs are the checkouts (default `packages`). */
  packagesDir?: string;
  /** The file marking a workspace root (WorkspaceLayout.workspaceMarker); none by default. */
  marker?: string;
  /** What a checkout is read against when its remote has no default branch (default `origin/main`). */
  fallbackBase?: string;
}

/**
 * A provisioned working dir that isn't itself a git repo holds its checkouts
 * as the subdirs of `packagesDir`. Each is read against its remote's default
 * branch (`origin/HEAD`, which a clone sets), or `fallbackBase` when the
 * remote has no default, so work committed on the local branch it was cloned
 * on still shows as changed files. A checkout may be a symlink to the real
 * one. Anything else under the packages dir but a plain file — a dir that
 * isn't a git checkout, a broken link — is listed too, so reading it fails
 * rather than its files going unread. A working dir that is a git repo, or a
 * launch that wasn't provisioned, is one checkout as in the git layout.
 */
export function workspaceProjectLayout(opts: WorkspaceLayoutOptions = {}): ProjectLayout {
  const packagesDir = opts.packagesDir?.replace(/^\/+|\/+$/g, "") || "packages";
  const fallbackBase = opts.fallbackBase || "origin/main";
  return {
    id: "workspace",
    workspaceMarker: opts.marker || null,
    checkouts(launch) {
      const root = launch.worktreePath;
      if (!launch.provisioned || existsSync(join(root, ".git"))) return gitProjectLayout.checkouts(launch);
      let names: string[];
      try {
        names = readdirSync(join(root, packagesDir)).sort();
      } catch {
        return [];
      }
      return names.flatMap((name) => {
        const path = join(root, packagesDir, name);
        const checkout: LaunchCheckout = { path, label: `${packagesDir}/${name}`, baseBranch: "origin/HEAD", fallbackBase };
        try {
          if (statSync(path).isFile()) return [];
          const gitDir = statSync(join(path, ".git"));
          return [{ ...checkout, gitDirId: `${gitDir.ino}.${gitDir.birthtimeMs}` }];
        } catch {
          return [checkout];
        }
      });
    },
  };
}

/** The layout kinds resolveProjectLayout knows. */
export const PROJECT_LAYOUT_KINDS = ["git", "workspace"] as const;

/**
 * The configured project layout: STANDUP_PROJECT_LAYOUT — `git` (the
 * default) or `workspace`, which takes STANDUP_WORKSPACE_PACKAGES_DIR,
 * STANDUP_WORKSPACE_MARKER and STANDUP_WORKSPACE_FALLBACK_BASE (see
 * WorkspaceLayoutOptions). An unknown kind resolves to `git` with a warning.
 */
export function resolveProjectLayout(
  env: Record<string, string | undefined> = process.env,
  warn: (message: string) => void = (m) => console.warn(m)
): ProjectLayout {
  const kind = env.STANDUP_PROJECT_LAYOUT?.trim().toLowerCase() || "git";
  if (kind === "git") return gitProjectLayout;
  if (kind === "workspace") {
    const packagesDir = env.STANDUP_WORKSPACE_PACKAGES_DIR?.trim();
    if (packagesDir && (packagesDir.startsWith("/") || packagesDir.split("/").includes(".."))) {
      warn(`[project-layout] STANDUP_WORKSPACE_PACKAGES_DIR must be a relative dir without ".."; using the git layout`);
      return gitProjectLayout;
    }
    const marker = env.STANDUP_WORKSPACE_MARKER?.trim();
    if (marker && !/^[\w.-]+$/.test(marker)) {
      warn(`[project-layout] STANDUP_WORKSPACE_MARKER must be a file name; using the git layout`);
      return gitProjectLayout;
    }
    return workspaceProjectLayout({
      ...(packagesDir ? { packagesDir } : {}),
      ...(marker ? { marker } : {}),
      ...(env.STANDUP_WORKSPACE_FALLBACK_BASE?.trim() ? { fallbackBase: env.STANDUP_WORKSPACE_FALLBACK_BASE.trim() } : {}),
    });
  }
  warn(`[project-layout] unknown STANDUP_PROJECT_LAYOUT "${kind}"; using git (known: ${PROJECT_LAYOUT_KINDS.join(", ")})`);
  return gitProjectLayout;
}

let active: ProjectLayout | undefined;

/** The collector's project layout, resolved once from the environment. */
export function activeProjectLayout(): ProjectLayout {
  active ??= resolveProjectLayout();
  return active;
}

/** Replaces the collector's project layout (a test's), or with no argument drops it so the next read resolves again. */
export function setActiveProjectLayout(layout?: ProjectLayout): void {
  active = layout;
}
