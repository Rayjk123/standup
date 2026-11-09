import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { classifyToolCall, type FloorProbes } from "./classify.js";
import { OWNER_ONLY_CATEGORIES } from "./gate.js";
import type { FloorCategory, FloorConfig, FloorVerdict } from "./gate.js";

/*
 * Writes that reach the Standup install, Claude Code's config, the screenshot
 * helper's Playwright toolchain or Bun's package cache by a way the floor has
 * to read closely: a string literal's redirections and directory changes, a
 * Bun config beside the helper, a hard-linked cache file, a tree copied into a
 * dir above one of them, and a bundle's output. Classified only: nothing here
 * runs. The layout is a scratch install, worktree and home under the system
 * temp dir.
 */

const REPO = resolve(import.meta.dir, "../../../..");
const SHIPPED = ["scripts/pipeline-screenshot.ts", "scripts/pipeline-recording.ts", "packages/shared/src/review.ts", "packages/shared/src/pipeline.ts", "packages/shared/src/topology.ts"];
const PAGE = "http://localhost:5173/";

let base: string;
let install: string;
let root: string;
let home: string;
let helper: string;
let cacheFile: string;
let config: FloorConfig;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "floor-install-writes-")));
  const data = join(base, "data");
  install = join(base, "install");
  root = join(data, "worktrees", "standup", "feat-1");
  home = join(base, "home");
  for (const d of [root, join(root, "defines"), join(root, "dotfile"), join(root, "staging"), join(data, "secrets"), join(install, "packages/collector/src/floor"), join(home, ".claude")]) {
    mkdirSync(d, { recursive: true });
  }
  for (const f of SHIPPED) {
    mkdirSync(join(install, f, ".."), { recursive: true });
    try {
      writeFileSync(join(install, f), readFileSync(join(REPO, f), "utf8"));
    } catch {
      // A module this checkout doesn't have.
    }
  }
  helper = join(install, "scripts", "pipeline-screenshot.ts");
  writeFileSync(join(root, "bunfig.toml"), '[test]\npreload = ["./test-guard.ts"]\n');
  writeFileSync(join(root, "defines", "bunfig.toml"), '[define]\n"process.env.STANDUP_PLAYWRIGHT_DIR" = "\\"/tmp/evil\\""\n');
  writeFileSync(join(root, "dotfile", ".bunfig.toml"), '[define]\n"process.env.STANDUP_PLAYWRIGHT_DIR" = "\\"/tmp/evil\\""\n');
  writeFileSync(join(root, "staging", ".env.staging"), "STANDUP_PLAYWRIGHT_DIR=/tmp/evil\n");
  cacheFile = join(home, ".bun", "install", "cache", "playwright@1.48.0@@@1", "index.js");
  mkdirSync(join(cacheFile, ".."), { recursive: true });
  writeFileSync(cacheFile, "module.exports = {};\n");
  // `bun install` hard-links a project's node_modules files to the cache's.
  mkdirSync(join(root, "node_modules", "playwright"), { recursive: true });
  linkSync(cacheFile, join(root, "node_modules", "playwright", "index.js"));
  writeFileSync(join(root, "notes.txt"), "mine\n");
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

const bash = (command: string): FloorVerdict => classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: root }, config, probes());

/** A worker script whose one string is `literal` (JS source; INSTALL, ROOT and HOME replaced), handed to `execSync`, run with bun from `cwd`. */
function runsLiteral(name: string, literal: string, cwd = root, before = ""): FloorVerdict {
  const source = literal.replaceAll("INSTALL", install).replaceAll("ROOT", root).replaceAll("HOME", home);
  writeFileSync(join(root, `${name}.ts`), `import { execSync } from "child_process";\n${before}const step = ${source};\nexecSync(step);\n`);
  return bash(`cd ${cwd} && bun ${root}/${name}.ts`);
}

function expectHold(v: FloorVerdict, category?: FloorCategory): void {
  expect(v.action).toBe("hold");
  if (v.action !== "hold" || category === undefined) return;
  expect(v.category).toBe(category);
  expect(v.ownerOnly).toBe(OWNER_ONLY_CATEGORIES.has(category));
}

/**
 * Not run as shipped, the helper is install code like any other: the
 * owner's, read for what it does, so it runs unless that reaches the
 * denylist.
 */
function expectInstallCode(command: string, run: (c: string) => FloorVerdict = bash): void {
  expect({ command, verdict: run(command) }).toEqual({ command, verdict: { action: "allow" } });
}

/** The head of a module that runs a command as it loads, so the strings in it are read as commands once it is read. */
const RUNS = 'import { execSync } from "child_process";\nexecSync("true");\n';

