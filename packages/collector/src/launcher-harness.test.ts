import { expect, test, describe, afterAll } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { SLOT_ENV_VARS } from "@standup/shared/topology";
import { createStore, upsertProject, getLaunch } from "@standup/store";
import type { HarnessId, Project } from "@standup/shared";
import {
  buildSpawnArgv,
  buildClaudeLaunchArgv,
  buildSubmitTextCmds,
  buildModalAnswerKeys,
  isModalSubmitReady,
  shouldBufferPaste,
  launchSession,
  OpeningPromptUndeliverableError,
  type SpawnArgvSpec,
} from "./launcher.js";
import { buildInteractiveLaunchArgv, workerTmux } from "./tmux-launch.js";
import { CodexHarnessAdapter } from "./harness/codex.js";

/**
 * Per-launch harness selection. Claude Code stays the default harness with its
 * behavior unchanged; a launch may opt into Codex without touching the project's
 * default. The launch routes through the harness-routing seam (buildSpawnArgv),
 * so these tests assert the resolved harness and the persisted launch row
 * WITHOUT spawning any real agent — the seam is stubbed to a no-op command.
 */

// buildSpawnArgv routes to a harness's argv builder — a pure decision, so it is
// tested directly with no store, no spawn.
describe("buildSpawnArgv routing", () => {
  // launchCwd is the launchSubdir cwd (a package under the workspace);
  // workspaceRoot is the worktree root. Claude runs at launchCwd, Codex at the
  // root — the two differ here so the routing can be told apart.
  const spec: SpawnArgvSpec = {
    tmuxSession: "sess",
    launchCwd: "/tmp/wt/src/pkg",
    workspaceRoot: "/tmp/wt",
    prompt: "do the task",
    launchId: "L1",
    model: "opus",
    effort: "high",
    launchArgs: "--permission-mode acceptEdits",
    isScratch: false,
  };

  test("claude launches INTERACTIVELY at the launchSubdir cwd (prompt NOT positional), with model/effort, the project's own permission-mode, and the always-allowed KB reads", () => {
    // A `claude` wrapper script can drop a positional prompt, so claude is spawned
    // interactively (buildInteractiveLaunchArgv) with the per-launch model/effort
    // flags, the project's extra launch args, and the always-allowed read-only
    // standup KB tools folded into --allowedTools — but NO prompt argument. The
    // opening prompt is typed in via send-keys after the pane is ready. This spec
    // pins --permission-mode acceptEdits, so the launch-posture default (auto) is
    // NOT injected — the project's explicit mode wins. Claude runs at launchCwd
    // (the subdir), NOT the workspace root.
    expect(buildSpawnArgv("claude", spec)).toEqual(
      buildInteractiveLaunchArgv("sess", "/tmp/wt/src/pkg", [
        "claude",
        "--model",
        "opus",
        "--effort",
        "high",
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        "mcp__standup__search_knowledge,mcp__standup__get_knowledge_doc,mcp__standup__graph_neighbors,mcp__standup__knowledge_for_file",
      ], "L1")
    );
    // The prompt is delivered out-of-band (send-keys), so it must NOT appear on
    // the spawn command line — that positional arg is exactly what a wrapper drops.
    const argv = buildSpawnArgv("claude", spec);
    expect(argv).not.toContain("do the task");
    // No `sh -c` temp-file prompt wrapper either — claude runs directly.
    expect(argv).not.toContain("sh");
    expect(argv.join(" ")).not.toContain('"$P"');
    // The CLI argv is exactly buildClaudeLaunchArgv's, spliced in after the
    // workers' server new-session header and the pane env — nothing appended after it.
    expect(argv.slice(0, 3)).toEqual(workerTmux());
    expect(argv.slice(argv.indexOf("claude"))).toEqual(buildClaudeLaunchArgv("opus", "high", "--permission-mode acceptEdits"));
  });

  test("codex goes through the Codex adapter at the WORKSPACE ROOT with its own model + effort, teeing its --json event log", () => {
    const codexSpec: SpawnArgvSpec = {
      ...spec,
      isScratch: true,
      codexEventLog: "/tmp/ev.jsonl",
      codexModel: "gpt-5-codex",
      codexEffort: "high",
    };
    const argv = buildSpawnArgv("codex", codexSpec);
    // The project's launchArgs are Claude flags and are NOT forwarded to codex —
    // `codex exec` (clap-based) aborts on an unknown flag, so passing them would
    // silently break the launch. The adapter is called with codex's OWN model +
    // reasoning effort (never the Claude model/effort or the project's launchArgs),
    // and its cwd is the workspace ROOT, not the launchSubdir.
    expect(argv).toEqual(
      new CodexHarnessAdapter({ skipGitRepoCheck: true }).buildLaunchCommand({
        cwd: "/tmp/wt",
        prompt: "do the task",
        tmuxSession: "sess",
        launchId: "L1",
        model: "gpt-5-codex",
        reasoningEffort: "high",
        eventLogPath: "/tmp/ev.jsonl",
      })
    );
    const joined = argv.join(" ");
    // `codex exec --json -C <root>` (tokens shell-quoted individually), teeing the
    // event stream to the sidecar (the multi-turn run loop appends: `tee -a`).
    expect(joined).toContain("'codex' 'exec' '--json' '-C' '/tmp/wt'");
    // The tmux pane cwd (-c) is the workspace root too.
    expect(joined).toContain("-c /tmp/wt env -u TMUX -u TMUX_PANE TMUX_TMPDIR=");
    expect(joined).toContain(" sh -c ");
    expect(joined).toContain("tee -a '/tmp/ev.jsonl'");
    // The workspace ROOT, never the launchSubdir package, is what codex gets.
    expect(joined).not.toContain("src/pkg");
    // The codex model rides -m and the effort rides the -c override channel.
    expect(joined).toContain("'-m' 'gpt-5-codex'");
    expect(joined).toContain("model_reasoning_effort=high");
    // The Claude-only launch flag and the Claude model alias never reach codex.
    expect(joined).not.toContain("--permission-mode");
    expect(joined).not.toContain("'opus'");
  });

  test("codex keeps --skip-git-repo-check on a NON-scratch launch (worktree/workspace-root)", () => {
    // A non-scratch codex launch runs at a worktree or a multi-checkout workspace ROOT.
    // A workspace root is NOT itself a git repo, so codex refuses to start
    // without --skip-git-repo-check ("Not inside a trusted directory and
    // --skip-git-repo-check was not specified"), the tee'd event log stays empty,
    // and the pane dies before any JSON. The flag must ride EVERY codex launch,
    // not just scratch — this pins that so the launch can't regress to silently
    // dropping it for the common case.
    const joined = buildSpawnArgv("codex", { ...spec, isScratch: false, codexEventLog: "/tmp/ev.jsonl" }).join(" ");
    expect(joined).toContain("--skip-git-repo-check");
  });

  test("the codex model/effort never leak into a claude launch's argv (regression)", () => {
    // A spec carrying BOTH the Claude knobs and stray codex fields: the claude
    // branch reads only model/effort, so the argv is byte-for-byte the codex-free
    // one — the two harnesses' knobs never cross over.
    const withCodexFields: SpawnArgvSpec = { ...spec, codexModel: "gpt-5-codex", codexEffort: "high" };
    expect(buildSpawnArgv("claude", withCodexFields)).toEqual(buildSpawnArgv("claude", spec));
    const joined = buildSpawnArgv("claude", withCodexFields).join(" ");
    expect(joined).not.toContain("gpt-5-codex");
    expect(joined).not.toContain("model_reasoning_effort");
  });
});

