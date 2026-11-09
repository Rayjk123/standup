// Answer/approve authorization: a non-owner learned only as the DM DELIVERY
// recipient must NOT be able to resolve an ask or decide a plan, while a human
// the operator explicitly authorized (SLACK_ASK_USER, SLACK_STEER_ALLOWLIST, or a
// mapped owner in SLACK_OWNER_MAP) must be able to.
//
// These tests build the authority through wireSlackAuthority — the SAME factory
// index.ts wires main() with (see index.ts: `const { steer, authorized } =
// wireSlackAuthority(env, collector, …)`, asks/plans authorized by that same
// predicate). So they exercise the REAL owner source (ownerUserId: () =>
// env.askUser, allowlist = SLACK_STEER_ALLOWLIST ∪ SLACK_OWNER_MAP values), not a
// hand-written reconstruction: weakening the factory to trust the DM-learned
// recipient — the historical defect — flips a stranger's `authorized(...)` from
// false to true and fails these tests. Recording collector fakes stand in so NO
// live Slack/HTTP call runs.

import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import type { Ask, PlanApproval } from "@standup/shared";
import { Asks, type OwnerRouting } from "./asks.js";
import { Plans } from "./plans.js";
import { wireSlackAuthority, type SteerSink } from "./steer.js";
import type { SlackEnv } from "./env.js";

/** A Slack web fake: records post targets, opens a stable DM id per user. */
function makeWeb() {
  const posts: { channel: string }[] = [];
  let ts = 0;
  const web = {
    chat: {
      postMessage: async (a: { channel: string }) => {
        posts.push({ channel: a.channel });
        return { ts: `ts-${++ts}` };
      },
      update: async () => ({ ok: true }),
    },
    conversations: {
      open: async (a: { users: string }) => ({ channel: { id: `D-${a.users}` } }),
    },
  };
  return { web, posts };
}

/** A collector fake that records the privileged calls the gate must guard. */
function makeCollector(pendingAsks: Ask[] = []) {
  const resolved: { askId: string; answer: string; actor?: string }[] = [];
  const decided: { planId: string; decision: string; actor?: string }[] = [];
  const collector = {
    sessionTitle: async () => "Session",
    getPendingAsks: async () => pendingAsks,
    getPendingPlans: async () => [] as PlanApproval[],
    setAskUser: async () => {},
    resolveAsk: async (askId: string, answer: string, actor?: string) => {
      resolved.push({ askId, answer, actor });
      return { ok: true };
    },
    decidePlan: async (planId: string, decision: string, actor?: string) => {
      decided.push({ planId, decision, actor });
      return { ok: true };
    },
  };
  return { collector, resolved, decided };
}

/** Steer needs a /send sink for onThreadReply; allowed() never touches it. */
const idleSteerSink: SteerSink = { sendToSession: async () => ({ ok: true }) };

/**
 * The operator-config slice wireSlackAuthority reads. Defaults model a fresh
 * install: nothing configured, so authority is empty until an operator sets it.
 */
function env(
  over: Partial<Pick<SlackEnv, "askUser" | "steerAllowlist" | "ownerMap">> = {},
): Pick<SlackEnv, "askUser" | "steerAllowlist" | "ownerMap"> {
  return {
    askUser: over.askUser,
    steerAllowlist: over.steerAllowlist ?? [],
    ownerMap: over.ownerMap ?? new Map<string, string>(),
  };
}

/** Route every session's ask to one fixed Slack id (mapped-owner delivery). */
const routeTo = (slackId: string): OwnerRouting => ({ routeFor: async () => ({ slackId }) });

const ask = (id: string): Ask =>
  ({
    id,
    sessionId: `s-${id}`,
    question: `Approve ${id}?`,
    kind: "permission_prompt",
    createdAt: "2026-01-01T00:00:00Z",
    status: "pending",
  }) as unknown as Ask;

