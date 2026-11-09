import { expect, test, describe, spyOn, afterEach, setSystemTime } from "bun:test";
import { DEFAULT_IDENTITY_HEADER } from "@standup/shared";
import { mkdtemp, mkdir, readdir, writeFile, rename, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { KnowledgeLoader, KnowledgeStore, searchKnowledge } from "@standup/knowledge";
import { createStore, upsertProject, type Store } from "@standup/store";
import { USER_CHANNEL_HEADER, userChannelToken } from "@standup/shared/owner-token";
import { KNOWLEDGE_FULL_SYNC_INTERVAL_MS, KNOWLEDGE_WATCH_COALESCE_MS, KnowledgeSync } from "./knowledge-sync.js";
import { activeOwnerSecrets } from "./owner-secret.js";
import { createServer } from "./server.js";

/**
 * syncDirty re-reads only the projects the knowledge-directory watcher saw
 * change, so a search over an unchanged corpus reads no file, while every
 * change is still visible to the next search.
 */

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  setSystemTime();
  while (cleanup.length > 0) await cleanup.pop()!();
});

interface Harness {
  store: Store;
  dir: string;
  sync: KnowledgeSync;
  docs: KnowledgeStore;
  /** loadProject calls since the last call to this, by project. */
  reads: () => string[];
}

async function harness(projects: Record<string, Record<string, string>>): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "standup-kb-dirty-"));
  const store = createStore(":memory:");
  for (const [projectId, files] of Object.entries(projects)) {
    upsertProject(store.db, { id: projectId, name: projectId, branch: "main", repos: [] });
    await mkdir(join(dir, projectId), { recursive: true });
    for (const [slug, body] of Object.entries(files)) await writeDoc(dir, projectId, slug, body);
  }
  const sync = new KnowledgeSync(store.db, dir, null);
  const spy = spyOn(KnowledgeLoader.prototype, "loadProject");
  let seen = 0;
  cleanup.push(async () => {
    sync.stopWatching();
    spy.mockRestore();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    store,
    dir,
    sync,
    docs: new KnowledgeStore(store.db),
    reads: () => {
      const calls = spy.mock.calls.slice(seen).map((args) => args[0] as string);
      seen = spy.mock.calls.length;
      return calls.sort();
    },
  };
}

function writeDoc(dir: string, projectId: string, slug: string, body: string): Promise<void> {
  return writeFile(join(dir, projectId, `${slug}.md`), `---\ntitle: ${slug}\n---\n${body}`);
}

const bodyOf = (h: Harness, projectId: string, slug: string) => h.docs.getDoc(projectId, slug)?.body ?? null;

