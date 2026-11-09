import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { getAsk, listPersonaFloorDecisions } from "@standup/store";
import { PERSONA_TOKEN_HEADER } from "./routes.js";
import { ownerOnlyHold } from "./delegates.js";
import type { AllowChecker } from "./allow-check.js";
import {
  HIGH_RISK,
  OWNER,
  actionRecords,
  cardsFor,
  escalate,
  harness as openHarness,
  hold,
  until,
} from "./delegate-test-harness.js";
import type { Call, ClientHold, Harness, Rule } from "./delegate-test-harness.js";
import { setActiveOrgProfile } from "../org-profile/load.js";
import { exampleCorpProfile } from "../org-profile/fixtures/example-corp.js";

// The example.corp fixture profile: ROUTINE prints its SSO cookie, a hold Persona decides.
beforeAll(() => setActiveOrgProfile(exampleCorpProfile()));
afterAll(() => setActiveOrgProfile());

/*
 * A high-risk floor hold whose allow the second check flags goes to the hold
 * delegate's review, not straight to the owner's card, unless it is one of
 * the owner's own (ownerOnlyHold). The real floor and tool routes, stub main
 * and delegate turns, and a stub model layer of the check that flags.
 */

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

const CHECK_REASON = "the brief asks to fix the docs sync, not to rehearse a restart";
const flagging: AllowChecker = { name: "stub", check: async () => ({ verdict: "flag", reason: CHECK_REASON }) };
const harness = (env: Record<string, string> = {}): Harness => {
  const h = openHarness(env, { allowChecker: flagging });
  open.push(h);
  return h;
};

// Held commands are built at run time.
// A scratch collector under its own /tmp root: every env var that places Standup's state points there.
const R = "/tmp/rehearsal-1";
const REHEARSAL =
  `env -u TMUX -u TMUX_PANE HOME=${R}/home XDG_CONFIG_HOME=${R}/xdg/config XDG_DATA_HOME=${R}/xdg/data XDG_STATE_HOME=${R}/xdg/state ` +
  `XDG_CACHE_HOME=${R}/xdg/cache DB_PATH=${R}/data/standup.db STANDUP_SQLITE_PATH=${R}/data/standup.db KNOWLEDGE_DIR=${R}/knowledge ` +
  `STANDUP_INTERNAL_ROOT=${R}/internal STANDUP_PROJECT_DOCS_DIR=${R}/docs TMPDIR=${R}/tmp TMP=${R}/tmp TEMP=${R}/tmp TMUX_TMPDIR=${R}/tmux PORT=17891 ` +
  `bun run src/restart-rehearsal.ts`;
const REHEARSAL_HOLD: ClientHold = {
  category: "floor-tamper",
  ownerReserved: true,
  reason: "starts a Standup collector under /tmp/rehearsal-1, on its own tmux socket and ports",
};
const INSTALL_WRITE = ["bun", "add", "left-pad"].join(" ");
const INSTALL_HOLD: ClientHold = {
  category: "floor-tamper",
  ownerReserved: true,
  reason: "`bun add` writes dependencies into the Standup install (/opt/standup), which the collector loads on its next start",
};
const DB_WRITE = ["sqlite3", "standup.db", "'DELETE FROM asks'"].join(" ");
const DB_HOLD: ClientHold = {
  category: "floor-tamper",
  ownerReserved: true,
  reason: "`sqlite3` writes Standup's own data (standup.db), which holds asks and launch args",
};

/** A stub delegate that allows on its first look and answers its review with `onReview`. */
function allowThenReview(onReview: Rule["act"], firstResults: string[] = []): Rule["act"] {
  const seen = new Set<string>();
  return async (askId, call) => {
    if (seen.has(askId)) return onReview(askId, call);
    seen.add(askId);
    const tried = await call("answer_ask", { askId, answer: "Allow once", reason: "the job runs an isolated restart rehearsal" });
    firstResults.push(tried.text);
  };
}
const answer = (text: string, reason: string) => async (askId: string, call: Call) => {
  await call("answer_ask", { askId, answer: text, reason });
};
const records = (h: Harness, askId: string) =>
  actionRecords(h)
    .map((r) => JSON.parse(r.value_json) as Record<string, unknown>)
    .filter((v) => (v.target as Record<string, string> | undefined)?.askId === askId);

