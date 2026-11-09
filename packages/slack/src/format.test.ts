import { describe, expect, test } from "bun:test";
import type { Ask, Checkpoint, Digest, KnowledgeChange, PlanApproval, WsMessage } from "@standup/shared";
import {
  feedLine,
  planMessage,
  planResolvedBlocks,
  askMessage,
  answeredBlocks,
  closedBlocks,
  answeredElsewhereNote,
  activityMessage,
  PLAN_ACTION_PREFIX,
  type PlanActionValue,
} from "./format.js";
import type { ActiveWorkItem } from "./collector-client.js";

/** Every section block's text — the thing Slack hard-caps at 3000 chars. */
function sectionTexts(blocks: unknown[]): string[] {
  return (blocks as { type: string; text?: { text?: string } }[])
    .filter((b) => b.type === "section")
    .map((b) => b.text?.text ?? "");
}
/** Every context element's text — Slack rejects an over-3000-char element the same way. */
function contextTexts(blocks: unknown[]): string[] {
  return (blocks as { type: string; elements?: { text?: string }[] }[])
    .filter((b) => b.type === "context")
    .flatMap((b) => (b.elements ?? []).map((e) => e.text ?? ""));
}
const SLACK_SECTION_LIMIT = 3000;

const knowledgeMsg = (over: Partial<KnowledgeChange>): WsMessage => ({
  type: "knowledge:change",
  payload: {
    id: "kc1",
    projectId: "widgets",
    slug: "runtime",
    kind: "accepted",
    title: "Runtime",
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  } satisfies KnowledgeChange,
  timestamp: "2026-01-01T00:00:00Z",
});

describe("feedLine knowledge-graph changes", () => {
  test("an accepted doc produces a feed line naming the doc", () => {
    const line = feedLine(knowledgeMsg({ kind: "accepted", title: "Runtime" }), undefined);
    expect(line).toContain("Knowledge accepted");
    expect(line).toContain("Runtime");
  });

  test("a flagged contradiction produces a conflict line naming the opposing docs", () => {
    const line = feedLine(
      knowledgeMsg({ kind: "contradiction", slug: "runtime", title: "Runtime", contradicted: ["runtime", "uses-node"] }),
      undefined
    );
    expect(line).toContain("conflict");
    expect(line).toContain("uses-node");
    // The subject's own slug is not listed as a doc it conflicts with.
    expect(line).not.toContain("runtime,");
  });

  test("removed / reconciled / distilled each surface a line", () => {
    expect(feedLine(knowledgeMsg({ kind: "removed" }), undefined)).toContain("removed");
    expect(feedLine(knowledgeMsg({ kind: "reconciled" }), undefined)).toContain("reconciled");
    expect(feedLine(knowledgeMsg({ kind: "distilled" }), undefined)).toContain("distilled");
  });
});

const digestMsg = (over: Partial<Digest> = {}): WsMessage => ({
  type: "digest:posted",
  payload: {
    id: "digest:2026-01-15",
    createdAt: "2026-01-15T14:30:00Z",
    periodStart: "2026-01-14T14:30:00Z",
    periodEnd: "2026-01-15T14:30:00Z",
    body: "## web\n- shipped the digest cron",
    projects: ["web"],
    counts: { projects: 1, activeWork: 0, taskRuns: 1, checkpoints: 0, knowledgeChanges: 0, asks: 0, launches: 0 },
    ...over,
  } satisfies Digest,
  timestamp: "2026-01-15T14:30:00Z",
});

describe("feedLine daily digest", () => {
  test("renders a headline over the summary body", () => {
    const line = feedLine(digestMsg(), undefined)!;
    expect(line).toContain("Morning digest");
    expect(line).toContain("2026-01-15");
    expect(line).toContain("1 project");
    expect(line).toContain("shipped the digest cron");
  });

  test("a huge body is capped under Slack's section limit", () => {
    const line = feedLine(digestMsg({ body: "x".repeat(6000) }), undefined)!;
    expect(line.length).toBeLessThanOrEqual(SLACK_SECTION_LIMIT);
  });
});

const checkpointMsg = (source: Checkpoint["source"], summary: string): WsMessage => ({
  type: "checkpoint:new",
  payload: {
    id: "c1",
    sessionId: "s1",
    source,
    summary,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  } satisfies Checkpoint,
  timestamp: "2026-01-01T00:00:00Z",
});

