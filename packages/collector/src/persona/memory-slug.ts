import { createHash } from "crypto";
import { isValidSlug } from "@standup/knowledge";

/**
 * Slugs of Persona's memories. Every owner's memories live in the reserved
 * global corpus, so the slug carries the owner: `persona-<owner>-<topic>`.
 * One owner saving a topic never lands on another owner's file.
 */

/** Slug prefix of every Persona memory. */
export const PERSONA_MEMORY_PREFIX = "persona-";

/** Longest knowledge slug (it becomes a file name; see isValidSlug). */
const MAX_SLUG = 64;
/** Longest owner part of a memory slug. */
const MAX_OWNER_PART = 24;
/** Length of the hash suffix that keeps lossy topics apart. */
const HASH_CHARS = 8;

function asciiSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The owner's part of a memory slug. */
export function ownerSlugPart(owner: string): string {
  return asciiSlug(owner).slice(0, MAX_OWNER_PART).replace(/-+$/g, "") || "owner";
}

/** The slug prefix of one owner's memories: `persona-<owner>-`. */
export function ownerMemoryPrefix(owner: string): string {
  return `${PERSONA_MEMORY_PREFIX}${ownerSlugPart(owner)}-`;
}

/**
 * A topic as the owner wrote it, normalized: NFKC, lowercase, every run of
 * characters that are not letters or digits turned into one hyphen.
 */
function normalizedTopic(topic: string): string {
  return topic
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The memory slug for `topic`, and the topic key it stands for. A topic that
 * fits in ASCII letters, digits and hyphens is its own key ("brief-length").
 * Anything that would lose information — non-ASCII words, a topic cut to fit
 * the slug — keeps what ASCII it has and gains a hash of the whole topic, so
 * "テスト" and "レビュー" (or two long topics sharing a prefix) never replace
 * each other, while the same topic always maps to the same slug. Null for a
 * topic with no letters or digits at all.
 */
export function memorySlug(owner: string, topic: string): { slug: string; topic: string } | null {
  const normalized = normalizedTopic(topic);
  if (!normalized) return null;
  const prefix = ownerMemoryPrefix(owner);
  const budget = MAX_SLUG - prefix.length;
  const ascii = asciiSlug(normalized);
  if (ascii === normalized && ascii.length <= budget) return { slug: `${prefix}${ascii}`, topic: ascii };
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, HASH_CHARS);
  const head = ascii.slice(0, Math.max(0, budget - HASH_CHARS - 1)).replace(/-+$/g, "");
  const key = head ? `${head}-${hash}` : hash;
  return { slug: `${prefix}${key}`, topic: key };
}

/**
 * The topic of a memory slug: what follows the owner's prefix, or — for a
 * memory saved before slugs carried the owner — what follows `persona-`.
 */
export function topicOfMemorySlug(slug: string, owner: string): string {
  const prefix = ownerMemoryPrefix(owner);
  if (slug.startsWith(prefix)) return slug.slice(prefix.length);
  return slug.startsWith(PERSONA_MEMORY_PREFIX) ? slug.slice(PERSONA_MEMORY_PREFIX.length) : slug;
}

/** Whether `slug` names a Persona memory file: a valid slug under the `persona-` prefix. */
export function isMemorySlug(slug: string): boolean {
  return isValidSlug(slug) && slug.startsWith(PERSONA_MEMORY_PREFIX) && slug.length > PERSONA_MEMORY_PREFIX.length;
}
