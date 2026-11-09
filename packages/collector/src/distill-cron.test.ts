import { expect, test, describe } from "bun:test";
import {
  createStore,
  upsertProject,
  createSession,
  createTaskRun,
  updateTaskRunStatus,
  appendEvent,
  getSetting,
  createLaunch,
  attachSessionToLaunch,
  recordRetrievals,
} from "@standup/store";
import type { Store } from "@standup/store";
import { OWNER_PREFERENCES_BEGIN, fenceOwnerPreferences } from "./persona/preferences-block.js";
import type { Project, TaskRun, TranscriptEvent } from "@standup/shared";
import { KnowledgeStore, type KnowledgeDoc, type SearchResult } from "@standup/knowledge";
import type { KnowledgeDraftInput, KnowledgeDocFile } from "@standup/knowledge";
import {
  distillSession,
  distillTick,
  extractTouchedFiles,
  touchedProjectIds,
  renderTranscript,
  isLexicalNearDup,
  parseDistillerOutput,
  distillPrompt,
  NEAR_DUP_THRESHOLD,
  type DistillDeps,
  type DistillInput,
  type DistilledDraft,
} from "./distill-cron.js";

/** Shapes a `claude --output-format json` envelope around an agent reply. */
function envelope(result: string, isError = false): string {
  return JSON.stringify({ type: "result", subtype: "success", is_error: isError, result });
}

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

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: "run1",
    kind: "worktree",
    projectId: "web",
    sessionId: "sess-1",
    worktreePath: "/repos/web",
    status: "succeeded",
    createdAt: new Date(),
    ...overrides,
  } as TaskRun;
}

/** An assistant record carrying a tool_use block (as stored in transcript_events). */
function editEvent(seq: number, filePath: string): TranscriptEvent {
  return {
    seq,
    eventId: `e${seq}`,
    createdAt: new Date().toISOString(),
    event: {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Applying the fix." },
          { type: "tool_use", name: "Edit", input: { file_path: filePath } },
        ],
      },
    },
  };
}

function textEvent(seq: number, role: string, text: string): TranscriptEvent {
  return {
    seq,
    eventId: `e${seq}`,
    createdAt: new Date().toISOString(),
    event: { type: role, message: { role, content: [{ type: "text", text }] } },
  };
}

/** A personal-layer doc in the reserved global corpus. */
function personalDoc(overrides: Partial<KnowledgeDoc>): KnowledgeDoc {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    projectId: "global",
    slug: "doc",
    title: "Doc",
    body: "",
    updatedAt: new Date("2026-08-16T00:00:00Z"),
    filePath: "/x/doc.md",
    originClass: "owner",
    ...overrides,
  };
}

const fixedDraft: DistilledDraft = {
  slug: "retry-backoff",
  title: "Retry backoff policy",
  body: "The client retries with exponential backoff capped at 30s.",
  tags: ["retry"],
};

function makeDeps(overrides: Partial<DistillDeps> = {}): {
  deps: DistillDeps;
  writes: Array<{ projectId: string; draft: KnowledgeDraftInput }>;
} {
  const writes: Array<{ projectId: string; draft: KnowledgeDraftInput }> = [];
  const deps: DistillDeps = {
    distill: async () => fixedDraft,
    search: async () => [],
    readAcceptedDoc: async () => null,
    writeDraft: async (projectId, draft) => {
      writes.push({ projectId, draft });
    },
    now: () => new Date("2026-08-31T00:00:00.000Z"),
    ...overrides,
  };
  return { deps, writes };
}

function acceptedDoc(overrides: Partial<KnowledgeDocFile> = {}): KnowledgeDocFile {
  return {
    slug: "existing",
    title: "Existing doc",
    body: "Some accepted content.",
    tags: [],
    updatedAt: new Date(),
    sourceKind: "code",
    ...overrides,
  };
}

function searchHit(score: number, slug = "existing", projectId = "web"): SearchResult {
  return {
    id: `${projectId}/${slug}`,
    projectId,
    slug,
    title: slug,
    excerpt: "",
    score,
    source: "embedding",
    originClass: "agent",
    sourceKind: "code",
    generated: true,
  };
}

