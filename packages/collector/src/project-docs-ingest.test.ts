import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ingestProjectDocs, parseIngestMarker } from "./project-docs-ingest.js";

let root: string;
let knowledgeDir: string;
let repoDir: string;
let docsDirEnv: string | undefined;

beforeEach(async () => {
  // These cases lay their docs out under the default `plan` subdir, so a
  // STANDUP_PROJECT_DOCS_DIR set in the test environment must not redirect them.
  docsDirEnv = process.env.STANDUP_PROJECT_DOCS_DIR;
  delete process.env.STANDUP_PROJECT_DOCS_DIR;
  root = await mkdtemp(join(tmpdir(), "docs-ingest-"));
  knowledgeDir = join(root, "knowledge");
  repoDir = join(root, "repo");
  await mkdir(join(repoDir, "plan"), { recursive: true });
});

afterEach(async () => {
  if (docsDirEnv === undefined) delete process.env.STANDUP_PROJECT_DOCS_DIR;
  else process.env.STANDUP_PROJECT_DOCS_DIR = docsDirEnv;
  await rm(root, { recursive: true, force: true });
});

const project = (id = "standup") => ({ id, repos: [repoDir] });

async function corpus(slug: string): Promise<string> {
  return readFile(join(knowledgeDir, "standup", `${slug}.md`), "utf-8");
}

