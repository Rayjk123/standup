import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * A commit in a repository under a temp dir that has its own `.git` dir and
 * no remote, with `git -c` settings that only name the author or committer
 * (or the first branch of a new repository, or turn signing off), can't
 * publish its branch, so it isn't outward even when that branch is named
 * like a shared one. Settings that give the repository a remote, an
 * upstream, an include, hooks or a program to run, a repository with a
 * remote, one outside the temp dirs, and every push still hold; hooks the
 * floor can't read (a template dir, a copied file) are unread and run. The
 * machine is virtual.
 */

const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const COMMON = join(INSTALL, ".git");

/** A freshly initialized repository under the temp dir: its own `.git` dir, branch master, no remote. */
const SCRATCH = join("/", "tmp", "scratch");
/** A temp dir with files that isn't a repository yet. */
const PLAIN = join("/", "tmp", "r6-scratch");
/** A temp-dir repository with a remote. */
const REMOTED = join("/", "tmp", "remoted");
/** A temp-dir repository with no remote whose hooks dir holds hooks that push. */
const HOOKED = join("/", "tmp", "hooked");
/** A temp-dir repository with no remote whose only hook is a `pre-auto-gc` that pushes. */
const GC_HOOKED = join("/", "tmp", "gc-hooked");
/** A repository outside the temp dirs with its own `.git` dir and no remote. */
const ELSEWHERE = join("/", "srv", "repo");

const LOCAL_CONFIG = "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n";
const PUSHING_HOOK = "#!/bin/sh\ngit push https://example.com/x.git master\n";

const config: FloorConfig = {
  v: 1,
  collectorUrl: "http://127.0.0.1:17777",
  launchId: "launch-1",
  root: ROOT,
  sharedBranches: ["main", "mainline"],
  personalAwsAccounts: [],
  waitSeconds: 60,
  standupDataDir: DATA,
  floorPaths: [join(INSTALL, "packages", "collector", "src", "floor")],
  installDir: INSTALL,
  protectedPaths: [join(DATA, "secrets")],
  tmpDirs: ["/tmp"],
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
};

interface Repo {
  top: string;
  gitfile?: string;
  common: string;
  branch: string;
  config: string | null;
}

const REPOS: Repo[] = [
  { top: ROOT, gitfile: `gitdir: ${COMMON}/worktrees/feat-1\n`, common: COMMON, branch: "standup/feat-1", config: null },
  { top: INSTALL, common: COMMON, branch: "main", config: null },
  { top: SCRATCH, common: join(SCRATCH, ".git"), branch: "master", config: LOCAL_CONFIG },
  { top: REMOTED, common: join(REMOTED, ".git"), branch: "master", config: `${LOCAL_CONFIG}[remote "origin"]\n\turl = https://example.com/x.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n` },
  { top: HOOKED, common: join(HOOKED, ".git"), branch: "master", config: LOCAL_CONFIG },
  { top: GC_HOOKED, common: join(GC_HOOKED, ".git"), branch: "master", config: LOCAL_CONFIG },
  { top: ELSEWHERE, common: join(ELSEWHERE, ".git"), branch: "master", config: LOCAL_CONFIG },
];

const FILES: Record<string, string> = {
  [join(INSTALL, ".git", "config")]: `${LOCAL_CONFIG}[remote "origin"]\n\turl = ssh://git.example.com/standup\n`,
  [join(COMMON, "HEAD")]: "ref: refs/heads/main\n",
  [join(COMMON, "refs", "heads", "main")]: `${"a".repeat(40)}\n`,
  [join(PLAIN, "f")]: "a\n",
  [join(SCRATCH, "f")]: "a\n",
  [join(HOOKED, ".git", "hooks", "post-commit")]: PUSHING_HOOK,
  [join(HOOKED, ".git", "hooks", "reference-transaction")]: PUSHING_HOOK,
  [join(GC_HOOKED, ".git", "hooks", "pre-auto-gc")]: PUSHING_HOOK,
};
for (const r of REPOS) {
  if (r.gitfile) FILES[join(r.top, ".git")] = r.gitfile;
  if (r.config !== null && !FILES[join(r.common, "config")]) FILES[join(r.common, "config")] = r.config;
  FILES[join(r.common, "HEAD")] = `ref: refs/heads/${r.branch}\n`;
}

