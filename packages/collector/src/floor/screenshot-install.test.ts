import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { classifyToolCall, defaultProbes, type FloorProbes } from "./classify.js";
import { OWNER_ONLY_CATEGORIES } from "./gate.js";
import type { FloorCategory, FloorConfig, FloorVerdict } from "./gate.js";

/*
 * The install's screenshot and recording helper (scripts/pipeline-screenshot.ts,
 * its --record mode in scripts/pipeline-recording.ts), run from the Standup
 * install itself, against a real scratch layout: a temp install holding copies
 * of the helper and the modules it imports, a worktree under a fake data dir,
 * and a fake home. A capture into the worker's own ground is allowed whether
 * Bun starts in the install or names the helper by its absolute path; the
 * helper run any other way is install code, read for what it does; every way
 * of turning the same command into a write into the install still holds.
 */

const REPO = resolve(import.meta.dir, "../../../..");
const SHIPPED = ["scripts/pipeline-screenshot.ts", "scripts/pipeline-recording.ts", "packages/shared/src/review.ts", "packages/shared/src/pipeline.ts"];
const PAGE = "http://localhost:5173/";
const SHOTS = "/tmp/standup-screenshots-1000";

let base: string;
let install: string;
let root: string;
let home: string;
let helper: string;
let config: FloorConfig;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "floor-shot-install-")));
  const data = join(base, "data");
  install = join(base, "install");
  root = join(data, "worktrees", "standup", "feat-1");
  home = join(base, "home");
  for (const d of [join(root, "scripts"), join(root, "preloading"), join(root, "dotenv"), join(data, "secrets"), join(install, "packages/collector/src/floor"), join(home, ".claude")]) {
    mkdirSync(d, { recursive: true });
  }
  for (const f of SHIPPED) {
    mkdirSync(join(install, f, ".."), { recursive: true });
    writeFileSync(join(install, f), readFileSync(join(REPO, f), "utf8"));
  }
  helper = join(install, "scripts", "pipeline-screenshot.ts");
  writeFileSync(join(install, "scripts", "other.ts"), 'console.log("hi");\n');
  writeFileSync(join(root, "scripts", "pipeline-screenshot.ts"), readFileSync(join(REPO, "scripts/pipeline-screenshot.ts"), "utf8"));
  symlinkSync(helper, join(root, "shot.ts"));
  symlinkSync(join(install, "scripts", "other.ts"), join(root, "into-install.png"));
  writeFileSync(join(root, "preloading", "bunfig.toml"), 'preload = ["./evil.ts"]\n');
  writeFileSync(join(root, "dotenv", ".env"), "STANDUP_PLAYWRIGHT_DIR=/tmp/pw\n");
  writeFileSync(join(root, "bunfig.toml"), '[test]\npreload = ["./test-guard.ts"]\n');
  writeFileSync(join(root, "into-install.ts"), `import { execSync } from "child_process";\nconst step = "cd ${install} && bun add left-pad";\nexecSync(step);\n`);
  // The helpers' own usage text, as shipped.
  const usageOf = (file: string) => /(?:export )?const (?:RECORD_)?USAGE =[\s\S]*?;\n/.exec(readFileSync(join(REPO, file), "utf8"))![0];
  writeFileSync(join(root, "prose.ts"), `${usageOf("scripts/pipeline-screenshot.ts")}console.log(USAGE);\n`);
  writeFileSync(join(root, "record-usage.ts"), `${usageOf("scripts/pipeline-recording.ts")}console.log(RECORD_USAGE);\n`);
  writeFileSync(join(root, "template.ts"), 'const n = 2, ran = 1;\nconsole.log(`${n} command(s) exited 0${ran > 0 ? "; criterion met" : ""}${[1].map((x) => `${x} item`).join(", ")}`);\n');
  writeFileSync(join(root, "template-push.ts"), 'import { execSync } from "child_process";\nconsole.log(`pushed: ${execSync("git push origin HEAD")}`);\n');
  writeFileSync(join(root, "writes-claude.ts"), 'import { execSync } from "child_process";\nconst step = "echo hi > ~/.claude/settings.json";\nexecSync(step);\n');
  writeFileSync(join(root, ".git"), `gitdir: ${join(base, "repo.git")}\n`);
  config = {
    v: 1,
    collectorUrl: "http://localhost:7777",
    launchId: "launch-1",
    root,
    sharedBranches: ["main", "mainline"],
    personalAwsAccounts: [],
    waitSeconds: 60,
    standupDataDir: data,
    floorPaths: [join(install, "packages/collector/src/floor")],
    installDir: install,
    protectedPaths: [join(data, "secrets")],
    tmpDirs: ["/tmp"],
    workerToken: "x".repeat(64),
    replyPublicKey: "test",
  };
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

