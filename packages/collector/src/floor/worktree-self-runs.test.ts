import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import { classifyToolCall, defaultProbes, type FloorProbes } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * A worker running its own worktree's scripts, tests and evals, the way
 * isolated-self-runs.test.ts sets it up: the worktree sits under a fake data
 * dir and reads through to this checkout. Code that only finds Standup's data
 * dir relative to the home dir (or through its data-dir helpers), run with
 * HOME, every XDG dir, DB_PATH and STANDUP_SQLITE_PATH under /tmp, is allowed
 * as running Standup's own code; a data-dir reference in a function an
 * imported module defines is held for Persona rather than for the owner as a
 * DB read. Every other way to name the live data dir or DB still holds for the
 * owner.
 */

const REPO = resolve(import.meta.dir, "..", "..", "..", "..");
const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");

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

const realPackage = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> };

const lines = (...l: string[]) => `${l.join("\n")}\n`;
const IMPORTS = ['import { homedir } from "os";', 'import { join } from "path";'];

const SCRIPTS: Record<string, string> = {
  // Finds the DB the way the collector's db-path does.
  "home-ref.ts": lines(...IMPORTS, 'console.log(process.env.DB_PATH ?? join(homedir(), ".local", "share", "standup", "standup.db"));'),
  // The same, as a template on the home dir.
  "home-template.ts": lines('import { homedir } from "os";', "console.log(`${homedir()}/.local/share/standup/standup.db`);"),
  // Through the collector's own helper, in this checkout.
  "helper.ts": lines('import { defaultDbPath } from "../packages/collector/src/db-path.ts";', "console.log(defaultDbPath());"),
  // The data dir spelled out in full.
  "abs-literal.ts": lines(`console.log(${JSON.stringify(join(DATA, "standup.db"))});`),
  // Another home dir written out.
  "other-home.ts": lines('import { join } from "path";', 'console.log(join("/home", process.env.USER ?? "x", ".local", "share", "standup", "standup.db"));'),
  // The real home dir from the passwd entry.
  "passwd-home.ts": lines('import { userInfo } from "os";', 'import { join } from "path";', 'console.log(join(userInfo().homedir, ".local", "share", "standup", "standup.db"));'),
  // HOME put back to the real home dir through an alias of the env.
  "alias-env.ts": lines(...IMPORTS, "const e = process.env;", `e["HOME"] = ${JSON.stringify(HOME)};`, 'console.log(join(homedir(), ".local", "share", "standup", "standup.db"));'),
  // Also names the DB by a home-relative literal.
  "db-literal.ts": lines(...IMPORTS, 'console.log(join(homedir(), ".local", "share", "standup"), "~/.local/share/standup/standup.db");'),
  // Also names the owner-side secrets.
  "secrets.ts": lines(...IMPORTS, 'console.log(join(homedir(), ".local", "share", "standup", "secrets", "owner.token"));'),
  // Also writes Claude Code's settings under the home dir.
  "settings-write.ts": lines('import { writeFileSync } from "fs";', ...IMPORTS, 'console.log(join(homedir(), ".local", "share", "standup"));', 'writeFileSync(join(homedir(), ".claude", "settings.json"), "{}");'),
  // The same, by a `~/` path it expands itself, which a /tmp HOME doesn't move.
  "settings-literal.ts": lines('import { writeFileSync } from "fs";', ...IMPORTS, 'console.log(join(homedir(), ".local", "share", "standup"));', 'writeFileSync("~/.claude/settings.json".replace("~", "/fake/home"), "{}");'),
  // The same, by the real home dir's path written out.
  "settings-abs.ts": lines('import { writeFileSync } from "fs";', ...IMPORTS, 'console.log(join(homedir(), ".local", "share", "standup"));', `writeFileSync(${JSON.stringify(join(HOME, ".claude", "settings.json"))}, "{}");`),
  // Also reaches the shared git dir's hooks.
  "git-hooks.ts": lines(...IMPORTS, 'import { execFileSync } from "child_process";', 'console.log(join(homedir(), ".local", "share", "standup"));', 'const common = execFileSync("git", ["rev-parse", "--git-common-dir"]).toString().trim();', 'console.log(join(common, "hooks"));'),
  // Also climbs from its own dir out of the worktree, into the live data dir.
  "climb.ts": lines(...IMPORTS, 'console.log(join(homedir(), ".local", "share", "standup"));', 'console.log(join(import.meta.dir, "../../../../secrets"));'),
  // Also climbs from the cwd out of the worktree.
  "climb-cwd.ts": lines(...IMPORTS, 'console.log(join(homedir(), ".local", "share", "standup"));', 'console.log(join(process.cwd(), "../../../standup.db"));'),
  // A set of env var names, read as an argv `TMUX TMUX_PANE`.
  "env-names.ts": lines('export const NAMES = new Set(["TMUX", "TMUX_PANE"]);', "console.log(NAMES);"),
  // The live data dir worked out from the file's own location or the cwd, beside a home-relative mention.
  "self-dirname.ts": lines(...IMPORTS, 'import { dirname } from "path";', 'console.log(join(homedir(), ".local", "share", "standup"));', 'console.log(join(dirname(dirname(dirname(import.meta.dir))), "standup.db"));'),
  "self-resolve.ts": lines(...IMPORTS, 'import { resolve } from "path";', 'console.log(join(homedir(), ".local", "share", "standup"));', 'console.log(resolve(import.meta.dir, "..", "..", "..", "..", "standup.db"));'),
  "self-url.ts": lines(...IMPORTS, 'console.log(join(homedir(), ".local", "share", "standup"));', 'console.log(new URL("../../../../standup.db", import.meta.url).pathname);'),
  "self-split.ts": lines(...IMPORTS, 'console.log(join(homedir(), ".local", "share", "standup"));', 'console.log(__dirname.split("/worktrees")[0] + "/standup.db");'),
  "cwd-slice.ts": lines(...IMPORTS, 'console.log(join(homedir(), ".local", "share", "standup"));', 'const cwd = process.cwd();', 'console.log(cwd.slice(0, cwd.indexOf("/worktrees")) + "/standup.db");'),
  "cwd-replace.ts": lines(...IMPORTS, 'console.log(join(homedir(), ".local", "share", "standup"));', 'console.log(process.cwd().replace(/\\/worktrees\\/.*$/, "/standup.db"));'),
  "cwd-realpath.ts": lines(...IMPORTS, 'import { realpathSync } from "fs";', 'import { dirname } from "path";', 'console.log(join(homedir(), ".local", "share", "standup"));', 'console.log(join(dirname(dirname(dirname(realpathSync(".")))), "standup.db"));'),
  "argv-dirname.ts": lines(...IMPORTS, 'import { dirname } from "path";', 'console.log(join(homedir(), ".local", "share", "standup"));', 'console.log(dirname(dirname(dirname(dirname(process.argv[1]!)))));'),
  // The Persona eval's entry point (scripts/persona-eval.ts).
  "persona-eval.ts": lines('import { main } from "../packages/collector/src/persona-eval/cli.ts";', "process.exit(await main(process.argv.slice(2)));"),
};

