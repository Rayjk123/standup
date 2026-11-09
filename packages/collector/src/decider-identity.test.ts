import { afterAll, describe, expect, test } from "bun:test";
import { DEFAULT_IDENTITY_HEADER } from "@standup/shared";
import { createStore, getGlobalDeciderPrefs, getUserDeciderPrefs } from "@standup/store";
import type { DeciderConfigView } from "@standup/shared";
import { OWNER_TOKEN_HEADER, USER_CHANNEL_HEADER, userChannelToken } from "@standup/shared/owner-token";
import { createServer } from "./server.js";
import { hostUserAlias } from "./host-user.js";
import { generateOwnerSecrets } from "./owner-secret.js";

/**
 * Who the decider routes believe, over a real loopback socket (the console
 * proxy's hop): the owner through the owner channel, a teammate through their
 * own user channel token — and never a worker, which shares the loopback and can
 * set any header but holds neither secret.
 */

const HOST = hostUserAlias();
const GUEST = "alice";

const cleanup: Array<() => void> = [];
afterAll(() => {
  for (const fn of cleanup.reverse()) fn();
});

function setUp() {
  const store = createStore(":memory:");
  const secrets = generateOwnerSecrets();
  const app = createServer(store, () => {}, null, undefined, undefined, "", "", {}, undefined, undefined, undefined, undefined, {
    ownerSecrets: secrets,
  });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  cleanup.push(() => server.stop(true));
  const call = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${server.port}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...headers },
    });
  const guest = { [DEFAULT_IDENTITY_HEADER]: GUEST, [USER_CHANNEL_HEADER]: userChannelToken(secrets.ownerToken, GUEST) };
  const owner = { [OWNER_TOKEN_HEADER]: secrets.ownerToken };
  return { store, call, guest, owner, secrets };
}

const put = (backends: Record<string, string>): RequestInit => ({ method: "PUT", body: JSON.stringify({ backends }) });

describe("decider route identity", () => {
  test("a worker with no secret is refused, with or without a forged identity header", async () => {
    const { store, call } = setUp();
    expect((await call("/api/decider/config")).status).toBe(403);
    expect((await call("/api/decider/prefs", {}, put({ project: "claude" }))).status).toBe(403);
    expect((await call("/api/decider/prefs", { [DEFAULT_IDENTITY_HEADER]: GUEST }, put({ project: "claude" }))).status).toBe(403);
    expect((await call("/api/decider/suggest", {}, { method: "POST", body: JSON.stringify({ task: "x" }) })).status).toBe(403);
    expect(getUserDeciderPrefs(store.db, HOST).backends).toEqual({});
    expect(getUserDeciderPrefs(store.db, GUEST).backends).toEqual({});
  });

  test("a user channel token minted for someone else proves nothing", async () => {
    const { call, secrets } = setUp();
    const res = await call(
      "/api/decider/prefs",
      { [DEFAULT_IDENTITY_HEADER]: GUEST, [USER_CHANNEL_HEADER]: userChannelToken(secrets.ownerToken, "bob") },
      put({ project: "claude" })
    );
    expect(res.status).toBe(403);
  });

  test("a teammate edits their own layer through their user channel, but not the global one", async () => {
    const { store, call, guest } = setUp();
    const view = (await (await call("/api/decider/config", guest)).json()) as DeciderConfigView;
    expect(view.alias).toBe(GUEST);
    expect(view.isOwner).toBe(false);
    expect((await call("/api/decider/prefs", guest, put({ project: "claude" }))).status).toBe(200);
    expect(getUserDeciderPrefs(store.db, GUEST).backends).toEqual({ project: "claude" });
    expect((await call("/api/decider/global", guest, put({ project: "claude" }))).status).toBe(403);
    expect((await call("/api/decider/decisions?all=1", guest)).status).toBe(403);
    expect(getGlobalDeciderPrefs(store.db)).toEqual({});
  });

  test("the owner channel is the owner, and may change the global layer", async () => {
    const { store, call, owner } = setUp();
    const view = (await (await call("/api/decider/config", owner)).json()) as DeciderConfigView;
    expect(view.alias).toBe(HOST);
    expect(view.isOwner).toBe(true);
    expect((await call("/api/decider/global", owner, put({ model: "claude" }))).status).toBe(200);
    expect(getGlobalDeciderPrefs(store.db)).toEqual({ model: "claude" });
    expect((await call("/api/decider/decisions?all=1", owner)).status).toBe(200);
  });

  test("the owner token does not let the owner channel speak for a guest named in the header", async () => {
    const { store, call, owner } = setUp();
    const res = await call("/api/decider/prefs", { ...owner, [DEFAULT_IDENTITY_HEADER]: GUEST }, put({ project: "claude" }));
    expect(res.status).toBe(403);
    expect(getUserDeciderPrefs(store.db, GUEST).backends).toEqual({});
  });
});
