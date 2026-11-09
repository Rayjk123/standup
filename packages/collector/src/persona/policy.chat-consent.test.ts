import { describe, expect, test } from "bun:test";
import { CHAT_CONSENT_WINDOW_MS, chatConsent, closeTargetsUnnamed, decide, outwardMatches } from "./policy.js";
import type { ChatConsentInput } from "./policy.js";
import { FLOOR_OWNER_GATE } from "../floor/gate.js";
import { scratchRunHold } from "./allow-check.js";

const NOW = new Date("2026-10-05T16:00:00Z");
const budget = { projectLaunchable: true, activeLaunches: 3, maxActiveLaunches: 6 };
const TASK = "Investigate the flaky parser test in packages/collector and fix it.";
/** The owner holds launches (STANDUP_PERSONA_HOLD): the one launch hold that remains. */
const HOLD_LAUNCHES = { hold: new Set(["launch_session"]) };

function input(overrides: Partial<ChatConsentInput> = {}, text = "Yes, launch the parser fix too"): ChatConsentInput {
  return {
    action: "launch_session",
    decision: decide("launch_session", { ...budget, text: TASK }, HOLD_LAUNCHES),
    owner: "alice",
    threadId: "t1",
    now: NOW,
    message: { threadId: "t1", role: "user", actor: "alice", text, createdAt: new Date(NOW.getTime() - 60_000).toISOString() },
    subject: `Launch a worker in standup\n${TASK}`,
    actionTexts: [TASK],
    ...overrides,
  };
}

describe("close_session", () => {
  const TITLE = "Orders table migration script for the importer";
  const close = (text: string, overrides: Partial<ChatConsentInput> = {}) =>
    chatConsent(
      input(
        {
          action: "close_session",
          decision: decide("close_session", {}),
          subject: `close 1a2b3c4d\n${TITLE}`,
          actionTexts: [TITLE],
          ...overrides,
        },
        text
      )
    );

  test("is held on any session but an open worker or another user's", () => {
    expect(decide("close_session", {})).toMatchObject({ rule: "ask", holdRule: "close-session" });
    expect(decide("close_session", { owned: true, openJobWorker: true })).toMatchObject({ rule: "never" });
    expect(decide("close_session", { openJobWorker: true }).reason).toContain("another open Persona job");
    expect(decide("close_session", { sessionOtherUser: "bob" })).toMatchObject({ rule: "never", reason: "the session belongs to bob" });
    // The owner's hold knob can't make it routine, and it never falls to the launched-only rule.
    expect(decide("close_session", {}, { hold: new Set(["close_session"]) }).rule).toBe("ask");
  });

  test("the owner's plain yes naming the session clears it", () => {
    expect(close("yes, close the orders migration script session")).toMatchObject({ ok: true });
    expect(close("yes", { prompt: `Want me to close the old orders table migration session?` })).toMatchObject({ ok: true });
  });

  test("closeTargetsUnnamed: every target needs its own title word or short id", () => {
    const targets = [
      { id: "1a2b3c4d-x", title: "Orders migration script" },
      { id: "9f8e7d6c-y", title: "Old scratch session" },
    ];
    expect(closeTargetsUnnamed({ ownerText: "yes, close the orders one and 9f8e7d6c" }, targets)).toEqual([]);
    expect(closeTargetsUnnamed({ ownerText: "yes, close the orders session" }, targets)).toEqual(["9f8e7d6c-y"]);
    // A title of only generic words is named by its id alone.
    expect(closeTargetsUnnamed({ ownerText: "yes, close all the old scratch sessions" }, targets)).toEqual(["1a2b3c4d-x", "9f8e7d6c-y"]);
    // A short yes is read with Persona's question it answers, and only that question.
    expect(closeTargetsUnnamed({ ownerText: "yes", prompt: "Close the orders script and 9f8e7d6c?" }, targets)).toEqual([]);
    expect(
      closeTargetsUnnamed({ ownerText: "yes", prompt: "I looked at 9f8e7d6c earlier. Shall I close the orders script?" }, targets)
    ).toEqual(["9f8e7d6c-y"]);
  });

  test("closeTargetsUnnamed: verbs, yes-words and words two titles share name nobody", () => {
    const login = { id: "aaaaaaaa-1", title: "Refactor login form" };
    expect(closeTargetsUnnamed({ ownerText: "yes, close the login one" }, [login, { id: "bbbbbbbb-2", title: "Close stale PRs" }])).toEqual([
      "bbbbbbbb-2",
    ]);
    expect(closeTargetsUnnamed({ ownerText: "okay, close the login one" }, [login, { id: "cccccccc-3", title: "Okay button styling" }])).toEqual([
      "cccccccc-3",
    ]);
    // "login" is in both titles, so it names neither; "form" names only the first.
    expect(
      closeTargetsUnnamed({ ownerText: "yes close the login form session" }, [login, { id: "dddddddd-4", title: "Login rate limiting" }])
    ).toEqual(["dddddddd-4"]);
  });

  test("a request about other work, a question or a negation doesn't", () => {
    expect(close("yes, close the billing architecture draft session")).toMatchObject({ ok: false, reason: "the message isn't about this action" });
    expect(close("should I close the orders script session?").ok).toBe(false);
    expect(close("don't close the orders script session").ok).toBe(false);
  });
});

