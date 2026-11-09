#!/usr/bin/env bun
/**
 * Import a knowledge bundle produced by kb:export into this host's KB, restoring
 * everything meaningful with ZERO embedding calls (the embedded chunks are
 * carried, so no provider need be reachable here).
 *
 *   bun run kb:import <bundle-dir> [--force]
 *
 * Targets the SAME DB_PATH / KNOWLEDGE_DIR the collector uses (env-overridable).
 * Refuses a non-empty target unless --force (which overwrites matching
 * (project_id, slug) docs and leaves non-matching target docs untouched). Run it
 * against a STOPPED collector or a fresh location — never an in-use live DB.
 */

import { homedir } from "os";
import { join } from "path";
import { importKnowledgeBundle, tryEnableSqliteVecExtension } from "@standup/knowledge";

const DB_PATH =
  process.env.DB_PATH ?? join(homedir(), ".local", "share", "standup", "standup.db");
const KNOWLEDGE_DIR =
  process.env.KNOWLEDGE_DIR ?? join(homedir(), ".config", "standup", "knowledge");

const args = process.argv.slice(2);
const force = args.includes("--force");
const bundleDir = args.find((a) => !a.startsWith("-"));
if (!bundleDir) {
  console.error("usage: bun run kb:import <bundle-dir> [--force]");
  process.exit(1);
}

// Point bun:sqlite at an extension-capable SQLite BEFORE the store opens, so the
// vec0 KNN mirror can be rebuilt from the carried vectors. Auto-on when available
// and best-effort: it attempts the swap by default and is a clean no-op on a host
// without an extension-capable SQLite, where search falls back to the brute-force
// scan. STANDUP_DISABLE_VEC is the explicit opt-out; STANDUP_SQLITE_VEC no longer
// gates (its absence no longer disables the swap).
if (tryEnableSqliteVecExtension()) {
  console.log("[kb-import] sqlite-vec enabled — vec KNN mirror will be rebuilt");
}

const result = await importKnowledgeBundle({
  bundleDir,
  knowledgeDir: KNOWLEDGE_DIR,
  dbPath: DB_PATH,
  force,
});

console.log(`[kb-import] imported bundle from ${bundleDir}`);
console.log(`[kb-import]   target DB:        ${DB_PATH}`);
console.log(`[kb-import]   knowledge dir:    ${KNOWLEDGE_DIR}`);
console.log(`[kb-import]   embedding fp:     ${result.manifest.embeddingFingerprint ?? "(none)"}`);
console.log(
  `[kb-import]   docs=${result.docs} drafts=${result.drafts} ` +
    `chunks=${result.chunks} (skipped ${result.skippedChunks}) ` +
    `docVerdicts=${result.docVerdicts} draftVerdicts=${result.draftVerdicts} ` +
    `retrievals=${result.retrievals} resolutions=${result.resolutions} ` +
    `changes=${result.changes} knowledgeScopes=${result.knowledgeScopes}`
);
console.log(`[kb-import]   vec index rebuilt: ${result.vecRebuilt}`);
