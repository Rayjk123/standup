import { describe, expect, test } from "bun:test";
import { join, resolve } from "path";
import { classifyToolCall, defaultProbes, type FloorProbes } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * Code a command only imports is not code it runs. A module reached through
 * imports counts in full for what runs when it loads; the functions its
 * importers name may never be called on the path, so the owner-only and
 * destructive steps in them are Persona's to weigh, not the owner's. The
 * entry itself — the script run, a `-e` probe — still counts whole. The
 * imported modules are this repository's real source; the machine around it
 * is virtual, with the worktree under a fake data dir that reads through to
 * this checkout, so none of Standup's own path literals appear here.
 */

const REPO = resolve(import.meta.dir, "..", "..", "..", "..");
const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const HOOK = join(INSTALL, "packages", "collector", "src", "floor", "hook.ts");

const config: FloorConfig = {
  v: 1,
  collectorUrl: "http://127.0.0.1:7777",
  launchId: "11111111-2222-3333-4444-555555555555",
  root: ROOT,
  sharedBranches: ["main", "mainline"],
  personalAwsAccounts: [],
  waitSeconds: 60,
  standupDataDir: DATA,
  floorPaths: [join(INSTALL, "packages", "collector", "src", "floor")],
  installDir: INSTALL,
  protectedPaths: [join(DATA, "secrets"), join(DATA, "review-scratch"), join(DATA, "review-media")],
  worktreeRoots: [join(DATA, "worktrees")],
  tmpDirs: ["/tmp"],
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
};

/** An eval harness shaped like the Persona eval: a thin entry, and a cli that loads the floor, policy, launcher and media modules. */
const EVAL_ENTRY = 'import { main } from "../packages/collector/src/persona-eval/cli.ts";\nprocess.exit(await main(process.argv.slice(2)));\n';
const EVAL_CLI = [
  'import { writeFileSync } from "fs";',
  'import { join } from "path";',
  'import { decodeFloorConfig, floorQuestion } from "../floor/gate.ts";',
  'import { decide } from "../persona/policy.ts";',
  'import { stopLaunch } from "../launcher.ts";',
  'import { PERSONA_CWD } from "../internal-cwd.ts";',
  'import { readImageForAttachment } from "../persona/attachments.ts";',
  "export async function main(argv: string[]): Promise<number> {",
  '  const decisions = ["git push origin main", "docker push img"].map((step) => decide(step));',
  "  if (argv.includes(\"--record\")) {",
  "    const config = decodeFloorConfig(argv[argv.indexOf(\"--record\") + 1] ?? \"\");",
  "    console.log(floorQuestion, PERSONA_CWD, config, readImageForAttachment);",
  "    await stopLaunch;",
  "  }",
  '  if (argv.includes("--write-baseline")) writeFileSync(join(import.meta.dir, "baseline.json"), JSON.stringify(decisions));',
  "  return decisions.length ? 0 : 1;",
  "}",
].join("\n");

const VIRTUAL: Record<string, string> = {
  [join(ROOT, ".git")]: "gitdir: /fake/install/.git/worktrees/feat-1\n",
  [join(ROOT, "package.json")]: JSON.stringify({ name: "standup", scripts: { "persona-eval": "bun run scripts/persona-eval.ts" } }),
  [join(ROOT, "scripts", "persona-eval.ts")]: EVAL_ENTRY,
  [join(ROOT, "packages", "collector", "src", "persona-eval", "cli.ts")]: EVAL_CLI,
  [join(DATA, "standup.db")]: "",
  [join(DATA, "secrets", "owner.token")]: "secret",
};

/** The real path a virtual worktree path reads through to, or null for the rest of the virtual machine. */
function real(p: string): string | null {
  if (p === ROOT) return REPO;
  return p.startsWith(`${ROOT}/`) ? join(REPO, p.slice(ROOT.length + 1)) : null;
}