/** Real filesystem reads; git, the shell snapshot, the home dir and AWS are pinned so the user's own setup can't leak in. */
function probes(extra: Partial<FloorProbes> = {}): Partial<FloorProbes> {
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    homeDir: () => home,
    shellDefinitions: () => ({ aliases: new Map(), functions: new Map() }),
    awsAccount: () => null,
    ...extra,
  };
}

const bash = (command: string, extra: Partial<FloorProbes> = {}): FloorVerdict =>
  classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: root }, config, probes(extra));

/** A worker script in the worktree whose one string is `literal` (JS source, tokens replaced), handed to `execSync`, run with bun. */
function runsLiteral(name: string, literal: string, cwd = root): FloorVerdict {
  const source = literal.replaceAll("INSTALL", install).replaceAll("ROOT", root);
  writeFileSync(join(root, `${name}.ts`), `import { execSync } from "child_process";\nconst step = ${source};\nexecSync(step);\n`);
  return bash(`cd ${cwd} && bun ${root}/${name}.ts`);
}

function expectHold(v: FloorVerdict, category?: FloorCategory): void {
  expect(v.action).toBe("hold");
  if (v.action !== "hold" || category === undefined) return;
  expect(v.category).toBe(category);
  expect(v.ownerOnly).toBe(OWNER_ONLY_CATEGORIES.has(category));
}

describe("the install's screenshot helper is a plain allowed action", () => {
  const RECORD = `--record ${PAGE} --cold --login-url ${PAGE}login --preset persona --mark "first row=.row" --until ".ready" --duration-ms 4000`;
  const cases: Array<[string, () => string]> = [
    ["a screenshot from the install as cwd", () => `cd ${install} && bun scripts/pipeline-screenshot.ts ${PAGE} --out /tmp/a.png --wait-ms 500`],
    ["a screenshot into the per-user dir", () => `cd ${install} && bun scripts/pipeline-screenshot.ts ${PAGE} --out ${SHOTS}/a.png --full-page --width 1280 --height 800 --wait-for "#app"`],
    ["a screenshot through ./scripts", () => `cd ${install} && bun ./scripts/pipeline-screenshot.ts ${PAGE} --out /tmp/a.png`],
    ["a screenshot by absolute path", () => `bun ${helper} ${PAGE} --out /tmp/a.png --wait-ms 500`],
    ["a screenshot with no --out", () => `bun ${helper} ${PAGE}`],
    ["a screenshot of a data: page", () => `bun ${helper} "data:text/html,<h1>hi</h1>" --out ${SHOTS}/a.png`],
    ["a screenshot into the worktree", () => `bun ${helper} ${PAGE} --out ${root}/shots/a.png`],
    ["a recording from the install as cwd", () => `cd ${install} && bun scripts/pipeline-screenshot.ts ${RECORD} --out ${SHOTS}/r.webm`],
    ["a recording by absolute path", () => `bun ${helper} ${RECORD} --out /tmp/r.webm`],
    ["a recording with no --out", () => `cd ${install} && bun scripts/pipeline-screenshot.ts --record ${PAGE}`],
    ["a recording started from a dir with only a [test] preload", () => `cd ${root} && bun ${helper} --record ${PAGE} --out /tmp/r.webm`],
  ];
  for (const [name, command] of cases) {
    test(name, () => {
      expect(bash(command())).toEqual({ action: "allow" });
    });
  }
});

