import { describe, expect, test } from "bun:test";
import { dirname, join } from "path";
import { classifyToolCall, type FloorProbes } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * A script path named through a variable the same command line assigned
 * earlier (`S=~/.claude/skills/…/report.py; python3 $S summary …`) is
 * decided exactly as the literal path is: an installed skill script the
 * floor reads as harmless runs, never anything looser. A top-level
 * `P && S=value` (`cd dir && S=…`) is read both ways: on from where the
 * assignment ran, and on from where `P` failed and S stayed unset. A prefix
 * assignment, a subshell's, a group's or a pipeline stage's, one after `||`
 * or a longer chain, one after the use, or a value with a blank or glob
 * character (bash splits and globs it, zsh doesn't) leaves the script
 * unread; a reassignment the floor follows (`read`, `for`, `eval`, `source`,
 * a function) is the script run. An installed skill is read by its bytes,
 * not by where it sits: a skill dir linked elsewhere is the script it leads
 * to, read by its content.
 */

const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const WS = join(DATA, "worktrees", "standup", "item15");
const INSTALL = join(HOME, "standup");
const SCRIPT_TEXT = "#!/usr/bin/env python3\nimport sys\nprint('summary of', ', '.join(sys.argv[1:]))\n";
const SKILLS = join(HOME, ".claude", "skills");
const SKILL = join(SKILLS, "tools", "scripts", "report.py");
const OTHER_SKILL = join(SKILLS, "notes", "scripts", "notes.py");
const LINKED_SKILL = join(SKILLS, "linked", "tools", "scripts", "report.py");
const LINK_TARGET = join("/", "tmp", "planted", "tools", "scripts", "report.py");
const SPACED = join(HOME, "my tools", "tools", "scripts", "report.py");
const UPLOAD = join(WS, "upload.py");
const SET_S = join(WS, "set-s.sh");
const REMOTE_WRITER = `#!/usr/bin/env python3
import json, urllib.request
req = urllib.request.Request("https://example.com/upload", data=json.dumps({"a": 1}).encode(), method="POST")
urllib.request.urlopen(req)
`;

const config: FloorConfig = {
  v: 1,
  collectorUrl: "http://localhost:7777",
  launchId: "launch-1",
  root: WS,
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

const FILES: Record<string, string> = {
  [SKILL]: SCRIPT_TEXT,
  [SPACED]: SCRIPT_TEXT,
  [OTHER_SKILL]: "#!/usr/bin/env python3\nprint('hello')\n",
  [LINK_TARGET]: REMOTE_WRITER,
  [UPLOAD]: REMOTE_WRITER,
  [SET_S]: `S=${UPLOAD}\n`,
  [join(WS, "a.png")]: "png",
  [join(WS, "b.png")]: "png",
  [join(WS, ".git")]: "gitdir: /tmp/x\n",
};
const DIRS = new Set<string>([HOME, WS, INSTALL, "/tmp", "/", ...Object.keys(FILES).map((f) => dirname(f))]);
/** `~/.claude/skills/linked` is a symlink to a dir under /tmp. */
const LINK = join(SKILLS, "linked");
const LINK_DIR = join("/", "tmp", "planted");
const resolveLink = (p: string): string => (p === LINK || p.startsWith(`${LINK}/`) ? LINK_DIR + p.slice(LINK.length) : p);

function probes(): Partial<FloorProbes> {
  return {
    gitBranch: () => "standup/item15",
    gitAlias: () => null,
    gitHooksDir: () => null,
    readFile: (p) => {
      const r = resolveLink(p);
      return r in FILES ? { ok: true, text: FILES[r]! } : { ok: false, reason: "missing" };
    },
    exists: (p) => resolveLink(p) in FILES || DIRS.has(resolveLink(p)),
    isDirectory: (p) => DIRS.has(resolveLink(p)),
    listDir: (p) => {
      const r = resolveLink(p);
      return DIRS.has(r) ? Object.keys(FILES).filter((f) => dirname(f) === r).map((f) => f.slice(r.length + 1)) : null;
    },
    realpath: (p) => {
      const r = resolveLink(p);
      return r in FILES || DIRS.has(r) ? r : null;
    },
    lstat: (p) =>
      p === LINK
        ? { symlink: true, file: false, nlink: 1 }
        : resolveLink(p) in FILES
          ? { symlink: false, file: true, nlink: 1 }
          : DIRS.has(resolveLink(p))
            ? { symlink: false, file: false, nlink: 2 }
            : null,
    homeDir: () => HOME,
    shellDefinitions: () => ({ aliases: new Map(), functions: new Map() }),
    awsAccount: () => null,
    now: () => Date.now(),
  };
}

const bash = (command: string): FloorVerdict => classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: WS }, config, probes());
const summary = (v: FloorVerdict): string => (v.action === "allow" ? "allow" : `${v.category}: ${v.reason}`);
const category = (v: FloorVerdict): string => (v.action === "allow" ? "allow" : v.category);

