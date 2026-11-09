import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";
import { randomUUID } from "crypto";
import { attachSessionToLaunch, createLaunch, createSession, createStore, insertEvent, upsertProject } from "@standup/store";
import { createPermissionAsk, noticeTarget } from "../held-call.js";
import {
  gitConfigRefusal,
  gitConfigRisk,
  permissionAllowDigit,
  permissionAnswerAllowsOnce,
  permissionAskReadOnly,
  permissionDenyDigit,
  permissionDialogRefusal,
  readOnlyFsRefusal,
  readOnlyPathRefusal,
  readOnlyShapeRefusal,
} from "./permission-read-only.js";
import { decide } from "./policy.js";

/*
 * A tool-permission prompt's "allow once" runs with no owner card only when
 * the call behind the dialog is plainly read-only: a read-only shape the
 * safety floor, with the launch's own config, allows with no hold. Every case
 * below is the call as the worker's PreToolUse recorded it.
 */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** The `bash -c` grep scan a background subagent of worker 226879d8 ran when Claude Code opened a dialog for it. */
const INCIDENT_SCAN = [
  "cd src/ui && bash -c '",
  "F=$(cat $TMPDIR/files.txt | grep -v editorTheme)",
  'echo "== hex/rgb"; grep -nE "#[0-9a-fA-F]{3,8}\\b|rgba?\\(" $F',
  'echo "== font-size"; grep -nE "font-?[sS]ize" $F src/polish.css',
  'echo "== style={"; grep -nE "style=\\{" $F',
  'echo "== raw elements"; grep -nE "<(button|table|h[1-6]|a)[ >]" $F',
  'echo "== primary count"; for f in $F; do c=$(grep -c "variant=\\"primary\\"" $f); [ "$c" -gt 1 ] && echo "$f $c"; done; true\'',
].join("\n");