describe("feedLine checkpoint classification", () => {
  test("suppresses routine structural ticks", () => {
    expect(feedLine(checkpointMsg("structural", "Completed: wire it"), "sess")).toBeNull();
  });

  test("surfaces deliberate self-reported and auto checkpoints", () => {
    expect(feedLine(checkpointMsg("self-reported", "Shipped the fix"), "sess")).toContain(
      "Shipped the fix",
    );
    expect(feedLine(checkpointMsg("auto", "✓ Done — tests green"), "sess")).toContain(
      "Done",
    );
  });

  test("caps a long session title so a feed line never becomes a wall of text", () => {
    const line = feedLine(checkpointMsg("self-reported", "did stuff"), "x".repeat(400))!;
    expect(line).toContain("…");
    // The title portion is truncated well under its 120-char cap, so the whole
    // line can't carry the full 400-char title.
    expect((line.match(/x/g) ?? []).length).toBeLessThanOrEqual(120);
  });
});

const plan = (over: Partial<PlanApproval> = {}): PlanApproval => ({
  id: "p1",
  launchId: "l1",
  projectId: "widgets",
  worktreePath: "/tmp/wt",
  status: "awaiting_approval",
  relevantFiles: ["src/a.ts"],
  plan: "Refactor the widget",
  acceptanceCriterion: "bun test",
  criterionMet: false,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  ...over,
});

describe("planMessage — owner-routed plan approval", () => {
  test("carries the plan, criterion, and Approve/Reject buttons with the plan id", () => {
    const { text, blocks } = planMessage(plan(), "http://web.local", "U123");
    expect(text).toContain("Plan awaiting approval");
    // @-mentions the owner so the attention actually reaches them.
    expect(JSON.stringify(blocks)).toContain("<@U123>");
    expect(JSON.stringify(blocks)).toContain("Refactor the widget");
    expect(JSON.stringify(blocks)).toContain("bun test");
    expect(JSON.stringify(blocks)).toContain("http://web.local");

    const actions = blocks.find((b) => b.type === "actions") as { elements: { action_id: string; value: string }[] };
    const decisions = actions.elements.map((e) => (JSON.parse(e.value) as PlanActionValue).decision).sort();
    expect(decisions).toEqual(["approve", "reject"]);
    expect(actions.elements.every((e) => e.action_id.startsWith(PLAN_ACTION_PREFIX))).toBe(true);
    expect(actions.elements.every((e) => (JSON.parse(e.value) as PlanActionValue).planId === "p1")).toBe(true);
  });

  test("resolved blocks reflect the decision and drop the buttons", () => {
    const approved = planResolvedBlocks(plan({ status: "approved", approvedBy: "alice" }), "✅ Approved by alice.");
    expect(JSON.stringify(approved)).toContain("Plan approved");
    expect(approved.some((b) => b.type === "actions")).toBe(false);
  });
});

const askOf = (question: string, options?: string[]): Ask =>
  ({
    id: "a1",
    sessionId: "s1",
    question,
    kind: "question",
    options,
    status: "pending",
    createdAt: "2026-01-01T00:00:00Z",
  }) as unknown as Ask;

describe("section text stays under Slack's 3000-char limit (invalid_blocks guard)", () => {
  test("a big plan WITH a long criterion AND relevant files caps to one <=3000 section", () => {
    const p = plan({
      plan: "P".repeat(2400),
      acceptanceCriterion: "C".repeat(500),
      relevantFiles: Array.from({ length: 40 }, (_, i) => `src/very/long/path/to/file-${i}.ts`),
    });
    const { blocks } = planMessage(p, "http://web.local", "U123");
    const sections = sectionTexts(blocks);
    for (const s of sections) expect(s.length).toBeLessThanOrEqual(SLACK_SECTION_LIMIT);
    // The composed plan+criterion+files body is the one that would have overflowed.
    expect(Math.max(...sections.map((s) => s.length))).toBeGreaterThan(2000);
  });

  test("an ask question full of <,>,& escapes stays <=3000 AFTER escaping", () => {
    // 2000 raw '<' → 8000 chars once escaped to &lt; — well past 3000 pre-cap.
    const { blocks } = askMessage(askOf("<".repeat(2000)), "session");
    const sections = sectionTexts(blocks);
    for (const s of sections) expect(s.length).toBeLessThanOrEqual(SLACK_SECTION_LIMIT);
    // The escape actually ran (no raw '<' left) and the section was capped.
    const question = sections[sections.length - 1]!;
    expect(question).toContain("&lt;");
    expect(question).not.toContain("<");
  });

  test("no section anywhere exceeds 3000 for pathological inputs", () => {
    const huge = "&<>|".repeat(1500); // escape roughly 4×'s the length
    const p = plan({ plan: huge, acceptanceCriterion: huge, relevantFiles: [huge], projectId: huge });
    const all = [
      ...planMessage(p, "http://web.local", "U1").blocks,
      ...planResolvedBlocks(plan({ status: "approved", plan: huge }), "note"),
      ...askMessage(askOf(huge), huge).blocks,
      ...answeredBlocks(huge, huge, huge),
      ...closedBlocks(huge, "note", huge),
    ];
    for (const s of sectionTexts(all)) expect(s.length).toBeLessThanOrEqual(SLACK_SECTION_LIMIT);
  });
});

