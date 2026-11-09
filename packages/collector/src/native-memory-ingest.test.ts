import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes } from "fs/promises";
import { existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readKnowledgeFile, isOriginEligibleForInjection } from "@standup/knowledge";
import {
  ingestNativeMemory,
  classifyAutoMemoryNote,
  ACTIVITY_NOTE_HALF_LIFE_DAYS,
  encodeClaudeProjectDir,
  buildKbFactsBlock,
  redactSecrets,
  KB_FACTS_BEGIN,
  KB_FACTS_END,
  type NativeMemoryIngestResult,
} from "./native-memory-ingest.js";

/**
 * Native-memory ingest mirrors Claude Code's own memory surfaces (the CLAUDE.md
 * hierarchy + auto-memory) into the knowledge corpus. Exercised entirely against
 * a temp base dir standing in for HOME — the real ~/.claude is never read or
 * written. Sibling of project-docs-ingest.test.ts, sharing its idempotency /
 * non-destructiveness shape.
 */

let root: string;
let knowledgeDir: string;
let baseDir: string;
let repoDir: string;

const GLOBAL_ID = "global";
const PROJECT_ID = "proj";

/**
 * The host settings the ingest reads from the environment. Each test clears
 * them (with a fixed USER), so the outcome never depends on the host's user or
 * its STANDUP_* configuration. HOME is not among them: bun's os.homedir() does
 * not follow a runtime HOME change, so every call passes `baseDir` instead and
 * the real ~/.claude is never consulted.
 */
const HOST_ENV_KEYS = [
  "USER",
  "STANDUP_HOST_USER",
  "STANDUP_NATIVE_MEMORY_EXCLUDE_HOME",
  "STANDUP_NATIVE_MEMORY_PROJECT_ID",
  "STANDUP_PERSONAL_ACCOUNT_IDS",
] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "native-mem-"));
  knowledgeDir = join(root, "knowledge");
  baseDir = join(root, "home");
  repoDir = join(root, "repo");
  await mkdir(join(baseDir, ".claude"), { recursive: true });

  savedEnv = {};
  for (const key of HOST_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.USER = "native-mem-test";
});

