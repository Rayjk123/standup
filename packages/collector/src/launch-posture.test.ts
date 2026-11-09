import { expect, test, describe } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import type { Project } from "@standup/shared";
import { WORKER_TOKEN_FILE_ENV } from "@standup/shared";
import { createStore, getLaunchHookAuth, getLaunchReviewTokenHash, getLaunchWorkerTokenHash, upsertProject } from "@standup/store";
import type { Store } from "@standup/store";
import {
  adoptSession,
  buildAdoptArgv,
  buildClaudeLaunchArgv,
  launchArgsPermissionModes,
  buildSpawnArgv,
  withStandupReadTools,
  launchArgsSetPermissionMode,
  launchArgsPermissionMode,
  launchArgsBypass,
  launchArgsSetSettings,
  launchArgsPermissionConflict,
  resolveBypassPermissions,
  redactedCommandLine,
  resolveClaudePermissionPosture,
  LaunchPermissionError,
  ALWAYS_ALLOWED_STANDUP_TOOLS,
  type ClaudeLaunchPermissions,
  type SpawnArgvSpec,
} from "./launcher.js";
import { CodexHarnessAdapter } from "./harness/codex.js";
import { buildInteractiveLaunchArgv } from "./tmux-launch.js";
import { reviewTokenEnv } from "./review/token-file.js";
import { HOOK_TOKEN_ENV, decodeFloorConfig, workerTokenHash, type FloorConfig } from "./floor/gate.js";
import { buildLaunchFloorConfig } from "./floor/launch.js";

/** The launch row's hook token hash, or null. */
function hookTokenHashOf(store: Store, launchId: string): string | null {
  const row = store.db.query("SELECT hook_token_hash FROM launches WHERE id = ?").get(launchId) as { hook_token_hash: string | null } | null;
  return row?.hook_token_hash ?? null;
}

/**
 * Launch posture: a console-launched Claude session must run UNATTENDED rather
 * than starting in manual mode and blocking on the first permission prompt (a
 * read-only KB search shouldn't stop a run for 20 minutes). So Claude launches
 * default to `--permission-mode bypassPermissions` with the safety-floor hook
 * installed through `--settings`, fall back to `--permission-mode auto` when the
 * project or launch opts out or the floor can't be installed, and always
 * pre-allow the read-only standup KB tools — while a project's explicit
 * `--permission-mode` still wins and the write/action tools stay gated. Codex
 * already runs autonomously (approval_policy=never); that path is unchanged.
 */

const HOOK = "/opt/standup/floor/hook.ts";
const BUN = "/usr/local/bin/bun";

const FLOOR: FloorConfig = buildLaunchFloorConfig(
  { launchId: "L-floor", root: "/tmp/no-such-standup-worktree/proj/slug", projectBranch: "feature-base" },
  { DB_PATH: "/data/standup/standup.db", STANDUP_FLOOR_WAIT_S: "90" }
);

/** Permissions for a launch whose floor can be installed. */
function withFloor(bypassPermissions: boolean, extra: Partial<ClaudeLaunchPermissions> = {}): ClaudeLaunchPermissions {
  return { bypassPermissions, floor: FLOOR, bunPath: BUN, hookPath: HOOK, ...extra };
}

/** The values of every `--settings` flag in the argv. */
function settingsValues(argv: string[]): string[] {
  return argv.flatMap((t, i) => (t === "--settings" ? [argv[i + 1] ?? ""] : []));
}

/** The floor hook entry of an injected `--settings` JSON. */
function floorHook(settings: string): { matcher: string; command: string; timeout: number } {
  const parsed = JSON.parse(settings) as {
    hooks: { PreToolUse: { matcher: string; hooks: { type: string; command: string; timeout: number }[] }[] };
  };
  const entry = parsed.hooks.PreToolUse[0];
  expect(entry.hooks[0].type).toBe("command");
  return { matcher: entry.matcher, command: entry.hooks[0].command, timeout: entry.hooks[0].timeout };
}

/** Decodes the FloorConfig embedded (base64url, single-quoted) in the hook command. */
function embeddedConfig(command: string): FloorConfig {
  const m = command.match(/'([A-Za-z0-9_-]{20,})'; else/);
  expect(m).not.toBeNull();
  return decodeFloorConfig(m![1]);
}