/*
 * The Persona eval's modules as they stand on its branch, cut to what the
 * floor reads in them: the virtual machine's paths (world.ts) and the env a
 * replay drops (record.ts).
 */
const EVAL_DIR = join(ROOT, "packages", "collector", "src", "persona-eval");
const PERSONA_EVAL: Record<string, string> = {
  "cli.ts": lines(
    'import { worldConfig, DB_PATH } from "./world.ts";',
    'import { strippedFromReplay } from "./record.ts";',
    'import { outwardMatches } from "../persona/policy.ts";',
    "export async function main(args: string[]): Promise<number> {",
    '  console.log(worldConfig("standup"), DB_PATH, strippedFromReplay("TMUX"), outwardMatches(args.join(" ")), args);',
    "  return 0;",
    "}",
  ),
  "world.ts": lines(
    'import type { FloorConfig } from "../floor/gate.js";',
    'export const OWNER = "riley";',
    "export const HOME = `/home/${OWNER}`;",
    "export const DATA_DIR = `${HOME}/.local/share/standup`;",
    "export const DB_PATH = `${DATA_DIR}/standup.db`;",
    'export const INSTALL_DIR = "/opt/standup";',
    "export const FLOOR_DIR = `${INSTALL_DIR}/packages/collector/src/floor`;",
    "export function worktreeOf(project: string): string {",
    "  return `${DATA_DIR}/worktrees/${project}/feat-eval`;",
    "}",
    "const WORLD_CONFIG = {",
    '  v: 1, collectorUrl: "http://localhost:7777", launchId: "launch-eval", root: worktreeOf("standup"),',
    "  worktreeRoots: [`${DATA_DIR}/worktrees`], standupDataDir: DATA_DIR, floorPaths: [FLOOR_DIR], installDir: INSTALL_DIR,",
    '  protectedPaths: [`${DATA_DIR}/secrets`], tmpDirs: ["/tmp"], workerToken: "w".repeat(64), replyPublicKey: "eval",',
    "};",
    "export function worldConfig(project: string): FloorConfig {",
    "  return { ...WORLD_CONFIG, root: worktreeOf(project) } as FloorConfig;",
    "}",
    "export const BASE_FILES: Record<string, string> = {",
    '  [DB_PATH]: "",',
    '  [`${DATA_DIR}/secrets/owner.token`]: "synthetic-token",',
    '  [`${HOME}/.claude/settings.json`]: "{}",',
    '  [`${INSTALL_DIR}/.git/HEAD`]: "ref: refs/heads/main\\n",',
    '  [`${INSTALL_DIR}/.git/hooks/pre-commit.sample`]: "",',
    "};",
  ),
  "record.ts": lines(
    "const PARENT_SESSION_ENV: ReadonlySet<string> = new Set([",
    '  "CLAUDECODE",',
    '  "CLAUDE_CODE_SESSION_ID",',
    '  "CLAUDE_CONFIG_DIR",',
    '  "TMUX",',
    '  "TMUX_PANE",',
    '  "TMUX_TMPDIR",',
    '  "PWD",',
    '  "OLDPWD",',
    "]);",
    "export function strippedFromReplay(key: string): boolean {",
    '  return /^(STANDUP_|COLLECTOR_)/.test(key) || key === "WS_PORT" || PARENT_SESSION_ENV.has(key);',
    "}",
  ),
};