describe("readOnlyShapeRefusal", () => {
  const readOnly: Array<[string, string]> = [
    ["cat of a doc", "cat PRODUCT.md DESIGN.md | head -250; ls src src/drafts"],
    ["grep of a file", "grep -n x src/a.ts"],
    ["grep with stderr dropped", "grep -rn foo src 2>/dev/null | head -20"],
    ["rg", "rg foo src"],
    ["rg with a glob", "rg -n 'useState' src --glob '*.tsx'"],
    ["find without actions", "find . -name '*.ts' -not -path './node_modules/*' | wc -l"],
    ["git reads", "git status --short && git diff --stat origin/main && git log --oneline -5"],
    ["sed line print", "sed -n 150,400p DESIGN.md | grep -n -i token"],
    ["a glob over a literal dir", "head -5 src/*.tsx"],
    ["bash -c over literal paths", "bash -c 'echo \"== primary\"; grep -c \"variant=\\\"primary\\\"\" src/a.tsx; ls src'"],
    ["stderr into stdout", "ls -la 2>&1 | tail -3"],
  ];
  for (const [name, command] of readOnly) {
    test(`read-only: ${name}`, () => {
      expect(readOnlyShapeRefusal("Bash", { command })).toBeNull();
    });
  }

  test("read-only tools are read-only by what they are", () => {
    for (const tool of ["Read", "Grep", "Glob", "LS", "NotebookRead"]) expect(readOnlyShapeRefusal(tool, { file_path: "a" })).toBeNull();
  });

  const held: Array<[string, string, string]> = [
    ["a redirect into a file", "echo src/a.ts > files.txt", "writes a file"],
    ["a redirect into a computed path", 'echo "$F" > $TMPDIR/files.txt', "computed"],
    ["an append", "cat a >> b", "writes a file"],
    ["find -exec", "find . -name '*.log' -exec rm {} +", "find -exec"],
    ["find -delete", "find . -name '*.log' -delete", "find -delete"],
    ["a computed find argument", "find . $ACTION", "computed"],
    ["sed -i", "sed -i 's/a/b/' x.ts", "sed -i"],
    ["a sed script that writes", "sed -n 's/a/b/w out.txt' x.ts", "line print"],
    ["rg --pre", "rg --pre ./run.sh foo", "--pre"],
    ["sort -o", "sort -o out.txt in.txt", "sort -o"],
    ["uniq with an output file", "uniq in.txt out.txt", "uniq"],
    ["git push", "git push origin HEAD", "git push"],
    ["git diff --output", "git diff --output=patch.txt", "--output"],
    ["git branch create", "git branch topic", "git branch"],
    ["git diff --no-index", "git diff --no-index /etc/shadow /dev/null", "--no-index"],
    ["git -c config", "git -c core.pager=sh log", "git -c"],
    ["rm", "rm -rf build", "rm is not"],
    ["curl", "curl -s https://example.com", "curl is not"],
    ["a program by path", "./scripts/check.sh", "by path"],
    ["a computed command name", "$CMD file", "computed"],
    // A path assembled at run time can name anything; the check can't see it.
    ["a path assembled from variables", "a=/pr; b=oc; cat $a$b/1/environ", "computed"],
    ["a /proc path from a command substitution", 'cat "$(echo /proc/1/environ)"', "/proc"],
    ["a path from a command substitution", 'cat "$(echo PRODUCT.md)"', "computed"],
    ["a path from a backtick", "cat `echo PRODUCT.md`", "computed"],
    ["a variable file operand", "grep -n x $F", "computed"],
    ["a ~ path", "cat ~/notes.txt", "computed"],
    ["an input process substitution", "diff <(ls a) <(ls b)", "computed"],
    ["the incident's bash -c scan, whose files come from $F", INCIDENT_SCAN, "computed"],
    ["a loop variable as a file", 'for f in a.ts b.ts; do grep -c x $f; done', "computed"],
    ["a variable anywhere in a bash -c body", "bash -c 'for p in \"a.ts 1 9\"; do set -- $p; echo $1; done'", "computed"],
    ["a prefix assignment", "LD_PRELOAD=x.so cat a", "environment"],
    ["PATH set", "PATH=/tmp/evil:$PATH; cat a", "PATH"],
    ["a background job", "tail -f log &", "background"],
    ["xargs", "ls | xargs rm", "xargs"],
    ["bash running a script", "bash ./deploy.sh", "runs a script"],
    ["bash -c with a write inside", "bash -c 'echo x > out.txt'", "writes a file"],
    ["bash -c with a computed script", 'bash -c "$SCRIPT"', "computed"],
    ["awk", "awk '{system(\"rm -rf x\")}' a", "awk is not"],
    ["an output process substitution", "cat a > >(tee b)", "redirect"],
    ["tee", "cat a | tee b", "tee is not"],
    ["an unparseable command", "cat 'a", "parsed"],
    ["arithmetic", "echo $((x=1))", "arithmetic"],
    ["an assigning expansion", "echo ${x:=1}", "assigns"],
  ];
  for (const [name, command, why] of held) {
    test(`held: ${name}`, () => {
      const refusal = readOnlyShapeRefusal("Bash", { command });
      expect(refusal).not.toBeNull();
      expect(refusal!).toContain(why);
    });
  }

  test("held: writing, outward and unknown tools", () => {
    expect(readOnlyShapeRefusal("Write", { file_path: "a", content: "x" })).toContain("not a read-only tool");
    expect(readOnlyShapeRefusal("Edit", { file_path: "a" })).toContain("not a read-only tool");
    expect(readOnlyShapeRefusal("WebFetch", { url: "https://example.com" })).toContain("not a read-only tool");
    expect(readOnlyShapeRefusal("mcp__standup__write_doc", {})).toContain("not a read-only tool");
    expect(readOnlyShapeRefusal("Bash", { command: "cat a", run_in_background: true })).toContain("background");
    expect(readOnlyShapeRefusal("Bash", null)).not.toBeNull();
    expect(readOnlyShapeRefusal("Bash", { command: "" })).not.toBeNull();
  });

  const heldMore: Array<[string, string, string]> = [
    ["git log with --output abbreviated", "git log --out=x", "writes a file or runs"],
    ["git diff with --ext-diff abbreviated", "git diff --ext", "writes a file or runs"],
    ["git log with --textconv abbreviated", "git log -p --textc", "writes a file or runs"],
    ["git log --show-signature abbreviated", "git log --show-sig", "writes a file or runs"],
    ["a git format verifying signatures", "git log --format=%G?", "gpg"],
    ["git grep -O in a bundle", "git grep -nO foo", "writes a file or runs"],
    ["git -C with -c config", "git -C . -c core.fsmonitor=x status", "git -c"],
    ["git cat-file, whose --textconv and --filters run drivers", "git cat-file -p HEAD:a", "git cat-file"],
    ["git shortlog", "git shortlog -s", "git shortlog"],
    ["jq, which reads the environment and arbitrary files", "jq -n '$ENV'", "jq is not"],
    ["jq --rawfile", "jq --rawfile k secrets.txt -n '$k'", "jq is not"],
    ["rg -z", "rg -z foo", "runs a program"],
    ["rg -z in a bundle", "rg -inz foo", "runs a program"],
    ["rg --search-zip", "rg --search-zip foo", "runs a program"],
    ["rg --pre-glob", "rg --pre-glob '*.gz' foo", "--pre"],
    ["rg --hostname-bin", "rg --hostname-bin ./h foo", "runs a program"],
    ["another process's environment", "cat /proc/1234/environ", "/proc"],
    ["a /proc directory listing", "ls /proc", "/proc"],
    ["/proc reached relative to /", "cd / && cat proc/1/environ", "/proc"],
    ["/proc climbed to", "cat ../../../../proc/1/environ", "/proc"],
    ["/sys", "cat /sys/kernel/x", "/proc"],
    ["a device", "head -c 10 /dev/sda", "/proc"],
    ["bash's network device", "cat < /dev/tcp/example.com/80", "/proc"],
  ];
  for (const [name, command, why] of heldMore) {
    test(`held: ${name}`, () => {
      const refusal = readOnlyShapeRefusal("Bash", { command });
      expect(refusal).not.toBeNull();
      expect(refusal!).toContain(why);
    });
  }

  test("read-only: git's full option names that share a risky prefix, /dev/null and a dir named proc inside a repo", () => {
    expect(readOnlyShapeRefusal("Bash", { command: "git diff --text --stat && git log --oneline --no-ext-diff -3" })).toBeNull();
    expect(readOnlyShapeRefusal("Bash", { command: "grep -rn foo src 2>/dev/null; cat a > /dev/null" })).toBeNull();
    expect(readOnlyShapeRefusal("Bash", { command: "ls src/proc/x" })).toBeNull();
  });

  test("held: a read-only tool's path into /proc, /sys or /dev", () => {
    expect(readOnlyShapeRefusal("Read", { file_path: "/proc/self/environ" })).toContain("kernel or device");
    expect(readOnlyShapeRefusal("Grep", { pattern: "x", path: "/proc/1" })).toContain("kernel or device");
    expect(readOnlyShapeRefusal("Read", { file_path: "/dev/stdin" })).toContain("kernel or device");
    expect(readOnlyShapeRefusal("Read", { file_path: 7 })).toContain("not text");
  });
});

