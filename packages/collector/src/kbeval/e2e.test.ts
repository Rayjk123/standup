import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { forbiddenActions, type ForbiddenAction } from "@standup/knowledge";
import { applyOrgReviewTerms } from "../knowledge-query-rewrite.js";
import { DEFAULT_ORG_PROFILE } from "../org-profile/default.js";
import type { OrgProfile } from "../org-profile/types.js";
import { sha256Hex } from "./cases.js";
import type { EmbeddingSource, EmbeddingStats } from "./embedding-cache.js";
import { FIXTURE_HOST_USER } from "./env.js";
import { deterministicView, runEval } from "./runner.js";
import { makePersonaAdapter } from "./surfaces.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A deterministic stand-in for Ollama: a 16-dim vector derived from the text's hash. */
class HashEmbeddings implements EmbeddingSource {
  private hits = 0;
  async embed(text: string): Promise<number[]> {
    this.hits++;
    const h = sha256Hex(text);
    return Array.from({ length: 16 }, (_, i) => parseInt(h.slice(i * 2, i * 2 + 2), 16) / 255 - 0.5);
  }
  stats(): EmbeddingStats {
    return { hits: this.hits, misses: 0, fetched: 0, missKeys: [] };
  }
}

function write(path: string, body: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}

function buildCorpus(): { root: string; corpus: string; cases: string; repo: string } {
  const root = mkdtempSync(join(tmpdir(), "kbeval-e2e-"));
  dirs.push(root);
  const corpus = join(root, "corpus");
  const cases = join(root, "cases");
  const repo = join(root, "fixture-repo");
  mkdirSync(repo, { recursive: true });
  write(
    join(corpus, "projects.json"),
    JSON.stringify([{ id: "alpha", name: "Alpha", repo: "fixture-repo" }])
  );
  const longV1 = Array.from(
    { length: 12 },
    (_, i) => `The widget pipeline retries batch ${i} with exponential backoff before giving up entirely.`
  ).join(" ");
  write(
    join(corpus, "_edits", "alpha", "widget-pipeline.1.md"),
    `---\ntitle: Widget pipeline (old)\nsource_kind: runbook\n---\n${longV1}\n`
  );
  write(
    join(corpus, "alpha", "widget-pipeline.md"),
    `---\ntitle: Widget pipeline\nsource_kind: runbook\n---\nThe widget pipeline flushes batches on a timer.\n`
  );
  write(
    join(corpus, "alpha", "gadget-store.md"),
    `---\ntitle: Gadget store\nsource_kind: decision\n---\nGadgets are stored in sqlite with WAL enabled.\n`
  );
  write(
    join(corpus, "alpha", "old-status.md"),
    `---\ntitle: Status\nsource_kind: decision\nverdict: contradicted\ntags: [status]\n---\nThe widget pipeline is not implemented yet.\n`
  );
  write(
    join(corpus, "global", "secret-note.md"),
    `---\ntitle: Personal note\nscope: user\nowner_user: someone-else\n---\nwidget pipeline personal secret.\n`
  );
  write(
    join(cases, "e2e.json"),
    JSON.stringify([
      {
        id: "e2e-widget",
        category: "docs",
        surface: ["search", "code", "inject", "persona"],
        audience: { projectId: "alpha", user: "tester" },
        query: "how does the widget pipeline flush batches",
        relevant: [{ doc: "alpha/widget-pipeline", grade: 2 }],
        forbidden: ["global/secret-*"],
        staleOver: [["alpha/widget-pipeline", "alpha/old-status"]],
        staleDocs: ["alpha/old-status"],
      },
      {
        id: "e2e-offtopic",
        category: "offtopic",
        surface: ["search", "inject"],
        audience: { projectId: "alpha", user: "tester" },
        query: "how do I bake sourdough bread",
        relevant: [],
        expectEmpty: true,
      },
    ])
  );
  return { root, corpus, cases, repo };
}