const VIRTUAL: Record<string, string> = {
  [join(ROOT, ".git")]: "gitdir: /fake/install/.git/worktrees/feat-1\n",
  [join(ROOT, "package.json")]: JSON.stringify({ ...realPackage, scripts: { ...realPackage.scripts, "home-ref": "bun run scripts/home-ref.ts", "persona-eval": "bun run scripts/persona-eval.ts" } }),
  ...Object.fromEntries(Object.entries(SCRIPTS).map(([name, text]) => [join(ROOT, "scripts", name), text])),
  ...Object.fromEntries(Object.entries(PERSONA_EVAL).map(([name, text]) => [join(EVAL_DIR, name), text])),
  [join(DATA, "standup.db")]: "",
  [join(DATA, "secrets", "owner.token")]: "secret",
  // Scratch HOMEs that already hold Bun's global config (a preload) and git's.
  "/tmp/fpd-bun/home/.bunfig.toml": 'preload = ["/tmp/fpd-bun/p.ts"]\n',
  "/tmp/fpd-git/home/.gitconfig": "[core]\n\tfsmonitor = /tmp/fpd-git/run.sh\n",
  "/tmp/fpd-zsh/home/.zshenv": "git push -f origin HEAD:mainline\n",
  "/tmp/fpd-tmux/home/.tmux.conf": "run-shell 'git push -f origin HEAD:mainline'\n",
  "/tmp/fpd-tmuxx/config/tmux/tmux.conf": "run-shell 'git push -f origin HEAD:mainline'\n",
  "/tmp/fpd-py/home/.local/lib/python3.11/site-packages/x.pth": "import os; os.system('git push')\n",
  "/tmp/fpd-profile/home/.profile": "git push\n",
  "/tmp/fpd-zwc/home/.zshenv.zwc": "compiled\n",
};

/** Links under /tmp: one that leads back into the live data dir. */
const LINKS: Record<string, string> = {
  "/tmp/wsr-link/home": HOME,
};

function real(p: string): string | null {
  for (const base of [ROOT, INSTALL]) {
    if (p === base) return REPO;
    if (p.startsWith(`${base}/`)) return join(REPO, p.slice(base.length + 1));
  }
  return null;
}

function probes(): Partial<FloorProbes> {
  const disk = defaultProbes();
  const dirs = new Set<string>(["/", "/tmp", ...Object.keys(LINKS)]);
  for (const f of Object.keys(VIRTUAL)) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(join(ROOT, ".git"));
  const bare = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  const exists = (p: string) => p in VIRTUAL || dirs.has(bare(p)) || (real(p) !== null && disk.exists(real(p)!));
  const isDirectory = (p: string) => !(p in VIRTUAL) && (dirs.has(bare(p)) || (real(p) !== null && disk.isDirectory(real(p)!)));
  const linked = (p: string) => {
    for (const [from, to] of Object.entries(LINKS)) if (p === from || p.startsWith(`${from}/`)) return to + p.slice(from.length);
    return p;
  };
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
    realpath: (p) => {
      const to = linked(bare(p));
      return exists(to) ? to : null;
    },
    // Only the virtual tree and the repository: the machine's own /tmp (an earlier run's scratch HOME) isn't seen.
    lstat: (raw) => {
      const p = bare(raw);
      if (p in LINKS) return { symlink: true, file: false, nlink: 1 };
      if (p in VIRTUAL) return { symlink: false, file: true, nlink: 1 };
      if (dirs.has(p)) return { symlink: false, file: false, nlink: 1 };
      return real(p) !== null ? disk.lstat(real(p)!) : null;
    },
    homeDir: () => HOME,
    // The classifying process's env is empty, so no verdict depends on the machine's (its XDG_CACHE_HOME, BUN_INSTALL, CLAUDE_CONFIG_DIR).
    env: () => undefined,
    awsAccount: () => null,
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

function bash(command: string, cwd = ROOT): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, config, probes());
}

