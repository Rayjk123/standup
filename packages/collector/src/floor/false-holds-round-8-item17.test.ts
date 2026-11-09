import { describe, expect, test } from "bun:test";
import { dirname, join, resolve } from "path";
import { classifyToolCall, defaultProbes, type FloorProbes } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * A scratch collector started in a tmux session on a private socket under a
 * fresh mktemp root in /tmp: a cleared env with every path Standup's code
 * reads under the root, a PATH led by the root's own bin holding a stub
 * `claude`, loopback, scratch ports and the off-network flags, Persona's
 * included: a stub on PATH is no isolation, since any later call may put a
 * real `claude` where Persona's turns find it. The entry is
 * this checkout's real packages/collector/src/index.ts; the machine around
 * the worktree is virtual.
 */

const REPO = resolve(import.meta.dir, "..", "..", "..", "..");
const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const SCRATCH = join(HOME, ".cache", "standup-scratch", "11111111-2222-3333-4444-555555555555");

const config: FloorConfig = {
  v: 1,
  collectorUrl: "http://127.0.0.1:17777",
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
  scratchDir: SCRATCH,
  scratchRoot: join(HOME, ".cache", "standup-scratch"),
};

const STUB_TEXT = "#!/bin/sh\necho stub\n";
const REAL_CLAUDE = '#!/bin/sh\nexec node /fake/claude.js "$@"\n';

const VIRTUAL: Record<string, string> = {
  [join(ROOT, ".git")]: "gitdir: /fake/install/.git/worktrees/feat-1\n",
  [join(DATA, "standup.db")]: "",
  [join(DATA, "secrets", "owner.token")]: "secret",
  [join(HOME, ".local", "bin", "claude")]: REAL_CLAUDE,
  // Roots an earlier command made, each with its `bin/claude`.
  "/tmp/sc-prev/bin/claude": STUB_TEXT,
  "/tmp/sc-real/bin/claude": REAL_CLAUDE,
  "/tmp/sc-noexec/bin/claude": STUB_TEXT,
  "/tmp/sc-link/bin/claude": REAL_CLAUDE,
};

/** Dirs an earlier command made: each root's TMUX_TMPDIR. */
const MADE = ["/tmp/sc-prev/tmp", "/tmp/sc-real/tmp", "/tmp/sc-noexec/tmp", "/tmp/sc-link/tmp", "/tmp/r8-live-CcJPf5/tmp"];

/** Files with no execute bit. */
const NOT_EXECUTABLE = new Set(["/tmp/sc-noexec/bin/claude"]);

/** Symlinks, and where they lead. */
const LINKS: Record<string, string> = { "/tmp/sc-link/bin/claude": join(HOME, ".local", "bin", "claude") };

const WORKER_ENV: Record<string, string> = {
  TMUX: "/tmp/tmux-1000/default,1,0",
  TMUX_PANE: "%1",
  TMPDIR: SCRATCH,
  TMP: SCRATCH,
  TEMP: SCRATCH,
  HOME,
  PATH: "/usr/bin:/bin",
};

/** A launched worker's env: outside any tmux session, its own TMUX_TMPDIR under /tmp. */
const LAUNCHED_ENV: Record<string, string> = {
  TMUX_TMPDIR: "/tmp/standup-tmux-1000-11111111",
  TMPDIR: SCRATCH,
  TMP: SCRATCH,
  TEMP: SCRATCH,
  HOME,
  PATH: "/usr/bin:/bin",
};

function real(p: string): string | null {
  for (const base of [ROOT, INSTALL]) {
    if (p === base) return REPO;
    if (p.startsWith(`${base}/`)) return join(REPO, p.slice(base.length + 1));
  }
  return null;
}

/** Where the home dir really is when it is a link (`/home/u` -> `/data/home/u`). */
const LINKED_HOME = join("/", "fake", "data", "home");

