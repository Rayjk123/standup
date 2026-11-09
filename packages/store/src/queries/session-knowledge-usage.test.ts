import { expect, test, describe } from "bun:test";
import type { Database } from "bun:sqlite";
import { createStore } from "../store.js";
import { upsertProject } from "./projects.js";
import { createSession } from "./sessions.js";
import { recordRetrievals } from "./knowledge-retrievals.js";
import {
  CONTRIBUTE_NUDGE_EVENT_TYPE,
  getSessionKnowledgeUsage,
  summarizeKnowledgeUsage,
} from "./session-knowledge-usage.js";

let seq = 0;

/** Inserts a hook event with a fixed timestamp. */
function event(
  db: Database,
  sessionId: string,
  createdAt: string,
  payload: Record<string, unknown>,
  type = "PostToolUse"
): void {
  seq += 1;
  db.run("INSERT INTO events (session_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)", [
    sessionId,
    seq,
    type,
    JSON.stringify({ session_id: sessionId, ...payload }),
    createdAt,
  ]);
}

function toolCall(
  db: Database,
  sessionId: string,
  createdAt: string,
  tool: string,
  input: Record<string, unknown> = {},
  extra: Record<string, unknown> = {}
): void {
  event(db, sessionId, createdAt, { hook_event_name: "PostToolUse", tool_name: tool, tool_input: input, ...extra });
}

function propose(db: Database, sessionId: string, createdAt: string, text: string): void {
  toolCall(db, sessionId, createdAt, "mcp__standup__propose_knowledge", { slug: "x" }, {
    tool_response: [{ type: "text", text }],
  });
}

function session(db: Database, id: string, projectId: string, startedAt: string, extra: Record<string, string> = {}): void {
  createSession(db, { id, projectId, title: `T ${id}`, cwd: "/repo", status: "running", ...extra });
  db.run("UPDATE sessions SET started_at = ? WHERE id = ?", [startedAt, id]);
}

let transcriptSeq = 0;
let toolUseN = 0;

/** Inserts one transcript record with a fixed timestamp. */
function transcript(db: Database, sessionId: string, createdAt: string, record: unknown): void {
  transcriptSeq += 1;
  db.run("INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)", [
    sessionId,
    transcriptSeq,
    typeof record === "string" ? record : JSON.stringify(record),
    createdAt,
  ]);
}

/** A tool call as the Codex observer logs it: a tool_use record, then its tool_result. */
function codexTool(
  db: Database,
  sessionId: string,
  createdAt: string,
  name: string,
  input: Record<string, unknown> = {},
  output = ""
): void {
  toolUseN += 1;
  const id = `codextool:L:${toolUseN}`;
  transcript(db, sessionId, createdAt, {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  });
  transcript(db, sessionId, createdAt, {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: output, is_error: false }] },
  });
}

/** A session started by a launch of the given harness. */
function launchedSession(db: Database, id: string, harness: string | null, startedAt: string): void {
  session(db, id, "p", startedAt);
  db.run(
    "INSERT INTO launches (id, project_id, task, worktree_path, branch, session_id, harness) VALUES (?, 'p', 't', '/wt', 'b', ?, ?)",
    [`L-${id}`, id, harness]
  );
}

function setRetrievalTimes(db: Database, sessionId: string, createdAt: string): void {
  db.run("UPDATE knowledge_retrievals SET created_at = ? WHERE session_id = ?", [createdAt, sessionId]);
}

