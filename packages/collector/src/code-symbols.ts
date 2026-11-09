import type { Database } from "bun:sqlite";
import { spawn } from "bun";
import { getSetting, setSetting } from "@standup/store";
import type { CodeSymbolRow, KnowledgeStore } from "@standup/knowledge";
import { primaryRepoPath } from "./knowledge-staleness.js";

/**
 * A symbol/path index over each project's repo, keyed by the commit it was read
 * at.
 *
 * Retrieval's code arm is a pattern search: it can tell you which lines mention
 * a name, not where that name is DEFINED, so "where does `searchCode` live"
 * competes with every call site and every doc that mentions it. This index
 * answers the definition question directly — exported and top-level
 * declarations, plus the file paths themselves — by name or prefix lookup.
 *
 * Extraction is regex-based per language, deliberately: a parser per language
 * is a dependency and a maintenance burden for a lookup whose failure mode is a
 * missing row, and the declaration forms that matter (`export function`, `def`
 * at column 0, `func`, `class`) are unambiguous on one line. Anything the
 * regexes miss is simply not in the index; nothing downstream treats the index
 * as complete.
 *
 * It re-indexes when HEAD moves, and incrementally when git can name the files
 * a commit range touched. Both the check (`git rev-parse HEAD`) and the index
 * pass run in the background, after the server is listening — never on a
 * request path.
 */

/** Extensions indexed, with the extractor each one uses. */
const LANGUAGES: Record<string, (content: string) => ExtractedSymbol[]> = {
  ".ts": extractTypeScript,
  ".tsx": extractTypeScript,
  ".mts": extractTypeScript,
  ".cts": extractTypeScript,
  ".js": extractTypeScript,
  ".jsx": extractTypeScript,
  ".mjs": extractTypeScript,
  ".cjs": extractTypeScript,
  ".py": extractPython,
  ".java": extractJvm,
  ".kt": extractJvm,
  ".kts": extractJvm,
  ".go": extractGo,
};

/** Files larger than this are listed as paths but not scanned for symbols. */
const MAX_FILE_BYTES = 512_000;

/** Ceiling on files indexed per repo, so a monorepo can't stall the pass. */
const MAX_FILES = 20_000;

/** How often the indexer re-checks HEAD. */
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

/** Longest signature line kept. */
const SIGNATURE_CHARS = 200;

export interface ExtractedSymbol {
  name: string;
  kind: string;
  line: number;
  signature: string;
}

export interface IndexedProject {
  id: string;
  repos: string[];
}

export interface CodeSymbolIndexerOptions {
  db: Database;
  store: KnowledgeStore;
  /** Read per pass, so a project registered after boot is picked up. */
  projects: () => IndexedProject[];
  intervalMs?: number;
  maxFiles?: number;
  /** Called after every completed pass, with its outcomes (e.g. to re-resolve doc→code mentions). */
  onPass?: (outcomes: RepoIndexOutcome[]) => void;
}

export interface RepoIndexOutcome {
  projectId: string;
  repoPath: string;
  sha: string | null;
  /** "full" on a first index or when a commit range can't be diffed. */
  mode: "full" | "incremental" | "unchanged" | "skipped";
  files: number;
  symbols: number;
  reason?: string;
}

/** Settings key holding the HEAD a repo's index was last brought up to. */
function headKey(projectId: string, repoPath: string): string {
  return `code-symbols-head:${projectId}:${repoPath}`;
}

export class CodeSymbolIndexer {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private active: Promise<RepoIndexOutcome[]> | null = null;

  constructor(private opts: CodeSymbolIndexerOptions) {}