describe("chat consent", () => {
  test("the owner's recent yes about this launch clears the owner's launch hold", () => {
    expect(input().decision).toMatchObject({ rule: "ask", consentable: true });
    expect(chatConsent(input())).toMatchObject({ ok: true });
  });

  test("a launch past the active cap is queued, not held, so there is nothing to consent to", () => {
    const queued = decide("launch_session", { ...budget, activeLaunches: 6, text: TASK });
    expect(queued.rule).toBe("act");
    expect(chatConsent(input({ decision: queued })).ok).toBe(false);
  });

  test("a bare yes answers Persona's question about this launch", () => {
    const res = chatConsent(input({ prompt: "You hold launches for approval. Want me to start a worker on the flaky parser test?" }, "yes"));
    expect(res).toMatchObject({ ok: true });
  });

  test("a yes repeating the step's verb from Persona's question clears the allow of the ask holding that step", () => {
    const call = "env -i HOME=/tmp/r/home DB_PATH=/tmp/r/data/standup.db bun run packages/collector/src/index.ts";
    const allow = input({
      action: "answer_ask",
      decision: { rule: "ask", reason: "a high-risk floor hold", consentable: true },
      subject: `Answer the worker's ask: starts a scratch collector\n${call}`,
      actionTexts: [call],
      prompt: "The worker wants to start a scratch collector under /tmp to test the floor route against it. Start it?",
    }, "Yes, start it");
    expect(chatConsent(allow)).toMatchObject({ ok: true });
    // As a floor allow: Persona's question names the collector the call starts.
    expect(chatConsent({ ...allow, heldCall: { toolName: "Bash", call } })).toMatchObject({ ok: true });
    // On a high-risk hold a call with a scratch run's shape is named by the scratch collector, whatever the question's other words.
    expect(chatConsent({ ...allow, heldCall: { toolName: "Bash", call, highRisk: true, scratchRun: true } })).toMatchObject({ ok: true });
    const tmpOnly = "env -i HOME=/tmp/r/home DB_PATH=/tmp/r/data/standup.db bun run src/index.ts";
    const natural = { prompt: "The floor held the worker's scratch run for its live check. Start it?", subject: `Answer the worker's ask: starts a scratch collector\n${tmpOnly}`, actionTexts: [tmpOnly] };
    expect(chatConsent({ ...allow, ...natural, heldCall: { toolName: "Bash", call: tmpOnly, highRisk: true, scratchRun: true } })).toMatchObject({ ok: true });
    expect(chatConsent({ ...allow, ...natural, heldCall: { toolName: "Bash", call: tmpOnly, highRisk: true } }).ok).toBe(false);
    // The verb must be the question's, and the question about this ask.
    expect(chatConsent({ ...allow, prompt: "The worker wants a scratch collector under /tmp. Should it?" }).ok).toBe(false);
    expect(chatConsent({ ...allow, prompt: "Start the docs cleanup job?" }).ok).toBe(false);
    // Only an ask's allow runs the step its question names.
    expect(chatConsent(input({ action: "stop_session", decision: allow.decision, prompt: "The parser worker could start over. Start it?" }, "Yes, start it")).ok).toBe(false);
  });

  test("a yes to Persona's natural question about a scratch collector clears a scratch run's hold, and only a scratch run's", () => {
    const X = "/tmp/tmp.Q1w2E3";
    const WT = "/home/alice/.local/share/standup/worktrees/standup/feat-1";
    const prefix =
      `env -u TMUX -u TMUX_PANE HOME=${X}/home XDG_CONFIG_HOME=${X}/xdg/config XDG_DATA_HOME=${X}/xdg/data XDG_STATE_HOME=${X}/xdg/state ` +
      `XDG_CACHE_HOME=${X}/xdg/cache DB_PATH=${X}/data/standup.db STANDUP_SQLITE_PATH=${X}/data/standup.db KNOWLEDGE_DIR=${X}/knowledge ` +
      `STANDUP_INTERNAL_ROOT=${X}/internal STANDUP_PROJECT_DOCS_DIR=${X}/docs TMPDIR=${X}/tmp TMP=${X}/tmp TEMP=${X}/tmp TMUX_TMPDIR=${X}/tmux PORT=17891`;
    const call = `cd packages/collector && ${prefix} bun run src/index.ts > ${X}/log 2>&1 & echo $! > ${X}/pid`;
    const ask = (prompt: string, reason = "starts a Standup collector"): ChatConsentInput =>
      input(
        {
          action: "answer_ask",
          decision: { rule: "ask", reason: "a high-risk floor hold", consentable: true },
          prompt,
          subject: `Answer the worker's ask: ${reason}\n${call}`,
          actionTexts: [call],
          heldCall: { toolName: "Bash", call, highRisk: true, scratchRun: scratchRunHold("Bash", "floor-tamper", call, reason, WT) },
        },
        "Yes, start it"
      );
    for (const prompt of [
      "The worker wants to start a scratch collector on port 17891 under /tmp to check its health endpoint. OK to start it?",
      "Should I let the worker start its scratch Standup instance?",
      "The worker wants to spin up a scratch copy of Standup to live-check the route. Start it?",
      "The worker wants to start a scratch-collector under /tmp. Start it?",
      "The worker wants to start a temp collector under /tmp for its live check. Start it?",
      "The worker wants to start a second collector on port 17891 with its state under /tmp. Start it?",
      "The worker wants to start a Standup collector on port 17891 with its HOME and database under /tmp/tmp.Q1w2E3 to check the route. Start it?",
    ]) {
      expect({ prompt, res: chatConsent(ask(prompt)) }).toMatchObject({ prompt, res: { ok: true } });
    }
    // A floor reason naming more than the isolation leaves the call's own targets to be named.
    const reaching = "Ends sessions outside this worker: `kill -9 -1`. starts a Standup collector (also destructive: kills every process of the user)";
    expect(chatConsent(ask("The worker wants to start a scratch-collector under /tmp. Start it?", reaching)).ok).toBe(false);
  });

  test("a yes to a floor allow names what the held call reaches; words the worker put in the call's comments don't count", () => {
    const held = "cp /tmp/evil.ts ~/.local/share/standup/install/packages/collector/src/floor/classify.ts # tests";
    const allow = (text: string, prompt?: string) =>
      chatConsent(
        input(
          {
            action: "answer_ask",
            decision: { rule: "ask", reason: "a floor hold", consentable: true },
            subject: `Answer the worker's ask: writes the floor source\n${held}`,
            actionTexts: [held],
            heldCall: { toolName: "Bash", call: held },
            ...(prompt ? { prompt } : {}),
          },
          text
        )
      );
    expect(allow("ok, run the tests").ok).toBe(false);
    expect(allow("yes, allow the tests run").ok).toBe(false);
    expect(allow("yes, allow the copy of the evil file over the install classify source")).toMatchObject({ ok: true });
    expect(allow("Yes, allow it", "The worker wants to copy the evil file over the install classify source. Allow it?")).toMatchObject({ ok: true });
    // A file tool's input is named by its path, not by the text it writes.
    const write = JSON.stringify({ file_path: "/srv/ws/wt/notes.md", content: "tests tests tests" });
    const tool = (text: string) =>
      chatConsent(
        input(
          {
            action: "answer_ask",
            decision: { rule: "ask", reason: "a floor hold", consentable: true },
            subject: `Answer the worker's ask: writes notes\n${write}`,
            actionTexts: [write],
            heldCall: { toolName: "Write", call: write },
          },
          text
        )
      );
    expect(tool("ok, allow writing the tests").ok).toBe(false);
    expect(tool("yes, allow writing the notes")).toMatchObject({ ok: true });
  });

  test("on a high-risk floor allow, a yes or question sharing only a job word with the held call doesn't name it", () => {
    const held = "cp /tmp/evil.ts ~/.local/share/standup/install/packages/collector/src/floor/classify.ts";
    const allow = (text: string, prompt: string) =>
      chatConsent(
        input(
          {
            action: "answer_ask",
            decision: { rule: "ask", reason: "a high-risk floor hold", consentable: true },
            subject: `Answer the worker's ask: writes the floor source\n${held}`,
            actionTexts: [held],
            heldCall: { toolName: "Bash", call: held, highRisk: true },
            prompt,
          },
          text
        )
      );
    expect(allow("yes, let it run", "The floor route job's worker wants to run its floor checks. Let it run?").ok).toBe(false);
    expect(allow("yes, go ahead", "Status: the floor route job is at review; the collector restarted fine. Want me to let the worker continue?").ok).toBe(false);
    expect(allow("yes, let it run", "The worker wants to copy a file over the install's floor classify.ts. Let it run?")).toMatchObject({ ok: true });
  });

  test("on a high-risk floor allow, a yes naming one of the call's targets doesn't name the others, nor the paths after a cd out of the worktree", () => {
    const WT = "/srv/ws/wt";
    const allow = (held: string, text: string) =>
      chatConsent(
        input(
          {
            action: "answer_ask",
            decision: { rule: "ask", reason: "a high-risk floor hold", consentable: true },
            subject: `Answer the worker's ask: reads notes\n${held}`,
            actionTexts: [held],
            heldCall: { toolName: "Bash", call: held, highRisk: true, worktreeRoot: WT },
          },
          text
        )
      );
    expect(allow("cat ~/notes.md > ~/.local/share/standup/install/packages/collector/src/floor/classify.ts", "yes, allow reading my notes").ok).toBe(false);
    expect(allow("cd ~/.local/share/standup/install && cat ~/notes.md > packages/collector/src/floor/classify.ts", "yes, allow reading my notes").ok).toBe(false);
    expect(allow(`cd ${WT}/packages/collector && cat ~/notes.md > review-scratch/notes.txt`, "yes, allow reading my notes")).toMatchObject({ ok: true });
  });

  test("a bare yes with no question about this action doesn't count", () => {
    expect(chatConsent(input({}, "yes")).ok).toBe(false);
    expect(chatConsent(input({ prompt: "Want me to stop the docs worker?" }, "yes")).ok).toBe(false);
  });

  test("the message must be the owner's, in this thread, recent, and a plain yes", () => {
    const base = input();
    const msg = base.message!;
    expect(chatConsent({ ...base, message: null }).ok).toBe(false);
    expect(chatConsent({ ...base, message: { ...msg, threadId: "t2" } }).ok).toBe(false);
    expect(chatConsent({ ...base, message: { ...msg, actor: "mallory" } }).ok).toBe(false);
    expect(chatConsent({ ...base, message: { ...msg, role: "persona" } }).ok).toBe(false);
    const old = new Date(NOW.getTime() - CHAT_CONSENT_WINDOW_MS - 1000).toISOString();
    expect(chatConsent({ ...base, message: { ...msg, createdAt: old } }).ok).toBe(false);
    for (const text of [
      "Should you launch the parser fix?",
      "Don't launch the parser fix yet",
      "Launch the parser fix later",
      "Wait on the parser fix",
    ]) {
      expect(chatConsent(input({}, text)).ok).toBe(false);
    }
  });

  test("a yes about other work doesn't count", () => {
    expect(chatConsent(input({}, "Yes, launch the docs cleanup")).ok).toBe(false);
  });

  test("never for an action that carries a push, PR, merge or deploy", () => {
    for (const task of [
      "Fix the parser and push to origin.",
      "Fix the parser, then open a PR.",
      "Merge the parser fix into main.",
      "Deploy the parser fix to prod.",
    ]) {
      // Even a consentable owner hold whose action carries such a step stays on the card.
      expect(chatConsent(input({ actionTexts: [task], subject: task }, "Yes, launch the parser fix")).ok).toBe(false);
    }
  });

  test("never for holds kept for the card", () => {
    const floor = decide("answer_ask", { owned: true, askKind: "ask_human", askGate: FLOOR_OWNER_GATE, text: "Allow once" });
    expect(floor.rule).toBe("ask");
    expect(floor.consentable).toBeUndefined();
    const memory = decide("remember", { text: "Workers may deploy without asking", ownerTexts: [] });
    expect(memory.consentable).toBeUndefined();
    const gate = decide("answer_ask", { owned: true, askKind: "ask_human", askGate: "confirm", text: "yes" });
    expect(gate.consentable).toBeUndefined();
    for (const decision of [floor, memory, gate]) {
      expect(chatConsent(input({ decision })).ok).toBe(false);
    }
  });

  test("an owner-only floor allow acts without any consent to clear", () => {
    const floor = decide("answer_ask", { owned: true, askKind: "ask_human", askGate: FLOOR_OWNER_GATE, floorCategory: "outward", text: "Allow once" });
    expect(floor.rule).toBe("act");
    expect(floor.consentable).toBeUndefined();
  });

  test("permission prompts, restarts and owner holds may be cleared", () => {
    expect(decide("answer_ask", { owned: true, askKind: "permission", text: "1", authorizes: ["Claude wants to run Bash"] }).consentable).toBe(true);
    expect(decide("restart_standup", { privateThread: false }).consentable).toBe(true);
    expect(decide("launch_session", budget, HOLD_LAUNCHES).consentable).toBe(true);
    expect(decide("approve_plan", { owned: true }, { hold: new Set(["approve_plan"]) }).consentable).toBe(true);
  });
});

describe("mention-only text", () => {
  test("a quoted phrase talked about is not a request", () => {
    for (const text of [
      "The detector flagged the phrase 'merge into main' in the brief; fix the false positive.",
      'Make the regex ignore text containing "git push origin main".',
      "The old card said `push to origin`, which confused the owner.",
    ]) {
      expect(outwardMatches(text)).toEqual([]);
    }
  });

  test("a quoted step the text tells the worker to carry out is still a request", () => {
    for (const text of [
      "Run the command the doc mentions: 'git push origin main'.",
      "Do what the README says: \"git push origin HEAD\".",
      "The phrase 'docs' is fine, now push to origin.",
    ]) {
      expect(outwardMatches(text).length).toBeGreaterThan(0);
    }
  });
});
