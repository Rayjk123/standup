import type { Database } from "bun:sqlite";
import type { ScopeAudience, SearchHit } from "../knowledge/types.js";
import { searchKnowledge } from "../knowledge/search.js";
import { passesConfidenceFloor } from "../knowledge/confidence.js";
import { GLOBAL_PROJECT_ID } from "../knowledge/scope.js";
import { runRipgrep, type RgMatch } from "./ripgrep.js";
import { synthesizeAnswer, type ContextItem } from "./synthesize.js";

/** Minimum rawScore for a knowledge hit to be considered at all. */
export const RELEVANCE_FLOOR = 0.15;
/** Number of items returned to the caller as "Sources". */
export const MAX_SOURCES = 6;
/** Model used to synthesize the answer. */
export const SYNTH_MODEL = "claude-haiku-4-5";
/** Hits taken from the asking project's partition. */
export const PROJECT_LIMIT = 4;
/** Hits taken from the reserved global project's partition. */
export const GLOBAL_LIMIT = 4;
/** Items handed to the synthesizer. */
export const MAX_CONTEXT_DOCS = 10;

export interface ExpertAnswer {
  answer: string;
  sources: string[];
}

/**
 * ask_expert: a project-partition search plus a reserved-global search, a
 * ripgrep keyword arm over the caller's cwd, then a Haiku synthesis over the
 * merged context. Knowledge hits are scaled into [1, 3] and code hits into
 * roughly [0, 1.6] before the merge.
 */
export async function askExpert(
  db: Database,
  question: string,
  audience: ScopeAudience,
  cwd: string
): Promise<ExpertAnswer> {
  const projectHits = await searchKnowledge(db, question, { audience, limit: PROJECT_LIMIT, corpus: "project" });
  const globalHits = await searchKnowledge(db, question, {
    audience: { projectId: GLOBAL_PROJECT_ID, user: audience.user },
    limit: GLOBAL_LIMIT,
    corpus: "project",
  });

  const knowledge = [...projectHits, ...globalHits]
    .filter((h) => h.rawScore >= RELEVANCE_FLOOR)
    .filter((h) => h.doc.verdict !== "contradicted" && h.doc.verdict !== "superseded")
    .filter((h) => passesConfidenceFloor(h.doc));

  let code: RgMatch[] = [];
  try {
    code = await runRipgrep(keywordPattern(question), cwd);
  } catch (err) {
    console.error("[expert] ripgrep arm failed", err);
  }

  const ranked = mergeRanked(knowledge, code);
  const context = ranked.slice(0, MAX_CONTEXT_DOCS);
  const answer = await synthesizeAnswer(question, context, SYNTH_MODEL, cwd);
  return { answer, sources: ranked.slice(0, MAX_SOURCES).map((c) => c.label) };
}

function keywordPattern(question: string): string {
  const ids = question.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) ?? [];
  return ids.slice(0, 6).join("|");
}

function mergeRanked(knowledge: SearchHit[], code: RgMatch[]): (ContextItem & { weight: number })[] {
  const maxRaw = Math.max(...knowledge.map((h) => h.rawScore), 0.0001);
  const k = knowledge.map((h) => ({
    label: `${h.doc.projectId}/${h.doc.slug}`,
    text: h.doc.body.slice(0, 4000),
    weight: 1 + 2 * (h.rawScore / maxRaw),
  }));
  const c = code.map((m, i) => ({
    label: `${m.path}:${m.line}`,
    text: m.text,
    weight: 1.6 * (1 - i / Math.max(code.length, 1)),
  }));
  return [...k, ...c].sort((a, b) => b.weight - a.weight);
}