describe("the same command turned into a write into the install, or into unread code, still holds", () => {
  test("--out inside the install is owner-only floor-tamper, in both forms", () => {
    expectHold(bash(`cd ${install} && bun scripts/pipeline-screenshot.ts ${PAGE} --out ${install}/packages/collector/a.png`), "floor-tamper");
    expectHold(bash(`bun ${helper} ${PAGE} --out ${install}/a.png`), "floor-tamper");
    expectHold(bash(`bun ${helper} --record ${PAGE} --out ${install}/scripts/r.webm`), "floor-tamper");
  });

  test("--out through a symlink into the install is floor-tamper", () => {
    expectHold(bash(`bun ${helper} ${PAGE} --out ${root}/into-install.png`), "floor-tamper");
  });

  test("a page on the collector's own API holds as a collector call, as with the worker's own copy", () => {
    expectHold(bash(`bun ${root}/scripts/pipeline-screenshot.ts http://localhost:7777/api/asks --out /tmp/a.png`), "collector-api");
    expectHold(bash(`bun ${helper} http://localhost:7777/api/asks --out /tmp/a.png`), "collector-api");
    expectHold(bash(`cd ${install} && bun scripts/pipeline-screenshot.ts --record ${PAGE} --login-url http://localhost:7777/api/asks --out /tmp/r.webm`), "collector-api");
  });

  test("--out naming the owner's secrets is floor-tamper", () => {
    expectHold(bash(`bun ${helper} ${PAGE} --out ${config.protectedPaths[0]}/a.png`), "floor-tamper");
  });

  test("a real bun add or bun install in the install", () => {
    const v = bash(`cd ${install} && bun add left-pad`);
    expectHold(v, "floor-tamper");
    expect(v.action === "hold" && v.reason).toContain("writes dependencies into the Standup install");
    expectHold(bash(`cd ${install} && bun install`), "floor-tamper");
  });

  test("a command chained after the capture", () => {
    expectHold(bash(`cd ${install} && bun scripts/pipeline-screenshot.ts ${PAGE} --out /tmp/a.png && rm -rf packages`), "floor-tamper");
    expectHold(bash(`cd ${install} && bun scripts/pipeline-screenshot.ts ${PAGE} --out /tmp/a.png; bun add x`), "floor-tamper");
    expectHold(bash(`cd ${install} && bun scripts/pipeline-screenshot.ts ${PAGE} --out /tmp/a.png > scripts/pipeline-screenshot.ts`), "floor-tamper");
    expectHold(bash(`bun ${helper} ${PAGE} --out /tmp/a.png >> ${install}/scripts/other.ts`), "floor-tamper");
  });

  test("an edit to the helper itself", () => {
    expectHold(
      classifyToolCall({ toolName: "Edit", toolInput: { file_path: helper, old_string: "a", new_string: "b" }, cwd: root }, config, probes()),
      "floor-tamper",
    );
  });

  test("piped into a shell, or fed a command substitution", () => {
    expectHold(bash(`bun ${helper} ${PAGE} --out /tmp/a.png | sh`));
    expectHold(bash(`cd ${install} && bun scripts/pipeline-screenshot.ts ${PAGE} --out $(cat /tmp/where)`));
  });

  test("a bun the command defines itself", () => {
    expectHold(bash(`bun() { git push origin HEAD; }; bun ${helper} ${PAGE} --out /tmp/a.png`), "outward");
  });

  test("an --out relative to the install lands in it", () => {
    expectHold(bash(`cd ${install} && bun scripts/pipeline-screenshot.ts ${PAGE} --out a.png`), "floor-tamper");
    expectHold(bash(`cd ${install} && bun scripts/other.ts --out scripts/x.png`), "floor-tamper");
    expectHold(bash(`cd ${install} && bun --eval 'require("fs").writeFileSync("scripts/x.ts", "")'`), "floor-tamper");
  });
});

/*
 * Not run as shipped (other environment, options, arguments, a link to it, a
 * step before it), the helper is install code like any other: the owner's,
 * read for what it does, so it runs unless that reaches the denylist.
 */