// launchSession routing + persistence, exercised through the stubbed seam so no
// agent is spawned. Env is sandboxed (temp worktree root + HOME) and restored so
// the shared test process isn't polluted.
const dirs: string[] = [];
const savedEnv = {
  HOME: process.env.HOME,
  WORKTREE_ROOT: process.env.STANDUP_WORKTREE_ROOT,
  CODEX_HOME: process.env.CODEX_HOME,
};
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  if (savedEnv.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = savedEnv.HOME;
  if (savedEnv.WORKTREE_ROOT === undefined) delete process.env.STANDUP_WORKTREE_ROOT;
  else process.env.STANDUP_WORKTREE_ROOT = savedEnv.WORKTREE_ROOT;
  if (savedEnv.CODEX_HOME === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedEnv.CODEX_HOME;
});

async function scratchStore() {
  const root = await mkdtemp(join(tmpdir(), "standup-harness-root-"));
  dirs.push(root);
  process.env.STANDUP_WORKTREE_ROOT = root;
  // Sandbox HOME so the claude path's folder-trust pre-accept can't touch the
  // real ~/.claude.json. CODEX_HOME takes priority over HOME in
  // codexConfigPath, so it is cleared for the sandbox to hold.
  const home = await mkdtemp(join(tmpdir(), "standup-harness-home-"));
  dirs.push(home);
  process.env.HOME = home;
  delete process.env.CODEX_HOME;

  const store = createStore(":memory:");
  const id = `harness-${randomUUID().slice(0, 8)}`;
  upsertProject(store.db, { id, name: "H", branch: "main", repos: [] });
  return { store, project: { id, name: "H", branch: "main", repos: [] } as Project };
}

