import {
  codeReviewTerms,
  MODEL_REWRITE_SYSTEM_PROMPT,
  modelRewritePrompt,
  parseModelRewrite,
  planInjection,
  setCodeReviewTerms,
  type InjectionPlan,
} from "@standup/knowledge";
import { runClaudeText, type RunClaudeOptions } from "./claude-cli.js";
import { INJECTION_QUERY_CWD } from "./internal-cwd.js";
import type { OrgProfile } from "./org-profile/types.js";

/**
 * Adds the org profile's code-review noun (`codeReview.noun`, e.g. `changeset`) to
 * the review words the injection plan reads: a brief that forbids opening one
 * leaves code-review runbooks out, and "review the <noun>" reads as a review
 * task. A profile with no noun leaves the built-in words alone, and so does a
 * noun that is an everyday word (GENERIC_REVIEW_NOUNS): with `change` as a
 * term, "don't change the API" would forbid the code_review action and leave
 * out every runbook titled with the word.
 *
 * Returns a function that puts back the terms in force before the call.
 */
export function applyOrgReviewTerms(profile: OrgProfile): () => void {
  const before = codeReviewTerms();
  const noun = profile.codeReview.noun?.trim();
  setCodeReviewTerms(noun && !GENERIC_REVIEW_NOUNS.has(noun.toLowerCase()) ? [noun] : []);
  return () => setCodeReviewTerms(before);
}

/** Review nouns too common in prose to read as naming a code review on their own. */
export const GENERIC_REVIEW_NOUNS: ReadonlySet<string> = new Set([
  "change",
  "changes",
  "review",
  "reviews",
  "diff",
  "diffs",
  "patch",
  "patches",
  "commit",
  "commits",
  "request",
  "requests",
  "revision",
  "revisions",
  "submission",
  "submissions",
]);

/**
 * The launch brief → injection plan step (see the knowledge package's
 * query-rewrite.ts). The heuristic plan is always available; with
 * STANDUP_INJECTION_QUERY_MODEL=1 a cheap model call proposes the focused
 * queries and the task type instead, and any failure of that call — a timeout,
 * a non-zero exit, an answer that is not the strict JSON shape — falls back to
 * the heuristic plan.
 */

/** The env flag that turns the model rewrite on; anything but "1" leaves it off. */
export const INJECTION_QUERY_MODEL_ENV = "STANDUP_INJECTION_QUERY_MODEL";

/** The model the rewrite runs on. */
export const INJECTION_QUERY_MODEL = "claude-haiku-4-5-20251001";

/** How long the launch waits for the model rewrite before using the heuristic plan. */
export const INJECTION_QUERY_MODEL_TIMEOUT_MS = 8_000;

/** Runs one model call and returns its text, or null on any failure (runClaudeText's contract). */
export type RewriteModelCall = (prompt: string) => Promise<string | null>;

/**
 * The most restricted headless call: no tools, `--bare` (no CLAUDE.md, memory,
 * hooks or plugins), no MCP servers, thinking off, a fixed system prompt, from
 * a reserved internal cwd so its own hooks never register a session.
 */
export const INJECTION_QUERY_CALL_OPTIONS: RunClaudeOptions = {
  model: INJECTION_QUERY_MODEL,
  cwd: INJECTION_QUERY_CWD,
  timeoutMs: INJECTION_QUERY_MODEL_TIMEOUT_MS,
  tools: "",
  bare: true,
  noThinking: true,
  systemPrompt: MODEL_REWRITE_SYSTEM_PROMPT,
};

const defaultModelCall: RewriteModelCall = (prompt) => runClaudeText(prompt, INJECTION_QUERY_CALL_OPTIONS);

/** Whether the model rewrite is on for this process. */
export function isInjectionQueryModelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[INJECTION_QUERY_MODEL_ENV]?.trim() === "1";
}

/**
 * The injection plan for a launch brief: the model rewrite when it is enabled
 * and answers in shape, else the heuristic. Never throws.
 */
export async function rewriteInjectionQueries(
  brief: string,
  opts: { env?: NodeJS.ProcessEnv; callModel?: RewriteModelCall } = {}
): Promise<InjectionPlan> {
  if (!isInjectionQueryModelEnabled(opts.env)) return planInjection(brief);
  try {
    const answer = await (opts.callModel ?? defaultModelCall)(modelRewritePrompt(brief));
    return planInjection(brief, parseModelRewrite(answer));
  } catch {
    return planInjection(brief);
  }
}
