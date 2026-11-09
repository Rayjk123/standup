/**
 * A pure, dependency-free scanner for knowledge-doc / generated-content quality.
 *
 * It takes a block of text and returns structured findings across three
 * categories — non-inclusive language, common AI-tell / filler phrasing, and
 * run-on sentences. Everything here is computed from the input string alone:
 * no I/O, no database, no network, no model calls, so it is cheap to run on
 * every draft and fully deterministic.
 *
 * The wiring that feeds text in and surfaces findings lives elsewhere; this
 * module is only the validator.
 */

export type CleanlinessCategory =
  | "inclusive-language"
  | "ai-tell"
  | "long-sentence";

export interface CleanlinessFinding {
  category: CleanlinessCategory;
  severity: "high" | "medium" | "low";
  /** Human-readable; names the offending term and the suggested fix. */
  message: string;
  /** The exact substring that matched. */
  match: string;
  /** 0-based char offset into the input where {@link match} starts. */
  index: number;
  /** Replacement text, when the rule has one to offer. */
  suggestion?: string;
}

/**
 * The optional trailing suffix on a stem: possessive ('s), plural (s / es), or
 * verb inflections (-ed / -ing). Straight and curly apostrophes are both
 * accepted. Anything else after the stem (e.g. "ful", "smith") leaves a word
 * character adjacent to the stem, so the closing \b fails and the term does
 * not match.
 */
const STANDARD_SUFFIX = "(?:['’]s|es|ed|ing|s)?";

/**
 * Non-inclusive terms and their mandated replacements. `body` is the regex
 * fragment matched between word boundaries, case-insensitively. The boundaries
 * mean "whitelisted", "blacklisting", and "master's" are caught while
 * "masterful", "blacksmith", "postmaster", and "grandmaster" — which only
 * share a prefix or a suffix — are not.
 */
const INCLUSIVE_TERMS: readonly { body: string; suggestion: string }[] = [
  { body: `master${STANDARD_SUFFIX}`, suggestion: "primary/main/leader/controller" },
  // "slave" drops its silent -e before -ed/-ing ("slaved", "slaving") while
  // still taking plural/possessive endings ("slaves", "slave's").
  { body: "slav(?:e(?:['’]s|s|d)?|ing)", suggestion: "replica/secondary/follower/responder" },
  { body: `whitelist${STANDARD_SUFFIX}`, suggestion: "allowlist/approved list/inclusion list" },
  { body: `blacklist${STANDARD_SUFFIX}`, suggestion: "denylist/blocklist/exclusion list" },
  { body: `whiteday${STANDARD_SUFFIX}`, suggestion: "clear day(s)/allowed day(s)" },
  { body: `blackday${STANDARD_SUFFIX}`, suggestion: "blocked day(s)" },
];

const INCLUSIVE_MATCHERS: readonly { regex: RegExp; suggestion: string }[] =
  INCLUSIVE_TERMS.map((term) => ({
    regex: new RegExp(`\\b${term.body}\\b`, "gi"),
    suggestion: term.suggestion,
  }));

/**
 * Curated filler / "AI-tell" phrases. Matched case-insensitively as whole
 * phrases (word boundaries on any alphanumeric edge) so that, for example,
 * "as an ai" does not fire inside "has an aid". Phrases that end in a comma
 * carry no trailing boundary.
 */
const AI_TELL_PHRASES: readonly string[] = [
  "as an ai",
  "as a language model",
  "i cannot",
  "delve into",
  "it's worth noting that",
  "it is worth noting that",
  "in conclusion",
  "furthermore,",
  "moreover,",
  "it's important to note",
  "it is important to note",
  "rest assured",
  "i hope this helps",
];

const AI_TELL_MATCHERS: readonly RegExp[] = AI_TELL_PHRASES.map(aiTellRegex);

/** Sentences with more than this many words are flagged as run-ons. */
const LONG_SENTENCE_WORD_LIMIT = 40;

/**
 * Words that commonly precede a period without ending a sentence. Used, along
 * with single-letter initials, to avoid splitting on abbreviation dots.
 */
const SENTENCE_ABBREVIATIONS: ReadonlySet<string> = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
  "sr",
  "jr",
  "st",
  "vs",
  "etc",
  "eg",
  "ie",
  "al",
  "inc",
  "ltd",
  "co",
  "no",
  "fig",
  "approx",
]);

/** Longest guarded abbreviation; bounds how far the guard scans backward. */
const LONGEST_ABBREVIATION = Math.max(
  ...[...SENTENCE_ABBREVIATIONS].map((word) => word.length)
);

/** Tie-break order when two findings share an offset, for deterministic output. */
const CATEGORY_ORDER: Record<CleanlinessCategory, number> = {
  "inclusive-language": 0,
  "ai-tell": 1,
  "long-sentence": 2,
};

/**
 * Scans {@link text} and returns every quality finding, sorted by the offset
 * at which it occurs (ties broken by category for a stable, deterministic
 * order). Empty input yields an empty array.
 */
export function validateCleanliness(text: string): CleanlinessFinding[] {
  if (text.length === 0) return [];

  const findings: CleanlinessFinding[] = [];
  collectInclusiveLanguage(text, findings);
  collectAiTells(text, findings);
  collectLongSentences(text, findings);

  findings.sort(
    (a, b) =>
      a.index - b.index || CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category]
  );
  return findings;
}

function collectInclusiveLanguage(
  text: string,
  out: CleanlinessFinding[]
): void {
  for (const matcher of INCLUSIVE_MATCHERS) {
    for (const m of text.matchAll(matcher.regex)) {
      const match = m[0];
      out.push({
        category: "inclusive-language",
        severity: "high",
        message: `Non-inclusive term "${match}" — use ${matcher.suggestion} instead.`,
        match,
        index: m.index ?? 0,
        suggestion: matcher.suggestion,
      });
    }
  }
}

