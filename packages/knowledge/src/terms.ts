// Query tokenization shared by retrieval: the code search picks its ripgrep
// terms from here, and extractExcerpt anchors the returned excerpt on them.
// Both want the same thing from a natural-language question — the
// discriminating words, stopwords dropped — so they draw from one definition
// rather than two that can drift apart.

// Words that match everything and therefore rank nothing. Dropped before
// building the code search so results reflect the question's actual subject,
// dropped from the knowledge FTS query (see buildOrQuery in search.ts), and
// dropped before choosing an excerpt anchor, so a "How/What/Why …" question
// doesn't anchor the excerpt on a ubiquitous substring.
const STOPWORDS = new Set([
  "a","an","the","is","are","was","were","be","been","being","do","does","did",
  "how","what","why","when","where","which","who","whom","whose","this","that",
  "these","those","i","we","you","it","its","of","in","on","at","to","for",
  "with","from","by","about","as","into","and","or","but","if","then","than",
  "so","not","no","can","could","should","would","will","just","use","used",
  "using","get","gets","work","works","working","here","there","our","my",
]);

/** Whether `word` (any case) is a stopword. */
export function isStopword(word: string): boolean {
  return STOPWORDS.has(word.toLowerCase());
}

export function extractTerms(question: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];

  for (const raw of question.toLowerCase().split(/[^a-z0-9_]+/)) {
    const term = raw.trim();
    if (term.length < 3 || STOPWORDS.has(term) || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }

  // Longer terms are more discriminating; cap so the regex stays cheap.
  return terms.sort((a, b) => b.length - a.length).slice(0, 8);
}
