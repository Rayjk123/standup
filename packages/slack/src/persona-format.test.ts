// Pure helpers behind the Persona bridge: markdown → mrkdwn, splitting, Slack →
// plain text, context caps, action ids, and the routing decisions.

import { describe, expect, test } from "bun:test";
import {
  absoluteConsoleLinks,
  approvalCardBlocks,
  approvalFallbackBlocks,
  approvalPointerText,
  approvalText,
  capContext,
  jobRefsBlock,
  markdownToMrkdwn,
  neutralizeBroadcasts,
  neutralizeUserPings,
  optionBlocks,
  personaOutboundText,
  parseApprovalAction,
  parseOptionAction,
  revealLinks,
  slackToPlain,
  splitForSlack,
} from "./persona-format.js";
import {
  audienceFitsBinding,
  dmAskClaims,
  dmMessageRoute,
  dmRoute,
  type DmMessageRoute,
  fileShareDmText,
  isDmFileShare,
  launchRoute,
  mentionRoute,
  UNREADABLE_FILES_NOTICE,
  unreadableFilesNotice,
  UNSENT_FILES_NOTICE,
  unsentFilesNotice,
  parseExternalRef,
  parseMuteCommand,
  personaOwnerConflict,
  resolvePersonaOwnerSlackId,
  threadMessageRoute,
  tsAfter,
} from "./persona-routing.js";
import type { PersonaApproval } from "@standup/shared";

describe("jobRefsBlock", () => {
  const line = (b: ReturnType<typeof jobRefsBlock>) => (b?.elements as { text: string }[] | undefined)?.[0]?.text;

  test("names each job by title and short id in one context block", () => {
    expect(
      jobRefsBlock([
        { jobId: "3f2a9c1d-1111-2222", title: "Knowledge audit" },
        { jobId: "8be01a77-3333-4444", title: "Checkout currency" },
      ]),
    ).toEqual({ type: "context", elements: [{ type: "mrkdwn", text: "Jobs: Knowledge audit `3f2a9c1d` · Checkout currency `8be01a77`" }] });
    expect(line(jobRefsBlock([{ jobId: "3f2a9c1d-1111", title: "Audit" }]))).toBe("Job: Audit `3f2a9c1d`");
  });

  test("no jobs, no block", () => {
    expect(jobRefsBlock([])).toBeUndefined();
    expect(jobRefsBlock([{ jobId: "" }])).toBeUndefined();
  });

  test("an unknown or blank title shows the short id alone", () => {
    expect(line(jobRefsBlock([{ jobId: "abcdef0123456" }, { jobId: "99999999x", title: "   " }]))).toBe("Jobs: `abcdef01` · `99999999`");
  });

  test("titles are escaped, defused, stripped of markup and clipped", () => {
    expect(line(jobRefsBlock([{ jobId: "j1", title: "a <b> & `c` *d*" }]))).toBe("Job: a &lt;b&gt; &amp; c d `j1`");
    expect(line(jobRefsBlock([{ jobId: "j1", title: "<@U123> ping <!here>" }]))).toBe("Job: &lt;@U123&gt; ping @⁠here `j1`");
    expect(line(jobRefsBlock([{ jobId: "j1", title: "multi\nline\ttitle" }]))).toBe("Job: multi line title `j1`");
    const long = line(jobRefsBlock([{ jobId: "j1", title: "x".repeat(100) }]))!;
    expect(long).toBe(`Job: ${"x".repeat(39)}… \`j1\``);
  });

  test("shows at most four jobs, then counts the rest; duplicates count once", () => {
    const refs = ["a", "b", "c", "d", "e", "f", "a"].map((id) => ({ jobId: `${id}-job`, title: id.toUpperCase() }));
    expect(line(jobRefsBlock(refs))).toBe("Jobs: A `a-job` · B `b-job` · C `c-job` · D `d-job` · +2 more");
  });
});