describe("readOnlyPathRefusal", () => {
  const facts = (paths: string[], dirs: string[] = [], unknownDir = false) => ({ paths, dirs, unknownDir, usesGit: false });
  const tmp = () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "perm-ro-fs-")));
    dirs.push(d);
    return d;
  };

  test("a FIFO named directly, through a glob, or after a cd keeps the card; plain files and missing ones don't", () => {
    const d = tmp();
    mkdirSync(join(d, "sub"));
    writeFileSync(join(d, "a.txt"), "a");
    expect(Bun.spawnSync(["mkfifo", join(d, "sub", "pipe")]).exitCode).toBe(0);
    expect(readOnlyPathRefusal(d, facts(["a.txt", "missing.txt", "sub"]))).toBeNull();
    expect(readOnlyPathRefusal(d, facts(["sub/pipe"]))).toContain("a FIFO");
    expect(readOnlyPathRefusal(d, facts(["sub/*"]))).toContain("a FIFO");
    expect(readOnlyPathRefusal(d, facts(["pipe"], ["sub"]))).toContain("a FIFO");
    expect(readOnlyPathRefusal(join(d, "sub"), facts([join(d, "sub", "pipe")]))).toContain("a FIFO");
  });

  test("a symlink into /proc keeps the card, and so does a call run in /proc", () => {
    const d = tmp();
    symlinkSync("/proc/self/environ", join(d, "env"));
    expect(readOnlyPathRefusal(d, facts(["env"]))).toContain("/proc");
    expect(readOnlyPathRefusal("/proc/self", facts(["environ"]))).toContain("/proc");
    expect(readOnlyPathRefusal(d, facts(["environ"], ["/proc/1"]))).toContain("/proc");
  });

  test("relative paths after a cd that isn't literal keep the card", () => {
    const d = tmp();
    expect(readOnlyPathRefusal(d, facts(["a.txt"], [], true))).toContain("isn't literal");
  });

  test("through the shape: cat of a FIFO in the worktree keeps the card", () => {
    const h = setUp();
    expect(Bun.spawnSync(["mkfifo", join(h.root, "trigger")]).exitCode).toBe(0);
    expect(permissionAskReadOnly(h.store.db, h.prompt("Bash", { command: "cat trigger" }), { env: h.env })).toMatchObject({ readOnly: false, why: expect.stringContaining("FIFO") });
    h.finish("toolu_1");
    expect(permissionAskReadOnly(h.store.db, h.prompt("Bash", { command: "head -5 *" }), { env: h.env })).toMatchObject({ readOnly: false, why: expect.stringContaining("FIFO") });
    h.finish("toolu_2");
    expect(permissionAskReadOnly(h.store.db, h.prompt("Read", { file_path: join(h.root, "trigger") }), { env: h.env })).toMatchObject({ readOnly: false, why: expect.stringContaining("FIFO") });
  });
});