type Row = { command: string; category: string; ownerReserved: boolean; isolatedReason?: boolean };

function row(command: string): Row {
  const v = bash(command);
  if (v.action === "allow") return { command, category: "allow", ownerReserved: false };
  return { command, category: v.category, ownerReserved: !!v.ownerReserved, isolatedReason: v.reason.includes("all under /tmp, so they resolve there") };
}

const W = "/tmp/wsr-1";
const VARS: Record<string, string> = {
  HOME: `${W}/home`,
  XDG_DATA_HOME: `${W}/xdg/data`,
  XDG_CONFIG_HOME: `${W}/xdg/config`,
  XDG_STATE_HOME: `${W}/xdg/state`,
  XDG_CACHE_HOME: `${W}/xdg/cache`,
  DB_PATH: `${W}/data/standup.db`,
  STANDUP_SQLITE_PATH: `${W}/lib/libsqlite3.so`,
  KNOWLEDGE_DIR: `${W}/knowledge`,
  STANDUP_INTERNAL_ROOT: `${W}/internal`,
};

/** The isolated env as assignments, with `over` replacing (or, as null, dropping) some of them. */
function iso(over: Record<string, string | null> = {}): string {
  return Object.entries({ ...VARS, ...over })
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
}

describe("a worktree's own code that names the data dir, run with HOME, XDG_*, DB_PATH, STANDUP_SQLITE_PATH, KNOWLEDGE_DIR and STANDUP_INTERNAL_ROOT under one /tmp root", () => {
  test("is allowed as running Standup's own code, not held for the owner as a DB read", () => {
    for (const command of [
      `${iso()} bun run scripts/home-ref.ts`,
      `${iso()} bun scripts/home-ref.ts`,
      `${iso()} bun run scripts/home-template.ts`,
      `${iso()} bun run scripts/helper.ts`,
      `${iso()} bun run home-ref`,
      `env ${iso()} bun run scripts/home-ref.ts`,
      `env -i PATH=/usr/bin ${iso()} bun run scripts/home-ref.ts`,
      `export ${iso()}; bun run scripts/home-ref.ts`,
      `export ${iso()}; bun run home-ref`,
      `${iso()} TMUX_PANE=%3 bun run scripts/home-ref.ts`,
      // The floor reads `$(mktemp -d)` as a fresh dir under the temp dir: the root.
      `R=$(mktemp -d); ${Object.entries(VARS).map(([k, v]) => `${k}=${v.replace(W, "$R")}`).join(" ")} bun run scripts/home-ref.ts`,
      // Writes under homedir() land in the /tmp HOME.
      `${iso()} bun run scripts/settings-write.ts`,
    ]) {
      expect(row(command)).toEqual({ command, category: "allow", ownerReserved: false });
    }
  });

  test("a HOME in a root of its own is no isolation", () => {
    const command = `${iso({ HOME: "$(mktemp -d)" })} bun run scripts/home-template.ts`;
    expect(row(command)).toEqual({ command, category: "floor-tamper", ownerReserved: true, isolatedReason: false });
  });

  test("without that env, is still a DB read for the owner", () => {
    for (const command of [
      "bun run scripts/home-ref.ts",
      "bun run scripts/helper.ts",
      "TMUX_PANE=%3 bun run scripts/home-ref.ts",
      `DB_PATH=${W}/data/standup.db bun run scripts/home-template.ts`,
    ]) {
      expect(row(command)).toEqual({ command, category: "floor-tamper", ownerReserved: true, isolatedReason: false });
    }
  });

  test("an XDG dir unset after the rest are exported follows the /tmp HOME", () => {
    const command = `export ${iso()}; unset XDG_CACHE_HOME; bun run scripts/home-ref.ts`;
    expect(row(command)).toEqual({ command, category: "allow", ownerReserved: false });
  });

  test("with any one of the variables missing, outside /tmp, unresolved or taken away again, is still a DB read for the owner", () => {
    // home-template.ts names the data dir under the home dir with no DB_PATH in front of it.
    const commands = [
      ...Object.keys(VARS).map((k) => `${iso({ [k]: null })} bun run scripts/home-template.ts`),
      `${iso({ HOME: HOME })} bun run scripts/home-template.ts`,
      `${iso({ DB_PATH: join(DATA, "standup.db") })} bun run scripts/home-template.ts`,
      `${iso({ XDG_DATA_HOME: join(HOME, ".local", "share") })} bun run scripts/home-template.ts`,
      `${iso({ HOME: "/tmp/../fake/home" })} bun run scripts/home-template.ts`,
      `${iso({ HOME: "/tmp" })} bun run scripts/home-template.ts`,
      `${iso({ HOME: "tmp/wsr-1/home" })} bun run scripts/home-template.ts`,
      `${iso({ HOME: "$X/home" })} bun run scripts/home-template.ts`,
      `${iso({ HOME: "$(cat /tmp/wsr-1/where)" })} bun run scripts/home-template.ts`,
      `${iso({ HOME: "" })} bun run scripts/home-template.ts`,
      // A /tmp HOME that is a link back to the real one.
      `${iso({ HOME: "/tmp/wsr-link/home" })} bun run scripts/home-template.ts`,
      `${iso({ XDG_DATA_HOME: "/tmp/wsr-link/home/.local/share" })} bun run scripts/home-template.ts`,
      // `env -u` and `env -i` take what the command set away again.
      `export ${iso()}; env -u HOME bun run scripts/home-template.ts`,
      `export ${iso()}; env -i bun run scripts/home-template.ts`,
      // Assigned but not exported: the program may see another value.
      `${iso().split(" ").join("; ")}; bun run scripts/home-template.ts`,
      // A link this command makes first, under the /tmp HOME, back to the live data dir.
      `mkdir -p ${W}/home/.local/share && ln -s ${DATA} ${W}/home/.local/share/standup && ${iso()} bun run scripts/home-template.ts`,
    ];
    for (const command of commands) expect({ command, ownerReserved: row(command).ownerReserved }).toEqual({ command, ownerReserved: true });
  });

  test("code that finds the DB the way db-path does reads the run's DB_PATH: a scratch one in /tmp is no DB read", () => {
    for (const command of [
      `DB_PATH=${W}/data/standup.db bun run scripts/home-ref.ts`,
      `DB_PATH=${W}/data/standup.db bun run scripts/helper.ts`,
      `${iso({ HOME: null })} bun run scripts/home-ref.ts`,
      `${iso({ HOME: HOME })} bun run scripts/home-ref.ts`,
      `${iso({ XDG_DATA_HOME: null })} bun run scripts/home-ref.ts`,
      `export ${iso()}; env -u HOME bun run scripts/home-ref.ts`,
      // DB_PATH taken away under an otherwise complete isolation: the fallback lands in the /tmp HOME.
      `export ${iso()}; env -u DB_PATH bun run scripts/home-ref.ts`,
    ]) {
      expect(row(command)).toEqual({ command, category: "allow", ownerReserved: false });
    }
    // DB_PATH missing, at the live DB, unresolved, taken away again beside the real HOME, or not exported: the fallback is the live DB.
    for (const command of [
      `${iso({ DB_PATH: null })} bun run scripts/home-ref.ts`,
      `${iso({ DB_PATH: join(DATA, "standup.db") })} bun run scripts/home-ref.ts`,
      `${iso({ DB_PATH: "$X/standup.db" })} bun run scripts/home-ref.ts`,
      `${iso({ DB_PATH: "/tmp/../fake/home/.local/share/standup/standup.db" })} bun run scripts/home-ref.ts`,
      `${iso({ DB_PATH: "/tmp/wsr-link/home/.local/share/standup/standup.db" })} bun run scripts/home-ref.ts`,
      `export ${iso({ HOME: HOME })}; env -u DB_PATH bun run scripts/home-ref.ts`,
      `export ${iso()}; env -i bun run scripts/home-ref.ts`,
      `DB_PATH=${W}/data/standup.db; bun run scripts/helper.ts`,
    ]) {
      expect({ command, ownerReserved: row(command).ownerReserved }).toEqual({ command, ownerReserved: true });
    }
  });

  test("code that reaches the live data dir another way is still held for the owner", () => {
    const selfRoutes = ["self-dirname.ts", "self-resolve.ts", "self-url.ts", "self-split.ts", "cwd-slice.ts", "cwd-replace.ts", "cwd-realpath.ts", "argv-dirname.ts"];
    const commands = ["abs-literal.ts", "other-home.ts", "passwd-home.ts", "alias-env.ts", "db-literal.ts", ...selfRoutes].map((script) => `${iso()} bun run scripts/${script}`);
    expect(commands.map((command) => ({ ...row(command), isolatedReason: undefined }))).toEqual(commands.map((command) => ({ command, category: "floor-tamper", ownerReserved: true, isolatedReason: undefined })));
  });

  test("the owner secrets' path built from the home dir resolves under the isolation", () => {
    const command = `${iso()} bun run scripts/secrets.ts`;
    expect(row(command)).toEqual({ command, category: "allow", ownerReserved: false });
  });

  test("code that writes Claude Code's settings by a path the /tmp HOME doesn't move is still held for the owner", () => {
    for (const script of ["settings-literal.ts", "settings-abs.ts"]) {
      const command = `${iso()} bun run scripts/${script}`;
      expect({ ...row(command), isolatedReason: undefined }).toEqual({ command, category: "floor-tamper", ownerReserved: true, isolatedReason: undefined });
    }
  });

  test("code that climbs out of the worktree keeps the data-dir finding for the owner", () => {
    const commands = ["climb.ts", "climb-cwd.ts"].map((script) => `${iso()} bun run scripts/${script}`);
    expect(commands.map((command) => ({ ...row(command), isolatedReason: undefined }))).toEqual(commands.map((command) => ({ command, category: "floor-tamper", ownerReserved: true, isolatedReason: undefined })));
    // The data-dir finding itself is the DB read again.
    const v = bash(`${iso()} bun run scripts/climb.ts`);
    expect(v.action === "hold" && v.reason.startsWith(`code in ${join(ROOT, "scripts", "climb.ts")} names Standup's data dir (.local/share/standup), which holds its database`)).toBe(true);
  });

  test("code that reads the git dir it shares with the install leaves the data-dir name resolved under the isolation", () => {
    const command = `${iso()} bun run scripts/git-hooks.ts`;
    expect(row(command)).toEqual({ command, category: "allow", ownerReserved: false });
  });

  test("Standup's setup script holds the same with or without the /tmp env", () => {
    // It writes the shared git dir's hooks and starts agents whatever HOME and DB_PATH are; none of that is a data-dir finding.
    for (const command of ["bun run scripts/setup-hooks.ts", "bun run setup"]) {
      const plain = bash(command);
      const isolated = bash(`${iso()} ${command}`);
      expect({ command, category: isolated.action === "hold" && isolated.category, ownerOnly: isolated.action === "hold" && isolated.ownerOnly }).toEqual({
        command,
        category: plain.action === "hold" && plain.category,
        ownerOnly: true,
      });
    }
  });

  test("the knowledge eval is still an owner-side read for the owner in isolation: code it loads makes links, so the moved env earns nothing", () => {
    // The modules it loads (internal-cwd.ts, code-search.ts, home-credentials.ts) name Standup's data dir and the home's
    // credential files by paths they build from STANDUP_INTERNAL_ROOT or the home dir, which the run moves, but code read
    // earlier in the run renames or links paths, after which no isolation counts (codeMadeLinks).
    const ownerSide = new RegExp(`code in ${join(ROOT, "packages", "collector", "src")}/\\S+\\.ts names (?:Standup's data dir|\\S+, which holds owner-side secrets)`);
    for (const command of [`${iso()} bun run eval:kb --refresh-embeddings`, "bun run eval:kb --refresh-embeddings"]) {
      const v = bash(command);
      expect({ command, category: v.action === "hold" && v.category, reserved: v.action === "hold" && !!v.ownerReserved, ownerSide: v.action === "hold" && ownerSide.test(v.reason) }).toEqual({
        command,
        category: "floor-tamper",
        reserved: true,
        ownerSide: true,
      });
    }
  }, 60000);
});