/** The comma-joined value of the argv's `--allowedTools` flag, split back out. */
function allowedTools(argv: string[]): string[] {
  const i = argv.indexOf("--allowedTools");
  if (i === -1) return [];
  return (argv[i + 1] ?? "").split(",").filter(Boolean);
}

/** The token immediately following `--permission-mode`, or undefined. */
function permissionMode(argv: string[]): string | undefined {
  const i = argv.indexOf("--permission-mode");
  return i === -1 ? undefined : argv[i + 1];
}

describe("buildClaudeLaunchArgv — default posture", () => {
  test("a default launch is --permission-mode bypassPermissions with the floor hook in --settings", () => {
    const argv = buildClaudeLaunchArgv(undefined, undefined, undefined, withFloor(true));

    expect(permissionMode(argv)).toBe("bypassPermissions");
    expect(argv.filter((t) => t === "--permission-mode")).toHaveLength(1);

    const settings = settingsValues(argv);
    expect(settings).toHaveLength(1);
    const hook = floorHook(settings[0]);
    expect(hook.matcher).toBe("*");
    expect(hook.command).toContain(HOOK);
    expect(hook.command).toContain(BUN);
    // Claude Code must not time the hook out before the hook's own wait ends.
    expect(hook.timeout).toBeGreaterThan(FLOOR.waitSeconds);

    const config = embeddedConfig(hook.command);
    expect(config.launchId).toBe("L-floor");
    expect(config.root).toBe("/tmp/no-such-standup-worktree/proj/slug");
    expect(config.sharedBranches).toContain("main");
    expect(config.sharedBranches).toContain("mainline");
    expect(config.sharedBranches).toContain("feature-base");
    expect(config.waitSeconds).toBe(90);
    expect(config.standupDataDir).toBe("/data/standup");

    // The KB reads stay pre-allowed under bypass too.
    expect(allowedTools(argv)).toEqual([...ALWAYS_ALLOWED_STANDUP_TOOLS]);
  });

  test("the flag order is model/effort, mode, settings, then the project's launchArgs", () => {
    const argv = buildClaudeLaunchArgv("opus", "high", "--add-dir /tmp/x", withFloor(true));
    expect(argv.slice(0, 7)).toEqual([
      "claude",
      "--model",
      "opus",
      "--effort",
      "high",
      "--permission-mode",
      "bypassPermissions",
    ]);
    expect(argv[7]).toBe("--settings");
    expect(argv.slice(9)).toEqual(["--add-dir", "/tmp/x", "--allowedTools", ALWAYS_ALLOWED_STANDUP_TOOLS.join(",")]);
  });

  test("a project that opted out runs --permission-mode auto, still under the floor", () => {
    const argv = buildClaudeLaunchArgv(undefined, undefined, undefined, withFloor(false));
    expect(permissionMode(argv)).toBe("auto");
    expect(floorHook(settingsValues(argv)[0]!).command).toContain(HOOK);
    expect(argv).not.toContain("bypassPermissions");
  });

  test("without permissions (no floor config) a launch never bypasses", () => {
    const argv = buildClaudeLaunchArgv(undefined, undefined, undefined);

    // AUTO so the session isn't manual-mode and doesn't stall on the first
    // permission prompt, but no bypass without the floor.
    expect(permissionMode(argv)).toBe("auto");
    expect(argv).not.toContain("--settings");

    // Every read-only standup KB tool is always pre-allowed.
    const allowed = allowedTools(argv);
    expect(allowed).toContain("mcp__standup__search_knowledge");
    expect(allowed).toContain("mcp__standup__get_knowledge_doc");
    expect(allowed).toContain("mcp__standup__graph_neighbors");
    expect(allowed).toContain("mcp__standup__knowledge_for_file");
    expect(allowed).toEqual([...ALWAYS_ALLOWED_STANDUP_TOOLS]);
  });

  test("the write/action tools are NOT in the always-allowed set — they stay gated", () => {
    const allowed = allowedTools(buildClaudeLaunchArgv(undefined, undefined, undefined));
    expect(allowed).not.toContain("mcp__standup__propose_knowledge");
    expect(allowed).not.toContain("mcp__standup__propose_standup_improvement");
    // And the constant itself only carries reads.
    expect(ALWAYS_ALLOWED_STANDUP_TOOLS).not.toContain("mcp__standup__propose_knowledge" as never);
    expect(ALWAYS_ALLOWED_STANDUP_TOOLS).not.toContain(
      "mcp__standup__propose_standup_improvement" as never
    );
  });
});

