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
}
