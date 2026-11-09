import { describe, expect, test } from "bun:test";
import { FLOOR_HIGH_RISK_LABEL, FLOOR_OWNER_GATE } from "../floor/gate.js";
import { ALLOW_CHECK_SYSTEM_PROMPT, allowCheckPrompt, asksOneStep, ownerApproved, ruleCheck, runAllowCheck, type AllowChecker, type AllowCheckInput } from "./allow-check.js";
import { SCRATCH_INSTANCE } from "./consent-target.js";
import { ownerProhibits, ownerYes } from "./policy.js";

/*
 * The owner's yes in the job's thread, sent after the hold, is their ask for
 * the held step even when the job's goal and brief never name it: a scratch
 * collector the owner said to run, or a push they said yes to. It covers only
 * the step it names, the owner's latest word on it wins, quoted text is not
 * theirs, and secrets stay out of Persona's reach whatever they say.
 */

/** The floor's complete isolation under one scratch root, with the run's scratch port and off-network flags. */
const ISOLATED =
  "HOME=/tmp/r/home XDG_CONFIG_HOME=/tmp/r/xdg/config XDG_DATA_HOME=/tmp/r/xdg/data XDG_STATE_HOME=/tmp/r/xdg/state XDG_CACHE_HOME=/tmp/r/xdg/cache " +
  "DB_PATH=/tmp/r/data/standup.db STANDUP_SQLITE_PATH=/tmp/r/data/standup.db KNOWLEDGE_DIR=/tmp/r/knowledge STANDUP_INTERNAL_ROOT=/tmp/r/internal TMUX_TMPDIR=/tmp/r/tmux " +
  "COLLECTOR_PORT=29777 WS_PORT=29778 STANDUP_BIND_HOST=127.0.0.1 STANDUP_GATEWAY=0 STANDUP_PERSONA=0 STANDUP_REVIEW_TUNNELS=0 STANDUP_DIGEST=0";

/** A scratch collector started in the background beside its health check, as a worker types it. */
const SCRATCH_START = `env -i PATH=/usr/bin:/bin ${ISOLATED} bun run src/index.ts > /tmp/r/c.log 2>&1 & sleep 3; curl -s http://127.0.0.1:29777/health`;

function input(over: Partial<AllowCheckInput> = {}): AllowCheckInput {
  return {
    owner: "alice",
    selfAliases: ["alice"],
    gate: FLOOR_OWNER_GATE,
    category: "floor-tamper",
    floorReason: `${FLOOR_HIGH_RISK_LABEL}code in src/index.ts names Standup's data dir`,
    toolName: "Bash",
    call: SCRATCH_START,
    personaReason: "the worker checks its change on a scratch collector",
    job: { title: "floor route", goal: "fix the floor route" },
    brief: "Fix the floor route and its tests.",
    ownerMessages: ["fix the floor route"],
    preferences: [],
    worktreeRoot: "/srv/ws/wt",
    ...over,
  };
}

const push = (over: Partial<AllowCheckInput> = {}) =>
  input({ category: "outward", floorReason: "pushes a branch", call: "git push origin HEAD", personaReason: "the branch is ready", ...over });

/** Persona's question naming this job's scratch collector start. */
const ASKED_HERE = "The floor route worker wants to start a scratch copy of the collector under /tmp to check its change. Should it?";

