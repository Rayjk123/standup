import { expect, test, describe } from "bun:test";
import { mkdtemp, rm, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  writeDraftFile,
  writeKnowledgeFile,
  updateDocFrontmatter,
  acceptDraftFile,
  deleteDraftFile,
  readKnowledgeFile,
  deleteKnowledgeFile,
  readRawDocFile,
  isSafePathSegment,
  isValidSlug,
  normalizeTags,
} from "./writer.js";
import { KnowledgeLoader } from "./loader.js";

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

  test("scope + owner_user survive a write-then-read (per-user knowledge)", async () => {
    const dir = await tempKnowledgeDir();
    try {
      await writeKnowledgeFile(dir, "proj", {
        slug: "mine",
        title: "Mine",
        body: "my own note",
        scope: "user",
        ownerUser: "alice",
      });

      const raw = await readFile(join(dir, "proj", "mine.md"), "utf-8");
      expect(raw).toContain("scope: user");
      expect(raw).toContain("owner_user: alice");

      const doc = await readKnowledgeFile(dir, "proj", "mine");
      expect(doc?.scope).toBe("user");
      expect(doc?.ownerUser).toBe("alice");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a doc written without scope surfaces none raw — the loader supplies 'project' (per-user knowledge)", async () => {
    const dir = await tempKnowledgeDir();
    try {
      await writeKnowledgeFile(dir, "proj", {
        slug: "plain",
        title: "Plain",
        body: "no scope asserted",
      });

      const raw = await readFile(join(dir, "proj", "plain.md"), "utf-8");
      expect(raw).not.toContain("scope:");
      expect(raw).not.toContain("owner_user:");

      // readKnowledgeFile surfaces scope RAW (undefined) so a round-tripping
      // edit never fabricates a scope the file did not carry; the loader is the
      // reader that applies the 'project' default on ingest.
      const doc = await readKnowledgeFile(dir, "proj", "plain");
      expect(doc?.scope).toBeUndefined();
      expect(doc?.ownerUser).toBeUndefined();
      const [loaded] = await new KnowledgeLoader(dir).loadProject("proj");
      expect(loaded.scope).toBe("project");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a read-modify-write through writeKnowledgeFile carrying scope/owner + related edges preserves them", async () => {
    const dir = await tempKnowledgeDir();
    try {
      await writeKnowledgeFile(dir, "proj", {
        slug: "mine",
        title: "Mine",
        body: "original",
        scope: "user",
        ownerUser: "alice",
        related: ["proj/other"],
        originClass: "agent",
      });

      // Simulate an edit route: read the existing file, then rewrite the body
      // while carrying the provenance/scope/edge frontmatter back through (a
      // full rewrite emits only what it is handed).
      const existing = await readKnowledgeFile(dir, "proj", "mine");
      await writeKnowledgeFile(dir, "proj", {
        slug: "mine",
        title: existing!.title,
        body: "edited body",
        scope: existing!.scope,
        ownerUser: existing!.ownerUser,
        related: existing!.related,
        originClass: existing!.originClass,
      });

      const [loaded] = await new KnowledgeLoader(dir).loadProject("proj");
      expect(loaded.body).toBe("edited body");
      expect(loaded.scope).toBe("user");
      expect(loaded.ownerUser).toBe("alice");
      // Existing graph edges are not severed by the round-trip.
      expect(loaded.related).toEqual(["proj/other"]);
      expect(loaded.originClass).toBe("agent");
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

  test("stamps origin_class + source_session_id for an agent-authored draft", async () => {
    const dir = await tempKnowledgeDir();
    try {
      await writeDraftFile(dir, "proj", {
        slug: "gotchas",
        title: "Gotchas",
        body: "watch out for X",
        originClass: "agent",
        sourceSessionId: "sess-1",
      });

      const raw = await readFile(join(dir, "proj", ".drafts", "gotchas.md"), "utf-8");
      expect(raw).toContain("origin_class: agent");
      expect(raw).toContain("source_session_id: sess-1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("draft provenance survives accept into the loaded doc", () => {
  // The automated pipeline: propose stamps origin_class + source_session_id on
  // the draft, acceptDraftFile's rename carries the frontmatter over, and
  // loadProject reads it back onto the KnowledgeDoc — which is what lets the
  // graph derive session→doc and doc→doc provenance edges for real agent
  // authoring rather than only for hand-written frontmatter.
  test("an accepted agent draft loads with origin_class + source_session_id", async () => {
    const dir = await tempKnowledgeDir();
    try {
      await writeDraftFile(dir, "proj", {
        slug: "gotchas",
        title: "Gotchas",
        body: "watch out for X",
        originClass: "agent",
        sourceSessionId: "sess-1",
      });
      expect(await acceptDraftFile(dir, "proj", "gotchas")).toBe(true);

      const docs = await new KnowledgeLoader(dir).loadProject("proj");
      const loaded = docs.find((d) => d.slug === "gotchas")!;
      expect(loaded.originClass).toBe("agent");
      expect(loaded.sourceSessionId).toBe("sess-1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Roadmap r2: source_kind + confidence bookkeeping must survive the same
  // propose→accept lifecycle. The propose path stamps them on the draft
  // frontmatter; acceptDraftFile's rename carries them up; loadProject reads
  // them onto the doc so the store persists them.
  test("an accepted draft's source_kind + confidence fields load onto the doc", async () => {
    const dir = await tempKnowledgeDir();
    try {
      await writeDraftFile(dir, "proj", {
        slug: "decay-doc",
        title: "Decay Doc",
        body: "a fact with a shelf life",
        originClass: "agent",
        sourceKind: "spec",
        confidence: 1,
        lastVerifiedAt: "2026-08-16T00:00:00.000Z",
        halfLifeDays: 90,
      });

      // The frontmatter is on the draft file before accept.
      const draftRaw = await readFile(join(dir, "proj", ".drafts", "decay-doc.md"), "utf-8");
      expect(draftRaw).toContain("source_kind: spec");
      expect(draftRaw).toContain("half_life_days: 90");

      expect(await acceptDraftFile(dir, "proj", "decay-doc")).toBe(true);

      const docs = await new KnowledgeLoader(dir).loadProject("proj");
      const loaded = docs.find((d) => d.slug === "decay-doc")!;
      expect(loaded.sourceKind).toBe("spec");
      expect(loaded.confidence).toBe(1);
      expect(loaded.lastVerifiedAt).toBe("2026-08-16T00:00:00.000Z");
      expect(loaded.halfLifeDays).toBe(90);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // A doc that asserts no source kind reads as 'unclassified' (the default),
  // never NULL/undefined and never presumed code.
  test("a draft without source_kind loads as 'unclassified' with no confidence opinion", async () => {
    const dir = await tempKnowledgeDir();
    try {
      await writeDraftFile(dir, "proj", {
        slug: "plain",
        title: "Plain",
        body: "no confidence bookkeeping here",
        originClass: "agent",
      });
      expect(await acceptDraftFile(dir, "proj", "plain")).toBe(true);

      const docs = await new KnowledgeLoader(dir).loadProject("proj");
      const loaded = docs.find((d) => d.slug === "plain")!;
      expect(loaded.sourceKind).toBe("unclassified");
      expect(loaded.confidence).toBeUndefined();
      expect(loaded.lastVerifiedAt).toBeUndefined();
      expect(loaded.halfLifeDays).toBeUndefined();
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

describe("updateDocFrontmatter — re-verification write-back (roadmap r5)", () => {
  test("patches confidence + last_verified_at while preserving every other frontmatter field", async () => {
    const dir = await tempKnowledgeDir();
    try {
      // Simulate an accepted agent-authored doc: it carries provenance the
      // loader reads back (origin_class, source_session_id) that a full rewrite
      // through writeKnowledgeFile would drop. Write the raw file directly so
      // those fields are present, as acceptDraftFile's rename leaves them.
      const { writeFile, mkdir } = await import("fs/promises");
      await mkdir(join(dir, "proj"), { recursive: true });
      await writeFile(
        join(dir, "proj", "arch.md"),
        [
          "---",
          "title: Arch",
          "origin_class: agent",
          "source_session_id: sess-1",
          "generated_from_sha: abc123",
          "source_kind: code",
          "confidence: 1",
          "last_verified_at: '2026-01-01T00:00:00.000Z'",
          "half_life_days: 90",
          "---",
          "the body",
          "",
        ].join("\n"),
        "utf-8"
      );

      const ok = await updateDocFrontmatter(dir, "proj", "arch", {
        confidence: 0.1,
        last_verified_at: "2026-09-01T00:00:00.000Z",
      });
      expect(ok).toBe(true);

      // The loader is the real reader of these fields — assert through it.
      const [loaded] = await new KnowledgeLoader(dir).loadProject("proj");
      expect(loaded.confidence).toBe(0.1);
      expect(loaded.lastVerifiedAt).toBe("2026-09-01T00:00:00.000Z");
      // Preserved, not dropped:
      expect(loaded.originClass).toBe("agent");
      expect(loaded.sourceSessionId).toBe("sess-1");
      expect(loaded.generatedFromSha).toBe("abc123");
      expect(loaded.halfLifeDays).toBe(90);
      expect(loaded.body).toBe("the body");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a confidence patch preserves scope, owner_user, and related edges (per-user knowledge)", async () => {
    const dir = await tempKnowledgeDir();
    try {
      // A user-scoped, agent-authored doc with an explicit graph edge — the
      // frontmatter a full rewrite would risk dropping. gray-matter's merge
      // preserves keys it wasn't told about, so a key-level confidence patch
      // must never flip the scope/owner or sever the edge.
      const { writeFile, mkdir } = await import("fs/promises");
      await mkdir(join(dir, "proj"), { recursive: true });
      await writeFile(
        join(dir, "proj", "mine.md"),
        [
          "---",
          "title: Mine",
          "scope: user",
          "owner_user: alice",
          "origin_class: agent",
          "related:",
          "  - proj/other",
          "confidence: 1",
          "---",
          "the body",
          "",
        ].join("\n"),
        "utf-8"
      );

      const ok = await updateDocFrontmatter(dir, "proj", "mine", { confidence: 0.1 });
      expect(ok).toBe(true);

      const [loaded] = await new KnowledgeLoader(dir).loadProject("proj");
      expect(loaded.confidence).toBe(0.1);
      // Preserved, not dropped:
      expect(loaded.scope).toBe("user");
      expect(loaded.ownerUser).toBe("alice");
      expect(loaded.related).toEqual(["proj/other"]);
      expect(loaded.originClass).toBe("agent");
      expect(loaded.body).toBe("the body");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("changes only the patched keys' lines: comments, date formats and flow lists are kept", async () => {
    const dir = await tempKnowledgeDir();
    try {
      const { writeFile, mkdir } = await import("fs/promises");
      await mkdir(join(dir, "proj"), { recursive: true });
      const raw = [
        "---",
        "# curated by the team",
        "title: Arch",
        "last_verified_at: 2026-08-16",
        "tags: [a, b]",
        "confidence: 1",
        "---",
        "",
        "the body",
        "",
      ].join("\n");
      await writeFile(join(dir, "proj", "arch.md"), raw, "utf-8");
      expect(await updateDocFrontmatter(dir, "proj", "arch", { confidence: 0.5, half_life_days: 90 })).toBe(true);
      expect(await readFile(join(dir, "proj", "arch.md"), "utf-8")).toBe(
        raw.replace("confidence: 1\n", "confidence: 0.5\nhalf_life_days: 90\n")
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a patch that widens a doc to scope=global or scope=user re-redacts it at the full tier", async () => {
    const dir = await tempKnowledgeDir();
    try {
      // A draft with no scope is written under project scope, which keeps
      // credential-shaped assignments; the accept path then re-stamps the
      // replaced doc's scope: global through updateDocFrontmatter.
      await writeDraftFile(dir, "proj", {
        slug: "acct",
        title: "db password: hunter2very",
        body: "connect with password: hunter2very\nin us-west-2",
      });
      expect(await acceptDraftFile(dir, "proj", "acct")).toBe(true);
      const path = join(dir, "proj", "acct.md");
      expect(await readFile(path, "utf-8")).toContain("password: hunter2very");

      expect(await updateDocFrontmatter(dir, "proj", "acct", { scope: "global" })).toBe(true);
      const widened = await readFile(path, "utf-8");
      expect(widened).not.toContain("hunter2very");
      expect(widened).toContain("connect with password: [REDACTED]\nin us-west-2");
      expect((await readRawDocFile(dir, "proj", "acct"))?.data).toMatchObject({
        scope: "global",
        title: "db password: [REDACTED]",
      });

      // A narrowing or same-placement patch leaves the text alone.
      await writeKnowledgeFile(dir, "proj", { slug: "team", title: "Team", body: "Beta password: s3cretTeamPass" });
      expect(await updateDocFrontmatter(dir, "proj", "team", { confidence: 0.9 })).toBe(true);
      expect(await readFile(join(dir, "proj", "team.md"), "utf-8")).toContain("s3cretTeamPass");
      expect(await updateDocFrontmatter(dir, "proj", "team", { scope: "user", owner_user: "alice" })).toBe(true);
      expect(await readFile(join(dir, "proj", "team.md"), "utf-8")).not.toContain("s3cretTeamPass");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns false when the doc file does not exist", async () => {
    const dir = await tempKnowledgeDir();
    try {
      expect(await updateDocFrontmatter(dir, "proj", "nope", { confidence: 0.5 })).toBe(false);
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

describe("write seam redaction", () => {
  const SECRET = "deploy to account 123456789012 with password: hunter2very";
  /** Signature-tier secrets, a heuristic-only shape and an account id: a project doc is redacted at the
   *  signature tier plus account ids. */
  const PROJECT_SECRET =
    "deploy to account 123456789012 with Server=db;User Id=app;Password=hunter2very; sortKey: createdAt";

  test("a project draft and doc lose secrets and account ids but keep credential-shaped team data", async () => {
    const dir = await tempKnowledgeDir();
    try {
      await writeDraftFile(dir, "proj", { slug: "draft", title: "Server=db;Password=hunter2very;", body: PROJECT_SECRET });
      const draft = await readFile(join(dir, "proj", ".drafts", "draft.md"), "utf-8");
      expect(draft).not.toContain("hunter2very");
      expect(draft).not.toContain("123456789012");
      expect(draft).toContain("sortKey: createdAt");

      await writeKnowledgeFile(dir, "proj", { slug: "doc", title: "Doc", body: PROJECT_SECRET, scope: "project" });
      const doc = await readKnowledgeFile(dir, "proj", "doc");
      expect(doc?.body).not.toContain("hunter2very");
      expect(doc?.body).not.toContain("123456789012");
      expect(doc?.body).toContain("sortKey: createdAt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a global or user-scoped write also loses account ids", async () => {
    const dir = await tempKnowledgeDir();
    try {
      await writeDraftFile(dir, "proj", { slug: "wide", title: "Wide", body: SECRET, scope: "global" });
      expect(await readFile(join(dir, "proj", ".drafts", "wide.md"), "utf-8")).not.toContain("123456789012");
      await writeKnowledgeFile(dir, "proj", { slug: "mine", title: "Mine", body: SECRET, scope: "user", ownerUser: "a" });
      expect((await readKnowledgeFile(dir, "proj", "mine"))?.body).not.toContain("123456789012");
      await writeKnowledgeFile(dir, "global", { slug: "home", title: "Home", body: SECRET });
      expect((await readKnowledgeFile(dir, "global", "home"))?.body).not.toContain("123456789012");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("doc paths stay inside their project", () => {
  test("a project id or slug that isn't one path segment reads nothing, deletes nothing and is never written", async () => {
    const dir = await tempKnowledgeDir();
    try {
      await writeKnowledgeFile(dir, "other", { slug: "private", title: "Private", body: "owner-private" });
      for (const [projectId, slug] of [
        ["global", "persona-../../other/private"],
        ["global", "../other/private"],
        ["..", "other/private"],
        ["global/../other", "private"],
        ["global", "a\\b"],
      ] as const) {
        expect(await readKnowledgeFile(dir, projectId, slug)).toBeNull();
        expect(await readRawDocFile(dir, projectId, slug)).toBeNull();
        expect(await deleteKnowledgeFile(dir, projectId, slug)).toBe(false);
        expect(await updateDocFrontmatter(dir, projectId, slug, { title: "x" })).toBe(false);
        await expect(writeKnowledgeFile(dir, projectId, { slug, title: "x", body: "x" })).rejects.toThrow();
      }
      expect(existsSync(join(dir, "other", "private.md"))).toBe(true);
      expect((await readKnowledgeFile(dir, "other", "private"))?.body).toContain("owner-private");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("isSafePathSegment accepts ordinary ids and slugs, odd file names included", () => {
    for (const ok of ["global", "frost-watch", "persona-alice-tests", "My_Notes", "v1.2"]) expect(isSafePathSegment(ok)).toBe(true);
    for (const bad of ["", ".", "..", "a/b", "a\\b", "x\u0000y"]) expect(isSafePathSegment(bad)).toBe(false);
  });
});

describe("isValidSlug", () => {
  test("rejects a missing or empty slug instead of testing it as a string", () => {
    expect(isValidSlug(undefined)).toBe(false);
    expect(isValidSlug(null)).toBe(false);
    expect(isValidSlug("")).toBe(false);
    expect(isValidSlug(42)).toBe(false);
  });

  test("accepts kebab-case and refuses path-shaped input", () => {
    expect(isValidSlug("retry-policy")).toBe(true);
    expect(isValidSlug("../x")).toBe(false);
    expect(isValidSlug("-leading")).toBe(false);
  });
});

describe("normalizeTags", () => {
  test("takes an array or a comma-separated string, trimmed, lowercased and deduped", () => {
    expect(normalizeTags(["Slack", " retry ", "slack"])).toEqual({ ok: true, tags: ["slack", "retry"] });
    expect(normalizeTags("slack, Retry,,backoff")).toEqual({ ok: true, tags: ["slack", "retry", "backoff"] });
    expect(normalizeTags(["a,b"])).toEqual({ ok: true, tags: ["a", "b"] });
  });

  test("absent or empty input stores no tags", () => {
    expect(normalizeTags(undefined)).toEqual({ ok: true, tags: undefined });
    expect(normalizeTags("")).toEqual({ ok: true, tags: undefined });
  });

  test("rejects a non-string tag, whitespace inside a tag, and too many tags", () => {
    expect(normalizeTags([1, "x"]).ok).toBe(false);
    expect(normalizeTags({ tag: "x" }).ok).toBe(false);
    expect(normalizeTags(["two words"]).ok).toBe(false);
    expect(normalizeTags(Array.from({ length: 17 }, (_, i) => `t${i}`)).ok).toBe(false);
  });
});
