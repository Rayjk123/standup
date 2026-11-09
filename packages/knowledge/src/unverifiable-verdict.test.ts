import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { KnowledgeStore } from "./store.js";
import { searchKnowledge } from "./search.js";
import { isVerdictAdmissible } from "./relevance.js";
import {
  UNVERIFIABLE_VERDICT,
  isUncheckedVerdict,
  isVerdictEligibleForInjection,
  type DraftDispute,
  type KnowledgeDoc,
} from "./types.js";

function doc(id: string, title: string, body: string): KnowledgeDoc {
  return {
    id,
    projectId: "proj",
    slug: id,
    title,
    body,
    updatedAt: new Date("2026-10-01T00:00:00Z"),
    filePath: `/x/${id}.md`,
    originClass: "agent",
  };
}

describe("an unverifiable doc", () => {
  test("is admitted to injection and every surface, like an unverified one", () => {
    expect(isVerdictEligibleForInjection(UNVERIFIABLE_VERDICT)).toBe(true);
    for (const surface of ["inject", "search"] as const) {
      expect(isVerdictAdmissible({ verdict: UNVERIFIABLE_VERDICT }, surface)).toBe(true);
      expect(isVerdictAdmissible({ verdict: "superseded" }, surface)).toBe(false);
    }
    expect(isUncheckedVerdict(UNVERIFIABLE_VERDICT)).toBe(true);
    expect(isUncheckedVerdict("unverified")).toBe(true);
    expect(isUncheckedVerdict("disputed")).toBe(false);
  });

  test("is returned by an audience-gated search, with its verdict and repo note", async () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc("cadence", "Release cadence", "Releases go out on Thursdays after the integration run."));
    for (let i = 0; i < 5; i++) store.upsertDoc(doc(`f${i}`, `Filler ${i}`, `filler topic number ${i}`));
    const note: DraftDispute = {
      claim: "unverifiable: no repo for project proj",
      finding: "skipped",
      evidence: "projects.repos_json",
      origin: "repo",
    };
    store.setDocVerdict("proj", "cadence", UNVERIFIABLE_VERDICT, [note], null);

    const hits = await searchKnowledge(db, "proj", "release cadence thursdays", null, {
      limit: 5,
      audience: { projectId: "proj" },
    });
    const hit = hits.find((h) => h.slug === "cadence");
    expect(hit?.verdict).toBe(UNVERIFIABLE_VERDICT);
    expect(store.getDoc("proj", "cadence")?.disputes).toEqual([note]);
    expect(store.getDocVerdictRepo("proj", "cadence")).toBeNull();
  });

  test("setDocVerdict records the checkout a verdict was produced against, and keeps it when omitted", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc("d", "Doc", "body"));
    store.setDocVerdict("proj", "d", "disputed", [], "/repos/proj");
    expect(store.getDocVerdictRepo("proj", "d")).toBe("/repos/proj");
    store.setDocVerdict("proj", "d", "disputed", []);
    expect(store.getDocVerdictRepo("proj", "d")).toBe("/repos/proj");
    store.clearDocVerdict("proj", "d");
    expect(store.getDocVerdictRepo("proj", "d")).toBeNull();
  });
});