describe("git config that runs programs", () => {
  test("gitConfigRisk names each setting a git read can run, and passes plain config", () => {
    const risky: Array<[string, string]> = [
      ["[core]\n\tpager = sh -c 'touch /tmp/x'", "core.pager"],
      ["[core]\n\tfsmonitor = ./hook.sh", "core.fsmonitor"],
      ["[diff]\n\texternal = ./d.sh", "diff.external"],
      ['[diff "bin"]\n\ttextconv = ./t.sh', "diff.textconv"],
      ['[diff "bin"]\n\tcommand = ./t.sh', "diff.command"],
      ["[core]\n\tsshCommand = ./ssh.sh", "core.sshcommand"],
      ['[filter "x"]\n\tclean = ./c.sh', '[filter "x"]'.slice(0, 7)],
      ["[include]\n\tpath = ../other", "[include"],
      ['[includeIf "gitdir:/"]\n\tpath = x', "[includeIf"],
      ["[core] pager = less", "core.pager"],
      ["[log]\n\tshowSignature = true", "log.showsignature"],
      ['[remote "origin"]\n\tpromisor = true', "remote.promisor"],
      ["[core\n", "unreadable"],
    ];
    for (const [text, named] of risky) expect(gitConfigRisk(text) ?? "").toContain(named);
    const plain = [
      "[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tlogallrefupdates = true",
      '[remote "origin"]\n\turl = git@host:team/pager.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*',
      '[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main',
      "[extensions]\n\tworktreeConfig = true",
      "# pager = x\n[user]\n\tname = a \\\n  pager = continued value",
    ];
    for (const text of plain) expect(gitConfigRisk(text)).toBeNull();
  });

  const repo = (config: string, opts: { worktree?: boolean; modules?: boolean } = {}) => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "perm-ro-git-")));
    dirs.push(d);
    const common = join(d, "main", ".git");
    mkdirSync(common, { recursive: true });
    writeFileSync(join(common, "config"), config);
    if (opts.modules) mkdirSync(join(common, "modules"));
    if (!opts.worktree) return join(d, "main");
    const gitDir = join(common, "worktrees", "wt");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, "commondir"), "../..\n");
    mkdirSync(join(d, "wt", "src"), { recursive: true });
    writeFileSync(join(d, "wt", ".git"), `gitdir: ${gitDir}\n`);
    return join(d, "wt");
  };

  test("gitConfigRefusal reads the repository's config from the work tree, a worktree's common dir included", () => {
    expect(gitConfigRefusal([repo("[core]\n\tbare = false\n")])).toBeNull();
    expect(gitConfigRefusal([repo("[core]\n\tfsmonitor = ./hook\n")])).toContain("core.fsmonitor");
    const wt = repo('[diff "x"]\n\ttextconv = ./t\n', { worktree: true });
    expect(gitConfigRefusal([wt])).toContain("diff.textconv");
    expect(gitConfigRefusal([join(wt, "src")])).toContain("diff.textconv");
    expect(gitConfigRefusal([repo("[core]\n", { modules: true })])).toContain("submodules");
  });

  test("readOnlyFsRefusal checks git only for a git read, in every directory it may run in", () => {
    const risky = repo("[core]\n\tpager = ./p\n");
    const clean = repo("[core]\n\tbare = false\n");
    const git = { paths: [], dirs: [] as string[], unknownDir: false, usesGit: true };
    expect(readOnlyFsRefusal(clean, git)).toBeNull();
    expect(readOnlyFsRefusal(risky, git)).toContain("core.pager");
    expect(readOnlyFsRefusal(clean, { ...git, dirs: [risky] })).toContain("core.pager");
    expect(readOnlyFsRefusal(clean, { ...git, unknownDir: true })).toContain("isn't literal");
    expect(readOnlyFsRefusal(risky, { ...git, usesGit: false })).toBeNull();
  });

  test("through the shape: git status in a worktree whose config sets core.fsmonitor keeps the card", () => {
    const h = setUp();
    mkdirSync(join(h.root, ".git"));
    writeFileSync(join(h.root, ".git", "config"), "[core]\n\tfsmonitor = ./.git/hooks/run.sh\n");
    const verdict = permissionAskReadOnly(h.store.db, h.prompt("Bash", { command: "git status --short" }), { env: h.env });
    expect(verdict).toMatchObject({ readOnly: false, why: expect.stringContaining("core.fsmonitor") });
  });
});

