// The collector client's Persona methods: owner routes reject writes without a
// JSON content type, so every write sends one (a bodyless write sends `{}`),
// every call is time-bounded, and every call made for a user names them with
// the owner secret.

import { afterEach, describe, expect, test } from "bun:test";
import { SERVICE_CLIENT_HEADER } from "@standup/shared";
import { OWNER_TOKEN_HEADER, PERSONA_USER_HEADER } from "@standup/shared/owner-token";
import { CollectorClient } from "./collector-client.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function client(): CollectorClient {
  return new CollectorClient("http://collector.test", "ws://collector.test", { onMessage: () => {}, onReconnect: () => {} }, () => "owner-secret");
}

function capture(response: unknown, status = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return { ok: status < 400, status, json: async () => response } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

function headers(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

describe("CollectorClient Persona methods", () => {
  test("writes send JSON with a timeout; approve sends {}", async () => {
    const calls = capture({ approval: { id: "a" } });
    const res = await client().personaApprove("alice", "a/b");
    expect(res.ok).toBe(true);
    expect(calls[0]!.url).toBe("http://collector.test/api/persona/approvals/a%2Fb/approve");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(headers(calls[0]!.init)["content-type"]).toBe("application/json");
    expect(calls[0]!.init?.body).toBe("{}");
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("personaSend carries context and returns the message; errors surface status + text", async () => {
    let calls = capture({ message: { id: "m1" } }, 201);
    const ok = await client().personaSend("alice", { threadId: "t", text: "hi", idempotencyKey: "k", context: [{ author: "bob", text: "x" }] });
    expect(ok).toEqual({ ok: true, data: { id: "m1" } as never });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ threadId: "t", text: "hi", idempotencyKey: "k", context: [{ author: "bob", text: "x" }] });
    calls = capture({ error: "sign in first" }, 403);
    expect(await client().personaSend("alice", { text: "hi" })).toEqual({ ok: false, status: 403, error: "sign in first" });
  });

  test("personaThread / personaDeny / reads hit the documented routes", async () => {
    let calls = capture({ thread: { id: "t" } });
    expect((await client().personaThread("alice", { channel: "slack", externalRef: "dm:D1" })).ok).toBe(true);
    expect(calls[0]!.url).toBe("http://collector.test/api/persona/threads");
    calls = capture({ approval: { id: "a" } });
    await client().personaDeny("alice", "a", "no");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ reason: "no" });
    calls = capture({ threadId: "t", messages: [{ seq: 3 }] });
    expect(await client().personaMessages("alice", "t", 2)).toEqual([{ seq: 3 } as never]);
    expect(calls[0]!.url).toContain("/api/persona/messages?threadId=t&afterSeq=2");
    calls = capture({ threads: [] });
    expect(await client().personaThreads("alice")).toEqual([]);
    calls = capture({}, 500);
    expect(await client().personaState()).toBeNull();
  });

  test("every call made for a user names them alongside the owner secret; the host lookup carries the secret alone", async () => {
    let calls = capture({ approvals: [] });
    await client().personaApprovals("bob", "pending");
    expect(calls[0]!.url).toBe("http://collector.test/api/persona/approvals?status=pending");
    expect(headers(calls[0]!.init)).toMatchObject({ [OWNER_TOKEN_HEADER]: "owner-secret", [PERSONA_USER_HEADER]: "bob" });
    calls = capture({ message: { id: "m" } });
    await client().personaSend("bob", { text: "hi" });
    expect(headers(calls[0]!.init)).toMatchObject({ [OWNER_TOKEN_HEADER]: "owner-secret", [PERSONA_USER_HEADER]: "bob" });
    calls = capture({ owner: "bob" });
    await client().personaState("bob");
    expect(headers(calls[0]!.init)[PERSONA_USER_HEADER]).toBe("bob");
    calls = capture({ owner: "alice" });
    await client().personaState();
    expect(headers(calls[0]!.init)).toEqual({ [OWNER_TOKEN_HEADER]: "owner-secret" });
  });

  test("personaSend passes attachment ids through", async () => {
    const calls = capture({ message: { id: "m1" } }, 201);
    await client().personaSend("alice", { threadId: "t", text: "", idempotencyKey: "k", attachmentIds: ["up-1", "up-2"] });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ threadId: "t", text: "", idempotencyKey: "k", attachmentIds: ["up-1", "up-2"] });
  });

  test("personaUpload posts the file as JSON for the user and returns the stored attachment", async () => {
    const attachment = { id: "up-1", mimeType: "image/png", bytes: 3, name: "a.png" };
    const calls = capture({ attachment }, 201);
    const req = { threadId: "t", name: "a.png", mimeType: "image/png", dataBase64: "AQID" };
    expect(await client().personaUpload("bob", req)).toEqual(attachment as never);
    expect(calls[0]!.url).toBe("http://collector.test/api/persona/uploads");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(headers(calls[0]!.init)).toMatchObject({
      "content-type": "application/json",
      [OWNER_TOKEN_HEADER]: "owner-secret",
      [PERSONA_USER_HEADER]: "bob",
    });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual(req);
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
  });

  const uploadErrors: [string, unknown, number, string][] = [
    ["a 400 carries the collector's text", { error: "a.png is a JPEG image, not image/png" }, 400, "a.png is a JPEG image, not image/png"],
    ["a 413 carries the collector's text", { error: "videos can be at most 50 MB" }, 413, "videos can be at most 50 MB"],
    ["a bare 413 still says why", {}, 413, "the file is too large"],
    ["a bare 500 names the status", {}, 500, "the collector refused the file (HTTP 500)"],
    ["a 201 without an attachment", {}, 201, "the collector returned no attachment"],
  ];
  for (const [what, body, status, message] of uploadErrors) {
    test(`personaUpload: ${what}`, async () => {
      capture(body, status);
      await expect(client().personaUpload("alice", { name: "a.png", dataBase64: "AQID" })).rejects.toThrow(message);
    });
  }

  test("personaUsers lists the aliases with a running or persisted Persona from the host-only users route", async () => {
    const calls = capture({
      users: [
        { alias: "alice", running: true, state: { runState: "idle" } },
        { owner: "bob", running: false, state: { runState: "paused" } },
        { running: false, state: { owner: "carol" } },
        { alias: "dave", running: true },
        { alias: "erin", running: false, state: null },
        { alias: "frank" },
        { nothing: 1 },
      ],
    });
    expect(await client().personaUsers()).toEqual(["alice", "bob", "carol", "dave"]);
    expect(calls[0]!.url).toBe("http://collector.test/api/persona/users");
    expect(headers(calls[0]!.init)).toEqual({ [OWNER_TOKEN_HEADER]: "owner-secret" });
    capture({}, 404);
    expect(await client().personaUsers()).toBeNull();
  });

  test("the WS upgrade marks the relay as a service client and carries the owner secret", () => {
    const realWs = globalThis.WebSocket;
    const opened: { url: string; headers: Record<string, string> }[] = [];
    class FakeWs {
      static readonly OPEN = 1;
      readyState = 0;
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((e: MessageEvent) => void) | null = null;
      constructor(url: string, opts?: { headers?: Record<string, string> }) {
        opened.push({ url, headers: opts?.headers ?? {} });
      }
      send(): void {}
      close(): void {}
    }
    globalThis.WebSocket = FakeWs as unknown as typeof WebSocket;
    const c = client();
    try {
      c.connect();
    } finally {
      c.close();
      globalThis.WebSocket = realWs;
    }
    expect(opened).toEqual([{ url: "ws://collector.test", headers: { [SERVICE_CLIENT_HEADER]: "slack", [OWNER_TOKEN_HEADER]: "owner-secret" } }]);
  });

  test("a decision that times out is reported as timed out (the collector may still act on it)", async () => {
    globalThis.fetch = (async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as unknown as typeof fetch;
    const res = await client().personaApprove("alice", "a");
    expect(res).toMatchObject({ ok: false, timedOut: true });
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const refused = await client().personaDeny("alice", "a");
    expect(refused.ok).toBe(false);
    expect("timedOut" in refused && refused.timedOut).toBeFalsy();
  });
});