describe("buildClaudeLaunchArgv — project override of permission mode", () => {
  test("a project that pins --permission-mode plan is NOT overridden by the auto default", () => {
    const argv = buildClaudeLaunchArgv(undefined, undefined, "--permission-mode plan");

    // The project's explicit mode wins: `plan`, not `auto`, and no second
    // --permission-mode flag is injected.
    expect(permissionMode(argv)).toBe("plan");
    expect(argv.filter((t) => t === "--permission-mode")).toHaveLength(1);
    expect(argv).not.toContain("auto");

    // The KB reads are still always pre-allowed even under a project's own mode.
    expect(allowedTools(argv)).toEqual([...ALWAYS_ALLOWED_STANDUP_TOOLS]);
  });

  test("a pinned --permission-mode plan holds under a bypass request, under the floor", () => {
    const argv = buildClaudeLaunchArgv(undefined, undefined, "--permission-mode plan", withFloor(true));
    expect(permissionMode(argv)).toBe("plan");
    expect(argv.filter((t) => t === "--permission-mode")).toHaveLength(1);
    expect(settingsValues(argv)).toHaveLength(1);
  });

  test("a pinned --permission-mode auto carries the floor, so a worker's outward step is held", () => {
    for (const mode of ["auto", "acceptEdits", "default"]) {
      const posture = resolveClaudePermissionPosture(`--permission-mode ${mode}`, withFloor(true));
      expect(posture).toEqual({ floor: true, note: `[info] permissions: ${mode} (pinned by project launchArgs); safety floor on` });
      const argv = buildClaudeLaunchArgv(undefined, undefined, `--permission-mode ${mode}`, withFloor(true));
      expect(permissionMode(argv)).toBe(mode);
      expect(floorHook(settingsValues(argv)[0]!).matcher).toBe("*");
    }
  });

  test("a pinned mode goes without the floor only when its hook can't run, and the note warns", () => {
    const blocked = resolveClaudePermissionPosture("--permission-mode auto", withFloor(true, { floorHookUnavailable: "disableAllHooks" }));
    expect(blocked.floor).toBe(false);
    expect(blocked.note).toBe("[warn] permissions: auto (pinned by project launchArgs); no safety floor (disableAllHooks)");
    const own = resolveClaudePermissionPosture("--permission-mode auto --settings /tmp/s.json", withFloor(true));
    expect(own.floor).toBe(false);
    expect(own.note).toContain("pass their own --settings");
    expect(resolveClaudePermissionPosture("--permission-mode auto", { bypassPermissions: true }).floor).toBe(false);
  });

  test("a bypass blocked only by its confirmation dialog falls back to auto under the floor", () => {
    const posture = resolveClaudePermissionPosture(
      undefined,
      withFloor(true, { floorUnavailable: "bypass mode would open on Claude Code's confirmation dialog", floorHookUnavailable: undefined })
    );
    expect(posture.injectedMode).toBe("auto");
    expect(posture.floor).toBe(true);
    expect(posture.note).toContain("not bypassing; safety floor on");
  });

  test("launchArgsSetPermissionMode detects an explicit project mode", () => {
    expect(launchArgsSetPermissionMode("--permission-mode acceptEdits")).toBe(true);
    expect(launchArgsSetPermissionMode("--permission-mode=plan")).toBe(true);
    expect(launchArgsSetPermissionMode("--add-dir /tmp/x")).toBe(false);
    expect(launchArgsSetPermissionMode(undefined)).toBe(false);
    expect(launchArgsPermissionMode("--permission-mode=plan")).toBe("plan");
    expect(launchArgsPermissionMode("--permission-mode bypassPermissions")).toBe("bypassPermissions");
  });
});

