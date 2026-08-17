import type { Project } from "@standup/shared";

/**
 * TODO(phase-7 Step 4, Opus): This is a placeholder, not a draft. The real
 * research prompt is its own step for a reason — plan/phase-7.md's Step 4
 * says the whole phase lives or dies on it, since deciding what NOT to
 * write is the actual task, and a prompt that looks finished but is wrong
 * fails silently (a knowledge base full of plausible, slowly-rotting
 * summaries) rather than loudly. Read plan/phase-7.md's Step 4 section in
 * full — including the worked example prompt and the two "why" notes below
 * it — before replacing this function's body. Do not improvise content here.
 *
 * Step 3 only needs *some* string to pass as `task` so the bootstrap launch
 * route can be exercised end to end; this is deliberately inert and easy to
 * tell apart from a real prompt at a glance.
 */
export function bootstrapPrompt(project: Project): string {
  return [
    `PLACEHOLDER TASK — phase-7 Step 4 has not been implemented yet.`,
    ``,
    `This is a stub prompt for a knowledge-bootstrap run against the "${project.name}" project.`,
    `It exists only so the bootstrap launch route (Step 3) has a task string to pass`,
    `to \`claude\`. It is NOT the real research prompt — see plan/phase-7.md's Step 4`,
    `for what belongs here (the many-files test, the propose_knowledge deliverables,`,
    `the stub-vs-prose split between overview.md/connections.md and the rest).`,
    ``,
    `If you are an agent reading this as your actual task: stop, call \`checkpoint\``,
    `noting that the real prompt is missing, and do not call \`propose_knowledge\`.`,
  ].join("\n");
}