describe("the owner's yes in the job's thread since the hold", () => {
  test("a scratch collector the owner said to run is placed, though the job's goal and brief never name it", () => {
    expect(ruleCheck(input())).toMatchObject({ verdict: "flag", reason: expect.stringContaining("never asked for this floor-tamper step") });
    for (const text of ["Yes, run the scratch collector", "ok, start the scratch collector", "go ahead and run the isolated instance", "Persona, yes, start the scratch copy of the collector"]) {
      expect({ text, verdict: ruleCheck(input({ ownerApprovals: [{ text }] })).verdict }).toEqual({ text, verdict: "allow" });
    }
  });

  test("a bare scratch copy names no collector: it is placed only through Persona's question about this job's collector start", () => {
    expect(SCRATCH_INSTANCE.test("the scratch copy")).toBe(false);
    expect(SCRATCH_INSTANCE.test("make a scratch copy of the db")).toBe(false);
    expect(SCRATCH_INSTANCE.test("a scratch copy of the collector")).toBe(true);
    expect(SCRATCH_INSTANCE.test("a scratch copy of standup")).toBe(true);
    expect(ruleCheck(input({ ownerApprovals: [{ text: "Yes, run the scratch copy" }] })).verdict).toBe("flag");
    const answered = input({ ownerApprovals: [{ text: "Yes, run the scratch copy", prompt: ASKED_HERE }] });
    expect(ownerApproved(answered, answered.call)).toBe(true);
    expect(ruleCheck(answered).verdict).toBe("allow");
    // A copy of the database is not a collector start, whatever the question asked.
    for (const text of ["Yes, make a scratch copy of the db", "yes, run the scratch copy of the database"]) {
      const db = input({ ownerApprovals: [{ text, prompt: ASKED_HERE }] });
      expect({ text, approved: ownerApproved(db, db.call), verdict: ruleCheck(db).verdict }).toEqual({ text, approved: false, verdict: "flag" });
    }
  });

  test("a short yes is placed by the question of Persona's it answers, only when that question names this job and the step", () => {
    expect(ruleCheck(input({ ownerApprovals: [{ text: "yes", prompt: ASKED_HERE }] })).verdict).toBe("allow");
    expect(ruleCheck(input({ job: { id: "4f2a9c1e-77aa-4b0e-9c1d-00000000000a", title: "floor route", goal: "fix the floor route" }, ownerApprovals: [{ text: "yes please", prompt: "Job 4f2a9c1e wants to start a scratch collector under /tmp. Should it?" }] })).verdict).toBe("allow");
    // A question that names the step but not the job, or names another worker's job too, places nothing.
    for (const prompt of [
      "The worker wants to run a scratch copy of the collector under /tmp to check the route. Run it?",
      "Worker B (job: docs) wants to start a scratch collector under /tmp. Should it?",
      "The floor route worker and the docs worker both want a scratch collector under /tmp. Should they?",
      "The docs job wants to start a scratch collector under /tmp, like the floor route one. Should it?",
      "Should the worker push its branch on floor route?",
    ]) {
      const v = input({ ownerApprovals: [{ text: "yes", prompt }] });
      expect({ prompt, approved: ownerApproved(v, v.call), verdict: ruleCheck(v).verdict }).toEqual({ prompt, approved: false, verdict: "flag" });
    }
    // A statement of Persona's is no question a yes answers.
    expect(ruleCheck(input({ ownerApprovals: [{ text: "yes", prompt: "The floor route worker wants to start a scratch copy of the collector." }] })).verdict).toBe("flag");
  });

  test("a deferral, an aside, a retraction, a condition or a recollection is no yes", () => {
    for (const text of [
      "ok I see the scratch collector got held, let me think about it",
      "Thanks! Yes it ran the scratch collector fine yesterday. Today hold everything.",
      "yes run the scratch copy. Actually, scratch that, I'll do it myself",
      "sure, but first explain why the scratch collector needs this",
      "Yes, make a scratch copy of the db",
      "yes, run the scratch collector if the tests pass",
      "yes run the scratch collector?",
      "ok the scratch collector is fine I guess",
      "yes, start the scratch collector instead of the tests",
    ]) {
      for (const prompt of [undefined, ASKED_HERE]) {
        const v = input({ ownerApprovals: [{ text, ...(prompt ? { prompt } : {}) }] });
        expect({ text, prompt, approved: ownerApproved(v, v.call), verdict: ruleCheck(v).verdict }).toEqual({ text, prompt, approved: false, verdict: "flag" });
      }
    }
  });

  test("a yes with a condition, a deferral or an exception attached is no yes", () => {
    for (const text of [
      "Yes, run the scratch collector once I have reviewed the plan.",
      "Yes, run the scratch collector after the tests pass.",
      "Yes, start the scratch collector when I am back at my desk.",
      "Yes, start the scratch collector whenever the build is green.",
      "Yes, run the scratch collector, assuming it stays under /tmp.",
      "Yes, start the scratch collector provided the diff is small.",
      "Yes, run the scratch collector as long as nothing else is running.",
      "Yes, run the scratch collector so long as it stays local.",
      "Yes, run the scratch collector tomorrow morning.",
      "Yes, run the scratch collector tonight.",
      "Yes, run the scratch collector later today.",
      "Yes, run the scratch collector next.",
      "Yes, run the scratch collector except for the digest part.",
      "Yes, run the scratch collector other than the digest part.",
      "Yes, run the scratch collector only if the tests pass.",
      "Yes, run the scratch collector pending my review.",
      "Yes, run the scratch collector after review.",
      "Yes, run the scratch collector while I watch the logs.",
    ]) {
      expect({ text, yes: ownerYes(text).yes }).toEqual({ text, yes: false });
      for (const prompt of [undefined, ASKED_HERE]) {
        const v = input({ ownerApprovals: [{ text, ...(prompt ? { prompt } : {}) }] });
        expect({ text, prompt, approved: ownerApproved(v, v.call), verdict: ruleCheck(v).verdict }).toEqual({ text, prompt, approved: false, verdict: "flag" });
      }
    }
    // A plain yes is still one.
    for (const text of ["Yes, run the scratch collector", "ok, start the scratch collector", "yes please"]) {
      expect({ text, yes: ownerYes(text).yes }).toEqual({ text, yes: true });
    }
  });

  test("a prohibition in words other than never, don't, no or stop forbids the step, beside a later yes too", () => {
    const forbidding = [
      "Avoid starting scratch collectors in this job.",
      "Skip the scratch collector, I will check it myself.",
      "Please refrain from running a scratch collector.",
      "Scratch collectors are off limits for this job.",
      "Scratch collectors are off-limits here.",
      "I would rather you not start an isolated collector.",
      "I'd rather you didn't start a scratch collector.",
      "Starting a scratch collector is not allowed on this job.",
      "A scratch collector is not okay here.",
      "Scratch collectors are forbidden in this job.",
      "Please don't start a scratch collector.",
      "Hold off on the scratch collector.",
    ];
    const yes = { text: "Yes, run the scratch collector." };
    for (const text of forbidding) {
      expect({ text, clauses: ownerProhibits(text).clauses.length > 0 }).toEqual({ text, clauses: true });
      for (const over of [{ ownerMessages: ["fix the floor route", text] }, { preferences: [text] }, { ownerApprovals: [{ text }, yes] }]) {
        const v = input({ ownerApprovals: [yes], ...over });
        expect({ text, over, approved: ownerApproved(v, v.call), verdict: ruleCheck(v).verdict }).toEqual({ text, over, approved: false, verdict: "flag" });
      }
    }
    expect(ownerApproved(input({ preferences: ["Skip scratch collectors."], ownerApprovals: [yes] }), SCRATCH_START)).toBe(false);
    // A prohibition of another step leaves the yes standing.
    const other = input({ preferences: ["avoid pushing to main"], ownerApprovals: [yes] });
    expect(ownerApproved(other, other.call)).toBe(true);
  });

  test("a bare yes to a question naming this step and another approves neither", () => {
    const both = "The floor route worker wants to start a scratch copy of the collector under /tmp and then push HEAD to origin/main. Should it?";
    const pushMain = (over: Partial<AllowCheckInput>) => push({ call: "git push origin HEAD:main", ...over });
    for (const prompt of [
      both,
      "The floor route worker wants to start a scratch copy of the collector under /tmp and push its branch. Should it?",
      "The floor route worker wants to start a scratch copy of the collector under /tmp, plus push HEAD to origin/main. Should it?",
      "The floor route worker wants to start a scratch copy of the collector under /tmp and also push HEAD to origin/main. Should it?",
      "The floor route worker wants to push HEAD to origin/main and cut a PR. Should it?",
    ]) {
      for (const v of [pushMain({ ownerApprovals: [{ text: "yes", prompt }] }), input({ ownerApprovals: [{ text: "yes", prompt }] })]) {
        expect({ prompt, call: v.call, approved: ownerApproved(v, v.call) }).toEqual({ prompt, call: v.call, approved: false });
      }
      const cited = input({ ownerConsent: "yes", ownerConsentPrompt: prompt });
      expect({ prompt, approved: ownerApproved(cited, cited.call) }).toEqual({ prompt, approved: false });
    }
    // A bare no to such a question still takes an earlier yes back.
    expect(ruleCheck(input({ ownerApprovals: [{ text: "Yes, run the scratch collector" }, { text: "no", prompt: both }] })).verdict).toBe("flag");
    // A question about the one step still places a bare yes.
    expect(ruleCheck(input({ ownerApprovals: [{ text: "yes", prompt: ASKED_HERE }] })).verdict).toBe("allow");
    expect(asksOneStep(ASKED_HERE)).toBe(true);
    expect(asksOneStep(both)).toBe(false);
  });

  test("an owner message or standing preference forbidding the step wins over a yes, before or after it", () => {
    const yes = { text: "yes", prompt: ASKED_HERE };
    const forbidding: Array<Partial<AllowCheckInput>> = [
      { preferences: ["Never start scratch collectors without asking me on a call first"] },
      { ownerMessages: ["fix the floor route", "never start a scratch collector on this job"] },
      { ownerThreadMessages: ["fix the floor route", "don't start the scratch collector"] },
      { ownerThreadMessages: ["hold everything"] },
      { ownerApprovals: [{ text: "never run a scratch copy here" }, yes] },
      { ownerApprovals: [yes, { text: "stop the scratch collector" }] },
    ];
    for (const over of forbidding) {
      const v = input({ ownerApprovals: [yes], ...over });
      expect({ over, approved: ownerApproved(v, v.call), verdict: ruleCheck(v).verdict }).toEqual({ over, approved: false, verdict: "flag" });
    }
    // A prohibition of another step leaves the yes standing.
    const other = input({ preferences: ["never push to main"], ownerApprovals: [yes] });
    expect(ownerApproved(other, other.call)).toBe(true);
  });

  test("the owner's latest word on the step wins: a later no, a hold-off or a question takes the yes back", () => {
    const yes = { text: "Yes, run the scratch collector" };
    for (const later of ["no, don't run the scratch copy", "wait on the scratch copy until I say", "should it run the scratch collector?"]) {
      expect({ later, verdict: ruleCheck(input({ ownerApprovals: [yes, { text: later }] })).verdict }).toEqual({ later, verdict: "flag" });
    }
    // A bare no answering the question about the step takes it back.
    expect(ruleCheck(input({ ownerApprovals: [yes, { text: "no", prompt: ASKED_HERE }] })).verdict).toBe("flag");
    // A deferral is lifted by a later yes.
    expect(ruleCheck(input({ ownerApprovals: [{ text: "don't run the scratch copy yet" }, yes] })).verdict).toBe("allow");
    // A later message about something else leaves the yes standing.
    expect(ruleCheck(input({ ownerApprovals: [yes, { text: "thanks, and don't push yet" }] })).verdict).toBe("allow");
  });

  test("a yes to one step never carries over to another", () => {
    expect(ruleCheck(input({ ownerApprovals: [{ text: "yes, push the branch" }] })).verdict).toBe("flag");
    expect(ruleCheck(input({ ownerApprovals: [{ text: "yes, push the branch", prompt: ASKED_HERE }] })).verdict).toBe("flag");
    expect(ruleCheck(push()).verdict).toBe("flag");
    expect(ruleCheck(push({ ownerApprovals: [{ text: "Yes, run the scratch collector" }] })).verdict).toBe("flag");
    expect(ruleCheck(push({ ownerApprovals: [{ text: "yes, push the branch" }] })).verdict).toBe("allow");
    // A yes to a scratch run never covers a start that isn't one: a DB outside /tmp.
    const live = input({ call: SCRATCH_START.replace("DB_PATH=/tmp/r/data/standup.db", "DB_PATH=/srv/standup.db"), ownerApprovals: [{ text: "Yes, run the scratch collector" }] });
    expect(ruleCheck(live).verdict).toBe("flag");
    // Nor a scratch run whose floor reason names more than its isolation.
    const more = input({ floorReason: `${FLOOR_HIGH_RISK_LABEL}code names Standup's data dir (also outward: pushes a branch)`, ownerApprovals: [{ text: "Yes, run the scratch collector" }] });
    expect(ruleCheck(more).verdict).toBe("flag");
  });

  test("quoted, fenced or reported text in the owner's message is not their yes", () => {
    for (const text of ["> Yes, run the scratch collector\nwhat does the worker mean by this?", "the worker wrote:\n```\nYes, run the scratch collector\n```", 'the worker said "yes, run the scratch collector"']) {
      expect({ text, verdict: ruleCheck(input({ ownerApprovals: [{ text }] })).verdict }).toEqual({ text, verdict: "flag" });
    }
  });

  test("secrets and process memory stay flagged whatever the owner says, and the collector's API is never placed by a yes", () => {
    for (const call of ["cat ~/.aws/credentials", "cat ~/.local/share/standup/secrets/owner-token", "cat /proc/1/environ"]) {
      const v = ruleCheck(input({ call, floorReason: `${FLOOR_HIGH_RISK_LABEL}reads owner-side secrets`, ownerApprovals: [{ text: `yes, run ${call}` }] }));
      expect({ call, reason: v.reason }).toEqual({ call, reason: expect.stringContaining("reads or moves secrets") });
    }
    const api = push({ category: "collector-api", call: "curl -X POST http://127.0.0.1:7777/api/asks/a/resolve", ownerApprovals: [{ text: "yes, resolve the ask with curl" }] });
    expect(ruleCheck(api).verdict).toBe("flag");
  });

  test("a reason quoting the owner's yes since the hold is backed by it", () => {
    const quoted = input({ personaReason: 'alice said "Yes, run the scratch collector"', ownerApprovals: [{ text: "Yes, run the scratch collector" }] });
    expect(ruleCheck(quoted).verdict).toBe("allow");
    expect(ruleCheck({ ...quoted, ownerApprovals: [] }).verdict).toBe("flag");
  });

  test("ownerApproved reads the validated yes Persona cites as well", () => {
    const cited = input({ ownerConsent: "Yes, run the scratch collector" });
    expect(ownerApproved(cited, cited.call)).toBe(true);
    expect(ruleCheck(cited).verdict).toBe("allow");
    // A preference forbidding the step outweighs the cited yes too.
    const forbidden = { ...cited, preferences: ["never start a scratch collector"] };
    expect(ownerApproved(forbidden, forbidden.call)).toBe(false);
  });
});

