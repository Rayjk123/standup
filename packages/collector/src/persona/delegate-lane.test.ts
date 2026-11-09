import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  createAsk,
  getAsk,
  listPendingPersonaInbox,
  listPersonaCommitments,
  listPersonaMessages,
  listPersonaTurns,
  recordPersonaTurn,
} from "@standup/store";
import { PersonaRuntime } from "./runtime.js";
import { resolvePersonaConfig } from "./config.js";
import { PERSONA_TOKEN_HEADER } from "./routes.js";
import { DELEGATE_ESCALATIONS_EVENT, HOLD_DELEGATE } from "./delegates.js";
import { LANE_BRIEFS_HEADING } from "./delegate-lane.js";
import { DELEGATES_HEADING } from "./prompt.js";
import {
  HIGH_RISK,
  OUTWARD,
  OWNER,
  ROUTINE,
  actionRecords,
  allow,
  cardsFor,
  escalate,
  harness as openHarness,
  hold,
  mainPromptsWith,
  tryAllowThenEscalate,
  until,
} from "./delegate-test-harness.js";
import type { Harness } from "./delegate-test-harness.js";
import { setActiveOrgProfile } from "../org-profile/load.js";
import { exampleCorpProfile } from "../org-profile/fixtures/example-corp.js";

// The example.corp fixture profile: ROUTINE prints its SSO cookie, a hold Persona decides.
beforeAll(() => setActiveOrgProfile(exampleCorpProfile()));
afterAll(() => setActiveOrgProfile());

/*
 * The hold delegate end to end in one process (see delegate-test-harness.ts):
 * the real floor and tool routes, stub main and delegate turns.
 */

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});
const harness = (...args: Parameters<typeof openHarness>): Harness => {
  const h = openHarness(...args);
  open.push(h);
  return h;
};