function seed() {
  const store = createStore(":memory:");
  const db = store.db;
  upsertProject(db, { id: "p", name: "p", branch: "main", repos: [] });
  upsertProject(db, { id: "q", name: "q", branch: "main", repos: [] });

  // s1: launched with injected docs, searches before editing, proposes three
  // times (published, draft, refused), a subagent searches, and it was nudged.
  session(db, "s1", "p", "2026-03-01 10:00:00");
  db.run(
    "INSERT INTO launches (id, project_id, task, worktree_path, branch, session_id) VALUES ('L1', 'p', 't', '/wt', 'b', 's1')"
  );
  recordRetrievals(db, [
    { docProject: "p", docSlug: "inj-a", query: "task", rank: 0, surface: "inject", injected: true, launchId: "L1" },
    { docProject: "p", docSlug: "inj-b", query: "task", rank: 1, surface: "inject", injected: true, launchId: "L1" },
    { docProject: "p", docSlug: "inj-c", query: "task", rank: 2, surface: "inject", injected: false, launchId: "L1" },
  ]);
  recordRetrievals(db, [
    { docProject: "p", docSlug: "hot", query: "how does x work", rank: 0, surface: "search", sessionId: "s1" },
    { docProject: "p", docSlug: "warm", query: "how does x work", rank: 1, surface: "search", sessionId: "s1" },
    { docProject: "p", docSlug: "deep", query: "how does x work", rank: 7, surface: "search", sessionId: "s1" },
    { docProject: "p", docSlug: "hot", query: "x gotchas", rank: 0, surface: "search", sessionId: "s1" },
    { docProject: "p", docSlug: "held", query: "x gotchas", rank: 0, surface: "search", sessionId: "s1", dropReason: "scope" },
    { docProject: "p", docSlug: "hot", query: "hot", rank: 0, surface: "doc_get", sessionId: "s1" },
  ]);
  setRetrievalTimes(db, "s1", "2026-03-01 10:01:00");
  toolCall(db, "s1", "2026-03-01 10:01:00", "mcp__standup__search_knowledge", { query: "how does x work" });
  // A search with no hits leaves only its event.
  toolCall(db, "s1", "2026-03-01 10:01:30", "mcp__standup__search_knowledge", { query: "nothing matches" }, {
    agent_id: "sub1",
  });
  toolCall(db, "s1", "2026-03-01 10:02:00", "Edit", { file_path: "/repo/a.ts" });
  toolCall(db, "s1", "2026-03-01 10:03:00", "Write", { file_path: "/repo/b.ts" }, { agent_id: "sub1" });
  toolCall(db, "s1", "2026-03-01 10:03:30", "Bash", { command: "ls" });
  propose(db, "s1", "2026-03-01 10:04:00", 'Knowledge "a" published — searchable now at reduced confidence until its fact-check against the repository passes.');
  propose(db, "s1", "2026-03-01 10:05:00", 'Draft "b" saved for human review — it is not searchable until a human accepts it.');
  propose(
    db,
    "s1",
    "2026-03-01 10:06:00",
    'standup tool "propose_knowledge" failed: standup collector request failed (400): body is required'
  );
  event(db, "s1", "2026-03-01 10:07:00", { reason: "contribute" }, CONTRIBUTE_NUDGE_EVENT_TYPE);
  // The subagent's own row is not a separate session in the default listing.
  session(db, "s1:sub1", "p", "2026-03-01 10:01:20", {
    parentSessionId: "s1",
    kind: "subagent",
    agentId: "sub1",
    agentType: "executor",
  });

  // s2: edits first, then searches, and proposes into an existing doc.
  session(db, "s2", "p", "2026-03-01 11:00:00");
  toolCall(db, "s2", "2026-03-01 11:01:00", "MultiEdit", { file_path: "/repo/c.ts" });
  toolCall(db, "s2", "2026-03-01 11:02:00", "mcp__standup__search_knowledge", { query: "late" });
  propose(db, "s2", "2026-03-01 11:03:00", "p/a already covers this: nothing was added.");

  // s3: no knowledge activity at all; s4: another project; s5: before the window.
  session(db, "s3", "p", "2026-03-01 12:00:00");
  session(db, "s4", "q", "2026-03-01 12:30:00");
  toolCall(db, "s4", "2026-03-01 12:31:00", "NotebookEdit", { notebook_path: "/repo/n.ipynb" });
  session(db, "s5", "p", "2026-02-01 12:00:00");
  return store;
}