  /**
   * Schedules the first pass on the next turn of the event loop — after the
   * server is listening, like the embedding backfill — then re-checks HEAD on an
   * interval. The timer is unref'd so it never holds the process open.
   */
  start(): Promise<RepoIndexOutcome[]> {
    const interval = this.opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    const first = new Promise<RepoIndexOutcome[]>((resolve) => {
      setTimeout(() => resolve(this.indexAll()), 0);
    });
    this.timer = setInterval(() => void this.indexAll(), interval);
    this.timer.unref?.();
    return first;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass over every project with a repo. Passes never overlap. A completed
   * pass also drops the rows of any repo that is no longer a project's primary
   * repo (a project removed, or its repos[0] changed), so lookups never serve
   * symbols from a checkout nobody configures any more.
   */
  indexAll(): Promise<RepoIndexOutcome[]> {
    if (this.active) return this.active;
    this.active = (async () => {
      const outcomes: RepoIndexOutcome[] = [];
      const configured: Array<{ projectId: string; repoPath: string }> = [];
      try {
        for (const project of this.opts.projects()) {
          if (this.stopped) break;
          const repoPath = primaryRepoPath(project);
          if (!repoPath) continue;
          configured.push({ projectId: project.id, repoPath });
          try {
            outcomes.push(await this.indexRepo(project.id, repoPath));
          } catch (err) {
            console.error(`[code-symbols] indexing ${project.id} failed:`, err);
          }
        }
        if (!this.stopped) {
          this.opts.store.pruneCodeSymbols(configured);
          try {
            this.opts.onPass?.(outcomes);
          } catch (err) {
            console.error("[code-symbols] post-pass hook failed:", err);
          }
        }
      } finally {
        this.active = null;
      }
      return outcomes;
    })();
    return this.active;
  }

  /**
   * Brings one repo's index up to HEAD. A HEAD that hasn't moved since the last
   * pass costs exactly one `git rev-parse`; a HEAD that has moved and whose
   * predecessor is still in the clone costs a `git diff` and a read of just the
   * blobs it names.
   *
   * Everything is read from the HEAD commit's tree, never the working tree, so
   * the rows stamped with HEAD's sha describe HEAD even while the checkout has
   * uncommitted edits, and a tracked symlink is never followed.
   */
  async indexRepo(projectId: string, repoPath: string): Promise<RepoIndexOutcome> {
    const head = (await git(repoPath, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]))?.trim() ?? null;
    if (!head) {
      return {
        projectId,
        repoPath,
        sha: null,
        mode: "skipped",
        files: 0,
        symbols: 0,
        reason: "HEAD does not resolve in this clone",
      };
    }

    const indexed = getSetting(this.opts.db, headKey(projectId, repoPath));
    const hasRows = this.opts.store.codeSymbolStats(projectId, repoPath).files > 0;
    if (indexed === head && hasRows) {
      return { projectId, repoPath, sha: head, mode: "unchanged", files: 0, symbols: 0 };
    }

    const tree = await headTree(repoPath, head);
    if (!tree) {
      return {
        projectId,
        repoPath,
        sha: head,
        mode: "skipped",
        files: 0,
        symbols: 0,
        reason: "git could not list the repo's files",
      };
    }

    const maxFiles = this.opts.maxFiles ?? MAX_FILES;
    const touched = indexed && indexed !== head && hasRows ? await changedFiles(repoPath, indexed, head) : null;
    // A range touching more files than one pass may read is re-indexed in full
    // (itself capped), rather than leaving the overflow describing older commits.
    const changed = touched && touched.length <= maxFiles ? touched : null;
    const mode = changed ? "incremental" : "full";
    // Every path the pass replaces rows for: a full pass the whole tree, an
    // incremental one the paths the range touched — including ones deleted (or
    // renamed away) in it, which are absent from HEAD's tree and so just lose
    // their rows.
    const files = changed ?? [...tree.keys()].slice(0, maxFiles);
    const present = files.flatMap((file) => {
      const entry = tree.get(file);
      return entry ? [{ file, ...entry }] : [];
    });

    // A full pass replaces the whole repo, so a file deleted while the index was
    // stale cannot linger.
    if (mode === "full") this.opts.store.clearCodeSymbols(projectId, repoPath);

    const contents = await readBlobs(
      repoPath,
      present.filter((e) => e.size <= MAX_FILE_BYTES).map((e) => e.blob)
    );

    const rows: CodeSymbolRow[] = [];
    let indexedFiles = 0;
    for (const entry of present) {
      // An oversized blob keeps its path row with no symbols; one git could not
      // read is skipped entirely.
      const content = entry.size <= MAX_FILE_BYTES ? contents.get(entry.blob) : "";
      if (content === undefined) continue;
      indexedFiles++;
      // Every indexed file gets a path row, so lookupPaths covers files that
      // export nothing (configs, templates, a package's entry stub).
      rows.push({
        file: entry.file,
        line: 0,
        name: entry.file.split("/").pop() ?? entry.file,
        kind: "file",
        signature: undefined,
      });
      for (const symbol of extractSymbols(entry.file, content)) {
        rows.push({
          file: entry.file,
          line: symbol.line,
          name: symbol.name,
          kind: symbol.kind,
          signature: symbol.signature,
        });
      }
    }

    this.opts.store.replaceCodeSymbols(projectId, repoPath, head, files, rows);
    setSetting(this.opts.db, headKey(projectId, repoPath), head);

    return {
      projectId,
      repoPath,
      sha: head,
      mode,
      files: indexedFiles,
      symbols: rows.filter((r) => r.kind !== "file").length,
    };
  }
}

