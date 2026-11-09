import {
  docInAudience,
  isVerdictAdmissible,
  refreshCodeMentions,
  resolveMentionedPath,
  type CodeMentionRow,
  type KnowledgeDoc,
  type KnowledgeStore,
  type ScopeAudience,
} from "@standup/knowledge";

/**
 * Read-time use of doc→code mentions (knowledge/src/code-mentions.ts): the
 * staleness marker and demotion search applies to a doc naming code that is
 * gone from HEAD, and the "docs about this file" lookup.
 *
 * The existence check reads the code_symbols index, which the CodeSymbolIndexer
 * keeps at each project's HEAD; nothing here touches git, so it is cheap enough
 * for the search path.
 */

/**
 * How many places a hit naming code no longer in the index moves down, past
 * hits that name none. Small on purpose: a doc can be mostly right with one
 * renamed function, so it is marked and nudged, not buried.
 */
export const MISSING_MENTION_DEMOTION = 2;

/** Docs listed by one about-file lookup unless the caller asks for fewer. */
export const ABOUT_FILE_DEFAULT_LIMIT = 5;

/** Longest excerpt an about-file doc carries. */
const ABOUT_FILE_EXCERPT_CHARS = 200;

export interface MissingMention {
  kind: "file" | "symbol";
  target: string;
}

/**
 * Brings the mentions of `projectIds` up to date; a failure is logged and
 * leaves the previous mentions in place — the marker is advisory.
 */
export function refreshProjectsCodeMentions(store: KnowledgeStore, projectIds: Iterable<string>): void {
  for (const projectId of new Set(projectIds)) {
    try {
      refreshCodeMentions(store, projectId);
    } catch (err) {
      console.error(`[code-mentions] refreshing ${projectId} failed:`, err);
    }
  }
}

/**
 * Per hit id, the files/symbols it names that are no longer in its project's
 * code index. Refreshes the hits' projects first, which costs one indexed
 * query per project when no doc or index changed.
 */
export function missingMentionsFor(
  store: KnowledgeStore,
  hits: ReadonlyArray<{ id: string; projectId: string }>
): Map<string, MissingMention[]> {
  if (hits.length === 0) return new Map();
  refreshProjectsCodeMentions(
    store,
    hits.map((h) => h.projectId)
  );
  try {
    return store.missingCodeMentions(hits.map((h) => h.id));
  } catch (err) {
    console.error("[code-mentions] missing-mention check failed:", err);
    return new Map();
  }
}

/**
 * Moves each flagged item down past up to `positions` unflagged items that
 * follow it; flagged items keep their order among themselves.
 */
export function demoteMissingMentions<T>(
  items: readonly T[],
  flagged: (item: T) => boolean,
  positions = MISSING_MENTION_DEMOTION
): T[] {
  const out = [...items];
  for (let i = out.length - 1; i >= 0; i--) {
    if (!flagged(out[i])) continue;
    let j = i;
    let passed = 0;
    while (passed < positions && j + 1 < out.length && !flagged(out[j + 1])) {
      j++;
      passed++;
    }
    if (j === i) continue;
    const [item] = out.splice(i, 1);
    out.splice(j, 0, item);
  }
  return out;
}

/** The marker text for a doc's missing mentions: "names 2 symbols no longer in the code: x, y". */
export function describeMissingMentions(missing: readonly MissingMention[]): string {
  const files = missing.filter((m) => m.kind === "file").length;
  const symbols = missing.length - files;
  const counts = [
    ...(files > 0 ? [`${files} ${files === 1 ? "file" : "files"}`] : []),
    ...(symbols > 0 ? [`${symbols} ${symbols === 1 ? "symbol" : "symbols"}`] : []),
  ].join(" and ");
  return `names ${counts} no longer in the code: ${missing.map((m) => m.target).join(", ")}`;
}

/**
 * A path as the project's code index knows it: an indexed file the path
 * names (repo-relative, or absolute into any checkout/worktree), else the
 * path relative to one of the project's repos, else — for an absolute path
 * into a file the index has not seen — the path re-rooted on an indexed
 * directory it ends with. Null when none applies.
 */