describe("buildClaudeLaunchArgv — launchArgs that bypass on their own carry the floor", () => {
  test("a pinned --permission-mode bypassPermissions keeps its flag and gets the floor, even when the project opted out", () => {
    for (const bypass of [true, false]) {
      const argv = buildClaudeLaunchArgv(undefined, undefined, "--permission-mode bypassPermissions", withFloor(bypass));
      expect(permissionMode(argv)).toBe("bypassPermissions");
      expect(argv.filter((t) => t === "--permission-mode")).toHaveLength(1);
      expect(settingsValues(argv)).toHaveLength(1);
      expect(floorHook(settingsValues(argv)[0]).command).toContain(HOOK);
    }
  });

  test("--dangerously-skip-permissions gets the floor and no injected mode", () => {
    const argv = buildClaudeLaunchArgv(undefined, undefined, "--dangerously-skip-permissions", withFloor(false));
    expect(argv).not.toContain("--permission-mode");
    expect(argv).toContain("--dangerously-skip-permissions");
    expect(settingsValues(argv)).toHaveLength(1);
  });

  test("--allow-dangerously-skip-permissions gets the floor beside the requested mode", () => {
    const on = buildClaudeLaunchArgv(undefined, undefined, "--allow-dangerously-skip-permissions", withFloor(true));
    expect(permissionMode(on)).toBe("bypassPermissions");
    expect(settingsValues(on)).toHaveLength(1);
    const off = buildClaudeLaunchArgv(undefined, undefined, "--allow-dangerously-skip-permissions", withFloor(false));
    expect(permissionMode(off)).toBe("auto");
    expect(settingsValues(off)).toHaveLength(1);
  });

  test("launchArgsBypass / launchArgsSetSettings detect the flags", () => {
    expect(launchArgsBypass("--permission-mode bypassPermissions")).toBe(true);
    expect(launchArgsBypass("--permission-mode=bypassPermissions")).toBe(true);
    expect(launchArgsBypass("--dangerously-skip-permissions")).toBe(true);
    expect(launchArgsBypass("--allow-dangerously-skip-permissions")).toBe(true);
    expect(launchArgsBypass("--permission-mode plan")).toBe(false);
    expect(launchArgsBypass(undefined)).toBe(false);
    expect(launchArgsSetSettings("--settings /tmp/s.json")).toBe(true);
    expect(launchArgsSetSettings("--settings={}")).toBe(true);
    expect(launchArgsSetSettings("--setting-sources user")).toBe(false);
  });
});

describe("buildClaudeLaunchArgv — fail closed when the floor can't be installed", () => {
  test("launchArgs with their own --settings fall back to auto; only the project's --settings survives", () => {
    const argv = buildClaudeLaunchArgv(undefined, undefined, "--settings /tmp/mine.json", withFloor(true));
    expect(permissionMode(argv)).toBe("auto");
    expect(settingsValues(argv)).toEqual(["/tmp/mine.json"]);
    expect(argv).not.toContain("bypassPermissions");
  });

  test("launchArgs that pin bypass AND pass --settings are refused", () => {
    expect(() =>
      buildClaudeLaunchArgv(undefined, undefined, "--dangerously-skip-permissions --settings /tmp/mine.json", withFloor(true))
    ).toThrow(LaunchPermissionError);
    expect(launchArgsPermissionConflict("--permission-mode bypassPermissions --settings x")).toContain("Refusing to launch");
    expect(launchArgsPermissionConflict("--settings x")).toBeUndefined();
    expect(launchArgsPermissionConflict("--dangerously-skip-permissions")).toBeUndefined();
  });

  test("a floor that can't run (e.g. disableAllHooks) falls back to auto", () => {
    const argv = buildClaudeLaunchArgv(
      undefined,
      undefined,
      undefined,
      withFloor(true, { floorUnavailable: "/home/u/.claude/settings.json sets disableAllHooks: true" })
    );
    expect(permissionMode(argv)).toBe("auto");
    expect(argv).not.toContain("--settings");
  });

  test("a launchArgs bypass is refused when the floor can't run or has no config", () => {
    expect(() =>
      buildClaudeLaunchArgv(undefined, undefined, "--dangerously-skip-permissions", withFloor(true, { floorUnavailable: "hook missing" }))
    ).toThrow(LaunchPermissionError);
    expect(() => buildClaudeLaunchArgv(undefined, undefined, "--permission-mode bypassPermissions")).toThrow(
      LaunchPermissionError
    );
  });
});

