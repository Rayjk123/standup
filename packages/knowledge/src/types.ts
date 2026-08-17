export interface KnowledgeDoc {
  id: string;
  projectId: string;
  slug: string;
  title: string;
  body: string;
  tags?: string[];
  embedding?: number[];
  updatedAt: Date;
  filePath: string;
  // Provenance, carried in frontmatter when a draft is accepted (see
  // acceptDraftFile). NULL for a human-authored doc — Step 6's staleness
  // check keys "is this generated" off exactly that distinction, so this
  // must stay undefined rather than "" when absent.
  generatedFromSha?: string;
  generatedAt?: string;
}

export interface KnowledgeChunk {
  id: string;
  knowledgeId: string;
  chunkIndex: number;
  text: string;
  embedding: number[];
}

export interface KnowledgeFrontmatter {
  title?: string;
  tags?: string[];
  generated_from_sha?: string;
  generated_at?: string;
}

/**
 * Result of an adversarial fact-check pass (see collector's draft-verify.ts,
 * which is the only writer of this state). Mirrored here rather than
 * imported from the collector — this package has no dependency on it, and
 * the shape is a plain data contract, not behavior worth sharing.
 */
export type DraftVerdict = "unverified" | "clean" | "disputed" | "error";

export interface DraftDispute {
  /** The claim as the draft states it, quoted closely enough to find. */
  claim: string;
  /** What checking actually showed. */
  finding: string;
  /** The command run, so a human can re-check rather than trust this. */
  evidence: string;
}

/**
 * A draft: a proposed doc awaiting human review. Deliberately has no
 * `embedding` field and no chunk relation — see store.ts's ensureTables for
 * why that absence is load-bearing rather than an oversight.
 */
export interface KnowledgeDraft {
  id: string;
  projectId: string;
  slug: string;
  title: string;
  body: string;
  tags?: string[];
  filePath: string;
  updatedAt: Date;
  generatedFromSha?: string;
  generatedAt?: string;
  generatedByLaunchId?: string;
  // Set when this draft would overwrite an existing accepted doc on accept —
  // NULL on a first bootstrap. See phase-7.md Step 5 for how review renders
  // this (preview vs. diff).
  replacesSlug?: string;
  // 'unverified' until draft-verify.ts's background pass reports back —
  // never inferred as 'clean' by default, because the two look identical in
  // review otherwise and the whole point of the pass is knowing which it is.
  verdict: DraftVerdict;
  disputes: DraftDispute[];
}

export interface DraftFrontmatter extends KnowledgeFrontmatter {
  generated_by_launch_id?: string;
  replaces_slug?: string;
}