function probes(linkedHome = false): Partial<FloorProbes> {
  const disk = defaultProbes();
  const dirs = new Set<string>(["/", "/tmp", ...MADE]);
  for (const f of [...Object.keys(VIRTUAL), ...MADE]) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(join(ROOT, ".git"));
  if (linkedHome) dirs.add(LINKED_HOME).add(dirname(LINKED_HOME));
  const swap = (p: string, from: string, to: string) => (linkedHome && (p === from || p.startsWith(`${from}/`)) ? to + p.slice(from.length) : p);
  // Every path is looked up by the name the fixture keeps it under; realpath answers with the link's target.
  const named = (p: string) => swap(p, LINKED_HOME, HOME);
  const bare = (raw: string) => {
    const p = named(raw);
    return p.length > 1 ? p.replace(/\/+$/, "") : p;
  };
  const exists = (raw: string) => {
    const p = named(raw);
    return p in VIRTUAL || dirs.has(bare(p)) || (real(p) !== null && disk.exists(real(p)!));
  };
  const isDirectory = (raw: string) => {
    const p = named(raw);
    return !(p in VIRTUAL) && (dirs.has(bare(p)) || (real(p) !== null && disk.isDirectory(real(p)!)));
  };
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: () => null,
    readFile: (raw, max) => {
      const p = named(raw);
      return p in VIRTUAL ? { ok: true, text: VIRTUAL[p]! } : real(p) !== null ? disk.readFile(real(p)!, max) : { ok: false, reason: "missing" };
    },
    exists,
    isDirectory,
    executable: (raw) => {
      const p = named(raw);
      return p in VIRTUAL ? !NOT_EXECUTABLE.has(p) : real(p) !== null ? disk.executable(real(p)!) : null;
    },
    listDir: (raw) => {
      const p = bare(raw);
      if (!isDirectory(p)) return null;
      const virtual = Object.keys(VIRTUAL).concat([...dirs]).filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!);
      const onDisk = real(p) !== null ? (disk.listDir(real(p)!) ?? []).filter((n) => n !== ".git") : [];
      return [...new Set([...virtual, ...onDisk])];
    },
    lstat: (p) => {
      const link = bare(p) in LINKS || (linkedHome && p.replace(/\/+$/, "") === HOME);
      return exists(p) ? { symlink: link, file: !isDirectory(p) && !link, nlink: 1 } : null;
    },
    realpath: (p) => (exists(p) ? swap(LINKS[bare(p)] ?? bare(p), HOME, LINKED_HOME) : null),
    homeDir: () => HOME,
    env: (name) => (linkedHome ? LAUNCHED_ENV : WORKER_ENV)[name],
    awsAccount: () => null,
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

function verdict(command: string, cwd = ROOT, linkedHome = false): { command: string; action: string; category: string | null; ownerReserved: boolean; reason: string } {
  const v: FloorVerdict = classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, config, probes(linkedHome));
  return v.action === "hold"
    ? { command, action: v.action, category: v.category, ownerReserved: v.ownerReserved === true, reason: v.reason }
    : { command, action: v.action, category: null, ownerReserved: false, reason: "" };
}

const allowed = (command: string, cwd = ROOT) => {
  const v = verdict(command, cwd);
  return { command, action: v.action, reason: v.reason };
};

/** `allowed`, with the home dir a link to where it really is. */
const allowedIn = (command: string, cwd: string) => {
  const v = verdict(command, cwd, true);
  return { command, action: v.action, reason: v.reason };
};

const held = (command: string, cwd = ROOT) => {
  const v = verdict(command, cwd);
  return { command, action: v.action, category: v.category, ownerReserved: v.ownerReserved };
};

const MKTEMP = "R=$(mktemp -d -p /tmp sc-XXXXXX)";
const DIRS = "mkdir -p $R/bin $R/home $R/xdg/config $R/xdg/data $R/xdg/cache $R/xdg/state $R/tmp $R/data $R/knowledge $R/internal";
const STUB = "printf '#!/bin/sh\\necho stub\\n' > $R/bin/claude && chmod +x $R/bin/claude";
const BUN = "/home/alice/.bun/bin";