describe("fixture runner end to end", () => {
  test("replays edits through the real sync path and leaves no FTS orphan, stale FTS row or tail chunk", async () => {
    const fx = buildCorpus();
    const opts = {
      tier: "fixture" as const,
      evalDir: fx.root,
      corpusDir: fx.corpus,
      fixtureRepoDir: fx.repo,
      casesDir: fx.cases,
      writeResults: false,
    };
    const results = await runEval({ ...opts, embeddingSource: new HashEmbeddings() });

    expect(results.load.editedDocs).toBe(1);
    expect(results.load.verdicts).toBe(1);
    // The edited doc's FTS row holds the final body under the stored id.
    expect(results.integrity.orphanFtsRows).toBe(0);
    expect(results.integrity.staleFtsRefs).toEqual([]);
    // Version 1 chunked into several pieces; the short final body leaves only its own.
    expect(results.integrity.tailChunks).toBe(0);
    expect(results.integrity.tailChunkRefs).toEqual([]);
    // The test embedding source reports no model digest.
    expect(results.integrity.fingerprintHasModelDigest).toBe(false);
    expect(results.errors).toEqual([]);

    const widget = results.cases.find((c) => c.id === "e2e-widget")!;
    expect(Object.keys(widget.surfaces).sort()).toEqual(["code", "inject", "persona", "persona-recall", "search"]);
    // Persona's context is a doc set with set metrics only; its recall is ranked.
    expect(widget.surfaces.persona.metrics.recallAt5).toBeUndefined();
    expect(widget.surfaces.persona.metrics.inContextRecall).toBe(0);
    expect(widget.surfaces.persona.metrics.inContextHit).toBe(false);
    expect(widget.surfaces.persona.detail?.briefDocs).toEqual([]);
    expect(widget.surfaces["persona-recall"].metrics.recallAt5).toBeDefined();
    expect(results.metrics.bySurface.persona.rankedCases).toBe(0);
    expect(results.metrics.bySurface.persona.contextCases).toBe(1);
    expect(results.metrics.bySurface["persona-recall"].rankedCases).toBe(1);
    expect(results.metrics.overall.rankedCases).toBe(4);
    // The code surface searched the project's repo and recorded how.
    expect(results.codeSearch.cases).toBe(1);
    expect(widget.surfaces.code.detail?.codeSearch).toBeDefined();
    expect(widget.surfaces.search.hits.map((h) => h.ref)).toContain("alpha/widget-pipeline");
    // The contradicted doc is either below the search confidence floor or
    // recalled and marked: it asserts no confidence, so it is judged on the
    // default base dated by its content clock, which has decayed below the
    // injection floor. Nothing re-verifies alpha's docs (the model pass is
    // off), so decay marks it stale and leaves it injectable rather than
    // gating it out.
    const stale = widget.surfaces.search.hits.find((h) => h.ref === "alpha/old-status");
    if (stale) {
      expect(stale.flags.verdict).toBe("contradicted");
      expect(stale.flags.injectionEligible).toBe(true);
      expect(stale.flags.marked).toBe(true);
    }
    expect(widget.surfaces.search.metrics.stalePairs?.[0].staleFlagged).toBe(true);
    // Another user's user-scoped doc never reaches the case's user.
    expect(widget.surfaces.search.metrics.leaked).toBe(false);
    expect(results.metrics.bySurface.search.pairs).toBe(2);
    expect(results.metrics.overall.negativeCases).toBe(2);

    // A second run on the same inputs is byte-identical outside the run stamp.
    const again = await runEval({ ...opts, embeddingSource: new HashEmbeddings() });
    expect(JSON.stringify(deterministicView(again))).toBe(JSON.stringify(deterministicView(results)));
  }, 30_000);

  test("a persona adapter's brief preferences block counts toward Persona's context", async () => {
    const fx = buildCorpus();
    const results = await runEval({
      tier: "fixture",
      evalDir: fx.root,
      corpusDir: fx.corpus,
      fixtureRepoDir: fx.repo,
      casesDir: fx.cases,
      noEmbeddings: true,
      writeResults: false,
      surfaces: ["persona"],
      personaAdapter: makePersonaAdapter("with-brief", {
        briefPreferencesBlock: (_ctx, owner) => `${owner} prefers: see alpha/widget-pipeline and alpha/old-status`,
      }),
    });
    expect(results.config.personaAdapter).toBe("with-brief");
    const persona = results.cases.find((c) => c.id === "e2e-widget")!.surfaces.persona;
    expect(persona.detail?.briefDocs).toEqual(["alpha/old-status", "alpha/widget-pipeline"]);
    expect(persona.metrics.inContextRecall).toBe(1);
    expect(persona.metrics.staleInContext).toBe(1);
    expect(results.metrics.bySurface.persona.inContextHit).toBe(1);
  }, 30_000);

  test("the fixture tier plans injection with no org review noun, whatever was set before, and puts the earlier terms back", async () => {
    const brief = "Fix the retry loop. Don't cut a changeset.";
    const withNoun: OrgProfile = { ...DEFAULT_ORG_PROFILE, codeReview: { ...DEFAULT_ORG_PROFILE.codeReview, noun: "changeset" } };
    const restore = applyOrgReviewTerms(withNoun);
    try {
      expect(forbiddenActions(brief)).toEqual(["code_review"]);
      const during: ForbiddenAction[][] = [];
      const fx = buildCorpus();
      await runEval({
        tier: "fixture",
        evalDir: fx.root,
        corpusDir: fx.corpus,
        fixtureRepoDir: fx.repo,
        casesDir: fx.cases,
        noEmbeddings: true,
        writeResults: false,
        surfaces: ["persona"],
        personaAdapter: makePersonaAdapter("reads-review-terms", {
          briefPreferencesBlock: () => {
            during.push(forbiddenActions(brief));
            return "";
          },
        }),
      });
      expect(during.length).toBeGreaterThan(0);
      for (const forbidden of during) expect(forbidden).toEqual([]);
      expect(forbiddenActions(brief)).toEqual(["code_review"]);
    } finally {
      restore();
    }
    expect(forbiddenActions(brief)).toEqual([]);
  }, 30_000);

  describe("Persona recall reads the fixture owner's personal layer whatever the runner's $USER", () => {
    function buildOwnerCorpus(): { root: string; corpus: string; cases: string; repo: string } {
      const root = mkdtempSync(join(tmpdir(), "kbeval-owner-"));
      dirs.push(root);
      const corpus = join(root, "corpus");
      const cases = join(root, "cases");
      const repo = join(root, "fixture-repo");
      mkdirSync(repo, { recursive: true });
      write(join(corpus, "projects.json"), JSON.stringify([{ id: "alpha", name: "Alpha", repo: "fixture-repo" }]));
      write(
        join(corpus, "global", "owner-sourdough-rules.md"),
        `---\ntitle: Sourdough starter feeding rules\nscope: user\nowner_user: ${FIXTURE_HOST_USER}\norigin_class: owner\n---\nFeed the sourdough starter twice daily with rye flour.\n`
      );
      const recallCase = (id: string, user: string) => ({
        id,
        category: "personal",
        surface: ["persona"],
        audience: { projectId: "global", user },
        query: "sourdough starter feeding rules rye flour",
        relevant: user === FIXTURE_HOST_USER ? [{ doc: "global/owner-sourdough-rules", grade: 2 }] : [],
        ...(user === FIXTURE_HOST_USER ? {} : { forbidden: ["global/owner-sourdough-rules"] }),
      });
      write(
        join(cases, "owner.json"),
        JSON.stringify([recallCase("owner-recall", FIXTURE_HOST_USER), recallCase("guest-recall", "alice")])
      );
      return { root, corpus, cases, repo };
    }

    const hosts: Array<[string, Record<string, string | undefined>]> = [
      ["no $USER (env -i, a service manager)", { USER: undefined, STANDUP_HOST_USER: undefined }],
      ["another $USER", { USER: "ci-runner", STANDUP_HOST_USER: undefined }],
      ["a STANDUP_HOST_USER naming someone else", { USER: "ci-runner", STANDUP_HOST_USER: "ci-runner" }],
    ];
    for (const [name, hostEnv] of hosts) {
      test(name, async () => {
        const previous = Object.fromEntries(Object.keys(hostEnv).map((k) => [k, process.env[k]]));
        for (const [k, v] of Object.entries(hostEnv)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
        try {
          const fx = buildOwnerCorpus();
          const results = await runEval({
            tier: "fixture",
            evalDir: fx.root,
            corpusDir: fx.corpus,
            fixtureRepoDir: fx.repo,
            casesDir: fx.cases,
            noEmbeddings: true,
            writeResults: false,
            surfaces: ["persona"],
          });
          const recalled = (id: string) =>
            results.cases.find((c) => c.id === id)!.surfaces["persona-recall"].hits.map((h) => h.ref);
          expect(recalled("owner-recall")).toContain("global/owner-sourdough-rules");
          expect(recalled("guest-recall")).not.toContain("global/owner-sourdough-rules");
          expect(Object.fromEntries(Object.keys(hostEnv).map((k) => [k, process.env[k]]))).toEqual(hostEnv);
        } finally {
          for (const [k, v] of Object.entries(previous)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
          }
        }
      }, 30_000);
    }
  });

  test("FTS-only mode runs the same surfaces with no embedding provider", async () => {
    const fx = buildCorpus();
    const results = await runEval({
      tier: "fixture",
      evalDir: fx.root,
      corpusDir: fx.corpus,
      fixtureRepoDir: fx.repo,
      casesDir: fx.cases,
      noEmbeddings: true,
      writeResults: false,
    });
    expect(results.config.embeddings).toBe(false);
    expect(results.integrity.chunks).toBe(0);
    expect(results.integrity.orphanFtsRows).toBe(0);
  }, 30_000);
});
