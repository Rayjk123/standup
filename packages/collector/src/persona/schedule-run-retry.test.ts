import { describe, expect, test } from "bun:test";
import {
  createStore,
  getOrCreatePersonaThreadByRef,
  getPersonaInboxItem,
  getPersonaSchedule,
  getPersonaScheduleRun,
  listPendingPersonaInbox,
  listPersonaMessages,
  reconcilePersonaScheduleRuns,
} from "@standup/store";
import { resolvePersonaConfig } from "./config.js";
import { PersonaRuntime, SCHEDULE_WAKE_MAX_ATTEMPTS, SCHEDULE_WAKE_RETRY_BASE_MS } from "./runtime.js";
import type { TurnInput, TurnResult } from "./turn.js";

const OWNER = "alice";
const AUTH_EXPIRED =
  "AWS authentication failed · refresh your AWS credentials (SSO sign-in, access keys, API key or proxy token) and retry · API Error: 403";

/** A runtime whose turns answer from `results` in order (the last one repeats), on a clock the test moves. */
function harness(results: TurnResult[], onTurn?: (runtime: PersonaRuntime) => Promise<void>) {
  const store = createStore(":memory:");
  let nowMs = Date.parse("2026-10-11T13:00:00.000Z");
  const calls: TurnInput[] = [];
  const runtime: PersonaRuntime = new PersonaRuntime({
    db: store.db,
    owner: OWNER,
    config: resolvePersonaConfig({}),
    broadcast: () => {},
    turnRunner: async (input) => {
      calls.push(input);
      await onTurn?.(runtime);
      return results[Math.min(calls.length - 1, results.length - 1)]!;
    },
    now: () => new Date(nowMs),
  });
  return {
    store,
    runtime,
    calls,
    advance(ms: number) {
      nowMs += ms;
    },
    nowIso: () => new Date(nowMs).toISOString(),
  };
}

/** Creates a wake_persona schedule and runs it now; returns the schedule, its run and the run's wake item. */
async function fireWake(h: ReturnType<typeof harness>, threadId?: string) {
  const created = h.runtime.schedules.create(
    { title: "Daily report", cron: "0 13 * * *", timezone: "UTC", kind: "wake_persona", note: "write the daily report" },
    { createdBy: OWNER, threadId }
  );
  if (!created.ok) throw new Error(created.error);
  const ran = await h.runtime.schedules.runNow(created.value.id, { approved: true });
  if (!ran.ok) throw new Error(ran.error);
  const { id: runId, status, inboxId } = ran.value;
  expect(status).toBe("running");
  if (!inboxId) throw new Error("the run has no wake item");
  return { schedule: created.value, runId, inboxId };
}

/** The turns that carried the schedule's wake (its note). */
const wakeTurns = (h: ReturnType<typeof harness>) => h.calls.filter((c) => c.prompt.includes("write the daily report"));

/** A failed turn; `transient` is the turn runner's verdict on its diagnostics (see parseTurnOutput). */
const failed = (error: string, transient?: boolean): TurnResult => ({ ok: false, error, ...(transient ? { transient } : {}) });
const ok: TurnResult = { ok: true, text: "Report posted.", sessionId: "sid-1" };

