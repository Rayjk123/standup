import { afterAll, describe, expect, mock, setSystemTime, test } from "bun:test";
import {
  createLaunch,
  createPersonaApproval,
  createPersonaJob,
  createPersonaSchedule,
  createStore,
  getPersonaInboxItem,
  linkPersonaJobLaunch,
  listPendingPersonaInbox,
  listPersonaBriefRuns,
  listPersonaMessages,
  setJobBudgetPrefs,
  setNotifyPrefs,
  updatePersonaState,
  upsertProject,
} from "@standup/store";
import type { WsMessage } from "@standup/shared";
import { resolvePersonaConfig } from "./config.js";
import type { TurnInput, TurnResult } from "./turn.js";
import { BRIEF_HEADING } from "./prompt.js";
import { briefSince, nextBriefSlot } from "./brief.js";

// Phone pushes leave the host: record them instead, and lift the stub
// afterwards — mock.module is process-wide.
import * as push from "../push.js";
const realPush = { ...push };
const pushes: Array<{ title: string; body: string; recipient: string | null | undefined }> = [];
mock.module("../push.js", () => ({
  ...realPush,
  pushNotification: async (title: string, body: string, recipient?: string | null) => {
    pushes.push({ title, body, recipient });
  },
}));
const { PersonaRuntime } = await import("./runtime.js");

// Push privacy reads the owner-topic map; these tests run without one unless they set it.
const savedOwnerTopics = process.env.NTFY_OWNER_TOPICS;
delete process.env.NTFY_OWNER_TOPICS;

afterAll(() => {
  mock.module("../push.js", () => realPush);
  if (savedOwnerTopics === undefined) delete process.env.NTFY_OWNER_TOPICS;
  else process.env.NTFY_OWNER_TOPICS = savedOwnerTopics;
});

const OWNER = "alice";
const NY = "America/New_York";
const HOUR = 3_600_000;
/** The next 08:30 in New York: rows the test writes (stamped with the wall clock) fall in the day before it. */
const SLOT = nextBriefSlot("08:30", NY, new Date())!;

function harness(
  opts: {
    reply?: (input: TurnInput) => Promise<string> | string;
    /** The whole turn result, for a failing turn. */
    result?: (input: TurnInput) => TurnResult;
    at?: number;
    owner?: string;
    host?: string;
  } = {}
) {
  const owner = opts.owner ?? OWNER;
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  setNotifyPrefs(store.db, owner, null, { timezone: NY });
  const frames: WsMessage[] = [];
  const clock = { ms: opts.at ?? SLOT.getTime() + 5_000 };
  const calls: TurnInput[] = [];
  const runtime = new PersonaRuntime({
    db: store.db,
    owner,
    ...(opts.host ? { host: opts.host } : {}),
    config: { ...resolvePersonaConfig({}), coalesceMs: 0 },
    broadcast: (m) => frames.push(m),
    turnRunner: async (input): Promise<TurnResult> => {
      calls.push(input);
      if (opts.result) return opts.result(input);
      const text = opts.reply ? await opts.reply(input) : "Waiting on you: approve the deploy.";
      return { ok: true, text, sessionId: "sid-1", contextTokens: 100 };
    },
    now: () => new Date(clock.ms),
    dailyBrief: true,
  });
  const personaMessages = () => listPersonaMessages(store.db, runtime.consoleThreadId()).filter((m) => m.role === "persona");
  const briefItems = () =>
    (store.db.query("SELECT id FROM persona_inbox WHERE owner = ? AND kind = 'schedule'").all(owner) as Array<{ id: string }>).map(
      (r) => getPersonaInboxItem(store.db, r.id)!
    );
  return { store, db: store.db, runtime, frames, calls, clock, personaMessages, briefItems };
}

