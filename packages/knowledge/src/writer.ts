import { readFile, writeFile, unlink, mkdir, readdir, rename } from "fs/promises";
import { existsSync } from "fs";
import { join, basename } from "path";
import matter from "gray-matter";

/**
 * File-level CRUD for knowledge docs.
 *
 * Markdown files on disk stay the source of truth rather than the database:
 * they are editable outside the console, greppable, and survive the database
 * being deleted. SQLite is an index over them, rebuilt by sync.
 */

export interface KnowledgeDocInput {
  slug: string;
  title: string;
  body: string;
  tags?: string[];
}

export interface KnowledgeDocFile {
  slug: string;
  title: string;
  body: string;
  tags: string[];
  updatedAt: Date;
}

/**
 * Slugs become filenames and are used in URLs, so they are constrained
 * rather than sanitized — silently rewriting what someone typed makes the
 * doc hard to find again.
 */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/i.test(slug);
}

function docPath(knowledgeDir: string, projectId: string, slug: string): string {
  return join(knowledgeDir, projectId, `${slug}.md`);
}

function draftPath(knowledgeDir: string, projectId: string, slug: string): string {
  return join(knowledgeDir, projectId, ".drafts", `${slug}.md`);
}

export async function listKnowledgeFiles(
  knowledgeDir: string,
  projectId: string
): Promise<KnowledgeDocFile[]> {
  const dir = join(knowledgeDir, projectId);
  if (!existsSync(dir)) return [];

  const files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
  const docs: KnowledgeDocFile[] = [];

  for (const file of files) {
    const doc = await readKnowledgeFile(knowledgeDir, projectId, basename(file, ".md"));
    if (doc) docs.push(doc);
  }

  return docs.sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function readKnowledgeFile(
  knowledgeDir: string,
  projectId: string,
  slug: string
): Promise<KnowledgeDocFile | null> {
  const path = docPath(knowledgeDir, projectId, slug);
  if (!existsSync(path)) return null;

  try {
    const raw = await readFile(path, "utf-8");
    const { data, content } = matter(raw);
    const frontmatter = data as { title?: string; tags?: string[] };
    const { mtime } = await Bun.file(path).stat();

    return {
      slug,
      title: frontmatter.title ?? slug,
      body: content.trim(),
      tags: frontmatter.tags ?? [],
      updatedAt: mtime,
    };
  } catch {
    return null;
  }
}

export async function writeKnowledgeFile(
  knowledgeDir: string,
  projectId: string,
  doc: KnowledgeDocInput
): Promise<void> {
  if (!isValidSlug(doc.slug)) {
    throw new Error(
      "Slug must be letters, numbers and hyphens — it becomes a filename."
    );
  }

  const dir = join(knowledgeDir, projectId);
  await mkdir(dir, { recursive: true });

  // gray-matter's stringify handles escaping, which hand-rolling YAML would
  // get wrong the first time a title contains a colon.
  const contents = matter.stringify(doc.body.trim() + "\n", {
    title: doc.title,
    ...(doc.tags?.length ? { tags: doc.tags } : {}),
  });

  await writeFile(docPath(knowledgeDir, projectId, doc.slug), contents, "utf-8");
}

export async function deleteKnowledgeFile(
  knowledgeDir: string,
  projectId: string,
  slug: string
): Promise<boolean> {
  const path = docPath(knowledgeDir, projectId, slug);
  if (!existsSync(path)) return false;
  await unlink(path);
  return true;
}

export interface KnowledgeDraftInput extends KnowledgeDocInput {
  generatedFromSha?: string;
  generatedAt?: string;
  generatedByLaunchId?: string;
  replacesSlug?: string;
}

export async function writeDraftFile(
  knowledgeDir: string,
  projectId: string,
  draft: KnowledgeDraftInput
): Promise<void> {
  if (!isValidSlug(draft.slug)) {
    throw new Error(
      "Slug must be letters, numbers and hyphens — it becomes a filename."
    );
  }

  const dir = join(knowledgeDir, projectId, ".drafts");
  await mkdir(dir, { recursive: true });

  const contents = matter.stringify(draft.body.trim() + "\n", {
    title: draft.title,
    ...(draft.tags?.length ? { tags: draft.tags } : {}),
    ...(draft.generatedFromSha ? { generated_from_sha: draft.generatedFromSha } : {}),
    ...(draft.generatedAt ? { generated_at: draft.generatedAt } : {}),
    ...(draft.generatedByLaunchId ? { generated_by_launch_id: draft.generatedByLaunchId } : {}),
    ...(draft.replacesSlug ? { replaces_slug: draft.replacesSlug } : {}),
  });

  await writeFile(draftPath(knowledgeDir, projectId, draft.slug), contents, "utf-8");
}

/**
 * Moves `.drafts/{slug}.md` up to `{slug}.md`. A plain rename rather than a
 * read-and-rewrite, deliberately: re-serializing through gray-matter would
 * risk reformatting the provenance frontmatter the point of this function is
 * to preserve.
 */
export async function acceptDraftFile(
  knowledgeDir: string,
  projectId: string,
  slug: string
): Promise<boolean> {
  const from = draftPath(knowledgeDir, projectId, slug);
  if (!existsSync(from)) return false;

  const to = docPath(knowledgeDir, projectId, slug);
  await mkdir(join(knowledgeDir, projectId), { recursive: true });
  await rename(from, to);
  return true;
}

export async function deleteDraftFile(
  knowledgeDir: string,
  projectId: string,
  slug: string
): Promise<boolean> {
  const path = draftPath(knowledgeDir, projectId, slug);
  if (!existsSync(path)) return false;
  await unlink(path);
  return true;
}
