import { describe, expect, test } from "bun:test";
import { isRoutineCheckpoint, knowledgeChangeLine, digestHeadline } from "./feed.js";
import type { Digest, KnowledgeChange } from "./types.js";

describe("isRoutineCheckpoint", () => {
  test("only structural checkpoints are routine", () => {
    expect(isRoutineCheckpoint("structural")).toBe(true);
    expect(isRoutineCheckpoint("self-reported")).toBe(false);
    expect(isRoutineCheckpoint("auto")).toBe(false);
  });
});

describe("knowledgeChangeLine", () => {
  const change = (over: Partial<KnowledgeChange>): KnowledgeChange => ({
    id: "kc1",
    projectId: "p",
    slug: "runtime",
    kind: "accepted",
    title: "Runtime",
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  });

  test("accepted names the doc", () => {
    expect(knowledgeChangeLine(change({ kind: "accepted", title: "Runtime" }))).toContain(
      "Knowledge accepted — Runtime",
    );
  });

  test("contradiction lists the opposing docs but not the subject's own slug", () => {
    const line = knowledgeChangeLine(
      change({ kind: "contradiction", slug: "runtime", contradicted: ["runtime", "uses-node"] }),
    );
    expect(line).toContain("conflict");
    expect(line).toContain("uses-node");
    expect(line).not.toContain("with runtime");
  });

  test("removed / reconciled / distilled each render their own verb", () => {
    expect(knowledgeChangeLine(change({ kind: "removed" }))).toContain("removed");
    expect(knowledgeChangeLine(change({ kind: "reconciled" }))).toContain("reconciled");
    expect(knowledgeChangeLine(change({ kind: "distilled" }))).toContain("distilled");
  });

  test("falls back to the slug when the title is empty", () => {
    expect(knowledgeChangeLine(change({ title: "", slug: "runtime" }))).toContain("runtime");
  });
});

describe("digestHeadline", () => {
  const digest = (over: Partial<Digest> = {}): Digest => ({
    id: "digest:2026-01-15",
    createdAt: "2026-01-15T14:30:00Z",
    periodStart: "2026-01-14T14:30:00Z",
    periodEnd: "2026-01-15T14:30:00Z",
    body: "body",
    projects: ["web"],
    counts: { projects: 1, activeWork: 0, taskRuns: 1, checkpoints: 0, knowledgeChanges: 0, asks: 0, launches: 0 },
    ...over,
  });

  test("names the date and project count", () => {
    const line = digestHeadline(digest());
    expect(line).toContain("2026-01-15");
    expect(line).toContain("1 project");
  });

  test("pluralizes the project count", () => {
    const line = digestHeadline(
      digest({ counts: { projects: 3, activeWork: 0, taskRuns: 0, checkpoints: 0, knowledgeChanges: 0, asks: 0, launches: 0 } })
    );
    expect(line).toContain("3 projects");
  });

  test("a quiet day (zero projects) reads as such", () => {
    const line = digestHeadline(
      digest({ projects: [], counts: { projects: 0, activeWork: 0, taskRuns: 0, checkpoints: 0, knowledgeChanges: 0, asks: 0, launches: 0 } })
    );
    expect(line.toLowerCase()).toContain("quiet day");
  });
});