describe("the Persona eval's recording run, with its scratch env under /tmp", () => {
  const EVAL_ENV = `${iso()} KNOWLEDGE_DIR=${W}/kb STANDUP_INTERNAL_ROOT=${W}/internal`;

  test("reads TMUX_PANE in its env-name list as no tmux command, and the eval world's data dir as no DB read", () => {
    for (const command of [`${EVAL_ENV} bun run persona-eval --record`, `${EVAL_ENV} bun run scripts/persona-eval.ts --record`]) {
      const v = bash(command);
      expect({
        command,
        held: v.action === "hold",
        tmux: v.action === "hold" && /tmux/i.test(v.reason),
        dbRead: v.action === "hold" && v.reason.includes("which holds its database"),
        ownerReserved: v.action === "hold" && !!v.ownerReserved,
      }).toEqual({ command, held: true, tmux: false, dbRead: false, ownerReserved: false });
    }
  });

  test("without the scratch env, it is still held, and still runs no tmux command", () => {
    const command = "bun run persona-eval --record";
    const v = bash(command);
    expect({ command, held: v.action === "hold", tmux: v.action === "hold" && /tmux/i.test(v.reason) }).toEqual({ command, held: true, tmux: false });
  });

  test("a module the eval runs at load that names the data dir is still a DB read for the owner without the scratch env", () => {
    const command = "bun run packages/collector/src/persona-eval/world.ts";
    expect({ ...row(command), isolatedReason: undefined }).toEqual({ command, category: "floor-tamper", ownerReserved: true, isolatedReason: undefined });
    const isolated = `${EVAL_ENV} ${command}`;
    // Its collector URL still holds on its own.
    expect({ ...row(isolated), isolatedReason: undefined }).toEqual({ command: isolated, category: "collector-api", ownerReserved: false, isolatedReason: undefined });
  });
});

