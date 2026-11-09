import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { PersonaMessage } from "@standup/shared";
import { GlobalWindow } from "happy-dom";
import {
  PERSONA_UPLOAD_ACCEPT,
  discardPersonaUpload,
  formatDuration,
  formatMegabytes,
  keepSentPreview,
  pruneSentPreviews,
  sentPreviewUrl,
  sourceAnswers,
  uploadBlockedReason,
  uploadErrorMessage,
  uploadPersonaFile,
  uploadPrecheck,
} from "./personaUploads";
import { pendingAttachmentIds, reconcileOutbox, type PersonaOutboxItem } from "./persona";

const MIB = 1024 * 1024;

describe("uploadPrecheck", () => {
  test.each([
    ["a small PNG", { name: "a.png", type: "image/png", size: 10 }, undefined],
    ["an image at the cap", { name: "a.jpg", type: "image/jpeg", size: 10 * MIB }, undefined],
    ["an image over the cap", { name: "a.webp", type: "image/webp", size: 10 * MIB + 1 }, "a.webp is 10.0 MB; images can be at most 10 MB"],
    ["a video under its cap", { name: "c.mp4", type: "video/mp4", size: 49 * MIB }, undefined],
    ["a video over its cap", { name: "clip.mov", type: "video/quicktime", size: 62 * MIB }, "clip.mov is 62.0 MB; videos can be at most 50 MB"],
    ["a HEIC photo", { name: "photo.heic", type: "image/heic", size: 10 }, "photo.heic: HEIC isn't supported — use PNG, JPEG, GIF, WebP, MP4, MOV or WebM"],
    ["a PDF without an extension", { name: "doc", type: "application/pdf", size: 10 }, "doc: application/pdf isn't supported — use PNG, JPEG, GIF, WebP, MP4, MOV or WebM"],
    ["an untyped file", { name: "mystery", type: "", size: 20 * MIB }, undefined],
    ["an untyped file over the video cap", { name: "mystery", type: "", size: 51 * MIB }, "mystery is 51.0 MB; videos can be at most 50 MB"],
  ])("%s", (_label, candidate, expected) => {
    expect(uploadPrecheck(candidate)).toBe(expected);
  });

  test("the picker accepts exactly the collector's types", () => {
    expect(PERSONA_UPLOAD_ACCEPT).toBe("image/png,image/jpeg,image/gif,image/webp,video/mp4,video/quicktime,video/webm");
  });
});

describe("formatting", () => {
  test.each([
    [0, "0:00"],
    [9.6, "0:10"],
    [83.4, "1:23"],
    [3725, "1:02:05"],
  ])("formatDuration(%p) is %p", (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });

  test("formatMegabytes keeps one decimal", () => {
    expect(formatMegabytes(62 * MIB)).toBe("62.0 MB");
    expect(formatMegabytes(1.25 * MIB)).toBe("1.3 MB");
  });
});

describe("uploadErrorMessage", () => {
  test.each([
    ["the collector's own message", { ok: false, status: 400, error: "not a PNG" }, "not a PNG"],
    ["a bare 413", { ok: false, status: 413, error: "Request failed (413)" }, "x.mp4 is too large to upload"],
    ["a bare 502", { ok: false, status: 502, error: "Request failed (502)" }, "Upload failed (502)"],
    ["a network failure", { ok: false, status: 0, error: "Failed to fetch" }, "Upload failed: Failed to fetch"],
  ])("%s", (_label, res, expected) => {
    expect(uploadErrorMessage("x.mp4", res)).toBe(expected);
  });
});

describe("uploadBlockedReason", () => {
  test.each([
    [undefined, undefined],
    [{ audience: "private" as const }, undefined],
    [{ audience: "shared" as const }, "Images and videos can only be sent in private threads"],
    [{ audience: "external" as const }, "Images and videos can only be sent in private threads"],
  ])("%p", (thread, expected) => {
    expect(uploadBlockedReason(thread)).toBe(expected);
  });
});

