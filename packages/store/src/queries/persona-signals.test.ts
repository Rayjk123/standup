import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createStore } from "../store.js";
import {
  PERSONA_SIGNAL_CAPTURE_SETTING,
  PERSONA_SIGNAL_KINDS,
  appendPersonaMessage,
  createPersonaApproval,
  getOrCreatePersonaConsoleThread,
  getPersonaApproval,
  listPersonaMessages,
  listPersonaSignals,
  personaHoldReport,
  personaOptionReplyRecorded,
  personaOwnerActiveNear,
  personaSignalCaptureEnabled,
  recordPersonaSignal,
  setSetting,
} from "../index.js";
import type { PersonaSignalKind } from "../index.js";

const OWNER = "me";
const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

/** Inserts one approval row exactly as given, so times and statuses are deterministic. */
function approval(
  db: Database,
  opts: {
    rule?: string | null;
    action?: string;
    status: string;
    reason?: string;
    created?: number;
    decideAfterMin?: number;
    owner?: string;
  }
) {
  const id = crypto.randomUUID();
  const created = opts.created ?? 0;
  const decided = opts.decideAfterMin !== undefined ? at(created + opts.decideAfterMin) : null;
  db.run(
    `INSERT INTO persona_approvals (id, owner, action, summary, reason, hold_rule, args_json, status, decided_by, created_at, decided_at)
     VALUES (?, ?, ?, 's', ?, ?, '{}', ?, ?, ?, ?)`,
    [
      id,
      opts.owner ?? OWNER,
      opts.action ?? "approve_plan",
      opts.reason ?? null,
      opts.rule === undefined ? "hold-knob:approve_plan" : opts.rule,
      opts.status,
      decided ? OWNER : null,
      at(created),
      decided,
    ]
  );
  return id;
}

/** `approved` approvals then `denied` ones under `rule`, each decided a minute after it was raised. */
function decisions(db: Database, rule: string, approved: number, denied: number, action = "approve_plan") {
  for (let i = 0; i < approved; i++) approval(db, { rule, action, status: "executed", created: i * 10, decideAfterMin: 1 });
  for (let i = 0; i < denied; i++) approval(db, { rule, action, status: "denied", created: 1000 + i * 10, decideAfterMin: 1 });
}

const rowOf = (db: Database, rule: string) => personaHoldReport(db, OWNER).rows.find((r) => r.holdRule === rule);

