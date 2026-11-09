import { describe, expect, test } from "bun:test";
import {
  createStore,
  upsertProject,
  createSession,
  getSession,
  createLaunch,
} from "@standup/store";
import { capTitle } from "@standup/shared";
import {
  maybeSummarizeTitle,
  isTitleSummaryEnabled,
  setTitleSummaryEnabled,
  clearTitleSummaryState,
} from "./auto-checkpoint.js";
import { createServer } from "./server.js";

/**
 * Title summarization: a session's title lands readable (a capped raw
 * task/prompt) immediately, then upgrades to a succinct Haiku one off the hook's
 * critical path — for launched sessions as much as monitored ones. It is
 * decoupled from auto-checkpoint (its own default-on flag) and falls back to the
 * capped title when off or when the model call fails. The Haiku call is injected
 * here so nothing spawns a real `claude`.
 */

// A wall-of-text task/prompt whose capped title is therefore truncated (…) — the
// signal that it is worth a model call.
const HUGE = "Investigate and fix ".repeat(20).trim();

function setup(): ReturnType<typeof createStore> {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  return store;
}

function seedSession(store: ReturnType<typeof createStore>, id: string, title: string): void {
  createSession(store.db, { id, projectId: "p", title, cwd: `/w/${id}`, status: "running" });
}

describe("maybeSummarizeTitle", () => {
  test("is on by default (decoupled from auto-checkpoint)", () => {
    const store = setup();
    expect(isTitleSummaryEnabled(store.db)).toBe(true);
    store.close();
  });

  test("upgrades a launched session's capped wall-of-text title to a short Haiku title", async () => {
    const store = setup();
    seedSession(store, "launched", capTitle(HUGE));
    let nudged = "";
    const out = await maybeSummarizeTitle(store.db, "launched", HUGE, {
      generate: async () => "Fix flaky retry backoff",
      onUpgraded: (id) => {
        nudged = id;
      },
    });
    expect(out).toBe("Fix flaky retry backoff");
    expect(getSession(store.db, "launched")!.title).toBe("Fix flaky retry backoff");
    expect(nudged).toBe("launched");
    store.close();
  });

  test("upgrades a monitored session's capped first-prompt title", async () => {
    const store = setup();
    seedSession(store, "monitored", capTitle(HUGE));
    const out = await maybeSummarizeTitle(store.db, "monitored", HUGE, {
      generate: async () => "Wire the auth flow",
    });
    expect(out).toBe("Wire the auth flow");
    expect(getSession(store.db, "monitored")!.title).toBe("Wire the auth flow");
    store.close();
  });

  test("is a no-op falling back to the capped title when disabled — no model call", async () => {
    const store = setup();
    setTitleSummaryEnabled(store.db, false);
    const capped = capTitle(HUGE);
    seedSession(store, "off", capped);
    let called = false;
    const out = await maybeSummarizeTitle(store.db, "off", HUGE, {
      generate: async () => {
        called = true;
        return "should not run";
      },
    });
    expect(out).toBeNull();
    expect(called).toBe(false);
    expect(getSession(store.db, "off")!.title).toBe(capped);
    store.close();
  });

  test("is a no-op falling back to the capped title when the model call throws/times out", async () => {
    const store = setup();
    const capped = capTitle(HUGE);
    seedSession(store, "boom", capped);
    const out = await maybeSummarizeTitle(store.db, "boom", HUGE, {
      generate: async () => {
        throw new Error("timed out");
      },
    });
    expect(out).toBeNull();
    expect(getSession(store.db, "boom")!.title).toBe(capped);
    store.close();
  });

  test("skips a title that already fits — a short label / prompt is a fine title (no model call)", async () => {
    const store = setup();
    seedSession(store, "labeled", "Nightly KB build");
    let called = false;
    const out = await maybeSummarizeTitle(store.db, "labeled", "Nightly KB build", {
      generate: async () => {
        called = true;
        return "x";
      },
    });
    expect(out).toBeNull();
    expect(called).toBe(false);
    expect(getSession(store.db, "labeled")!.title).toBe("Nightly KB build");
    store.close();
  });

  test("fires at most once per session (no retry after a fallback) until state is cleared", async () => {
    const store = setup();
    const capped = capTitle(HUGE);
    seedSession(store, "once", capped);
    let calls = 0;
    const gen = async (): Promise<string | null> => {
      calls++;
      return null; // fallback: title stays capped and still ends with "…"
    };

    expect(await maybeSummarizeTitle(store.db, "once", HUGE, { generate: gen })).toBeNull();
    expect(getSession(store.db, "once")!.title).toBe(capped);
    // A later prompt would call again, but the once-per-session marker blocks it.
    expect(await maybeSummarizeTitle(store.db, "once", HUGE, { generate: gen })).toBeNull();
    expect(calls).toBe(1);

    // Clearing the marker (as /clear and SessionEnd do) re-enables summarization.
    clearTitleSummaryState("once");
    await maybeSummarizeTitle(store.db, "once", HUGE, { generate: gen });
    expect(calls).toBe(2);
    store.close();
  });
});

describe("launched session title is stored capped (ensureSession)", () => {
  test("a huge launch task becomes a bounded, ellipsized title on the first hook", async () => {
    const store = setup();
    const cwd = `/tmp/launch-title-${Math.random().toString(36).slice(2, 10)}`;
    createLaunch(store.db, {
      id: "L1",
      projectId: "p",
      task: HUGE,
      worktreePath: cwd,
      branch: "feat/x",
    });
    const app = createServer(store, () => {}, null);

    // SessionStart only: ensureSession stamps the capped launch task as the
    // title. No UserPromptSubmit, so the (real) async summarizer never runs.
    await app.request("/hook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "launched-1",
        cwd,
        transcript_path: `${cwd}/transcript.jsonl`,
        hook_event_name: "SessionStart",
        source: "startup",
      }),
    });

    const title = getSession(store.db, "launched-1")!.title;
    expect(title.length).toBeLessThanOrEqual(70);
    expect(title.endsWith("…")).toBe(true);
    store.close();
  });
});
