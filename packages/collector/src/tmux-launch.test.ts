import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { standupDataDir, workerTmuxSocket } from "@standup/shared/owner-token";
import { scratchDirFor } from "@standup/shared/scratch";
import { testTempDir } from "./test-support/temp-dirs.js";
import { buildLaunchArgv, buildInteractiveLaunchArgv, paneEnv, paneTmuxDir, preparePaneTmuxDir, workerTmux } from "./tmux-launch.js";

/** Pulls the temp prompt-file path out of the composed `sh -c` command. */
function promptFileOf(cmd: string): string | undefined {
  return /cat '([^']*)'/.exec(cmd)?.[1];
}

/** The TMPDIR/TMP/TEMP assignments paneEnv adds for `id`'s scratch dir. */
function scratchEnv(id: string): string[] {
  const dir = scratchDirFor(id);
  return [`TMPDIR=${dir}`, `TMP=${dir}`, `TEMP=${dir}`];
}

/** The workers' server prefix every launch argv starts with. */
const WORKERS = ["tmux", "-S", join(standupDataDir(), "tmux", "workers")];

describe("the workers' tmux server and the pane environment", () => {
  test("workerTmux names the workers' socket, in Standup's data dir, before any command", () => {
    expect(workerTmuxSocket()).toBe(join(standupDataDir(), "tmux", "workers"));
    expect(workerTmux("kill-session", "-t", "x")).toEqual([...WORKERS, "kill-session", "-t", "x"]);
  });

  test("a data dir too deep for a socket path fails the launch with the reason", () => {
    const saved = process.env.DB_PATH;
    process.env.DB_PATH = join("/tmp", "d".repeat(100), "standup.db");
    try {
      expect(() => buildInteractiveLaunchArgv("s", "/w", ["true"], "L-long")).toThrow("longer than a socket path");
    } finally {
      process.env.DB_PATH = saved;
    }
  });

  test("building a launch argv makes the workers' socket dir, owner-only", () => {
    buildInteractiveLaunchArgv("s", "/w", ["true"], "L-socketdir");
    expect(lstatSync(join(standupDataDir(), "tmux")).mode & 0o777).toBe(0o700);
  });

  test("paneEnv drops $TMUX and $TMUX_PANE and points TMUX_TMPDIR at the launch's own dir", () => {
    expect(paneEnv("/tmp/standup-tmux-abc")).toEqual(["env", "-u", "TMUX", "-u", "TMUX_PANE", "TMUX_TMPDIR=/tmp/standup-tmux-abc"]);
  });

  test("paneEnv with a scratch dir points TMPDIR, TMP and TEMP at it", () => {
    expect(paneEnv("/tmp/standup-tmux-abc", "/c/scratch/L1")).toEqual([
      "env", "-u", "TMUX", "-u", "TMUX_PANE", "TMUX_TMPDIR=/tmp/standup-tmux-abc",
      "TMPDIR=/c/scratch/L1", "TMP=/c/scratch/L1", "TEMP=/c/scratch/L1",
    ]);
  });

  test("a launch argv makes the scratch dir it names, the launch's own unless another is given", () => {
    const own = buildInteractiveLaunchArgv("s", "/w", ["true"], "L-scratch-own");
    expect(own).toContain(`TMPDIR=${scratchDirFor("L-scratch-own")}`);
    expect(statSync(scratchDirFor("L-scratch-own")).mode & 0o777).toBe(0o700);
    const reused = buildInteractiveLaunchArgv("s", "/w", ["true"], "L-scratch-new", {}, "L-scratch-orig");
    expect(reused).toContain(`TMP=${scratchDirFor("L-scratch-orig")}`);
    expect(reused).toContain(`TMUX_TMPDIR=${paneTmuxDir("L-scratch-new")}`);
    expect(existsSync(scratchDirFor("L-scratch-orig"))).toBe(true);
    const codex = buildLaunchArgv("s", "/w", ["codex"], "p", "L-scratch-codex", { scratchId: "L-scratch-orig2" });
    expect(codex).toContain(`TEMP=${scratchDirFor("L-scratch-orig2")}`);
    const file = promptFileOf(codex[codex.length - 1]!);
    if (file && existsSync(file)) unlinkSync(file);
    expect(() => buildInteractiveLaunchArgv("s", "/w", ["true"], "L-x", {}, "../escape")).toThrow("not a usable launch id");
  });

  test("paneTmuxDir is per user and launch, under the temp dir, and short enough for a socket", () => {
    const uid = process.getuid?.() ?? 0;
    // A temp dir short enough for a socket below it: a launched worker's own TMPDIR is too long (the next test).
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = testTempDir("standup-tmux-test-", "/tmp");
    try {
      const dir = paneTmuxDir("abcdef00-0000-4000-8000-0000000000b1");
      expect(dir).toBe(join(process.env.TMPDIR, `standup-tmux-${uid}-abcdef000000`));
      expect(paneTmuxDir("other-launch")).not.toBe(dir);
      expect(join(dir, `tmux-${uid}`, "standup-workers").length).toBeLessThanOrEqual(103);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });

  test("paneTmuxDir falls back to /tmp when the temp dir is too long for a socket under it", () => {
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = `/tmp/${"x".repeat(80)}`;
    try {
      expect(paneTmuxDir("L1").startsWith("/tmp/standup-tmux-")).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });

  test("preparePaneTmuxDir makes a 0700 dir, accepts its own, and refuses a symlink", () => {
    const id = `t${process.pid}${Date.now()}`;
    const dir = paneTmuxDir(id);
    try {
      expect(preparePaneTmuxDir(id)).toBe(dir);
      expect(lstatSync(dir).mode & 0o777).toBe(0o700);
      expect(preparePaneTmuxDir(id)).toBe(dir);
      rmSync(dir, { recursive: true });
      symlinkSync(tmpdir(), dir);
      expect(() => preparePaneTmuxDir(id)).toThrow("not a private directory");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildLaunchArgv", () => {
  test("default (no opts) matches the Claude launch shape — no stdin redirect", () => {
    const argv = buildLaunchArgv(
      "standup-sess",
      "/tmp/wt",
      ["claude", "--model", "opus"],
      "do the thing",
      "launch-1"
    );
    expect(argv.slice(0, 20)).toEqual([
      ...WORKERS,
      "new-session",
      "-d",
      "-s",
      "standup-sess",
      "-c",
      "/tmp/wt",
      "env",
      "-u",
      "TMUX",
      "-u",
      "TMUX_PANE",
      `TMUX_TMPDIR=${paneTmuxDir("launch-1")}`,
      ...scratchEnv("launch-1"),
      "sh",
      "-c",
    ]);
    const cmd = argv[20];
    expect(argv).toHaveLength(21);
    expect(cmd).toContain("exec 'claude' '--model' 'opus'");
    expect(cmd.trimEnd().endsWith('"$P"')).toBe(true);
    expect(cmd).not.toContain("/dev/null");

    const file = promptFileOf(cmd);
    try {
      expect(readFileSync(file!, "utf8")).toBe("do the thing");
    } finally {
      if (file && existsSync(file)) unlinkSync(file);
    }
  });

  test("closeStdin appends a /dev/null redirect for a headless harness", () => {
    const argv = buildLaunchArgv("s", "/w", ["codex", "exec"], "p", "launch-2", {
      closeStdin: true,
    });
    const cmd = argv[argv.length - 1]!;
    expect(cmd.trimEnd().endsWith('"$P" </dev/null')).toBe(true);
    const file = promptFileOf(cmd);
    if (file && existsSync(file)) unlinkSync(file);
  });

  test("logFile tees stdout to a sidecar and drops the exec form (pipeline)", () => {
    const argv = buildLaunchArgv("s", "/w", ["codex", "exec", "--json"], "p", "launch-tee", {
      closeStdin: true,
      logFile: "/tmp/codex-events.jsonl",
    });
    const cmd = argv[argv.length - 1]!;
    // stdin closed, stdout tee'd to the sidecar; a pipeline can't be exec'd.
    expect(cmd).not.toContain("exec 'codex'");
    expect(cmd.trimEnd().endsWith(`"$P" </dev/null | tee '/tmp/codex-events.jsonl'`)).toBe(true);
    const file = promptFileOf(cmd);
    if (file && existsSync(file)) unlinkSync(file);
  });

  test("buildRun replaces the default run with a caller-supplied command (multi-turn harness)", () => {
    const argv = buildLaunchArgv("s", "/w", [], "the prompt", "launch-run", {
      // A multi-turn harness composes its own loop; the temp-file prompt is still
      // read into $P and handed to the builder as the prompt reference.
      buildRun: (promptRef) => `codex_loop ${promptRef}`,
    });
    const cmd = argv[argv.length - 1]!;
    // The prompt still rides the temp file; the builder's command runs after it.
    expect(cmd).toContain("codex_loop \"$P\"");
    // The default exec/tee forms are not emitted when buildRun is set.
    expect(cmd).not.toContain("exec ");
    expect(cmd).not.toContain("| tee");
    const file = promptFileOf(cmd);
    try {
      expect(readFileSync(file!, "utf8")).toBe("the prompt");
    } finally {
      if (file && existsSync(file)) unlinkSync(file);
    }
  });

  test("interactive spawn runs the CLI directly with NO prompt and no sh -c wrapper", () => {
    const argv = buildInteractiveLaunchArgv(
      "standup-sess",
      "/tmp/wt",
      ["claude", "--model", "opus", "--permission-mode", "auto"],
      "launch-i",
      { STANDUP_WORKER_TOKEN_FILE: "/t/tok" }
    );
    // The workers' server new-session header, the session env, the pane env,
    // then the CLI argv spliced straight in — no `sh -c`, no temp-file prompt,
    // and no trailing positional prompt (which a `claude` wrapper script can drop).
    // The opening prompt is delivered via send-keys.
    expect(argv).toEqual([
      ...WORKERS,
      "new-session",
      "-d",
      "-s",
      "standup-sess",
      "-c",
      "/tmp/wt",
      "-e",
      "STANDUP_WORKER_TOKEN_FILE=/t/tok",
      "env",
      "-u",
      "TMUX",
      "-u",
      "TMUX_PANE",
      `TMUX_TMPDIR=${paneTmuxDir("launch-i")}`,
      ...scratchEnv("launch-i"),
      "claude",
      "--model",
      "opus",
      "--permission-mode",
      "auto",
    ]);
    expect(argv).not.toContain("sh");
    expect(argv.join(" ")).not.toContain("$P");
  });

  test("delivers a large prompt via the temp file, not the tmux command line", () => {
    const big = "x".repeat(50_000);
    const argv = buildLaunchArgv("s", "/w", ["codex", "exec"], big, "launch-3");
    const cmd = argv[argv.length - 1]!;
    // The tmux command stays tiny regardless of prompt size.
    expect(cmd.length).toBeLessThan(500);
    const file = promptFileOf(cmd);
    try {
      expect(readFileSync(file!, "utf8")).toBe(big);
    } finally {
      if (file && existsSync(file)) unlinkSync(file);
    }
  });
});