/** The collector's env, in the order a worker types it. */
const ENV: ReadonlyArray<readonly [string, string]> = [
  ["PATH", `$R/bin:${BUN}:/usr/bin:/bin`],
  ["HOME", "$R/home"],
  ["XDG_CONFIG_HOME", "$R/xdg/config"],
  ["XDG_DATA_HOME", "$R/xdg/data"],
  ["XDG_CACHE_HOME", "$R/xdg/cache"],
  ["XDG_STATE_HOME", "$R/xdg/state"],
  ["TMPDIR", "$R/tmp"],
  ["TMP", "$R/tmp"],
  ["TEMP", "$R/tmp"],
  ["DB_PATH", "$R/data/standup.db"],
  ["STANDUP_SQLITE_PATH", "$R/data/standup.sqlite"],
  ["KNOWLEDGE_DIR", "$R/knowledge"],
  ["STANDUP_INTERNAL_ROOT", "$R/internal"],
  ["STANDUP_BIND_HOST", "127.0.0.1"],
  ["COLLECTOR_PORT", "29777"],
  ["WS_PORT", "29778"],
  ["STANDUP_GATEWAY", "0"],
  ["STANDUP_PERSONA", "0"],
  ["STANDUP_REVIEW_TUNNELS", "0"],
  ["STANDUP_DIGEST", "0"],
];

type Env = Record<string, string | null>;

/** The collector's env line with `changes` applied (null drops a name; a new name is added at the end). */
function envLine(changes: Env = {}): string {
  const out: string[] = [];
  for (const [k, v] of ENV) {
    const c = k in changes ? changes[k] : v;
    if (c !== null && c !== undefined) out.push(`${k}=${c}`);
  }
  for (const [k, v] of Object.entries(changes)) if (!ENV.some(([n]) => n === k) && v !== null) out.push(`${k}=${v}`);
  return out.join(" ");
}

interface Shape {
  env?: Env;
  tmux?: string;
  entry?: string;
  stub?: string;
}

/** The whole worker command: a fresh root, its dirs, the stub turn runner, and the collector in a tmux session on the root's socket. */
function shape({ env = {}, tmux = "tmux -S $R/tmux.sock", entry = "packages/collector/src/index.ts", stub = STUB }: Shape = {}): string {
  return `${MKTEMP} && ${DIRS} && ${stub} && ${tmux} new-session -d -s c "env -i ${envLine(env)} bun ${entry}"`;
}

/** The start in a tmux session on the root's socket, for a root an earlier command made. */
function later(root: string, env: Env = {}, tmux = "tmux -S $R/tmux.sock"): string {
  return `R=${root} && ${tmux} new-session -d -s c "env -i ${envLine(env)} bun packages/collector/src/index.ts"`;
}

describe("a fully isolated scratch collector in a private tmux session with a stub claude", () => {
  test("is allowed, with Persona off in it, with a TMUX_TMPDIR under the root", () => {
    for (const command of [
      shape({ env: { TMUX_TMPDIR: "$R/tmp" } }),
      // Run straight from the shell, not in tmux.
      `${MKTEMP} && ${DIRS} && ${STUB} && env -i ${envLine({ TMUX_TMPDIR: "$R/tmp" })} bun packages/collector/src/index.ts`,
      // The stub made executable another way.
      shape({ env: { TMUX_TMPDIR: "$R/tmp" }, stub: "printf '#!/bin/sh\\necho stub\\n' > $R/bin/claude && chmod 755 $R/bin/claude" }),
      shape({ env: { TMUX_TMPDIR: "$R/tmp" }, stub: "printf '#!/bin/sh\\nexit 0\\n' > $R/bin/claude && chmod u+x $R/bin/claude" }),
    ]) {
      expect(allowed(command)).toEqual({ command, action: "allow", reason: "" });
    }
  }, 300_000);

  test("without TMUX_TMPDIR under the root, its bare tmux may fall back to the shared default socket: held", () => {
    for (const command of [
      shape(),
      `${MKTEMP} && ${DIRS} && ${STUB} && env -i ${envLine()} bun packages/collector/src/index.ts`,
      shape({ stub: "printf '#!/bin/sh\\necho stub\\n' > $R/bin/claude && chmod 755 $R/bin/claude" }),
    ]) {
      expect(held(command)).toEqual({ command, action: "hold", category: "destructive", ownerReserved: false });
    }
  }, 300_000);

  test("is allowed with the stub an earlier command wrote, and a TMUX_TMPDIR under the root", () => {
    const command = later("/tmp/sc-prev", { TMUX_TMPDIR: "$R/tmp" });
    expect(allowed(command)).toEqual({ command, action: "allow", reason: "" });
  }, 120_000);
});