describe("persona signals", () => {
  test("records and lists a signal with its structured value", () => {
    const { db } = createStore();
    const s = recordPersonaSignal(db, {
      owner: OWNER,
      kind: "option_reply",
      actor: "owner",
      subject: "ask_user",
      value: { optionIndex: 1, offMenu: false },
      messageId: "m1",
      threadId: "t1",
    })!;
    expect(s).toMatchObject({ kind: "option_reply", actor: "owner", audience: "private", value: { optionIndex: 1, offMenu: false } });
    expect(listPersonaSignals(db, OWNER)).toHaveLength(1);
    expect(listPersonaSignals(db, OWNER, { kind: "approval" })).toHaveLength(0);
    expect(listPersonaSignals(db, "someone-else")).toHaveLength(0);
    expect(personaOptionReplyRecorded(db, OWNER, "m1")).toBe(true);
    expect(personaOptionReplyRecorded(db, OWNER, "m2")).toBe(false);
  });

  test("list filters by kind and since (inclusive) together, oldest first, and stops at the limit", () => {
    const { db } = createStore();
    const rows: Array<[PersonaSignalKind, number]> = [
      ["approval", 0],
      ["option_reply", 10],
      ["approval", 20],
      ["approval", 30],
    ];
    for (const [kind, min] of rows) recordPersonaSignal(db, { owner: OWNER, kind, actor: "owner", value: { min }, occurredAt: at(min) });
    const mins = (opts: Parameters<typeof listPersonaSignals>[2]) => listPersonaSignals(db, OWNER, opts).map((s) => s.value.min);
    const cases: Array<[Parameters<typeof listPersonaSignals>[2], number[]]> = [
      [{}, [0, 10, 20, 30]],
      [{ since: at(10) }, [10, 20, 30]],
      [{ kind: "approval" }, [0, 20, 30]],
      [{ kind: "approval", since: at(10) }, [20, 30]],
      [{ kind: "approval", since: at(10), limit: 1 }, [20]],
      [{ since: at(31) }, []],
    ];
    for (const [opts, expected] of cases) expect([opts, mins(opts)]).toEqual([opts, expected]);
  });

  test("every kind in PERSONA_SIGNAL_KINDS passes the table's kind CHECK", () => {
    const { db } = createStore();
    for (const kind of PERSONA_SIGNAL_KINDS) recordPersonaSignal(db, { owner: OWNER, kind, actor: "system", value: {} });
    expect(listPersonaSignals(db, OWNER).map((s) => s.kind)).toEqual([...PERSONA_SIGNAL_KINDS]);
    expect(() => recordPersonaSignal(db, { owner: OWNER, kind: "bogus" as never, actor: "system", value: {} })).toThrow();
  });

  test("afterId pages strictly past a signal, ties on time included; another owner's id matches nothing", () => {
    const { db } = createStore();
    const ids = [0, 1, 2].map((n) => recordPersonaSignal(db, { owner: OWNER, kind: "approval", actor: "owner", value: { n }, occurredAt: at(5) })!.id);
    const other = recordPersonaSignal(db, { owner: "someone-else", kind: "approval", actor: "owner", value: {}, occurredAt: at(0) })!.id;
    const ns = (afterId: string) => listPersonaSignals(db, OWNER, { afterId }).map((s) => s.value.n);
    expect(ns(ids[0]!)).toEqual([1, 2]);
    expect(ns(ids[2]!)).toEqual([]);
    expect(ns(other)).toEqual([]);
  });

  test("a worker can never be a signal's actor", () => {
    const { db } = createStore();
    expect(() =>
      recordPersonaSignal(db, { owner: OWNER, kind: "approval", actor: "worker" as never, value: {} })
    ).toThrow();
    expect(listPersonaSignals(db, OWNER)).toHaveLength(0);
  });

  test("the capture switch off records nothing", () => {
    const { db } = createStore();
    expect(personaSignalCaptureEnabled(db)).toBe(true);
    setSetting(db, PERSONA_SIGNAL_CAPTURE_SETTING, "off");
    expect(personaSignalCaptureEnabled(db)).toBe(false);
    expect(recordPersonaSignal(db, { owner: OWNER, kind: "approval", actor: "owner", value: {} })).toBeNull();
    expect(listPersonaSignals(db, OWNER)).toHaveLength(0);
    setSetting(db, PERSONA_SIGNAL_CAPTURE_SETTING, "on");
    expect(recordPersonaSignal(db, { owner: OWNER, kind: "approval", actor: "owner", value: {} })).not.toBeNull();
  });

  test("owner activity near a time: their messages or other decisions within the window", () => {
    const { db } = createStore();
    const thread = getOrCreatePersonaConsoleThread(db, OWNER);
    appendPersonaMessage(db, { threadId: thread.id, role: "user", text: "hi", actor: OWNER });
    const sent = listPersonaMessages(db, thread.id)[0]!.createdAt;
    const sentMs = Date.parse(sent);
    expect(personaOwnerActiveNear(db, OWNER, new Date(sentMs + 4 * 60_000).toISOString(), 5 * 60_000)).toBe(true);
    expect(personaOwnerActiveNear(db, OWNER, new Date(sentMs + 6 * 60_000).toISOString(), 5 * 60_000)).toBe(false);
    // A Persona message is not the owner being active.
    appendPersonaMessage(db, { threadId: thread.id, role: "persona", text: "hello" });
    expect(personaOwnerActiveNear(db, OWNER, new Date(sentMs + 6 * 60_000).toISOString(), 5 * 60_000)).toBe(false);
    // Another decision counts; the approval itself doesn't.
    const self = approval(db, { status: "executed", created: 0, decideAfterMin: 1 });
    expect(personaOwnerActiveNear(db, OWNER, at(0), 5 * 60_000, self)).toBe(false);
    approval(db, { status: "denied", created: 0, decideAfterMin: 3 });
    expect(personaOwnerActiveNear(db, OWNER, at(0), 5 * 60_000, self)).toBe(true);
  });
});