describe("schedule run wakes — transient failures", () => {
  test("a wake that fails on expired credentials is retried after a backoff, and the run then records done", async () => {
    const h = harness([failed(AUTH_EXPIRED, true), ok]);
    const { schedule, runId, inboxId } = await fireWake(h);
    await h.runtime.drain();
    expect(h.calls).toHaveLength(1);
    let item = getPersonaInboxItem(h.store.db, inboxId)!;
    expect(item).toMatchObject({ status: "pending", attempts: 1, error: AUTH_EXPIRED });
    expect(Date.parse(item.notBefore!) - Date.parse(h.nowIso())).toBe(SCHEDULE_WAKE_RETRY_BASE_MS);
    expect(reconcilePersonaScheduleRuns(h.store.db, OWNER, h.nowIso())).toHaveLength(0);
    expect(getPersonaScheduleRun(h.store.db, runId)?.status).toBe("running");

    // Not due yet: the generic 30s retry doesn't apply to a schedule wake.
    h.advance(60_000);
    await h.runtime.drain();
    expect(h.calls).toHaveLength(1);

    h.advance(SCHEDULE_WAKE_RETRY_BASE_MS);
    await h.runtime.drain();
    expect(h.calls).toHaveLength(2);
    item = getPersonaInboxItem(h.store.db, inboxId)!;
    expect(item.status).toBe("done");
    const [settled] = reconcilePersonaScheduleRuns(h.store.db, OWNER, h.nowIso());
    expect(settled).toMatchObject({ id: runId, status: "done" });
    expect(getPersonaSchedule(h.store.db, schedule.id)?.lastOutcome).toBe("done");
    // No give-up notice for a run that got through.
    expect(listPendingPersonaInbox(h.store.db, OWNER)).toHaveLength(0);
  });

  test("a wake still failing after the last retry fails its run and posts one schedule_run event in the schedule's thread", async () => {
    const h = harness([failed("API Error: 529 Overloaded", true)]);
    const { schedule, runId, inboxId } = await fireWake(h);
    const thread = h.runtime.schedules.threadOf(schedule);
    const delays: number[] = [];
    for (let attempt = 1; attempt <= SCHEDULE_WAKE_MAX_ATTEMPTS; attempt++) {
      await h.runtime.drain();
      const item = getPersonaInboxItem(h.store.db, inboxId)!;
      expect(item.attempts).toBe(attempt);
      if (attempt < SCHEDULE_WAKE_MAX_ATTEMPTS) {
        expect(item.status).toBe("pending");
        const delay = Date.parse(item.notBefore!) - Date.parse(h.nowIso());
        delays.push(delay);
        h.advance(delay);
      } else {
        expect(item.status).toBe("failed");
      }
    }
    expect(wakeTurns(h)).toHaveLength(SCHEDULE_WAKE_MAX_ATTEMPTS);
    // 4, 8 and 16 minutes: the run is given about half an hour.
    expect(delays).toEqual([1, 2, 4].map((n) => n * SCHEDULE_WAKE_RETRY_BASE_MS));

    // The event went to a turn at once (which also failed here) and waits on the generic retry.
    const events = listPendingPersonaInbox(h.store.db, OWNER).filter((i) => i.kind === "system");
    expect(events).toHaveLength(1);
    expect(h.calls.at(-1)!.prompt).toContain(`schedule "Daily report" run failed: gave up after ${SCHEDULE_WAKE_MAX_ATTEMPTS} attempts`);
    expect(events[0]).toMatchObject({
      threadId: thread,
      payload: {
        type: "schedule_run",
        scheduleId: schedule.id,
        scheduleTitle: "Daily report",
        runId,
        status: "failed",
        error: `gave up after ${SCHEDULE_WAKE_MAX_ATTEMPTS} attempts: API Error: 529 Overloaded`,
      },
    });
    const [settled] = reconcilePersonaScheduleRuns(h.store.db, OWNER, h.nowIso());
    expect(settled).toMatchObject({ id: runId, status: "failed", error: "API Error: 529 Overloaded" });
    // The owner sees it at once in the thread, by name, even while Persona's turns keep failing;
    // the wake gets no generic "could not process" notice besides.
    expect(listPersonaMessages(h.store.db, thread).filter((m) => m.role === "system").map((m) => m.text)).toEqual([
      `Schedule "Daily report" didn't run: Persona gave up after ${SCHEDULE_WAKE_MAX_ATTEMPTS} attempts (API Error: 529 Overloaded).`,
    ]);
  });

  test("in a thread other people read, the give-up names the schedule but keeps the error out", async () => {
    const h = harness([failed(`${AUTH_EXPIRED} at /home/alice/.aws/credentials`, true)]);
    const shared = getOrCreatePersonaThreadByRef(h.store.db, OWNER, "slack", "C1:100.1", "#team");
    const { runId } = await fireWake(h, shared.id);
    for (let attempt = 1; attempt <= SCHEDULE_WAKE_MAX_ATTEMPTS; attempt++) {
      await h.runtime.drain();
      h.advance(SCHEDULE_WAKE_RETRY_BASE_MS * 2 ** (attempt - 1));
    }
    // The event's own turn failed too, so it waits on the generic retry.
    const events = listPendingPersonaInbox(h.store.db, OWNER).filter((i) => i.kind === "system");
    expect(events.map((e) => e.payload)).toEqual([
      expect.objectContaining({ runId, error: `gave up after ${SCHEDULE_WAKE_MAX_ATTEMPTS} attempts: details are in the Standup console` }),
    ]);
    const texts = listPersonaMessages(h.store.db, shared.id).filter((m) => m.role === "system").map((m) => m.text);
    expect(texts[0]).toBe(
      `Schedule "Daily report" didn't run: Persona gave up after ${SCHEDULE_WAKE_MAX_ATTEMPTS} attempts (details are in the Standup console).`
    );
    expect(texts.join("\n")).not.toContain("/home/alice");
  });

  test("in a thread other people read, Persona's schedule tools show a failed run without its error", async () => {
    const listed: string[] = [];
    const h = harness([failed("claude exited 1: ENOENT /home/alice/secret/config"), ok], async (runtime) => {
      const r = await runtime.tools.call("list_schedules", {});
      listed.push(r.content.map((c) => ("text" in c ? c.text : "")).join(""));
    });
    const shared = getOrCreatePersonaThreadByRef(h.store.db, OWNER, "slack", "C1:100.1", "#team");
    const { runId } = await fireWake(h, shared.id);
    // The wake fails at once (not transient); the give-up event's turn then lists the schedules.
    await h.runtime.drain();
    expect(reconcilePersonaScheduleRuns(h.store.db, OWNER, h.nowIso())[0]).toMatchObject({ id: runId, status: "failed" });
    h.advance(60_000);
    h.runtime.receiveUserMessage({ text: "why didn't the daily report run?", actor: OWNER, threadId: shared.id });
    await h.runtime.drain();
    const last = JSON.parse(listed.at(-1)!) as { schedules: Array<{ lastOutcome: string; lastOutcomeDetail?: string }> };
    expect(last.schedules[0]).toMatchObject({ lastOutcome: "failed", lastOutcomeDetail: "details are in the Standup console" });
    expect(listed.join("\n")).not.toContain("/home/alice");
  });

  test("an error that only reads as transient, without the runner's verdict, is not retried", async () => {
    const h = harness([failed("the reply mentioned throttling and a Bad Gateway"), ok]);
    const { inboxId } = await fireWake(h);
    await h.runtime.drain();
    expect(getPersonaInboxItem(h.store.db, inboxId)).toMatchObject({ status: "failed", attempts: 1 });
  });

  test("a wake that fails any other way is not retried: it fails at once, and Persona's next turn gets the event", async () => {
    const h = harness([failed("Prompt is too long"), ok]);
    const { runId, inboxId } = await fireWake(h);
    await h.runtime.drain();
    expect(wakeTurns(h)).toHaveLength(1);
    expect(getPersonaInboxItem(h.store.db, inboxId)).toMatchObject({ status: "failed", attempts: 1 });
    // The same drain ran the event's turn, which succeeded.
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.prompt).toContain('schedule "Daily report" run failed: gave up after 1 attempt: Prompt is too long');
    expect(listPendingPersonaInbox(h.store.db, OWNER)).toHaveLength(0);
    expect(reconcilePersonaScheduleRuns(h.store.db, OWNER, h.nowIso())[0]).toMatchObject({
      id: runId,
      status: "failed",
      error: "Prompt is too long",
    });
    h.advance(SCHEDULE_WAKE_RETRY_BASE_MS * 8);
    await h.runtime.drain();
    expect(wakeTurns(h)).toHaveLength(1);
  });

  test("other items in the failing turn keep the generic retry policy", async () => {
    const h = harness([failed(AUTH_EXPIRED, true)]);
    const { inboxId } = await fireWake(h);
    h.runtime.receiveUserMessage({ text: "and the weekly one?", actor: OWNER });
    await h.runtime.drain();
    const message = listPendingPersonaInbox(h.store.db, OWNER).find((i) => i.kind === "user_message")!;
    expect(Date.parse(message.notBefore!) - Date.parse(h.nowIso())).toBe(30_000);
    expect(Date.parse(getPersonaInboxItem(h.store.db, inboxId)!.notBefore!) - Date.parse(h.nowIso())).toBe(SCHEDULE_WAKE_RETRY_BASE_MS);
  });
});