describe("uploadPersonaFile", () => {
  // Bun has no FileReader; the browser's comes from happy-dom, with its File.
  const window = new GlobalWindow();
  const File = window.File as unknown as typeof globalThis.File;
  const g = globalThis as Record<string, unknown>;
  const savedReader = g.FileReader;
  beforeAll(() => {
    g.FileReader = window.FileReader;
  });
  afterAll(async () => {
    g.FileReader = savedReader;
    await window.happyDOM.close();
  });

  test("posts the bytes as JSON to the uploads route and returns the attachment", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ attachment: { id: "a1", name: "x.png", mimeType: "image/png", bytes: 3 } }), { status: 201 });
    };
    const outcome = await uploadPersonaFile(new File(["abc"], "x.png", { type: "image/png" }), "t1", { fetchFn });
    expect(outcome).toEqual({ ok: true, attachment: { id: "a1", name: "x.png", mimeType: "image/png", bytes: 3 } });
    expect(seen[0].url).toBe("/api/persona/uploads");
    expect(seen[0].init?.method).toBe("POST");
    expect((seen[0].init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(seen[0].init?.body))).toEqual({ threadId: "t1", name: "x.png", mimeType: "image/png", dataBase64: "YWJj" });
  });

  const busy = (retryAfter?: string) =>
    new Response("gateway busy", { status: 503, headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter } });
  const created = () => new Response(JSON.stringify({ attachment: { id: "a1", name: "x.mp4", mimeType: "video/mp4", bytes: 3 } }), { status: 201 });

  test.each([
    ["Retry-After: 2", "2", 2000],
    ["Retry-After: 0", "0", 500],
    ["Retry-After: 120", "120", 10_000],
    ["a Retry-After date", "Wed, 21 Oct 2026 07:28:00 GMT", 2000],
  ])("a busy gateway (%s) is retried once after the wait", async (_label, header, ms) => {
    const replies = [busy(header), created()];
    const bodies: string[] = [];
    const waits: number[] = [];
    const outcome = await uploadPersonaFile(
      new File(["abc"], "x.mp4", { type: "video/mp4" }),
      "t1",
      {
        fetchFn: async (_url, init) => {
          bodies.push(String(init?.body));
          return replies.shift()!;
        },
        wait: async (wait) => {
          waits.push(wait);
        },
      }
    );
    expect(outcome.ok).toBe(true);
    expect(waits).toEqual([ms]);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
  });

  test.each([
    ["a 503 without Retry-After is not retried", [busy()], 1],
    ["a second busy answer is the last", [busy("2"), busy("2")], 2],
  ])("%s", async (_label, replies, calls) => {
    let n = 0;
    const waits: number[] = [];
    const outcome = await uploadPersonaFile(
      new File(["abc"], "x.mp4", { type: "video/mp4" }),
      "t1",
      {
        fetchFn: async () => {
          n++;
          return replies.shift()!;
        },
        wait: async (wait) => {
          waits.push(wait);
        },
      }
    );
    expect(n).toBe(calls);
    expect(waits).toHaveLength(calls - 1);
    expect(outcome).toEqual({ ok: false, error: "The server is busy — remove x.mp4 and add it again in a moment" });
  });

  test("returns the server's error", async () => {
    const fetchFn = async () => new Response(JSON.stringify({ error: "video/mp4 declared, but the file is a PNG" }), { status: 400 });
    expect(await uploadPersonaFile(new File(["abc"], "x.mp4", { type: "video/mp4" }), undefined, { fetchFn })).toEqual({
      ok: false,
      error: "video/mp4 declared, but the file is a PNG",
    });
  });

  test("the signal reaches the request, and aborting it stops the upload", async () => {
    const controller = new AbortController();
    const signals: (AbortSignal | null | undefined)[] = [];
    const fetchFn = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        signals.push(init?.signal);
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const pending = uploadPersonaFile(new File(["abc"], "x.mp4", { type: "video/mp4" }), "t1", { fetchFn, signal: controller.signal });
    await new Promise((r) => setTimeout(r, 5));
    expect(signals).toEqual([controller.signal]);
    controller.abort();
    expect(await pending).toEqual({ ok: false, error: "Upload of x.mp4 cancelled" });
  });

  test("aborting during the Retry-After wait skips the retry", async () => {
    const controller = new AbortController();
    let calls = 0;
    const outcome = await uploadPersonaFile(new File(["abc"], "x.mp4", { type: "video/mp4" }), "t1", {
      fetchFn: async () => {
        calls++;
        return busy("2");
      },
      wait: async () => controller.abort(),
      signal: controller.signal,
    });
    expect(calls).toBe(1);
    expect(outcome).toEqual({ ok: false, error: "Upload of x.mp4 cancelled" });
  });

  test("an already aborted signal sends nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const outcome = await uploadPersonaFile(new File(["abc"], "x.mp4", { type: "video/mp4" }), "t1", {
      fetchFn: async () => {
        calls++;
        return busy("2");
      },
      signal: controller.signal,
    });
    expect(calls).toBe(0);
    expect(outcome.ok).toBe(false);
  });

  test("an upload that landed is reported even when cancelled after, so it can be deleted", async () => {
    const controller = new AbortController();
    const outcome = await uploadPersonaFile(new File(["abc"], "x.mp4", { type: "video/mp4" }), "t1", {
      fetchFn: async () => {
        controller.abort();
        return created();
      },
      signal: controller.signal,
    });
    expect(outcome.ok).toBe(true);
  });
});

