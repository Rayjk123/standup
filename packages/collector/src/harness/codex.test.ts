import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildCodexArgv,
  buildCodexResumeFlags,
  buildCodexRunLoop,
  CODEX_CONTINUE_INSTRUCTION,
  CODEX_DONE_SENTINEL,
  CODEX_MAX_TURNS,
  CodexHarnessAdapter,
  DEFAULT_CODEX_PROFILE,
} from "./codex.js";
import type { HarnessLaunchSpec } from "./types.js";
import { scratchDirFor } from "@standup/shared/scratch";
import { paneTmuxDir, workerTmux } from "../tmux-launch.js";

describe("buildCodexArgv", () => {
  test("default profile is full-access, non-interactive, skips the git-repo check, with model and workspace root", () => {
    // --skip-git-repo-check is on by default: the -C dir (a multi-checkout workspace root)
    // is often not itself a git repo, and codex refuses to run outside a trusted
    // one without it.
    expect(buildCodexArgv({ cwd: "/tmp/wt", model: "gpt-5-codex" })).toEqual([
      "codex",
      "exec",
      "--json",
      "-C",
      "/tmp/wt",
      "-m",
      "gpt-5-codex",
      "-s",
      "danger-full-access",
      "-c",
      "approval_policy=never",
      "--skip-git-repo-check",
    ]);
  });

  test("omits -m when no model is given", () => {
    expect(buildCodexArgv({ cwd: "/w" })).not.toContain("-m");
  });

  test("emits -c model_reasoning_effort=<effort> when a reasoning effort is given", () => {
    const argv = buildCodexArgv({ cwd: "/w", model: "gpt-5-codex", reasoningEffort: "high" });
    // The effort rides the same -c override channel as approval, right after it.
    const i = argv.indexOf("model_reasoning_effort=high");
    expect(i).toBeGreaterThan(-1);
    expect(argv[i - 1]).toBe("-c");
    // The -m model passthrough is unchanged.
    expect(argv).toContain("-m");
    expect(argv).toContain("gpt-5-codex");
  });

  test("omits the reasoning-effort override when none is given (CLI default)", () => {
    const argv = buildCodexArgv({ cwd: "/w", model: "gpt-5-codex" });
    expect(argv.join(" ")).not.toContain("model_reasoning_effort");
    // Approval is still emitted — only the effort override is conditional.
    expect(argv).toContain("approval_policy=never");
  });

  test("emits the effort override even with no model, and never a bare effort flag", () => {
    const argv = buildCodexArgv({ cwd: "/w", reasoningEffort: "minimal" });
    expect(argv).not.toContain("-m");
    expect(argv).toContain("model_reasoning_effort=minimal");
    // The level rides -c, never a top-level flag exec would reject.
    expect(argv).not.toContain("--reasoning-effort");
    expect(argv).not.toContain("-r");
  });

  test("parameterizes sandbox, approval, skip-git-repo-check, and extra args", () => {
    expect(
      buildCodexArgv(
        { cwd: "/w", model: "m", extraArgs: ["--ignore-user-config"] },
        { sandbox: "read-only", approvalPolicy: "on-request", skipGitRepoCheck: true }
      )
    ).toEqual([
      "codex",
      "exec",
      "--json",
      "-C",
      "/w",
      "-m",
      "m",
      "-s",
      "read-only",
      "-c",
      "approval_policy=on-request",
      "--skip-git-repo-check",
      "--ignore-user-config",
    ]);
  });

  test("never emits a bare -a/--ask-for-approval (exec rejects it)", () => {
    const argv = buildCodexArgv({ cwd: "/w" }, { approvalPolicy: "never" });
    expect(argv).not.toContain("-a");
    expect(argv).not.toContain("--ask-for-approval");
    expect(argv).toContain("approval_policy=never");
  });

  test("exposes a full-access, non-interactive, git-check-skipping default profile", () => {
    // danger-full-access, NOT the codex `workspace-write` sandbox: Standup's own
    // worktree/provisioned workspace is the isolation boundary, and the internal
    // sandbox would block outbound network (AWS + the localhost standup MCP) and
    // scope writes to the -C dir, crippling autonomous build/deploy/KB.
    // skipGitRepoCheck defaults ON because the -C dir (a multi-checkout workspace root) is
    // often not a git repo, and codex won't run outside a trusted one without it.
    expect(DEFAULT_CODEX_PROFILE).toEqual({
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
    });
  });
});