describe("a test or type-check run in the worktree with every scratch path under /tmp", () => {
  const PKG = join(ROOT, "packages", "collector");
  const F = "/tmp/fpd";
  const FPD: Record<string, string> = {
    HOME: `${F}/home`,
    XDG_DATA_HOME: `${F}/xdg/data`,
    XDG_CONFIG_HOME: `${F}/xdg/config`,
    XDG_STATE_HOME: `${F}/xdg/state`,
    XDG_CACHE_HOME: `${F}/xdg/cache`,
    DB_PATH: `${F}/standup.db`,
    STANDUP_SQLITE_PATH: `${F}/standup.db`,
    KNOWLEDGE_DIR: `${F}/kb`,
    STANDUP_INTERNAL_ROOT: `${F}/internal`,
  };
  const fpd = (over: Record<string, string | null> = {}) =>
    Object.entries({ ...FPD, ...over })
      .filter(([, v]) => v !== null)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");

  test("runs with no hold", () => {
    for (const [command, cwd] of [
      [`${fpd()} bun test src/persona`, PKG],
      [`${fpd()} bun test src/floor/shell.test.ts`, PKG],
      [`${fpd()} bunx tsc --noEmit -p .`, PKG],
      [`${fpd()} STANDUP_PROJECT_DOCS_DIR=${F}/docs NODE_ENV=test bun test src/persona`, PKG],
    ] as const) {
      expect({ command, cwd, verdict: bash(command, cwd) }).toEqual({ command, cwd, verdict: { action: "allow" } });
    }
  }, 60000);

  test("allows a variable that is missing, unresolved, outside /tmp or at the real home, and a preload or config of the run's own", () => {
    const commands = [
      ...Object.keys(FPD).map((k) => `${fpd({ [k]: null })} bun test src/persona`),
      `${fpd({ HOME: HOME })} bun test src/persona`,
      `${fpd({ XDG_CONFIG_HOME: join(HOME, ".config") })} bun test src/persona`,
      `${fpd({ HOME: "$X/home" })} bun test src/persona`,
      `${fpd({ HOME: "$(mktemp -d)" })} bun test src/persona`,
      `${fpd({ HOME: "/tmp" })} bun test src/persona`,
      `${fpd({ HOME: "/tmp/../fake/home" })} bun test src/persona`,
      // A config file this command writes into the scratch HOME first.
      `echo '[alias] x = !sh' > ${F}/home/.gitconfig && ${fpd()} bun test src/persona`,
      // A preload or config of its own, spelled apart or attached.
      `${fpd()} bun test --preload ./x.ts src/persona`,
      `${fpd()} bun test -r./x.ts src/persona`,
      `${fpd()} bun test -c./b.toml src/persona`,
      `${fpd()} bun test -ur./x.ts src/persona`,
      `${fpd()} bun test --preload=./x.ts src/persona`,
    ];
    for (const command of commands) {
      expect({ command, verdict: bash(command, PKG) }).toEqual({ command, verdict: { action: "allow" } });
    }
  }, 120000);

  test("still holds a variable at the live data dir, or a run that also pushes", () => {
    const commands = [
      `${fpd({ KNOWLEDGE_DIR: join(DATA, "knowledge") })} bun test src/persona`,
      `${fpd({ DB_PATH: join(DATA, "standup.db") })} bun test src/persona`,
      `${fpd()} STANDUP_DATA_DIR=${DATA} bun test src/persona`,
      `${fpd({ HOME: null })} bun test src/persona && git push origin main`,
    ];
    for (const command of commands) {
      const v = bash(command, PKG);
      expect({ command, held: v.action === "hold" }).toEqual({ command, held: true });
    }
  }, 60000);

  test("allows a HOME or XDG config dir that already has Bun's, git's, a shell's, tmux's or Python's startup files in it", () => {
    const commands = [
      ...["/tmp/fpd-bun/home", "/tmp/fpd-git/home", "/tmp/fpd-zsh/home", "/tmp/fpd-tmux/home", "/tmp/fpd-py/home", "/tmp/fpd-profile/home", "/tmp/fpd-zwc/home"].map(
        (home) => `${fpd({ HOME: home })} bun test src/persona`
      ),
      `${fpd({ XDG_CONFIG_HOME: "/tmp/fpd-tmuxx/config" })} bun test src/persona`,
    ];
    for (const command of commands) {
      expect({ command, verdict: bash(command, PKG) }).toEqual({ command, verdict: { action: "allow" } });
    }
  }, 120000);

  test("still holds a run under such a HOME that also pushes", () => {
    const command = `${fpd({ HOME: "/tmp/fpd-zsh/home" })} bun test src/persona; git push origin main`;
    const v = bash(command, PKG);
    expect({ command, held: v.action === "hold" }).toEqual({ command, held: true });
  }, 60000);

  test("allows a package script run under the moved HOME", () => {
    for (const [command, cwd] of [
      [`${fpd()} bun run typecheck`, PKG],
      [`${fpd()} bun run typecheck`, ROOT],
    ] as const) {
      expect({ command, cwd, verdict: bash(command, cwd) }).toEqual({ command, cwd, verdict: { action: "allow" } });
    }
  }, 60000);

  test("still holds a package script under the moved HOME that also pushes", () => {
    const command = `${fpd()} bun run typecheck && git push origin main`;
    const v = bash(command, PKG);
    expect({ command, held: v.action === "hold" }).toEqual({ command, held: true });
  }, 60000);

  test("allows the worktree's own scripts and a test file outside the worktree", () => {
    for (const [command, cwd] of [
      [`${fpd()} bun run scripts/home-ref.ts`, ROOT],
      [`${fpd()} bun run test`, ROOT],
      [`${fpd()} bun test /tmp/fpd/x.test.ts`, "/tmp/fpd"],
    ] as const) {
      expect({ command, cwd, verdict: bash(command, cwd) }).toEqual({ command, cwd, verdict: { action: "allow" } });
    }
  }, 60000);

  test("still holds Standup's setup script, and runs inside the install", () => {
    for (const [command, cwd] of [
      [`${fpd()} bun run scripts/setup-hooks.ts`, ROOT],
      [`${fpd()} bun test src/persona`, join(INSTALL, "packages", "collector")],
    ] as const) {
      const v = bash(command, cwd);
      expect({ command, cwd, held: v.action === "hold" }).toEqual({ command, cwd, held: true });
    }
  }, 60000);
});