describe("ingestProjectDocs", () => {
  test("ingests a newly-committed plan doc, stamped and titled from its heading", async () => {
    await writeFile(
      join(repoDir, "plan", "slack-terminal-fidelity.md"),
      "# Slack mirror → terminal fidelity\n\nStatus: draft\n\nBody text.\n"
    );

    const [res] = await ingestProjectDocs(knowledgeDir, [project()]);

    expect(res.ingested).toEqual(["slack-terminal-fidelity"]);
    const written = await corpus("slack-terminal-fidelity");
    expect(parseIngestMarker(written)).toBe(
      join(repoDir, "plan", "slack-terminal-fidelity.md")
    );
    // Title comes off the first heading, not the slug.
    expect(written).toContain('title: "Slack mirror → terminal fidelity"');
    expect(written).toContain("Body text.");
    // A repo design doc is an owner-written spec, never a code fact.
    expect(written).toContain("source_kind: spec");
    expect(written).toContain("origin_class: owner");
  });

  test("redacts secrets and account ids out of the mirrored copy", async () => {
    await writeFile(
      join(repoDir, "plan", "deploy.md"),
      "# Deploy\n\nAccount 123456789012, DB postgres://admin:s3cr3tpass@db:5432/app\n"
    );
    await ingestProjectDocs(knowledgeDir, [project()]);
    const written = await corpus("deploy");
    expect(written).toContain("Account [REDACTED]");
    expect(written).not.toContain("123456789012");
    expect(written).not.toContain("s3cr3tpass");
  });

  test("rewrites a copy whose body predates the redaction, even when its source is older", async () => {
    const sourcePath = join(repoDir, "plan", "old.md");
    await writeFile(sourcePath, "# Old\n\nServer=db;Password=hunter2very;\n");
    await mkdir(join(knowledgeDir, "standup"), { recursive: true });
    await writeFile(
      join(knowledgeDir, "standup", "old.md"),
      `---\ntitle: "Old"\ningested_from: ${JSON.stringify(sourcePath)}\n---\n\n# Old\n\nServer=db;Password=hunter2very;\n`
    );
    const past = new Date(Date.now() - 3_600_000);
    await utimes(sourcePath, past, past);

    const [res] = await ingestProjectDocs(knowledgeDir, [project()]);
    expect(res.refreshed).toEqual(["old"]);
    expect(await corpus("old")).not.toContain("hunter2very");

    const [again] = await ingestProjectDocs(knowledgeDir, [project()]);
    expect(again.refreshed).toEqual([]);
  });

  test("a refresh keeps the front matter a curator set on an ingested copy", async () => {
    const sourcePath = join(repoDir, "plan", "cur.md");
    await writeFile(sourcePath, "# Cur\n\nv1\n");
    await ingestProjectDocs(knowledgeDir, [project()]);
    const path = join(knowledgeDir, "standup", "cur.md");
    const relabeled = (await corpus("cur"))
      .replace("source_kind: spec", "source_kind: decision\nscope: global\ntags:\n  - infra")
      .replace('title: "Cur"', 'title: "Curated title"');
    await writeFile(path, relabeled);

    // Front matter alone differs from what the ingest would render: no rewrite.
    const [noop] = await ingestProjectDocs(knowledgeDir, [project()]);
    expect(noop.refreshed).toEqual([]);
    expect(await corpus("cur")).toBe(relabeled);

    // A source change rewrites the body and keeps every curated key.
    await writeFile(sourcePath, "# Cur\n\nv2\n");
    const [res] = await ingestProjectDocs(knowledgeDir, [project()]);
    expect(res.refreshed).toEqual(["cur"]);
    const written = await corpus("cur");
    expect(written).toContain("v2");
    expect(written).toContain("source_kind: decision");
    expect(written).toContain("scope: global");
    expect(written).toContain("- infra");
    expect(written).toContain("Curated title");
  });

  test("recurses into subdirectories (research/*.md)", async () => {
    await mkdir(join(repoDir, "plan", "research"), { recursive: true });
    await writeFile(
      join(repoDir, "plan", "research", "openclaw-architecture.md"),
      "# OpenClaw architecture\n\ndeep read\n"
    );

    const [res] = await ingestProjectDocs(knowledgeDir, [project()]);

    expect(res.ingested).toEqual(["openclaw-architecture"]);
    expect(existsSync(join(knowledgeDir, "standup", "openclaw-architecture.md"))).toBe(
      true
    );
  });

  test("never overwrites a human-curated corpus doc (no marker)", async () => {
    await mkdir(join(knowledgeDir, "standup"), { recursive: true });
    const curated = "---\ntitle: Curated\nedges:\n  - other\n---\n\nHand written.\n";
    await writeFile(join(knowledgeDir, "standup", "gaps.md"), curated);
    await writeFile(join(repoDir, "plan", "gaps.md"), "# Gaps\n\nrepo version\n");

    const [res] = await ingestProjectDocs(knowledgeDir, [project()]);

    expect(res.ingested).toEqual([]);
    expect(res.refreshed).toEqual([]);
    // Curated content, including its hand-added edges, is untouched.
    expect(await corpus("gaps")).toBe(curated);
  });

  test("refreshes an ingested copy only when the repo source changed", async () => {
    const sourcePath = join(repoDir, "plan", "d.md");
    await writeFile(sourcePath, "# D\n\nv1\n");
    await ingestProjectDocs(knowledgeDir, [project()]);

    // Source unchanged (older than the just-written copy) — no refresh.
    const [noop] = await ingestProjectDocs(knowledgeDir, [project()]);
    expect(noop.refreshed).toEqual([]);

    // Bump the source content and its mtime into the future — refresh fires.
    await writeFile(sourcePath, "# D\n\nv2\n");
    const future = new Date(Date.now() + 60_000);
    await utimes(sourcePath, future, future);

    const [changed] = await ingestProjectDocs(knowledgeDir, [project()]);
    expect(changed.refreshed).toEqual(["d"]);
    expect(await corpus("d")).toContain("v2");
  });

  test("removes an ingested copy when its repo source is deleted", async () => {
    const sourcePath = join(repoDir, "plan", "temp.md");
    await writeFile(sourcePath, "# Temp\n\ntransient\n");
    await ingestProjectDocs(knowledgeDir, [project()]);
    expect(existsSync(join(knowledgeDir, "standup", "temp.md"))).toBe(true);

    await rm(sourcePath);
    const [res] = await ingestProjectDocs(knowledgeDir, [project()]);

    expect(res.removed).toEqual(["temp"]);
    expect(existsSync(join(knowledgeDir, "standup", "temp.md"))).toBe(false);
  });

  test("does not remove a curated corpus doc that has no repo source", async () => {
    await mkdir(join(knowledgeDir, "standup"), { recursive: true });
    await writeFile(
      join(knowledgeDir, "standup", "curated-only.md"),
      "---\ntitle: Only here\n---\n\nno repo source\n"
    );
    // A plan dir exists (so removal logic runs) but has no matching source.
    await writeFile(join(repoDir, "plan", "unrelated.md"), "# Unrelated\n\nx\n");

    const [res] = await ingestProjectDocs(knowledgeDir, [project()]);

    expect(res.removed).toEqual([]);
    expect(existsSync(join(knowledgeDir, "standup", "curated-only.md"))).toBe(true);
  });

  test("a repo with no docs directory is a silent no-op with no removal", async () => {
    await rm(join(repoDir, "plan"), { recursive: true, force: true });
    // A pre-existing ingested copy must survive when the repo/plan dir is gone
    // (e.g. an unmounted volume), so it is never mistaken for a deletion.
    await mkdir(join(knowledgeDir, "standup"), { recursive: true });
    await writeFile(
      join(knowledgeDir, "standup", "prior.md"),
      `---\ntitle: Prior\ningested_from: ${JSON.stringify(join(repoDir, "plan", "prior.md"))}\n---\n\nkept\n`
    );

    const results = await ingestProjectDocs(knowledgeDir, [project()]);

    expect(results).toEqual([]);
    expect(existsSync(join(knowledgeDir, "standup", "prior.md"))).toBe(true);
  });

  test("a duplicate basename across subdirectories keeps the first and skips the rest", async () => {
    await mkdir(join(repoDir, "plan", "sub"), { recursive: true });
    await writeFile(join(repoDir, "plan", "dup.md"), "# Top\n\ntop\n");
    await writeFile(join(repoDir, "plan", "sub", "dup.md"), "# Sub\n\nsub\n");

    const [res] = await ingestProjectDocs(knowledgeDir, [project()]);

    expect(res.ingested).toEqual(["dup"]);
  });

  test("expands a leading ~ and skips a project with no repo", async () => {
    const noRepo = { id: "scratch", repos: [] as string[] };
    const results = await ingestProjectDocs(knowledgeDir, [noRepo]);
    expect(results).toEqual([]);
  });
});

describe("parseIngestMarker", () => {
  test("returns null for a doc with no frontmatter and for one without the marker", () => {
    expect(parseIngestMarker("# Just a heading\n\nbody")).toBeNull();
    expect(parseIngestMarker("---\ntitle: X\n---\n\nbody")).toBeNull();
  });

  test("reads a quoted and a bare marker value", () => {
    expect(parseIngestMarker('---\ningested_from: "/a/b.md"\n---\n')).toBe("/a/b.md");
    expect(parseIngestMarker("---\ningested_from: /a/b.md\n---\n")).toBe("/a/b.md");
  });
});
