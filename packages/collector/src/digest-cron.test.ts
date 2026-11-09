import { expect, test, describe } from "bun:test";
import {
  createStore,
  upsertProject,
  createSession,
  createTaskRun,
  updateTaskRunStatus,
  createCheckpoint,
  createLaunch,
  createKnowledgeChange,
  createAsk,
  resolveAsk,
  createDigest,
  createPersonaApproval,
  getRecentDigests,
  getSetting,
  setSetting,
  type Store,
} from "@standup/store";
import type { Digest, KnowledgeChange, Project, WsMessage } from "@standup/shared";
import {
  isDigestEnabled,
  localParts,
  gatherDigest,
  renderDigest,
  renderKnowledgeUsage,
  summarizeDigest,
  makeDigestEmitter,
  tick,
  DIGEST_LAST_RUN_KEY,
  type DigestData,
} from "./digest-cron.js";

// ── fixtures ────────────────────────────────────────────────────────────────

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "web",
    name: "web",
    branch: "main",
    repos: ["/repos/web"],
    ...overrides,
  } as Project;
}

function knowledgeChange(overrides: Partial<KnowledgeChange> = {}): KnowledgeChange {
  return {
    id: `kc:${Math.random()}`,
    projectId: "web",
    slug: "doc",
    kind: "accepted",
    title: "A doc",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Common cron options: a fixed model text and no real broadcast/spawn. */
function opts(over: Partial<Parameters<typeof tick>[1]> = {}): Parameters<typeof tick>[1] {
  return {
    broadcast: () => {},
    tz: "America/New_York",
    digestHour: 9,
    generate: async () => "MODEL SUMMARY",
    ...over,
  };
}

// ── isDigestEnabled ────────────────────────────────────────────────────────

describe("isDigestEnabled — DEFAULT ON, env/setting opt-out", () => {
  test("defaults ON with neither env nor setting", () => {
    expect(isDigestEnabled(undefined, null)).toBe(true);
  });

  test("explicit falsy env hard-disables even when the setting is on", () => {
    expect(isDigestEnabled("0", "true")).toBe(false);
    expect(isDigestEnabled("off", "on")).toBe(false);
  });

  test("truthy env enables", () => {
    expect(isDigestEnabled("1", null)).toBe(true);
  });

  test("falsy setting disables when the env flag is unset", () => {
    expect(isDigestEnabled(undefined, "false")).toBe(false);
    expect(isDigestEnabled(undefined, "off")).toBe(false);
  });

  test("truthy setting keeps it on (same as default)", () => {
    expect(isDigestEnabled(undefined, "true")).toBe(true);
  });
});

// ── localParts — TZ math ─────────────────────────────────────────────────────

describe("localParts — TZ-aware date/hour", () => {
  test("a UTC instant resolves to the correct America/New_York local date + hour", () => {
    // 2026-01-15T02:30Z is 2026-01-14 21:30 EST (UTC-5) — a DIFFERENT local date.
    const { date, hour } = localParts(new Date("2026-01-15T02:30:00Z"), "America/New_York");
    expect(date).toBe("2026-01-14");
    expect(hour).toBe(21);
  });

  test("9am EST resolves to hour 9 on the same local date", () => {
    // 2026-01-15T14:30Z is 09:30 EST.
    const { date, hour } = localParts(new Date("2026-01-15T14:30:00Z"), "America/New_York");
    expect(date).toBe("2026-01-15");
    expect(hour).toBe(9);
  });

  test("UTC tz reads the raw UTC parts", () => {
    const { date, hour } = localParts(new Date("2026-01-15T08:00:00Z"), "UTC");
    expect(date).toBe("2026-01-15");
    expect(hour).toBe(8);
  });
});

// ── the cron gate ────────────────────────────────────────────────────────────

describe("tick — anacron gate + 9am floor", () => {
  test("before 9am local → no-op (no digest, no stamp)", async () => {
    const store = createStore(":memory:");
    const posted: Digest[] = [];
    // 2026-01-15T13:30Z is 08:30 EST — below the 9am floor.
    await tick(store.db, opts({ now: () => new Date("2026-01-15T13:30:00Z"), emit: (d) => posted.push(d) }));
    expect(posted).toHaveLength(0);
    expect(getSetting(store.db, DIGEST_LAST_RUN_KEY)).toBeNull();
    store.close();
  });

  test("at/after 9am and not yet done today → posts once and stamps the date", async () => {
    const store = createStore(":memory:");
    const posted: Digest[] = [];
    // 09:30 EST.
    await tick(store.db, opts({ now: () => new Date("2026-01-15T14:30:00Z"), emit: (d) => posted.push(d) }));
    expect(posted).toHaveLength(1);
    expect(getSetting(store.db, DIGEST_LAST_RUN_KEY)).toBe("2026-01-15");
    store.close();
  });

  test("already done today → no-op", async () => {
    const store = createStore(":memory:");
    setSetting(store.db, DIGEST_LAST_RUN_KEY, "2026-01-15");
    const posted: Digest[] = [];
    await tick(store.db, opts({ now: () => new Date("2026-01-15T14:30:00Z"), emit: (d) => posted.push(d) }));
    expect(posted).toHaveLength(0);
    store.close();
  });

  test("a missed 9am (process down) runs on the first poll after it returns (catch-up)", async () => {
    const store = createStore(":memory:");
    // Last ran yesterday; the process was down at 9am and returns at 11am EST.
    setSetting(store.db, DIGEST_LAST_RUN_KEY, "2026-01-14");
    const posted: Digest[] = [];
    // 2026-01-15T16:00Z is 11:00 EST.
    await tick(store.db, opts({ now: () => new Date("2026-01-15T16:00:00Z"), emit: (d) => posted.push(d) }));
    expect(posted).toHaveLength(1);
    expect(getSetting(store.db, DIGEST_LAST_RUN_KEY)).toBe("2026-01-15");
    store.close();
  });

  test("stamps the date even when delivery throws, so it doesn't re-fire all day", async () => {
    const store = createStore(":memory:");
    await tick(
      store.db,
      opts({
        now: () => new Date("2026-01-15T14:30:00Z"),
        emit: () => {
          throw new Error("boom");
        },
      })
    );
    // No throw escaped, and the day is stamped.
    expect(getSetting(store.db, DIGEST_LAST_RUN_KEY)).toBe("2026-01-15");
    store.close();
  });
});

// ── gather + windowing ───────────────────────────────────────────────────────

describe("gatherDigest — windowing", () => {
  test("keeps only last-24h items and buckets them per project", () => {
    const store = createStore(":memory:");
    upsertProject(store.db, project());
    const now = new Date("2026-02-01T12:00:00Z");

    // In-window knowledge change (1h ago) and out-of-window one (48h ago).
    createKnowledgeChange(
      store.db,
      knowledgeChange({ id: "recent", title: "Recent", createdAt: new Date(now.getTime() - 3_600_000).toISOString() })
    );
    createKnowledgeChange(
      store.db,
      knowledgeChange({ id: "old", title: "Old", createdAt: new Date(now.getTime() - 48 * 3_600_000).toISOString() })
    );

    const data = gatherDigest(store.db, { now });
    expect(data.empty).toBe(false);
    const section = data.sections.find((s) => s.projectId === "web");
    expect(section).toBeDefined();
    expect(section!.knowledgeChanges.map((k) => k.id)).toEqual(["recent"]);
    expect(data.counts.knowledgeChanges).toBe(1);
    expect(data.counts.projects).toBe(1);
    store.close();
  });

  test("no personal-layer change reaches the shared digest, flagged or legacy", () => {
    const store = createStore(":memory:");
    upsertProject(store.db, project());
    const now = new Date();
    const recent = new Date(now.getTime() - 3_600_000).toISOString();
    // Alice's scope=user doc in the knowledge index, with a change recorded
    // before changes carried the personal flag.
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS knowledge (id TEXT PRIMARY KEY, project_id TEXT, slug TEXT, scope TEXT, source_kind TEXT, owner_user TEXT)"
    );
    store.db.run(
      "INSERT INTO knowledge (id, project_id, slug, scope, source_kind, owner_user) VALUES ('a', 'web', 'alice-legal', 'user', 'decision', 'alice')"
    );
    store.db.run(
      `INSERT INTO knowledge_changes (id, project_id, slug, kind, title, created_at, personal)
       VALUES ('legacy', 'web', 'alice-legal', 'accepted', 'Alice divorce lawyer notes', ?, NULL)`,
      [recent]
    );
    createKnowledgeChange(
      store.db,
      knowledgeChange({ id: "flagged", title: "Host private CLAUDE.md", createdAt: recent, personal: true, ownerUser: "host" })
    );
    createKnowledgeChange(store.db, knowledgeChange({ id: "team", title: "Team doc", createdAt: recent }));

    const data = gatherDigest(store.db, { now });
    const titles = data.sections.flatMap((s) => s.knowledgeChanges.map((k) => k.title));
    expect(titles).toEqual(["Team doc"]);
    expect(renderDigest(data)).not.toContain("divorce");
    store.close();
  });

  test("finished task runs inside the window are gathered; unfinished ones are not", () => {
    const store = createStore(":memory:");
    upsertProject(store.db, project());
    createTaskRun(store.db, { id: "r1", projectId: "web", worktreePath: "/repos/web" });
    updateTaskRunStatus(store.db, "r1", "running");
    updateTaskRunStatus(store.db, "r1", "succeeded", { summary: "shipped it" });
    // A still-running run has no ended_at, so it is not "finished in the window".
    createTaskRun(store.db, { id: "r2", projectId: "web", worktreePath: "/repos/web2" });
    updateTaskRunStatus(store.db, "r2", "running");

    const data = gatherDigest(store.db, { now: new Date() });
    const section = data.sections.find((s) => s.projectId === "web")!;
    expect(section.taskRuns.map((r) => r.id)).toEqual(["r1"]);
    expect(data.counts.taskRuns).toBe(1);
    store.close();
  });

  test("non-routine checkpoints and resolved asks are bucketed by their session's project", () => {
    const store = createStore(":memory:");
    upsertProject(store.db, project());
    createSession(store.db, { id: "s1", projectId: "web", title: "T", cwd: "/repos/web", status: "running" });
    // A structural (routine) checkpoint is dropped; a self-reported one is kept.
    createCheckpoint(store.db, "s1", "structural", "routine tick");
    createCheckpoint(store.db, "s1", "self-reported", "milestone reached");
    const ask = createAsk(store.db, "s1", "ask_human", "which approach?");
    resolveAsk(store.db, ask.id, "the second one");

    const data = gatherDigest(store.db, { now: new Date() });
    const section = data.sections.find((s) => s.projectId === "web")!;
    expect(section.checkpoints.map((c) => c.summary)).toEqual(["milestone reached"]);
    expect(section.resolvedAsks).toHaveLength(1);
    expect(data.counts.checkpoints).toBe(1);
    expect(data.counts.asks).toBe(1);
    store.close();
  });
});

// ── gather: the 24h window is TRUE UTC, not local-offset skewed ──────────────
//
// The store maps bare UTC sqlite stamps (`YYYY-MM-DD HH:MM:SS`) to Date via
// `new Date(stamp)`, which V8/Bun parse as LOCAL time — so a Date-typed
// dimension's `.getTime()` is skewed by the process UTC offset. gatherDigest
// must window finished task runs, launches, and non-routine checkpoints in true
// UTC regardless of the process timezone. These tests pin process.env.TZ to a
// non-UTC zone so the OLD Date-based comparison would misclassify the boundary
// items; the SQL-windowed reads classify them correctly.

/** Run `fn` with process.env.TZ pinned, restoring it afterward (TZ is global). */
function withTz<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
}