describe("messages and approvals carry the new fields", () => {
  test("recommendedOption round-trips; out of range or without options it is dropped", () => {
    const { db } = createStore();
    const thread = getOrCreatePersonaConsoleThread(db, OWNER);
    const ok = appendPersonaMessage(db, { threadId: thread.id, role: "persona", text: "q", options: ["a", "b"], recommendedOption: 1 }).message;
    expect(ok.recommendedOption).toBe(1);
    const zero = appendPersonaMessage(db, { threadId: thread.id, role: "persona", text: "q", options: ["a", "b"], recommendedOption: 0 }).message;
    expect(zero.recommendedOption).toBe(0);
    const out = appendPersonaMessage(db, { threadId: thread.id, role: "persona", text: "q", options: ["a"], recommendedOption: 3 }).message;
    expect(out.recommendedOption).toBeUndefined();
    const none = appendPersonaMessage(db, { threadId: thread.id, role: "persona", text: "q", recommendedOption: 0 }).message;
    expect(none.recommendedOption).toBeUndefined();
    const plain = appendPersonaMessage(db, { threadId: thread.id, role: "persona", text: "q", options: ["a"] }).message;
    expect(plain.recommendedOption).toBeUndefined();
    expect(plain.options).toEqual(["a"]);
  });

  test("an options row written before 056 (no recommended_option) still parses", () => {
    const { db } = createStore();
    const thread = getOrCreatePersonaConsoleThread(db, OWNER);
    db.run(
      `INSERT INTO persona_messages (id, thread_id, seq, role, text, options_json, created_at)
       VALUES ('old', ?, 1, 'persona', 'q', '["yes","no"]', '2026-10-01T00:00:00.000Z')`,
      [thread.id]
    );
    const [m] = listPersonaMessages(db, thread.id);
    expect(m).toMatchObject({ id: "old", options: ["yes", "no"] });
    expect(m!.recommendedOption).toBeUndefined();
  });

  test("an approval stores its hold rule", () => {
    const { db } = createStore();
    const a = createPersonaApproval(db, { owner: OWNER, action: "remember", summary: "s", holdRule: "memory-owner-words", args: {} });
    expect(getPersonaApproval(db, a.id)!.holdRule).toBe("memory-owner-words");
    const b = createPersonaApproval(db, { owner: OWNER, action: "remember", summary: "s", args: {} });
    expect(getPersonaApproval(db, b.id)!.holdRule).toBeUndefined();
  });
});

