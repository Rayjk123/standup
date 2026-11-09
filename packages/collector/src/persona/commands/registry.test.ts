import { describe, expect, test } from "bun:test";
import { DEFAULT_IDENTITY_HEADER, PERSONA_COMMANDS, parsePersonaCommand, stateVerdictLine } from "@standup/shared";
import type { PersonaCommandResponse, PersonaCommandsResponse, StateReport } from "@standup/shared";
import {
  appendPersonaMessage,
  countPendingPersonaInbox,
  createStore,
  getOrCreatePersonaConsoleThread,
  getOrCreatePersonaThreadByRef,
  listPersonaMessages,
  listUnansweredPersonaQuestions,
  personaOwnerRepliedAfter,
} from "@standup/store";
import { OWNER_TOKEN_HEADER } from "@standup/shared/owner-token";
import { createServer, resolveUserAlias } from "../../server.js";
import { generateOwnerSecrets } from "../../owner-secret.js";
import { resolvePersonaConfig } from "../config.js";
import { createBroadcastTap } from "../events.js";
import { PersonaFleet } from "../fleet.js";
import { PersonaRuntime } from "../runtime.js";
import { COMMAND_HANDLERS, runPersonaCommand, unmatchedCommandNames } from "./registry.js";
import type { PersonaCommandHandler } from "./registry.js";

const OWNER = resolveUserAlias(undefined);

describe("the command registry", () => {
  test("every listed command has a handler, and every handler is listed", () => {
    expect(unmatchedCommandNames()).toEqual([]);
    expect(PERSONA_COMMANDS.map((c) => c.name)).toContain("state");
    for (const c of PERSONA_COMMANDS) expect(c.description.length).toBeGreaterThan(10);
  });

  test("parsePersonaCommand takes only a known command at the start of the message", () => {
    expect(parsePersonaCommand("/state")).toEqual({ name: "state", args: "" });
    expect(parsePersonaCommand("  /STATE  ")).toEqual({ name: "state", args: "" });
    // /state takes no text after it, so this is a question for Persona.
    expect(parsePersonaCommand("/state of the build?")).toBeNull();
    expect(parsePersonaCommand("/echo hi", [{ name: "echo", description: "d", takesArgs: true }])).toEqual({ name: "echo", args: "hi" });
    expect(parsePersonaCommand("/stateful")).toBeNull();
    expect(parsePersonaCommand("/deploy beta")).toBeNull();
    expect(parsePersonaCommand("what is /state?")).toBeNull();
    expect(parsePersonaCommand("/")).toBeNull();
    expect(parsePersonaCommand("")).toBeNull();
  });

  test("the verdict line words both counts", () => {
    expect(stateVerdictLine(0, 0)).toBe("All good");
    expect(stateVerdictLine(1, 0)).toBe("1 thing needs you");
    expect(stateVerdictLine(0, 3)).toBe("3 things look off");
    expect(stateVerdictLine(2, 1)).toBe("2 things need you · 1 thing looks off");
  });

  test("a handler that throws yields a failed result with a plain reason", () => {
    const store = createStore(":memory:");
    const broken: PersonaCommandHandler = {
      name: "boom",
      run() {
        throw new Error("the store is closed");
      },
    };
    const ctx = { db: store.db, owner: OWNER, now: new Date(), args: "" };
    const result = runPersonaCommand("boom", ctx, new Map([["boom", broken]]));
    expect(result).toMatchObject({ ok: false, data: null, summary: "/boom couldn't run just now. Try again in a moment." });
    expect(runPersonaCommand("nope", ctx)).toBeNull();
    expect(COMMAND_HANDLERS.get("state")).toBeDefined();
  });
});