describe("getSessionKnowledgeUsage", () => {
  test("reads injection, lookups, proposals, edits and nudges per session", () => {
    const store = seed();
    const rows = getSessionKnowledgeUsage(store.db, { projectId: "p", since: "2026-03-01T00:00:00Z" });
    expect(rows.map((r) => r.sessionId)).toEqual(["s3", "s2", "s1"]);

    const s1 = rows.find((r) => r.sessionId === "s1")!;
    expect(s1.projectId).toBe("p");
    expect(s1.title).toBe("T s1");
    expect(s1.startedAt).toBe("2026-03-01 10:00:00");
    expect(s1.injectedDocs).toEqual({ count: 2, slugs: ["inj-a", "inj-b"] });
    expect(s1.searches).toBe(3);
    expect(s1.docGets).toBe(1);
    expect(s1.topHitSlugs).toEqual(["hot", "warm"]);
    expect(s1.proposals).toEqual({ calls: 3, published: 1, drafts: 1, refused: 1 });
    expect(s1.subagentKbCalls).toBe(1);
    expect(s1.edits).toBe(2);
    expect(s1.searchedBeforeFirstEdit).toBe(true);
    expect(s1.nudged).toBe(true);

    const s2 = rows.find((r) => r.sessionId === "s2")!;
    expect(s2.searches).toBe(1);
    expect(s2.edits).toBe(1);
    expect(s2.searchedBeforeFirstEdit).toBe(false);
    expect(s2.proposals).toEqual({ calls: 1, published: 0, drafts: 0, refused: 1 });
    expect(s2.nudged).toBe(false);

    const s3 = rows.find((r) => r.sessionId === "s3")!;
    expect(s3.searches + s3.docGets).toBe(0);
    expect(s3.edits).toBe(0);
    expect(s3.searchedBeforeFirstEdit).toBeNull();
    expect(s3.injectedDocs.count).toBe(0);
    store.close();
  });

  test("filters by session ids, window end and limit", () => {
    const store = seed();
    expect(getSessionKnowledgeUsage(store.db, { sessionIds: ["s4", "s1"] }).map((r) => r.sessionId)).toEqual([
      "s4",
      "s1",
    ]);
    expect(getSessionKnowledgeUsage(store.db, { sessionIds: [] })).toEqual([]);
    expect(
      getSessionKnowledgeUsage(store.db, { since: "2026-03-01 00:00:00", until: "2026-03-01T11:30:00Z" }).map(
        (r) => r.sessionId
      )
    ).toEqual(["s2", "s1"]);
    expect(getSessionKnowledgeUsage(store.db, { limit: 2 }).map((r) => r.sessionId)).toEqual(["s4", "s3"]);
    store.close();
  });

  test("a database without the knowledge tables reads as no knowledge activity", () => {
    const store = seed();
    store.db.exec("DROP TABLE knowledge_retrievals");
    const rows = getSessionKnowledgeUsage(store.db, { sessionIds: ["s1"] });
    expect(rows[0].injectedDocs.count).toBe(0);
    expect(rows[0].topHitSlugs).toEqual([]);
    // The tool events alone still show the lookups and proposals.
    expect(rows[0].searches).toBe(2);
    expect(rows[0].proposals.calls).toBe(3);
    expect(summarizeKnowledgeUsage(rows, store.db).draftsPending).toBe(1);
    store.close();
  });
});

