import { describe, expect, test } from "bun:test";
import { appendPersonaMessage, getOrCreatePersonaConsoleThread, getOrCreatePersonaThreadByRef } from "@standup/store";
import { HOST, docsHarness } from "../docs/test-harness.js";
import { READ_ACTIONS } from "./policy.js";
import { PERSONA_TOKEN_HEADER } from "./routes.js";

/*
 * search_thread: Persona's full-text search over what was said in its
 * threads (query), and the messages around one of them (messageId).
 */

function setUp() {
  const h = docsHarness();
  const db = h.store.db;
  const console = getOrCreatePersonaConsoleThread(db, HOST).id;
  const dm = getOrCreatePersonaThreadByRef(db, HOST, "slack", "dm:D1", "dm", "private").id;
  const shared = getOrCreatePersonaThreadByRef(db, HOST, "slack", "C1:1.0", "#team", "shared").id;
  const say = (threadId: string, text: string, role: "user" | "persona" = "user") =>
    appendPersonaMessage(db, { threadId, role, text, actor: role === "user" ? HOST : undefined }).message.id;
  const inThread = (threadId: string) => {
    (h.runtime as unknown as { turnThreadId?: string }).turnThreadId = threadId;
  };
  const tool = async (args: Record<string, unknown>) => {
    const res = await h.app.request("/api/persona/tool", {
      method: "POST",
      headers: { "content-type": "application/json", [PERSONA_TOKEN_HEADER]: h.runtime.token },
      body: JSON.stringify({ name: "search_thread", arguments: args }),
    });
    expect(res.status).toBe(200);
    const result = (await res.json()) as { content: Array<{ text: string }>; isError?: boolean };
    return { isError: !!result.isError, text: result.content.map((c) => c.text).join("") };
  };
  inThread(console);
  return { ...h, console, dm, shared, say, inThread, tool };
}

