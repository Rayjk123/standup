import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { parse as parseToml } from "smol-toml";
import type { Database } from "bun:sqlite";
import { searchKnowledge, type EmbeddingProvider } from "@standup/knowledge";
import { runRipgrep } from "./ripgrep.js";

export interface ExpertRegion {
  name: string;
  anchors: string[];
  weight?: number;
}

export interface ExpertSource {
  path: string;
  kind: "knowledge" | "code";
  excerpt: string;
  score: number;
}

export interface ExpertAnswer {
  answer: string;
  region: string;
  sources: string[];
}

/**
 * Minimum normalized score for a knowledge doc to be treated as relevant.
 * Tuned against the eval suite (see packages/collector/src/expert.eval.ts),
 * not by feel — raise it and genuine cross-domain hits start dropping out.
 */
const KNOWLEDGE_RELEVANCE_FLOOR = 0.15;

export function defaultExpertsPath(): string {
  return (
    process.env.STANDUP_EXPERTS_PATH ??
    join(homedir(), ".config", "standup", "experts.toml")
  );
}

export async function loadRegions(path = defaultExpertsPath()): Promise<ExpertRegion[]> {
  if (!existsSync(path)) return [];
  try {
    const parsed = parseToml(await readFile(path, "utf-8")) as unknown as {
      region?: ExpertRegion[];
    };
    return parsed.region ?? [];
  } catch (err) {
    console.error(`[expert] Failed to parse ${path}:`, err);
    return [];
  }
}

// Words that match everything and therefore rank nothing. Dropped before
// building the code search so results reflect the question's actual subject.
const STOPWORDS = new Set([
  "a","an","the","is","are","was","were","be","been","being","do","does","did",
  "how","what","why","when","where","which","who","whom","whose","this","that",
  "these","those","i","we","you","it","its","of","in","on","at","to","for",
  "with","from","by","about","as","into","and","or","but","if","then","than",
  "so","not","no","can","could","should","would","will","just","use","used",
  "using","get","gets","work","works","working","here","there","our","my",
]);

export function extractTerms(question: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];

  for (const raw of question.toLowerCase().split(/[^a-z0-9_]+/)) {
    const term = raw.trim();
    if (term.length < 3 || STOPWORDS.has(term) || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }

  // Longer terms are more discriminating; cap so the regex stays cheap.
  return terms.sort((a, b) => b.length - a.length).slice(0, 8);
}

/**
 * Scores which region a set of results came from, and returns the strongest.
 *
 * This is the "attribute, don't route" half of the design: nothing above
 * this point filtered by region, so cross-domain answers surface normally.
 * The label describes where the evidence landed, after the fact.
 */
export function attributeRegion(
  sources: ExpertSource[],
  regions: ExpertRegion[]
): string {
  if (regions.length === 0 || sources.length === 0) return "";

  // Per-region: strongest single match, plus a small corroboration bonus for
  // additional matches. Deliberately not a sum — summing lets a region with
  // several mediocre files outrank the region holding the one file that
  // actually answers the question, which is how "how does the collector
  // claim steers" got attributed to `design` (three passing mentions across
  // plan/*.md) instead of `collector` (steers.ts itself).
  const best = new Map<string, { top: number; count: number }>();

  for (const source of sources) {
    for (const region of regions) {
      const matches = region.anchors.some((anchor) => source.path.includes(anchor));
      if (!matches) continue;

      const weighted = source.score * (region.weight ?? 1);
      const current = best.get(region.name);
      best.set(region.name, {
        top: Math.max(current?.top ?? 0, weighted),
        count: (current?.count ?? 0) + 1,
      });
    }
  }

  if (best.size === 0) return "";

  const scored = [...best.entries()].map(([name, { top, count }]) => ({
    name,
    score: top * (1 + 0.08 * (count - 1)),
  }));

  return scored.sort((a, b) => b.score - a.score)[0].name;
}

/** Boosts results sitting inside a region's anchors, without excluding others. */
function applyRegionBias(
  sources: ExpertSource[],
  regions: ExpertRegion[]
): ExpertSource[] {
  return sources
    .map((source) => {
      let multiplier = 1;
      for (const region of regions) {
        if (region.anchors.some((anchor) => source.path.includes(anchor))) {
          multiplier = Math.max(multiplier, region.weight ?? 1);
        }
      }
      return { ...source, score: source.score * multiplier };
    })
    .sort((a, b) => b.score - a.score);
}

export interface AskExpertOptions {
  db: Database;
  projectId: string;
  cwd: string;
  question: string;
  embeddingProvider: EmbeddingProvider | null;
  regions: ExpertRegion[];
  maxSources?: number;
}

/**
 * Answers a question from one shared corpus: project knowledge docs plus the
 * code itself. Searches everything, reranks with a bias toward region
 * anchors, then labels the result with the region it actually came from.
 *
 * This is retrieval, not synthesis — the "answer" is assembled evidence, and
 * says so. Generating prose over these passages would need a model call; the
 * seam for that is here, deliberately unfilled, because retrieval quality
 * has to be right before synthesis can be worth anything.
 */
