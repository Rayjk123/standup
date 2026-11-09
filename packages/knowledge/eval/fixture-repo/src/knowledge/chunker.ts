/** Target size of one chunk, in characters. */
export const CHUNK_TARGET_CHARS = 512;

/** Words carried from the end of one chunk into the start of the next. */
export const CHUNK_OVERLAP_WORDS = 10;

const SENTENCE_END = /(?<=[.!?])\s+/;

/**
 * Splits a doc body into ~512-character chunks on sentence boundaries, with a
 * 10-word overlap between neighbours. Markdown structure (headings, fences) is
 * not considered, and the doc title is not prefixed to any chunk.
 */
export function chunkText(body: string): string[] {
  const sentences = body.split(SENTENCE_END).filter((s) => s.trim().length > 0);
  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    if (current.length > 0 && current.length + sentence.length + 1 > CHUNK_TARGET_CHARS) {
      chunks.push(current.trim());
      const tail = current.trim().split(/\s+/).slice(-CHUNK_OVERLAP_WORDS).join(" ");
      current = `${tail} ${sentence}`;
    } else {
      current = current.length > 0 ? `${current} ${sentence}` : sentence;
    }
  }
  if (current.trim().length > 0) chunks.push(current.trim());
  return chunks;
}