describe("multi-turn constants", () => {
  test("the completion sentinel and turn cap are fixed constants", () => {
    expect(CODEX_DONE_SENTINEL).toBe("===STANDUP_CODEX_DONE===");
    expect(CODEX_MAX_TURNS).toBe(20);
  });

  test("the continue instruction names the sentinel the agent must print when done", () => {
    expect(CODEX_CONTINUE_INSTRUCTION).toContain(CODEX_DONE_SENTINEL);
    expect(CODEX_CONTINUE_INSTRUCTION.toLowerCase()).toContain("validate");
  });
});

describe("buildCodexResumeFlags", () => {
  test("resume takes NO exec-only -s/-C; --skip-git-repo-check is on by default; sandbox rides -c sandbox_mode alongside -c approval_policy", () => {
    // Default: --json + --skip-git-repo-check (default on), with sandbox/approval
    // as -c overrides — and crucially NO -s/-C (resume rejects them).
    expect(buildCodexResumeFlags()).toEqual([
      "--json",
      "--skip-git-repo-check",
      "-c",
      "approval_policy=never",
      "-c",
      "sandbox_mode=danger-full-access",
    ]);
    // Overriding skipGitRepoCheck off drops the flag and threads the chosen
    // sandbox through the -c override, still without -s/-C.
    expect(buildCodexResumeFlags({ skipGitRepoCheck: false, sandbox: "read-only" })).toEqual([
      "--json",
      "-c",
      "approval_policy=never",
      "-c",
      "sandbox_mode=read-only",
    ]);
    expect(buildCodexResumeFlags()).not.toContain("-s");
    expect(buildCodexResumeFlags()).not.toContain("-C");
  });
});

