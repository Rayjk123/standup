import { expect, test, describe, mock, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import {
  attachSessionToLaunch,
  createLaunch,
  createSession,
  createStore,
  getAsk,
  getPendingAsksBySession,
  getPermissionAskCandidateIds,
  getPermissionAskToolUseId,
  insertEvent,
  setLaunchWorkerTokenHash,
  upsertProject,
} from "@standup/store";
import type { Ask, WsMessage } from "@standup/shared";
import { OWNER_TOKEN_HEADER } from "@standup/shared/owner-token";
import { generateOwnerSecrets } from "./owner-secret.js";
import { FLOOR_HOLD_ROUTE, FLOOR_WORKER_TOKEN_HEADER, workerTokenHash, type FloorHoldRequest } from "./floor/gate.js";
import { classifyToolCall } from "./floor/classify.js";
import { buildLaunchFloorConfig } from "./floor/launch.js";
import type { AwsIdentity } from "./floor/aws-identity.js";
import {
  createPermissionAsk,
  noticeTarget,
  noticeToolName,
  staleCallReason,
  unanswerableReason,
  type HeldToolCall,
  type NoticeTarget,
} from "./held-call.js";
import { reconcileBlockedSessions } from "./reconcile.js";

/** A notice target tied to the call `toolUseId`. */
function tiedTo(toolUseId: string): NoticeTarget {
  const call: HeldToolCall = {
    toolName: "Bash",
    toolInput: {},
    toolUseId,
    event: { id: "0", sessionId: "", seq: 0, type: "PreToolUse", payload: {}, createdAt: new Date() },
  };
  return { call, candidates: [call] };
}

/*
 * Permission notices tied to the call behind the dialog. The scenarios run
 * background subagents side by side in one session: one subagent's call is
 * held by the safety floor and allowed, Claude Code's own check then opens a
 * dialog for it, and meanwhile other subagents' calls start and finish.
 */

import * as push from "./push.js";
const realPush = { ...push };
mock.module("./push.js", () => ({ ...realPush, pushNotification: mock(async () => {}) }));

const dirs: string[] = [];
afterAll(() => {
  mock.module("./push.js", () => realPush);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const { createServer } = await import("./server.js");

const noCredentials: AwsIdentity = { cached: () => null, resolve: async () => null };

const HELD_COMMAND = "rm -rf /tmp/some-other-checkout";
const HARMLESS_COMMAND = "cd packages/collector/src/floor; sed -n 1,82p process-substitution.test.ts > /tmp/harness-f.txt; wc -l /tmp/harness-f.txt";
/** The terminal UI's notice, which names no tool. */
const TUI_NOTICE = "Claude needs your permission";

function setUp() {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "P", branch: "main", repos: [] });
  const root = mkdtempSync(join(tmpdir(), "held-call-wt-"));
  dirs.push(root);
  const launchId = randomUUID();
  const sessionId = randomUUID();
  const workerToken = randomUUID() + randomUUID();
  createLaunch(store.db, { id: launchId, projectId: "p", task: "t", worktreePath: root, branch: "feature" });
  createSession(store.db, { id: sessionId, projectId: "p", title: "worker", cwd: root, status: "running" });
  attachSessionToLaunch(store.db, launchId, sessionId);
  setLaunchWorkerTokenHash(store.db, launchId, workerTokenHash(workerToken));
  const frames: WsMessage[] = [];
  const secrets = generateOwnerSecrets();
  const app = createServer(
    store,
    (m) => frames.push(m),
    null,
    undefined,
    undefined,
    "",
    "",
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    { ownerSecrets: secrets, awsIdentity: noCredentials }
  );

  const hook = (body: Record<string, unknown>) =>
    app.request("/hook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, cwd: root, ...body }),
    });
  const bash = (command: string) => ({ command });
  const pre = (toolUseId: string, agentId: string | undefined, toolInput: Record<string, unknown>, toolName = "Bash") =>
    hook({ hook_event_name: "PreToolUse", tool_use_id: toolUseId, tool_name: toolName, tool_input: toolInput, ...(agentId ? { agent_id: agentId } : {}) });
  const post = (toolUseId: string, agentId: string | undefined, toolInput: Record<string, unknown>, toolName = "Bash") =>
    hook({ hook_event_name: "PostToolUse", tool_use_id: toolUseId, tool_name: toolName, tool_input: toolInput, tool_response: {}, ...(agentId ? { agent_id: agentId } : {}) });
  const notice = (message = TUI_NOTICE) => hook({ hook_event_name: "Notification", notification_type: "permission_prompt", message });

  /** Starts the floor's hold of a Bash call (the hook's long-poll), resolving once its ask exists. */
  const floorHold = async (toolUseId: string, command: string): Promise<{ ask: Ask; reply: Promise<Response> }> => {
    const body: FloorHoldRequest = {
      session_id: sessionId,
      cwd: root,
      launch_id: launchId,
      request_id: toolUseId,
      tool_name: "Bash",
      tool_input: { command },
      hold: { category: "destructive", ownerOnly: false, reason: "deletes outside the worktree", step: command },
      wait_s: 30,
    };
    const reply = Promise.resolve(
      app.request(FLOOR_HOLD_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json", [FLOOR_WORKER_TOKEN_HEADER]: workerToken },
        body: JSON.stringify(body),
      })
    );
    for (let i = 0; i < 200; i++) {
      const row = store.db.query("SELECT id FROM asks WHERE request_id = ?").get(toolUseId) as { id: string } | null;
      if (row) return { ask: getAsk(store.db, row.id)!, reply };
      await Bun.sleep(5);
    }
    throw new Error(`no hold for ${toolUseId}`);
  };

  const resolve = (askId: string, answer: string) =>
    app.request(`/api/asks/${askId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", [OWNER_TOKEN_HEADER]: secrets.ownerToken },
      body: JSON.stringify({ answer }),
    });

  /** Holds `toolUseId`'s call on the floor and answers the hold, as Persona or the owner would. */
  const floorDecide = async (toolUseId: string, command: string, answer: "Allow once" | "Deny") => {
    const hold = await floorHold(toolUseId, command);
    expect((await resolve(hold.ask.id, answer)).status).toBe(200);
    await hold.reply;
    return hold.ask;
  };

  const permissionAsks = () => getPendingAsksBySession(store.db, sessionId).filter((a) => a.kind === "permission_prompt");
  const statusOf = (ask: Ask | undefined) => getAsk(store.db, ask!.id)?.status;

  return { store, app, root, sessionId, secrets, frames, hook, bash, pre, post, notice, floorHold, floorDecide, resolve, permissionAsks, statusOf };
}

describe("noticeToolName", () => {
  test("reads the tool the SDK's notice names; the terminal's names none", () => {
    expect(noticeToolName("Claude needs your permission to use Bash")).toBe("Bash");
    expect(noticeToolName("Claude needs your permission to use mcp__standup__checkpoint")).toBe("mcp__standup__checkpoint");
    expect(noticeToolName(TUI_NOTICE)).toBeUndefined();
    expect(noticeToolName(undefined)).toBeUndefined();
  });
});

describe("a dialog after the floor allowed a subagent's call", () => {
  test("is tied to that call, not to another subagent's call that ran meanwhile (the harness-f sed)", async () => {
    const h = setUp();
    await h.pre("toolu_E", "agent-e", h.bash(HELD_COMMAND));
    await h.floorDecide("toolu_E", HELD_COMMAND, "Allow once");
    await h.pre("toolu_F", "agent-f", h.bash(HARMLESS_COMMAND));
    await h.post("toolu_F", "agent-f", h.bash(HARMLESS_COMMAND));
    await h.notice();

    const [ask] = h.permissionAsks();
    expect(ask?.question).toContain(HELD_COMMAND);
    expect(ask?.question).not.toContain("harness-f");
    expect(getPermissionAskToolUseId(h.store.db, ask!.id)).toBe("toolu_E");
  });

  test("outlives other subagents' calls finishing and a new main-thread prompt; its own call finishing retires it", async () => {
    const h = setUp();
    await h.pre("toolu_E", "agent-e", h.bash(HELD_COMMAND));
    await h.floorDecide("toolu_E", HELD_COMMAND, "Allow once");
    await h.notice();
    const [ask] = h.permissionAsks();

    await h.pre("toolu_G", "agent-f", h.bash("ls"));
    await h.post("toolu_G", "agent-f", h.bash("ls"));
    await h.hook({ hook_event_name: "UserPromptSubmit", prompt: "<task-notification>…</task-notification>" });
    await h.hook({ hook_event_name: "Stop" });
    expect(h.statusOf(ask)).toBe("pending");

    await h.post("toolu_E", "agent-e", h.bash(HELD_COMMAND));
    expect(h.statusOf(ask)).toBe("cancelled");
    expect(h.frames.some((f) => f.type === "ask:resolved" && (f.payload as { askId: string }).askId === ask!.id)).toBe(true);
  });

  test("survives a main-thread Stop between the call and the notice, and a later Read (the owner.ts case)", async () => {
    const h = setUp();
    await h.pre("toolu_C", "agent-backend", h.bash(HELD_COMMAND));
    await h.floorDecide("toolu_C", HELD_COMMAND, "Allow once");
    await h.hook({ hook_event_name: "Stop" });
    const read = { file_path: join(h.root, "src/drafts/owner.ts") };
    await h.pre("toolu_D", "agent-ui", read, "Read");
    await h.post("toolu_D", "agent-ui", read, "Read");
    await h.notice();

    const [ask] = h.permissionAsks();
    expect(ask?.question).toContain(HELD_COMMAND);
    expect(ask?.question).not.toContain("owner.ts");
  });

  test("ends with its subagent: SubagentStop retires the ask", async () => {
    const h = setUp();
    await h.pre("toolu_E", "agent-e", h.bash(HELD_COMMAND));
    await h.floorDecide("toolu_E", HELD_COMMAND, "Allow once");
    await h.notice();
    const [ask] = h.permissionAsks();
    await h.hook({ hook_event_name: "SubagentStop", agent_id: "agent-e" });
    expect(h.statusOf(ask)).toBe("cancelled");
  });
});

describe("calls the floor decides for", () => {
  test("a call the floor still holds has no dialog yet, so it is never the one", async () => {
    const h = setUp();
    await h.pre("toolu_E", "agent-e", h.bash(HELD_COMMAND));
    const hold = await h.floorHold("toolu_E", HELD_COMMAND);
    expect(noticeTarget(h.store.db, h.sessionId)).toEqual({ call: null, candidates: [] });
    expect((await h.resolve(hold.ask.id, "Deny")).status).toBe(200);
    await hold.reply;
  });

  test("a call the floor refused never runs, so it is never the one", async () => {
    const h = setUp();
    await h.pre("toolu_E", "agent-e", h.bash(HELD_COMMAND));
    await h.floorDecide("toolu_E", HELD_COMMAND, "Deny");
    expect(noticeTarget(h.store.db, h.sessionId).candidates).toEqual([]);
  });

  test("a hold whose recorded call differs from the PreToolUse doesn't count for it", async () => {
    const h = setUp();
    await h.pre("toolu_R", "agent-a", h.bash("git push --force origin main"));
    const forged = await h.floorHold("toolu_R", "echo harmless");
    expect(noticeTarget(h.store.db, h.sessionId).call?.toolUseId).toBe("toolu_R");
    expect((await h.resolve(forged.ask.id, "Deny")).status).toBe(200);
    await forged.reply;
  });
});

describe("a notice the calls in flight leave ambiguous", () => {
  test("is tied to no call, lists the candidates, and stays until none is in flight", async () => {
    const h = setUp();
    await h.pre("toolu_A", "agent-a", h.bash("rm -rf $X/"));
    await h.pre("toolu_B", "agent-b", h.bash("bun test"));
    await h.notice();

    const [ask] = h.permissionAsks();
    expect(getPermissionAskToolUseId(h.store.db, ask!.id)).toBeNull();
    expect(ask?.question).toContain("one of 2 calls");
    expect(ask?.question).toContain("rm -rf $X/");
    expect(ask?.question).toContain("bun test");

    await h.post("toolu_B", "agent-b", h.bash("bun test"));
    expect(h.statusOf(ask)).toBe("pending");
    await h.post("toolu_A", "agent-a", h.bash("rm -rf $X/"));
    expect(h.statusOf(ask)).toBe("cancelled");
  });

  test("two floor-allowed calls in flight are ambiguous too", async () => {
    const h = setUp();
    await h.pre("toolu_A", "agent-a", h.bash(HELD_COMMAND));
    await h.floorDecide("toolu_A", HELD_COMMAND, "Allow once");
    await h.pre("toolu_B", "agent-b", h.bash(`${HELD_COMMAND}-2`));
    await h.floorDecide("toolu_B", `${HELD_COMMAND}-2`, "Allow once");
    expect(noticeTarget(h.store.db, h.sessionId).call).toBeNull();
  });

  test("a floor-allowed call beside a merely running one is still ambiguous, and the list marks it", async () => {
    const h = setUp();
    await h.pre("toolu_A", "agent-a", h.bash(HELD_COMMAND));
    await h.floorDecide("toolu_A", HELD_COMMAND, "Allow once");
    await h.pre("toolu_B", "agent-b", h.bash("bun test"));
    expect(noticeTarget(h.store.db, h.sessionId).call).toBeNull();
    await h.notice();
    const [ask] = h.permissionAsks();
    expect(ask?.question).toContain("the safety floor allowed this one");
  });
});

describe("answering a tied ask", () => {
  test("after its call finished, types nothing and retires the ask", async () => {
    const h = setUp();
    const write = { file_path: join(h.root, ".git/config"), content: "x" };
    await h.pre("toolu_W", undefined, write, "Write");
    await h.notice("Claude needs your permission to use Write");
    const [ask] = h.permissionAsks();
    expect(getPermissionAskToolUseId(h.store.db, ask!.id)).toBe("toolu_W");
    // The call ran while the answer was still being decided.
    insertEvent(h.store.db, h.sessionId, "PostToolUse", { tool_use_id: "toolu_W", tool_name: "Write", tool_input: write });

    const res = await h.resolve(ask!.id, "3");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("nothing was typed");
    expect(h.statusOf(ask)).toBe("cancelled");
  });

  test("a call still waiting far back in a busy session isn't mistaken for finished", async () => {
    const h = setUp();
    await h.pre("toolu_OLD", "agent-a", h.bash(HELD_COMMAND));
    const ask = createPermissionAsk(h.store.db, h.sessionId, "q", tiedTo("toolu_OLD"));
    for (let i = 0; i < 600; i++) insertEvent(h.store.db, h.sessionId, i % 2 ? "PostToolUse" : "PreToolUse", { tool_use_id: `toolu_${i >> 1}`, agent_id: "agent-b", tool_name: "Read", tool_input: {} });
    expect(staleCallReason(h.store.db, ask)).toBeNull();
  });

  test("menu keystrokes are refused for an ask that isn't a question's", async () => {
    const h = setUp();
    await h.pre("toolu_A", "agent-a", h.bash(HELD_COMMAND));
    await h.notice();
    const [ask] = h.permissionAsks();
    const res = await h.app.request(`/api/asks/${ask!.id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", [OWNER_TOKEN_HEADER]: h.secrets.ownerToken },
      body: JSON.stringify({ selections: [[0]] }),
    });
    expect(res.status).toBe(409);
    expect(h.statusOf(ask)).toBe("pending");
  });
});

