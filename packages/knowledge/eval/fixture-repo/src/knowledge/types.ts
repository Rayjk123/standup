export type SourceKind = "code" | "product" | "spec" | "decision" | "runbook" | "native-memory";
export type Scope = "global" | "project" | "user";
export type OriginClass = "owner" | "agent" | "untrusted";
export type Verdict = "unverified" | "clean" | "disputed" | "contradicted" | "superseded";

export interface KnowledgeDoc {
  id: string;
  projectId: string;
  slug: string;
  title: string;
  body: string;
  tags?: string[];
  sourceKind: SourceKind;
  scope: Scope;
  ownerUser?: string;
  originClass: OriginClass;
  confidence?: number;
  lastVerifiedAt?: string;
  halfLifeDays?: number;
  verdict: Verdict;
  updatedAt: Date;
}

export interface ScopeAudience {
  projectId: string;
  user?: string;
}

export interface SearchHit {
  doc: KnowledgeDoc;
  /** Fused RRF score; ordering key. */
  score: number;
  /** 0.4 * batch-normalized text score + 0.6 * cosine. Shown to agents as "relevance". */
  rawScore: number;
  excerpt: string;
}

export interface SearchOptions {
  audience: ScopeAudience;
  limit?: number;
  kinds?: SourceKind[];
  corpus?: "project" | "all";
  graphRerank?: boolean;
}