describe("resolveBypassPermissions / posture notes", () => {
  const project = { id: "p", name: "p", repos: [], branch: "main" } as Project;

  test("the per-launch override wins both ways; else the project; else on", () => {
    expect(resolveBypassPermissions(project)).toBe(true);
    expect(resolveBypassPermissions({ ...project, bypassPermissions: false })).toBe(false);
    expect(resolveBypassPermissions({ ...project, bypassPermissions: false }, true)).toBe(true);
    expect(resolveBypassPermissions({ ...project, bypassPermissions: true }, false)).toBe(false);
    expect(resolveBypassPermissions(project, false)).toBe(false);
  });

  test("the launch-log note names the posture and why", () => {
    expect(resolveClaudePermissionPosture(undefined, withFloor(true)).note).toContain(
      "permissions: bypassed (safety floor on)"
    );
    expect(resolveClaudePermissionPosture(undefined, withFloor(false, { source: "project" })).note).toContain(
      "permissions: auto (project opted out)"
    );
    expect(resolveClaudePermissionPosture(undefined, withFloor(false, { source: "launch" })).note).toContain(
      "permissions: auto (this launch opted out)"
    );
    const blocked = resolveClaudePermissionPosture(undefined, withFloor(true, { floorUnavailable: "hook missing" }));
    expect(blocked.note).toContain("[warn] permissions: auto");
    expect(blocked.note).toContain("hook missing");
  });
});

describe("withStandupReadTools — merging into a project's own --allowedTools", () => {
  test("with no project allow-list, one is added carrying just the reads", () => {
    expect(withStandupReadTools([])).toEqual([
      "--allowedTools",
      ALWAYS_ALLOWED_STANDUP_TOOLS.join(","),
    ]);
  });

  test("the reads are merged into a project's existing --allowedTools, preserving its entries", () => {
    const out = withStandupReadTools(["--allowedTools", "Read,Grep"]);
    const allowed = allowedTools(out);
    // Exactly one --allowedTools flag, project entries first, reads appended.
    expect(out.filter((t) => t === "--allowedTools")).toHaveLength(1);
    expect(allowed).toEqual([
      "Read",
      "Grep",
      "mcp__standup__search_knowledge",
      "mcp__standup__get_knowledge_doc",
      "mcp__standup__graph_neighbors",
      "mcp__standup__knowledge_for_file",
    ]);
  });

  test("a read already listed by the project is not duplicated", () => {
    const out = withStandupReadTools([
      "--allowedTools",
      "mcp__standup__search_knowledge,Read",
    ]);
    const allowed = allowedTools(out);
    expect(allowed.filter((t) => t === "mcp__standup__search_knowledge")).toHaveLength(1);
    expect(allowed).toContain("mcp__standup__get_knowledge_doc");
  });
});