function setUp() {
  const store = createStore(":memory:");
  const tap = createBroadcastTap(() => {});
  const secrets = generateOwnerSecrets();
  let turns = 0;
  const runtime = new PersonaRuntime({
    db: store.db,
    owner: OWNER,
    config: resolvePersonaConfig({}),
    broadcast: tap.broadcast,
    dataDir: "/nonexistent",
    turnRunner: async () => {
      turns++;
      return { ok: true, text: "[silent]", sessionId: "sid" };
    },
    ownerToken: () => secrets.ownerToken,
  });
  const fleet = new PersonaFleet({ db: store.db, host: OWNER, hostRuntime: runtime });
  const health = { head: "0123456789abcdef", startedAt: new Date(Date.now() - 3_600_000).toISOString() };
  const app = createServer(
    store,
    tap.broadcast,
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
    { fleet, ownerSecrets: secrets },
    {},
    { health }
  );
  const auth = { [DEFAULT_IDENTITY_HEADER]: OWNER, [OWNER_TOKEN_HEADER]: secrets.ownerToken };
  const post = (body: unknown, headers: Record<string, string> = auth) =>
    app.request("/api/persona/commands", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  const get = (path: string, headers: Record<string, string> = auth) => app.request(path, { headers });
  return { store, app, auth, post, get, turns: () => turns };
}

describe("/api/persona/commands", () => {
  test("GET lists the registry", async () => {
    const h = setUp();
    const res = await h.get("/api/persona/commands");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PersonaCommandsResponse;
    expect(body.commands).toEqual([...PERSONA_COMMANDS]);
  });

  test("POST /state keeps the line and the card in the thread, starts no turn, and leaves questions open", async () => {
    const h = setUp();
    const db = h.store.db;
    const thread = getOrCreatePersonaConsoleThread(db, OWNER);
    const question = appendPersonaMessage(db, { threadId: thread.id, role: "persona", text: "Ship it?", options: ["yes", "no"] }).message;

    const started = performance.now();
    const res = await h.post({ text: "/state", idempotencyKey: "k1" });
    const ms = performance.now() - started;
    expect(res.status).toBe(201);
    expect(ms).toBeLessThan(300);
    const body = (await res.json()) as PersonaCommandResponse;
    expect(body.message).toMatchObject({ role: "user", text: "/state", actor: OWNER, command: { name: "state", args: "" } });
    expect(body.result.role).toBe("system");
    const report = body.result.command!.result!.data as StateReport;
    expect(body.result.command!.result!.ok).toBe(true);
    expect(report.waiting.questions.map((q) => q.title)).toEqual(["Ship it?"]);
    expect(report.health.collector.head).toBe("0123456789abcdef");
    expect(body.result.text).toBe("1 thing needs you");

    // Kept in the thread, with no inbox item and no turn.
    expect(listPersonaMessages(db, thread.id).map((m) => m.id).slice(-2)).toEqual([body.message.id, body.result.id]);
    expect(countPendingPersonaInbox(db, OWNER)).toBe(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.turns()).toBe(0);
    // The owner's /state is no reply to Persona's question, nor to a commitment's hold on it.
    expect(listUnansweredPersonaQuestions(db, OWNER, "2000-01-01T00:00:00.000Z").map((q) => q.text)).toEqual(["Ship it?"]);
    expect(personaOwnerRepliedAfter(db, question.id, OWNER)).toBe(false);

    // A retry with the same key replays the first run.
    const again = await h.post({ text: "/state", idempotencyKey: "k1" });
    expect(again.status).toBe(200);
    const replay = (await again.json()) as PersonaCommandResponse;
    expect([replay.message.id, replay.result.id]).toEqual([body.message.id, body.result.id]);
    expect(listPersonaMessages(db, thread.id)).toHaveLength(3);
  });

  test("a key an ordinary message already used is refused, not replayed as a command", async () => {
    const h = setUp();
    const thread = getOrCreatePersonaConsoleThread(h.store.db, OWNER);
    appendPersonaMessage(h.store.db, { threadId: thread.id, role: "user", text: "hello", actor: OWNER, idempotencyKey: "k-shared" });
    expect((await h.post({ text: "/state", idempotencyKey: "k-shared" })).status).toBe(409);
    // …and the other way round: a command's key never posts a message to Persona.
    expect((await h.post({ text: "/state", idempotencyKey: "k-cmd" })).status).toBe(201);
    const res = await h.app.request("/api/persona/messages", {
      method: "POST",
      headers: { ...h.auth, "content-type": "application/json" },
      body: JSON.stringify({ text: "hi", idempotencyKey: "k-cmd" }),
    });
    expect(res.status).toBe(409);
  });

  test("a run of commands doesn't push the conversation out of Persona's history", () => {
    const store = createStore(":memory:");
    const thread = getOrCreatePersonaConsoleThread(store.db, OWNER);
    appendPersonaMessage(store.db, { threadId: thread.id, role: "persona", text: "the conversation" });
    for (let i = 0; i < 30; i++) {
      appendPersonaMessage(store.db, { threadId: thread.id, role: "user", text: "/state", actor: OWNER, command: { name: "state", args: "" } });
    }
    expect(listPersonaMessages(store.db, thread.id, { limit: 5, excludeCommands: true }).map((m) => m.text)).toEqual(["the conversation"]);
  });

  test("an unknown command or empty text is refused", async () => {
    const h = setUp();
    expect((await h.post({ text: "/deploy beta" })).status).toBe(400);
    expect((await h.post({ text: "" })).status).toBe(400);
    expect((await h.post({ text: "/state", idempotencyKey: 7 })).status).toBe(400);
  });

  test("another user's thread is unknown, and a shared thread refuses commands", async () => {
    const h = setUp();
    const db = h.store.db;
    const theirs = getOrCreatePersonaConsoleThread(db, "mallory");
    expect((await h.post({ text: "/state", threadId: theirs.id })).status).toBe(404);
    const shared = getOrCreatePersonaConsoleThread(db, OWNER);
    db.run("UPDATE persona_threads SET audience = 'shared' WHERE id = ?", [shared.id]);
    expect((await h.post({ text: "/state", threadId: shared.id })).status).toBe(400);
  });

  test("a request without the owner's channel proof is refused", async () => {
    const h = setUp();
    const res = await h.post({ text: "/state" }, { [DEFAULT_IDENTITY_HEADER]: OWNER });
    expect([401, 403]).toContain(res.status);
  });
});

describe("Persona's turns and command messages", () => {
  test("a fresh turn's thread history leaves the /state line and its card out", async () => {
    const store = createStore(":memory:");
    // Thread history is replayed for a fresh session of a thread others read.
    const thread = getOrCreatePersonaThreadByRef(store.db, OWNER, "slack", "C1:123.456", "Team thread", "shared");
    const prompts: string[] = [];
    const runtime = new PersonaRuntime({
      db: store.db,
      owner: OWNER,
      config: resolvePersonaConfig({}),
      broadcast: () => {},
      turnRunner: async (input) => {
        prompts.push(input.prompt);
        return { ok: true, text: "ok", sessionId: "sid-1" };
      },
    });
    const threadId = thread.id;
    runtime.postMessage({ threadId, role: "persona", text: "Earlier reply from Persona" });
    runtime.postMessage({ threadId, role: "user", text: "/state", actor: OWNER, command: { name: "state", args: "" } });
    runtime.postMessage({
      threadId,
      role: "system",
      text: "CARD-SUMMARY-LINE",
      command: { name: "state", args: "", result: { ok: true, data: {}, summary: "CARD-SUMMARY-LINE", ranAt: new Date().toISOString(), ms: 1 } },
    });
    runtime.receiveUserMessage({ text: "what's next?", actor: OWNER, threadId });
    await runtime.drain();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Earlier reply from Persona");
    expect(prompts[0]).not.toContain("CARD-SUMMARY-LINE");
    expect(prompts[0]).not.toContain("/state");
  });
});