describe("the helper run any other way is install code, run like the install's other scripts", () => {
  const cases: Array<[string, () => string]> = [
    ["another script from the install, from inside it", () => `cd ${install} && bun scripts/other.ts ${PAGE} --out /tmp/a.png`],
    ["another script from the install, from outside", () => `bun ${install}/scripts/other.ts ${PAGE} --out /tmp/a.png`],
    ["environment that changes what Bun loads", () => `BUN_OPTIONS=--preload=/tmp/x.ts bun ${helper} ${PAGE} --out /tmp/a.png`],
    ["environment that changes where Playwright comes from", () => `STANDUP_PLAYWRIGHT_DIR=/tmp/pw bun ${helper} ${PAGE} --out /tmp/a.png`],
    ["an exported environment", () => `export STANDUP_SCREENSHOT_ROOTS=/; bun ${helper} ${PAGE} --out /tmp/a.png`],
    ["Bun's own options before the script", () => `bun --preload /tmp/x.ts ${helper} ${PAGE} --out /tmp/a.png`],
    ["bun run from the install", () => `cd ${install} && bun run scripts/pipeline-screenshot.ts ${PAGE} --out /tmp/a.png`],
    ["a .env where Bun starts", () => `cd ${root}/dotenv && bun ${helper} ${PAGE} --out /tmp/a.png`],
    ["a symlink to the helper", () => `bun ${root}/shot.ts ${PAGE} --out /tmp/a.png`],
    ["a path that climbs with ..", () => `cd ${install}/scripts && bun ../scripts/pipeline-screenshot.ts ${PAGE} --out /tmp/a.png`],
    ["an argument the helper doesn't take", () => `cd ${install} && bun scripts/pipeline-screenshot.ts ${PAGE} --out /tmp/a.png --bogus`],
    ["a page that isn't http(s) or data:", () => `bun ${helper} file:///etc/passwd --out /tmp/a.png`],
    ["an --out with the other mode's extension", () => `bun ${helper} --record ${PAGE} --out /tmp/r.png`],
    ["--setup with more", () => `bun ${helper} --setup --record`],
    ["--setup with environment", () => `STANDUP_PLAYWRIGHT_DIR=/tmp/pw bun ${helper} --setup`],
  ];
  for (const [name, command] of cases) test(name, () => expect(bash(command())).toEqual({ action: "allow" }));

  test("the worker's own copy of the helper, run from the install: its setup hint is read as a command run there", () => {
    expectHold(bash(`cd ${install} && bun ${root}/scripts/pipeline-screenshot.ts ${PAGE} --out /tmp/a.png`), "floor-tamper");
  });
});

describe("string literals in code are read as commands only when they could be ones", () => {
  test("the helpers' shipped usage text carries no shell redirections", () => {
    // ~/.claude is floor ground: a real redirect there would be floor-tamper.
    expect(bash(`cd ${home}/.claude && bun ${root}/prose.ts`)).toEqual({ action: "allow" });
    expect(bash(`cd ${home}/.claude && bun ${root}/record-usage.ts`)).toEqual({ action: "allow" });
  });

  test("a template's ${…} code is not text: its `>` is a comparison, its strings are literals of their own", () => {
    expect(bash(`cd ${home}/.claude && bun ${root}/template.ts`)).toEqual({ action: "allow" });
    const v = bash(`bun ${root}/template-push.ts`);
    expectHold(v, "outward");
    expect(v.action === "hold" && v.reason).toContain("git push");
  });

  test("a literal with a real program still has its redirections checked", () => {
    expectHold(bash(`bun ${root}/writes-claude.ts`), "floor-tamper");
  });

  test("a cd inside a literal moves the commands after it", () => {
    const v = bash(`bun ${root}/into-install.ts`);
    expectHold(v, "floor-tamper");
    expect(v.action === "hold" && v.reason).toContain("writes dependencies into the Standup install");
  });

  test("the helper read as code (not run as shipped) runs: its usage text and setup hint are no commands", () => {
    for (const command of [
      `cd ${install} && bun scripts/pipeline-screenshot.ts ${PAGE} --out /tmp/a.png --bogus`,
      `cd ${install} && bun scripts/pipeline-screenshot.ts --record ${PAGE} --out /tmp/a.webm --bogus`,
      `cd ${home}/.claude && bun ${helper} ${PAGE} --out /tmp/a.png --bogus`,
      `cd ${home}/.claude && bun ${helper} --record ${PAGE} --out /tmp/a.webm --bogus`,
    ]) {
      expect({ command, verdict: bash(command) }).toEqual({ command, verdict: { action: "allow" } });
    }
  });
});

describe("a literal's redirections are all checked, whatever comes first", () => {
  const writes: Array<[string, string]> = [
    ["a null command", '": > INSTALL/x"'],
    ["a test builtin", '"[ 1 ] > INSTALL/x"'],
    ["an empty program word", `'"" > INSTALL/x'`],
    ["a program in a variable", `'"$CMD" > INSTALL/x'`],
    ["a template's program name", "`${c} > INSTALL/x`"],
    ["an input that exists first", '"cat <ROOT/bunfig.toml >INSTALL/x"'],
    ["an output before the missing input", '"x >INSTALL/x <nofile"'],
    ["an input path in a variable", '"x <$F >INSTALL/x"'],
    ["an input path that is a glob", '"x <url* >INSTALL/x"'],
    ["a here-string first", '"x <<<hi >INSTALL/x"'],
    ["a missing input after a command that may have made it", '"touch url; x <url >INSTALL/x"'],
    ["a missing input first", '"x <nofile >INSTALL/x"'],
    ["numbered fds, input first", '"x 0</tmp/nofile 1>INSTALL/x"'],
    ["exec with a missing input first", '"exec </tmp/nofile >INSTALL/x"'],
  ];
  for (const [name, literal] of writes) {
    test(`${name} still writes into the install`, () => {
      expectHold(runsLiteral(`w-${name.replace(/\W+/g, "-")}`, literal), "floor-tamper");
    });
  }
});

