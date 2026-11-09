#!/usr/bin/env bun
/**
 * Retrieval-only knowledge eval: the real-shaped golden tier (R) and the
 * task-usefulness tier (U) over the synthetic fixture corpus, on the search,
 * recall and inject surfaces.
 *
 *   bun run eval:retrieval --out <dir> [--label <name>] [--now <iso>] [--offline]
 *
 * Writes <dir>/<label>.json and <dir>/<label>.md. The clock is pinned (--now,
 * default 2026-10-10T00:00:00Z) so a rerun reproduces the same numbers.
 * Embeddings come from the committed caches; a text missing from both is
 * fetched once from local Ollama and added to
 * packages/knowledge/eval/retrieval/embeddings, unless --offline. The Ollama
 * URL is STANDUP_EVAL_OLLAMA_URL (loopback only), default http://localhost:11434;
 * the run prints the endpoint it uses.
 *
 * Imports only the knowledge package's store, loader, embedding and search
 * modules (plus @standup/store and @standup/shared); no collector module. It
 * starts no server, spawns nothing and opens no live data.
 */

import { mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { renderMarkdown, runRetrievalEval } from "../packages/knowledge/src/eval-retrieval/index.ts";
import { OLLAMA_URL } from "../packages/knowledge/src/eval-retrieval/embedding-cache.ts";

const DEFAULT_NOW = "2026-10-10T00:00:00.000Z";

/**
 * The Ollama base URL embeddings are fetched from: STANDUP_EVAL_OLLAMA_URL, else
 * OLLAMA_URL. Only a loopback host is accepted, so the eval never sends corpus
 * text off the machine.
 */
function loopbackOllamaUrl(raw: string | undefined): string {
  const url = new URL(raw?.trim() || OLLAMA_URL);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error(`STANDUP_EVAL_OLLAMA_URL must be a loopback address, got ${url.hostname}`);
  }
  return url.origin;
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const out = argValue(args, "--out");
  if (!out) {
    console.error("usage: bun run eval:retrieval --out <dir> [--label <name>] [--now <iso>] [--offline]");
    process.exit(2);
  }
  const label = argValue(args, "--label") ?? "run";
  const now = new Date(argValue(args, "--now") ?? DEFAULT_NOW);
  if (!Number.isFinite(now.getTime())) throw new Error("--now must be an ISO timestamp");
  const evalDir = join(import.meta.dir, "..", "packages", "knowledge", "eval");
  const outDir = resolve(out);
  const fetchMissing = !args.includes("--offline");
  const ollamaUrl = loopbackOllamaUrl(process.env.STANDUP_EVAL_OLLAMA_URL);
  mkdirSync(outDir, { recursive: true });
  console.log(`embeddings endpoint: ${fetchMissing ? `${ollamaUrl}/api/embeddings` : "none (--offline)"}`);

  const { results, run } = await runRetrievalEval({
    corpusDir: join(evalDir, "corpus"),
    fixtureRepoDir: join(evalDir, "fixture-repo"),
    casesDir: join(evalDir, "retrieval"),
    baseEmbeddingsDir: join(evalDir, "embeddings"),
    harnessEmbeddingsDir: join(evalDir, "retrieval", "embeddings"),
    workDir: join(outDir, "work"),
    now,
    label,
    fetchMissing,
    ollamaUrl,
    user: "owner",
    hostUser: "owner",
  });

  writeFileSync(join(outDir, `${label}.json`), JSON.stringify(results, null, 2) + "\n");
  writeFileSync(join(outDir, `${label}.md`), renderMarkdown(results));
  writeFileSync(join(outDir, `${label}.run.json`), JSON.stringify(run, null, 2) + "\n");
  console.log(`embeddings: ${JSON.stringify(run.embeddings)}`);
  console.log(`push: ${results.push}`);
  console.log(`wrote ${join(outDir, `${label}.json`)} and ${join(outDir, `${label}.md`)}`);
}

await main();
