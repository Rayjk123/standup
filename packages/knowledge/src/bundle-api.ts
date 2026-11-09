import type { BundleSource, BundleVerdict } from "./bundle.js";
import { findRedactions, redactOptionsFor, redactSecrets } from "./redact.js";
import { SUPERSEDED_TAG } from "./temporal.js";
import { layerOf, type DraftDispute } from "./types.js";
import { isValidSlug, writeKnowledgeFile, type KnowledgeDocFile } from "./writer.js";

/**
 * A bundle source over a running collector's read API, for a host that may not
 * read the collector's DB or data dir. It reads `GET /api/projects` and each
 * project's `GET /api/projects/:id/knowledge` (the console's Browse listing:
 * every published doc with its verdict) and writes each kept doc through
 * writeKnowledgeFile, so the tree has the corpus's own file format and
 * redaction.
 *
 * The API serves neither chunks nor the retrieval, resolution and change
 * ledgers, so the bundle carries docs and their verdicts only; the importing
 * host embeds the docs itself. Drafts are never listed by these routes.
 */

/** One doc as `GET /api/projects/:id/knowledge` serves it. */
export type ApiKnowledgeDoc = Omit<KnowledgeDocFile, "updatedAt"> & {
  updatedAt: string;
  verdict?: string | null;
  disputes?: DraftDispute[] | null;
};

/** Why a published doc is left out of a shareable bundle, or null to keep it. */
export function shareableExclusion(doc: ApiKnowledgeDoc): string | null {
  if (layerOf(doc) === "personal") return "personal layer";
  if (doc.sourceKind === "native-memory") return "native memory";
  if (doc.slug.startsWith("persona-")) return "persona doc";
  if (doc.verdict === "superseded" || doc.tags?.includes(SUPERSEDED_TAG)) return "superseded";
  return null;
}

export interface ApiBundleReport {
  /** Each doc left out, with the reason. */
  excluded: Array<{ projectId: string; slug: string; reason: string }>;
  /** Each written doc whose title, body or disputes had spans redacted, by rule. */
  redacted: Array<{ projectId: string; slug: string; patterns: Record<string, number> }>;
  /** The written docs, with the metadata a reader index needs. */
  written: Array<{
    projectId: string;
    slug: string;
    title: string;
    verdict: string | null;
    updatedAt: string;
    sourceKind: string;
    tags: string[];
  }>;
}

export interface ApiBundleSourceOptions {
  /** The collector's base URL, e.g. http://localhost:7777. */
  collectorUrl: string;
  /** Headers sent on every request. */
  headers?: Record<string, string>;
  /** Why a doc is left out, or null to keep it; defaults to shareableExclusion. */
  exclude?: (doc: ApiKnowledgeDoc, projectId: string) => string | null;
}

async function getJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GET ${url} answered ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/** A bundle source over the collector API at `options.collectorUrl`, and the report it fills while reading. */
export function apiBundleSource(options: ApiBundleSourceOptions): { source: BundleSource; report: ApiBundleReport } {
  const base = options.collectorUrl.replace(/\/+$/, "");
  const headers = options.headers ?? {};
  const exclude = options.exclude ?? shareableExclusion;
  const report: ApiBundleReport = { excluded: [], redacted: [], written: [] };

  const source: BundleSource = {
    async read(treeDest) {
      const projects = await getJson<Array<{ id: string }>>(`${base}/api/projects`, headers);
      const docVerdicts: BundleVerdict[] = [];
      for (const { id: projectId } of projects) {
        const docs = await getJson<ApiKnowledgeDoc[]>(
          `${base}/api/projects/${encodeURIComponent(projectId)}/knowledge`,
          headers
        );
        for (const doc of docs) {
          const reason = !isValidSlug(doc.slug) ? "slug is not a writable file name" : exclude(doc, projectId);
          if (reason) {
            report.excluded.push({ projectId, slug: doc.slug, reason });
            continue;
          }
          const opts = redactOptionsFor({ projectId, scope: doc.scope, sourceKind: doc.sourceKind, slug: doc.slug });
          const redact = <T>(t: T): T => (typeof t === "string" ? (redactSecrets(t, opts) as T) : t);
          const disputes = (doc.disputes ?? []).map((d) => ({
            ...d,
            claim: redact(d.claim),
            finding: redact(d.finding),
            evidence: redact(d.evidence),
          }));
          const patterns: Record<string, number> = {};
          const texts = [doc.title, doc.body, ...(doc.disputes ?? []).flatMap((d) => [d.claim, d.finding, d.evidence])];
          for (const span of texts.flatMap((t) => (typeof t === "string" ? findRedactions(t, opts) : []))) {
            patterns[span.pattern] = (patterns[span.pattern] ?? 0) + 1;
          }
          if (Object.keys(patterns).length) report.redacted.push({ projectId, slug: doc.slug, patterns });

          await writeKnowledgeFile(treeDest, projectId, {
            slug: doc.slug,
            title: doc.title,
            body: doc.body,
            tags: doc.tags,
            related: doc.related,
            generatedFromSha: doc.generatedFromSha,
            generatedAt: doc.generatedAt,
            originClass: doc.originClass,
            sourceSessionId: doc.sourceSessionId,
            sourceKind: doc.sourceKind,
            scope: doc.scope,
            ownerUser: doc.ownerUser,
            confidence: doc.confidence,
            lastVerifiedAt: doc.lastVerifiedAt,
            halfLifeDays: doc.halfLifeDays,
          });
          if (doc.verdict) docVerdicts.push({ projectId, slug: doc.slug, verdict: doc.verdict, disputes });
          report.written.push({
            projectId,
            slug: doc.slug,
            title: redactSecrets(doc.title, opts),
            verdict: doc.verdict ?? null,
            updatedAt: doc.updatedAt,
            sourceKind: doc.sourceKind,
            tags: doc.tags ?? [],
          });
        }
      }
      return {
        // The API carries no schema-shaped rows, so the bundle imports into any schema.
        sourceSchemaVersion: 0,
        embeddingFingerprint: null,
        docs: report.written.length,
        drafts: 0,
        state: { docVerdicts, draftVerdicts: [], retrievals: [], resolutions: [], changes: [], knowledgeScopes: [] },
        chunks: [],
      };
    },
  };
  return { source, report };
}
