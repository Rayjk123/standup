import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  aggregateUsage,
  normalizeModelId,
  parseUsageRecords,
  readSessionUsage,
  mapWithConcurrency,
  MODEL_PRICING,
  type UsageRecord,
} from "./usage.js";

const j = (o: unknown) => JSON.stringify(o);

/** An assistant record carrying a message-level usage object. */
function assistant(
  uuid: string,
  model: string,
  usage: Record<string, number>,
  opts: { messageId?: string; sessionId?: string } = {}
) {
  return j({
    type: "assistant",
    uuid,
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    timestamp: "2026-01-01T00:00:00Z",
    message: {
      role: "assistant",
      ...(opts.messageId ? { id: opts.messageId } : {}),
      model,
      content: [{ type: "text", text: "hi" }],
      usage,
    },
  });
}

describe("normalizeModelId", () => {
  test("bare id maps to itself", () => {
    expect(normalizeModelId("claude-opus-4-8")).toBe("claude-opus-4-8");
  });
  test("strips a gateway prefix and a [1m] annotation", () => {
    expect(normalizeModelId("global.anthropic.claude-opus-4-8[1m]")).toBe(
      "claude-opus-4-8"
    );
    expect(normalizeModelId("us.anthropic.claude-sonnet-5")).toBe("claude-sonnet-5");
  });
  test("strips a -YYYYMMDD snapshot suffix", () => {
    expect(normalizeModelId("claude-opus-4-8-20260115")).toBe("claude-opus-4-8");
  });
  test("returns null for a synthetic / non-claude / empty model", () => {
    expect(normalizeModelId("<synthetic>")).toBeNull();
    expect(normalizeModelId("gpt-4")).toBeNull();
    expect(normalizeModelId(undefined)).toBeNull();
    expect(normalizeModelId("")).toBeNull();
  });
});