async function git(repoPath: string, args: string[]): Promise<string | null> {
  try {
    const proc = spawn(["git", ...args], { cwd: repoPath, stdout: "pipe", stderr: "pipe" });
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return proc.exitCode === 0 ? stdout : null;
  } catch {
    // A repo path that moved or never existed throws from spawn rather than
    // exiting nonzero — same degrade either way.
    return null;
  }
}

interface TreeEntry {
  blob: string;
  size: number;
}

/**
 * Indexable regular files in a commit's tree, by path, with their blob ids and
 * sizes — or null when git can't answer. Symlinks (mode 120000) and submodules
 * (160000) are left out: a link's target is not this repo's code.
 */
async function headTree(repoPath: string, commit: string): Promise<Map<string, TreeEntry> | null> {
  const out = await git(repoPath, ["ls-tree", "-r", "-z", "-l", "--full-tree", commit]);
  if (out === null) return null;
  const tree = new Map<string, TreeEntry>();
  for (const record of out.split("\0")) {
    // `<mode> <type> <object> <size>\t<path>`
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, blob, size] = record.slice(0, tab).trim().split(/\s+/);
    const path = record.slice(tab + 1);
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) continue;
    if (!isIndexable(path)) continue;
    tree.set(path, { blob, size: parseInt(size, 10) });
  }
  return tree;
}

/**
 * Indexable paths a commit range touched, or null when the range can't be
 * resolved — a rewritten history or a shallow clone drops the caller back to a
 * full re-index rather than leaving the index describing commits that are gone.
 * Rename detection is off, so a rename reports both its old path (whose rows
 * are cleared) and its new one.
 */
async function changedFiles(repoPath: string, from: string, to: string): Promise<string[] | null> {
  const out = await git(repoPath, ["diff", "--no-renames", "--name-only", "-z", `${from}..${to}`]);
  if (out === null) return null;
  return out.split("\0").filter((f) => f.length > 0 && isIndexable(f));
}

/** How many blobs one `git cat-file --batch` call reads, bounding its output. */
const BLOB_BATCH = 200;

/**
 * Blob contents by id, read with `git cat-file --batch` in bounded batches. A
 * blob git reports missing is simply absent from the map.
 */