/** Terminal task run whose ended_at is forced to a bare UTC stamp. */
function finishedRunAt(store: Store, id: string, endedAt: string): void {
  createTaskRun(store.db, { id, projectId: "web", worktreePath: `/repos/${id}` });
  updateTaskRunStatus(store.db, id, "running");
  updateTaskRunStatus(store.db, id, "succeeded", { summary: id });
  store.db.run("UPDATE task_runs SET ended_at = ? WHERE id = ?", [endedAt, id]);
}

describe("gatherDigest — 24h window is true-UTC (not local-offset skewed)", () => {
  test("America/New_York (UTC-5): items just OUTSIDE the window are not pulled in", () => {
    withTz("America/New_York", () => {
      const store = createStore(":memory:");
      upsertProject(store.db, project());
      createSession(store.db, {
        id: "s1", projectId: "web", title: "T", cwd: "/repos/web", status: "running",
      });
      // now = 09:00 EST; true window start = 2026-01-14 14:00:00Z.
      const now = new Date("2026-01-15T14:00:00Z");
      // "…20:00" is 6h INSIDE the window; "…10:00" is 4h BEFORE the start (28h
      // before now). Under the old local-parse, "…10:00" mapped to 15:00Z and
      // was wrongly INCLUDED as "finished in the last 24h".
      finishedRunAt(store, "run-in", "2026-01-14 20:00:00");
      finishedRunAt(store, "run-out", "2026-01-14 10:00:00");

      createLaunch(store.db, { id: "l-in", projectId: "web", task: "l-in", worktreePath: "/repos/li", branch: "main" });
      store.db.run("UPDATE launches SET created_at = ? WHERE id = ?", ["2026-01-14 20:00:00", "l-in"]);
      createLaunch(store.db, { id: "l-out", projectId: "web", task: "l-out", worktreePath: "/repos/lo", branch: "main" });
      store.db.run("UPDATE launches SET created_at = ? WHERE id = ?", ["2026-01-14 10:00:00", "l-out"]);

      const cpIn = createCheckpoint(store.db, "s1", "self-reported", "cp-in");
      store.db.run("UPDATE checkpoints SET created_at = ? WHERE id = ?", ["2026-01-14 20:00:00", cpIn.id]);
      const cpOut = createCheckpoint(store.db, "s1", "self-reported", "cp-out");
      store.db.run("UPDATE checkpoints SET created_at = ? WHERE id = ?", ["2026-01-14 10:00:00", cpOut.id]);

      const data = gatherDigest(store.db, { now, tz: "America/New_York" });
      const section = data.sections.find((s) => s.projectId === "web")!;
      expect(section.taskRuns.map((r) => r.id)).toEqual(["run-in"]);
      expect(section.launches.map((l) => l.id)).toEqual(["l-in"]);
      expect(section.checkpoints.map((c) => c.summary)).toEqual(["cp-in"]);
      expect(data.counts.taskRuns).toBe(1);
      expect(data.counts.launches).toBe(1);
      expect(data.counts.checkpoints).toBe(1);
      store.close();
    });
  });

  test("Australia/Sydney (UTC+11): real in-window work is not silently dropped", () => {
    withTz("Australia/Sydney", () => {
      const store = createStore(":memory:");
      upsertProject(store.db, project());
      const now = new Date("2026-01-15T14:00:00Z");
      // true window start = 2026-01-14 14:00:00Z. "…16:00" is 2h INSIDE the
      // window but under the old local-parse mapped to 05:00Z and was wrongly
      // DROPPED (silent omission). "…10:00" the prior day is genuinely OUT.
      finishedRunAt(store, "run-in", "2026-01-14 16:00:00");
      finishedRunAt(store, "run-out", "2026-01-13 10:00:00");

      const data = gatherDigest(store.db, { now, tz: "Australia/Sydney" });
      const section = data.sections.find((s) => s.projectId === "web")!;
      expect(section.taskRuns.map((r) => r.id)).toEqual(["run-in"]);
      expect(data.counts.taskRuns).toBe(1);
      store.close();
    });
  });
});