// ── extraction helpers ────────────────────────────────────────────────────────

describe("extractTouchedFiles", () => {
  test("pulls file_path from Edit/Write/MultiEdit/NotebookEdit tool_use blocks", () => {
    const events: TranscriptEvent[] = [
      textEvent(1, "user", "please fix it"),
      editEvent(2, "/repos/web/src/a.ts"),
      editEvent(3, "/repos/web/src/a.ts"), // dedup
      editEvent(4, "/repos/api/src/b.ts"),
    ];
    expect(extractTouchedFiles(events)).toEqual([
      "/repos/web/src/a.ts",
      "/repos/api/src/b.ts",
    ]);
  });

  test("ignores read-only tool calls and malformed records", () => {
    const events: TranscriptEvent[] = [
      {
        seq: 1,
        eventId: "e1",
        createdAt: "",
        event: { message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/x" } }] } },
      },
      { seq: 2, eventId: "e2", createdAt: "", event: null },
    ];
    expect(extractTouchedFiles(events)).toEqual([]);
  });
});

describe("touchedProjectIds", () => {
  test("maps touched files to owning projects by repo prefix", () => {
    const projects = [project(), project({ id: "api", name: "api", repos: ["/repos/api"] })];
    const ids = touchedProjectIds(
      ["/repos/web/src/a.ts", "/repos/api/src/b.ts"],
      projects
    );
    expect(new Set(ids)).toEqual(new Set(["web", "api"]));
  });

  test("a prefix that is not a path boundary does not match", () => {
    // /repos/web-legacy must NOT be attributed to the /repos/web project.
    const ids = touchedProjectIds(["/repos/web-legacy/x.ts"], [project()]);
    expect(ids).toEqual([]);
  });
});

describe("renderTranscript", () => {
  test("renders roles and tool calls, tail-truncating to the budget", () => {
    const events = [textEvent(1, "user", "hello"), editEvent(2, "/repos/web/a.ts")];
    const out = renderTranscript(events);
    expect(out).toContain("user: hello");
    expect(out).toContain("[tool_use Edit");

    const long = renderTranscript([textEvent(1, "user", "x".repeat(1000))], 100);
    expect(long.length).toBe(100);
  });

  test("leaves a Persona brief's owner-preferences block out", () => {
    const brief = `Fix the flaky test.\n\n${fenceOwnerPreferences("- my password is hunter2\n- keep replies terse")}\n\nFooter rule.`;
    const out = renderTranscript([textEvent(1, "user", brief), textEvent(2, "assistant", "done")]);
    expect(out).toContain("Fix the flaky test.");
    expect(out).toContain("Footer rule.");
    expect(out).not.toContain("keep replies terse");
    expect(out).not.toContain(OWNER_PREFERENCES_BEGIN);
    // A block cut off before its end marker is dropped to the end of the message.
    const cut = renderTranscript([textEvent(1, "user", `Task.\n${OWNER_PREFERENCES_BEGIN}\n- private`)]);
    expect(cut).toBe("user: Task.");
  });
});

describe("parseDistillerOutput", () => {
  const draftJson = `{"slug":"retry-backoff","title":"Retry backoff","body":"Exponential backoff, capped 30s.","tags":["retry"]}`;

  test("parses a clean double-wrapped reply", () => {
    const out = parseDistillerOutput(envelope(draftJson));
    expect(out).toEqual({
      slug: "retry-backoff",
      title: "Retry backoff",
      body: "Exponential backoff, capped 30s.",
      tags: ["retry"],
    });
  });

  test("tolerates prose wrapped around the JSON (the finding's failure mode)", () => {
    const out = parseDistillerOutput(envelope(`Here is the knowledge doc:\n\n${draftJson}\n\nHope that helps!`));
    expect(out?.slug).toBe("retry-backoff");
  });

  test("tolerates a ```json fenced reply", () => {
    const out = parseDistillerOutput(envelope("```json\n" + draftJson + "\n```"));
    expect(out?.slug).toBe("retry-backoff");
  });

  test("returns a non-kebab slug verbatim (shape rejected downstream, not silently dropped)", () => {
    const out = parseDistillerOutput(envelope(`{"slug":"Not A Slug","title":"T","body":"B"}`));
    expect(out?.slug).toBe("Not A Slug");
  });

  test("null on a skip decline, an errored envelope, and missing fields", () => {
    expect(parseDistillerOutput(envelope(`{"skip":true}`))).toBeNull();
    expect(parseDistillerOutput(envelope(draftJson, true))).toBeNull();
    expect(parseDistillerOutput(envelope(`{"slug":"x","title":"T"}`))).toBeNull();
    expect(parseDistillerOutput("not json at all")).toBeNull();
  });

  test("degrades safely on a real `claude` API-error envelope (verbatim CLI output)", () => {
    // Captured from an actual `claude --output-format json` run of the distiller
    // args against a Bedrock endpoint whose token had expired: the CLI still
    // exits with a well-formed result envelope carrying is_error:true and a
    // string `result` describing the failure. The parse path must read that as
    // "no draft" (null) rather than mistake the error string for a body — this
    // is the real degrade path behind runClaudeDistiller returning null.
    const realApiErrorEnvelope = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: 403,
      terminal_reason: "api_error",
      result: "Failed to authenticate. API Error: 403 The security token included in the request is expired",
      num_turns: 1,
    });
    expect(parseDistillerOutput(realApiErrorEnvelope)).toBeNull();
  });
});

