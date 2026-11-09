import { expect, test, describe } from "bun:test";
import type {
  PersonaApproval,
  PersonaJob,
  PersonaJobState,
  PersonaMessage,
  PersonaState,
  PersonaThreadSummary,
  WsMessage,
} from "@standup/shared";
import {
  activityLabel,
  approvalDecider,
  approvalFromLabel,
  approvalWaitingLabel,
  approvalsNeedingViewer,
  consoleThreadOf,
  isApprovalDecider,
  unavailableMessage,
  viewerIsHost,
  signInNeededAs,
  pendingStripTitle,
  accessUpdate,
  isUserDisabled,
  otherUsers,
  userStatusLabel,
  type PersonaUserEntry,
  audienceBadge,
  callerFields,
  composerAudienceWarning,
  fetchPersonaSnapshot,
  formatGbNumber,
  hostCapacity,
  initialPersonaViewState,
  isHostViewer,
  isPersonaDisabled,
  isPersonaOwner,
  isUserPaused,
  needsSignIn,
  parseProjectList,
  refusalReason,
  userLoginCommand,
  withUser,
  isThreadUnread,
  jobNote,
  loadLastViewed,
  maxSeq,
  messagesPath,
  olderMessagesPath,
  PERSONA_PAGE,
  mergeJobs,
  mergeMessages,
  filteredThread,
  tagFilterKey,
  withJobTag,
  messageHasAnyJob,
  messageJobIds,
  messageJobPath,
  messageJobTags,
  parseTagFilter,
  taggedMessagesPath,
  threadJobCounts,
  withoutJobTag,
  mergeApprovalSnapshot,
  mergeApprovals,
  newIdempotencyKey,
  openOptionsMessageIds,
  orderThreads,
  pendingApprovals,
  personaCall,
  personaLanding,
  personaReducer,
  reconcileOutbox,
  runStateChip,
  saveLastViewed,
  jobLastActivity,
  jobState,
  jobSummaryLine,
  sortJobs,
  threadHeaderLabel,
  threadLabel,
  threadPreview,
  upsertApproval,
  upsertJob,
  type PersonaOutboxItem,
  type PersonaViewState,
} from "./persona";

/**
 * The Persona view's client model. The web package has no component-test
 * harness, so the merge rules are pinned here: thread ordering and dedup,
 * optimistic sends reconciling with their echo exactly once, jobs and
 * approvals never rolling back, and REST snapshots that race live frames.
 */

const THREAD = "t1";

function msg(seq: number, over: Partial<PersonaMessage> = {}): PersonaMessage {
  return {
    id: `m${seq}`,
    threadId: THREAD,
    seq,
    role: "persona",
    text: `message ${seq}`,
    createdAt: `2026-10-04T16:${String(seq).padStart(2, "0")}:00.000Z`,
    ...over,
  };
}

function outboxItem(key: string, text: string, afterSeq: number): PersonaOutboxItem {
  return {
    idempotencyKey: key,
    text,
    createdAt: "2026-10-04T16:00:00.000Z",
    afterSeq,
    status: "sending",
  };
}

function job(id: string, over: Partial<PersonaJob> = {}): PersonaJob {
  return {
    id,
    owner: "sam",
    threadId: THREAD,
    title: `Job ${id}`,
    goal: "do it",
    status: "active",
    launchIds: [],
    sessionIds: [],
    createdAt: "2026-10-04T16:00:00.000Z",
    updatedAt: "2026-10-04T16:00:00.000Z",
    ...over,
  };
}

function approval(id: string, over: Partial<PersonaApproval> = {}): PersonaApproval {
  return {
    id,
    owner: "sam",
    action: "answer_ask",
    summary: "Answer the worker's question with Yes",
    args: {},
    status: "pending",
    createdAt: "2026-10-04T16:00:00.000Z",
    ...over,
  };
}

function personaState(over: Partial<PersonaState> = {}): PersonaState {
  return {
    owner: "sam",
    runState: "idle",
    threadId: THREAD,
    epoch: 1,
    pendingInbox: 0,
    activeLaunches: 2,
    maxActiveLaunches: 6,
    ...over,
  };
}

function frame(type: WsMessage["type"], payload: unknown): WsMessage {
  return { type, payload, timestamp: "2026-10-04T16:00:00.000Z" };
}

function loaded(over: Partial<PersonaViewState> = {}): PersonaViewState {
  return {
    ...initialPersonaViewState,
    loaded: true,
    threadId: THREAD,
    state: personaState(),
    ...over,
  };
}

