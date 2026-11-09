import { claudeDecider, type RunModel } from "./decider/claude.js";
import { runDecision, type DecisionContext } from "./decider/run.js";
import type { Decider, DecisionRequest } from "./decider/types.js";

/**
 * Best-effort, launch-time inference of the real project a project-less launch
 * belongs to.
 *
 * A launch started without a project runs in `scratch` (see the launcher's
 * scratch path). That's a safe default but a poor home: the work almost always
 * belongs to one of the registered projects. This asks the Decider port
 * (decider/) to match the launch's task + working directory against the
 * registered projects' names and repo paths and name the single most likely
 * one, through a cheap Haiku call on the auto-checkpoint model wiring (Haiku,
 * no tools, short timeout).
 * It is deliberately conservative: if the answer isn't a clean match
 * for exactly one registered project, the session stays in `scratch` rather
 * than being guessed into the wrong one.
 */

/** The subset of a project the matcher reasons over. */
export interface ProjectCandidate {
  id: string;
  name: string;
  repos: string[];
}

export interface InferMainProjectInput {
  /** The launched agent's opening task — the strongest signal. */
  task: string;
  /** Where the launch is running (a scratch dir carries little signal, but repo-rooted cwds do). */
  cwd: string;
  /** Registered projects to match against; `scratch` should be excluded by the caller. */
  candidates: ProjectCandidate[];
}

/** Matches auto-checkpoint's cheap-model calls; one call, then it's done. */
const INFER_TIMEOUT_MS = 20_000;
const MAX_TASK_CHARS = 4_000;

/**
 * Builds the matcher prompt: the task, the cwd, and a list of the candidate
 * projects with their ids, names, and repo paths. The model is asked to answer
 * with exactly one id or the literal NONE, which is what lets a low-confidence
 * or ambiguous result fall through to `scratch`.
 */
export function buildInferencePrompt(input: InferMainProjectInput): string {
  const list = input.candidates
    .map((c) => {
      const repos = c.repos.length ? c.repos.join(", ") : "(no repos configured)";
      return `- id: ${c.id}\n  name: ${c.name}\n  repos: ${repos}`;
    })
    .join("\n");

  return (
    "An AI coding agent was just launched with the task below but no project " +
    "assigned. Decide which ONE of the registered projects the task most " +
    "likely belongs to, by matching the task and working directory against " +
    "each project's name and repo paths.\n\n" +
    "Reply with ONLY the project's id, exactly as written below. If no project " +
    "is a clear match, or two or more are equally plausible, reply with exactly " +
    "NONE — do not guess.\n\n" +
    `Task:\n${input.task.slice(0, MAX_TASK_CHARS)}\n\n` +
    `Working directory:\n${input.cwd}\n\n` +
    `Registered projects:\n${list}`
  );
}

/**
 * Maps the model's raw answer to a candidate id, or null when it declined
 * (NONE), returned nothing, or named something that isn't exactly one of the
 * candidates. Pure, so the branch logic is unit-testable without a model call.
 *
 * Accepts the model naming a project by its exact id OR its exact name
 * (case-insensitive), mapping a name back to its id; an id match wins over a
 * name match. Either way the match must be UNIQUE — an ambiguous answer, or one
 * that isn't a clean match for exactly one project, stays in `scratch`, because
 * the point of the feature is a stable default rather than a guess.
 */
export function resolveInferredProject(
  raw: string | null,
  candidates: ProjectCandidate[]
): string | null {
  if (!raw) return null;

  // Take the first non-empty line and strip wrapping quotes/backticks and
  // trailing punctuation the model may add despite the instruction.
  const answer = (raw.split("\n").find((l) => l.trim()) ?? "")
    .replace(/^["'`]+|["'`.]+$/g, "")
    .trim()
    .toLowerCase();

  if (!answer || answer === "none") return null;

  const byId = candidates.filter((c) => c.id.toLowerCase() === answer);
  if (byId.length === 1) return byId[0].id;
  if (byId.length === 0) {
    const byName = candidates.filter((c) => c.name.trim().toLowerCase() === answer);
    if (byName.length === 1) return byName[0].id;
  }
  return null;
}

/** The option that keeps a launch in scratch. */
export const NO_PROJECT = "NONE";

/**
 * The project-routing decision as the Decider port asks it: the task as state,
 * one option per candidate (its name and repos), and NONE. The answer is always
 * one of these keys. The claude backend prompts with buildInferencePrompt,
 * which also carries the cwd.
 *
 * The cwd stays out of the state. A project-less launch's cwd is its scratch
 * dir (`…/scratch/<slug>`), which carries no signal but reads as "keep the task
 * in scratch" and pulls a decision model toward NONE.
 */
export function buildProjectDecision(input: InferMainProjectInput): DecisionRequest {
  const options: Record<string, string> = {};
  for (const c of input.candidates) {
    if (c.id === NO_PROJECT) continue;
    options[c.id] = c.repos.length ? `${c.name} (repos: ${c.repos.join(", ")})` : c.name;
  }
  options[NO_PROJECT] = "None of these projects clearly fits, or several fit equally; keep the task in scratch.";
  return {
    kind: "project",
    state: input.task.slice(0, MAX_TASK_CHARS),
    question: "Which registered project does this task belong to?",
    options,
  };
}

/** The claude backend for project routing: today's prompt and matcher. */
export function projectClaudeDecider(input: InferMainProjectInput, runModel?: RunModel): Decider {
  return claudeDecider({
    runModel,
    prompt: () => buildInferencePrompt(input),
    parse: (raw) => {
      const resolved = resolveInferredProject(raw, input.candidates);
      const firstLine = raw.split("\n").find((l) => l.trim())?.trim() ?? "";
      return { choice: resolved ?? NO_PROJECT, confidence: null, reason: firstLine };
    },
  });
}

/** Where a routing decision is recorded and whose routing applies. */
export type InferContext = DecisionContext;

/**
 * Runs the inference through the Decider port with the claude matcher.
 * `runModel` is injectable so tests can exercise it without spawning a model.
 * Never throws — no answer, or NONE, resolves to null (stay in scratch).
 *
 * Logs its decision at every outcome so an operator can always see what
 * inference decided and why a project-less launch did or didn't get re-homed:
 * `[infer] matched <id>` on a confident single match, `[infer] declined
 * (NONE/ambiguous) raw="<first line>"` when the backend declined or named
 * nothing usable, and `[infer] error <msg>` when no backend answered.
 */
export async function inferMainProject(
  input: InferMainProjectInput,
  runModel?: RunModel,
  ctx: InferContext = {}
): Promise<string | null> {
  if (input.candidates.length === 0 || !input.task.trim()) return null;

  const outcome = await runDecision(ctx, buildProjectDecision(input), {
    claude: projectClaudeDecider(input, runModel),
    claudeTimeoutMs: INFER_TIMEOUT_MS,
  });
  if (!outcome.answer) {
    console.log(`[infer] error ${outcome.detail ?? "no answer"}`);
    return null;
  }
  const { choice, reason } = outcome.answer;
  const resolved = choice === NO_PROJECT ? null : input.candidates.find((c) => c.id === choice)?.id ?? null;
  if (resolved) {
    console.log(`[infer] matched ${resolved}`);
  } else {
    console.log(`[infer] declined (NONE/ambiguous) raw="${reason ?? choice}"`);
  }
  return resolved;
}