// ── empty → quiet day ────────────────────────────────────────────────────────

describe("renderDigest — empty window is a quiet-day sentence, never blank", () => {
  test("an all-empty gather renders a real sentence", () => {
    const store = createStore(":memory:");
    const data = gatherDigest(store.db, { now: new Date() });
    expect(data.empty).toBe(true);
    const rendered = renderDigest(data);
    expect(rendered.trim().length).toBeGreaterThan(0);
    expect(rendered.toLowerCase()).toContain("quiet day");
    store.close();
  });

  test("Persona's cards waiting on the owner are listed in plain English, even on a quiet day", () => {
    const store = createStore(":memory:");
    createPersonaApproval(store.db, {
      owner: "alice",
      action: "launch_session",
      summary: 'Launch a worker in web: "Fix the flaky auth test"',
      reason: "active launch cap reached (6/6)",
      args: { projectId: "web", title: "Fix the flaky auth test", task: "Fix the flaky auth test." },
    });
    createPersonaApproval(store.db, {
      owner: "bob",
      action: "launch_session",
      summary: 'Launch a worker in web: "Bob\'s own task"',
      reason: "held",
      args: { projectId: "web", title: "Bob's own task", task: "Bob's own task." },
    });
    const data = gatherDigest(store.db, { now: new Date(), reader: "alice" });
    expect(data.awaitingApproval).toEqual([
      "I want to start a worker in web on “Fix the flaky auth test”. 6 workers are already running, and 6 at once is the limit.",
    ]);
    const rendered = renderDigest(data);
    expect(rendered.toLowerCase()).toContain("quiet day");
    expect(rendered).toContain("- Waiting on your approval (1): I want to start a worker in web on “Fix the flaky auth test”.");
    store.close();
  });

  test("a non-empty gather renders per-project sections", () => {
    const store = createStore(":memory:");
    upsertProject(store.db, project());
    createKnowledgeChange(store.db, knowledgeChange({ title: "Indexed a decision" }));
    const data = gatherDigest(store.db, { now: new Date() });
    const rendered = renderDigest(data);
    expect(rendered).toContain("## web");
    expect(rendered).toContain("Indexed a decision");
    store.close();
  });
});

