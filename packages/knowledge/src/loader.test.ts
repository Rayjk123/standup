import { expect, test, describe } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { GLOBAL_PROJECT_ID } from "@standup/shared";
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

  test("coerces an unquoted YAML date in last_verified_at / generated_at to a string, not a Date", async () => {
    const dir = await tempKnowledgeDir();
    try {
      const projectDir = join(dir, "proj");
      await mkdir(projectDir, { recursive: true });
      // Unquoted timestamps — the natural way a human hand-authors YAML dates.
      // js-yaml parses these into JS Date objects, which bun:sqlite refuses to
      // bind into the TEXT columns, aborting the sync. The loader must hand back
      // strings so upsertDoc never sees a Date.
      await writeFile(
        join(projectDir, "decision.md"),
        [
          "---",
          "title: Decision",
          "confidence: 0.9",
          "last_verified_at: 2026-06-01",
          "generated_at: 2026-06-01T12:00:00Z",
          "half_life_days: 180",
          "---",
          "body",
        ].join("\n")
      );

      const loader = new KnowledgeLoader(dir);
      const docs = await loader.loadProject("proj");
      const doc = docs.find((d) => d.slug === "decision")!;

      expect(typeof doc.lastVerifiedAt).toBe("string");
      expect(doc.lastVerifiedAt).toBe("2026-06-01T00:00:00.000Z");
      expect(typeof doc.generatedAt).toBe("string");
      expect(doc.confidence).toBe(0.9);
      expect(doc.halfLifeDays).toBe(180);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("classes a doc in the owner's own dir as owner, honoring an explicit origin_class", async () => {
    const dir = await tempKnowledgeDir();
    try {
      const projectDir = join(dir, "proj");
      await mkdir(projectDir, { recursive: true });
      // No frontmatter class — a hand-written doc in the owner's own knowledge
      // dir is owner-authored, so it stays eligible for auto-injection rather
      // than being fail-closed out of it.
      await writeFile(join(projectDir, "bare.md"), "---\ntitle: Bare\n---\nbody");
      // An explicit class is honored, never overridden by the owner default.
      await writeFile(
        join(projectDir, "ext.md"),
        "---\ntitle: Ext\norigin_class: untrusted\n---\nbody"
      );

      const loader = new KnowledgeLoader(dir);
      const docs = await loader.loadProject("proj");

      expect(docs.find((d) => d.slug === "bare")!.originClass).toBe("owner");
      expect(docs.find((d) => d.slug === "ext")!.originClass).toBe("untrusted");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("defaults scope to 'project' when the file asserts none, and reads scope + owner_user when present (per-user knowledge)", async () => {
    const dir = await tempKnowledgeDir();
    try {
      const projectDir = join(dir, "proj");
      await mkdir(projectDir, { recursive: true });
      // No scope frontmatter — a doc belongs to its project unless promoted.
      await writeFile(join(projectDir, "bare.md"), "---\ntitle: Bare\n---\nbody");
      // A user-scoped doc names its owning user.
      await writeFile(
        join(projectDir, "mine.md"),
        "---\ntitle: Mine\nscope: user\nowner_user: alice\n---\nbody"
      );
      // A promoted global doc has no owning user.
      await writeFile(
        join(projectDir, "shared.md"),
        "---\ntitle: Shared\nscope: global\n---\nbody"
      );

      const loader = new KnowledgeLoader(dir);
      const docs = await loader.loadProject("proj");

      const bare = docs.find((d) => d.slug === "bare")!;
      expect(bare.scope).toBe("project");
      expect(bare.ownerUser).toBeUndefined();

      const mine = docs.find((d) => d.slug === "mine")!;
      expect(mine.scope).toBe("user");
      expect(mine.ownerUser).toBe("alice");

      const shared = docs.find((d) => d.slug === "shared")!;
      expect(shared.scope).toBe("global");
      expect(shared.ownerUser).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("defaults a doc in the reserved GLOBAL corpus to scope='global', so best-practice docs reach the whole corpus", async () => {
    const dir = await tempKnowledgeDir();
    try {
      // A doc physically homed in the reserved GLOBAL dir with no scope
      // frontmatter — the exact shape of a pre-existing best-practices doc. It
      // must read 'global' (not the 'project' default), or its project_id
      // ('global') keeps it out of every asking project's scope gate and the
      // whole global KB silently vanishes from launch injection + scoped search.
      const globalDir = join(dir, GLOBAL_PROJECT_ID);
      await mkdir(globalDir, { recursive: true });
      await writeFile(join(globalDir, "review-workflow.md"), "---\ntitle: Review workflow\n---\nbody");
      // An explicit in-set scope in the global dir is still honored — a
      // deliberately user-scoped doc placed here stays isolated to its owner.
      await writeFile(
        join(globalDir, "mine.md"),
        "---\ntitle: Mine\nscope: user\nowner_user: alice\n---\nbody"
      );
      // A typo/out-of-set scope in the global dir falls back to the global
      // default rather than 'project' — so a slip can't silently drop the doc.
      await writeFile(join(globalDir, "typo.md"), "---\ntitle: Typo\nscope: gobal\n---\nbody");

      const loader = new KnowledgeLoader(dir);
      const docs = await loader.loadProject(GLOBAL_PROJECT_ID);

      expect(docs.find((d) => d.slug === "review-workflow")!.scope).toBe("global");
      const mine = docs.find((d) => d.slug === "mine")!;
      expect(mine.scope).toBe("user");
      expect(mine.ownerUser).toBe("alice");
      expect(docs.find((d) => d.slug === "typo")!.scope).toBe("global");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an ordinary project still defaults scope to 'project', not 'global' — the reserved-corpus rule is scoped to it", async () => {
    const dir = await tempKnowledgeDir();
    try {
      const projectDir = join(dir, "alpha");
      await mkdir(projectDir, { recursive: true });
      await writeFile(join(projectDir, "bare.md"), "---\ntitle: Bare\n---\nbody");

      const loader = new KnowledgeLoader(dir);
      const docs = await loader.loadProject("alpha");

      expect(docs.find((d) => d.slug === "bare")!.scope).toBe("project");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("coerces an out-of-set (typo'd or wrong-cased) scope to 'project' rather than persisting an invalid enum", async () => {
    const dir = await tempKnowledgeDir();
    try {
      const projectDir = join(dir, "proj");
      await mkdir(projectDir, { recursive: true });
      // A hand-authored typo and a casing slip both fall outside the closed
      // SCOPES set; each must read back as the default rather than a broken
      // value that would match no retrieval window.
      await writeFile(
        join(projectDir, "typo.md"),
        "---\ntitle: Typo\nscope: gobal\n---\nbody"
      );
      await writeFile(
        join(projectDir, "case.md"),
        "---\ntitle: Case\nscope: Global\n---\nbody"
      );

      const loader = new KnowledgeLoader(dir);
      const docs = await loader.loadProject("proj");

      expect(docs.find((d) => d.slug === "typo")!.scope).toBe("project");
      expect(docs.find((d) => d.slug === "case")!.scope).toBe("project");
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
