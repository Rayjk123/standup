import { layerOf } from "@standup/knowledge";
import type {
  KnowledgeDeadDoc,
  KnowledgeHubDoc,
  KnowledgeRetrievalUsage,
  KnowledgeUsageHealth,
} from "@standup/shared";

/** Default window a doc must have been used within to count as live. */
export const DEAD_DOC_WINDOW_DAYS = 30;
/** Docs listed per dead-doc list (the counts are always complete). */
export const DEAD_DOC_LIST_LIMIT = 100;
/** Docs listed as hubs. */
export const HUB_LIST_LIMIT = 10;

/** The doc fields the health view reads. */
export interface HealthDoc {
  projectId: string;
  slug: string;
  title: string;
  scope?: string;
  sourceKind?: string;
}

const keyOf = (projectId: string, slug: string) => `${projectId}/${slug}`;

/**
 * Dead docs and hubs over `docs` (the caller's browsable corpus) from per-doc
 * retrieval usage:
 *  - `neverRetrieved`: no returned hit or full-body fetch within `windowDays`
 *    (a candidate only ever gated does not count as used), oldest use first,
 *    never-used docs before them.
 *  - `neverCited`: never opened with get_knowledge_doc after a search or a
 *    launch injection handed it to the same session (see
 *    KnowledgeRetrievalUsage.cited). The personal layer is left out.
 *  - `hubs`: the docs with the largest share of all returned retrievals.
 * `orphanedUsageDocs` counts usage rows whose doc is not in `corpusKeys` (the
 * whole corpus, so a doc the caller cannot browse is not counted as gone).
 */
export function knowledgeUsageHealth(input: {
  docs: HealthDoc[];
  usage: KnowledgeRetrievalUsage[];
  corpusKeys: ReadonlySet<string>;
  windowDays?: number;
  now?: Date;
}): KnowledgeUsageHealth {
  const { corpusKeys } = input;
  const windowDays = input.windowDays ?? DEAD_DOC_WINDOW_DAYS;
  const cutoff = new Date((input.now ?? new Date()).getTime() - windowDays * 86_400_000).toISOString();
  const usageByKey = new Map(input.usage.map((u) => [keyOf(u.docProject, u.docSlug), u]));

  const dead = (doc: HealthDoc, u: KnowledgeRetrievalUsage | undefined): KnowledgeDeadDoc => ({
    projectId: doc.projectId,
    slug: doc.slug,
    title: doc.title,
    layer: layerOf(doc),
    ...(u?.lastUsedAt ? { lastRetrievedAt: u.lastUsedAt } : {}),
  });

  const neverRetrieved: KnowledgeDeadDoc[] = [];
  const neverCited: KnowledgeDeadDoc[] = [];
  for (const doc of input.docs) {
    const u = usageByKey.get(keyOf(doc.projectId, doc.slug));
    if (!u?.lastUsedAt || toIso(u.lastUsedAt) < cutoff) neverRetrieved.push(dead(doc, u));
    if ((u?.cited ?? 0) === 0 && layerOf(doc) !== "personal") neverCited.push(dead(doc, u));
  }
  const byLastUse = (a: KnowledgeDeadDoc, b: KnowledgeDeadDoc) =>
    (a.lastRetrievedAt ?? "").localeCompare(b.lastRetrievedAt ?? "") ||
    keyOf(a.projectId, a.slug).localeCompare(keyOf(b.projectId, b.slug));
  neverRetrieved.sort(byLastUse);
  neverCited.sort(byLastUse);

  const docByKey = new Map(input.docs.map((d) => [keyOf(d.projectId, d.slug), d]));
  const visibleUsage = input.usage.filter((u) => docByKey.has(keyOf(u.docProject, u.docSlug)));
  const totalReturned = visibleUsage.reduce((sum, u) => sum + u.retrievals, 0);
  const hubs: KnowledgeHubDoc[] = visibleUsage
    .filter((u) => u.retrievals > 0)
    .sort((a, b) => b.retrievals - a.retrievals || keyOf(a.docProject, a.docSlug).localeCompare(keyOf(b.docProject, b.docSlug)))
    .slice(0, HUB_LIST_LIMIT)
    .map((u) => ({
      projectId: u.docProject,
      slug: u.docSlug,
      title: docByKey.get(keyOf(u.docProject, u.docSlug))!.title,
      retrievals: u.retrievals,
      share: totalReturned === 0 ? 0 : u.retrievals / totalReturned,
    }));

  return {
    windowDays,
    docs: input.docs.length,
    neverRetrievedCount: neverRetrieved.length,
    neverRetrieved: neverRetrieved.slice(0, DEAD_DOC_LIST_LIMIT),
    neverCitedCount: neverCited.length,
    neverCited: neverCited.slice(0, DEAD_DOC_LIST_LIMIT),
    hubs,
    orphanedUsageDocs: input.usage.filter((u) => !corpusKeys.has(keyOf(u.docProject, u.docSlug))).length,
  };
}

/** SQLite's `datetime('now')` text ("YYYY-MM-DD HH:MM:SS", UTC) as ISO, for comparison. */
function toIso(sqliteOrIso: string): string {
  return sqliteOrIso.includes("T") ? sqliteOrIso : `${sqliteOrIso.replace(" ", "T")}Z`;
}