describe("a code literal that isn't shell, read with its placeholders as words", () => {
  test("a redirect beside a placeholder still holds", () => {
    for (const text of [`echo it's <name> > ${DATA}/notes`, `echo it's > ${DATA}/notes <name>`]) {
      const command = `bun -e 'require("child_process").execSync(${JSON.stringify(text).replace(/'/g, "'\\''")})'`;
      const v = verdict(command);
      expect({ command, action: v.action, redirect: v.reason.includes("redirect > writes Standup's own data") }).toEqual({ command, action: "hold", redirect: true });
    }
  }, 120_000);
});

describe("the same start stays held", () => {
  test("with HOME outside /tmp", () => {
    for (const command of [shape({ env: { HOME: HOME } }), shape({ env: { HOME: join(HOME, "scratch-home") } })]) {
      expect(held(command)).toEqual({ command, action: "hold", category: "floor-tamper", ownerReserved: true });
    }
  }, 120_000);

  test("with Persona on, whatever claude its PATH leads to: a later call may put a real one there", () => {
    const on = { STANDUP_PERSONA: null, TMUX_TMPDIR: "$R/tmp" };
    for (const command of [
      // A stub on PATH, written now or by an earlier command.
      shape({ env: on }),
      shape({ env: { ...on, STANDUP_PERSONA: "1" } }),
      shape({ env: on, stub: "printf '#!/bin/sh\\nexit 0\\n' > $R/bin/claude && chmod u+x $R/bin/claude" }),
      `${MKTEMP} && ${DIRS} && ${STUB} && env -i ${envLine(on)} bun packages/collector/src/index.ts`,
      later("/tmp/sc-prev", on),
      // A stub run by an `env` lookup that finds a `bash` the command put on the same PATH.
      shape({
        env: on,
        stub: `printf '#!/usr/bin/env bash\\necho stub\\n' > $R/bin/claude && chmod +x $R/bin/claude && printf '#!/bin/sh\\nexec ${HOME}/.local/bin/claude -p\\n' > $R/bin/bash && chmod +x $R/bin/bash`,
      }),
      shape({ env: { ...on, PATH: `${BUN}:/usr/bin:/bin` } }),
      shape({ env: { ...on, PATH: `${BUN}:$R/bin:/usr/bin:/bin` } }),
      shape({ env: { ...on, PATH: `/tmp:$R/bin:${BUN}:/usr/bin:/bin` } }),
      shape({ env: on, stub: "true" }),
      shape({ env: on, stub: "printf '#!/bin/sh\\necho stub\\n' > $R/bin/claude" }),
      shape({ env: on, stub: `printf '#!/bin/sh\\nexec ${HOME}/.local/bin/claude \"$@\"\\n' > $R/bin/claude && chmod +x $R/bin/claude` }),
      shape({ env: on, stub: "printf '#!/usr/bin/env node\\nconsole.log(1)\\n' > $R/bin/claude && chmod +x $R/bin/claude" }),
      later("/tmp/sc-real", on),
      later("/tmp/sc-noexec", on),
    ]) {
      const v = verdict(command);
      expect({ command, action: v.action, category: v.category, persona: v.reason.includes("without STANDUP_PERSONA=0") }).toEqual({ command, action: "hold", category: "outward", persona: true });
    }
  }, 300_000);

  test("with Persona off, the turn runner on PATH is not what isolates it", () => {
    const command = shape({ env: { STANDUP_PERSONA: "0", PATH: `${BUN}:/usr/bin:/bin`, TMUX_TMPDIR: "$R/tmp" }, stub: "true" });
    expect(allowed(command)).toEqual({ command, action: "allow", reason: "" });
  }, 120_000);

  test("with the real claude linked or copied in", () => {
    for (const stub of [`ln -s ${HOME}/.local/bin/claude $R/bin/claude`, `cp ${HOME}/.local/bin/claude $R/bin/claude && chmod +x $R/bin/claude`]) {
      for (const env of [{ STANDUP_PERSONA: null }, { STANDUP_PERSONA: null, TMUX_TMPDIR: "$R/tmp" }] as Env[]) {
        const command = shape({ stub, env });
        expect({ command, action: verdict(command).action }).toEqual({ command, action: "hold" });
      }
    }
    // A root an earlier command made, its claude a link to the real one: a link out of the root voids the isolation itself.
    const command = later("/tmp/sc-link", { TMUX_TMPDIR: "$R/tmp" });
    expect(held(command)).toEqual({ command, action: "hold", category: "floor-tamper", ownerReserved: true });
  }, 120_000);

  test("with Persona on and the stub replaced after the collector starts, in the same call or a later one", () => {
    const swaps = [`cp ${HOME}/.local/bin/claude $R/bin/claude`, "rm -f $R/bin/claude", `ln -sf ${HOME}/.local/bin/claude $R/bin/claude`, `printf '#!/bin/sh\\nexec node /fake/claude.js\\n' > $R/bin/claude`];
    for (const tail of swaps) {
      const command = `${shape({ env: { STANDUP_PERSONA: null, TMUX_TMPDIR: "$R/tmp" } })} && ${tail}`;
      const v = verdict(command);
      expect({ command, action: v.action, persona: v.reason.includes("without STANDUP_PERSONA=0") }).toEqual({ command, action: "hold", persona: true });
    }
    // A later call's swap is an ordinary temp-dir write: the start it would subvert is the one held.
    const start = later("/tmp/sc-prev", { STANDUP_PERSONA: null, TMUX_TMPDIR: "$R/tmp" });
    expect(held(start)).toEqual({ command: start, action: "hold", category: "outward", ownerReserved: false });
    for (const command of [`cp ${HOME}/.local/bin/claude /tmp/sc-prev/bin/claude`, `printf '#!/bin/sh\\nexec ${HOME}/.local/bin/claude \"$@\"\\n' > /tmp/sc-prev/bin/claude`]) {
      expect(allowed(command)).toEqual({ command, action: "allow", reason: "" });
    }
  }, 300_000);

  test("on the live collector's or console's ports", () => {
    for (const env of [{ COLLECTOR_PORT: "17777" }, { COLLECTOR_PORT: "27777" }, { WS_PORT: "27778" }, { COLLECTOR_PORT: "27777", WS_PORT: "27778" }] as Env[]) {
      const command = shape({ env });
      expect({ command, action: verdict(command).action }).toEqual({ command, action: "hold" });
    }
  }, 300_000);

  test("bound past loopback, or with a gateway, review tunnels or digests on", () => {
    for (const env of [{ STANDUP_BIND_HOST: "0.0.0.0" }, { STANDUP_GATEWAY: "1" }, { STANDUP_GATEWAY: null }, { STANDUP_REVIEW_TUNNELS: null }, { STANDUP_REVIEW_TUNNELS: "1" }, { STANDUP_DIGEST: null }, { STANDUP_BIND_HOST: null }] as Env[]) {
      const command = shape({ env });
      expect(held(command)).toEqual({ command, action: "hold", category: "outward", ownerReserved: false });
    }
  }, 300_000);

  test("with DB_PATH at the live DB", () => {
    for (const command of [shape({ env: { DB_PATH: join(DATA, "standup.db") } }), shape({ env: { DB_PATH: join(DATA, "standup.db"), STANDUP_PERSONA: "0" } })]) {
      expect(held(command)).toEqual({ command, action: "hold", category: "floor-tamper", ownerReserved: true });
    }
  }, 120_000);

  test("run from the install", () => {
    const command = shape();
    expect({ command, action: verdict(command, INSTALL).action }).toEqual({ command, action: "hold" });
  }, 120_000);

  test("in a session on the shared tmux server", () => {
    for (const tmux of ["tmux", "tmux -S /tmp/tmux-1000/default", "tmux -L default"]) {
      const command = shape({ tmux });
      expect({ command, action: verdict(command).action }).toEqual({ command, action: "hold" });
    }
  }, 300_000);

  test("without TMUX_TMPDIR on a root no fresh mktemp made: its DB may name sessions on the shared default server", () => {
    for (const command of [later("/tmp/sc-prev"), later("/tmp/sc-prev", { STANDUP_PERSONA: "0", PATH: `${BUN}:/usr/bin:/bin` })]) {
      expect(held(command)).toEqual({ command, action: "hold", category: "destructive", ownerReserved: false });
    }
  }, 120_000);
});

