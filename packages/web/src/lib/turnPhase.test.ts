import { expect, test, describe } from "bun:test";
import {
  PHASE_STALE_MS,
  messageTail,
  richRowTail,
  turnPhase,
} from "./turnPhase";

/**
 * The transcript's live "working" indicator. The web package has no
 * component-test harness, so the phase derivation is pinned at the logic level:
 * what each tail means, when the indicator must stay silent, and the stale
 * cutoff that stops a dead session from spinning forever.
 */

const NOW = Date.parse("2026-09-09T12:00:00.000Z");
const justNow = new Date(NOW - 2000).toISOString();

describe("turnPhase — what the tail says the agent is doing", () => {
  test("a prompt with nothing after it means the agent has it and is working", () => {
    const phase = turnPhase({
      tail: { kind: "prompt" },
      tailAt: justNow,
      sessionEnded: false,
      now: NOW,
    });
    expect(phase).toEqual({ label: "working", sinceMs: 2000 });
  });

  test("an unresolved tool call names the tool that is running", () => {
    // The gap this closes: the poll that shows a long Bash call and the poll that
    // shows its result can be minutes apart, with nothing moving in between.
    const phase = turnPhase({
      tail: { kind: "tool", name: "Bash", pending: true },
      tailAt: justNow,
      sessionEnded: false,
      now: NOW,
    });
    expect(phase?.label).toBe("running Bash");
  });

  test("a resolved tool call still counts as working — the turn isn't over", () => {
    const phase = turnPhase({
      tail: { kind: "tool", name: "Read", pending: false },
      tailAt: justNow,
      sessionEnded: false,
      now: NOW,
    });
    expect(phase?.label).toBe("working");
  });

  test("thinking reads as thinking", () => {
    const phase = turnPhase({
      tail: { kind: "thinking" },
      tailAt: justNow,
      sessionEnded: false,
      now: NOW,
    });
    expect(phase?.label).toBe("thinking");
  });

  test("the agent's own prose is where the turn rests — no indicator", () => {
    // Otherwise every finished session would claim to be working while it sits
    // idle waiting for a reply.
    expect(
      turnPhase({ tail: { kind: "text" }, tailAt: justNow, sessionEnded: false, now: NOW })
    ).toBeNull();
  });
});

describe("turnPhase — when it must stay silent", () => {
  test("an ended session is never working", () => {
    expect(
      turnPhase({ tail: { kind: "prompt" }, tailAt: justNow, sessionEnded: true, now: NOW })
    ).toBeNull();
  });

  test("a session blocked on an ask is waiting on a human, not working", () => {
    // The ask panel is the story there; a spinner next to it would contradict it.
    expect(
      turnPhase({
        tail: { kind: "tool", name: "AskUserQuestion", pending: true },
        tailAt: justNow,
        sessionEnded: false,
        blocked: true,
        now: NOW,
      })
    ).toBeNull();
  });

  test("an empty transcript claims nothing", () => {
    expect(turnPhase({ sessionEnded: false, now: NOW })).toBeNull();
  });

  test("a tail that has gone quiet mid-turn is stalled, not busy", () => {
    const stale = new Date(NOW - PHASE_STALE_MS - 1000).toISOString();
    expect(
      turnPhase({ tail: { kind: "prompt" }, tailAt: stale, sessionEnded: false, now: NOW })
    ).toBeNull();
    // Just inside the cutoff it still reads as working.
    const fresh = new Date(NOW - PHASE_STALE_MS + 1000).toISOString();
    expect(
      turnPhase({ tail: { kind: "prompt" }, tailAt: fresh, sessionEnded: false, now: NOW })
    ).not.toBeNull();
  });

  test("an unusable timestamp claims no phase (a resumed idle tail, not a live turn)", () => {
    const phase = turnPhase({
      tail: { kind: "thinking" },
      tailAt: "not a date",
      sessionEnded: false,
      now: NOW,
    });
    expect(phase).toBeNull();
  });

  test("a clock skew that puts the tail in the future doesn't go negative", () => {
    const phase = turnPhase({
      tail: { kind: "prompt" },
      tailAt: new Date(NOW + 5000).toISOString(),
      sessionEnded: false,
      now: NOW,
    });
    expect(phase?.sinceMs).toBe(0);
  });
});

describe("richRowTail — the terminal view's rows", () => {
  test("each row kind maps to the phase it implies", () => {
    expect(richRowTail({ kind: "user" })).toEqual({ kind: "prompt" });
    expect(richRowTail({ kind: "thinking" })).toEqual({ kind: "thinking" });
    expect(richRowTail({ kind: "text" })).toEqual({ kind: "text" });
    expect(richRowTail({ kind: "tool", name: "Grep", result: { kind: "pending" } })).toEqual({
      kind: "tool",
      name: "Grep",
      pending: true,
    });
    expect(richRowTail({ kind: "tool", name: "Grep", result: { kind: "text" } })).toEqual({
      kind: "tool",
      name: "Grep",
      pending: false,
    });
  });

  test("an out-of-band row lands mid-turn, so it reads as still working", () => {
    // A compaction or mode change never ends a turn.
    expect(richRowTail({ kind: "compaction" })).toEqual({ kind: "prompt" });
    expect(richRowTail({ kind: "mode" })).toEqual({ kind: "prompt" });
  });
});

describe("messageTail — the card view's messages", () => {
  test("a user card is a prompt", () => {
    expect(messageTail({ role: "user", text: "do the thing" })).toEqual({ kind: "prompt" });
  });

  test("an unresolved call inside a card wins over the prose beside it", () => {
    // A card folds the whole turn: text and tool calls arrive together, and the
    // unresolved call is the live part.
    expect(
      messageTail({
        role: "assistant",
        text: "Let me check the config.",
        toolCalls: [
          { name: "Read", output: "ok" },
          { name: "Bash" },
        ],
      })
    ).toEqual({ kind: "tool", name: "Bash", pending: true });
  });

  test("a card whose calls all resolved is still mid-turn", () => {
    expect(messageTail({ role: "assistant", toolCalls: [{ name: "Read", output: "ok" }] })).toEqual({
      kind: "tool",
      name: "Read",
      pending: false,
    });
  });

  test("prose alone rests the turn; thinking alone keeps it going", () => {
    expect(messageTail({ role: "assistant", text: "Done." })).toEqual({ kind: "text" });
    expect(messageTail({ role: "assistant", thinking: "hmm" })).toEqual({ kind: "thinking" });
  });

  test("an empty assistant card says nothing about the phase", () => {
    expect(messageTail({ role: "assistant" })).toEqual({ kind: "other" });
  });
});
