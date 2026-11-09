import { describe, expect, test } from "bun:test";
import { classifyToolCall, type FloorProbes } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * A cookie store or credential cache below one of the home dir's dot entries
 * (homeSecretFile) is an owner secret whether or not an org profile names its
 * dir. Reading it through its dir is held as a direct read is: a glob that
 * matches it, a recursive search or copy of a dir that holds it, a `find` or
 * `ls` whose names a later step takes, and a path below the dir whose name
 * the floor can't read. The default profile names no SSO dirs, so these rows
 * hold by what the dirs hold, not by their names.
 */

const HOME = "/home/tester";
const DATA = `${HOME}/.local/share/standup`;
const ROOT = `${DATA}/worktrees/proj/fix-1`;
const INSTALL = "/opt/standup";

const config: FloorConfig = {
  v: 1,
  collectorUrl: "http://localhost:7777",
  launchId: "launch-1",
  root: ROOT,
  sharedBranches: ["main"],
  personalAwsAccounts: [],
  waitSeconds: 60,
  standupDataDir: DATA,
  floorPaths: [`${INSTALL}/packages/collector/src/floor`],
  installDir: INSTALL,
  protectedPaths: [`${DATA}/secrets`],
  tmpDirs: ["/tmp"],
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
  worktreeRoots: [`${DATA}/worktrees`],
};

const FILES: Record<string, string> = {
  [`${HOME}/.corp-sso/cookie`]: "session=1\n",
  [`${HOME}/.corp-sso/config`]: "region=x\n",
  [`${HOME}/.sso-tool/state/credentials.json`]: "{}\n",
  [`${HOME}/.sso-tool/state/settings.json`]: "{}\n",
  [`${HOME}/.agent-cli/.credentials.json`]: "{}\n",
  [`${HOME}/.agent-cli/notes.md`]: "\n",
  [`${HOME}/.config/nvim/init.lua`]: "\n",
  [`${HOME}/.config/nvim/lua/plugins.lua`]: "\n",
  [`${HOME}/.vim/vimrc`]: "\n",
  [`${HOME}/.cargo/registry/src/crate-1/lib.rs`]: "\n",
  [`${ROOT}/.git`]: "gitdir: /tmp/x\n",
  [`${ROOT}/e2e/cookies.json`]: "[]\n",
  [`${ROOT}/src/a.ts`]: "\n",
};

/** A dot dir with more entries than the floor's walk takes (HOME_SECRET_WALK_CAP), a token cache below them all. */
const BIG: Record<string, string> = { [`${HOME}/.cache/big/zz/a/b/token`]: "t\n", [`${ROOT}/src/a.ts`]: "\n", [`${ROOT}/.git`]: "gitdir: /tmp/x\n" };
for (let i = 0; i < 6000; i++) BIG[`${HOME}/.cache/big/f${String(i).padStart(4, "0")}`] = "\n";
for (let i = 0; i < 6000; i++) BIG[`${HOME}/.history/s${String(i).padStart(4, "0")}.jsonl`] = "{}\n";

function probesOf(files: Record<string, string>): Partial<FloorProbes> {
  const dirs = new Set<string>(["/", "/tmp", INSTALL]);
  for (const f of Object.keys(files)) {
    for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  }
  const listing = new Map<string, Set<string>>();
  for (const p of [...Object.keys(files), ...dirs]) {
    if (p === "/") continue;
    const parent = p.slice(0, p.lastIndexOf("/")) || "/";
    if (!listing.has(parent)) listing.set(parent, new Set());
    listing.get(parent)!.add(p.slice(p.lastIndexOf("/") + 1));
  }
  return {
    gitBranch: () => "fix-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    readFile: (p) => (p in files ? { ok: true, text: files[p]! } : { ok: false, reason: "missing" }),
    exists: (p) => p in files || dirs.has(p),
    isDirectory: (p) => dirs.has(p),
    listDir: (dir) => (dirs.has(dir) ? [...(listing.get(dir) ?? [])].sort() : null),
    lstat: (p) => (p in files ? { symlink: false, file: true, nlink: 1 } : dirs.has(p) ? { symlink: false, file: false, nlink: 2 } : null),
    realpath: (p) => (p in files || dirs.has(p) ? p : null),
    homeDir: () => HOME,
    shellDefinitions: () => ({ aliases: new Map(), functions: new Map() }),
    awsAccount: () => null,
    now: () => Date.now(),
  };
}

