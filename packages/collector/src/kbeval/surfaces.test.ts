import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { searchableTempDir } from "../code-search.js";
import { runCode, type SurfaceContext } from "./surfaces.js";
import type { EvalCase } from "./types.js";

const repo = mkdtempSync(join(searchableTempDir(), "kbeval-code-surface-"));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

function write(path: string, body: string): void {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), body);
}

write("src/steers.ts", "export function deliverSteer() {}\n// steers are queued then delivered on the next turn\n");
write("src/feed.ts", "// the feed shows checkpoints\nexport const feed = [];\n");
write("plan/steers.md", "Steers are queued, then delivered on the next turn.\n");
write("src/steers.eval.ts", "// how do steers get queued and delivered\n");
write("src/unrelated.ts", "export const delivered = true;\n");

const ctx = { repoFor: (p: string) => (p === "proj" ? repo : undefined) } as unknown as SurfaceContext;
const kase = (query: string, projectId = "proj"): EvalCase => ({
  id: "c",
  category: "code",
  surface: ["code"],
  audience: { projectId },
  query,
  relevant: [],
});

describe("code surface", () => {
  test("ranks files by distinct-term coverage, a named file over prose, and drops weak and eval files", async () => {
    const run = await runCode(ctx, kase("how do steers get queued and delivered"));
    const refs = run.hits.map((h) => h.ref);
    // The source file named after the subject first, its design note after (prose is damped).
    expect(refs).toEqual(["code:src/steers.ts", "code:plan/steers.md"]);
    // One shared word is under the coverage floor; eval fixtures are excluded.
    expect(refs).not.toContain("code:src/unrelated.ts");
    expect(refs).not.toContain("code:src/steers.eval.ts");
    expect(run.hits[0].kind).toBe("code");
    expect(run.hits[0].excerpt).toBe("2: // steers are queued then delivered on the next turn");
    expect(run.hits.map((h) => h.rank)).toEqual([0, 1]);
    const report = run.detail?.codeSearch as { status: string; backend: string | null };
    expect(["ok", "degraded"]).toContain(report.status);
    expect(report.backend).not.toBeNull();
  });

  test("a project with no repo, or a query with no terms, searches nothing and says why", async () => {
    const noRepo = await runCode(ctx, kase("how do steers get delivered", "elsewhere"));
    expect(noRepo.hits).toEqual([]);
    expect(noRepo.detail?.codeSearch).toEqual({ status: "unavailable", backend: null, error: "no repo path to search" });
    const noTerms = await runCode(ctx, kase("how is it"));
    expect(noTerms.hits).toEqual([]);
    expect(noTerms.detail?.codeSearch).toMatchObject({ status: "unavailable", error: "no searchable terms in the query" });
  });
});