describe("isLexicalNearDup", () => {
  test("true for a near-verbatim restatement", () => {
    expect(
      isLexicalNearDup(
        "The client retries with exponential backoff capped at 30s.",
        "The client retries requests with exponential backoff capped at 30s."
      )
    ).toBe(true);
  });

  test("false for two docs that merely share domain vocabulary", () => {
    expect(
      isLexicalNearDup(
        "Retry backoff. The client retries with exponential backoff capped at thirty seconds.",
        "Rate limiting. The gateway sheds excess requests with a token bucket per tenant shard."
      )
    ).toBe(false);
  });

  test("false when either side has no significant tokens", () => {
    expect(isLexicalNearDup("", "anything at all here")).toBe(false);
  });

  test("false when a short new fact's tokens are a subset of a much LONGER doc's vocabulary", () => {
    // The finding: a concise new fact re-using ~9 of its 11 significant tokens
    // from a big accepted doc scores containment 0.82 — but it is not a
    // restatement of that doc, just a user of the same terms. The size-ratio
    // guard must keep it from being suppressed.
    const shortNewFact =
      "distill cron scans task_runs succeeded sessions transcript_events haiku returning skip decline";
    const longDoc =
      "distill cron scans task_runs succeeded sessions transcript_events haiku returning " +
      "scheduler interval settings gate provenance origin_class confidence half_life reverify " +
      "backend seam draft accept merge slug title body tags related edges graph inject expert " +
      "search embedding cosine lexical jaccard containment threshold suppress bloat corpus accepted";
    expect(isLexicalNearDup(shortNewFact, longDoc)).toBe(false);
  });

  test("true for a comparable-size doc almost wholly contained in the other (containment arm, Jaccard alone under-scores)", () => {
    // Sizes comparable (5 vs 9 significant tokens, ratio 0.56 ≥ floor) and the
    // smaller is fully contained → a genuine restatement Jaccard (0.56) misses.
    expect(
      isLexicalNearDup(
        "alpha bravo charlie delta echo",
        "alpha bravo charlie delta echo foxtrot golf hotel india"
      )
    ).toBe(true);
  });
});

// ── the core: distillSession ──────────────────────────────────────────────────

