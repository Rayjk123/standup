import { describe, expect, test } from "bun:test";
import type { PersonaApproval, PersonaJob, PersonaMessage, PersonaState, WsMessage } from "@standup/shared";
import {
  PERSONA_PAGE,
  catchUpFromSeq,
  catchUpPath,
  catchUpPersonaThread,
  DRAINING_HEADER,
  fetchPersonaSnapshot,
  filteredThread,
  hasOlderMessages,
  initialPersonaViewState,
  personaCall,
  personaReducer,
  personaViewFromCache,
  savePersonaCache,
  syncPersonaSnapshot,
  type PersonaSnapshot,
  type PersonaViewState,
} from "./persona";

/*
 * The Persona thread can't stay stale: what the reducer does with every kind
 * of frame or read that could leave a message off screen, and the visible-tab
 * catch-up that reads back whatever the live socket lost.
 */

const T = "t-console";
const msg = (seq: number, over: Partial<PersonaMessage> = {}): PersonaMessage => ({
  id: `m${seq}`,
  threadId: T,
  seq,
  role: "persona",
  text: `message ${seq}`,
  createdAt: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
  ...over,
});
const view = (messages: PersonaMessage[], over: Partial<PersonaViewState> = {}): PersonaViewState => ({
  ...initialPersonaViewState,
  loaded: true,
  threadId: T,
  consoleThreadId: T,
  messages,
  ...over,
});
const frame = (m: PersonaMessage): WsMessage => ({ type: "persona:message", payload: m, timestamp: "t" });
const ids = (v: PersonaViewState) => v.messages.map((m) => m.id);

describe("frames that must not be dropped", () => {
  test("a frame whose seq is below the window's newest (a late or re-sent message) is placed in order", () => {
    const next = personaReducer(view([msg(1), msg(3)]), { type: "frame", message: frame(msg(2)) });
    expect(ids(next)).toEqual(["m1", "m2", "m3"]);
  });

  test("a tagged frame (postTagged) for a message never seen is added, tags and all", () => {
    const tagged = msg(4, { jobIds: ["j1"], jobTags: [{ jobId: "j1", source: "declared" }] });
    const next = personaReducer(view([msg(3)]), { type: "frame", message: frame(tagged) });
    expect(ids(next)).toEqual(["m3", "m4"]);
    expect(next.messages[1]!.jobTags).toEqual([{ jobId: "j1", source: "declared" }]);
  });

  test("a tag re-publish of an owner message updates it in place, with no duplicate", () => {
    const owner = msg(5, { role: "user" });
    const retagged = { ...owner, jobIds: ["j1"], jobTags: [{ jobId: "j1", source: "inferred" as const }] };
    const next = personaReducer(view([msg(4), owner]), { type: "frame", message: frame(retagged) });
    expect(ids(next)).toEqual(["m4", "m5"]);
    expect(next.messages[1]!.jobIds).toEqual(["j1"]);
  });

  test("a frame for another thread (a Slack DM) is held for it, and shows when that thread is picked", () => {
    const dm = msg(1, { id: "dm1", threadId: "t-dm" });
    let next = personaReducer(view([msg(9)]), { type: "frame", message: frame(dm) });
    expect(ids(next)).toEqual(["m9"]);
    next = personaReducer(next, { type: "select", threadId: "t-dm" });
    expect(ids(next)).toEqual(["dm1"]);
  });
});

describe("re-publishes of messages older than the window", () => {
  test("an edit to a message older than the loaded window and not held is ignored, so it opens no hole", () => {
    const start = view([msg(300), msg(301)]);
    const next = personaReducer(start, { type: "frame", message: frame(msg(5, { jobIds: ["j1"] })) });
    expect(ids(next)).toEqual(["m300", "m301"]);
  });

  test("an edit to a held backfill row still updates it", () => {
    const old = msg(5);
    const start = view([msg(300)], { backfill: { threadId: T, key: "j1", messages: [old] } });
    const next = personaReducer(start, { type: "frame", message: frame({ ...old, jobIds: ["j1"] }) });
    expect(next.backfill!.messages[0]!.jobIds).toEqual(["j1"]);
    expect(ids(next)).toEqual(["m300"]);
  });
});