describe("mergeMessages — the thread is ascending by seq, unique by id", () => {
  test("out-of-order arrivals sort by seq", () => {
    const merged = mergeMessages([msg(1), msg(3)], [msg(2)]);
    expect(merged.map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  test("a redelivered frame does not duplicate and returns the same array", () => {
    const existing = [msg(1), msg(2)];
    expect(mergeMessages(existing, [msg(2)])).toBe(existing);
  });

  test("an incoming copy of a known id replaces it", () => {
    const merged = mergeMessages([msg(1)], [msg(1, { text: "edited" })]);
    expect(merged).toHaveLength(1);
    expect(merged[0].text).toBe("edited");
  });

  test("a different id claiming a held seq wins (seq is unique per thread)", () => {
    const merged = mergeMessages([msg(1), msg(2)], [msg(2, { id: "other" })]);
    expect(merged.map((m) => m.id)).toEqual(["m1", "other"]);
  });

  test("empty incoming is a no-op", () => {
    const existing = [msg(1)];
    expect(mergeMessages(existing, [])).toBe(existing);
  });

  test("maxSeq reads the tail, 0 when empty", () => {
    expect(maxSeq([])).toBe(0);
    expect(maxSeq([msg(1), msg(7)])).toBe(7);
  });

  test("a copy whose tag only changed source replaces the held row", () => {
    const held = msg(1, { jobIds: ["j1"], jobTags: [{ jobId: "j1", source: "inferred" }] });
    const upgraded = msg(1, { jobIds: ["j1"], jobTags: [{ jobId: "j1", source: "explicit" }] });
    const merged = mergeMessages([held], [upgraded]);
    expect(merged[0]).toBe(upgraded);
    expect(mergeMessages(merged, [{ ...upgraded, jobTags: [{ jobId: "j1", source: "explicit" }] }])).toBe(merged);
  });

  test("tags added after the fact replace the held row", () => {
    const held = [msg(1, { role: "user" })];
    const tagged = msg(1, { role: "user", jobIds: ["j1", "j2"], jobTags: [{ jobId: "j1", source: "explicit" }, { jobId: "j2", source: "inferred" }] });
    expect(mergeMessages(held, [tagged])[0]).toBe(tagged);
  });
});

describe("message job tags", () => {
  const tagged = msg(1, {
    jobIds: ["j1", "j2"],
    jobTags: [
      { jobId: "j1", source: "explicit" },
      { jobId: "j2", source: "inferred" },
    ],
  });

  test("tags read from jobTags, else from bare jobIds as explicit", () => {
    expect(messageJobIds(tagged)).toEqual(["j1", "j2"]);
    expect(messageJobTags(msg(2, { jobIds: ["j3"] }))).toEqual([{ jobId: "j3", source: "explicit" }]);
    expect(messageJobTags(msg(3))).toEqual([]);
  });

  test("withoutJobTag drops one job from both lists", () => {
    const next = withoutJobTag(tagged, "j2");
    expect(next.jobIds).toEqual(["j1"]);
    expect(next.jobTags).toEqual([{ jobId: "j1", source: "explicit" }]);
    expect(tagged.jobIds).toEqual(["j1", "j2"]);
  });

  test("threadJobCounts counts messages per job, most-tagged first", () => {
    const counts = threadJobCounts([tagged, msg(2, { jobIds: ["j2"] }), msg(3)]);
    expect(counts).toEqual([
      { jobId: "j2", count: 2 },
      { jobId: "j1", count: 1 },
    ]);
    expect(messageHasAnyJob(tagged, new Set(["j9", "j2"]))).toBe(true);
    expect(messageHasAnyJob(msg(3), new Set(["j1"]))).toBe(false);
  });

  test("the tag filter query and the routes it drives", () => {
    expect(parseTagFilter(" j1, j2,,j1 ")).toEqual(["j1", "j2"]);
    expect(parseTagFilter(null)).toEqual([]);
    expect(taggedMessagesPath("t 1", ["j1", "j2"])).toBe("/messages?threadId=t+1&jobId=j1%2Cj2");
    expect(taggedMessagesPath(null, ["j1"])).toBe("/messages?jobId=j1");
    expect(messageJobPath("m/1", "j1")).toBe("/messages/m%2F1/jobs/j1");
  });

  test("messageUpdated replaces a held row without touching the outbox", () => {
    const view: PersonaViewState = {
      ...initialPersonaViewState,
      loaded: true,
      threadId: THREAD,
      messages: [tagged],
      outbox: [outboxItem("k1", tagged.text, 0)],
    };
    const next = personaReducer(view, { type: "messageUpdated", message: withoutJobTag(tagged, "j2") });
    expect(next.messages[0].jobIds).toEqual(["j1"]);
    expect(next.outbox).toBe(view.outbox);
  });

  test("messageUpdated for a row no longer held is dropped", () => {
    const view = loaded({ messages: [msg(50)] });
    expect(personaReducer(view, { type: "messageUpdated", message: tagged })).toBe(view);
  });

  test("withJobTag puts one tag back, and leaves a message already carrying the job", () => {
    const restored = withJobTag(withoutJobTag(tagged, "j2"), { jobId: "j2", source: "inferred" });
    expect(restored.jobIds).toEqual(["j1", "j2"]);
    expect(restored.jobTags).toEqual(tagged.jobTags);
    const upgraded = msg(1, { jobIds: ["j2"], jobTags: [{ jobId: "j2", source: "explicit" }] });
    expect(withJobTag(upgraded, { jobId: "j2", source: "inferred" })).toBe(upgraded);
    expect(tagFilterKey(["j2", "j1"])).toBe(tagFilterKey(["j1", "j2"]));
  });
});

describe("tag removal — optimistic, and a failure restores only its own tag", () => {
  const X = { jobId: "jx", source: "inferred" as const };
  const Y = { jobId: "jy", source: "inferred" as const };
  const J = { jobId: "j1", source: "explicit" as const };
  const row = msg(5, { jobIds: ["j1", "jx", "jy"], jobTags: [J, X, Y] });

  test("remove X then Y; Y succeeds, X fails: X comes back, Y stays gone", () => {
    let view = loaded({ messages: [row] });
    view = personaReducer(view, { type: "tagRemove", messageId: "m5", jobId: "jx" });
    view = personaReducer(view, { type: "tagRemove", messageId: "m5", jobId: "jy" });
    expect(messageJobIds(view.messages[0])).toEqual(["j1"]);
    // The server dropped Y; X's request hadn't landed, so its copy still has X.
    view = personaReducer(view, { type: "messageUpdated", message: msg(5, { jobIds: ["j1", "jx"], jobTags: [J, X] }) });
    view = personaReducer(view, { type: "tagRestore", messageId: "m5", tag: X });
    expect(messageJobIds(view.messages[0])).toEqual(["j1", "jx"]);
  });

  test("remove X then Y; X fails first: only X returns", () => {
    let view = loaded({ messages: [row] });
    view = personaReducer(view, { type: "tagRemove", messageId: "m5", jobId: "jx" });
    view = personaReducer(view, { type: "tagRemove", messageId: "m5", jobId: "jy" });
    view = personaReducer(view, { type: "tagRestore", messageId: "m5", tag: X });
    expect(messageJobIds(view.messages[0])).toEqual(["j1", "jx"]);
    expect(view.messages[0].text).toBe(row.text);
  });

  test("a restore keeps changes a frame made meanwhile", () => {
    let view = loaded({ messages: [row] });
    view = personaReducer(view, { type: "tagRemove", messageId: "m5", jobId: "jx" });
    // A frame upgrades X to explicit and edits the text while the DELETE is out.
    const upgraded = msg(5, { text: "edited", jobIds: ["j1", "jx", "jy"], jobTags: [J, { jobId: "jx", source: "explicit" }, Y] });
    view = personaReducer(view, { type: "frame", message: frame("persona:message", upgraded) });
    const held = view.messages[0];
    view = personaReducer(view, { type: "tagRestore", messageId: "m5", tag: X });
    expect(view.messages[0]).toBe(held);
    expect(view.messages[0].jobTags?.[1].source).toBe("explicit");
  });
});

describe("filter backfill — older matches are held apart from the thread", () => {
  const J = { jobId: "j1", source: "explicit" as const };
  const old = msg(2, { jobIds: ["j1"], jobTags: [J], text: "old match" });
  const windowRows = [msg(40), msg(41, { jobIds: ["j1"], jobTags: [J] })];
  const filled = () =>
    personaReducer(loaded({ messages: windowRows }), {
      type: "backfill",
      threadId: THREAD,
      key: "j1",
      messages: [old, windowRows[1]],
    });

  test("backfilled rows never join the thread; clearing leaves the window exactly", () => {
    const view = filled();
    expect(view.messages).toBe(windowRows);
    // The window's own match stays the window's: the backfill holds only older rows.
    expect(view.backfill?.messages.map((m) => m.id)).toEqual(["m2"]);
    const cleared = personaReducer(view, { type: "backfillClear" });
    expect(cleared.backfill).toBeUndefined();
    expect(cleared.messages).toBe(windowRows);
  });

  test("a response for a thread no longer selected is ignored, and switching threads drops it", () => {
    const view = loaded({ messages: windowRows });
    expect(personaReducer(view, { type: "backfill", threadId: "t2", key: "j1", messages: [old] })).toBe(view);
    expect(personaReducer(filled(), { type: "select", threadId: "t2" }).backfill).toBeUndefined();
  });

  test("frames and tag edits patch a backfilled row without pulling it into the thread", () => {
    let view = filled();
    const edited = { ...old, text: "old match, edited" };
    view = personaReducer(view, { type: "frame", message: frame("persona:message", edited) });
    expect(view.backfill?.messages[0].text).toBe("old match, edited");
    expect(view.messages).toBe(windowRows);

    view = personaReducer(view, { type: "tagRemove", messageId: "m2", jobId: "j1" });
    expect(messageJobIds(view.backfill!.messages[0])).toEqual([]);
    view = personaReducer(view, { type: "messageUpdated", message: { ...edited, jobIds: [], jobTags: [] } });
    expect(view.messages).toBe(windowRows);
    expect(filteredThread(view.messages, view.backfill!.messages, new Set(["j1"]), Infinity).rows.map((m) => m.id)).toEqual(["m41"]);
  });

  test("a frame for a row the window holds updates the window", () => {
    const view = personaReducer(filled(), { type: "frame", message: frame("persona:message", { ...windowRows[1], text: "both" }) });
    expect(view.messages[1].text).toBe("both");
    expect(view.backfill?.messages.map((m) => m.id)).toEqual(["m2"]);
  });

  test("switching threads: a backfill landing before the thread's page leaves the page whole", () => {
    const b = (seq: number, over: Partial<PersonaMessage> = {}) => msg(seq, { id: `b${seq}`, threadId: "B", ...over });
    let view = loaded({ messages: windowRows });
    view = personaReducer(view, { type: "select", threadId: "B" });
    view = personaReducer(view, { type: "backfill", threadId: "B", key: "j1", messages: [b(2, { jobIds: ["j1"], jobTags: [J] })] });
    view = personaReducer(view, {
      type: "threadMessages",
      response: { threadId: "B", messages: [b(1), b(2, { jobIds: ["j1"], jobTags: [J] }), b(3)] },
    });
    expect(view.messages.map((m) => m.id)).toEqual(["b1", "b2", "b3"]);
    expect(view.backfill?.messages).toEqual([]);
    view = personaReducer(view, { type: "backfillClear" });
    expect(view.messages.map((m) => m.id)).toEqual(["b1", "b2", "b3"]);
  });

  test("a live frame for a backfilled row newer than the window joins the thread", () => {
    const a2 = msg(2, { role: "user", text: "tagged send", jobIds: ["j1"], jobTags: [J] });
    let view = loaded({ messages: [msg(1)], outbox: [outboxItem("k1", "tagged send", 1)] });
    view = personaReducer(view, { type: "backfill", threadId: THREAD, key: "j1", messages: [a2] });
    expect(view.backfill?.messages).toEqual([]);
    view = personaReducer(view, { type: "frame", message: frame("persona:message", a2) });
    expect(view.outbox).toEqual([]);
    // The thread list heard of it too: no summary holds the thread, so it is flagged stale.
    expect(view.threadsStale).toBe(true);
    view = personaReducer(view, { type: "backfillClear" });
    expect(view.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  test("a page reaching back over backfilled rows takes them into the window", () => {
    let view = personaReducer(loaded({ messages: [msg(50)] }), { type: "backfill", threadId: THREAD, key: "j1", messages: [old] });
    expect(view.backfill?.messages.map((m) => m.id)).toEqual(["m2"]);
    view = personaReducer(view, { type: "threadMessages", response: { threadId: THREAD, messages: [msg(1), old, msg(3), msg(50)] } });
    expect(view.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m50"]);
    expect(view.backfill?.messages).toEqual([]);
  });

  test("an update for a row held only in the backfill, before any window loads, stays in the backfill", () => {
    let view = personaReducer(loaded({ messages: [] }), { type: "backfill", threadId: THREAD, key: "j1", messages: [old] });
    view = personaReducer(view, { type: "messageUpdated", message: { ...old, text: "edited" } });
    expect(view.messages).toEqual([]);
    expect(view.backfill?.messages[0].text).toBe("edited");
  });

  test("filteredThread merges the backfill under the window and keeps the owner's newer messages", () => {
    const stale = { ...windowRows[1], text: "stale copy" };
    const sent = msg(42, { role: "user", text: "sent while filtering" });
    const before = msg(39, { role: "user", text: "said before filtering" });
    const { rows, matches } = filteredThread([before, ...windowRows, sent], [old, stale], new Set(["j1"]), 41);
    expect(rows.map((m) => m.text)).toEqual(["old match", windowRows[1].text, "sent while filtering"]);
    expect(matches).toBe(2);
  });
});

describe("reconcileOutbox — an optimistic send clears exactly once", () => {
  test("a user row with the same text after afterSeq confirms the item", () => {
    const out = reconcileOutbox([outboxItem("k1", "hello", 4)], [msg(5, { role: "user", text: "hello" })]);
    expect(out).toEqual([]);
  });

  test("whitespace differences don't block the match", () => {
    const out = reconcileOutbox([outboxItem("k1", "hello ", 0)], [msg(1, { role: "user", text: " hello" })]);
    expect(out).toEqual([]);
  });

  test("an older identical message does not confirm a new send", () => {
    const item = outboxItem("k1", "yes", 4);
    const out = reconcileOutbox([item], [msg(3, { role: "user", text: "yes" })]);
    expect(out).toEqual([item]);
  });

  test("a persona row never confirms a user send", () => {
    const item = outboxItem("k1", "hello", 0);
    expect(reconcileOutbox([item], [msg(1, { text: "hello" })])).toEqual([item]);
  });

  test("a matching idempotency key on the echo wins over text", () => {
    const a = outboxItem("k1", "same", 0);
    const b = outboxItem("k2", "same", 0);
    const echo = { ...msg(1, { role: "user", text: "same" }), idempotencyKey: "k2" };
    expect(reconcileOutbox([a, b], [echo])).toEqual([a]);
  });

  test("an echo keyed for a different send never falls back to text", () => {
    const item = outboxItem("k1", "yes", 0);
    const echo = { ...msg(1, { role: "user", text: "yes" }), idempotencyKey: "other-tab" };
    expect(reconcileOutbox([item], [echo])).toEqual([item]);
  });

  test("an unkeyed echo still confirms by text", () => {
    const item = outboxItem("k1", "yes", 0);
    expect(reconcileOutbox([item], [msg(1, { role: "user", text: "yes" })])).toEqual([]);
  });

  test("the same text sent twice keeps one pending until the second echo", () => {
    const a = outboxItem("k1", "yes", 0);
    const b = outboxItem("k2", "yes", 0);
    const afterFirst = reconcileOutbox([a, b], [msg(1, { role: "user", text: "yes" })]);
    expect(afterFirst).toEqual([b]);
    expect(reconcileOutbox(afterFirst, [msg(2, { role: "user", text: "yes" })])).toEqual([]);
  });

  test("returns the same array when nothing matches", () => {
    const outbox = [outboxItem("k1", "a", 0)];
    expect(reconcileOutbox(outbox, [msg(1, { role: "user", text: "b" })])).toBe(outbox);
  });
});

describe("personaReducer — sending", () => {
  const queued = () =>
    personaReducer(loaded({ messages: [msg(1)] }), {
      type: "queue",
      item: outboxItem("k1", "fix the test", 1),
    });

  test("echo frame first, then the POST response: one row, no outbox", () => {
    const echo = msg(2, { role: "user", text: "fix the test" });
    let s = personaReducer(queued(), { type: "frame", message: frame("persona:message", echo) });
    expect(s.outbox).toEqual([]);
    s = personaReducer(s, { type: "sent", idempotencyKey: "k1", message: echo });
    expect(s.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(s.outbox).toEqual([]);
  });

  test("POST response first, then the echo frame: one row, no outbox", () => {
    const echo = msg(2, { role: "user", text: "fix the test" });
    let s = personaReducer(queued(), { type: "sent", idempotencyKey: "k1", message: echo });
    s = personaReducer(s, { type: "frame", message: frame("persona:message", echo) });
    expect(s.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(s.outbox).toEqual([]);
  });

  test("a POST response for one send never clears a second send of the same text", () => {
    let s = queued();
    s = personaReducer(s, { type: "queue", item: outboxItem("k2", "fix the test", 1) });
    s = personaReducer(s, {
      type: "sent",
      idempotencyKey: "k1",
      message: msg(2, { role: "user", text: "fix the test" }),
    });
    expect(s.outbox.map((o) => o.idempotencyKey)).toEqual(["k2"]);
    // The first message's echo arriving late must not consume k2 either.
    s = personaReducer(s, {
      type: "frame",
      message: frame("persona:message", msg(2, { role: "user", text: "fix the test" })),
    });
    expect(s.outbox.map((o) => o.idempotencyKey)).toEqual(["k2"]);
  });

  test("failure marks the item, resend restores it, discard drops it", () => {
    let s = personaReducer(queued(), { type: "sendFailed", idempotencyKey: "k1", error: "boom" });
    expect(s.outbox[0]).toMatchObject({ status: "failed", error: "boom" });
    s = personaReducer(s, { type: "resend", idempotencyKey: "k1" });
    expect(s.outbox[0]).toMatchObject({ status: "sending", error: undefined });
    s = personaReducer(s, { type: "discard", idempotencyKey: "k1" });
    expect(s.outbox).toEqual([]);
  });

  test("frames for another thread stay out of the selected thread but are held", () => {
    const s0 = loaded();
    const s = personaReducer(s0, {
      type: "frame",
      message: frame("persona:message", msg(1, { threadId: "slack" })),
    });
    expect(s.messages).toEqual([]);
    expect(s.others.slack.messages.map((m) => m.id)).toEqual(["m1"]);
  });
});

describe("personaReducer — frames", () => {
  test("persona:state replaces the state and clears activity when the turn ends", () => {
    let s = personaReducer(loaded({ state: personaState({ runState: "thinking" }) }), {
      type: "frame",
      message: frame("persona:activity", { label: "launch_session", at: "x" }),
    });
    expect(activityLabel(s)).toBe("launch_session");
    s = personaReducer(s, { type: "frame", message: frame("persona:state", personaState()) });
    expect(s.activity).toBeNull();
    expect(activityLabel(s)).toBeUndefined();
  });

  test("persona:job and persona:approval upsert", () => {
    let s = personaReducer(loaded(), { type: "frame", message: frame("persona:job", job("J1")) });
    s = personaReducer(s, { type: "frame", message: frame("persona:approval", approval("A1")) });
    expect(s.jobs.map((j) => j.id)).toEqual(["J1"]);
    expect(pendingApprovals(s.approvals).map((a) => a.id)).toEqual(["A1"]);
  });

  test("every persona frame bumps the frame counter; other frames are ignored", () => {
    const s0 = loaded();
    const s1 = personaReducer(s0, { type: "frame", message: frame("persona:job", job("J1")) });
    expect(s1.frames).toBe(1);
    expect(personaReducer(s1, { type: "frame", message: frame("ask:new", {}) })).toBe(s1);
  });

  test("a frame for another thread before the first snapshot stays out of the view", () => {
    let s = personaReducer(initialPersonaViewState, {
      type: "frame",
      message: frame("persona:message", msg(4, { id: "s4", threadId: "S1", text: "slack reply" })),
    });
    expect(s.messages).toEqual([]);
    expect(s.others.S1.messages.map((m) => m.id)).toEqual(["s4"]);
    s = personaReducer(s, {
      type: "snapshot",
      frameMark: 0,
      snapshot: {
        state: personaState(),
        messages: { threadId: THREAD, messages: [msg(1)] },
        threads: [summary(THREAD, { channel: "console", audience: "private" })],
      },
    });
    expect(s.threadId).toBe(THREAD);
    expect(s.messages.map((m) => m.id)).toEqual(["m1"]);
    expect(s.others.S1.messages.map((m) => m.id)).toEqual(["s4"]);
    // The list predates S1, so it is refetched to learn the thread's name.
    expect(s.threadsStale).toBe(true);
    s = personaReducer(s, { type: "select", threadId: "S1" });
    expect(s.messages.map((m) => m.id)).toEqual(["s4"]);
  });

  test("a frame for the console thread before the first snapshot merges into it", () => {
    let s = personaReducer(initialPersonaViewState, {
      type: "frame",
      message: frame("persona:message", msg(2)),
    });
    expect(s.messages).toEqual([]);
    s = personaReducer(s, {
      type: "snapshot",
      frameMark: 0,
      snapshot: { state: personaState(), messages: { threadId: THREAD, messages: [msg(1)] } },
    });
    expect(s.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(s.others[THREAD]).toBeUndefined();
  });

  test("a held frame is adopted when only the messages route answered", () => {
    let s = personaReducer(initialPersonaViewState, {
      type: "frame",
      message: frame("persona:message", msg(2)),
    });
    s = personaReducer(s, {
      type: "snapshot",
      frameMark: 0,
      snapshot: { messages: { threadId: THREAD, messages: [msg(1)] } },
    });
    expect(s.threadId).toBe(THREAD);
    expect(s.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  test("a state frame adopts held rows for its thread", () => {
    let s = personaReducer(initialPersonaViewState, {
      type: "frame",
      message: frame("persona:message", msg(1)),
    });
    s = personaReducer(s, {
      type: "frame",
      message: frame("persona:message", msg(1, { id: "o1", threadId: "S1" })),
    });
    s = personaReducer(s, { type: "frame", message: frame("persona:state", personaState()) });
    expect(s.messages.map((m) => m.id)).toEqual(["m1"]);
    expect(s.others.S1.messages.map((m) => m.id)).toEqual(["o1"]);
  });

  test("the first state adopts its thread id", () => {
    const s = personaReducer(initialPersonaViewState, {
      type: "frame",
      message: frame("persona:state", personaState()),
    });
    expect(s.threadId).toBe(THREAD);
  });
});

describe("personaReducer — REST snapshots", () => {
  test("a fresh snapshot loads everything", () => {
    const s = personaReducer(initialPersonaViewState, {
      type: "snapshot",
      frameMark: 0,
      snapshot: {
        state: personaState(),
        messages: { threadId: THREAD, messages: [msg(2), msg(1)] },
        jobs: [job("J1")],
        recentApprovals: [approval("A1")],
      },
    });
    expect(s.loaded).toBe(true);
    expect(s.threadId).toBe(THREAD);
    expect(s.messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(s.jobs).toHaveLength(1);
    expect(s.approvals).toHaveLength(1);
  });

  test("a resync merges with the held thread instead of replacing it", () => {
    const s = personaReducer(loaded({ messages: [msg(1), msg(2)] }), {
      type: "snapshot",
      frameMark: 0,
      snapshot: { messages: { threadId: THREAD, messages: [msg(2), msg(3)] } },
    });
    expect(s.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  test("a resync clears an outbox item whose echo was missed while offline", () => {
    let s = personaReducer(loaded({ messages: [msg(1)] }), {
      type: "queue",
      item: outboxItem("k1", "hi", 1),
    });
    s = personaReducer(s, {
      type: "snapshot",
      frameMark: s.frames,
      snapshot: { messages: { threadId: THREAD, messages: [msg(1), msg(2, { role: "user", text: "hi" })] } },
    });
    expect(s.outbox).toEqual([]);
  });

  test("a fresh pending list drops approvals decided while disconnected", () => {
    const s = personaReducer(loaded({ approvals: [approval("A1"), approval("A2")] }), {
      type: "snapshot",
      frameMark: 0,
      snapshot: { pendingApprovals: [approval("A2")], recentApprovals: [approval("A2")] },
    });
    expect(s.approvals.map((a) => a.id)).toEqual(["A2"]);
  });

  test("an old pending approval past the recent list's cap stays pending", () => {
    const old = approval("OLD", { createdAt: "2026-09-01T00:00:00.000Z" });
    const s = personaReducer(loaded({ approvals: [old] }), {
      type: "snapshot",
      frameMark: 0,
      snapshot: {
        pendingApprovals: [old],
        recentApprovals: [approval("NEW", { status: "executed" })],
      },
    });
    expect(pendingApprovals(s.approvals).map((a) => a.id)).toEqual(["OLD"]);
    expect(s.approvals.map((a) => a.id).sort()).toEqual(["NEW", "OLD"]);
  });

  test("the recent list alone never prunes a held pending approval", () => {
    const s = personaReducer(loaded({ approvals: [approval("OLD")] }), {
      type: "snapshot",
      frameMark: 0,
      snapshot: { recentApprovals: [approval("NEW")] },
    });
    expect(pendingApprovals(s.approvals).map((a) => a.id).sort()).toEqual(["NEW", "OLD"]);
  });

  test("a snapshot older than live frames neither rolls state back nor drops approvals", () => {
    let s = loaded();
    const mark = s.frames;
    s = personaReducer(s, {
      type: "frame",
      message: frame("persona:state", personaState({ runState: "thinking" })),
    });
    s = personaReducer(s, { type: "frame", message: frame("persona:approval", approval("A9")) });
    s = personaReducer(s, {
      type: "snapshot",
      frameMark: mark,
      snapshot: { state: personaState({ runState: "idle" }), recentApprovals: [] },
    });
    expect(s.state?.runState).toBe("thinking");
    expect(s.approvals.map((a) => a.id)).toEqual(["A9"]);
  });

  test("a disabled snapshot reads as disabled", () => {
    const s = personaReducer(initialPersonaViewState, {
      type: "snapshot",
      frameMark: 0,
      snapshot: { disabledReason: "Persona is disabled (STANDUP_PERSONA=0)" },
    });
    expect(isPersonaDisabled(s)).toBe(true);
    expect(runStateChip(s).label).toBe("Disabled");
  });

  test("a load error is recorded and cleared by the next good snapshot", () => {
    let s = personaReducer(initialPersonaViewState, {
      type: "snapshot",
      frameMark: 0,
      snapshot: { loadError: "offline" },
    });
    expect(s.loadError).toBe("offline");
    s = personaReducer(s, { type: "snapshot", frameMark: 0, snapshot: { state: personaState() } });
    expect(s.loadError).toBeUndefined();
  });
});

describe("jobs", () => {
  test("upsert keeps newest-first and replaces by id", () => {
    let jobs = upsertJob([], job("J1", { createdAt: "2026-10-04T10:00:00.000Z" }));
    jobs = upsertJob(jobs, job("J2", { createdAt: "2026-10-04T11:00:00.000Z" }));
    expect(jobs.map((j) => j.id)).toEqual(["J2", "J1"]);
    jobs = upsertJob(jobs, job("J1", { status: "done", updatedAt: "2026-10-04T17:00:00.000Z" }));
    expect(jobs.find((j) => j.id === "J1")?.status).toBe("done");
  });

  test("a stale copy never rolls a job back", () => {
    const jobs = [job("J1", { status: "done", updatedAt: "2026-10-04T12:00:00.000Z" })];
    expect(upsertJob(jobs, job("J1", { status: "active", updatedAt: "2026-10-04T11:00:00.000Z" }))).toBe(jobs);
  });

  test("mergeJobs unions a list", () => {
    expect(mergeJobs([job("J1")], [job("J2"), job("J1")]).map((j) => j.id).sort()).toEqual(["J1", "J2"]);
  });

  test("sortJobs puts jobs waiting on the owner first, closed ones last", () => {
    const sorted = sortJobs([
      job("done", { status: "done" }),
      job("active", { status: "active" }),
      job("waiting", { status: "waiting_user" }),
      job("failed", { status: "failed" }),
    ]);
    expect(sorted.map((j) => j.id)).toEqual(["waiting", "active", "failed", "done"]);
  });

  test("sortJobs orders by the derived state, most recently active first within one", () => {
    const view = (state: PersonaJobState, lastActivityAt: string) => ({ view: { state, lastActivityAt } });
    const sorted = sortJobs([
      job("idle", view("idle", "2026-10-04T18:00:00.000Z")),
      job("running-old", view("running", "2026-10-04T16:30:00.000Z")),
      job("asks", view("needs_you", "2026-10-04T16:10:00.000Z")),
      job("running-new", view("running", "2026-10-04T17:00:00.000Z")),
    ]);
    expect(sorted.map((j) => j.id)).toEqual(["asks", "running-new", "running-old", "idle"]);
  });

  test("jobState reads the derived view, else falls back to the stored status", () => {
    expect(jobState(job("a", { status: "active", view: { state: "needs_you", lastActivityAt: "x" } }))).toBe("needs_you");
    expect(jobState(job("b", { status: "waiting_user" }))).toBe("needs_you");
    expect(jobState(job("c", { status: "active" }))).toBe("running");
    expect(jobState(job("d", { status: "cancelled" }))).toBe("cancelled");
  });

  test("jobSummaryLine prefers a served checkpoint over the note", () => {
    const checkpoint = { sessionId: "s", summary: "tests green", at: "2026-10-04T17:00:00.000Z" };
    expect(jobSummaryLine(job("a", { note: "n", view: { state: "idle", lastActivityAt: "x", checkpoint } }))).toEqual({
      text: "tests green",
      source: "checkpoint",
    });
    expect(jobSummaryLine(job("b", { note: "n" }))).toEqual({ text: "n", source: "note" });
    expect(jobSummaryLine(job("c"))).toBeUndefined();
  });

  test("jobLastActivity falls back to updatedAt", () => {
    expect(jobLastActivity(job("a"))).toBe("2026-10-04T16:00:00.000Z");
  });
});

describe("approvals", () => {
  test("a decision never reverts to pending", () => {
    const decided = [approval("A1", { status: "executed" })];
    expect(upsertApproval(decided, approval("A1"))).toBe(decided);
  });

  test("approved can advance to executed", () => {
    const next = upsertApproval([approval("A1", { status: "approved" })], approval("A1", { status: "executed" }));
    expect(next[0].status).toBe("executed");
  });

  test("a non-authoritative recent list only adds", () => {
    const next = mergeApprovals([approval("A1")], [approval("A2")], false);
    expect(next.map((a) => a.id)).toEqual(["A1", "A2"]);
  });

  test("pending + recent merge keeps an old pending approval and records decisions", () => {
    const next = mergeApprovalSnapshot(
      [approval("OLD"), approval("GONE"), approval("D1")],
      [approval("OLD"), approval("D1")],
      [approval("D1", { status: "denied" }), approval("R1", { status: "executed" })],
      true
    );
    expect(next.map((a) => [a.id, a.status])).toEqual([
      ["OLD", "pending"],
      ["D1", "denied"],
      ["R1", "executed"],
    ]);
  });

  test("a stale snapshot's pending list does not prune", () => {
    const next = mergeApprovalSnapshot([approval("A9")], [], [], false);
    expect(next.map((a) => a.id)).toEqual(["A9"]);
  });

  test("pendingApprovals is oldest first and excludes decided", () => {
    const list = pendingApprovals([
      approval("late", { createdAt: "2026-10-04T12:00:00.000Z" }),
      approval("done", { status: "denied" }),
      approval("early", { createdAt: "2026-10-04T10:00:00.000Z" }),
    ]);
    expect(list.map((a) => a.id)).toEqual(["early", "late"]);
  });
});

describe("quick replies", () => {
  const live = (messages: PersonaMessage[], outbox?: PersonaOutboxItem[]) => [...openOptionsMessageIds(messages, outbox)];

  test("every open question's options are live, not just the latest", () => {
    expect(live([msg(1, { options: ["A"] }), msg(2, { options: ["B", "C"] })])).toEqual(["m1", "m2"]);
    expect(
      live([msg(1, { options: ["A"] }), msg(2, { options: ["B"] }), msg(3), msg(4, { options: ["C"] })])
    ).toEqual(["m1", "m2", "m4"]);
  });

  test("an owner message in between leaves earlier open questions live", () => {
    expect(live([msg(1, { options: ["A"] }), msg(2, { role: "user" }), msg(3, { options: ["B"] })])).toEqual(["m1", "m3"]);
  });

  test("an answered question shows no options; the others stay", () => {
    const messages = [
      msg(1, { options: ["A"], answeredAt: "2026-10-04T17:00:00.000Z" }),
      msg(2, { options: ["B"] }),
      msg(3, { options: ["C"] }),
    ];
    expect(live(messages)).toEqual(["m2", "m3"]);
  });

  test("a quick reply still sending hides only the question it answers", () => {
    const reply = { ...outboxItem("k", "A", 2), replyTo: { messageId: "m1", optionIndex: 0 } };
    expect(live([msg(1, { options: ["A"] }), msg(2, { options: ["B"] })], [reply])).toEqual(["m2"]);
    // A typed message still sending names no question, so none close until the collector says.
    expect(live([msg(1, { options: ["A"] })], [outboxItem("k", "hello", 1)])).toEqual(["m1"]);
  });

  test("live frames: a new question keeps the old one's options; answering the older closes only it", () => {
    let view = loaded({ messages: [msg(1, { options: ["A1", "A2"] })] });
    view = personaReducer(view, { type: "frame", message: frame("persona:message", msg(2, { options: ["B1", "B2"] })) });
    expect(live(view.messages, view.outbox)).toEqual(["m1", "m2"]);
    view = personaReducer(view, { type: "frame", message: frame("persona:message", msg(3, { options: ["C1"] })) });
    expect(live(view.messages, view.outbox)).toEqual(["m1", "m2", "m3"]);
    // The owner answers the oldest: the collector re-publishes it answered, then the reply.
    view = personaReducer(view, {
      type: "frame",
      message: frame("persona:message", msg(1, { options: ["A1", "A2"], answeredAt: "2026-10-04T17:00:00.000Z" })),
    });
    view = personaReducer(view, { type: "frame", message: frame("persona:message", msg(4, { role: "user", text: "A1" })) });
    expect(live(view.messages, view.outbox)).toEqual(["m2", "m3"]);
  });

  test("a snapshot read before the answer doesn't bring an answered question's options back", () => {
    let view = loaded({ messages: [msg(1, { options: ["A"] }), msg(2, { options: ["B"] })] });
    const mark = view.frames;
    view = personaReducer(view, {
      type: "frame",
      message: frame("persona:message", msg(1, { options: ["A"], answeredAt: "2026-10-04T17:00:00.000Z" })),
    });
    view = personaReducer(view, { type: "frame", message: frame("persona:message", msg(3, { role: "user", text: "A" })) });
    view = personaReducer(view, {
      type: "snapshot",
      frameMark: mark,
      snapshot: { state: personaState(), messages: { threadId: THREAD, messages: [msg(1, { options: ["A"] }), msg(2, { options: ["B"] })] } },
    });
    expect(live(view.messages, view.outbox)).toEqual(["m2"]);
  });

  test("the POST reply to a quick reply closes its question even before the collector's frame", () => {
    let view = loaded({ messages: [msg(1, { options: ["A"] }), msg(2, { options: ["B"] })] });
    view = personaReducer(view, {
      type: "queue",
      item: { ...outboxItem("k", "A", 2), replyTo: { messageId: "m1", optionIndex: 0 } },
    });
    expect(live(view.messages, view.outbox)).toEqual(["m2"]);
    view = personaReducer(view, { type: "sent", idempotencyKey: "k", message: msg(3, { role: "user", text: "A" }) });
    expect(view.outbox).toEqual([]);
    expect(live(view.messages, view.outbox)).toEqual(["m2"]);
    // The frame then lands; nothing changes.
    view = personaReducer(view, {
      type: "frame",
      message: frame("persona:message", msg(1, { options: ["A"], answeredAt: "2026-10-04T17:00:00.000Z" })),
    });
    expect(live(view.messages, view.outbox)).toEqual(["m2"]);
  });

  test("a failed quick reply hides only its question, and discarding it brings the options back", () => {
    let view = loaded({ messages: [msg(1, { options: ["A"] }), msg(2, { options: ["B"] })] });
    view = personaReducer(view, { type: "queue", item: { ...outboxItem("k", "A", 2), replyTo: { messageId: "m1", optionIndex: 0 } } });
    view = personaReducer(view, { type: "sendFailed", idempotencyKey: "k", error: "offline" });
    expect(live(view.messages, view.outbox)).toEqual(["m2"]);
    view = personaReducer(view, { type: "discard", idempotencyKey: "k" });
    expect(live(view.messages, view.outbox)).toEqual(["m1", "m2"]);
  });

  test("an answered re-publish for a thread with nothing loaded isn't held as a lone row", () => {
    let view = loaded({
      messages: [msg(1)],
      threads: [
        { id: THREAD, channel: "console", audience: "private", messageCount: 1, updatedAt: "2026-10-04T16:00:00.000Z" },
        {
          id: "slack1",
          channel: "slack",
          audience: "private",
          messageCount: 250,
          updatedAt: "2026-10-04T16:00:00.000Z",
          lastMessage: { ...msg(250), threadId: "slack1", id: "s250" },
        },
      ] as PersonaViewState["threads"],
    });
    const republished = { ...msg(5, { options: ["A"], answeredAt: "z" }), threadId: "slack1", id: "s5" };
    view = personaReducer(view, { type: "frame", message: frame("persona:message", republished) });
    expect(view.others.slack1).toBeUndefined();
    // A new message for that thread is still held.
    view = personaReducer(view, { type: "frame", message: frame("persona:message", { ...msg(251), threadId: "slack1", id: "s251" }) });
    expect(view.others.slack1?.messages.map((m) => m.id)).toEqual(["s251"]);
  });

  test("a quick reply confirmed after the owner switched threads still closes its question", () => {
    const threads = [
      { id: THREAD, channel: "console", audience: "private", messageCount: 2, updatedAt: "2026-10-04T16:00:00.000Z" },
      { id: "t2", channel: "slack", audience: "private", messageCount: 0, updatedAt: "2026-10-04T16:00:00.000Z" },
    ] as PersonaViewState["threads"];
    let view = loaded({ messages: [msg(1, { options: ["A"] }), msg(2, { options: ["B"] })], threads });
    view = personaReducer(view, {
      type: "queue",
      item: { ...outboxItem("k", "A", 2), threadId: THREAD, replyTo: { messageId: "m1", optionIndex: 0 } },
    });
    view = personaReducer(view, { type: "select", threadId: "t2" });
    view = personaReducer(view, { type: "sent", idempotencyKey: "k", message: msg(3, { role: "user", text: "A" }) });
    view = personaReducer(view, { type: "select", threadId: THREAD });
    expect(live(view.messages, view.outbox)).toEqual(["m2"]);
  });

  test("an answered re-publish held before a thread's first page is dropped when the page lands", () => {
    // Boot: the frame arrives before any snapshot.
    let view: PersonaViewState = { ...initialPersonaViewState };
    view = personaReducer(view, { type: "frame", message: frame("persona:message", msg(5, { options: ["A"], answeredAt: "z" })) });
    const page = Array.from({ length: 5 }, (_, i) => msg(151 + i));
    view = personaReducer(view, {
      type: "snapshot",
      frameMark: view.frames,
      snapshot: { state: personaState(), messages: { threadId: THREAD, messages: page } },
    });
    expect(view.messages.map((m) => m.seq)).toEqual([151, 152, 153, 154, 155]);
    // A loaded run right below the page, answered questions included, stays.
    let kept = loaded({ messages: [msg(149, { options: ["A"], answeredAt: "z" }), msg(150)] });
    kept = personaReducer(kept, { type: "threadMessages", response: { threadId: THREAD, messages: page } });
    expect(kept.messages.map((m) => m.seq)).toEqual([149, 150, 151, 152, 153, 154, 155]);
  });

  test("back-to-back questions closed together and re-published before the first page are dropped", () => {
    let view: PersonaViewState = { ...initialPersonaViewState };
    view = personaReducer(view, { type: "frame", message: frame("persona:message", msg(5, { options: ["A"], answeredAt: "z" })) });
    view = personaReducer(view, { type: "frame", message: frame("persona:message", msg(6, { options: ["B"], answeredAt: "z" })) });
    const page = Array.from({ length: 5 }, (_, i) => msg(151 + i));
    view = personaReducer(view, {
      type: "snapshot",
      frameMark: view.frames,
      snapshot: { state: personaState(), messages: { threadId: THREAD, messages: page } },
    });
    expect(view.messages.map((m) => m.seq)).toEqual([151, 152, 153, 154, 155]);
  });

  test("a re-publish for the thread just selected, before its page lands, is dropped with the page", () => {
    let view = loaded({ threadId: "t0", messages: [msg(1, { threadId: "t0", id: "x1" })] });
    view = personaReducer(view, { type: "select", threadId: THREAD });
    view = personaReducer(view, { type: "frame", message: frame("persona:message", msg(5, { options: ["A"], answeredAt: "z" })) });
    const page = Array.from({ length: 5 }, (_, i) => msg(151 + i));
    view = personaReducer(view, { type: "threadMessages", response: { threadId: THREAD, messages: page } });
    expect(view.messages.map((m) => m.seq)).toEqual([151, 152, 153, 154, 155]);
  });

  test("a held run below the page that isn't only answered questions stays", () => {
    let view = loaded({ messages: [msg(5, { options: ["A"], answeredAt: "z" }), msg(6), msg(7)] });
    const page = Array.from({ length: 5 }, (_, i) => msg(151 + i));
    view = personaReducer(view, { type: "threadMessages", response: { threadId: THREAD, messages: page } });
    expect(view.messages.map((m) => m.seq)).toEqual([5, 6, 7, 151, 152, 153, 154, 155]);
  });

  test("a stale tag-edit response for a backfilled question keeps its answer", () => {
    const old = msg(2, { options: ["A"], jobIds: ["j1"], jobTags: [{ jobId: "j1", source: "inferred" }] });
    let view = loaded({ messages: [msg(10), msg(11)] });
    view = personaReducer(view, { type: "backfill", threadId: THREAD, key: "j1", messages: [old] });
    view = personaReducer(view, { type: "frame", message: frame("persona:message", { ...old, answeredAt: "2026-10-04T17:00:00.000Z" }) });
    view = personaReducer(view, { type: "messageUpdated", message: { ...old, jobIds: undefined, jobTags: undefined } });
    expect(view.backfill?.messages[0]?.answeredAt).toBeString();
    expect(view.backfill?.messages[0]?.jobTags).toBeUndefined();
  });

  test("a backfill refetch keeps an answer a frame brought meanwhile", () => {
    const old = msg(2, { options: ["A"], jobIds: ["j1"], jobTags: [{ jobId: "j1", source: "explicit" }] });
    let view = loaded({ messages: [msg(10), msg(11)] });
    view = personaReducer(view, { type: "backfill", threadId: THREAD, key: "j1", messages: [old] });
    view = personaReducer(view, { type: "frame", message: frame("persona:message", { ...old, answeredAt: "2026-10-04T17:00:00.000Z" }) });
    expect(view.backfill?.messages[0]?.answeredAt).toBeString();
    view = personaReducer(view, { type: "backfill", threadId: THREAD, key: "j1", messages: [old] });
    expect(view.backfill?.messages[0]?.answeredAt).toBeString();
  });

  test("only Persona questions with options count", () => {
    expect(live([msg(1, { role: "user", options: ["x"] }), msg(2, { options: [] }), msg(3)])).toEqual([]);
  });
});

describe("status line", () => {
  test("chip per run state", () => {
    expect(runStateChip(loaded()).label).toBe("Idle");
    expect(runStateChip(loaded({ state: personaState({ runState: "thinking" }) }))).toEqual({
      label: "Thinking",
      tone: "running",
    });
    expect(runStateChip(loaded({ state: personaState({ runState: "error" }) })).tone).toBe("waiting");
    expect(runStateChip(loaded({ state: personaState({ runState: "paused" }) })).label).toBe("Paused");
    expect(runStateChip(initialPersonaViewState).label).toBe("Connecting");
  });

  test("activity shows only while thinking, with its detail", () => {
    const activity = { label: "launch_session", detail: "billing-platform", at: "x" };
    expect(activityLabel({ state: personaState({ runState: "thinking" }), activity })).toBe(
      "launch_session · billing-platform"
    );
    expect(activityLabel({ state: personaState(), activity })).toBeUndefined();
  });

  test("host capacity without a host reading shows only workers against the configured cap", () => {
    const cap = hostCapacity(personaState());
    expect(cap.workers.text).toBe("Workers 2 / 6");
    expect(cap.hostLimited).toBeUndefined();
    expect(cap.queued).toBeUndefined();
    expect(cap.cpu).toBeUndefined();
    expect(cap.ram).toBeUndefined();
  });

  test("host capacity labels CPU load against cores and RAM free against total", () => {
    const host = {
      effectiveMaxActive: 55,
      hostLimited: false,
      memAvailableBytes: 223.7 * GiB,
      memTotalBytes: 247.2 * GiB,
      load1: 5.2,
      cores: 64,
      queued: 0,
    };
    const cap = hostCapacity(personaState({ activeLaunches: 4, maxActiveLaunches: 55, host }));
    expect(cap.workers.text).toBe("Workers 4 / 55");
    expect(cap.cpu?.text).toBe("CPU load 5.2 / 64 cores");
    expect(cap.ram?.text).toBe("RAM 224 / 247 GB free");
    expect(cap.hostLimited).toBeUndefined();
    for (const r of [cap.workers, cap.cpu, cap.ram]) expect(r?.title).toBeTruthy();
    expect(cap.cpu?.title).toContain("1-minute CPU load average");
  });

  test("host capacity flags a host-limited cap and counts queued launches apart", () => {
    const host = {
      effectiveMaxActive: 3,
      hostLimited: true,
      memAvailableBytes: 3.1 * GiB,
      load1: 1.2,
      cores: 4,
      queued: 1,
    };
    const cap = hostCapacity(personaState({ activeLaunches: 3, host }));
    expect(cap.workers.text).toBe("Workers 2 / 3");
    expect(cap.hostLimited?.text).toBe("host-limited");
    expect(cap.hostLimited?.title).toBe("The host's free memory or CPU lowered the worker cap from 6 to 3");
    expect(cap.queued?.text).toBe("1 queued");
    expect(cap.ram?.text).toBe("RAM 3.1 GB free");
  });

  test("GB numbers are whole from 10 GB up and keep a decimal below", () => {
    expect(formatGbNumber(223.7 * GiB)).toBe("224");
    expect(formatGbNumber(10 * GiB)).toBe("10");
    expect(formatGbNumber(9.96 * GiB)).toBe("10");
    expect(formatGbNumber(9.9 * GiB)).toBe("9.9");
    expect(formatGbNumber(0.4 * GiB)).toBe("0.4");
  });
});

const GiB = 1024 ** 3;

/** A fetch stand-in answering by path; unknown paths 404. */
function stubFetch(routes: Record<string, { status: number; body?: unknown } | "throw">) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const route = routes[url];
    if (route === "throw") throw new Error("network down");
    if (!route) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    return new Response(route.body === undefined ? "" : JSON.stringify(route.body), {
      status: route.status,
    });
  };
  return { fn, calls };
}

describe("personaCall", () => {
  test("posts JSON and returns the body", async () => {
    const { fn, calls } = stubFetch({ "/api/persona/pause": { status: 200, body: personaState({ runState: "paused" }) } });
    const res = await personaCall<PersonaState>("/pause", { method: "POST", body: {} }, fn);
    expect(res.ok).toBe(true);
    expect(res.data?.runState).toBe("paused");
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.body).toBe("{}");
  });

  test("a 503 is flagged disabled with the server's reason", async () => {
    const { fn } = stubFetch({ "/api/persona/messages": { status: 503, body: { error: "Persona is disabled (STANDUP_PERSONA=0)" } } });
    const res = await personaCall("/messages", { method: "POST", body: { text: "x" } }, fn);
    expect(res).toMatchObject({ ok: false, status: 503, disabled: true, error: "Persona is disabled (STANDUP_PERSONA=0)" });
  });

  test("a 503 without the collector's JSON error (a proxy's) is a failed read, not a disabled Persona", async () => {
    const { fn } = stubFetch({ "/api/persona/state": { status: 503, body: "Service Unavailable" } });
    const res = await personaCall("/state", undefined, fn);
    expect(res).toMatchObject({ ok: false, status: 503, disabled: false, error: "Request failed (503)" });
  });

  test("a 409 without a body still yields an error", async () => {
    const { fn } = stubFetch({ "/api/persona/approvals/A1/approve": { status: 409 } });
    const res = await personaCall("/approvals/A1/approve", { method: "POST" }, fn);
    expect(res).toMatchObject({ ok: false, status: 409, error: "Request failed (409)" });
    expect(res.disabled).toBe(false);
  });

  test("a network failure never throws", async () => {
    const { fn } = stubFetch({ "/api/persona/state": "throw" });
    const res = await personaCall("/state", undefined, fn);
    expect(res).toMatchObject({ ok: false, status: 0, error: "network down" });
  });
});

describe("fetchPersonaSnapshot", () => {
  test("gathers all five collections", async () => {
    const { fn, calls } = stubFetch({
      "/api/persona/state": { status: 200, body: personaState() },
      "/api/persona/messages?limit=50": { status: 200, body: { threadId: THREAD, messages: [msg(1)] } },
      "/api/persona/jobs": { status: 200, body: { jobs: [job("J1")] } },
      "/api/persona/approvals?status=pending": { status: 200, body: { approvals: [approval("P1")] } },
      "/api/persona/approvals": { status: 200, body: { approvals: [approval("A1")] } },
      "/api/persona/threads": { status: 200, body: { threads: [summary("S1")] } },
    });
    const snap = await fetchPersonaSnapshot(fn);
    expect(calls).toHaveLength(6);
    expect(snap.threads?.map((t) => t.id)).toEqual(["S1"]);
    expect(snap.pendingApprovals?.map((a) => a.id)).toEqual(["P1"]);
    expect(snap.state?.runState).toBe("idle");
    expect(snap.messages?.messages).toHaveLength(1);
    expect(snap.jobs?.map((j) => j.id)).toEqual(["J1"]);
    expect(snap.recentApprovals?.map((a) => a.id)).toEqual(["A1"]);
    expect(snap.disabledReason).toBeUndefined();
    expect(snap.loadError).toBeUndefined();
  });

  test("disabled: state says so and the other routes 503", async () => {
    const reason = { status: 503, body: { error: "Persona is disabled (STANDUP_PERSONA=0)" } };
    const { fn } = stubFetch({
      "/api/persona/state": { status: 200, body: personaState({ runState: "disabled" }) },
      "/api/persona/messages?limit=50": reason,
      "/api/persona/jobs": reason,
      "/api/persona/approvals?status=pending": reason,
      "/api/persona/approvals": reason,
    });
    const snap = await fetchPersonaSnapshot(fn);
    expect(snap.disabledReason).toBe("Persona is disabled (STANDUP_PERSONA=0)");
    expect(snap.loadError).toBeUndefined();
    expect(snap.messages).toBeUndefined();
    const view = personaReducer(initialPersonaViewState, { type: "snapshot", frameMark: 0, snapshot: snap });
    expect(isPersonaDisabled(view)).toBe(true);
  });

  test("disabled state alone still reads as disabled", async () => {
    const { fn } = stubFetch({
      "/api/persona/state": { status: 200, body: personaState({ runState: "disabled" }) },
    });
    const snap = await fetchPersonaSnapshot(fn);
    expect(snap.disabledReason).toBe("Persona is disabled (STANDUP_PERSONA=0)");
  });

  test("a failed collection is omitted and reported, the rest still load", async () => {
    const { fn } = stubFetch({
      "/api/persona/state": { status: 200, body: personaState() },
      "/api/persona/messages?limit=50": "throw",
      "/api/persona/jobs": { status: 200, body: { jobs: [] } },
      "/api/persona/approvals?status=pending": { status: 200, body: { approvals: [] } },
      "/api/persona/approvals": { status: 200, body: { approvals: [] } },
    });
    const snap = await fetchPersonaSnapshot(fn);
    expect(snap.messages).toBeUndefined();
    expect(snap.state).toBeDefined();
    expect(snap.loadError).toBe("network down");
    const held = loaded({ messages: [msg(1)] });
    const view = personaReducer(held, { type: "snapshot", frameMark: held.frames, snapshot: snap });
    expect(view.messages).toHaveLength(1);
  });

  const allRoutes = {
    "/api/persona/state": { status: 200, body: personaState() },
    "/api/persona/messages?limit=50": { status: 200, body: { threadId: THREAD, messages: [msg(1)] } },
    "/api/persona/jobs": { status: 200, body: { jobs: [job("J1")] } },
    "/api/persona/approvals?status=pending": { status: 200, body: { approvals: [approval("P1")] } },
    "/api/persona/approvals": { status: 200, body: { approvals: [approval("A1")] } },
    "/api/persona/threads": { status: 200, body: { threads: [summary("S1")] } },
  };

  test("a first-paint snapshot reads only the state, the newest page and the pending cards", async () => {
    const { fn, calls } = stubFetch(allRoutes);
    const snap = await fetchPersonaSnapshot(fn, null, null, { firstPaint: true });
    expect(calls.map((c) => c.url).sort()).toEqual([
      "/api/persona/approvals?status=pending",
      "/api/persona/messages?limit=50",
      "/api/persona/state",
    ]);
    expect(snap.messages?.messages.map((m) => m.id)).toEqual(["m1"]);
    expect(snap.pendingApprovals?.map((a) => a.id)).toEqual(["P1"]);
    expect(snap.jobs).toBeUndefined();
    expect(snap.recentApprovals).toBeUndefined();
    expect(snap.threads).toBeUndefined();
    expect(snap.loadError).toBeUndefined();
    // The jobs list isn't known yet, so the view doesn't claim it is.
    const view = personaReducer(initialPersonaViewState, { type: "snapshot", frameMark: 0, snapshot: snap });
    expect(view.loaded).toBe(true);
    expect(view.jobsLoaded).toBeUndefined();
  });

  test("a full snapshot reads all six routes, the messages a page at a time, and marks the jobs loaded", async () => {
    const { fn, calls } = stubFetch(allRoutes);
    const snap = await fetchPersonaSnapshot(fn);
    expect(calls.map((c) => c.url).sort()).toEqual([
      "/api/persona/approvals",
      "/api/persona/approvals?status=pending",
      "/api/persona/jobs",
      "/api/persona/messages?limit=50",
      "/api/persona/state",
      "/api/persona/threads",
    ]);
    const view = personaReducer(initialPersonaViewState, { type: "snapshot", frameMark: 0, snapshot: snap });
    expect(view.jobsLoaded).toBe(true);
    expect(view.jobs.map((j) => j.id)).toEqual(["J1"]);
  });

  test("a first-paint snapshot of a selected thread for a user scopes its three reads", async () => {
    const { fn, calls } = stubFetch({});
    await fetchPersonaSnapshot(fn, "t9", "alice", { firstPaint: true });
    expect(calls.map((c) => c.url).sort()).toEqual([
      "/api/persona/approvals?status=pending&user=alice",
      "/api/persona/messages?threadId=t9&user=alice",
      "/api/persona/state?user=alice",
    ]);
  });

  test("a first-paint snapshot whose messages read fails still reports it", async () => {
    const { fn } = stubFetch({ ...allRoutes, "/api/persona/messages?limit=50": "throw" });
    const snap = await fetchPersonaSnapshot(fn, null, null, { firstPaint: true });
    expect(snap.messages).toBeUndefined();
    expect(snap.loadError).toBe("network down");
  });
});

describe("messages paths", () => {
  test("messagesPath carries the thread and the page size, or neither", () => {
    expect(messagesPath()).toBe("/messages");
    expect(messagesPath(null, 50)).toBe("/messages?limit=50");
    expect(messagesPath("t 1")).toBe("/messages?threadId=t%201");
    expect(messagesPath("t1", 50)).toBe("/messages?threadId=t1&limit=50");
  });

  test("olderMessagesPath reads the page before a seq, a page at a time by default", () => {
    expect(olderMessagesPath("t 1", 151)).toBe(`/messages?threadId=t+1&beforeSeq=151&limit=${PERSONA_PAGE}`);
    expect(olderMessagesPath("t1", 9, 5)).toBe("/messages?threadId=t1&beforeSeq=9&limit=5");
  });
});

describe("newIdempotencyKey", () => {
  test("keys are distinct", () => {
    const keys = new Set(Array.from({ length: 50 }, () => newIdempotencyKey()));
    expect(keys.size).toBe(50);
  });
});

describe("per-user Persona: refusals, landing and sign-in", () => {
  const unauthenticated = { status: 403, body: { error: "Persona needs a signed-in identity", reason: "unauthenticated" } };

  test("an unauthenticated 403 is flagged forbidden with its reason, not a load error", async () => {
    const { fn } = stubFetch({
      "/api/persona/state": unauthenticated,
      "/api/persona/messages?limit=50": unauthenticated,
      "/api/persona/jobs": unauthenticated,
      "/api/persona/approvals?status=pending": unauthenticated,
      "/api/persona/approvals": unauthenticated,
    });
    const snap = await fetchPersonaSnapshot(fn);
    expect(snap.forbidden).toBe("Persona needs a signed-in identity");
    expect(snap.forbiddenReason).toBe("unauthenticated");
    expect(snap.loadError).toBeUndefined();
    const view = personaReducer(initialPersonaViewState, { type: "snapshot", frameMark: 0, snapshot: snap });
    expect(view.forbidden).toBeDefined();
    expect(view.forbiddenReason).toBe("unauthenticated");
    expect(view.loadError).toBeUndefined();
  });

  test("personaCall carries a known refusal reason and ignores unknown ones", async () => {
    const { fn } = stubFetch({
      "/api/persona/messages": { status: 403, body: { error: "sign in", reason: "sign-in" } },
      "/api/persona/users": { status: 403, body: { error: "host only", reason: "host-only" } },
      "/api/persona/pause": { status: 403, body: { error: "x", reason: "something-else" } },
    });
    expect((await personaCall("/messages", { method: "POST", body: {} }, fn)).reason).toBe("sign-in");
    expect((await personaCall("/users", undefined, fn)).reason).toBe("host-only");
    const unknown = await personaCall("/pause", { method: "POST" }, fn);
    expect(unknown.forbidden).toBe(true);
    expect(unknown.reason).toBeUndefined();
    expect(refusalReason(null)).toBeUndefined();
  });

  test("a 401 unauthenticated reads like a 403: forbidden with its reason, not a load error", async () => {
    const anon = { status: 401, body: { error: "Persona needs a signed-in user", reason: "unauthenticated" } };
    const res = await personaCall("/state", undefined, stubFetch({ "/api/persona/state": anon }).fn);
    expect(res).toMatchObject({ ok: false, status: 401, forbidden: true, reason: "unauthenticated" });
    const { fn } = stubFetch({
      "/api/persona/state": anon,
      "/api/persona/messages?limit=50": anon,
      "/api/persona/jobs": anon,
      "/api/persona/approvals?status=pending": anon,
      "/api/persona/approvals": anon,
    });
    const snap = await fetchPersonaSnapshot(fn);
    expect(snap.forbidden).toBe("Persona needs a signed-in user");
    expect(snap.forbiddenReason).toBe("unauthenticated");
    expect(snap.loadError).toBeUndefined();
    const view = personaReducer(initialPersonaViewState, { type: "snapshot", frameMark: 0, snapshot: snap });
    expect(view.forbiddenReason).toBe("unauthenticated");
    expect(personaLanding(view, "")).toBe("/work");
  });

  test("a sign-in refusal on the reads lands a user on Persona, where the sign-in note is", async () => {
    const signIn = { status: 403, body: { error: "To direct your Persona, sign in", reason: "sign-in" } };
    const { fn } = stubFetch({
      "/api/persona/state": signIn,
      "/api/persona/messages?limit=50": signIn,
      "/api/persona/jobs": signIn,
      "/api/persona/approvals?status=pending": signIn,
      "/api/persona/approvals": signIn,
    });
    const view = personaReducer(initialPersonaViewState, { type: "snapshot", frameMark: 0, snapshot: await fetchPersonaSnapshot(fn) });
    expect(view.forbiddenReason).toBe("sign-in");
    expect(personaLanding(view, "alice")).toBe("/persona");
    expect(personaLanding(view, "anonymous")).toBe("/work");
  });

  test("a 503 `unavailable` is flagged apart from a disabled Persona", async () => {
    const full = { status: 503, body: { error: "No Persona for alice: at capacity", reason: "unavailable" } };
    const res = await personaCall("/state", undefined, stubFetch({ "/api/persona/state": full }).fn);
    expect(res).toMatchObject({ disabled: true, unavailable: true });
    const off = await personaCall("/state", undefined, stubFetch({ "/api/persona/state": { status: 503, body: { error: "off" } } }).fn);
    expect(off.unavailable).toBeUndefined();
    const snap = await fetchPersonaSnapshot(
      stubFetch({
        "/api/persona/state": full,
        "/api/persona/messages?limit=50": full,
        "/api/persona/jobs": full,
        "/api/persona/approvals?status=pending": full,
        "/api/persona/approvals": full,
      }).fn
    );
    expect(snap.unavailable).toBe(true);
    const view = personaReducer(initialPersonaViewState, { type: "snapshot", frameMark: 0, snapshot: snap });
    expect(view.unavailable).toBe(true);
    expect(isPersonaDisabled(view)).toBe(true);
    expect(runStateChip(view).label).toBe("Unavailable");
    expect(unavailableMessage("sam")).toBe("Persona is at capacity on this host — ask sam");
    expect(unavailableMessage(undefined)).toBe("Persona is at capacity on this host — ask the host");
    const action = personaReducer(loaded(), { type: "disabled", reason: "x", unavailable: true });
    expect(action.unavailable).toBe(true);
    expect(personaReducer(loaded(), { type: "disabled", reason: "x" }).unavailable).toBe(false);
  });

  test("a synthesized idle state with no thread keeps the known console thread", async () => {
    const view = personaReducer(loaded({ consoleThreadId: THREAD }), {
      type: "state",
      state: personaState({ threadId: null as unknown as string }),
    });
    expect(view.consoleThreadId).toBe(THREAD);
    const fresh = personaReducer(initialPersonaViewState, {
      type: "state",
      state: personaState({ threadId: null as unknown as string }),
    });
    expect(fresh.consoleThreadId).toBeNull();
    expect(fresh.threadId).toBeNull();
    // The bare messages route 404s until the console thread exists: no load error.
    const snap = await fetchPersonaSnapshot(
      stubFetch({
        "/api/persona/state": { status: 200, body: personaState({ threadId: null as unknown as string }) },
        "/api/persona/jobs": { status: 200, body: { jobs: [] } },
        "/api/persona/approvals?status=pending": { status: 200, body: { approvals: [] } },
        "/api/persona/approvals": { status: 200, body: { approvals: [] } },
      }).fn
    );
    expect(snap.loadError).toBeUndefined();
    expect(snap.messages).toBeUndefined();
  });

  test("a guest's first write lands in the console thread it creates, and its replies follow", () => {
    const T1 = "T1";
    let s = personaReducer(initialPersonaViewState, {
      type: "snapshot",
      frameMark: 0,
      snapshot: {
        state: personaState({ owner: "alice", threadId: "" }),
        messages: { threadId: "", messages: [] },
        threads: [],
      },
    });
    expect(s.threadId).toBeNull();
    expect(s.consoleThreadId).toBeNull();
    s = personaReducer(s, { type: "viewing", active: true });
    s = personaReducer(s, { type: "queue", item: outboxItem("k1", "hello", 0) });
    expect(s.outbox.map((o) => o.threadId)).toEqual([undefined]);
    s = personaReducer(s, {
      type: "sent",
      idempotencyKey: "k1",
      message: msg(1, { id: "u1", threadId: T1, role: "user", text: "hello" }),
    });
    expect(s.threadId).toBe(T1);
    expect(s.consoleThreadId).toBe(T1);
    expect(s.outbox).toEqual([]);
    expect(s.messages.map((m) => m.id)).toEqual(["u1"]);
    expect(s.threadsStale).toBe(true);
    s = personaReducer(s, {
      type: "frame",
      message: frame("persona:state", personaState({ owner: "alice", threadId: T1, runState: "thinking" })),
    });
    s = personaReducer(s, {
      type: "frame",
      message: frame("persona:message", msg(2, { id: "p2", threadId: T1, text: "hi alice" })),
    });
    expect(s.threadId).toBe(T1);
    expect(s.messages.map((m) => m.id)).toEqual(["u1", "p2"]);
    expect(s.others).toEqual({});
    expect(s.lastViewed[T1]).toBe(2);
    expect(orderThreads(s.threads, consoleThreadOf(s)).map((t) => t.id)).toEqual([T1]);
  });

  test("a guest whose state frame beats the POST response still sees its write and the reply", () => {
    const T1 = "T1";
    let s = personaReducer(initialPersonaViewState, {
      type: "snapshot",
      frameMark: 0,
      snapshot: {
        state: personaState({ owner: "alice", threadId: "" }),
        messages: { threadId: "", messages: [] },
        threads: [],
      },
    });
    s = personaReducer(s, { type: "queue", item: outboxItem("k1", "hello", 0) });
    s = personaReducer(s, {
      type: "frame",
      message: frame("persona:message", msg(1, { id: "u1", threadId: T1, role: "user", text: "hello" })),
    });
    s = personaReducer(s, {
      type: "frame",
      message: frame("persona:state", personaState({ owner: "alice", threadId: T1 })),
    });
    expect(s.threadId).toBe(T1);
    expect(s.messages.map((m) => m.id)).toEqual(["u1"]);
    expect(s.threadsStale).toBe(true);
    s = personaReducer(s, {
      type: "sent",
      idempotencyKey: "k1",
      message: msg(1, { id: "u1", threadId: T1, role: "user", text: "hello" }),
    });
    expect(s.outbox).toEqual([]);
    expect(s.messages.map((m) => m.id)).toEqual(["u1"]);
  });

  test("whether the viewer is the host: alias against hostAlias, else isHost, else unknown", () => {
    const withHost = loaded({ state: personaState({ hostAlias: "sam", isHost: true } as Partial<PersonaState>) });
    expect(viewerIsHost(withHost, "sam")).toBe(true);
    expect(viewerIsHost(withHost, "alice")).toBe(false);
    expect(viewerIsHost(withHost, "")).toBe(true);
    expect(viewerIsHost(loaded({ state: personaState({ isHost: false } as Partial<PersonaState>) }), "")).toBe(false);
    expect(viewerIsHost({ state: null }, "sam")).toBeUndefined();
  });

  test("who must sign in: the owner for the host, the user for a guest, nobody when writes are allowed", () => {
    const host = { hostAlias: "sam", isHost: true };
    expect(signInNeededAs(loaded({ state: personaState({ ...host, canWrite: true } as Partial<PersonaState>) }), "sam")).toBeUndefined();
    expect(signInNeededAs(loaded({ state: personaState({ ...host, canWrite: false } as Partial<PersonaState>) }), "sam")).toBe("owner");
    const guest = personaState({ owner: "alice", hostAlias: "sam", isHost: false, canWrite: false } as Partial<PersonaState>);
    expect(signInNeededAs(loaded({ state: guest }), "alice")).toBe("user");
    expect(signInNeededAs(loaded({ state: personaState({ ...host, canWrite: true } as Partial<PersonaState>), signInNeeded: true }), "sam")).toBe("owner");
    // Reads refused before any state: the wording says whose refusal it is.
    const refused = { ...initialPersonaViewState, loaded: true, forbiddenReason: "sign-in" as const };
    expect(signInNeededAs({ ...refused, forbidden: "doesn't carry the owner token (x-standup-owner-token)" }, "sam")).toBe("owner");
    expect(signInNeededAs({ ...refused, forbidden: "To direct your Persona, sign in" }, "alice")).toBe("user");
    expect(signInNeededAs({ ...initialPersonaViewState, forbidden: "x", forbiddenReason: "unauthenticated" }, "")).toBeUndefined();
  });

  test("People rows: disabled reads first, and an access change keeps the other field", () => {
    const entry = (over: Partial<PersonaUserEntry>): PersonaUserEntry => ({ alias: "alice", state: null, pendingApprovals: 0, access: null, ...over });
    const off = entry({ access: { enabled: false, launchProjects: ["a"] }, state: { paused: true } });
    expect(isUserDisabled(off)).toBe(true);
    expect(userStatusLabel(off)).toBe("disabled · paused");
    expect(userStatusLabel(entry({ access: { enabled: false, launchProjects: [] } }))).toBe("disabled · no Persona yet");
    expect(userStatusLabel(entry({ state: { paused: true } }))).toBe("paused");
    expect(userStatusLabel(entry({ state: { runState: "thinking" } }))).toBe("thinking");
    expect(userStatusLabel(entry({}))).toBe("no Persona yet");
    expect(accessUpdate(off, { enabled: true })).toEqual({ launchProjects: ["a"], enabled: true });
    expect(accessUpdate(off, { launchProjects: ["b"] })).toEqual({ launchProjects: ["b"], enabled: false });
    expect(accessUpdate(entry({}), { enabled: false })).toEqual({ launchProjects: [], enabled: false });
    const users = [entry({ alias: "sam" }), entry({ alias: "alice" })];
    expect(otherUsers(users, "sam").map((u) => u.alias)).toEqual(["alice"]);
    expect(otherUsers([entry({ alias: "sam" })], "sam")).toEqual([]);
  });

  test("a card is decidable only by its approver, else its owner", () => {
    const own = approval("A1", { owner: "alice" });
    const escalated = approval("A2", { owner: "alice", approver: "sam" });
    expect(approvalDecider(own)).toBe("alice");
    expect(approvalDecider(escalated)).toBe("sam");
    expect(isApprovalDecider(own, "alice")).toBe(true);
    expect(isApprovalDecider(escalated, "alice")).toBe(false);
    expect(isApprovalDecider(escalated, "sam")).toBe(true);
    expect(isApprovalDecider(own, undefined)).toBe(false);
    expect(approvalWaitingLabel(escalated, "alice")).toBe("Waiting on sam");
    expect(approvalWaitingLabel(escalated, "sam")).toBeUndefined();
    expect(approvalWaitingLabel({ ...escalated, status: "approved" }, "alice")).toBeUndefined();
    const all = [own, escalated, approval("A3", { owner: "alice", status: "denied" })];
    expect(approvalsNeedingViewer(all, "alice").map((a) => a.id)).toEqual(["A1"]);
    expect(approvalsNeedingViewer(all, "sam").map((a) => a.id)).toEqual(["A2"]);
    expect(approvalsNeedingViewer(all, undefined)).toEqual([]);
    expect(pendingStripTitle([own], "alice")).toBe("Awaiting your approval");
    expect(pendingStripTitle([own, escalated], "alice")).toBe("Awaiting your approval · 1 waiting on someone else");
    expect(pendingStripTitle([escalated, approval("A4", { owner: "alice", approver: "sam" })], "alice")).toBe("2 waiting on others");
    expect(pendingStripTitle([escalated, approval("A4", { owner: "bob", approver: "sam" })], "sam")).toBe("2 awaiting your approval");
  });

  test("a forbidden action marks the view forbidden with its refusal", () => {
    const s = personaReducer(loaded(), { type: "forbidden", reason: "nope", refusal: "unauthenticated" });
    expect(s.forbidden).toBe("nope");
    expect(s.forbiddenReason).toBe("unauthenticated");
  });

  test("the host lands on their Persona", () => {
    expect(personaLanding(loaded(), "sam")).toBe("/persona");
    expect(isPersonaOwner(loaded(), "sam")).toBe(true);
  });

  test("an authenticated guest lands on their own Persona, even before signing in to write", () => {
    const guest = loaded({ state: personaState({ owner: "alice", canWrite: false, isHost: false } as Partial<PersonaState>) });
    expect(personaLanding(guest, "alice")).toBe("/persona");
    expect(isPersonaOwner(guest, "alice")).toBe(true);
  });

  test("before hello-ok names the viewer, a served state is the viewer's", () => {
    expect(personaLanding(loaded(), "")).toBe("/persona");
  });

  test("an anonymous or refused viewer lands on /work", () => {
    expect(personaLanding(loaded(), "anonymous")).toBe("/work");
    const forbidden: PersonaViewState = {
      ...initialPersonaViewState,
      loaded: true,
      forbidden: "Persona needs a signed-in identity",
      forbiddenReason: "unauthenticated",
    };
    expect(personaLanding(forbidden, "")).toBe("/work");
    expect(isPersonaOwner(forbidden, "")).toBe(false);
    expect(personaLanding(initialPersonaViewState, "anonymous")).toBe("/work");
  });

  test("a state naming someone else (a stale view) is not the viewer's", () => {
    expect(personaLanding(loaded(), "teammate")).toBe("/work");
    expect(isPersonaOwner(loaded(), "teammate")).toBe(false);
  });

  test("disabled or unreachable Persona lands on /work; loading waits", () => {
    expect(personaLanding(loaded({ disabledReason: "off" }), "sam")).toBe("/work");
    const unreachable: PersonaViewState = { ...initialPersonaViewState, loaded: true, loadError: "x" };
    expect(personaLanding(unreachable, "sam")).toBe("/work");
    expect(personaLanding(initialPersonaViewState, "sam")).toBeUndefined();
  });

  test("caller fields read defensively from the state", () => {
    expect(callerFields(null)).toEqual({ hostAlias: undefined, isHost: undefined, canWrite: undefined });
    const state = personaState({ hostAlias: "sam", isHost: true, canWrite: true } as Partial<PersonaState>);
    expect(callerFields(state)).toEqual({ hostAlias: "sam", isHost: true, canWrite: true });
    const odd = personaState({ hostAlias: 3, isHost: "yes" } as unknown as Partial<PersonaState>);
    expect(callerFields(odd)).toEqual({ hostAlias: undefined, isHost: undefined, canWrite: undefined });
  });

  test("sign-in is needed when the state says the browser can't write, or a write said sign-in", () => {
    expect(needsSignIn(loaded())).toBe(false);
    expect(needsSignIn(loaded({ state: personaState({ canWrite: false } as Partial<PersonaState>) }))).toBe(true);
    const refused = personaReducer(loaded(), { type: "signInNeeded" });
    expect(needsSignIn(refused)).toBe(true);
    expect(refused.forbidden).toBeUndefined();
    const signedIn = personaReducer(refused, { type: "state", state: personaState({ canWrite: true } as Partial<PersonaState>) });
    expect(needsSignIn(signedIn)).toBe(false);
  });

  test("a persona:state frame keeps the caller fields GET /state supplied", () => {
    const view = loaded({
      state: personaState({ hostAlias: "sam", isHost: true, canWrite: true } as Partial<PersonaState>),
    });
    const next = personaReducer(view, { type: "frame", message: frame("persona:state", personaState({ runState: "thinking" })) });
    expect(next.state?.runState).toBe("thinking");
    expect(callerFields(next.state)).toEqual({ hostAlias: "sam", isHost: true, canWrite: true });
    expect(isHostViewer(next)).toBe(true);
  });

  test("another user's persona:state frame never replaces the viewer's", () => {
    const view = loaded();
    const next = personaReducer(view, { type: "frame", message: frame("persona:state", personaState({ owner: "alice", runState: "paused" })) });
    expect(next.state?.owner).toBe("sam");
    expect(next.state?.runState).toBe("idle");
  });

  test("isHostViewer needs the state to say so", () => {
    expect(isHostViewer(loaded())).toBe(false);
    expect(isHostViewer(loaded({ state: personaState({ isHost: true } as Partial<PersonaState>) }))).toBe(true);
    expect(isHostViewer(loaded({ state: personaState({ isHost: true } as Partial<PersonaState>), forbidden: "x" }))).toBe(false);
  });

  test("the login command names the user, or a placeholder", () => {
    expect(userLoginCommand("alice")).toBe("bun run scripts/console-login.ts --user alice");
    expect(userLoginCommand(undefined)).toBe("bun run scripts/console-login.ts --user <you>");
  });

  test("a card another user's Persona raised is labelled with whose", () => {
    expect(approvalFromLabel(approval("A1", { owner: "alice" }), "sam")).toBe("from alice's Persona");
    expect(approvalFromLabel(approval("A1"), "sam")).toBeUndefined();
    expect(approvalFromLabel(approval("A1", { owner: "alice" }), undefined)).toBeUndefined();
  });
});

describe("host view of another user", () => {
  test("withUser appends ?user= or &user=, encoded", () => {
    expect(withUser("/threads", "alice")).toBe("/threads?user=alice");
    expect(withUser("/approvals?status=pending", "alice")).toBe("/approvals?status=pending&user=alice");
    expect(withUser("/messages?threadId=t1", "a b")).toBe("/messages?threadId=t1&user=a%20b");
    expect(withUser("/jobs", null)).toBe("/jobs");
    expect(withUser("/jobs", "")).toBe("/jobs");
  });

  const aliceRoutes = {
    "/api/persona/messages?user=alice": { status: 200, body: { threadId: "ta", messages: [msg(1, { threadId: "ta" })] } },
    "/api/persona/jobs?user=alice": { status: 200, body: { jobs: [job("J1")] } },
    "/api/persona/approvals?status=pending&user=alice": { status: 200, body: { approvals: [approval("P1", { owner: "alice" })] } },
    "/api/persona/approvals?user=alice": { status: 200, body: { approvals: [] } },
    "/api/persona/threads?user=alice": { status: 200, body: { threads: [summary("ta")] } },
  };

  test("a user snapshot fetches every collection for that user, /state included", async () => {
    const { fn, calls } = stubFetch(aliceRoutes);
    const snap = await fetchPersonaSnapshot(fn, null, "alice");
    expect(calls.map((c) => c.url).sort()).toEqual([
      "/api/persona/approvals?status=pending&user=alice",
      "/api/persona/approvals?user=alice",
      "/api/persona/jobs?user=alice",
      "/api/persona/messages?user=alice",
      "/api/persona/state?user=alice",
      "/api/persona/threads?user=alice",
    ]);
    // A collector without `?user` on /state (404 here) is no load error.
    expect(snap.state).toBeUndefined();
    expect(snap.loadError).toBeUndefined();
    expect(snap.messages?.threadId).toBe("ta");
    expect(snap.pendingApprovals?.map((a) => a.id)).toEqual(["P1"]);
  });

  test("a user snapshot keeps that user's state, never the host's", async () => {
    const own = await fetchPersonaSnapshot(
      stubFetch({ ...aliceRoutes, "/api/persona/state?user=alice": { status: 200, body: personaState({ owner: "alice", threadId: "ta" }) } }).fn,
      null,
      "alice"
    );
    expect(own.state?.owner).toBe("alice");
    const hosts = await fetchPersonaSnapshot(
      stubFetch({ ...aliceRoutes, "/api/persona/state?user=alice": { status: 200, body: personaState() } }).fn,
      null,
      "alice"
    );
    expect(hosts.state).toBeUndefined();
    const view = personaReducer(initialPersonaViewState, { type: "snapshot", snapshot: own, frameMark: 0 });
    expect(view.consoleThreadId).toBe("ta");
  });

  test("the console thread falls back to the listed thread on the console channel", () => {
    const threads = [summary("ts"), summary("tc", { channel: "console" })];
    expect(consoleThreadOf({ consoleThreadId: null, threads })).toBe("tc");
    expect(consoleThreadOf({ consoleThreadId: "tx", threads })).toBe("tx");
    expect(consoleThreadOf({ consoleThreadId: null, threads: [summary("ts")] })).toBeNull();
    expect(orderThreads(threads, consoleThreadOf({ consoleThreadId: null, threads })).map((t) => t.id)).toEqual(["tc", "ts"]);
  });

  test("a selected thread and the user both ride the messages call", async () => {
    const { fn, calls } = stubFetch({});
    await fetchPersonaSnapshot(fn, "t9", "alice");
    expect(calls.map((c) => c.url)).toContain("/api/persona/messages?threadId=t9&user=alice");
  });

  test("a People entry reads paused from either field", () => {
    expect(isUserPaused({ state: { paused: true } })).toBe(true);
    expect(isUserPaused({ state: { runState: "paused" } })).toBe(true);
    expect(isUserPaused({ state: { paused: false, runState: "idle" } })).toBe(false);
    expect(isUserPaused({ state: null })).toBe(false);
  });

  test("parseProjectList trims, dedupes and drops blanks", () => {
    expect(parseProjectList(" standup, billing-platform ,,standup\nother ")).toEqual(["standup", "billing-platform", "other"]);
    expect(parseProjectList("")).toEqual([]);
  });
});

describe("rendering helpers", () => {
  test("jobNote reads the optional note and ignores blanks", () => {
    expect(jobNote({ ...job("J1"), note: "waiting on CI" } as PersonaJob)).toBe("waiting on CI");
    expect(jobNote({ ...job("J1"), note: "  " } as PersonaJob)).toBeUndefined();
    expect(jobNote(job("J1"))).toBeUndefined();
  });
});

function summary(id: string, over: Partial<PersonaThreadSummary> = {}): PersonaThreadSummary {
  return {
    id,
    owner: "sam",
    channel: "slack",
    externalRef: `C42:1700000000.${id}`,
    audience: "shared",
    createdAt: "2026-10-04T15:00:00.000Z",
    updatedAt: "2026-10-04T15:00:00.000Z",
    messageCount: 0,
    ...over,
  };
}

describe("threads — switching, live merge, unread", () => {
  const consoleThread = summary(THREAD, { channel: "console", externalRef: undefined });
  const slack = summary("S1", {
    messageCount: 2,
    lastMessage: { seq: 2, role: "persona", text: "done", createdAt: "2026-10-04T16:02:00.000Z" },
    updatedAt: "2026-10-04T16:02:00.000Z",
  });
  const withThreads = (over: Partial<PersonaViewState> = {}) =>
    personaReducer(
      loaded({ consoleThreadId: THREAD, viewing: true, messages: [msg(1)], ...over }),
      { type: "threads", threads: [slack, consoleThread] }
    );

  test("selecting a thread parks the current one and restores it on return", () => {
    let s = withThreads();
    s = personaReducer(s, { type: "select", threadId: "S1" });
    expect(s.threadId).toBe("S1");
    expect(s.messages).toEqual([]);
    expect(s.others[THREAD].messages.map((m) => m.id)).toEqual(["m1"]);
    s = personaReducer(s, { type: "select", threadId: THREAD });
    expect(s.messages.map((m) => m.id)).toEqual(["m1"]);
    expect(s.others[THREAD]).toBeUndefined();
  });

  test("a thread's fetched messages merge into it even after switching away", () => {
    let s = personaReducer(withThreads(), { type: "select", threadId: "S1" });
    s = personaReducer(s, { type: "select", threadId: THREAD });
    s = personaReducer(s, {
      type: "threadMessages",
      response: { threadId: "S1", messages: [msg(1, { id: "s1", threadId: "S1" })] },
    });
    expect(s.messages.map((m) => m.id)).toEqual(["m1"]);
    expect(s.others.S1.messages.map((m) => m.id)).toEqual(["s1"]);
  });

  test("a frame for a non-selected thread updates its preview and marks it unread", () => {
    let s = personaReducer(withThreads(), { type: "select", threadId: "S1" });
    s = personaReducer(s, { type: "select", threadId: THREAD });
    expect(isThreadUnread(s.threads.find((t) => t.id === "S1")!, s)).toBe(false);
    s = personaReducer(s, {
      type: "frame",
      message: frame(
        "persona:message",
        msg(3, { id: "s3", threadId: "S1", text: "PR is up", createdAt: "2026-10-04T17:00:00.000Z" })
      ),
    });
    const row = s.threads.find((t) => t.id === "S1")!;
    expect(row.lastMessage?.text).toBe("PR is up");
    expect(row.messageCount).toBe(3);
    expect(isThreadUnread(row, s)).toBe(true);
    s = personaReducer(s, { type: "select", threadId: "S1" });
    expect(isThreadUnread(s.threads.find((t) => t.id === "S1")!, s)).toBe(false);
    expect(s.lastViewed.S1).toBe(3);
  });

  test("the owner's own message never reads as unread", () => {
    const s = personaReducer(withThreads(), {
      type: "frame",
      message: frame("persona:message", msg(3, { id: "s3", threadId: "S1", role: "user" })),
    });
    expect(isThreadUnread(s.threads.find((t) => t.id === "S1")!, s)).toBe(false);
  });

  test("messages arriving in the selected thread count as seen only while the view is open", () => {
    let s = personaReducer(withThreads({ viewing: false }), {
      type: "frame",
      message: frame("persona:message", msg(2)),
    });
    expect(s.lastViewed[THREAD] ?? 0).toBe(0);
    s = personaReducer(s, { type: "viewing", active: true });
    expect(s.lastViewed[THREAD]).toBe(2);
  });

  test("a message for a thread the list lacks flags the list stale; a reload clears it", () => {
    let s = personaReducer(withThreads(), {
      type: "frame",
      message: frame("persona:message", msg(1, { id: "n1", threadId: "NEW" })),
    });
    expect(s.threadsStale).toBe(true);
    s = personaReducer(s, { type: "threads", threads: [summary("NEW"), slack, consoleThread] });
    expect(s.threadsStale).toBe(false);
  });

  test("a thread list older than a live frame keeps the newer last message", () => {
    let s = personaReducer(withThreads(), {
      type: "frame",
      message: frame("persona:message", msg(5, { id: "s5", threadId: "S1", text: "newer" })),
    });
    s = personaReducer(s, { type: "threads", threads: [slack, consoleThread] });
    expect(s.threads.find((t) => t.id === "S1")?.lastMessage?.text).toBe("newer");
  });

  test("a send is queued on the selected thread and its POST response lands there after a switch", () => {
    let s = personaReducer(withThreads(), { type: "select", threadId: "S1" });
    s = personaReducer(s, { type: "queue", item: outboxItem("k1", "ship it", 2) });
    expect(s.outbox[0].threadId).toBe("S1");
    s = personaReducer(s, { type: "select", threadId: THREAD });
    s = personaReducer(s, {
      type: "sent",
      idempotencyKey: "k1",
      message: msg(3, { id: "s3", threadId: "S1", role: "user", text: "ship it" }),
    });
    expect(s.messages.map((m) => m.id)).toEqual(["m1"]);
    expect(s.others.S1.outbox).toEqual([]);
    expect(s.others.S1.messages.map((m) => m.id)).toEqual(["s3"]);
  });

  test("a failed send on a parked thread is still marked failed", () => {
    let s = personaReducer(withThreads(), { type: "select", threadId: "S1" });
    s = personaReducer(s, { type: "queue", item: outboxItem("k1", "ship it", 2) });
    s = personaReducer(s, { type: "select", threadId: THREAD });
    s = personaReducer(s, { type: "sendFailed", idempotencyKey: "k1", error: "boom" });
    expect(s.others.S1.outbox[0]).toMatchObject({ status: "failed", error: "boom" });
  });

  test("orderThreads puts the console thread first, synthesizing it when absent", () => {
    const older = summary("S0", { updatedAt: "2026-10-04T10:00:00.000Z" });
    expect(orderThreads([older, consoleThread, slack], THREAD).map((t) => t.id)).toEqual([
      THREAD,
      "S1",
      "S0",
    ]);
    const synthesized = orderThreads([slack], THREAD);
    expect(synthesized.map((t) => t.id)).toEqual([THREAD, "S1"]);
    expect(synthesized[0].channel).toBe("console");
  });

  test("threadLabel: console, DM, #channel from the title, external-ref fallback", () => {
    expect(threadLabel(consoleThread)).toBe("Console");
    expect(threadLabel({ channel: "slack", externalRef: "dm:D123" })).toBe("DM");
    expect(threadLabel({ channel: "slack", externalRef: "C42:1.2", title: "#eng" })).toBe("#eng");
    expect(threadLabel({ channel: "slack", externalRef: "C42:1.2", title: "eng" })).toBe("#eng");
    expect(threadLabel({ channel: "slack", externalRef: "C42:1.2", title: "Deploy plan" })).toBe(
      "Deploy plan"
    );
    expect(threadLabel({ channel: "slack", externalRef: "C42:1.2" })).toBe("#C42");
    expect(threadLabel({ channel: "slack" })).toBe("Slack thread");
  });

  test("audienceBadge marks each audience with an icon and a spoken label", () => {
    expect(audienceBadge("private")).toMatchObject({ icon: "\u{1F512}" });
    expect(audienceBadge("shared")).toMatchObject({ icon: "\u{1F465}" });
    expect(audienceBadge("external")).toMatchObject({ icon: "\u{1F310}" });
    expect(audienceBadge("private")?.label).toMatch(/^Private/);
    expect(audienceBadge("shared")?.label).toMatch(/^Shared/);
    expect(audienceBadge("external")?.label).toMatch(/^External/);
    expect(audienceBadge(undefined)).toBeUndefined();
  });

  test("the synthesized console row reads as private", () => {
    expect(orderThreads([slack], THREAD)[0].audience).toBe("private");
  });

  test("threadPreview flattens, clips, and marks the owner's own message", () => {
    expect(threadPreview(slack)).toBe("done");
    const long = summary("L", {
      lastMessage: { seq: 1, role: "user", text: "a\n\nb " + "x".repeat(100), createdAt: "x" },
    });
    const preview = threadPreview(long, 20);
    expect(preview.startsWith("You: a b x")).toBe(true);
    expect(preview.endsWith("…")).toBe(true);
    expect(threadPreview(summary("E"))).toBe("");
  });

  test("messagesPath addresses a thread, bare for the default", () => {
    expect(messagesPath()).toBe("/messages");
    expect(messagesPath("a b")).toBe("/messages?threadId=a%20b");
  });

  test("last-viewed seqs round-trip through storage and tolerate junk", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    saveLastViewed(storage, { S1: 3 });
    expect(loadLastViewed(storage)).toEqual({ S1: 3 });
    store.set("standup:personaLastViewed", "{not json");
    expect(loadLastViewed(storage)).toEqual({});
    store.set("standup:personaLastViewed", JSON.stringify({ S1: "x", S2: 4 }));
    expect(loadLastViewed(storage)).toEqual({ S2: 4 });
    expect(loadLastViewed(undefined)).toEqual({});
  });
});

describe("shared-thread composer warning", () => {
  test("shared and external threads warn that replies post to the channel; private ones don't", () => {
    expect(composerAudienceWarning({ audience: "shared", externalRef: "C42:1.2", title: "#eng" })).toBe(
      "Replies here are posted to #eng and visible to others in it."
    );
    expect(composerAudienceWarning({ audience: "shared", externalRef: "C42:1.2", title: "Deploy plan" })).toBe(
      "Replies here are posted to #C42 and visible to others in it."
    );
    expect(composerAudienceWarning({ audience: "external", externalRef: "CX:1.2", title: "acme" })).toBe(
      "Replies here are posted to #acme and visible to others in it, including people outside your workspace."
    );
    expect(composerAudienceWarning({ audience: "private", externalRef: "dm:D1" })).toBeUndefined();
    expect(composerAudienceWarning(undefined)).toBeUndefined();
  });

  test("the thread header names the thread and who can read it", () => {
    expect(threadHeaderLabel({ channel: "slack", audience: "shared", externalRef: "C42:1.2", title: "#eng" })).toBe(
      "#eng · Shared — everyone in the channel can read it"
    );
    expect(threadHeaderLabel({ channel: "slack", audience: "external", externalRef: "CX:1.2", title: "acme" })).toMatch(
      /^#acme · External/
    );
    expect(threadHeaderLabel({ channel: "slack", audience: "private", externalRef: "dm:D1" })).toBe("DM · Private");
    expect(threadHeaderLabel({ channel: "console", audience: "private" }, true)).toBe("Console");
  });
});
