// PersonaThreadStore persists bindings and approval cards across restarts,
// writes atomically, and caps what it keeps.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersonaThreadStore } from "./persona-store.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function path(): string {
  const d = mkdtempSync(join(tmpdir(), "persona-store-"));
  dirs.push(d);
  return join(d, "state.json");
}

describe("PersonaThreadStore", () => {
  test("bindings, posted ts and approval cards survive a reload", () => {
    const p = path();
    const s = new PersonaThreadStore(p);
    s.put({ key: "C1:1.0", kind: "channel", threadId: "t1", channel: "C1", threadTs: "1.0", lastDeliveredSeq: 0 });
    s.recordPosted("C1:1.0", "m1", "2.0");
    s.update("C1:1.0", { muted: true, lastDeliveredSeq: 4, lastContextTs: "1.5" });
    s.putApproval({ approvalId: "ap", channel: "D1", ts: "3.0", status: "pending" });
    s.flush();
    expect(existsSync(`${p}.tmp`)).toBe(false);
    expect(JSON.parse(readFileSync(p, "utf8")).version).toBe(1);

    const r = new PersonaThreadStore(p);
    expect(r.get("C1:1.0")).toMatchObject({ threadId: "t1", muted: true, lastDeliveredSeq: 4, lastContextTs: "1.5" });
    expect(r.byThreadId("t1")?.key).toBe("C1:1.0");
    expect(r.postedTs("C1:1.0", "m1")).toBe("2.0");
    expect(r.approval("ap")).toMatchObject({ channel: "D1", ts: "3.0", status: "pending" });
  });

  test("caps posted ids per thread", () => {
    const s = new PersonaThreadStore(path());
    s.put({ key: "dm:D1", kind: "dm", threadId: "t", channel: "D1", lastDeliveredSeq: 0 });
    for (let i = 0; i < 250; i++) s.recordPosted("dm:D1", `m${i}`, `${i}.0`);
    expect(Object.keys(s.get("dm:D1")!.posted)).toHaveLength(200);
    expect(s.postedTs("dm:D1", "m0")).toBeUndefined();
    expect(s.postedTs("dm:D1", "m249")).toBe("249.0");
  });

  test("a corrupt file loads as empty instead of crashing", async () => {
    const p = path();
    await Bun.write(p, "{not json");
    const s = new PersonaThreadStore(p);
    expect(s.all()).toEqual([]);
  });

  test("the file is owner-only and a planted temp path or symlink is never written through", () => {
    const p = path();
    const victim = join(dirname(p), "victim.txt");
    writeFileSync(victim, "original");
    symlinkSync(victim, `${p}.tmp`);
    const s = new PersonaThreadStore(p);
    s.put({ key: "dm:D1", kind: "dm", threadId: "t1", channel: "D1", lastDeliveredSeq: 0 });
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(readFileSync(victim, "utf8")).toBe("original");
    expect(readdirSync(dirname(p)).filter((f) => f.endsWith(".tmp") && f !== "state.json.tmp")).toEqual([]);
  });

  test("bindings whose key and Slack address disagree are dropped on load", () => {
    const p = path();
    writeFileSync(
      p,
      JSON.stringify({
        threads: [
          { key: "dm:DOWNER", kind: "channel", threadId: "real-dm", channel: "CPUBLIC", threadTs: "1.1", lastDeliveredSeq: 0 },
          { key: "dm:DOWNER2", kind: "dm", threadId: "dm2", channel: "CPUBLIC", lastDeliveredSeq: 0 },
          { key: "C1:1.0", kind: "channel", threadId: "c1", channel: "C2", threadTs: "1.0", lastDeliveredSeq: 0 },
          { key: "console", kind: "console", threadId: "con", channel: "CPUBLIC", lastDeliveredSeq: 0 },
          { key: "dm:D3", kind: "dm", threadId: "ok-dm", channel: "D3", lastDeliveredSeq: 0 },
          { key: "C4:4.0", kind: "channel", threadId: "ok-ch", channel: "C4", threadTs: "4.0", lastDeliveredSeq: 0 },
        ],
      }),
    );
    const s = new PersonaThreadStore(p);
    expect(s.all().map((b) => b.threadId).sort()).toEqual(["ok-ch", "ok-dm"]);
  });

  test("chunk progress and sent owner messages are tracked per binding", () => {
    const p = path();
    const s = new PersonaThreadStore(p);
    s.put({ key: "C1:1.0", kind: "channel", threadId: "t1", channel: "C1", threadTs: "1.0", lastDeliveredSeq: 0 });
    s.recordChunks("C1:1.0", "m1", "2.0", 1);
    expect(s.chunkProgress("C1:1.0", "m1")).toEqual({ ts: "2.0", done: 1 });
    s.recordPosted("C1:1.0", "m1", "2.0");
    expect(s.chunkProgress("C1:1.0", "m1")).toBeUndefined();
    s.recordSent("C1:1.0", "1.5");
    expect(s.wasSent("C1:1.0", "1.5")).toBe(true);
    expect(s.wasSent("C1:1.0", "1.6")).toBe(false);
    s.flush();
    expect(new PersonaThreadStore(p).wasSent("C1:1.0", "1.5")).toBe(true);
  });
});
