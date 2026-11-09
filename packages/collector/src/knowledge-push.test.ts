import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  attachSessionToLaunch,
  createLaunch,
  createStore,
  getPushUptake,
  recordRetrievals,
  setSetting,
  upsertProject,
} from "@standup/store";
import type { Store } from "@standup/store";
import { KnowledgeStore, PUSH_HEADERS, PUSH_MAX_CHARS, type KnowledgeDoc, type SearchResult } from "@standup/knowledge";
import { createServer } from "./server.js";
import { resetSessionProjectCaches } from "./session-project.js";
import { refreshProjectsCodeMentions } from "./knowledge-code-mentions.js";
import {
  aboutFilePushHits,
  createKnowledgePusher,
  KNOWLEDGE_PUSH_ENV,
  launchKnowledgePush,
  mergeHookContext,
  withinBudget,
  type PushSearch,
} from "./knowledge-push.js";

/**
 * Knowledge pushed through the hooks: the /hook route answers SessionStart,
 * UserPromptSubmit and a directory's first edit with additionalContext naming
 * the docs that clear the push bar, never a disputed doc, never a doc the
 * session already has, nothing when nothing clears the bar, and nothing at all
 * when the push is off. The pusher's own budget and dedup are driven with a
 * fake search.
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  resetSessionProjectCaches();
});

function doc(overrides: Partial<KnowledgeDoc>): KnowledgeDoc {
  return {
    id: crypto.randomUUID(),
    projectId: "alpha",
    slug: "doc",
    title: "Doc",
    body: "body",
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    filePath: "/x/doc.md",
    sourceKind: "code",
    originClass: "owner",
    scope: "project",
    ...overrides,
  };
}

interface Fixture {
  store: Store;
  app: ReturnType<typeof createServer>;
  knowledge: KnowledgeStore;
  repo: string;
}

function setUp(): Fixture {
  const repo = mkdtempSync(join(tmpdir(), "kb-push-"));
  const store = createStore(":memory:");
  cleanups.push(() => {
    store.close();
    rmSync(repo, { recursive: true, force: true });
  });
  upsertProject(store.db, { id: "alpha", name: "Alpha", branch: "main", repos: [repo] });
  const knowledge = new KnowledgeStore(store.db);
  knowledge.upsertDoc(
    doc({
      slug: "quota-guide",
      title: "Quota override guide",
      body: "How the daily quota override is configured and why CheckQuota answers 429 with Retry-After.",
    })
  );
  knowledge.upsertDoc(
    doc({
      slug: "routing-notes",
      title: "Routing notes",
      body: "The console router maps hash routes to pages; the try-it page is registered last.",
    })
  );
  knowledge.upsertDoc(
    doc({
      slug: "refuted-claim",
      title: "Refuted claim",
      body: "A claim the re-verification pass refuted.",
    })
  );
  store.db.run("UPDATE knowledge SET verdict = 'disputed' WHERE slug = 'refuted-claim'");
  return { store, app: createServer(store, () => {}, null), knowledge, repo };
}

type HookReply = { hookSpecificOutput?: { hookEventName: string; additionalContext: string } };

async function hook(f: Fixture, body: Record<string, unknown>): Promise<HookReply> {
  const res = await f.app.request("/hook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: "s1", cwd: f.repo, transcript_path: "/t.jsonl", ...body }),
  });
  return (await res.json()) as HookReply;
}

const prompt = (text: string) => ({ hook_event_name: "UserPromptSubmit", prompt: text });

function withEnv(name: string, value: string): void {
  const prior = process.env[name];
  process.env[name] = value;
  cleanups.push(() => {
    if (prior === undefined) delete process.env[name];
    else process.env[name] = prior;
  });
}

describe("/hook knowledge push", () => {
  test("UserPromptSubmit names a doc that clears the bar, once per session", async () => {
    const f = setUp();
    await hook(f, { hook_event_name: "SessionStart", source: "startup" });
    const reply = await hook(f, prompt("please update `quota-guide` before the release goes out"));
    const ctx = reply.hookSpecificOutput;
    expect(ctx?.hookEventName).toBe("UserPromptSubmit");
    expect(ctx?.additionalContext.split("\n")[0]).toBe(PUSH_HEADERS.UserPromptSubmit);
    expect(ctx?.additionalContext).toContain('(get_knowledge_doc slug "alpha/quota-guide")');
    expect(ctx!.additionalContext.length).toBeLessThanOrEqual(PUSH_MAX_CHARS.UserPromptSubmit);
    const rows = f.store.db
      .query("SELECT surface, session_id, doc_slug, injected FROM knowledge_retrievals WHERE surface LIKE 'push:%'")
      .all();
    expect(rows).toEqual([{ surface: "push:UserPromptSubmit", session_id: "s1", doc_slug: "quota-guide", injected: 1 }]);

    // The same doc is not pushed again, by this hook or another.
    expect((await hook(f, prompt("and check `quota-guide` once more for the release"))).hookSpecificOutput).toBeUndefined();
    const edit = await hook(f, {
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: join(f.repo, "docs", "quota-guide.md") },
    });
    expect(edit.hookSpecificOutput?.additionalContext ?? "").not.toContain("alpha/quota-guide");
  });

  test("a disputed doc is never pushed, even when named", async () => {
    const f = setUp();
    const reply = await hook(f, prompt("what does `refuted-claim` say about the release"));
    expect(reply.hookSpecificOutput?.additionalContext ?? "").not.toContain("refuted-claim");
  });

  test("nothing clears the bar → no additionalContext", async () => {
    const f = setUp();
    const reply = await hook(f, prompt("how should I name the new telemetry dashboard tiles"));
    expect(reply.hookSpecificOutput).toBeUndefined();
    expect((f.store.db.query("SELECT COUNT(*) AS n FROM knowledge_retrievals WHERE surface LIKE 'push:%'").get() as { n: number }).n).toBe(0);
  });

  test("trivial prompts push nothing", async () => {
    const f = setUp();
    for (const text of ["continue", "/compact", "`quota-guide`"]) {
      expect((await hook(f, prompt(text))).hookSpecificOutput).toBeUndefined();
    }
  });

  test("SessionStart of a launch pushes against its brief, minus the docs injected at launch", async () => {
    const f = setUp();
    createLaunch(f.store.db, {
      id: "L1",
      projectId: "alpha",
      task: "Rework `routing-notes` and `quota-guide` for the console",
      worktreePath: f.repo,
      branch: "standup/L1",
      harness: "claude",
    });
    attachSessionToLaunch(f.store.db, "L1", "s1");
    recordRetrievals(f.store.db, [
      { docProject: "alpha", docSlug: "quota-guide", query: "q", rank: 0, surface: "inject", injected: true, launchId: "L1" },
    ]);
    const reply = await hook(f, { hook_event_name: "SessionStart", source: "startup" });
    const ctx = reply.hookSpecificOutput;
    expect(ctx?.hookEventName).toBe("SessionStart");
    expect(ctx?.additionalContext).toContain('"alpha/routing-notes"');
    expect(ctx?.additionalContext).not.toContain("alpha/quota-guide");
    expect(ctx!.additionalContext.length).toBeLessThanOrEqual(PUSH_MAX_CHARS.SessionStart);
    const row = f.store.db
      .query("SELECT surface, launch_id FROM knowledge_retrievals WHERE surface = 'push:SessionStart'")
      .get();
    expect(row).toEqual({ surface: "push:SessionStart", launch_id: "L1" });
    // The opening prompt is the brief SessionStart already searched.
    expect((await hook(f, prompt("Rework `routing-notes` and `quota-guide` for the console\n\nmore steering"))).hookSpecificOutput).toBeUndefined();
  });

  test("PreToolUse pushes on the first edit in a directory only", async () => {
    const f = setUp();
    const editOf = (file: string) => ({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: join(f.repo, "src", file) },
    });
    // A Read never pushes; nothing names the path, so the first edit pushes nothing either.
    expect((await hook(f, { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: join(f.repo, "src", "a.ts") } })).hookSpecificOutput).toBeUndefined();
    expect((await hook(f, editOf("a.ts"))).hookSpecificOutput).toBeUndefined();
    // A doc named by the target's stem clears the bar, but the directory has had its push.
    f.knowledge.upsertDoc(doc({ slug: "b", title: "B", body: "b" }));
    expect((await hook(f, editOf("b.ts"))).hookSpecificOutput).toBeUndefined();
  });

  test("PreToolUse names the docs that name the edited file", async () => {
    const f = setUp();
    const file = "src/quota/override.ts";
    f.knowledge.replaceCodeSymbols("alpha", f.repo, "sha", [file], [{ file, line: 0, name: "override.ts", kind: "file" }]);
    f.knowledge.upsertDoc(doc({ slug: "override-gotcha", title: "Override gotcha", body: `\`${file}\` must clamp the quota before saving.` }));
    f.knowledge.upsertDoc(doc({ slug: "override-refuted", title: "Override refuted", body: `\`${file}\` never clamps.` }));
    f.store.db.run("UPDATE knowledge SET verdict = 'disputed' WHERE slug = 'override-refuted'");
    // The hook reads the mentions as the indexer pass left them; it never refreshes them itself.
    const aboutFile = aboutFilePushHits(f.knowledge, f.store.db);
    expect(aboutFile("alpha", join(f.repo, file))).toEqual([]);
    refreshProjectsCodeMentions(f.knowledge, ["alpha"]);
    expect(aboutFile("alpha", join(f.repo, file)).map((d) => d.slug)).toEqual(["override-gotcha"]);
    const reply = await hook(f, {
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: join(f.repo, file) },
    });
    expect(reply.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
    expect(reply.hookSpecificOutput?.additionalContext.split("\n")[0]).toBe(PUSH_HEADERS.PreToolUse);
    expect(reply.hookSpecificOutput?.additionalContext).toContain('"alpha/override-gotcha"');
    expect(reply.hookSpecificOutput?.additionalContext).not.toContain("override-refuted");
    expect(reply.hookSpecificOutput!.additionalContext.length).toBeLessThanOrEqual(PUSH_MAX_CHARS.PreToolUse);
  });

  test("STANDUP_KNOWLEDGE_PUSH=0 turns it off", async () => {
    withEnv(KNOWLEDGE_PUSH_ENV, "0");
    const f = setUp();
    expect((await hook(f, prompt("please update `quota-guide` before the release goes out"))).hookSpecificOutput).toBeUndefined();
  });

  test("a stored knowledge_first_enabled=0 is ignored", async () => {
    const f = setUp();
    setSetting(f.store.db, "knowledge_first_enabled", "0");
    const out = await hook(f, prompt("please update `quota-guide` before the release goes out"));
    expect(out.hookSpecificOutput?.additionalContext).toContain("alpha/quota-guide");
  });

  test("a later get_knowledge_doc of a pushed doc counts as uptake", async () => {
    const f = setUp();
    const since = Date.now() - 60_000;
    await hook(f, prompt("please update `quota-guide` before the release goes out"));
    recordRetrievals(f.store.db, [{ docProject: "alpha", docSlug: "quota-guide", query: "quota-guide", rank: 0, surface: "doc_get", sessionId: "s1" }]);
    expect(getPushUptake(f.store.db, since)).toEqual({
      pushed: 1,
      opened: 1,
      byEvent: { UserPromptSubmit: { pushed: 1, opened: 1 } },
    });
  });
});

function fakeHit(slug: string, relevance = 0.9): SearchResult {
  return {
    id: slug,
    projectId: "alpha",
    slug,
    title: `Title ${slug}`,
    excerpt: `About ${slug}.`,
    score: relevance,
    relevance,
    source: "text",
    originClass: "owner",
    sourceKind: "code",
    generated: false,
    scope: "project",
  };
}

function pusherFixture(search: PushSearch, budgetMs = 50) {
  const store = createStore(":memory:");
  cleanups.push(() => store.close());
  upsertProject(store.db, { id: "alpha", name: "Alpha", branch: "main", repos: ["/repo"] });
  store.db.run("INSERT INTO sessions (id, project_id, cwd) VALUES ('s1', 'alpha', '/repo')");
  return { store, pusher: createKnowledgePusher({ db: store.db, search, budgetMs, env: {} }) };
}

const promptPayload = (text: string) => ({ session_id: "s1", hook_event_name: "UserPromptSubmit", cwd: "/repo", prompt: text });

describe("createKnowledgePusher", () => {
  test("a search past the budget pushes nothing and records nothing", async () => {
    const slow: PushSearch = () => new Promise((resolve) => setTimeout(() => resolve([fakeHit("a")]), 200));
    const { store, pusher } = pusherFixture(slow, 20);
    const started = performance.now();
    expect(await pusher.forHook(promptPayload("how is the quota override configured today"))).toBeNull();
    expect(performance.now() - started).toBeLessThan(150);
    expect((store.db.query("SELECT COUNT(*) AS n FROM knowledge_retrievals").get() as { n: number }).n).toBe(0);
  });

  test("a failing search pushes nothing", async () => {
    const { pusher } = pusherFixture(() => Promise.reject(new Error("boom")));
    expect(await pusher.forHook(promptPayload("how is the quota override configured today"))).toBeNull();
  });

  test("caps, bar and dedup across hooks of one session", async () => {
    const { pusher } = pusherFixture(async () => [fakeHit("a"), fakeHit("b"), fakeHit("c"), fakeHit("weak", 0.3)]);
    const first = await pusher.forHook(promptPayload("how is the quota override configured today"));
    expect(first?.docs.map((d) => d.slug)).toEqual(["a", "b"]);
    const second = await pusher.forHook({ session_id: "s1", hook_event_name: "SessionStart", cwd: "/repo" });
    expect(second?.docs.map((d) => d.slug)).toEqual(["c"]);
    expect(await pusher.forHook(promptPayload("and how is the quota override configured tomorrow"))).toBeNull();
  });

  test("concurrent pushes for one session never push the same doc twice", async () => {
    const { pusher } = pusherFixture(async () => [fakeHit("a"), fakeHit("b")]);
    const [x, y] = await Promise.all([
      pusher.forHook(promptPayload("how is the quota override configured today")),
      pusher.forHook(promptPayload("how is the quota override configured today")),
    ]);
    const pushed = [...(x?.docs ?? []), ...(y?.docs ?? [])].map((d) => d.slug).sort();
    expect(pushed).toEqual(["a", "b"]);
  });

  test("the first edit pins the docs naming the file ahead of the search", async () => {
    const store = createStore(":memory:");
    cleanups.push(() => store.close());
    store.db.run("INSERT INTO projects (id, name, branch) VALUES ('alpha', 'Alpha', 'main')");
    const pusher = createKnowledgePusher({
      db: store.db,
      search: async () => [fakeHit("searched")],
      aboutFile: (_project, path) => (path === "/repo/src/a.ts" ? [fakeHit("names-the-file", 1)] : []),
      env: {},
    });
    const edit = (file: string) => ({
      session_id: "s1",
      hook_event_name: "PreToolUse",
      cwd: "/repo",
      tool_name: "apply_patch",
      tool_input: { input: `*** Begin Patch\n*** Update File: ${file}\n*** End Patch` },
    });
    expect((await pusher.forHook(edit("src/a.ts")))?.docs.map((d) => d.slug)).toEqual(["names-the-file", "searched"]);
    expect(await pusher.forHook(edit("src/other.ts"))).toBeNull();
  });

  const editIn = (file: string) => ({
    session_id: "s1",
    hook_event_name: "PreToolUse",
    cwd: "/repo",
    tool_name: "Edit",
    tool_input: { file_path: file },
  });

  test("the budget counts from the hook's arrival: a slow about-file lookup leaves the search less time", async () => {
    const store = createStore(":memory:");
    cleanups.push(() => store.close());
    store.db.run("INSERT INTO projects (id, name, branch) VALUES ('alpha', 'Alpha', 'main')");
    const budgetMs = 60;
    const pusher = createKnowledgePusher({
      db: store.db,
      // Answers inside the budget on its own, past it once the lookup has spent most of it.
      search: () => new Promise((resolve) => setTimeout(() => resolve([fakeHit("searched")]), 30)),
      aboutFile: () => {
        const until = performance.now() + 45;
        while (performance.now() < until) {
          // Spends the budget synchronously, as a slow mentions read would.
        }
        return [];
      },
      budgetMs,
      env: {},
    });
    const started = performance.now();
    expect(await pusher.forHook(editIn("/repo/src/a.ts"))).toBeNull();
    expect(performance.now() - started).toBeLessThan(budgetMs + 20);
  });

  test("a first-edit search past the budget leaves the directory open for a later edit", async () => {
    let slow = true;
    const search: PushSearch = () =>
      slow ? new Promise((resolve) => setTimeout(() => resolve([fakeHit("late")]), 200)) : Promise.resolve([fakeHit("fresh")]);
    const { pusher } = pusherFixture(search, 20);
    expect(await pusher.forHook(editIn("/repo/src/a.ts"))).toBeNull();
    slow = false;
    expect((await pusher.forHook(editIn("/repo/src/b.ts")))?.docs.map((d) => d.slug)).toEqual(["fresh"]);
    expect(await pusher.forHook(editIn("/repo/src/c.ts"))).toBeNull();
  });

  test("a first-edit search that answers below the bar claims the directory", async () => {
    let weak = true;
    const { pusher } = pusherFixture(async () => [weak ? fakeHit("weak", 0.1) : fakeHit("strong")]);
    expect(await pusher.forHook(editIn("/repo/src/a.ts"))).toBeNull();
    weak = false;
    expect(await pusher.forHook(editIn("/repo/src/b.ts"))).toBeNull();
  });

  test("events other than the three push nothing", async () => {
    const { pusher } = pusherFixture(async () => [fakeHit("a")]);
    for (const event of ["Stop", "PostToolUse", "SubagentStart", "SessionEnd"]) {
      expect(await pusher.forHook({ session_id: "s1", hook_event_name: event, cwd: "/repo" })).toBeNull();
    }
  });
});

describe("withinBudget", () => {
  test("resolves the value in time, null past the budget or on rejection", async () => {
    expect(await withinBudget(Promise.resolve(1), 50)).toBe(1);
    expect(await withinBudget(new Promise<number>((r) => setTimeout(() => r(1), 100)), 10)).toBeNull();
    expect(await withinBudget(Promise.reject(new Error("x")), 50)).toBeNull();
  });
});

describe("mergeHookContext", () => {
  const push = { event: "UserPromptSubmit" as const, text: "PUSH", docs: [] };
  test("appends to the same event's context, after what was there", () => {
    expect(
      mergeHookContext({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "STEER" } }, push)
    ).toEqual({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "STEER\n\nPUSH" } });
  });
  test("adds its own hookSpecificOutput to a bare reply", () => {
    expect(mergeHookContext(null, push)).toEqual({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "PUSH" } });
  });
  test("leaves another event's output and a null push alone", () => {
    const other = { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "x" } };
    expect(mergeHookContext(other, push)).toBe(other);
    expect(mergeHookContext(other, null)).toBe(other);
  });
});

describe("launchKnowledgePush", () => {
  test("pushes the brief's docs minus the injected ones, recorded against the launch", async () => {
    const store = createStore(":memory:");
    cleanups.push(() => store.close());
    store.db.run("INSERT INTO projects (id, name, branch) VALUES ('alpha', 'Alpha', 'main')");
    const text = await launchKnowledgePush(store.db, {
      projectId: "alpha",
      brief: "Add the daily quota override",
      launchId: "L9",
      injected: [{ projectId: "alpha", slug: "a" }],
      search: async () => [fakeHit("a"), fakeHit("b")],
      env: {},
    });
    expect(text.split("\n")[0]).toBe(PUSH_HEADERS.SessionStart);
    expect(text).toContain('"alpha/b"');
    expect(text).not.toContain('"alpha/a"');
    expect(store.db.query("SELECT surface, launch_id, doc_slug FROM knowledge_retrievals").all()).toEqual([
      { surface: "push:launch", launch_id: "L9", doc_slug: "b" },
    ]);
  });

  test("off by env → empty", async () => {
    const store = createStore(":memory:");
    cleanups.push(() => store.close());
    const text = await launchKnowledgePush(store.db, {
      projectId: "alpha",
      brief: "Add the daily quota override",
      launchId: "L9",
      injected: [],
      search: async () => [fakeHit("b")],
      env: { [KNOWLEDGE_PUSH_ENV]: "0" },
    });
    expect(text).toBe("");
  });
});