describe("markdownToMrkdwn", () => {
  test("converts emphasis, links, headings and lists", () => {
    expect(markdownToMrkdwn("# Title\n**bold** *it* ~~gone~~ [x](https://a.test)\n- one\n- two")).toBe(
      "*Title*\n*bold* _it_ ~gone~ <https://a.test|x>\n• one\n• two",
    );
  });
  test("escapes control characters and leaves code alone", () => {
    expect(markdownToMrkdwn("a < b & `**x**`\n```ts\nconst y = **1**;\n```")).toBe(
      "a &lt; b &amp; `**x**`\n```\nconst y = **1**;\n```",
    );
  });
});

describe("splitForSlack", () => {
  test("short text is one chunk; long text splits on paragraphs under the limit", () => {
    expect(splitForSlack("hi")).toEqual(["hi"]);
    const long = Array.from({ length: 10 }, (_, i) => `p${i} `.padEnd(100, "x")).join("\n\n");
    const parts = splitForSlack(long, 350);
    expect(parts.length).toBeGreaterThan(2);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(350);
    expect(parts.join("\n\n")).toBe(long);
  });
  test("a split inside a code fence closes and reopens it", () => {
    const code = "```\n" + Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") + "\n```";
    const parts = splitForSlack(code, 120);
    for (const p of parts) expect((p.match(/```/g) ?? []).length % 2).toBe(0);
  });
});

describe("slackToPlain", () => {
  test("drops the bot mention and renders mentions, channels, links and entities", () => {
    expect(
      slackToPlain("<@UBOT> ping <@U1> in <#C1|ops> see <https://x.test|this> &amp; <https://y.test> &lt;3", "UBOT", (id) =>
        id === "U1" ? "bob" : undefined,
      ),
    ).toBe("ping @bob in #ops see this (https://x.test) & https://y.test <3");
  });
});

describe("capContext", () => {
  test("keeps the newest messages within item and char caps, oldest first", () => {
    const msgs = Array.from({ length: 10 }, (_, i) => ({ author: "a", text: `${i}`.padEnd(100, "x") }));
    const out = capContext(msgs, { maxItems: 5, maxChars: 250, maxItemChars: 2000 });
    expect(out.map((m) => m.text[0])).toEqual(["8", "9"]);
  });
  test("clips a single huge message", () => {
    const out = capContext([{ author: "a", text: "y".repeat(5000) }]);
    expect(out[0]!.text.length).toBe(2000);
  });
});