describe("buildSpawnArgv — the claude path carries the posture into the tmux argv", () => {
  test("the --settings JSON is one argv element of the directly-exec'd tmux command", () => {
    const spec: SpawnArgvSpec = {
      tmuxSession: "sess",
      launchCwd: "/tmp/wt",
      workspaceRoot: "/tmp/wt",
      prompt: "do the task",
      launchId: "L1",
      isScratch: false,
      permissions: withFloor(true),
    };
    const argv = buildSpawnArgv("claude", spec);
    expect(argv).toEqual(
      buildInteractiveLaunchArgv("sess", "/tmp/wt", buildClaudeLaunchArgv(undefined, undefined, undefined, withFloor(true)), "L1")
    );
    const settings = settingsValues(argv);
    expect(settings).toHaveLength(1);
    expect(() => JSON.parse(settings[0])).not.toThrow();
  });

  test("the session's env carries only the review token file's path, never a token", () => {
    const spec: SpawnArgvSpec = {
      tmuxSession: "sess",
      launchCwd: "/tmp/wt",
      workspaceRoot: "/tmp/wt",
      prompt: "do the task",
      launchId: "L1",
      isScratch: false,
      permissions: withFloor(true),
      workerTokenFile: "/data/standup/worker-tokens/L1",
    };
    const argv = buildSpawnArgv("claude", spec);
    const at = argv.indexOf("-e");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(argv.indexOf("claude"));
    expect(argv[at + 1]).toBe(`${WORKER_TOKEN_FILE_ENV}=/data/standup/worker-tokens/L1`);
    expect(argv.filter((a) => a === "-e")).toHaveLength(1);
    expect(reviewTokenEnv(undefined)).toEqual({});
    expect(buildSpawnArgv("claude", { ...spec, workerTokenFile: undefined })).not.toContain("-e");
  });

  test("the session's env carries the hook token for the reporting hooks; claude's argv and the log line don't", () => {
    const hookToken = "a".repeat(64);
    const argv = buildSpawnArgv("claude", {
      tmuxSession: "sess",
      launchCwd: "/tmp/wt",
      workspaceRoot: "/tmp/wt",
      prompt: "do the task",
      launchId: "L1",
      isScratch: false,
      permissions: withFloor(true),
      hookToken,
    });
    const at = argv.indexOf(`${HOOK_TOKEN_ENV}=${hookToken}`);
    expect(at).toBeGreaterThan(0);
    expect(argv[at - 1]).toBe("-e");
    expect(at).toBeLessThan(argv.indexOf("claude"));
    expect(argv.slice(argv.indexOf("claude")).join("\0")).not.toContain(hookToken);
    expect(redactedCommandLine(argv)).not.toContain(hookToken);
    expect(redactedCommandLine(argv)).toContain(`${HOOK_TOKEN_ENV}=<redacted>`);
  });
});

describe("buildSpawnArgv — codex path keeps its posture", () => {
  const spec: SpawnArgvSpec = {
    tmuxSession: "sess",
    launchCwd: "/tmp/wt/src/pkg",
    workspaceRoot: "/tmp/wt",
    prompt: "do the task",
    launchId: "L1",
    launchArgs: "--permission-mode acceptEdits",
    isScratch: true,
    codexEventLog: "/tmp/ev.jsonl",
    // Bypass + floor are Claude-only: a Codex launch ignores them.
    permissions: withFloor(true),
  };

  test("codex runs approval_policy=never at the workspace root and takes no Claude permission-mode / allowedTools flags", () => {
    const argv = buildSpawnArgv("codex", spec);
    // Byte-for-byte the adapter output — the launch-posture defaults are
    // Claude-only and must not leak into the codex argv. cwd is the workspace
    // ROOT, not the launchSubdir.
    expect(argv).toEqual(
      new CodexHarnessAdapter({ skipGitRepoCheck: true }).buildLaunchCommand({
        cwd: "/tmp/wt",
        prompt: "do the task",
        tmuxSession: "sess",
        launchId: "L1",
        eventLogPath: "/tmp/ev.jsonl",
      })
    );
    const joined = argv.join(" ");
    // Codex auto-approves everything via its profile — nothing gates a KB read —
    // and runs unsandboxed so it can reach the network + write across the workspace.
    expect(joined).toContain("approval_policy=never");
    expect(joined).toContain("'-s' 'danger-full-access'");
    // The Claude-only posture flags never reach the codex argv.
    expect(joined).not.toContain("--permission-mode");
    expect(joined).not.toContain("--settings");
    expect(joined).not.toContain("bypassPermissions");
    expect(joined).not.toContain("--allowedTools");
    expect(joined).not.toContain("mcp__standup__");
  });
});

describe("launchArgs that pin more than one posture are refused", () => {
  const refusals = [
    "--permission-mode plan --permission-mode bypassPermissions",
    "--permission-mode=acceptEdits --permission-mode auto",
    "--permission-mode plan --permissionMode bypassPermissions",
    "--permission_mode=default --permission-mode=plan",
    "--dangerously-skip-permissions --permission-mode plan",
    "--allow-dangerously-skip-permissions --permission-mode=acceptEdits",
    "--permission-mode bypassPermissions --permission-mode bypassPermissions",
  ];

  test("every spelling of a repeated --permission-mode is counted", () => {
    expect(launchArgsPermissionModes("--permission-mode plan --permissionMode=auto --PERMISSION-MODE x")).toEqual(["plan", "auto", "x"]);
  });

  for (const launchArgs of refusals) {
    test(`refused: ${launchArgs}`, () => {
      expect(launchArgsPermissionConflict(launchArgs)).toContain("Refusing to launch");
      for (const bypass of [true, false]) {
        expect(() => resolveClaudePermissionPosture(launchArgs, withFloor(bypass))).toThrow(LaunchPermissionError);
        expect(() => buildClaudeLaunchArgv(undefined, undefined, launchArgs, withFloor(bypass))).toThrow(LaunchPermissionError);
      }
    });
  }

  test("a single mode, or a bypass flag beside bypassPermissions, still launches", () => {
    expect(launchArgsPermissionConflict("--permission-mode plan")).toBeUndefined();
    expect(launchArgsPermissionConflict("--dangerously-skip-permissions --permission-mode bypassPermissions")).toBeUndefined();
  });
});

