import { expect, test, describe, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createStore,
  upsertProject,
  getSession,
  createLaunch,
  attachSessionToLaunch,
  createAsk,
  setSetting,
  CONTRIBUTE_NUDGE_EVENT_TYPE,
} from "@standup/store";
import type { Store } from "@standup/store";
import type { HarnessId } from "@standup/shared";
import { createServer } from "./server.js";
import { CONTRIBUTE_NUDGE_REASON } from "./contribute-nudge.js";
import { launchCarriesKnowledgeSteering } from "./launcher.js";

/**
 * The Stop-hook contribute nudge, driven through the real /hook route: a
 * launched worker that edited files and never proposed knowledge has its first
 * stop blocked with the reminder, and only that one.
 */

const SESSION = "sess-worker";

function setUp(
  opts: { launched?: boolean; harness?: HarnessId; launchArgs?: string } = {}
): { store: Store; app: ReturnType<typeof createServer> } {
  const store = createStore(":memory:");
  upsertProject(store.db, {
    id: "p",
    name: "p",
    branch: "main",
    repos: ["/repo"],
    ...(opts.launchArgs ? { launchArgs: opts.launchArgs } : {}),
  });
  if (opts.launched ?? true) {
    createLaunch(store.db, {
      id: "L1",
      projectId: "p",
      task: "t",
      worktreePath: "/repo",
      branch: "b",
      harness: opts.harness ?? "claude",
    });
    attachSessionToLaunch(store.db, "L1", SESSION);
  }
  const app = createServer(store, () => {}, null);
  return { store, app };
}

async function hook(app: ReturnType<typeof createServer>, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await app.request("/hook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: SESSION, cwd: "/repo", transcript_path: "/t.jsonl", ...body }),
  });
  return (await res.json()) as Record<string, unknown>;
}

async function toolUse(app: ReturnType<typeof createServer>, tool: string, extra: Record<string, unknown> = {}) {
  await hook(app, { hook_event_name: "PostToolUse", tool_name: tool, tool_input: {}, ...extra });
}

async function edits(app: ReturnType<typeof createServer>, n: number) {
  const tools = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
  for (let i = 0; i < n; i++) await toolUse(app, tools[i % tools.length]!);
}

function stop(app: ReturnType<typeof createServer>, extra: Record<string, unknown> = {}) {
  return hook(app, { hook_event_name: "Stop", ...extra });
}

function nudgeRows(store: Store): number {
  return (
    store.db
      .query("SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND type = ?")
      .get(SESSION, CONTRIBUTE_NUDGE_EVENT_TYPE) as { n: number }
  ).n;
}

const savedKillSwitch = process.env.STANDUP_CONTRIBUTE_NUDGE;
afterEach(() => {
  if (savedKillSwitch === undefined) delete process.env.STANDUP_CONTRIBUTE_NUDGE;
  else process.env.STANDUP_CONTRIBUTE_NUDGE = savedKillSwitch;
});

