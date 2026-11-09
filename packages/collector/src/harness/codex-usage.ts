import { createReadStream, existsSync } from "fs";
import { createInterface } from "readline";
import {
  aggregateUsage,
  MODEL_PRICING,
  type ModelPricing,
  type UsageRecord,
  type UsageTotals,
} from "../usage.js";
import { codexUsageToRecord, parseCodexLine } from "./codex-events.js";

/**
 * Fleet token/cost telemetry for a Codex run, derived from the JSONL event
 * sidecar the launcher tees `codex exec --json` stdout to (Launch.codexEventLog)
 * — the Codex analogue of `usage.ts`'s read of Claude's JSONL transcript.
 *
 * Each `turn.completed` carries the turn's `usage`; the parser normalizes it and
 * `codexUsageToRecord` reconciles it onto the same `UsageRecord` cost model
 * usage.ts sums for Claude — decomposing Codex's cache-inclusive `input_tokens`
 * into fresh + cache-read + cache-write legs so `aggregateUsage`'s total is
 * `input_tokens + output_tokens`, never the double-counted naive sum. One
 * `UsageRecord` per completed turn is summed into the run's lifetime total.
 *
 * Streamed line-by-line rather than buffered whole so a long run's sidecar can't
 * blow up memory, matching usage.ts's streaming reader. A missing or unreadable
 * sidecar (e.g. a run that hasn't emitted a turn yet, or a cleaned worktree)
 * degrades to zeroed totals with null cost rather than throwing.
 */
export async function readCodexSessionUsage(
  eventLogPath: string | null | undefined,
  model?: string,
  pricing: Record<string, ModelPricing> = MODEL_PRICING
): Promise<UsageTotals & { model?: string }> {
  const empty: UsageTotals & { model?: string } = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    costUsd: null,
  };

  if (!eventLogPath || !existsSync(eventLogPath)) return empty;

  try {
    const records: UsageRecord[] = [];
    const rl = createInterface({
      input: createReadStream(eventLogPath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    // for-await releases the file handle on completion, error, or break.
    for await (const line of rl) {
      const event = parseCodexLine(line);
      if (event?.kind === "turn-completed" && event.usage) {
        records.push(codexUsageToRecord(event.usage, model));
      }
    }
    const totals = aggregateUsage(records, pricing);
    return { ...totals, model };
  } catch (err) {
    console.error(`[usage] Failed to read codex sidecar ${eventLogPath}:`, err);
    return empty;
  }
}