/** A module a value import names is read: its `step` literal (beside RUNS, a command it may run) holds. */
function expectModuleRead(v: FloorVerdict): void {
  expect({ action: v.action, names: v.action === "hold" && v.reason.includes(".claude/settings.json") }).toEqual({ action: "hold", names: true });
}

describe("H1: a literal's redirections all count, whichever comes first", () => {
  const cases: Array<[string, string, string?]> = [
    ["a missing input first", '"x <nofile >INSTALL/x"'],
    ["numbered fds, input first", '"x 0</tmp/nofile-standup 1>INSTALL/x"'],
    ["exec with a missing input first", '"exec </tmp/nofile-standup >INSTALL/x"'],
    ["an input the code itself writes first", '"x <url >INSTALL/x"', 'require("fs").writeFileSync("url", "");\n'],
  ];
  for (const [name, literal, before] of cases) {
    test(name, () => {
      expectHold(runsLiteral(`h1-${name.replace(/\W+/g, "-")}`, literal, root, before), "floor-tamper");
    });
  }
});

describe("H2: a cd in a literal the floor can't be sure of leaves every place a relative write may land", () => {
  const claude = () => join(home, ".claude");
  const cases: Array<[string, string]> = [
    ["a cd into a dir that isn't there", '"cd /tmp/nodir-standup-test; echo x > settings.json"'],
    ["a cd to a dir code computes", "`cd ${process.env.D}; echo x > settings.json`"],
    ["cd -", '"cd - ; echo x > settings.json"'],
    ["a popd past the stack", '"pushd /tmp; popd; popd; echo x > settings.json"'],
    ["a cd that may fail", '"cd /tmp && echo x > settings.json"'],
  ];
  for (const [name, literal] of cases) {
    test(`from ~/.claude: ${name}`, () => {
      expectHold(runsLiteral(`h2-${name.replace(/\W+/g, "-")}`, literal, claude()));
    });
  }

  test("in a command, a cd into a dir that isn't there leaves the shell where it was", () => {
    expectHold(bash(`cd ${claude()} && cd /tmp/nodir-standup-test; echo x > settings.json`), "floor-tamper");
  });

  test("a cd into ~/.claude still holds; one between own dirs, or into a dir the command makes, is fine", () => {
    expectHold(runsLiteral("h2-claude", '"cd HOME/.claude && echo x > settings.json"'), "floor-tamper");
    expect(runsLiteral("h2-own", '"cd /tmp && echo x > out.txt"')).toEqual({ action: "allow" });
    expect(bash("mkdir -p build && cd build && echo x > out.txt")).toEqual({ action: "allow" });
  });
});

describe("H3: a Bun config or .env where the helper starts is not the helper as shipped: it is install code", () => {
  test("a bunfig.toml or .bunfig.toml with [define], or any .env file", () => {
    expectInstallCode(`cd ${root}/defines && bun ${helper} ${PAGE} --out /tmp/a.png`);
    expectInstallCode(`cd ${root}/dotfile && bun ${helper} ${PAGE} --out /tmp/a.png`);
    expectInstallCode(`cd ${root}/staging && bun ${helper} ${PAGE} --out /tmp/a.png`);
    expectInstallCode(`cd ${root}/defines && bun ${helper} --setup`);
  });

  test("a home bunfig with [define]", () => {
    writeFileSync(join(home, ".bunfig.toml"), '[define]\n"process.env.HOME" = "\\"/tmp\\""\n');
    try {
      expectInstallCode(`bun ${helper} ${PAGE} --out /tmp/a.png`);
    } finally {
      rmSync(join(home, ".bunfig.toml"), { force: true });
    }
  });

  test("a bunfig written earlier in the same command", () => {
    expectInstallCode(`printf '[define]\\n"process.env.X" = "1"\\n' > bunfig.toml && bun ${helper} ${PAGE} --out /tmp/a.png`);
    // A bunfig copied from a file the floor can't read may preload any code before the helper.
    expectHold(bash(`cp /tmp/evil.toml bunfig.toml && bun ${helper} ${PAGE} --out /tmp/a.png`), "unclassified");
    expectHold(bash(`printf 'x' > ${install}/bunfig.toml && bun ${helper} ${PAGE} --out /tmp/a.png`), "floor-tamper");
  });

  test("a [test]-only bunfig still lets a capture through", () => {
    expect(bash(`bun ${helper} ${PAGE} --out /tmp/a.png`)).toEqual({ action: "allow" });
  });
});

