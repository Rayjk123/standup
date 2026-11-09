// Launch-gate predicates + bot-launch dispatch. Capabilities-only: recording
// fakes stand in for the collector's launch/project-list and Slack notices, so NO
// live Slack or HTTP call runs. Covers WHO may launch across the DM and @-mention
// surfaces (explicit owner/allowlist only — no first-requester bootstrap), that a
// pending ask claims a "launch …" DM reply as its answer, and — end to end through
// the real handleBotLaunch → launchIsAllowed → LaunchFromSlack path — that an
// unauthorized requester spawns NO session and concurrent first-DM launches can't
// both pass. The final block drives the REAL Asks.noteDmSender learn-from-DM path
// wired exactly as index.ts wires Steer, proving the launch/steer authority is
// decoupled from the DM-learned recipient (the two-step bootstrap + owner-hijack).

import { describe, expect, test } from "bun:test";
import type { Launch } from "@standup/shared";
import type { LaunchOutcome } from "./collector-client.js";
import { Asks } from "./asks.js";
import { InboundDedup } from "./inbound-dedup.js";
import { LaunchFromSlack, type LaunchSink } from "./launch.js";
import { parseLaunchCommand } from "./launch-command.js";
import { Steer, type SteerSink } from "./steer.js";
import {
  launchIsAllowed,
  dmShouldTryLaunch,
  handleBotLaunch,
  type BotLaunchDispatch,
} from "./launch-gate.js";

describe("launchIsAllowed", () => {
  test("an owner or allowlisted user may launch", () => {
    expect(launchIsAllowed({ userId: "Uowner", ownerOrAllowlisted: true })).toBe(true);
  });

  test("a missing user id is never allowed", () => {
    expect(launchIsAllowed({ userId: undefined, ownerOrAllowlisted: true })).toBe(false);
  });

  test("a non-owner, non-allowlisted requester is refused — no first-requester bootstrap", () => {
    // The High finding: on a fresh install, whoever DMs "launch …" first must NOT
    // be trusted to spawn a repo-modifying agent on the operator's host. Launching
    // requires explicit authorization — an allowlist entry or a claimed owner.
    expect(launchIsAllowed({ userId: "Ustranger", ownerOrAllowlisted: false })).toBe(false);
  });
});

describe("dmShouldTryLaunch", () => {
  test("a launch command with no pending ask is a launch", () => {
    expect(dmShouldTryLaunch({ hasPendingAsk: false, isLaunchCommand: true })).toBe(true);
  });

  test("a pending ask claims a 'launch …' reply as its answer, not a launch", () => {
    // "launch the deploy in prod mode" answering an open ask must resolve the ask,
    // not spawn a new session and strand the agent.
    expect(dmShouldTryLaunch({ hasPendingAsk: true, isLaunchCommand: true })).toBe(false);
  });

  test("a non-launch message is never a launch", () => {
    expect(dmShouldTryLaunch({ hasPendingAsk: false, isLaunchCommand: false })).toBe(false);
    expect(dmShouldTryLaunch({ hasPendingAsk: true, isLaunchCommand: false })).toBe(false);
  });
});

function fakeLaunch(over: Partial<Launch> = {}): Launch {
  return {
    id: "launch-1",
    kind: "worktree",
    projectId: "scratch",
    task: "t",
    worktreePath: "/tmp/wt",
    branch: "standup/x",
    status: "starting",
    keepAlive: false,
    createdAt: new Date(),
    ...over,
  };
}

/** Records every launch call so tests can assert whether a session was spawned. */
class RecordingCollector implements LaunchSink {
  readonly calls: { projectId: string; task: string; actor?: string }[] = [];
  launch = async (
    projectId: string,
    task: string,
    opts: { actor?: string; idempotencyKey?: string } = {},
  ): Promise<LaunchOutcome> => {
    this.calls.push({ projectId, task, actor: opts.actor });
    return { ok: true, launch: fakeLaunch() };
  };
  listProjects = async () => [];
}

/** Steer needs a /send sink for onThreadReply; the gate's allowed() never uses it. */
const idleSteerSink: SteerSink = {
  sendToSession: async () => ({ ok: true }),
};

interface Notice {
  channel: string;
  text: string;
}

/**
 * Reconstruct the router's bot-launch wiring (index.ts launchFromBotMessage): the
 * REAL handleBotLaunch drives the REAL launchIsAllowed gate, dedup, denial notice,
 * and LaunchFromSlack — only the collector + Slack post are faked. So these tests
 * exercise the same authorization path the DM / @-mention surfaces run.
 */
function makeBotLaunch(steer: Steer, launcher: LaunchFromSlack, notices: Notice[]) {
  const dedup = new InboundDedup();
  return (a: { channel: string; text: string; userId?: string; key: string }): Promise<boolean> => {
    const dispatch: BotLaunchDispatch = {
      seen: (k) => dedup.seen(k),
      allowed: (u) => steer.allowed(u),
      denied: async () => {
        notices.push({ channel: a.channel, text: Steer.DENIED_NOTICE });
      },
      launch: () =>
        launcher.tryLaunch({ channel: a.channel, threadTs: "", text: a.text, idempotencyKey: a.key }),
    };
    return handleBotLaunch(
      { isLaunchCommand: parseLaunchCommand(a.text) !== null, userId: a.userId, key: a.key },
      dispatch,
    );
  };
}