/**
 * A seam stub: records the resolved harness + spec, and records every
 * opening-prompt delivery (so tests can assert the prompt is delivered via
 * send-keys for claude and not for codex) without spawning an agent or driving a
 * real tmux pane. The spawn seam returns a no-op command.
 */
function recordingSeam() {
  const calls: { harness: HarnessId; spec: SpawnArgvSpec }[] = [];
  const deliveries: { session: string; prompt: string; launchId: string }[] = [];
  const buildSpawnArgv = (harness: HarnessId, spec: SpawnArgvSpec): string[] => {
    calls.push({ harness, spec });
    return ["true"];
  };
  const deliverPrompt = async (session: string, prompt: string, launchId: string) => {
    deliveries.push({ session, prompt, launchId });
  };
  return { calls, deliveries, deps: { buildSpawnArgv, deliverPrompt } };
}

describe("launchSession — per-launch harness", () => {
  test("harness=codex routes through the codex adapter (mocked) and persists the harness + sidecar", async () => {
    const { store, project } = await scratchStore();
    const { calls, deps } = recordingSeam();

    const result = await launchSession(
      store.db,
      { project, task: "do it", harness: "codex" },
      undefined,
      undefined,
      deps
    );
    await result.done;

    expect(calls).toHaveLength(1);
    expect(calls[0].harness).toBe("codex");
    // The codex sidecar path is computed and threaded to the adapter.
    expect(calls[0].spec.codexEventLog).toBeTruthy();

    const row = getLaunch(store.db, result.launch.id);
    expect(row?.harness).toBe("codex");
    expect(row?.codexEventLog).toBeTruthy();
    expect(row?.status).toBe("running");
    store.close();
  });

  test("omitting harness defaults to claude and stores no harness (the unchanged path)", async () => {
    const { store, project } = await scratchStore();
    const { calls, deps } = recordingSeam();

    const result = await launchSession(
      store.db,
      { project, task: "do it" },
      undefined,
      undefined,
      deps
    );
    await result.done;

    expect(calls[0].harness).toBe("claude");
    // No codex sidecar is computed for the default harness.
    expect(calls[0].spec.codexEventLog).toBeUndefined();

    const row = getLaunch(store.db, result.launch.id);
    // A claude launch records no harness (unset = claude), byte-for-byte the row
    // the pre-harness launcher wrote.
    expect(row?.harness).toBeUndefined();
    expect(row?.codexEventLog).toBeUndefined();
    expect(row?.status).toBe("running");
    store.close();
  });

  test("a claude launch delivers its opening prompt via the send-keys seam, not positionally", async () => {
    const { store, project } = await scratchStore();
    const { calls, deliveries, deps } = recordingSeam();

    const result = await launchSession(
      store.db,
      { project, task: "wire up the widget" },
      undefined,
      undefined,
      deps
    );
    await result.done;

    // Claude launch → the opening prompt is delivered through the send-keys seam
    // exactly once (a `claude` wrapper script can drop a positional prompt), and it carries
    // the task text plus the checkpoint steering that buildOpeningPrompt appends.
    expect(calls[0].harness).toBe("claude");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].prompt).toContain("wire up the widget");
    expect(deliveries[0].prompt).toContain("checkpoint");
    // The same prompt is what the spawn spec carried — delivery and spawn agree.
    expect(deliveries[0].prompt).toBe(calls[0].spec.prompt);
    store.close();
  });

  test("a codex launch does NOT use the send-keys delivery (its prompt is a codex exec arg)", async () => {
    const { store, project } = await scratchStore();
    const { calls, deliveries, deps } = recordingSeam();

    const result = await launchSession(
      store.db,
      { project, task: "do it", harness: "codex" },
      undefined,
      undefined,
      deps
    );
    await result.done;

    expect(calls[0].harness).toBe("codex");
    // Codex takes its prompt as a `codex exec` argument (which works), so the
    // claude-only send-keys delivery is not invoked.
    expect(deliveries).toHaveLength(0);
    store.close();
  });

  test("a codex launch carries the knowledge-first steering only when ~/.codex/config.toml registers standup", async () => {
    // Unregistered: the steering is dropped and the launch log says why.
    {
      const { store, project } = await scratchStore();
      const { calls, deps } = recordingSeam();
      const result = await launchSession(store.db, { project, task: "do it", harness: "codex" }, undefined, undefined, deps);
      await result.done;
      expect(calls[0].spec.prompt).not.toContain("search_knowledge");
      const log = getLaunch(store.db, result.launch.id)?.log ?? "";
      expect(log).toContain("[warn] knowledge-first steering skipped:");
      expect(log).toContain(join(process.env.HOME!, ".codex", "config.toml"));
      store.close();
    }
    // Registered under the sandboxed HOME: the steering rides the prompt, no warning.
    {
      const { store, project } = await scratchStore();
      await mkdir(join(process.env.HOME!, ".codex"), { recursive: true });
      await writeFile(
        join(process.env.HOME!, ".codex", "config.toml"),
        '[mcp_servers.standup]\ncommand = "bun"\nargs = ["run", "index.ts"]\n'
      );
      const { calls, deps } = recordingSeam();
      const result = await launchSession(store.db, { project, task: "do it", harness: "codex" }, undefined, undefined, deps);
      await result.done;
      expect(calls[0].spec.prompt).toContain("search_knowledge");
      expect(calls[0].spec.prompt).toContain("get_knowledge_doc");
      expect(getLaunch(store.db, result.launch.id)?.log ?? "").not.toContain("knowledge-first steering skipped");
      store.close();
    }
  });

  test("a per-launch harness overrides the project's default", async () => {
    const { store, project } = await scratchStore();
    // Project defaults to codex; the launch forces claude and must win.
    const codexProject: Project = { ...project, harness: "codex" };
    const { calls, deps } = recordingSeam();

    const result = await launchSession(
      store.db,
      { project: codexProject, task: "do it", harness: "claude" },
      undefined,
      undefined,
      deps
    );
    await result.done;

    expect(calls[0].harness).toBe("claude");
    expect(getLaunch(store.db, result.launch.id)?.harness).toBeUndefined();
    store.close();
  });

  test("harness=codex persists codexModel/codexEffort and threads them to the spawn seam", async () => {
    const { store, project } = await scratchStore();
    const { calls, deps } = recordingSeam();

    const result = await launchSession(
      store.db,
      { project, task: "do it", harness: "codex", codexModel: "gpt-5-codex", codexEffort: "high" },
      undefined,
      undefined,
      deps
    );
    await result.done;

    // The resolved codex model + effort reach the routing seam...
    expect(calls[0].spec.codexModel).toBe("gpt-5-codex");
    expect(calls[0].spec.codexEffort).toBe("high");
    // ...and round-trip on the persisted launch row.
    const row = getLaunch(store.db, result.launch.id);
    expect(row?.codexModel).toBe("gpt-5-codex");
    expect(row?.codexEffort).toBe("high");
    store.close();
  });

  test.each(["provider.example-model-6", "provider.example-model-6.1"])(
    "a codex launch with %s passes it to codex exec -m, with its effort on the -c channel",
    async (codexModel) => {
      const { store, project } = await scratchStore();
      const { calls, deps } = recordingSeam();

      const result = await launchSession(
        store.db,
        { project, task: "do it", harness: "codex", codexModel, codexEffort: "ultra" },
        undefined,
        undefined,
        deps
      );
      await result.done;

      // The spec the launch handed the seam builds a codex command carrying the id verbatim.
      expect(calls[0].harness).toBe("codex");
      const joined = buildSpawnArgv("codex", calls[0].spec).join(" ");
      expect(joined).toContain(`'-m' '${codexModel}'`);
      expect(joined).toContain("model_reasoning_effort=ultra");
      expect(getLaunch(store.db, result.launch.id)?.codexModel).toBe(codexModel);
      store.close();
    }
  );

  test("a claude launch never stores codex model/effort, even if the request carries them", async () => {
    const { store, project } = await scratchStore();
    const { calls, deps } = recordingSeam();

    // No harness → claude. Stray codex fields must be dropped, not stored (they'd
    // be meaningless on a claude row).
    const result = await launchSession(
      store.db,
      { project, task: "do it", codexModel: "gpt-5-codex", codexEffort: "high" },
      undefined,
      undefined,
      deps
    );
    await result.done;

    expect(calls[0].harness).toBe("claude");
    expect(calls[0].spec.codexModel).toBeUndefined();
    expect(calls[0].spec.codexEffort).toBeUndefined();
    const row = getLaunch(store.db, result.launch.id);
    expect(row?.codexModel).toBeUndefined();
    expect(row?.codexEffort).toBeUndefined();
    store.close();
  });

  test("a codex launch never stores claude model/effort, even if the request carries them", async () => {
    const { store, project } = await scratchStore();
    const { calls, deps } = recordingSeam();

    // harness=codex with stray Claude model/effort (the composer leaves the
    // Claude selects' state set when its harness dropdown flips to Codex). They
    // must be dropped, not stored — a codex row carrying a phantom "opus" would
    // mislabel the session's model in the feed/work views. Symmetric to the
    // claude-drops-codex-fields guard above.
    const result = await launchSession(
      store.db,
      { project, task: "do it", harness: "codex", model: "opus", effort: "high" },
      undefined,
      undefined,
      deps
    );
    await result.done;

    expect(calls[0].harness).toBe("codex");
    // The Claude aliases never reach the spawn seam...
    expect(calls[0].spec.model).toBeUndefined();
    expect(calls[0].spec.effort).toBeUndefined();
    // ...nor the persisted launch row.
    const row = getLaunch(store.db, result.launch.id);
    expect(row?.model).toBeUndefined();
    expect(row?.effort).toBeUndefined();
    store.close();
  });

  test("with no per-launch choice a codex project still launches codex", async () => {
    const { store, project } = await scratchStore();
    const codexProject: Project = { ...project, harness: "codex" };
    const { calls, deps } = recordingSeam();

    const result = await launchSession(
      store.db,
      { project: codexProject, task: "do it" },
      undefined,
      undefined,
      deps
    );
    await result.done;

    expect(calls[0].harness).toBe("codex");
    expect(getLaunch(store.db, result.launch.id)?.harness).toBe("codex");
    store.close();
  });
});