describe("H4: a file in Bun's package cache is rewritten in place only by the owner", () => {
  test("in-place writes onto an existing cache file", () => {
    for (const command of [
      () => `echo x > ${cacheFile}`,
      () => `echo x >> ${cacheFile}`,
      () => `echo x | tee ${cacheFile}`,
      () => `cp /tmp/evil.js ${cacheFile}`,
      () => `dd if=/tmp/evil.js of=${cacheFile}`,
      () => `truncate -s 0 ${cacheFile}`,
      () => `python3 -c 'open("${cacheFile}", "w").write("x")'`,
    ]) {
      expectHold(bash(command()), "floor-tamper");
    }
  });

  test("unlinking, renaming over it and new entries change no shared inode", () => {
    for (const v of [bash(`rm ${cacheFile}`), bash(`sed -i s/a/b/ ${cacheFile}`),bash(`mv /tmp/new.js ${cacheFile}`), bash(`echo x > ${join(cacheFile, "..", "fresh.js")}`)]) {
      if (v.action === "hold") expect(v.category).not.toBe("floor-tamper");
    }
    expect(bash("bun install")).toEqual({ action: "allow" });
  });
});

describe("H5: a tree copied or moved into a dir above a protected root", () => {
  test("into ~/.cache, above the toolchain", () => {
    for (const command of [
      () => `cp -r /tmp/evil/standup ${home}/.cache/`,
      () => `cp -r /tmp/evil/. ${home}/.cache`,
      () => `cp -rT /tmp/evil ${home}/.cache/standup`,
      () => `rsync -a /tmp/evil/ ${home}/.cache/`,
      () => `mv -T /tmp/evil/standup ${home}/.cache/standup`,
      () => `mv /tmp/evil ${home}/.cache/standup/playwright`,
    ]) {
      expectHold(bash(command()), "floor-tamper");
    }
  });

  test("into the home dir, which holds ~/.claude", () => {
    expectHold(bash(`rsync -a /tmp/x/ ${home}/`), "floor-tamper");
    expectHold(bash(`cp -a /tmp/x/. ${home}`), "floor-tamper");
  });

  test("a tree copied within the worktree is fine", () => {
    expect(bash("cp -r src lib")).toEqual({ action: "allow" });
  });
});

describe("M2: a bundle's output is a write", () => {
  test("into the install or ~/.claude holds; into the worktree is fine", () => {
    expectHold(bash(`bun build src/index.ts --outdir ${install}/packages/collector/dist`), "floor-tamper");
    expectHold(bash(`bun build src/index.ts --outfile=${home}/.claude/hooks/x.js`), "floor-tamper");
    expect(bash("bun build src/index.ts --outdir dist")).toEqual({ action: "allow" });
    expect(bash("bun build src/index.ts --outfile=dist/x.js")).toEqual({ action: "allow" });
  });
});

describe("a module imported only for its types is not run", () => {
  test("`import type` / `export type` from a module skip its code; a value import still reads it", () => {
    writeFileSync(join(root, "writes-claude.ts"), RUNS + 'export type T = string;\nexport const step = "echo x > ~/.claude/settings.json";\n');
    writeFileSync(join(root, "types-only.ts"), 'import type { T } from "./writes-claude";\nexport type { T as U } from "./writes-claude";\nconst t: T = "x";\nconsole.log(t);\n');
    writeFileSync(join(root, "values.ts"), 'import type { T } from "./writes-claude";\nimport { step } from "./writes-claude";\nconsole.log(step);\n');
    expect(bash(`bun ${root}/types-only.ts`)).toEqual({ action: "allow" });
    expectModuleRead(bash(`bun ${root}/values.ts`));
  });
});

describe("R3-H1: only a real type-only import or export skips a module", () => {
  const imports: Array<[string, string, string]> = [
    ["a default import named `type`", "ts", 'import type from "./writes-claude";\nconsole.log(type);\n'],
    ["a default import named `type`, split over lines", "ts", 'import type\n  from "./writes-claude";\nconsole.log(type);\n'],
    ["`type` beside named imports", "ts", 'import type, { step } from "./writes-claude";\nconsole.log(type, step);\n'],
    ["`import type { … }` in a .js file, which isn't TypeScript", "js", 'import type { T } from "./writes-claude";\nconsole.log(1);\n'],
  ];
  for (const [name, ext, source] of imports) {
    test(`${name} reads the module`, () => {
      writeFileSync(join(root, "writes-claude.ts"), RUNS + 'export type T = string;\nexport const step = "echo x > ~/.claude/settings.json";\nexport default step;\n');
      const file = join(root, `imports-${name.replace(/\W+/g, "-")}.${ext}`);
      writeFileSync(file, source);
      expectModuleRead(bash(`bun ${file}`));
    });
  }

  test("`import type { T }`, `import type T from`, `import type * as N` and `export type * from` skip it", () => {
    writeFileSync(join(root, "writes-claude.ts"), RUNS + 'export type T = string;\nexport const step = "echo x > ~/.claude/settings.json";\n');
    writeFileSync(join(root, "types-only-2.ts"), 'import type { T } from "./writes-claude";\nimport type D from "./writes-claude";\nimport type * as N from "./writes-claude";\nexport type * from "./writes-claude";\nconst t: T | D | N.T = "x";\nconsole.log(t);\n');
    expect(bash(`bun ${root}/types-only-2.ts`)).toEqual({ action: "allow" });
  });
});

