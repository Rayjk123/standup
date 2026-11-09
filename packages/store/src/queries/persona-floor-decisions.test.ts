import { describe, expect, test } from "bun:test";
import { createStore } from "../store.js";
import { ensurePersonaFloorDecisionCheckColumn } from "../migrations.js";
import { listPersonaFloorDecisions, recordPersonaFloorDecision } from "../index.js";

describe("persona floor decisions", () => {
  const base = {
    owner: "me",
    askId: "ask-1",
    sessionId: "s1",
    gate: "safety_floor_owner",
    call: "git push origin HEAD",
    reason: "the owner asked for the push",
    decidedBy: "persona:me",
  };

  test("records an allow with every field and lists the owner's newest first", () => {
    const { db } = createStore();
    const first = recordPersonaFloorDecision(db, base);
    expect(first).toEqual({ ...base, id: expect.any(String), createdAt: expect.any(String) });
    const second = recordPersonaFloorDecision(db, {
      ...base,
      askId: "ask-2",
      jobId: "job-1",
      threadId: "thread-1",
      gate: "safety_floor",
      category: "destructive",
      call: "rm -rf /tmp/build",
    });
    expect(second).toMatchObject({ jobId: "job-1", threadId: "thread-1", category: "destructive" });
    recordPersonaFloorDecision(db, { ...base, owner: "someone-else", askId: "ask-3" });

    expect(listPersonaFloorDecisions(db, "me").map((d) => d.askId)).toEqual(["ask-2", "ask-1"]);
    expect(listPersonaFloorDecisions(db, "me", { jobId: "job-1" }).map((d) => d.askId)).toEqual(["ask-2"]);
    expect(listPersonaFloorDecisions(db, "me", { limit: 1 }).map((d) => d.askId)).toEqual(["ask-2"]);
    expect(listPersonaFloorDecisions(db, "nobody")).toEqual([]);
  });

  test("keeps the second check's flag on a flagged allow and leaves it off an unflagged one", () => {
    const { db } = createStore();
    const flagged = recordPersonaFloorDecision(db, { ...base, checkFlag: "the job never asked for a push" });
    expect(flagged.checkFlag).toBe("the job never asked for a push");
    recordPersonaFloorDecision(db, { ...base, askId: "ask-2" });
    const [plain, listed] = listPersonaFloorDecisions(db, "me");
    expect(plain).not.toHaveProperty("checkFlag");
    expect(listed).toMatchObject({ askId: "ask-1", checkFlag: "the job never asked for a push" });
  });

  test("an older database gains the check_flag column without losing its rows", () => {
    const { db } = createStore();
    recordPersonaFloorDecision(db, base);
    db.exec("ALTER TABLE persona_floor_decisions DROP COLUMN check_flag");
    ensurePersonaFloorDecisionCheckColumn(db);
    ensurePersonaFloorDecisionCheckColumn(db);
    expect(listPersonaFloorDecisions(db, "me").map((d) => d.askId)).toEqual(["ask-1"]);
    expect(recordPersonaFloorDecision(db, { ...base, askId: "ask-2", checkFlag: "x" }).checkFlag).toBe("x");
  });
});