describe("aggregateUsage", () => {
  test("sums token legs and prices a known model exactly", () => {
    // opus 4.8: $5/MTok input, $25/MTok output; cache read 0.1x, write 1.25x.
    const records: UsageRecord[] = [
      {
        model: "claude-opus-4-8",
        inputTokens: 1000,
        outputTokens: 2000,
        cacheReadTokens: 10000,
        cacheCreationTokens: 4000,
      },
    ];
    const out = aggregateUsage(records);
    expect(out.inputTokens).toBe(1000);
    expect(out.outputTokens).toBe(2000);
    expect(out.cacheReadTokens).toBe(10000);
    expect(out.cacheCreationTokens).toBe(4000);
    expect(out.totalTokens).toBe(17000);
    // (1000*5 + 10000*5*0.1 + 4000*5*1.25 + 2000*25) / 1e6
    // = (5000 + 5000 + 25000 + 50000) / 1e6 = 0.085
    expect(out.costUsd).toBeCloseTo(0.085, 10);
  });

  test("unknown model → cost null, tokens still summed", () => {
    const records: UsageRecord[] = [
      {
        model: "claude-experimental-9",
        inputTokens: 500,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    ];
    const out = aggregateUsage(records);
    expect(out.costUsd).toBeNull();
    expect(out.totalTokens).toBe(600);
    expect(out.inputTokens).toBe(500);
    expect(out.outputTokens).toBe(100);
  });

  test("no records → zeroed totals with null cost", () => {
    const out = aggregateUsage([]);
    expect(out.totalTokens).toBe(0);
    expect(out.costUsd).toBeNull();
  });

  test("mixed known + unknown models: tokens all summed, cost is the priced portion", () => {
    const records: UsageRecord[] = [
      {
        model: "claude-sonnet-5", // 2/10
        inputTokens: 500,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      {
        model: "claude-experimental-9", // unpriced
        inputTokens: 300,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    ];
    const out = aggregateUsage(records);
    expect(out.totalTokens).toBe(950);
    // Only the sonnet record is priced: (500*2 + 100*10)/1e6 = 0.002
    expect(out.costUsd).toBeCloseTo(0.002, 10);
  });

  test("openai provider bills a cache write at the base rate, not Anthropic's 1.25x premium", () => {
    // Same token legs and model rate for both records; the only difference is the
    // provider, which selects the cache-write multiplier (1x openai vs 1.25x
    // anthropic). An absent provider must stay anthropic so Claude is unchanged.
    const legs = { inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 10000, cacheCreationTokens: 4000 };
    const anthropic = aggregateUsage([{ model: "claude-opus-4-8", ...legs }]);
    const openai = aggregateUsage([{ model: "claude-opus-4-8", provider: "openai", ...legs }]);

    // anthropic (default): (1000*5 + 10000*5*0.1 + 4000*5*1.25 + 2000*25)/1e6 = 0.085
    expect(anthropic.costUsd).toBeCloseTo(0.085, 10);
    // openai: cache write at 1x, not 1.25x → (…+ 4000*5*1 + …)/1e6 = 0.080
    expect(openai.costUsd).toBeCloseTo(0.08, 10);
    // The 1.25x premium on the cache-write leg is the entire gap: 4000*5*0.25/1e6.
    expect(openai.costUsd!).toBeLessThan(anthropic.costUsd!);
    expect(anthropic.costUsd! - openai.costUsd!).toBeCloseTo(0.005, 10);
  });

  test("fleet-wide sum across two sessions' records", () => {
    const opus: UsageRecord[] = [
      {
        model: "claude-opus-4-8",
        inputTokens: 1000,
        outputTokens: 2000,
        cacheReadTokens: 10000,
        cacheCreationTokens: 4000,
      },
    ];
    const sonnet: UsageRecord[] = [
      {
        model: "claude-sonnet-5",
        inputTokens: 500,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    ];
    const combined = aggregateUsage([...opus, ...sonnet]);
    expect(combined.totalTokens).toBe(17000 + 600);
    // 0.085 (opus) + 0.002 (sonnet)
    expect(combined.costUsd).toBeCloseTo(0.087, 10);
  });
});

describe("parseUsageRecords", () => {
  test("counts a message's usage once even when split across records", () => {
    // One logical message (same message.id) written as several block records,
    // each stamped with identical message-level usage.
    const usage = { output_tokens: 1103, input_tokens: 2, cache_read_input_tokens: 15069 };
    const lines = [
      assistant("u1", "claude-opus-4-8", usage, { messageId: "msg_1" }),
      assistant("u2", "claude-opus-4-8", usage, { messageId: "msg_1" }),
      assistant("u3", "claude-opus-4-8", usage, { messageId: "msg_1" }),
    ];
    const records = parseUsageRecords(lines);
    expect(records).toHaveLength(1);
    const out = aggregateUsage(records);
    expect(out.outputTokens).toBe(1103);
    expect(out.inputTokens).toBe(2);
    expect(out.cacheReadTokens).toBe(15069);
  });

  test("skips non-assistant records and records without usage", () => {
    const lines = [
      j({ type: "user", uuid: "x", message: { role: "user", content: "hello" } }),
      assistant("a1", "claude-opus-4-8", { output_tokens: 10, input_tokens: 5 }),
      j({ type: "assistant", uuid: "a2", message: { role: "assistant", model: "claude-opus-4-8", content: [] } }),
      "not json at all",
    ];
    const records = parseUsageRecords(lines);
    expect(records).toHaveLength(1);
    expect(records[0].outputTokens).toBe(10);
  });

  test("end-to-end: parse a fixture transcript then aggregate per session", () => {
    const lines = [
      assistant("a1", "claude-opus-4-8", {
        input_tokens: 1000,
        output_tokens: 2000,
        cache_read_input_tokens: 10000,
        cache_creation_input_tokens: 4000,
      }),
      assistant("a2", "claude-opus-4-8", {
        input_tokens: 0,
        output_tokens: 500,
        cache_read_input_tokens: 20000,
        cache_creation_input_tokens: 0,
      }),
    ];
    const out = aggregateUsage(parseUsageRecords(lines));
    expect(out.outputTokens).toBe(2500);
    expect(out.cacheReadTokens).toBe(30000);
    // turn 1: 0.085 ; turn 2: (20000*5*0.1 + 500*25)/1e6 = (10000 + 12500)/1e6 = 0.0225
    expect(out.costUsd).toBeCloseTo(0.1075, 10);
  });

  test("drops records belonging to another session when a sessionId is given", () => {
    const lines = [
      assistant("m1", "claude-opus-4-8", { output_tokens: 100 }, { sessionId: "own" }),
      assistant("f1", "claude-opus-4-8", { output_tokens: 999 }, { sessionId: "other" }),
      assistant("m2", "claude-opus-4-8", { output_tokens: 50 }, { sessionId: "own" }),
    ];
    const out = aggregateUsage(parseUsageRecords(lines, "own"));
    // 999 from the foreign session must not be counted.
    expect(out.outputTokens).toBe(150);
  });
});

describe("MODEL_PRICING", () => {
  test("covers the current model family with sane relative rates", () => {
    expect(MODEL_PRICING["claude-opus-4-8"]).toEqual({ inputPerMTok: 5, outputPerMTok: 25 });
    expect(MODEL_PRICING["claude-sonnet-5"]).toEqual({ inputPerMTok: 2, outputPerMTok: 10 });
    expect(MODEL_PRICING["claude-haiku-4-5"]).toEqual({ inputPerMTok: 1, outputPerMTok: 5 });
  });
});

describe("readSessionUsage — streams a real transcript file", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  async function writeTranscript(lines: string[]): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "standup-usage-"));
    dirs.push(dir);
    const path = join(dir, "transcript.jsonl");
    // A trailing newline is the real on-disk shape of an append-only JSONL.
    await writeFile(path, lines.join("\n") + "\n", "utf8");
    return path;
  }

  test("aggregates the whole file and reports the current model", async () => {
    const path = await writeTranscript([
      assistant("a1", "claude-opus-4-8", {
        input_tokens: 1000,
        output_tokens: 2000,
        cache_read_input_tokens: 10000,
        cache_creation_input_tokens: 4000,
      }),
      assistant("a2", "claude-opus-4-8", {
        input_tokens: 0,
        output_tokens: 500,
        cache_read_input_tokens: 20000,
        cache_creation_input_tokens: 0,
      }),
    ]);

    const out = await readSessionUsage(path);
    expect(out.outputTokens).toBe(2500);
    expect(out.cacheReadTokens).toBe(30000);
    expect(out.totalTokens).toBe(1000 + 2500 + 30000 + 4000);
    // Same fixture as the parseUsageRecords end-to-end test: 0.085 + 0.0225.
    expect(out.costUsd).toBeCloseTo(0.1075, 10);
    expect(out.model).toBe("claude-opus-4-8");
  });

  test("counts a split message once and drops another session's turns", async () => {
    const usage = { output_tokens: 100, input_tokens: 2 };
    const path = await writeTranscript([
      assistant("u1", "claude-opus-4-8", usage, { messageId: "msg_1", sessionId: "own" }),
      // Same logical message, split across blocks — billed once.
      assistant("u2", "claude-opus-4-8", usage, { messageId: "msg_1", sessionId: "own" }),
      // A turn copied in from a resumed/compacted parent conversation.
      assistant("f1", "claude-opus-4-8", { output_tokens: 999 }, { sessionId: "other" }),
    ]);

    const out = await readSessionUsage(path, "own");
    expect(out.outputTokens).toBe(100);
  });

  test("unknown model → cost null, tokens still summed", async () => {
    const path = await writeTranscript([
      assistant("a1", "claude-experimental-9", { input_tokens: 500, output_tokens: 100 }),
    ]);
    const out = await readSessionUsage(path);
    expect(out.costUsd).toBeNull();
    expect(out.totalTokens).toBe(600);
    // The model id is a real (claude-*) string, so it's reported — it's simply
    // absent from the pricing map, which is why the cost is null.
    expect(out.model).toBe("claude-experimental-9");
  });

  test("a missing or null transcript path degrades to zeroed totals with null cost", async () => {
    const missing = await readSessionUsage(join(tmpdir(), "standup-usage-does-not-exist.jsonl"));
    expect(missing.totalTokens).toBe(0);
    expect(missing.costUsd).toBeNull();

    const none = await readSessionUsage(null);
    expect(none.totalTokens).toBe(0);
    expect(none.costUsd).toBeNull();
  });
});

describe("mapWithConcurrency", () => {
  test("preserves input order regardless of completion order", async () => {
    const items = [30, 10, 20, 5];
    const out = await mapWithConcurrency(items, 2, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms * 2;
    });
    expect(out).toEqual([60, 20, 40, 10]);
  });

  test("never runs more than `limit` calls at once", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  test("an empty input resolves to an empty array without spawning a worker", async () => {
    let calls = 0;
    const out = await mapWithConcurrency([], 4, async () => {
      calls++;
      return 1;
    });
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });

  test("a non-positive limit still makes progress with a single worker", async () => {
    const out = await mapWithConcurrency([1, 2, 3], 0, async (n) => n + 1);
    expect(out).toEqual([2, 3, 4]);
  });
});