describe("R3-H2: a file hard-linked elsewhere is rewritten in place only by the owner", () => {
  test("a worktree node_modules file bun install linked to the cache", () => {
    expectHold(bash("echo x > node_modules/playwright/index.js"), "floor-tamper");
    expectHold(bash("cp /tmp/evil.js node_modules/playwright/index.js"), "floor-tamper");
  });

  test("a hard link made out of the cache, then written", () => {
    expectHold(bash(`ln ${cacheFile} /tmp/hl-standup-test && echo x > /tmp/hl-standup-test`), "floor-tamper");
    expectHold(bash(`cp -l ${cacheFile} /tmp/hl3-standup-test && echo x > /tmp/hl3-standup-test`), "floor-tamper");
    expectHold(bash(`cp --link ${cacheFile} /tmp/hl4-standup-test`), "floor-tamper");
  });

  test("an own file with one link is fine; renaming over a linked one is only the node_modules write hold", () => {
    expect(bash("echo x > notes.txt")).toEqual({ action: "allow" });
    expectHold(bash("sed -i s/a/b/ node_modules/playwright/index.js"), "unseen-code");
  });
});

describe("R3-H5: a symlink or rename creating the toolchain, or a dir above it", () => {
  test("ln -s and mv onto ~/.cache/standup, …/playwright or ~/.cache/ms-playwright before they exist", () => {
    for (const command of [
      () => `ln -s /tmp/evil/standup ${home}/.cache/standup`,
      () => `ln -s /tmp/evil/standup ${home}/.cache/`,
      () => `ln -sfn /tmp/evil/pw ${home}/.cache/standup/playwright`,
      () => `ln -s /tmp/evil/ms ${home}/.cache/ms-playwright`,
      () => `mv /tmp/evil-link ${home}/.cache/standup`,
    ]) {
      expectHold(bash(command()), "floor-tamper");
    }
  });

  test("a plain mkdir of ~/.cache/standup is fine", () => {
    expect(bash(`mkdir -p ${home}/.cache/standup`)).toEqual({ action: "allow" });
  });

  test("the helper isn't run as shipped when its toolchain dir is reached through a symlink below the home dir: it is install code", () => {
    mkdirSync(join(base, "elsewhere"), { recursive: true });
    mkdirSync(join(home, ".cache"), { recursive: true });
    symlinkSync(join(base, "elsewhere"), join(home, ".cache", "standup"));
    try {
      expectInstallCode(`bun ${helper} ${PAGE} --out /tmp/a.png`);
      expectInstallCode(`bun ${helper} --setup`);
    } finally {
      rmSync(join(home, ".cache", "standup"), { force: true });
    }
  });
});

describe("R3-M2: writes into Bun's package cache hold for the owner, however they land", () => {
  const pkg = () => join(cacheFile, "..");
  test("a tree copied or synced into a cache package", () => {
    expectHold(bash(`cp -r /tmp/evil/. ${pkg()}/`), "floor-tamper");
    expectHold(bash(`rsync -a /tmp/evil/ ${pkg()}/`), "floor-tamper");
  });

  test("rsync writing in place onto a cache file", () => {
    expectHold(bash(`rsync --inplace /tmp/evil.js ${cacheFile}`), "floor-tamper");
    expectHold(bash(`rsync --append /tmp/evil.js ${cacheFile}`), "floor-tamper");
  });

  test("an archive extracted over a cache package", () => {
    expectHold(bash(`unzip -o /tmp/evil.zip -d ${pkg()}`), "floor-tamper");
    expectHold(bash(`tar --overwrite -xf /tmp/evil.tar -C ${pkg()}`), "floor-tamper");
  });
});

describe("pax and cpio copying a tree onto or above a protected root", () => {
  test("pax -rw and cpio -p into ~/.cache, the home dir or the cache", () => {
    for (const command of [
      () => `pax -rw /tmp/evil/standup ${home}/.cache`,
      () => `pax -r -w /tmp/evil/standup ${home}`,
      () => `cd /tmp/evil && find standup | cpio -pdm ${home}/.cache`,
      () => `find . | cpio -p ${home}/.cache/standup`,
      () => `find . | cpio --pass-through --make-directories ${join(cacheFile, "..")}`,
    ]) {
      expectHold(bash(command()), "floor-tamper");
    }
  });

  test("into the worktree is fine", () => {
    expect(bash("find src | cpio -pdm copy")).toEqual({ action: "allow" });
    expect(bash("pax -rw src copy")).toEqual({ action: "allow" });
  });
});

