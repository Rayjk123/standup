import type { PersonaMessageJobTag } from "@standup/shared";

/** A job as mention matching sees it. */
export interface MentionableJob {
  id: string;
  title: string;
}

/** Characters that continue an identifier: a job id or short id must not touch one on either side. */
const ID_CHAR = String.raw`[\p{L}\p{N}_-]`;
/** Characters that continue a word: a title must not touch one on either side. */
const WORD_CHAR = String.raw`[\p{L}\p{N}_]`;
/** A short id as Persona writes it: the first 8 hex characters of a job id, standing alone. */
const SHORT_ID = new RegExp(String.raw`(?<!${ID_CHAR})[0-9a-f]{8}(?!${ID_CHAR})`, "giu");
const HEX_PREFIX = /^[0-9a-f]{8}/i;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Words too common to make a title distinctive: function words and the
 * generic verbs a task title opens with.
 */
const STOPWORDS = new Set([
  "a", "an", "and", "as", "at", "by", "for", "from", "in", "into", "is", "it", "of", "on", "or", "the", "to", "up", "with",
  "add", "fix", "make", "remove", "run", "update", "use",
]);
/** The shortest pair of distinctive words (joined by a space) that counts as distinctive. */
const MIN_TWO_WORD_TITLE_CHARS = 12;

/**
 * Whether a title is distinctive enough to count as a mention when it appears
 * in text, judged on its words that aren't stopwords: three or more of them;
 * two, at least 12 characters joined by a space; or a title that is a single
 * word of at least 4 characters reading as an identifier (a digit or one of
 * `-_.#/`). A plain word ("Docs") or a generic phrase ("Run tests", "Fix the
 * bug", "Add unit tests", "Code review") is too likely to be ordinary prose.
 */
export function isMentionableTitle(title: string): boolean {
  const normalized = title.trim().replace(/\s+/g, " ");
  if (normalized.length < 4) return false;
  const words = normalized.split(" ");
  if (words.length === 1) return /[\d\-_.#/]/.test(normalized);
  const distinctive = words.filter((w) => !STOPWORDS.has(w.toLowerCase()));
  if (distinctive.length >= 3) return true;
  return distinctive.length === 2 && distinctive.join(" ").length >= MIN_TWO_WORD_TITLE_CHARS;
}

/**
 * The jobs `text` names, in `jobs` order: by full id, by short id (the first
 * 8 characters of an id that starts with 8 hex characters, as a whole token,
 * naming exactly one of `jobs`), or by exact title (case-insensitive, as a
 * whole phrase, only for a title isMentionableTitle accepts). Nothing looser
 * counts: a partial word, a title fragment, or an 8-character word that isn't
 * hex never matches.
 */
export function jobMentions(text: string, jobs: readonly MentionableJob[]): string[] {
  if (!text.trim() || jobs.length === 0) return [];
  const shortTokens = new Set((text.match(SHORT_ID) ?? []).map((t) => t.toLowerCase()));
  const byPrefix = new Map<string, number>();
  for (const job of jobs) {
    if (!HEX_PREFIX.test(job.id)) continue;
    const prefix = job.id.slice(0, 8).toLowerCase();
    byPrefix.set(prefix, (byPrefix.get(prefix) ?? 0) + 1);
  }
  const found: string[] = [];
  for (const job of jobs) {
    if (!job.id || found.includes(job.id)) continue;
    const fullId = new RegExp(`(?<!${ID_CHAR})${escapeRegExp(job.id)}(?!${ID_CHAR})`, "iu");
    if (fullId.test(text)) {
      found.push(job.id);
      continue;
    }
    if (HEX_PREFIX.test(job.id)) {
      const prefix = job.id.slice(0, 8).toLowerCase();
      if (shortTokens.has(prefix) && byPrefix.get(prefix) === 1) {
        found.push(job.id);
        continue;
      }
    }
    if (isMentionableTitle(job.title)) {
      const phrase = job.title.trim().split(/\s+/).map(escapeRegExp).join(String.raw`\s+`);
      if (new RegExp(`(?<!${WORD_CHAR})${phrase}(?!${WORD_CHAR})`, "iu").test(text)) found.push(job.id);
    }
  }
  return found;
}

/**
 * A reply's job tags: what the turn acted on, the jobs its worker and system
 * events were about, and the jobs the reply names are `inferred`; the jobs
 * Persona declared with tag_reply are `declared`. A job Persona declared
 * removed is left off whatever else would tag it. Each job appears once, at
 * its strongest source: the declared ones first, then the inferred ones in
 * the order above.
 */
export function composeReplyTags(input: {
  acted?: Iterable<string>;
  events?: Iterable<string>;
  mentioned?: Iterable<string>;
  declaredAdd?: Iterable<string>;
  declaredRemove?: Iterable<string>;
}): PersonaMessageJobTag[] {
  const removed = new Set(input.declaredRemove ?? []);
  const tags = new Map<string, PersonaMessageJobTag>();
  for (const jobId of input.declaredAdd ?? []) {
    if (jobId && !removed.has(jobId)) tags.set(jobId, { jobId, source: "declared" });
  }
  for (const source of [input.acted, input.events, input.mentioned]) {
    for (const jobId of source ?? []) {
      if (jobId && !removed.has(jobId) && !tags.has(jobId)) tags.set(jobId, { jobId, source: "inferred" });
    }
  }
  return [...tags.values()];
}