describe("action ids", () => {
  test("option and approval ids round-trip", () => {
    const blocks = optionBlocks("thr:1", ["a", "b", "c", "d", "e", "f", "g"]);
    expect(blocks).toHaveLength(2);
    const id = (blocks[1]!.elements as { action_id: string }[])[1]!.action_id;
    expect(parseOptionAction(id)).toEqual({ threadId: "thr:1", index: 6 });
    expect(parseApprovalAction("persona_approval:ap-1:deny")).toEqual({ approvalId: "ap-1", decision: "deny" });
    expect(parseApprovalAction("persona_approval:ap-1:maybe")).toBeNull();
    expect(parseOptionAction("ask_answer:x")).toBeNull();
  });
  test("an option id carries the question's message id and round-trips; the old form still parses", () => {
    const blocks = optionBlocks("thr:1", ["a", "b"], "3f1c2a9e-0000-4000-8000-0000000000e1");
    const id = (blocks[0]!.elements as { action_id: string }[])[1]!.action_id;
    expect(id).toBe("persona_option:thr:1:1~3f1c2a9e-0000-4000-8000-0000000000e1");
    expect(parseOptionAction(id)).toEqual({ threadId: "thr:1", index: 1, messageId: "3f1c2a9e-0000-4000-8000-0000000000e1" });
    expect(parseOptionAction("persona_option:thr:1:4")).toEqual({ threadId: "thr:1", index: 4 });
    expect(parseOptionAction("persona_option:thr:1:x~m")).toBeNull();
    expect(parseOptionAction("persona_option:thr:1:-1")).toBeNull();
  });
  test("an approval card clips huge details and links the console", () => {
    const a: PersonaApproval = {
      id: "ap",
      owner: "alice",
      action: "launch_session",
      summary: "Launch a session",
      args: { task: "z".repeat(5000) },
      status: "pending",
      createdAt: "t",
    };
    const blocks = approvalCardBlocks(a, "http://console.test");
    const text = JSON.stringify(blocks);
    expect(text).toContain("full details in the console");
    expect(text.length).toBeLessThan(5000);
  });
  test("an owner-only floor hold's card shows its deadline above the buttons while pending", () => {
    const a: PersonaApproval = {
      id: "ap",
      owner: "alice",
      action: "answer_ask",
      summary: "Answer safety-floor hold",
      args: {
        askId: "a1",
        answer: "Allow once",
        askQuestion: "Safety floor held a Bash call (floor-tamper)\n\nvim gate.ts",
        floorHold: true,
        holdExpiresAt: "2026-10-08T20:25:19.000Z",
      },
      status: "pending",
      createdAt: "t",
    };
    const blocks = approvalCardBlocks(a, "http://c");
    const text = JSON.stringify(blocks);
    expect(text).toContain("safety floor is holding a command");
    const deadline = blocks.findIndex((b) => JSON.stringify(b).includes("Decide by <!date^1791491119^{date_short_pretty} {time}|2026-10-08T20:25:19.000Z>"));
    expect(deadline).toBeGreaterThan(0);
    expect(blocks[deadline + 1]).toMatchObject({ type: "actions" });
    expect(JSON.stringify(approvalCardBlocks({ ...a, status: "denied" }, "http://c"))).not.toContain("Decide by");
  });
});

describe("routing", () => {
  test("owner id: SLACK_ASK_USER first, else the owner-map entry for Persona's alias", () => {
    const map = new Map([["alice", "U_A"]]);
    expect(resolvePersonaOwnerSlackId({ askUser: "U_X", ownerMap: map }, "alice")).toBe("U_X");
    expect(resolvePersonaOwnerSlackId({ ownerMap: map }, "alice")).toBe("U_A");
    expect(resolvePersonaOwnerSlackId({ ownerMap: map }, "bob")).toBeUndefined();
    expect(resolvePersonaOwnerSlackId({ ownerMap: map }, undefined)).toBeUndefined();
  });
  test("external refs parse back to Slack addresses", () => {
    expect(parseExternalRef("dm:D1")).toEqual({ kind: "dm", channel: "D1" });
    expect(parseExternalRef("C1:123.456")).toEqual({ kind: "channel", channel: "C1", threadTs: "123.456" });
    expect(parseExternalRef("console")).toBeNull();
  });
  test("route decisions", () => {
    expect(dmRoute({ active: true, hasPersona: true, hasPendingAsk: false })).toBe("persona");
    expect(dmRoute({ active: true, hasPersona: false, hasPendingAsk: false })).toBe("legacy");
    expect(dmRoute({ active: false, hasPersona: true, hasPendingAsk: false })).toBe("legacy");
    expect(dmRoute({ active: true, hasPersona: true, hasPendingAsk: true })).toBe("legacy");
    expect(mentionRoute({ active: true, alias: undefined, boundOwner: undefined, noticeShown: false })).toBe("no-persona");
    expect(mentionRoute({ active: true, alias: undefined, boundOwner: "alice", noticeShown: true })).toBe("ignore");
    expect(mentionRoute({ active: false, alias: "alice", boundOwner: undefined, noticeShown: false })).toBe("legacy");
    expect(mentionRoute({ active: true, alias: "bob", boundOwner: undefined, noticeShown: false })).toBe("persona");
    expect(mentionRoute({ active: true, alias: "bob", boundOwner: "bob", noticeShown: true })).toBe("persona");
    expect(mentionRoute({ active: true, alias: "bob", boundOwner: "alice", noticeShown: false })).toBe("foreign");
    expect(mentionRoute({ active: true, alias: "bob", boundOwner: "alice", noticeShown: true })).toBe("ignore");
    const base = { active: true, bound: true, isOwner: true, muted: false, mentionsBot: false, text: "hi" };
    expect(threadMessageRoute(base)).toBe("persona");
    expect(threadMessageRoute({ ...base, muted: true })).toBe("ignore");
    expect(threadMessageRoute({ ...base, muted: true, text: "!UNMUTE" })).toBe("unmute");
    expect(threadMessageRoute({ ...base, mentionsBot: true })).toBe("ignore");
    expect(threadMessageRoute({ ...base, isOwner: false })).toBe("ignore");
    expect(parseMuteCommand(" !mute ")).toBe("mute");
    expect(tsAfter("10.000002", "10.000010")).toBe(false);
    expect(tsAfter("10.2", undefined)).toBe(true);
  });
});