describe("cd options before the target", () => {
  test("`cd --`, `cd -P`, `pushd --` still move where later relative writes land", () => {
    const claude = join(home, ".claude");
    for (const command of [`cd -- ${claude}; echo x > settings.json`, `cd -P ${claude} && echo x > settings.json`, `cd -L -- ${claude}; echo x > settings.json`, `pushd -- ${claude}; echo x > settings.json`]) {
      expectHold(bash(command), "floor-tamper");
    }
  });
});

describe("R4-1: a string-named import specifier is not a type-only import", () => {
  test("`import { \"export type {\" as s } from` reads the module", () => {
    writeFileSync(join(root, "string-named.ts"), RUNS + 'const step = "echo x > ~/.claude/settings.json";\nexport { step as "export type {" };\n');
    writeFileSync(join(root, "imports-string-named.ts"), 'import { "export type {" as s } from "./string-named";\nconsole.log(s);\n');
    expectModuleRead(bash(`bun ${root}/imports-string-named.ts`));
  });

  test("a comment naming `export type {` inside an import clause reads the module", () => {
    writeFileSync(join(root, "comment-named.ts"), RUNS + 'export const step = "echo x > ~/.claude/settings.json";\n');
    writeFileSync(join(root, "imports-comment-named.ts"), 'import { step // export type {\n} from "./comment-named";\nconsole.log(step);\n');
    expectModuleRead(bash(`bun ${root}/imports-comment-named.ts`));
  });
});

describe("R4-3: code that only reads a hard-linked file is not writing it", () => {
  test("writeFileSync elsewhere of readFileSync(<hard-linked file>)", () => {
    expect(bash(`bun -e "require('fs').writeFileSync('out.json', require('fs').readFileSync('${root}/node_modules/playwright/index.js'))"`)).toEqual({ action: "allow" });
  });

  test("code that writes a hard-linked file by absolute path still holds", () => {
    expectHold(bash(`bun -e "require('fs').appendFileSync('${root}/node_modules/playwright/index.js', 'x')"`), "floor-tamper");
    expectHold(bash(`bun -e "require('fs').writeFileSync('${root}/node_modules/playwright/index.js', require('fs').readFileSync('/tmp/evil.js'))"`), "floor-tamper");
    expectHold(bash(`python3 -c "open('${root}/node_modules/playwright/index.js', 'w').write('x')"`), "floor-tamper");
    expectHold(bash(`bun -e "Bun.file('${root}/node_modules/playwright/index.js').write('x')"`), "floor-tamper");
  });
});

describe("R5-1: a default import whose name starts with `type` is a real import", () => {
  test("`import types from`, `import typeorm from`, `import type$ from` read the module", () => {
    writeFileSync(join(root, "typed-default.ts"), RUNS + 'export default "echo x > ~/.claude/settings.json";\n');
    for (const name of ["types", "typeorm", "type$", "typeX"]) {
      const file = `imports-${name.replace(/\$/g, "dollar")}.ts`;
      writeFileSync(join(root, file), `import ${name} from "./typed-default";\nconsole.log(${name});\n`);
      expectModuleRead(bash(`bun ${root}/${file}`));
    }
  });

  test("real type-only forms still load nothing", () => {
    writeFileSync(join(root, "typed-only.ts"), RUNS + 'export type T = string;\nexport const step = "echo x > ~/.claude/settings.json";\n');
    writeFileSync(join(root, "imports-type-only.ts"), 'import type { T } from "./typed-only";\nimport type T2 from "./typed-only";\nconst x: T = "a";\nconsole.log(x);\n');
    expect(bash(`bun ${root}/imports-type-only.ts`)).toEqual({ action: "allow" });
  });
});

describe("R5-2: a writer bound to a reader's name is not a read", () => {
  const link = () => `${root}/node_modules/playwright/index.js`;
  test("destructuring and import renames of a writer to a reader's name", () => {
    expectHold(bash(`bun -e "const { appendFileSync: readFile } = require('fs'); readFile('${link()}', 'x'); require('fs').writeFileSync('out.json', 'x')"`), "floor-tamper");
    expectHold(bash(`bun -e "const fs = require('fs'); const { appendFileSync: readFile } = fs; readFile('${link()}', 'x'); fs.writeFileSync('out.json', 'x')"`), "floor-tamper");
    expectHold(bash(`bun -e "(({ appendFileSync: readFile }) => readFile('${link()}', 'x'))(require('fs')); require('fs').writeFileSync('out.json','x')"`), "floor-tamper");
    expectHold(bash(`bun -e "var [readFile] = [require('fs').appendFileSync]; readFile('${link()}', 'x'); require('fs').writeFileSync('out.json','x')"`), "floor-tamper");
    writeFileSync(join(root, "renamed-writer.ts"), `import { appendFileSync as readFile, writeFileSync } from "fs";\nreadFile("${link()}", "x");\nwriteFileSync("out.json", "x");\n`);
    expectHold(bash(`bun ${root}/renamed-writer.ts`), "floor-tamper");
  });
});

