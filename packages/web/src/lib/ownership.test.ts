import { expect, test, describe, afterEach } from "bun:test";
import type { Actor, Session, SessionParticipant } from "@standup/shared";
import { ownershipView, buildParticipantTimeline, claimOwnership } from "./ownership";

const actors: Actor[] = [
  { id: "alice", display: "Alice", firstSeen: new Date(), lastSeen: new Date() },
  { id: "bob", display: "Bob", firstSeen: new Date(), lastSeen: new Date() },
];

function participant(
  actorId: string,
  firstSeen: string,
  contributionCount = 1
): SessionParticipant {
  return { sessionId: "S1", actorId, firstSeen: new Date(firstSeen), contributionCount };
}

describe("ownershipView", () => {
  test("no current user (identity unresolved) offers nothing", () => {
    expect(ownershipView({ ownerActor: "bob" }, "", actors)).toEqual({ kind: "none" });
  });

  test("unowned session offers a claim", () => {
    expect(ownershipView({}, "alice", actors)).toEqual({
      kind: "claim",
      label: "Claim ownership",
    });
  });

  test("current owner sees an owned-by-you state, not an action", () => {
    expect(ownershipView({ ownerActor: "alice" }, "alice", actors)).toEqual({
      kind: "owned-by-you",
      label: "You own this",
    });
  });

  test("someone else's session offers a reassign, naming the current owner", () => {
    expect(ownershipView({ ownerActor: "bob" }, "alice", actors)).toEqual({
      kind: "reassign",
      label: "Claim ownership",
      currentOwner: "Bob",
    });
  });
});

describe("buildParticipantTimeline", () => {
  test("orders acted-on rows by first-acted and flags creator/owner/current user", () => {
    const timeline = buildParticipantTimeline({
      participants: [
        participant("bob", "2026-01-01T10:05:00Z", 2),
        participant("alice", "2026-01-01T10:00:00Z", 5),
      ],
      actors,
      createdActor: "alice",
      ownerActor: "bob",
      currentUser: "alice",
    });

    expect(timeline.map((e) => e.actorId)).toEqual(["alice", "bob"]);
    const [alice, bob] = timeline;
    expect(alice.display).toBe("Alice");
    expect(alice.isCreator).toBe(true);
    expect(alice.isOwner).toBe(false);
    expect(alice.isCurrentUser).toBe(true);
    expect(alice.contributionCount).toBe(5);
    expect(bob.isOwner).toBe(true);
    expect(bob.isCreator).toBe(false);
    expect(bob.firstSeen).toBeInstanceOf(Date);
  });

  test("an owner who never acted still earns a trailing timestamp-less row", () => {
    const timeline = buildParticipantTimeline({
      participants: [participant("alice", "2026-01-01T10:00:00Z")],
      actors,
      createdActor: "alice",
      ownerActor: "bob",
    });

    expect(timeline.map((e) => e.actorId)).toEqual(["alice", "bob"]);
    const bob = timeline[1];
    expect(bob.isOwner).toBe(true);
    expect(bob.firstSeen).toBeUndefined();
    expect(bob.contributionCount).toBeUndefined();
  });

  test("empty records produce an empty timeline", () => {
    expect(buildParticipantTimeline({ participants: [] })).toEqual([]);
  });
});

describe("claimOwnership", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("posts to /assign-owner and returns the updated session", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenBody: string | undefined;
    const updated: Partial<Session> = { id: "S1", ownerActor: "alice", createdActor: "bob" };
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenMethod = init?.method ?? "GET";
      seenBody = init?.body as string | undefined;
      return new Response(JSON.stringify(updated), { status: 200 });
    }) as typeof fetch;

    const session = await claimOwnership("S1");
    expect(seenUrl).toBe("/api/sessions/S1/assign-owner");
    expect(seenMethod).toBe("POST");
    // A bare claim sends no body — the server attributes it to the tunnel user.
    expect(seenBody).toBeUndefined();
    expect(session.ownerActor).toBe("alice");
  });

  test("sends an explicit actor body when reassigning to a chosen owner", async () => {
    let seenBody: string | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seenBody = init?.body as string | undefined;
      return new Response(JSON.stringify({ id: "S1", ownerActor: "carol" }), { status: 200 });
    }) as typeof fetch;

    await claimOwnership("S1", "carol");
    expect(seenBody).toBe(JSON.stringify({ actor: "carol" }));
  });

  test("throws with the server error on a non-OK response", async () => {
    globalThis.fetch = (async (_url: string) =>
      new Response(JSON.stringify({ error: "Not found" }), { status: 404 })) as typeof fetch;

    await expect(claimOwnership("nope")).rejects.toThrow("Not found");
  });
});
