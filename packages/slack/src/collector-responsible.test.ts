// CollectorClient.sessionResponsible drives the Slack owner-routing decision:
// it resolves the session's responsible human (owner → creator → earliest
// participant) from GET /api/sessions/:id, so a self-launched session (creator
// set, owner unclaimed) routes to the creator instead of being suppressed as
// owner-less. The tri-state — alias / null (genuinely unattributed → no
// channel-wide broadcast; see routeForResponsible) / undefined (fetch failed →
// fall back) — is asserted here against a stubbed fetch, no live collector.

import { afterEach, describe, expect, test } from "bun:test";
import type { Session } from "@standup/shared";
import { CollectorClient } from "./collector-client.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function clientReturning(session: Partial<Session> | null, ok = true): CollectorClient {
  globalThis.fetch = (async () =>
    ({
      ok,
      json: async () => session,
    }) as unknown as Response) as unknown as typeof fetch;
  return new CollectorClient("http://collector.test", "ws://collector.test", {
    onMessage: () => {},
    onReconnect: () => {},
  });
}

describe("CollectorClient.sessionResponsible", () => {
  test("prefers the explicitly-claimed owner", async () => {
    const c = clientReturning({ ownerActor: "bob", createdActor: "alice", participantActors: ["carol"] });
    expect(await c.sessionResponsible("S1")).toBe("bob");
  });

  test("falls back to the creator when no owner is claimed (self-launched session → routed, not suppressed)", async () => {
    const c = clientReturning({ createdActor: "alice", participantActors: ["carol"] });
    expect(await c.sessionResponsible("S1")).toBe("alice");
  });

  test("falls back to the earliest participant when neither owner nor creator is set", async () => {
    const c = clientReturning({ participantActors: ["carol", "dave"] });
    expect(await c.sessionResponsible("S1")).toBe("carol");
  });

  test("null for a wholly unattributed session — the only case owner routing suppresses", async () => {
    const c = clientReturning({});
    expect(await c.sessionResponsible("S1")).toBeNull();
  });

  test("undefined when the lookup fails — a blip falls back to today's delivery, never suppresses", async () => {
    const c = clientReturning(null, false);
    expect(await c.sessionResponsible("S1")).toBeUndefined();
  });
});