describe("the hold delegate", () => {
  test("decides a routine hold with no main-thread turn and nothing posted in the thread", async () => {
    const h = harness();
    h.rules.push({ match: ROUTINE, act: allow("the job reads the SSO cookie to call the wiki") });
    const before = listPersonaMessages(h.store.db, h.job.threadId, { limit: 100 }).length;
    const { askId, reply } = await hold(h, ROUTINE);
    expect(await reply).toMatchObject({ decision: "allow" });
    expect(getAsk(h.store.db, askId)!.status).not.toBe("pending");
    await Bun.sleep(1_300);
    expect(h.laneTurns).toHaveLength(1);
    expect(h.mainTurns).toHaveLength(0);
    expect(listPendingPersonaInbox(h.store.db, OWNER)).toHaveLength(0);
    expect(listPersonaMessages(h.store.db, h.job.threadId, { limit: 100 })).toHaveLength(before);
    expect(cardsFor(h, askId)).toHaveLength(0);
    // The delegate's turn ran on Persona's own prompt with its role and context.
    const turn = h.laneTurns[0]!;
    expect(turn.systemPrompt).toContain(HOLD_DELEGATE.role(OWNER));
    expect(turn.systemPrompt).not.toContain(DELEGATES_HEADING);
    expect(turn.prompt).toContain(LANE_BRIEFS_HEADING);
    expect(turn.prompt).toContain("fix the docs sync's wiki sign-in");
    expect(turn.prompt).toContain(askId);
    expect(turn.resumeSessionId).toBeUndefined();
  });

  test("charges its turn to the job, like a Persona turn on it", async () => {
    const h = harness();
    h.rules.push({ match: ROUTINE, act: allow("the job reads the SSO cookie to call the wiki") });
    const { reply } = await hold(h, ROUTINE);
    await reply;
    const turns = await until(() => {
      const t = listPersonaTurns(h.store.db, OWNER);
      return t.length > 0 ? t : null;
    }, "the ledger row");
    expect(turns[0]).toMatchObject({ kind: "delegate", jobIds: [h.job.id], threadId: h.job.threadId });
  });

  test("its turns leave the cost of the main Persona's resumed session as it was", () => {
    const h = harness({}, { start: false });
    const turn = (input: Partial<Parameters<typeof recordPersonaTurn>[1]>) =>
      recordPersonaTurn(h.store.db, { user: OWNER, jobIds: [h.job.id], ok: true, startedAt: new Date().toISOString(), durationMs: 1, ...input });
    turn({ kind: "turn", claudeSessionId: "main-session", reportedCostUsd: 1.5 });
    turn({ kind: "delegate", claudeSessionId: "lane-session", reportedCostUsd: 0.25 });
    const resumed = turn({ kind: "turn", claudeSessionId: "main-session", resumed: true, resumedSessionId: "main-session", reportedCostUsd: 2 });
    expect(resumed.costUsd).toBe(0.5);
  });

  test("escalates an outward step with no owner yes: its allow is not decided there, and the main Persona gets one event with the recommendation", async () => {
    const h = harness();
    h.rules.push({ match: OUTWARD, act: tryAllowThenEscalate("ask_owner", "a push to the shared remote; the owner hasn't said yes") });
    const { askId } = await hold(h, OUTWARD);
    const main = await until(() => mainPromptsWith(h, askId)[0], "the main turn");
    expect(main.prompt).toContain(`${HOLD_DELEGATE.id} escalated 1 event`);
    expect(main.prompt).toContain("recommends ask_owner: a push to the shared remote");
    expect(main.prompt).toContain(OUTWARD);
    expect(main.systemPrompt).toContain(DELEGATES_HEADING);
    const tried = h.laneResults.find((r) => r.name === "answer_ask" && r.askId === askId)!;
    expect(tried.isError).toBe(true);
    expect(tried.text).toContain("not decided here: an outward-facing step needs");
    // The hold is still pending and no card was raised: the main Persona decides it as today.
    expect(getAsk(h.store.db, askId)!.status).toBe("pending");
    expect(cardsFor(h, askId)).toHaveLength(0);
    expect(h.mainTurns).toHaveLength(1);
  });

  test("an owner yes the second check finds lets it settle an outward step", async () => {
    const h = harness();
    const yes = h.runtime.postMessage({ threadId: h.job.threadId, role: "user", actor: OWNER, jobIds: [h.job.id], text: "yes, push fix/docs-sync to origin" });
    h.rules.push({
      match: OUTWARD,
      act: async (askId, call) => {
        await call("answer_ask", { askId, answer: "Allow once", reason: "the owner said to push it", consentMessageId: yes.id });
      },
    });
    const { askId, reply } = await hold(h, OUTWARD);
    await until(() => h.laneResults.length > 0, "the delegate's answer");
    expect(h.laneResults[0]).toMatchObject({ name: "answer_ask", askId });
    expect(h.laneResults[0]!.text).not.toContain("not decided here");
    expect(await reply).toMatchObject({ decision: "allow" });
    await Bun.sleep(1_300);
    expect(h.mainTurns).toHaveLength(0);
  });

  test("escalates a high-risk hold it won't allow; the owner's card is raised exactly as today", async () => {
    const h = harness();
    h.rules.push({ match: HIGH_RISK, act: tryAllowThenEscalate("deny", "reads another process's environment") });
    const { askId } = await hold(h, HIGH_RISK);
    expect(getAsk(h.store.db, askId)!.question).toContain("HIGH RISK");
    const main = await until(() => mainPromptsWith(h, askId)[0], "the main turn");
    expect(main.prompt).toContain("recommends deny");
    const [card] = cardsFor(h, askId);
    expect(card).toMatchObject({ status: "pending", jobId: h.job.id, args: { askId, answer: "Allow once", floorHold: true } });
    expect(getAsk(h.store.db, askId)!.status).toBe("pending");
  });

  test("escalations made together reach the main Persona as one event", async () => {
    const h = harness({}, { start: false });
    h.rules.push({ match: OUTWARD, act: escalate("ask_owner", "an outward step") });
    h.rules.push({ match: HIGH_RISK, act: escalate("deny", "high risk") });
    h.rules.push({ match: ROUTINE, act: escalate("allow_once", "outside the brief, the owner should say") });
    const asks = [await hold(h, OUTWARD), await hold(h, HIGH_RISK), await hold(h, ROUTINE)].map((x) => x.askId);
    h.runtime.start();
    const main = await until(() => mainPromptsWith(h, "escalated 3 events")[0], "the main turn");
    for (const askId of asks) expect(main.prompt).toContain(askId);
    expect(h.laneTurns).toHaveLength(1);
    expect(h.mainTurns).toHaveLength(1);
  });

  test("escalations from separate delegate turns while the main Persona is busy wait as one event", async () => {
    const h = harness();
    let release!: () => void;
    h.mainGate = new Promise<void>((r) => (release = r));
    h.rules.push({ match: "", act: escalate("ask_owner", "needs the owner") });
    const first = await hold(h, OUTWARD);
    await until(() => h.mainTurns.length === 1, "the first main turn");
    const second = await hold(h, HIGH_RISK);
    await until(() => h.laneTurns.length === 2, "the second delegate turn");
    const third = await hold(h, ROUTINE);
    await until(() => h.laneTurns.length === 3, "the third delegate turn");
    const pending = await until(() => {
      const items = listPendingPersonaInbox(h.store.db, OWNER).filter((i) => i.payload.type === DELEGATE_ESCALATIONS_EVENT);
      return items.length === 1 && (items[0]!.payload.escalations as unknown[]).length === 2 ? items : null;
    }, "one merged escalations item");
    expect(pending).toHaveLength(1);
    h.mainGate = undefined;
    release();
    const merged = await until(() => h.mainTurns[1], "the second main turn");
    expect(merged.prompt).toContain("escalated 2 events");
    expect(merged.prompt).toContain(second.askId);
    expect(merged.prompt).toContain(third.askId);
    // The first escalation reached the first main turn; the second turn's event carries only the two later ones.
    expect(h.mainTurns[0]!.prompt).toContain(`escalated 1 event`);
    expect(h.mainTurns[0]!.prompt).toContain(first.askId);
    expect(merged.prompt.split(`${HOLD_DELEGATE.id} recommends`)).toHaveLength(3);
  });

  test("a hold its turn leaves undecided is escalated for it", async () => {
    const h = harness();
    const { askId } = await hold(h, OUTWARD);
    const main = await until(() => mainPromptsWith(h, askId)[0], "the main turn");
    expect(main.prompt).toContain(`recommends none: the ${HOLD_DELEGATE.id} left it undecided`);
  });

  test("a failed delegate turn hands its holds to the main Persona", async () => {
    const h = harness();
    h.laneFails = "model service unavailable";
    const { askId } = await hold(h, ROUTINE);
    const main = await until(() => mainPromptsWith(h, askId)[0], "the main turn");
    expect(main.prompt).toContain("turn failed (model service unavailable)");
  });

  test("an event no route matches still reaches the main Persona", async () => {
    const h = harness();
    const ask = createAsk(h.store.db, h.sessionId, "ask_human", "Which wiki space should the sync write to?");
    h.runtime.eventListener()({ type: "ask:new", payload: ask, timestamp: new Date().toISOString() });
    const main = await until(() => mainPromptsWith(h, ask.id)[0], "the main turn");
    expect(main.prompt).toContain("worker ask");
    expect(h.laneTurns).toHaveLength(0);
  });

  test("on start it takes the holds still pending, so a restart loses none", async () => {
    const h = harness({}, { subscribe: false, start: false });
    h.rules.push({ match: ROUTINE, act: allow("the job reads the SSO cookie to call the wiki") });
    const { askId, reply } = await hold(h, ROUTINE);
    expect(h.laneTurns).toHaveLength(0);
    h.subscribe();
    h.runtime.start();
    expect(await reply).toMatchObject({ decision: "allow" });
    expect(getAsk(h.store.db, askId)!.status).not.toBe("pending");
    expect(h.mainTurns).toHaveLength(0);
  });

  test("a restart leaves holds the main Persona already has, or the owner's card holds, where they are", async () => {
    const h = harness();
    h.rules.push({ match: OUTWARD, act: escalate("ask_owner", "a push") });
    h.rules.push({ match: HIGH_RISK, act: tryAllowThenEscalate("deny", "high risk") });
    const outward = await hold(h, OUTWARD);
    const risky = await hold(h, HIGH_RISK);
    await until(() => mainPromptsWith(h, outward.askId)[0] && mainPromptsWith(h, risky.askId)[0], "both escalations");
    expect(cardsFor(h, risky.askId)).toHaveLength(1);
    const lanesBefore = h.laneTurns.length;
    const mainBefore = h.mainTurns.length;
    h.runtime.stop();
    h.runtime.start();
    await Bun.sleep(1_300);
    expect(h.laneTurns).toHaveLength(lanesBefore);
    expect(h.mainTurns).toHaveLength(mainBefore);
  });

  test("a restart with the delegate turned off hands the holds it held to the main Persona", async () => {
    const h = harness({}, { subscribe: false, start: false });
    const { askId } = await hold(h, ROUTINE);
    // The same DB, now served by a runtime whose delegates are off.
    const runtime = new PersonaRuntime({
      db: h.store.db,
      owner: OWNER,
      config: resolvePersonaConfig({ STANDUP_PERSONA_DELEGATES: "0", STANDUP_PERSONA_COALESCE_S: "1" }),
      broadcast: () => {},
      tickMs: 3_600_000,
      dailyBrief: false,
      turnRunner: async (input) => {
        h.mainTurns.push(input);
        return { ok: true, text: "[silent]", sessionId: "stub" };
      },
    });
    runtime.start();
    try {
      const main = await until(() => mainPromptsWith(h, askId)[0], "the main turn");
      expect(main.prompt).toContain("worker ask");
    } finally {
      runtime.stop();
    }
  });

  test("an escalated ask opens the commitment to answer it", async () => {
    const h = harness();
    h.rules.push({ match: OUTWARD, act: escalate("ask_owner", "a push") });
    const { askId } = await hold(h, OUTWARD);
    await until(() => mainPromptsWith(h, askId)[0], "the main turn");
    const open = listPersonaCommitments(h.store.db, OWNER, { status: "open", limit: 100 });
    expect(open.some((c) => c.action.includes(askId))).toBe(true);
  });

  test("marks the asks it is deciding in the main Persona's snapshot", async () => {
    const h = harness();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.rules.push({ match: ROUTINE, act: async () => gate });
    const { askId } = await hold(h, ROUTINE);
    await until(() => h.laneTurns.length === 1, "the delegate turn");
    const question = createAsk(h.store.db, h.sessionId, "ask_human", "Which wiki space?");
    h.runtime.eventListener()({ type: "ask:new", payload: question, timestamp: new Date().toISOString() });
    const main = await until(() => mainPromptsWith(h, question.id)[0], "the main turn");
    expect(main.prompt).toContain(`ask ${askId}`);
    expect(main.prompt).toContain(`with ${HOLD_DELEGATE.id}, leave it`);
    release();
  });
});