describe("distillSession", () => {
  test("proposes a draft through the seam with agent provenance and derived tags", async () => {
    const { deps, writes } = makeDeps();
    const events = [editEvent(1, "/repos/web/src/a.ts"), editEvent(2, "/repos/api/src/b.ts")];
    const projects = [project(), project({ id: "api", name: "api", repos: ["/repos/api"] })];

    const outcome = await distillSession(deps, run(), events, projects, "abc123");

    expect(outcome.status).toBe("proposed");
    expect(writes).toHaveLength(1);
    const { projectId, draft } = writes[0];
    expect(projectId).toBe("web");
    // Provenance stamped by the collector, not the agent.
    expect(draft.originClass).toBe("agent");
    expect(draft.generatedFromSha).toBe("abc123");
    expect(draft.sourceSessionId).toBe("sess-1");
    expect(draft.sourceKind).toBe("code");
    // Unverified until a fact-check passes: no verification stamp yet.
    expect(draft.confidence).toBe(0.6);
    expect(draft.lastVerifiedAt).toBeUndefined();
    expect(draft.generatedAt).toBe("2026-08-31T00:00:00.000Z");
    // Edges derived from touched projects surface as tags (co-citation fuel).
    expect(draft.tags).toContain("retry");
    expect(draft.tags).toContain("web");
    expect(draft.tags).toContain("api");
  });

  test("derives cross-project related edges to the strongest doc in each touched project", async () => {
    // search: near-dup query (own project 'web') finds nothing; the api-project
    // related lookup returns a doc. Distinguish by the projectId argument.
    const search: DistillDeps["search"] = async (projectId) => {
      if (projectId === "api") return [searchHit(0.5, "api-doc", "api")];
      return [];
    };
    const { deps, writes } = makeDeps({ search });
    const events = [editEvent(1, "/repos/web/src/a.ts"), editEvent(2, "/repos/api/src/b.ts")];
    const projects = [project(), project({ id: "api", name: "api", repos: ["/repos/api"] })];

    await distillSession(deps, run(), events, projects, "abc123");

    expect(writes[0].draft.related).toEqual(["api/api-doc"]);
  });

  test("suppresses a near-duplicate of an accepted doc — nothing written", async () => {
    const { deps, writes } = makeDeps({
      search: async () => [searchHit(NEAR_DUP_THRESHOLD + 0.02, "retry-policy")],
      readAcceptedDoc: async () => acceptedDoc({ slug: "retry-policy" }),
    });
    const outcome = await distillSession(deps, run(), [editEvent(1, "/repos/web/a.ts")], [project()], "abc");

    expect(outcome.status).toBe("suppressed-dup");
    if (outcome.status === "suppressed-dup") expect(outcome.dupSlug).toBe("retry-policy");
    expect(writes).toHaveLength(0);
  });

  test("a below-threshold hit is NOT a near-duplicate — the draft is written", async () => {
    const { deps, writes } = makeDeps({
      search: async () => [searchHit(NEAR_DUP_THRESHOLD - 0.2)],
      readAcceptedDoc: async (_p, slug) => (slug === "existing" ? acceptedDoc() : null),
    });
    const outcome = await distillSession(deps, run(), [editEvent(1, "/repos/web/a.ts")], [project()], "abc");
    expect(outcome.status).toBe("proposed");
    expect(writes).toHaveLength(1);
  });

  test("lexical near-dup suppresses even with no embedding provider (low FTS score)", async () => {
    // Text-search-only regime: the top FTS hit scores far below the semantic
    // bar, but its accepted-doc body is a near-verbatim restatement of the
    // candidate — the lexical arm must catch it.
    const { deps, writes } = makeDeps({
      search: async () => [searchHit(0.4, "retry-policy")],
      readAcceptedDoc: async () =>
        acceptedDoc({
          slug: "retry-policy",
          title: "Retry backoff policy",
          body: "The client retries requests with exponential backoff capped at 30s.",
        }),
    });
    const outcome = await distillSession(deps, run(), [editEvent(1, "/repos/web/a.ts")], [project()], "abc");
    expect(outcome.status).toBe("suppressed-dup");
    if (outcome.status === "suppressed-dup") expect(outcome.dupSlug).toBe("retry-policy");
    expect(writes).toHaveLength(0);
  });

  test("a low-score hit whose accepted doc shares only vocabulary is NOT suppressed", async () => {
    const { deps, writes } = makeDeps({
      search: async () => [searchHit(0.4, "networking")],
      readAcceptedDoc: async () =>
        acceptedDoc({
          slug: "networking",
          title: "Networking overview",
          body: "The gateway multiplexes websocket frames across tenant connections and shards.",
        }),
    });
    const outcome = await distillSession(deps, run(), [editEvent(1, "/repos/web/a.ts")], [project()], "abc");
    expect(outcome.status).toBe("proposed");
    expect(writes).toHaveLength(1);
  });

  test("a short candidate whose tokens are a subset of a LONG accepted doc is NOT suppressed", async () => {
    // The finding's uncovered edge: fixedDraft is short; the top FTS hit is a
    // long comprehensive doc whose large vocabulary happens to contain nearly
    // all of the candidate's significant tokens. Old containment (÷ smaller set)
    // scored ~1.0 and silently suppressed genuinely-new knowledge; the size-
    // ratio guard must let the draft through.
    const longBody =
      "The client retries with exponential backoff capped when policy applies. " +
      "This subsystem also documents circuit breakers, bulkheads, timeouts, jitter, " +
      "idempotency keys, dead-letter queues, replay windows, throttling budgets, " +
      "connection pools, health probes, load shedding, and graceful shutdown paths.";
    const { deps, writes } = makeDeps({
      search: async () => [searchHit(0.4, "resilience-guide")],
      readAcceptedDoc: async () =>
        acceptedDoc({ slug: "resilience-guide", title: "Resilience guide", body: longBody }),
    });
    const outcome = await distillSession(deps, run(), [editEvent(1, "/repos/web/a.ts")], [project()], "abc");
    expect(outcome.status).toBe("proposed");
    expect(writes).toHaveLength(1);
  });

  test("sets replacesSlug when the draft's slug already names an accepted doc (data-loss gate)", async () => {
    // readAcceptedDoc returns a HUMAN-authored doc at the same slug the distiller
    // chose, with unrelated content (so near-dup does not fire). The draft must
    // carry replacesSlug so accept merges instead of a silent overwrite.
    const { deps, writes } = makeDeps({
      search: async () => [],
      readAcceptedDoc: async (_projectId, slug) =>
        slug === fixedDraft.slug
          ? acceptedDoc({ slug, title: "Hand-written", body: "Totally different human content." })
          : null,
    });
    const outcome = await distillSession(deps, run(), [editEvent(1, "/repos/web/a.ts")], [project()], "abc");
    expect(outcome.status).toBe("proposed");
    expect(writes).toHaveLength(1);
    expect(writes[0].draft.replacesSlug).toBe(fixedDraft.slug);
  });

  test("leaves replacesSlug unset for a fresh slug (first write, accept-all eligible)", async () => {
    const { deps, writes } = makeDeps();
    await distillSession(deps, run(), [editEvent(1, "/repos/web/a.ts")], [project()], "abc");
    expect(writes[0].draft.replacesSlug).toBeUndefined();
  });

  test("writes nothing when the distiller declines (nothing durable)", async () => {
    const { deps, writes } = makeDeps({ distill: async () => null });
    const outcome = await distillSession(deps, run(), [editEvent(1, "/repos/web/a.ts")], [project()], "abc");
    expect(outcome.status).toBe("empty");
    expect(writes).toHaveLength(0);
  });

  test("rejects an unusable draft (bad slug) without writing", async () => {
    const { deps, writes } = makeDeps({
      distill: async () => ({ ...fixedDraft, slug: "Not A Slug!" }),
    });
    const outcome = await distillSession(deps, run(), [editEvent(1, "/repos/web/a.ts")], [project()], "abc");
    expect(outcome.status).toBe("invalid");
    expect(writes).toHaveLength(0);
  });
});