export function repoRelativePath(
  store: KnowledgeStore,
  projectId: string,
  path: string,
  repos: readonly string[] = []
): string | null {
  const p = path.trim().replace(/^(?:\.\/)+/, "");
  if (p.length === 0) return null;
  const indexed = resolveMentionedPath(store, projectId, p);
  if (indexed) return indexed;
  if (!p.startsWith("/")) return p;
  for (const repo of repos) {
    const root = repo.replace(/\/+$/, "");
    if (root && p.startsWith(`${root}/`)) return p.slice(root.length + 1);
  }
  const slash = p.lastIndexOf("/");
  const dir = p.slice(0, slash);
  const parent = dir.slice(dir.lastIndexOf("/") + 1);
  if (!parent) return null;
  let best: string | null = null;
  for (const file of store.lookupPaths(projectId, `${parent}/`, { limit: 200 })) {
    const fileDir = file.slice(0, file.lastIndexOf("/"));
    if (fileDir && (dir === fileDir || dir.endsWith(`/${fileDir}`)) && (!best || fileDir.length > best.length)) {
      best = fileDir;
    }
  }
  return best ? `${best}${p.slice(slash)}` : null;
}

export interface AboutFileDoc {
  id: string;
  projectId: string;
  slug: string;
  title: string;
  /** The doc line naming the file (or its symbol), else its first prose line. */
  excerpt: string;
  /** "file": names the path; "symbol": names a symbol defined in it; "directory": names a sibling file. */
  match: "file" | "symbol" | "directory";
  /** The mentions that matched, as the doc wrote them. */
  mentions: string[];
  missingMentions?: MissingMention[];
}

/**
 * The confident docs about one file of a project: docs naming the file or a
 * symbol defined in it, then docs naming a file in the same directory. Only
 * docs inside `audience` whose verdict is admissible (not disputed, superseded
 * or the losing side of a contradiction) are returned. This is the lookup the
 * knowledge_for_file tool and a first-edit push both read.
 */
export function docsAboutFile(
  store: KnowledgeStore,
  opts: {
    projectId: string;
    path: string;
    audience: ScopeAudience;
    repos?: readonly string[];
    limit?: number;
    /**
     * Re-index the project's mentions first (default true). A hook-path caller
     * passes false and reads the mentions table as the indexer pass left it,
     * since a refresh walks the project's docs and code.
     */
    refresh?: boolean;
  }
): { path: string | null; docs: AboutFileDoc[] } {
  const limit = opts.limit ?? ABOUT_FILE_DEFAULT_LIMIT;
  if (opts.refresh !== false) refreshProjectsCodeMentions(store, [opts.projectId]);
  const path = repoRelativePath(store, opts.projectId, opts.path, opts.repos);
  if (!path) return { path: null, docs: [] };

  // Over-fetch: the audience and verdict gates below drop some.
  const hits = store.docsMentioningPath(opts.projectId, path, { limit: limit * 4 });
  const docs: AboutFileDoc[] = [];
  for (const hit of hits) {
    if (docs.length >= limit) break;
    const doc = store.getDocById(hit.docId);
    if (!doc || !isConfidentAboutFile(doc) || !docInAudience(doc, opts.audience)) continue;
    const match = hit.match === "directory" ? "directory" : hit.mentions.some((m) => m.kind === "file") ? "file" : "symbol";
    docs.push({
      id: doc.id,
      projectId: doc.projectId,
      slug: doc.slug,
      title: doc.title,
      excerpt: excerptFor(doc.body, hit.mentions),
      match,
      mentions: hit.mentions.map((m) => m.mention),
    });
  }
  const missing = store.missingCodeMentions(docs.map((d) => d.id));
  for (const d of docs) {
    const m = missing.get(d.id);
    if (m) d.missingMentions = m;
  }
  return { path, docs };
}

/**
 * Whether a doc may be offered as being about a file. Stricter than search,
 * which returns a disputed doc with its marker: a file lookup (and a push on
 * first edit) has no query to weigh a marker against, so a disputed doc is
 * left out along with everything isVerdictAdmissible holds back. A
 * contradicted doc carries no side here, so it is held out too.
 */
function isConfidentAboutFile(doc: KnowledgeDoc): boolean {
  return doc.verdict !== "disputed" && isVerdictAdmissible(doc, "search");
}

/** The first body line naming one of `mentions`, else the first prose line; trimmed of markdown. */
function excerptFor(body: string, mentions: readonly CodeMentionRow[]): string {
  const lines = body.split("\n").map((l) => l.trim());
  const named = lines.find((l) => mentions.some((m) => l.includes(m.mention)));
  const prose = lines.find((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("---") && !l.startsWith("```"));
  const line = (named ?? prose ?? "").replace(/^(?:[#>*-]+\s*)+/, "").replace(/\s+/g, " ");
  return line.length > ABOUT_FILE_EXCERPT_CHARS ? `${line.slice(0, ABOUT_FILE_EXCERPT_CHARS - 1)}…` : line;
}