describe("a new dialog while an older ask is pending", () => {
  test("in a monitored session it replaces the older ask: an answer at the terminal closed that dialog", async () => {
    const h = setUp();
    // Outside any launch's worktree, so the session isn't attached to one.
    const mon = { session_id: "monitored-1", cwd: tmpdir() };
    createSession(h.store.db, { id: "monitored-1", projectId: "p", title: "monitored", cwd: tmpdir(), status: "running" });
    await h.hook({ ...mon, hook_event_name: "PreToolUse", tool_use_id: "toolu_A", agent_id: "agent-a", tool_name: "Bash", tool_input: h.bash(HELD_COMMAND) });
    await h.hook({ ...mon, hook_event_name: "Notification", notification_type: "permission_prompt", message: TUI_NOTICE });
    const asks = () => getPendingAsksBySession(h.store.db, "monitored-1").filter((a) => a.kind === "permission_prompt");
    const [first] = asks();
    expect(getPermissionAskToolUseId(h.store.db, first!.id)).toBe("toolu_A");
    // A was allowed at the terminal and runs on; B's dialog opens.
    await h.hook({ ...mon, hook_event_name: "PreToolUse", tool_use_id: "toolu_B", agent_id: "agent-b", tool_name: "Bash", tool_input: h.bash("git push --force") });
    await h.hook({ ...mon, hook_event_name: "Notification", notification_type: "permission_prompt", message: TUI_NOTICE });

    expect(h.statusOf(first)).toBe("cancelled");
    const [second] = asks();
    expect(second?.question).toContain("git push --force");
    expect(second?.question).toContain(HELD_COMMAND);
  });

  test("in a launched session too, a tied ask gives way to a listing ask once another call could be behind the dialog", async () => {
    const h = setUp();
    await h.pre("toolu_E", "agent-e", h.bash(HELD_COMMAND));
    await h.floorDecide("toolu_E", HELD_COMMAND, "Allow once");
    await h.notice();
    const [tied] = h.permissionAsks();
    // E's dialog may have closed without its ask (a reply sent to the pane); G's opens.
    await h.pre("toolu_G", "agent-g", h.bash("git push --force"));
    await h.notice();
    expect(h.statusOf(tied)).toBe("cancelled");
    const [listing] = h.permissionAsks();
    expect(listing?.question).toContain("git push --force");
    expect(listing?.question).toContain(HELD_COMMAND);
  });

  test("a tied call whose thread went on to another call keeps its ask until the call or thread ends", async () => {
    const h = setUp();
    await h.pre("toolu_A", "agent-a", h.bash(HELD_COMMAND));
    await h.notice();
    const [ask] = h.permissionAsks();
    h.store.db.run("UPDATE asks SET created_at = datetime('now', '-10 seconds') WHERE id = ?", [ask!.id]);
    await h.pre("toolu_A2", "agent-a", h.bash("ls"));
    await h.post("toolu_A2", "agent-a", h.bash("ls"));
    await h.pre("toolu_A3", "agent-a", h.bash("ls -la"));
    expect(h.statusOf(ask)).toBe("pending");
    expect(staleCallReason(h.store.db, getAsk(h.store.db, ask!.id)!)).toBeNull();
    await h.hook({ hook_event_name: "SubagentStop", agent_id: "agent-a" });
    expect(h.statusOf(ask)).toBe("cancelled");
  });

  test("a background launch that finished at once doesn't let id-less subagent calls retire a main call's ask", async () => {
    const h = setUp();
    await h.pre("toolu_M", undefined, h.bash(HELD_COMMAND));
    await h.notice();
    const [ask] = h.permissionAsks();
    h.store.db.run("UPDATE asks SET created_at = datetime('now', '-10 seconds') WHERE id = ?", [ask!.id]);
    const launch = { prompt: "review", run_in_background: true };
    await h.pre("toolu_AGENT", undefined, launch, "Agent");
    await h.post("toolu_AGENT", undefined, launch, "Agent");
    // The subagent's calls came without their agent_id, so they read as main-thread.
    for (const id of ["toolu_x1", "toolu_x2"]) {
      await h.pre(id, undefined, { file_path: join(h.root, "a.ts") }, "Read");
      await h.post(id, undefined, { file_path: join(h.root, "a.ts") }, "Read");
    }
    expect(h.statusOf(ask)).toBe("pending");
    expect(staleCallReason(h.store.db, getAsk(h.store.db, ask!.id)!)).toBeNull();
  });

  test("an override is refused while other calls could have a dialog queued behind this one", async () => {
    const h = setUp();
    await h.pre("toolu_A", "agent-a", h.bash(HELD_COMMAND));
    await h.pre("toolu_B", "agent-b", h.bash("bun test"));
    await h.notice();
    const [ask] = h.permissionAsks();
    const res = await h.app.request(`/api/asks/${ask!.id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", [OWNER_TOKEN_HEADER]: h.secrets.ownerToken },
      body: JSON.stringify({ answer: "do something else", override: true }),
    });
    expect(res.status).toBe(409);
    expect(h.statusOf(ask)).toBe("pending");
  });

  test("an untied ask that can't record its calls is never answered from Standup", async () => {
    const h = setUp();
    // PreToolUses without a tool_use_id can't be recorded.
    for (let i = 0; i < 2; i++) await h.hook({ hook_event_name: "PreToolUse", agent_id: `agent-${i}`, tool_name: "Bash", tool_input: h.bash(`step ${i}`) });
    await h.notice();
    const [ask] = h.permissionAsks();
    expect(ask?.question).toContain("one of 2 calls");
    const res = await h.resolve(ask!.id, "1");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("can't tell which");
    expect(h.statusOf(ask)).toBe("pending");
  });

  test("an ask lists and records every call it could approve, however many", async () => {
    const h = setUp();
    for (let i = 0; i < 12; i++) await h.pre(`toolu_${i}`, `agent-${i}`, h.bash(`step ${i}`));
    await h.notice();
    const [ask] = h.permissionAsks();
    for (let i = 0; i < 12; i++) expect(ask?.question).toContain(`step ${i}`);
    expect(getPermissionAskCandidateIds(h.store.db, ask!.id)).toHaveLength(12);
    expect(unanswerableReason(h.store.db, ask!)).toBeNull();
  });

  test("a sibling call the same thread starts just after the notice doesn't retire the open dialog's ask", async () => {
    const h = setUp();
    const r1 = { file_path: "/etc/hosts" };
    await h.pre("toolu_R1", "agent-a", r1, "Read");
    await h.notice();
    const [ask] = h.permissionAsks();
    h.store.db.run("UPDATE asks SET created_at = datetime('now', '-1 seconds') WHERE id = ?", [ask!.id]);
    await h.pre("toolu_R2", "agent-a", { file_path: "/etc/passwd" }, "Read");
    expect(h.statusOf(ask)).toBe("pending");
    expect(staleCallReason(h.store.db, getAsk(h.store.db, ask!.id)!)).toBeNull();
  });

  test("a call with an open dialog stays a candidate while side-by-side reads start and finish around it", async () => {
    const h = setUp();
    const fetch = { url: "https://example.com/docs", prompt: "summarize" };
    await h.pre("toolu_W", undefined, fetch, "WebFetch");
    await h.pre("toolu_R1", undefined, { file_path: join(h.root, "a.ts") }, "Read");
    await h.post("toolu_R1", undefined, { file_path: join(h.root, "a.ts") }, "Read");
    await h.pre("toolu_R2", undefined, { file_path: join(h.root, "b.ts") }, "Read");
    expect(noticeTarget(h.store.db, h.sessionId).candidates.map((c) => c.toolUseId)).toContain("toolu_W");
    await h.post("toolu_R2", undefined, { file_path: join(h.root, "b.ts") }, "Read");
    await h.notice();
    const [ask] = h.permissionAsks();
    expect(getPermissionAskToolUseId(h.store.db, ask!.id)).toBe("toolu_W");
    expect(ask?.question).toContain("example.com/docs");
  });

  test("a call denied at the terminal stays listed beside the next one: listing a dead call is the safe side", async () => {
    const h = setUp();
    // C was denied in the terminal (no PostToolUse); the next turn is one call N that needs a dialog too.
    await h.pre("toolu_C", undefined, h.bash(HELD_COMMAND));
    await h.pre("toolu_N", undefined, h.bash("git push --force"));
    await h.notice();
    const [ask] = h.permissionAsks();
    expect(getPermissionAskToolUseId(h.store.db, ask!.id)).toBeNull();
    expect(ask?.question).toContain(HELD_COMMAND);
    expect(ask?.question).toContain("git push --force");
    expect(getPermissionAskCandidateIds(h.store.db, ask!.id)?.sort()).toEqual(["toolu_C", "toolu_N"]);
  });

  test("a repeat notice for the same dialog raises nothing new", async () => {
    const h = setUp();
    await h.pre("toolu_A", "agent-a", h.bash(HELD_COMMAND));
    await h.notice();
    await h.notice();
    expect(h.permissionAsks()).toHaveLength(1);
  });

  test("an untied ask's recorded calls decide when it retires, not a window of recent events", async () => {
    const h = setUp();
    await h.pre("toolu_A", "agent-a", h.bash("rm -rf $X/"));
    await h.pre("toolu_B", "agent-b", h.bash("bun test"));
    await h.notice();
    const [ask] = h.permissionAsks();
    for (let i = 0; i < 300; i++) {
      await h.pre(`toolu_c${i}`, "agent-c", h.bash("ls"));
      await h.post(`toolu_c${i}`, "agent-c", h.bash("ls"));
    }
    expect(h.statusOf(ask)).toBe("pending");
    await h.post("toolu_A", "agent-a", h.bash("rm -rf $X/"));
    await h.post("toolu_B", "agent-b", h.bash("bun test"));
    expect(h.statusOf(ask)).toBe("cancelled");
  });
});

describe("what can be behind a dialog", () => {
  test("a foreground subagent's launching Agent call is never a candidate", async () => {
    const h = setUp();
    await h.pre("toolu_AGENT", undefined, { prompt: "review", subagent_type: "general-purpose" }, "Agent");
    await h.pre("toolu_A", "agent-a", h.bash(HELD_COMMAND));
    expect(noticeTarget(h.store.db, h.sessionId).call?.toolUseId).toBe("toolu_A");
  });

  test("a failed call's PostToolUseFailure retires its ask", async () => {
    const h = setUp();
    await h.pre("toolu_A", "agent-a", h.bash(HELD_COMMAND));
    await h.notice();
    const [ask] = h.permissionAsks();
    await h.hook({ hook_event_name: "PostToolUseFailure", tool_use_id: "toolu_A", agent_id: "agent-a", tool_name: "Bash", tool_input: h.bash(HELD_COMMAND), error: "exit 1" });
    expect(h.statusOf(ask)).toBe("cancelled");
  });

  test("startup reconcile ties a notice to its call though subagents recorded more events after it", async () => {
    const h = setUp();
    insertEvent(h.store.db, h.sessionId, "PreToolUse", { tool_use_id: "toolu_E", agent_id: "agent-e", tool_name: "Bash", tool_input: h.bash(HELD_COMMAND), cwd: h.root });
    insertEvent(h.store.db, h.sessionId, "Notification", { notification_type: "permission_prompt", message: TUI_NOTICE });
    insertEvent(h.store.db, h.sessionId, "PreToolUse", { tool_use_id: "toolu_F", agent_id: "agent-f", tool_name: "Bash", tool_input: h.bash(HARMLESS_COMMAND), cwd: h.root });
    insertEvent(h.store.db, h.sessionId, "PostToolUse", { tool_use_id: "toolu_F", agent_id: "agent-f", tool_name: "Bash", tool_input: h.bash(HARMLESS_COMMAND), cwd: h.root });
    const [ask] = reconcileBlockedSessions(h.store.db);
    expect(getPermissionAskToolUseId(h.store.db, ask!.id)).toBe("toolu_E");
    expect(ask?.question).not.toContain("harness-f");
  });
});

describe("tied request ids", () => {
  test("a later ask about the same call gets the next id and still names the call", () => {
    const h = setUp();
    const first = createPermissionAsk(h.store.db, h.sessionId, "q", tiedTo("toolu_X"));
    const second = createPermissionAsk(h.store.db, h.sessionId, "q", tiedTo("toolu_X"));
    expect(first.id).not.toBe(second.id);
    expect(getPermissionAskToolUseId(h.store.db, second.id)).toBe("toolu_X");
  });

  test("an ask_human can't claim a permission ask's request id", async () => {
    const h = setUp();
    const res = h.app.request("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: h.sessionId, cwd: h.root, question: "q", request_id: "permission:toolu_Y", timeout_s: 1 }),
    });
    await Bun.sleep(50);
    const row = h.store.db.query("SELECT request_id FROM asks WHERE kind = 'ask_human'").get() as { request_id: string | null } | null;
    expect(row?.request_id ?? null).toBeNull();
    await res;
    expect(getPermissionAskToolUseId(h.store.db, createPermissionAsk(h.store.db, h.sessionId, "q", tiedTo("toolu_Y")).id)).toBe("toolu_Y");
  });
});

describe("the floor allows a worker's own calls without a hold", () => {
  test("a Read under a symlinked workspace root, by either spelling", () => {
    const base = mkdtempSync(join(tmpdir(), "held-call-ws-"));
    dirs.push(base);
    const real = join(base, "code-real", "ws");
    mkdirSync(join(real, "src", "UI", "src", "drafts"), { recursive: true });
    writeFileSync(join(real, "src", "UI", "src", "drafts", "owner.ts"), "export {};\n");
    symlinkSync(join(base, "code-real"), join(base, "code"));
    const linked = join(base, "code", "ws");
    const config = buildLaunchFloorConfig(
      { launchId: "l", root: linked, workerToken: "x".repeat(64), replyPublicKey: "test" },
      { DB_PATH: join(base, "data", "standup.db"), HOME: join(base, "home") }
    );
    expect(config.root).toBe(realpathSync(linked));
    for (const ws of [linked, realpathSync(real)]) {
      const verdict = classifyToolCall(
        { toolName: "Read", toolInput: { file_path: join(ws, "src", "UI", "src", "drafts", "owner.ts") }, cwd: join(ws, "src", "ControlPlane") },
        config
      );
      expect(verdict).toEqual({ action: "allow" });
    }
  });

  test("a subagent's Bash inside the worktree that writes only to /tmp", () => {
    const base = mkdtempSync(join(tmpdir(), "held-call-wt2-"));
    dirs.push(base);
    const root = join(base, "worktree");
    mkdirSync(join(root, "packages", "collector", "src", "floor"), { recursive: true });
    const config = buildLaunchFloorConfig(
      { launchId: "l", root, workerToken: "x".repeat(64), replyPublicKey: "test" },
      { DB_PATH: join(base, "data", "standup.db"), HOME: join(base, "home") }
    );
    expect(classifyToolCall({ toolName: "Bash", toolInput: { command: HARMLESS_COMMAND }, cwd: root }, config)).toEqual({ action: "allow" });
  });
});