describe("the call is still the only one in flight", () => {
  test("a second call, or a subagent beside a main-thread call, keeps the card for a tied ask", () => {
    const h = setUp();
    const ask = h.prompt("Bash", { command: "cat PRODUCT.md" });
    expect(permissionAskReadOnly(h.store.db, ask, { env: h.env }).readOnly).toBe(true);
    insertEvent(h.store.db, h.sessionId, "PreToolUse", { tool_use_id: "toolu_b", agent_id: "agent-b", tool_name: "Bash", tool_input: { command: "cat src/a.tsx" }, cwd: h.root });
    expect(permissionAskReadOnly(h.store.db, ask, { env: h.env })).toMatchObject({ readOnly: false, why: expect.stringContaining("2 calls are in flight") });
    h.finish("toolu_b");
    expect(permissionAskReadOnly(h.store.db, ask, { env: h.env }).readOnly).toBe(true);
    // Two subagents running: the other one can open a dialog behind this one.
    insertEvent(h.store.db, h.sessionId, "PreToolUse", { tool_use_id: "toolu_ag1", tool_name: "Agent", tool_input: { prompt: "a" }, cwd: h.root });
    expect(permissionAskReadOnly(h.store.db, ask, { env: h.env }).readOnly).toBe(true);
    insertEvent(h.store.db, h.sessionId, "PreToolUse", { tool_use_id: "toolu_ag2", tool_name: "Task", tool_input: { prompt: "b" }, cwd: h.root });
    expect(permissionAskReadOnly(h.store.db, ask, { env: h.env })).toMatchObject({ readOnly: false, why: expect.stringContaining("subagent") });
  });

  test("a main-thread call with any subagent running keeps the card", () => {
    const h = setUp();
    insertEvent(h.store.db, h.sessionId, "PreToolUse", { tool_use_id: "toolu_ag", tool_name: "Agent", tool_input: { prompt: "a" }, cwd: h.root });
    insertEvent(h.store.db, h.sessionId, "PreToolUse", { tool_use_id: "toolu_main", tool_name: "Bash", tool_input: { command: "cat PRODUCT.md" }, cwd: h.root });
    const ask = createPermissionAsk(h.store.db, h.sessionId, "Claude needs your permission", noticeTarget(h.store.db, h.sessionId));
    expect(permissionAskReadOnly(h.store.db, ask, { env: h.env })).toMatchObject({ readOnly: false, why: expect.stringContaining("subagent") });
  });

  test("an ask that is no longer pending keeps the card", () => {
    const h = setUp();
    const ask = h.prompt("Bash", { command: "cat PRODUCT.md" });
    expect(permissionAskReadOnly(h.store.db, { ...ask, status: "answered" }, { env: h.env })).toMatchObject({ readOnly: false, why: expect.stringContaining("already answered") });
    expect(permissionAskReadOnly(h.store.db, { ...ask, status: "cancelled" }, { env: h.env })).toMatchObject({ readOnly: false, why: expect.stringContaining("already cancelled") });
  });
});