// The send-keys delivery mechanism, tested as pure command builders (no tmux
// pane needed). This is how a Claude launch's opening prompt reaches the CLI now
// that it is spawned interactively.
describe("send-keys opening-prompt delivery", () => {
  test("shouldBufferPaste: short single-line rides send-keys; multi-line or large uses a buffer", () => {
    expect(shouldBufferPaste("hello")).toBe(false);
    // A multi-line prompt must NOT ride literal send-keys — an embedded newline
    // would submit it at the first blank line before the rest arrived.
    expect(shouldBufferPaste("line one\nline two")).toBe(true);
    // And anything over the command-length budget goes through the buffer too.
    expect(shouldBufferPaste("x".repeat(9000))).toBe(true);
  });

  test("a multi-line opening prompt is delivered via a tmux buffer + bracketed paste, then a single Enter", () => {
    // buildOpeningPrompt always appends the checkpoint steering, so a real
    // opening prompt is multi-line — it must ride the buffer path.
    const prompt = "do the task\n\n---\ncheckpoint steering...";
    const cmds = buildSubmitTextCmds("sess", prompt, "/tmp/buf.txt", "bufname");
    expect(cmds).toEqual([
      workerTmux("load-buffer", "-b", "bufname", "/tmp/buf.txt"),
      workerTmux("paste-buffer", "-d", "-p", "-b", "bufname", "-t", "sess"),
      workerTmux("send-keys", "-t", "sess", "Enter"),
    ]);
    // The prompt text is NEVER carried on a send-keys command line (that is the
    // positional-prompt shape a wrapped claude drops); it rides the buffer file.
    expect(cmds.some((c) => c.includes(prompt))).toBe(false);
  });

  test("a short single-line message rides send-keys -l directly, then Enter", () => {
    const cmds = buildSubmitTextCmds("sess", "yes", "/tmp/buf.txt", "bufname");
    expect(cmds).toEqual([
      workerTmux("send-keys", "-t", "sess", "-l", "yes"),
      workerTmux("send-keys", "-t", "sess", "Enter"),
    ]);
  });

  test("a session on another server is driven there (sessionTmux's prefix)", () => {
    expect(buildSubmitTextCmds("old", "yes", "/tmp/buf.txt", "b", ["tmux", "-S", "/tmp/tmux-1/default"])).toEqual([
      ["tmux", "-S", "/tmp/tmux-1/default", "send-keys", "-t", "old", "-l", "yes"],
      ["tmux", "-S", "/tmp/tmux-1/default", "send-keys", "-t", "old", "Enter"],
    ]);
  });
});

