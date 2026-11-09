import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import {
  attachSessionToLaunch,
  createLaunch,
  createSession,
  createStore,
  cancelPromptAsks,
  claimPendingAsk,
  getAsk,
  getSurfacedAsksBySession,
  insertEvent,
  releaseAskClaim,
  reopenClaimedAsk,
  resolvePendingAsk,
  upsertProject,
} from "@standup/store";
import type { Store } from "@standup/store";
import type { WsMessage } from "@standup/shared";
import { OWNER_TOKEN_HEADER } from "@standup/shared/owner-token";
import { createPermissionAsk, noticeTarget } from "./held-call.js";
import { generateOwnerSecrets } from "./owner-secret.js";

/*
 * Persona's read-only allow once claims the permission prompt before it
 * checks the pane and types: of two answers sent at the same time only one
 * types, and a refusal after the claim leaves the prompt for the owner.
 */

import * as launcher from "./launcher.js";
const realLauncher = { ...launcher };
const sendToLaunch = mock(async (_launch: unknown, _text: string) => ({ ok: true }));
const RULE = "─".repeat(60);
const bashDialog = (command: string) =>
  [`● Bash(${command})`, RULE, " Bash command", `   ${command}`, " Do you want to proceed?", " ❯ 1. Yes", "   2. Yes, and don't ask again for similar commands in /repo", "   3. No, and tell Claude what to do differently (esc)"].join("\n");
/** What the worker's pane shows when the digit is typed. */
let paneScreen = "";
/** When set, answerPermissionDialog waits on it before it reads the pane. */
let hold: Promise<void> | null = null;
/** When set, answerPermissionDialog throws it. */
let failWith: Error | null = null;
const typedDigits: string[] = [];
const answerPermissionDialog = mock(async (_launch: unknown, digit: string, refusal: (screen: string) => string | null) => {
  if (hold) await hold;
  if (failWith) throw failWith;
  const why = refusal(paneScreen);
  if (why) return { ok: false, typed: false, error: why };
  typedDigits.push(digit);
  return { ok: true, typed: true };
});
mock.module("./launcher.js", () => ({ ...realLauncher, sendToLaunch, answerPermissionDialog }));
import * as push from "./push.js";
const realPush = { ...push };
mock.module("./push.js", () => ({ ...realPush, pushNotification: mock(async () => {}) }));

