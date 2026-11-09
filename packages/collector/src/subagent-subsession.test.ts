import { expect, test, describe, afterAll } from "bun:test";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  createStore,
  upsertProject,
  getSession,
  getAllSessions,
  getChildSessions,
  createLaunch,
  attachSessionToLaunch,
  recordRetrievals,
  setSetting,
} from "@standup/store";
import type { Store } from "@standup/store";
import { createServer } from "./server.js";
import { buildSubagentKnowledgeContext } from "./launcher.js";

/**
 * SubagentStart/SubagentStop → nested subsessions. Driven end-to-end through the
 * real /hook route so the switch case, the synthetic-id upsert, the roots-only
 * list filter, and the subagent transcript wiring are all exercised together.
 *
 * The parent session_id in the payload IS the parent — ensureSession stamps it
 * as a root; the subagent becomes a CHILD keyed `${parent}:${agentId}`, never a
 * second root on the parent's id.
 */

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function setUp(): { store: Store; app: ReturnType<typeof createServer> } {
  const store = createStore(":memory:");
  // The parent hook's cwd is under this repo, so ensureSession homes the parent
  // (and the inheriting child) under project "p" — no dependency on the reserved
  // "scratch" project the real collector auto-ensures on boot.
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: ["/repo"] });
  const app = createServer(store, () => {}, null);
  return { store, app };
}

const PARENT = "sess-parent";

function hook(app: ReturnType<typeof createServer>, body: Record<string, unknown>) {
  return app.request("/hook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function subagentStart(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: PARENT,
    cwd: "/repo",
    transcript_path: "/parent.jsonl",
    hook_event_name: "SubagentStart",
    agent_type: "code-reviewer",
    agent_id: "agent-1",
    ...extra,
  };
}

const CHILD = `${PARENT}:agent-1`;

describe("SubagentStart", () => {
  test("creates a nested child row (synthetic id, parent link, kind='subagent') and no extra root", async () => {
    const { store, app } = setUp();
    await hook(app, subagentStart());

    const child = getSession(store.db, CHILD);
    expect(child).not.toBeNull();
    expect(child?.parentSessionId).toBe(PARENT);
    expect(child?.kind).toBe("subagent");
    expect(child?.agentType).toBe("code-reviewer");
    expect(child?.agentId).toBe("agent-1");
    expect(child?.status).toBe("running");

    // The parent's id is a single ROOT row — the subagent did not spawn a second
    // root, and the child is excluded from the flat list.
    expect(getAllSessions(store.db).map((s) => s.id)).toEqual([PARENT]);
    expect(getChildSessions(store.db, PARENT).map((s) => s.id)).toEqual([CHILD]);
    store.close();
  });

  test("is idempotent on a redelivered SubagentStart (one child, not two)", async () => {
    const { store, app } = setUp();
    await hook(app, subagentStart());
    await hook(app, subagentStart());

    expect(getChildSessions(store.db, PARENT)).toHaveLength(1);
    expect(getAllSessions(store.db)).toHaveLength(1);
    store.close();
  });

  test("an unnamed subagent (empty agent_type) is skipped — no child", async () => {
    const { store, app } = setUp();
    await hook(app, subagentStart({ agent_type: "" }));

    expect(getChildSessions(store.db, PARENT)).toHaveLength(0);
    store.close();
  });
});