describe("a cd the floor can't be sure of leaves every place a relative write may land", () => {
  const claude = () => join(home, ".claude");
  const literals: Array<[string, string]> = [
    ["a cd into a dir that isn't there", '"cd /tmp/nodir-standup-test; echo x > settings.json"'],
    ["a cd to a dir code computes", "`cd ${process.env.D}; echo x > settings.json`"],
    ["cd -", '"cd - ; echo x > settings.json"'],
    ["a popd past the stack", '"pushd /tmp; popd; popd; echo x > settings.json"'],
    ["a cd that may fail", '"cd /tmp && echo x > settings.json"'],
  ];
  for (const [name, literal] of literals) {
    test(`in a literal run from ~/.claude: ${name}`, () => {
      expectHold(runsLiteral(`cd-${name.replace(/\W+/g, "-")}`, literal, claude()));
    });
  }

  test("a cd into ~/.claude itself still holds, and one between own dirs is fine", () => {
    expectHold(runsLiteral("cd-claude", '"cd ~/.claude && echo x > settings.json"'), "floor-tamper");
    expect(runsLiteral("cd-own", '"cd /tmp && echo x > out.txt"')).toEqual({ action: "allow" });
  });

  test("in a command, a cd into a dir that isn't there leaves the shell where it was", () => {
    expectHold(bash(`cd ${claude()} && cd /tmp/nodir-standup-test; echo x > settings.json`), "floor-tamper");
    expect(bash("mkdir -p build && cd build && echo x > out.txt")).toEqual({ action: "allow" });
  });
});

describe("a template's ${…} code leaves an unknown value, never a hidden target", () => {
  test("a lone string interpolated as the target is the target", () => {
    expectHold(runsLiteral("t-install", '`cat /tmp/evil > ${"INSTALL/scripts/other.ts"}`'), "floor-tamper");
    expectHold(runsLiteral("t-claude", '`echo hi > ${"~/.claude/settings.json"}`'), "floor-tamper");
  });

  test("a computed program with a redirect holds, and so does a computed target", () => {
    expectHold(runsLiteral("t-program", '`${["cat", "/tmp/evil"].join(" ")} > INSTALL/x`'), "floor-tamper");
    expectHold(runsLiteral("t-program-tmp", '`${cmds.join(" ")} > /tmp/out.txt`'), "unclassified");
    expectHold(runsLiteral("t-target", '`cat /tmp/evil > ${dir + "/x"}`'), "unclassified");
  });
});

describe("--out the floor can't read literally, or a link it made, is not the helper's own write", () => {
  test("a symlink or hard link made with cp to floor code, then written through", () => {
    for (const flag of ["-s", "--symbolic-link", "-l", "--link"]) {
      expectHold(bash(`mkdir -p /tmp/o && cp ${flag} ${install}/packages/collector/src/floor/classify.ts /tmp/o/x.png && bun ${helper} ${PAGE} --out /tmp/o/x.png`), "floor-tamper");
    }
  });

  test("an --out with a glob, braces, ~, $ or a backslash is checked as the write it is", () => {
    for (const out of ["/tmp/o/{a,b}.png", "~/x.png", "$HOME/x.png", "'/tmp/o/a\\b.png'"]) {
      expect({ out, verdict: bash(`bun ${helper} ${PAGE} --out ${out}`) }).toEqual({ out, verdict: { action: "allow" } });
    }
    // A path the floor can't place, in a call naming the install: held.
    for (const out of ["/tmp/o/ln?.png", "/tmp/o/ln[k].png", "/tmp/o/lnk?/a.png"]) {
      expect({ out, action: bash(`bun ${helper} ${PAGE} --out ${out}`).action }).toEqual({ out, action: "hold" });
    }
    expectHold(bash(`bun ${helper} ${PAGE} --out ~/.claude/x.png`), "floor-tamper");
  });

  test("with no --out, a default dir that resolves into the install holds", () => {
    const real = defaultProbes().realpath;
    const uid = process.getuid!();
    const fake = (p: string) => (p.startsWith(`/tmp/standup-screenshots-${uid}`) ? join(install, "scripts") + p.slice(`/tmp/standup-screenshots-${uid}`.length) : real(p));
    expectHold(bash(`bun ${helper} ${PAGE}`, { realpath: fake }), "floor-tamper");
    expectHold(bash(`cd ${install} && bun scripts/pipeline-screenshot.ts --record ${PAGE}`, { realpath: fake }), "floor-tamper");
  });

  test("every recording flag the helper takes is accepted", () => {
    const all = `--record ${PAGE} --out /tmp/r.webm --login-url ${PAGE}login --cold --preset persona --mark "list=.row" --until ".ready" --duration-ms 3000 --timeout-ms 9000 --tail-ms 800 --width 1280 --height 800 --no-overlay`;
    expect(bash(`cd ${install} && bun scripts/pipeline-screenshot.ts ${all}`)).toEqual({ action: "allow" });
    expect(bash(`bun ${helper} ${all}`)).toEqual({ action: "allow" });
  });
});

