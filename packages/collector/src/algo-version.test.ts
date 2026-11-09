import { expect, test, describe } from "bun:test";
import { join } from "path";
import { createStore } from "@standup/store";
import { ALGO_VERSION, RANKING_ENV_VARS, effectiveAlgoVersion } from "@standup/knowledge";
import { recordKnowledgeRetrievals } from "./retrieval-telemetry.js";

/**
 * ALGO_VERSION is stamped on every retrieval row so scores are only compared
 * within one algorithm. This pins it to the built-in values of the constants
 * that move a score's scale or a hit's admission (rankingFingerprint): changing
 * any of them fails here until ALGO_VERSION is bumped and the pin below updated
 * to the new (version, fingerprint) pair.
 */
const PINNED = {
  algoVersion: "2026-10-10.3",
  fingerprint: "00d41e6ef556ddb1",
};

/**
 * The fingerprint of the built-in values: computed in a fresh process with
 * every ranking override removed, so a KNOWLEDGE_* / STANDUP_* override in the
 * test environment does not move it.
 */
function builtInFingerprint(): string {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !RANKING_ENV_VARS.includes(k)) env[k] = v;
  }
  const run = Bun.spawnSync([process.execPath, join(import.meta.dir, "algo-fingerprint.ts")], { env });
  if (run.exitCode !== 0) throw new Error(`fingerprint process failed: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
}

describe("ALGO_VERSION", () => {
  test("is bumped whenever a ranking or gating constant's built-in value changes", () => {
    const fingerprint = builtInFingerprint();
    if (ALGO_VERSION === PINNED.algoVersion) {
      expect(
        fingerprint,
        `a ranking/gating constant changed: bump ALGO_VERSION (packages/knowledge/src/algo-version.ts) and pin { algoVersion, fingerprint: "${fingerprint}" }`
      ).toBe(PINNED.fingerprint);
    } else {
      expect(
        ALGO_VERSION,
        `ALGO_VERSION moved: update the pin to { algoVersion: "${ALGO_VERSION}", fingerprint: "${fingerprint}" }`
      ).toBe(PINNED.algoVersion);
    }
  });

  test("has the documented <YYYY-MM-DD>.<n> form", () => {
    expect(ALGO_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });

  test("a runtime ranking override marks the version, and rows are stamped with it", () => {
    expect(effectiveAlgoVersion({})).toBe(ALGO_VERSION);
    expect(effectiveAlgoVersion({ KNOWLEDGE_RRF_K: "  " })).toBe(ALGO_VERSION);
    expect(effectiveAlgoVersion({ KNOWLEDGE_RRF_K: "90" })).toBe(`${ALGO_VERSION}+env`);
    expect(effectiveAlgoVersion({ STANDUP_CODE_INJECT_MAX_DOCS: "5" })).toBe(`${ALGO_VERSION}+env`);

    const saved = process.env.KNOWLEDGE_TITLE_BOOST_WEIGHT;
    process.env.KNOWLEDGE_TITLE_BOOST_WEIGHT = "0.9";
    const store = createStore(":memory:");
    try {
      recordKnowledgeRetrievals(
        store.db,
        [{ docProject: "p", docSlug: "d", query: "q", rank: 0, surface: "search" }],
        undefined
      );
      const row = store.db.query("SELECT algo_version FROM knowledge_retrievals").get() as { algo_version: string };
      expect(row.algo_version).toBe(`${ALGO_VERSION}+env`);
    } finally {
      if (saved === undefined) delete process.env.KNOWLEDGE_TITLE_BOOST_WEIGHT;
      else process.env.KNOWLEDGE_TITLE_BOOST_WEIGHT = saved;
      store.close();
    }
  });
});
