import type { Database } from "bun:sqlite";
import type { ScopeAudience, SearchHit, SourceKind } from "../knowledge/types.js";
import { searchKnowledge } from "../knowledge/search.js";
import { deriveConfidence, CONFIDENCE_FLOOR } from "../knowledge/confidence.js";

/** Kinds rendered under "Relevant code knowledge" in a launch prompt. */
export const CODE_KNOWLEDGE_KINDS: SourceKind[] = ["code", "decision", "runbook", "native-memory"];

/** Kinds rendered under "Product context" in a launch prompt. */
export const PRODUCT_KNOWLEDGE_KINDS: SourceKind[] = ["product", "spec"];

/** Candidates fetched per block before gating. */
export const INJECT_OVERFETCH = 12;
/** Docs kept per block after gating. */
export const INJECT_KEEP = 3;

const BLOCK_CHAR_BUDGET = 4000;

export interface InjectGateOptions {
  reverifyActive: boolean;
}

/**
 * Retrieves the top docs of the given kinds for a launch task. Candidates are
 * gated on origin class, verdict and (when re-verify is active) confidence;
 * there is no relevance floor, so the top INJECT_KEEP survivors are injected
 * whatever their score.
 */
export async function retrieveKnowledgeOfKinds(
  db: Database,
  task: string,
  audience: ScopeAudience,
  kinds: SourceKind[],
  gate: InjectGateOptions
): Promise<SearchHit[]> {
  const candidates = await searchKnowledge(db, task, { audience, kinds, limit: INJECT_OVERFETCH });
  return candidates
    .filter((h) => h.doc.originClass !== "untrusted")
    .filter((h) => h.doc.verdict !== "contradicted" && h.doc.verdict !== "superseded")
    .filter((h) => !gate.reverifyActive || (deriveConfidence(h.doc) ?? 1) >= CONFIDENCE_FLOOR)
    .slice(0, INJECT_KEEP);
}

export function retrieveProductKnowledge(
  db: Database,
  task: string,
  audience: ScopeAudience,
  gate: InjectGateOptions
): Promise<SearchHit[]> {
  return retrieveKnowledgeOfKinds(db, task, audience, PRODUCT_KNOWLEDGE_KINDS, gate);
}

export function buildInjectionBlock(heading: string, hits: SearchHit[]): string {
  if (hits.length === 0) return "";
  let out = `## ${heading}\n\nGROUND your implementation in these docs:\n\n`;
  for (const h of hits) {
    const section = `### [${h.doc.sourceKind}] ${h.doc.title}\n${h.doc.body}\n\n`;
    if (out.length + section.length > BLOCK_CHAR_BUDGET) break;
    out += section;
  }
  return out;
}
