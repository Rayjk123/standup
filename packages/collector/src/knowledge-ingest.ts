import type { SourceKind } from "@standup/knowledge";

/**
 * The ingest-URL puller: the automatic path that brings PRODUCT/SPEC sources
 * (a design doc, a wiki page, a ticket's rendered HTML, any reachable URL) into
 * the knowledge graph, distinct from the propose seam that only fires from
 * inside a running launch. Product knowledge comes in two ways, the
 * configured doc MCPs and an ingest URL, both landing docs tagged
 * source_kind=product. This module is the ingest-URL half: given a URL, it fetches the content,
 * reduces HTML to readable text, and shapes a draft the caller writes through
 * the same `KnowledgeBackend.writeDraft` seam every other proposal uses. A
 * human still accepts the draft before it is searchable or injectable; ingest
 * only gets a product/spec source INTO the corpus so launch-time product
 * injection has something to retrieve.
 *
 * The doc-MCP-specific pullers (authenticated docs, wiki and tracker clients) stay
 * out of scope here — those are per-MCP auth adapters that would themselves
 * fetch a URL or export text and then hand it to this same draft-shaping code.
 */

/**
 * Source kinds an ingested doc may be classified as. Ingestion only ever lands
 * PRODUCT knowledge — a `code`/`decision`/`runbook` doc is authored from work,
 * not pulled from an external URL — so the accepted set is product|spec with
 * `product` as the default.
 */
export const INGEST_SOURCE_KINDS: readonly SourceKind[] = ["product", "spec"];

/** Default classification for an ingested doc that names no source_kind. */
export const DEFAULT_INGEST_SOURCE_KIND: SourceKind = "product";

/**
 * Coerces a caller-supplied source_kind to one the ingest path accepts,
 * defaulting to `product`. Unlike the propose route's normalizeSourceKind
 * (whose default is `code`), ingestion is product-first: a garbage or absent
 * value lands `product`, never `code`, because an ingested URL is by definition
 * an external product/spec source.
 */
export function normalizeIngestSourceKind(value: unknown): SourceKind {
  return typeof value === "string" && INGEST_SOURCE_KINDS.includes(value as SourceKind)
    ? (value as SourceKind)
    : DEFAULT_INGEST_SOURCE_KIND;
}

/** Upper bound on an ingested doc body so one huge page can't bloat the corpus. */
export const MAX_INGEST_BODY_CHARS = 20_000;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

/** Decodes the handful of HTML entities that survive tag-stripping into text. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? whole;
  });
}

/**
 * Reduces an HTML document to readable plain text: drops `<script>`, `<style>`,
 * `<head>` and comments wholesale (their contents are never prose), turns block
 * boundaries into newlines so paragraphs survive, strips remaining tags, decodes
 * entities, and collapses runaway whitespace. Deliberately dependency-free — a
 * lossy extraction good enough to ground an agent, not a fidelity renderer.
 */
export function htmlToText(html: string): string {
  let text = html;
  // Elements whose text content is not prose.
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ");
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  // Preserve block structure: a closing block tag or <br> becomes a newline.
  text = text.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  // Strip every remaining tag.
  text = text.replace(/<[^>]+>/g, " ");
  text = decodeEntities(text);
  // Collapse horizontal whitespace, then squeeze blank-line runs to one.
  text = text.replace(/[ \t\f\v\r]+/g, " ");
  text = text.replace(/ *\n */g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

/** Extracts a document title from `<title>` or the first `<h1>`, if present. */
export function extractHtmlTitle(html: string): string | undefined {
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (title?.[1]) {
    const decoded = decodeEntities(title[1].replace(/\s+/g, " ")).trim();
    if (decoded) return decoded;
  }
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1?.[1]) {
    const decoded = htmlToText(h1[1]);
    if (decoded) return decoded;
  }
  return undefined;
}

/**
 * Turns arbitrary text (a title, a URL path segment) into a filename-safe slug
 * that satisfies isValidSlug: lowercase, non-alphanumerics folded to single
 * hyphens, trimmed, capped at 64 chars, and guaranteed to start with an
 * alphanumeric. Returns "" when nothing usable survives, so the caller can fall
 * back to another source.
 */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return /^[a-z0-9]/.test(slug) ? slug : "";
}

/**
 * Derives the ingested draft's slug: an explicit slug wins, then a slug made
 * from the title, then the URL's last meaningful path segment, then its
 * hostname. Returns "" only if every source is unusable (the caller rejects
 * that).
 */
export function deriveIngestSlug(
  url: string,
  opts: { explicitSlug?: string; title?: string } = {}
): string {
  if (opts.explicitSlug) {
    const fromExplicit = slugify(opts.explicitSlug);
    if (fromExplicit) return fromExplicit;
  }
  if (opts.title) {
    const fromTitle = slugify(opts.title);
    if (fromTitle) return fromTitle;
  }
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    for (let i = segments.length - 1; i >= 0; i--) {
      const fromSegment = slugify(decodeURIComponent(segments[i]));
      if (fromSegment) return fromSegment;
    }
    const fromHost = slugify(parsed.hostname);
    if (fromHost) return fromHost;
  } catch {
    // Not a parseable URL — the route validates the URL up front, so this only
    // guards a defensive fallthrough.
  }
  return "";
}

/**
 * Assembles the draft body from extracted text, prefixing a provenance line so
 * a reviewer (and later a reader of the accepted doc) can see the source URL
 * and when it was pulled. The extracted text is truncated to MAX_INGEST_BODY_CHARS
 * with a visible marker so the body never silently drops content.
 */
export function buildIngestBody(text: string, url: string, fetchedAt: string): string {
  let body = text.trim();
  let truncated = false;
  if (body.length > MAX_INGEST_BODY_CHARS) {
    body = body.slice(0, MAX_INGEST_BODY_CHARS).trimEnd();
    truncated = true;
  }
  const header = `> Ingested from ${url} on ${fetchedAt}`;
  const suffix = truncated ? "\n\n_[truncated at ingest]_" : "";
  return `${header}\n\n${body}${suffix}`;
}

/** Whether a URL is an http(s) URL the ingest route will fetch. */
export function isIngestableUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