const ARGS = "summary a.png b.png";
const LITERAL = `python3 ${SKILL} ${ARGS}`;
const ASSIGN = "S=~/.claude/skills/tools/scripts/report.py";

describe("a script path held in a variable assigned earlier in the command", () => {
  test("the literal path is the skill script, read and allowed", () => {
    expect(category(bash(LITERAL))).toBe("allow");
    expect(category(bash(`python3 ~/.claude/skills/tools/scripts/report.py ${ARGS}`))).toBe("allow");
  });

  test.each([
    [`${ASSIGN}; python3 $S ${ARGS}`],
    [`S=${SKILL}; python3 $S ${ARGS}`],
    [`S="${SKILL}"; python3 "$S" ${ARGS}`],
    [`S='${SKILL}'; python3 \${S} ${ARGS}`],
    [`${ASSIGN} && python3 "\${S}" ${ARGS}`],
    [`${ASSIGN}\npython3 $S ${ARGS}`],
    [`export ${ASSIGN}; python3 -I "$S" ${ARGS}`],
    [`S=$HOME/.claude/skills/tools/scripts/report.py; python3 $S ${ARGS}`],
    [`cd ${WS} && ${ASSIGN}; python3 $S ${ARGS}`],
    [`cd ${WS} && ${ASSIGN} && python3 $S ${ARGS}`],
    [`cd ~ && ${ASSIGN}; python3 $S ${ARGS}`],
  ])("%s is decided as the literal path is", (command) => {
    expect(summary(bash(command))).toBe(summary(bash(LITERAL)));
  });

  test("another installed skill's script is read and classified as its literal path is", () => {
    expect(summary(bash(`S=~/.claude/skills/notes/scripts/notes.py; python3 $S`))).toBe(summary(bash(`python3 ${OTHER_SKILL}`)));
  });

  test("a step with an outward action after the skill is held as outward, as with the literal path", () => {
    expect(category(bash(`${ASSIGN}; python3 $S ${ARGS} && git push origin HEAD`))).toBe("outward");
    expect(category(bash(`${LITERAL} && git push origin HEAD`))).toBe("outward");
  });

  test.each([
    ["a prefix assignment, which applies after $S expands", `S=${SKILL} python3 $S ${ARGS}`],
    ["an assignment in a subshell", `(S=${SKILL}); python3 $S ${ARGS}`],
    ["an assignment in a pipeline stage", `S=${SKILL} | true; python3 $S ${ARGS}`],
    ["an assignment after `||`", `true || S=${SKILL}; python3 $S ${ARGS}`],
    ["an assignment chained after another", `cd ${WS} && true && S=${SKILL}; python3 $S ${ARGS}`],
    ["an assignment after a cd the command defines as a function", `cd() { false; }; cd ${WS} && ${ASSIGN}; python3 $S ${ARGS}`],
    ["an assignment inside a group", `{ cd ${WS} && ${ASSIGN}; }; python3 $S ${ARGS}`],
    ["an assignment of a command substitution", `cd ${WS} && S=$(echo ${SKILL}); python3 $S ${ARGS}`],
    ["an assignment after the use", `python3 $S ${ARGS}; S=${SKILL}`],
    ["a reassignment by read", `S=${SKILL}; read S < /dev/null; python3 $S ${ARGS}`],
    ["a value with a blank, split by bash but not by zsh", `S="${SPACED}"; python3 $S ${ARGS}`],
    ["a value with a glob character, globbed by bash but not by zsh", `S=${join(SKILLS, "tools", "scripts", "rep*.py")}; python3 $S ${ARGS}`],
  ])("%s leaves the script unread: held", (_what, command) => {
    expect(bash(command).action).toBe("hold");
  });

  test.each([
    ["a test that may fail", `[ -d /tmp ] && S=${SKILL}; python3 $S ${ARGS}`],
    ["a cd into a dir that doesn't exist", `cd /nowhere && ${ASSIGN}; python3 $S ${ARGS}`],
    ["a cd CDPATH may move", `cd item15 && ${ASSIGN}; python3 $S ${ARGS}`],
    ["a cd into a dir an earlier step removes", `rm -rf /tmp/d; cd /tmp && ${ASSIGN}; python3 $S ${ARGS}`],
  ])("an assignment after %s is read both ways: the script where it ran, nothing where the name stayed unset", (_what, command) => {
    expect(summary(bash(command))).toBe(summary(bash(LITERAL)));
  });

  test("where the step before the assignment fails, the words after the unset name are the program's", () => {
    // `python3 $S upload.py` with S unset runs upload.py.
    expect(bash(`python3 ${OTHER_SKILL} ${UPLOAD}`).action).toBe("allow");
    expect(category(bash(`cd /nowhere && S=${OTHER_SKILL}; python3 $S ${UPLOAD}`))).toBe("outward");
    expect(category(bash(`cd ${WS} && S=${OTHER_SKILL}; python3 $S ${UPLOAD}`))).toBe("outward");
  });

  test("a name the worker's environment holds is unknown where the assignment didn't run", () => {
    const v = classifyToolCall({ toolName: "Bash", toolInput: { command: `cd ${WS} && ${ASSIGN}; python3 $S ${ARGS}` }, cwd: WS }, config, { ...probes(), env: (n: string) => (n === "S" ? "/elsewhere.py" : undefined) });
    expect(v.action).toBe("hold");
  });

  test("a quoted value with a blank is the one path both shells run", () => {
    expect(summary(bash(`S="${SPACED}"; python3 "$S" ${ARGS}`))).toBe(summary(bash(`python3 "${SPACED}" ${ARGS}`)));
  });

  test("a reassignment by for is followed, and the step after the loop is read for every way the loop may end", () => {
    expect(category(bash(`S=${SKILL}; for S in ${UPLOAD}; do :; done; python3 $S`))).toBe("outward");
  });

  test.each([
    ["eval", `S=${SKILL}; eval "S=${UPLOAD}"; python3 $S`],
    ["source", `S=${SKILL}; source ${SET_S}; python3 $S`],
    ["a function", `f() { S=${UPLOAD}; }; S=${SKILL}; f; python3 $S`],
  ])("a reassignment by %s runs the script it names", (_what, command) => {
    expect(category(bash(command))).toBe("outward");
  });
});

describe("the installed skill scripts stay protected from workers", () => {
  test("a write into ~/.claude/skills is held", () => {
    expect(bash(`echo 'print(1)' > ${OTHER_SKILL}`).action).toBe("hold");
    expect(bash(`cp ${UPLOAD} ${SKILL}`).action).toBe("hold");
  });

  test("a skill script the command itself writes first is not read as the one installed", () => {
    expect(bash(`S=${SKILL}; cp /tmp/evil.py $S; python3 $S ${ARGS}`).action).toBe("hold");
  });

  test("a skill dir linked to /tmp is the script it leads to, through the variable as by its literal path", () => {
    const literal = bash(`python3 ${LINKED_SKILL} ${ARGS}`);
    expect(category(literal)).toBe("outward");
    expect(summary(bash(`S=~/.claude/skills/linked/tools/scripts/report.py; python3 $S ${ARGS}`))).toBe(summary(literal));
  });
});
