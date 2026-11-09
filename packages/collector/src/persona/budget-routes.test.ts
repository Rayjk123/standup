import { afterAll, describe, expect, test } from "bun:test";
import { createStore, upsertProject } from "@standup/store";
import { DEFAULT_IDENTITY_HEADER } from "@standup/shared";
import { OWNER_TOKEN_HEADER } from "@standup/shared/owner-token";
import { createServer } from "../server.js";
import { hostUserAlias } from "../host-user.js";
import { generateOwnerSecrets } from "../owner-secret.js";

/** GET/PUT/DELETE /api/job-budget — each user's own default Persona job budget, by layer. */

const HOST = hostUserAlias();
const GUEST = "alice";
const stops: Array<() => void> = [];
afterAll(() => {
  for (const stop of stops) stop();
});

function setUp() {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "proj", name: "Proj", branch: "main", repos: [] });
  const secrets = generateOwnerSecrets();
  const app = createServer(store, () => {}, null, undefined, undefined, "", "", {}, undefined, undefined, undefined, undefined, {
    ownerSecrets: secrets,
  });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  stops.push(() => server.stop(true));
  const call = (method: string, path: string, opts: { body?: unknown; as?: string; owner?: boolean } = {}) =>
    fetch(`http://127.0.0.1:${server.port}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(opts.owner === false ? {} : { [OWNER_TOKEN_HEADER]: secrets.ownerToken }),
        ...(opts.as ? { [DEFAULT_IDENTITY_HEADER]: opts.as } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  return { call, store };
}

describe("/api/job-budget", () => {
  test("a person sets their default and a project override; the project layer wins for that project", async () => {
    const { call } = setUp();
    const empty = await (await call("GET", "/api/job-budget")).json();
    expect(empty).toMatchObject({ global: null, project: null, resolved: { usd: null, minutes: 480 } });

    const saved = await (await call("PUT", "/api/job-budget", { body: { usd: 5, minutes: null } })).json();
    expect(saved).toMatchObject({ global: { usd: 5, minutes: null }, resolved: { usd: 5, minutes: 480, source: { usd: "user", minutes: "default" } } });

    const project = await (await call("PUT", "/api/job-budget?project=proj", { body: { usd: 2, minutes: 30 } })).json();
    expect(project).toMatchObject({
      global: { usd: 5 },
      project: { usd: 2, minutes: 30 },
      resolved: { usd: 2, minutes: 30, source: { usd: "project", minutes: "project" } },
    });

    const reset = await (await call("DELETE", "/api/job-budget?project=proj")).json();
    expect(reset).toMatchObject({ project: null, resolved: { usd: 5, minutes: 480 } });
  });

  test("the built-in default has no spend limit; an owner default of 0 keeps none", async () => {
    const { call } = setUp();
    const empty = await (await call("GET", "/api/job-budget")).json();
    expect(empty).toMatchObject({ defaults: { usd: null, minutes: 480 }, resolved: { usd: null, source: { usd: "default" } } });
    const saved = await (await call("PUT", "/api/job-budget", { body: { usd: 0, minutes: 120 } })).json();
    expect(saved).toMatchObject({ global: { usd: 0, minutes: 120 }, resolved: { usd: null, minutes: 120, source: { usd: "user" } } });
  });

  test("layers are per user: another user's settings neither show nor apply", async () => {
    const { call } = setUp();
    await call("PUT", "/api/job-budget", { body: { usd: 7, minutes: 60 } });
    const guest = await (await call("GET", "/api/job-budget", { as: GUEST })).json();
    expect(guest).toMatchObject({ global: null, resolved: { usd: null, minutes: 480 } });
    const host = await (await call("GET", "/api/job-budget", { as: HOST })).json();
    expect(host).toMatchObject({ global: { usd: 7, minutes: 60 } });
  });

  test("a request without the owner token (a worker) is refused; bad values and unknown projects are rejected", async () => {
    const { call } = setUp();
    expect((await call("GET", "/api/job-budget", { owner: false })).status).toBe(403);
    expect((await call("PUT", "/api/job-budget", { owner: false, body: { usd: 1 } })).status).toBe(403);
    expect((await call("PUT", "/api/job-budget", { body: { usd: -1 } })).status).toBe(400);
    expect((await call("PUT", "/api/job-budget", { body: { minutes: "lots" } })).status).toBe(400);
    expect((await call("PUT", "/api/job-budget?project=nope", { body: { usd: 1 } })).status).toBe(404);
  });
});