describe("CollectorClient.personaAttachment", () => {
  const MB = 1024 * 1024;
  const originalCap = process.env.STANDUP_PERSONA_ATTACH_VIDEO_MAX_MB;
  afterEach(() => {
    if (originalCap === undefined) delete process.env.STANDUP_PERSONA_ATTACH_VIDEO_MAX_MB;
    else process.env.STANDUP_PERSONA_ATTACH_VIDEO_MAX_MB = originalCap;
  });

  /**
   * Serves `size` bytes as `type` in 1 MB chunks, declaring `size` as the
   * length unless `declared` says otherwise; returns how many chunks were
   * pulled and whether the body was cancelled.
   */
  function serve(type: string, size: number, declared: number | null = size, status = 200) {
    const seen = { pulled: 0, cancelled: false };
    let left = size;
    globalThis.fetch = (async () => {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (left <= 0) return controller.close();
          const n = Math.min(MB, left);
          left -= n;
          seen.pulled++;
          controller.enqueue(new Uint8Array(n));
        },
        cancel() {
          seen.cancelled = true;
        },
      });
      return new Response(body, {
        status,
        headers: { "content-type": type, ...(declared !== null ? { "content-length": String(declared) } : {}) },
      });
    }) as unknown as typeof fetch;
    return seen;
  }

  test("takes an image up to 10 MB and a video up to the highest cap; anything else, or over, is null and not read", async () => {
    const cases: Array<{ label: string; type: string; size: number; declared?: number | null; cap?: string; status?: number; ok: boolean; cancelled?: boolean }> = [
      { label: "an image", type: "image/png", size: 64, ok: true },
      { label: "an image over 10 MB, undeclared", type: "image/png", size: 12 * MB, declared: null, ok: false, cancelled: true },
      { label: "an MP4", type: "video/mp4", size: 64, ok: true },
      { label: "a WebM at 20 MB", type: "video/webm", size: 20 * MB, ok: true },
      // The collector capped it when attached; this process's own env doesn't shrink that.
      { label: "a 60 MB video, this env capped at 1 MB", type: "video/mp4", size: 60 * MB, cap: "1", ok: true },
      { label: "a video declared over 250 MB", type: "video/mp4", size: 8, declared: 250 * MB + 1, ok: false, cancelled: true },
      { label: "HTML", type: "text/html", size: 64, ok: false, cancelled: true },
      { label: "a 404", type: "video/mp4", size: 64, status: 404, ok: false, cancelled: true },
      { label: "empty", type: "video/mp4", size: 0, ok: false },
    ];
    for (const c of cases) {
      if (c.cap === undefined) delete process.env.STANDUP_PERSONA_ATTACH_VIDEO_MAX_MB;
      else process.env.STANDUP_PERSONA_ATTACH_VIDEO_MAX_MB = c.cap;
      const seen = serve(c.type, c.size, c.declared === undefined ? c.size : c.declared, c.status);
      const bytes = await client().personaAttachment("alice", "att-1");
      expect({ label: c.label, ok: bytes !== null, cancelled: seen.cancelled }).toEqual({ label: c.label, ok: c.ok, cancelled: c.cancelled ?? false });
      if (c.ok) expect(bytes!.length).toBe(c.size);
    }
  });

  test("an undeclared body is read only until it outgrows the limit", async () => {
    const seen = serve("image/png", 40 * MB, null);
    expect(await client().personaAttachment("alice", "att-1")).toBeNull();
    expect(seen.cancelled).toBe(true);
    // 10 MB is reached in the 11th chunk; nothing after it is pulled.
    expect(seen.pulled).toBeLessThanOrEqual(12);
  });
});
