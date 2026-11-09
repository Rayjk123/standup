import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { createPersonaJob, createStore, listPersonaScheduleRuns, updatePersonaJob } from "@standup/store";
import { resolvePersonaConfig } from "./config.js";
import { PersonaRuntime } from "./runtime.js";
import { createStubTurnRunner } from "./stub-turn.js";
import type { TurnInput } from "./turn.js";

const OWNER = "local";

/** Persona's runtime over the store at `path`, wired as the collector wires it, with scripted turns. */
function runtimeAt(path: string, prompts: string[]) {
  const store = createStore(path);
  const stub = createStubTurnRunner();
  const runtime = new PersonaRuntime({
    db: store.db,
    owner: OWNER,
    config: resolvePersonaConfig({}),
    broadcast: () => {},
    turnRunner: async (input: TurnInput) => {
      prompts.push(input.prompt);
      return stub(input);
    },
  });
  return { db: store.db, runtime };
}

describe("schedule watch through Persona's runtime", () => {
  const root = mkdtempSync(join("/tmp", "schedule-watch-runtime-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("no change: skipped with no turn; a job change: one turn whose prompt says what changed; then quiet again, across a restart", async () => {
    const path = join(root, "standup.db");
    const prompts: string[] = [];
    const first = runtimeAt(path, prompts);
    const job = createPersonaJob(first.db, { owner: OWNER, threadId: first.runtime.consoleThreadId(), title: "Reconcile demo job", goal: "demo" });
    const created = first.runtime.schedules.create(
      { title: "Job status reconcile", cron: "*/15 * * * *", timezone: "UTC", kind: "wake_persona", note: "Reconcile job status", watch: { kind: "jobs" } },
      { createdBy: OWNER }
    );
    if (!created.ok) throw new Error(created.error);
    const id = created.value.id;

    const quiet = await first.runtime.schedules.runNow(id, { approved: true });
    await first.runtime.drain();
    expect(quiet.ok && quiet.value.status).toBe("skipped");
    expect(quiet.ok && quiet.value.reason).toContain("no change");
    expect(prompts).toHaveLength(0);

    updatePersonaJob(first.db, job.id, { status: "waiting_user" });
    const woke = await first.runtime.schedules.runNow(id, { approved: true });
    await first.runtime.drain();
    expect(woke.ok && woke.value.status).toBe("running");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("What changed since its last wake:");
    expect(prompts[0]).toContain(`job ${job.id.slice(0, 8)} "Reconcile demo job": active → waiting_user`);
    first.db.close();

    const second = runtimeAt(path, prompts);
    const after = await second.runtime.schedules.runNow(id, { approved: true });
    await second.runtime.drain();
    expect(after.ok && after.value.status).toBe("skipped");
    expect(prompts).toHaveLength(1);
    const runs = listPersonaScheduleRuns(second.db, id).map((r) => `${r.status}${r.reason ? `: ${r.reason}` : ""}`);
    console.log(JSON.stringify({ schedule: second.runtime.schedules.get(id), runs, wakePrompt: prompts[0]!.split("\n").filter((l) => l.includes("schedule") || l.includes("changed") || l.includes("→")) }, null, 2));
    expect(second.runtime.schedules.get(id)!.watchSkips).toBe(2);
    second.db.close();
  });
});