/** The start with the collector's output sent to a log under the root, from `cd` into the worktree inside the session. */
function logged(prefix: string, env: Env = {}, target = "$R/collector.log"): string {
  const off = { PATH: `${BUN}:/usr/local/bin:/usr/bin:/bin`, TMUX_TMPDIR: "$R/tmp", ...env };
  return `${prefix} && tmux -S $R/tmux.sock new-session -d -s c "cd ${ROOT} && env -i ${envLine(off)} bun packages/collector/src/index.ts > ${target} 2>&1"`;
}

describe("a scratch collector whose output goes to a log under its root", () => {
  test("is allowed, on a root an earlier command made or a fresh one", () => {
    const earlier = logged("R=/tmp/r8-live-CcJPf5");
    const commands = [
      earlier,
      // The socket spelled out, the root set by `;`.
      earlier.replace("tmux -S $R/", "tmux -S /tmp/r8-live-CcJPf5/"),
      earlier.replace("tmux -S $R/", "tmux -S /tmp/r8-live-CcJPf5/").replace(" && tmux", "; tmux"),
      // Every path spelled out.
      earlier.slice("R=/tmp/r8-live-CcJPf5 && ".length).replaceAll("$R", "/tmp/r8-live-CcJPf5"),
      // Without the cd, or without the log.
      earlier.replace(`cd ${ROOT} && `, ""),
      earlier.replace(" > $R/collector.log 2>&1", ""),
      logged("R=/tmp/sc-prev"),
      // A fresh root made in the same command.
      logged(`${MKTEMP} && ${DIRS}`),
      logged("R=$(mktemp -d -p /tmp r8-live-XXXXXX) && mkdir -p $R/home $R/xdg/config $R/xdg/data $R/xdg/cache $R/xdg/state $R/tmp $R/data $R/knowledge $R/internal"),
    ];
    expect(commands.map((c) => allowed(c))).toEqual(commands.map((command) => ({ command, action: "allow", reason: "" })));
  }, 300_000);

  test("is allowed with the home dir a link, the session cd'ing by either name", () => {
    const local = LINKED_HOME + ROOT.slice(HOME.length);
    const commands = [logged("R=/tmp/r8-live-CcJPf5"), logged("R=/tmp/r8-live-CcJPf5").replace(`cd ${ROOT}`, `cd ${local}`), logged(`${MKTEMP} && ${DIRS}`).replace(`cd ${ROOT}`, `cd ${local}`)];
    const out = [];
    for (const cwd of [ROOT, local]) for (const command of commands) out.push({ cwd, ...allowedIn(command, cwd) });
    expect(out).toEqual(out.map(({ cwd, command }) => ({ cwd, command, action: "allow", reason: "" })));
  }, 300_000);

  test("stays held with the log in the live data dir, the live DB or the install", () => {
    for (const target of [join(DATA, "collector.log"), join(DATA, "standup.db"), join(INSTALL, "collector.log")]) {
      for (const command of [logged("R=/tmp/sc-prev", {}, target), logged(`${MKTEMP} && ${DIRS}`, {}, target)]) {
        expect({ command, action: verdict(command).action }).toEqual({ command, action: "hold" });
      }
    }
  }, 300_000);

  test("stays held with DB_PATH or HOME at the real data", () => {
    for (const env of [{ DB_PATH: join(DATA, "standup.db") }, { HOME }] as Env[]) {
      for (const command of [logged("R=/tmp/sc-prev", env), logged(`${MKTEMP} && ${DIRS}`, env)]) {
        expect(held(command)).toEqual({ command, action: "hold", category: "floor-tamper", ownerReserved: true });
      }
    }
  }, 300_000);
});