describe("R5-3: a read call given write flags or extra options is not a read", () => {
  const link = () => `${root}/node_modules/playwright/index.js`;
  test("readFileSync / createReadStream with a flag object, python open with an opener", () => {
    expectHold(bash(`bun -e "require('fs').readFileSync('${link()}', { flag: 'w' }); require('fs').writeFileSync('out.json', 'x')"`), "floor-tamper");
    expectHold(bash(`bun -e "require('fs').createReadStream('${link()}', { flags: 'w' }); require('fs').writeFileSync('out.json', 'x')"`), "floor-tamper");
    expectHold(bash(`python3 -c "import os; open('${link()}', 'r', opener=lambda p, f: os.open(p, os.O_RDWR | os.O_TRUNC)); open('/tmp/x', 'w')"`), "floor-tamper");
  });

  test("a plain read, or one with a literal encoding, stays a read", () => {
    expect(bash(`bun -e "require('fs').writeFileSync('out.json', require('fs').readFileSync('${link()}', 'utf8'))"`)).toEqual({ action: "allow" });
    expect(bash(`bun -e "require('fs').writeFileSync('out.json', require('fs').readFileSync('${link()}'))"`)).toEqual({ action: "allow" });
  });
});

describe("R5-4: a cache link the worker could have made drops the helper allowance: it is install code", () => {
  test("a user-owned ~/.cache symlink (one the worker can retarget) is not trusted", () => {
    const home2 = join(base, "home-user-linked-cache");
    const target = join(base, "user-cache-target");
    mkdirSync(join(target, "standup", "playwright"), { recursive: true });
    mkdirSync(home2, { recursive: true });
    symlinkSync(target, join(home2, ".cache"));
    const real = probes({ homeDir: () => home2 });
    expectInstallCode(`bun ${helper} ${PAGE} --out /tmp/a.png`, (command) => classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: root }, config, real));
  });

  test("a root-owned ~/.cache symlink (an admin-provisioned home) is trusted", () => {
    const home2 = join(base, "home-root-linked-cache");
    const realCache = join(base, "root-cache-target");
    mkdirSync(join(realCache, "standup", "playwright"), { recursive: true });
    mkdirSync(home2, { recursive: true });
    symlinkSync(realCache, join(home2, ".cache"));
    // The link reads as root's, as an admin-provisioned home's would.
    const rootOwned = probes({
      homeDir: () => home2,
      lstat: (p: string) => {
        try {
          const st = lstatSync(p);
          return { symlink: st.isSymbolicLink(), file: st.isFile(), nlink: st.nlink, uid: p === join(home2, ".cache") ? 0 : st.uid };
        } catch {
          return null;
        }
      },
    });
    const v = classifyToolCall({ toolName: "Bash", toolInput: { command: `bun ${helper} ${PAGE} --out /tmp/a.png` }, cwd: root }, config, rootOwned);
    expect(v).toEqual({ action: "allow" });
  });

  test("replacing the cache root in the same command drops the allowance", () => {
    expectInstallCode(`ln -sfn /tmp/evil ${home}/.cache && bun ${helper} ${PAGE} --out /tmp/a.png`);
  });
});

describe("R5-5: only directory changes may run before the helper as shipped; after anything else it is install code", () => {
  test("env set by printf -v, declare -n, export $(…) or any other program before it", () => {
    for (const before of ["printf -v STANDUP_PLAYWRIGHT_DIR %s /tmp/evil/standup/playwright; export STANDUP_PLAYWRIGHT_DIR", "export $(cat /tmp/env.sh | cut -d' ' -f2)"]) {
      expectInstallCode(`${before}; bun ${helper} ${PAGE} --out /tmp/a.png`);
    }
    // A preload or nameref the floor can't read may load anything into the run: held as any run's is.
    for (const before of ["printf -v BUN_OPTIONS %s --preload=/tmp/evil/x.ts; export BUN_OPTIONS", "declare -n r=XDG_CACHE_HOME; r=/tmp/evil; export XDG_CACHE_HOME", "read BUN_OPTIONS < /tmp/env.txt; export BUN_OPTIONS"]) {
      const command = `${before}; bun ${helper} ${PAGE} --out /tmp/a.png`;
      expect({ command, action: bash(command).action }).toEqual({ command, action: "hold" });
    }
  });

  test("a cd before it still runs as shipped", () => {
    expect(bash(`cd ${install} && bun scripts/pipeline-screenshot.ts ${PAGE} --out /tmp/a.png`)).toEqual({ action: "allow" });
  });
});

