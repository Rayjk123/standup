export { KnowledgeStore } from "./store.js";
export { KnowledgeLoader } from "./loader.js";
export { searchKnowledge, type SearchResult } from "./search.js";
export {
  generateEmbedding,
  chunkText,
  embedChunks,
  type EmbeddingProvider,
} from "./embeddings.js";
export type {
  KnowledgeDoc,
  KnowledgeChunk,
  KnowledgeDraft,
  DraftVerdict,
  DraftDispute,
} from "./types.js";
export {
  listKnowledgeFiles,
  readKnowledgeFile,
  writeKnowledgeFile,
  deleteKnowledgeFile,
  writeDraftFile,
  acceptDraftFile,
  deleteDraftFile,
  isValidSlug,
  type KnowledgeDocFile,
  type KnowledgeDocInput,
  type KnowledgeDraftInput,
} from "./writer.js";