describe("discardPersonaUpload", () => {
  test.each([204, 404, 500])("DELETEs the upload by id and ignores a %p", async (status) => {
    const seen: { url: string; method?: string }[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      seen.push({ url, method: init?.method });
      return new Response(status === 204 ? null : JSON.stringify({ error: "x" }), { status });
    };
    await discardPersonaUpload("a/1", fetchFn);
    expect(seen).toEqual([{ url: "/api/persona/uploads/a%2F1", method: "DELETE" }]);
  });

  test("a network failure is swallowed", async () => {
    await discardPersonaUpload("a1", async () => {
      throw new Error("offline");
    });
  });
});

describe("sourceAnswers", () => {
  test.each([
    [206, true],
    [200, true],
    [401, false],
    [404, false],
    [502, false],
  ])("a %p answer reads as served: %p", async (status, expected) => {
    const seen: RequestInit[] = [];
    const fetchFn = async (_url: string, init?: RequestInit) => {
      seen.push(init!);
      return new Response(status < 300 ? "x" : "{}", { status });
    };
    expect(await sourceAnswers("/api/persona/attachments/v1", fetchFn)).toBe(expected);
    expect(seen[0]).toEqual({ method: "GET", headers: { Range: "bytes=0-0" } });
  });

  test("a failed request reads as not served", async () => {
    expect(
      await sourceAnswers("/x", async () => {
        throw new TypeError("Failed to fetch");
      })
    ).toBe(false);
  });
});

describe("sent previews", () => {
  const realRevoke = URL.revokeObjectURL;
  afterEach(() => {
    URL.revokeObjectURL = realRevoke;
    pruneSentPreviews(new Set());
  });

  test("a preview lasts while a pending send holds its attachment", () => {
    const revoked: string[] = [];
    URL.revokeObjectURL = ((url: string) => {
      revoked.push(url);
    }) as typeof URL.revokeObjectURL;
    keepSentPreview("a1", "blob:1");
    keepSentPreview("a2", "blob:2");
    pruneSentPreviews(new Set(["a1"]));
    expect(sentPreviewUrl("a1")).toBe("blob:1");
    expect(sentPreviewUrl("a2")).toBeUndefined();
    expect(revoked).toEqual(["blob:2"]);
  });
});

describe("outbox attachments", () => {
  const item = (key: string, text: string, attachmentIds?: string[]): PersonaOutboxItem => ({
    idempotencyKey: key,
    text,
    createdAt: "2026-10-09T12:00:00.000Z",
    afterSeq: 1,
    status: "sending",
    ...(attachmentIds ? { attachmentIds } : {}),
  });
  const echo = (text: string, ids: string[]): PersonaMessage => ({
    id: "m2",
    threadId: "t1",
    seq: 2,
    role: "user",
    text,
    createdAt: "2026-10-09T12:00:00.000Z",
    attachments: ids.map((id) => ({ id, name: `${id}.png`, mimeType: "image/png" as const, bytes: 1 })),
  });

  test("an unkeyed echo confirms only the send with the same attachments", () => {
    const outbox = [item("k1", "", ["a1"]), item("k2", "", ["a2"])];
    expect(reconcileOutbox(outbox, [echo("", ["a2"])]).map((o) => o.idempotencyKey)).toEqual(["k1"]);
    expect(reconcileOutbox([item("k3", "hi")], [echo("hi", ["a9"])]).map((o) => o.idempotencyKey)).toEqual(["k3"]);
  });

  test("pendingAttachmentIds gathers every thread's outbox", () => {
    const ids = pendingAttachmentIds({
      outbox: [item("k1", "", ["a1", "a2"])],
      others: { t2: { messages: [], outbox: [item("k2", "x", ["a3"]), item("k3", "y")] } },
    });
    expect([...ids].sort()).toEqual(["a1", "a2", "a3"]);
  });
});