describe("redactedCommandLine", () => {
  const json = '{"hooks":{"PreToolUse":[{"hooks":[{"command":"bun hook.ts secret-token"}]}]}}';

  test("replaces the --settings value in a direct argv, however it is spelled", () => {
    const direct = redactedCommandLine(["tmux", "new-session", "-d", "claude", "--permission-mode", "bypassPermissions", "--settings", json, "--add-dir", "/x"]);
    expect(direct).toBe("tmux new-session -d claude --permission-mode bypassPermissions --settings <safety-floor settings> --add-dir /x");
    expect(redactedCommandLine(["claude", `--settings=${json}`])).toBe("claude --settings=<safety-floor settings>");
  });

  test("replaces a single-quoted --settings value inside a sh -c string", () => {
    const line = redactedCommandLine(["tmux", "new-session", "sh", "-c", `exec claude --settings '${json.replace(/'/g, "'\\''")}' --model opus "$P"`]);
    expect(line).not.toContain("secret-token");
    expect(line).toContain("--settings <safety-floor settings> --model opus");
  });

  test("the real launch argv's floor config (worker token included) never reaches the log line", () => {
    const argv = buildInteractiveLaunchArgv("s", "/wt", buildClaudeLaunchArgv(undefined, undefined, undefined, withFloor(true)), "L1");
    const line = redactedCommandLine(argv);
    const encoded = argv.join(" ").match(/hook\.ts' '([A-Za-z0-9_-]+)'/)?.[1];
    expect(encoded).toBeDefined();
    expect(line).not.toContain(encoded!);
    expect(line).not.toContain("PreToolUse");
    expect(line).toContain("--settings <safety-floor settings>");
  });
});

describe("adopted sessions resume under the launch posture", () => {
  const ended = (cwd: string, projectId = "p") => ({ id: "11111111-2222-3333-4444-555555555555", cwd, title: "t", projectId, endedAt: new Date() });

  function adopt(project: Partial<Project>, floorUnavailable?: string) {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p", name: "P", branch: "main", repos: [], ...project });
    const cwd = mkdtempSync(join(tmpdir(), "adopt-posture-"));
    const spawned: string[][] = [];
    const result = adoptSession(store.db, ended(cwd), {
      dataDir: join(cwd, ".data"),
      tmuxAvailable: () => true,
      tmuxSessionExists: () => false,
      floorUnavailable: () => floorUnavailable,
      run: async (cmd) => {
        spawned.push(cmd);
        return { ok: true, output: "" };
      },
    });
    return { store, cwd, spawned, result };
  }

  test("buildAdoptArgv resumes the session id with the same flags a launch gets", () => {
    const permissions = withFloor(true);
    const launch = buildClaudeLaunchArgv("opus", undefined, "--add-dir /x", permissions);
    expect(buildAdoptArgv("sid", "opus", undefined, "--add-dir /x", permissions)).toEqual([
      "claude",
      "--resume",
      "sid",
      ...launch.slice(1),
    ]);
  });

  test("a default project resumes bypassed with the floor, and the launch row holds the worker token's hash", async () => {
    const { store, cwd, spawned, result } = adopt({});
    try {
      const { launch } = await result;
      expect(launch.status).toBe("running");
      const argv = spawned[0]!;
      const claude = argv.slice(argv.indexOf("claude"));
      expect(claude.slice(0, 3)).toEqual(["claude", "--resume", "11111111-2222-3333-4444-555555555555"]);
      expect(permissionMode(claude)).toBe("bypassPermissions");
      const config = embeddedConfig(floorHook(settingsValues(claude)[0]!).command);
      expect(config.launchId).toBe(launch.id);
      expect(getLaunchWorkerTokenHash(store.db, launch.id)).toBe(workerTokenHash(config.workerToken));
      // Its settings carry the reporting hooks, which present the hook token from the
      // session's env; the token is in the tmux -e env, never in claude's argv, and the
      // launch row holds only its hash, not yet proven.
      const hookToken = argv.find((t) => t.startsWith(`${HOOK_TOKEN_ENV}=`))?.slice(HOOK_TOKEN_ENV.length + 1);
      expect(hookToken).toMatch(/^[0-9a-f]{64}$/);
      expect(argv.indexOf(`${HOOK_TOKEN_ENV}=${hookToken}`)).toBeLessThan(argv.indexOf("claude"));
      expect(claude.join("\0")).not.toContain(hookToken!);
      expect(hookTokenHashOf(store, launch.id)).toBe(workerTokenHash(hookToken!));
      expect(getLaunchHookAuth(store.db, launch.id)).toBe(false);
      expect(redactedCommandLine(argv)).not.toContain(hookToken!);
      // The resumed session's env names its own review token file (0600 in a
      // 0700 dir); neither the floor's token nor the review token is in the argv.
      const tokenFile = join(cwd, ".data", "worker-tokens", launch.id);
      expect(argv.slice(0, argv.indexOf("claude"))).toContain(`${WORKER_TOKEN_FILE_ENV}=${tokenFile}`);
      expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
      expect(statSync(join(cwd, ".data", "worker-tokens")).mode & 0o777).toBe(0o700);
      const reviewToken = readFileSync(tokenFile, "utf8");
      expect(reviewToken).toMatch(/^[0-9a-f]{64}$/);
      expect(reviewToken).not.toBe(config.workerToken);
      expect(getLaunchReviewTokenHash(store.db, launch.id)).toBe(workerTokenHash(reviewToken));
      expect(argv.join("\0")).not.toContain(reviewToken);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("an opted-out project, or a floor that can't run, resumes --permission-mode auto — never a bare resume", async () => {
    for (const [project, unavailable, floored] of [
      [{ bypassPermissions: false }, undefined, true],
      [{ launchArgs: "--permission-mode auto" }, undefined, true],
      [{}, "disableAllHooks", false],
      [{ launchArgs: "--add-dir /x" }, "disableAllHooks", false],
    ] as const) {
      const { store, cwd, spawned, result } = adopt(project, unavailable);
      try {
        const { launch } = await result;
        const claude = spawned[0]!.slice(spawned[0]!.indexOf("claude"));
        expect(permissionMode(claude)).toBe("auto");
        expect(settingsValues(claude)).toHaveLength(floored ? 1 : 0);
        // No settings means no reporting hooks and no hook token: the session reports through the global hooks.
        expect(hookTokenHashOf(store, launch.id) !== null).toBe(floored);
        expect(spawned[0]!.some((t) => t.startsWith(`${HOOK_TOKEN_ENV}=`))).toBe(floored);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  });

  test("a session whose root contains the home dir resumes --permission-mode auto, and the log says why", async () => {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p", name: "P", branch: "main", repos: [] });
    const spawned: string[][] = [];
    const { launch, log } = await adoptSession(store.db, ended(homedir()), {
      tmuxAvailable: () => true,
      tmuxSessionExists: () => false,
      run: async (cmd) => {
        spawned.push(cmd);
        return { ok: true, output: "" };
      },
    });
    expect(launch.status).toBe("running");
    const claude = spawned[0]!.slice(spawned[0]!.indexOf("claude"));
    expect(permissionMode(claude)).toBe("auto");
    expect(settingsValues(claude)).toHaveLength(0);
    expect(log.join("\n")).toContain("contains the user's home directory");
    expect(log.join("\n")).toContain("not bypassing");
  });

  test("a project whose launchArgs pin conflicting modes can't be adopted", async () => {
    const { cwd, spawned, result } = adopt({ launchArgs: "--permission-mode plan --permission-mode auto" });
    try {
      await expect(result).rejects.toThrow(LaunchPermissionError);
      expect(spawned).toHaveLength(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