describe("summarizeKnowledgeUsage", () => {
  test("totals the rows, with before-edit as a share of editing sessions", () => {
    const store = seed();
    const rows = getSessionKnowledgeUsage(store.db, { since: "2026-03-01T00:00:00Z" });
    expect(summarizeKnowledgeUsage(rows)).toEqual({
      sessions: 4,
      searched: 2,
      searchedPct: 50,
      editing: 3,
      searchedBeforeEdit: 1,
      searchedBeforeEditPct: 33,
      proposed: 2,
      proposedPct: 50,
      proposalCalls: 4,
      draftsPending: 1,
      byHarness: {
        claude: {
          sessions: 4,
          searched: 2,
          searchedPct: 50,
          editing: 3,
          searchedBeforeEdit: 1,
          searchedBeforeEditPct: 33,
          proposed: 2,
          proposedPct: 50,
          proposalCalls: 4,
        },
      },
    });
    store.close();
  });

  test("counts drafts still pending review through the session's launch when given the database", () => {
    const store = seed();
    store.db.exec(
      `CREATE TABLE knowledge_drafts (id TEXT PRIMARY KEY, project_id TEXT, slug TEXT, status TEXT, generated_by_launch_id TEXT)`
    );
    store.db.run(
      "INSERT INTO knowledge_drafts VALUES ('d1', 'p', 'b', 'pending', 'L1'), ('d2', 'p', 'c', 'pending', 'L1'), ('d3', 'p', 'd', 'accepted', 'L1'), ('d4', 'p', 'e', 'pending', 'other')"
    );
    const rows = getSessionKnowledgeUsage(store.db, { projectId: "p" });
    expect(summarizeKnowledgeUsage(rows, store.db).draftsPending).toBe(2);
    expect(summarizeKnowledgeUsage([], store.db)).toMatchObject({ sessions: 0, searchedPct: 0, draftsPending: 0 });
    store.close();
  });

  test("counts pending drafts a session saved through propose_knowledge, without a launch", () => {
    const store = seed();
    const db = store.db;
    db.exec(
      `CREATE TABLE knowledge_drafts (id TEXT PRIMARY KEY, project_id TEXT, slug TEXT, status TEXT, generated_by_launch_id TEXT)`
    );
    session(db, "s6", "p", "2026-03-02 09:00:00");
    propose(db, "s6", "2026-03-02 09:01:00", 'Draft "loose" saved for human review — it is not searchable until a human accepts it.');
    propose(
      db,
      "s6",
      "2026-03-02 09:02:00",
      "Saved as a review draft replacing p/shared (another session wrote it); it goes live when a human accepts it."
    );
    db.run(
      "INSERT INTO knowledge_drafts VALUES ('d1', 'p', 'loose', 'pending', NULL), ('d2', 'p', 'shared', 'pending', NULL), ('d3', 'q', 'shared', 'pending', NULL), ('d4', 'p', 'other', 'pending', NULL)"
    );
    const rows = getSessionKnowledgeUsage(db, { sessionIds: ["s6"] });
    expect(summarizeKnowledgeUsage(rows, db).draftsPending).toBe(2);
    store.close();
  });

  test("a slug's _ and % are matched literally, and a slug-only reply counts only in the session's project", () => {
    const store = seed();
    const db = store.db;
    db.exec(
      `CREATE TABLE knowledge_drafts (id TEXT PRIMARY KEY, project_id TEXT, slug TEXT, status TEXT, generated_by_launch_id TEXT)`
    );
    upsertProject(db, { id: "q", name: "q", branch: "main", repos: [] });
    session(db, "s7", "p", "2026-03-02 09:00:00");
    propose(db, "s7", "2026-03-02 09:01:00", 'Draft "a_b" saved for human review — it is not searchable until a human accepts it.');
    propose(db, "s7", "2026-03-02 09:02:00", 'Draft "50%" saved for human review — it is not searchable until a human accepts it.');
    propose(db, "s7", "2026-03-02 09:03:00", 'Saved as a review draft replacing "c_d" (another session wrote it); it goes live when a human accepts it.');
    db.run(
      `INSERT INTO knowledge_drafts VALUES
         ('x1', 'p', 'a_b', 'pending', NULL), ('x2', 'p', 'axb', 'pending', NULL), ('x3', 'q', 'a_b', 'pending', NULL),
         ('x4', 'p', '50%', 'pending', NULL), ('x5', 'p', '5%', 'pending', NULL),
         ('x6', 'p', 'c_d', 'pending', NULL), ('x7', 'p', 'cxd', 'pending', NULL), ('x8', 'q', 'c_d', 'pending', NULL)`
    );
    const rows = getSessionKnowledgeUsage(db, { sessionIds: ["s7"] });
    expect(summarizeKnowledgeUsage(rows, db).draftsPending).toBe(3);
    store.close();
  });
});