// ── the tick: detection + gating over a real ledger ──────────────────────────

function seedRun(store: Store): void {
  upsertProject(store.db, {
    id: "web",
    name: "web",
    branch: "main",
    repos: [],
    dailyReviewActive: true,
  });
  createSession(store.db, {
    id: "sess-1",
    projectId: "web",
    title: "t",
    cwd: "/repos/web",
    status: "running",
  });
  createTaskRun(store.db, {
    id: "run1",
    projectId: "web",
    worktreePath: "/repos/web",
    sessionId: "sess-1",
  });
  updateTaskRunStatus(store.db, "run1", "running");
  updateTaskRunStatus(store.db, "run1", "succeeded");
  appendEvent(store.db, "sess-1", { eventId: "e1", event: editEvent(1, "/repos/web/a.ts").event });
}

describe("distillPrompt", () => {
  const input = (injectedDocs: DistillInput["injectedDocs"]): DistillInput => ({
    run: run(),
    transcript: "user: hi",
    touchedFiles: [],
    touchedProjectIds: [],
    injectedDocs,
  });

  test.each([
    ["lessons, not logs", "Lessons, not logs"],
    ["nothing to save", "Nothing to save is a fine outcome"],
    ["update order", "(1) update the injected doc below that the session showed wrong"],
    ["related doc", "(2) otherwise extend an injected doc below that covers a related subject"],
    ["no injected docs", `Docs of project "web" injected into the session's brief (full text):\n(none)`],
  ])("states %s", (_label, expected) => {
    expect(distillPrompt(input([]))).toContain(expected);
  });

});