function collectAiTells(text: string, out: CleanlinessFinding[]): void {
  for (const regex of AI_TELL_MATCHERS) {
    for (const m of text.matchAll(regex)) {
      const match = m[0];
      out.push({
        category: "ai-tell",
        severity: "low",
        message: `AI-tell / filler phrase "${match}" — remove it or rephrase for a more direct tone.`,
        match,
        index: m.index ?? 0,
      });
    }
  }
}

function collectLongSentences(text: string, out: CleanlinessFinding[]): void {
  for (const sentence of splitSentences(text)) {
    const words = wordCount(sentence.text);
    if (words <= LONG_SENTENCE_WORD_LIMIT) continue;

    const snippet =
      sentence.text.length > 60
        ? `${sentence.text.slice(0, 60)}…`
        : sentence.text;
    out.push({
      category: "long-sentence",
      severity: "low",
      message: `Long sentence (${words} words) starting "${snippet}" — consider splitting it into shorter sentences.`,
      match: sentence.text,
      index: sentence.index,
    });
  }
}

interface SentenceSpan {
  /** The sentence with surrounding whitespace trimmed off. */
  text: string;
  /** Offset of the sentence's first non-whitespace character in the input. */
  index: number;
}

/**
 * Splits text into sentences on a run of `.`, `!`, or `?` that is followed by
 * whitespace or the end of the text, in a single linear pass.
 *
 * Checking the character *after* the terminator run directly (rather than a
 * regex lookahead) keeps this O(n): a long run of terminators with no trailing
 * whitespace — a decimal like "3.14", TOC dot-leaders, or "?????x" — is walked
 * once instead of triggering quadratic regex backtracking. The abbreviation /
 * initial guard reads only a bounded number of characters back from the
 * terminator, so it never re-slices the whole prefix.
 *
 * A terminator preceded by a single letter (initials, or the dots inside
 * "e.g.") or by a known abbreviation ("Mr.", "etc.") is treated as part of the
 * sentence rather than a break. This is a cheap heuristic, not a full parser.
 * Two spec-accepted tradeoffs remain: text with no terminal punctuation is one
 * "sentence", and the abbreviation guard can merge across a real break — either
 * only risks under-reporting a run-on, never a crash.
 */
function splitSentences(text: string): SentenceSpan[] {
  const spans: SentenceSpan[] = [];
  const len = text.length;
  let sentenceStart = 0;
  let i = 0;

  while (i < len) {
    if (!isTerminator(text[i])) {
      i++;
      continue;
    }

    // Consume the whole run of terminators in one step, so an unbounded run is
    // walked linearly rather than re-scanned.
    let runEnd = i + 1;
    while (runEnd < len && isTerminator(text[runEnd])) runEnd++;

    // A sentence ends only when the run is followed by whitespace or the end of
    // the text — so "3.14" (dot followed by a digit) never splits.
    const endsSentence = runEnd >= len || isWhitespace(text[runEnd]);
    if (endsSentence && !precededByAbbreviation(text, i)) {
      pushSentence(spans, text.slice(sentenceStart, runEnd), sentenceStart);
      sentenceStart = runEnd;
    }
    i = runEnd;
  }

  if (sentenceStart < len) {
    pushSentence(spans, text.slice(sentenceStart, len), sentenceStart);
  }

  return spans;
}

function pushSentence(
  out: SentenceSpan[],
  raw: string,
  rawStart: number
): void {
  const leadingWhitespace = raw.length - raw.trimStart().length;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return;
  out.push({ text: trimmed, index: rawStart + leadingWhitespace });
}

function wordCount(sentence: string): number {
  const trimmed = sentence.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

function isTerminator(ch: string): boolean {
  return ch === "." || ch === "!" || ch === "?";
}

function isWhitespace(ch: string): boolean {
  return /\s/.test(ch);
}

function isLetter(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
}

/**
 * Whether the terminator at `termIndex` is preceded by a single-letter initial
 * or a known abbreviation, in which case it does not end a sentence. Scans at
 * most {@link LONGEST_ABBREVIATION}+1 characters back, so it stays O(1) per
 * terminator instead of re-slicing the whole prefix.
 */
function precededByAbbreviation(text: string, termIndex: number): boolean {
  let wordStart = termIndex;
  while (wordStart > 0 && isLetter(text[wordStart - 1])) {
    if (termIndex - wordStart >= LONGEST_ABBREVIATION + 1) {
      // Longer than any guarded abbreviation, and not a single letter.
      return false;
    }
    wordStart--;
  }

  const wordLength = termIndex - wordStart;
  if (wordLength === 0) return false;
  if (wordLength === 1) return true;
  return SENTENCE_ABBREVIATIONS.has(
    text.slice(wordStart, termIndex).toLowerCase()
  );
}

/**
 * Builds a case-insensitive, global matcher for one AI-tell phrase. Word
 * boundaries are added only on alphanumeric edges, so a phrase ending in a
 * comma (e.g. "furthermore,") matches without a spurious trailing boundary,
 * and straight apostrophes also match their curly counterpart.
 */
function aiTellRegex(phrase: string): RegExp {
  const startBoundary = /^\w/.test(phrase) ? "\\b" : "";
  const endBoundary = /\w$/.test(phrase) ? "\\b" : "";
  const body = escapeRegExp(phrase).replace(/'/g, "['’]");
  return new RegExp(`${startBoundary}${body}${endBoundary}`, "gi");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