describe("proposal outcomes", () => {
  /** The first lines propose_knowledge returns (packages/mcp/src/tools.ts), followed by a nearest-docs line. */
  const NEAREST =
    '\nNearest existing docs: p/build "Build failed on arm64; saved for human review once" (similarity 0.71); p/pub "Why nothing was published" (similarity 0.64)';

  function outcomes(texts: string[]) {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
    session(store.db, "o1", "p", "2026-03-01 10:00:00");
    texts.forEach((t, i) => propose(store.db, "o1", `2026-03-01 10:0${i}:00`, t));
    const counts = getSessionKnowledgeUsage(store.db, { sessionIds: ["o1"] })[0]!.proposals;
    store.close();
    return counts;
  }

  test("a duplicate the collector suppressed is refused, not published", () => {
    expect(
      outcomes([
        'Proposal "x" duplicated the existing doc "y", so nothing new was published — that doc already covers it.',
        "Proposal \"x\" duplicates p/y; nothing was published.",
        "p/y (your own doc) already covers this: nothing was added. If this corrects or extends it, propose_knowledge with slug \"y\" to update it in place.",
        'q/y already covers this: nothing was added. If this corrects or extends it, propose_knowledge with slug "y" and project "q" — it is saved as a review draft replacing that doc.',
      ])
    ).toEqual({ calls: 4, published: 0, drafts: 0, refused: 4 });
  });

  test("only the first line decides, so nearest-doc titles do not misclassify", () => {
    expect(
      outcomes([
        'Knowledge "a" published — searchable now at reduced confidence until its fact-check against the repository passes.' + NEAREST,
        'Knowledge "b" published — searchable now at reduced confidence until its fact-check against the repository passes (it replaced your existing doc of the same name).',
        'Draft "c" saved for human review — it is not searchable until a human accepts it.' + NEAREST,
        "Saved as a review draft replacing p/d (another session wrote it); it goes live when a human accepts it." + NEAREST,
        'standup tool "propose_knowledge" failed: standup collector request failed (400): body is required',
        'standup tool "propose_knowledge" failed: standup collector request failed (409): the slug "e" was published elsewhere',
      ])
    ).toEqual({ calls: 6, published: 2, drafts: 2, refused: 2 });
  });
});

describe("lookups and filters", () => {
  test("a doc fetched by id counts once, resolved to its slug through the retrieval row", () => {
    const store = createStore(":memory:");
    const db = store.db;
    upsertProject(db, { id: "p", name: "p", branch: "main", repos: [] });
    session(db, "g1", "p", "2026-03-01 10:00:00");
    toolCall(db, "g1", "2026-03-01 10:01:00", "mcp__standup__get_knowledge_doc", { id: "doc-uuid-1" });
    toolCall(db, "g1", "2026-03-01 10:02:00", "mcp__standup__get_knowledge_doc", { id: "doc-uuid-2" });
    recordRetrievals(db, [
      { docProject: "p", docSlug: "deploys", query: "doc-uuid-1", rank: 0, surface: "doc_get", sessionId: "g1" },
    ]);
    // The second fetch left no retrieval row; its id still counts.
    expect(getSessionKnowledgeUsage(db, { sessionIds: ["g1"] })[0]!.docGets).toBe(2);
    store.close();
  });

  test("include filters before the limit", () => {
    const store = seed();
    const rows = getSessionKnowledgeUsage(store.db, { include: (id) => id !== "s4" && id !== "s3", limit: 2 });
    expect(rows.map((r) => r.sessionId)).toEqual(["s2", "s1"]);
    store.close();
  });

  test("a lookup and an edit in the same second read as looked-up-first", () => {
    const store = createStore(":memory:");
    const db = store.db;
    upsertProject(db, { id: "p", name: "p", branch: "main", repos: [] });
    session(db, "t1", "p", "2026-03-01 10:00:00");
    toolCall(db, "t1", "2026-03-01 10:01:00", "Edit", { file_path: "/repo/a.ts" });
    toolCall(db, "t1", "2026-03-01 10:01:00", "mcp__standup__search_knowledge", { query: "q" });
    expect(getSessionKnowledgeUsage(db, { sessionIds: ["t1"] })[0]!.searchedBeforeFirstEdit).toBe(true);
    store.close();
  });
});