describe("distillSession with injected docs", () => {
  const injected = (docSlug: string) => ({ docProject: "web", docSlug });

  test("offers only shared, whole, unpending docs within the budgets as update targets", async () => {
    const docs: Record<string, KnowledgeDocFile> = {
      small: acceptedDoc({ slug: "small", title: "Small", body: "short" }),
      big: acceptedDoc({ slug: "big", title: "Big", body: "x".repeat(12_001) }),
      mine: acceptedDoc({ slug: "mine", title: "Mine", body: "personal", scope: "user" }),
      pending: acceptedDoc({ slug: "pending", title: "Pending", body: "has a draft" }),
      a: acceptedDoc({ slug: "a", title: "A", body: "a".repeat(12_000) }),
      b: acceptedDoc({ slug: "b", title: "B", body: "b".repeat(12_000) }),
    };
    let seen: DistillInput | null = null;
    const { deps } = makeDeps({
      distill: async (input) => {
        seen = input;
        return null;
      },
      readAcceptedDoc: async (_projectId, slug) => docs[slug] ?? null,
      draftExists: (_projectId, slug) => slug === "pending",
    });
    const slugs = ["small", "big", "mine", "pending", "gone", "a", "b"];
    await distillSession(deps, run(), [], [project()], null, slugs.map(injected));
    // "b" would take the total past the 24k budget.
    expect(seen!.injectedDocs.map((d) => d.slug)).toEqual(["small", "a"]);
  });

  test("a replacement keeps the replaced doc's kind, tags, edges and half-life", async () => {
    const { deps, writes } = makeDeps({
      readAcceptedDoc: async (_projectId, slug) =>
        slug === fixedDraft.slug
          ? acceptedDoc({
              slug,
              body: "Unrelated product intent.",
              sourceKind: "runbook",
              tags: ["forbid:deploy"],
              related: ["api/rate-limits"],
              halfLifeDays: 365,
            })
          : null,
    });
    await distillSession(deps, run(), [], [project()], null);
    const draft = writes[0].draft;
    expect(draft.replacesSlug).toBe(fixedDraft.slug);
    expect(draft.sourceKind).toBe("runbook");
    expect(draft.tags).toEqual(["forbid:deploy", "retry"]);
    expect(draft.related).toEqual(["api/rate-limits"]);
    expect(draft.halfLifeDays).toBe(365);
  });

  test.each([
    ["a native-memory mirror", { sourceKind: "native-memory" as const, nativeMemoryFrom: "/m/MEMORY.md" }],
    ["a playbook", { sourceKind: "playbook" as const }],
    ["a personal doc", { scope: "user" as const }],
  ])("never replaces or offers %s", async (_label, fields) => {
    let seen: DistillInput | null = null;
    const { deps, writes } = makeDeps({
      distill: async (input) => {
        seen = input;
        return fixedDraft;
      },
      readAcceptedDoc: async (_projectId, slug) =>
        slug === fixedDraft.slug ? acceptedDoc({ slug, body: "Maintained elsewhere.", ...fields }) : null,
    });
    const outcome = await distillSession(deps, run(), [], [project()], null, [injected(fixedDraft.slug)]);
    expect(seen!.injectedDocs).toEqual([]);
    expect(outcome.status).toBe("invalid");
    expect(writes).toHaveLength(0);
  });

  test("never overwrites a review draft already pending at the slug", async () => {
    const { deps, writes } = makeDeps({ draftExists: (projectId, slug) => projectId === "web" && slug === fixedDraft.slug });
    const outcome = await distillSession(deps, run(), [], [project()], null);
    expect(outcome).toEqual({ status: "pending-draft", slug: fixedDraft.slug });
    expect(writes).toHaveLength(0);
  });
});

