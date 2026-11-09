import { describe, expect, test } from "bun:test";
import { createStore } from "../store.js";
import { listPersonaKnowledgeDecisions, recordPersonaKnowledgeDecision } from "../index.js";

describe("persona knowledge decisions", () => {
  const base = {
    owner: "me",
    projectId: "p",
    draftSlug: "deploys",
    title: "Deploys",
    decision: "accept" as const,
    mode: "new" as const,
    edited: false,
    reason: "checked",
  };

  test("records a decision with every field and lists it newest first", () => {
    const { db } = createStore();
    const first = recordPersonaKnowledgeDecision(db, base);
    expect(first).toMatchObject({ ...base, id: expect.any(String), createdAt: expect.any(String) });
    expect(first.targetSlug).toBeUndefined();
    expect(first.editedBody).toBeUndefined();
    const second = recordPersonaKnowledgeDecision(db, {
      ...base,
      projectId: "q",
      draftSlug: "deploys-v2",
      targetSlug: "deploys",
      mode: "replace",
      edited: true,
      editedBody: "new text",
      verdict: "clean",
      generatedByLaunchId: "l1",
      threadId: "t1",
    });
    expect(second).toMatchObject({ targetSlug: "deploys", mode: "replace", edited: true, editedBody: "new text", verdict: "clean", generatedByLaunchId: "l1", threadId: "t1" });
    expect(listPersonaKnowledgeDecisions(db, "me").map((d) => d.id)).toEqual([second.id, first.id]);
    expect(listPersonaKnowledgeDecisions(db, "me", { projectId: "p" }).map((d) => d.id)).toEqual([first.id]);
    expect(listPersonaKnowledgeDecisions(db, "someone-else")).toEqual([]);
    expect(listPersonaKnowledgeDecisions(db, "me", { limit: 1 })).toHaveLength(1);
  });

  test("decision and mode are constrained", () => {
    const { db } = createStore();
    expect(() => recordPersonaKnowledgeDecision(db, { ...base, decision: "maybe" as never })).toThrow();
    expect(() => recordPersonaKnowledgeDecision(db, { ...base, mode: "merge" as never })).toThrow();
  });
});
