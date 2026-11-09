import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createStore, getOrCreatePersonaConsoleThread, upsertProject } from "@standup/store";
import type { PersonaSchedule, SchedulesResponse, WsMessage } from "@standup/shared";
import { DEFAULT_IDENTITY_HEADER } from "@standup/shared";
import { OWNER_TOKEN_HEADER, USER_CHANNEL_HEADER, userChannelToken } from "@standup/shared/owner-token";
import { createServer, resolveUserAlias } from "../server.js";
import { generateOwnerSecrets } from "../owner-secret.js";
import { PersonaRuntime } from "./runtime.js";
import { PersonaFleet } from "./fleet.js";
import type { TurnSlots } from "./fleet.js";
import { createBroadcastTap } from "./events.js";
import { resolvePersonaConfig } from "./config.js";
import { PERSONA_TOKEN_HEADER } from "./routes.js";
import type { PersonaScheduleRunDetail } from "./schedule-routes.js";
import { listOneShotWakeups } from "./schedule-routes.js";

const OWNER = resolveUserAlias(undefined);
const dirs: string[] = [];
const runtimes: PersonaRuntime[] = [];
afterAll(() => {
  for (const r of runtimes) r.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function setUp() {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "Project P", branch: "main", repos: ["/repo/p"] });
  const knowledgeDir = mkdtempSync(join(tmpdir(), "schedule-routes-kb-"));
  dirs.push(knowledgeDir);
  const frames: WsMessage[] = [];
  const tap = createBroadcastTap((m) => frames.push(m));
  const secrets = generateOwnerSecrets();
  const runtimeFor = (owner: string, shared?: { turnSlots: TurnSlots; host: string }) => {
    const created = new PersonaRuntime({
      db: store.db,
      owner,
      host: shared?.host,
      turnSlots: shared?.turnSlots,
      config: resolvePersonaConfig({}),
      broadcast: tap.broadcast,
      turnRunner: async () => ({ ok: true, text: "[silent]", sessionId: "sid" }),
      ownerToken: () => secrets.ownerToken,
    });
    runtimes.push(created);
    return created;
  };
  const runtime = runtimeFor(OWNER);
  const fleet = new PersonaFleet({ db: store.db, host: OWNER, hostRuntime: runtime, create: runtimeFor });
  const app = createServer(
    store,
    tap.broadcast,
    null,
    undefined,
    undefined,
    knowledgeDir,
    "",
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    { fleet, ownerSecrets: secrets }
  );

  /** A request from the owner's signed-in console: JSON, carrying the owner token (`ownerToken: null` omits it). */
  const human = (path: string, init: RequestInit & { ownerToken?: string | null } = {}) => {
    const { ownerToken = secrets.ownerToken, ...rest } = init;
    return app.request(path, {
      ...rest,
      headers: {
        "content-type": "application/json",
        ...(ownerToken ? { [OWNER_TOKEN_HEADER]: ownerToken } : {}),
        ...(rest.headers as Record<string, string> | undefined),
      },
    });
  };

  const create = async (fields: Record<string, unknown> = {}): Promise<PersonaSchedule> => {
    const res = await human("/api/persona/schedules", {
      method: "POST",
      body: JSON.stringify({
        title: "Morning triage",
        cron: "0 9 * * 1-5",
        timezone: "America/New_York",
        kind: "wake_persona",
        note: "Triage the overnight asks",
        ...fields,
      }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { schedule: PersonaSchedule }).schedule;
  };

  return { store, app, runtime, secrets, frames, human, create };
}

async function errorOf(res: Response): Promise<string> {
  return ((await res.json()) as { error: string }).error;
}

describe("schedule routes — auth", () => {
  test("writes without the owner token, or with a wrong one, are refused with 403", async () => {
    const h = setUp();
    const existing = await h.create();
    const writes: Array<[string, string, unknown]> = [
      ["POST", "/api/persona/schedules", { title: "x", cron: "0 9 * * *", kind: "wake_persona", note: "n" }],
      ["PATCH", `/api/persona/schedules/${existing.id}`, { enabled: false }],
      ["DELETE", `/api/persona/schedules/${existing.id}`, {}],
      ["POST", `/api/persona/schedules/${existing.id}/run`, {}],
    ];
    for (const [method, path, body] of writes) {
      const missing = await h.human(path, { method, ownerToken: null, body: JSON.stringify(body) });
      expect(missing.status).toBe(403);
      expect(await errorOf(missing)).toContain(OWNER_TOKEN_HEADER);
      const wrong = await h.human(path, { method, ownerToken: "not-the-owner-secret", body: JSON.stringify(body) });
      expect(wrong.status).toBe(403);
    }
    const list = (await (await h.human("/api/persona/schedules")).json()) as SchedulesResponse;
    expect(list.schedules.map((s) => s.id)).toEqual([existing.id]);
    expect(list.schedules[0]!.enabled).toBe(true);
  });

  test("the persona token is refused on every schedule route, reads included", async () => {
    const h = setUp();
    const existing = await h.create();
    const headers = { [PERSONA_TOKEN_HEADER]: h.runtime.token };
    for (const [method, path] of [
      ["GET", "/api/persona/schedules"],
      ["GET", `/api/persona/schedules/${existing.id}/runs`],
      ["POST", "/api/persona/schedules"],
      ["PATCH", `/api/persona/schedules/${existing.id}`],
      ["DELETE", `/api/persona/schedules/${existing.id}`],
      ["POST", `/api/persona/schedules/${existing.id}/run`],
    ] as const) {
      const res = await h.human(path, { method, headers, ...(method === "GET" ? {} : { body: "{}" }) });
      expect(res.status).toBe(403);
      expect(await errorOf(res)).toBe("Persona's token cannot be used on owner routes");
    }
  });

  test("a write that isn't JSON is refused, DELETE included", async () => {
    const h = setUp();
    const existing = await h.create();
    for (const [method, path] of [
      ["POST", "/api/persona/schedules"],
      ["PATCH", `/api/persona/schedules/${existing.id}`],
      ["DELETE", `/api/persona/schedules/${existing.id}`],
      ["POST", `/api/persona/schedules/${existing.id}/run`],
    ] as const) {
      const form = await h.human(path, {
        method,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "title=x",
      });
      expect(form.status).toBe(403);
      expect(await errorOf(form)).toContain("Content-Type must be application/json");
    }
    const bare = await h.app.request(`/api/persona/schedules/${existing.id}`, {
      method: "DELETE",
      headers: { [OWNER_TOKEN_HEADER]: h.secrets.ownerToken },
    });
    expect(bare.status).toBe(403);
    expect(h.runtime.schedules.get(existing.id)).not.toBeNull();
  });

  test("another user sees only their own schedules and can't touch the owner's", async () => {
    const h = setUp();
    const existing = await h.create();
    const headers = { [DEFAULT_IDENTITY_HEADER]: "mallory-not-owner" };
    const signedIn = { ...headers, [USER_CHANNEL_HEADER]: userChannelToken(h.secrets.ownerToken, "mallory-not-owner") };
    const list = await h.human("/api/persona/schedules", { ownerToken: null, headers: signedIn });
    expect(list.status).toBe(200);
    expect(((await list.json()) as SchedulesResponse).schedules).toEqual([]);
    expect((await h.human(`/api/persona/schedules/${existing.id}/runs`, { ownerToken: null, headers: signedIn })).status).toBe(404);
    // The owner token alone proves only the host: another user's read or write needs their own channel proof.
    const forgedList = await h.human("/api/persona/schedules", { headers });
    expect(forgedList.status).toBe(403);
    expect(await forgedList.json()).toMatchObject({ reason: "sign-in" });
    const del = await h.human(`/api/persona/schedules/${existing.id}`, { method: "DELETE", headers, body: "{}" });
    expect(del.status).toBe(403);
    expect(h.runtime.schedules.get(existing.id)).not.toBeNull();
  });

  test("a disallowed Host is refused", async () => {
    const h = setUp();
    const foreign = { host: "rebind.attacker.example:7777", origin: "http://rebind.attacker.example:7777" };
    const get = await h.human("http://rebind.attacker.example:7777/api/persona/schedules", { headers: foreign });
    expect(get.status).toBe(403);
    expect(await errorOf(get)).toContain("STANDUP_ALLOWED_HOSTS");
    const post = await h.human("http://rebind.attacker.example:7777/api/persona/schedules", {
      method: "POST",
      headers: foreign,
      body: JSON.stringify({ title: "x", cron: "0 9 * * *", kind: "wake_persona", note: "n" }),
    });
    expect(post.status).toBe(403);
    expect(h.runtime.schedules.get("x")).toBeNull();
    expect((await (await h.human("/api/persona/schedules")).json() as SchedulesResponse).schedules).toHaveLength(0);
  });
});

describe("schedule routes — schedules", () => {
  test("create and list: the owner's schedule in the console thread, with the default timezone", async () => {
    const h = setUp();
    const schedule = await h.create();
    expect(schedule.createdBy).toBe(OWNER);
    expect(schedule.threadId).toBe(getOrCreatePersonaConsoleThread(h.store.db, OWNER).id);
    expect(schedule.timezone).toBe("America/New_York");
    expect(schedule.enabled).toBe(true);
    expect(Date.parse(schedule.nextRunAt!)).toBeGreaterThan(Date.now());
    expect(h.frames.some((f) => f.type === "persona:schedule" && (f.payload as PersonaSchedule).id === schedule.id)).toBe(true);

    const res = await h.human("/api/persona/schedules");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SchedulesResponse;
    expect(body.schedules.map((s) => s.id)).toEqual([schedule.id]);
    expect(body.wakeups).toEqual([]);
    expect(typeof body.defaultTimezone).toBe("string");
    expect(body.defaultTimezone.length).toBeGreaterThan(0);
  });

  test("create validation errors are 400 with an error", async () => {
    const h = setUp();
    for (const body of [
      { cron: "0 9 * * *", kind: "wake_persona", note: "n" },
      { title: "t", cron: "not a cron", kind: "wake_persona", note: "n" },
      { title: "t", cron: "0 9 * * *", kind: "wake_persona" },
      { title: "t", cron: "0 9 * * *", kind: "launch_job" },
      { title: "t", cron: "0 9 * * *", kind: "wake_persona", note: "n", timezone: "Mars/Olympus" },
    ]) {
      const res = await h.human("/api/persona/schedules", { method: "POST", body: JSON.stringify(body) });
      expect(res.status).toBe(400);
      expect((await errorOf(res)).length).toBeGreaterThan(0);
    }
    const notObject = await h.human("/api/persona/schedules", { method: "POST", body: "[1]" });
    expect(notObject.status).toBe(400);
  });

  test("update: pause clears nextRunAt, resume recomputes it, edits apply, bad edits are 400", async () => {
    const h = setUp();
    const schedule = await h.create();
    const patch = (body: unknown, id = schedule.id) =>
      h.human(`/api/persona/schedules/${id}`, { method: "PATCH", body: JSON.stringify(body) });

    const paused = await patch({ enabled: false });
    expect(paused.status).toBe(200);
    const pausedSchedule = ((await paused.json()) as { schedule: PersonaSchedule }).schedule;
    expect(pausedSchedule.enabled).toBe(false);
    expect(pausedSchedule.nextRunAt).toBeUndefined();

    const resumed = ((await (await patch({ enabled: true })).json()) as { schedule: PersonaSchedule }).schedule;
    expect(resumed.enabled).toBe(true);
    expect(Date.parse(resumed.nextRunAt!)).toBeGreaterThan(Date.now());

    const edited = ((await (await patch({ title: "Evening triage", cron: "30 17 * * *" })).json()) as {
      schedule: PersonaSchedule;
    }).schedule;
    expect(edited.title).toBe("Evening triage");
    expect(edited.cron).toBe("30 17 * * *");

    const kindChange = await patch({ kind: "launch_job" });
    expect(kindChange.status).toBe(400);
    expect(await errorOf(kindChange)).toContain("kind can't be changed");
    const badCron = await patch({ cron: "61 * * * *" });
    expect(badCron.status).toBe(400);
    const unknown = await patch({ enabled: false }, "no-such-schedule");
    expect(unknown.status).toBe(404);
    expect(await errorOf(unknown)).toContain("no-such-schedule");
  });

  test("end bound: create stores endsAt and maxRuns, list shows them, a past endsAt is 400, PATCH clears with null", async () => {
    const h = setUp();
    const ahead = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const schedule = await h.create({ endsAt: ahead, maxRuns: 3 });
    expect(schedule).toMatchObject({ endsAt: ahead, maxRuns: 3, runCount: 0, enabled: true });

    const listed = ((await (await h.human("/api/persona/schedules")).json()) as SchedulesResponse).schedules;
    expect(listed.find((s) => s.id === schedule.id)).toMatchObject({ endsAt: ahead, maxRuns: 3, runCount: 0 });

    const past = await h.human("/api/persona/schedules", {
      method: "POST",
      body: JSON.stringify({ title: "t", cron: "0 9 * * *", kind: "wake_persona", note: "n", endsAt: "2020-01-01T00:00:00Z" }),
    });
    expect(past.status).toBe(400);
    expect(await errorOf(past)).toContain("already passed");

    const cleared = await h.human(`/api/persona/schedules/${schedule.id}`, {
      method: "PATCH",
      body: JSON.stringify({ endsAt: null, maxRuns: null }),
    });
    expect(cleared.status).toBe(200);
    const after = ((await cleared.json()) as { schedule: PersonaSchedule }).schedule;
    expect(after.endsAt).toBeUndefined();
    expect(after.maxRuns).toBeUndefined();
  });

  test("delete removes the schedule and broadcasts it; an unknown id is 404", async () => {
    const h = setUp();
    const schedule = await h.create();
    const res = await h.human(`/api/persona/schedules/${schedule.id}`, { method: "DELETE", body: "{}" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: schedule.id, deleted: true });
    expect(h.runtime.schedules.get(schedule.id)).toBeNull();
    expect(h.frames.some((f) => f.type === "persona:schedule" && (f.payload as { deleted?: boolean }).deleted)).toBe(true);
    const again = await h.human(`/api/persona/schedules/${schedule.id}`, { method: "DELETE", body: "{}" });
    expect(again.status).toBe(404);
    expect(await errorOf(again)).toContain(schedule.id);
  });

  test("run now of a wake_persona schedule records a manual run and wakes Persona", async () => {
    const h = setUp();
    const schedule = await h.create();
    const res = await h.human(`/api/persona/schedules/${schedule.id}/run`, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    const { run } = (await res.json()) as { run: PersonaScheduleRunDetail };
    expect(run.scheduleId).toBe(schedule.id);
    expect(run.trigger).toBe("manual");
    expect(run.status).toBe("running");
    expect(run.inboxId).toEqual(expect.any(String));

    const item = h.store.db.query("SELECT kind, payload_json FROM persona_inbox WHERE id = ?").get(run.inboxId!) as {
      kind: string;
      payload_json: string;
    } | null;
    expect(item?.kind).toBe("schedule");
    expect(JSON.parse(item!.payload_json)).toMatchObject({ note: "Triage the overnight asks", scheduleId: schedule.id });

    const runs = await h.human(`/api/persona/schedules/${schedule.id}/runs`);
    expect(runs.status).toBe(200);
    const listed = ((await runs.json()) as { runs: PersonaScheduleRunDetail[] }).runs;
    expect(listed.map((r) => r.id)).toEqual([run.id]);

    const unknownRun = await h.human("/api/persona/schedules/nope/run", { method: "POST", body: "{}" });
    expect(unknownRun.status).toBe(404);
    expect((await h.human("/api/persona/schedules/nope/runs")).status).toBe(404);
  });

  test("runs come back newest first", async () => {
    const h = setUp();
    const schedule = await h.create({ overlap: "allow" });
    const first = ((await (await h.human(`/api/persona/schedules/${schedule.id}/run`, { method: "POST", body: "{}" })).json()) as {
      run: PersonaScheduleRunDetail;
    }).run;
    await Bun.sleep(5);
    const second = ((await (await h.human(`/api/persona/schedules/${schedule.id}/run`, { method: "POST", body: "{}" })).json()) as {
      run: PersonaScheduleRunDetail;
    }).run;
    const listed = ((await (await h.human(`/api/persona/schedules/${schedule.id}/runs`)).json()) as {
      runs: PersonaScheduleRunDetail[];
    }).runs;
    expect(listed.map((r) => r.id)).toEqual([second.id, first.id]);
  });

  test("wakeups list a pending one-shot schedule_wakeup but not a recurring run's wake", async () => {
    const h = setUp();
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const thread = getOrCreatePersonaConsoleThread(h.store.db, OWNER).id;
    const oneShot = h.runtime.enqueue("schedule", { note: "Check the deploy", jobId: "job-1" }, { threadId: thread, notBefore: later });
    h.runtime.enqueue("schedule", { note: "recurring", scheduleId: "sched-1", runId: "run-1" }, { threadId: thread, notBefore: later });
    const body = (await (await h.human("/api/persona/schedules")).json()) as SchedulesResponse;
    expect(body.wakeups).toEqual([
      { id: oneShot.id, note: "Check the deploy", at: later, threadId: thread, jobId: "job-1", createdAt: oneShot.createdAt },
    ]);
  });

  test("a pending daily brief is not listed as a wakeup", async () => {
    const h = setUp();
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const thread = getOrCreatePersonaConsoleThread(h.store.db, OWNER).id;
    const oneShot = h.runtime.enqueue("schedule", { note: "Check the deploy" }, { threadId: thread, notBefore: later });
    h.runtime.enqueue("schedule", { brief: true, slot: later, digest: ["Window: …"], empty: false }, { threadId: thread, notBefore: later });
    expect(listOneShotWakeups(h.store.db, OWNER).map((w) => w.id)).toEqual([oneShot.id]);
    const body = (await (await h.human("/api/persona/schedules")).json()) as SchedulesResponse;
    expect(body.wakeups.map((w) => w.id)).toEqual([oneShot.id]);
  });
});