describe("KnowledgeSync.syncDirty", () => {
  test("without a watcher every call re-reads every known project, as syncAll does", async () => {
    const h = await harness({ alpha: { a: "alpha body" }, beta: { b: "beta body" } });
    await h.sync.syncDirty();
    expect(h.reads()).toEqual(["alpha", "beta", "scratch"]);
    await h.sync.syncDirty();
    expect(h.reads()).toEqual(["alpha", "beta", "scratch"]);
    await h.sync.syncDirty(["alpha"]);
    expect(h.reads()).toEqual(["alpha"]);
  });

  test("with the watcher, the first call is a full sync and an unchanged corpus is then never re-read", async () => {
    const h = await harness({ alpha: { a: "alpha body" }, beta: { b: "beta body" } });
    await h.sync.startWatching();
    await h.sync.syncDirty();
    expect(h.reads()).toEqual(["alpha", "beta", "scratch"]);
    for (let i = 0; i < 5; i++) await h.sync.syncDirty();
    await h.sync.syncDirty(["alpha", "beta"]);
    expect(h.reads()).toEqual([]);
    expect(bodyOf(h, "alpha", "a")).toBe("alpha body");
  });

  // Each row is one way a doc changes on disk; the change must show on the very
  // next call, which re-reads only the project it touched.
  const edits: Array<[name: string, project: string, slug: string, apply: (dir: string) => Promise<void>, body: string | null]> = [
    ["in-place rewrite", "alpha", "a", (dir) => writeDoc(dir, "alpha", "a", "alpha rewritten"), "alpha rewritten"],
    [
      "editor save via temp file + rename",
      "alpha",
      "a",
      async (dir) => {
        await writeFile(join(dir, "alpha", ".a.md.swp"), "---\ntitle: a\n---\nalpha renamed in");
        await rename(join(dir, "alpha", ".a.md.swp"), join(dir, "alpha", "a.md"));
      },
      "alpha renamed in",
    ],
    ["new doc", "beta", "fresh", (dir) => writeDoc(dir, "beta", "fresh", "a brand new doc"), "a brand new doc"],
    ["deleted doc", "beta", "b", (dir) => rm(join(dir, "beta", "b.md")), null],
  ];
  test.each(edits)("%s is visible on the next call", async (_name, project, slug, apply, body) => {
    const h = await harness({ alpha: { a: "alpha body" }, beta: { b: "beta body" } });
    await h.sync.startWatching();
    await h.sync.syncDirty();
    h.reads();
    await apply(h.dir);
    await h.sync.syncDirty();
    expect(bodyOf(h, project, slug)).toBe(body);
    expect(h.reads()).toEqual([project]);
  });

  test("an edit right before each of many calls is never missed", async () => {
    const h = await harness({ alpha: { a: "v0" } });
    await h.sync.startWatching();
    await h.sync.syncDirty();
    for (let i = 1; i <= 25; i++) {
      await writeDoc(h.dir, "alpha", "a", `v${i}`);
      await h.sync.syncDirty();
      expect(bodyOf(h, "alpha", "a")).toBe(`v${i}`);
    }
  });

  test("concurrent calls both return with the change synced", async () => {
    const h = await harness({ alpha: { a: "v0" } });
    await h.sync.startWatching();
    await h.sync.syncDirty();
    await writeDoc(h.dir, "alpha", "a", "v1");
    const first = h.sync.syncDirty();
    const second = h.sync.syncDirty();
    await second;
    expect(bodyOf(h, "alpha", "a")).toBe("v1");
    await first;
  });

  test("a project directory created after the watcher started is picked up, and so are later edits in it", async () => {
    const h = await harness({ alpha: { a: "alpha body" } });
    await h.sync.startWatching();
    await h.sync.syncDirty();
    h.reads();

    upsertProject(h.store.db, { id: "gamma", name: "gamma", branch: "main", repos: [] });
    await mkdir(join(h.dir, "gamma"));
    await writeDoc(h.dir, "gamma", "g", "gamma first");
    await h.sync.syncDirty();
    expect(bodyOf(h, "gamma", "g")).toBe("gamma first");

    await writeDoc(h.dir, "gamma", "g", "gamma edited");
    await h.sync.syncDirty();
    expect(bodyOf(h, "gamma", "g")).toBe("gamma edited");
    expect(h.reads()).toEqual(["gamma", "gamma"]);
  });

  test("a project registered after the last full sync is synced though no file event named it", async () => {
    const h = await harness({ alpha: { a: "alpha body" } });
    await mkdir(join(h.dir, "late"));
    await writeDoc(h.dir, "late", "l", "late body");
    await h.sync.startWatching();
    await h.sync.syncDirty();
    expect(bodyOf(h, "late", "l")).toBeNull();
    h.reads();

    upsertProject(h.store.db, { id: "late", name: "late", branch: "main", repos: [] });
    await h.sync.syncDirty();
    expect(bodyOf(h, "late", "l")).toBe("late body");
    expect(h.reads()).toEqual(["late"]);
    await h.sync.syncDirty();
    expect(h.reads()).toEqual([]);
  });

  test("a file in an unregistered project directory is never indexed", async () => {
    const h = await harness({ alpha: { a: "alpha body" } });
    await h.sync.startWatching();
    await h.sync.syncDirty();
    await mkdir(join(h.dir, "stranger"));
    await writeDoc(h.dir, "stranger", "s", "not a project");
    await h.sync.syncDirty();
    expect(bodyOf(h, "stranger", "s")).toBeNull();
  });

  test("a draft change re-reads nothing", async () => {
    const h = await harness({ alpha: { a: "alpha body" } });
    await mkdir(join(h.dir, "alpha", ".drafts"));
    await h.sync.startWatching();
    await h.sync.syncDirty();
    h.reads();
    await writeFile(join(h.dir, "alpha", ".drafts", "pending.md"), "---\ntitle: p\n---\ndraft");
    await h.sync.syncDirty();
    expect(h.reads()).toEqual([]);
  });

  test("a scoped call leaves dirty projects outside its scope for a later call", async () => {
    const h = await harness({ alpha: { a: "v0" }, beta: { b: "v0" } });
    await h.sync.startWatching();
    await h.sync.syncDirty();
    h.reads();
    await writeDoc(h.dir, "alpha", "a", "v1");
    await writeDoc(h.dir, "beta", "b", "v1");
    await h.sync.syncDirty(["alpha"]);
    expect(h.reads()).toEqual(["alpha"]);
    expect(bodyOf(h, "beta", "b")).toBe("v0");
    await h.sync.syncDirty();
    expect(h.reads()).toEqual(["beta"]);
    expect(bodyOf(h, "beta", "b")).toBe("v1");
  });

  test("past KNOWLEDGE_FULL_SYNC_INTERVAL_MS a call re-reads everything once", async () => {
    const h = await harness({ alpha: { a: "alpha body" }, beta: { b: "beta body" } });
    await h.sync.startWatching();
    await h.sync.syncDirty();
    h.reads();
    setSystemTime(new Date(Date.now() + KNOWLEDGE_FULL_SYNC_INTERVAL_MS + 1));
    await h.sync.syncDirty();
    expect(h.reads()).toEqual(["alpha", "beta", "scratch"]);
    await h.sync.syncDirty();
    expect(h.reads()).toEqual([]);
  });

  test("a watcher that cannot start leaves every call re-reading", async () => {
    const h = await harness({ alpha: { a: "alpha body" } });
    const start = spyOn(KnowledgeLoader.prototype, "startWatching").mockImplementation(async (_onChange, onError) =>
      onError(new Error("no watcher"))
    );
    const error = spyOn(console, "error").mockImplementation(() => {});
    cleanup.push(() => {
      start.mockRestore();
      error.mockRestore();
    });
    await h.sync.startWatching();
    expect(error).toHaveBeenCalled();
    await h.sync.syncDirty();
    await h.sync.syncDirty();
    expect(h.reads()).toEqual(["alpha", "alpha", "scratch", "scratch"]);
  });

  test("a fence the watcher never reports makes that call re-read everything", async () => {
    const h = await harness({ alpha: { a: "alpha body" } });
    await h.sync.startWatching();
    await h.sync.syncDirty();
    h.reads();
    const fence = spyOn(KnowledgeLoader.prototype, "flushWatchEvents").mockResolvedValue(false);
    cleanup.push(() => fence.mockRestore());
    await h.sync.syncDirty();
    expect(h.reads()).toEqual(["alpha", "scratch"]);
  });

  test("fence files never reach the index or mark a project dirty", async () => {
    const h = await harness({ alpha: { a: "alpha body" } });
    await h.sync.startWatching();
    await h.sync.syncDirty();
    h.reads();
    for (let i = 0; i < 3; i++) await h.sync.syncDirty();
    expect(h.reads()).toEqual([]);
    expect((await readdir(h.dir)).sort()).toEqual(["alpha"]);
  });

  test(
    "the coalesced background flush syncs a change without any request",
    async () => {
      const h = await harness({ alpha: { a: "v0" } });
      const changed: string[] = [];
      await h.sync.startWatching((projectId) => changed.push(projectId));
      await h.sync.syncDirty();
      await writeDoc(h.dir, "alpha", "a", "v1");
      await writeDoc(h.dir, "alpha", "a", "v2");
      await Bun.sleep(KNOWLEDGE_WATCH_COALESCE_MS + 500);
      expect(bodyOf(h, "alpha", "a")).toBe("v2");
      expect(changed).toEqual(["alpha"]);
    },
    KNOWLEDGE_WATCH_COALESCE_MS + 5_000
  );
});

