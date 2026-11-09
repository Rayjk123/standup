import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createStore } from "@standup/store";
import { PERSONA_AUTOCOMPACT_PCT, ROTATE_TOKENS_FALLBACK, resolvePersonaConfig, rotationTokens } from "./config.js";
import type { PersonaConfig } from "./config.js";
import { PersonaRuntime } from "./runtime.js";
import { HANDOFF_PROMPT } from "./prompt.js";
import { buildTurnEnv, createClaudeTurnRunner, parseTurnOutput, withoutCompactionSettingsEnv } from "./turn.js";
import type { TurnInput, TurnResult, TurnSpawn } from "./turn.js";
import { buildSpawnArgv, type SpawnArgvSpec } from "../launcher.js";
import { workerEnv } from "../worker-env.js";

const OVERRIDE = "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE";

describe("Persona auto-compact percent", () => {
  test("defaults to 40 and takes a 1-100 STANDUP_PERSONA_AUTOCOMPACT_PCT", () => {
    expect(PERSONA_AUTOCOMPACT_PCT).toBe(40);
    expect(resolvePersonaConfig({}).autoCompactPct).toBe(40);
    expect(resolvePersonaConfig({ STANDUP_PERSONA_AUTOCOMPACT_PCT: "25" }).autoCompactPct).toBe(25);
    expect(resolvePersonaConfig({ STANDUP_PERSONA_AUTOCOMPACT_PCT: "100" }).autoCompactPct).toBe(100);
    for (const bad of ["0", "-5", "101", "abc", ""]) {
      expect(resolvePersonaConfig({ STANDUP_PERSONA_AUTOCOMPACT_PCT: bad }).autoCompactPct).toBe(40);
    }
  });

  test("buildTurnEnv adds the override only when the turn sets a percent, and leaves its base alone", () => {
    const base = { PATH: "/usr/bin" };
    expect(buildTurnEnv({ autoCompactPct: 40 }, base)).toEqual({ PATH: "/usr/bin", [OVERRIDE]: "40" });
    expect(buildTurnEnv({}, base)).toEqual({ PATH: "/usr/bin" });
    const disabled = { PATH: "/usr/bin", DISABLE_AUTO_COMPACT: "1", DISABLE_COMPACT: "1" };
    expect(buildTurnEnv({ autoCompactPct: 40 }, disabled)).toEqual({ PATH: "/usr/bin", [OVERRIDE]: "40" });
    expect(buildTurnEnv({}, disabled)).toEqual(disabled);
    expect(base).toEqual({ PATH: "/usr/bin" });
  });

  test("every runtime turn carries the configured percent; the rotation handoff carries none", async () => {
    const store = createStore(":memory:");
    const calls: TurnInput[] = [];
    const config: PersonaConfig = { ...resolvePersonaConfig({}), rotateTokens: 500 };
    const runtime = new PersonaRuntime({
      db: store.db,
      owner: "alice",
      config,
      broadcast: () => {},
      turnRunner: async (input): Promise<TurnResult> => {
        calls.push(input);
        return { ok: true, text: "ok", sessionId: "sid-1", contextTokens: 1000 };
      },
    });
    runtime.receiveUserMessage({ text: "first", actor: "alice" });
    await runtime.drain();
    runtime.receiveUserMessage({ text: "second", actor: "alice" });
    await runtime.drain();
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.some((c) => c.prompt === HANDOFF_PROMPT)).toBe(true);
    expect(calls.map((c) => c.autoCompactPct)).toEqual(calls.map((c) => (c.prompt === HANDOFF_PROMPT ? undefined : 40)));
  });
});

/**
 * The Claude Code CLI's auto-compact threshold under CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
 * (claude-code 2.1.295): `min(floor(window * pct / 100), window - 13000)` of the
 * effective window, which is at most the model's context window.
 */
function cliCompactThreshold(effectiveWindow: number, pct: number): number {
  return Math.min(Math.floor(effectiveWindow * (pct / 100)), effectiveWindow - 13_000);
}