const dirs: string[] = [];
afterAll(() => {
  mock.module("./launcher.js", () => realLauncher);
  mock.module("./push.js", () => realPush);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const { createServer, resolveUserAlias } = await import("./server.js");
const { PersonaRuntime } = await import("./persona/runtime.js");
const { PersonaFleet } = await import("./persona/fleet.js");
const { createBroadcastTap } = await import("./persona/events.js");
const { resolvePersonaConfig } = await import("./persona/config.js");
const { PERSONA_TOKEN_HEADER } = await import("./persona/routes.js");
type LaunchFn = import("./server.js").LaunchFn;

const OWNER = resolveUserAlias(undefined);

function setUp() {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "Project P", branch: "main", repos: ["/repo/p"] });
  const tap = createBroadcastTap(() => {});
  const frames: WsMessage[] = [];
  tap.subscribe((message) => frames.push(message));
  const secrets = generateOwnerSecrets();
  const runtime = new PersonaRuntime({
    db: store.db,
    owner: OWNER,
    config: { ...resolvePersonaConfig({}) },
    broadcast: tap.broadcast,
    turnRunner: async () => ({ ok: true, text: "[silent]", sessionId: "sid" }),
    ownerToken: () => secrets.ownerToken,
  });
  const fleet = new PersonaFleet({ db: store.db, host: OWNER, hostRuntime: runtime, create: () => runtime });
  tap.subscribe(fleet.eventListener());

  const root = realpathSync(mkdtempSync(join(tmpdir(), "perm-claim-")));
  dirs.push(root);
  writeFileSync(join(root, "README.md"), "# Readme\n");

  const launchFn = (async (
    db: Store["db"],
    request: { project: { id: string }; task: string; label?: string; requester?: string; launchedBy?: string; idempotencyKey?: string }
  ) => {
    const launch = createLaunch(db, {
      id: randomUUID(),
      projectId: request.project.id,
      task: request.task,
      worktreePath: root,
      branch: request.label ?? "b",
      requester: request.requester,
      launchedBy: request.launchedBy,
      idempotencyKey: request.idempotencyKey,
    });
    return { launch, log: [] };
  }) as unknown as LaunchFn;
  const app = createServer(
    store,
    tap.broadcast,
    null,
    undefined,
    undefined,
    join(root, "kb"),
    "",
    {},
    undefined,
    undefined,
    launchFn,
    undefined,
    { fleet, ownerSecrets: secrets },
    {},
    { stopLaunch: async () => ({ ok: true, log: [] }), paneAlive: () => false }
  );

  /** A Persona worker's session with one read-only call waiting on its permission dialog. */
  const readOnlyPrompt = async () => {
    const res = await app.request("/api/persona/tool", {
      method: "POST",
      headers: { "content-type": "application/json", [PERSONA_TOKEN_HEADER]: runtime.token },
      body: JSON.stringify({ name: "launch_session", arguments: { task: `read the docs ${randomUUID().slice(0, 4)}`, projectId: "p" } }),
    });
    const launched = (await res.json()) as { content: Array<{ text: string }> };
    const launchId = (JSON.parse(launched.content.map((c) => c.text).join("")) as { launchId: string }).launchId;
    const sessionId = randomUUID();
    createSession(store.db, { id: sessionId, projectId: "p", title: "worker", cwd: root, status: "running" });
    attachSessionToLaunch(store.db, launchId, sessionId);
    insertEvent(store.db, sessionId, "PreToolUse", { tool_use_id: "toolu_1", agent_id: "agent-a", tool_name: "Bash", tool_input: { command: "cat README.md" }, cwd: root });
    paneScreen = bashDialog("cat README.md");
    return createPermissionAsk(store.db, sessionId, "Claude needs your permission", noticeTarget(store.db, sessionId));
  };
  const hook = (sessionId: string, body: Record<string, unknown>) =>
    app.request("/hook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, cwd: root, ...body }),
    });
  const permissionAsks = (sessionId: string) =>
    (store.db.query("SELECT id, status FROM asks WHERE session_id = ? AND kind = 'permission_prompt'").all(sessionId) as Array<{ id: string; status: string }>);
  const resolveAs = (askId: string, answer: string, header: Record<string, string>) =>
    app.request(`/api/asks/${askId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", ...header },
      body: JSON.stringify({ answer }),
    });
  const asPersona = { [PERSONA_TOKEN_HEADER]: runtime.token };
  const asOwner = { [OWNER_TOKEN_HEADER]: secrets.ownerToken };
  return { store, frames, hook, permissionAsks, readOnlyPrompt, resolveAs, asPersona, asOwner };
}

const reset = () => {
  sendToLaunch.mockClear();
  answerPermissionDialog.mockClear();
  typedDigits.length = 0;
  hold = null;
  failWith = null;
};

describe("Persona's read-only allow once claims the prompt before it types", () => {
  test("two answers sent at the same time: exactly one types", async () => {
    const h = setUp();
    const ask = await h.readOnlyPrompt();
    reset();
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    const first = h.resolveAs(ask.id, "1", h.asPersona);
    const second = h.resolveAs(ask.id, "1", h.asPersona);
    // Both requests have run up to the dialog step before either types.
    await new Promise((r) => setTimeout(r, 20));
    release();
    const statuses = (await Promise.all([first, second])).map((r) => r.status).sort();
    expect(statuses[0]).toBe(200);
    expect([403, 409]).toContain(statuses[1]);
    expect(answerPermissionDialog).toHaveBeenCalledTimes(1);
    expect(typedDigits).toEqual(["1"]);
    expect(sendToLaunch).not.toHaveBeenCalled();
    expect(getAsk(h.store.db, ask.id)).toMatchObject({ status: "answered", answer: "1" });
  });

  test("a pane check that fails after the claim leaves the prompt for the owner", async () => {
    const h = setUp();
    const ask = await h.readOnlyPrompt();
    reset();
    paneScreen = bashDialog("cat README.md; rm -rf build");
    const refused = await h.resolveAs(ask.id, "1", h.asPersona);
    expect(refused.status).toBe(409);
    expect(typedDigits).toEqual([]);
    expect(getAsk(h.store.db, ask.id)).toMatchObject({ status: "pending" });
    expect(getAsk(h.store.db, ask.id)!.answer ?? null).toBeNull();

    const owner = await h.resolveAs(ask.id, "1", h.asOwner);
    expect(owner.status).toBe(200);
    expect(sendToLaunch).toHaveBeenCalledTimes(1);
    expect(answerPermissionDialog).toHaveBeenCalledTimes(1);
    expect(getAsk(h.store.db, ask.id)).toMatchObject({ status: "answered", answer: "1" });
  });

  test("a send that throws after the claim leaves the prompt pending", async () => {
    const h = setUp();
    const ask = await h.readOnlyPrompt();
    reset();
    failWith = new Error("pane gone");
    const res = await h.resolveAs(ask.id, "1", h.asPersona);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(getAsk(h.store.db, ask.id)).toMatchObject({ status: "pending" });
    failWith = null;
    expect((await h.resolveAs(ask.id, "1", h.asOwner)).status).toBe(200);
  });

  test("the owner's answer does not claim the prompt first", async () => {
    const h = setUp();
    const ask = await h.readOnlyPrompt();
    reset();
    const res = await h.resolveAs(ask.id, "1", h.asOwner);
    expect(res.status).toBe(200);
    expect(answerPermissionDialog).not.toHaveBeenCalled();
    expect(sendToLaunch).toHaveBeenCalledTimes(1);
    expect(getAsk(h.store.db, ask.id)).toMatchObject({ status: "answered", answer: "1" });
  });
});

/** Holds answerPermissionDialog until the returned release is called. */
function holdDialog(): () => void {
  let release!: () => void;
  hold = new Promise<void>((r) => (release = r));
  return release;
}

/** Lets an in-flight request run up to the held dialog step. */
const settle = () => new Promise((r) => setTimeout(r, 20));

/** The ask frames sent from index `from` on, for `askId`. */
function askFrames(frames: WsMessage[], from: number, askId: string): string[] {
  return frames.slice(from).flatMap((m) => {
    const p = m.payload as { id?: string; askId?: string };
    if (m.type === "ask:new" && p.id === askId) return ["ask:new"];
    if (m.type === "ask:resolved" && p.askId === askId) return ["ask:resolved"];
    return [];
  });
}

describe("while Persona holds the claim", () => {
  test("a re-notification for the same dialog raises no second ask", async () => {
    const h = setUp();
    const ask = await h.readOnlyPrompt();
    reset();
    const release = holdDialog();
    const answering = h.resolveAs(ask.id, "1", h.asPersona);
    await settle();
    expect(getAsk(h.store.db, ask.id)!.status).toBe("answered");
    const notified = await h.hook(ask.sessionId, { hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission" });
    expect(notified.status).toBeLessThan(400);
    expect(h.permissionAsks(ask.sessionId)).toEqual([{ id: ask.id, status: "answered" }]);
    release();
    expect((await answering).status).toBe(200);
    expect(typedDigits).toEqual(["1"]);
    expect(h.permissionAsks(ask.sessionId)).toEqual([{ id: ask.id, status: "answered" }]);
  });

  test("an exception after the claim, before the dialog step, puts the prompt back to pending", async () => {
    const h = setUp();
    const ask = await h.readOnlyPrompt();
    reset();
    const db = h.store.db;
    const realRun = db.run.bind(db);
    const realQuery = db.query.bind(db);
    let claimed = false;
    let thrown = false;
    db.run = ((sql: string, ...rest: unknown[]) => {
      const result = (realRun as (s: string, ...r: unknown[]) => ReturnType<typeof db.run>)(sql, ...rest);
      if (sql.includes("status = 'answered'") && sql.includes("AND status = 'pending'")) claimed = true;
      return result;
    }) as typeof db.run;
    db.query = ((sql: string) => {
      if (claimed && !thrown && sql.includes("FROM launches")) {
        thrown = true;
        throw new Error("launch lookup failed");
      }
      return realQuery(sql);
    }) as typeof db.query;
    const from = h.frames.length;
    try {
      const res = await h.resolveAs(ask.id, "1", h.asPersona);
      expect(res.status).toBeGreaterThanOrEqual(500);
    } finally {
      db.run = realRun;
      db.query = realQuery;
    }
    expect(thrown).toBe(true);
    expect(answerPermissionDialog).not.toHaveBeenCalled();
    expect(getAsk(db, ask.id)).toMatchObject({ status: "pending" });
    expect(askFrames(h.frames, from, ask.id)).toEqual(["ask:new"]);
    expect((await h.resolveAs(ask.id, "1", h.asOwner)).status).toBe(200);
  });

  test("a refusal that reopens the prompt tells the ask surfaces it is pending again", async () => {
    const h = setUp();
    const ask = await h.readOnlyPrompt();
    reset();
    paneScreen = bashDialog("cat README.md; rm -rf build");
    const from = h.frames.length;
    expect((await h.resolveAs(ask.id, "1", h.asPersona)).status).toBe(409);
    expect(getAsk(h.store.db, ask.id)!.status).toBe("pending");
    expect(askFrames(h.frames, from, ask.id)).toEqual(["ask:new"]);
    const frame = h.frames.slice(from).find((m) => m.type === "ask:new" && (m.payload as { id?: string }).id === ask.id);
    expect(frame!.payload).toMatchObject({ id: ask.id, status: "pending" });
  });

  test("a refusal once the dialog's call has finished cancels the prompt instead of reopening it", async () => {
    const h = setUp();
    const ask = await h.readOnlyPrompt();
    reset();
    const release = holdDialog();
    const from = h.frames.length;
    const answering = h.resolveAs(ask.id, "1", h.asPersona);
    await settle();
    insertEvent(h.store.db, ask.sessionId, "PostToolUse", { tool_use_id: "toolu_1", agent_id: "agent-a", tool_name: "Bash", tool_input: { command: "cat README.md" }, tool_response: {} });
    paneScreen = "";
    release();
    expect((await answering).status).toBe(409);
    expect(typedDigits).toEqual([]);
    expect(getAsk(h.store.db, ask.id)!.status).toBe("cancelled");
    expect(askFrames(h.frames, from, ask.id)).toEqual(["ask:resolved"]);
  });
});

describe("claimPendingAsk", () => {
  test("a claimed ask counts as surfaced and is cancelled with the session's prompts until released", async () => {
    const h = setUp();
    const ask = await h.readOnlyPrompt();
    expect(claimPendingAsk(h.store.db, ask.id, "1", "persona:a")).toBe(true);
    expect(claimPendingAsk(h.store.db, ask.id, "1", "persona:b")).toBe(false);
    expect(getSurfacedAsksBySession(h.store.db, ask.sessionId).map((a) => a.id)).toEqual([ask.id]);
    expect(cancelPromptAsks(h.store.db, ask.sessionId).map((a) => a.id)).toEqual([ask.id]);
    expect(getAsk(h.store.db, ask.id)!.status).toBe("cancelled");
    expect(reopenClaimedAsk(h.store.db, ask.id, "persona:a")).toBe(false);
    releaseAskClaim(ask.id);
  });

  test("a released claim is an ordinary answered ask", async () => {
    const h = setUp();
    const ask = await h.readOnlyPrompt();
    expect(claimPendingAsk(h.store.db, ask.id, "1", "persona:a")).toBe(true);
    releaseAskClaim(ask.id);
    expect(getSurfacedAsksBySession(h.store.db, ask.sessionId)).toEqual([]);
    expect(cancelPromptAsks(h.store.db, ask.sessionId)).toEqual([]);
    expect(getAsk(h.store.db, ask.id)!.status).toBe("answered");
  });
});

describe("reopenClaimedAsk", () => {
  test("undoes only the named claim", async () => {
    const h = setUp();
    const ask = await h.readOnlyPrompt();
    expect(resolvePendingAsk(h.store.db, ask.id, "1", "persona:a")).toBe(true);
    expect(resolvePendingAsk(h.store.db, ask.id, "1", "persona:b")).toBe(false);
    expect(reopenClaimedAsk(h.store.db, ask.id, "persona:b")).toBe(false);
    expect(getAsk(h.store.db, ask.id)!.status).toBe("answered");
    expect(reopenClaimedAsk(h.store.db, ask.id, "persona:a")).toBe(true);
    expect(getAsk(h.store.db, ask.id)!.status).toBe("pending");
    expect(reopenClaimedAsk(h.store.db, ask.id, "persona:a")).toBe(false);
  });
});
