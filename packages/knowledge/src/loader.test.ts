import { expect, test, describe } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { KnowledgeLoader } from "./loader.js";

async function tempKnowledgeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "standup-knowledge-"));
}

describe("KnowledgeLoader.loadProject", () => {
  test("ignores .drafts/ — not by design, but because readdir returns the bare directory name and it fails the .md check", async () => {
    const dir = await tempKnowledgeDir();
    try {
      const projectDir = join(dir, "proj");
      await mkdir(join(projectDir, ".drafts"), { recursive: true });
      await writeFile(join(projectDir, "accepted.md"), "---\ntitle: Accepted\n---\nbody");
      await writeFile(
        join(projectDir, ".drafts", "pending.md"),
        "---\ntitle: Pending\n---\nbody"
      );

      const loader = new KnowledgeLoader(dir);
      const docs = await loader.loadProject("proj");

      expect(docs.map((d) => d.slug)).toEqual(["accepted"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("carries generated_from_sha / generated_at frontmatter through when present", async () => {
    const dir = await tempKnowledgeDir();
    try {
      const projectDir = join(dir, "proj");
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        join(projectDir, "gen.md"),
        "---\ntitle: Gen\ngenerated_from_sha: abc123\ngenerated_at: '2026-08-16T00:00:00Z'\n---\nbody"
      );
      await writeFile(join(projectDir, "human.md"), "---\ntitle: Human\n---\nbody");

      const loader = new KnowledgeLoader(dir);
      const docs = await loader.loadProject("proj");

      const gen = docs.find((d) => d.slug === "gen")!;
      const human = docs.find((d) => d.slug === "human")!;

      expect(gen.generatedFromSha).toBe("abc123");
      expect(gen.generatedAt).toBe("2026-08-16T00:00:00Z");
      // Empty string is not NULL — a human-authored doc must come back
      // undefined, not "", or Step 6's staleness check would flag every
      // hand-written doc.
      expect(human.generatedFromSha).toBeUndefined();
      expect(human.generatedAt).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("KnowledgeLoader.loadDrafts", () => {
  test("reads .drafts/ and parses provenance frontmatter", async () => {
    const dir = await tempKnowledgeDir();
    try {
      const projectDir = join(dir, "proj");
      await mkdir(join(projectDir, ".drafts"), { recursive: true });
      await writeFile(
        join(projectDir, ".drafts", "toolchain.md"),
        [
          "---",
          "title: Toolchain",
          "generated_from_sha: deadbeef",
          "generated_at: '2026-08-16T00:00:00Z'",
          "generated_by_launch_id: launch-1",
          "---",
          "how to build",
        ].join("\n")
      );
      // A doc sitting alongside .drafts/ must not leak into loadDrafts.
      await writeFile(join(projectDir, "accepted.md"), "---\ntitle: Accepted\n---\nbody");

      const loader = new KnowledgeLoader(dir);
      const drafts = await loader.loadDrafts("proj");

      expect(drafts).toHaveLength(1);
      expect(drafts[0].slug).toBe("toolchain");
      expect(drafts[0].title).toBe("Toolchain");
      expect(drafts[0].body).toBe("how to build");
      expect(drafts[0].generatedFromSha).toBe("deadbeef");
      expect(drafts[0].generatedByLaunchId).toBe("launch-1");
      expect(drafts[0].replacesSlug).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns empty array when .drafts/ doesn't exist yet", async () => {
    const dir = await tempKnowledgeDir();
    try {
      await mkdir(join(dir, "proj"), { recursive: true });
      const loader = new KnowledgeLoader(dir);
      const drafts = await loader.loadDrafts("proj");
      expect(drafts).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