describe("buildModalAnswerKeys — AskUserQuestion menu navigation", () => {
  test("single-select first option is just Enter; the trailing group submits", () => {
    // Two single-select questions, the recommended (top) option chosen for each
    // — the exact 'do both the recommended' case. Enter selects the highlighted
    // option and advances, so no Down is needed.
    expect(buildModalAnswerKeys([[0], [0]], [false, false])).toEqual([
      ["Enter"],
      ["Enter"],
      ["Enter"],
    ]);
  });

  test("single-select non-top option walks down to it before Enter", () => {
    expect(buildModalAnswerKeys([[2]], [false])).toEqual([
      ["Down", "Down", "Enter"],
      ["Enter"],
    ]);
  });

  test("multi-select toggles each chosen option with Space while walking down", () => {
    // Choose options 0 and 2: Space at the top, Down twice to option 2, Space,
    // then Enter to advance.
    expect(buildModalAnswerKeys([[2, 0]], [true])).toEqual([
      ["Space", "Down", "Down", "Space", "Enter"],
      ["Enter"],
    ]);
  });
});

describe("isModalSubmitReady — gating the AskUserQuestion submit Enter", () => {
  test("a review-screen marker means ready, regardless of the previous capture", () => {
    expect(isModalSubmitReady("Ready to submit your answers?", null)).toBe(true);
    expect(isModalSubmitReady("... Submit answers ...", "something else")).toBe(true);
  });

  test("no marker and a changed screen is not ready (still transitioning)", () => {
    expect(isModalSubmitReady("question 2 of 2", "question 1 of 2")).toBe(false);
    // First poll has no previous capture to compare against.
    expect(isModalSubmitReady("question 2 of 2", null)).toBe(false);
  });

  test("no marker but two identical non-empty captures counts as settled", () => {
    expect(isModalSubmitReady("a stable screen", "a stable screen")).toBe(true);
  });

  test("an empty capture is never ready, even if it matches the previous one", () => {
    expect(isModalSubmitReady("", "")).toBe(false);
    expect(isModalSubmitReady("   ", null)).toBe(false);
  });
});