describe("harnesses", () => {
  const MCP_PUBLISHED = JSON.stringify(
    { content: [{ type: "text", text: 'Knowledge "n" published — searchable now at reduced confidence.' }] },
    null,
    2
  );

  function codexSeed() {
    const store = createStore(":memory:");
    const db = store.db;
    upsertProject(db, { id: "p", name: "p", branch: "main", repos: [] });

    // c1: searches, then patches a file, then proposes.
    launchedSession(db, "c1", "codex", "2026-03-01 10:00:00");
    codexTool(db, "c1", "2026-03-01 10:01:00", "mcp__standup__search_knowledge", { query: "codex q" }, "{}");
    codexTool(db, "c1", "2026-03-01 10:02:00", "ApplyPatch", { changes: [{ path: "/repo/a.ts", changeKind: "update" }] });
    codexTool(db, "c1", "2026-03-01 10:02:30", "Bash", { command: "ls" });
    codexTool(db, "c1", "2026-03-01 10:03:00", "mcp__standup__propose_knowledge", { slug: "n" }, MCP_PUBLISHED);
    // c2: patches before it searches.
    launchedSession(db, "c2", "codex", "2026-03-01 11:00:00");
    codexTool(db, "c2", "2026-03-01 11:01:00", "ApplyPatch", { changes: [] });
    codexTool(db, "c2", "2026-03-01 11:01:30", "apply_patch");
    codexTool(db, "c2", "2026-03-01 11:02:00", "mcp__standup__search_knowledge", { query: "late" });
    // k1: a Claude session whose transcript repeats its hook-recorded calls.
    launchedSession(db, "k1", "claude", "2026-03-01 12:00:00");
    toolCall(db, "k1", "2026-03-01 12:01:00", "mcp__standup__search_knowledge", { query: "claude q" });
    toolCall(db, "k1", "2026-03-01 12:02:00", "Edit", { file_path: "/repo/b.ts" });
    codexTool(db, "k1", "2026-03-01 12:01:00", "mcp__standup__search_knowledge", { query: "claude q" });
    codexTool(db, "k1", "2026-03-01 12:02:00", "Edit", { file_path: "/repo/b.ts" });
    // x1: a harness this reader does not know.
    launchedSession(db, "x1", "gemini", "2026-03-01 13:00:00");
    return store;
  }

  test("a Codex session's transcript tool calls count as edits and lookups", () => {
    const store = codexSeed();
    const rows = getSessionKnowledgeUsage(store.db, { sessionIds: ["c1", "c2"] });
    const c1 = rows.find((r) => r.sessionId === "c1")!;
    expect(c1.harness).toBe("codex");
    expect(c1.edits).toBe(1);
    expect(c1.searches).toBe(1);
    expect(c1.searchedBeforeFirstEdit).toBe(true);
    expect(c1.proposals).toEqual({ calls: 1, published: 1, drafts: 0, refused: 0 });

    const c2 = rows.find((r) => r.sessionId === "c2")!;
    expect(c2.edits).toBe(2);
    expect(c2.searches).toBe(1);
    expect(c2.searchedBeforeFirstEdit).toBe(false);
    store.close();
  });

  test("a Claude session reads only its hook events, not the transcript that repeats them", () => {
    const store = codexSeed();
    const k1 = getSessionKnowledgeUsage(store.db, { sessionIds: ["k1"] })[0]!;
    expect(k1.harness).toBe("claude");
    expect(k1.edits).toBe(1);
    expect(k1.searches).toBe(1);
    expect(k1.searchedBeforeFirstEdit).toBe(true);
    store.close();
  });

  test("a search with both a retrieval row and a transcript tool call counts once", () => {
    const store = codexSeed();
    const db = store.db;
    recordRetrievals(db, [
      { docProject: "p", docSlug: "hot", query: "codex q", rank: 0, surface: "search", sessionId: "c1" },
      { docProject: "p", docSlug: "warm", query: "codex q", rank: 1, surface: "search", sessionId: "c1" },
      { docProject: "p", docSlug: "hot", query: "doc-id-1", rank: 0, surface: "doc_get", sessionId: "c1" },
    ]);
    setRetrievalTimes(db, "c1", "2026-03-01 10:01:00");
    codexTool(db, "c1", "2026-03-01 10:01:10", "mcp__standup__get_knowledge_doc", { id: "doc-id-1" });
    const c1 = getSessionKnowledgeUsage(db, { sessionIds: ["c1"] })[0]!;
    expect(c1.searches).toBe(1);
    expect(c1.docGets).toBe(1);
    expect(c1.topHitSlugs).toEqual(["hot", "warm"]);
    store.close();
  });

  test("the summary splits the counts by harness", () => {
    const store = codexSeed();
    const rows = getSessionKnowledgeUsage(store.db, {});
    expect(rows.map((r) => [r.sessionId, r.harness])).toEqual([
      ["x1", "other"],
      ["k1", "claude"],
      ["c2", "codex"],
      ["c1", "codex"],
    ]);
    const summary = summarizeKnowledgeUsage(rows);
    expect(summary).toMatchObject({ sessions: 4, editing: 3, searchedBeforeEdit: 2, proposalCalls: 1 });
    expect(summary.byHarness).toEqual({
      claude: {
        sessions: 1,
        searched: 1,
        searchedPct: 100,
        editing: 1,
        searchedBeforeEdit: 1,
        searchedBeforeEditPct: 100,
        proposed: 0,
        proposedPct: 0,
        proposalCalls: 0,
      },
      codex: {
        sessions: 2,
        searched: 2,
        searchedPct: 100,
        editing: 2,
        searchedBeforeEdit: 1,
        searchedBeforeEditPct: 50,
        proposed: 1,
        proposedPct: 50,
        proposalCalls: 1,
      },
      other: {
        sessions: 1,
        searched: 0,
        searchedPct: 0,
        editing: 0,
        searchedBeforeEdit: 0,
        searchedBeforeEditPct: 0,
        proposed: 0,
        proposedPct: 0,
        proposalCalls: 0,
      },
    });
    expect(summarizeKnowledgeUsage([]).byHarness).toEqual({});
    store.close();
  });

  test("transcript records that are not valid JSON or carry no tool calls are skipped", () => {
    const store = codexSeed();
    const db = store.db;
    transcript(db, "c1", "2026-03-01 10:04:00", "{not json");
    transcript(db, "c1", "2026-03-01 10:04:00", { type: "assistant", message: { role: "assistant", content: "text" } });
    transcript(db, "c1", "2026-03-01 10:04:00", { type: "user", message: { role: "user", content: "hello" } });
    const c1 = getSessionKnowledgeUsage(db, { sessionIds: ["c1"] })[0]!;
    expect(c1.edits).toBe(1);
    expect(c1.searches).toBe(1);
    store.close();
  });
});