describe("handleBotLaunch authorization", () => {
  test("a non-owner, non-allowlisted member DMing 'launch …' is REFUSED — no session spawned", async () => {
    // Fresh install: no owner claimed, no allowlist configured.
    const steer = new Steer(idleSteerSink, { ownerUserId: () => undefined });
    const collector = new RecordingCollector();
    const launcher = new LaunchFromSlack(collector, { webUrl: "http://localhost:5173" });
    const notices: Notice[] = [];
    const botLaunch = makeBotLaunch(steer, launcher, notices);

    const handled = await botLaunch({
      channel: "D1",
      text: "launch delete everything in web",
      userId: "Ustranger",
      key: "cm-1",
    });

    expect(handled).toBe(true); // the launch command was consumed…
    expect(collector.calls).toHaveLength(0); // …but NO session was spawned
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toBe(Steer.DENIED_NOTICE);
  });

  test("two concurrent first-DM launches from different users cannot both pass", async () => {
    // The Medium finding: the gate reads only persisted owner/allowlist state and
    // never claims ownership, so neither racer bootstraps a claim the other rides.
    const steer = new Steer(idleSteerSink, { ownerUserId: () => undefined });
    const collector = new RecordingCollector();
    const launcher = new LaunchFromSlack(collector, { webUrl: "http://localhost:5173" });
    const notices: Notice[] = [];
    const botLaunch = makeBotLaunch(steer, launcher, notices);

    await Promise.all([
      botLaunch({ channel: "D1", text: "launch a thing in web", userId: "Ualice", key: "cm-a" }),
      botLaunch({ channel: "D2", text: "launch a thing in web", userId: "Ubob", key: "cm-b" }),
    ]);

    // Neither passes on an unclaimed bot — zero sessions, not one, not two.
    expect(collector.calls).toHaveLength(0);
    expect(notices).toHaveLength(2);
  });

  test("the already-claimed owner may launch (one session spawned)", async () => {
    const steer = new Steer(idleSteerSink, { ownerUserId: () => "Uowner" });
    const collector = new RecordingCollector();
    const launcher = new LaunchFromSlack(collector, { webUrl: "http://localhost:5173" });
    const botLaunch = makeBotLaunch(steer, launcher, []);

    const handled = await botLaunch({
      channel: "D1",
      text: "launch add a health check in web",
      userId: "Uowner",
      key: "cm-1",
    });

    expect(handled).toBe(true);
    expect(collector.calls).toHaveLength(1);
  });

  test("an allowlisted user may launch even before any owner is claimed", async () => {
    const steer = new Steer(idleSteerSink, { ownerUserId: () => undefined, allowlist: ["Uhelper"] });
    const collector = new RecordingCollector();
    const launcher = new LaunchFromSlack(collector, { webUrl: "http://localhost:5173" });
    const botLaunch = makeBotLaunch(steer, launcher, []);

    await botLaunch({ channel: "D1", text: "launch fix the flaky test", userId: "Uhelper", key: "cm-1" });

    expect(collector.calls).toHaveLength(1);
  });

  test("a non-launch message is not handled — the caller keeps its ask/steer behavior", async () => {
    const steer = new Steer(idleSteerSink, { ownerUserId: () => "Uowner" });
    const collector = new RecordingCollector();
    const launcher = new LaunchFromSlack(collector, { webUrl: "http://localhost:5173" });
    const botLaunch = makeBotLaunch(steer, launcher, []);

    const handled = await botLaunch({ channel: "D1", text: "run the tests", userId: "Uowner", key: "cm-1" });

    expect(handled).toBe(false);
    expect(collector.calls).toHaveLength(0);
  });
});

/**
 * A real Asks backed by no-op Slack/collector fakes, so its learn-from-DM path
 * (noteDmSender) runs end to end with NO live call. `configuredAskUser` seeds the
 * ask recipient the way index.ts does from SLACK_ASK_USER / the persisted setting.
 */
function makeAsks(configuredAskUser?: string): Asks {
  const web = {
    chat: { postMessage: async () => ({ ts: "ts-1" }), update: async () => ({ ok: true }) },
    conversations: { open: async () => ({ channel: { id: "D-x" } }) },
  };
  const collector = {
    sessionTitle: async () => "Session",
    getPendingAsks: async () => [],
    setAskUser: async () => {},
    resolveAsk: async () => ({ ok: true }),
  };
  return new Asks(web as never, collector as never, configuredAskUser, undefined);
}