describe("the Playwright toolchain is the owner's to change", () => {
  const pw = () => join(home, ".cache", "standup", "playwright");
  const ms = () => join(home, ".cache", "ms-playwright");

  test("planting node_modules/playwright/index.js, by any write the floor reads", () => {
    const entry = () => join(pw(), "node_modules", "playwright", "index.js");
    for (const command of [
      () => `echo 'module.exports = {}' > ${entry()}`,
      () => `cp /tmp/evil.js ${entry()}`,
      () => `mv /tmp/evil.js ${entry()}`,
      () => `ln -sf /tmp/evil.js ${entry()}`,
      () => `tar -xf /tmp/evil.tar -C ${pw()}`,
      () => `unzip /tmp/evil.zip -d ${pw()}`,
      () => `python3 -c 'open("${entry()}", "w").write("x")'`,
      () => `cd ${pw()} && bun add file:/tmp/evil`,
      () => `ln -s /tmp/pw ${pw()}`,
      () => `rm -rf ${join(home, ".cache")}`,
    ]) {
      expectHold(bash(command()), "floor-tamper");
    }
  });

  test("swapping the chromium binary Playwright launches", () => {
    const chrome = () => join(ms(), "chromium-1140", "chrome-linux", "chrome");
    for (const command of [
      () => `cp /tmp/chrome ${chrome()}`,
      () => `mv /tmp/chrome ${chrome()}`,
      () => `ln -sf /tmp/chrome ${chrome()}`,
      () => `rm -rf ${join(ms(), "chromium-1140")}`,
      () => `chmod +x ${chrome()} && cp /tmp/chrome ${chrome()}`,
    ]) {
      expectHold(bash(command()), "floor-tamper");
    }
  });

  test("`playwright install` however it is started", () => {
    for (const command of ["bunx playwright install chromium", "npx playwright install", "bun x playwright install chromium", "npx playwright@1.48 install", `${root}/node_modules/.bin/playwright install`]) {
      expectHold(bash(command), "floor-tamper");
    }
  });

  test("reading it is fine", () => {
    expect(bash(`ls ${pw()}`)).toEqual({ action: "allow" });
  });

  test("the helper's own --setup is allowed, from the install or by absolute path", () => {
    expect(bash(`cd ${install} && bun scripts/pipeline-screenshot.ts --setup`)).toEqual({ action: "allow" });
    expect(bash(`bun ${helper} --setup`)).toEqual({ action: "allow" });
  });

  test("--setup with anything more, or with environment, is the helper read as install code", () => {
    for (const command of [`bun ${helper} --setup --record`, `bun ${helper} --setup extra`, `BUN_OPTIONS=--preload=/tmp/x.ts bun ${helper} --setup`, `STANDUP_PLAYWRIGHT_DIR=/tmp/pw bun ${helper} --setup`]) {
      expect({ command, verdict: bash(command) }).toEqual({ command, verdict: { action: "allow" } });
    }
  });

  test("a HOME the run inherits is the owner's home; one set for the run that holds a toolchain is another", () => {
    const other = join(base, "other-home");
    mkdirSync(join(other, ".cache", "standup", "playwright"), { recursive: true });
    const hookEnv = { env: (name: string) => (name === "HOME" ? other : undefined) };
    expect(bash(`STANDUP_PLAYWRIGHT_DIR=${join(base, "no-pw")} bun ${helper} --setup`, hookEnv)).toEqual({ action: "allow" });
    expectHold(bash(`HOME=${other} bun ${helper} --setup`), "unclassified");
  });
});