describe("context element text stays under Slack's 3000-char limit (invalid_blocks guard)", () => {
  test("answeredBlocks caps an escape-heavy answer AFTER escaping", () => {
    // A pasted diff/code answer: 2000 raw '<>&' chars escape to ~8000 — the old
    // truncate-before-escape (cap 2000) would leave the context element well over 3000.
    const answer = "&<>|".repeat(500); // 2000 raw chars → ~7000 escaped
    const ctx = contextTexts(answeredBlocks("q", answer, "session"));
    expect(ctx.length).toBeGreaterThan(0);
    for (const c of ctx) expect(c.length).toBeLessThanOrEqual(SLACK_SECTION_LIMIT);
    // The escape actually ran (raw '<' replaced) even though it was capped.
    expect(ctx.join("")).toContain("&lt;");
    expect(ctx.join("")).not.toContain("<");
  });

  test("an empty answer still renders the dismissed placeholder", () => {
    const ctx = contextTexts(answeredBlocks("q", "", "session")).join("");
    expect(ctx).toContain("(dismissed)");
  });

  test("answeredElsewhereNote redacts+escapes+caps an un-bounded web-UI answer", () => {
    const answer = "&<>|".repeat(1000); // 4000 raw → ~14000 escaped if left un-capped
    const note = answeredElsewhereNote(answer);
    const ctx = contextTexts(closedBlocks("q", note, "session"));
    for (const c of ctx) expect(c.length).toBeLessThanOrEqual(SLACK_SECTION_LIMIT);
    expect(note).toContain("Answered elsewhere");
    expect(note).not.toContain("<"); // escaped, not passed through verbatim
  });

  test("an empty answer note reads as resolved/dismissed", () => {
    expect(answeredElsewhereNote("")).toContain("Resolved elsewhere");
  });

  test("no context element anywhere exceeds 3000 for pathological inputs", () => {
    const huge = "&<>|".repeat(1500);
    const all = [
      ...planMessage(plan({ plan: huge, projectId: huge }), "http://web.local", "U1").blocks,
      ...planResolvedBlocks(plan({ status: "approved", plan: huge }), huge),
      ...askMessage(askOf(huge), huge).blocks,
      ...answeredBlocks(huge, huge, huge),
      ...closedBlocks(huge, answeredElsewhereNote(huge), huge),
    ];
    for (const c of contextTexts(all)) expect(c.length).toBeLessThanOrEqual(SLACK_SECTION_LIMIT);
  });
});

const work = (over: Partial<ActiveWorkItem> & { sessionId: string }): ActiveWorkItem => ({
  title: over.sessionId,
  status: "running",
  lastActivityAt: "2026-09-07T12:00:00Z",
  ...over,
});