describe("launchSession — undeliverable opening prompt", () => {
  test("a claude launch whose opening prompt can never be delivered fails with the reason", async () => {
    const { store, project } = await scratchStore();
    const { deps } = recordingSeam();
    const deliverPrompt = async () => {
      throw new OpeningPromptUndeliverableError("the opening prompt could not be delivered: /x is unusable");
    };

    const result = await launchSession(
      store.db,
      { project, task: "wire up the widget" },
      undefined,
      undefined,
      { ...deps, deliverPrompt }
    );
    await result.done;

    const row = getLaunch(store.db, result.launch.id);
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("could not be delivered");
    store.close();
  });
});

describe("launchSession — worker environment", () => {
  test("the spawned worker command does not inherit the collector's slot vars", async () => {
    const { store, project } = await scratchStore();
    const { deps } = recordingSeam();
    const out = join(await mkdtemp(join(tmpdir(), "standup-harness-env-")), "env.txt");
    dirs.push(dirname(out));
    const saved = Object.fromEntries(SLOT_ENV_VARS.map((name) => [name, process.env[name]]));
    for (const name of SLOT_ENV_VARS) process.env[name] = "17777";
    try {
      const result = await launchSession(
        store.db,
        { project, task: "do it" },
        undefined,
        undefined,
        { ...deps, buildSpawnArgv: () => ["/bin/sh", "-c", `env > '${out}'`] }
      );
      await result.done;
    } finally {
      for (const name of SLOT_ENV_VARS) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
      store.close();
    }
    const names = (await readFile(out, "utf8")).split("\n").map((line) => line.slice(0, line.indexOf("=")));
    expect(names).toContain("PATH");
    for (const name of SLOT_ENV_VARS) expect(names).not.toContain(name);
  });
});
