import type { CodeMentionRow, KnowledgeStore } from "./store.js";

/**
 * Doc→code mentions: the repo files and code symbols a knowledge doc names,
 * resolved against the project's HEAD symbol index (`code_symbols`).
 *
 * A doc claims things about code by naming it — `packages/x/src/store.ts`,
 * `lookupSymbols()`, `KnowledgeStore.getDoc`. Recording which of those names
 * resolved to real files/symbols gives two things the prose alone cannot: a
 * read-time check that the code a doc talks about still exists (a mention that
 * resolved once and no longer does is a stale claim), and a lookup from a file
 * to the docs about it.
 *
 * Extraction is deliberately conservative and resolution is the filter: a name
 * is only recorded when the index knows it, so prose that happens to look like
 * an identifier costs nothing unless the repo really defines it. Mentions live
 * in their own table rather than the doc↔doc edge set, because their far end is
 * a file or symbol, not a doc, and they follow the code index's revision rather
 * than the corpus's.
 */

export type CodeMentionKind = "file" | "symbol";

/** One name a doc body mentions, before resolution. */
export interface ExtractedCodeMention {
  kind: CodeMentionKind;
  /** The path or symbol as written (paths with a leading `./` and `:line` removed). */
  mention: string;
  /**
   * Symbol names to try against the index, best first: the member of a dotted
   * name, then its owner (`Foo.bar` → `bar`, `Foo`). Paths have none.
   */
  candidates: string[];
}

/** Extensions a mentioned path must end in to count as a file reference. */
const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "py", "java", "kt", "kts", "go", "rs", "rb",
  "c", "h", "cc", "cpp", "hpp", "cs", "swift", "scala", "sh", "sql", "json", "yaml", "yml", "toml",
  "md", "mdx", "css", "scss", "html", "vue", "svelte", "proto", "graphql",
]);

/** Most mentions recorded per doc, bounding a doc that is mostly a file listing. */
export const MAX_MENTIONS_PER_DOC = 64;

/** Identifiers that read as code in backticks but are language keywords or literals. */
const SYMBOL_STOPWORDS = new Set([
  "true", "false", "null", "undefined", "default", "this", "self", "None", "True", "False", "void",
  "async", "await", "return", "const", "let", "var", "function", "class", "import", "export",
]);

const URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s`)\]>]+/gi;
const INLINE_CODE = /`([^`\n]+)`/g;
const FENCE = /^\s*(```|~~~)/;
// A path token: optional ./, ../, / or ~/ prefix, any number of segments, a
// file name with a letter-led extension, and an optional :line suffix. The
// lookarounds keep it from starting or ending inside a longer word.
const PATH_TOKEN =
  /(?<![\w./@~-])((?:\.{1,2}\/|~\/|\/)*(?:[\w@.-]+\/)*[\w@-][\w@.-]*\.([A-Za-z][A-Za-z0-9]*))(?::\d+(?::\d+)?)?(?![\w/-])/g;
const WHOLE_PATH = new RegExp(`^${PATH_TOKEN.source}$`);
const SYMBOL_SPAN = /^([A-Za-z_$][\w$]*(?:(?:\.|::|#)[A-Za-z_$][\w$]*)*)(\([^()]*\))?;?$/;

/**
 * The files and symbols a doc body names. Paths are taken from inline code,
 * fenced blocks and prose (prose and fences only when the path has a directory,
 * so `Node.js` or `e.g.` never reads as a file); symbols only from inline code
 * spans, and only when they look like code — camelCase, PascalCase with two
 * humps, snake/SCREAMING case, a dotted member, or a call `foo()`. URLs are
 * dropped before either pass. Order is first appearance; duplicates collapse.
 */
export function extractCodeMentions(body: string): ExtractedCodeMention[] {
  const out = new Map<string, ExtractedCodeMention>();
  const add = (m: ExtractedCodeMention): void => {
    if (out.size >= MAX_MENTIONS_PER_DOC) return;
    const key = `${m.kind}\0${m.mention}`;
    if (!out.has(key)) out.set(key, m);
  };
  const addPaths = (text: string, requireDir: boolean): void => {
    for (const match of text.matchAll(PATH_TOKEN)) {
      const path = normalizePath(match[1]);
      if (!path || !CODE_EXTENSIONS.has(match[2].toLowerCase())) continue;
      if (requireDir && !path.includes("/")) continue;
      add({ kind: "file", mention: path, candidates: [] });
    }
  };

  let inFence = false;
  for (const rawLine of body.split("\n")) {
    if (FENCE.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    const line = rawLine.replace(URL, " ");
    if (inFence) {
      addPaths(line, true);
      continue;
    }
    for (const span of line.matchAll(INLINE_CODE)) {
      const content = span[1].trim();
      const whole = content.match(WHOLE_PATH);
      // `Foo.bar` has the shape of a file name too; only a code extension makes it one.
      if (whole && CODE_EXTENSIONS.has(whole[2].toLowerCase())) {
        addPaths(content, false);
        continue;
      }
      const symbol = symbolCandidates(content);
      if (symbol) {
        add({ kind: "symbol", mention: symbol.mention, candidates: symbol.candidates });
        continue;
      }
      addPaths(content, true);
    }
    addPaths(line.replace(INLINE_CODE, " "), true);
  }
  return [...out.values()];
}

/** A path with any leading `./` / `../` segments removed; absolute paths keep their root. */
function normalizePath(path: string): string {
  return path.replace(/^(?:\.\.?\/)+/, "");
}

/** Whether a single identifier reads as code rather than an ordinary word. */
function looksLikeCode(name: string, called: boolean): boolean {
  if (name.length < 3 || SYMBOL_STOPWORDS.has(name)) return false;
  if (called) return true;
  return (
    /[a-z][A-Z]/.test(name) ||
    /^[A-Z][a-z0-9]+[A-Z]/.test(name) ||
    (/_/.test(name) && /[A-Za-z]/.test(name))
  );
}

function symbolCandidates(content: string): { mention: string; candidates: string[] } | null {
  const m = content.match(SYMBOL_SPAN);
  if (!m) return null;
  const called = m[2] !== undefined;
  const segments = m[1].split(/\.|::|#/);
  const last = segments[segments.length - 1];
  const candidates: string[] = [];
  if (looksLikeCode(last, called)) candidates.push(last);
  for (let i = segments.length - 2; i >= 0; i--) {
    if (looksLikeCode(segments[i], false) && !candidates.includes(segments[i])) candidates.push(segments[i]);
  }
  return candidates.length > 0 ? { mention: m[1], candidates } : null;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * The indexed file a mentioned path names, or null when the index has none or
 * the path is ambiguous. A repo-relative path matches exactly or as a suffix
 * (`src/store.ts` names `packages/knowledge/src/store.ts` when that is the only
 * such file); an absolute path matches the longest indexed file it ends with,
 * so a path into any checkout or worktree of the repo resolves.
 */
export function resolveMentionedPath(store: KnowledgeStore, projectId: string, path: string): string | null {
  const files = store.codeFilesNamed(projectId, baseName(path));
  if (files.length === 0) return null;
  if (files.includes(path)) return path;
  const contained = files.filter((f) => path.endsWith(`/${f}`)).sort((a, b) => b.length - a.length);
  if (contained.length > 0) return contained[0];
  if (path.startsWith("/") || path.startsWith("~")) return null;
  const suffixed = files.filter((f) => f.endsWith(`/${path}`));
  return suffixed.length === 1 ? suffixed[0] : null;
}

function resolveMention(
  store: KnowledgeStore,
  docId: string,
  projectId: string,
  m: ExtractedCodeMention
): CodeMentionRow | null {
  if (m.kind === "file") {
    const file = resolveMentionedPath(store, projectId, m.mention);
    return file
      ? { docId, projectId, kind: "file", mention: m.mention, target: file, file, line: null, nameKey: baseName(file) }
      : null;
  }
  for (const name of m.candidates) {
    const defs = store.symbolDefinitions(projectId, name);
    if (defs.length === 0) continue;
    return {
      docId,
      projectId,
      kind: "symbol",
      mention: m.mention,
      target: name,
      file: defs[0].file,
      line: defs[0].line,
      nameKey: name,
    };
  }
  return null;
}

/**
 * Brings a project's doc→code mentions up to date with its docs and code index.
 * Only docs whose body or the code index changed since their last pass are
 * re-read, so a call with nothing new costs one indexed query. A mention that
 * resolved before but no longer does is kept as it was recorded — that is
 * exactly the stale claim the read-time check reports — until the doc stops
 * naming it. Rows of deleted docs are dropped. Idempotent.
 */
export function refreshCodeMentions(store: KnowledgeStore, projectId: string): { refreshed: number } {
  const revision = store.codeSymbolRevision();
  const pending = store.docsNeedingCodeMentions(projectId, revision);
  for (const doc of pending) {
    const previous = new Map(store.getCodeMentions(doc.id).map((r) => [`${r.kind}\0${r.mention}`, r]));
    const rows: CodeMentionRow[] = [];
    for (const m of extractCodeMentions(doc.body)) {
      const row = resolveMention(store, doc.id, projectId, m) ?? previous.get(`${m.kind}\0${m.mention}`);
      if (row) rows.push(row);
    }
    store.replaceCodeMentions(doc.id, projectId, rows, doc.fingerprint);
  }
  store.pruneCodeMentions(projectId);
  return { refreshed: pending.length };
}
