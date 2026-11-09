import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { classifyToolCall } from "./classify.js";
import type { FloorConfig } from "./gate.js";

/*
 * The impeccable skill launcher against the floor's real probes: a home under
 * a fresh /tmp dir holds the launcher as the skill installs it, its VERSION,
 * and a compiled program as this host's engine. The collector URL is dead and
 * no collector runs: classifying a call never reaches one.
 */

const ENGINE_SOURCE = "/usr/bin/true";
const OS = process.platform === "darwin" ? "darwin" : "linux";
const ARCH = process.arch === "arm64" ? "arm64" : "x64";

let base: string;
let home: string;
let root: string;
let launcher: string;
let config: FloorConfig;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join("/tmp", "impeccable-live-")));
  home = join(base, "home");
  root = join(base, "data", "worktrees", "standup", "feat-1");
  const scripts = join(home, ".claude", "skills", "impeccable", "scripts");
  launcher = join(scripts, "impeccable");
  for (const d of [join(scripts, "bin", `${OS}-${ARCH}`), join(root, "src"), join(base, "install", "packages", "collector", "src", "floor"), join(base, "data", "secrets")]) mkdirSync(d, { recursive: true });
  writeFileSync(launcher, readFileSync(join(import.meta.dir, "fixtures", "false-holds", "impeccable-launcher.sh.txt")));
  chmodSync(launcher, 0o755);
  writeFileSync(join(scripts, "VERSION"), "0.1.14\n");
  copyFileSync(ENGINE_SOURCE, join(scripts, "bin", `${OS}-${ARCH}`, "impeccable"));
  writeFileSync(join(root, ".git"), `gitdir: ${join(base, "repo.git")}\n`);
  writeFileSync(join(base, "variant-outside.sh"), "mv -f /tmp/x /etc/hosts\n");
  writeFileSync(join(base, "variant-settings.sh"), 'printf "{}" > "$HOME/.claude/settings.json"\n');
  config = {
    v: 1,
    collectorUrl: "http://127.0.0.1:1",
    launchId: "live-check",
    root,
    sharedBranches: ["main", "mainline"],
    personalAwsAccounts: [],
    waitSeconds: 1,
    standupDataDir: join(base, "data"),
    floorPaths: [join(base, "install", "packages", "collector", "src", "floor")],
    installDir: join(base, "install"),
    protectedPaths: [join(base, "data", "secrets")],
    tmpDirs: ["/tmp"],
    workerToken: "x".repeat(64),
    replyPublicKey: "test",
  };
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe.skipIf(!existsSync(ENGINE_SOURCE))("the impeccable launcher against the floor's real probes", () => {
  test("its run shapes are allowed and the unsafe ones held", () => {
    const cases: Array<[string, "allow" | "hold"]> = [
      [`${launcher} context`, "allow"],
      [`${launcher} critique --target src/app.tsx`, "allow"],
      [`sh ${launcher} detect --json`, "allow"],
      [`${launcher} hooks on`, "hold"],
      [`OPENAI_API_KEY=sk-test ${launcher} generate-image`, "hold"],
      [`IMPECCABLE_BIN=/bin/rm ${launcher} context`, "hold"],
      [`sh < ${launcher}`, "hold"],
      [`sudo ${launcher} context`, "hold"],
      [`X=a\\ nohup strace -E IMPECCABLE_BIN=/tmp/e ${launcher} context`, "hold"],
      // The home here is under /tmp, which is the worker's own ground: a path outside it is a system one.
      [`${launcher} comp-diff --out-dir /etc/impeccable`, "hold"],
      [`sh ${join(base, "variant-outside.sh")} context`, "hold"],
      [`sh ${join(base, "variant-settings.sh")} context`, "hold"],
    ];
    const results = cases.map(([command, want]) => {
      const v = classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: root }, config, { homeDir: () => home });
      return { command: command.replaceAll(base, "$R"), want, got: v.action, ...(v.action === "hold" ? { category: v.category } : {}) };
    });
    console.log(JSON.stringify(results, null, 1));
    for (const r of results) expect({ command: r.command, got: r.got }).toEqual({ command: r.command, got: r.want });
  });
});