describe("knowledge use — per project, over sessions started in the window", () => {
  let eventSeq = 0;
  function toolCall(store: Store, sessionId: string, createdAt: string, tool: string, extra: Record<string, unknown> = {}) {
    eventSeq += 1;
    store.db.run(
      "INSERT INTO events (session_id, seq, type, payload_json, created_at) VALUES (?, ?, 'PostToolUse', ?, ?)",
      [sessionId, eventSeq, JSON.stringify({ session_id: sessionId, tool_name: tool, ...extra }), createdAt]
    );
  }
  function startedSession(store: Store, id: string, startedAt: string) {
    createSession(store.db, { id, projectId: "web", title: id, cwd: "/repos/web", status: "running" });
    store.db.run("UPDATE sessions SET started_at = ? WHERE id = ?", [startedAt, id]);
  }

  test("gatherDigest summarizes the window's sessions and renderDigest prints one line", () => {
    const store = createStore(":memory:");
    upsertProject(store.db, project());
    const now = new Date("2026-02-01T12:00:00Z");

    // a: searches, then edits, then proposes twice (published + draft).
    startedSession(store, "a", "2026-02-01 08:00:00");
    toolCall(store, "a", "2026-02-01 08:01:00", "mcp__standup__search_knowledge", { tool_input: { query: "q" } });
    toolCall(store, "a", "2026-02-01 08:02:00", "Edit");
    toolCall(store, "a", "2026-02-01 08:03:00", "mcp__standup__propose_knowledge", {
      tool_response: [{ type: "text", text: 'Knowledge "x" published — it is now live, searchable project knowledge.' }],
    });
    toolCall(store, "a", "2026-02-01 08:04:00", "mcp__standup__propose_knowledge", {
      tool_response: [{ type: "text", text: 'Draft "y" saved for human review — it is not searchable until a human accepts it.' }],
    });
    // b: edits without searching.
    startedSession(store, "b", "2026-02-01 09:00:00");
    toolCall(store, "b", "2026-02-01 09:01:00", "Write");
    // Outside the window on both sides: not counted.
    startedSession(store, "old", "2026-01-30 09:00:00");
    startedSession(store, "later", "2026-02-01 13:00:00");

    const data = gatherDigest(store.db, { now });
    const section = data.sections.find((s) => s.projectId === "web")!;
    expect(section.knowledgeUsage).toMatchObject({
      sessions: 2,
      searched: 1,
      editing: 2,
      searchedBeforeEdit: 1,
      proposed: 1,
      proposalCalls: 2,
      draftsPending: 1,
    });
    expect(renderDigest(data)).toContain(
      "- Knowledge use: 1/2 sessions searched · 1/2 editing sessions searched before editing · 1/2 proposed (2 calls) · 1 draft pending"
    );
    store.close();
  });

  test("no line when no session started in the window", () => {
    const store = createStore(":memory:");
    upsertProject(store.db, project());
    createKnowledgeChange(store.db, knowledgeChange({ title: "Indexed a decision" }));
    const data = gatherDigest(store.db, { now: new Date() });
    expect(data.sections[0].knowledgeUsage).toBeUndefined();
    expect(renderDigest(data)).not.toContain("Knowledge use:");
    store.close();
  });

  test("renderKnowledgeUsage drops the clauses with nothing to report", () => {
    expect(
      renderKnowledgeUsage({
        sessions: 3,
        searched: 0,
        searchedPct: 0,
        editing: 0,
        searchedBeforeEdit: 0,
        searchedBeforeEditPct: 0,
        proposed: 1,
        proposedPct: 33,
        proposalCalls: 1,
        draftsPending: 0,
      })
    ).toBe("- Knowledge use: 0/3 sessions searched · 1/3 proposed (1 call)");
    expect(renderKnowledgeUsage(undefined)).toBe("");
  });

  test("renderKnowledgeUsage splits searched-before-editing by harness when more than one ran", () => {
    const counts = (sessions: number, editing: number, searchedBeforeEdit: number) => ({
      sessions,
      searched: searchedBeforeEdit,
      searchedPct: 0,
      editing,
      searchedBeforeEdit,
      searchedBeforeEditPct: 0,
      proposed: 0,
      proposedPct: 0,
      proposalCalls: 0,
    });
    const total = { ...counts(5, 4, 2), draftsPending: 0 };
    expect(
      renderKnowledgeUsage({ ...total, byHarness: { claude: counts(3, 2, 2), codex: counts(2, 2, 0) } })
    ).toBe(
      "- Knowledge use: 2/5 sessions searched · 2/4 editing sessions searched before editing (claude 2/2, codex 0/2) · 0/5 proposed (0 calls)"
    );
    expect(renderKnowledgeUsage({ ...total, byHarness: { claude: counts(5, 4, 2) } })).toBe(
      "- Knowledge use: 2/5 sessions searched · 2/4 editing sessions searched before editing · 0/5 proposed (0 calls)"
    );
  });
});

