// Who directs which Persona from Slack, the `login` command, and the console
// login links the bridge mints.

import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { isLoginCommand, offersNoPersonaNotice, personaDirectory } from "./persona-routing.js";
import { LOGIN_CODE_TTL_MS, userLoginCode, userLoginLink } from "./login-link.js";
import { approvalDecider, approvalOrigin, approvalText } from "./persona-format.js";

describe("personaDirectory", () => {
  test("the host is SLACK_ASK_USER; every listed owner-map pair maps its Slack user to its alias", () => {
    const dir = personaDirectory(
      { askUser: "U_HOST", ownerMap: new Map([["alice", "U_HOST"], ["bob", "U_BOB"], ["carol", "U_CAROL"]]), personaUsers: ["bob", "carol"] },
      "alice",
    );
    expect(dir.hostSlackId).toBe("U_HOST");
    expect([...dir.aliasBySlackId]).toEqual([["U_HOST", "alice"], ["U_BOB", "bob"], ["U_CAROL", "carol"]]);
    expect(dir.slackIdByAlias.get("bob")).toBe("U_BOB");
  });

  test("only SLACK_PERSONA_USERS opts a mapped user in; with nobody listed the directory is the host alone", () => {
    const ownerMap = new Map([["alice", "U_HOST"], ["bob", "U_BOB"], ["carol", "U_CAROL"]]);
    const some = personaDirectory({ askUser: "U_HOST", ownerMap, personaUsers: ["bob", "zed"] }, "alice");
    expect([...some.slackIdByAlias.keys()]).toEqual(["alice", "bob"]);
    const hostOnly = personaDirectory({ askUser: "U_HOST", ownerMap }, "alice");
    expect([...hostOnly.aliasBySlackId]).toEqual([["U_HOST", "alice"]]);
  });

  test("without SLACK_ASK_USER the host's own owner-map entry names them", () => {
    const dir = personaDirectory({ ownerMap: new Map([["alice", "U_A"], ["bob", "U_B"]]), personaUsers: ["bob"] }, "alice");
    expect(dir.hostSlackId).toBe("U_A");
    expect(dir.aliasBySlackId.get("U_B")).toBe("bob");
  });

  test("unmapped users, a pair claiming the host's Slack id, and a Slack id claimed twice get no Persona", () => {
    const dir = personaDirectory(
      {
        askUser: "U_HOST",
        ownerMap: new Map([["mallory", "U_HOST"], ["bob", "U_SHARED"], ["eve", "U_SHARED"], ["dan", "U_DAN"]]),
        personaUsers: ["mallory", "bob", "eve", "dan"],
      },
      "alice",
    );
    expect(dir.aliasBySlackId.get("U_HOST")).toBe("alice");
    expect(dir.slackIdByAlias.has("mallory")).toBe(false);
    expect(dir.aliasBySlackId.has("U_SHARED")).toBe(false);
    expect(dir.aliasBySlackId.get("U_DAN")).toBe("dan");
    expect(dir.aliasBySlackId.has("U_STRANGER")).toBe(false);
  });

  test("an unresolvable host leaves only the guests", () => {
    const dir = personaDirectory({ ownerMap: new Map([["bob", "U_B"]]) }, "alice");
    expect(dir.hostSlackId).toBeUndefined();
    expect(dir.slackIdByAlias.has("alice")).toBe(false);
  });

  test("the no-Persona DM notice is offered only in multi-user mode, and only to senders the operator hasn't configured", () => {
    const base = { active: true, multiUser: true, hostSlackId: "U_HOST", ownerMap: new Map([["bob", "U_BOB"], ["carol", "U_CAROL"]]) };
    expect(offersNoPersonaNotice({ ...base, userId: "U_STRANGER" })).toBe(true);
    expect(offersNoPersonaNotice({ ...base, userId: "U_CAROL" })).toBe(false);
    expect(offersNoPersonaNotice({ ...base, userId: "U_HOST" })).toBe(false);
    expect(offersNoPersonaNotice({ ...base, userId: undefined })).toBe(false);
    expect(offersNoPersonaNotice({ ...base, multiUser: false, userId: "U_STRANGER" })).toBe(false);
    expect(offersNoPersonaNotice({ ...base, active: false, userId: "U_STRANGER" })).toBe(false);
  });

  test("login is the bare word, any case", () => {
    expect(isLoginCommand(" LOGIN ")).toBe(true);
    expect(isLoginCommand("login please")).toBe(false);
  });
});

describe("login links", () => {
  test("a link carries <expiry>.<alias>.<hmac> under `code` on the login path, valid for ten minutes", () => {
    const now = 1_700_000_000_000;
    const link = userLoginLink("secret", "bob", "http://console.test/", now);
    const url = new URL(link);
    expect(url.origin + url.pathname).toBe("http://console.test/__standup/login");
    const code = url.searchParams.get("code")!;
    const [expiry, alias, mac] = code.split(".");
    expect(Number(expiry)).toBe(Math.floor((now + LOGIN_CODE_TTL_MS) / 1000));
    expect(alias).toBe("bob");
    expect(mac).toBe(createHmac("sha256", "secret").update(`user-login:bob:${expiry}`).digest("hex"));
    expect(code).toBe(userLoginCode("secret", "bob", Number(expiry)));
  });

  test("codes are bound to their alias and secret", () => {
    expect(userLoginCode("secret", "bob", 100)).not.toBe(userLoginCode("secret", "carol", 100));
    expect(userLoginCode("secret", "bob", 100)).not.toBe(userLoginCode("other", "bob", 100));
  });
});

describe("approval routing", () => {
  test("the decider is the approver, else the owner; a card names the owner only when someone else decides", () => {
    expect(approvalDecider({ owner: "bob" })).toBe("bob");
    expect(approvalDecider({ owner: "bob", approver: null })).toBe("bob");
    expect(approvalDecider({ owner: "bob", approver: "alice" })).toBe("alice");
    expect(approvalOrigin({ owner: "bob", approver: "alice" })).toBe("bob");
    expect(approvalOrigin({ owner: "bob", approver: "bob" })).toBeUndefined();
    expect(approvalOrigin({ owner: "bob" })).toBeUndefined();
    expect(approvalText({ action: "answer_ask", summary: "Answer yes", owner: "bob", approver: "alice", status: "pending" })).toContain("(from bob's Persona)");
  });
});
