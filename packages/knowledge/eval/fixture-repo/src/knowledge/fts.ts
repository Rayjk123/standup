/**
 * Full-text query construction for the knowledge_fts (FTS5) table.
 *
 * The table is created with the default unicode61 tokenizer, so there is no
 * stemming: "PRs" and "PR" are different terms, as are "deploy" and "deploys".
 */
export const FTS_TOKENIZER = "unicode61";

/**
 * Builds an FTS5 MATCH expression from free text. Every word is quoted and the
 * words are OR-joined; stopwords are kept, so "how do I" contributes three
 * terms to the bm25 sum.
 */
export function buildFtsQuery(text: string): string {
  const words = text
    .split(/[^\p{L}\p{N}_]+/u)
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
  if (words.length === 0) return "";
  return words.map((w) => `"${w.replace(/"/g, '""')}"`).join(" OR ");
}