describe("buildCodexRunLoop", () => {
  const execArgv = [
    "codex",
    "exec",
    "--json",
    "-C",
    "/tmp/root",
    "-s",
    "danger-full-access",
    "-c",
    "approval_policy=never",
  ];
  const resumeFlags = buildCodexResumeFlags();

  test("runs the first turn (exec, with -s/-C), then resumes the captured thread until the sentinel or the cap", () => {
    const loop = buildCodexRunLoop('"$P"', execArgv, resumeFlags, "/tmp/ev.jsonl");
    const lines = loop.split("\n");

    // First turn: `codex exec --json … -s … -C …` with the opening prompt (exec
    // accepts the sandbox/-C flags), tee'd to the log.
    const execLine = lines.find((l) => l.includes(`"$P" </dev/null`))!;
    expect(execLine).toBe(
      `'codex' 'exec' '--json' '-C' '/tmp/root' '-s' 'danger-full-access' '-c' 'approval_policy=never' "$P" </dev/null | tee -a '/tmp/ev.jsonl' "$TURN"`
    );
    // The thread id is captured from the thread.started event of turn 1.
    expect(loop).toContain('TID="$(');
    expect(loop).toContain('"thread_id"');
    // Resume loop: bounded by the turn cap; each resume takes the resume flag set.
    expect(loop).toContain(`while [ -n "$TID" ] && [ "$n" -lt ${CODEX_MAX_TURNS} ]`);
    expect(loop).toContain("n=$((n + 1))");

    // Resume line: `codex exec resume "$TID" --json` with the sandbox via
    // `-c sandbox_mode=…` — and crucially NO exec-only -s or -C (resume rejects
    // them: "unexpected argument '-s' found").
    const resumeLine = lines.find((l) => l.includes("'resume'"))!;
    expect(resumeLine).toContain(`'codex' 'exec' 'resume' "$TID" '--json'`);
    expect(resumeLine).toContain("'-c' 'approval_policy=never'");
    expect(resumeLine).toContain("'-c' 'sandbox_mode=danger-full-access'");
    expect(resumeLine).not.toContain("'-s'");
    expect(resumeLine).not.toContain("'-C'");

    // Completion is matched on the EXACT assistant-message text — the JSON
    // fragment "text":"<sentinel>" on an agent_message line — never the sentinel
    // appearing anywhere (which would fire on the prompt echo or a mid-run mention).
    expect(loop).toContain(
      `grep -F '"text":"${CODEX_DONE_SENTINEL}"' "$TURN" | grep -q agent_message`
    );
    // The continue instruction is delivered to each resume turn.
    expect(loop).toContain(CODEX_CONTINUE_INSTRUCTION.slice(0, 20));
    // The turn count is reported when the loop ends.
    expect(loop).toContain("codex ran");
  });

  /**
   * Runs the loop under `sh` with a fake `codex` on PATH that logs each call and
   * prints the first turn's events on its first call and `later` (default: the
   * same events) on every call after, and returns how many times codex ran.
   */
  function runLoopAgainst(first: unknown[], later: unknown[] = first): { calls: number; output: string } {
    const dir = mkdtempSync(join(tmpdir(), "codex-loop-"));
    try {
      const lines = (events: unknown[]) => `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
      writeFileSync(join(dir, "first.jsonl"), lines(first));
      writeFileSync(join(dir, "later.jsonl"), lines(later));
      writeFileSync(
        join(dir, "codex"),
        `#!/bin/sh\nif [ -f "${dir}/calls" ]; then t=later; else t=first; fi\n` +
          `echo call >> "${dir}/calls"\ncat "${dir}/$t.jsonl"\nexit 1\n`
      );
      chmodSync(join(dir, "codex"), 0o755);
      const loop = buildCodexRunLoop('"$P"', ["codex", "exec", "--json"], buildCodexResumeFlags(), join(dir, "ev.jsonl"));
      const run = Bun.spawnSync(["sh", "-c", loop], {
        env: { PATH: `${dir}:${process.env.PATH ?? "/usr/bin:/bin"}`, P: "do it" },
      });
      const calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n").length;
      return { calls, output: run.stdout.toString() };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const refusedTurn = [
    { type: "thread.started", thread_id: "t-1" },
    { type: "turn.started" },
    { type: "error", message: "Reconnecting... 1/5 (unexpected status 403 Forbidden: explicit deny)" },
    { type: "turn.failed", error: { message: "unexpected status 403 Forbidden: explicit deny" } },
  ];

  test("a first turn the provider refuses before any work is not resumed", () => {
    const { calls, output } = runLoopAgainst(refusedTurn);
    expect(calls).toBe(1);
    expect(output).toContain("[standup] codex refused the first turn before any work; not resuming");
  });

  test("a later turn that fails before any work is still resumed", () => {
    const { calls, output } = runLoopAgainst(
      [
        { type: "thread.started", thread_id: "t-1" },
        { type: "turn.started" },
        { type: "item.completed", item: { type: "agent_message", id: "a1", text: "working" } },
        { type: "turn.completed", usage: { input_tokens: 5, output_tokens: 1 } },
      ],
      refusedTurn.slice(1)
    );
    expect(calls).toBe(CODEX_MAX_TURNS);
    expect(output).not.toContain("not resuming");
  });

  test("a failed turn that completed work is still resumed", () => {
    const { calls } = runLoopAgainst([
      { type: "thread.started", thread_id: "t-1" },
      { type: "turn.started" },
      { type: "item.completed", item: { type: "agent_message", id: "a1", text: "working" } },
      { type: "turn.failed", error: { message: "stream disconnected" } },
    ]);
    expect(calls).toBe(CODEX_MAX_TURNS);
  });

  test("without a log file it still tees each turn to the per-turn scratch file", () => {
    const loop = buildCodexRunLoop('"$P"', execArgv, resumeFlags, undefined);
    expect(loop).toContain(`"$P" </dev/null | tee -a "$TURN"`);
    expect(loop).not.toContain("tee -a '");
  });
});

describe("CodexHarnessAdapter", () => {
  const spec: HarnessLaunchSpec = {
    cwd: "/tmp/wt-codex",
    prompt: "implement the feature\nwith a $VAR and 'quotes'",
    tmuxSession: "standup-codex-abc",
    launchId: "codex-test-launch",
    model: "gpt-5-codex",
    eventLogPath: "/tmp/ev-codex.jsonl",
  };

  test("id is 'codex'", () => {
    expect(new CodexHarnessAdapter().id).toBe("codex");
  });

  test("buildLaunchCommand wraps a multi-turn codex loop in a detached tmux session", () => {
    const argv = new CodexHarnessAdapter().buildLaunchCommand(spec);
    const scratch = scratchDirFor(spec.launchId);
    expect(argv.slice(0, 20)).toEqual([
      ...workerTmux(),
      "new-session",
      "-d",
      "-s",
      "standup-codex-abc",
      "-c",
      "/tmp/wt-codex",
      "env",
      "-u",
      "TMUX",
      "-u",
      "TMUX_PANE",
      `TMUX_TMPDIR=${paneTmuxDir(spec.launchId)}`,
      `TMPDIR=${scratch}`,
      `TMP=${scratch}`,
      `TEMP=${scratch}`,
      "sh",
      "-c",
    ]);

    const cmd = argv[20]!;
    // First turn: `codex exec --json` at the workspace root, full-access (exec
    // accepts -s/-C), stdin closed, tee'd to the sidecar.
    expect(cmd).toContain("'codex' 'exec' '--json' '-C' '/tmp/wt-codex'");
    expect(cmd).toContain("'-s' 'danger-full-access'");
    expect(cmd).toContain("approval_policy=never");
    expect(cmd).toContain(`"$P" </dev/null | tee -a '/tmp/ev-codex.jsonl' "$TURN"`);
    // Multi-turn: resumes the captured thread, bounded by the cap. The resume
    // turn carries NO exec-only -s/-C (resume rejects them) — sandbox rides
    // `-c sandbox_mode=…`.
    expect(cmd).toContain(`'codex' 'exec' 'resume' "$TID" '--json'`);
    expect(cmd).toContain("'-c' 'sandbox_mode=danger-full-access'");
    const resumeLine = cmd.split("\n").find((l) => l.includes("'resume'"))!;
    expect(resumeLine).not.toContain("'-s'");
    expect(resumeLine).not.toContain("'-C'");
    expect(cmd).toContain(`[ "$n" -lt ${CODEX_MAX_TURNS} ]`);
    // Completion matches the EXACT assistant-message text.
    expect(cmd).toContain(
      `grep -F '"text":"${CODEX_DONE_SENTINEL}"' "$TURN" | grep -q agent_message`
    );

    // The prompt was delivered byte-for-byte via the temp file the launcher wrote.
    const promptFile = /cat '([^']*)'/.exec(cmd)?.[1];
    expect(promptFile).toBeTruthy();
    try {
      expect(readFileSync(promptFile!, "utf8")).toBe(spec.prompt);
    } finally {
      if (promptFile && existsSync(promptFile)) unlinkSync(promptFile);
    }
  });

  test("createParser returns a working streaming parser", () => {
    const parser = new CodexHarnessAdapter().createParser();
    const events = parser.push(
      JSON.stringify({ type: "thread.started", thread_id: "t-1" }) + "\n"
    );
    expect(events).toEqual([{ kind: "session-started", sessionId: "t-1" }]);
  });

  test("a scratch (no-repo) profile adds --skip-git-repo-check to both turns", () => {
    const argv = new CodexHarnessAdapter({ skipGitRepoCheck: true }).buildLaunchCommand(spec);
    const cmd = argv[argv.length - 1]!;
    expect(cmd).toContain("--skip-git-repo-check");
    const promptFile = /cat '([^']*)'/.exec(cmd)?.[1];
    if (promptFile && existsSync(promptFile)) unlinkSync(promptFile);
  });
});
