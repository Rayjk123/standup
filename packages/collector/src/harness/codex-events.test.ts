import { describe, expect, test } from "bun:test";
import {
  CodexEventParser,
  codexUsageToRecord,
  mapCodexUsage,
  parseCodexLine,
} from "./codex-events.js";
import type { NormalizedEvent } from "./types.js";
import { aggregateUsage, type UsageRecord } from "../usage.js";

const j = (o: unknown) => JSON.stringify(o);

/** Feeds a whole stream through the parser in fixed-size chunks (split lines). */
function parseInChunks(stream: string, chunkSize: number): NormalizedEvent[] {
  const parser = new CodexEventParser();
  const events: NormalizedEvent[] = [];
  for (let i = 0; i < stream.length; i += chunkSize) {
    events.push(...parser.push(stream.slice(i, i + chunkSize)));
  }
  events.push(...parser.end());
  return events;
}

// A live `codex exec --json` run of a one-word reply, verbatim but for the thread id.
const LIVE_STREAM = [
  j({ type: "thread.started", thread_id: "0000c0de-0000-7000-8000-00000000c0de" }),
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
].join("\n");

describe("parseCodexLine — captured live sample", () => {
  test("maps the four live events in order", () => {
    const events = LIVE_STREAM.split("\n").map(parseCodexLine);
    expect(events[0]).toEqual({
      kind: "session-started",
      sessionId: "0000c0de-0000-7000-8000-00000000c0de",
    });
    expect(events[1]).toEqual({ kind: "turn-started" });
    expect(events[2]).toEqual({ kind: "assistant-message", itemId: "item_0", text: "hello" });
    expect(events[3]).toEqual({
      kind: "turn-completed",
      usage: {
        inputTokens: 9573,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 9531,
        outputTokens: 5,
        reasoningOutputTokens: 0,
      },
    });
  });
});

describe("CodexEventParser — streaming robustness", () => {
  test("reassembles lines split across arbitrary chunk boundaries", () => {
    for (const size of [1, 3, 7, 13, 64, 100000]) {
      const events = parseInChunks(LIVE_STREAM + "\n", size);
      expect(events.map((e) => e.kind)).toEqual([
        "session-started",
        "turn-started",
        "assistant-message",
        "turn-completed",
      ]);
    }
  });

  test("flushes a final line with no trailing newline via end()", () => {
    const parser = new CodexEventParser();
    expect(parser.push(j({ type: "turn.started" }))).toEqual([]);
    expect(parser.end()).toEqual([{ kind: "turn-started" }]);
  });

  test("skips non-JSON noise and blank lines interleaved with events", () => {
    const stream = [
      "Reading additional input from stdin...",
      "",
      LIVE_STREAM.split("\n")[0],
      "   ",
      "not json at all {",
      LIVE_STREAM.split("\n")[1],
    ].join("\n");
    const events = parseInChunks(stream + "\n", 5);
    expect(events.map((e) => e.kind)).toEqual(["session-started", "turn-started"]);
  });

  test("never throws on a stream of pure garbage", () => {
    const garbage = [
      "",
      "   ",
      "not json",
      "42",
      "true",
      "[1,2,3]",
      j({ no: "type" }),
      j({ type: 123 }),
      "{unterminated",
      "\u0000\u0001binary",
    ].join("\n");
    expect(() => parseInChunks(garbage + "\n", 4)).not.toThrow();
    expect(parseInChunks(garbage + "\n", 4)).toEqual([]);
  });
});

describe("parseCodexLine — per-line garbage tolerance", () => {
  test.each([
    ["", null],
    ["   ", null],
    ["not json", null],
    ["42", null],
    ["[1,2,3]", null],
    ['{"no":"type"}', null],
    ['{"type":123}', null],
    ['{"type":""}', null],
  ])("returns null for %p", (line, expected) => {
    expect(parseCodexLine(line as string)).toBe(expected as null);
  });
});

