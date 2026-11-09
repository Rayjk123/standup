import type { Database } from "bun:sqlite";
import type { ScopeAudience } from "../knowledge/types.js";
import {
  CODE_KNOWLEDGE_KINDS,
  retrieveKnowledgeOfKinds,
  retrieveProductKnowledge,
  buildInjectionBlock,
} from "./inject.js";

/** Launch-time injection never applies the confidence floor. */
export const REVERIFY_ACTIVE_AT_LAUNCH = false;

export interface LaunchRequest {
  task: string;
  audience: ScopeAudience;
  cwd: string;
  model: string;
  effort: "low" | "medium" | "high";
}

export interface LaunchPlan {
  prompt: string;
  injectedSlugs: string[];
}

export async function launchSession(db: Database, req: LaunchRequest): Promise<LaunchPlan> {
  const gate = { reverifyActive: REVERIFY_ACTIVE_AT_LAUNCH };
  const code = await retrieveKnowledgeOfKinds(db, req.task, req.audience, CODE_KNOWLEDGE_KINDS, gate);
  const product = await retrieveProductKnowledge(db, req.task, req.audience, gate);

  const prompt = [
    buildInjectionBlock("Relevant code knowledge", code),
    buildInjectionBlock("Product context", product),
    `## Task\n\n${req.task}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  console.log(`[launcher] injected ${code.length} code, ${product.length} product`);
  return { prompt, injectedSlugs: [...code, ...product].map((h) => `${h.doc.projectId}/${h.doc.slug}`) };
}
