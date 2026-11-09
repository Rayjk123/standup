import { describe, expect, test } from "bun:test";
import {
  approveLabel,
  approvalCardText,
  approvalHeadline,
  describeApproval,
  holdExpiresIn,
  plainHoldReason,
  splitApprovalReason,
  withoutIds,
} from "./approval-card.js";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** A held launch in the stored shape: summary, policy reason and arguments. */
const LAUNCH = {
  action: "launch_session",
  summary: 'Launch a worker in ledger: "Goal: stop the nightly invoice export from writing each refund twice…"',
  reason:
    'the text asks for an outward-facing step ("tagged a release"); outward-facing steps always go to the owner for approval',
  args: {
    projectId: "ledger",
    title: "Duplicate refund rows in the export",
    task: "Goal: stop the nightly invoice export from writing each refund twice.\n\nAcceptance: a failing test first, then the fix, in one local commit.",
  },
};

const SEND = {
  action: "send_to_session",
  summary: 'Queue for the next turn of session 3f2a9c1b: "Rebase onto main and rerun the tests."',
  reason: "Unblock the worker (held: the owner holds send_to_session for approval (STANDUP_PERSONA_HOLD))",
  args: {
    sessionId: "3f2a9c1b-0d1e-4a5b-9c8d-7e6f5a4b3c2d",
    text: "Rebase onto main and rerun the tests.",
    mode: "next_turn",
    sessionTitle: "Fix the flaky auth test",
  },
};

const PERMISSION = {
  action: "answer_ask",
  summary: 'Answer permission prompt "Bash" on session 3f2a9c1b with exactly "1"',
  reason: "tool-permission prompts are held for the owner",
  args: {
    askId: "8c7b6a59-4e3d-4c2b-a1f0-0e9d8c7b6a59",
    answer: "1",
    sessionTitle: "Fix the flaky auth test",
    askQuestion: "Claude wants to run Bash",
    askOptions: ["Yes", "Yes, and don't ask again", "No"],
    toolName: "Bash",
    toolInput: { command: "rm -rf node_modules && bun install" },
    pinned: { toolHash: "abc" },
  },
};

describe("approval cards in plain English", () => {
  test("the held launch reads as a sentence, says why, and shows the brief in full", () => {
    const card = describeApproval(LAUNCH);
    expect(card.headline).toBe("I want to start a worker in ledger on “Duplicate refund rows in the export”.");
    expect(card.why).toBe("It asks for “tagged a release”, which other people would see, so it's your call.");
    expect(card.sections).toEqual([{ label: "Brief", text: LAUNCH.args.task }]);
  });

  test("a message to a worker names the worker, not its session id", () => {
    const card = describeApproval(SEND);
    expect(card.headline).toBe("I want to send a message to the worker on “Fix the flaky auth test”.");
    expect(card.why).toBe("You asked to approve these yourself.");
    expect(card.note).toBe("Unblock the worker");
    expect(card.sections).toEqual([{ label: "Message", text: "Rebase onto main and rerun the tests." }]);
  });

  test("a permission answer shows the command it lets run as code", () => {
    const card = describeApproval(PERMISSION);
    expect(card.headline).toBe("I want to let the worker on “Fix the flaky auth test” run Bash.");
    expect(card.why).toBe("The worker's own permission settings stopped this tool call, so only you can allow it.");
    expect(card.sections).toContainEqual({ label: "Command", text: "rm -rf node_modules && bun install", code: true });
  });

  test("no card carries JSON or ids", () => {
    for (const approval of [LAUNCH, SEND, PERMISSION]) {
      const text = approvalCardText(approval);
      expect(text).not.toMatch(UUID);
      expect(text).not.toMatch(/\b3f2a9c1b\b/);
      expect(text).not.toMatch(/[{}]|"\w+":/);
      expect(text.endsWith("Approve / Deny")).toBe(true);
    }
  });

  test("a repos change shows the project's repos before and after", () => {
    const card = describeApproval({
      action: "update_project_repos",
      summary: "Set the repos of project payments to /src/A, /src/B",
      reason: "Register the data-plane repos (held: a project's repos decide where workers launch; only the owner changes them)",
      args: { projectId: "payments", projectName: "Payments Platform", repos: ["/src/A", "/src/B"], currentRepos: [], pinned: { currentRepos: [] } },
    });
    expect(card.headline).toBe("I want to set the repos of “Payments Platform”.");
    expect(card.why).toBe("A project's repos decide where workers launch and what they can reach, so only you can change them.");
    expect(card.note).toBe("Register the data-plane repos");
    expect(card.sections).toEqual([
      { label: "Repos now", text: "(none)", code: true },
      { label: "Repos after", text: "/src/A\n/src/B", code: true },
    ]);
  });

  test("the one-line form is the headline and why", () => {
    expect(approvalHeadline(LAUNCH)).toBe(
      "I want to start a worker in ledger on “Duplicate refund rows in the export”. It asks for “tagged a release”, which other people would see, so it's your call."
    );
  });

  test("hold reasons read in plain words", () => {
    expect(plainHoldReason("active launch cap reached (6/6)")).toBe("6 workers are already running, and 6 at once is the limit.");
    expect(plainHoldReason('approves a worker\'s request to "git push origin HEAD", an outward-facing step the owner decides on')).toBe(
      "It says yes to the worker's request to “git push origin HEAD”, which other people would see, so it's your call."
    );
    expect(plainHoldReason("the text writes to Standup's HTTP API; workers must use the standup MCP tools")).toMatch(/^It would change Standup itself/);
    expect(
      plainHoldReason("the pipeline change weakens the pipeline (deploy is removed; review needs fewer reviewers (1 instead of 2)); only the owner weakens it")
    ).toBe("It weakens the delivery pipeline (deploy is removed; review needs fewer reviewers (1 instead of 2)), so only you can approve it.");
  });

  test("the stored reason splits into Persona's note and the hold", () => {
    expect(splitApprovalReason("Need it now (held: active launch cap reached (6/6))")).toEqual({
      note: "Need it now",
      held: "active launch cap reached (6/6)",
    });
    expect(splitApprovalReason("tool-permission prompts are held for the owner")).toEqual({ held: "tool-permission prompts are held for the owner" });
    expect(splitApprovalReason(undefined)).toEqual({});
  });

  test("ids are dropped from free text", () => {
    expect(withoutIds("Type into session 3f2a9c1b now")).toBe("Type into session now");
    expect(withoutIds("approval 5d0b7e21 (5d0b7e21-9a3c-4e6f-b812-0c4d2a7f9e35) done")).toBe("approval done");
  });
});

