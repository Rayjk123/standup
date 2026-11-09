import { runModel as runCheapModel } from "../auto-checkpoint.js";
import { DeciderError, shortError, type Decider, type DeciderAnswer, type DecisionRequest } from "./types.js";

/**
 * The `claude` backend: one headless `claude -p` call (the cheap-model helper
 * auto-checkpoint uses: no tools, the reserved cwd, its default model unless
 * STANDUP_DECIDER_MODEL names another).
 *
 * A decision with an established prompt and parser passes them in, so it
 * behaves exactly as the decision always did. Without them it asks the
 * generic routing-classifier prompt and maps the reply onto an option key.
 */

/** Runs one prompt and returns the reply text, or null on any failure. */
export type RunModel = (prompt: string, timeoutMs?: number) => Promise<string | null>;

export interface ClaudeDeciderOptions {
  /** Builds the prompt; defaults to the generic classifier prompt. */
  prompt?: (req: DecisionRequest) => string;
  /**
   * Maps the reply onto an answer, or null when it names no option. Defaults to
   * matching the reply against the option keys.
   */
  parse?: (raw: string, req: DecisionRequest) => DeciderAnswer | null;
  /** The model call; defaults to the shared cheap-model helper. */
  runModel?: RunModel;
}

/** The generic prompt: the state, the question, the options, one key back. */
export function genericClaudePrompt(req: DecisionRequest): string {
  const lines = Object.entries(req.options).map(([key, desc]) => `- ${key}: ${desc}`);
  return (
    "You are a routing classifier inside a developer tool.\n\n" +
    `<request>\n${req.state}\n</request>\n\n` +
    `Question: ${req.question}\n` +
    `Options:\n${lines.join("\n")}\n\n` +
    "Reply with exactly one option key from the list and nothing else."
  );
}

/**
 * Maps a free-text reply onto an option key: exact, then case-insensitive, then
 * the longest key the reply contains. Null when none matches.
 */
export function matchOptionKey(raw: string, options: Record<string, string>): string | null {
  const cleaned = (raw.split("\n").find((l) => l.trim()) ?? "").trim().replace(/^[`'"]+|[`'".]+$/g, "").trim();
  if (!cleaned) return null;
  if (Object.hasOwn(options, cleaned)) return cleaned;
  const keys = Object.keys(options);
  const insensitive = keys.find((k) => k.toLowerCase() === cleaned.toLowerCase());
  if (insensitive) return insensitive;
  const hits = keys.filter((k) => cleaned.toLowerCase().includes(k.toLowerCase()));
  return hits.length ? hits.reduce((a, b) => (b.length > a.length ? b : a)) : null;
}

/**
 * The model the claude backend runs, from STANDUP_DECIDER_MODEL (any
 * `claude --model` value); unset keeps the cheap-model helper's own default,
 * the model these decisions have always used. Read per call, so a changed
 * environment applies on the next decision.
 */
export function deciderClaudeModel(env: Record<string, string | undefined> = process.env): string | undefined {
  return env.STANDUP_DECIDER_MODEL?.trim() || undefined;
}

/** A Decider backed by a headless `claude -p` call. */
export function claudeDecider(options: ClaudeDeciderOptions = {}): Decider {
  const buildPrompt = options.prompt ?? genericClaudePrompt;
  const parse =
    options.parse ??
    ((raw: string, req: DecisionRequest): DeciderAnswer | null => {
      const choice = matchOptionKey(raw, req.options);
      return choice ? { choice, confidence: null } : null;
    });
  const runModel: RunModel =
    options.runModel ??
    ((prompt, timeoutMs) => {
      const model = deciderClaudeModel();
      return runCheapModel(prompt, model ? { model, timeoutMs } : { timeoutMs });
    });

  return {
    backend: "claude",
    async decide(req, { timeoutMs }) {
      let raw: string | null;
      try {
        raw = await runModel(buildPrompt(req), timeoutMs);
      } catch (err) {
        throw new DeciderError("error", shortError(err));
      }
      if (!raw) throw new DeciderError("error", "no reply");
      const answer = parse(raw, req);
      if (!answer || !Object.hasOwn(req.options, answer.choice)) {
        const firstLine = raw.split("\n").find((l) => l.trim())?.trim() ?? "";
        throw new DeciderError("invalid_answer", `unmatched reply "${firstLine.slice(0, 80)}"`);
      }
      return answer;
    },
  };
}
