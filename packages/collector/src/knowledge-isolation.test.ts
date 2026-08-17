import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";
import { runRipgrep } from "./ripgrep.js";

/**
 * Drafts must not be reachable by the code half of expert retrieval.
 *
 * The structural argument is that drafts live under `~/.config/standup/` while
 * `runRipgrep` searches the session's cwd, so they are out of reach by
 * construction. That argument is correct and is exactly the kind of thing this
 * project has been wrong about before: Phase 5 spent a phase's worth of
 * flattered numbers because the eval file sat in the searched corpus with every
 * test question in it verbatim, and excluding it moved 6/8 to 7/8. The lesson
 * recorded then was to assert corpus isolation rather than reason about it,
 * which is what these tests do.
 *
 * The stakes are higher here than for the eval file. A draft is unreviewed
 * machine output; the entire point of the review gate is that no agent reads it
 * until a human accepts it. A leak would not fail loudly — it would quietly
 * feed unverified text to agents as authoritative context.
 */
describe("knowledge drafts are outside the searched corpus", () => {
  test("ripgrep cannot escape the cwd it is given", async () => {
    const root = mkdtempSync(join(tmpdir(), "standup-isolation-"));
    try {
      // A repo, and a knowledge directory beside it — the real layout in
      // miniature, with the draft one level *up* from where a session runs.
      const repo = join(root, "repo");
      const knowledge = join(root, "knowledge", "proj", ".drafts");
      mkdirSync(repo, { recursive: true });
      mkdirSync(knowledge, { recursive: true });

      const token = "zqxjkbootstrapleakcanary";
      writeFileSync(join(knowledge, "gotchas.md"), `a draft containing ${token}\n`);
      // Present in the repo too, so a zero result can't be mistaken for
      // ripgrep simply failing to run or the pattern never matching anything.
      writeFileSync(join(repo, "real.ts"), `// source containing ${token}\n`);

      const result = await runRipgrep(token, repo);

      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.matches.every((m) => m.file.includes("real.ts"))).toBe(true);
      expect(result.matches.some((m) => m.file.includes(".drafts"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a search of this repo returns nothing from the knowledge directory", async () => {
    // The live version of the same claim, against the real paths rather than a
    // constructed layout. "standup" appears in both trees, so it exercises the
    // boundary rather than a term that was never going to match.
    const knowledgeDir = join(homedir(), ".config", "standup", "knowledge");
    const result = await runRipgrep("standup", process.cwd());

    expect(result.matches.length).toBeGreaterThan(0);
    for (const match of result.matches) {
      expect(match.file.startsWith(knowledgeDir)).toBe(false);
      expect(match.file).not.toContain("/.drafts/");
    }
  });
});