describe("the catchUp action", () => {
  test("adds only unseen rows, in seq order, with no duplicates", () => {
    const start = view([msg(1), msg(2), msg(4)]);
    const next = personaReducer(start, { type: "catchUp", messages: [msg(2), msg(3), msg(5)] });
    expect(ids(next)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(personaReducer(next, { type: "catchUp", messages: [msg(3), msg(5)] })).toBe(next);
  });

  test("never overwrites a held row with the read's older copy (a tag frame that raced it)", () => {
    const tagged = msg(2, { jobIds: ["j1"], jobTags: [{ jobId: "j1", source: "inferred" }] });
    const next = personaReducer(view([msg(1), tagged]), { type: "catchUp", messages: [msg(2), msg(3)] });
    expect(next.messages[1]!.jobIds).toEqual(["j1"]);
    expect(ids(next)).toEqual(["m1", "m2", "m3"]);
  });

  test("confirms an unconfirmed send whose echo the socket lost, so it isn't shown twice", () => {
    const start = view([msg(1)], {
      outbox: [{ idempotencyKey: "k1", text: "hi there", status: "sending", createdAt: "t", afterSeq: 1, threadId: T }],
    });
    const next = personaReducer(start, { type: "catchUp", messages: [msg(2, { role: "user", text: "hi there" })] });
    expect(next.outbox).toEqual([]);
    expect(ids(next)).toEqual(["m1", "m2"]);
  });

  test("a row held only in the backfill isn't added to the window", () => {
    const old = msg(1, { jobIds: ["j1"] });
    const start = view([msg(50)], { backfill: { threadId: T, key: "j1", messages: [old] } });
    expect(personaReducer(start, { type: "catchUp", messages: [old] })).toBe(start);
  });
});

describe("filteredThread keeps the conversation the owner is having", () => {
  test("an untagged reply to a message sent while filtering stays in view", () => {
    const tagged = msg(10, { jobIds: ["j1"] });
    const untaggedBefore = msg(11);
    const sent = msg(12, { role: "user" });
    const reply = msg(13);
    const { rows, matches } = filteredThread([tagged, untaggedBefore, sent, reply], [], new Set(["j1"]), 11);
    expect(rows.map((m) => m.id)).toEqual(["m10", "m12", "m13"]);
    expect(matches).toBe(1);
  });

  test("with nothing sent while filtering, untagged replies stay filtered out", () => {
    const { rows } = filteredThread([msg(10, { jobIds: ["j1"] }), msg(12), msg(13)], [], new Set(["j1"]), 11);
    expect(rows.map((m) => m.id)).toEqual(["m10"]);
  });

  test("the reply stays when the sent message itself carries the filter's tag (picked, or inferred later)", () => {
    const sent = msg(12, { role: "user", jobIds: ["j1"], jobTags: [{ jobId: "j1", source: "inferred" }] });
    const { rows } = filteredThread([msg(10, { jobIds: ["j1"] }), sent, msg(13)], [], new Set(["j1"]), 11);
    expect(rows.map((m) => m.id)).toEqual(["m10", "m12", "m13"]);
  });

  test("after a send, a row tagged only with another job is about that job and stays out", () => {
    const sent = msg(12, { role: "user" });
    const other = msg(13, { jobIds: ["j2"] });
    const { rows } = filteredThread([msg(10, { jobIds: ["j1"] }), sent, other, msg(14)], [], new Set(["j1"]), 11);
    expect(rows.map((m) => m.id)).toEqual(["m10", "m12", "m14"]);
  });
});

describe("catchUpFromSeq", () => {
  test("the seq before the first hole, else the newest", () => {
    expect(catchUpFromSeq([msg(4), msg(5), msg(6)])).toBe(6);
    expect(catchUpFromSeq([msg(4), msg(6), msg(9)])).toBe(4);
    expect(catchUpFromSeq([msg(7)])).toBe(7);
  });
});

describe("catchUpPath", () => {
  test("reads after the newest held seq, or the newest page when nothing is held", () => {
    expect(catchUpPath("t 1", 41)).toBe("/messages?threadId=t+1&limit=100&afterSeq=41");
    expect(catchUpPath("t1", null, 20)).toBe("/messages?threadId=t1&limit=20");
  });
});

/** A stand-in for `GET /api/persona/messages` over `rows`, recording each read's path. */
function server(rows: PersonaMessage[]) {
  const reads: string[] = [];
  const fetchFn = async (input: string) => {
    reads.push(input);
    const url = new URL(input, "http://console");
    const after = url.searchParams.get("afterSeq");
    const limit = Number(url.searchParams.get("limit"));
    const thread = rows.filter((m) => m.threadId === url.searchParams.get("threadId"));
    const out = after === null ? thread.slice(-limit) : thread.filter((m) => m.seq > Number(after)).slice(0, limit);
    return Response.json({ threadId: T, messages: out });
  };
  return { reads, fetchFn };
}

async function runCatchUp(start: PersonaViewState, rows: PersonaMessage[], opts: { pageSize?: number; maxPages?: number } = {}) {
  let v = start;
  let missed = 0;
  let resyncs = 0;
  const s = server(rows);
  const ok = await catchUpPersonaThread({
    view: () => v,
    apply: (messages) => {
      v = personaReducer(v, { type: "catchUp", messages });
    },
    resync: async () => {
      resyncs++;
    },
    fetchFn: s.fetchFn,
    onMissed: () => missed++,
    ...opts,
  });
  return { ok, view: v, missed, resyncs, reads: s.reads };
}

describe("catchUpPersonaThread", () => {
  test("nothing new: one small read, no change, the socket left alone", async () => {
    const start = view([msg(1), msg(2)]);
    const r = await runCatchUp(start, [msg(1), msg(2)]);
    expect(r.ok).toBe(true);
    expect(r.view).toBe(start);
    expect(r.reads).toEqual(["/api/persona/messages?threadId=t-console&limit=100&afterSeq=2"]);
    expect(r.missed).toBe(0);
    expect(r.resyncs).toBe(0);
  });

  test("a message the socket lost is added and flagged; the socket is checked and the rest resynced", async () => {
    const r = await runCatchUp(view([msg(1)]), [msg(1), msg(2), msg(3)]);
    expect(ids(r.view)).toEqual(["m1", "m2", "m3"]);
    expect(r.missed).toBe(1);
    // Cards, jobs and tag edits sent alongside the lost frame come back with the resync.
    expect(r.resyncs).toBe(1);
  });

  test("a reply lost behind the owner's next send (which came back on its POST) is read from the hole", async () => {
    // seq 2 (Persona's reply) never arrived; seq 3 (the owner's follow-up) did, on the POST response.
    const start = view([msg(1), msg(3, { role: "user" })]);
    const r = await runCatchUp(start, [msg(1), msg(2), msg(3, { role: "user" })]);
    expect(r.reads).toEqual(["/api/persona/messages?threadId=t-console&limit=100&afterSeq=1"]);
    expect(ids(r.view)).toEqual(["m1", "m2", "m3"]);
    expect(r.missed).toBe(1);
  });

  test("a long run is read page by page, up to the cap, in order", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => msg(i + 1));
    const r = await runCatchUp(view([msg(1)]), rows, { pageSize: 3, maxPages: 3 });
    expect(ids(r.view)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9", "m10"]);
    expect(r.reads.length).toBe(3);
    const again = await runCatchUp(r.view, rows, { pageSize: 3, maxPages: 3 });
    expect(ids(again.view)).toEqual(rows.map((m) => m.id));
  });

  test("a view holding nothing reads the newest page, never the thread's oldest rows", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => msg(i + 1));
    const r = await runCatchUp(view([]), rows, { pageSize: 4 });
    expect(ids(r.view)).toEqual(["m7", "m8", "m9", "m10"]);
    expect(r.reads).toEqual(["/api/persona/messages?threadId=t-console&limit=4"]);
  });

  test("a failed read changes nothing and reports failure", async () => {
    const start = view([msg(1)]);
    let v = start;
    const ok = await catchUpPersonaThread({
      view: () => v,
      apply: (messages) => {
        v = personaReducer(v, { type: "catchUp", messages });
      },
      resync: async () => {},
      fetchFn: async () => new Response("bad gateway", { status: 502 }),
    });
    expect(ok).toBe(false);
    expect(v).toBe(start);
  });

  test("a read answered after the view moved to another thread is dropped", async () => {
    let v = view([msg(1)]);
    const ok = await catchUpPersonaThread({
      view: () => v,
      apply: () => {
        throw new Error("must not apply");
      },
      resync: async () => {},
      fetchFn: async () => {
        v = { ...v, threadId: "t-other" };
        return Response.json({ threadId: T, messages: [msg(2)] });
      },
    });
    expect(ok).toBe(true);
  });

  test("a view whose resync ran out of retries resyncs once, and still reads the thread", async () => {
    const r = await runCatchUp(view([msg(1)], { loadError: "Request failed (502)" }), [msg(1), msg(2)]);
    // One resync for the error; the find doesn't add a second in the same run.
    expect(r.resyncs).toBe(1);
    expect(r.reads.length).toBe(1);
    expect(ids(r.view)).toEqual(["m1", "m2"]);
  });

  test("a read stuck on a dead connection gives up after the read timeout", async () => {
    let aborted = false;
    const ok = await catchUpPersonaThread({
      view: () => view([msg(1)]),
      apply: () => {},
      resync: async () => {},
      readTimeoutMs: 50,
      fetchFn: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    });
    expect(ok).toBe(false);
    expect(aborted).toBe(true);
  });

  test("nothing is read before the view has loaded, or while Persona is off or refused", async () => {
    for (const over of [{ loaded: false }, { threadId: null }, { disabledReason: "off" }, { forbidden: "no" }]) {
      const r = await runCatchUp(view([msg(1)], over), [msg(1), msg(2)]);
      expect(r.reads).toEqual([]);
    }
  });

  test("a view showing a refusal resyncs to see whether it still holds; only when it is due", async () => {
    for (const over of [{ disabledReason: "draining" }, { forbidden: "no" }]) {
      expect((await runCatchUp(view([msg(1)], over), [msg(1)])).resyncs).toBe(1);
      const held = await catchUpPersonaThread({
        view: () => view([msg(1)], over),
        apply: () => {},
        resync: async () => {
          throw new Error("not due");
        },
        refusedResyncDue: () => false,
        fetchFn: server([msg(1)]).fetchFn,
      });
      expect(held).toBe(true);
    }
    // Nothing refused, nothing failed: no resync at all.
    expect((await runCatchUp(view([msg(1)]), [msg(1)])).resyncs).toBe(0);
    // A capacity refusal comes from writes alone; a read can't say it ended, so none is made for it.
    const full = view([msg(1)], { disabledReason: "this host already runs 2 Personas", unavailable: true });
    expect((await runCatchUp(full, [msg(1)])).resyncs).toBe(0);
  });

  test("onAnswered says the collector answered: never for a run that made no request", async () => {
    const answered = async (v: PersonaViewState, resync: () => Promise<unknown>, fetchFn = server([msg(1)]).fetchFn) => {
      let n = 0;
      await catchUpPersonaThread({ view: () => v, apply: () => {}, resync, fetchFn, refusedResyncDue: () => false, onAnswered: () => n++ });
      return n;
    };
    const none = async () => {};
    // A messages read that came back.
    expect(await answered(view([msg(1)]), none)).toBe(1);
    // Not loaded, Persona off with no resync due: no request at all.
    expect(await answered(view([msg(1)], { loaded: false }), none)).toBe(0);
    expect(await answered(view([msg(1)], { disabledReason: "off" }), none)).toBe(0);
    // A read that failed.
    expect(await answered(view([msg(1)]), none, async () => new Response("down", { status: 502 }))).toBe(0);
    // A resync that loaded counts, even when the view it leaves reads nothing.
    expect(await answered(view([msg(1)], { loadError: "x", loaded: false }), async () => true)).toBe(1);
    expect(await answered(view([msg(1)], { loadError: "x", loaded: false }), async () => false)).toBe(0);
  });

  test("once the resync finds Persona on again, the same catch-up reads what was missed", async () => {
    let v = view([msg(1)], { disabledReason: "draining" });
    const s = server([msg(1), msg(2)]);
    await catchUpPersonaThread({
      view: () => v,
      apply: (messages) => {
        v = personaReducer(v, { type: "catchUp", messages });
      },
      resync: async () => {
        v = personaReducer(v, { type: "snapshot", snapshot: { state: personaState(), messages: { threadId: T, messages: [msg(1)] } }, frameMark: v.frames });
      },
      fetchFn: s.fetchFn,
    });
    expect(v.disabledReason).toBeUndefined();
    expect(ids(v)).toEqual(["m1", "m2"]);
  });
});