describe("rotation sits above the compaction threshold", () => {
  const config = resolvePersonaConfig({});

  test("for a 1M and a 200k window, compaction fires before rotation", () => {
    // The effective windows the CLI logs: 980k for claude-opus-5-5[1m], 180k for a 200k window.
    for (const [window, effective] of [[1_000_000, 980_000], [200_000, 180_000]] as const) {
      const compactAt = cliCompactThreshold(effective, config.autoCompactPct);
      const rotateAt = rotationTokens(config, window);
      expect(compactAt).toBeLessThan(rotateAt);
    }
    expect(rotationTokens(config, 1_000_000)).toBe(450_000);
    expect(rotationTokens(config, 200_000)).toBe(90_000);
    expect(cliCompactThreshold(980_000, 40)).toBe(392_000);
  });

  test("an unknown window falls back to 450k, above 40% of a 980k window", () => {
    expect(rotationTokens(config)).toBe(ROTATE_TOKENS_FALLBACK);
    expect(ROTATE_TOKENS_FALLBACK).toBe(450_000);
    expect(cliCompactThreshold(980_000, config.autoCompactPct)).toBeLessThan(rotationTokens(config));
  });

  test("the rotation percent follows a configured compaction percent; an explicit size wins", () => {
    expect(rotationTokens({ autoCompactPct: 60 }, 1_000_000)).toBe(650_000);
    expect(rotationTokens({ autoCompactPct: 100 }, 1_000_000)).toBe(950_000);
    expect(rotationTokens({ autoCompactPct: 40, rotateTokens: 1234 }, 1_000_000)).toBe(1234);
    expect(resolvePersonaConfig({ STANDUP_PERSONA_ROTATE_TOKENS: "300000" }).rotateTokens).toBe(300_000);
  });

  test("parseTurnOutput reports the largest window in modelUsage", () => {
    const result = {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "ok",
      session_id: "sid-1",
      modelUsage: { "claude-haiku-5-5": { contextWindow: 200_000 }, "claude-opus-5-5[1m]": { contextWindow: 1_000_000 } },
    };
    expect(parseTurnOutput(JSON.stringify(result), "", 0)).toMatchObject({ ok: true, contextWindow: 1_000_000 });
    const bare = { ...result, modelUsage: undefined };
    const parsed = parseTurnOutput(JSON.stringify(bare), "", 0);
    expect(parsed.ok && parsed.contextWindow).toBeUndefined();
  });

  test("a private session between the compaction and rotation sizes keeps its session; past rotation it hands off", async () => {
    const run = async (contextTokens: number, contextWindow?: number) => {
      const store = createStore(":memory:");
      const calls: TurnInput[] = [];
      const runtime = new PersonaRuntime({
        db: store.db,
        owner: "alice",
        config: resolvePersonaConfig({}),
        broadcast: () => {},
        turnRunner: async (input): Promise<TurnResult> => {
          calls.push(input);
          return { ok: true, text: "ok", sessionId: "sid-1", contextTokens, contextWindow };
        },
      });
      runtime.enqueue("schedule", { note: "x" });
      await runtime.drain();
      return calls.some((c) => c.prompt === HANDOFF_PROMPT);
    };
    expect(await run(400_000, 1_000_000)).toBe(false);
    expect(await run(400_000)).toBe(false);
    expect(await run(460_000, 1_000_000)).toBe(true);
    expect(await run(100_000, 200_000)).toBe(true);
  });
});