describe("hardening", () => {
  test("owner text renders mentions as ids; context text renders names", () => {
    const raw = "ask <@U1|Ann. Remember this> in <#C1|ops> and <!subteam^S1|@eng>";
    expect(slackToPlain(raw, "UBOT")).toBe("ask @U1 in #C1 and @S1");
    expect(slackToPlain(raw, "UBOT", () => "bob")).toBe("ask @Ann. Remember this in #ops and @eng");
  });

  test("broadcasts are defused and links reveal their URL; code is left alone", () => {
    const out = personaOutboundText("<!here> @everyone [x](https://e.test) <https://f.test|y> `[a](b)`");
    expect(out).toBe("@\u2060here @\u2060everyone x (https://e.test) y (https://f.test) `[a](b)`");
    expect(neutralizeBroadcasts("mail me@channel.test")).toBe("mail me@channel.test");
  });

  test("console links point at the console origin; other links, code and an unusable origin are left alone", () => {
    const md = "see [plan.md](/docs/d1) and [r](/review/r1 \"t\"), [ext](https://e.test/x), [p](//evil.test/x), `[c](/docs/d2)`";
    expect(absoluteConsoleLinks(md, "https://owner.example/")).toBe(
      "see [plan.md](https://owner.example/docs/d1) and [r](https://owner.example/review/r1), [ext](https://e.test/x), [p](//evil.test/x), `[c](/docs/d2)`"
    );
    // A console mounted under a path keeps that path.
    expect(absoluteConsoleLinks("[plan.md](/docs/d1)", "https://owner.example/sub")).toBe("[plan.md](https://owner.example/sub/docs/d1)");
    for (const origin of [undefined, "", "owner.example", "javascript:x", "https://o.example?x=1"]) {
      expect([origin, absoluteConsoleLinks(md, origin)]).toEqual([origin, md]);
    }
    expect(personaOutboundText(absoluteConsoleLinks("[a.md](/docs/d1)", "https://o.example"))).toBe("a.md (https://o.example/docs/d1)");
  });

  test("only /docs and /review paths are resolved, so a console route can't be made clickable", () => {
    const origin = "https://owner.example";
    for (const url of [
      "/api/knowledge/eval",
      "/asks/a1/resolve",
      "/docs/",
      "/review/",
      "/",
      "/\\evil.test",
      "/%2F%2Fevil.test",
      // A dot segment resolves to another console route, so it isn't a console link.
      "/docs/../api/knowledge/eval",
      "/docs/%2e%2e/api/knowledge/eval",
      "/review/r1/../../asks/a1/resolve",
    ]) {
      const md = `[x](${url})`;
      expect([url, absoluteConsoleLinks(md, origin)]).toEqual([url, md]);
    }
  });

  test("a console link on a loopback host is re-pointed at the console origin", () => {
    const origin = "https://owner.example";
    expect(absoluteConsoleLinks("[a](http://localhost:5173/docs/d1)", origin)).toBe("[a](https://owner.example/docs/d1)");
    expect(absoluteConsoleLinks("[a](http://127.0.0.1:5173/review/r1?x=1#f)", origin)).toBe("[a](https://owner.example/review/r1?x=1#f)");
    // Another host's link, and a loopback link outside the console's pages, stay as they are.
    for (const url of [
      "https://e.test/docs/d1",
      "http://localhost:5173/api/knowledge/eval",
      "http://localhost.evil.test/docs/d1",
      "http://localhost:5173/docs/../api/knowledge/eval",
    ]) {
      const md = `[a](${url})`;
      expect([url, absoluteConsoleLinks(md, origin)]).toEqual([url, md]);
    }
  });

  test("context capping keeps pinned messages and trims the middle", () => {
    const msgs = Array.from({ length: 50 }, (_, i) => ({ author: "a", text: `m${i}`, ts: `${i}.0` }));
    const out = capContext(msgs, { maxItems: 5, maxChars: 8000, maxItemChars: 2000 }, new Set(["0.0", "20.0"]));
    expect(out.map((m) => m.text)).toEqual(["m0", "m20", "m47", "m48", "m49"]);
  });

  test("approval cards stay under Slack's section limit for code-, HTML- and shell-heavy actions", () => {
    const samples = [
      "return <div className=\"a\">{items.map((i) => <Row key={i.id} a={a && b} />)}</div>;\n".repeat(30).slice(0, 2000),
      '<li><a href="/docs/x">Docs</a> &amp; <b>notes</b></li>\n'.repeat(60).slice(0, 2000),
      "cd pkg && bun test > out.log 2>&1 && grep -c FAIL out.log >> summary.txt\n".repeat(40).slice(0, 2000),
    ];
    for (const text of samples) {
      const a: PersonaApproval = {
        id: "ap",
        owner: "o",
        action: "send_to_session",
        summary: `Type into session ab12cd34: ${JSON.stringify(text)}`,
        reason: text,
        args: { sessionId: "s", text },
        status: "failed",
        result: text,
        createdAt: "t",
      };
      for (const blocks of [approvalCardBlocks(a, "http://c"), approvalFallbackBlocks({ ...a, status: "pending" }, "http://c")]) {
        for (const b of blocks as { text?: { text: string }; elements?: { text?: string }[] }[]) {
          for (const t of [b.text?.text, ...(b.elements ?? []).map((e) => e.text)]) {
            if (typeof t === "string") expect(t.length).toBeLessThanOrEqual(3000);
          }
        }
      }
      expect(JSON.stringify(approvalCardBlocks(a, "http://c"))).toContain("full details in the console");
    }
  });

  test("an approval card reads as plain English, with no JSON or ids", () => {
    const a: PersonaApproval = {
      id: "7c3e9a41-2b6d-4e8f-a1c5-90d4b7e2f6a3",
      owner: "o",
      action: "send_to_session",
      summary: 'Queue for the next turn of session 3f2a9c1b: "Rebase onto main."',
      reason: "the owner holds send_to_session for approval (STANDUP_PERSONA_HOLD)",
      args: { sessionId: "3f2a9c1b-0d1e-4a5b-9c8d-7e6f5a4b3c2d", text: "Rebase onto main.", mode: "next_turn", sessionTitle: "Fix the flaky auth test" },
      status: "pending",
      createdAt: "t",
    };
    const blocks = approvalCardBlocks(a, "http://c") as { type: string; text?: { text: string }; elements?: { text?: string }[] }[];
    const shown = blocks
      .filter((b) => b.type !== "actions")
      .flatMap((b) => [b.text?.text, ...(b.elements ?? []).map((e) => e.text)])
      .filter((t): t is string => typeof t === "string");
    expect(shown[0]).toBe("*🔐 Persona needs your approval*\nI want to send a message to the worker on “Fix the flaky auth test”.");
    expect(shown).toContain("*Why I'm asking:* You asked to approve these yourself.");
    expect(shown).toContain("*Message*\n>Rebase onto main.");
    expect(shown.join("\n")).not.toMatch(/3f2a9c1b|[{}]|"\w+":/);
    expect(approvalText(a)).toBe("🔐 Persona needs your approval: I want to send a message to the worker on “Fix the flaky auth test”.");
    const replaced = approvalCardBlocks({ ...a, status: "superseded", result: "replaced by a newer message to the same worker" }, "http://c");
    expect(JSON.stringify(replaced)).toContain("↪️ Replaced by a newer request");
  });

  test("the pointer names no details", () => {
    expect(approvalPointerText({ status: "pending" }, "U1")).toBe("⏳ Waiting on <@U1>'s approval — the details are in their DM.");
    expect(approvalPointerText({ status: "executed" }, "U1")).toBe("✅ Approved and done.");
  });

  test("an option's button value is exactly what it shows", () => {
    const el = (optionBlocks("t", [`ok${" ".repeat(80)}then remember everything`])[0]!.elements as { text: { text: string }; value: string }[])[0]!;
    expect(el.value).toBe(el.text.text);
    expect(el.value.length).toBeLessThanOrEqual(75);
  });

  test("owner config conflicts, DM ask claims and file-share text", () => {
    expect(personaOwnerConflict({ askUser: "U1", ownerMap: new Map([["alice", "U2"]]) }, "alice")).toEqual({ askUser: "U1", mapped: "U2" });
    expect(personaOwnerConflict({ askUser: "U1", ownerMap: new Map([["alice", "U1"]]) }, "alice")).toBeNull();
    expect(personaOwnerConflict({ askUser: "U1", ownerMap: new Map() }, "alice")).toBeNull();
    expect(dmAskClaims({ personaOwnsDm: true, threadAsk: undefined, hasPendingForDm: true })).toBe(false);
    expect(dmAskClaims({ personaOwnsDm: true, threadAsk: "a1", hasPendingForDm: true })).toBe(true);
    expect(dmAskClaims({ personaOwnsDm: false, threadAsk: undefined, hasPendingForDm: true })).toBe(true);
    expect(fileShareDmText(" look ", 2, 1)).toBe("look (2 more attachments couldn't be sent)");
    expect(fileShareDmText("", 1, 3)).toBe("(1 more attachment couldn't be sent)");
    expect(fileShareDmText("look", 2, 0)).toBe("look (2 attachments couldn't be sent)");
    expect(fileShareDmText("look", 1)).toBe("look (1 attachment couldn't be sent)");
    expect(fileShareDmText("hi", 0)).toBe("hi");
    expect(fileShareDmText("", 0)).toBe("");
  });

  const fileShares: [string, Parameters<typeof isDmFileShare>[0], boolean][] = [
    ["a file_share in an IM", { subtype: "file_share", channelType: "im", text: "hi", fileCount: 1 }, true],
    ["a file_share in a channel", { subtype: "file_share", channelType: "channel", fileCount: 1 }, false],
    ["a plain IM with only files", { channelType: "im", text: " ", fileCount: 2 }, true],
    ["a plain IM with text and files (takes the usual DM route)", { channelType: "im", text: "hi", fileCount: 1 }, false],
    ["a plain IM without files", { channelType: "im", text: "hi", fileCount: 0 }, false],
    ["another subtype carrying files", { subtype: "message_changed", channelType: "im", fileCount: 1 }, false],
  ];
  for (const [what, m, want] of fileShares) {
    test(`isDmFileShare: ${what}`, () => expect(isDmFileShare(m)).toBe(want));
  }

  const unsent: [string, Parameters<typeof unsentFilesNotice>[0], string | undefined][] = [
    ["a Persona user's ask answer or launch with files", { personaDm: true, fileCount: 2 }, UNSENT_FILES_NOTICE],
    ["a Persona user's ask answer without files", { personaDm: true, fileCount: 0 }, undefined],
    ["someone without a Persona here", { personaDm: false, fileCount: 1 }, undefined],
  ];
  for (const [what, a, want] of unsent) {
    test(`unsentFilesNotice: ${what}`, () => expect(unsentFilesNotice(a)).toBe(want));
  }
  const plain = {
    personaDm: true,
    fileShare: false,
    text: "hi",
    fileCount: 0,
    threadAsk: false,
    askClaims: false,
    isLaunchCommand: false,
    isActivityCommand: false,
    launchToPersona: false,
  };
  const routes: [string, Partial<typeof plain>, DmMessageRoute][] = [
    ["a file_share in an ask card's thread answers the ask", { fileShare: true, fileCount: 1, text: "looks broken", threadAsk: true, askClaims: true }, "ask"],
    ["a launch Persona takes goes to Persona (it becomes a job), files and all", { fileShare: true, fileCount: 1, text: "launch fix the bug in standup", isLaunchCommand: true, launchToPersona: true }, "persona"],
    ["a launch Persona takes goes to Persona", { text: "launch fix the bug in standup", isLaunchCommand: true, launchToPersona: true }, "persona"],
    ["a launch Persona doesn't take (paused, options, non-Claude) is a direct launch", { text: "launch harness=codex fix it", isLaunchCommand: true }, "launch"],
    ["anyone else's launch is a direct launch", { personaDm: false, text: "launch fix the bug in standup", isLaunchCommand: true }, "launch"],
    ["a launch-like answer in an ask thread answers the ask even when Persona would take it", { threadAsk: true, askClaims: true, isLaunchCommand: true, launchToPersona: true }, "ask"],
    ["a launch-like answer in an ask thread answers the ask", { fileShare: true, fileCount: 1, threadAsk: true, askClaims: true, isLaunchCommand: true }, "ask"],
    ["the activity command with a file shows activity", { fileShare: true, fileCount: 1, text: "active", isActivityCommand: true }, "activity"],
    ["a plain file share goes to Persona", { fileShare: true, fileCount: 2, text: "what's this?" }, "persona"],
    ["files with no text go to Persona", { fileShare: true, fileCount: 1, text: "" }, "persona"],
    ["a text-less file in an ask thread goes to Persona (no answer to give)", { fileShare: true, fileCount: 1, text: "", threadAsk: true, askClaims: true }, "persona"],
    ["text and files without a subtype go to Persona", { fileCount: 1, text: "see attached" }, "persona"],
    ["a non-owner's file share is dropped", { personaDm: false, fileShare: true, fileCount: 1, text: "hi" }, "drop"],
    ["a non-owner's plain DM takes the pre-Persona path", { personaDm: false }, "other"],
    ["a non-owner's text-less DM is dropped", { personaDm: false, text: "" }, "drop"],
    ["an empty owner DM is dropped", { text: "" }, "drop"],
    ["a launch that didn't go through (rerouted) goes to Persona", { fileShare: true, fileCount: 1, text: "launch x in y" }, "persona"],
  ];
  for (const [what, facts, want] of routes) {
    test(`dmMessageRoute: ${what}`, () => expect(dmMessageRoute({ ...plain, ...facts })).toBe(want));
  }

  const unreadable: [string, Parameters<typeof unreadableFilesNotice>[0], string | undefined][] = [
    ["a Persona user's files none of which could be read", { personaDm: true, rawFileCount: 2, fileCount: 0 }, UNREADABLE_FILES_NOTICE],
    ["some files readable (the others are handled per file)", { personaDm: true, rawFileCount: 2, fileCount: 1 }, undefined],
    ["no files at all", { personaDm: true, rawFileCount: 0, fileCount: 0 }, undefined],
    ["someone without a Persona here", { personaDm: false, rawFileCount: 1, fileCount: 0 }, undefined],
  ];
  for (const [what, a, want] of unreadable) {
    test(`unreadableFilesNotice: ${what}`, () => expect(unreadableFilesNotice(a)).toBe(want));
  }
  test("the unreadable-files notice asks for a resend", () => {
    expect(UNREADABLE_FILES_NOTICE).toContain("Couldn't read the files in that message — try sending them again");
  });
  test("a plain message whose files can't be read still counts as a file share, so its owner hears about them", () => {
    expect(isDmFileShare({ channelType: "im", text: "", fileCount: 1 })).toBe(true);
  });

  test("the unsent-files notice says how to send them", () => {
    expect(UNSENT_FILES_NOTICE).toContain("Files aren't sent with ask answers or launch commands — send them as a separate DM");
  });
});