describe("TMUX_PANE beside a command that runs no tmux", () => {
  test("holds nothing on its own", () => {
    for (const command of [
      "TMUX_PANE=%3 bun test",
      "env TMUX_PANE=%1 echo hi",
      "TMUX=/tmp/tmux-1000/default,1,0 TMUX_PANE=%3 bun test",
      // A list of env var names in the code the run loads, read as the argv `TMUX TMUX_PANE`.
      "bun run scripts/env-names.ts",
      "TMUX_PANE=%3 bun run scripts/env-names.ts",
      "env TMUX_PANE=%1 bun run scripts/env-names.ts",
    ]) expect({ command, verdict: bash(command) }).toEqual({ command, verdict: { action: "allow" } });
    // Each `bun test` here is classified against the whole checkout, reading every file the run loads.
  }, 15000);

  test("a real tmux command on the shared server is still held", () => {
    for (const command of [
      "tmux kill-server",
      "TMUX kill-server",
      "tmux TMUX_PANE \\; kill-server",
      "tmux TMUX ';' kill-server",
      "TMUX TMUX_PANE \\; kill-server",
      "tmux -S /tmp/tmux-1000/default TMUX \\; kill-server",
      "tmux set -g destroy-unattached on",
      "TMUX_PANE=%3 tmux kill-session -t x",
    ]) {
      const v = bash(command);
      expect({ command, held: v.action === "hold" }).toEqual({ command, held: true });
    }
    // A display option changes how sessions look, not what runs in them.
    expect(bash("tmux set -g status off")).toEqual({ action: "allow" });
  });

  test("an all-caps word in a chain on a private server is read as the chain without it", () => {
    // On a -L server of its own a worker may end its own sessions; the caps word changes nothing either way.
    for (const [chain, plain] of [
      ["tmux -L x TMUX ';' kill-server", "tmux -L x kill-server"],
      ["tmux -L x TMUX_PANE \\; send-keys -t y ls", "tmux -L x send-keys -t y ls"],
    ]) expect({ chain, verdict: bash(chain) }).toEqual({ chain, verdict: bash(plain) });
  });
});