describe("parseCodexLine — item.completed catalog", () => {
  test("reasoning joins summary and content prose", () => {
    const event = parseCodexLine(
      j({
        type: "item.completed",
        item: { id: "r1", type: "reasoning", summary: ["plan a", "plan b"], content: ["deep"] },
      })
    );
    expect(event).toEqual({ kind: "reasoning", itemId: "r1", text: "plan a\nplan b\ndeep" });
  });

  test("command_execution maps output/exit/status", () => {
    const event = parseCodexLine(
      j({
        type: "item.completed",
        item: {
          id: "c1",
          type: "command_execution",
          command: "ls -a",
          cwd: "/tmp/wt",
          aggregated_output: "a\nb\n",
          exit_code: 0,
          status: "completed",
          duration_ms: 42,
        },
      })
    );
    expect(event).toEqual({
      kind: "tool",
      itemId: "c1",
      tool: {
        kind: "command",
        command: "ls -a",
        cwd: "/tmp/wt",
        aggregatedOutput: "a\nb\n",
        exitCode: 0,
        status: "completed",
        durationMs: 42,
      },
    });
  });

  test("file_change decodes the discriminated kind object (add/update+move/delete/legacy/unknown)", () => {
    const event = parseCodexLine(
      j({
        type: "item.completed",
        item: {
          id: "f1",
          type: "file_change",
          status: "completed",
          changes: [
            { path: "a.ts", kind: { type: "add" }, diff: "+new" },
            { path: "b.ts", kind: { type: "update", move_path: "c.ts" }, diff: "@@" },
            { path: "d.ts", kind: { type: "delete" } },
            { path: "e.ts", kind: "add" },
            { path: "g.ts", kind: { type: "weird" } },
          ],
        },
      })
    );
    expect(event).toEqual({
      kind: "file-change",
      itemId: "f1",
      changes: [
        { path: "a.ts", changeKind: "add", movePath: undefined, diff: "+new" },
        { path: "b.ts", changeKind: "update", movePath: "c.ts", diff: "@@" },
        { path: "d.ts", changeKind: "delete", movePath: undefined, diff: undefined },
        { path: "e.ts", changeKind: "add", movePath: undefined, diff: undefined },
        { path: "g.ts", changeKind: "unknown", movePath: undefined, diff: undefined },
      ],
    });
  });

  test("mcp_tool_call, web_search, function_call_output, dynamic_tool_call map to tool kinds", () => {
    const mcp = parseCodexLine(
      j({
        type: "item.completed",
        item: { id: "m1", type: "mcp_tool_call", server: "s", tool: "t", status: "completed" },
      })
    );
    expect(mcp).toMatchObject({ kind: "tool", tool: { kind: "mcp", server: "s", tool: "t" } });

    const web = parseCodexLine(
      j({ type: "item.completed", item: { type: "web_search", query: "q", action: "search" } })
    );
    expect(web).toMatchObject({ kind: "tool", tool: { kind: "web-search", query: "q", action: "search" } });

    const fn = parseCodexLine(
      j({ type: "item.completed", item: { type: "function_call_output", name: "f", output: 1 } })
    );
    expect(fn).toMatchObject({ kind: "tool", tool: { kind: "function", name: "f", output: 1 } });

    const dyn = parseCodexLine(
      j({ type: "item.completed", item: { type: "dynamic_tool_call", tool: "d", status: "completed" } })
    );
    expect(dyn).toMatchObject({ kind: "tool", tool: { kind: "dynamic", tool: "d" } });
  });

  test("plan reads text; todo_list falls back to formatted items", () => {
    expect(
      parseCodexLine(j({ type: "item.completed", item: { type: "plan", text: "1. do it" } }))
    ).toEqual({ kind: "plan", itemId: undefined, text: "1. do it" });

    expect(
      parseCodexLine(
        j({
          type: "item.completed",
          item: {
            type: "todo_list",
            items: [
              { status: "completed", content: "step one" },
              { status: "pending", content: "step two" },
            ],
          },
        })
      )
    ).toEqual({ kind: "plan", itemId: undefined, text: "[completed] step one\n[pending] step two" });
  });

  test("user_message extracts echoed prompt text from content blocks", () => {
    expect(
      parseCodexLine(
        j({
          type: "item.completed",
          item: { type: "user_message", content: [{ type: "text", text: "hi there" }] },
        })
      )
    ).toEqual({ kind: "user-message", itemId: undefined, text: "hi there" });
  });

  test("an out-of-contract item type passes through as unknown, not dropped", () => {
    const event = parseCodexLine(
      j({ type: "item.completed", item: { id: "x", type: "image_view", src: "u" } })
    );
    expect(event).toMatchObject({ kind: "unknown", eventType: "item.completed:image_view" });
  });

  test("an out-of-contract top-level event passes through as unknown", () => {
    const event = parseCodexLine(j({ type: "thread.tokenUsage.updated", total: {} }));
    expect(event).toMatchObject({ kind: "unknown", eventType: "thread.tokenUsage.updated" });
  });

  test("item.started / item.updated are ignored (content repeats on completed)", () => {
    expect(parseCodexLine(j({ type: "item.started", item: { id: "i", type: "agent_message" } }))).toBeNull();
    expect(parseCodexLine(j({ type: "item.updated", item: { id: "i", type: "agent_message" } }))).toBeNull();
  });
});