describe("launchRoute", () => {
  const go = { surfaceIsPersona: true, personaCanAct: true, needsDirect: false };
  const cases: [string, Partial<typeof go>, "persona" | "direct"][] = [
    ["a launch on the sender's own Persona surface goes to Persona", {}, "persona"],
    ["another user's Persona thread (or no Persona) launches directly", { surfaceIsPersona: false }, "direct"],
    ["a paused or erroring Persona launches directly", { personaCanAct: false }, "direct"],
    ["harness/model/effort or a non-Claude project launches directly", { needsDirect: true }, "direct"],
  ];
  for (const [what, facts, want] of cases) test(what, () => expect(launchRoute({ ...go, ...facts })).toBe(want));
});

describe("links can't hide their destination", () => {
  test("every markdown and Slack link form shows its URL", () => {
    const cases: [string, string][] = [
      ['[Re-auth Slack](https://evil.example/login "Slack")', "Re-auth Slack (https://evil.example/login)"],
      ["[[Re-auth Slack]](https://evil.example/login)", "[Re-auth Slack] (https://evil.example/login)"],
      ["[Re-auth Slack](<https://evil.example/log in>)", "Re-auth Slack (https://evil.example/log in)"],
      ["![logo](https://evil.example/a.png 'x')", "logo (https://evil.example/a.png)"],
      ["[Re-auth Slack][1]\n\n[1]: https://evil.example/login", "Re-auth Slack (https://evil.example/login)\n\n1: https://evil.example/login"],
      ["[Re-auth Slack][]\n[re-auth slack]: <https://evil.example/x> \"t\"", "Re-auth Slack (https://evil.example/x)\nre-auth slack: https://evil.example/x"],
      ["<slack://open|Open Slack>", "Open Slack (slack://open)"],
      ["<https://evil.example|Docs>", "Docs (https://evil.example)"],
    ];
    for (const [input, out] of cases) expect(revealLinks(input)).toBe(out);
  });

  test("no link syntax survives, and code is left alone", () => {
    const out = revealLinks("[a](b c) and [x][missing] `[k](https://k.test)`");
    expect(out.endsWith(" `[k](https://k.test)`")).toBe(true);
    expect(out.replace("`[k](https://k.test)`", "")).not.toMatch(/\]\(|\]\[/);
  });

  test("user pings are defused except the owner's; group pings are defused", () => {
    expect(neutralizeUserPings("<@U0CEO> <@W1|boss> <@U_OWNER>", "U_OWNER")).toBe("@U0CEO @W1 <@U_OWNER>");
    const out = personaOutboundText("<!subteam^S0ONCALL|@oncall> <@U0CEO> <@U_OWNER>", "U_OWNER");
    expect(out).not.toContain("<!subteam");
    expect(out).not.toContain("<@U0CEO>");
    expect(out).toContain("<@U_OWNER>");
  });
});

describe("external refs name the right kind of Slack id", () => {
  test("dm: only for D ids; channel threads only for C/G ids", () => {
    expect(parseExternalRef("dm:C0PUBLIC")).toBeNull();
    expect(parseExternalRef("dm:G1")).toBeNull();
    expect(parseExternalRef("D1:123.456")).toBeNull();
    expect(parseExternalRef("U1:123.456")).toBeNull();
    expect(parseExternalRef("G1:123.456")).toEqual({ kind: "channel", channel: "G1", threadTs: "123.456" });
    expect(audienceFitsBinding("dm", "private")).toBe(true);
    expect(audienceFitsBinding("dm", "shared")).toBe(false);
    expect(audienceFitsBinding("channel", "private")).toBe(false);
    expect(audienceFitsBinding("channel", "external")).toBe(true);
  });
});
