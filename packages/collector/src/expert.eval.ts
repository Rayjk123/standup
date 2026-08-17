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

/**
 * Names a run so two of them can be compared with `diff` rather than by eye.
 *
 * Set it and the suite prints a stable PASS/FAIL block at the end, one line
 * per case and nothing else. The normal output can't be diffed usefully — a
 * failing case prints whichever sources it actually got, and those move
 * between runs for reasons that have nothing to do with what changed.
 *
 *   EVAL_LABEL=before bun run eval:expert > /tmp/before.txt
 *   EVAL_LABEL=after  bun run eval:expert > /tmp/after.txt
 *   diff <(rg '^>>' /tmp/before.txt) <(rg '^>>' /tmp/after.txt)
 */
const EVAL_LABEL = process.env.EVAL_LABEL ?? "";

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

  // Ad-hoc phrasings (Phase 7, Step 0).
  //
  // The suite passed 8/8 while ad-hoc questions returned tangential files,
  // because every original case was worded the way the corpus words itself.
  // These are deliberately phrased the way a person asks — "my branch", "how
  // often", "what happens to" — and none of them repeat a filename. They are
  // the cases that exposed the max-count/name-bonus interaction; keep them
  // conversational if you add more.
  {
    name: "ad-hoc: which project a session belongs to",
    question: "How does the launcher decide which project a session belongs to?",
    // findLaunchByCwd lives in the store, not the launcher — the obvious
    // guess is wrong, which is half the point of this case.
    expectSource: ["launcher.ts", "launches.ts", "projects-registry.ts"],
  },
  {
    name: "ad-hoc: cleanup semantics, asked as a user would",
    question: "What happens to my branch when I clean up a launch?",
    expectSource: ["launcher.ts"],
  },
  {
    name: "ad-hoc: nudge rate limiting",
    question: "How often can the same agent be nudged about being stuck?",
    expectSource: ["nudge.ts", "stuckness.ts"],
  },
  {
    name: "ad-hoc: a why question with no shared vocabulary",
    question: "Why is the sqlite database not stored inside the source tree?",
    expectSource: ["index.ts", "runbook.md"],
  },

  // Capability cases (Phase 7, Step 7B).
  //
  // These exist to answer one question: does bootstrapped knowledge let the
  // expert answer things it previously could not? So each one must FAIL with
  // only hand-written docs in the corpus and PASS once the generated docs are
  // accepted. A case that passes in both states measures nothing.
  //
  // All three were probed against the pre-acceptance corpus before being
  // written down, and all three returned tangential code and no knowledge doc.
  // One candidate was cut for passing already — "why can two agents in one
  // directory write to the same session" surfaces session-id.ts unaided,
  // because the code genuinely answers it.
  //
  // What makes these work is that the answer is an *absence* or a *judgment*:
  // that no linter exists, that red typecheck output predates you, that
  // per-session state is in memory and a reload drops it. None of that is
  // greppable, which is the same property the prompt selects documents for.
  {
    name: "capability: knows there is no linter",
    question: "Is there a linter set up here, and why does that command fail?",
    expectSource: ["knowledge/toolchain"],
  },
  {
    name: "capability: explains duplicate checkpoints after a reload",
    question:
      "Why do duplicate checkpoints show up right after the collector reloads?",
    expectSource: ["knowledge/gotchas"],
  },
  {
    name: "capability: pre-existing typecheck noise",
    question:
      "Should I worry about the red type errors that were already there before my change?",
    expectSource: ["knowledge/toolchain"],
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
  const outcomes: Array<[string, boolean]> = [];

  for (const testCase of CASES) {
    if (testCase.multiHop) multiHopTotal++;

    let result: ExpertResponse;
    try {
      result = await ask(testCase.question);
    } catch (err) {
      console.log(`✗ ${testCase.name}\n    request failed: ${(err as Error).message}\n`);
      failures.push(testCase.name);
      outcomes.push([testCase.name, false]);
      continue;
    }

    const sourceHit = testCase.expectSource.some((expected) =>
      result.sources.some((actual) => actual.includes(expected))
    );
    const regionOk =
      !testCase.expectRegion || result.region === testCase.expectRegion;

    outcomes.push([testCase.name, sourceHit && regionOk]);

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

  if (EVAL_LABEL) {
    // The label names the run in the header only. Prefixing every result line
    // with it would make the two runs differ on every line and defeat the
    // point; `>>` is the stable marker to filter on.
    console.log(`\n--- results: ${EVAL_LABEL} ---`);
    for (const [name, ok] of outcomes) {
      console.log(`>> ${ok ? "PASS" : "FAIL"} ${name}`);
    }
  }

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