const personaState = (): PersonaState => ({
  owner: "owner",
  runState: "idle",
  threadId: T,
  epoch: 1,
  pendingInbox: 0,
  activeLaunches: 0,
  maxActiveLaunches: 6,
});

/** What a draining collector answers every new request (packages/collector/src/drain.ts). */
const draining = () =>
  new Response(JSON.stringify({ error: "draining" }), {
    status: 503,
    headers: { "content-type": "application/json", [DRAINING_HEADER]: "refused" },
  });

describe("a collector draining for a restart", () => {
  test("its 503 is a failed read, not Persona being off", async () => {
    const res = await personaCall("/state", undefined, async () => draining());
    expect(res.ok).toBe(false);
    expect(res.disabled).toBe(false);
    // The body alone is enough when a proxy dropped the header.
    const bare = await personaCall("/state", undefined, async () => Response.json({ error: "draining" }, { status: 503 }));
    expect(bare.disabled).toBe(false);
    // The collector's own "Persona is off" 503 still reads as off.
    const off = await personaCall("/state", undefined, async () => Response.json({ error: "Persona is disabled" }, { status: 503 }));
    expect(off.disabled).toBe(true);
  });

  test("a snapshot read while it drains is a load error to retry, never a disabled Persona", async () => {
    const snapshot = await fetchPersonaSnapshot(async () => draining(), T);
    expect(snapshot.disabledReason).toBeUndefined();
    expect(snapshot.loadError).toBe("draining");
  });

  test("the resync that follows a restart retries past the drain and loads", async () => {
    let v = view([msg(1)]);
    let calls = 0;
    const loaded = await syncPersonaSnapshot({
      fetchSnapshot: () =>
        fetchPersonaSnapshot(async (input) => {
          calls++;
          if (calls <= 6) return draining();
          return String(input).includes("/messages")
            ? Response.json({ threadId: T, messages: [msg(1), msg(2)] })
            : String(input).includes("/state")
              ? Response.json(personaState())
              : Response.json({ jobs: [], approvals: [], threads: [] });
        }, T),
      apply: (snapshot, frameMark) => {
        v = personaReducer(v, { type: "snapshot", snapshot, frameMark });
      },
      frameMark: () => v.frames,
      current: () => true,
      sleep: async () => {},
    });
    expect(loaded).toBe(true);
    expect(v.disabledReason).toBeUndefined();
    expect(ids(v)).toEqual(["m1", "m2"]);
  });

  test("a snapshot that loads with Persona on clears a refusal an earlier read left", () => {
    const stuck = view([msg(1)], { disabledReason: "draining" });
    const next = personaReducer(stuck, {
      type: "snapshot",
      snapshot: { state: personaState(), messages: { threadId: T, messages: [msg(1), msg(2)] } },
      frameMark: stuck.frames,
    });
    expect(next.disabledReason).toBeUndefined();
    expect(ids(next)).toEqual(["m1", "m2"]);
    // Frames landed while it was in flight, so its state isn't applied: the refusal still clears.
    const held = { ...stuck, state: personaState(), frames: 3 };
    const raced = personaReducer(held, {
      type: "snapshot",
      snapshot: { state: personaState(), messages: { threadId: T, messages: [msg(1)] } },
      frameMark: 2,
    });
    expect(raced.disabledReason).toBeUndefined();
    // A snapshot that failed says nothing either way.
    const failed = personaReducer(stuck, { type: "snapshot", snapshot: { loadError: "Request failed (502)" }, frameMark: stuck.frames });
    expect(failed.disabledReason).toBe("draining");
  });
});