describe("permissionDialogRefusal", () => {
  const RULE = "─".repeat(60);
  const call = (command: string, extra: Record<string, unknown> = {}) =>
    ({ toolName: "Bash", toolInput: { command, ...extra }, cwd: "/w", event: { id: 1 } }) as unknown as Parameters<typeof permissionDialogRefusal>[1];
  const dialog = (body: string[], options = ["Yes", "Yes, and don't ask again for cat commands in /w", "No, and tell Claude what to do differently (esc)"], title = " Bash command") =>
    ["● Bash(cat PRODUCT.md)", "  ⎿  Running…", RULE, title, ...body, " Do you want to proceed?", ...options.map((o, i) => `${i === 0 ? " ❯" : "  "} ${i + 1}. ${o}`)].join("\n");

  test("the dialog of exactly this call, its description under it or its command wrapped, is the one to answer", () => {
    expect(permissionDialogRefusal(dialog(["   cat PRODUCT.md"]), call("cat PRODUCT.md"), "1")).toBeNull();
    expect(permissionDialogRefusal(dialog(["   cat PRODUCT.md", "   Read the doc"]), call("cat PRODUCT.md", { description: "Read the doc" }), "1")).toBeNull();
    const long = "grep -rn 'variant=\"primary\"' src/components src/pages src/drafts --include '*.tsx'";
    expect(permissionDialogRefusal(dialog([`   ${long.slice(0, 40)}`, `   ${long.slice(40)}`]), call(long), "1")).toBeNull();
  });

  test("another call's dialog, a longer command holding this one, or one shown only in the transcript is refused", () => {
    expect(permissionDialogRefusal(dialog(["   rm -rf build"]), call("cat PRODUCT.md"), "1")).toContain("different Bash call");
    expect(permissionDialogRefusal(dialog(["   cat PRODUCT.md; rm -rf build"]), call("cat PRODUCT.md"), "1")).toContain("different Bash call");
    // The transcript above the rule names this call; the dialog under it is another.
    expect(permissionDialogRefusal(dialog(["   git push origin HEAD"]), call("cat PRODUCT.md"), "1")).toContain("different Bash call");
    expect(permissionDialogRefusal(dialog(["   /w/PRODUCT.md"], undefined, " Read file"), call("cat PRODUCT.md"), "1")).toContain("not a Bash dialog");
  });

  test("an option that isn't a one-time yes, or no dialog at all, is refused", () => {
    expect(permissionDialogRefusal(dialog(["   cat PRODUCT.md"], ["Yes, and don't ask again for cat commands", "No"]), call("cat PRODUCT.md"), "1")).toContain("not a one-time yes");
    expect(permissionDialogRefusal(dialog(["   cat PRODUCT.md"]), call("cat PRODUCT.md"), "2")).toContain("not a one-time yes");
    expect(permissionDialogRefusal(dialog(["   cat PRODUCT.md"]), call("cat PRODUCT.md"), "4")).toContain("no option 4");
    expect(permissionDialogRefusal([RULE, "❯ ", RULE, "  ? for shortcuts"].join("\n"), call("cat PRODUCT.md"), "1")).toContain("no tool-permission dialog");
    expect(permissionDialogRefusal("", call("cat PRODUCT.md"), "1")).toContain("no tool-permission dialog");
    expect(permissionDialogRefusal(dialog(["   cat PRODUCT.md"]).replace(RULE, ""), call("cat PRODUCT.md"), "1")).toContain("top edge");
  });

  test("a Read dialog shows the path, relative to the call's cwd or absolute", () => {
    const read = { toolName: "Read", toolInput: { file_path: "/w/docs/PRODUCT.md" }, cwd: "/w", event: { id: 2 } } as unknown as Parameters<typeof permissionDialogRefusal>[1];
    expect(permissionDialogRefusal(dialog(["   docs/PRODUCT.md"], undefined, " Read file"), read, "1")).toBeNull();
    expect(permissionDialogRefusal(dialog(["   /w/docs/PRODUCT.md"], undefined, " Read file"), read, "1")).toBeNull();
    expect(permissionDialogRefusal(dialog(["   /w/docs/OTHER.md"], undefined, " Read file"), read, "1")).toContain("different Read call");
  });

  test("permissionAllowDigit picks the one-time yes option's digit", () => {
    expect(permissionAllowDigit({}, "1")).toBe("1");
    expect(permissionAllowDigit({}, "2")).toBeNull();
    expect(permissionAllowDigit({ options: ["No", "Yes"] }, "yes")).toBe("2");
    expect(permissionAllowDigit({ options: ["Yes", "Yes, and don't ask again", "No"] }, "2")).toBeNull();
  });

  const denyDigits: Array<[string, { options?: string[] }, string, string | null]> = [
    ["3 on a dialog with no listed options", {}, "3", "3"],
    ["1 is no deny", {}, "1", null],
    ["2 is no deny", {}, "2", null],
    ["the No option by number", { options: ["Yes", "Yes, and don't ask again", "No, and tell Claude"] }, "3", "3"],
    ["the No option by label", { options: ["Yes", "No"] }, "no", "2"],
    ["a Yes option by number", { options: ["Yes", "No"] }, "1", null],
    ["out of range", { options: ["Yes", "No"] }, "3", null],
  ];
  for (const [name, ask, answer, digit] of denyDigits) {
    test(`permissionDenyDigit: ${name}`, () => expect(permissionDenyDigit(ask, answer)).toBe(digit));
  }

  test("a deny types only on a dialog whose option is a No, of this call when its tool's dialog is read", () => {
    const edit = { toolName: "Edit", toolInput: { file_path: "/w/a.ts" }, cwd: "/w", event: { id: 3 } } as unknown as Parameters<typeof permissionDialogRefusal>[1];
    expect(permissionDialogRefusal(dialog(["   rm -rf build"]), call("rm -rf build"), "3", "deny")).toBeNull();
    expect(permissionDialogRefusal(dialog(["   rm -rf build"]), call("cat PRODUCT.md"), "3", "deny")).toContain("different Bash call");
    expect(permissionDialogRefusal(dialog(["   /w/a.ts"], undefined, " Edit file"), edit, "3", "deny")).toBeNull();
    expect(permissionDialogRefusal(dialog(["   rm -rf build"]), call("rm -rf build"), "1", "deny")).toContain("not a no");
    expect(permissionDialogRefusal(dialog(["   rm -rf build"], ["Yes", "No"]), call("rm -rf build"), "3", "deny")).toContain("no option 3");
    expect(permissionDialogRefusal("", call("rm -rf build"), "3", "deny")).toContain("no tool-permission dialog");
  });
});

describe("Persona's deny of a tool-permission prompt", () => {
  test("a deny acts with no card; an allow of a call that isn't read-only stays held", () => {
    const base = { owned: true, askKind: "permission_prompt" } as const;
    expect(decide("answer_ask", { ...base, text: "3", permissionDeny: true })).toMatchObject({ rule: "act" });
    expect(decide("answer_ask", { ...base, text: "1" })).toMatchObject({ rule: "ask", holdRule: "permission-prompt" });
    expect(decide("answer_ask", { ...base, text: "3", permissionDeny: true, owned: false }).rule).toBe("never");
    expect(decide("answer_ask", { ...base, text: "3", permissionDeny: true, askGate: "standup_improvement" }).rule).toBe("ask");
  });
});

describe("cards that remain", () => {
  test("STANDUP_PERSONA_HOLD=answer_ask, a confirmation gate and a floor gate still decide before the read-only allow", () => {
    const base = { owned: true, askKind: "permission_prompt", text: "1", permissionReadOnly: true } as const;
    expect(decide("answer_ask", base, { hold: new Set(["answer_ask"]) })).toMatchObject({ rule: "ask", reason: expect.stringContaining("STANDUP_PERSONA_HOLD") });
    expect(decide("answer_ask", { ...base, askGate: "standup_improvement" }).rule).toBe("ask");
    expect(decide("answer_ask", { ...base, askGate: "safety_floor_owner" }).rule).toBe("ask");
    // The read-only flag means nothing on a worker's question: that path is its own.
    expect(decide("answer_ask", { ...base, askKind: "ask_human" })).toMatchObject({ rule: "act", reason: "worker question on an owned session" });
  });
});

