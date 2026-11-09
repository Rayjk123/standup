// Safety-floor holds answered from Slack: only the owner may allow one (and
// only their allow carries the owner token the collector requires), anyone the
// answer gate admits may deny one, and a floor hold takes only its exact option
// labels. The collector client presents the owner token only when asked to.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ask } from "@standup/shared";
import { OWNER_TOKEN_HEADER } from "@standup/shared/owner-token";
import { Asks, FLOOR_ALLOW_OPTION, FLOOR_DENY_OPTION, exactFloorOption, isFloorAsk, ownerAnswers } from "./asks.js";
import { CollectorClient } from "./collector-client.js";

const OWNER = "U-OWNER";
const HELPER = "U-HELPER";

function makeWeb() {
  const posts: { channel: string; text?: string }[] = [];
  let ts = 0;
  const web = {
    chat: {
      postMessage: async (a: { channel: string; text?: string }) => {
        posts.push({ channel: a.channel, text: a.text });
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

function makeCollector(pending: Ask[]) {
  const resolved: { askId: string; answer: string; actor?: string; asOwner: boolean }[] = [];
  const collector = {
    sessionTitle: async () => "Session",
    getPendingAsks: async () => pending,
    setAskUser: async () => {},
    resolveAsk: async (askId: string, answer: string, actor?: string, asOwner = false) => {
      resolved.push({ askId, answer, actor, asOwner });
      return { ok: true };
    },
  };
  return { collector, resolved };
}

const floorAsk = (id: string, gate = "safety_floor_owner"): Ask =>
  ({
    id,
    sessionId: `s-${id}`,
    kind: "ask_human",
    question: "Safety floor held a Bash call (outward): pushes",
    options: [FLOOR_ALLOW_OPTION, FLOOR_DENY_OPTION],
    gate,
    status: "pending",
    createdAt: "2026-01-01T00:00:00Z",
  }) as unknown as Ask;

let seq = 0;
const cleanups: string[] = [];
function isolateState(): void {
  const p = join(tmpdir(), `standup-floor-asks-${process.pid}-${++seq}.json`);
  process.env.STANDUP_SLACK_ASK_STATE = p;
  cleanups.push(p);
}
afterAll(() => {
  for (const p of cleanups) rmSync(p, { force: true });
});

/** Asks wired with an answer gate admitting the owner and a helper, and the owner as the floor owner. */
function wired(pending: Ask[]) {
  isolateState();
  const { web, posts } = makeWeb();
  const { collector, resolved } = makeCollector(pending);
  const asks = new Asks(web as never, collector as never, OWNER, undefined, undefined, (u) => u === OWNER || u === HELPER);
  asks.setFloorOwner((u) => u === OWNER);
  return { asks, posts, resolved };
}

describe("floor holds from Slack", () => {
  test("a non-owner can't allow a floor hold — by button or by text — and nothing is sent", async () => {
    const { asks, posts, resolved } = wired([floorAsk("f1")]);
    await asks.onButton({ askId: "f1", answer: FLOOR_ALLOW_OPTION }, "slack:U-HELPER", HELPER);
    await asks.onDmThreadReply("f1", "D-x", FLOOR_ALLOW_OPTION, "slack:U-HELPER", HELPER);
    expect(resolved).toHaveLength(0);
    expect(posts.some((p) => p.text === Asks.FLOOR_ALLOW_DENIED_NOTICE)).toBe(true);
  });

  test("a non-owner may deny a floor hold, without the owner token", async () => {
    const { asks, resolved } = wired([floorAsk("f2")]);
    await asks.onButton({ askId: "f2", answer: FLOOR_DENY_OPTION }, "slack:U-HELPER", HELPER);
    expect(resolved).toEqual([{ askId: "f2", answer: FLOOR_DENY_OPTION, actor: "slack:U-HELPER", asOwner: false }]);
  });

  test("the owner's allow is sent with the owner token", async () => {
    const { asks, resolved } = wired([floorAsk("f3", "safety_floor")]);
    await asks.onButton({ askId: "f3", answer: FLOOR_ALLOW_OPTION }, "slack:U-OWNER", OWNER);
    expect(resolved).toEqual([{ askId: "f3", answer: FLOOR_ALLOW_OPTION, actor: "slack:U-OWNER", asOwner: true }]);
  });

  test("a floor hold takes only its exact option labels, even from the owner", async () => {
    const { asks, posts, resolved } = wired([floorAsk("f4")]);
    for (const text of ["yes", "allow", "ok go ahead", "Allow once please", "deny it"]) {
      await asks.onDmThreadReply("f4", "D-x", text, "slack:U-OWNER", OWNER);
    }
    expect(resolved).toHaveLength(0);
    expect(posts.filter((p) => p.text === Asks.FLOOR_EXACT_NOTICE)).toHaveLength(5);
    await asks.onDmThreadReply("f4", "D-x", "  Allow once ", "slack:U-OWNER", OWNER);
    expect(resolved).toEqual([{ askId: "f4", answer: FLOOR_ALLOW_OPTION, actor: "slack:U-OWNER", asOwner: true }]);
  });

  test("without a floor owner configured nobody may allow from Slack", async () => {
    isolateState();
    const { web } = makeWeb();
    const { collector, resolved } = makeCollector([floorAsk("f5")]);
    const asks = new Asks(web as never, collector as never, OWNER, undefined, undefined, () => true);
    await asks.onButton({ askId: "f5", answer: FLOOR_ALLOW_OPTION }, "slack:U-OWNER", OWNER);
    expect(resolved).toHaveLength(0);
  });

  test("an ordinary ask is answered as before, without the token", async () => {
    const ordinary = { ...floorAsk("o1"), gate: undefined, options: ["yes", "no"] } as unknown as Ask;
    const { asks, resolved } = wired([ordinary]);
    await asks.onButton({ askId: "o1", answer: "yes" }, "slack:U-HELPER", HELPER);
    expect(resolved).toEqual([{ askId: "o1", answer: "yes", actor: "slack:U-HELPER", asOwner: false }]);
  });

  test("the owner's answer to a permission prompt or a self-fix confirmation carries the owner token; a teammate's doesn't", async () => {
    const prompt = { ...floorAsk("p1"), kind: "permission_prompt", gate: undefined, options: ["Yes", "No"] } as unknown as Ask;
    const fix = { ...floorAsk("i1"), gate: "standup_improvement", options: ["Fire the fix", "Not now"] } as unknown as Ask;
    const { asks, resolved } = wired([prompt, fix]);
    await asks.onButton({ askId: "p1", answer: "Yes" }, "slack:U-OWNER", OWNER);
    await asks.onButton({ askId: "i1", answer: "Fire the fix" }, "slack:U-HELPER", HELPER);
    expect(resolved).toEqual([
      { askId: "p1", answer: "Yes", actor: "slack:U-OWNER", asOwner: true },
      { askId: "i1", answer: "Fire the fix", actor: "slack:U-HELPER", asOwner: false },
    ]);
    expect(ownerAnswers({ kind: "permission_prompt", gate: "idle_notice" } as Ask)).toBe(false);
  });

  test("helpers", () => {
    expect(isFloorAsk(floorAsk("x"))).toBe(true);
    expect(isFloorAsk({ gate: "standup_improvement" } as Ask)).toBe(false);
    expect(exactFloorOption(floorAsk("x"), "Deny")).toBe(FLOOR_DENY_OPTION);
    expect(exactFloorOption(floorAsk("x"), "deny")).toBeUndefined();
  });
});

describe("CollectorClient owner token", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  afterEach(() => server?.stop(true));

  test("resolveAsk presents the owner token only when asked; Persona writes always do", async () => {
    const seen: { path: string; token: string | null }[] = [];
    server = Bun.serve({
      port: 0,
      fetch(req) {
        seen.push({ path: new URL(req.url).pathname, token: req.headers.get(OWNER_TOKEN_HEADER) });
        return Response.json({ ok: true, approval: { id: "ap1" } });
      },
    });
    const client = new CollectorClient(`http://127.0.0.1:${server.port}`, "ws://unused", { onMessage: () => {}, onReconnect: () => {} }, () => "owner-secret");
    await client.resolveAsk("a1", "Deny");
    await client.resolveAsk("a1", FLOOR_ALLOW_OPTION, "slack:U", true);
    await client.personaApprove("alice", "ap1");
    expect(seen).toEqual([
      { path: "/api/asks/a1/resolve", token: null },
      { path: "/api/asks/a1/resolve", token: "owner-secret" },
      { path: "/api/persona/approvals/ap1/approve", token: "owner-secret" },
    ]);
  });
});
