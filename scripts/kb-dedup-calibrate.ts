#!/usr/bin/env bun
/**
 * Measures the write-path duplicate detector (packages/collector/src/
 * knowledge-dedup.ts) on a real corpus: for every accepted doc, the nearest
 * other docs it would be compared against, with each pair's signals and
 * whether the detector calls it a duplicate. Prints refs and numbers only,
 * never doc text.
 *
 *   bun run scripts/kb-dedup-calibrate.ts --fixture            # the committed fixture corpus
 *   bun run scripts/kb-dedup-calibrate.ts --snapshot <copy.db> # a COPY of a real standup.db
 *
 * Labels: a pair is a known duplicate when the bodies are identical, or when it
 * is listed in --pairs <file> (format in scripts/kb-dedup-pairs.ts). The
 * fixture tier also reads the labels kept beside the corpus,
 * packages/knowledge/eval/dedup-pairs.txt, when that file exists. Everything
 * else is an unlabeled pair; the highest-scoring ones are printed so a false
 * positive is visible.
 *
 * Needs local Ollama with nomic-embed-text (the query side is embedded live).
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { LocalMarkdownBackend, KnowledgeStore, tryEnableSqliteVecExtension, type KnowledgeDoc } from "@standup/knowledge";
import { createStore } from "@standup/store";
import {
  dupFeatures,
  isDuplicate,
  similarityOf,
  type DupFeatures,
} from "../packages/collector/src/knowledge-dedup.ts";
import { buildFixtureEnv } from "../packages/collector/src/kbeval/env.ts";
import { assertSafeDbCopy } from "../packages/collector/src/kbeval/env.ts";
import { emptyDupLabels, isLabeledDup, parseDupLabels } from "./kb-dedup-pairs.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : (args[i + 1] ?? "");
};
const evalDir = join(import.meta.dir, "..", "packages", "knowledge", "eval");

tryEnableSqliteVecExtension();

interface Pair {
  a: string;
  b: string;
  features: DupFeatures;
  duplicate: boolean;
  label: "dup" | "unlabeled";
}

const tier = args.includes("--fixture") ? "fixture" : "snapshot";
const labels = emptyDupLabels();
const pairsFile = flag("--pairs");
if (pairsFile) parseDupLabels(readFileSync(pairsFile, "utf-8"), labels);
const fixturePairsFile = join(evalDir, "dedup-pairs.txt");
if (tier === "fixture") {
  if (existsSync(fixturePairsFile)) parseDupLabels(readFileSync(fixturePairsFile, "utf-8"), labels);
  else
    console.warn(
      `warning: ${fixturePairsFile} is missing; only identical bodies count as known duplicates, ` +
        "so the printed precision and recall are not comparable with a labeled run",
    );
}

let root = "";
let db;
let knowledgeDir = "";
let closeEnv = () => {};
if (tier === "fixture") {
  const env = await buildFixtureEnv({
    corpusDir: join(evalDir, "corpus"),
    fixtureRepoDir: join(evalDir, "fixture-repo"),
    embeddingProvider: "ollama",
  });
  db = env.db;
  knowledgeDir = env.knowledgeDir;
  closeEnv = () => env.close();
} else {
  const source = assertSafeDbCopy(resolve(flag("--snapshot") ?? join(evalDir, "local", "snapshot.db")));
  root = mkdtempSync(join(tmpdir(), "kb-dedup-calibrate-"));
  const copy = join(root, "snapshot.db");
  copyFileSync(source, copy);
  const store = createStore(copy);
  db = store.db;
  closeEnv = () => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  };
}

const backend = new LocalMarkdownBackend(db, "ollama", {}, knowledgeDir);
const docs = new KnowledgeStore(db).getAllDocs();
const byRef = new Map<string, KnowledgeDoc>(docs.map((d) => [`${d.projectId}/${d.slug}`, d]));

const pairs = new Map<string, Pair>();
for (const doc of docs) {
  if (doc.verdict === "superseded") continue;
  const ref = `${doc.projectId}/${doc.slug}`;
  const query = `${doc.title}\n${doc.body}`.slice(0, 2000);
  const hits = await backend.search(doc.projectId, query, {
    corpus: "all",
    limit: 30,
    textWeight: 0,
    embeddingWeight: 1,
  });
  const ranked = [...hits].sort((x, y) => (y.rawScore ?? 0) - (x.rawScore ?? 0)).slice(0, 11);
  for (const hit of ranked) {
    const other = `${hit.projectId}/${hit.slug}`;
    if (other === ref) continue;
    const existing = byRef.get(other);
    if (!existing) continue;
    const key = `${ref} ${other}`;
    const features = dupFeatures(doc, existing, hit.rawScore);
    const labeled = features.identical || isLabeledDup(labels, ref, other);
    pairs.set(key, {
      a: ref,
      b: other,
      features,
      duplicate: isDuplicate(features),
      label: labeled ? "dup" : "unlabeled",
    });
  }
}

const all = [...pairs.values()];
const dups = all.filter((p) => p.label === "dup");
const caught = dups.filter((p) => p.duplicate);
const firedUnlabeled = all.filter((p) => p.label === "unlabeled" && p.duplicate);
const fmt = (n: number | undefined) => (n === undefined ? "  -  " : n.toFixed(3));
const line = (p: Pair) =>
  `${p.duplicate ? "DUP " : "    "}${p.label === "dup" ? "L" : " "} cos=${fmt(p.features.cosine)} jac=${fmt(p.features.jaccard)} con=${fmt(p.features.containment)} title=${fmt(p.features.titleSimilarity)} ident=${p.features.identical ? 1 : 0} slug=${p.features.sameSlug ? 1 : 0}  ${p.a} -> ${p.b}`;

console.log(`tier=${tier} docs=${docs.length} directedPairs=${all.length}`);
console.log(`labeled duplicates: ${dups.length}, caught ${caught.length} (recall ${(caught.length / Math.max(dups.length, 1)).toFixed(3)})`);
console.log(`unlabeled pairs called duplicate: ${firedUnlabeled.length}`);
console.log("\n# labeled duplicates, least similar first");
for (const p of dups.sort((x, y) => similarityOf(x.features) - similarityOf(y.features))) console.log(line(p));
console.log("\n# unlabeled pairs called duplicate");
for (const p of firedUnlabeled) console.log(line(p));
console.log("\n# top unlabeled pairs by cosine (not called duplicate)");
for (const p of all
  .filter((p) => p.label === "unlabeled" && !p.duplicate)
  .sort((x, y) => (y.features.cosine ?? 0) - (x.features.cosine ?? 0))
  .slice(0, Number(flag("--top") ?? 40))) {
  console.log(line(p));
}

closeEnv();
