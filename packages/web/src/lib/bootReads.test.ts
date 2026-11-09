import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { BOOT_READS, fetchPersonaSnapshot, withBootReads } from "./persona";

const INDEX_HTML = readFileSync(join(import.meta.dir, "../../index.html"), "utf8");

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("Persona's boot reads", () => {
  test("index.html starts exactly the first-paint snapshot's reads", () => {
    const list = INDEX_HTML.match(/\[("\/api\/persona[^\]]*)\]\.forEach/);
    expect(list).not.toBeNull();
    expect(JSON.parse(`[${list![1]}]`)).toEqual([...BOOT_READS]);
  });

  test("the first-paint snapshot is answered from the boot reads alone", async () => {
    const boot: Record<string, Promise<Response>> = {
      "/api/persona/state": Promise.resolve(json({ owner: "me", threadId: "t1", runState: "idle" })),
      "/api/persona/messages?limit=50": Promise.resolve(json({ threadId: "t1", messages: [] })),
      "/api/persona/approvals?status=pending": Promise.resolve(json({ approvals: [] })),
    };
    const network: string[] = [];
    const fetchFn = withBootReads(async (url) => {
      network.push(url);
      return json({});
    }, boot);
    const snap = await fetchPersonaSnapshot(fetchFn, null, null, { firstPaint: true });
    expect(network).toEqual([]);
    expect(snap.messages?.threadId).toBe("t1");
    expect(snap.loadError).toBeUndefined();
    expect(Object.keys(boot)).toEqual([]);
  });

  test("each boot read answers once; a later read, a write or a failed boot read goes to the network", async () => {
    const boot: Record<string, Promise<Response>> = {
      "/api/persona/state": Promise.resolve(json({ from: "boot" })),
      "/api/persona/approvals?status=pending": Promise.reject(new Error("offline")),
    };
    const network: string[] = [];
    const fetchFn = withBootReads(async (url, init) => {
      network.push(`${init?.method ?? "GET"} ${url}`);
      return json({ from: "network" });
    }, boot);
    expect(await (await fetchFn("/api/persona/state")).json()).toEqual({ from: "boot" });
    expect(await (await fetchFn("/api/persona/state")).json()).toEqual({ from: "network" });
    expect(await (await fetchFn("/api/persona/approvals?status=pending")).json()).toEqual({ from: "network" });
    await fetchFn("/api/persona/messages?limit=50", { method: "POST" });
    expect(network).toEqual(["GET /api/persona/state", "GET /api/persona/approvals?status=pending", "POST /api/persona/messages?limit=50"]);
  });
});