describe("parseCodexLine — turn.failed / error classification", () => {
  test("string codexErrorInfo variant is non-retryable", () => {
    const event = parseCodexLine(
      j({ type: "turn.failed", error: { message: "ctx", codex_error_info: "contextWindowExceeded" } })
    );
    expect(event).toEqual({
      kind: "turn-failed",
      error: {
        message: "ctx",
        code: "contextWindowExceeded",
        retryable: false,
        additionalDetails: undefined,
      },
    });
  });

  test("object-tagged connection variant is retryable and carries httpStatusCode", () => {
    const nullStatus = parseCodexLine(
      j({
        type: "turn.failed",
        error: { message: "drop", codex_error_info: { responseStreamDisconnected: { httpStatusCode: null } } },
      })
    );
    expect(nullStatus).toEqual({
      kind: "turn-failed",
      error: {
        message: "drop",
        code: "responseStreamDisconnected",
        retryable: true,
        httpStatusCode: null,
        additionalDetails: undefined,
      },
    });

    const withStatus = parseCodexLine(
      j({
        type: "turn.failed",
        error: { message: "conn", codex_error_info: { httpConnectionFailed: { httpStatusCode: 503 } } },
      })
    );
    expect(withStatus).toMatchObject({
      kind: "turn-failed",
      error: { code: "httpConnectionFailed", retryable: true, httpStatusCode: 503 },
    });
  });

  test("activeTurnNotSteerable is non-retryable and reads turnKind, not httpStatusCode", () => {
    const event = parseCodexLine(
      j({
        type: "turn.failed",
        error: { message: "busy", codex_error_info: { activeTurnNotSteerable: { turnKind: "review" } } },
      })
    );
    expect(event).toEqual({
      kind: "turn-failed",
      error: {
        message: "busy",
        code: "activeTurnNotSteerable",
        retryable: false,
        additionalDetails: "turnKind=review",
      },
    });
  });

  test("turn.completed with status:failed + populated error surfaces as turn-failed, dropping usage", () => {
    const event = parseCodexLine(
      j({
        type: "turn.completed",
        status: "failed",
        usage: { input_tokens: 100, output_tokens: 5 },
        error: { message: "over budget", codex_error_info: "sessionBudgetExceeded" },
      })
    );
    expect(event).toEqual({
      kind: "turn-failed",
      error: {
        message: "over budget",
        code: "sessionBudgetExceeded",
        retryable: false,
        additionalDetails: undefined,
      },
    });
  });

  test("turn.completed with a retryable connection error is classified retryable", () => {
    const event = parseCodexLine(
      j({
        type: "turn.completed",
        status: "failed",
        error: { message: "drop", codex_error_info: { responseStreamDisconnected: { httpStatusCode: null } } },
      })
    );
    expect(event).toMatchObject({
      kind: "turn-failed",
      error: { code: "responseStreamDisconnected", retryable: true, httpStatusCode: null },
    });
  });

  test("turn.completed with status:failed but no error yields a default-message failure", () => {
    const event = parseCodexLine(j({ type: "turn.completed", status: "failed" }));
    expect(event).toEqual({
      kind: "turn-failed",
      error: { message: "codex turn failed", retryable: false, additionalDetails: undefined },
    });
  });

  test("turn.completed with a populated error but no status is still a failure", () => {
    const event = parseCodexLine(
      j({ type: "turn.completed", error: { message: "boom", codex_error_info: "internalServerError" } })
    );
    expect(event).toMatchObject({ kind: "turn-failed", error: { code: "internalServerError" } });
  });

  test("a clean turn.completed (no status, no error) still maps to turn-completed with usage", () => {
    const event = parseCodexLine(
      j({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 2 },
        error: null,
      })
    );
    expect(event).toEqual({
      kind: "turn-completed",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 2,
        reasoningOutputTokens: 0,
      },
    });
  });

  test("top-level error event tolerates flat message and nested error", () => {
    expect(parseCodexLine(j({ type: "error", message: "boom", will_retry: true }))).toEqual({
      kind: "stream-error",
      message: "boom",
      willRetry: true,
    });
    expect(parseCodexLine(j({ type: "error", error: { message: "nested" } }))).toEqual({
      kind: "stream-error",
      message: "nested",
      willRetry: undefined,
    });
  });
});

