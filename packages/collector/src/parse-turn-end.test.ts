import { expect, test, describe } from "bun:test";
import { parseTurnEnd } from "./auto-checkpoint.js";

/**
 * parseTurnEnd turns the classifier's reply into a typed state. Garbled or
 * unknown labels must fall back to 'idle' (the do-nothing state) rather than
 * accidentally surfacing a needs-you.
 */
describe("parseTurnEnd", () => {
  test("NEEDS_YOU with a reason", () => {
    const r = parseTurnEnd("NEEDS_YOU\nIt asked which database to target.");
    expect(r.state).toBe("needs_you");
    expect(r.reason).toBe("It asked which database to target.");
  });

  test("DONE", () => {
    expect(parseTurnEnd("DONE\nFinished the refactor and tests pass.").state).toBe("done");
  });

  test("IDLE", () => {
    expect(parseTurnEnd("IDLE\nStopped mid-exchange.").state).toBe("idle");
  });

  test("tolerates label variants and surrounding noise", () => {
    expect(parseTurnEnd("needs_you — asked a question").state).toBe("needs_you");
    expect(parseTurnEnd("Label: DONE").state).toBe("done");
  });

  test("unknown label falls back to idle", () => {
    expect(parseTurnEnd("MAYBE?\nnot sure").state).toBe("idle");
  });

  test("uses the first line as the reason when there's no second line", () => {
    const r = parseTurnEnd("DONE");
    expect(r.state).toBe("done");
    expect(r.reason).toBe("DONE");
  });
});
