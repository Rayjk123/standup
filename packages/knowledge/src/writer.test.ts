import { expect, test, describe } from "bun:test";
import { mkdtemp, rm, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  writeDraftFile,
  writeKnowledgeFile,
  acceptDraftFile,
  deleteDraftFile,
  readKnowledgeFile,
} from "./writer.js";

async function tempKnowledgeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "standup-knowledge-"));
}

describe("writeKnowledgeFile / readKnowledgeFile — provenance round-trip", () => {
  test("generatedFromSha/generatedAt survive a write-then-read (phase-7 Step 6)", async () => {
    const dir = await tempKnowledgeDir();
    try {
      await writeKnowledgeFile(dir, "proj", {
        slug: "gotchas",
        title: "Gotchas",
        body: "generated text",
        generatedFromSha: "abc123",
        generatedAt: "2026-08-16T00:00:00.000Z",
      });

      const raw = await readFile(join(dir, "proj", "gotchas.md"), "utf-8");
      expect(raw).toContain("generated_from_sha: abc123");

      const doc = await readKnowledgeFile(dir, "proj", "gotchas");
      expect(doc?.generatedFromSha).toBe("abc123");
      expect(doc?.generatedAt).toBe("2026-08-16T00:00:00.000Z");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a doc written without provenance has none — undefined, not empty string", async () => {
    const dir = await tempKnowledgeDir();
    try {
      await writeKnowledgeFile(dir, "proj", {
        slug: "conventions",
        title: "Conventions",
        body: "written by a person",
      });

      const raw = await readFile(join(dir, "proj", "conventions.md"), "utf-8");
      expect(raw).not.toContain("generated_from_sha");

      const doc = await readKnowledgeFile(dir, "proj", "conventions");
      expect(doc?.generatedFromSha).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("writeDraftFile", () => {
  test("rejects an invalid slug the same way writeKnowledgeFile does", async () => {
    const dir = await tempKnowledgeDir();
    try {
      await expect(
        writeDraftFile(dir, "proj", { slug: "not a slug!", title: "x", body: "x" })
      ).rejects.toThrow(/letters, numbers and hyphens/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("writes to .drafts/{slug}.md with provenance frontmatter", async () => {
    const dir = await tempKnowledgeDir();
    try {
      await writeDraftFile(dir, "proj", {
        slug: "gotchas",
        title: "Gotchas",
        body: "watch out for X",
        generatedFromSha: "abc123",
        generatedAt: "2026-08-16T00:00:00.000Z",
        generatedByLaunchId: "launch-1",
      });

      const path = join(dir, "proj", ".drafts", "gotchas.md");
      expect(existsSync(path)).toBe(true);

      const raw = await readFile(path, "utf-8");
      expect(raw).toContain("generated_from_sha: abc123");
      expect(raw).toContain("generated_by_launch_id: launch-1");
      expect(raw).toContain("watch out for X");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("acceptDraftFile", () => {
  test("moves .drafts/{slug}.md to {slug}.md, preserving frontmatter", async () => {
    const dir = await tempKnowledgeDir();
    try {
      await writeDraftFile(dir, "proj", {
        slug: "gotchas",
        title: "Gotchas",
        body: "watch out for X",
        generatedFromSha: "abc123",
        generatedAt: "2026-08-16T00:00:00.000Z",
      });

      const ok = await acceptDraftFile(dir, "proj", "gotchas");
      expect(ok).toBe(true);

      // Gone from .drafts/
      expect(existsSync(join(dir, "proj", ".drafts", "gotchas.md"))).toBe(false);

      // Present as an accepted doc, with provenance intact.
      const doc = await readKnowledgeFile(dir, "proj", "gotchas");
      expect(doc).not.toBeNull();
      expect(doc!.body).toBe("watch out for X");

      const raw = await readFile(join(dir, "proj", "gotchas.md"), "utf-8");
      expect(raw).toContain("generated_from_sha: abc123");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns false when there is no such draft", async () => {
    const dir = await tempKnowledgeDir();
    try {
      const ok = await acceptDraftFile(dir, "proj", "nonexistent");
      expect(ok).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("deleteDraftFile", () => {
  test("removes the draft file and reports whether one existed", async () => {
    const dir = await tempKnowledgeDir();
    try {
      await writeDraftFile(dir, "proj", { slug: "temp", title: "Temp", body: "x" });

      expect(await deleteDraftFile(dir, "proj", "temp")).toBe(true);
      expect(existsSync(join(dir, "proj", ".drafts", "temp.md"))).toBe(false);
      expect(await deleteDraftFile(dir, "proj", "temp")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