describe("noisy-hold report", () => {
  test("4 decisions all approved is below the sample threshold: not flagged", () => {
    const { db } = createStore();
    decisions(db, "hold-knob:approve_plan", 4, 0);
    expect(rowOf(db, "hold-knob:approve_plan")).toMatchObject({ decided: 4, approved: 4, approveRate: 1, noisy: false });
  });

  test("5 decisions all approved: flagged", () => {
    const { db } = createStore();
    decisions(db, "hold-knob:approve_plan", 5, 0);
    expect(rowOf(db, "hold-knob:approve_plan")).toMatchObject({ decided: 5, approved: 5, noisy: true });
  });

  test("9 of 10 approved is exactly 90%: flagged; 8 of 10 is not", () => {
    const { db } = createStore();
    decisions(db, "hold-knob:approve_plan", 9, 1);
    decisions(db, "memory-owner-words", 8, 2, "remember");
    expect(rowOf(db, "hold-knob:approve_plan")).toMatchObject({ decided: 10, approved: 9, denied: 1, approveRate: 0.9, noisy: true });
    expect(rowOf(db, "memory-owner-words")).toMatchObject({ decided: 10, approved: 8, approveRate: 0.8, noisy: false });
  });

  test("owner-only floor categories, permission prompts and confirmation gates are never flagged, even at 100%", () => {
    const { db } = createStore();
    for (const rule of ["floor:outward", "floor:aws", "floor:collector-api", "floor:floor-tamper", "floor:unknown", "permission-prompt", "confirmation-gate"]) {
      decisions(db, rule, 20, 0, "answer_ask");
      const row = rowOf(db, rule)!;
      expect(row.approveRate).toBe(1);
      expect(row.noisy).toBe(false);
      expect(row.excluded).toBeTruthy();
    }
    // A category Persona may decide is still a candidate.
    decisions(db, "floor:destructive", 6, 0, "answer_ask");
    expect(rowOf(db, "floor:destructive")!.noisy).toBe(true);
  });

  test("pending, expired and superseded approvals are counted but never move the rate", () => {
    const { db } = createStore();
    decisions(db, "hold-knob:approve_plan", 5, 0);
    approval(db, { status: "pending" });
    approval(db, { status: "expired" });
    approval(db, { status: "expired" });
    approval(db, { status: "superseded" });
    expect(rowOf(db, "hold-knob:approve_plan")).toMatchObject({
      decided: 5,
      approveRate: 1,
      pending: 1,
      expired: 2,
      superseded: 1,
      noisy: true,
    });
  });

  test("a rule with only undecided approvals has no rate and no median", () => {
    const { db } = createStore();
    approval(db, { status: "expired" });
    expect(rowOf(db, "hold-knob:approve_plan")).toMatchObject({ decided: 0, approveRate: null, medianDecideMs: null, noisy: false });
  });

  test("failed-after-approval counts as approved; denials count against", () => {
    const { db } = createStore();
    approval(db, { status: "failed", decideAfterMin: 1 });
    approval(db, { status: "approved", decideAfterMin: 1 });
    approval(db, { status: "denied", decideAfterMin: 1 });
    expect(rowOf(db, "hold-knob:approve_plan")).toMatchObject({ decided: 3, approved: 2, denied: 1 });
  });

  test("median time to decide: odd and even counts", () => {
    const odd = createStore().db;
    for (const m of [1, 10, 3]) approval(odd, { status: "executed", decideAfterMin: m });
    expect(rowOf(odd, "hold-knob:approve_plan")!.medianDecideMs).toBe(3 * 60_000);
    const even = createStore().db;
    for (const m of [1, 10, 3, 5]) approval(even, { status: "executed", decideAfterMin: m });
    expect(rowOf(even, "hold-knob:approve_plan")!.medianDecideMs).toBe(4 * 60_000);
  });

  test("older approvals without a stored rule are attributed from their reason and marked inferred", () => {
    const { db } = createStore();
    approval(db, { rule: null, action: "remember", status: "executed", decideAfterMin: 1, reason: "the memory changes what agents may do on their own, and no message from the owner this turn asks to remember it in these words" });
    approval(db, { rule: "memory-owner-words", action: "remember", status: "executed", decideAfterMin: 1 });
    approval(db, { rule: null, action: "launch_session", status: "denied", decideAfterMin: 1, reason: "keep going (held: daily launch budget reached (20/20))" });
    approval(db, { rule: null, action: "send_to_session", status: "executed", decideAfterMin: 1, reason: "nothing recognizable" });
    const report = personaHoldReport(db, OWNER);
    expect(report.rows.find((r) => r.holdRule === "memory-owner-words")).toMatchObject({ decided: 2, inferred: true });
    expect(report.rows.find((r) => r.holdRule === "budget")).toMatchObject({ retired: true, inferred: true, noisy: false });
    expect(report.unattributed).toBe(1);
  });

  test("a retired rule is never flagged, whatever its rate", () => {
    const { db } = createStore();
    for (let i = 0; i < 10; i++) {
      approval(db, { rule: null, action: "send_to_session", status: "executed", decideAfterMin: 1, created: i, reason: 'the text names an outward-facing step ("git push")' });
    }
    expect(rowOf(db, "text:outward")).toMatchObject({ decided: 10, approveRate: 1, retired: true, noisy: false });
  });

  test("per-action breakdown, other owners' approvals left out, `since` bounds the window", () => {
    const { db } = createStore();
    decisions(db, "hold-knob:approve_plan", 3, 0, "approve_plan");
    approval(db, { status: "denied", action: "reject_plan", decideAfterMin: 1, created: 5000 });
    approval(db, { status: "executed", owner: "someone-else", decideAfterMin: 1 });
    const row = rowOf(db, "hold-knob:approve_plan")!;
    expect(row.decided).toBe(4);
    expect(row.actions).toEqual([
      { action: "approve_plan", decided: 3, approved: 3 },
      { action: "reject_plan", decided: 1, approved: 0 },
    ]);
    expect(row.lastAt).toBe(at(5000));
    const since = personaHoldReport(db, OWNER, { since: at(15) });
    expect(since.since).toBe(at(15));
    expect(since.rows.find((r) => r.holdRule === "hold-knob:approve_plan")!.decided).toBe(2);
  });

  test("noisy rows sort first; an empty history reports nothing; the report writes nothing", () => {
    const { db } = createStore();
    expect(personaHoldReport(db, OWNER)).toMatchObject({ rows: [], unattributed: 0, minSamples: 5, minApproveRate: 0.9 });
    decisions(db, "memory-owner-words", 10, 5, "remember");
    decisions(db, "hold-knob:approve_plan", 5, 0);
    const before = db.query("SELECT * FROM persona_approvals ORDER BY id").all();
    const report = personaHoldReport(db, OWNER);
    expect(report.rows.map((r) => r.holdRule)).toEqual(["hold-knob:approve_plan", "memory-owner-words"]);
    expect(db.query("SELECT * FROM persona_approvals ORDER BY id").all()).toEqual(before);
    expect(listPersonaSignals(db, OWNER)).toHaveLength(0);
  });
});