// The auth-bypass regression: launch/steer authority must come from the
// operator-configured owner (SLACK_ASK_USER, modeled as the Steer `ownerUserId`
// callback index.ts wires) — NEVER from the DM-learned recipient that
// Asks.noteDmSender bootstraps from any sender. These drive the REAL Asks through
// noteDmSender and the REAL handleBotLaunch → launchIsAllowed → LaunchFromSlack
// path, closing the coverage gap the prior tests left (they hardcoded the owner
// and never exercised noteDmSender).
describe("launch authority is decoupled from the DM-learned recipient", () => {
  test("a benign DM learns the ask recipient but grants NO launch rights (two-step bootstrap closed)", async () => {
    // Fresh install: no SLACK_ASK_USER, empty allowlist.
    const asks = makeAsks();

    // Step 1: a stranger sends a benign, non-launch DM. index.ts's DM router falls
    // through to noteDmSender, which learns them as the ask DELIVERY recipient.
    await asks.noteDmSender("Ustranger", "D1");
    expect(asks.ownerUserId).toBe("Ustranger"); // learned as the delivery recipient…

    // …and the OLD wiring (ownerUserId: () => asks.ownerUserId) WOULD have trusted
    // that learned recipient as the owner — that was the bypass. Prove the learned
    // recipient really is the stranger, so the refusal below isn't vacuous.
    const oldVulnerableWiring = new Steer(idleSteerSink, { ownerUserId: () => asks.ownerUserId });
    expect(oldVulnerableWiring.allowed("Ustranger")).toBe(true);

    // The SHIPPED wiring reads only the operator-configured owner (env.askUser),
    // unset on a fresh install — so the stranger is refused.
    const steer = new Steer(idleSteerSink, { ownerUserId: () => undefined /* env.askUser */ });
    expect(steer.allowed("Ustranger")).toBe(false);

    // Step 2: the stranger now DMs "launch …". handleBotLaunch → launchIsAllowed →
    // steer.allowed → refused; NO session spawned.
    const collector = new RecordingCollector();
    const launcher = new LaunchFromSlack(collector, { webUrl: "http://localhost:5173" });
    const notices: Notice[] = [];
    const botLaunch = makeBotLaunch(steer, launcher, notices);

    const handled = await botLaunch({
      channel: "D1",
      text: "launch delete everything in web",
      userId: "Ustranger",
      key: "cm-2",
    });

    expect(handled).toBe(true); // consumed as a launch command…
    expect(collector.calls).toHaveLength(0); // …but NO session spawned
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toBe(Steer.DENIED_NOTICE);
  });

  test("a later DM sender cannot hijack the operator-configured owner's launch rights", async () => {
    // Install seeded with an explicit owner. Authority reads that configured owner,
    // never the learned recipient (modeled by wiring ownerUserId to the constant).
    const asks = makeAsks("Uoperator");
    const steer = new Steer(idleSteerSink, { ownerUserId: () => "Uoperator" /* env.askUser */ });

    // An attacker DMs a benign message — noteDmSender overwrites the DELIVERY
    // recipient (last-writer-wins)… but that must not move launch authority.
    await asks.noteDmSender("Uattacker", "D2");
    expect(asks.ownerUserId).toBe("Uattacker"); // delivery recipient hijacked…
    expect(steer.allowed("Uattacker")).toBe(false); // …authority unchanged
    expect(steer.allowed("Uoperator")).toBe(true);

    const collector = new RecordingCollector();
    const launcher = new LaunchFromSlack(collector, { webUrl: "http://localhost:5173" });
    const notices: Notice[] = [];
    const botLaunch = makeBotLaunch(steer, launcher, notices);

    await botLaunch({ channel: "D2", text: "launch wipe prod in web", userId: "Uattacker", key: "cm-3" });
    expect(collector.calls).toHaveLength(0); // attacker refused

    await botLaunch({ channel: "D3", text: "launch add a health check in web", userId: "Uoperator", key: "cm-4" });
    expect(collector.calls).toHaveLength(1); // configured owner allowed
  });

  test("two concurrent first-DM launches through the real learn-from-DM path both fail", async () => {
    // The race: on a fresh install two strangers each DM then "launch …" at once.
    // Authority reads the constant configured owner (unset), so no launch can
    // bootstrap a claim the other rides — neither passes.
    const asks = makeAsks();
    const steer = new Steer(idleSteerSink, { ownerUserId: () => undefined /* env.askUser */ });
    const collector = new RecordingCollector();
    const launcher = new LaunchFromSlack(collector, { webUrl: "http://localhost:5173" });
    const notices: Notice[] = [];
    const botLaunch = makeBotLaunch(steer, launcher, notices);

    await Promise.all([
      (async () => {
        await asks.noteDmSender("Ualice", "D1");
        await botLaunch({ channel: "D1", text: "launch a thing in web", userId: "Ualice", key: "cm-a" });
      })(),
      (async () => {
        await asks.noteDmSender("Ubob", "D2");
        await botLaunch({ channel: "D2", text: "launch a thing in web", userId: "Ubob", key: "cm-b" });
      })(),
    ]);

    expect(collector.calls).toHaveLength(0);
    expect(notices).toHaveLength(2);
  });
});