// ── summarize: model text vs fallback ────────────────────────────────────────

describe("summarizeDigest — model text, with fallback that never throws", () => {
  function nonEmpty(): DigestData {
    return {
      periodStart: "2026-01-01T00:00:00Z",
      periodEnd: "2026-01-02T00:00:00Z",
      date: "2026-01-02",
      sections: [
        {
          projectId: "web",
          projectName: "web",
          activeWork: [],
          taskRuns: [],
          checkpoints: [],
          knowledgeChanges: [knowledgeChange()],
          resolvedAsks: [],
          launches: [],
        },
      ],
      counts: { projects: 1, activeWork: 0, taskRuns: 0, checkpoints: 0, knowledgeChanges: 1, asks: 0, launches: 0 },
      empty: false,
    };
  }

  test("returns the model's text when it produces one", async () => {
    const data = nonEmpty();
    const out = await summarizeDigest("RENDERED", data, { generate: async () => "MODEL WROTE THIS" });
    expect(out).toBe("MODEL WROTE THIS");
  });

  test("falls back to the rendered summary when the model returns null", async () => {
    const out = await summarizeDigest("RENDERED", nonEmpty(), { generate: async () => null });
    expect(out).toBe("RENDERED");
  });

  test("falls back (never throws) when the model call throws", async () => {
    const out = await summarizeDigest("RENDERED", nonEmpty(), {
      generate: async () => {
        throw new Error("timeout");
      },
    });
    expect(out).toBe("RENDERED");
  });

  test("a quiet day skips the model entirely and returns the rendered sentence", async () => {
    let called = false;
    const empty: DigestData = { ...nonEmpty(), sections: [], counts: { ...nonEmpty().counts, projects: 0, knowledgeChanges: 0 }, empty: true };
    const out = await summarizeDigest("QUIET", empty, {
      generate: async () => {
        called = true;
        return "should not run";
      },
    });
    expect(called).toBe(false);
    expect(out).toBe("QUIET");
  });
});

