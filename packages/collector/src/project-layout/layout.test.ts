import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { testTempDir } from "../test-support/temp-dirs.js";
import { gitProjectLayout, resolveProjectLayout, unreadWorkingDirs, unreadWorkingDirsWarning, workspaceProjectLayout } from "./layout.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A working dir with `packages` as subdirs of `packagesDir`, each with a .git dir unless named in `bare`. */
function workdir(packagesDir: string, packages: string[], opts: { bare?: string[]; rootGit?: boolean } = {}): string {
  const root = testTempDir("standup-layout-");
  dirs.push(root);
  for (const name of packages) {
    mkdirSync(join(root, packagesDir, name), { recursive: true });
    if (!opts.bare?.includes(name)) mkdirSync(join(root, packagesDir, name, ".git"));
  }
  if (opts.rootGit) mkdirSync(join(root, ".git"));
  return root;
}

describe("gitProjectLayout — the built-in default", () => {
  test("the working dir is the one checkout, read against the launch's base", () => {
    expect(gitProjectLayout.checkouts({ worktreePath: "/wt", provisioned: false, baseBranch: "develop" })).toEqual([
      { path: "/wt", label: "", baseBranch: "develop" },
    ]);
    const repo = workdir("packages", [], { rootGit: true });
    expect(gitProjectLayout.checkouts({ worktreePath: repo, provisioned: true, baseBranch: "develop" })).toEqual([
      { path: repo, label: "", baseBranch: "develop" },
    ]);
    expect(gitProjectLayout.workspaceMarker).toBeNull();
  });

  test("a provisioned working dir that isn't a git repo holds no checkout it reads", () => {
    const workspace = workdir("src", ["api"]);
    expect(gitProjectLayout.checkouts({ worktreePath: workspace, provisioned: true, baseBranch: "main" })).toEqual([]);
  });
});

describe("working dirs the layout reads no checkout in", () => {
  test("are the provisioned dirs on disk that aren't git repos, under the git layout", () => {
    const workspace = workdir("src", ["api"]);
    const repo = workdir("packages", [], { rootGit: true });
    const gone = join(workspace, "no-such-dir");
    expect(unreadWorkingDirs(gitProjectLayout, [workspace, repo, gone])).toEqual([workspace]);
    expect(unreadWorkingDirs(workspaceProjectLayout({ packagesDir: "src" }), [workspace, repo, gone])).toEqual([]);
  });

  test("the boot warning names them and the settings a workspace needs", () => {
    expect(unreadWorkingDirsWarning(gitProjectLayout, [])).toBeNull();
    const warning = unreadWorkingDirsWarning(gitProjectLayout, ["/a", "/b", "/c", "/d"])!;
    expect(warning).toContain("4 provisioned working dir(s)");
    expect(warning).toContain("/a, /b, /c and 1 more");
    for (const knob of ["STANDUP_PROJECT_LAYOUT=workspace", "STANDUP_WORKSPACE_PACKAGES_DIR", "STANDUP_WORKSPACE_MARKER", "STANDUP_WORKSPACE_FALLBACK_BASE"]) {
      expect(warning).toContain(knob);
    }
  });
});

describe("workspaceProjectLayout", () => {
  test("a provisioned working dir that is no repo holds its packages dir's checkouts, sorted", () => {
    const root = workdir("packages", ["web", "api"]);
    const checkouts = workspaceProjectLayout().checkouts({ worktreePath: root, provisioned: true, baseBranch: "main" });
    expect(checkouts.map((c) => [c.label, c.baseBranch, c.fallbackBase])).toEqual([
      ["packages/api", "origin/HEAD", "origin/main"],
      ["packages/web", "origin/HEAD", "origin/main"],
    ]);
    expect(checkouts.every((c) => typeof c.gitDirId === "string")).toBe(true);
  });

  test("its packages dir and fallback base are configurable", () => {
    const root = workdir("src", ["PkgA"]);
    const [c] = workspaceProjectLayout({ packagesDir: "src/", fallbackBase: "origin/trunk" }).checkouts({ worktreePath: root, provisioned: true, baseBranch: "main" });
    expect(c).toMatchObject({ path: join(root, "src", "PkgA"), label: "src/PkgA", fallbackBase: "origin/trunk" });
  });

  test("a dir that isn't a checkout is still listed, a plain file is not", () => {
    const root = workdir("packages", ["real", "loose"], { bare: ["loose"] });
    writeFileSync(join(root, "packages", "README"), "x\n");
    symlinkSync(join(root, "nowhere"), join(root, "packages", "dangling"));
    const labels = workspaceProjectLayout().checkouts({ worktreePath: root, provisioned: true, baseBranch: "main" }).map((c) => c.label);
    expect(labels).toEqual(["packages/dangling", "packages/loose", "packages/real"]);
  });

  test("a working dir that is a repo, or a launch that wasn't provisioned, is one checkout", () => {
    const repo = workdir("packages", ["x"], { rootGit: true });
    const layout = workspaceProjectLayout();
    expect(layout.checkouts({ worktreePath: repo, provisioned: true, baseBranch: "main" })).toEqual([{ path: repo, label: "", baseBranch: "main" }]);
    const plain = workdir("packages", ["x"]);
    expect(layout.checkouts({ worktreePath: plain, provisioned: false, baseBranch: "main" })).toEqual([{ path: plain, label: "", baseBranch: "main" }]);
  });

  test("a workspace with no packages dir has no checkouts", () => {
    const root = workdir("other", ["x"]);
    expect(workspaceProjectLayout().checkouts({ worktreePath: root, provisioned: true, baseBranch: "main" })).toEqual([]);
  });

  test("its marker is what names a workspace root", () => {
    expect(workspaceProjectLayout().workspaceMarker).toBeNull();
    expect(workspaceProjectLayout({ marker: ".workspace" }).workspaceMarker).toBe(".workspace");
  });
});

describe("resolveProjectLayout", () => {
  const cases: Array<[string, Record<string, string | undefined>, string, string | null, number]> = [
    ["unset is git", {}, "git", null, 0],
    ["explicit git", { STANDUP_PROJECT_LAYOUT: "git" }, "git", null, 0],
    ["workspace", { STANDUP_PROJECT_LAYOUT: "workspace", STANDUP_WORKSPACE_MARKER: ".workspace" }, "workspace", ".workspace", 0],
    ["unknown falls back to git", { STANDUP_PROJECT_LAYOUT: "monorepo" }, "git", null, 1],
    ["a packages dir that climbs out falls back to git", { STANDUP_PROJECT_LAYOUT: "workspace", STANDUP_WORKSPACE_PACKAGES_DIR: "../x" }, "git", null, 1],
    ["a marker that is a path falls back to git", { STANDUP_PROJECT_LAYOUT: "workspace", STANDUP_WORKSPACE_MARKER: "a/b" }, "git", null, 1],
  ];
  for (const [name, env, id, marker, warnings] of cases) {
    test(name, () => {
      const warned: string[] = [];
      const layout = resolveProjectLayout(env, (m) => warned.push(m));
      expect(layout.id).toBe(id);
      expect(layout.workspaceMarker).toBe(marker);
      expect(warned).toHaveLength(warnings);
    });
  }
});
