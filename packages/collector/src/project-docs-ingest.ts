import { readFile, writeFile, readdir, mkdir, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import { readRawDocFile, redactOptionsFor, redactSecrets, writeRawDocFile } from "@standup/knowledge";

/**
 * Which repo-relative directory a project's committed design docs live in. The
 * corpus this feeds is the human-facing design/spec knowledge (`plan/*.md`),
 * not the code — a project's briefs, gap analyses, and review docs.
 */
const DEFAULT_DOCS_SUBDIR = "plan";

/**
 * Frontmatter key stamped on every corpus doc this ingest writes. Its presence
 * is the safety interlock for refresh and removal: the ingest only ever
 * overwrites or deletes a corpus file that carries this marker — a file it
 * authored itself — and never touches a human-curated doc (which never has it),
 * so hand-added `related:`/`edges:` frontmatter and edited copies are preserved.
 * The value is the absolute path of the repo source doc, so a later pass can
 * tell whether that source still exists.
 */
const INGEST_MARKER = "ingested_from";

export interface IngestableProject {
  id: string;
  repos: string[];
}

export interface ProjectDocsIngestResult {
  projectId: string;
  /** Slugs written for the first time this pass. */
  ingested: string[];
  /** Slugs whose corpus copy was rewritten because the repo source changed. */
  refreshed: string[];
  /** Slugs whose corpus copy was deleted because the repo source is gone. */
  removed: string[];
}

export interface ProjectDocsIngestOptions {
  /** Repo-relative docs directory. Defaults to STANDUP_PROJECT_DOCS_DIR or `plan`. */
  docsSubdir?: string;
}

/** Expands a leading `~` to the home directory; leaves other paths untouched. */
function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/** Absolute paths of every `.md` file under `dir`, recursively. Throws ENOENT
 *  when `dir` does not exist — the caller treats that as "no docs to ingest". */
async function walkMarkdown(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkMarkdown(full)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Reads the `ingested_from` value out of a corpus file's leading YAML
 * frontmatter, or null when the file has no frontmatter or no marker. Kept as a
 * hand parser (rather than pulling in gray-matter) because it only needs one
 * key off a block this module itself writes in a fixed shape — a dependency-free
 * read that never has to round-trip arbitrary YAML.
 */
export function parseIngestMarker(content: string): string | null {
  const fence = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!fence) return null;
  for (const line of fence[1].split(/\r?\n/)) {
    const m = /^ingested_from:\s*(.+)$/.exec(line);
    if (m) {
      const raw = m[1].trim();
      // The value is written via JSON.stringify (double-quoted); undo that when
      // present, else take the bare scalar.
      if (raw.startsWith('"')) {
        try {
          return JSON.parse(raw) as string;
        } catch {
          return raw;
        }
      }
      return raw;
    }
  }
  return null;
}

/** Strips a leading `---`-fenced frontmatter block so wrapping the body in a
 *  fresh block can't nest two of them. */
function stripLeadingFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

/** The doc title: the first Markdown heading, else the slug. */
function deriveTitle(body: string, slug: string): string {
  const m = /^#{1,6}[ \t]+(.+?)\s*#*\s*$/m.exec(body);
  return m ? m[1].trim() : slug;
}

/**
 * Renders the corpus file: a minimal frontmatter block over the source body,
 * stripped of any frontmatter of its own. A repo design doc is a spec written
 * by the project's own team, so it is stamped `source_kind: spec` (it reaches
 * launches as product context, never as code knowledge) and `origin_class:
 * owner`, beside the ingest marker.
 */
function buildCorpusDoc(title: string, sourceAbsPath: string, body: string): string {
  return [
    "---",
    `title: ${JSON.stringify(title)}`,
    "source_kind: spec",
    "origin_class: owner",
    `${INGEST_MARKER}: ${JSON.stringify(sourceAbsPath)}`,
    "---",
    "",
    stripLeadingFrontmatter(body).trimStart(),
    "",
  ].join("\n");
}

/** A source doc's body as the corpus holds it: front matter stripped, then
 *  redacted under the options the copy's placement calls for. */
function corpusBody(projectId: string, slug: string, sourceContent: string, scope?: unknown): string {
  const opts = redactOptionsFor({
    projectId,
    slug,
    sourceKind: "spec",
    scope: typeof scope === "string" ? scope : undefined,
  });
  return redactSecrets(stripLeadingFrontmatter(sourceContent), opts);
}

/**
 * Mirrors each project's committed design docs (`<repo>/plan/**\/*.md`) into the
 * knowledge corpus directory so a newly-committed doc becomes retrievable
 * through search_knowledge on the next collector boot — closing the
 * freshness gap where a doc was invisible until someone hand-copied it into the
 * corpus. Idempotent and non-destructive:
 *
 * - A brand-new source doc is written into `<knowledgeDir>/<projectId>/<slug>.md`
 *   with an `ingested_from` marker.
 * - A corpus doc WITHOUT that marker is human-curated and is never touched.
 * - A previously-ingested corpus doc is rewritten when its redacted body or its
 *   marker differs from the source's, so a change to the source or the
 *   redaction re-applies to every copy. Its front matter is carried over — a
 *   curator's relabel, re-scope or tags edit survives — and only the marker
 *   and an uncurated title (one still equal to the old body's heading) follow
 *   the source.
 * - A previously-ingested corpus doc whose repo source has been deleted (while
 *   the docs directory itself still exists, i.e. the repo is present) is removed
 *   so deletions propagate.
 *
 * Callers run this BEFORE the corpus sync so the written files are embedded on
 * the same boot. Only `repos[0]` is consulted; a project whose repo has no docs
 * directory is a silent no-op. Slugs are file basenames, so a duplicate basename
 * across subdirectories keeps the first seen and skips the rest.
 */
export async function ingestProjectDocs(
  knowledgeDir: string,
  projects: readonly IngestableProject[],
  options: ProjectDocsIngestOptions = {}
): Promise<ProjectDocsIngestResult[]> {
  const subdir =
    options.docsSubdir ?? process.env.STANDUP_PROJECT_DOCS_DIR ?? DEFAULT_DOCS_SUBDIR;
  const results: ProjectDocsIngestResult[] = [];

  for (const project of projects) {
    const repo = project.repos?.[0];
    if (!repo) continue;

    const docsDir = join(expandHome(repo), subdir);
    let sources: string[];
    try {
      sources = await walkMarkdown(docsDir);
    } catch {
      // No docs directory (or repo not mounted) — nothing to ingest, and
      // deliberately no removal either, so an unmounted /Volumes repo can't
      // delete its already-ingested corpus copies.
      continue;
    }

    const corpusProjectDir = join(knowledgeDir, project.id);
    const res: ProjectDocsIngestResult = {
      projectId: project.id,
      ingested: [],
      refreshed: [],
      removed: [],
    };

    const seenSlugs = new Set<string>();
    for (const sourcePath of sources) {
      const slug = basename(sourcePath, ".md");
      if (seenSlugs.has(slug)) continue; // duplicate basename — first wins
      seenSlugs.add(slug);

      const corpusPath = join(corpusProjectDir, `${slug}.md`);
      const sourceContent = await readFile(sourcePath, "utf-8");

      let existing: string | null = null;
      try {
        existing = await readFile(corpusPath, "utf-8");
      } catch {
        existing = null;
      }

      if (existing !== null) {
        // A curated doc (no marker) is authoritative — leave it alone.
        if (parseIngestMarker(existing) === null) continue;
        const file = await readRawDocFile(knowledgeDir, project.id, slug);
        if (!file) continue;
        const body = corpusBody(project.id, slug, sourceContent, file.data.scope);
        // Ours: rewrite only when the body or the marker changed.
        if (file.content.trim() === body.trim() && file.data[INGEST_MARKER] === sourcePath) continue;
        const oldTitle = file.data.title;
        const titleCurated = typeof oldTitle === "string" && oldTitle !== deriveTitle(file.content, slug);
        await writeRawDocFile(knowledgeDir, project.id, slug, {
          data: {
            ...file.data,
            title: titleCurated ? oldTitle : deriveTitle(body, slug),
            [INGEST_MARKER]: sourcePath,
          },
          content: `\n${body.trimStart().trimEnd()}\n`,
        });
        res.refreshed.push(slug);
      } else {
        const body = corpusBody(project.id, slug, sourceContent);
        await mkdir(corpusProjectDir, { recursive: true });
        await writeFile(corpusPath, buildCorpusDoc(deriveTitle(body, slug), sourcePath, body), "utf-8");
        res.ingested.push(slug);
      }
    }

    // Propagate deletions: an ingested copy whose repo source is gone. Guarded
    // on the docs directory existing (it does — walkMarkdown succeeded above),
    // so this never fires for an unmounted repo, and on the marker pointing
    // under this docs directory, so it only reclaims docs THIS pass owns.
    let corpusFiles: string[] = [];
    try {
      corpusFiles = (await readdir(corpusProjectDir)).filter((f) => f.endsWith(".md"));
    } catch {
      corpusFiles = [];
    }
    for (const file of corpusFiles) {
      const corpusPath = join(corpusProjectDir, file);
      const marker = parseIngestMarker(await readFile(corpusPath, "utf-8"));
      if (marker === null) continue; // curated — not ours to remove
      if (!marker.startsWith(docsDir)) continue; // ingested from elsewhere
      if (existsSync(marker)) continue; // source still there
      await unlink(corpusPath);
      res.removed.push(basename(file, ".md"));
    }

    results.push(res);
  }

  return results;
}
