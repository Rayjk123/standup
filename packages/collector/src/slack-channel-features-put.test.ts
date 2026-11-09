import { expect, test, describe } from "bun:test";
import { createStore, getSetting } from "@standup/store";
import type { Store } from "@standup/store";
import { createServer } from "./server.js";
import type { ChannelFeaturesPatch } from "@standup/shared";

/**
 * PUT /api/settings { slackChannelFeaturesPatch } applies a per-channel DELTA on top
 * of the CURRENT stored blob instead of overwriting the whole value. This is the
 * root-cause fix for the whole-blob read-modify-write: a command persisting one
 * channel can no longer clobber a concurrent external edit to another channel, and
 * two overlapping commands can no longer lose each other's toggle. The read-merge-
 * write is synchronous in the handler, so it is atomic even across overlapping
 * requests.
 */

const HEADERS = { "content-type": "application/json" };
const KEY = "slackChannelFeatures";

function setUp(): { store: Store; app: ReturnType<typeof createServer> } {
  const store = createStore(":memory:");
  return { store, app: createServer(store, () => {}, null) };
}

function patch(app: ReturnType<typeof createServer>, p: ChannelFeaturesPatch) {
  return app.request("/api/settings", {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify({ slackChannelFeaturesPatch: p }),
  });
}

describe("PUT /api/settings — per-channel feature patch", () => {
  test("a patch on one channel does NOT clobber an external edit to another (finding #1)", async () => {
    const { store, app } = setUp();
    // An external writer sets channel C feed:true (whole-blob path — e.g. a direct PUT).
    await app.request("/api/settings", {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ slackChannelFeatures: JSON.stringify({ C: { feed: true } }) }),
    });
    // A Slack command mutes a DIFFERENT channel D via a delta.
    const res = await patch(app, { set: { D: { mirror: false } } });
    expect(res.status).toBe(200);
    const stored = JSON.parse(getSetting(store.db, KEY) as string);
    expect(stored).toEqual({ C: { feed: true }, D: { mirror: false } }); // C survived
    store.close();
  });

  test("two sequential patches to different channels both survive (finding #3)", async () => {
    const { store, app } = setUp();
    await patch(app, { set: { E: { asks: false } } });
    await patch(app, { set: { C: { mirror: false } } });
    expect(JSON.parse(getSetting(store.db, KEY) as string)).toEqual({
      E: { asks: false },
      C: { mirror: false },
    });
    store.close();
  });

  test("a same-channel patch field-merges, preserving other fields", async () => {
    const { store, app } = setUp();
    await patch(app, { set: { C: { feed: true } } });
    await patch(app, { set: { C: { mirror: false } } });
    expect(JSON.parse(getSetting(store.db, KEY) as string)).toEqual({ C: { feed: true, mirror: false } });
    store.close();
  });

  test("feedKinds merge key-by-key across patches", async () => {
    const { store, app } = setUp();
    await patch(app, { set: { C: { feed: true, feedKinds: { launched: true } } } });
    await patch(app, { set: { C: { feedKinds: { finished: false } } } });
    expect(JSON.parse(getSetting(store.db, KEY) as string)).toEqual({
      C: { feed: true, feedKinds: { launched: true, finished: false } },
    });
    store.close();
  });

  test("a clear patch drops only that channel; an emptied blob is stored as \"\"", async () => {
    const { store, app } = setUp();
    await patch(app, { set: { C: { feed: true }, D: { mirror: false } } });
    await patch(app, { clear: ["C"] });
    expect(JSON.parse(getSetting(store.db, KEY) as string)).toEqual({ D: { mirror: false } });
    // Clearing the last channel leaves "" (the all-on default readers already expect).
    await patch(app, { clear: ["D"] });
    expect(getSetting(store.db, KEY)).toBe("");
    store.close();
  });

  test("the response reports the bumped settingsVersion and merged blob", async () => {
    const { app } = setUp();
    const res = await patch(app, { set: { C: { mirror: false } } });
    const body = (await res.json()) as { settingsVersion: number; slackChannelFeatures: string };
    expect(body.settingsVersion).toBeGreaterThan(0);
    expect(JSON.parse(body.slackChannelFeatures)).toEqual({ C: { mirror: false } });
  });

  test("a patch on top of a malformed stored blob fails open (starts from empty)", async () => {
    const { store, app } = setUp();
    // Poison the stored value directly, then patch — the merge must not throw and
    // must not resurrect garbage; it starts from the fail-open empty map.
    await app.request("/api/settings", {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ slackChannelFeatures: "{not json" }),
    });
    const res = await patch(app, { set: { C: { feed: true } } });
    expect(res.status).toBe(200);
    expect(JSON.parse(getSetting(store.db, KEY) as string)).toEqual({ C: { feed: true } });
    store.close();
  });

  // These pin the correctness that lets the Slack adapter run its command handlers
  // concurrently (no serial queue): the collector's synchronous per-request read-
  // merge-write applies each delta to the freshest blob, so overlapping commands
  // commute — neither the whole-blob clobber nor a lost update can happen.
  describe("concurrent commands persist correctly without an adapter-side queue", () => {
    test("two concurrent commands on different channels (CX, CY) both persist via the per-channel merge", async () => {
      const { store, app } = setUp();
      // Fire both patches at once — the interleave the removed adapter queue serialized.
      await Promise.all([
        patch(app, { set: { CX: { mirror: false } } }),
        patch(app, { set: { CY: { feed: true } } }),
      ]);
      expect(JSON.parse(getSetting(store.db, KEY) as string)).toEqual({
        CX: { mirror: false },
        CY: { feed: true },
      });
      store.close();
    });

    test("two concurrent commands on the SAME channel both apply (no whole-blob clobber)", async () => {
      const { store, app } = setUp();
      // Both touch the same channel C but different fields, each sending only its own
      // delta. The atomic per-request merge keeps both — request order decides which
      // commits first, but neither overwrites the other with a whole-blob write.
      await Promise.all([
        patch(app, { set: { C: { mirror: false } } }),
        patch(app, { set: { C: { asks: false } } }),
      ]);
      expect(JSON.parse(getSetting(store.db, KEY) as string)).toEqual({
        C: { mirror: false, asks: false },
      });
      store.close();
    });
  });
});
