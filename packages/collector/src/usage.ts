import { createReadStream, existsSync } from "fs";
import { createInterface } from "readline";
import { recordBelongsToSession, type RawRecord } from "./transcript.js";

/**
 * Fleet token/cost telemetry, derived from Claude Code's JSONL transcript on
 * read rather than persisted into a session_usage table.
 *
 * Why compute-on-read, not a mirror table: the per-message token counts already
 * live in the transcript (the single source of truth), and the collector
 * already parses transcripts per request for the transcript views. A
 * session_usage table would be a rebuildable, denormalized copy that has to be
 * re-derived and re-written on every ingest — an extra write path and a
 * staleness surface — to serve a cost view that is opened occasionally, not on
 * a hot request path. Deriving on demand stays consistent with the transcript
 * by construction and needs no migration, the same "reconcile/derive on read"
 * philosophy transcript.ts already follows.
 *
 * Token summing for COST is different from the context-size reading
 * transcript.ts reports. Every API request bills its own input / cache / output
 * tokens, so the lifetime bill is the SUM of every turn's usage — unlike
 * context size, where summing input across turns double-counts the re-sent
 * history (see the note on TranscriptPage.outputTokens). Usage is stamped per
 * logical assistant message, so each message id is counted once: a message
 * split across thinking / text / tool records carries identical message-level
 * usage on each record.
 */

/**
 * USD per 1M tokens for a model's base input and output. Cache-leg rates are
 * derived from the base input rate (below). Sourced from Anthropic's published
 * first-party rates; a model absent from this map is priced as unknown (cost
 * null), its tokens still counted. Keyed by the NORMALIZED model id — see
 * normalizeModelId, which strips gateway prefixes, snapshot dates, and context
 * annotations before lookup.
 */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-7": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-6": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10 },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
  "claude-fable-5": { inputPerMTok: 10, outputPerMTok: 50 },
};

/**
 * Pricing provider a record's tokens are billed under. It selects the
 * cache-write premium below; an absent provider bills as `anthropic`, the Claude
 * default. Codex records carry `openai` (see codexUsageToRecord).
 */
export type UsageProvider = "anthropic" | "openai";

/**
 * Cache-read rate multiplier on the base input rate — a cache hit bills far below
 * fresh input. Shared across providers; the cache-write leg is the only one whose
 * rate differs by provider (below).
 */
const CACHE_READ_MULTIPLIER = 0.1;

/**
 * Cache-write ("creation") rate multiplier on the base input rate, keyed by
 * provider. Anthropic bills a cache write at a ~1.25x premium; OpenAI/Codex has
 * no cache-write surcharge and bills it at the base rate (1x). Keying the premium
 * on the provider keeps a Codex turn's cache-write leg off Anthropic's premium; a
 * record with no provider bills as `anthropic`, so Claude cost is unaffected.
 * Codex's cache_write semantics behind a hosted provider are unverified, so the
 * base rate — not a premium — is the conservative estimate.
 */
const CACHE_WRITE_MULTIPLIER: Record<UsageProvider, number> = {
  anthropic: 1.25,
  openai: 1,
};

/**
 * Reduces a raw transcript model id to a pricing-map key. Transcript ids arrive
 * in several shapes — bare (`claude-opus-4-8`), snapshot-dated
 * (`claude-opus-4-8-20260115`), and gateway-prefixed / annotated
 * (`global.anthropic.claude-opus-4-8[1m]`, `us.anthropic.claude-...`) — so the
 * provider prefix, a trailing `[...]` annotation, and a trailing `-YYYYMMDD`
 * snapshot date are all stripped before lookup. Returns null for a value with
 * no `claude` segment (e.g. `<synthetic>` or an empty string), which prices as
 * unknown.
 */
export function normalizeModelId(model: string | undefined): string | null {
  if (!model) return null;
  const lower = model.toLowerCase();
  const claudeAt = lower.indexOf("claude");
  if (claudeAt < 0) return null;
  const id = lower
    .slice(claudeAt)
    .replace(/\[.*?\]\s*$/, "")
    .replace(/-\d{8}$/, "");
  return id || null;
}

/** One logical assistant message's billed token usage. */
export interface UsageRecord {
  model?: string;
  /**
   * Pricing provider for the cache-write premium; absent ⇒ `anthropic` (the
   * Claude default). Codex records set `openai` so their cache-write leg is not
   * billed at Anthropic's cache-creation premium.
   */
  provider?: UsageProvider;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** input + output + both cache legs. */
  totalTokens: number;
  /** Estimated USD cost, or null when no record's model is in the pricing map. */
  costUsd: number | null;
}

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

/**
 * USD cost of one message's usage under its model's pricing, or null when the
 * model isn't in the map.
 */
function priceRecord(
  r: UsageRecord,
  pricing: Record<string, ModelPricing>
): number | null {
  const key = normalizeModelId(r.model);
  const p = key ? pricing[key] : undefined;
  if (!p) return null;
  const cacheWriteMultiplier = CACHE_WRITE_MULTIPLIER[r.provider ?? "anthropic"];
  return (
    (r.inputTokens * p.inputPerMTok +
      r.cacheReadTokens * p.inputPerMTok * CACHE_READ_MULTIPLIER +
      r.cacheCreationTokens * p.inputPerMTok * cacheWriteMultiplier +
      r.outputTokens * p.outputPerMTok) /
    1_000_000
  );
}

