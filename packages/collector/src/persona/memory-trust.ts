import { NATIVE_MEMORY_HOME_SLUG_PREFIX, layerOf, stampedWriter, type WriterStampRow } from "@standup/knowledge";
import { PERSONA_MEMORY_PREFIX } from "./memory-slug.js";

/**
 * Who may write the owner's personal layer, and which of its docs count as
 * Persona's memories of the owner.
 *
 * The owner profile and every worker brief present a memory as the owner's own
 * instruction, so a doc counts as one only when Persona's remember/forget path
 * wrote it, as recorded server-side: the knowledge edit route stamps the row's
 * `writer_stamp` with PERSONA_WRITER, bound to the content it wrote, only when
 * the request carries the Persona runtime's per-boot secret
 * (PERSONA_WRITER_HEADER), which never leaves the collector process. Nothing a
 * doc says about itself — slug, tags, front matter — makes it trusted, and any
 * later write to the row by anything else (a file edit synced in, a draft
 * published over it, an import, a migration) leaves it unstamped or stamped
 * for content it no longer has (see @standup/knowledge writer-stamp.ts).
 *
 * The knowledge routes also refuse every write into the personal layer that
 * is not Persona's (personalLayerRefusal): propose, ingest-url, draft edits and
 * accepts, and edits and deletes without the secret.
 */

/** The tag that marks a Persona memory. Display only: trust comes from the writer stamp. */
export const PERSONA_MEMORY_TAG = "persona";

/** Header carrying the Persona runtime's per-boot writer secret on its own knowledge writes. */
export const PERSONA_WRITER_HEADER = "x-standup-persona-writer";

/** The writer name Persona's own knowledge writes are stamped with. */
export const PERSONA_WRITER = "persona";

function isPersonaTag(tag: unknown): boolean {
  return typeof tag === "string" && tag.trim().toLowerCase() === PERSONA_MEMORY_TAG;
}

/**
 * The shape of a playbook slug, `playbook-<owner>--<name>` (playbook.ts). An
 * ordinary doc named `playbook-oncall` has no `--` after the owner, so it is
 * not reserved.
 */
const PLAYBOOK_SLUG = /^playbook-[a-z0-9]+(?:-[a-z0-9]+)*--/;

/** Whether `slug` is one only Persona's memories and playbooks, or the owner's HOME mirrors, are kept under. */
function isReservedPersonalSlug(slug: unknown): boolean {
  if (typeof slug !== "string") return false;
  const lower = slug.toLowerCase();
  return (
    lower.startsWith(PERSONA_MEMORY_PREFIX) ||
    PLAYBOOK_SLUG.test(lower) ||
    lower.startsWith(NATIVE_MEMORY_HOME_SLUG_PREFIX)
  );
}

/** A doc as personalLayerRefusal reads it: an accepted doc or a draft. */
export interface PersonalLayerDoc {
  slug?: string;
  scope?: string;
  sourceKind?: string;
  replacesSlug?: string;
}

/**
 * Why a write that is not Persona's may not land, or null when it may: it
 * would create, change or remove a doc of the personal layer — a reserved
 * `persona-…` or HOME-mirror slug, a requested `scope: user`, or an existing
 * doc or draft that is personal.
 */
export function personalLayerRefusal(target: {
  slug: string;
  requestedScope?: unknown;
  docs?: ReadonlyArray<PersonalLayerDoc | null | undefined>;
}): string | null {
  const slugs = [target.slug, ...(target.docs ?? []).flatMap((d) => [d?.slug, d?.replacesSlug])];
  const personal =
    slugs.some(isReservedPersonalSlug) ||
    target.requestedScope === "user" ||
    (target.docs ?? []).some((d) => !!d && layerOf({ slug: d.slug ?? target.slug, scope: d.scope, sourceKind: d.sourceKind }) === "personal");
  if (!personal) return null;
  return "the personal layer (Persona's memories and the owner's personal docs) is written only by Persona; ask Persona to remember, change or forget it";
}

/**
 * Why a proposal may not be written as asked, or null when it may: the
 * `persona` tag, or any write into the personal layer (personalLayerRefusal).
 */
export function personaProposalRefusal(slug: unknown, tags: unknown, requestedScope?: unknown): string | null {
  if (typeof slug === "string" && slug.toLowerCase().startsWith(PERSONA_MEMORY_PREFIX)) {
    return `slugs starting with "${PERSONA_MEMORY_PREFIX}" are reserved for Persona's memories of its owner; pick another slug`;
  }
  if (Array.isArray(tags) && tags.some(isPersonaTag)) {
    return `the "${PERSONA_MEMORY_TAG}" tag is reserved for Persona's memories of its owner; drop it`;
  }
  return personalLayerRefusal({ slug: typeof slug === "string" ? slug : "", requestedScope });
}

/**
 * The tags a knowledge edit is written with: as sent for Persona's own write,
 * else without the `persona` tag.
 */
export function knowledgeWriteTags(tags: string[] | undefined, fromPersona: boolean): string[] | undefined {
  if (fromPersona || !Array.isArray(tags)) return tags;
  return tags.filter((tag) => !isPersonaTag(tag));
}

/** A knowledge row as isPersonaWrittenMemory reads it. */
export type MemoryTrustRow = WriterStampRow & { writer_stamp: string | null };

/**
 * Whether the row is a memory Persona wrote: a `persona-…` doc of the personal
 * layer whose writer stamp is Persona's and still matches its content.
 */
export function isPersonaWrittenMemory(row: MemoryTrustRow): boolean {
  return (
    row.slug.startsWith(PERSONA_MEMORY_PREFIX) &&
    row.scope === "user" &&
    !row.source_session_id &&
    row.source_kind !== "native-memory" &&
    stampedWriter(row) === PERSONA_WRITER
  );
}