describe("daily brief from the runtime tick", () => {
  test("just after 08:30 in the owner's zone, one tick wakes one brief turn; a second tick doesn't", async () => {
    pushes.length = 0;
    const h = harness();
    // The job and approval are stamped with the wall clock; written a minute
    // before the slot, the job stays well inside its time budget at the ticks
    // below, wherever in the day the test runs.
    setSystemTime(new Date(SLOT.getTime() - 60_000));
    let job: ReturnType<typeof createPersonaJob>;
    try {
      job = createPersonaJob(h.db, { owner: OWNER, threadId: h.runtime.consoleThreadId(), title: "Deploy beta", goal: "g" });
      createPersonaApproval(h.db, { owner: OWNER, jobId: job.id, action: "launch_session", summary: "launch the deploy worker", args: {} });
    } finally {
      setSystemTime();
    }

    await h.runtime.tick();
    expect(h.briefItems()).toHaveLength(1);
    const item = h.briefItems()[0]!;
    expect(item.threadId).toBe(h.runtime.consoleThreadId());
    expect(item.payload).toMatchObject({ brief: true, slot: SLOT.toISOString(), empty: false });
    expect(item.status).toBe("done");

    expect(h.calls).toHaveLength(1);
    const prompt = h.calls[0]!.prompt;
    expect(prompt).toContain(BRIEF_HEADING);
    expect(prompt).toContain("daily brief is due");
    expect(prompt).toContain("approval waiting: launch the deploy worker");
    expect(prompt).toContain('"Deploy beta"');

    const [reply] = h.personaMessages();
    expect(reply).toMatchObject({ threadId: h.runtime.consoleThreadId(), text: "Waiting on you: approve the deploy.", notify: { kind: "brief", channels: ["slack"] } });
    // The default brief route is Slack only.
    expect(pushes).toEqual([]);
    expect(listPersonaBriefRuns(h.db, OWNER)).toEqual([
      expect.objectContaining({ slot: SLOT.toISOString(), status: "sent", inboxId: item.id }),
    ]);

    h.clock.ms += 60_000;
    await h.runtime.tick();
    h.clock.ms += HOUR;
    await h.runtime.tick();
    expect(h.briefItems()).toHaveLength(1);
    expect(h.calls).toHaveLength(1);
    expect(h.personaMessages()).toHaveLength(1);
  });

  test("before the slot nothing fires; the brief routed to push also pushes", async () => {
    pushes.length = 0;
    const h = harness({ at: SLOT.getTime() - 60_000 });
    setNotifyPrefs(h.db, OWNER, null, { timezone: NY, routes: { brief: { channels: ["slack", "push"] } } });
    createPersonaApproval(h.db, { owner: OWNER, action: "launch_session", summary: "a card", args: {} });
    await h.runtime.tick();
    expect(h.briefItems()).toEqual([]);
    expect(listPersonaBriefRuns(h.db, OWNER).filter((r) => r.slot === SLOT.toISOString())).toEqual([]);

    h.clock.ms = SLOT.getTime() + 1_000;
    await h.runtime.tick();
    expect(h.personaMessages()[0]!.notify).toEqual({ kind: "brief", channels: ["slack", "push"] });
    expect(pushes).toEqual([{ title: "Your Persona brief", body: "Waiting on you: approve the deploy.", recipient: OWNER }]);
  });

  test("nothing actionable: no inbox item, no turn, and the slot settles silent", async () => {
    const h = harness();
    await h.runtime.tick();
    expect(h.briefItems()).toEqual([]);
    expect(listPendingPersonaInbox(h.db, OWNER)).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(listPersonaBriefRuns(h.db, OWNER)).toEqual([
      expect.objectContaining({ slot: SLOT.toISOString(), status: "silent", detail: "nothing changed and nothing waits on you" }),
    ]);
  });

  test("nothing actionable but routed always: the turn is told to say so in one line", async () => {
    const h = harness({ reply: () => "Nothing new today." });
    setNotifyPrefs(h.db, OWNER, null, { timezone: NY, routes: { brief: { when: "always" } } });
    await h.runtime.tick();
    expect(h.briefItems()).toHaveLength(1);
    expect(h.briefItems()[0]!.payload.empty).toBe(true);
    expect(h.calls[0]!.prompt).toContain("Nothing changed and nothing waits on alice; say so in one line.");
    expect(h.personaMessages()[0]).toMatchObject({ text: "Nothing new today.", notify: { kind: "brief", channels: ["slack"] } });
  });

  test("a brief turn that replies silent posts nothing", async () => {
    const h = harness({ reply: () => "[silent]" });
    createPersonaApproval(h.db, { owner: OWNER, action: "launch_session", summary: "a card", args: {} });
    await h.runtime.tick();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.prompt).toContain("reply exactly [silent]");
    expect(h.personaMessages()).toEqual([]);
    expect(listPersonaBriefRuns(h.db, OWNER)).toEqual([
      expect.objectContaining({ slot: SLOT.toISOString(), status: "silent", inboxId: h.briefItems()[0]!.id }),
    ]);
    // A silent brief doesn't move the next digest's window on: it still looks a day back.
    expect(briefSince(h.db, OWNER, new Date(SLOT.getTime() + 30 * HOUR))).toBe(new Date(SLOT.getTime() + 6 * HOUR).toISOString());
  });

  test("the slot is queued while its turn runs and sent only once the reply posts", async () => {
    const seen: string[] = [];
    const h = harness({
      reply: () => {
        seen.push(...listPersonaBriefRuns(h.db, OWNER).map((r) => r.status));
        return "One approval waits.";
      },
    });
    createPersonaApproval(h.db, { owner: OWNER, action: "launch_session", summary: "a card", args: {} });
    await h.runtime.tick();
    expect(seen).toEqual(["queued"]);
    expect(listPersonaBriefRuns(h.db, OWNER)).toEqual([expect.objectContaining({ status: "sent", inboxId: h.briefItems()[0]!.id })]);
    // The next digest starts at this slot rather than a day back.
    expect(briefSince(h.db, OWNER, new Date(SLOT.getTime() + 30 * HOUR))).toBe(SLOT.toISOString());
  });

  test("a failed brief turn leaves the slot queued and the next window where it was", async () => {
    const h = harness({ result: () => ({ ok: false, error: "claude exited 1" }) });
    createPersonaApproval(h.db, { owner: OWNER, action: "launch_session", summary: "a card", args: {} });
    const later = new Date(SLOT.getTime() + 30 * HOUR);
    const before = briefSince(h.db, OWNER, later);
    await h.runtime.tick();
    expect(h.calls).toHaveLength(1);
    expect(h.personaMessages()).toEqual([]);
    expect(listPersonaBriefRuns(h.db, OWNER)).toEqual([expect.objectContaining({ slot: SLOT.toISOString(), status: "queued" })]);
    expect(briefSince(h.db, OWNER, later)).toBe(before);
    expect(before).toBe(new Date(SLOT.getTime() + 6 * HOUR).toISOString());
  });

  test("moving the brief time later the same day after the brief went out sends no second one", async () => {
    const h = harness();
    // Stamped a minute before the slot, the card is still live an hour after it, wherever in the day the test runs.
    setSystemTime(new Date(SLOT.getTime() - 60_000));
    try {
      createPersonaApproval(h.db, { owner: OWNER, action: "launch_session", summary: "a card", args: {} });
    } finally {
      setSystemTime();
    }
    await h.runtime.tick();
    expect(h.briefItems()).toHaveLength(1);
    expect(listPersonaBriefRuns(h.db, OWNER)[0]!.status).toBe("sent");

    h.clock.ms = SLOT.getTime() + HOUR;
    // `always`, so tomorrow's brief fires though today's card will have expired by then.
    setNotifyPrefs(h.db, OWNER, null, { timezone: NY, brief: { time: "09:00" }, routes: { brief: { when: "always" } } });
    await h.runtime.tick();
    await h.runtime.tick();
    expect(h.briefItems()).toHaveLength(1);
    expect(h.calls).toHaveLength(1);
    expect(listPersonaBriefRuns(h.db, OWNER)).toHaveLength(1);

    // The next day's 09:00 slot fires as usual.
    const tomorrow = nextBriefSlot("09:00", NY, new Date(h.clock.ms))!;
    h.clock.ms = tomorrow.getTime() + 5_000;
    await h.runtime.tick();
    expect(h.briefItems()).toHaveLength(2);
    expect(listPersonaBriefRuns(h.db, OWNER)[0]!.slot).toBe(tomorrow.toISOString());
  });

  test("moving the brief time hours earlier still fires the next day's brief", async () => {
    const h = harness();
    createPersonaApproval(h.db, { owner: OWNER, action: "launch_session", summary: "a card", args: {} });
    await h.runtime.tick();
    expect(h.briefItems()).toHaveLength(1);

    // 08:30 → 03:00: tomorrow's 03:00 slot is 18.5h after today's brief.
    setNotifyPrefs(h.db, OWNER, null, { timezone: NY, brief: { time: "03:00" }, routes: { brief: { when: "always" } } });
    const tomorrow = nextBriefSlot("03:00", NY, new Date(SLOT.getTime() + HOUR))!;
    expect(tomorrow.getTime() - SLOT.getTime()).toBe(18.5 * HOUR);
    h.clock.ms = tomorrow.getTime() + 5_000;
    await h.runtime.tick();
    expect(h.briefItems()).toHaveLength(2);
    expect(listPersonaBriefRuns(h.db, OWNER)[0]!.slot).toBe(tomorrow.toISOString());
  });

  test("many ticks in one slot leave one run row and one brief", async () => {
    const h = harness();
    createPersonaApproval(h.db, { owner: OWNER, action: "launch_session", summary: "a card", args: {} });
    for (let i = 0; i < 5; i++) {
      await h.runtime.tick();
      h.clock.ms += 60_000;
    }
    expect(h.briefItems()).toHaveLength(1);
    expect(h.calls).toHaveLength(1);
    expect(listPersonaBriefRuns(h.db, OWNER)).toHaveLength(1);
  });

  test("a slot past by more than three hours is left alone, not sent late", async () => {
    const h = harness({ at: SLOT.getTime() + 3 * HOUR + 60_000 });
    const card = createPersonaApproval(h.db, { owner: OWNER, action: "launch_session", summary: "a card", args: {} });
    // Stamped on the harness clock: on the wall clock the card can be over a
    // day older than this tick (SLOT is up to a day ahead), and its expiry
    // would wake a turn this test doesn't expect.
    h.db.run("UPDATE persona_approvals SET created_at = ? WHERE id = ?", [new Date(h.clock.ms).toISOString(), card.id]);
    await h.runtime.tick();
    expect(h.briefItems()).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(listPersonaBriefRuns(h.db, OWNER)).toEqual([]);
  });

  test("a paused Persona skips its brief", async () => {
    const h = harness();
    createPersonaApproval(h.db, { owner: OWNER, action: "launch_session", summary: "a card", args: {} });
    updatePersonaState(h.db, OWNER, { paused: true });
    await h.runtime.tick();
    expect(h.briefItems()).toEqual([]);
    expect(listPersonaBriefRuns(h.db, OWNER)).toEqual([expect.objectContaining({ status: "skipped", detail: "Persona was paused" })]);
  });

  test("off while a legacy report schedule runs, unless the owner turned the brief on", async () => {
    const h = harness();
    createPersonaApproval(h.db, { owner: OWNER, action: "launch_session", summary: "a card", args: {} });
    createPersonaSchedule(h.db, { owner: OWNER, title: "Daily report", cron: "0 9 * * *", timezone: NY, kind: "wake_persona", note: "n", createdBy: OWNER });
    await h.runtime.tick();
    expect(listPersonaBriefRuns(h.db, OWNER)).toEqual([]);
    setNotifyPrefs(h.db, OWNER, null, { timezone: NY, brief: { enabled: true } });
    await h.runtime.tick();
    expect(h.briefItems()).toHaveLength(1);
  });

  test("the owner's brief time and zone are honoured", async () => {
    const berlinSlot = nextBriefSlot("07:15", "Europe/Berlin", new Date())!;
    const h = harness({ at: berlinSlot.getTime() + 1_000 });
    setNotifyPrefs(h.db, OWNER, null, { timezone: "Europe/Berlin", brief: { time: "07:15" } });
    createPersonaApproval(h.db, { owner: OWNER, action: "launch_session", summary: "a card", args: {} });
    await h.runtime.tick();
    expect(h.briefItems().map((i) => i.payload.slot)).toEqual([berlinSlot.toISOString()]);
  });

  test("off by default under STANDUP_TEST", async () => {
    const store = createStore(":memory:");
    createPersonaApproval(store.db, { owner: OWNER, action: "launch_session", summary: "a card", args: {} });
    const runtime = new PersonaRuntime({
      db: store.db,
      owner: OWNER,
      config: resolvePersonaConfig({}),
      broadcast: () => {},
      turnRunner: async () => ({ ok: true, text: "x", sessionId: "s" }),
      now: () => new Date(SLOT.getTime() + 5_000),
    });
    expect(process.env.STANDUP_TEST).toBe("1");
    await runtime.tick();
    expect(listPersonaBriefRuns(store.db, OWNER)).toEqual([]);
  });
});

