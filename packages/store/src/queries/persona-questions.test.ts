import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createStore } from "../store.js";
import { ensurePersonaQuestionAnsweredColumn, ensurePersonaReplyToColumn } from "../migrations.js";
import {
  appendPersonaMessage,
  clearPersonaJobOpenAsk,
  closePersonaJobQuestions,
  closePersonaQuestion,
  closePersonaQuestionsOfClosedJob,
  createPersonaJob,
  getOrCreatePersonaConsoleThread,
  getOrCreatePersonaThreadByRef,
  getPersonaJob,
  getPersonaMessage,
  listOpenPersonaQuestions,
  listPersonaMessages,
  listUnansweredPersonaQuestions,
  personaMessageAnswered,
  personaTappedQuestion,
  recordPersonaQuestionReply,
  setPersonaJobOpenAsk,
  syncPersonaJobOpenAsk,
  updatePersonaJob,
} from "./index.js";

const OWNER = "owner";

function setUp(path = ":memory:") {
  const store = createStore(path);
  const db = store.db;
  const thread = getOrCreatePersonaConsoleThread(db, OWNER).id;
  const ask = (options: string[], jobIds?: string[], threadId = thread) =>
    appendPersonaMessage(db, { threadId, role: "persona", text: `${options.join("/")}?`, options, jobIds }).message;
  const reply = (text: string, threadId = thread) =>
    appendPersonaMessage(db, { threadId, role: "user", text, actor: OWNER }).message;
  /** The ids of the thread's questions still open, oldest first. */
  const open = (threadId = thread) =>
    listPersonaMessages(db, threadId)
      .filter((m) => m.options && !m.answeredAt)
      .map((m) => m.id);
  return { store, db, thread, ask, reply, open };
}

