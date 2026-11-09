import type { LaunchSuggestion } from "@standup/shared";
import { claudeDecider, type RunModel } from "./claude.js";
import { runDecision, type DecisionContext, type DecisionOutcome } from "./run.js";
import type { DecisionRequest } from "./types.js";

/**
 * Effort and model suggestions for a launch task. These are suggestion-only
 * decisions (SUGGESTION_ONLY_KINDS): the composer shows them next to its own
 * pickers and nothing applies them to a launch.
 */

const MAX_TASK_CHARS = 4_000;
const SUGGEST_CLAUDE_TIMEOUT_MS = 20_000;

export const EFFORT_OPTIONS: Record<string, string> = {
  low: "Trivial or mechanical: a lookup, a one-line fix, a rename, a quick question, a status check.",
  medium: "A routine, well-scoped change: a bug fix or small feature in one area, with tests.",
  high: "Hard or open-ended: cross-cutting design, multi-package changes, deep debugging, or research that needs measurements.",
};

export const MODEL_OPTIONS: Record<string, string> = {
  haiku: "Fast and cheap: simple lookups, summaries, formatting, mechanical edits.",
  sonnet: "Everyday coding: implement or fix a well-specified change.",
  opus: "The hardest work: architecture and design, ambiguous research, tricky debugging, security-sensitive judgment.",
};

export function effortDecision(task: string): DecisionRequest {
  return {
    kind: "effort",
    state: task.slice(0, MAX_TASK_CHARS),
    question: "How much reasoning effort does an AI coding agent need for this task?",
    options: EFFORT_OPTIONS,
  };
}

export function modelDecision(task: string): DecisionRequest {
  return {
    kind: "model",
    state: task.slice(0, MAX_TASK_CHARS),
    question: "Which model should run this task?",
    options: MODEL_OPTIONS,
  };
}

function summarize(outcome: DecisionOutcome): LaunchSuggestion["effort"] {
  return {
    choice: outcome.answer?.choice ?? null,
    confidence: outcome.answer?.confidence ?? null,
    backend: outcome.backend,
    latencyMs: Math.round(outcome.latencyMs),
  };
}

/** Suggests an effort and a model for `task`, both at once. Never throws. */
export async function suggestLaunchSettings(
  ctx: DecisionContext,
  task: string,
  deps: { runModel?: RunModel } = {}
): Promise<LaunchSuggestion> {
  const claude = claudeDecider({ runModel: deps.runModel });
  const backends = { claude, claudeTimeoutMs: SUGGEST_CLAUDE_TIMEOUT_MS };
  const [effort, model] = await Promise.all([
    runDecision(ctx, effortDecision(task), backends),
    runDecision(ctx, modelDecision(task), backends),
  ]);
  return { effort: summarize(effort), model: summarize(model) };
}