describe("routing a turn's reply", () => {
  test("a turn that closes a job posts a done update, routed by the owner's prefs, pushing when routed to push", async () => {
    pushes.length = 0;
    let jobId = "";
    const h = harness({
      reply: async (input) => {
        if (input.prompt.includes("check the job")) {
          const r = await h.runtime.tools.call("close_job", { jobId, status: "done", outcome: "merged" });
          expect(r.isError).toBeFalsy();
        }
        return "Closed: Ship it is done.";
      },
    });
    setNotifyPrefs(h.db, OWNER, null, { timezone: NY, routes: { done: { channels: ["push"] } } });
    jobId = createPersonaJob(h.db, { owner: OWNER, threadId: h.runtime.consoleThreadId(), title: "Ship it", goal: "g" }).id;
    h.runtime.enqueue("schedule", { note: "check the job" }, { threadId: h.runtime.consoleThreadId() });
    await h.runtime.drain();
    expect(h.personaMessages().at(-1)).toMatchObject({ text: "Closed: Ship it is done.", notify: { kind: "done", channels: ["push"] } });
    expect(pushes).toEqual([{ title: "Persona: job done", body: "Closed: Ship it is done.", recipient: OWNER }]);
  });

  test("failures_only: a job closed done stays in the console; one closed failed goes out", async () => {
    pushes.length = 0;
    const ids: string[] = [];
    const h = harness({
      reply: async (input) => {
        const m = /close (\S+) (done|failed)/.exec(input.prompt);
        if (m) await h.runtime.tools.call("close_job", { jobId: m[1], status: m[2], outcome: "o" });
        return `closed ${m?.[2]}`;
      },
    });
    setNotifyPrefs(h.db, OWNER, null, { timezone: NY, routes: { done: { channels: ["slack", "push"], when: "failures_only" } } });
    for (const t of ["a", "b"]) ids.push(createPersonaJob(h.db, { owner: OWNER, threadId: h.runtime.consoleThreadId(), title: t, goal: "g" }).id);
    h.runtime.enqueue("schedule", { note: `close ${ids[0]} done` }, { threadId: h.runtime.consoleThreadId() });
    await h.runtime.drain();
    h.runtime.enqueue("schedule", { note: `close ${ids[1]} failed` }, { threadId: h.runtime.consoleThreadId() });
    await h.runtime.drain();
    const [ok, failed] = h.personaMessages();
    expect(ok!.notify).toEqual({ kind: "done", channels: [] });
    expect(failed!.notify).toEqual({ kind: "done", channels: ["slack", "push"] });
    expect(pushes.map((p) => p.title)).toEqual(["Persona: a job ended unfinished"]);
  });

  test("a project layer routes a done update about that project's job", async () => {
    let jobId = "";
    const h = harness({
      reply: async () => {
        await h.runtime.tools.call("close_job", { jobId, status: "cancelled", outcome: "o" });
        return "cancelled it";
      },
    });
    setNotifyPrefs(h.db, OWNER, "p", { routes: { done: { channels: [] } } });
    jobId = createPersonaJob(h.db, { owner: OWNER, threadId: h.runtime.consoleThreadId(), title: "In p", goal: "g" }).id;
    createLaunch(h.db, { id: "lp", projectId: "p", task: "t", worktreePath: "/w", branch: "b" });
    linkPersonaJobLaunch(h.db, jobId, "lp");
    h.runtime.enqueue("schedule", { note: "go" }, { threadId: h.runtime.consoleThreadId() });
    await h.runtime.drain();
    expect(h.personaMessages().at(-1)!.notify).toEqual({ kind: "done", channels: [] });
  });

  test("a reply to the owner's own message is a conversation and isn't routed, even when it closes a job", async () => {
    let jobId = "";
    const h = harness({
      reply: async () => {
        await h.runtime.tools.call("close_job", { jobId, status: "done", outcome: "o" });
        return "Done.";
      },
    });
    jobId = createPersonaJob(h.db, { owner: OWNER, threadId: h.runtime.consoleThreadId(), title: "x", goal: "g" }).id;
    h.runtime.receiveUserMessage({ text: "close it", actor: OWNER });
    await h.runtime.drain();
    const reply = h.personaMessages().at(-1)!;
    expect(reply.text).toBe("Done.");
    expect(reply.notify).toBeUndefined();
  });

  test("ask_user's question is a decision update: pushed by default, kept off push and Slack under approvals_only", async () => {
    pushes.length = 0;
    const h = harness();
    const first = await h.runtime.tools.call("ask_user", { question: "Which branch?", options: ["main", "dev"] });
    expect(first.isError).toBeFalsy();
    expect(h.personaMessages().at(-1)).toMatchObject({ text: "Which branch?", notify: { kind: "decision", channels: ["slack", "push"] } });
    expect(pushes).toEqual([{ title: "Persona has a question", body: "Which branch?", recipient: OWNER }]);

    pushes.length = 0;
    setNotifyPrefs(h.db, OWNER, null, { timezone: NY, routes: { decision: { when: "approvals_only" } } });
    await h.runtime.tools.call("ask_user", { question: "Which repo?", options: ["a", "b"] });
    expect(h.personaMessages().at(-1)).toMatchObject({ text: "Which repo?", notify: { kind: "decision", channels: [] } });
    expect(pushes).toEqual([]);
  });

  test("a reply woken only by a job's worker event is a progress update", async () => {
    const h = harness({ reply: () => "The worker went idle." });
    setNotifyPrefs(h.db, OWNER, null, { timezone: NY, routes: { progress: { channels: ["slack"], when: "always" } } });
    const job = createPersonaJob(h.db, { owner: OWNER, threadId: h.runtime.consoleThreadId(), title: "Watch", goal: "g" });
    h.runtime.enqueue("worker_event", { type: "idle", jobId: job.id, sessionId: "s1" }, { threadId: h.runtime.consoleThreadId() });
    await h.runtime.drain();
    const reply = h.personaMessages().at(-1)!;
    expect(reply.jobIds).toEqual([job.id]);
    expect(reply.notify).toEqual({ kind: "progress", channels: ["slack"] });
  });

  test("ask_user in a turn answering the owner posts as conversation, without notify", async () => {
    const h = harness({
      reply: async () => {
        await h.runtime.tools.call("ask_user", { question: "Squash or merge?", options: ["squash", "merge"] });
        return "[silent]";
      },
    });
    h.runtime.receiveUserMessage({ text: "land it", actor: OWNER });
    await h.runtime.drain();
    const question = h.personaMessages().find((m) => m.text === "Squash or merge?")!;
    expect(question.options).toEqual(["squash", "merge"]);
    expect(question.notify).toBeUndefined();
  });

  test("ask_user in a turn a worker event woke is routed as a decision", async () => {
    const h = harness({
      reply: async () => {
        await h.runtime.tools.call("ask_user", { question: "The worker wants to push. Allow?", options: ["yes", "no"] });
        return "[silent]";
      },
    });
    const job = createPersonaJob(h.db, { owner: OWNER, threadId: h.runtime.consoleThreadId(), title: "Push it", goal: "g" });
    h.runtime.enqueue("worker_event", { type: "ask", jobId: job.id, sessionId: "s1" }, { threadId: h.runtime.consoleThreadId() });
    await h.runtime.drain();
    const question = h.personaMessages().find((m) => m.text.startsWith("The worker wants to push"))!;
    expect(question.notify).toEqual({ kind: "decision", channels: ["slack", "push"] });
  });
});