describe("each ask_user question's own answered state", () => {
  test("two and three questions stay open together until each is answered", () => {
    const h = setUp();
    const a = h.ask(["A1", "A2"]);
    const b = h.ask(["B1", "B2"]);
    expect(h.open()).toEqual([a.id, b.id]);
    const c = h.ask(["C1"]);
    expect(h.open()).toEqual([a.id, b.id, c.id]);
  });

  test("a quick reply to the oldest answers only it", () => {
    const h = setUp();
    const a = h.ask(["A1", "A2"]);
    const b = h.ask(["B1"]);
    const c = h.ask(["C1"]);
    const r = h.reply("A2");
    const closed = recordPersonaQuestionReply(h.db, OWNER, h.thread, { seq: r.seq, replyToMessageId: a.id });
    expect(closed.map((m) => m.id)).toEqual([a.id]);
    expect(closed[0].answeredAt).toBeString();
    expect(h.open()).toEqual([b.id, c.id]);
    // Answering it again changes nothing.
    expect(recordPersonaQuestionReply(h.db, OWNER, h.thread, { seq: r.seq, replyToMessageId: a.id })).toEqual([]);
  });

  test("a typed, untagged message closes nothing, not even the lone open question", () => {
    const h = setUp();
    const a = h.ask(["A1"]);
    expect(recordPersonaQuestionReply(h.db, OWNER, h.thread, { seq: h.reply("also, can you rebase my branch?").seq })).toEqual([]);
    expect(h.open()).toEqual([a.id]);
    const b = h.ask(["B1"]);
    expect(recordPersonaQuestionReply(h.db, OWNER, h.thread, { seq: h.reply("hmm").seq })).toEqual([]);
    expect(h.open()).toEqual([a.id, b.id]);
  });

  test("a reply tagged with a job answers that job's questions only, oldest first", () => {
    const h = setUp();
    const ja = createPersonaJob(h.db, { owner: OWNER, threadId: h.thread, title: "a", goal: "g" });
    const jb = createPersonaJob(h.db, { owner: OWNER, threadId: h.thread, title: "b", goal: "g" });
    const a1 = h.ask(["A1"], [ja.id]);
    const b = h.ask(["B1"], [jb.id]);
    const a2 = h.ask(["A2"], [ja.id]);
    const closed = recordPersonaQuestionReply(h.db, OWNER, h.thread, { seq: h.reply("about a").seq, jobId: ja.id });
    expect(closed.map((m) => m.id)).toEqual([a1.id, a2.id]);
    expect(h.open()).toEqual([b.id]);
  });

  test("a reply tagged with a job also answers that job's questions asked in the owner's other threads", () => {
    const h = setUp();
    const dm = getOrCreatePersonaThreadByRef(h.db, OWNER, "slack", "D1").id;
    const job = createPersonaJob(h.db, { owner: OWNER, threadId: h.thread, title: "a", goal: "g" });
    const inDm = h.ask(["A1"], [job.id], dm);
    const closed = recordPersonaQuestionReply(h.db, OWNER, h.thread, { seq: h.reply("go with A1").seq, jobId: job.id });
    expect(closed.map((m) => m.id)).toEqual([inDm.id]);
    expect(h.open(dm)).toEqual([]);
  });

  test("a tap naming an option the question doesn't have closes nothing", () => {
    const h = setUp();
    const a = h.ask(["A1", "A2"]);
    const r = h.reply("A9");
    expect(recordPersonaQuestionReply(h.db, OWNER, h.thread, { seq: r.seq, replyToMessageId: a.id, optionIndex: 9 })).toEqual([]);
    expect(recordPersonaQuestionReply(h.db, OWNER, h.thread, { seq: r.seq, replyToMessageId: a.id, optionIndex: -1 })).toEqual([]);
    expect(h.open()).toEqual([a.id]);
    expect(recordPersonaQuestionReply(h.db, OWNER, h.thread, { seq: r.seq, replyToMessageId: a.id, optionIndex: 1 })).toHaveLength(1);
  });

  test("a quick reply naming another thread's or owner's question closes nothing", () => {
    const h = setUp();
    const slack = getOrCreatePersonaThreadByRef(h.db, OWNER, "slack", "C1:1").id;
    const elsewhere = h.ask(["X"], undefined, slack);
    const a = h.ask(["A1"]);
    expect(recordPersonaQuestionReply(h.db, OWNER, h.thread, { seq: h.reply("X").seq, replyToMessageId: elsewhere.id })).toEqual([]);
    expect(h.open()).toEqual([a.id]);
    expect(h.open(slack)).toEqual([elsewhere.id]);
    expect(recordPersonaQuestionReply(h.db, "someone", slack, { seq: 99, replyToMessageId: elsewhere.id })).toEqual([]);
    expect(h.open(slack)).toEqual([elsewhere.id]);
  });

  test("closePersonaQuestion closes one question of its thread and moves the job on to its next open one", () => {
    const h = setUp();
    const slack = getOrCreatePersonaThreadByRef(h.db, OWNER, "slack", "C1:1").id;
    const job = createPersonaJob(h.db, { owner: OWNER, threadId: h.thread, title: "a", goal: "g" });
    const first = h.ask(["A1"], [job.id]);
    const second = h.ask(["A2"], [job.id]);
    const other = h.ask(["B"]);
    const elsewhere = h.ask(["X"], undefined, slack);
    setPersonaJobOpenAsk(h.db, job.id, second.id);
    // Only an open question of this owner's thread.
    expect(closePersonaQuestion(h.db, OWNER, h.thread, elsewhere.id)).toBeNull();
    expect(closePersonaQuestion(h.db, "someone", h.thread, other.id)).toBeNull();
    expect(closePersonaQuestion(h.db, OWNER, h.thread, "nope")).toBeNull();

    const closed = closePersonaQuestion(h.db, OWNER, h.thread, second.id)!;
    expect(closed.message.answeredAt).toBeString();
    expect(closed.jobIds).toEqual([job.id]);
    // The job still has `first` open, so it still needs the owner, about that one.
    expect(getPersonaJob(h.db, job.id)!.view!.needs).toEqual(["question"]);
    expect(h.open()).toEqual([first.id, other.id]);
    expect(closePersonaQuestion(h.db, OWNER, h.thread, second.id)).toBeNull();

    expect(closePersonaQuestion(h.db, OWNER, h.thread, first.id)!.jobIds).toEqual([job.id]);
    expect(getPersonaJob(h.db, job.id)!.view!.needs ?? []).not.toContain("question");
  });

  test("syncPersonaJobOpenAsk points a job with no open question recorded at its newest open one", () => {
    const h = setUp();
    const job = createPersonaJob(h.db, { owner: OWNER, threadId: h.thread, title: "a", goal: "g" });
    expect(syncPersonaJobOpenAsk(h.db, job.id)).toBe(false);
    h.ask(["A1"], [job.id]);
    const newest = h.ask(["A2"], [job.id]);
    expect(syncPersonaJobOpenAsk(h.db, job.id)).toBe(true);
    expect(getPersonaJob(h.db, job.id)!.view!.needs).toEqual(["question"]);
    // One already recorded is left alone.
    expect(syncPersonaJobOpenAsk(h.db, job.id)).toBe(false);
    clearPersonaJobOpenAsk(h.db, job.id);
    closePersonaQuestion(h.db, OWNER, h.thread, newest.id);
    updatePersonaJob(h.db, job.id, { status: "done", outcome: "ok" });
    expect(syncPersonaJobOpenAsk(h.db, job.id)).toBe(false);
  });

  test("listOpenPersonaQuestions lists a thread's newest open questions, oldest first", () => {
    const h = setUp();
    h.ask(["A"]);
    const b = h.ask(["B"]);
    const c = h.ask(["C"]);
    h.ask(["D"]);
    closePersonaQuestion(h.db, OWNER, h.thread, b.id);
    expect(listOpenPersonaQuestions(h.db, h.thread).map((m) => m.text)).toEqual(["A?", "C?", "D?"]);
    expect(listOpenPersonaQuestions(h.db, h.thread, 2).map((m) => m.text)).toEqual(["C?", "D?"]);
    expect(listOpenPersonaQuestions(h.db, h.thread, 2)[0]!.id).toBe(c.id);
  });

  test("Persona setting a job's questions aside, or closing the job, closes them", () => {
    const h = setUp();
    const ja = createPersonaJob(h.db, { owner: OWNER, threadId: h.thread, title: "a", goal: "g" });
    const jb = createPersonaJob(h.db, { owner: OWNER, threadId: h.thread, title: "b", goal: "g" });
    const a = h.ask(["A1"], [ja.id]);
    const both = h.ask(["AB"], [ja.id, jb.id]);
    const b = h.ask(["B1"], [jb.id]);
    expect(closePersonaJobQuestions(h.db, ja.id).map((m) => m.id)).toEqual([a.id, both.id]);
    expect(h.open()).toEqual([b.id]);

    const h2 = setUp();
    const jc = createPersonaJob(h2.db, { owner: OWNER, threadId: h2.thread, title: "c", goal: "g" });
    const jd = createPersonaJob(h2.db, { owner: OWNER, threadId: h2.thread, title: "d", goal: "g" });
    const c = h2.ask(["C1"], [jc.id]);
    const cd = h2.ask(["CD"], [jc.id, jd.id]);
    updatePersonaJob(h2.db, jc.id, { status: "done", outcome: "ok" });
    // The question also about the open job keeps its quick replies.
    expect(closePersonaQuestionsOfClosedJob(h2.db, jc.id).map((m) => m.id)).toEqual([c.id]);
    expect(h2.open()).toEqual([cd.id]);
    updatePersonaJob(h2.db, jd.id, { status: "cancelled" });
    expect(closePersonaQuestionsOfClosedJob(h2.db, jd.id).map((m) => m.id)).toEqual([cd.id]);
  });

  test("the answered state persists across a reopen of the database", () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/persona-questions-${crypto.randomUUID()}`;
    const path = `${dir}.db`;
    const h = setUp(path);
    const a = h.ask(["A1"]);
    const b = h.ask(["B1"]);
    recordPersonaQuestionReply(h.db, OWNER, h.thread, { seq: h.reply("A1").seq, replyToMessageId: a.id });
    h.store.db.close();
    const reopened = createStore(path);
    expect(getPersonaMessage(reopened.db, a.id)!.answeredAt).toBeString();
    expect(getPersonaMessage(reopened.db, b.id)!.answeredAt).toBeUndefined();
    reopened.db.close();
  });

  test("the morning brief's unanswered list follows each question's own state", () => {
    const h = setUp();
    const a = h.ask(["A1"]);
    const b = h.ask(["B1"]);
    recordPersonaQuestionReply(h.db, OWNER, h.thread, { seq: h.reply("A1").seq, replyToMessageId: a.id });
    expect(listUnansweredPersonaQuestions(h.db, OWNER, "2000-01-01T00:00:00.000Z").map((m) => m.id)).toEqual([b.id]);
  });
});

describe("persona_messages.answered_at backfill", () => {
  test("a question an owner message followed, or whose jobs all closed, starts answered; the rest stay open", () => {
    const h = setUp();
    // Someone else in the thread (a Slack channel) answers nothing.
    const byOther = h.ask(["Z"]);
    appendPersonaMessage(h.db, { threadId: h.thread, role: "user", text: "z", actor: "a-colleague" });
    // A job whose open question the owner then followed up on.
    const followedJob = createPersonaJob(h.db, { owner: OWNER, threadId: h.thread, title: "f", goal: "g" });
    const followed = h.ask(["A"], [followedJob.id]);
    setPersonaJobOpenAsk(h.db, followedJob.id, followed.id);
    // And a job whose only question was followed up on.
    const settledJob = createPersonaJob(h.db, { owner: OWNER, threadId: h.thread, title: "s", goal: "g" });
    const settled = h.ask(["S"], [settledJob.id]);
    setPersonaJobOpenAsk(h.db, settledJob.id, settled.id);
    h.reply("A");
    // followedJob asked again after that reply; its open ask still names the old question.
    const again = h.ask(["A2"], [followedJob.id]);
    const done = createPersonaJob(h.db, { owner: OWNER, threadId: h.thread, title: "d", goal: "g" });
    const live = createPersonaJob(h.db, { owner: OWNER, threadId: h.thread, title: "l", goal: "g" });
    const ofDone = h.ask(["B"], [done.id]);
    const ofLive = h.ask(["C"], [live.id]);
    setPersonaJobOpenAsk(h.db, live.id, ofLive.id);
    const untagged = h.ask(["D"]);
    updatePersonaJob(h.db, done.id, { status: "done", outcome: "ok" });
    // The shape before the column: drop it and let the repair add and backfill it.
    h.db.exec("ALTER TABLE persona_messages DROP COLUMN answered_at");
    ensurePersonaQuestionAnsweredColumn(h.db);
    // Read fresh: a cached SELECT * keeps the column list it was first prepared with.
    const answeredAt = (id: string) =>
      (h.db.prepare("SELECT answered_at FROM persona_messages WHERE id = ?").get(id) as { answered_at: string | null }).answered_at;
    expect(answeredAt(followed.id)).toBeString();
    // The owner's later "A" followed it too.
    expect(answeredAt(byOther.id)).toBe(answeredAt(followed.id));
    expect(answeredAt(ofDone.id)).toBeString();
    expect(answeredAt(ofLive.id)).toBeNull();
    expect(answeredAt(untagged.id)).toBeNull();
    // A job no longer points at a question that now counts as answered: it
    // moves on to its newest open one, or to none; one still open keeps it.
    const openAsk = (jobId: string) =>
      (h.db.prepare("SELECT open_ask_message_id AS id FROM persona_jobs WHERE id = ?").get(jobId) as { id: string | null }).id;
    expect(answeredAt(again.id)).toBeNull();
    expect(openAsk(followedJob.id)).toBe(again.id);
    expect(openAsk(settledJob.id)).toBeNull();
    expect(openAsk(live.id)).toBe(ofLive.id);
    // Idempotent: a second run leaves later answers alone.
    ensurePersonaQuestionAnsweredColumn(h.db);
    expect(answeredAt(ofLive.id)).toBeNull();
  });

  test("a database without persona_messages is left alone", () => {
    const db = new Database(":memory:");
    ensurePersonaQuestionAnsweredColumn(db);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'persona_messages'").get()).toBeNull();
  });
});

describe("persona questions — the question a tap answers", () => {
  test.each([
    ["an option of a question in the thread", "q", 1, true],
    ["an index past its options", "q", 2, false],
    ["a negative index", "q", -1, false],
    ["a fractional index", "q", 0.5, false],
    ["a message without options", "plain", 0, false],
    ["a question of another thread", "elsewhere", 0, false],
    ["an unknown message", "missing", 0, false],
  ] as const)("personaTappedQuestion: %s", (_label, target, optionIndex, found) => {
    const h = setUp();
    const other = getOrCreatePersonaThreadByRef(h.db, OWNER, "slack", "D1:1.0", "dm", "private").id;
    const ids: Record<string, string> = {
      q: h.ask(["A", "B"]).id,
      plain: appendPersonaMessage(h.db, { threadId: h.thread, role: "persona", text: "fyi" }).message.id,
      elsewhere: h.ask(["A"], undefined, other).id,
      missing: "no-such-id",
    };
    const question = personaTappedQuestion(h.db, h.thread, { messageId: ids[target]!, optionIndex });
    expect(question?.id ?? null).toBe(found ? ids[target]! : null);
  });

  test("personaMessageAnswered: a tap answers the question tapped, a typed reply Persona's message before it", () => {
    const h = setUp();
    const older = h.ask(["Yes", "No"]);
    const newer = h.ask(["Yes", "Later"]);
    const tap = appendPersonaMessage(h.db, { threadId: h.thread, role: "user", text: "Yes", actor: OWNER, replyToMessageId: older.id }).message;
    const typed = h.reply("Yes");
    expect(getPersonaMessage(h.db, tap.id)?.replyToMessageId).toBe(older.id);
    expect(typed.replyToMessageId).toBeUndefined();
    expect(personaMessageAnswered(h.db, tap)?.id).toBe(older.id);
    expect(personaMessageAnswered(h.db, typed)?.id).toBe(newer.id);
  });

  test("ensurePersonaReplyToColumn adds the column once and leaves a database without persona_messages alone", () => {
    const h = setUp();
    h.db.exec("ALTER TABLE persona_messages DROP COLUMN reply_to_id");
    ensurePersonaReplyToColumn(h.db);
    ensurePersonaReplyToColumn(h.db);
    const columns = (h.db.query("PRAGMA table_info(persona_messages)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns.filter((c) => c === "reply_to_id")).toHaveLength(1);
    const bare = new Database(":memory:");
    ensurePersonaReplyToColumn(bare);
    expect(bare.query("SELECT name FROM sqlite_master WHERE name = 'persona_messages'").get()).toBeNull();
  });
});