const range = (from: number, to: number, over: Partial<PersonaMessage> = {}) =>
  Array.from({ length: to - from + 1 }, (_, i) => msg(from + i, over));

describe("older pages", () => {
  test("a page above the window is prepended in order, with what's held kept once", () => {
    const start = view(range(151, 200));
    const next = personaReducer(start, { type: "older", threadId: T, messages: range(101, 151), limit: 51 });
    expect(next.messages.map((m) => m.seq)).toEqual(range(101, 200).map((m) => m.seq));
    expect(new Set(ids(next)).size).toBe(100);
    expect(next.oldestReached[T]).toBeUndefined();
    expect(hasOlderMessages(next)).toBe(true);
  });

  test("a short page marks the thread's oldest reached, and nothing older is offered", () => {
    const start = view(range(31, 80));
    const next = personaReducer(start, { type: "older", threadId: T, messages: range(1, 30), limit: PERSONA_PAGE });
    expect(next.messages[0]!.seq).toBe(1);
    expect(next.oldestReached[T]).toBe(true);
    expect(hasOlderMessages(next)).toBe(false);
  });

  test("an empty page marks the oldest reached without touching the rows", () => {
    const start = view(range(5, 9));
    const next = personaReducer(start, { type: "older", threadId: T, messages: [], limit: PERSONA_PAGE });
    expect(next.messages).toBe(start.messages);
    expect(next.oldestReached[T]).toBe(true);
    expect(hasOlderMessages(next)).toBe(false);
  });

  test("a page for a thread no longer selected is ignored", () => {
    const start = view(range(51, 100));
    expect(personaReducer(start, { type: "older", threadId: "t-dm", messages: range(1, 50), limit: PERSONA_PAGE })).toBe(start);
  });

  test("rows of another thread riding a page are left out", () => {
    const start = view(range(51, 100));
    const stray = msg(10, { id: "dm10", threadId: "t-dm" });
    const next = personaReducer(start, { type: "older", threadId: T, messages: [stray, ...range(1, 50)], limit: PERSONA_PAGE + 1 });
    expect(ids(next)).not.toContain("dm10");
    expect(next.messages).toHaveLength(100);
    // 50 of the thread's rows against a limit of 51 is a short page.
    expect(next.oldestReached[T]).toBe(true);
  });

  test("hasOlderMessages: a window starting past seq 1, on a thread not yet read to its start", () => {
    expect(hasOlderMessages(view(range(2, 5)))).toBe(true);
    expect(hasOlderMessages(view(range(1, 5)))).toBe(false);
    expect(hasOlderMessages(view([]))).toBe(false);
    expect(hasOlderMessages(view(range(2, 5), { threadId: null }))).toBe(false);
    expect(hasOlderMessages(view(range(2, 5), { oldestReached: { [T]: true } }))).toBe(false);
    // Another thread's oldest being reached says nothing about this one.
    expect(hasOlderMessages(view(range(2, 5), { oldestReached: { "t-dm": true } }))).toBe(true);
  });

  test("the catch-up after older pages reads after the newest held seq: the prepended pages open no hole", async () => {
    const all = range(1, 210);
    let v = view(all.slice(150, 200));
    v = personaReducer(v, { type: "older", threadId: T, messages: all.slice(100, 150), limit: PERSONA_PAGE });
    v = personaReducer(v, { type: "older", threadId: T, messages: all.slice(50, 100), limit: PERSONA_PAGE });
    expect(v.messages[0]!.seq).toBe(51);
    expect(catchUpFromSeq(v.messages)).toBe(200);
    const r = await runCatchUp(v, all);
    expect(r.reads).toEqual(["/api/persona/messages?threadId=t-console&limit=100&afterSeq=200"]);
    expect(r.view.messages.map((m) => m.seq)).toEqual(range(51, 210).map((m) => m.seq));
    expect(r.missed).toBe(1);
  });
});