describe("search_thread", () => {
  test("is a read that always acts", () => {
    expect(READ_ACTIONS.has("search_thread")).toBe(true);
  });

  test("discover: the best matches first, as raw snippets with msg ids, secrets redacted", async () => {
    const h = setUp();
    const weak = h.say(h.console, "We talked about the release once.");
    const strong = h.say(h.console, "Never push the release branch without asking me; release notes go in the doc.");
    const persona = h.say(h.console, "Noted: I'll ask before every push.", "persona");
    h.say(h.console, "Unrelated chatter about lunch.");
    h.say(h.console, "my key is AKIAIOSFODNN7EXAMPLE for the release");
    const found = await h.tool({ query: "release push" });
    expect(found.isError).toBe(false);
    const lines = found.text.split("\n").filter((l) => l.startsWith("- ["));
    expect(lines).toHaveLength(4);
    const best = lines.find((l) => l.includes(`msg ${strong}`))!;
    expect(best).toContain(`· ${HOST} ·`);
    expect(best).toContain("«push» the «release»");
    expect(lines.indexOf(best)).toBeLessThan(lines.findIndex((l) => l.includes(`msg ${weak}`)));
    expect(lines.some((l) => l.includes(`· you · msg ${persona}]`))).toBe(true);
    expect(lines.some((l) => l.includes(`msg ${weak}`))).toBe(true);
    expect(found.text).not.toContain("lunch");
    expect(found.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(found.text.startsWith("```\n")).toBe(true);

    expect((await h.tool({ query: "giraffe" })).text).toBe('No messages match "giraffe".');
    expect((await h.tool({})).isError).toBe(true);
    expect((await h.tool({ query: "x", messageId: strong })).isError).toBe(true);
  });

  test("discover redacts the whole message before cutting its snippet, so a matched or cut-off label can't expose a secret", async () => {
    const h = setUp();
    h.say(h.console, "the key is sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIJ and password=hunter2secretvalue");
    h.say(h.console, `${"filler ".repeat(40)}password: Hx9vQ2mLp7Rt\nzebra bb0 bb1 bb2`);
    for (const query of ["ant", "api03", "sk", "password", "zebra"]) {
      const found = await h.tool({ query });
      expect(found.text).toContain("msg ");
      for (const secret of ["AbCdEfGhIjKl", "hunter2secretvalue", "Hx9vQ2mLp7Rt"]) expect(found.text).not.toContain(secret);
    }
    expect((await h.tool({ query: "zebra" })).text).toContain("«zebra»");
  });

  test("discover marks the words the index matched, stemmed or accent-folded, past the start of a long message", async () => {
    const h = setUp();
    const pad = "filler ".repeat(60);
    h.say(h.console, `${pad}we deployed it to the café yesterday`);
    h.say(h.console, `${"x".repeat(1_000)} zebra stripes`);
    expect((await h.tool({ query: "deploying" })).text).toContain("we «deployed» it");
    expect((await h.tool({ query: "cafe" })).text).toContain("the «café» yesterday");
    expect((await h.tool({ query: "zebra" })).text).toContain("«zebra» stripes");
  });

  test("discover keeps to maxChars and says how many matches it left out", async () => {
    const h = setUp();
    for (let i = 0; i < 10; i++) h.say(h.console, `penguin ${"note ".repeat(40)} ${i}`);
    const found = await h.tool({ query: "penguin", maxChars: 500 });
    expect(found.text.split("\n").filter((l) => l.startsWith("- [")).length).toBeLessThan(10);
    expect(found.text).toMatch(/\(\d+ more matches past maxChars\)/);
  });

  test("scroll: the messages around one, oldest first, the anchor marked, nearest kept under a tight budget", async () => {
    const h = setUp();
    const ids = Array.from({ length: 9 }, (_, i) => h.say(h.console, `line ${i + 1}`));
    const around = await h.tool({ messageId: ids[4], around: 2 });
    const lines = around.text.split("\n").filter((l) => l.startsWith("- ["));
    expect(lines.map((l) => l.replace(/.*\] /, ""))).toEqual(["line 3", "line 4", "line 5 ←", "line 6", "line 7"]);
    expect(lines[2]).toContain(`msg ${ids[4]}]`);

    const tight = await h.tool({ messageId: ids[4], around: 4, maxChars: 500 });
    expect(tight.text).toContain("line 5 ←");
    expect((await h.tool({ messageId: "nope" })).isError).toBe(true);

    const long = h.say(h.console, `start ${"word ".repeat(1_000)}end`);
    const whole = await h.tool({ messageId: long, maxChars: 10_000 });
    expect(whole.text).toContain(" end ←");
    expect((await h.tool({ messageId: long, maxChars: 500 })).text).toContain("start word");
  });

  test("a private thread searches the owner's private threads, naming where each hit was said", async () => {
    const h = setUp();
    h.say(h.console, "the otter plan lives in the console");
    h.say(h.dm, "the otter plan, said in a DM");
    h.say(h.shared, "the otter plan, said in a shared channel");
    const found = await h.tool({ query: "otter" });
    expect(found.text).toContain("in the console");
    expect(found.text).toContain("· Slack DM · msg");
    expect(found.text).toContain("said in a DM");
    expect(found.text).not.toContain("shared channel");
  });

  test("a shared thread searches only itself and can't scroll to a private message", async () => {
    const h = setUp();
    const secret = h.say(h.console, "private: the badger budget is 40k");
    h.say(h.dm, "private DM: badger");
    h.say(h.shared, "team: the badger demo is Tuesday");
    h.inThread(h.shared);
    const found = await h.tool({ query: "badger" });
    expect(found.text).toContain("«badger» demo is Tuesday");
    expect(found.text).not.toContain("private");
    const scrolled = await h.tool({ messageId: secret });
    expect(scrolled.isError).toBe(true);
    expect(scrolled.text).not.toContain("40k");

    const external = getOrCreatePersonaThreadByRef(h.store.db, HOST, "slack", "C2:1.0", "vendor", "external").id;
    h.inThread(external);
    expect((await h.tool({ query: "badger" })).text).toBe('No messages match "badger".');
  });
});