describe("SubagentStart knowledge context", () => {
  type SubagentStartOutput = {
    hookSpecificOutput?: { hookEventName: string; additionalContext: string };
  };

  /** Launches PARENT and records the docs its opening prompt was injected with. */
  function launchParent(store: Store): void {
    createLaunch(store.db, {
      id: "L-parent",
      projectId: "p",
      task: "t",
      worktreePath: "/repo",
      branch: "standup/L-parent",
      harness: "claude",
    });
    attachSessionToLaunch(store.db, "L-parent", PARENT);
    recordRetrievals(store.db, [
      { docProject: "p", docSlug: "beta", query: "q", rank: 1, surface: "inject", injected: true, launchId: "L-parent" },
      { docProject: "p", docSlug: "alpha", query: "q", rank: 0, surface: "inject", injected: true, launchId: "L-parent" },
      { docProject: "p", docSlug: "alpha", query: "q2", rank: 2, surface: "inject", injected: true, launchId: "L-parent" },
    ]);
  }

  async function startOutput(app: ReturnType<typeof createServer>): Promise<SubagentStartOutput> {
    const res = await hook(app, subagentStart());
    return (await res.json()) as SubagentStartOutput;
  }

  test("a launched session's subagent gets the steering line and the parent's injected docs", async () => {
    const { store, app } = setUp();
    launchParent(store);

    const out = await startOutput(app);
    expect(out.hookSpecificOutput?.hookEventName).toBe("SubagentStart");
    const ctx = out.hookSpecificOutput?.additionalContext ?? "";
    expect(ctx).toContain(
      "call search_knowledge (mcp__standup__search_knowledge) before implementing, open the most relevant " +
        "with get_knowledge_doc (pass its slug and project), and include any durable non-obvious finding " +
        "in your final report to the parent so it can propose_knowledge"
    );
    expect(ctx).toContain("- p/alpha\n- p/beta");
    expect(ctx.length).toBeLessThan(1200);
    // The child row is still created alongside the context.
    expect(getSession(store.db, CHILD)?.kind).toBe("subagent");
    store.close();
  });

  test("the steering line is sent even when the launch had no injected docs", async () => {
    const { store, app } = setUp();
    createLaunch(store.db, { id: "L-bare", projectId: "p", task: "t", worktreePath: "/repo", branch: "b", harness: "claude" });
    attachSessionToLaunch(store.db, "L-bare", PARENT);

    const ctx = (await startOutput(app)).hookSpecificOutput?.additionalContext ?? "";
    expect(ctx).toContain("call search_knowledge");
    expect(ctx).not.toContain("injected into your parent");
    store.close();
  });

  test("an unlaunched session's subagent gets no context", async () => {
    const { store, app } = setUp();
    const out = await startOutput(app);
    expect(out.hookSpecificOutput).toBeUndefined();
    expect(getSession(store.db, CHILD)).not.toBeNull();
    store.close();
  });

  test("an unnamed helper subagent (empty agent_type) gets no context", async () => {
    const { store, app } = setUp();
    launchParent(store);
    const res = await hook(app, subagentStart({ agent_type: "" }));
    expect(((await res.json()) as SubagentStartOutput).hookSpecificOutput).toBeUndefined();
    store.close();
  });

  test("a stored knowledge_first_enabled=0 is ignored", async () => {
    const { store, app } = setUp();
    launchParent(store);
    setSetting(store.db, "knowledge_first_enabled", "0");

    expect((await startOutput(app)).hookSpecificOutput?.additionalContext ?? "").toContain("call search_knowledge");
    store.close();
  });

  test("no context when the project's launchArgs strip the standup MCP server", async () => {
    const { store, app } = setUp();
    upsertProject(store.db, {
      id: "p",
      name: "p",
      branch: "main",
      repos: ["/repo"],
      launchArgs: "--strict-mcp-config --mcp-config /x.json",
    });
    launchParent(store);

    expect((await startOutput(app)).hookSpecificOutput).toBeUndefined();
    store.close();
  });
});