/** Repositories whose hooks dir the floor finds; HOOKED's and GC_HOOKED's always are. */
let hooked = new Set<string>();
/** Env vars of the process classifying; each test starts with none. */
let env: Record<string, string> = {};
beforeEach(() => {
  hooked = new Set([HOOKED, GC_HOOKED]);
  env = {};
});

function repoOf(dir: string): Repo | null {
  let best: Repo | null = null;
  for (const r of REPOS) if ((dir === r.top || dir.startsWith(`${r.top}/`)) && (!best || r.top.length > best.top.length)) best = r;
  return best;
}

function probes(): Partial<FloorProbes> {
  const dirs = new Set<string>(["/", "/tmp", PLAIN, join(HOOKED, ".git", "hooks"), join(GC_HOOKED, ".git", "hooks")]);
  for (const r of REPOS) {
    dirs.add(r.top);
    if (!r.gitfile) dirs.add(r.common);
  }
  for (const f of [...Object.keys(FILES), ...dirs]) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  for (const r of REPOS) if (r.gitfile) dirs.delete(join(r.top, ".git"));
  const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
  parseShellSnapshot("", defs);
  const present = (p: string) => p in FILES || dirs.has(p);
  return {
    gitBranch: (dir) => repoOf(dir)?.branch ?? null,
    gitAlias: () => null,
    gitHooksDir: (dir) => {
      const r = repoOf(dir);
      return r && hooked.has(r.top) ? join(r.common, "hooks") : null;
    },
    gitCommonDir: (dir) => repoOf(dir)?.common ?? null,
    readFile: (p) => (p in FILES ? { ok: true, text: FILES[p]! } : { ok: false, reason: "missing" }),
    exists: present,
    isDirectory: (p) => dirs.has(p),
    listDir: (p) => {
      if (!dirs.has(p)) return null;
      const names = [...Object.keys(FILES), ...dirs].filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!);
      return [...new Set(names)];
    },
    realpath: (p) => (present(p) ? p : null),
    lstat: (p) => (p in FILES ? { symlink: false, file: true, nlink: 1 } : dirs.has(p) ? { symlink: false, file: false, nlink: 2 } : null),
    homeDir: () => HOME,
    shellDefinitions: () => defs,
    awsAccount: () => null,
    now: () => Date.now(),
    env: (name) => env[name],
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

function bash(command: string, cwd = ROOT): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, config, probes());
}

function expectAllowed(v: FloorVerdict): void {
  expect(v).toEqual({ action: "allow" });
}

function expectHeld(v: FloorVerdict, category: string): void {
  expect(v).toMatchObject({ action: "hold", category });
}

/** Held as outward, or as something stronger that names the outward step too. */
function expectOutward(v: FloorVerdict): void {
  expect(v.action).toBe("hold");
  const held = v as { category: string; reason: string };
  expect(held.category === "outward" || held.reason.includes("outward:")).toBe(true);
}