describe("R6-1: --out through /proc/self/cwd is the command's cwd, not the hook's", () => {
  test("a cd into protected ground then --out /proc/self/cwd/… holds", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    expect(bash(`cd ${home}/.claude && bun ${helper} ${PAGE} --out /proc/self/cwd/r.png`).action).toBe("hold");
    expect(bash(`cd ${install} && bun scripts/pipeline-screenshot.ts ${PAGE} --out /proc/self/cwd/scripts/x.png`).action).toBe("hold");
  });

  test("--out under /proc or /dev is never the helper's own ground: it is install code writing there", () => {
    for (const out of ["/proc/self/fd/1", "/dev/shm/a.png", "/proc/self/root/tmp/a.png"]) expectInstallCode(`bun ${helper} ${PAGE} --out ${out}`);
  });
});

describe("R6-2: programs that change no environment may run before the helper", () => {
  test("mkdir -p into own ground, ls, echo, pwd before the helper", () => {
    for (const before of ["mkdir -p /tmp/standup-shots-r6", `mkdir -p ${root}/media`, "ls /tmp", "echo starting", "pwd"]) {
      expect(bash(`${before} && bun ${helper} ${PAGE} --out /tmp/a.png`)).toEqual({ action: "allow" });
    }
  });

  test("anything that may set env still drops the allowance: the helper is install code, its preload read as any run's", () => {
    for (const before of ["echo $(export BUN_OPTIONS=x)", "eval 'export BUN_OPTIONS=x'"]) expectInstallCode(`${before}; bun ${helper} ${PAGE} --out /tmp/a.png`);
    expect(bash(`printf -v BUN_OPTIONS %s --preload=/tmp/x.ts; export BUN_OPTIONS; bun ${helper} ${PAGE} --out /tmp/a.png`).action).toBe("hold");
  });
});

describe("R6-3: steps running alongside the helper, or set up to run without a call, drop the allowance", () => {
  const run = () => `bun ${helper} ${PAGE} --out /tmp/a.png`;
  test("a write backgrounded or piped alongside the helper is read as the write it is", () => {
    expect(bash(`${run()} & echo STANDUP_PLAYWRIGHT_DIR=/tmp/evil > .env`)).toEqual({ action: "allow" });
    expect(bash(`${run()} | (echo STANDUP_PLAYWRIGHT_DIR=/tmp/evil > .env)`)).toEqual({ action: "allow" });
    expect(bash(`${run()} & printf '[define]' > ${install}/bunfig.toml`).action).toBe("hold");
  });

  test("a read-only pipe after the helper stays allowed", () => {
    expect(bash(`${run()} 2>&1 | tail -5`)).toEqual({ action: "allow" });
  });

  test("a function defined before the helper (zsh runs chpwd and TRAP* without a call) makes it install code", () => {
    expectInstallCode(`chpwd() { export BUN_OPTIONS=--preload=/tmp/evil/x.ts; }; cd /tmp && ${run()}`);
    expectInstallCode(`TRAPDEBUG() { export BUN_OPTIONS=--preload=/tmp/evil/x.ts; }; ${run()}`);
  });

  test("arithmetic before the helper (it runs substitutions held in variables) holds", () => {
    expect(bash(`X='a[$(echo STANDUP_PLAYWRIGHT_DIR=/tmp/evil > .env)]'; (( X )); ${run()}`).action).toBe("hold");
    expect(bash(`X='a[$(echo x)]'; [[ X -eq 0 ]]; ${run()}`).action).toBe("hold");
  });

  test("two captures in one command are both allowed", () => {
    expect(bash(`${run()} && bun ${helper} ${PAGE} --out /tmp/b.png`)).toEqual({ action: "allow" });
    expect(bash(`bun ${helper} ${PAGE} --out /tmp/a.png; bun ${helper} --record ${PAGE} --cold --out /tmp/b.webm`)).toEqual({ action: "allow" });
  });
});