const bash = (command: string, cwd = ROOT, files = FILES): FloorVerdict => classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, config, probesOf(files));
const tool = (toolName: string, toolInput: Record<string, unknown>): FloorVerdict => classifyToolCall({ toolName, toolInput, cwd: ROOT }, config, probesOf(FILES));
const category = (v: FloorVerdict) => (v.action === "hold" ? v.category : v.action);

describe("a dir below a home dot entry that holds a cookie or credential file, under the default profile", () => {
  const held: Array<[string, string?]> = [
    ["cat ~/.corp-sso/*"],
    [`cat ${HOME}/.corp-sso/*`],
    ["head -c 100 ~/.corp-sso/c*"],
    ["cat ~/.corp-*/cookie"],
    ["cat ~/.sso-tool/*/*"],
    ["cat ~/.corp-sso/**"],
    ["head ~/.sso-tool/**"],
    ["cat ~/.sso-tool/**/credentials.json"],
    ["grep -r session ~/.corp-sso"],
    [`grep -rn session ${HOME}/.corp-sso/`],
    ["grep -r token ~/.sso-tool"],
    ["grep -r token ~/.sso-tool/*"],
    ["rg session ~/.corp-sso"],
    ["cp -r ~/.corp-sso /tmp/sso"],
    ["cp -r ~/.corp-sso/* /tmp/sso"],
    ["cp -r ~/.sso-tool/* /tmp/sso"],
    ["tar czf /tmp/sso.tgz ~/.corp-sso"],
    ["find ~/.corp-sso -type f | xargs cat"],
    ["find ~/.sso-tool -type f -print0 | xargs -0 cat"],
    ["find ~/.corp-sso -type f -exec cat {} +"],
    ["cat *", `${HOME}/.corp-sso`],
    ["grep -r session .", `${HOME}/.corp-sso`],
    ["rg session", `${HOME}/.corp-sso`],
  ];
  for (const [command, cwd] of held) {
    test(`${command}${cwd ? ` (in ${cwd})` : ""} is held`, () => {
      expect({ command, verdict: category(bash(command, cwd)) }).toEqual({ command, verdict: "floor-tamper" });
    });
  }

  test("the Grep tool searching such a dir is held", () => {
    expect(category(tool("Grep", { pattern: "session", path: `${HOME}/.corp-sso` }))).toBe("floor-tamper");
    expect(category(tool("Grep", { pattern: "token", path: `${HOME}/.sso-tool` }))).toBe("floor-tamper");
  });
});

describe("a listing of such a dir whose names a later step takes is held", () => {
  const held: Array<[string, string?]> = [
    ["cat $(find ~/.corp-sso -type f)"],
    ["cat `find ~/.sso-tool -type f`"],
    ["xargs cat < <(find ~/.corp-sso -type f)"],
    ["while read -r f; do cat \"$f\"; done < <(find ~/.sso-tool -type f)"],
    ["find ~/.corp-sso -type f | while read -r f; do cat \"$f\"; done"],
    ["cat ~/.corp-sso/$(ls ~/.corp-sso | head -1)"],
    ["f=$(ls ~/.corp-sso); cat ~/.corp-sso/$f"],
    ["ls ~/.corp-sso | head -1"],
    ["ls -a ~/.agent-cli | grep cred"],
    ["find ~/.sso-tool -name '*.json' > /tmp/list"],
    ["find ~/.corp-sso -type f -fprint /tmp/list"],
    ["find ~/.sso-tool -type f -exec sh -c 'cat \"$1\"' _ {} \\;"],
    ["tree ~/.sso-tool > /tmp/tree"],
    ["ls | head -1", `${HOME}/.corp-sso`],
    ["cat $(find ~ -name cookie)"],
  ];
  for (const [command, cwd] of held) {
    test(`${command}${cwd ? ` (in ${cwd})` : ""} is held`, () => {
      expect({ command, verdict: category(bash(command, cwd)) }).toEqual({ command, verdict: "floor-tamper" });
    });
  }
});