describe("POST /api/knowledge/search", () => {
  const signedIn = (alias: string): Record<string, string> => ({
    [DEFAULT_IDENTITY_HEADER]: alias,
    [USER_CHANNEL_HEADER]: userChannelToken(activeOwnerSecrets().ownerToken, alias),
  });

  test("an unchanged corpus is not re-read, an edit is, and each row records the request's latency", async () => {
    const h = await harness({
      widgets: { pipeline: "The widget pipeline flushes batches through the collector on a timer." },
    });
    await h.sync.startWatching();
    const app = createServer(h.store, () => {}, null, h.sync, undefined, h.dir);
    const search = async (query: string) => {
      const res = await app.request("/api/knowledge/search", {
        method: "POST",
        headers: { "content-type": "application/json", ...signedIn("carol") },
        body: JSON.stringify({ cwd: "/tmp/none", query, project: "widgets" }),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as { results: Array<{ slug: string; excerpt?: string }> };
    };

    await search("widget pipeline batches");
    h.reads();
    expect((await search("widget pipeline batches")).results.map((r) => r.slug)).toContain("pipeline");
    expect(h.reads()).toEqual([]);

    await writeDoc(h.dir, "widgets", "pipeline", "The widget pipeline now drains through the sprocket queue.");
    await search("sprocket queue");
    expect(h.reads()).toEqual(["widgets"]);
    expect(bodyOf(h, "widgets", "pipeline")).toContain("sprocket");

    const latencies = (
      h.store.db.query("SELECT latency_ms AS l FROM knowledge_retrievals WHERE surface = 'search'").all() as Array<{
        l: number | null;
      }>
    ).map((r) => r.l);
    expect(latencies.length).toBeGreaterThan(0);
    for (const l of latencies) {
      expect(typeof l).toBe("number");
      expect(l!).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("search latency over a fixture corpus", () => {
  test("syncDirty + search is faster than syncAll + search on an unchanged corpus", async () => {
    const projects: Record<string, Record<string, string>> = {};
    for (const p of ["p1", "p2", "p3"]) {
      projects[p] = {};
      for (let i = 0; i < 100; i++) {
        projects[p][`doc-${i}`] =
          `Doc ${i} of ${p} covers the widget pipeline, retry backoff number ${i}, and deploy step ${i % 7}.\n`.repeat(8);
      }
    }
    const h = await harness(projects);
    await h.sync.syncAll();
    const search = () => searchKnowledge(h.store.db, "p1", "widget pipeline retry backoff", null, { limit: 5 });
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const time = async (fn: () => Promise<unknown>) => {
      const samples: number[] = [];
      for (let i = 0; i < 15; i++) {
        const t0 = performance.now();
        await fn();
        samples.push(performance.now() - t0);
      }
      return median(samples);
    };

    const before = await time(async () => {
      await h.sync.syncAll();
      await search();
    });
    await h.sync.startWatching();
    await h.sync.syncDirty();
    h.reads();
    const after = await time(async () => {
      await h.sync.syncDirty();
      await search();
    });
    expect(h.reads()).toEqual([]);
    console.log(
      `[latency] 300-doc corpus, median of 15: syncAll+search ${before.toFixed(1)} ms, syncDirty+search ${after.toFixed(1)} ms`
    );
    expect(after).toBeLessThan(before);
  });
});
