import { isOriginEligibleForInjection, layerOf, type Layer, type OriginClass } from "@standup/knowledge";
import { GLOBAL_PROJECT_ID, type Project } from "@standup/shared";
import { PERSONA_MEMORY_PREFIX } from "../persona/memory-slug.js";
import { isNativeMemoryDoc } from "../native-memory-ingest.js";

/** Layers the public knowledge API never serves. */
export const PUBLIC_EXCLUDED_LAYERS: readonly Layer[] = ["personal", "activity", "code"];

/** What a shareability check reads: the projects whose knowledge may be served. */
export interface ShareContext {
  /** Ids of projects whose knowledge is shareable; the reserved global corpus need not be listed. */
  shareableProjects: ReadonlySet<string>;
}

/** The fields of a doc or search hit a shareability check reads. */
export interface ShareableCandidate {
  projectId: string;
  slug: string;
  scope?: string;
  sourceKind?: string;
}

/**
 * Whether a doc may be served by the public knowledge API. It must be homed in
 * the reserved global corpus or a shareable project — a scope='global' doc homed
 * in a withheld project stays withheld — and it must not be personal or
 * activity knowledge: no scope='user' doc, no Persona memory (`persona-*`), no
 * native-memory mirror (CLAUDE.md, rules, auto-memory notes), and nothing
 * layerOf places in an excluded layer. A candidate whose scope is unknown is
 * not shareable: a bare reference has to be resolved to its doc first.
 */
export function isPubliclyShareable(doc: ShareableCandidate, ctx: ShareContext): boolean {
  if (doc.scope === undefined || doc.scope === "user") return false;
  if (PUBLIC_EXCLUDED_LAYERS.includes(layerOf(doc))) return false;
  if (doc.slug.startsWith(PERSONA_MEMORY_PREFIX)) return false;
  if (isNativeMemoryDoc(doc)) return false;
  return doc.projectId === GLOBAL_PROJECT_ID || ctx.shareableProjects.has(doc.projectId);
}

/** The fields of a doc or search hit the public trust gate reads. */
export interface TrustCandidate {
  originClass?: OriginClass;
  verdict?: string;
}

/**
 * Whether a shareable doc is trusted enough for /search, /projects and /docs to
 * serve: its origin passes the injection gate (owner or agent — never an
 * untrusted or unknown origin), and no re-verification has marked it disputed
 * or superseded. A doc flagged as contradicting another is served, with its
 * `verdict` saying so, on both sides of the pair: which side wins is a
 * per-query judgment, not a property of the doc.
 */
export function isPubliclyTrusted(doc: TrustCandidate): boolean {
  if (!isOriginEligibleForInjection(doc.originClass)) return false;
  return doc.verdict !== "disputed" && doc.verdict !== "superseded";
}

/** The ids of the projects whose knowledge is shareable, the reserved global corpus included. */
export function shareableProjectIds(projects: readonly Project[]): Set<string> {
  const ids = new Set<string>([GLOBAL_PROJECT_ID]);
  for (const p of projects) if (p.shareable !== false) ids.add(p.id);
  return ids;
}
