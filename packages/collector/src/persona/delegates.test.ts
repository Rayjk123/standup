import { describe, expect, test } from "bun:test";
import {
  DELEGATE_AGENTS,
  DELEGATE_ROUTES,
  HOLD_DELEGATE,
  delegateEventOf,
  delegateSwitchVar,
  resolveDelegateSwitches,
  routeEvent,
} from "./delegates.js";
import type { DelegateAgent, DelegateRoute } from "./delegates.js";
import { resolvePersonaConfig } from "./config.js";

const allOn = () => true;

describe("the default routes", () => {
  const cases: Array<{ name: string; payload: Record<string, unknown>; want: string | null }> = [
    { name: "a safety_floor hold", payload: { type: "ask", ask: { id: "a1", kind: "permission_prompt", gate: "safety_floor" } }, want: "hold-delegate" },
    { name: "a safety_floor_owner hold", payload: { type: "ask", ask: { id: "a2", kind: "permission_prompt", gate: "safety_floor_owner" } }, want: "hold-delegate" },
    { name: "a tool-permission prompt", payload: { type: "ask", ask: { id: "a3", kind: "permission_prompt" } }, want: "hold-delegate" },
    { name: "a worker's question", payload: { type: "ask", ask: { id: "a4", kind: "ask_human" } }, want: null },
    { name: "a confirmation-gate question", payload: { type: "ask", ask: { id: "a5", kind: "ask_human", gate: "confirm" } }, want: null },
    { name: "a plan", payload: { type: "plan", plan: { id: "p1" } }, want: null },
    { name: "a turn end", payload: { type: "turn_end", status: "idle" }, want: null },
    { name: "a run that ended", payload: { type: "run", status: "failed" }, want: null },
  ];
  for (const c of cases) {
    test(`${c.name} → ${c.want ?? "the main Persona"}`, () => {
      expect(routeEvent(delegateEventOf(c.payload), allOn)).toBe(c.want);
    });
  }

  test("an agent that is off leaves its events to the main Persona", () => {
    const hold = { type: "ask", ask: { id: "a1", kind: "permission_prompt", gate: "safety_floor" } };
    expect(routeEvent(delegateEventOf(hold), (id) => id !== HOLD_DELEGATE.id)).toBeNull();
  });

  test("every route names a registered agent, and every agent's escalation target exists", () => {
    const ids = new Set(DELEGATE_AGENTS.map((a) => a.id));
    for (const route of DELEGATE_ROUTES) expect(ids.has(route.agent)).toBe(true);
    for (const agent of DELEGATE_AGENTS) expect(agent.escalateTo === "main" || ids.has(agent.escalateTo)).toBe(true);
  });

  test("the hold delegate's tools are the read-only ones and answer_ask, nothing that launches, messages or closes", () => {
    expect([...HOLD_DELEGATE.tools].sort()).toEqual(["answer_ask", "read_session", "search_thread", "session_status"]);
    for (const name of HOLD_DELEGATE.tools) expect(HOLD_DELEGATE.role("owner")).toContain(name);
  });

  test("every agent's escalations end at the main Persona", () => {
    const byId = new Map(DELEGATE_AGENTS.map((a) => [a.id, a]));
    for (const agent of DELEGATE_AGENTS) {
      const seen = new Set<string>();
      let at: string = agent.id;
      while (at !== "main") {
        expect(seen.has(at)).toBe(false);
        seen.add(at);
        at = byId.get(at)!.escalateTo;
      }
    }
  });
});

describe("route order", () => {
  const routes: DelegateRoute[] = [
    { name: "docs project holds", match: (e) => e.type === "ask" && e.projectId === "docs", agent: "docs-agent" },
    { name: "every hold", match: (e) => e.type === "ask", agent: "hold-agent" },
  ];
  const cases: Array<{ name: string; event: Record<string, unknown>; enabled: string[]; want: string | null }> = [
    { name: "the first matching route wins", event: { type: "ask", projectId: "docs" }, enabled: ["docs-agent", "hold-agent"], want: "docs-agent" },
    { name: "a later route takes what the first doesn't match", event: { type: "ask", projectId: "web" }, enabled: ["docs-agent", "hold-agent"], want: "hold-agent" },
    { name: "a route whose agent is off is passed over", event: { type: "ask", projectId: "docs" }, enabled: ["hold-agent"], want: "hold-agent" },
    { name: "nothing on matches → main", event: { type: "ask", projectId: "docs" }, enabled: [], want: null },
    { name: "an unmatched event → main", event: { type: "plan" }, enabled: ["docs-agent", "hold-agent"], want: null },
  ];
  for (const c of cases) {
    test(c.name, () => {
      expect(routeEvent(c.event, (id) => c.enabled.includes(id), routes)).toBe(c.want);
    });
  }
});

describe("the off switches", () => {
  const second: DelegateAgent = { ...HOLD_DELEGATE, id: "review-helper" };
  const agents = [HOLD_DELEGATE, second];
  const cases: Array<{ name: string; env: Record<string, string>; want: Record<string, boolean> }> = [
    { name: "on by default", env: {}, want: { "hold-delegate": true, "review-helper": true } },
    { name: "STANDUP_PERSONA_DELEGATES=0 turns all off", env: { STANDUP_PERSONA_DELEGATES: "0" }, want: { "hold-delegate": false, "review-helper": false } },
    { name: "one agent off", env: { STANDUP_PERSONA_DELEGATE_HOLD_DELEGATE: "0" }, want: { "hold-delegate": false, "review-helper": true } },
    {
      name: "an agent's own switch overrides the global one",
      env: { STANDUP_PERSONA_DELEGATES: "off", STANDUP_PERSONA_DELEGATE_REVIEW_HELPER: "1" },
      want: { "hold-delegate": false, "review-helper": true },
    },
    { name: "any value but 1/on/true/yes is off", env: { STANDUP_PERSONA_DELEGATES: "disabled" }, want: { "hold-delegate": false, "review-helper": false } },
    { name: "an empty switch leaves the default", env: { STANDUP_PERSONA_DELEGATE_HOLD_DELEGATE: " " }, want: { "hold-delegate": true, "review-helper": true } },
  ];
  for (const c of cases) {
    test(c.name, () => {
      expect(resolveDelegateSwitches(c.env, agents)).toEqual(c.want);
    });
  }

  test("an agent's switch is named after its id", () => {
    expect(delegateSwitchVar("hold-delegate")).toBe("STANDUP_PERSONA_DELEGATE_HOLD_DELEGATE");
  });

  test("Persona's config carries the switches", () => {
    expect(resolvePersonaConfig({}).delegates).toEqual({ "hold-delegate": true });
    expect(resolvePersonaConfig({ STANDUP_PERSONA_DELEGATES: "0" }).delegates).toEqual({ "hold-delegate": false });
  });
});
