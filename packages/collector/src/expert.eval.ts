#!/usr/bin/env bun
/**
 * Expert retrieval eval suite.
 *
 * The design makes a falsifiable claim: partitioning the corpus by topic
 * destroys multi-hop answers, because the interesting edges live exactly at
 * domain boundaries. This suite exists to check that rather than assume it,
 * and to catch attribution regressions when weights or the relevance floor
 * are tuned.
 *
 * Run against a live collector:
 *   bun run packages/collector/src/expert.eval.ts
 *
 * Cases are scored on whether an *expected source* appears, not on exact
 * ranking — retrieval ordering is legitimately noisy, and over-fitting the
 * eval to current ranking makes it useless as a regression signal.
 */

const COLLECTOR_URL = process.env.COLLECTOR_URL ?? "http://localhost:7777";
const CWD = process.env.EVAL_CWD ?? process.cwd();

interface EvalCase {
  name: string;
  question: string;
  /** Substrings; the case passes if any returned source contains one. */
  expectSource: string[];
  /** Optional: the region we expect attribution to land on. */
  expectRegion?: string;
  /**
   * Multi-hop cases span two domains. These are the cases the design
   * predicts would regress under a topic-partitioned index — they are the
   * point of the suite.
   */
  multiHop?: boolean;
}

const CASES: EvalCase[] = [
  {
    name: "single-hop: code lookup",
    question: "How does the collector claim pending steers atomically?",
    expectSource: ["steers.ts"],
    expectRegion: "collector",
  },
  {
    name: "single-hop: store schema",
    question: "What columns does the launches table have?",
    expectSource: ["migrations.ts", "launches.ts"],
  },
  {
    name: "single-hop: intent from knowledge",
    question: "Why does Standup observe sessions instead of owning them?",
    expectSource: ["knowledge/overview"],
  },
  {
    name: "multi-hop: knowledge convention + the code enforcing it",
    question:
      "Why is there a relevance floor on knowledge results in expert retrieval?",
    expectSource: ["knowledge/practices", "expert.ts"],
    multiHop: true,
  },
  {
    name: "multi-hop: session correlation spans mcp and collector",
    question:
      "How does an MCP tool call get correlated back to a Claude Code session?",
    expectSource: ["session-id.ts", "sessions.ts", "server.ts"],
    multiHop: true,
  },
  {
    name: "multi-hop: steer delivery spans collector, store, and docs",
    question: "Where do queued steers get delivered and how are they marked?",
    expectSource: ["steers.ts", "server.ts"],
    multiHop: true,
  },
  {
    name: "cross-domain: web reads what the collector writes",
    question: "How does the feed receive new expert exchanges in real time?",
    expectSource: ["App.tsx", "server.ts", "ws.ts"],
    multiHop: true,
  },
  {
    name: "attribution: design docs win on intent questions",
    question: "What are the build phases and their ordering rationale?",
    expectSource: ["high-level-design.md", "implementation.md"],
    expectRegion: "design",
  },
];

interface ExpertResponse {
  answer: string;
  region: string;
  sources: string[];
}

async function ask(question: string): Promise<ExpertResponse> {
  const res = await fetch(`${COLLECTOR_URL}/api/expert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: CWD, question }),
  });
  if (!res.ok) throw new Error(`collector returned ${res.status}`);
  return res.json() as Promise<ExpertResponse>;
}

async function main() {
  console.log(`Expert eval — ${COLLECTOR_URL}\n${"=".repeat(60)}\n`);

  let passed = 0;
  let multiHopPassed = 0;
  let multiHopTotal = 0;
  const failures: string[] = [];

  for (const testCase of CASES) {
    if (testCase.multiHop) multiHopTotal++;

    let result: ExpertResponse;
    try {
      result = await ask(testCase.question);
    } catch (err) {
      console.log(`✗ ${testCase.name}\n    request failed: ${(err as Error).message}\n`);
      failures.push(testCase.name);
      continue;
    }

    const sourceHit = testCase.expectSource.some((expected) =>
      result.sources.some((actual) => actual.includes(expected))
    );
    const regionOk =
      !testCase.expectRegion || result.region === testCase.expectRegion;

    if (sourceHit && regionOk) {
      passed++;
      if (testCase.multiHop) multiHopPassed++;
      console.log(`✓ ${testCase.name}`);
      console.log(`    region=${result.region || "(none)"} sources=${result.sources.length}\n`);
    } else {
      failures.push(testCase.name);
      console.log(`✗ ${testCase.name}`);
      console.log(`    q: ${testCase.question}`);
      if (!sourceHit) {
        console.log(`    expected any of: ${testCase.expectSource.join(", ")}`);
        console.log(`    got: ${result.sources.join(", ") || "(nothing)"}`);
      }
      if (!regionOk) {
        console.log(`    expected region "${testCase.expectRegion}", got "${result.region}"`);
      }
      console.log();
    }
  }

  console.log("=".repeat(60));
  console.log(`${passed}/${CASES.length} passed`);
  console.log(
    `multi-hop: ${multiHopPassed}/${multiHopTotal} — these are the cases the ` +
      `design predicts a topic-partitioned index would lose`
  );

  if (failures.length > 0) {
    console.log(`\nFailing: ${failures.join(", ")}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Eval failed to run: ${(err as Error).message}`);
  console.error("Is the collector running? (bun run dev)");
  process.exit(1);
});