describe("Stop hook contribute nudge", () => {
  test("blocks the first stop of an editing worker that never proposed, without idling it", async () => {
    const { store, app } = setUp();
    await edits(app, 3);

    const out = await stop(app);
    expect(out).toEqual({ decision: "block", reason: CONTRIBUTE_NUDGE_REASON });
    expect(getSession(store.db, SESSION)?.status).not.toBe("idle");
    expect(nudgeRows(store)).toBe(1);
    store.close();
  });

  test("nudges only once: the next stop goes idle", async () => {
    const { store, app } = setUp();
    await edits(app, 3);
    await stop(app);

    expect(await stop(app)).toEqual({ ok: true });
    expect(getSession(store.db, SESSION)?.status).toBe("idle");
    expect(nudgeRows(store)).toBe(1);
    store.close();
  });

  test("a recorded nudge suppresses another on a later turn", async () => {
    const { store, app } = setUp();
    await edits(app, 3);
    await stop(app);
    await stop(app);
    await hook(app, { hook_event_name: "UserPromptSubmit", prompt: "more" });
    await edits(app, 3);

    expect(await stop(app)).toEqual({ ok: true });
    expect(nudgeRows(store)).toBe(1);
    store.close();
  });

  test("no nudge when the stop is already a Stop-hook continuation", async () => {
    const { store, app } = setUp();
    await edits(app, 3);

    expect(await stop(app, { stop_hook_active: true })).toEqual({ ok: true });
    expect(getSession(store.db, SESSION)?.status).toBe("idle");
    expect(nudgeRows(store)).toBe(0);
    store.close();
  });

  test("no nudge once the session proposed knowledge", async () => {
    const { store, app } = setUp();
    await edits(app, 3);
    await toolUse(app, "mcp__standup__propose_knowledge");

    expect(await stop(app)).toEqual({ ok: true });
    store.close();
  });

  test("a subagent's propose_knowledge counts for the parent", async () => {
    const { store, app } = setUp();
    await edits(app, 3);
    await toolUse(app, "mcp__standup__propose_knowledge", { agent_id: "agent-1" });

    expect(await stop(app)).toEqual({ ok: true });
    store.close();
  });

  test("no nudge with fewer than three edits", async () => {
    const { store, app } = setUp();
    await edits(app, 2);
    await toolUse(app, "Read");
    await toolUse(app, "Bash");

    expect(await stop(app)).toEqual({ ok: true });
    store.close();
  });

  test("no nudge when STANDUP_CONTRIBUTE_NUDGE=0", async () => {
    process.env.STANDUP_CONTRIBUTE_NUDGE = "0";
    const { store, app } = setUp();
    await edits(app, 3);

    expect(await stop(app)).toEqual({ ok: true });
    expect(nudgeRows(store)).toBe(0);
    store.close();
  });

  test("no nudge for a session no launch started", async () => {
    const { store, app } = setUp({ launched: false });
    await edits(app, 3);

    expect(await stop(app)).toEqual({ ok: true });
    expect(getSession(store.db, SESSION)?.status).toBe("idle");
    store.close();
  });

  test("no nudge while the session has a pending ask", async () => {
    const { store, app } = setUp();
    await edits(app, 3);
    createAsk(store.db, SESSION, "ask_human", "which one?");

    expect(await stop(app)).toEqual({ ok: true });
    store.close();
  });

  test("a stored knowledge_first_enabled=0 is ignored", async () => {
    const { store, app } = setUp();
    setSetting(store.db, "knowledge_first_enabled", "0");
    await edits(app, 3);

    expect(await stop(app)).toEqual({ decision: "block", reason: CONTRIBUTE_NUDGE_REASON });
    expect(nudgeRows(store)).toBe(1);
    store.close();
  });

  test("no nudge for a Codex launch whose config.toml doesn't register standup", async () => {
    // A Codex launch carries the steering only through its own config.toml,
    // which CODEX_HOME points at an empty scratch copy of.
    const codexHome = mkdtempSync(join(tmpdir(), "standup-nudge-codex-home-"));
    const saved = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      const { store, app } = setUp({ harness: "codex" });
      await edits(app, 3);

      expect(await stop(app)).toEqual({ ok: true });
      expect(nudgeRows(store)).toBe(0);
      store.close();
    } finally {
      if (saved === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = saved;
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test("a Codex launch whose config.toml registers standup is nudged like a Claude one", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "standup-nudge-codex-home-"));
    writeFileSync(join(codexHome, "config.toml"), '[mcp_servers.standup]\ncommand = "bun"\n');
    const saved = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      const { store, app } = setUp({ harness: "codex" });
      await edits(app, 3);

      expect(await stop(app)).toEqual({ decision: "block", reason: CONTRIBUTE_NUDGE_REASON });
      expect(nudgeRows(store)).toBe(1);
      store.close();
    } finally {
      if (saved === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = saved;
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test("no nudge when the project's launchArgs strip the standup MCP server", async () => {
    const { store, app } = setUp({ launchArgs: "--strict-mcp-config --mcp-config /x.json" });
    await edits(app, 3);

    expect(await stop(app)).toEqual({ ok: true });
    expect(nudgeRows(store)).toBe(0);
    store.close();
  });
});

describe("launchCarriesKnowledgeSteering", () => {
  test("applies the opening prompt's gates, reading an unrecorded harness as Claude", () => {
    expect(launchCarriesKnowledgeSteering({ harness: undefined }, null)).toBe(true);
    expect(launchCarriesKnowledgeSteering({ harness: "claude" }, { launchArgs: "--verbose" })).toBe(true);
    // A codex launch carries it only when its own config.toml registers the server.
    const home = mkdtempSync(join(tmpdir(), "standup-nudge-codex-"));
    const env = { HOME: home };
    expect(launchCarriesKnowledgeSteering({ harness: "codex" }, null, env)).toBe(false);
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), '[mcp_servers.standup]\ncommand = "bun"\n');
    expect(launchCarriesKnowledgeSteering({ harness: "codex" }, null, env)).toBe(true);
    rmSync(home, { recursive: true, force: true });
    expect(launchCarriesKnowledgeSteering({ harness: "claude" }, { launchArgs: "--strict-mcp-config" })).toBe(false);
  });
});
