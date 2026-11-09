#!/usr/bin/env bun
/**
 * Copy the sample knowledge docs shipped in seed/knowledge/ into this host's
 * knowledge dir, so a fresh install starts with a few docs that show the doc
 * format instead of an empty KB. A team can replace them with its own docs.
 *
 *   bun run kb:seed
 *
 * Targets the SAME KNOWLEDGE_DIR the collector uses (env-overridable). Never
 * overwrites: a doc already on disk at the same <project>/<path> is kept, so
 * re-running after local edits is safe. The collector indexes (and, with an
 * EMBEDDING_PROVIDER, embeds) the copied docs on its next sync — but only for
 * registered projects, so register seed/projects.toml's ids first.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export interface SeedResult {
  copied: number;
  skipped: number;
}

export function seedKnowledge(seedDir: string, knowledgeDir: string): SeedResult {
  const result: SeedResult = { copied: 0, skipped: 0 };
  for (const project of readdirSync(seedDir)) {
    const projectDir = join(seedDir, project);
    if (!statSync(projectDir).isDirectory()) continue;
    for (const file of readdirSync(projectDir, { recursive: true }) as string[]) {
      if (!file.endsWith(".md")) continue;
      const target = join(knowledgeDir, project, file);
      if (existsSync(target)) {
        result.skipped++;
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(projectDir, file), target);
      result.copied++;
    }
  }
  return result;
}

if (import.meta.main) {
  const SEED_DIR = join(import.meta.dir, "..", "seed", "knowledge");
  const KNOWLEDGE_DIR =
    process.env.KNOWLEDGE_DIR ?? join(homedir(), ".config", "standup", "knowledge");
  const { copied, skipped } = seedKnowledge(SEED_DIR, KNOWLEDGE_DIR);
  console.log(`[kb-seed] knowledge dir: ${KNOWLEDGE_DIR}`);
  console.log(`[kb-seed] copied=${copied} skipped(existing)=${skipped}`);
}