afterEach(async () => {
  for (const key of HOST_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await rm(root, { recursive: true, force: true });
});

const project = () => ({ id: PROJECT_ID, repos: [repoDir] });

function opts(extra: Record<string, unknown> = {}) {
  return { baseDir, globalProjectId: GLOBAL_ID, projects: [project()], ...extra };
}

function byId(results: NativeMemoryIngestResult[], id: string): NativeMemoryIngestResult {
  const r = results.find((x) => x.projectId === id);
  if (!r) throw new Error(`no result for ${id}`);
  return r;
}

function memoryDir(): string {
  return join(baseDir, ".claude", "projects", encodeClaudeProjectDir(repoDir), "memory");
}

async function seedHome(): Promise<void> {
  await writeFile(
    join(baseDir, ".claude", "CLAUDE.md"),
    "# Global notes\n\nAlways prefer imports over inline names.\n"
  );
  await mkdir(join(baseDir, ".claude", "rules"), { recursive: true });
  await writeFile(
    join(baseDir, ".claude", "rules", "safety.md"),
    "# Production safety\n\nNever delete prod resources.\n"
  );
}

async function seedProject(): Promise<void> {
  await mkdir(join(repoDir, ".claude"), { recursive: true });
  await writeFile(
    join(repoDir, ".claude", "CLAUDE.md"),
    "# Standup project notes\n\nThe collector is authoritative.\n"
  );
  await mkdir(memoryDir(), { recursive: true });
  await writeFile(join(memoryDir(), "MEMORY.md"), "# Memory index\n\n- slack streaming verified\n");
}

describe("ingestNativeMemory — mirroring", () => {
  test("mirrors the CLAUDE.md hierarchy and auto-memory with native-memory provenance", async () => {
    await seedHome();
    await seedProject();

    const { results } = await ingestNativeMemory(knowledgeDir, opts());

    // HOME CLAUDE.md + rule land under the global corpus, owner-trust.
    const g = byId(results, GLOBAL_ID);
    expect(g.ingested.sort()).toEqual(
      ["native-mem-home-claude-md", "native-mem-home-rule-safety"].sort()
    );

    const homeClaude = await readKnowledgeFile(knowledgeDir, GLOBAL_ID, "native-mem-home-claude-md");
    expect(homeClaude?.sourceKind).toBe("native-memory");
    expect(homeClaude?.originClass).toBe("owner");
    expect(homeClaude?.nativeMemoryFrom).toBe(join(baseDir, ".claude", "CLAUDE.md"));
    // Title comes off the first heading, and the body is mirrored.
    expect(homeClaude?.title).toBe("Global notes");
    expect(homeClaude?.body).toContain("prefer imports");

    const rule = await readKnowledgeFile(knowledgeDir, GLOBAL_ID, "native-mem-home-rule-safety");
    expect(rule?.sourceKind).toBe("native-memory");
    expect(rule?.originClass).toBe("owner");

    // Project CLAUDE.md + auto-memory land under the project corpus; memory is
    // agent-trust (Claude Code wrote it), CLAUDE.md is owner-trust.
    const p = byId(results, PROJECT_ID);
    expect(p.ingested.sort()).toEqual(
      ["native-mem-memory-memory", "native-mem-project-claude-md"].sort()
    );

    const projClaude = await readKnowledgeFile(knowledgeDir, PROJECT_ID, "native-mem-project-claude-md");
    expect(projClaude?.originClass).toBe("owner");
    expect(projClaude?.nativeMemoryFrom).toBe(join(repoDir, ".claude", "CLAUDE.md"));

    const mem = await readKnowledgeFile(knowledgeDir, PROJECT_ID, "native-mem-memory-memory");
    expect(mem?.sourceKind).toBe("native-memory");
    expect(mem?.originClass).toBe("agent");
    expect(mem?.nativeMemoryFrom).toBe(join(memoryDir(), "MEMORY.md"));
    // Agent-authored native memory is injection-eligible (unlike untrusted).
    expect(isOriginEligibleForInjection(mem?.originClass)).toBe(true);
  });

  test("opting the home tier out skips it and leaves a prior mirror untouched", async () => {
    await seedHome();
    await seedProject();

    // First pass mirrors the home tier by default.
    await ingestNativeMemory(knowledgeDir, opts());
    expect(existsSync(join(knowledgeDir, GLOBAL_ID, "native-mem-home-claude-md.md"))).toBe(true);

    // Opt the tier out: nothing home-tier is ingested this pass, and the prior
    // mirror is left in place (opting out stops updating, it does not delete).
    const { results } = await ingestNativeMemory(knowledgeDir, opts({ includeHomeConfig: false }));

    const g = results.find((r) => r.projectId === GLOBAL_ID);
    if (g) {
      expect(g.ingested).toEqual([]);
      expect(g.refreshed).toEqual([]);
      expect(g.removed).toEqual([]);
    }
    expect(existsSync(join(knowledgeDir, GLOBAL_ID, "native-mem-home-claude-md.md"))).toBe(true);
    expect(existsSync(join(knowledgeDir, GLOBAL_ID, "native-mem-home-rule-safety.md"))).toBe(true);
    // The project tier is unaffected by the flag.
    const p = byId(results, PROJECT_ID);
    expect(p.removed).toEqual([]);
  });

  test("STANDUP_NATIVE_MEMORY_EXCLUDE_HOME env flag opts the home tier out", async () => {
    await seedHome();
    const prev = process.env.STANDUP_NATIVE_MEMORY_EXCLUDE_HOME;
    process.env.STANDUP_NATIVE_MEMORY_EXCLUDE_HOME = "1";
    try {
      // No includeHomeConfig override → the env flag decides; home tier skipped.
      const { results } = await ingestNativeMemory(knowledgeDir, {
        baseDir,
        globalProjectId: GLOBAL_ID,
        projects: [],
      });
      const g = results.find((r) => r.projectId === GLOBAL_ID);
      expect(g).toBeUndefined();
      expect(existsSync(join(knowledgeDir, GLOBAL_ID, "native-mem-home-claude-md.md"))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.STANDUP_NATIVE_MEMORY_EXCLUDE_HOME;
      else process.env.STANDUP_NATIVE_MEMORY_EXCLUDE_HOME = prev;
    }
  });

  test("redacts secrets out of a mirrored home config body", async () => {
    await mkdir(join(baseDir, ".claude"), { recursive: true });
    await writeFile(
      join(baseDir, ".claude", "CLAUDE.md"),
      "# Global notes\n\naccount 123456789012, password: hunter2very\n"
    );

    await ingestNativeMemory(knowledgeDir, opts({ projects: [] }));

    const doc = await readKnowledgeFile(knowledgeDir, GLOBAL_ID, "native-mem-home-claude-md");
    expect(doc?.body).not.toContain("123456789012");
    expect(doc?.body).not.toContain("hunter2very");
    expect(doc?.body).toContain("[REDACTED]");
  });

  test("redacts UPPER_SNAKE creds, bearer tokens and connection strings before mirroring", async () => {
    await mkdir(join(baseDir, ".claude"), { recursive: true });
    await writeFile(
      join(baseDir, ".claude", "CLAUDE.md"),
      [
        "# Global notes",
        "",
        "export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIbPxRfiCYEXAMPLEKEYVALUE",
        "DB is postgres://admin:s3cr3tpass@db.internal:5432/app",
        "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.header.signature",
        "FOO_TOKEN=s3cR8tT0k3nV4lu3x9Q2zL",
        "",
      ].join("\n")
    );

    await ingestNativeMemory(knowledgeDir, opts({ projects: [] }));

    const doc = await readKnowledgeFile(knowledgeDir, GLOBAL_ID, "native-mem-home-claude-md");
    const body = doc?.body ?? "";
    // None of the secret material survives into the mirrored, remote-embedded copy.
    expect(body).not.toContain("wJalrXUtnFEMIbPxRfiCYEXAMPLEKEYVALUE");
    expect(body).not.toContain("s3cr3tpass");
    expect(body).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(body).not.toContain("s3cR8tT0k3nV4lu3x9Q2zL");
    expect(body).toContain("[REDACTED]");
  });

  test("mirrors the project-level .claude/rules/*.md tier as owner-trust native memory", async () => {
    await mkdir(join(repoDir, ".claude", "rules"), { recursive: true });
    await writeFile(
      join(repoDir, ".claude", "rules", "conventions.md"),
      "# Repo conventions\n\nPrefer imports over inline names.\n"
    );

    // Isolate the project rules tier — the home tier is off, and the project has
    // no CLAUDE.md or auto-memory this pass, only its `.claude/rules`.
    const { results } = await ingestNativeMemory(knowledgeDir, opts({ includeHomeConfig: false }));

    const p = byId(results, PROJECT_ID);
    expect(p.ingested).toContain("native-mem-project-rule-conventions");

    const rule = await readKnowledgeFile(
      knowledgeDir,
      PROJECT_ID,
      "native-mem-project-rule-conventions"
    );
    expect(rule?.sourceKind).toBe("native-memory");
    expect(rule?.originClass).toBe("owner");
    expect(rule?.nativeMemoryFrom).toBe(join(repoDir, ".claude", "rules", "conventions.md"));
    expect(rule?.title).toBe("Repo conventions");
    expect(rule?.body).toContain("Prefer imports");
  });

  test("a source deleted mid-pass skips only itself and never aborts the run", async () => {
    // Two home-tier sources: the CLAUDE.md (scanned/pushed synchronously, before
    // the first await) and a rule (scanned via readdir). Deleting the CLAUDE.md
    // the instant the ingest suspends on its first await reproduces the
    // scan-then-vanish race, since the file is read only later in the pass.
    await seedHome();
    const homeClaude = join(baseDir, ".claude", "CLAUDE.md");

    const pending = ingestNativeMemory(knowledgeDir, opts({ projects: [] }));
    // Synchronous: runs before any of the ingest's awaits resolve, so the file
    // is gone by the time the processing loop reads it.
    rmSync(homeClaude);

    // The whole pass still resolves (an unguarded read would have rejected here).
    const { results } = await pending;

    // The vanished source is skipped; the surviving rule is still mirrored.
    expect(existsSync(join(knowledgeDir, GLOBAL_ID, "native-mem-home-claude-md.md"))).toBe(false);
    expect(existsSync(join(knowledgeDir, GLOBAL_ID, "native-mem-home-rule-safety.md"))).toBe(true);
    const g = byId(results, GLOBAL_ID);
    expect(g.ingested).toContain("native-mem-home-rule-safety");
    expect(g.ingested).not.toContain("native-mem-home-claude-md");
  });

  test("re-running is idempotent — no re-ingest, no duplicates", async () => {
    await seedHome();
    await seedProject();

    await ingestNativeMemory(knowledgeDir, opts());
    const { results } = await ingestNativeMemory(knowledgeDir, opts());

    for (const r of results) {
      expect(r.ingested).toEqual([]);
      expect(r.refreshed).toEqual([]);
      expect(r.removed).toEqual([]);
    }
  });

  test("refreshes a mirrored doc only when the doc it would write changed", async () => {
    await seedHome();
    await ingestNativeMemory(knowledgeDir, opts());

    // Unchanged source (older than the just-written copy) — no refresh.
    const noop = await ingestNativeMemory(knowledgeDir, opts());
    expect(byId(noop.results, GLOBAL_ID).refreshed).toEqual([]);

    // Bump the source content and its mtime into the future — refresh fires.
    const sourcePath = join(baseDir, ".claude", "CLAUDE.md");
    await writeFile(sourcePath, "# Global notes\n\nUpdated guidance.\n");
    const future = new Date(Date.now() + 60_000);
    await utimes(sourcePath, future, future);

    const changed = await ingestNativeMemory(knowledgeDir, opts());
    expect(byId(changed.results, GLOBAL_ID).refreshed).toEqual(["native-mem-home-claude-md"]);
    const doc = await readKnowledgeFile(knowledgeDir, GLOBAL_ID, "native-mem-home-claude-md");
    expect(doc?.body).toContain("Updated guidance");
  });

  test("removes a mirrored doc when its source is deleted", async () => {
    await seedHome();
    await ingestNativeMemory(knowledgeDir, opts());
    expect(existsSync(join(knowledgeDir, GLOBAL_ID, "native-mem-home-rule-safety.md"))).toBe(true);

    await rm(join(baseDir, ".claude", "rules", "safety.md"));
    const { results } = await ingestNativeMemory(knowledgeDir, opts());

    expect(byId(results, GLOBAL_ID).removed).toEqual(["native-mem-home-rule-safety"]);
    expect(existsSync(join(knowledgeDir, GLOBAL_ID, "native-mem-home-rule-safety.md"))).toBe(false);
  });

  test("never overwrites a human-curated corpus doc occupying the same slug", async () => {
    await mkdir(join(knowledgeDir, GLOBAL_ID), { recursive: true });
    const curated = "---\ntitle: Curated\n---\n\nHand written, no marker.\n";
    await writeFile(join(knowledgeDir, GLOBAL_ID, "native-mem-home-claude-md.md"), curated);
    await writeFile(join(baseDir, ".claude", "CLAUDE.md"), "# Global notes\n\nrepo version\n");

    const { results } = await ingestNativeMemory(knowledgeDir, opts({ projects: [] }));

    expect(byId(results, GLOBAL_ID).ingested).toEqual([]);
    expect(byId(results, GLOBAL_ID).refreshed).toEqual([]);
    expect(await readFile(join(knowledgeDir, GLOBAL_ID, "native-mem-home-claude-md.md"), "utf-8")).toBe(
      curated
    );
  });

  test("an absent memory dir is a no-op with no removal (unmounted safety)", async () => {
    // A previously-mirrored memory doc must survive when the memory dir is gone
    // this pass, so it is never mistaken for a deletion.
    await mkdir(join(knowledgeDir, PROJECT_ID), { recursive: true });
    const marker = join(memoryDir(), "MEMORY.md");
    await writeFile(
      join(knowledgeDir, PROJECT_ID, "native-mem-memory-memory.md"),
      `---\ntitle: Prior\nsource_kind: native-memory\nnative_memory_from: ${JSON.stringify(marker)}\n---\n\nkept\n`
    );

    const { results } = await ingestNativeMemory(knowledgeDir, opts());

    // Project has no .claude dir and no memory dir this pass → nothing scanned,
    // nothing removed, the prior copy survives.
    const p = results.find((x) => x.projectId === PROJECT_ID);
    if (p) expect(p.removed).toEqual([]);
    expect(existsSync(join(knowledgeDir, PROJECT_ID, "native-mem-memory-memory.md"))).toBe(true);
  });

  test("home and project CLAUDE.md do not collide when the project shares the global corpus id", async () => {
    await seedHome();
    await mkdir(join(repoDir, ".claude"), { recursive: true });
    await writeFile(join(repoDir, ".claude", "CLAUDE.md"), "# Repo notes\n\nlocal\n");

    // Project id == global corpus id: both CLAUDE.md files target the same dir.
    const { results } = await ingestNativeMemory(knowledgeDir, {
      baseDir,
      globalProjectId: GLOBAL_ID,
      projects: [{ id: GLOBAL_ID, repos: [repoDir] }],
    });

    const g = byId(results, GLOBAL_ID);
    expect(g.ingested).toContain("native-mem-home-claude-md");
    expect(g.ingested).toContain("native-mem-project-claude-md");
    expect((await readKnowledgeFile(knowledgeDir, GLOBAL_ID, "native-mem-home-claude-md"))?.body).toContain(
      "Global notes"
    );
    expect((await readKnowledgeFile(knowledgeDir, GLOBAL_ID, "native-mem-project-claude-md"))?.body).toContain(
      "Repo notes"
    );
  });
});

describe("ingestNativeMemory — layers and re-mirroring", () => {
  const note = (type: string | undefined, body: string) =>
    (type ? `---\nname: n\ndescription: d\ntype: ${type}\n---\n` : "") + body;

  test("home-tier mirrors are personal: scope=user owned by the host user, homed in global", async () => {
    await seedHome();
    await ingestNativeMemory(knowledgeDir, opts({ projects: [], hostUser: "tester" }));

    for (const slug of ["native-mem-home-claude-md", "native-mem-home-rule-safety"]) {
      const doc = await readKnowledgeFile(knowledgeDir, GLOBAL_ID, slug);
      expect(doc?.scope).toBe("user");
      expect(doc?.ownerUser).toBe("tester");
      expect(doc?.originClass).toBe("owner");
    }
  });

  test("a repo CLAUDE.md mirror stays project-scoped", async () => {
    await seedProject();
    await ingestNativeMemory(knowledgeDir, opts({ includeHomeConfig: false, hostUser: "tester" }));
    const doc = await readKnowledgeFile(knowledgeDir, PROJECT_ID, "native-mem-project-claude-md");
    expect(doc?.scope).toBeUndefined();
    expect(doc?.ownerUser).toBeUndefined();
  });

  test("auto-memory notes are classified by their own front-matter type", async () => {
    await mkdir(memoryDir(), { recursive: true });
    await writeFile(join(memoryDir(), "reply-style.md"), note("feedback", "# Reply style\n\nKeep replies short.\n"));
    await writeFile(join(memoryDir(), "who.md"), note("user", "# Who\n\nSenior engineer.\n"));
    await writeFile(join(memoryDir(), "build.md"), note("project", "# Build\n\nRun bun test.\n"));
    await writeFile(join(memoryDir(), "dash.md"), note("reference", "# Dashboards\n\nSee the wiki.\n"));
    await writeFile(join(memoryDir(), "diary.md"), note("project", "# Diary 2026-09-05\n\nUser is away.\n"));
    await writeFile(join(memoryDir(), "MEMORY.md"), "# Memory index\n\n- build\n");

    const { results } = await ingestNativeMemory(
      knowledgeDir,
      opts({ includeHomeConfig: false, hostUser: "tester" })
    );
    expect(byId(results, PROJECT_ID).ingested.sort()).toEqual(
      [
        "native-mem-memory-diary",
        "native-mem-memory-memory",
        "native-mem-memory-reply-style",
        "native-mem-memory-who",
        "native-mem-note-build",
        "native-mem-note-dash",
      ].sort()
    );

    const feedback = await readKnowledgeFile(knowledgeDir, PROJECT_ID, "native-mem-memory-reply-style");
    expect(feedback?.scope).toBe("user");
    expect(feedback?.ownerUser).toBe("tester");
    expect(feedback?.halfLifeDays).toBeUndefined();

    const fact = await readKnowledgeFile(knowledgeDir, PROJECT_ID, "native-mem-note-build");
    expect(fact?.scope).toBeUndefined();
    expect(fact?.halfLifeDays).toBeUndefined();

    const diary = await readKnowledgeFile(knowledgeDir, PROJECT_ID, "native-mem-memory-diary");
    expect(diary?.scope).toBeUndefined();
    expect(diary?.halfLifeDays).toBe(ACTIVITY_NOTE_HALF_LIFE_DAYS);
    expect(diary?.confidence).toBe(1);
    expect(diary?.lastVerifiedAt).toBeDefined();
  });

  test("classifyAutoMemoryNote reads the type, and a dated name or heading is activity", () => {
    expect(classifyAutoMemoryNote("x.md", note("feedback", "# X\n"))).toBe("personal");
    expect(classifyAutoMemoryNote("x.md", note("project", "# X\n"))).toBe("docs");
    expect(classifyAutoMemoryNote("2026-09-05-log.md", note("project", "# X\n"))).toBe("activity");
    expect(classifyAutoMemoryNote("x.md", note("reference", "# Log 2026-09-05\n"))).toBe("activity");
    expect(classifyAutoMemoryNote("x.md", "# Untyped\n")).toBe("activity");
  });

  test("auto-memory is read from every repo of the project", async () => {
    const second = join(root, "repo-two");
    const secondMemory = join(baseDir, ".claude", "projects", encodeClaudeProjectDir(second), "memory");
    await mkdir(memoryDir(), { recursive: true });
    await mkdir(secondMemory, { recursive: true });
    await writeFile(join(memoryDir(), "one.md"), note("project", "# One\n\nfirst repo\n"));
    await writeFile(join(secondMemory, "two.md"), note("project", "# Two\n\nsecond repo\n"));

    const { results } = await ingestNativeMemory(knowledgeDir, {
      baseDir,
      globalProjectId: GLOBAL_ID,
      includeHomeConfig: false,
      hostUser: "tester",
      projects: [{ id: PROJECT_ID, repos: [repoDir, second] }],
    });
    expect(byId(results, PROJECT_ID).ingested.sort()).toEqual(["native-mem-note-one", "native-mem-note-two"]);
  });

  test("a copy made before a redaction change is re-redacted even though its source never moved", async () => {
    await mkdir(join(baseDir, ".claude"), { recursive: true });
    const source = join(baseDir, ".claude", "CLAUDE.md");
    await writeFile(source, "# Global notes\n\naccount 1234-5678-9012 here\n");
    // A stale copy written later than its source, still carrying the secret.
    await mkdir(join(knowledgeDir, GLOBAL_ID), { recursive: true });
    await writeFile(
      join(knowledgeDir, GLOBAL_ID, "native-mem-home-claude-md.md"),
      `---\ntitle: Global notes\nsource_kind: native-memory\norigin_class: owner\nnative_memory_from: ${JSON.stringify(source)}\n---\n\n# Global notes\n\naccount 1234-5678-9012 here\n`
    );
    const past = new Date(Date.now() - 3_600_000);
    await utimes(source, past, past);

    const { results } = await ingestNativeMemory(knowledgeDir, opts({ projects: [], hostUser: "tester" }));
    expect(byId(results, GLOBAL_ID).refreshed).toEqual(["native-mem-home-claude-md"]);
    const doc = await readKnowledgeFile(knowledgeDir, GLOBAL_ID, "native-mem-home-claude-md");
    expect(doc?.body).not.toContain("1234-5678-9012");
    expect(doc?.scope).toBe("user");

    // Re-running leaves the now-current copy alone.
    const again = await ingestNativeMemory(knowledgeDir, opts({ projects: [], hostUser: "tester" }));
    expect(byId(again.results, GLOBAL_ID).refreshed).toEqual([]);
  });

  test("both a repo CLAUDE.md mirror and the home mirror lose their account ids", async () => {
    await mkdir(join(repoDir, ".claude"), { recursive: true });
    await writeFile(join(repoDir, ".claude", "CLAUDE.md"), "# Repo\n\nBeta account 444455556666, Server=db;Password=hunter2very;\n");
    await writeFile(join(baseDir, ".claude", "CLAUDE.md"), "# Home\n\nPersonal dev account: 111122223333\n");

    await ingestNativeMemory(knowledgeDir, opts({ hostUser: "tester" }));

    const repo = await readKnowledgeFile(knowledgeDir, PROJECT_ID, "native-mem-project-claude-md");
    expect(repo?.body).toContain("Beta account [REDACTED]");
    expect(repo?.body).not.toContain("444455556666");
    expect(repo?.body).not.toContain("hunter2very");
    const home = await readKnowledgeFile(knowledgeDir, GLOBAL_ID, "native-mem-home-claude-md");
    expect(home?.body).not.toContain("111122223333");
  });

  test("a curator's relabel of a mirror survives re-ingest, and a source change keeps it", async () => {
    await mkdir(join(repoDir, ".claude"), { recursive: true });
    const source = join(repoDir, ".claude", "CLAUDE.md");
    await writeFile(source, "# Repo\n\nv1\n");
    await ingestNativeMemory(knowledgeDir, opts({ hostUser: "tester" }));
    const path = join(knowledgeDir, PROJECT_ID, "native-mem-project-claude-md.md");
    const relabeled = (await readFile(path, "utf-8")).replace(
      "source_kind: native-memory",
      "source_kind: native-memory\nscope: global\ntags:\n  - steering"
    );
    await writeFile(path, relabeled);

    const noop = await ingestNativeMemory(knowledgeDir, opts({ hostUser: "tester" }));
    expect(byId(noop.results, PROJECT_ID).refreshed).toEqual([]);
    expect(await readFile(path, "utf-8")).toBe(relabeled);

    await writeFile(source, "# Repo\n\nv2\n");
    const changed = await ingestNativeMemory(knowledgeDir, opts({ hostUser: "tester" }));
    expect(byId(changed.results, PROJECT_ID).refreshed).toEqual(["native-mem-project-claude-md"]);
    const doc = await readKnowledgeFile(knowledgeDir, PROJECT_ID, "native-mem-project-claude-md");
    expect(doc?.body).toContain("v2");
    expect(doc?.scope).toBe("global");
    expect(doc?.tags).toEqual(["steering"]);
  });

  test("a home-tier copy homed outside the global corpus is reclaimed", async () => {
    await seedHome();
    const source = join(baseDir, ".claude", "CLAUDE.md");
    await mkdir(join(knowledgeDir, PROJECT_ID), { recursive: true });
    await writeFile(
      join(knowledgeDir, PROJECT_ID, "native-mem-home-claude-md.md"),
      `---\ntitle: Old copy\nsource_kind: native-memory\nnative_memory_from: ${JSON.stringify(source)}\n---\n\nold\n`
    );
    // A curated doc with the same stem but no marker is never touched.
    await writeFile(
      join(knowledgeDir, PROJECT_ID, "native-mem-home-rule-curated.md"),
      "---\ntitle: Curated\n---\n\nmine\n"
    );

    const { results } = await ingestNativeMemory(knowledgeDir, opts({ projects: [], hostUser: "tester" }));
    expect(byId(results, PROJECT_ID).removed).toEqual(["native-mem-home-claude-md"]);
    expect(existsSync(join(knowledgeDir, PROJECT_ID, "native-mem-home-claude-md.md"))).toBe(false);
    expect(existsSync(join(knowledgeDir, PROJECT_ID, "native-mem-home-rule-curated.md"))).toBe(true);
    expect(existsSync(join(knowledgeDir, GLOBAL_ID, "native-mem-home-claude-md.md"))).toBe(true);
  });

  test("a note whose type changed moves to its new slug and the old copy is reclaimed", async () => {
    await mkdir(memoryDir(), { recursive: true });
    const file = join(memoryDir(), "build.md");
    await writeFile(file, "# Build\n\nRun bun test.\n");
    await ingestNativeMemory(knowledgeDir, opts({ includeHomeConfig: false, hostUser: "tester" }));
    expect(existsSync(join(knowledgeDir, PROJECT_ID, "native-mem-memory-build.md"))).toBe(true);

    await writeFile(file, note("project", "# Build\n\nRun bun test.\n"));
    const { results } = await ingestNativeMemory(
      knowledgeDir,
      opts({ includeHomeConfig: false, hostUser: "tester" })
    );
    const p = byId(results, PROJECT_ID);
    expect(p.ingested).toEqual(["native-mem-note-build"]);
    expect(p.removed).toEqual(["native-mem-memory-build"]);
  });
});

describe("ingestNativeMemory — write-back", () => {
  test("is OFF by default: never returns a write-back result and never touches CLAUDE.md", async () => {
    await seedHome();
    const before = await readFile(join(baseDir, ".claude", "CLAUDE.md"), "utf-8");

    const summary = await ingestNativeMemory(knowledgeDir, opts());

    expect(summary.writeBack).toBeUndefined();
    const after = await readFile(join(baseDir, ".claude", "CLAUDE.md"), "utf-8");
    expect(after).toBe(before);
    expect(after).not.toContain(KB_FACTS_BEGIN);
  });

  test("enabled without commit is a dry run: computes the block but writes nothing", async () => {
    await seedHome();
    const before = await readFile(join(baseDir, ".claude", "CLAUDE.md"), "utf-8");

    const summary = await ingestNativeMemory(
      knowledgeDir,
      opts({
        writeBack: { enabled: true, facts: [{ title: "DB path", body: "lives outside the source tree" }] },
      })
    );

    expect(summary.writeBack?.enabled).toBe(true);
    expect(summary.writeBack?.committed).toBe(false);
    expect(summary.writeBack?.factCount).toBe(1);
    expect(summary.writeBack?.block).toContain("DB path");
    // Dry run: the file is untouched.
    expect(await readFile(join(baseDir, ".claude", "CLAUDE.md"), "utf-8")).toBe(before);
  });

  test("enabled with commit splices a managed block in place, preserving user content and idempotent on re-run", async () => {
    await seedHome();

    const writeBack = { enabled: true, commit: true, facts: [{ title: "DB path", body: "outside the tree" }] };
    await ingestNativeMemory(knowledgeDir, opts({ writeBack }));

    const written = await readFile(join(baseDir, ".claude", "CLAUDE.md"), "utf-8");
    // User's own content survives; the managed block is appended once.
    expect(written).toContain("# Global notes");
    expect(written).toContain(KB_FACTS_BEGIN);
    expect(written).toContain(KB_FACTS_END);
    expect(written).toContain("DB path");

    // Re-run with the same block: still exactly one block (no duplication).
    await ingestNativeMemory(knowledgeDir, opts({ writeBack }));
    const again = await readFile(join(baseDir, ".claude", "CLAUDE.md"), "utf-8");
    expect(again.split(KB_FACTS_BEGIN).length - 1).toBe(1);
  });
});

describe("buildKbFactsBlock / encodeClaudeProjectDir", () => {
  test("encodeClaudeProjectDir matches Claude Code's dash-encoding", () => {
    expect(encodeClaudeProjectDir("/Volumes/work-disk/standup")).toBe(
      "-Volumes-work-disk-standup"
    );
    expect(encodeClaudeProjectDir("/Users/foo/my.project")).toBe("-Users-foo-my-project");
  });

  test("buildKbFactsBlock is delimited and lists the facts", () => {
    const block = buildKbFactsBlock([{ title: "A", body: "one" }, { title: "B", body: "two" }]);
    expect(block.startsWith(KB_FACTS_BEGIN)).toBe(true);
    expect(block.trimEnd().endsWith(KB_FACTS_END)).toBe(true);
    expect(block).toContain("**A** — one");
    expect(block).toContain("**B** — two");
  });

  /** Mirrors of the personal layer are redacted at the full tier, which these shapes exercise. */
  const FULL = { tier: "full" } as const;

  test("redactSecrets scrubs the high-signal secret shapes", () => {
    expect(redactSecrets("acct 123456789012 done", { accountIds: true })).toBe("acct [REDACTED] done");
    expect(redactSecrets("acct 123456789012 done")).toBe("acct 123456789012 done");
    expect(redactSecrets("key AKIAIOSFODNN7EXAMPLE end", FULL)).toBe("key [REDACTED] end");
    expect(redactSecrets("password = swordfish99", FULL)).toBe("password = [REDACTED]");
    // Ordinary prose is untouched.
    expect(redactSecrets("the collector is authoritative", FULL)).toBe("the collector is authoritative");
  });

  test("redactSecrets scrubs UPPER_SNAKE creds, bearer tokens and connection strings", () => {
    // UPPER_SNAKE_CASE credential env-vars whose credential word is a mid-name
    // segment the lowercase `\bkey\b` rule cannot see.
    const awsSecret = "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIbPxRfiCYEXAMPLEKEYVALUE";
    expect(redactSecrets(awsSecret, FULL)).toBe("AWS_SECRET_ACCESS_KEY=[REDACTED]");
    expect(redactSecrets("export FOO_TOKEN=abcdef123456GHIJKL7890", FULL)).toBe("export FOO_TOKEN=[REDACTED]");

    // Credentials embedded in a connection string — only the password segment is
    // scrubbed, the scheme/user/host stay legible.
    const conn = redactSecrets("db=postgres://admin:s3cr3tpass@db.example.com:5432/app", FULL);
    expect(conn).not.toContain("s3cr3tpass");
    expect(conn).toContain("postgres://admin:[REDACTED]@");

    // Inline bearer tokens.
    const bearer = redactSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.header.signature", FULL);
    expect(bearer).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(bearer).toBe("Authorization: Bearer [REDACTED]");

    // Ordinary prose containing the word "bearer" is untouched.
    expect(redactSecrets("the bearer of this note", FULL)).toBe("the bearer of this note");
  });

  test("redactSecrets scrubs the KEY family and every casing of underscore-joined creds", () => {
    // The KEY family — *_API_KEY / *_ACCESS_KEY / *_ACCESS_KEY_ID — whose name
    // carries no SECRET/TOKEN/PASSWORD word yet is the single most common
    // credential env-var shape.
    expect(redactSecrets("MY_API_KEY=k3yL1veA9bC8dE7fG6hI5jK4", FULL)).toBe("MY_API_KEY=[REDACTED]");
    expect(redactSecrets("GITHUB_API_KEY=ghp_abcdefghijklmnopqrstuvwxyz0123456789", FULL)).toBe("GITHUB_API_KEY=[REDACTED]");
    expect(redactSecrets("OPENAI_API_KEY=sk-abcdefghijklmnop0123", FULL)).toBe("OPENAI_API_KEY=[REDACTED]");
    expect(redactSecrets("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE", FULL)).toBe(
      "AWS_ACCESS_KEY_ID=[REDACTED]"
    );

    // The canonical ~/.aws/credentials lowercase form, and mixed casing — the
    // credential word is a mid-name underscore segment a `\b`-anchored rule can't
    // see, so a case-sensitive / boundary-based rule leaks it verbatim.
    expect(redactSecrets("aws_secret_access_key = wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY", FULL)).toBe(
      "aws_secret_access_key = [REDACTED]"
    );
    for (const name of [
      "db_password",
      "client_secret",
      "service_token",
      "api_secret",
      "my_password",
      "session_token",
      "Aws_Secret_Access_Key",
    ]) {
      const line = `${name}=someSecretValue123XyZ987`;
      expect(redactSecrets(line, FULL)).toBe(`${name}=[REDACTED]`);
      expect(redactSecrets(line, FULL)).not.toContain("someSecretValue123XyZ987");
    }

    // A non-credential assignment (no credential segment in the key) is left
    // intact — the rule redacts by key name, it does not blanket every `k=v`.
    expect(redactSecrets("log_level=verbose", FULL)).toBe("log_level=verbose");
  });

  test("redactSecrets scrubs a password-only connection-string userinfo", () => {
    // The standard redis/amqp `scheme://:password@host` form: the username is
    // empty, so a userinfo rule that demands a non-empty username bypasses it and
    // the password leaks (the REDIS_URL key carries no credential word either).
    const redis = redactSecrets("REDIS_URL=redis://:s3cr3tpassvalue@cache.internal:6379", FULL);
    expect(redis).not.toContain("s3cr3tpassvalue");
    expect(redis).toContain("redis://:[REDACTED]@");

    const amqp = redactSecrets("amqp://:brokerpassword@broker:5672", FULL);
    expect(amqp).not.toContain("brokerpassword");
    expect(amqp).toContain("amqp://:[REDACTED]@");
  });

  test("redactSecrets leaves ordinary prose with a bare credential word untouched", () => {
    // A bare single-word `key:`/`auth:`/`secret:`/`token:` in prose is NOT a
    // secret assignment — scrubbing it corrupts the mirrored docs. Only a
    // qualified key (multi-segment or ALL-CAPS env-var) names a credential.
    expect(redactSecrets("Primary key: session identifier", FULL)).toBe(
      "Primary key: session identifier"
    );
    expect(redactSecrets("auth: required for every request", FULL)).toBe(
      "auth: required for every request"
    );
    expect(redactSecrets("The secret: keep the surface small", FULL)).toBe(
      "The secret: keep the surface small"
    );
    expect(redactSecrets("token: the next lexical token", FULL)).toBe(
      "token: the next lexical token"
    );
    // A weak credential name with a generated-looking value IS redacted.
    expect(redactSecrets("api_key: k3yL1veA9bC8dE7fG6hI5jK4", FULL)).toBe("api_key: [REDACTED]");
    expect(redactSecrets("SECRET=k3yL1veA9bC8dE7fG6hI5jK4", FULL)).toBe("SECRET=[REDACTED]");
  });

  test("redactSecrets covers plural UPPER_SNAKE credential env-vars", () => {
    expect(redactSecrets("API_KEYS=k3yL1veA9bC8dE7fG6hI5jK4", FULL)).toBe("API_KEYS=[REDACTED]");
    expect(redactSecrets("AWS_SECRETS=wJalrXUtnFEMIbPx", FULL)).toBe("AWS_SECRETS=[REDACTED]");
    expect(redactSecrets("SERVICE_TOKENS=abcdef123456GHIJKL7890", FULL)).toBe("SERVICE_TOKENS=[REDACTED]");
  });

  test("redactSecrets scrubs the whole credential value up to the next setting, and quoted values entirely", () => {
    // An unquoted value ends at `;`/`,`/`&`, which separate the next setting in
    // a connection or query string; that setting stays legible.
    expect(redactSecrets("SQL_PASSWORD=abc;Server=prod;Trusted=no", FULL)).toBe(
      "SQL_PASSWORD=[REDACTED];Server=prod;Trusted=no"
    );
    expect(redactSecrets("API_TOKEN=a1B2c3D4e5F6g7H8i9J0k1,next", FULL)).toBe("API_TOKEN=[REDACTED],next");
    // Quoted value with spaces/delimiters — fully scrubbed inside the quotes.
    expect(redactSecrets('DB_PASSWORD="p@ss w0rd; and more"', FULL)).toBe('DB_PASSWORD="[REDACTED]"');
    expect(redactSecrets("client_secret = 'a b; c d'", FULL)).toBe("client_secret = '[REDACTED]'");
  });
});
