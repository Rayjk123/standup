import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isNearDuplicateReply } from "./runtime.js";
import { createStubTurnRunner, stubTurnsEnabled } from "./stub-turn.js";

const DEFAULT_DB = "/home/someone/.local/share/standup/standup.db";
const turn = { prompt: "p", systemPrompt: "s", model: "m", effort: "e", timeoutMs: 1000 };

describe("scripted Persona turns", () => {
  test("run only when asked for, on a collector with its own DB_PATH", () => {
    expect(stubTurnsEnabled({ STANDUP_PERSONA_STUB_TURNS: "1", DB_PATH: "/tmp/scratch/data/standup.db" }, DEFAULT_DB)).toBe(true);
    expect(stubTurnsEnabled({ DB_PATH: "/tmp/scratch/data/standup.db" }, DEFAULT_DB)).toBe(false);
    expect(stubTurnsEnabled({ STANDUP_PERSONA_STUB_TURNS: "true", DB_PATH: "/tmp/scratch/data/standup.db" }, DEFAULT_DB)).toBe(false);
    // The install's own data dir, named or by default: its real inbox items must never be answered by a stub.
    expect(stubTurnsEnabled({ STANDUP_PERSONA_STUB_TURNS: "1" }, DEFAULT_DB)).toBe(false);
    expect(stubTurnsEnabled({ STANDUP_PERSONA_STUB_TURNS: "1", DB_PATH: DEFAULT_DB }, DEFAULT_DB)).toBe(false);
    expect(stubTurnsEnabled({ STANDUP_PERSONA_STUB_TURNS: "1", DB_PATH: "/home/someone/.local/share/standup/../standup/standup.db" }, DEFAULT_DB)).toBe(false);
  });

  test("a symlinked spelling of the default data dir is still the default", () => {
    const root = mkdtempSync(join(tmpdir(), "stub-turn-"));
    try {
      mkdirSync(join(root, "real"));
      symlinkSync(join(root, "real"), join(root, "link"));
      const env = { STANDUP_PERSONA_STUB_TURNS: "1", DB_PATH: join(root, "link", "standup.db") };
      expect(stubTurnsEnabled(env, join(root, "real", "standup.db"))).toBe(false);
      expect(stubTurnsEnabled(env, join(root, "other", "standup.db"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("each turn succeeds at once with a reply the near-duplicate check never drops", async () => {
    const run = createStubTurnRunner();
    const a = await run(turn);
    const b = await run(turn);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.text).toMatch(/^stub reply( [0-9a-f]{4}){8}$/);
    expect(isNearDuplicateReply(a.text, b.text)).toBe(false);
  });
});