export async function askExpert({
  db,
  projectId,
  cwd,
  question,
  embeddingProvider,
  regions,
  maxSources = 6,
}: AskExpertOptions): Promise<ExpertAnswer> {
  const sources: ExpertSource[] = [];

  // 1. Human-authored knowledge — intent, conventions, cross-project context.
  const knowledgeHits = await searchKnowledge(
    db,
    projectId,
    question,
    embeddingProvider,
    { limit: 4 }
  );
  for (const hit of knowledgeHits) {
    // Floor on relevance. FTS5 terms are OR-joined (so natural-language
    // questions match at all), which means a doc sharing one incidental word
    // still comes back — with the knowledge boost below, that noise would
    // outrank genuinely relevant code. Weak matches are worse than none
    // here: the agent reads them as authoritative context.
    if (hit.score < KNOWLEDGE_RELEVANCE_FLOOR) continue;

    sources.push({
      path: `knowledge/${hit.slug}`,
      kind: "knowledge",
      excerpt: hit.excerpt,
      // Knowledge docs are deliberately weighted above raw code: they answer
      // "why", which is what an agent can't recover by reading source.
      score: 1 + hit.score * 2,
    });
  }

  // 2. The code itself, over the same corpus — no region filtering here, so
  //    a question can be answered by whichever part of the repo actually
  //    holds the answer.
  const terms = extractTerms(question);
  if (terms.length > 0) {
    try {
      const pattern = terms.join("|");
      const result = await runRipgrep(pattern, cwd, ".", [
        "-i",
        "--max-count",
        "3",
        // Eval fixtures contain the question text by construction, so they
        // match everything they are meant to measure. Leaving them in the
        // corpus makes retrieval look better than it is on exactly the
        // queries being scored.
        "--glob",
        "!*.eval.ts",
      ]);

      // Rank files by how many distinct query terms they contain, so a file
      // matching several concepts outranks one matching a single common word.
      const byFile = new Map<string, { lines: string[]; hits: Set<string> }>();
      for (const match of result.matches) {
        let entry = byFile.get(match.file);
        if (!entry) {
          entry = { lines: [], hits: new Set() };
          byFile.set(match.file, entry);
        }
        if (entry.lines.length < 3) {
          entry.lines.push(`${match.line}: ${match.text.trim().slice(0, 160)}`);
        }
        for (const term of terms) {
          if (match.text.toLowerCase().includes(term)) entry.hits.add(term);
        }
      }

      for (const [file, entry] of byFile) {
        const coverage = entry.hits.size / terms.length;

        // A filename matching a query term is a far stronger signal than the
        // same term appearing in prose. Without this, long design docs that
        // mention many terms in passing outrank the file actually named
        // after the subject — "how do steers get delivered" returned
        // plan/*.md above steers.ts until this was added.
        const name = file.split("/").pop()?.toLowerCase() ?? "";
        const nameHits = terms.filter((t) => name.includes(t)).length;
        const nameBonus = nameHits > 0 ? 0.6 + 0.2 * (nameHits - 1) : 0;

        // Mild penalty for prose. Markdown legitimately matches more terms
        // per document than code does, which is length bias rather than
        // relevance; code answers "how does this work", docs answer "why".
        const proseDamping = /\.(md|txt)$/i.test(file) ? 0.7 : 1;

        sources.push({
          path: file,
          kind: "code",
          excerpt: entry.lines.join("\n"),
          score: (coverage + nameBonus) * proseDamping,
        });
      }
    } catch (err) {
      console.error("[expert] code search failed:", err);
    }
  }

  if (sources.length === 0) {
    return {
      answer:
        `No matches for "${question}" in project knowledge or code.\n\n` +
        `If this is institutional context (why something exists, a convention, ` +
        `a cross-project dependency), it may simply not be written down yet — ` +
        `consider adding it under ~/.config/standup/knowledge/${projectId}/.`,
      region: "",
      sources: [],
    };
  }

  const ranked = applyRegionBias(sources, regions).slice(0, maxSources);
  const region = attributeRegion(ranked, regions);

  const knowledgeParts = ranked.filter((s) => s.kind === "knowledge");
  const codeParts = ranked.filter((s) => s.kind === "code");

  const sections: string[] = [];
  if (knowledgeParts.length > 0) {
    sections.push(
      "From project knowledge:\n" +
        knowledgeParts.map((s) => `  [${s.path}]\n  ${s.excerpt}`).join("\n\n")
    );
  }
  if (codeParts.length > 0) {
    sections.push(
      "From code:\n" +
        codeParts.map((s) => `  ${s.path}\n    ${s.excerpt.replace(/\n/g, "\n    ")}`).join("\n\n")
    );
  }

  return {
    answer:
      `Retrieved context for: "${question}"\n\n` +
      sections.join("\n\n") +
      `\n\n(Retrieved passages, not a synthesized answer — verify against the sources.)`,
    region,
    sources: ranked.map((s) => s.path),
  };
}