describe("activityMessage — the ephemeral activity snapshot", () => {
  const NOW = Date.parse("2026-09-07T12:00:00Z");

  test("renders one section per session with title, harness, actor, elapsed, status, and a deep link", () => {
    const { text, blocks } = activityMessage(
      [
        work({
          sessionId: "abcdefgh1234",
          title: "Refactor the store",
          status: "waiting",
          actor: "alice",
          harness: "codex",
          lastActivityAt: "2026-09-07 10:00:00", // 2h before NOW (bare UTC)
        }),
      ],
      { webUrl: "http://web.test", label: "web", now: NOW },
    );
    const joined = JSON.stringify(blocks);
    expect(text).toContain("Active now in web");
    expect(joined).toContain("*Active now in web*"); // header names the scope
    expect(joined).toContain("Refactor the store");
    expect(joined).toContain("codex"); // harness
    expect(joined).toContain("alice"); // actor
    expect(joined).toContain("waiting"); // status
    expect(joined).toContain("2h ago"); // elapsed
    // The "Open in Standup" deep link reuses the session share URL (…/s/<short id>).
    expect(joined).toContain("<http://web.test/s/abcdefgh|Open in Standup>");
  });

  test("empty state is a real sentence naming the scope (never a blank the send-guard drops)", () => {
    const { text, blocks } = activityMessage([], { webUrl: "http://web.test", label: "web", now: NOW });
    expect(text).toBe("📭 Nothing active in web right now.");
    expect(blocks.length).toBeGreaterThan(0);
    expect(sectionTexts(blocks).join("")).toContain("Nothing active in web right now.");
  });

  test("surfaces an 'N projects not shown' note when the cross-project fan-out was truncated", () => {
    const { text, blocks } = activityMessage([work({ sessionId: "s1", title: "task" })], {
      webUrl: "http://web.test",
      label: "your projects",
      now: NOW,
      omittedProjectCount: 2,
    });
    expect(contextTexts(blocks).join("")).toContain("2 projects not shown");
    // The main text line stays the session summary; the note rides a context block.
    expect(text).toContain("Active now in your projects");
  });

  test("the omitted-projects note is appended to the empty-state sentence too (never hidden)", () => {
    const { text, blocks } = activityMessage([], {
      webUrl: "http://web.test",
      label: "your projects",
      now: NOW,
      omittedProjectCount: 1,
    });
    expect(text).toContain("Nothing active in your projects right now.");
    expect(text).toContain("1 project not shown");
    expect(sectionTexts(blocks).join("")).toContain("1 project not shown");
  });

  test("no note when every project was covered (omittedProjectCount unset)", () => {
    const { blocks } = activityMessage([work({ sessionId: "s1", title: "task" })], {
      webUrl: "http://web.test",
      label: "web",
      now: NOW,
    });
    expect(contextTexts(blocks).join("")).not.toContain("not shown");
  });

  test("a pathologically long title caps its section under Slack's 3000-char limit", () => {
    const { blocks } = activityMessage(
      [work({ sessionId: "s1", title: "&<>|".repeat(2000) })], // ~8000 raw → ~24000 escaped
      { webUrl: "http://web.test", label: "web", now: NOW },
    );
    for (const s of sectionTexts(blocks)) expect(s.length).toBeLessThanOrEqual(SLACK_SECTION_LIMIT);
  });

  test("caps the individual title (not just the whole section) so a long title never floods a row", () => {
    const { blocks } = activityMessage(
      [work({ sessionId: "s1", title: "x".repeat(400) })],
      { webUrl: "http://web.test", label: "web", now: NOW },
    );
    const row = sectionTexts(blocks).find((s) => s.includes("x"))!;
    expect(row).toContain("…"); // truncated on a boundary, not left whole
    // The title portion is bounded to its 120-char feed cap — the full 400-char
    // title (e.g. an uncapped Codex-launch prompt) can't render as a wall of text.
    expect((row.match(/x/g) ?? []).length).toBeLessThanOrEqual(120);
  });

  test("caps the rendered rows and collapses the rest into an '…and N more' line", () => {
    const items = Array.from({ length: 15 }, (_, i) =>
      work({ sessionId: `s${i}`, title: `task ${i}` }),
    );
    const { blocks } = activityMessage(items, { webUrl: "http://web.test", label: "web", now: NOW });
    // 1 header + 12 rows = 13 sections; the remaining 3 collapse to a context line.
    expect(sectionTexts(blocks)).toHaveLength(13);
    expect(contextTexts(blocks).join("")).toContain("and 3 more");
  });

  test("a very recent row reads 'just now'; agent-authored title/actor are escaped", () => {
    const { blocks } = activityMessage(
      [work({ sessionId: "s1", title: "a<b>c", actor: "e&f", lastActivityAt: "2026-09-07T11:59:30Z" })],
      { webUrl: "http://web.test", label: "web", now: NOW },
    );
    const joined = sectionTexts(blocks).join("");
    expect(joined).toContain("just now");
    expect(joined).toContain("a&lt;b&gt;c");
    expect(joined).toContain("e&amp;f");
    expect(joined).not.toContain("a<b>c");
  });
});
