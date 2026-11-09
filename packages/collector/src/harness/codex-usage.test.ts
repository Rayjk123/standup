import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { readCodexSessionUsage } from "./codex-usage.js";

const j = (o: unknown) => JSON.stringify(o);

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Writes a JSONL sidecar and returns its path. */
function sidecar(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "standup-codex-usage-"));
  dirs.push(dir);
  const path = join(dir, "codex-events.jsonl");
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
  return path;
}

describe("readCodexSessionUsage", () => {
  test("reconciles the live sample's turn.completed usage (cache legs subsets of input)", async () => {
    const path = sidecar([
      j({ type: "thread.started", thread_id: "t-1" }),
      j({ type: "turn.started" }),
      j({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "hello" } }),
      j({
        type: "turn.completed",
        usage: {
          input_tokens: 9573,
          cached_input_tokens: 0,
          cache_write_input_tokens: 9531,
          output_tokens: 5,
          reasoning_output_tokens: 0,
        },
      }),
    ]);

    const totals = await readCodexSessionUsage(path, "gpt-5-codex");
    // input is inclusive of the cache legs: fresh = 9573 - 0 - 9531 = 42.
    expect(totals.inputTokens).toBe(42);
    expect(totals.cacheCreationTokens).toBe(9531);
    expect(totals.cacheReadTokens).toBe(0);
    expect(totals.outputTokens).toBe(5);
    // total = input + output + both cache legs = 42 + 5 + 0 + 9531 = 9578,
    // i.e. the true ~9573-token prompt + 5 output, never the double-counted sum.
    expect(totals.totalTokens).toBe(9578);
    // A non-Claude model prices as unknown while still counting tokens.
    expect(totals.model).toBe("gpt-5-codex");
    expect(totals.costUsd).toBeNull();
  });

  test("sums usage across multiple turns and drops a failed turn's usage", async () => {
    const path = sidecar([
      j({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 10 } }),
      // A failed turn surfaces as turn-failed (usage dropped), so it must not add.
      j({
        type: "turn.completed",
        status: "failed",
        usage: { input_tokens: 999, output_tokens: 999 },
        error: { message: "boom", codex_error_info: "internalServerError" },
      }),
      j({ type: "turn.completed", usage: { input_tokens: 50, output_tokens: 4 } }),
    ]);

    const totals = await readCodexSessionUsage(path);
    expect(totals.inputTokens).toBe(150);
    expect(totals.outputTokens).toBe(14);
    expect(totals.totalTokens).toBe(164);
  });

  test("tolerates non-JSON noise and a partial trailing line without throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "standup-codex-usage-"));
    dirs.push(dir);
    const path = join(dir, "codex-events.jsonl");
    // Interleaved stderr noise + a final unterminated line (no trailing newline).
    writeFileSync(
      path,
      [
        "Reading additional input from stdin...",
        j({ type: "turn.completed", usage: { input_tokens: 20, output_tokens: 2 } }),
        "not json {",
      ].join("\n"),
      "utf8"
    );

    const totals = await readCodexSessionUsage(path);
    expect(totals.inputTokens).toBe(20);
    expect(totals.outputTokens).toBe(2);
  });

  test("a missing sidecar degrades to zeroed totals with null cost", async () => {
    const totals = await readCodexSessionUsage("/no/such/codex-events.jsonl");
    expect(totals).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      costUsd: null,
    });
  });

  test("undefined/empty path (a claude launch or pre-sidecar row) is zeroed, not an error", async () => {
    expect((await readCodexSessionUsage(undefined)).totalTokens).toBe(0);
    expect((await readCodexSessionUsage(null)).totalTokens).toBe(0);
    expect((await readCodexSessionUsage("")).totalTokens).toBe(0);
  });
});
