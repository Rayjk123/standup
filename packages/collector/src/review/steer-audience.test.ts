import { describe, expect, test } from "bun:test";
import { createSession, createSteer, createStore, upsertProject } from "@standup/store";
import type { Steer, WsMessage } from "@standup/shared";
import { DEFAULT_IDENTITY_HEADER } from "@standup/shared";
import { USER_CHANNEL_HEADER, userChannelToken } from "@standup/shared/owner-token";
import { generateOwnerSecrets } from "../owner-secret.js";
import { createServer } from "../server.js";

/*
 * A Human Review steer (a review brief, or the owner's requested changes)
 * carries its owner as its audience: its delivery event goes only to sockets
 * that proved that owner, and the pending-steers read withholds its body from
 * anyone else. An ordinary steer is unchanged.
 */

const IDENTITY = DEFAULT_IDENTITY_HEADER;

function setUp() {
  const store = createStore(":memory:");
  const secrets = generateOwnerSecrets();
  upsertProject(store.db, { id: "p", name: "P", branch: "main", repos: [] });
  createSession(store.db, { id: "S1", projectId: "p", title: "t", cwd: "/tmp/steer-audience", status: "running" });
  const broadcasts: WsMessage[] = [];
  const app = createServer(
    store, (m) => broadcasts.push(m), null, undefined, undefined, "", "", {}, undefined, undefined, undefined, undefined,
    { ownerSecrets: secrets }
  );
  const as = (alias: string, proven = true): Record<string, string> => ({
    [IDENTITY]: alias,
    ...(proven ? { [USER_CHANNEL_HEADER]: userChannelToken(secrets.ownerToken, alias) } : {}),
  });
  return { store, app, broadcasts, as };
}

describe("a review steer's audience", () => {
  test("is stored on the steer row", () => {
    const { store } = setUp();
    const review = createSteer(store.db, "S1", "the brief", { audience: "alice" });
    const plain = createSteer(store.db, "S1", "go left");
    expect(review.audience).toBe("alice");
    expect(plain.audience).toBeUndefined();
    const rows = store.db.query("SELECT id, audience FROM steers ORDER BY rowid").all() as Array<{ id: string; audience: string | null }>;
    expect(rows).toEqual([
      { id: review.id, audience: "alice" },
      { id: plain.id, audience: null },
    ]);
  });

  test("its delivery event is addressed to its owner and proof-gated; an ordinary steer's is not", async () => {
    const { store, app, broadcasts } = setUp();
    const review = createSteer(store.db, "S1", "the secret brief", { audience: "alice" });
    const plain = createSteer(store.db, "S1", "go left");
    const res = await app.request("/api/checkpoint", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "S1", cwd: "/tmp/steer-audience", summary: "step" }),
    });
    expect(res.status).toBe(200);
    const delivered = broadcasts.filter((m) => m.type === "steer:delivered");
    const reviewEvent = delivered.find((m) => (m.payload as Steer).id === review.id)!;
    const plainEvent = delivered.find((m) => (m.payload as Steer).id === plain.id)!;
    expect(reviewEvent).toMatchObject({ audience: "alice", requireProof: true });
    expect(plainEvent.audience).toBeUndefined();
    expect(plainEvent.requireProof).toBeUndefined();
  });

  test("the UserPromptSubmit delivery is addressed the same way", async () => {
    const { store, app, broadcasts } = setUp();
    const review = createSteer(store.db, "S1", "the secret brief", { audience: "alice" });
    await app.request("/hook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "S1",
        cwd: "/tmp/steer-audience",
        transcript_path: "/tmp/steer-audience/t.jsonl",
        hook_event_name: "UserPromptSubmit",
        prompt: "next",
      }),
    });
    const event = broadcasts.find((m) => m.type === "steer:delivered" && (m.payload as Steer).id === review.id);
    expect(event).toMatchObject({ audience: "alice", requireProof: true });
  });

  test("the pending read shows its body only to its proven owner", async () => {
    const { store, app, as } = setUp();
    createSteer(store.db, "S1", "the secret brief", { audience: "alice" });
    createSteer(store.db, "S1", "go left");
    const read = async (headers: Record<string, string>) =>
      ((await (await app.request("/api/sessions/S1/steers/pending", { headers })).json()) as Steer[]).map((s) => s.body);
    expect(await read(as("alice"))).toEqual(["the secret brief", "go left"]);
    expect(await read(as("bob"))).toEqual(["", "go left"]);
    expect(await read(as("alice", false))).toEqual(["", "go left"]);
    expect(await read({})).toEqual(["", "go left"]);
  });
});