describe("a flagged high-risk allow with the hold delegate on", () => {
  test("of an isolated /tmp harness run is decided by the delegate's review, with no owner card", async () => {
    const h = harness();
    h.runtime.postMessage({ threadId: h.job.threadId, role: "user", actor: OWNER, jobIds: [h.job.id], text: "check the sync survives a collector restart too" });
    const first: string[] = [];
    h.rules.push({ match: REHEARSAL, act: allowThenReview(answer("Allow once", "an isolated /tmp rehearsal the job's live check needs"), first) });
    const { askId, reply } = await hold(h, REHEARSAL, REHEARSAL_HOLD);
    expect(getAsk(h.store.db, askId)!.question).toContain("HIGH RISK");
    expect(await reply).toMatchObject({ decision: "allow" });
    expect(first[0]).toContain("hold delegate's review");
    expect(h.laneTurns).toHaveLength(2);
    // The review turn saw the hold, the check's reason, the brief and the job's goal.
    const review = h.laneTurns[1]!.prompt;
    expect(review).toContain(`- review ${askId}`);
    const ran = records(h, askId).find((v) => v.outcome === "executed")!;
    const checkReason = (ran.delegateReview as { checkReason: string }).checkReason;
    // The rules pass a scratch run; the model layer's flag is what the delegate reviews.
    expect(checkReason).toBe(CHECK_REASON);
    expect(review).toContain(`the second check flagged the allow: ${checkReason}`);
    expect(review).toContain("restart-rehearsal.ts");
    expect(review).toContain("check the sync survives a collector restart too");
    expect(review).toContain("Find out why the nightly docs sync can't reach the internal wiki");
    expect(review).toContain("fix the docs sync's wiki sign-in");
    expect(cardsFor(h, askId)).toHaveLength(0);
    expect(h.mainTurns).toHaveLength(0);
    expect(ran).toMatchObject({ reason: "an isolated /tmp rehearsal the job's live check needs", delegateReview: { allowedBy: "the hold delegate" } });
    // The owner's floor-decision record (job drawer, You tab) shows the flag the review allowed past.
    const [decision] = listPersonaFloorDecisions(h.store.db, OWNER, { jobId: h.job.id });
    expect(decision).toMatchObject({ askId, checkFlag: CHECK_REASON });
    expect(decision!.reason).toContain("The hold delegate's review allowed it past the second check's flag");
  });

  test("a review the delegate leaves undecided goes to the owner's card", async () => {
    const h = harness();
    h.rules.push({ match: REHEARSAL, act: allowThenReview(async () => {}) });
    const { askId } = await hold(h, REHEARSAL, REHEARSAL_HOLD);
    const [card] = await until(() => (cardsFor(h, askId).length > 0 ? cardsFor(h, askId) : null), "the owner's card");
    expect(JSON.stringify(card)).toContain("left it undecided");
    expect(h.mainTurns).toHaveLength(0);
  });

  test("Persona's own flagged allow goes to the delegate's review too", async () => {
    const h = harness();
    let looks = 0;
    h.rules.push({
      match: REHEARSAL,
      act: async (askId, call) => {
        if (looks++ === 0) return escalate("allow_once", "a scratch rehearsal; the main Persona knows the job")(askId, call);
        await answer("Allow once", "the rehearsal stays under its /tmp root")(askId, call);
      },
    });
    const { askId, reply } = await hold(h, REHEARSAL, REHEARSAL_HOLD);
    await until(() => h.mainTurns.length > 0, "the main turn");
    const res = await h.app.request("/api/persona/tool", {
      method: "POST",
      headers: { "content-type": "application/json", [PERSONA_TOKEN_HEADER]: h.runtime.token },
      body: JSON.stringify({ name: "answer_ask", arguments: { askId, answer: "Allow once", reason: "the job's live check runs a scratch collector" } }),
    });
    const body = (await res.json()) as { content: Array<{ text: string }> };
    expect(body.content[0]!.text).toContain("hold delegate's review");
    expect(await reply).toMatchObject({ decision: "allow" });
    expect(cardsFor(h, askId)).toHaveLength(0);
    expect(records(h, askId).find((v) => v.outcome === "executed")).toMatchObject({ delegateReview: { allowedBy: "Persona" } });
  });

  for (const [name, act, why] of [
    ["denies it", answer("Deny", "the brief never asks for a restart"), "the brief never asks for a restart"],
    ["has concerns", escalate("ask_owner", "unsure the rehearsal stays off the live tmux server"), "unsure the rehearsal stays off the live tmux server"],
  ] as const) {
    test(`the delegate ${name}: the owner's card is raised with its reason, and the worker isn't denied`, async () => {
      const h = harness();
      h.rules.push({ match: REHEARSAL, act: allowThenReview(act) });
      const { askId } = await hold(h, REHEARSAL, REHEARSAL_HOLD);
      const [card] = await until(() => (cardsFor(h, askId).length > 0 ? cardsFor(h, askId) : null), "the owner's card");
      expect(card).toMatchObject({ status: "pending", jobId: h.job.id, args: { askId, answer: "Allow once", floorHold: true } });
      expect(JSON.stringify(card)).toContain(`The hold delegate escalated this high-risk hold the second check flagged: ${why}`);
      expect(getAsk(h.store.db, askId)!.status).toBe("pending");
      expect(h.mainTurns).toHaveLength(0);
    });
  }

  test("a re-allow after the delegate's concern doesn't roll the check again, and the owner's card keeps the hold", async () => {
    // The model layer flags once, then would pass: a retry must not wait for the pass.
    let checks = 0;
    const once: AllowChecker = { name: "stub", check: async () => (checks++ === 0 ? { verdict: "flag", reason: CHECK_REASON } : { verdict: "allow", reason: "fine" }) };
    const h = openHarness({}, { allowChecker: once });
    open.push(h);
    h.rules.push({ match: REHEARSAL, act: allowThenReview(answer("Deny", "the brief never asks for a restart")) });
    const { askId } = await hold(h, REHEARSAL, REHEARSAL_HOLD);
    await until(() => cardsFor(h, askId).length > 0, "the owner's card");
    const turns = h.laneTurns.length;
    const seen = checks;
    const res = await h.app.request("/api/persona/tool", {
      method: "POST",
      headers: { "content-type": "application/json", [PERSONA_TOKEN_HEADER]: h.runtime.token },
      body: JSON.stringify({ name: "answer_ask", arguments: { askId, answer: "Allow once", reason: "the job's live check runs a scratch collector" } }),
    });
    const text = ((await res.json()) as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toContain(`"Allow once" card (approval ${cardsFor(h, askId)[0]!.id.slice(0, 8)})`);
    expect(text).not.toContain("hold delegate's review");
    expect(checks).toBe(seen);
    // The re-allow carried the earlier flag, not a fresh check.
    const last = records(h, askId).filter((v) => v.outcome === "refused").at(-1)!;
    expect((last.allowCheck as { reason: string }).reason).toStartWith("flagged earlier in this job: ");
    expect(cardsFor(h, askId)).toHaveLength(1);
    expect(getAsk(h.store.db, askId)!.status).toBe("pending");
    await Bun.sleep(300);
    expect(h.laneTurns).toHaveLength(turns);
  });

  for (const [name, command, client] of [
    ["a secrets read", HIGH_RISK, undefined],
    ["a write to the install's code", INSTALL_WRITE, INSTALL_HOLD],
    ["a write to the live DB", DB_WRITE, DB_HOLD],
  ] as const) {
    test(`${name} still goes to the owner's card, with no review`, async () => {
      const h = harness();
      const first: string[] = [];
      h.rules.push({ match: command, act: allowThenReview(answer("Allow once", "reviewed"), first) });
      const { askId } = await hold(h, command, client);
      expect(getAsk(h.store.db, askId)!.question).toContain("HIGH RISK");
      const [card] = await until(() => (cardsFor(h, askId).length > 0 ? cardsFor(h, askId) : null), "the owner's card");
      expect(card).toMatchObject({ status: "pending", args: { askId, floorHold: true } });
      expect(first[0]).not.toContain("hold delegate's review");
      await Bun.sleep(300);
      expect(h.laneTurns.some((t) => t.prompt.includes(`- review ${askId}`))).toBe(false);
      expect(getAsk(h.store.db, askId)!.status).toBe("pending");
    });
  }
});

describe("a flagged high-risk allow with the hold delegate off", () => {
  test("goes to the owner's card as today, and stays blocked until the owner writes", async () => {
    const h = harness({ STANDUP_PERSONA_DELEGATES: "0" });
    const { askId } = await hold(h, REHEARSAL, REHEARSAL_HOLD);
    await until(() => h.mainTurns.length > 0, "the main turn");
    const allowOnce = async () => {
      const res = await h.app.request("/api/persona/tool", {
        method: "POST",
        headers: { "content-type": "application/json", [PERSONA_TOKEN_HEADER]: h.runtime.token },
        body: JSON.stringify({ name: "answer_ask", arguments: { askId, answer: "Allow once", reason: "the job's live check runs a scratch collector" } }),
      });
      return ((await res.json()) as { content: Array<{ text: string }> }).content[0]!.text;
    };
    const first = await allowOnce();
    expect(first).toContain(`"Allow once" card`);
    expect(first).not.toContain("hold delegate's review");
    expect(cardsFor(h, askId)).toHaveLength(1);
    expect(h.laneTurns).toHaveLength(0);
    expect(await allowOnce()).toContain("flagged earlier in this job");
    expect(getAsk(h.store.db, askId)!.status).toBe("pending");
  });
});

describe("ownerOnlyHold", () => {
  const base = { category: "floor-tamper", floorReason: "", secret: false, scratchRun: true };
  for (const [name, hold, owners] of [
    ["an isolated harness run", { ...base, floorReason: REHEARSAL_HOLD.reason }, false],
    ["a standup-ops scratch run", { ...base, category: "standup-ops", floorReason: REHEARSAL_HOLD.reason }, false],
    ["a high-risk hold that isn't a scratch run", { ...base, floorReason: "`sqlite3` reads standup.db", scratchRun: false }, true],
    ["a scratch run whose reason names a write to the install", { ...base, floorReason: INSTALL_HOLD.reason }, true],
    ["a tree put into the floor", { ...base, floorReason: "`cp` puts a tree into /x/floor, which holds or would hold the safety floor" }, true],
    ["a write in Bun's package cache", { ...base, floorReason: "code in x.ts writes files in Bun's package cache, whose files are hard-linked into the installs made from it" }, true],
    ["a write to the Playwright toolchain", { ...base, floorReason: "`bun add` writes dependencies into the screenshot helper's Playwright toolchain (/x)" }, true],
    ["a write to the floor through a path with a semicolon", { ...base, floorReason: "Write writes /x/a;b/hook.ts, part of the safety floor or a file it relies on" }, true],
    ["a /proc read of another session", { ...base, floorReason: "code in x.ts reads files under /proc of processes it names at run time, which may be another session's environment" }, true],
    ["an AWS finding later in the list", { ...base, floorReason: "starts a collector (also floor-tamper: reads x; aws: deletes s3://prod-bucket)" }, true],
    ["an outward finding later in the list", { ...base, floorReason: "starts a collector (also collector-api: posts to /api; outward: curl https://example.com)" }, true],
    ["a collector API call", { ...base, category: "collector-api" }, true],
    // Reasons the real classifier gives a scratch run whose worktree code reads the owner token, writes the live
    // DB, or writes the floor hook, by paths it builds at run time.
    [
      "code naming Standup's data dir",
      { ...base, floorReason: "code in /w/scripts/probe-x.ts names Standup's data dir (/fake/home/.local/share/standup), which holds its database: workers may not read Standup's database; use Standup's API" },
      true,
    ],
    ["code naming the install", { ...base, floorReason: "code in /w/scripts/probe-x.ts names /fake/install, part of the safety floor or a file it relies on" }, true],
    [
      "code writing into other launches' scratch dirs",
      { ...base, floorReason: "code in /w/scripts/zz-p0.ts writes files and names .cache/standup-scratch, in or above other launches' scratch dirs, whose venvs and scripts those workers run unread" },
      true,
    ],
    ["a tmux socket in Standup's live data dir", { ...base, floorReason: "`tmux` names the socket /x, in Standup's live data dir; only Standup and its owner drive the tmux servers there" }, true],
    ["an attach to another process", { ...base, floorReason: "`gdb` attaches to another process and reads its memory and environment" }, true],
    ["code using the data-dir helpers", { ...base, floorReason: "code in /w/scripts/probe-x.ts uses Standup's data-dir helpers" }, true],
    ["a run that may reach a live Standup process", { ...base, floorReason: "`bun` may stand in for, or reach, a live Standup process" }, true],
    ["a clipped reason", { ...base, floorReason: `starts a collector under /tmp/${"a/".repeat(300)}…` }, true],
    ["a secrets read", { ...base, secret: true }, true],
    ["a write to the install", { ...base, floorReason: INSTALL_HOLD.reason }, true],
    ["a write to the live DB", { ...base, floorReason: DB_HOLD.reason }, true],
    ["a write to the floor", { ...base, floorReason: "Write writes packages/collector/src/floor/hook.ts, part of the safety floor or a file it relies on" }, true],
    ["a build inside the install", { ...base, floorReason: "`bun` runs inside the Standup install (/opt/standup), writing build output there" }, true],
    ["an outward step", { ...base, category: "outward" }, true],
    ["an outward step found beside it", { ...base, floorReason: "starts a collector (also outward: git push origin main)" }, true],
    ["an AWS change outside the owner's accounts", { ...base, category: "aws" }, true],
    ["a personal-account AWS change", { ...base, category: "personal-aws" }, true],
  ] as const) {
    test(`${name}: ${owners ? "the owner's" : "the delegate's"}`, () => {
      expect(ownerOnlyHold(hold) !== null).toBe(owners);
    });
  }
});
