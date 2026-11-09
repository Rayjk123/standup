import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createAsk, getAsk } from "@standup/store";
import { exampleCorpProfile } from "../org-profile/fixtures/example-corp.js";
import { setActiveOrgProfile } from "../org-profile/load.js";
import { PERSONA_TOKEN_HEADER } from "./routes.js";
import { ESCALATE_TOOL, HOLD_DELEGATE } from "./delegates.js";
import { ROUTINE, harness as openHarness, hold, laneCaller, until } from "./delegate-test-harness.js";
import type { Harness } from "./delegate-test-harness.js";

// The example.corp fixture profile: ROUTINE prints its SSO cookie, a hold Persona decides.
beforeAll(() => setActiveOrgProfile(exampleCorpProfile()));
afterAll(() => setActiveOrgProfile());

/*
 * What a delegate lane's token reaches: the Persona tool routes, serving its
 * agent's allowlist and escalate, only inside its turn; no other route.
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

const toolsWith = async (h: Harness, token: string) => {
  const res = await h.app.request("/api/persona/tools", { headers: { [PERSONA_TOKEN_HEADER]: token } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
};

describe("a delegate lane's token", () => {
  test("lists only its agent's tools and escalate", async () => {
    const h = harness();
    const [lane] = h.runtime.delegateLanes();
    expect(lane!.agent.id).toBe(HOLD_DELEGATE.id);
    expect((await toolsWith(h, lane!.token)).sort()).toEqual([...HOLD_DELEGATE.tools, ESCALATE_TOOL].sort());
  });

  test("the main Persona's catalog has no escalate", async () => {
    const h = harness();
    const names = await toolsWith(h, h.runtime.token);
    expect(names).not.toContain(ESCALATE_TOOL);
    expect(names).toContain("launch_session");
  });

  test("refuses every tool outside the allowlist, inside its turn too", async () => {
    const h = harness();
    const refused: Array<{ name: string; isError?: boolean; text: string }> = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.rules.push({
      match: ROUTINE,
      act: async (askId, call) => {
        for (const name of ["launch_session", "send_to_session", "ask_user", "close_job", "update_job", "set_pipeline", "remember", "notify"]) {
          refused.push({ name, ...(await call(name, { askId, sessionId: h.sessionId, jobId: h.job.id, text: "x" })) });
        }
        await gate;
      },
    });
    await hold(h, ROUTINE);
    await until(() => refused.length === 8, "the refusals");
    for (const r of refused) {
      expect(r.isError).toBe(true);
      expect(r.text).toContain(`${r.name} is not one of ${HOLD_DELEGATE.id}'s tools`);
    }
    release();
  });

  test("its tools run only inside its turn", async () => {
    const h = harness();
    const [lane] = h.runtime.delegateLanes();
    const call = laneCaller(h, lane!.token);
    const { askId } = await hold(h, ROUTINE);
    await until(() => h.laneTurns.length === 1, "the delegate turn");
    await until(() => h.mainTurns.length === 1, "its escalation");
    const outside = await call("answer_ask", { askId, answer: "Allow once", reason: "late" });
    expect(outside.isError).toBe(true);
    expect(outside.text).toContain("run only inside its turn");
    expect(getAsk(h.store.db, askId)!.status).toBe("pending");
  });

  test("answers only the asks its turn is settling", async () => {
    const h = harness();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const other = createAsk(h.store.db, h.sessionId, "ask_human", "Which wiki space should the sync write to?");
    let answer: { isError?: boolean; text: string } | undefined;
    h.rules.push({
      match: ROUTINE,
      act: async (_askId, call) => {
        answer = await call("answer_ask", { askId: other.id, answer: "the docs space", reason: "the brief names it" });
        await gate;
      },
    });
    await hold(h, ROUTINE);
    await until(() => answer, "the delegate's answer");
    expect(answer!.isError).toBe(true);
    expect(answer!.text).toContain("is not one of the events this turn is settling");
    expect(getAsk(h.store.db, other.id)!.status).toBe("pending");
    release();
  });

  test("is not a Persona token anywhere else: it can't allow a hold through the ask route", async () => {
    const h = harness();
    const [lane] = h.runtime.delegateLanes();
    const { askId } = await hold(h, ROUTINE);
    const res = await h.app.request(`/api/asks/${askId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", [PERSONA_TOKEN_HEADER]: lane!.token },
      body: JSON.stringify({ answer: "Allow once" }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(getAsk(h.store.db, askId)!.status).toBe("pending");
    const state = await h.app.request("/api/persona/state", { headers: { [PERSONA_TOKEN_HEADER]: lane!.token } });
    expect(state.status).toBeGreaterThanOrEqual(400);
  });

  test("an unknown token is refused on the tool routes", async () => {
    const h = harness();
    const res = await h.app.request("/api/persona/tools", { headers: { [PERSONA_TOKEN_HEADER]: "x".repeat(64) } });
    expect(res.status).toBe(401);
  });
});