describe("a commit in a temp-dir repository with no remote", () => {
  test.each([
    `cd ${PLAIN} && git init -q && git add . && git commit -qm init`,
    `git -C ${SCRATCH} commit -m x`,
    `git init /tmp/s && cd /tmp/s && echo a > f && git add f && git -c user.name=t -c user.email=t@t commit -m a`,
    `cd ${SCRATCH} && git add f && git commit -m a`,
  ])("allows %p, as before", (command) => {
    expectAllowed(bash(command));
  });

  test.each([
    `cd ${SCRATCH} && git -c user.name=t -c user.email=t@t commit -m a`,
    `git -C ${SCRATCH} -c user.name=t -c user.email=t@t commit -m a`,
    `git -c user.name=t -c user.email=t@t -C ${SCRATCH} commit -qm a`,
    `cd ${SCRATCH} && echo b > f && git add f && git -c user.name=t -c user.email=t@t commit -m b`,
    `git -C ${SCRATCH} -c User.Name=t -c USER.EMAIL=t@t commit --allow-empty -m a`,
    `git -C ${SCRATCH} -c commit.gpgsign=false commit -m a`,
    `git -C ${SCRATCH} -c user.name=t -c user.email=t@t -c commit.gpgSign=false commit -m a`,
    `git -C ${SCRATCH} -c color.ui=never -c advice.detachedHead=false commit -m a`,
    `git -C ${SCRATCH} --no-pager -c user.name=t commit -m a`,
    `mkdir -p /tmp/s2 && cd /tmp/s2 && git init -q && git checkout -b main && git -c user.name=t -c user.email=t@t commit -m a`,
    `git init -q /tmp/s2 && git -C /tmp/s2 checkout -b main && git -C /tmp/s2 -c user.name=t -c user.email=t@t commit -m a`,
    `git -c init.defaultBranch=main init -q /tmp/s3 && git -C /tmp/s3 checkout -b main && git -C /tmp/s3 commit -m a`,
    `git -c init.defaultBranch=main init -q /tmp/s3 && git -C /tmp/s3 checkout -b main && git -C /tmp/s3 -c user.name=t -c user.email=t@t commit -m a`,
  ])("allows %p, whose -c settings only name who commits", (command) => {
    expectAllowed(bash(command));
  });

  test("allows the same from the repository itself", () => {
    expectAllowed(bash("git -c user.name=t -c user.email=t@t commit -m a", SCRATCH));
  });
});

