#!/usr/bin/env bun
/**
 * Export a portable, knowledge-scoped bundle of a KB so it can be moved to
 * another host (e.g. a remote dev box) and loaded there with kb:import.
 *
 *   bun run kb:export <out-dir>
 *   bun run kb:export <out-dir> --from api [--collector-url <url>]
 *
 * The default source reads the SAME DB_PATH / KNOWLEDGE_DIR the collector uses
 * (env-overridable) and carries everything meaningful — markdown, verdicts,
 * telemetry, the contradiction ledger, the feed, and the embedded chunks —
 * WITHOUT copying the whole collector DB. It opens the source DB read-only, so
 * it is safe to run against a live install.
 *
 * `--from api` reads a running collector's read API instead (COLLECTOR_URL,
 * default http://localhost:7777) and writes a shareable bundle: published docs
 * and their verdicts, without the personal layer, native memories, persona
 * docs or superseded docs. It also writes the owner's Docs-tab docs under
 * `<out-dir>/docs/` (read with this launch's worker token, as the doc tools
 * do) and `<out-dir>/index.json`, which lists every doc and the graph's links.
 */

import { execFileSync } from "child_process";
import { mkdir, rm, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import {
  apiBundleSource,
  exportKnowledgeBundle,
  findRedactions,
  redactSecrets,
  type BundleManifest,
} from "@standup/knowledge";
import { workerTokenHeaders } from "../packages/mcp/src/tools.ts";

const DB_PATH =
  process.env.DB_PATH ?? join(homedir(), ".local", "share", "standup", "standup.db");
const KNOWLEDGE_DIR =
  process.env.KNOWLEDGE_DIR ?? join(homedir(), ".config", "standup", "knowledge");

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const from = flag("--from") ?? "db";
const collectorUrl = (flag("--collector-url") ?? process.env.COLLECTOR_URL ?? "http://localhost:7777").replace(/\/+$/, "");
const outDir = args.find((a, i) => !a.startsWith("-") && !args[i - 1]?.startsWith("--"));
if (!outDir || (from !== "db" && from !== "api")) {
  console.error("usage: bun run kb:export <out-dir> [--from db|api] [--collector-url <url>]");
  process.exit(1);
}

function printManifest(manifest: BundleManifest, sourceLabel: string): void {
  const c = manifest.counts;
  console.log(`[kb-export] wrote bundle to ${outDir}`);
  console.log(`[kb-export]   source:           ${sourceLabel}`);
  console.log(`[kb-export]   schema version:   ${manifest.sourceSchemaVersion}`);
  console.log(`[kb-export]   embedding fp:     ${manifest.embeddingFingerprint ?? "(none)"}`);
  console.log(
    `[kb-export]   docs=${c.docs} drafts=${c.drafts} chunks=${c.chunks} ` +
      `docVerdicts=${c.docVerdicts} draftVerdicts=${c.draftVerdicts} ` +
      `retrievals=${c.retrievals} resolutions=${c.resolutions} changes=${c.changes} ` +
      `knowledgeScopes=${c.knowledgeScopes}`
  );
  console.log(`[kb-export]   checksum:         ${manifest.contentChecksum}`);
}

if (from === "db") {
  const manifest = await exportKnowledgeBundle({ dbPath: DB_PATH, knowledgeDir: KNOWLEDGE_DIR, outDir });
  printManifest(manifest, `${DB_PATH} + ${KNOWLEDGE_DIR}`);
  process.exit(0);
}

async function getJson<T>(path: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${collectorUrl}${path}`, { headers });
  if (!res.ok) throw new Error(`GET ${path} answered ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

// A re-export replaces what an earlier one wrote; other files in outDir stay.
await rm(join(outDir, "knowledge"), { recursive: true, force: true });
await rm(join(outDir, "docs"), { recursive: true, force: true });

const { source, report } = apiBundleSource({ collectorUrl });
const manifest = await exportKnowledgeBundle({ source, outDir });

// Docs-tab docs, by the routes list_docs and read_doc use. Their images are
// served only to the signed-in console, so a doc's image links are kept as
// written and listed in index.json as not exported.
const docHeaders = workerTokenHeaders();
const docRedactions: Array<{ path: string; patterns: Record<string, number> }> = [];
const missingImages: Array<{ doc: string; src: string }> = [];
const docsTab: Array<{ path: string; revision: number; updatedAt: string }> = [];
if (Object.keys(docHeaders).length === 0) {
  console.warn("[kb-export] no worker token (STANDUP_WORKER_TOKEN_FILE): Docs-tab docs skipped");
} else {
  const list = await getJson<{ docs: Array<{ path: string; revision: number; updatedAt: string }> }>(
    "/api/docs/list",
    docHeaders
  );
  for (const entry of list.docs) {
    const { doc } = await getJson<{ doc: { body: string } }>(
      `/api/docs/read?path=${encodeURIComponent(entry.path)}`,
      docHeaders
    );
    const patterns: Record<string, number> = {};
    for (const span of findRedactions(doc.body)) patterns[span.pattern] = (patterns[span.pattern] ?? 0) + 1;
    if (Object.keys(patterns).length) docRedactions.push({ path: entry.path, patterns });
    for (const m of doc.body.matchAll(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)) {
      if (!/^[a-z]+:/i.test(m[1]!)) missingImages.push({ doc: entry.path, src: m[1]! });
    }
    const name = entry.path.endsWith(".md") ? entry.path : `${entry.path}.md`;
    const dest = join(outDir, "docs", name);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, redactSecrets(doc.body), "utf-8");
    docsTab.push(entry);
  }
}

// The graph's links among the exported docs, keyed by project/slug.
const graph = await getJson<{
  nodes: Array<{ id: string; projectId: string; slug: string }>;
  edges: Array<{ source: string; target: string; kind: string; weight: number }>;
}>("/api/knowledge/graph");
const exported = new Set(report.written.map((d) => `${d.projectId}/${d.slug}`));
const refOf = new Map(graph.nodes.map((n) => [n.id, `${n.projectId}/${n.slug}`]));
const links = graph.edges
  .map((e) => ({ source: refOf.get(e.source), target: refOf.get(e.target), kind: e.kind, weight: e.weight }))
  .filter((e) => e.source && e.target && exported.has(e.source) && exported.has(e.target));

let standupCommit: string | null = null;
try {
  standupCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
} catch {
  // Not run from a checkout.
}

await writeFile(
  join(outDir, "index.json"),
  JSON.stringify(
    {
      exportedAt: manifest.exportedAt,
      standupCommit,
      knowledge: report.written.map((d) => ({ ...d, file: `knowledge/${d.projectId}/${d.slug}.md` })),
      links,
      docsTab: docsTab.map((d) => ({ ...d, file: `docs/${d.path}` })),
      // Counts only: a left-out doc's slug can itself be personal.
      excluded: report.excluded.reduce<Record<string, number>>((n, e) => ({ ...n, [e.reason]: (n[e.reason] ?? 0) + 1 }), {}),
      redacted: { knowledge: report.redacted, docsTab: docRedactions },
      imagesNotExported: missingImages,
    },
    null,
    2
  ) + "\n",
  "utf-8"
);

printManifest(manifest, collectorUrl);
console.log(`[kb-export]   docs tab:         ${docsTab.length} docs (${missingImages.length} image links not exported)`);
console.log(`[kb-export]   links:            ${links.length}`);
console.log(`[kb-export]   excluded:         ${report.excluded.length}`);
console.log(
  `[kb-export]   redacted docs:    ${report.redacted.length} knowledge, ${docRedactions.length} docs tab`
);