function probes(): Partial<FloorProbes> {
  const disk = defaultProbes();
  const dirs = new Set<string>(["/", "/tmp"]);
  for (const f of Object.keys(VIRTUAL)) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(join(ROOT, ".git"));
  const bare = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  const exists = (p: string) => p in VIRTUAL || dirs.has(bare(p)) || (real(p) !== null && disk.exists(real(p)!));
  const isDirectory = (p: string) => !(p in VIRTUAL) && (dirs.has(bare(p)) || (real(p) !== null && disk.isDirectory(real(p)!)));
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: () => null,
    readFile: (p, max) => (p in VIRTUAL ? { ok: true, text: VIRTUAL[p]! } : real(p) !== null ? disk.readFile(real(p)!, max) : { ok: false, reason: "missing" }),
    exists,
    isDirectory,
    executable: (p) => (p in VIRTUAL ? false : real(p) !== null ? disk.executable(real(p)!) : null),
    listDir: (raw) => {
      const p = bare(raw);
      if (!isDirectory(p)) return null;
      const virtual = Object.keys(VIRTUAL).concat([...dirs]).filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!);
      const onDisk = real(p) !== null ? (disk.listDir(real(p)!) ?? []).filter((n) => n !== ".git") : [];
      return [...new Set([...virtual, ...onDisk])];
    },
    realpath: (p) => (exists(p) ? bare(p) : null),
    homeDir: () => HOME,
    awsAccount: () => null,
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

function bash(command: string): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, probes());
}

/** What the verdict asks of the owner: nothing, or Persona's call, or the owner's. */
function gate(v: FloorVerdict): "allow" | "persona" | "owner" {
  if (v.action === "allow") return "allow";
  return v.action === "hold" && (v.ownerOnly || v.ownerReserved) ? "owner" : "persona";
}

function script(name: string, text: string): string {
  VIRTUAL[join(ROOT, "scripts", name)] = text;
  return `bun run scripts/${name}`;
}

describe("code only imported is not held for the owner", () => {
  test("probes that import the floor's gate and the attachments module", () => {
    for (const command of [
      `bun -e 'import { decodeFloorConfig } from "./packages/collector/src/floor/gate.ts"; console.log(decodeFloorConfig("e30"))'`,
      `bun -e 'import { formatBytes, sniffImageMime } from "./packages/collector/src/persona/attachments.ts"; console.log(formatBytes(3), sniffImageMime(new Uint8Array(4)))'`,
      `bun -e 'import * as a from "./packages/collector/src/persona/attachments.ts"; console.log(a.formatBytes(3))'`,
    ]) {
      expect({ command, verdict: bash(command) }).toEqual({ command, verdict: { action: "allow" } });
    }
  });

  test("a module whose load-time code only builds a path under the data dir is Persona's to weigh", () => {
    const v = bash(`bun -e 'import { DRAFT_VERIFY_CWD } from "./packages/collector/src/internal-cwd.ts"; console.log(DRAFT_VERIFY_CWD)'`);
    expect({ gate: gate(v), category: v.action === "hold" ? v.category : null }).toEqual({ gate: "persona", category: "unclassified" });
  });

  test("the pipeline screenshot helper, recording, from the worktree", () => {
    // The worktree's copy is read as the script run: what its own code writes is Persona's (the install's copy
    // runs as shipped, install-writes.test.ts). What the modules it imports only name doesn't reach the owner.
    const command = "bun run scripts/pipeline-screenshot.ts http://127.0.0.1:5301/ --record";
    expect({ command, gate: gate(bash(command)) }).not.toEqual({ command, gate: "owner" });
  });

  test("an eval harness whose modules name the data dir, its helpers and tmux kill-session", () => {
    for (const command of ["bun run persona-eval", "bun run persona-eval --record e30", "bun run persona-eval --write-baseline"]) {
      // Still Persona's: the modules' own text names outward steps and nested agents, which no owner card is needed for.
      expect({ command, gate: gate(bash(command)) }).toEqual({ command, gate: "persona" });
    }
  });
});