describe("distillTick", () => {
  test("distills a succeeded run once, then gates it out on the next tick", async () => {
    const store = createStore(":memory:");
    seedRun(store);

    const writes: Array<{ projectId: string; draft: KnowledgeDraftInput }> = [];
    let distillCalls = 0;
    const backend = {
      search: async () => [] as SearchResult[],
      readAcceptedDoc: async () => null,
      writeDraft: async (projectId: string, draft: KnowledgeDraftInput) => {
        writes.push({ projectId, draft });
      },
    };
    const synced: string[] = [];
    const deps = {
      makeDistiller: () => async () => {
        distillCalls++;
        return fixedDraft;
      },
      backend: backend as never,
      syncDrafts: async (projectId: string) => {
        synced.push(projectId);
      },
    };

    await distillTick(store.db, deps);
    expect(distillCalls).toBe(1);
    expect(writes).toHaveLength(1);
    expect(writes[0].draft.sourceSessionId).toBe("sess-1");
    expect(synced).toEqual(["web"]);
    expect(getSetting(store.db, "knowledge_distill_done:run1")).not.toBeNull();

    // Second tick: the run is gated out, so the distiller is not called again.
    await distillTick(store.db, deps);
    expect(distillCalls).toBe(1);
    expect(writes).toHaveLength(1);

    store.close();
  });

  test("a session with an injected doc yields a replacement draft for that slug", async () => {
    const store = createStore(":memory:");
    seedRun(store);
    createLaunch(store.db, { id: "L1", projectId: "web", task: "t", worktreePath: "/repos/web", branch: "b" });
    attachSessionToLaunch(store.db, "L1", "sess-1");
    recordRetrievals(store.db, [
      { docProject: "web", docSlug: "retry-policy", query: "t", rank: 0, surface: "inject", injected: true, launchId: "L1" },
      // Another project's doc is not an update target: the draft lands in "web".
      { docProject: "global", docSlug: "global-doc", query: "t", rank: 1, surface: "inject", injected: true, launchId: "L1" },
    ]);

    const stale = acceptedDoc({ slug: "retry-policy", title: "Retry policy", body: "Retries are capped at 3." });
    const writes: Array<{ projectId: string; draft: KnowledgeDraftInput }> = [];
    let seen: DistillInput | null = null;
    const deps = {
      makeDistiller: () => async (input: DistillInput) => {
        seen = input;
        return { slug: "retry-policy", title: "Retry policy", body: "Retries are capped at 5, with jitter." };
      },
      backend: {
        // The doc being replaced is the nearest hit; it is not a duplicate of itself.
        search: async () => [searchHit(0.99, "retry-policy", "web")],
        readAcceptedDoc: async (projectId: string, slug: string) =>
          projectId === "web" && slug === "retry-policy" ? stale : null,
        writeDraft: async (projectId: string, draft: KnowledgeDraftInput) => {
          writes.push({ projectId, draft });
        },
      } as never,
      syncDrafts: async () => {},
    };

    await distillTick(store.db, deps);
    expect(seen!.injectedDocs).toEqual([
      { slug: "retry-policy", title: "Retry policy", body: "Retries are capped at 3." },
    ]);
    expect(distillPrompt(seen!)).toContain("--- slug: retry-policy | title: Retry policy\nRetries are capped at 3.");
    expect(writes).toHaveLength(1);
    expect(writes[0].projectId).toBe("web");
    expect(writes[0].draft.slug).toBe("retry-policy");
    expect(writes[0].draft.replacesSlug).toBe("retry-policy");
    store.close();
  });

  test("a draft never carries the personal layer into its shared project scope", async () => {
    const store = createStore(":memory:");
    seedRun(store);
    const memory = "Alice is out every second Friday for a standing medical appointment.";
    const rule = "Prefix every database migration filename with a zero-padded four-digit sequence number.";
    const knowledge = new KnowledgeStore(store.db);
    knowledge.upsertDoc(personalDoc({ id: "mem", slug: "persona-alice-schedule", scope: "user", ownerUser: "alice", body: memory }));
    knowledge.upsertDoc(
      personalDoc({ id: "home", slug: "native-mem-home-claude-md", sourceKind: "native-memory", scope: "global", body: `## Migrations\n\n- ${rule}` })
    );

    const writes: KnowledgeDraftInput[] = [];
    // The distiller restates what the transcript showed it: the owner's memory and home rule next to the session's finding.
    const leaky: DistilledDraft = { ...fixedDraft, body: `${fixedDraft.body}\n\n- ${rule}\n\n> ${memory}` };
    await distillTick(store.db, {
      makeDistiller: () => async () => leaky,
      backend: {
        search: async () => [] as SearchResult[],
        readAcceptedDoc: async () => null,
        writeDraft: async (_projectId: string, draft: KnowledgeDraftInput) => {
          writes.push(draft);
        },
      } as never,
      syncDrafts: async () => {},
    });
    expect(writes).toHaveLength(1);
    expect(writes[0].scope).not.toBe("user");
    expect(writes[0].body).toContain(fixedDraft.body);
    expect(writes[0].body).not.toContain("medical appointment");
    expect(writes[0].body).not.toContain("zero-padded four-digit");
    store.close();
  });

  test("feeds the distiller the TAIL of a long session, not its exploratory head", async () => {
    const store = createStore(":memory:");
    upsertProject(store.db, {
      id: "web",
      name: "web",
      branch: "main",
      repos: [],
      dailyReviewActive: true,
    });
    createSession(store.db, { id: "sess-1", projectId: "web", title: "t", cwd: "/repos/web", status: "running" });
    createTaskRun(store.db, { id: "run1", projectId: "web", worktreePath: "/repos/web", sessionId: "sess-1" });
    updateTaskRunStatus(store.db, "run1", "running");
    updateTaskRunStatus(store.db, "run1", "succeeded");

    // A session longer than the 5000-record fetch cap: the first record carries
    // the early-exploration marker, the last carries the conclusion. The tail
    // fetch must hand the distiller the conclusion and drop the head.
    const total = 5002;
    appendEvent(store.db, "sess-1", {
      eventId: "head",
      event: textEvent(1, "user", "HEAD_MARKER_EARLY_EXPLORATION").event,
    });
    for (let i = 2; i < total; i++) {
      appendEvent(store.db, "sess-1", { eventId: `mid${i}`, event: textEvent(i, "assistant", "filler").event });
    }
    appendEvent(store.db, "sess-1", {
      eventId: "tail",
      event: textEvent(total, "assistant", "TAIL_MARKER_THE_FIX_THAT_WORKED").event,
    });

    let captured = "";
    const deps = {
      makeDistiller: () => async (input: DistillInput) => {
        captured = input.transcript;
        return null;
      },
      backend: { search: async () => [], readAcceptedDoc: async () => null, writeDraft: async () => {} } as never,
      syncDrafts: async () => {},
    };

    await distillTick(store.db, deps);
    expect(captured).toContain("TAIL_MARKER_THE_FIX_THAT_WORKED");
    expect(captured).not.toContain("HEAD_MARKER_EARLY_EXPLORATION");

    store.close();
  });

  test("skips runs in projects that have not opted into daily review", async () => {
    const store = createStore(":memory:");
    seedRun(store);
    // Flip the opt-in off.
    upsertProject(store.db, { id: "web", name: "web", branch: "main", repos: [], dailyReviewActive: false });

    let distillCalls = 0;
    const deps = {
      makeDistiller: () => async () => {
        distillCalls++;
        return fixedDraft;
      },
      backend: { search: async () => [], readAcceptedDoc: async () => null, writeDraft: async () => {} } as never,
      syncDrafts: async () => {},
    };

    await distillTick(store.db, deps);
    expect(distillCalls).toBe(0);
    // The gate is NOT recorded for a non-opted run, so opting in later backfills it.
    expect(getSetting(store.db, "knowledge_distill_done:run1")).toBeNull();

    store.close();
  });
});