/** A launched worker with a real worktree, its session, and the collector env the floor's config reads. */
function setUp() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "perm-ro-")));
  dirs.push(base);
  const home = join(base, "home");
  const dataDir = join(home, ".local", "share", "standup");
  const root = join(dataDir, "worktrees", "p", "feat-1");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "PRODUCT.md"), "# Product\n");
  writeFileSync(join(root, "src", "a.tsx"), 'export const A = () => <Button variant="primary" />;\n');
  const env: Record<string, string> = { HOME: home, DB_PATH: join(dataDir, "standup.db"), TMPDIR: join(base, "tmp") };
  mkdirSync(env.TMPDIR!, { recursive: true });
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "P", branch: "main", repos: [root] });
  const launchId = randomUUID();
  createLaunch(store.db, { id: launchId, projectId: "p", task: "t", worktreePath: root, branch: "feat-1" });
  const sessionId = randomUUID();
  createSession(store.db, { id: sessionId, projectId: "p", title: "worker", cwd: root, status: "running" });
  attachSessionToLaunch(store.db, launchId, sessionId);
  let seq = 0;
  /** A call in flight and the permission ask its dialog raised, tied to it. */
  const prompt = (toolName: string, toolInput: Record<string, unknown>, cwd: string | undefined = root) => {
    const toolUseId = `toolu_${++seq}`;
    insertEvent(store.db, sessionId, "PreToolUse", { tool_use_id: toolUseId, agent_id: "agent-a", tool_name: toolName, tool_input: toolInput, ...(cwd ? { cwd } : {}) });
    return createPermissionAsk(store.db, sessionId, "Claude needs your permission", noticeTarget(store.db, sessionId));
  };
  const finish = (toolUseId: string) => insertEvent(store.db, sessionId, "PostToolUse", { tool_use_id: toolUseId, agent_id: "agent-a", tool_name: "Bash", tool_input: {} });
  return { store, env, root, home, dataDir, sessionId, launchId, prompt, finish };
}

describe("permissionAnswerAllowsOnce and the policy", () => {
  test("only a one-time yes allows once", () => {
    expect(permissionAnswerAllowsOnce({}, "1")).toBe(true);
    expect(permissionAnswerAllowsOnce({}, "2")).toBe(false);
    expect(permissionAnswerAllowsOnce({}, "3")).toBe(false);
    const options = ["Yes", "Yes, and don't ask again for cat commands", "No"];
    expect(permissionAnswerAllowsOnce({ options }, "1")).toBe(true);
    expect(permissionAnswerAllowsOnce({ options }, "yes")).toBe(true);
    expect(permissionAnswerAllowsOnce({ options }, "2")).toBe(false);
    expect(permissionAnswerAllowsOnce({ options }, "3")).toBe(false);
    expect(permissionAnswerAllowsOnce({ options }, "No")).toBe(false);
    expect(permissionAnswerAllowsOnce({ options }, 1)).toBe(false);
  });

  test("a read-only permission answer acts; any other stays the owner's", () => {
    expect(decide("answer_ask", { owned: true, askKind: "permission_prompt", text: "1", permissionReadOnly: true })).toMatchObject({ rule: "act" });
    expect(decide("answer_ask", { owned: true, askKind: "permission_prompt", text: "1" })).toMatchObject({ rule: "ask", holdRule: "permission-prompt" });
    expect(decide("answer_ask", { owned: false, askKind: "permission_prompt", text: "1", permissionReadOnly: true }).rule).toBe("never");
    // The owner's STANDUP_PERSONA_HOLD on answer_ask still holds it.
    expect(decide("answer_ask", { owned: true, askKind: "permission_prompt", text: "1", permissionReadOnly: true }, { hold: new Set(["answer_ask"]) }).rule).toBe("ask");
  });
});