/** An in-memory stand-in for localStorage. */
function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
  };
}

const CACHE_KEY = "standup:personaSnapshot:v1";

const state = (over: Partial<PersonaState> = {}): PersonaState => ({
  owner: "owner",
  runState: "idle",
  threadId: T,
  epoch: 1,
  pendingInbox: 0,
  activeLaunches: 0,
  maxActiveLaunches: 6,
  ...over,
});
const card = (id: string, over: Partial<PersonaApproval> = {}): PersonaApproval => ({
  id,
  owner: "owner",
  action: "answer_ask",
  summary: `Card ${id}`,
  args: {},
  status: "pending",
  createdAt: "2026-10-04T16:00:00.000Z",
  ...over,
});
const job = (id: string, over: Partial<PersonaJob> = {}): PersonaJob => ({
  id,
  owner: "owner",
  threadId: T,
  title: `Job ${id}`,
  goal: "do it",
  status: "active",
  launchIds: [],
  sessionIds: [],
  createdAt: "2026-10-04T16:00:00.000Z",
  updatedAt: "2026-10-04T16:00:00.000Z",
  ...over,
});
const confirmed = (over: Partial<PersonaViewState> = {}) =>
  view(range(1, 3), { state: state(), approvals: [card("P1"), card("A1", { status: "approved" })], ...over });

/** The view the next open paints with, after `saved` was kept. */
function reopened(saved: PersonaViewState): PersonaViewState {
  const storage = memoryStorage();
  savePersonaCache(storage, saved);
  return personaViewFromCache(storage, {});
}

const snapshotOf = (over: Partial<PersonaSnapshot> = {}): PersonaSnapshot => ({
  state: state(),
  messages: { threadId: T, messages: range(1, 3) },
  pendingApprovals: [],
  ...over,
});

describe("the kept Persona view", () => {
  test("a confirmed console-thread view round-trips: its newest page, pending cards and state", () => {
    const storage = memoryStorage();
    savePersonaCache(storage, confirmed({ messages: range(1, 70) }));
    const next = personaViewFromCache(storage, { [T]: 5 });
    expect(next.loaded).toBe(true);
    expect(next.threadId).toBe(T);
    expect(next.consoleThreadId).toBe(T);
    expect(next.state?.owner).toBe("owner");
    expect(next.messages.map((m) => m.seq)).toEqual(range(70 - PERSONA_PAGE + 1, 70).map((m) => m.seq));
    expect(next.approvals.map((a) => a.id)).toEqual(["P1"]);
    expect(next.lastViewed).toEqual({ [T]: 5 });
    expect([...next.cached!.messageIds]).toEqual(ids(next));
    expect([...next.cached!.approvalIds]).toEqual(["P1"]);
    // The kept view hasn't seen the jobs list.
    expect(next.jobsLoaded).toBeUndefined();
  });

  test("only a confirmed view of the console thread is kept", () => {
    for (const over of [
      { loaded: false },
      { state: null },
      { threadId: null },
      { threadId: "t-dm", consoleThreadId: T },
      { cached: { messageIds: new Set<string>(), approvalIds: new Set<string>() } },
    ] as Partial<PersonaViewState>[]) {
      const storage = memoryStorage();
      savePersonaCache(storage, confirmed(over));
      expect(storage.items.has(CACHE_KEY)).toBe(false);
    }
  });

  test("a view still showing what was kept doesn't overwrite it", () => {
    const storage = memoryStorage();
    savePersonaCache(storage, confirmed());
    const before = storage.items.get(CACHE_KEY);
    savePersonaCache(storage, personaViewFromCache(storage, {}));
    expect(storage.items.get(CACHE_KEY)).toBe(before);
  });

  test("a refused, disabled or signed-out view removes what was kept", () => {
    for (const over of [{ forbidden: "no" }, { disabledReason: "off" }, { signInNeeded: true }] as Partial<PersonaViewState>[]) {
      const storage = memoryStorage();
      savePersonaCache(storage, confirmed());
      expect(storage.items.has(CACHE_KEY)).toBe(true);
      savePersonaCache(storage, confirmed(over));
      expect(storage.items.has(CACHE_KEY)).toBe(false);
      expect(personaViewFromCache(storage, {}).loaded).toBe(false);
    }
    // A viewer the state says can't write is signed out too.
    const storage = memoryStorage();
    savePersonaCache(storage, confirmed());
    savePersonaCache(storage, confirmed({ state: { ...state(), canWrite: false } as PersonaState }));
    expect(storage.items.has(CACHE_KEY)).toBe(false);
  });

  test("storage that throws is tolerated both ways", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => savePersonaCache(throwing, confirmed())).not.toThrow();
    expect(() => savePersonaCache(throwing, confirmed({ forbidden: "no" }))).not.toThrow();
    expect(personaViewFromCache(throwing, {}).loaded).toBe(false);
    expect(personaViewFromCache(undefined, {}).loaded).toBe(false);
    expect(() => savePersonaCache(undefined, confirmed())).not.toThrow();
  });

  test("garbage in the kept slot opens the empty view", () => {
    for (const raw of [
      "not json{",
      "null",
      "42",
      '"a string"',
      "[]",
      JSON.stringify({ threadId: T }),
      JSON.stringify({ threadId: 7, state: state(), messages: [], approvals: [] }),
      JSON.stringify({ threadId: T, state: "x", messages: [], approvals: [] }),
      JSON.stringify({ threadId: T, state: state(), messages: "x", approvals: [] }),
      JSON.stringify({ threadId: T, state: state(), messages: [], approvals: null }),
    ]) {
      const next = personaViewFromCache(memoryStorage({ [CACHE_KEY]: raw }), { a: 1 });
      expect(next.loaded).toBe(false);
      expect(next.cached).toBeUndefined();
      expect(next.messages).toEqual([]);
      expect(next.lastViewed).toEqual({ a: 1 });
    }
  });

  test("kept rows of another thread, or without a seq, are left out and the rest sorted", () => {
    const raw = JSON.stringify({
      threadId: T,
      consoleThreadId: T,
      state: state(),
      messages: [msg(3), null, msg(1, { threadId: "t-dm" }), { ...msg(2), seq: "2" }, msg(2)],
      approvals: [],
    });
    const next = personaViewFromCache(memoryStorage({ [CACHE_KEY]: raw }), {});
    expect(ids(next)).toEqual(["m2", "m3"]);
    expect([...next.cached!.messageIds].sort()).toEqual(["m2", "m3"]);
  });
});