describe("a path below such a dir whose name the floor can't read is held", () => {
  const held: string[] = [
    "cat ~/.corp-sso/$f",
    'cat "$HOME/.corp-sso/$name"',
    "head -c 50 ~/.sso-tool/$sub/credentials.json",
    "cat ~/.sso-tool/$(cat /tmp/which)",
    "base64 ~/.corp-sso/${n}",
    "cat ~/.$f",
  ];
  for (const command of held) {
    test(`${command} is held`, () => {
      expect({ command, verdict: category(bash(command)) }).toEqual({ command, verdict: "floor-tamper" });
    });
  }
});

describe("reads that reach no cookie or credential file pass", () => {
  const allowed: Array<[string, string?]> = [
    ["ls ~/.corp-sso"],
    ["find ~/.corp-sso -name config"],
    ["find ~/.corp-sso -name config | head"],
    ["find ~/.sso-tool -name 'settings*' | wc -l"],
    ["ls ~/.agent-cli | head"],
    ["cat ~/.corp-sso/config"],
    ["cat ~/.corp-sso/conf*"],
    ["cat ~/.sso-tool/state/settings.json"],
    ["grep -r foo ~/.config/nvim"],
    ["cat ~/.config/nvim/*.lua"],
    ["cat ~/.config/nvim/**"],
    ["cat ~/.config/nvim/$f"],
    ["find ~/.config/nvim -type f | xargs cat"],
    ["cat $(find ~/.config/nvim -name '*.lua')"],
    ["cp -r ~/.vim /tmp/vim"],
    ["rg foo ~/.cargo/registry/src"],
    ["grep -r cookie ."],
    ["rg cookie"],
    ["cat src/$f"],
    ["ls ~/.corp-sso/$f"],
    ["stat ~/.corp-sso/$f | head -1"],
    [`cat ${ROOT}/e2e/*`],
    ["cp -r e2e /tmp/e2e"],
    ["cat $(find . -name '*.ts')"],
  ];
  for (const [command, cwd] of allowed) {
    test(`${command}${cwd ? ` (in ${cwd})` : ""} is allowed`, () => {
      expect({ command, verdict: category(bash(command, cwd)) }).toEqual({ command, verdict: "allow" });
    });
  }

  test("the Grep tool searching a dot dir with no secret in it is allowed", () => {
    expect(category(tool("Grep", { pattern: "foo", path: `${HOME}/.config/nvim` }))).toBe("allow");
  });
});

describe("a dot dir with more below it than the floor walks", () => {
  const held = [
    "grep -r x ~/.history",
    "find ~/.history -type f | xargs cat",
    "grep -r x ~/.cache/big",
    "rg -uu session ~/.cache",
    "cp -r ~/.cache/big /tmp/big",
    "cat ~/.cache/big/**",
    "cat $(find ~/.cache/big -type f)",
    "find ~/.cache -type f | xargs cat",
  ];
  for (const command of held) {
    test(`${command} is held: what the walk doesn't reach may be a credential`, () => {
      expect({ command, verdict: category(bash(command, ROOT, BIG)) }).toEqual({ command, verdict: "floor-tamper" });
    });
  }

  const allowed = [
    "find ~/.history -name '*.jsonl' | head",
    "cat $(find ~/.history -name 's00*.jsonl')",
    "cat ~/.history/*.jsonl",
    "ls ~/.history | head",
    "cat ~/.history/s0001.jsonl",
  ];
  for (const command of allowed) {
    test(`${command} is allowed: it names no credential`, () => {
      expect({ command, verdict: category(bash(command, ROOT, BIG)) }).toEqual({ command, verdict: "allow" });
    });
  }
});