describe("the off switch", () => {
  for (const [name, env, wire] of [
    ["STANDUP_PERSONA_DELEGATES=0", { STANDUP_PERSONA_DELEGATES: "0" }, true],
    ["STANDUP_PERSONA_DELEGATE_HOLD_DELEGATE=0", { STANDUP_PERSONA_DELEGATE_HOLD_DELEGATE: "0" }, true],
    ["no delegate runner wired", {}, false],
  ] as const) {
    test(`${name} sends holds to the main Persona as today`, async () => {
      const h = harness(env, { wireLanes: wire });
      const { askId } = await hold(h, ROUTINE);
      const main = await until(() => mainPromptsWith(h, askId)[0], "the main turn");
      expect(main.prompt).toContain(`worker ask`);
      expect(main.prompt).not.toContain(DELEGATE_ESCALATIONS_EVENT);
      expect(main.systemPrompt).not.toContain(DELEGATES_HEADING);
      expect(h.laneTurns).toHaveLength(0);
      expect(h.runtime.delegateLanes()).toHaveLength(0);
    });
  }
});

describe("the audit record", () => {
  test("a delegate's allow is recorded exactly as the main Persona's allow of the same hold", async () => {
    const reason = "the job reads the SSO cookie to call the wiki";
    const lane = harness();
    lane.rules.push({ match: ROUTINE, act: allow(reason) });
    const viaLane = await hold(lane, ROUTINE);
    await viaLane.reply;

    const main = harness({ STANDUP_PERSONA_DELEGATES: "0" });
    const viaMain = await hold(main, ROUTINE);
    const res = await main.app.request("/api/persona/tool", {
      method: "POST",
      headers: { "content-type": "application/json", [PERSONA_TOKEN_HEADER]: main.runtime.token },
      body: JSON.stringify({ name: "answer_ask", arguments: { askId: viaMain.askId, answer: "Allow once", reason } }),
    });
    expect(res.status).toBe(200);
    await viaMain.reply;

    const normalize = (h: Harness, askId: string) =>
      actionRecords(h).map((r) => {
        const value = JSON.parse(r.value_json) as Record<string, unknown>;
        const target = { ...(value.target as Record<string, string>) };
        expect(target.askId).toBe(askId);
        delete target.askId;
        delete value.callHash;
        // How long the second check took is the only field that may differ between two runs.
        const timeless = JSON.parse(JSON.stringify({ ...value, target }, (key, v) => (key === "latencyMs" ? undefined : v)));
        return { value: timeless, thread: r.thread_id === h.job.threadId, job: r.job_id === h.job.id, audience: r.audience };
      });
    const laneRecord = normalize(lane, viaLane.askId);
    expect(laneRecord).toHaveLength(1);
    expect(laneRecord).toEqual(normalize(main, viaMain.askId));
    expect(laneRecord[0]!.value).toMatchObject({ action: "answer_ask", outcome: "executed", reason });
  });
});