const plan = (id: string): PlanApproval =>
  ({
    id,
    launchId: `l-${id}`,
    projectId: "web",
    worktreePath: "/tmp/wt",
    status: "awaiting_approval",
    relevantFiles: [],
    plan: "do the thing",
    criterionMet: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as PlanApproval;

let seq = 0;
const cleanups: string[] = [];
function isolateState(): void {
  const p = join(tmpdir(), `standup-answer-auth-${process.pid}-${++seq}.json`);
  process.env.STANDUP_SLACK_ASK_STATE = p;
  cleanups.push(p);
}
afterAll(() => {
  for (const p of cleanups) {
    try {
      rmSync(p, { force: true });
    } catch {
      /* best effort */
    }
  }
});

describe("answering an ask is gated to the authorized set, not the DM-learned recipient", () => {
  test("a non-owner learned as the delivery recipient cannot answer — free-text or button", async () => {
    isolateState();
    const { web } = makeWeb();
    const { collector, resolved } = makeCollector([ask("a1")]);
    // The REAL wiring: authority composed by wireSlackAuthority from operator
    // config only — here nothing is configured (a fresh install).
    const { authorized } = wireSlackAuthority(env(), idleSteerSink);
    const asks = new Asks(web as never, collector as never, undefined, undefined, undefined, authorized);

    // A stranger DMs the bot: learned only as the DELIVERY recipient, and the
    // pending ask is delivered to their DM.
    await asks.noteDmSender("Ustranger", "D-stranger");
    expect(asks.ownerUserId).toBe("Ustranger"); // learned as the delivery recipient…
    expect(asks.hasPendingForDm("D-stranger")).toBe(true); // …and the ask landed in their DM
    expect(authorized("Ustranger")).toBe(false); // …but the learned recipient is NOT the authority

    // …so they may not ANSWER it — not by free-text reply…
    await asks.onDmText("D-stranger", "yes, ship it", "slack:Ustranger", "Ustranger");
    expect(resolved).toHaveLength(0);
    // …nor by tapping the option button on the card.
    await asks.onButton({ askId: "a1", answer: "yes" }, "slack:Ustranger", "Ustranger");
    expect(resolved).toHaveLength(0);
  });

  test("the operator-configured owner (SLACK_ASK_USER) may answer — free-text and button", async () => {
    isolateState();
    const { web } = makeWeb();
    const { collector, resolved } = makeCollector();
    const { authorized } = wireSlackAuthority(env({ askUser: "Uoperator" }), idleSteerSink);
    const asks = new Asks(web as never, collector as never, "Uoperator", undefined, undefined, authorized);

    await asks.onAskNew(ask("a1"));
    await asks.onAskNew(ask("a2"));
    expect(asks.hasPendingForDm("D-Uoperator")).toBe(true);

    await asks.onButton({ askId: "a1", answer: "yes" }, "slack:Uoperator", "Uoperator");
    await asks.onDmText("D-Uoperator", "also yes", "slack:Uoperator", "Uoperator");

    expect(resolved.map((r) => r.askId).sort()).toEqual(["a1", "a2"]);
  });

  test("an allowlisted non-owner (SLACK_STEER_ALLOWLIST) may answer", async () => {
    isolateState();
    const { web } = makeWeb();
    const { collector, resolved } = makeCollector();
    const { authorized } = wireSlackAuthority(env({ steerAllowlist: ["Uhelper"] }), idleSteerSink);
    const asks = new Asks(web as never, collector as never, "Uhelper", undefined, undefined, authorized);

    await asks.onAskNew(ask("a1"));
    await asks.onDmText("D-Uhelper", "go", "slack:Uhelper", "Uhelper");

    expect(resolved).toHaveLength(1);
  });

  test("a mapped owner (SLACK_OWNER_MAP) may answer the ask ROUTED to them — disjoint from SLACK_ASK_USER", async () => {
    // The High: owner routing DMs alice's ask to her mapped Slack id, but she is
    // NOT SLACK_ASK_USER and NOT allowlisted. She must still be able to answer her
    // own routed ask — otherwise the routed owner is stranded and the agent stays
    // blocked (the mirror can be off, so the ask lives only in her DM).
    isolateState();
    const { web } = makeWeb();
    const { collector, resolved } = makeCollector([ask("a1")]);
    const { authorized } = wireSlackAuthority(
      env({ ownerMap: new Map([["alice", "U-ALICE"]]) }), // no askUser, empty allowlist
      idleSteerSink,
    );
    expect(authorized("U-ALICE")).toBe(true); // the mapped owner is authorized…
    expect(authorized("Ustranger")).toBe(false); // …but an unmapped stranger still isn't
    const asks = new Asks(web as never, collector as never, "U-recipient", undefined, routeTo("U-ALICE"), authorized);

    await asks.onAskNew(ask("a1")); // owner-routed → DM'd to D-U-ALICE
    expect(asks.hasPendingForDm("D-U-ALICE")).toBe(true);

    await asks.onDmText("D-U-ALICE", "go ahead", "slack:U-ALICE", "U-ALICE");
    expect(resolved).toEqual([{ askId: "a1", answer: "go ahead", actor: "slack:U-ALICE" }]);
  });

  test("the shipped owner source is SLACK_ASK_USER — reverting it to the DM-learned recipient reopens the bypass", async () => {
    // Pins the exact security wiring. Under wireSlackAuthority the authority owner
    // is env.askUser (unset here); the historical defect sourced it from the
    // learned recipient (asks.ownerUserId). A stranger DMs → becomes the learned
    // recipient; because the factory does NOT consult that, they gain no authority
    // and cannot answer. Reverting the factory's `ownerUserId: () => env.askUser`
    // to the learned recipient flips steer.allowed(stranger) to true and fails
    // both assertions below.
    isolateState();
    const { web } = makeWeb();
    const { collector, resolved } = makeCollector([ask("a1")]);
    const { steer, authorized } = wireSlackAuthority(env(), idleSteerSink);
    const asks = new Asks(web as never, collector as never, undefined, undefined, undefined, authorized);

    await asks.noteDmSender("Ustranger", "D-stranger");
    expect(asks.ownerUserId).toBe("Ustranger"); // the learned recipient…
    expect(steer.allowed("Ustranger")).toBe(false); // …is not the authority (reverting flips this true)

    await asks.onDmText("D-stranger", "yes", "slack:Ustranger", "Ustranger");
    await asks.onButton({ askId: "a1", answer: "yes" }, "slack:Ustranger", "Ustranger");
    expect(resolved).toHaveLength(0); // the bypass the shipped wiring closes stays closed
  });
});

describe("deciding a plan is gated to the authorized set, not the DM-learned recipient", () => {
  test("a non-owner delivery recipient cannot approve or reject", async () => {
    isolateState();
    const { web } = makeWeb();
    const { collector, decided } = makeCollector();
    const { authorized } = wireSlackAuthority(env(), idleSteerSink);
    const asks = new Asks(web as never, collector as never, undefined, undefined, undefined, authorized);
    const plans = new Plans(web as never, collector as never, asks, "http://localhost:5173", authorized);

    // The stranger becomes the delivery recipient, so the plan routes to their DM.
    await asks.noteDmSender("Ustranger", "D-stranger");
    await plans.onPlanUpdated(plan("p1"));

    await plans.onButton({ planId: "p1", decision: "approve" }, "slack:Ustranger", "Ustranger");
    await plans.onButton({ planId: "p1", decision: "reject" }, "slack:Ustranger", "Ustranger");
    expect(decided).toHaveLength(0);
  });

  test("the operator-configured owner may approve", async () => {
    isolateState();
    const { web } = makeWeb();
    const { collector, decided } = makeCollector();
    const { authorized } = wireSlackAuthority(env({ askUser: "Uoperator" }), idleSteerSink);
    const asks = new Asks(web as never, collector as never, "Uoperator", undefined, undefined, authorized);
    const plans = new Plans(web as never, collector as never, asks, "http://localhost:5173", authorized);

    await plans.onPlanUpdated(plan("p1")); // routed to the owner's DM
    await plans.onButton({ planId: "p1", decision: "approve" }, "slack:Uoperator", "Uoperator");

    expect(decided).toEqual([{ planId: "p1", decision: "approve", actor: "slack:Uoperator" }]);
  });

  test("a mapped owner (SLACK_OWNER_MAP) may approve their plan — disjoint from SLACK_ASK_USER", async () => {
    // The High, for plans: a mapped owner who is neither SLACK_ASK_USER nor
    // allowlisted must still be able to approve/reject.
    isolateState();
    const { web } = makeWeb();
    const { collector, decided } = makeCollector();
    const { authorized } = wireSlackAuthority(
      env({ ownerMap: new Map([["alice", "U-ALICE"]]) }),
      idleSteerSink,
    );
    const asks = new Asks(web as never, collector as never, "U-recipient", undefined, undefined, authorized);
    const plans = new Plans(web as never, collector as never, asks, "http://localhost:5173", authorized);

    await plans.onPlanUpdated(plan("p1"));
    await plans.onButton({ planId: "p1", decision: "approve" }, "slack:U-ALICE", "U-ALICE");

    expect(decided).toEqual([{ planId: "p1", decision: "approve", actor: "slack:U-ALICE" }]);
  });
});
