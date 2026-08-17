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
}

export interface DraftFrontmatter extends KnowledgeFrontmatter {
  generated_by_launch_id?: string;
  replaces_slug?: string;
}