describe("the model layer and the owner's yes since the hold", () => {
  const model = (verdict: "allow" | "flag" = "flag") => {
    const m = {
      name: "fake",
      calls: 0,
      seen: [] as string[],
      check: async (i: AllowCheckInput): Promise<{ verdict: "allow" | "flag"; reason: string }> => {
        m.calls++;
        m.seen.push(allowCheckPrompt(i));
        return { verdict, reason: verdict === "flag" ? "the job's goal and brief never name this step" : "the owner asked for it" };
      },
    };
    return m as AllowChecker & { calls: number; seen: string[] };
  };

  test("a scratch run's hold the owner said yes to still goes to the model, whose verdict stands", async () => {
    for (const ownerApprovals of [[{ text: "Yes, run the scratch collector" }], [{ text: "Yes, run the scratch copy", prompt: ASKED_HERE }]]) {
      const allows = model("allow");
      expect(await runAllowCheck(input({ ownerApprovals }), { model: allows, modelTimeoutMs: 1000 })).toMatchObject({ verdict: "allow", by: "fake" });
      expect(allows.calls).toBe(1);
      expect(allows.seen[0]).toContain(ownerApprovals[0]!.text);
      const denies = model("flag");
      expect(await runAllowCheck(input({ ownerApprovals }), { model: denies, modelTimeoutMs: 1000 })).toMatchObject({ verdict: "flag", by: "fake" });
      expect(denies.calls).toBe(1);
    }
    // Without the yes the rules flag it, and the model is not asked.
    const m = model("allow");
    expect(await runAllowCheck(input(), { model: m, modelTimeoutMs: 1000 })).toMatchObject({ verdict: "flag", by: "rules" });
    expect(m.calls).toBe(0);
  });

  test("an aside, a yes about another worker or a forbidding preference is no consent; where the job asks for the run anyway, the model still decides", async () => {
    const cases: Array<Partial<AllowCheckInput>> = [
      { ownerApprovals: [{ text: "ok I see the scratch collector got held, let me think about it" }] },
      { ownerApprovals: [{ text: "Thanks! Yes it ran the scratch collector fine yesterday. Today hold everything." }] },
      { ownerApprovals: [{ text: "yes run the scratch copy. Actually, scratch that, I'll do it myself", prompt: ASKED_HERE }] },
      { ownerApprovals: [{ text: "sure, but first explain why the scratch collector needs this" }] },
      { ownerApprovals: [{ text: "Yes, make a scratch copy of the db", prompt: ASKED_HERE }] },
      { ownerApprovals: [{ text: "yes", prompt: "Worker B (job: docs) wants to start a scratch collector under /tmp. Should it?" }] },
      { preferences: ["Never start scratch collectors without asking me on a call first"], ownerApprovals: [{ text: "yes", prompt: ASKED_HERE }] },
      { ownerMessages: ["fix the floor route", "never start a scratch collector on this job"], ownerApprovals: [{ text: "yes", prompt: ASKED_HERE }] },
    ];
    for (const over of cases) {
      const m = model("allow");
      const v = input(over);
      expect({ over, approved: ownerApproved(v, v.call) }).toEqual({ over, approved: false });
      // No consent: the rules flag the step, so the hold stays blocked.
      expect({ over, r: await runAllowCheck(v, { model: m, modelTimeoutMs: 1000 }) }).toMatchObject({ over, r: { verdict: "flag", by: "rules" } });
      // With the job itself asking for a scratch collector the rules let it through, and a denying model blocks it.
      const asked = input({ ...over, job: { title: "floor route", goal: "fix the floor route, then start a scratch collector to check it" } });
      const denies = model("flag");
      expect({ over, r: await runAllowCheck(asked, { model: denies, modelTimeoutMs: 1000 }) }).toMatchObject({ over, r: { verdict: "flag", by: "fake" } });
      expect({ over, calls: denies.calls }).toEqual({ over, calls: 1 });
    }
  });

  test("on any other step the model still weighs it, and sees the owner's messages since the hold and their cited yes", async () => {
    const m = model();
    const r = await runAllowCheck(push({ ownerApprovals: [{ text: "yes, push the branch", prompt: "Push it?" }], ownerConsent: "yes, push the branch" }), { model: m, modelTimeoutMs: 1000 });
    expect(r).toMatchObject({ verdict: "flag", by: "fake" });
    expect(m.calls).toBe(1);
    expect(m.seen[0]).toContain("messages in the job's thread since the hold");
    expect(m.seen[0]).toContain("«yes, push the branch (answering: Push it?)»");
    // A message since the hold is listed as one that can ask for the step, never among those that only rule steps out.
    const since = push({ ownerThreadMessages: ["fix the floor route", "yes, push the branch"], ownerApprovals: [{ text: "yes, push the branch" }] });
    expect(allowCheckPrompt(since)).toContain("never ask for it):\n- (none)");
    expect(m.seen[0]).toContain("The owner's yes the orchestrator cites");
    expect(ALLOW_CHECK_SYSTEM_PROMPT).toContain("is the owner asking for it");
    expect(ALLOW_CHECK_SYSTEM_PROMPT).toContain("never covers another");
  });
});