describe("R6-4: only fs itself reading a path is a read", () => {
  const link = () => `${root}/node_modules/playwright/index.js`;
  test("a reader name on another object is no read", () => {
    expectHold(bash(`bun -e "new Proxy(require('fs'), { get: (t) => t.appendFileSync }).readFileSync('${link()}', 'hex'); require('fs').writeFileSync('out.json','x')"`), "floor-tamper");
    writeFileSync(join(root, "w.js"), "exports.readFileSync = (p, x) => require('fs').appendFileSync(p, x);\n");
    expectHold(bash(`bun -e "require('./w').readFileSync('${link()}', 'hex'); require('fs').writeFileSync('out.json','x')"`), "floor-tamper");
  });

  test("python's open is never taken as a read, however it is bound", () => {
    expectHold(bash(`python3 -c "(lambda open: open('${link()}', 'r'))(lambda p, m: __builtins__.open(p, 'a'))"`), "floor-tamper");
    expectHold(bash(`python3 -c "[open('${link()}', 'r') for open in [lambda p, m: __builtins__.open(p, 'a')]]"`), "floor-tamper");
  });

  test("a name bound to fs may be rebound (a parameter, destructuring, &&=, for…of), so a reader on it is no read", () => {
    writeFileSync(join(root, "w2.js"), "module.exports = new Proxy(require('fs'), { get: (t, k) => k === 'readFileSync' ? t.appendFileSync : t[k] });\n");
    for (const code of [
      `const fs = require('fs'); ((fs) => fs.readFileSync('${link()}', 'hex'))(require('./w2'))`,
      `let fs = require('fs'); [fs] = [require('./w2')]; fs.readFileSync('${link()}', 'hex')`,
      `let fs = require('fs'); fs &&= require('./w2'); fs.readFileSync('${link()}', 'hex')`,
      `const fs = require('fs'); for (const fs of [require('./w2')]) fs.readFileSync('${link()}', 'hex')`,
    ]) {
      expectHold(bash(`bun -e "${code}; require('fs').writeFileSync('out.json','x')"`), "floor-tamper");
    }
  });

  test("fs's own readers still read", () => {
    expect(bash(`bun -e "require('fs').writeFileSync('out.json', require('fs').readFileSync('${link()}'))"`)).toEqual({ action: "allow" });
    writeFileSync(join(root, "reads-linked.ts"), `import { readFileSync, writeFileSync } from "fs";\nconst text = readFileSync("${link()}", "utf8");\nwriteFileSync("out.json", text);\n`);
    expect(bash(`bun ${root}/reads-linked.ts`)).toEqual({ action: "allow" });
  });
});

describe("R7-1: timeout and sleep don't stop the helper running as shipped", () => {
  test("timeout around the helper, and sleep before it", () => {
    expect(bash(`timeout 120 bun ${helper} ${PAGE} --out /tmp/a.png`)).toEqual({ action: "allow" });
    expect(bash(`timeout 120s bun ${helper} --record ${PAGE} --cold --out /tmp/r.webm`)).toEqual({ action: "allow" });
    expect(bash(`cd ${install} && timeout 120 bun scripts/pipeline-screenshot.ts ${PAGE} --out /tmp/a.png`)).toEqual({ action: "allow" });
    expect(bash(`sleep 3 && bun ${helper} ${PAGE} --out /tmp/a.png`)).toEqual({ action: "allow" });
  });
});

describe("R7-2: a step before the helper makes it install code, read for what it does", () => {
  test("curl, export or date before the helper", () => {
    for (const before of ["curl -s -o /dev/null http://localhost:5173/", "export FOO=1", "date"]) {
      const command = `${before} && bun ${helper} ${PAGE} --out /tmp/a.png`;
      expect({ command, verdict: bash(command) }).toEqual({ command, verdict: { action: "allow" } });
    }
    expect(bash(`date && bun ${helper} ${PAGE} --out ${install}/a.png`).action).toBe("hold");
  });
});

describe("R7-3: zsh's lowercase path arrays drop the helper allowance: it is install code", () => {
  test("cdpath=(…) before a cd, and path=(…) before the helper", () => {
    mkdirSync(join(root, "sub"), { recursive: true });
    const evil = join(base, "evil-cdpath");
    mkdirSync(join(evil, "sub"), { recursive: true });
    writeFileSync(join(evil, "sub", "bunfig.toml"), 'preload = ["./x.ts"]\n');
    mkdirSync(join(evil, "bin"), { recursive: true });
    writeFileSync(join(evil, "bin", "bun"), "#!/bin/sh\n");
    expectInstallCode(`cdpath=(${evil} .); cd sub && bun ${helper} ${PAGE} --out /tmp/a.png`);
    expectInstallCode(`path=(${evil}/bin $path); bun ${helper} ${PAGE} --out /tmp/a.png`);
  });
});

describe("R4-4: the hold for an own hard-linked file says why", () => {
  test("a shell write and a code write onto node_modules/playwright/index.js", () => {
    const text = "has other hard links (it may be shared with Bun's package cache or the Standup install)";
    for (const v of [bash("echo x > node_modules/playwright/index.js"), bash(`bun -e "require('fs').appendFileSync('${root}/node_modules/playwright/index.js', 'x')"`)]) {
      expectHold(v, "floor-tamper");
      if (v.action === "hold") expect(v.reason).toContain(text);
    }
  });
});

describe("Playwright's CLI module run by path installs browsers too", () => {
  test("node or bun on …/playwright/cli.js install", () => {
    expectHold(bash(`node ${root}/node_modules/playwright/cli.js install chromium`), "floor-tamper");
    expectHold(bash(`bun ${root}/node_modules/playwright-core/cli.js install`), "floor-tamper");
  });
});
