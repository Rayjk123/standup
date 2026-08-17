import { readdir, readFile, stat, watch } from "fs/promises";
import { join, basename } from "path";
import matter from "gray-matter";
import type { KnowledgeDoc, KnowledgeFrontmatter, KnowledgeDraft, DraftFrontmatter } from "./types.js";
import { randomUUID } from "crypto";

const DRAFTS_SUBDIR = ".drafts";

export class KnowledgeLoader {
  private knowledgeDir: string;
  private onChange?: (projectId: string, docs: KnowledgeDoc[]) => void;
  private abortController?: AbortController;

  constructor(knowledgeDir: string) {
    this.knowledgeDir = knowledgeDir;
  }

  async loadProject(projectId: string): Promise<KnowledgeDoc[]> {
    const projectDir = join(this.knowledgeDir, projectId);
    const docs: KnowledgeDoc[] = [];

    try {
      const files = await readdir(projectDir);

      for (const file of files) {
        // Also excludes .drafts itself: readdir returns the directory name
        // unqualified, which fails this same check. Relied on rather than
        // asserted here — see loader.test.ts for the assertion, since Step 1
        // makes this load-bearing instead of accidental.
        if (!file.endsWith(".md")) continue;

        const filePath = join(projectDir, file);
        const [content, fileStat] = await Promise.all([
          readFile(filePath, "utf-8"),
          stat(filePath),
        ]);
        const { data, content: body } = matter(content);
        const frontmatter = data as KnowledgeFrontmatter;

        const slug = basename(file, ".md");

        docs.push({
          id: randomUUID(),
          projectId,
          slug,
          title: frontmatter.title ?? slug,
          body: body.trim(),
          tags: frontmatter.tags,
          // The file's real mtime, not "now" — this is what lets syncProject
          // skip re-embedding unchanged files on every lazy resync.
          updatedAt: fileStat.mtime,
          filePath,
          // Carried over when acceptDraftFile moves a draft up — undefined
          // (not "") for a human-authored doc, per the empty-string-is-not-
          // NULL gotcha in runbook.md.
          generatedFromSha: frontmatter.generated_from_sha,
          generatedAt: frontmatter.generated_at,
        });
      }
    } catch (err) {
      // Directory doesn't exist yet, that's fine
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }

    return docs;
  }

  /**
   * Mirrors loadProject over `.drafts/` instead of the project directory.
   * Kept as a separate method (rather than a flag on loadProject) because the
   * two produce different shapes — a draft has no embedding and carries
   * review provenance loadProject's callers don't expect.
   */
  async loadDrafts(projectId: string): Promise<KnowledgeDraft[]> {
    const draftsDir = join(this.knowledgeDir, projectId, DRAFTS_SUBDIR);
    const drafts: KnowledgeDraft[] = [];

    try {
      const files = await readdir(draftsDir);

      for (const file of files) {
        if (!file.endsWith(".md")) continue;

        const filePath = join(draftsDir, file);
        const [content, fileStat] = await Promise.all([
          readFile(filePath, "utf-8"),
          stat(filePath),
        ]);
        const { data, content: body } = matter(content);
        const frontmatter = data as DraftFrontmatter;

        const slug = basename(file, ".md");

        drafts.push({
          id: randomUUID(),
          projectId,
          slug,
          title: frontmatter.title ?? slug,
          body: body.trim(),
          tags: frontmatter.tags,
          filePath,
          updatedAt: fileStat.mtime,
          generatedFromSha: frontmatter.generated_from_sha,
          generatedAt: frontmatter.generated_at,
          generatedByLaunchId: frontmatter.generated_by_launch_id,
          replacesSlug: frontmatter.replaces_slug,
          // The verification pass lives in the database, not the file, so a
          // draft freshly read off disk always starts here — upsertDraft
          // deliberately never writes these two columns, so a real verdict
          // already on the row survives this object overwriting everything
          // else on resync.
          verdict: "unverified",
          disputes: [],
        });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }

    return drafts;
  }

  async loadAll(projectIds: string[]): Promise<Map<string, KnowledgeDoc[]>> {
    const result = new Map<string, KnowledgeDoc[]>();

    for (const projectId of projectIds) {
      const docs = await this.loadProject(projectId);
      result.set(projectId, docs);
    }

    return result;
  }

  startWatching(
    projectIds: string[],
    onChange: (projectId: string, docs: KnowledgeDoc[]) => void
  ): void {
    this.onChange = onChange;
    this.abortController = new AbortController();

    for (const projectId of projectIds) {
      this.watchProject(projectId).catch((err) =>
        console.error(`[knowledge] Watcher for ${projectId} stopped unexpectedly:`, err)
      );
    }
  }

  private async watchProject(projectId: string): Promise<void> {
    const projectDir = join(this.knowledgeDir, projectId);

    try {
      const watcher = watch(projectDir, {
        recursive: true,
        signal: this.abortController?.signal,
      });

      for await (const event of watcher) {
        if (event.filename?.endsWith(".md")) {
          // Reload the entire project on any change
          const docs = await this.loadProject(projectId);
          this.onChange?.(projectId, docs);
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // Directory doesn't exist, skip watching
        return;
      }
      if ((err as Error).name === "AbortError") {
        // Watcher was stopped
        return;
      }
      throw err;
    }
  }

  stopWatching(): void {
    this.abortController?.abort();
  }
}