// ── delivery: persist-then-broadcast ─────────────────────────────────────────

describe("makeDigestEmitter — persist THEN broadcast", () => {
  test("the row is written before the broadcast fires (survives reload/reconnect)", () => {
    const store = createStore(":memory:");
    let persistedAtBroadcast = -1;
    let broadcastType = "";
    const emit = makeDigestEmitter(store.db, (msg: WsMessage) => {
      broadcastType = msg.type;
      persistedAtBroadcast = getRecentDigests(store.db).length;
    });
    emit({
      id: "digest:2026-01-15",
      createdAt: "2026-01-15T14:30:00Z",
      periodStart: "2026-01-14T14:30:00Z",
      periodEnd: "2026-01-15T14:30:00Z",
      body: "the digest",
      projects: ["web"],
      counts: { projects: 1, activeWork: 0, taskRuns: 1, checkpoints: 0, knowledgeChanges: 0, asks: 0, launches: 0 },
    });
    // At broadcast time the row was already durable.
    expect(persistedAtBroadcast).toBe(1);
    expect(broadcastType).toBe("digest:posted");
    expect(getRecentDigests(store.db)).toHaveLength(1);
    store.close();
  });

  test("tick delivers a digest:posted with counts and stamps the day", async () => {
    const store = createStore(":memory:");
    upsertProject(store.db, project());
    createKnowledgeChange(store.db, knowledgeChange());
    const broadcasts: WsMessage[] = [];
    await tick(store.db, opts({ now: () => new Date("2026-02-01T14:30:00Z"), broadcast: (m) => broadcasts.push(m) }));

    expect(broadcasts.map((b) => b.type)).toContain("digest:posted");
    const digest = broadcasts.find((b) => b.type === "digest:posted")!.payload as Digest;
    expect(digest.body).toBe("MODEL SUMMARY");
    expect(digest.counts.knowledgeChanges).toBe(1);
    expect(digest.projects).toEqual(["web"]);
    // Persisted for the resync ledger.
    expect(getRecentDigests(store.db)).toHaveLength(1);
    store.close();
  });
});

// ── store round-trip ─────────────────────────────────────────────────────────

describe("createDigest / getRecentDigests — JSON round-trip", () => {
  test("projects + counts survive persistence", () => {
    const store: Store = createStore(":memory:");
    const digest: Digest = {
      id: "d1",
      createdAt: "2026-01-15T14:30:00Z",
      periodStart: "2026-01-14T14:30:00Z",
      periodEnd: "2026-01-15T14:30:00Z",
      body: "body text",
      projects: ["web", "collector"],
      counts: { projects: 2, activeWork: 3, taskRuns: 1, checkpoints: 4, knowledgeChanges: 2, asks: 1, launches: 0 },
    };
    createDigest(store.db, digest);
    const [round] = getRecentDigests(store.db);
    expect(round.projects).toEqual(["web", "collector"]);
    expect(round.counts.checkpoints).toBe(4);
    expect(round.body).toBe("body text");
    // INSERT OR IGNORE: a re-post of the same id is a no-op.
    createDigest(store.db, digest);
    expect(getRecentDigests(store.db)).toHaveLength(1);
    store.close();
  });
});
