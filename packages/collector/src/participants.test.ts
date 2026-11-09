import { expect, test, describe } from "bun:test";
import { DEFAULT_IDENTITY_HEADER } from "@standup/shared";
import {
  createStore,
  upsertProject,
  createSession,
  createAsk,
  upsertActor,
  mergeActors,
  setSessionCreatedActor,
  assignSessionOwner,
  recordParticipant,
  getParticipants,
} from "@standup/store";
import type { Store } from "@standup/store";
import type { Actor, Session, SessionParticipant } from "@standup/shared";
import { createServer } from "./server.js";

/**
 * Participant read path: the write side records who worked
 * on a session (steer/reply/resolve/dispatch); these cover the read side —
 * GET /api/sessions/:id/participants — and that answering an ask attributes the
 * contribution to the acting user (tunnel header or an explicit Slack actor).
 */

function setUp(): { store: Store; app: ReturnType<typeof createServer> } {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  createSession(store.db, {
    id: "S1",
    projectId: "p",
    title: "",
    cwd: "/tmp/S1",
    status: "running",
  });
  return { store, app: createServer(store, () => {}, null) };
}

describe("GET /api/sessions/:id/participants", () => {
  test("returns the participant set plus resolved creator/owner actors", async () => {
    const { store, app } = setUp();
    // Mirror the real flow: the creator is stamped and recorded as the first
    // participant (ensureSession), the owner is upserted when claimed (the
    // assign-owner endpoint), and a replier is recorded as a participant.
    setSessionCreatedActor(store.db, "S1", "alice");
    recordParticipant(store.db, "S1", "alice");
    upsertActor(store.db, "bob");
    assignSessionOwner(store.db, "S1", "bob");
    recordParticipant(store.db, "S1", "carol");

    const res = await app.request("/api/sessions/S1/participants");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      participants: SessionParticipant[];
      actors: Actor[];
    };

    // The participant SET is the acting collaborators (alice, carol) — bob owns
    // the session but never acted, so he's not a participant.
    expect(body.participants.map((p) => p.actorId).sort()).toEqual(["alice", "carol"]);
    // The resolved actor directory covers participants AND the creator/owner,
    // so a client can render attribution (including the owner) without a
    // per-alias lookup.
    const actorIds = body.actors.map((a) => a.id).sort();
    expect(actorIds).toEqual(["alice", "bob", "carol"]);
    store.close();
  });

  test("folds a since-merged participant into its canonical identity", async () => {
    const { store, app } = setUp();
    // One human, two identities: they drive S1 over the tunnel as `alice` and
    // also answer an ask from Slack as `slack:U123`, so both are participants.
    recordParticipant(store.db, "S1", "slack:U123");
    recordParticipant(store.db, "S1", "alice");
    // Reconcile: fold the Slack identity into the user alias.
    mergeActors(store.db, "slack:U123", "alice");

    const res = await app.request("/api/sessions/S1/participants");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      participants: SessionParticipant[];
      actors: Actor[];
    };

    // The two rows collapse to a single canonical participant — no ghost row
    // carrying the raw `slack:U123`, and their contributions sum.
    expect(body.participants.map((p) => p.actorId)).toEqual(["alice"]);
    expect(body.participants[0]?.contributionCount).toBe(2);
    // The actor directory only lists the canonical identity.
    expect(body.actors.map((a) => a.id)).toEqual(["alice"]);
    store.close();
  });

  test("404 for an unknown session", async () => {
    const { store, app } = setUp();
    const res = await app.request("/api/sessions/nope/participants");
    expect(res.status).toBe(404);
    store.close();
  });
});

describe("GET /api/sessions resolves attribution through actor merges", () => {
  test("created/owner/participant read as the canonical id after a merge", async () => {
    const { store, app } = setUp();
    // A teammate drives S1 through the tunnel as `alice`, and also answers an
    // ask from Slack as `slack:U123` — two identities, one human. The Slack
    // actor is the creator, owner, and a participant before reconciliation.
    setSessionCreatedActor(store.db, "S1", "slack:U123");
    assignSessionOwner(store.db, "S1", "slack:U123");
    recordParticipant(store.db, "S1", "slack:U123");
    recordParticipant(store.db, "S1", "alice");

    // Reconcile: fold the Slack identity into the user alias.
    mergeActors(store.db, "slack:U123", "alice");

    const res = await app.request("/api/sessions/S1");
    expect(res.status).toBe(200);
    const session = (await res.json()) as Session;

    // The read path resolves every attribution id through the tombstone, so a
    // client's "Mine"/"started by" surfaces see the canonical `alice` — never
    // the raw, since-merged `slack:U123`.
    expect(session.createdActor).toBe("alice");
    expect(session.ownerActor).toBe("alice");
    // Deduped: the two identities collapse to a single canonical participant.
    expect(session.participantActors).toEqual(["alice"]);
    store.close();
  });
});

describe("POST /api/asks/:id/resolve attributes the answerer", () => {
  test("records the acting tunnel user as a participant", async () => {
    const { store, app } = setUp();
    const ask = createAsk(store.db, "S1", "ask_human", "proceed?");

    const res = await app.request(`/api/asks/${ask.id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", [DEFAULT_IDENTITY_HEADER]: "dave" },
      body: JSON.stringify({ answer: "yes" }),
    });
    expect(res.status).toBe(200);

    expect(getParticipants(store.db, "S1").map((p) => p.actorId)).toContain("dave");
    store.close();
  });

  test("an explicit body actor (e.g. from Slack) wins over the header", async () => {
    const { store, app } = setUp();
    const ask = createAsk(store.db, "S1", "ask_human", "proceed?");

    await app.request(`/api/asks/${ask.id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", [DEFAULT_IDENTITY_HEADER]: "dave" },
      body: JSON.stringify({ answer: "yes", actor: "slack:U123" }),
    });

    const ids = getParticipants(store.db, "S1").map((p) => p.actorId);
    expect(ids).toContain("slack:U123");
    expect(ids).not.toContain("dave");
    store.close();
  });
});