describe("push privacy: a user's own content is pushed only to a topic of their own", () => {
  const HOST_ALIAS = "hostuser";
  const GUEST_ALIAS = "guestuser";
  const allPush = { brief: { channels: ["push" as const] }, done: { channels: ["push" as const] }, progress: { channels: ["push" as const], when: "always" as const } };

  /** A brief, a done update and a progress update for `owner` (all routed to push), then a question. */
  async function everyKind(owner: string) {
    let jobId = "";
    let progressJobId = "";
    const h = harness({
      owner,
      host: HOST_ALIAS,
      reply: async (input) => {
        if (input.prompt.includes("wrap up")) {
          await h.runtime.tools.call("close_job", { jobId, status: "done", outcome: "o" });
          return "Done update.";
        }
        if (input.prompt.includes(BRIEF_HEADING)) return "Brief text.";
        return "Progress update.";
      },
    });
    setNotifyPrefs(h.db, owner, null, { timezone: NY, routes: allPush });
    // The clock sits at the next brief slot, up to a day past the jobs' real
    // creation time; with no limit no budget notice adds a turn of its own.
    setJobBudgetPrefs(h.db, owner, null, { usd: 0, minutes: 0 });
    createPersonaApproval(h.db, { owner, action: "launch_session", summary: "a card", args: {} });
    jobId = createPersonaJob(h.db, { owner, threadId: h.runtime.consoleThreadId(), title: "Close me", goal: "g" }).id;
    progressJobId = createPersonaJob(h.db, { owner, threadId: h.runtime.consoleThreadId(), title: "Watch me", goal: "g" }).id;
    await h.runtime.tick();
    h.runtime.enqueue("schedule", { note: "wrap up" }, { threadId: h.runtime.consoleThreadId() });
    await h.runtime.drain();
    h.runtime.enqueue("worker_event", { type: "idle", jobId: progressJobId, sessionId: "s1" }, { threadId: h.runtime.consoleThreadId() });
    await h.runtime.drain();
    await h.runtime.tools.call("ask_user", { question: "A decision?", options: ["a", "b"] });
    return h;
  }

  test("a guest with no owner-topic entry gets no brief, done or progress push; decisions push as before", async () => {
    pushes.length = 0;
    const h = await everyKind(GUEST_ALIAS);
    // The routing is stored as chosen; only the push is withheld.
    expect(h.personaMessages().map((m) => m.notify?.kind)).toEqual(["brief", "done", "progress", "decision"]);
    expect(h.personaMessages().slice(0, 3).every((m) => m.notify!.channels.includes("push"))).toBe(true);
    expect(pushes).toEqual([{ title: "Persona has a question", body: "A decision?", recipient: GUEST_ALIAS }]);
  });

  test("the host, with no owner-topic map, gets every push", async () => {
    pushes.length = 0;
    await everyKind(HOST_ALIAS);
    expect(pushes.map((p) => [p.title, p.recipient])).toEqual([
      ["Your Persona brief", HOST_ALIAS],
      ["Persona: job done", HOST_ALIAS],
      ["Persona update", HOST_ALIAS],
      ["Persona has a question", HOST_ALIAS],
    ]);
  });

  test("with an owner-topic map, a guest listed in it gets every push and the unlisted host gets only decisions", async () => {
    process.env.NTFY_OWNER_TOPICS = `${GUEST_ALIAS}:guest-phone`;
    try {
      pushes.length = 0;
      await everyKind(GUEST_ALIAS);
      expect(pushes).toHaveLength(4);
      pushes.length = 0;
      await everyKind(HOST_ALIAS);
      expect(pushes.map((p) => p.title)).toEqual(["Persona has a question"]);
    } finally {
      delete process.env.NTFY_OWNER_TOPICS;
    }
  });
});
