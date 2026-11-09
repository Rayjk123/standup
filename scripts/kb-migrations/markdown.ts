/**
 * Markdown-side reads and edits a knowledge migration plans alongside its DB
 * edits. Files are enumerated off disk, so a migration given a knowledge dir
 * derives its file work from the files themselves rather than from DB rows that
 * an earlier DB-only run may already have changed. An edit is a text splice:
 * only the named front-matter keys' lines and, when redacted, the body change;
 * every other byte (comments, quoting, date formats, flow lists, markers,
 * provenance, edges) is kept.
 */

import { readFile, readdir, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { frontmatterBody, readRawDocFile } from "@standup/knowledge";

/** One accepted doc file: `<knowledgeDir>/<projectId>/<slug>.md`. */
export interface DocFileRef {
  projectId: string;
  slug: string;
  /** Path relative to the knowledge dir. */
  rel: string;
}

/** A doc file as text, its parsed front matter, and its body. */
export interface DocText {
  raw: string;
  data: Record<string, unknown>;
  body: string;
}

export const docRel = (projectId: string, slug: string) => join(projectId, `${slug}.md`);

/** Every accepted doc file under `knowledgeDir` (drafts and dot-dirs excluded), sorted. */
export async function listDocFiles(knowledgeDir: string): Promise<DocFileRef[]> {
  const out: DocFileRef[] = [];
  const projects = (await readdir(knowledgeDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
  for (const projectId of projects) {
    const files = (await readdir(join(knowledgeDir, projectId), { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name)
      .sort();
    for (const name of files) {
      const slug = name.slice(0, -".md".length);
      out.push({ projectId, slug, rel: docRel(projectId, slug) });
    }
  }
  return out;
}

/** The doc file as text plus its parsed front matter and body, or null when unreadable. */
export async function readDocText(knowledgeDir: string, ref: DocFileRef): Promise<DocText | null> {
  const parsed = await readRawDocFile(knowledgeDir, ref.projectId, ref.slug);
  if (!parsed) return null;
  const raw = await readFile(join(knowledgeDir, ref.rel), "utf-8");
  return { raw, data: parsed.data, body: frontmatterBody(raw) };
}

export function writeDocText(knowledgeDir: string, ref: DocFileRef, raw: string): Promise<void> {
  return writeFile(join(knowledgeDir, ref.rel), raw, "utf-8");
}

export function deleteDocFile(knowledgeDir: string, ref: DocFileRef): Promise<void> {
  return unlink(join(knowledgeDir, ref.rel));
}

/** A front-matter value as a change report prints it. */
export function fmValue(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value);
}
