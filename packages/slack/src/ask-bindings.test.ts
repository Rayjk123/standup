import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import { AskBindingStore } from "./ask-bindings.js";

const cleanups: string[] = [];
let seq = 0;
function tmpStatePath(): string {
  const p = join(tmpdir(), `standup-ask-bindings-${process.pid}-${++seq}.json`);
  process.env.STANDUP_SLACK_ASK_STATE = p;
  cleanups.push(p);
  return p;
}
afterAll(() => {
  for (const p of cleanups) {
    try {
      rmSync(p, { force: true });
    } catch {
      /* best effort */
    }
  }
});

describe("AskBindingStore", () => {
  test("persists a binding and reloads it in a fresh store (survives a restart)", () => {
    tmpStatePath();
    const s1 = new AskBindingStore();
    s1.set("ask-1", { channel: "D1", ts: "111.1", question: "ok?", sessionTitle: "T", sessionId: "s1" });
    s1.set("ask-2", { channel: "C1", ts: "222.2", question: "go?", sessionTitle: "T2", sessionId: "s2", rootTs: "root-2" });

    const s2 = new AskBindingStore(); // fresh process, same state file
    expect(s2.has("ask-1")).toBe(true);
    expect(s2.get("ask-2")?.rootTs).toBe("root-2");
    expect(s2.all().length).toBe(2);
  });

  test("delete removes a binding and the removal persists", () => {
    tmpStatePath();
    const s1 = new AskBindingStore();
    s1.set("ask-1", { channel: "D1", ts: "1", question: "q", sessionTitle: "T", sessionId: "s1" });
    s1.delete("ask-1");
    s1.flush(); // delete debounces; force the write before reloading

    const s2 = new AskBindingStore();
    expect(s2.has("ask-1")).toBe(false);
  });

  test("owner-routed channels persist independently of bindings (survive a binding delete + restart)", () => {
    tmpStatePath();
    const s1 = new AskBindingStore();
    s1.set("ask-1", { channel: "D-U-ownerX", ts: "1", question: "q", sessionTitle: "T", sessionId: "s1", ownerRouted: true });
    s1.markOwnerRouted("D-U-ownerX");
    s1.delete("ask-1"); // the ask resolved — its binding is gone
    s1.flush(); // force the deleted state to disk before reloading

    const s2 = new AskBindingStore(); // fresh process, same state file
    expect(s2.has("ask-1")).toBe(false); // the binding did not survive
    expect(s2.ownerRoutedChannels()).toContain("D-U-ownerX"); // but the owner-routed mark did
  });

  test("drops malformed rows on load (missing channel/ts)", () => {
    const p = tmpStatePath();
    writeFileSync(
      p,
      JSON.stringify({
        asks: [
          { askId: "bad" }, // no channel/ts/sessionId — must be dropped
          { askId: "ok", channel: "D1", ts: "1", sessionId: "s1", question: "q", sessionTitle: "T" },
        ],
      }),
    );
    const s = new AskBindingStore();
    expect(s.has("bad")).toBe(false);
    expect(s.has("ok")).toBe(true);
  });
});