async function readBlobs(repoPath: string, blobs: string[]): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  const unique = [...new Set(blobs)];
  for (let i = 0; i < unique.length; i += BLOB_BATCH) {
    const batch = unique.slice(i, i + BLOB_BATCH);
    let out: Uint8Array;
    try {
      const proc = spawn(["git", "cat-file", "--batch"], {
        cwd: repoPath,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const reading = new Response(proc.stdout).arrayBuffer();
      proc.stdin.write(batch.map((b) => `${b}\n`).join(""));
      await proc.stdin.end();
      out = new Uint8Array(await reading);
      await proc.exited;
    } catch {
      continue;
    }
    parseCatFileBatch(out, contents);
  }
  return contents;
}

/** Parses `<id> <type> <size>\n<bytes>\n` records (and `<id> missing\n`). */
function parseCatFileBatch(out: Uint8Array, into: Map<string, string>): void {
  const decoder = new TextDecoder();
  let pos = 0;
  while (pos < out.length) {
    const newline = out.indexOf(0x0a, pos);
    if (newline < 0) return;
    const header = decoder.decode(out.subarray(pos, newline)).split(" ");
    pos = newline + 1;
    if (header.length < 3) continue;
    const size = parseInt(header[2], 10);
    if (!Number.isFinite(size)) return;
    if (header[1] === "blob") into.set(header[0], decoder.decode(out.subarray(pos, pos + size)));
    pos += size + 1;
  }
}

function isIndexable(file: string): boolean {
  const dot = file.lastIndexOf(".");
  return dot > 0 && LANGUAGES[file.slice(dot)] !== undefined;
}

/** Dispatches to the extractor for a file's extension; unknown ones yield none. */
export function extractSymbols(file: string, content: string): ExtractedSymbol[] {
  const dot = file.lastIndexOf(".");
  const extractor = dot > 0 ? LANGUAGES[file.slice(dot)] : undefined;
  return extractor ? extractor(content) : [];
}

function signatureOf(line: string): string {
  return line.trim().slice(0, SIGNATURE_CHARS);
}

function extractTypeScript(content: string): ExtractedSymbol[] {
  const out: ExtractedSymbol[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const push = (name: string, kind: string): void => {
      out.push({ name, kind, line: i + 1, signature: signatureOf(line) });
    };
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/))) {
      push(m[1], "function");
    } else if ((m = line.match(/^export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/))) {
      push(m[1], "class");
    } else if ((m = line.match(/^export\s+interface\s+([A-Za-z_$][\w$]*)/))) {
      push(m[1], "interface");
    } else if ((m = line.match(/^export\s+type\s+([A-Za-z_$][\w$]*)/))) {
      push(m[1], "type");
    } else if ((m = line.match(/^export\s+(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/))) {
      push(m[1], "enum");
    } else if ((m = line.match(/^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/))) {
      push(m[1], "const");
    } else if ((m = line.match(/^export\s+default\s+(?:async\s+)?(?:function|class)\s*([A-Za-z_$][\w$]*)?/))) {
      // An anonymous default export is still worth a row: the file is the name
      // a caller imports it under.
      push(m[1] ?? "default", "default");
    } else if ((m = line.match(/^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/))) {
      push(m[1], "function");
    } else if ((m = line.match(/^(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/))) {
      push(m[1], "class");
    }
  }
  return out;
}

function extractPython(content: string): ExtractedSymbol[] {
  const out: ExtractedSymbol[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Column 0 only: a nested def is an implementation detail of its enclosing
    // definition, and indexing it buries the module-level names a lookup wants.
    const fn = line.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)/);
    const cls = line.match(/^class\s+([A-Za-z_]\w*)/);
    if (fn) out.push({ name: fn[1], kind: "function", line: i + 1, signature: signatureOf(line) });
    else if (cls) out.push({ name: cls[1], kind: "class", line: i + 1, signature: signatureOf(line) });
  }
  return out;
}

function extractJvm(content: string): ExtractedSymbol[] {
  const out: ExtractedSymbol[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const type = line.match(
      /\b(class|interface|enum|record|object)\s+([A-Za-z_$][\w$]*)/
    );
    const fn = line.match(/\bfun\s+([A-Za-z_$][\w$]*)/);
    if (type) {
      out.push({ name: type[2], kind: type[1], line: i + 1, signature: signatureOf(line) });
    } else if (fn) {
      out.push({ name: fn[1], kind: "function", line: i + 1, signature: signatureOf(line) });
    }
  }
  return out;
}

function extractGo(content: string): ExtractedSymbol[] {
  const out: ExtractedSymbol[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // A receiver (`func (s *Store) Get(...)`) is skipped past so the method's
    // own name is what lands in the index.
    const fn = line.match(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/);
    const type = line.match(/^type\s+([A-Za-z_]\w*)/);
    const value = line.match(/^(?:var|const)\s+([A-Za-z_]\w*)/);
    if (fn) out.push({ name: fn[1], kind: "function", line: i + 1, signature: signatureOf(line) });
    else if (type) out.push({ name: type[1], kind: "type", line: i + 1, signature: signatureOf(line) });
    else if (value) out.push({ name: value[1], kind: "const", line: i + 1, signature: signatureOf(line) });
  }
  return out;
}
