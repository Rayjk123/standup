import type { KnowledgeDoc } from "./types.js";
import { runClaudeHeadless } from "../synth/claude-headless.js";

/** Composite similarity at or above which a proposal is treated as a duplicate. */
export const DEDUP_THRESHOLD = 0.95;

export interface DuplicateMatch {
  slug: string;
  composite: number;
}

/**
 * Finds existing docs a proposal duplicates. Only docs in the proposal's own
 * project are compared.
 */
export function findDuplicates(
  proposal: KnowledgeDoc,
  existing: KnowledgeDoc[],
  composite: (a: KnowledgeDoc, b: KnowledgeDoc) => number
): DuplicateMatch[] {
  return existing
    .filter((d) => d.projectId === proposal.projectId && d.slug !== proposal.slug)
    .map((d) => ({ slug: d.slug, composite: composite(proposal, d) }))
    .filter((m) => m.composite >= DEDUP_THRESHOLD);
}

export interface ContradictionJudgement {
  contradicts: boolean;
  rationale: string;
}

/**
 * Asks the judge model whether two accepted docs make opposing claims. Any
 * failure of the judge (including a Bedrock 403) is returned as "no
 * contradiction".
 */
export async function judgeContradiction(a: KnowledgeDoc, b: KnowledgeDoc): Promise<ContradictionJudgement> {
  const prompt =
    `Do these two documents make claims that directly contradict each other? ` +
    `Answer JSON {"contradicts": boolean, "rationale": string}.\n\n# A: ${a.title}\n${a.body}\n\n# B: ${b.title}\n${b.body}`;
  try {
    const out = await runClaudeHeadless(prompt, { model: "claude-haiku-4-5" });
    return JSON.parse(out) as ContradictionJudgement;
  } catch {
    return { contradicts: false, rationale: "" };
  }
}