describe("the override reaches the Persona process and no worker", () => {
  const origConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const origOverride = process.env[OVERRIDE];
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "standup-persona-autocompact-"));
    process.env.CLAUDE_CONFIG_DIR = dir;
    delete process.env[OVERRIDE];
  });
  afterEach(() => {
    if (origConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = origConfigDir;
    if (origOverride === undefined) delete process.env[OVERRIDE];
    else process.env[OVERRIDE] = origOverride;
    rmSync(dir, { recursive: true, force: true });
  });

  test("forwarded user settings lose the env keys that would override Persona's percent", () => {
    const source = join(dir, "forwarded.json");
    writeFileSync(
      source,
      JSON.stringify({ apiKeyHelper: "/bin/k", env: { AWS_REGION: "us-west-2", [OVERRIDE]: "80", DISABLE_AUTO_COMPACT: "1" } })
    );
    const out = join(dir, "persona-cwd");
    mkdirSync(out, { mode: 0o700 });
    const args = withoutCompactionSettingsEnv(["--settings", source], out);
    expect(args).toEqual(["--settings", join(out, "settings.json")]);
    expect(statSync(args[1]!).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(args[1]!, "utf8"))).toEqual({ apiKeyHelper: "/bin/k", env: { AWS_REGION: "us-west-2" } });

    const clean = join(dir, "clean.json");
    writeFileSync(clean, JSON.stringify({ env: { AWS_REGION: "us-west-2" } }));
    expect(withoutCompactionSettingsEnv(["--settings", clean], out)).toEqual(["--settings", clean]);
    expect(existsSync(join(out, "settings.json"))).toBe(false);
    expect(withoutCompactionSettingsEnv([], out)).toEqual([]);
  });

  test("the Persona turn spawns with CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=40; a worker launch's env and argv lack it", async () => {
    let seenEnv: Record<string, string> = {};
    let seenArgv: string[] = [];
    const spawn: TurnSpawn = (argv, options) => {
      seenArgv = argv;
      seenEnv = options.env;
      const event = { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "sid-1" };
      return {
        pid: 4242,
        stdout: new Blob([`${JSON.stringify(event)}\n`]).stream(),
        stderr: new Blob([""]).stream(),
        exited: Promise.resolve(0),
        exitCode: 0,
        kill: () => {},
      };
    };
    const runner = createClaudeTurnRunner({ cwd: join(dir, "persona"), collectorUrl: "http://127.0.0.1:1", token: "t", spawn });
    const result = await runner({
      prompt: "hi",
      systemPrompt: "SYSTEM",
      model: "opus",
      effort: "medium",
      timeoutMs: 5_000,
      autoCompactPct: resolvePersonaConfig({}).autoCompactPct,
    });
    expect(result).toMatchObject({ ok: true });
    expect(seenArgv[0]).toBe("claude");
    expect(seenEnv[OVERRIDE]).toBe("40");

    // Persona's override lives on its own spawn env, never on the collector's,
    // so the env a worker's tmux server starts with doesn't carry it.
    expect(process.env[OVERRIDE]).toBeUndefined();
    expect(workerEnv()[OVERRIDE]).toBeUndefined();
    // A value the owner set in the collector's own env reaches workers as is,
    // while Persona's turn still gets its own percent.
    process.env[OVERRIDE] = "77";
    await runner({ prompt: "hi", systemPrompt: "SYSTEM", model: "opus", effort: "medium", timeoutMs: 5_000, autoCompactPct: 40 });
    expect(seenEnv[OVERRIDE]).toBe("40");
    expect(process.env[OVERRIDE]).toBe("77");
    expect(workerEnv()[OVERRIDE]).toBe("77");
    delete process.env[OVERRIDE];
    const spec: SpawnArgvSpec = {
      tmuxSession: "sess",
      launchCwd: "/tmp/wt",
      workspaceRoot: "/tmp/wt",
      prompt: "do the task",
      launchId: "L1",
      model: "opus",
      effort: "high",
      launchArgs: undefined,
      isScratch: false,
      hookToken: "hook-tok",
    };
    const workerArgv = buildSpawnArgv("claude", spec);
    // A worker pane starts on the workers' own tmux server (`tmux -S <socket> new-session …`).
    expect(workerArgv[0]).toBe("tmux");
    expect(workerArgv).toContain("new-session");
    expect(workerArgv.join(" ")).not.toContain(OVERRIDE);
    expect(workerArgv.join(" ")).not.toContain("AUTOCOMPACT");
  });
});