describe("usage extraction and reconciliation", () => {
  test("mapCodexUsage reads the five snake_case fields", () => {
    expect(
      mapCodexUsage({
        input_tokens: 100,
        cached_input_tokens: 20,
        cache_write_input_tokens: 30,
        output_tokens: 40,
        reasoning_output_tokens: 10,
      })
    ).toEqual({
      inputTokens: 100,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 30,
      outputTokens: 40,
      reasoningOutputTokens: 10,
    });
  });

  test("mapCodexUsage tolerates camelCase and missing/absent usage", () => {
    expect(mapCodexUsage({ inputTokens: 7, outputTokens: 3 })).toEqual({
      inputTokens: 7,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 3,
      reasoningOutputTokens: 0,
    });
    expect(mapCodexUsage(undefined)).toBeUndefined();
    expect(mapCodexUsage("nope")).toBeUndefined();
  });

  test("codexUsageToRecord treats cache legs as subsets of input, never additive", () => {
    // The live sample: input is inclusive of the 9531 cache-write tokens.
    const record = codexUsageToRecord(
      {
        inputTokens: 9573,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 9531,
        outputTokens: 5,
        reasoningOutputTokens: 0,
      },
      "gpt-5-codex"
    );
    expect(record).toEqual({
      model: "gpt-5-codex",
      provider: "openai",
      inputTokens: 42, // 9573 - 0 - 9531 (fresh, base-rate portion)
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 9531,
    });

    // aggregateUsage's total must equal input + output (9573 + 5), NOT the naive
    // 9573 + 0 + 9531 + 5 sum that double-counts the cache-write leg.
    const totals = aggregateUsage([record]);
    expect(totals.totalTokens).toBe(9578);
    // An unknown (non-Claude) model prices as null while still counting tokens.
    expect(totals.costUsd).toBeNull();
  });

  test("a Codex cache-write leg is NOT billed at Anthropic's 1.25x cache-creation premium", () => {
    // Codex's cache_write maps onto cacheCreationTokens, which Anthropic bills at
    // a 1.25x premium — a multiplier that does not apply to OpenAI/Codex. Price a
    // real codexUsageToRecord output against an Anthropic-equivalent record with
    // identical token legs to isolate the premium: the only difference is
    // provider. A Claude model id is used for both so both resolve to the same
    // rate — the id is orthogonal to the provider premium under test.
    const codex = codexUsageToRecord(
      {
        inputTokens: 1000, // inclusive of the 400 cache-write tokens
        cachedInputTokens: 0,
        cacheWriteInputTokens: 400,
        outputTokens: 200,
        reasoningOutputTokens: 0,
      },
      "claude-opus-4-8"
    );
    expect(codex.provider).toBe("openai");
    expect(codex.cacheCreationTokens).toBe(400);

    const anthropicEquivalent: UsageRecord = {
      model: "claude-opus-4-8", // default provider ⇒ anthropic (1.25x on cache write)
      inputTokens: codex.inputTokens,
      outputTokens: codex.outputTokens,
      cacheReadTokens: codex.cacheReadTokens,
      cacheCreationTokens: codex.cacheCreationTokens,
    };

    const codexCost = aggregateUsage([codex]).costUsd;
    const anthropicCost = aggregateUsage([anthropicEquivalent]).costUsd;

    // opus 4.8: $5/MTok input, $25/MTok output; cache read 0.1x, write 1.25x
    // (anthropic) vs 1x (openai). Fresh input = 1000 - 400 = 600.
    // codex: (600*5 + 400*5*1   + 200*25)/1e6 = (3000 + 2000 + 5000)/1e6 = 0.010
    // anth : (600*5 + 400*5*1.25 + 200*25)/1e6 = (3000 + 2500 + 5000)/1e6 = 0.0105
    expect(codexCost).toBeCloseTo(0.01, 10);
    expect(anthropicCost).toBeCloseTo(0.0105, 10);
    // The premium is the whole difference: 400 * $5/MTok * (1.25 - 1) = $0.0005.
    expect(codexCost!).toBeLessThan(anthropicCost!);
    expect(anthropicCost! - codexCost!).toBeCloseTo(0.0005, 10);
  });

  test("codexUsageToRecord clamps at zero if reported subsets exceed input", () => {
    const record = codexUsageToRecord({
      inputTokens: 100,
      cachedInputTokens: 80,
      cacheWriteInputTokens: 40,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    });
    expect(record.inputTokens).toBe(0);
    expect(record.cacheReadTokens).toBe(80);
    expect(record.cacheCreationTokens).toBe(40);
  });
});