describe("an owner-only safety-floor hold's card", () => {
  const FLOOR_HOLD = {
    action: "answer_ask",
    summary: 'Answer safety-floor hold "Safety floor held a Bash call" on session 3f2a9c1b with exactly "Allow once"',
    reason: "a safety-floor hold (floor-tamper) that could outlast one allow: only the owner may allow it",
    args: {
      askId: "8c7b6a59-4e3d-4c2b-a1f0-0e9d8c7b6a59",
      answer: "Allow once",
      sessionTitle: "Fix the floor",
      askQuestion: "Safety floor held a Bash call (floor-tamper): writes the floor hook\n\nvim gate.ts\n\nOnly the owner can allow this.",
      askOptions: ["Allow once", "Deny"],
      floorHold: true,
      holdExpiresAt: "2026-03-14T16:40:00.000Z",
    },
  };

  test("says the floor holds it for the owner, shows the held call and its deadline", () => {
    const card = describeApproval(FLOOR_HOLD);
    expect(card.headline).toBe("Standup's safety floor is holding a command from the worker on “Fix the floor”, and only you can let it run.");
    expect(card.why).toBe("Standup's safety floor stopped this command, and only you can let it run.");
    expect(card.sections).toEqual([
      { label: "What the safety floor held", text: FLOOR_HOLD.args.askQuestion },
      { label: "What your answer does", text: "Allow once runs the held command this one time. Deny refuses it." },
    ]);
    expect(card.expiresAt).toBe("2026-03-14T16:40:00.000Z");
    expect(approvalCardText(FLOOR_HOLD)).toContain("Decide by 2026-03-14T16:40:00.000Z: after that the hold times out and the call is denied.");
    expect(approvalCardText(FLOOR_HOLD).endsWith("Allow once / Deny")).toBe(true);
    expect(approveLabel(FLOOR_HOLD)).toBe("Allow once");
    expect(approveLabel(SEND)).toBe("Approve");
    // Persona's own held allow of a floor hold is an ordinary card.
    expect(approveLabel({ ...FLOOR_HOLD, args: { ...FLOOR_HOLD.args, floorHold: undefined } })).toBe("Approve");
  });

  test("a hold Persona can't allow says why in plain words, whatever the check's reason quotes", () => {
    const why = (reason: string) => describeApproval({ ...FLOOR_HOLD, reason }).why;
    expect(why("Persona can't allow this safety-floor hold: the call reads or moves secrets (the SSO cookie)")).toBe(
      "It touches secrets: the SSO cookie. Persona is never allowed to let that run, so only you can allow it once."
    );
    expect(why("Persona can't allow this safety-floor hold: the second check blocks its allow (the job never asked for this floor-tamper step)")).toBe(
      "Standup's second check stopped Persona allowing it (the job never asked for this floor-tamper step), so only you can allow it once."
    );
    // A model reason naming another rule's phrase, or running over lines, still reads as the block.
    expect(why("Persona can't allow this safety-floor hold: the second check blocks its allow (an outward-facing step to the HTTP API\nthat the owner never asked for)")).toMatch(
      /^Standup's second check stopped Persona allowing it \(an outward-facing step to the HTTP API\nthat the owner never asked for\)/
    );
  });

  test("a deadline is read only from an answer_ask's valid time", () => {
    expect(describeApproval({ ...FLOOR_HOLD, args: { ...FLOOR_HOLD.args, holdExpiresAt: "soon" } }).expiresAt).toBeUndefined();
    expect(describeApproval({ ...SEND, args: { ...SEND.args, holdExpiresAt: FLOOR_HOLD.args.holdExpiresAt } }).expiresAt).toBeUndefined();
  });

  test("holdExpiresIn counts down in minutes, then hours", () => {
    const now = new Date("2026-03-14T15:40:00.000Z");
    expect(holdExpiresIn("2026-03-14T15:45:00.000Z", now)).toBe("in 5 min");
    expect(holdExpiresIn("2026-03-14T16:40:00.000Z", now)).toBe("in 1 h");
    expect(holdExpiresIn("2026-03-14T16:45:00.000Z", now)).toBe("in 1 h 5 min");
    expect(holdExpiresIn("2026-03-14T15:35:00.000Z", now)).toBe("now");
  });
});
