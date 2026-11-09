import { describe, expect, test } from "bun:test";
import type { PersonaSchedule, PersonaState } from "@standup/shared";
import { initialPersonaViewState, type PersonaViewState } from "./persona";
import {
  blankScheduleForm,
  formToCreateRequest,
  formToUpdateRequest,
  nextRunLabel,
  scheduleAccess,
  scheduleToForm,
  validateScheduleForm,
  wallTimeIn,
} from "./schedules";

function withState(fields: Record<string, unknown>, over: Partial<PersonaViewState> = {}): PersonaViewState {
  const state = {
    owner: "alice",
    runState: "idle",
    threadId: "t1",
    epoch: 1,
    pendingInbox: 0,
    activeLaunches: 0,
    maxActiveLaunches: 6,
    hostAlias: "sam",
    ...fields,
  } as unknown as PersonaState;
  return { ...initialPersonaViewState, loaded: true, state, ...over };
}

describe("scheduleAccess", () => {
  test("a browser that can write its own Persona can write its schedules", () => {
    expect(scheduleAccess(withState({ isHost: false, canWrite: true }), "alice", null)).toEqual({ canWrite: true });
  });

  test("a guest who isn't signed in reads only, and is told to sign in as themselves", () => {
    expect(scheduleAccess(withState({ isHost: false, canWrite: false }), "alice", null)).toEqual({ canWrite: false, signInAs: "user" });
  });

  test("the host who isn't signed in is told to sign in as the owner", () => {
    const host = withState({ owner: "sam", isHost: true, canWrite: false });
    expect(scheduleAccess(host, "sam", null)).toEqual({ canWrite: false, signInAs: "owner" });
  });

  test("a schedule write refused `sign-in` makes the page read-only too", () => {
    expect(scheduleAccess(withState({ isHost: false, canWrite: true }), "alice", null, true)).toEqual({ canWrite: false, signInAs: "user" });
  });

  test("reads refused `sign-in` before any state loaded", () => {
    const refused: PersonaViewState = { ...initialPersonaViewState, loaded: true, forbidden: "To direct your Persona, sign in", forbiddenReason: "sign-in" };
    expect(scheduleAccess(refused, "alice", null)).toEqual({ canWrite: false, signInAs: "user" });
  });

  test("the host viewing another user's schedules only reads, with no sign-in prompt", () => {
    expect(scheduleAccess(withState({ owner: "sam", isHost: true, canWrite: true }), "sam", "alice")).toEqual({ canWrite: false });
  });

  test("a collector that predates per-user Persona says nothing about writes: writable", () => {
    expect(scheduleAccess(withState({}), "alice", null)).toEqual({ canWrite: true });
  });
});

const SCHEDULE: PersonaSchedule = {
  id: "s1",
  owner: "alice",
  title: "Nightly",
  cron: "0 1 * * *",
  timezone: "America/New_York",
  kind: "wake_persona",
  note: "n",
  enabled: true,
  overlap: "skip",
  catchUp: "run_once",
  runCount: 0,
  createdBy: "alice",
  createdAt: "2026-10-12T00:00:00.000Z",
  updatedAt: "2026-10-12T00:00:00.000Z",
  nextRunAt: "2026-10-13T05:00:00.000Z",
};

describe("schedule end bound in the form", () => {
  test("a stored endsAt shows as a wall time in the schedule's timezone; maxRuns as text", () => {
    const form = scheduleToForm({ ...SCHEDULE, endsAt: "2026-10-19T05:00:00.000Z", maxRuns: 7 });
    expect(form.endsAt).toBe("2026-10-19T01:00");
    expect(form.maxRuns).toBe("7");
    expect(scheduleToForm(SCHEDULE)).toMatchObject({ endsAt: "", maxRuns: "" });
    expect(wallTimeIn("2026-11-02T06:00:00.000Z", "America/New_York")).toBe("2026-11-02T01:00");
    expect(wallTimeIn("2026-10-19T00:30:00.000Z", "UTC")).toBe("2026-10-19T00:30");
  });

  test("create sends a set bound; blank leaves it out", () => {
    const form = { ...blankScheduleForm("UTC"), title: "t", note: "n", endsAt: "2026-10-19T01:00", maxRuns: "2" };
    expect(formToCreateRequest(form)).toMatchObject({ endsAt: "2026-10-19T01:00", maxRuns: 2 });
    const plain = formToCreateRequest({ ...form, endsAt: "", maxRuns: "" });
    expect("endsAt" in plain || "maxRuns" in plain).toBe(false);
  });

  test("update sends only a changed bound, and null for a cleared one", () => {
    const original = { ...SCHEDULE, endsAt: "2026-10-19T05:00:00.000Z", maxRuns: 7 };
    const form = scheduleToForm(original);
    expect(formToUpdateRequest(form, original)).toEqual({});
    expect(formToUpdateRequest({ ...form, maxRuns: "9" }, original)).toEqual({ maxRuns: 9 });
    expect(formToUpdateRequest({ ...form, endsAt: "", maxRuns: "" }, original)).toEqual({ endsAt: null, maxRuns: null });
    expect(formToUpdateRequest({ ...form, endsAt: "2026-10-26T01:00" }, original)).toEqual({ endsAt: "2026-10-26T01:00" });
    // A new timezone alone keeps the stored end instant; "07" for 7 is no change.
    expect(formToUpdateRequest({ ...form, timezone: "UTC" }, original)).toEqual({ timezone: "UTC" });
    expect(formToUpdateRequest({ ...form, maxRuns: "07" }, original)).toEqual({});
  });

  test("validation refuses a run limit that isn't a positive whole number", () => {
    const form = { ...blankScheduleForm("UTC"), title: "t", note: "n" };
    for (const maxRuns of ["0", "-1", "1.5", "two"]) expect(validateScheduleForm({ ...form, maxRuns })).toContain("Max runs");
    expect(validateScheduleForm({ ...form, maxRuns: "3" })).toBeNull();
    expect(validateScheduleForm({ ...form, endsAt: "soon" })).toContain("end time");
  });

  test("an ended schedule's next run reads ended", () => {
    const now = new Date("2026-10-12T15:00:00.000Z");
    const ended = { ...SCHEDULE, enabled: false, nextRunAt: undefined, endedAt: "2026-10-12T14:00:00.000Z", endReason: "max_runs" as const };
    expect(nextRunLabel(ended, now)).toEqual({ primary: "ended", secondary: "1h ago" });
    expect(nextRunLabel({ ...SCHEDULE, enabled: false, nextRunAt: undefined }, now)).toEqual({ primary: "paused" });
  });
});