describe("the first snapshot after painting from the kept view", () => {
  test("replaces the kept rows with the server's page: a row the server dropped goes, an edited one takes the server's text", () => {
    const kept = reopened(confirmed({ messages: [msg(1), msg(2, { text: "before the edit" }), msg(3)] }));
    const next = personaReducer(kept, {
      type: "snapshot",
      frameMark: kept.frames,
      snapshot: snapshotOf({ messages: { threadId: T, messages: [msg(1), msg(2, { text: "after the edit" }), msg(4)] } }),
    });
    expect(next.cached).toBeUndefined();
    expect(ids(next)).toEqual(["m1", "m2", "m4"]);
    expect(next.messages[1]!.text).toBe("after the edit");
  });

  test("a kept card the server no longer lists as pending goes; the server's state replaces the kept one", () => {
    const kept = reopened(confirmed({ approvals: [card("P1"), card("P2")], state: state({ runState: "paused" }) }));
    const next = personaReducer(kept, {
      type: "snapshot",
      frameMark: kept.frames,
      snapshot: snapshotOf({ pendingApprovals: [card("P2")], state: state({ runState: "idle" }) }),
    });
    expect(next.approvals.map((a) => a.id)).toEqual(["P2"]);
    expect(next.state?.runState).toBe("idle");
  });

  test("a row a live frame delivered while the kept view showed stays", () => {
    let v = reopened(confirmed());
    v = personaReducer(v, { type: "frame", message: frame(msg(4, { text: "live" })) });
    const next = personaReducer(v, { type: "snapshot", frameMark: 0, snapshot: snapshotOf() });
    expect(ids(next)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(next.messages[3]!.text).toBe("live");
  });

  test("a snapshot for another thread clears every kept row of the kept thread", () => {
    const kept = reopened(confirmed());
    const next = personaReducer(kept, {
      type: "snapshot",
      frameMark: kept.frames,
      snapshot: snapshotOf({ state: state({ threadId: "t-new" }), messages: { threadId: "t-new", messages: [msg(1, { id: "n1", threadId: "t-new" })] } }),
    });
    expect(next.threadId).toBe("t-new");
    expect(ids(next)).toEqual(["n1"]);
  });

  test("a refusal or a disabled Persona drops the kept view too", () => {
    for (const over of [{ forbidden: "no", messages: undefined }, { disabledReason: "off", messages: undefined }]) {
      const kept = reopened(confirmed());
      const next = personaReducer(kept, { type: "snapshot", frameMark: kept.frames, snapshot: snapshotOf(over) });
      expect(next.cached).toBeUndefined();
      expect(next.messages).toEqual([]);
      expect(next.approvals).toEqual([]);
    }
  });

  test("a failed read keeps the kept view on screen, still marked kept, under the error", () => {
    const kept = reopened(confirmed());
    const next = personaReducer(kept, {
      type: "snapshot",
      frameMark: kept.frames,
      snapshot: { loadError: "network down", state: state() },
    });
    expect(next.loadError).toBe("network down");
    expect(ids(next)).toEqual(["m1", "m2", "m3"]);
    expect(next.approvals.map((a) => a.id)).toEqual(["P1"]);
    expect(next.cached).toBeDefined();
    // The next one that answers still replaces it.
    const after = personaReducer(next, {
      type: "snapshot",
      frameMark: next.frames,
      snapshot: snapshotOf({ messages: { threadId: T, messages: [msg(2)] } }),
    });
    expect(after.cached).toBeUndefined();
    expect(ids(after)).toEqual(["m2"]);
  });
});

describe("live updates on a view painted from the kept one", () => {
  const msgFrame = (m: PersonaMessage) => ({ type: "frame" as const, message: frame(m) });
  const jobFrame = (j: PersonaJob) => ({ type: "frame" as const, message: { type: "persona:job", payload: j, timestamp: "t" } as WsMessage });
  const cardFrame = (a: PersonaApproval) => ({
    type: "frame" as const,
    message: { type: "persona:approval", payload: a, timestamp: "t" } as WsMessage,
  });

  test("before the first snapshot, message, job and approval frames apply at once", () => {
    let v = reopened(confirmed());
    v = personaReducer(v, msgFrame(msg(4, { text: "new reply" })));
    expect(ids(v)).toEqual(["m1", "m2", "m3", "m4"]);
    v = personaReducer(v, msgFrame(msg(2, { text: "retagged", jobIds: ["J1"] })));
    expect(v.messages[1]!.jobIds).toEqual(["J1"]);
    v = personaReducer(v, jobFrame(job("J1")));
    expect(v.jobs.map((j) => j.id)).toEqual(["J1"]);
    v = personaReducer(v, cardFrame(card("P9")));
    expect(v.approvals.map((a) => a.id)).toEqual(["P1", "P9"]);
    v = personaReducer(v, cardFrame(card("P1", { status: "approved" })));
    expect(v.approvals.find((a) => a.id === "P1")!.status).toBe("approved");
    expect(v.frames).toBe(5);
  });

  test("after the first snapshot, the same frames still apply at once", () => {
    let v = reopened(confirmed());
    v = personaReducer(v, { type: "snapshot", frameMark: v.frames, snapshot: snapshotOf({ pendingApprovals: [card("P1")] }) });
    expect(v.cached).toBeUndefined();
    v = personaReducer(v, msgFrame(msg(4, { text: "new reply" })));
    v = personaReducer(v, jobFrame(job("J1", { status: "done" })));
    v = personaReducer(v, cardFrame(card("P1", { status: "denied" })));
    expect(ids(v)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(v.jobs[0]!.status).toBe("done");
    expect(v.approvals.find((a) => a.id === "P1")!.status).toBe("denied");
  });

  test("a card decided by a frame before a stale first snapshot stays decided", () => {
    let v = reopened(confirmed({ approvals: [card("P1")] }));
    const mark = v.frames;
    v = personaReducer(v, cardFrame(card("P1", { status: "approved" })));
    v = personaReducer(v, { type: "snapshot", frameMark: mark, snapshot: snapshotOf({ pendingApprovals: [card("P1")] }) });
    expect(v.cached).toBeUndefined();
    expect(v.approvals.find((a) => a.id === "P1")!.status).toBe("approved");
  });

  test("a card the owner decided before a stale first snapshot stays decided", () => {
    let v = reopened(confirmed({ approvals: [card("P1")] }));
    const mark = v.frames;
    v = personaReducer(v, { type: "approval", approval: card("P1", { status: "denied" }) });
    v = personaReducer(v, { type: "snapshot", frameMark: mark, snapshot: snapshotOf({ pendingApprovals: [card("P1")] }) });
    expect(v.approvals.find((a) => a.id === "P1")!.status).toBe("denied");
  });

  test("a state frame before a stale first snapshot isn't undone by the snapshot's older state", () => {
    let v = reopened(confirmed({ state: state({ runState: "idle" }) }));
    const mark = v.frames;
    v = personaReducer(v, {
      type: "frame",
      message: { type: "persona:state", payload: state({ runState: "thinking" }), timestamp: "t" } as WsMessage,
    });
    v = personaReducer(v, { type: "snapshot", frameMark: mark, snapshot: snapshotOf({ state: state({ runState: "idle" }) }) });
    expect(v.state?.runState).toBe("thinking");
  });

  test("a job frame before the first snapshot survives the full snapshot's older copy", () => {
    let v = reopened(confirmed());
    v = personaReducer(v, jobFrame(job("J1", { status: "done", updatedAt: "2026-10-04T17:00:00.000Z" })));
    v = personaReducer(v, { type: "snapshot", frameMark: 0, snapshot: snapshotOf({ jobs: [job("J1")] }) });
    expect(v.jobsLoaded).toBe(true);
    expect(v.jobs.find((j) => j.id === "J1")!.status).toBe("done");
  });

  test("the catch-up on a kept view reads after its newest kept seq, a window of the kept page", async () => {
    const all = range(1, 80);
    const kept = reopened(confirmed({ messages: all.slice(0, 70) }));
    expect(kept.messages).toHaveLength(PERSONA_PAGE);
    const r = await runCatchUp(kept, all);
    expect(r.reads).toEqual(["/api/persona/messages?threadId=t-console&limit=100&afterSeq=70"]);
    expect(r.view.messages.map((m) => m.seq)).toEqual(range(21, 80).map((m) => m.seq));
  });

  test("the catch-up on a kept view with older pages prepended reads from the newest seq, not a hole", async () => {
    const all = range(1, 120);
    let v = reopened(confirmed({ messages: all.slice(0, 100) }));
    v = personaReducer(v, { type: "older", threadId: T, messages: all.slice(0, 50), limit: PERSONA_PAGE });
    expect(v.messages.map((m) => m.seq)).toEqual(range(1, 100).map((m) => m.seq));
    const r = await runCatchUp(v, all);
    expect(r.reads).toEqual(["/api/persona/messages?threadId=t-console&limit=100&afterSeq=100"]);
    expect(r.view.messages).toHaveLength(120);
  });
});

describe("a first snapshot that answers only part of the kept view", () => {
  test("a failed state read keeps the kept state; a failed pending-cards read keeps the kept cards", () => {
    const kept = reopened(confirmed({ state: state({ runState: "paused" }), approvals: [card("P1")] }));
    const next = personaReducer(kept, {
      type: "snapshot",
      frameMark: kept.frames,
      snapshot: { loadError: "state read failed", messages: { threadId: T, messages: range(1, 3) } },
    });
    expect(next.cached).toBeUndefined();
    expect(next.state?.runState).toBe("paused");
    expect(next.approvals.map((a) => a.id)).toEqual(["P1"]);
  });

  test("the same read with state and cards answered replaces both", () => {
    const kept = reopened(confirmed({ state: state({ runState: "paused" }), approvals: [card("P1")] }));
    const next = personaReducer(kept, {
      type: "snapshot",
      frameMark: kept.frames,
      snapshot: snapshotOf({ state: state({ runState: "idle" }), pendingApprovals: [] }),
    });
    expect(next.state?.runState).toBe("idle");
    expect(next.approvals).toEqual([]);
  });
});

describe("the server's page replacing a kept view", () => {
  test("a re-published row below the page's first seq is dropped, so it doesn't stand above a hole", () => {
    let v = reopened(confirmed({ messages: range(1, 3) }));
    // A live re-publish of m1 makes it no longer a kept-only row.
    v = personaReducer(v, { type: "frame", message: frame(msg(1, { jobIds: ["J1"] })) });
    expect(v.cached!.messageIds.has("m1")).toBe(false);
    const next = personaReducer(v, {
      type: "snapshot",
      frameMark: v.frames,
      snapshot: snapshotOf({ messages: { threadId: T, messages: range(10, 12) } }),
    });
    expect(next.cached).toBeUndefined();
    expect(ids(next)).toEqual(["m10", "m11", "m12"]);
  });

  test("a view not painted from the kept one keeps rows below the page", () => {
    const v = view(range(1, 3), { state: state() });
    const next = personaReducer(v, {
      type: "snapshot",
      frameMark: v.frames,
      snapshot: snapshotOf({ messages: { threadId: T, messages: range(3, 5) } }),
    });
    expect(ids(next)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
  });
});

describe("a state frame the kept view refuses", () => {
  test("another owner's state frame leaves the kept state unmarked live, so a later snapshot replaces it", () => {
    let v = reopened(confirmed({ state: state({ runState: "paused" }) }));
    const mark = v.frames;
    v = personaReducer(v, {
      type: "frame",
      message: { type: "persona:state", payload: state({ owner: "alice", runState: "thinking" }), timestamp: "t" } as WsMessage,
    });
    expect(v.state?.runState).toBe("paused");
    expect(v.cached?.stateLive).toBeUndefined();
    // Not fresh: only a state the kept view gave up is replaced.
    v = personaReducer(v, { type: "snapshot", frameMark: mark, snapshot: snapshotOf({ state: state({ runState: "idle" }) }) });
    expect(v.state?.runState).toBe("idle");
  });

  test("this owner's state frame marks the kept state live", () => {
    let v = reopened(confirmed({ state: state({ runState: "paused" }) }));
    v = personaReducer(v, {
      type: "frame",
      message: { type: "persona:state", payload: state({ runState: "thinking" }), timestamp: "t" } as WsMessage,
    });
    expect(v.cached?.stateLive).toBe(true);
  });
});

describe("keeping the view when storage is full", () => {
  test("a save that throws removes the older kept view instead of leaving it", () => {
    const storage = memoryStorage();
    savePersonaCache(storage, confirmed());
    expect(storage.items.has(CACHE_KEY)).toBe(true);
    const full = {
      ...storage,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(() => savePersonaCache(full, confirmed({ messages: range(1, 70) }))).not.toThrow();
    expect(storage.items.has(CACHE_KEY)).toBe(false);
    expect(personaViewFromCache(storage, {}).loaded).toBe(false);
  });
});

describe("paging a kept view", () => {
  test("hasOlderMessages is false while the view is kept, and true once the server's page replaces it", () => {
    const kept = reopened(confirmed({ messages: range(1, 70) }));
    expect(kept.messages[0]!.seq).toBeGreaterThan(1);
    expect(hasOlderMessages(kept)).toBe(false);
    const next = personaReducer(kept, {
      type: "snapshot",
      frameMark: kept.frames,
      snapshot: snapshotOf({ messages: { threadId: T, messages: range(21, 70) } }),
    });
    expect(next.cached).toBeUndefined();
    expect(hasOlderMessages(next)).toBe(true);
  });
});

describe("a first-paint snapshot superseded by a newer resync", () => {
  test("applied with frameMark -1 it only adds: no newer pending card is pruned, no newer state replaced", () => {
    for (const start of [view([], { threadId: null, consoleThreadId: null }), reopened(confirmed())]) {
      // B: the newer resync, applied fresh.
      let v = personaReducer(start, {
        type: "snapshot",
        frameMark: start.frames,
        snapshot: snapshotOf({
          state: state({ runState: "thinking" }),
          messages: { threadId: T, messages: range(1, 5) },
          pendingApprovals: [card("P2")],
        }),
      });
      expect(v.approvals.map((a) => a.id)).toEqual(["P2"]);
      // A: the first-paint read started earlier, answering after B.
      v = personaReducer(v, {
        type: "snapshot",
        frameMark: -1,
        superseded: true,
        snapshot: snapshotOf({
          state: state({ runState: "idle" }),
          messages: { threadId: T, messages: range(1, 3) },
          pendingApprovals: [card("P1")],
        }),
      });
      expect(v.state?.runState).toBe("thinking");
      expect(v.approvals.map((a) => a.id).sort()).toEqual(["P1", "P2"]);
      expect(ids(v)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    }
  });

  test("a newer read's refusal or load error stands; the older read doesn't clear it", () => {
    const start = view([], { threadId: null, consoleThreadId: null });
    const older = snapshotOf({
      state: state({ runState: "idle" }),
      messages: { threadId: T, messages: range(1, 3) },
      pendingApprovals: [card("P1")],
    });
    const refused = personaReducer(start, {
      type: "snapshot",
      frameMark: start.frames,
      snapshot: { forbidden: "sign-in" },
    });
    expect(refused.forbidden).toBe("sign-in");
    const after = personaReducer(refused, { type: "snapshot", frameMark: -1, superseded: true, snapshot: older });
    expect(after).toBe(refused);

    const failed = personaReducer(start, { type: "snapshot", frameMark: start.frames, snapshot: { loadError: "network down" } });
    const merged = personaReducer(failed, { type: "snapshot", frameMark: -1, superseded: true, snapshot: older });
    expect(merged.loadError).toBe("network down");
    expect(ids(merged)).toEqual(["m1", "m2", "m3"]);
  });
});