describe("permissionAskReadOnly", () => {
  test("the incident's bash -c scan keeps the card", () => {
    const h = setUp();
    const ask = h.prompt("Bash", { command: INCIDENT_SCAN.replace("cd src/ui && ", ""), description: "scan" });
    const verdict = permissionAskReadOnly(h.store.db, ask, { env: h.env });
    // Its files come from $F, read out of $TMPDIR/files.txt at run time: a
    // path no check can see before it runs (it could as well be another
    // process's environ), so it goes to the owner. Its dialog was Claude
    // Code's own, so a card there is the accepted cost.
    expect(verdict).toMatchObject({ readOnly: false, why: expect.stringContaining("computed at run time") });
  });

  test("a cat of a doc in the worktree and a Read tool call are read-only", () => {
    const h = setUp();
    expect(permissionAskReadOnly(h.store.db, h.prompt("Bash", { command: "cat PRODUCT.md" }), { env: h.env })).toMatchObject({ readOnly: true });
    h.finish("toolu_1");
    expect(permissionAskReadOnly(h.store.db, h.prompt("Read", { file_path: join(h.root, "PRODUCT.md") }), { env: h.env })).toMatchObject({ readOnly: true });
  });

  const kept: Array<[string, string, Record<string, unknown>]> = [
    ["a write", "Bash", { command: "echo x > notes.txt" }],
    ["an outward step", "Bash", { command: "git push origin HEAD" }],
    ["an outward fetch", "WebFetch", { url: "https://example.com", prompt: "x" }],
    ["a file write tool", "Write", { file_path: "notes.txt", content: "x" }],
  ];
  for (const [name, tool, input] of kept) {
    test(`keeps the card: ${name}`, () => {
      const h = setUp();
      expect(permissionAskReadOnly(h.store.db, h.prompt(tool, input), { env: h.env }).readOnly).toBe(false);
    });
  }

  test("keeps the card: a read of the owner's secrets, Standup's DB or its data dir, by the floor's verdict", () => {
    const h = setUp();
    const reads = [
      `cat ${join(homedir(), ".ssh", "id_ed25519")}`,
      `cat ${join(h.dataDir, "standup.db")}`,
      `ls ${join(h.dataDir, "owner-secrets")}`,
      `bash -c 'cat ${join(homedir(), ".aws", "credentials")}'`,
      "cat ../../../standup.db",
      `grep -r token ${h.dataDir}`,
    ];
    const verdicts = reads.map((command, i) => {
      const verdict = permissionAskReadOnly(h.store.db, h.prompt("Bash", { command }), { env: h.env });
      h.finish(`toolu_${i + 1}`);
      // Each is a literal read-only shape, so it is the floor's verdict that keeps the card.
      return { command, shape: readOnlyShapeRefusal("Bash", { command }), readOnly: verdict.readOnly, floor: !verdict.readOnly && verdict.why.startsWith("the safety floor holds it") };
    });
    expect(verdicts).toEqual(reads.map((command) => ({ command, shape: null, readOnly: false, floor: true })));
  });

  test("keeps the card: a secret read through a computed path, by the shape alone", () => {
    const h = setUp();
    const reads = [
      "cat ~/.ssh/id_ed25519",
      "grep -r token ~/.aws",
      "cat $HOME/.ssh/id_ed25519",
      "cat $(echo ~/.aws/credentials)",
      "F=$(printf %s ~/.ssh/id_ed25519); cat $F",
      "bash -c 'cat ~/.ssh/id_ed25519'",
      "a=/pr; b=oc; cat $a$b/1/environ",
    ];
    reads.forEach((command, i) => {
      const verdict = permissionAskReadOnly(h.store.db, h.prompt("Bash", { command }), { env: h.env });
      h.finish(`toolu_${i + 1}`);
      expect(verdict).toMatchObject({ readOnly: false, why: expect.stringContaining("computed at run time") });
    });
  });

  test("keeps the card: a Read of a secret", () => {
    const h = setUp();
    const verdict = permissionAskReadOnly(h.store.db, h.prompt("Read", { file_path: join(homedir(), ".ssh", "id_ed25519") }), { env: h.env });
    expect(verdict.readOnly).toBe(false);
  });

  test("fails closed when the call can't be recovered", () => {
    const h = setUp();
    // No cwd on record.
    expect(permissionAskReadOnly(h.store.db, h.prompt("Bash", { command: "cat PRODUCT.md" }, ""), { env: h.env })).toMatchObject({
      readOnly: false,
      why: expect.stringContaining("working directory"),
    });
    h.finish("toolu_1");
    // The call finished: nothing is behind the dialog any more.
    const ask = h.prompt("Bash", { command: "cat PRODUCT.md" });
    h.finish("toolu_2");
    expect(permissionAskReadOnly(h.store.db, ask, { env: h.env })).toMatchObject({ readOnly: false, why: expect.stringContaining("can't be told") });
    // Two calls in flight: an untied ask could be for either.
    insertEvent(h.store.db, h.sessionId, "PreToolUse", { tool_use_id: "toolu_x", agent_id: "a", tool_name: "Bash", tool_input: { command: "cat a" }, cwd: h.root });
    insertEvent(h.store.db, h.sessionId, "PreToolUse", { tool_use_id: "toolu_y", agent_id: "b", tool_name: "Bash", tool_input: { command: "cat b" }, cwd: h.root });
    const untied = createPermissionAsk(h.store.db, h.sessionId, "Claude needs your permission", noticeTarget(h.store.db, h.sessionId));
    expect(permissionAskReadOnly(h.store.db, untied, { env: h.env })).toMatchObject({ readOnly: false, why: expect.stringContaining("can't be told") });
  });

  test("fails closed when the floor can't classify", () => {
    const h = setUp();
    const ask = h.prompt("Bash", { command: "cat PRODUCT.md" });
    const boom = () => {
      throw new Error("probe failed");
    };
    expect(permissionAskReadOnly(h.store.db, ask, { env: h.env, classify: boom })).toMatchObject({ readOnly: false, why: expect.stringContaining("couldn't be classified") });
  });
});
