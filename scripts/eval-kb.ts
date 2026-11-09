#!/usr/bin/env bun
/**
 * The knowledge eval: runs the labeled cases in packages/knowledge/eval against
 * the real search / code / inject / persona surfaces and reports retrieval,
 * leakage, staleness and index-integrity metrics.
 *
 *   bun run eval:kb [--gate] [--label <name>] [--snapshot [db-copy]] [--migrate] …
 *
 * Never touches the live DB or knowledge dir: the fixture tier builds a temp DB
 * and corpus copy; the snapshot tier copies the given DB before opening it.
 * See packages/knowledge/eval/FORMAT.md and `bun run eval:kb --help`.
 */

import type { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { join } from "path";
import { main, type MigrateHook } from "../packages/collector/src/kbeval/cli.ts";
import { hostUserAlias } from "../packages/collector/src/host-user.ts";
import { DEFAULT_MIGRATIONS, formatReport, runMigrations } from "./kb-migrations/index.ts";

const evalDir = join(import.meta.dir, "..", "packages", "knowledge", "eval");

/**
 * `--migrate`: every default (non-opt-in) knowledge-data migration, applied
 * DB-only to the run's temp DB. The snapshot tier's source checkout
 * (local/repo) stands in for the repo of each project that has one configured,
 * so its `plan/` dir is the DB-only signal for which docs the project-docs
 * ingest mirrored.
 */
const migrate: MigrateHook = async (db: Database, tier, dir) => {
  const planDir = join(dir, "local", "repo", "plan");
  const planDirs = new Map<string, string>();
  if (tier === "snapshot" && existsSync(planDir)) {
    const projects = db.query("SELECT id, repos_json FROM projects").all() as Array<{ id: string; repos_json: string | null }>;
    for (const p of projects) {
      const repos = JSON.parse(p.repos_json ?? "[]") as string[];
      if (repos.length > 0) planDirs.set(p.id, planDir);
    }
  }
  const reports = await runMigrations(db, DEFAULT_MIGRATIONS, { apply: true, hostUser: hostUserAlias(), planDirs });
  return reports.map((report) => formatReport(report));
};

process.exit(await main(process.argv.slice(2), evalDir, migrate));