/**
 * Sums token usage across a session's messages and estimates its cost. Tokens
 * are always summed regardless of whether the model is priced; cost is the sum
 * over the records whose model is in the pricing map, and null only when NONE
 * is priceable (an entirely-unknown-model session still reports its tokens). A
 * session that switched to an unpriced model mid-way therefore reports the cost
 * of its priced portion — the unpriced records add tokens but no cost.
 */
export function aggregateUsage(
  records: UsageRecord[],
  pricing: Record<string, ModelPricing> = MODEL_PRICING
): UsageTotals {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let cost = 0;
  let anyPriced = false;

  for (const r of records) {
    inputTokens += r.inputTokens;
    outputTokens += r.outputTokens;
    cacheReadTokens += r.cacheReadTokens;
    cacheCreationTokens += r.cacheCreationTokens;
    const c = priceRecord(r, pricing);
    if (c !== null) {
      cost += c;
      anyPriced = true;
    }
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
    costUsd: anyPriced ? cost : null,
  };
}

/**
 * Parses a single JSONL line into a UsageRecord, or null when the line carries
 * no billable usage for this session: a blank / unparseable line, a
 * non-assistant record, an assistant record without message-level usage, a turn
 * belonging to another session (a resumed/compacted file copies the parent
 * conversation's turns, each keeping its original id), or a message id already
 * counted — usage is stamped identically on every record of a message split
 * across thinking / text / tool blocks (the same dedup the rich-transcript
 * reader does for output tokens), so it is billed once. `counted` is owned by
 * the caller and shared across every line of the same transcript.
 */
function parseUsageLine(
  line: string,
  counted: Set<string>,
  sessionId?: string
): UsageRecord | null {
  if (!line.trim()) return null;
  let raw: RawRecord;
  try {
    raw = JSON.parse(line) as RawRecord;
  } catch {
    return null;
  }
  if (raw.type !== "assistant") return null;
  if (!recordBelongsToSession(raw, sessionId)) return null;

  const usage = raw.message?.usage;
  if (!usage) return null;

  const messageId = (raw.message as { id?: string } | undefined)?.id;
  if (messageId) {
    if (counted.has(messageId)) return null;
    counted.add(messageId);
  }

  return {
    model: raw.message?.model,
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    cacheCreationTokens: num(usage.cache_creation_input_tokens),
  };
}

/**
 * Extracts one UsageRecord per logical assistant message from JSONL lines,
 * counting each message id once. Records belonging to another session are
 * dropped when a sessionId is given. Defensive: an unparseable line is skipped,
 * never fatal. See parseUsageLine for the per-line rules.
 */
export function parseUsageRecords(lines: string[], sessionId?: string): UsageRecord[] {
  const records: UsageRecord[] = [];
  const counted = new Set<string>();
  for (const line of lines) {
    const record = parseUsageLine(line, counted, sessionId);
    if (record) records.push(record);
  }
  return records;
}

/**
 * Streams a transcript line-by-line, accumulating one UsageRecord per logical
 * assistant message. Peak memory is bounded to a read buffer plus the parsed
 * records (a few small numbers per turn) — never the whole file, unlike a
 * Buffer.alloc(fileSize) read of a multi-MB JSONL. This honors transcript.ts's
 * "never hold a whole transcript per request" design, so the fleet view can
 * span every session without a per-file allocation proportional to file size.
 */
async function streamUsageRecords(
  transcriptPath: string,
  sessionId?: string
): Promise<UsageRecord[]> {
  const records: UsageRecord[] = [];
  const counted = new Set<string>();
  const rl = createInterface({
    input: createReadStream(transcriptPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  // for-await closes the readline interface and destroys the underlying stream
  // on completion, error, or break, so the file handle is always released.
  for await (const line of rl) {
    const record = parseUsageLine(line, counted, sessionId);
    if (record) records.push(record);
  }
  return records;
}

/**
 * Reads a session's full transcript and returns its aggregated usage plus the
 * session's current (last real, non-synthetic) model id. Streams the whole file
 * line-by-line rather than a fixed tail so a long session's lifetime cost isn't
 * undercounted — the fleet view is opened occasionally, not polled — and rather
 * than a single whole-file buffer so peak memory stays bounded per session. A
 * missing or unreadable transcript degrades to zeroed totals with null cost
 * rather than throwing.
 */
export async function readSessionUsage(
  transcriptPath: string | null,
  sessionId?: string,
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

  if (!transcriptPath || !existsSync(transcriptPath)) return empty;

  try {
    const records = await streamUsageRecords(transcriptPath, sessionId);
    const totals = aggregateUsage(records, pricing);
    // Current model = the last record carrying a real (non-synthetic) model.
    const model = [...records].reverse().find((r) => normalizeModelId(r.model))?.model;
    return { ...totals, model };
  } catch (err) {
    console.error(`[usage] Failed to read ${transcriptPath}:`, err);
    return empty;
  }
}

/**
 * Max transcripts the fleet-usage endpoint reads concurrently. A small pool
 * bounds peak open file handles and resident parsed transcripts regardless of
 * fleet size; see mapWithConcurrency.
 */
export const FLEET_USAGE_READ_CONCURRENCY = 8;

/**
 * Maps `fn` over `items` with at most `limit` calls in flight at once, keeping
 * results in input order. The fleet-usage endpoint reads one transcript per
 * session, so an unbounded Promise.all over every session (especially `?all=1`,
 * every session ever recorded) would open a file handle and stream a transcript
 * for all of them at once — EMFILE and a memory spike on a large fleet. A fixed
 * worker pool caps concurrent reads to `limit`, trading a little latency on the
 * occasionally-opened cost view for bounded resource use. A non-positive
 * `limit` is clamped to one worker.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const workerCount = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