describe("a commit that can still publish or run what the floor doesn't read", () => {
  test.each([
    `git -C ${SCRATCH} -c user.name=t -c remote.origin.url=https://example.com/x.git commit -m a`,
    `git -C ${SCRATCH} -c user.name=t -c branch.master.remote=origin commit -m a`,
    `git -C ${SCRATCH} -c user.name=t -c url.https://example.com/.pushInsteadOf=x: commit -m a`,
    `git -C ${SCRATCH} -c user.name=t -c include.path=/tmp/x commit -m a`,
    `git -C ${SCRATCH} -c user.name=t -c includeIf.onbranch:master.path=/tmp/x commit -m a`,
    `git -C ${SCRATCH} -c user.name=t -c core.hooksPath=/tmp/hk commit -m a`,
    `git -C ${SCRATCH} -c core.worktree=/tmp/elsewhere -c user.name=t commit -m a`,
    `git -C ${SCRATCH} -c core.bare=false -c user.name=t commit -m a`,
    `git -C ${SCRATCH} -c commit.gpgsign=true commit -m a`,
    `git -C ${SCRATCH} -c commit.gpgsign commit -m a`,
    `git -C ${SCRATCH} -c gpg.program=/tmp/evil -c commit.gpgsign=false commit -m a`,
    `git -C ${SCRATCH} -c user.name.x=t commit -m a`,
    `git -C ${SCRATCH} -c "user.name =t" commit -m a`,
    `git -C ${SCRATCH} --config-env=user.name=U commit -m a`,
    `git -C ${SCRATCH} -c user.name=t --bare commit -m a`,
    `git -C ${SCRATCH} -c user.name=t --git-dir=${COMMON} commit -m a`,
    `git -C ${SCRATCH} -c user.name=t --work-tree=${SCRATCH} commit -m a`,
    `git -C ${SCRATCH} -c user.name=t --namespace=x commit -m a`,
    `git -C ${SCRATCH} -c user.name=t --literal-pathspecs commit -m a`,
  ])("holds %p", (command) => {
    expectOutward(bash(command));
  });

  test("a -c value the floor can't read holds", () => {
    expect(bash(`v=$(cat /tmp/kv); git -C ${SCRATCH} -c "$v" commit -m a`).action).toBe("hold");
    expect(bash(`git -C ${SCRATCH} -c user.name=$(whoami) commit -m a`).action).toBe("hold");
  });

  test("hooks configured through the environment or config hold", () => {
    expectHeld(bash(`cd ${SCRATCH} && GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/tmp/hk git -c user.name=t commit -m a`), "outward");
    expectHeld(bash(`GIT_CONFIG_PARAMETERS="'core.hookspath'='/tmp/hk'" git -C ${SCRATCH} -c user.name=t commit -m a`), "outward");
    expectOutward(bash(`cd ${SCRATCH} && git config core.hooksPath /tmp/hk && git -c user.name=t commit -m a`));
    // An identity set in the scratch repository's own config gives it no remote or hook.
    expectAllowed(bash(`cd ${SCRATCH} && git config user.name t && git -c user.email=t@t commit -m a`));
    expectOutward(bash(`cd ${SCRATCH} && git config remote.origin.url https://example.com/x.git && git -c user.email=t@t commit -m a`));
    env = { GIT_CONFIG_GLOBAL: "/tmp/gc" };
    expectOutward(bash(`git -C ${SCRATCH} -c user.name=t commit -m a`));
  });

  test("hooks written into the repository earlier in the command hold when they push", () => {
    expect(bash(`cd ${SCRATCH} && printf '#!/bin/sh\\ngit push https://example.com/x.git\\n' > .git/hooks/post-commit && chmod +x .git/hooks/post-commit && git -c user.name=t commit -m a`).action).toBe("hold");
    expectOutward(bash(`cd ${SCRATCH} && echo '[remote "o"]' >> .git/config && git -c user.name=t commit -qm x`));
  });

  test("a hook copied in from a file the floor can't read is unread, and runs", () => {
    expect(bash(`git init -q /tmp/s4 && cp /tmp/hook /tmp/s4/.git/hooks/post-commit && git -C /tmp/s4 -c user.name=t commit -m a`)).toEqual({ action: "allow" });
  });

  test("hooks already in the repository's hooks dir are read", () => {
    expectHeld(bash(`git -C ${HOOKED} -c user.name=t -c user.email=t@t commit -m a`), "outward");
    expectHeld(bash(`git -C ${HOOKED} commit -m a`), "outward");
  });

  test.each([
    `git -C ${GC_HOOKED} -c user.name=t -c user.email=t@t commit -m a`,
    `git -C ${GC_HOOKED} commit --no-verify -m a`,
    `git -C ${GC_HOOKED} merge topic`,
    `git -C ${GC_HOOKED} rebase topic`,
    `git -C ${GC_HOOKED} am /tmp/p.patch`,
    `git -C ${GC_HOOKED} cherry-pick topic`,
    `git -C ${GC_HOOKED} pull /tmp/other master`,
  ])("the pre-auto-gc hook auto maintenance runs is read for %p", (command) => {
    expectOutward(bash(command));
  });

  // A fetch and a revert end with auto maintenance too, and a fetch updates refs.
  test.each([`git -C ${GC_HOOKED} fetch /tmp/other`, `git -C ${GC_HOOKED} revert --no-edit HEAD`, `git -C ${HOOKED} fetch /tmp/other master`])(
    "the hooks %p runs are read",
    (command) => {
      expectOutward(bash(command));
    },
  );

  // Hooks copied from a template dir the floor doesn't read run in the new repository (clone's post-checkout at once), unread.
  test.each([
    `git clone --template=/tmp/t /tmp/other /tmp/z`,
    `git clone --template /tmp/t /tmp/other /tmp/z`,
    `git -c init.templateDir=/tmp/t clone /tmp/other /tmp/z`,
    `git -c init.templatedir=/tmp/t init -q /tmp/z`,
    `git init --template /tmp/t /tmp/z`,
    `git init -q --template=/tmp/t /tmp/z`,
    `GIT_TEMPLATE_DIR=/tmp/t git clone /tmp/other /tmp/z`,
    `export GIT_TEMPLATE_DIR=/tmp/t; git init -q /tmp/z`,
  ])("allows %p, whose unseen code is unread", (command) => {
    expect(bash(command)).toEqual({ action: "allow" });
  });

  test("a -c gc.auto setting is not one that only names who commits", () => {
    expectOutward(bash(`git -C ${SCRATCH} -c user.name=t -c gc.auto=1 commit -m a`));
    expectOutward(bash(`git -C ${SCRATCH} -c gc.auto=0 commit -m a`));
  });

  test("a repository with a remote, outside the temp dirs, or the worktree's holds", () => {
    expectHeld(bash(`git -C ${REMOTED} -c user.name=t -c user.email=t@t commit -m a`), "outward");
    expectHeld(bash(`git -C ${ELSEWHERE} -c user.name=t -c user.email=t@t commit -m a`), "outward");
    expectHeld(bash(`cd ${REMOTED} && git init -q && git -c user.name=t commit -qm x`), "outward");
    expectOutward(bash(`git -C ${INSTALL} -c user.name=t commit -m a`));
  });

  test("a cd into a dir the init may not have made may leave the shell where it was", () => {
    // `git init /tmp/s` can fail, and the `cd` after it with it: the commit then runs in the cwd, here a checkout on a shared branch.
    expectOutward(bash(`git init /tmp/s && cd /tmp/s && git -c user.name=t commit -m a`, INSTALL));
  });

  test("a repository relinked earlier in the command holds", () => {
    expectOutward(bash(`cd ${SCRATCH} && git remote add origin https://example.com/x.git && git -c user.name=t commit -qm x`));
    expectOutward(bash(`cd ${SCRATCH} && printf 'gitdir: ${COMMON}/worktrees/x\\n' > .git && git -c user.name=t commit -qm x`));
    expectOutward(bash(`rm -rf ${SCRATCH}/.git && ln -s ${COMMON} ${SCRATCH}/.git && git -C ${SCRATCH} -c user.name=t commit -qm x`));
    expectOutward(bash(`git -C ${SCRATCH} mv f .git/config && git -C ${SCRATCH} -c user.name=t commit -qm x`));
    expectOutward(bash(`git init -q /tmp/z && git -C /tmp/z remote add fork https://example.com/x.git && git -C /tmp/z checkout -b main && git -C /tmp/z -c user.name=t commit -qm x`));
    expectOutward(bash(`git -c user.name=t init -q --template=/tmp/t /tmp/z && git -C /tmp/z checkout -b main && git -C /tmp/z commit -qm x`));
  });

  test("an init with settings beyond who commits and the first branch doesn't make a repository of the command's own", () => {
    expectOutward(bash(`git -c core.hooksPath=/tmp/hk init -q /tmp/z && git -C /tmp/z checkout -b main && git -C /tmp/z commit -qm x`));
    expectOutward(bash(`git -c core.bare=true init -q /tmp/z && git -C /tmp/z checkout -b main && git -C /tmp/z commit -qm x`));
    expectOutward(bash(`git -c remote.origin.url=https://example.com/x.git init -q /tmp/z && git -C /tmp/z checkout -b main && git -C /tmp/z commit -qm x`));
  });

  test("a step run alongside the commit may relink the repository", () => {
    const v = bash(`git -C ${SCRATCH} -c user.name=t commit -qm x & printf 'gitdir: ${COMMON}/worktrees/x\\n' > ${SCRATCH}/.git; wait`);
    expectOutward(v);
    expect((v as { reason: string }).reason).toContain("a step run alongside it may change");
  });

  test("a commit in code a runner executes holds", () => {
    expect(bash(`cd ${SCRATCH} && sh -c 'git -c user.name=t commit -m a'`).action).toBe("allow");
    expect(bash(`cd ${SCRATCH} && node -e 'require("child_process").execSync("git -c user.name=t commit -m a")'`).action).toBe("hold");
  });

  test("every push from the temp-dir repository to somewhere it can reach still holds", () => {
    // With no remote anywhere, a push with no destination has nowhere to go (loose-by-default.test.ts reads scratch remotes).
    expectAllowed(bash(`git -C ${SCRATCH} -c user.name=t push`));
    expectHeld(bash(`git -C ${SCRATCH} -c user.name=t push origin`), "outward");
    expectHeld(bash(`git -C ${SCRATCH} push https://example.com/x.git master`), "outward");
    expectHeld(bash(`cd ${SCRATCH} && git -c user.name=t commit -qm x && git push https://example.com/x.git master`), "outward");
    expectHeld(bash(`cd ${SCRATCH} && git remote add origin https://example.com/x.git && git -c user.name=t commit -qm x && git push -u origin master`), "outward");
    expectHeld(bash(`git -C ${REMOTED} push`), "outward");
  });
});