describe("what the run itself does still holds for the owner", () => {
  test("an entry script that ends sessions outside the worker, from its top level or a function it calls", () => {
    for (const command of [
      script("kill.ts", 'import { execSync } from "child_process";\nexecSync("tmux kill-session -t other");\n'),
      script("kill-fn.ts", 'import { execFileSync } from "child_process";\nfunction stop() {\n  execFileSync("tmux", ["kill-server"]);\n}\nstop();\n'),
    ]) {
      const v = bash(command);
      expect({ command, category: v.action === "hold" ? v.category : null }).toEqual({ command, category: "destructive" });
    }
  });

  test("an entry script that reads Standup's DB or writes the floor hook", () => {
    for (const command of [
      script("db.ts", 'import { Database } from "bun:sqlite";\nimport { homedir } from "os";\nimport { join } from "path";\nnew Database(join(homedir(), ".local", "share", "standup", "standup.db")).query("select 1").all();\n'),
      script("hook.ts", `import { writeFileSync } from "fs";\nwriteFileSync("${HOOK}", "");\n`),
    ]) {
      expect({ command, gate: gate(bash(command)) }).toEqual({ command, gate: "owner" });
    }
  });

  test("an imported module whose load-time code ends sessions or reads the DB", () => {
    VIRTUAL[join(ROOT, "scripts", "lib", "boot.ts")] = 'import { execSync } from "child_process";\nexecSync("tmux kill-session -t other");\nexport const ready = true;\n';
    VIRTUAL[join(ROOT, "scripts", "lib", "store.ts")] = [
      'import { Database } from "bun:sqlite";',
      'import { homedir } from "os";',
      'import { join } from "path";',
      'const db = new Database(join(homedir(), ".local", "share", "standup", "standup.db"));',
      "export function count(): number {",
      '  return db.query("select 1").all().length;',
      "}",
    ].join("\n");
    const boot = bash(script("uses-boot.ts", 'import { ready } from "./lib/boot.ts";\nconsole.log(ready);\n'));
    expect(boot.action === "hold" && boot.category).toBe("destructive");
    expect(gate(bash(script("uses-store.ts", 'import "./lib/store.ts";\n')))).toBe("owner");
  });

  test("an imported helper the run calls that pushes is held as the push it is; one it only names, for Persona", () => {
    VIRTUAL[join(ROOT, "scripts", "lib", "ship.ts")] = 'import { execSync } from "child_process";\nexport function ship() {\n  execSync("git push origin HEAD");\n}\n';
    const v = bash(script("ship.ts", 'import { ship } from "./lib/ship.ts";\nship();\n'));
    expect({ gate: gate(v), category: v.action === "hold" ? v.category : null }).toEqual({ gate: "owner", category: "outward" });
    expect(v.action === "hold" && v.reason).toContain("git push");
    const named = bash(script("ship-named.ts", 'import { ship } from "./lib/ship.ts";\nexport const later = ship;\n'));
    expect({ gate: gate(named), category: named.action === "hold" ? named.category : null }).toEqual({ gate: "persona", category: "unclassified" });
  });

  test("a module's load-time step dressed as building values still holds for the owner", () => {
    const PUSH = 'execSync("git push origin HEAD")';
    const libs: Record<string, string> = {
      "alias.ts": `import { execSync as join } from "child_process";\njoin("git push origin HEAD");\nexport const ok = 1;\n`,
      "getter.ts": `import { execSync } from "child_process";\nconst o = { get v() { ${PUSH}; return 1; } };\nexport const ok = o.v;\n`,
      "coerce.ts": `import { execSync } from "child_process";\nconst o = { toString() { ${PUSH}; return ""; } };\nexport const ok = \`\${o}\`;\n`,
      "map.ts": `import { execSync } from "child_process";\nfunction go() {\n  ${PUSH};\n}\nexport const ok = [1].map(go);\n`,
      "timer.ts": `import { execSync } from "child_process";\nfunction go() {\n  ${PUSH};\n}\nsetTimeout(go, 1);\nexport const ok = 1;\n`,
      "extends.ts": `import { execSync } from "child_process";\nexport class ok extends (${PUSH}, Object) {}\n`,
      "stored.ts": `import { execSync } from "child_process";\nconst o = { run: () => ${PUSH} };\no.run();\nexport const ok = 1;\n`,
      "paren.ts": `import { execSync } from "child_process";\n(execSync)("git push origin HEAD");\nexport const ok = 1;\n`,
      "rename.ts": `import * as cp from "child_process";\nconst { execSync: Number } = cp;\nNumber("git push origin HEAD");\nexport const ok = 1;\n`,
      "pattern.ts": `import * as cp from "child_process";\nconst [Number] = [cp.execSync];\nNumber("git push origin HEAD");\nexport const ok = 1;\n`,
      "own-push.ts": `import * as cp from "child_process";\nconst x = { push: cp.execSync };\nx.push("git push origin HEAD");\nexport const ok = 1;\n`,
      "method-map.ts": `import * as cp from "child_process";\nconst o = { run() { cp.execSync("git push origin HEAD"); } };\nexport const ok = [0].map(o.run);\n`,
      "handed.ts": `import { execSync } from "child_process";\nimport { use } from "./use.ts";\nfunction go() {\n  ${PUSH};\n}\nuse({ run() { go(); } });\nexport const ok = 1;\n`,
      "alias-fn.ts": `import { execSync } from "child_process";\nfunction go() {\n  ${PUSH};\n}\nconst r = go;\nr();\nexport const ok = 1;\n`,
      "each.ts": `import { execSync } from "child_process";\nfunction go() {\n  ${PUSH};\n}\n[go].forEach((f) => f());\nexport const ok = 1;\n`,
      "alias-import.ts": 'import { wipe } from "./wipe.ts";\nconst s = wipe;\ns();\nexport const ok = 1;\n',
    };
    VIRTUAL[join(ROOT, "scripts", "lib", "use.ts")] = "export function use(x: { run(): void }) {\n  x.run();\n}\n";
    VIRTUAL[join(ROOT, "scripts", "lib", "wipe.ts")] = 'import { execSync } from "child_process";\nexport function wipe() {\n  execSync("git push --force origin HEAD:main");\n}\n';
    for (const [name, text] of Object.entries(libs)) {
      VIRTUAL[join(ROOT, "scripts", "lib", name)] = text;
      const command = script(`uses-${name}`, `import { ok } from "./lib/${name}";\nconsole.log(ok);\n`);
      expect({ name, gate: gate(bash(command)) }).toEqual({ name, gate: "owner" });
    }
  });

  test("a function a module calls from another while it loads counts in full there", () => {
    VIRTUAL[join(ROOT, "scripts", "lib", "wipe.ts")] = 'import { execSync } from "child_process";\nexport function wipe() {\n  execSync("git push --force origin HEAD:main");\n}\n';
    VIRTUAL[join(ROOT, "scripts", "lib", "boot2.ts")] = 'import { wipe } from "./wipe.ts";\nwipe();\nexport const ready = true;\n';
    expect(gate(bash(script("uses-boot2.ts", 'import { ready } from "./lib/boot2.ts";\nconsole.log(ready);\n')))).toBe("owner");
  });

  test("a file run as an entry counts whole even after the same command imported it", () => {
    VIRTUAL[join(ROOT, "scripts", "b2.ts")] = 'import { execSync } from "child_process";\nexport const x = 1;\nexport function idle() {\n  execSync("git push origin HEAD:main --force");\n}\n';
    VIRTUAL[join(ROOT, "scripts", "a2.ts")] = 'import { x } from "./b2.ts";\nconsole.log(x);\n';
    expect(gate(bash("bun run scripts/b2.ts"))).toBe("owner");
    expect(gate(bash("bun run scripts/a2.ts && bun run scripts/b2.ts"))).toBe("owner");
  });

  test("a module a type import names and code loads another way is still read", () => {
    VIRTUAL[join(ROOT, "scripts", "lib", "push.ts")] = 'import { execSync } from "child_process";\nexecSync("git push origin HEAD:main --force");\nexport function push() {}\n';
    for (const loader of ["module.require", "import.meta.require"]) {
      const command = `bun -e 'import type { X } from "./scripts/lib/push.ts";\n${loader}("./scripts/lib/push.ts").push()'`;
      expect({ loader, gate: gate(bash(command)) }).toEqual({ loader, gate: "owner" });
    }
  });

  test("a module read whole, through require or a namespace used as a value, is still held", () => {
    VIRTUAL[join(ROOT, "scripts", "lib", "pushfn.ts")] = 'import { execSync } from "child_process";\nexport function push() {\n  execSync("git push origin HEAD:main --force");\n}\n';
    for (const command of [
      `bun -e 'require("./scripts/lib/pushfn.ts").push()'`,
      `bun -e 'const m = await import("./scripts/lib/pushfn.ts"); m.push()'`,
      `bun -e 'import * as m from "./scripts/lib/pushfn.ts"; for (const f of Object.values(m)) f()'`,
    ]) {
      const v = bash(command);
      expect({ command, gate: gate(v), git: v.action === "hold" && v.reason.includes("git push") }).toEqual({ command, gate: "persona", git: true });
    }
  });

  test("a module also loaded through module.require or import.meta.require is read whole", () => {
    VIRTUAL[join(ROOT, "scripts", "lib", "pushx.ts")] = 'import { execSync } from "child_process";\nexport const x = 1;\nexport function push() {\n  execSync("git push origin HEAD:main --force");\n}\n';
    for (const command of [
      `bun -e 'import { x } from "./scripts/lib/pushx.ts"; console.log(x); import.meta.require("./scripts/lib/pushx.ts").push()'`,
      `bun -e 'import "./scripts/lib/pushx.ts"; module.require("./scripts/lib/pushx.ts").push()'`,
      `bun -e 'import type { X } from "./scripts/lib/pushx.ts"; const r = require; r("./scripts/lib/pushx.ts").push()'`,
      `bun -e 'import type { X } from "./scripts/lib/pushx.ts"; const s = "./scripts/lib/pushx.ts"; (await import(s)).push()'`,
    ]) {
      const v = bash(command);
      expect({ command, held: v.action === "hold" && v.reason.includes("git push") }).toEqual({ command, held: true });
    }
  });

  test("eval in a function an importer calls reads the module whole, in full", () => {
    VIRTUAL[join(ROOT, "scripts", "lib", "ev.ts")] = 'import { execSync } from "child_process";\nexport function run(s: string) {\n  eval(s);\n  execSync("git push origin HEAD");\n}\n';
    expect(gate(bash(script("uses-ev.ts", 'import { run } from "./lib/ev.ts";\nrun("1");\n')))).toBe("owner");
  });

  test("Standup's data-dir helpers read off the module that exports them", () => {
    for (const use of [
      'import * as s from "@standup/shared";\nconst f = s.standupDataDir;\nf();',
      'import * as s from "@standup/shared";\n(0, s.standupDataDir)();',
      'import * as s from "@standup/shared";\ns.standupDataDir?.();',
      'import * as s from "@standup/shared";\ns.standupDataDir.call(null);',
      'import * as s from "@standup/shared";\nconst t = s;\nt.standupDataDir();',
      'let s;\ns = require("@standup/shared");\ns.standupDataDir();',
      'require("@standup/shared").standupDataDir();',
    ]) {
      const command = script("helper.ts", `${use}\n`);
      expect({ use, gate: gate(bash(command)) }).toEqual({ use, gate: "owner" });
    }
  });

  test("a demoted step that ends other sessions is still named first", () => {
    VIRTUAL[join(ROOT, "scripts", "lib", "reset.ts")] = 'import { execSync } from "child_process";\nexport function note() {\n  execSync("git status --porcelain > /etc/standup-note");\n}\nexport function reset() {\n  execSync("tmux kill-server");\n}\n';
    const v = bash(script("uses-reset.ts", 'import { note, reset } from "./lib/reset.ts";\nnote();\nreset();\n'));
    expect(gate(v)).toBe("persona");
    // Ranked first for the sessions it reaches, though found after the other step.
    expect(v.action === "hold" && v.reason).toStartWith("`tmux kill-server`");
  });
});