describe("buildSubagentKnowledgeContext", () => {
  test("lists at most six docs as project/slug — title and stays under the budget", () => {
    const docs = Array.from({ length: 9 }, (_, i) => ({
      docProject: "some-project",
      docSlug: `a-fairly-long-knowledge-doc-slug-number-${i}`,
      title: "T".repeat(200),
    }));
    const ctx = buildSubagentKnowledgeContext(docs);
    expect(ctx.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(6);
    expect(ctx).toContain("- some-project/a-fairly-long-knowledge-doc-slug-number-0 — T");
    expect(ctx).not.toContain("number-6");
    expect(ctx.length).toBeLessThan(1200);
  });

  test("stays within the budget with six very long projects, slugs and titles", () => {
    const docs = Array.from({ length: 6 }, (_, i) => ({
      docProject: `project-${"p".repeat(300)}`,
      docSlug: `slug-${i}-${"s".repeat(500)}`,
      title: "T".repeat(500),
    }));
    const ctx = buildSubagentKnowledgeContext(docs);
    const listed = ctx.split("\n").filter((l) => l.startsWith("- "));
    expect(listed).toHaveLength(6);
    expect(listed.every((l) => l.length <= 128 && l.endsWith("…"))).toBe(true);
    expect(ctx.length).toBeLessThanOrEqual(1200);

    const longSlugs = buildSubagentKnowledgeContext(
      docs.map((_d, i) => ({ docProject: "p", docSlug: `slug-${i}-${"s".repeat(110)}`, title: "Short title" }))
    );
    expect(longSlugs.length).toBeLessThanOrEqual(1200);
    expect(longSlugs).toContain(`- p/slug-0-${"s".repeat(110)}`);
  });
});

describe("SubagentStop", () => {
  test("closes the child (status done)", async () => {
    const { store, app } = setUp();
    await hook(app, subagentStart());
    await hook(app, {
      session_id: PARENT,
      cwd: "/repo",
      transcript_path: "/parent.jsonl",
      hook_event_name: "SubagentStop",
      agent_type: "code-reviewer",
      agent_id: "agent-1",
      last_assistant_message: "done reviewing",
    });

    const child = getSession(store.db, CHILD);
    expect(child?.status).toBe("done");
    store.close();
  });

  test("upserts the child even when only SubagentStop arrives (no preceding Start)", async () => {
    const { store, app } = setUp();
    await hook(app, {
      session_id: PARENT,
      cwd: "/repo",
      transcript_path: "/parent.jsonl",
      hook_event_name: "SubagentStop",
      agent_type: "tester",
      agent_id: "agent-9",
      last_assistant_message: "tests pass",
    });

    const child = getSession(store.db, `${PARENT}:agent-9`);
    expect(child?.kind).toBe("subagent");
    expect(child?.status).toBe("done");
    store.close();
  });
});

describe("subagent transcript is served via the existing endpoints", () => {
  // The subagent's dedicated per-invocation JSONL. Its records carry the
  // subagent's OWN real session UUID — NOT the synthetic child id
  // `${parent}:${agentId}` the child row is keyed by (in production this is the
  // parent's UUID or the subagent's own; either way it never equals the child
  // id). This is the production record shape: a session-scoped filter on the
  // child id would reject every record, so these endpoints must skip it.
  const AGENT_SESSION_UUID = "98a955d2-4c1e-4b3a-9f2d-0123456789ab";

  async function writeAgentTranscript(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "standup-subagent-"));
    dirs.push(dir);
    const agentTranscript = join(dir, "agent.jsonl");
    const record = (uuid: string, text: string) =>
      JSON.stringify({
        type: "assistant",
        uuid,
        sessionId: AGENT_SESSION_UUID,
        timestamp: "2026-01-01T00:00:00Z",
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
    await writeFile(
      agentTranscript,
      record("u1", "hi from the subagent") + "\n" + record("u2", "second subagent message") + "\n"
    );
    return agentTranscript;
  }

  // Sanity: the fixture's real sessionId is not the synthetic child id, so these
  // tests genuinely exercise the skip-filter path (a fixture that matched, or
  // that omitted sessionId, would pass even against the broken session-filtered
  // read and mask the defect).
  test("fixture sessionId differs from the synthetic child id (exercises the real path)", () => {
    expect(AGENT_SESSION_UUID).not.toBe(CHILD);
  });

  test("GET /api/sessions/:childId/transcript returns the subagent's messages", async () => {
    // Store intentionally left open (see the note at the end) — the fire-and-
    // forget child ingest must not race a close, so this test drives `app` only.
    const { app } = setUp();
    const agentTranscript = await writeAgentTranscript();

    await hook(app, subagentStart({ agent_transcript_path: agentTranscript }));

    const res = await app.request(`/api/sessions/${encodeURIComponent(CHILD)}/transcript`);
    expect(res.status).toBe(200);
    const page = (await res.json()) as { messages: Array<{ text: string }> };
    expect(page.messages.map((m) => m.text)).toContain("hi from the subagent");
    expect(page.messages.map((m) => m.text)).toContain("second subagent message");
    // Left open deliberately: the SubagentStart hook kicks a fire-and-forget
    // transcript ingest, so closing here would race that background read against
    // a closed DB. The process tears the store down at exit.
  });

  test("GET /api/sessions/:childId/transcript/rich returns the subagent's rows", async () => {
    const { app } = setUp();
    const agentTranscript = await writeAgentTranscript();

    await hook(app, subagentStart({ agent_transcript_path: agentTranscript }));

    const res = await app.request(
      `/api/sessions/${encodeURIComponent(CHILD)}/transcript/rich`
    );
    expect(res.status).toBe(200);
    const page = (await res.json()) as { rows: unknown[] };
    expect(page.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(page.rows)).toContain("hi from the subagent");
  });

  test("GET /api/sessions/:childId/transcript/events ingests the subagent's records into the durable log", async () => {
    const { app } = setUp();
    const agentTranscript = await writeAgentTranscript();

    // A distinct agent id — hence a distinct child id — so the module-level
    // ingest byte-offset cache (keyed by session id in transcript.ts) isn't
    // primed by a sibling test that reused the same child id with a different
    // temp file. In production a child id maps to one growing file, so this
    // only matters for tests that reuse an id across fixtures.
    const eventsChild = `${PARENT}:agent-events`;
    await hook(
      app,
      subagentStart({ agent_id: "agent-events", agent_transcript_path: agentTranscript })
    );

    const res = await app.request(
      `/api/sessions/${encodeURIComponent(eventsChild)}/transcript/events`
    );
    expect(res.status).toBe(200);
    const page = (await res.json()) as { events: Array<{ event: unknown }> };
    // The durable log is a complete mirror — both real records land, keyed under
    // the child id despite carrying the subagent's own (different) sessionId.
    expect(page.events.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(page.events)).toContain("hi from the subagent");
    expect(JSON.stringify(page.events)).toContain("second subagent message");
  });

  test("the subagent hook's own ingest nudges followers with session:event for the child", async () => {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: ["/repo"] });
    const frames: Array<{ type: string; payload: { sessionId?: string; seq?: number } }> = [];
    const app = createServer(store, (m) => frames.push(m as (typeof frames)[number]), null);
    const agentTranscript = await writeAgentTranscript();
    const nudgedChild = `${PARENT}:agent-nudge`;

    await hook(app, subagentStart({ agent_id: "agent-nudge", agent_transcript_path: agentTranscript }));

    const nudge = () =>
      frames.find((f) => f.type === "session:event" && f.payload.sessionId === nudgedChild);
    for (let i = 0; i < 100 && !nudge(); i++) await Bun.sleep(10);
    expect(nudge()?.payload.seq).toBe(2);
  });
});

describe("a ROOT session still filters its transcript by its own id (isolation intact)", () => {
  // Skipping the session filter is scoped to subagent children ONLY: a root's
  // JSONL can hold a resumed/compacted parent conversation whose copied records
  // keep their original (foreign) sessionId, so a root must keep filtering to
  // its own id or another session's turns leak into its view. This pins that the
  // skip-filter fix did not weaken root isolation.
  const ROOT = "sess-root-iso";
  const FOREIGN_SESSION = "11111111-2222-3333-4444-555555555555";

  test("GET /api/sessions/:rootId/transcript drops records carrying a foreign sessionId", async () => {
    const { store, app } = setUp();

    const dir = await mkdtemp(join(tmpdir(), "standup-root-iso-"));
    dirs.push(dir);
    const rootTranscript = join(dir, "root.jsonl");
    const record = (uuid: string, sessionId: string, text: string) =>
      JSON.stringify({
        type: "assistant",
        uuid,
        sessionId,
        timestamp: "2026-01-01T00:00:00Z",
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
    await writeFile(
      rootTranscript,
      record("own-1", ROOT, "mine, keep it") +
        "\n" +
        record("foreign-1", FOREIGN_SESSION, "another session, drop it") +
        "\n" +
        record("own-2", ROOT, "mine again, keep it") +
        "\n"
    );

    // A plain SessionStart materializes ROOT as a root row (kind is unset, not
    // 'subagent') and stamps the transcript pointer onto its event stream.
    await hook(app, {
      session_id: ROOT,
      cwd: "/repo",
      transcript_path: rootTranscript,
      hook_event_name: "SessionStart",
    });

    // A root's kind is not 'subagent', so the endpoint filters to its own id.
    expect(getSession(store.db, ROOT)?.kind ?? null).not.toBe("subagent");

    const res = await app.request(`/api/sessions/${encodeURIComponent(ROOT)}/transcript`);
    expect(res.status).toBe(200);
    const page = (await res.json()) as { messages: Array<{ text: string }> };
    const texts = page.messages.map((m) => m.text);
    expect(texts).toContain("mine, keep it");
    expect(texts).toContain("mine again, keep it");
    // The foreign session's turn never leaks into the root's transcript.
    expect(texts).not.toContain("another session, drop it");
    // Store left open deliberately: SessionStart kicks a fire-and-forget
    // transcript ingest, so closing here would race that background read
    // against a closed DB. The process tears the store down at exit.
  });
});
