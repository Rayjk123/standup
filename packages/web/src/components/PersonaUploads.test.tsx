import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createElement, useReducer } from "react";
import type { Dispatch } from "react";
import type { PersonaApproval, PersonaAttachment, PersonaMessage, PersonaThreadSummary } from "@standup/shared";
import { personaAttachmentPath, personaAttachmentPosterPath } from "@standup/shared";
import type { Root } from "react-dom/client";
import { GlobalWindow } from "happy-dom";
import { initialPersonaViewState, personaReducer, type PersonaAction, type PersonaViewState } from "../lib/persona";

// react-dom decides whether a DOM exists when it is first imported, so the
// window is installed before the view modules load.
const window = new GlobalWindow({ url: "http://localhost/" });
const GLOBALS = [
  "window",
  "document",
  "navigator",
  "Node",
  "HTMLElement",
  "Element",
  "Text",
  "Event",
  "KeyboardEvent",
  "MutationObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "FileReader",
] as const;
const saved = new Map<string, unknown>();
const realFetch = globalThis.fetch;
const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;

let act: (fn: () => unknown) => Promise<void>;
let createRoot: (el: Element) => Root;
let Thread: typeof import("./PersonaView").Thread;
let PersonaView: typeof import("./PersonaView").PersonaView;
let PersonaComposer: typeof import("./PersonaView").PersonaComposer;
let router: typeof import("react-router-dom");

beforeAll(async () => {
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = (window as unknown as Record<string, unknown>)[name];
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = (await import("react")) as unknown as { act: typeof act });
  ({ createRoot } = await import("react-dom/client"));
  ({ Thread, PersonaView, PersonaComposer } = await import("./PersonaView"));
  router = await import("react-router-dom");
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  URL.createObjectURL = realCreateObjectURL;
  URL.revokeObjectURL = realRevokeObjectURL;
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  await window.happyDOM.close();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A file as the browser hands one over; `size` stands in for large contents. */
function file(name: string, type: string, content = "hello", size?: number): File {
  const f = new window.File([content], name, { type }) as unknown as File;
  if (size !== undefined) Object.defineProperty(f, "size", { configurable: true, value: size });
  return f;
}

function attachment(id: string, name: string, mimeType: PersonaAttachment["mimeType"], extra: Partial<PersonaAttachment> = {}): PersonaAttachment {
  return { id, name, mimeType, bytes: 5, ...extra };
}

interface Call {
  url: string;
  method: string;
  body?: Record<string, unknown>;
  signal?: AbortSignal | null;
}

describe("Persona composer uploads", () => {
  let host: HTMLElement;
  let root: Root;
  let calls: Call[];
  /** What `/uploads` answers, per request. */
  let uploadReply: (body: Record<string, unknown>, n: number) => Response | Promise<Response>;
  /** What `POST /messages` answers. */
  let messageReply: (body: Record<string, unknown>) => Response | Promise<Response>;
  let created: string[];
  let revoked: string[];
  let dispatch: Dispatch<PersonaAction>;
  let initial: PersonaViewState;

  beforeEach(() => {
    calls = [];
    created = [];
    revoked = [];
    let uploads = 0;
    uploadReply = (body) =>
      json(
        {
          attachment: attachment(`att-${++uploads}`, String(body.name), String(body.mimeType ?? "image/png") as PersonaAttachment["mimeType"]),
        },
        201
      );
    messageReply = (body) =>
      json({
        message: { id: "m9", threadId: "t1", seq: 9, role: "user", text: body.text, createdAt: "2026-10-09T12:00:00.000Z", idempotencyKey: body.idempotencyKey },
      });
    let n = 0;
    URL.createObjectURL = (() => {
      const url = `blob:local/${++n}`;
      created.push(url);
      return url;
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = ((url: string) => {
      revoked.push(url);
    }) as typeof URL.revokeObjectURL;
    let uploadCount = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      calls.push({ url, method, body, signal: init?.signal });
      if (method === "POST" && url === "/api/persona/uploads") return uploadReply(body!, ++uploadCount);
      if (method === "POST" && url === "/api/persona/messages") return messageReply(body!);
      if (method === "DELETE" && url.startsWith("/api/persona/uploads/")) return new Response(null, { status: 204 });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    initial = { ...initialPersonaViewState, loaded: true, threadId: "t1", consoleThreadId: "t1" };
  });

  afterEach(async () => {
    await act(() => root.unmount());
    host.remove();
    // The tray revokes its URLs a tick after unmount.
    await new Promise((r) => setTimeout(r, 5));
  });

  function Harness() {
    const [persona, d] = useReducer(personaReducer, initial);
    dispatch = d;
    return createElement(PersonaView, { persona, sessions: [], onAction: d, onRefresh });
  }

  async function render() {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(() => root.render(createElement(router.MemoryRouter, { initialEntries: ["/persona"] }, createElement(Harness))));
    await settle();
  }

  async function settle() {
    for (let i = 0; i < 4; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
  }

  const q = <T extends Element = HTMLElement>(sel: string) => host.querySelector(sel) as T | null;
  const uploadsPosted = () => calls.filter((c) => c.url === "/api/persona/uploads");
  const discarded = () => calls.filter((c) => c.method === "DELETE").map((c) => c.url);
  const messagesPosted = () => calls.filter((c) => c.url === "/api/persona/messages" && c.method === "POST");
  const sendButton = () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Send") as HTMLButtonElement;
  const trayItems = () => [...host.querySelectorAll("[data-testid=persona-upload]")] as HTMLElement[];
  const textarea = () => q<HTMLTextAreaElement>("textarea")!;

  async function pick(...files: File[]) {
    const input = q<HTMLInputElement>("[data-testid=persona-attach-input]")!;
    Object.defineProperty(input, "files", { configurable: true, value: files });
    await act(() => input.dispatchEvent(new window.Event("change", { bubbles: true }) as unknown as Event));
    await settle();
  }

  async function typeText(value: string) {
    const el = textarea();
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!;
    await act(() => {
      setter.call(el, value);
      el.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    });
  }

  /** A paste or drop event carrying `data` as its clipboard or drag payload. */
  function transferEvent(type: string, key: "clipboardData" | "dataTransfer", data: unknown): Event {
    const event = new window.Event(type, { bubbles: true, cancelable: true }) as unknown as Event;
    Object.defineProperty(event, key, { value: data });
    return event;
  }

  const filesPayload = (files: File[]) => ({ files, items: files.map((f) => ({ kind: "file", getAsFile: () => f })), types: ["Files"], dropEffect: "none" });

  test("the attach button opens a picker that takes images and videos", async () => {
    await render();
    const button = q("button[aria-label='Attach image or video']")!;
    expect(button).not.toBeNull();
    expect(button.getAttribute("aria-disabled")).toBeNull();
    const input = q<HTMLInputElement>("[data-testid=persona-attach-input]")!;
    expect(input.type).toBe("file");
    expect(input.multiple).toBe(true);
    expect(input.getAttribute("accept")).toBe("image/png,image/jpeg,image/gif,image/webp,video/mp4,video/quicktime,video/webm");
    let opened = 0;
    input.click = () => {
      opened++;
    };
    await act(() => button.click());
    expect(opened).toBe(1);
  });

  test("a picked file uploads at once with its base64, name, type and thread, and previews in the tray", async () => {
    await render();
    await pick(file("shot.png", "image/png", "hello"));
    expect(uploadsPosted().map((c) => c.body)).toEqual([
      { threadId: "t1", name: "shot.png", mimeType: "image/png", dataBase64: "aGVsbG8=" },
    ]);
    const [item] = trayItems();
    expect(item.dataset.status).toBe("ready");
    expect(item.querySelector("img")!.getAttribute("src")).toBe("blob:local/1");
    expect(item.textContent).toContain("shot.png");
    expect(q("button[aria-label='Remove shot.png']")).not.toBeNull();
  });

  test("an untyped file is sent without a mimeType, for the collector to decide", async () => {
    await render();
    await pick(file("mystery", ""));
    expect(uploadsPosted()[0].body).toEqual({ threadId: "t1", name: "mystery", dataBase64: "aGVsbG8=" });
  });

  test("Send posts the attachment ids with empty text, shows the pending preview, and empties the tray", async () => {
    let answer!: (r: Response) => void;
    const pendingSend = new Promise<Response>((r) => (answer = r));
    messageReply = () => pendingSend;
    await render();
    expect(sendButton().disabled).toBe(true);
    await pick(file("shot.png", "image/png"));
    expect(sendButton().disabled).toBe(false);
    await act(() => sendButton().click());
    await settle();
    const [sent] = messagesPosted();
    expect(sent.body).toMatchObject({ text: "", threadId: "t1", attachmentIds: ["att-1"] });
    expect(trayItems()).toHaveLength(0);
    // The pending bubble shows the owner's local copy; no URL was revoked yet.
    const pending = q("[data-testid=persona-outbox-attachments] [data-attachment-id=att-1]")!;
    expect(pending.querySelector("img")!.getAttribute("src")).toBe("blob:local/1");
    expect(revoked).toEqual([]);

    // The confirmed row serves the attachment from the collector, and the local copy is released.
    await act(async () =>
      answer(
        json({
          message: {
            id: "m9",
            threadId: "t1",
            seq: 9,
            role: "user",
            text: "",
            createdAt: "2026-10-09T12:00:00.000Z",
            idempotencyKey: sent.body!.idempotencyKey,
            attachments: [attachment("att-1", "shot.png", "image/png")],
          },
        })
      )
    );
    await settle();
    expect(q("[data-testid=persona-outbox-attachments]")).toBeNull();
    expect(q("[data-message-id=m9] img")!.getAttribute("src")).toBe(personaAttachmentPath("att-1"));
    expect(revoked).toEqual(["blob:local/1"]);
  });

  test("Send waits while an upload is in flight", async () => {
    let finish!: () => void;
    uploadReply = (body) =>
      new Promise((resolve) => {
        finish = () => resolve(json({ attachment: attachment("att-9", String(body.name), "image/png") }, 201));
      });
    await render();
    await typeText("look at this");
    await pick(file("shot.png", "image/png"));
    expect(trayItems()[0].dataset.status).toBe("uploading");
    expect(trayItems()[0].textContent).toContain("Uploading…");
    expect(sendButton().disabled).toBe(true);
    expect(q("[data-testid=persona-upload-waiting]")!.textContent).toContain("Waiting for uploads to finish");
    await act(async () => finish());
    await settle();
    expect(sendButton().disabled).toBe(false);
    expect(q("[data-testid=persona-upload-waiting]")).toBeNull();
    await act(() => sendButton().click());
    await settle();
    expect(messagesPosted()[0].body).toMatchObject({ text: "look at this", attachmentIds: ["att-9"] });
  });

  test.each([
    ["an oversize image", file("big.png", "image/png", "x", 11 * 1024 * 1024), "big.png is 11.0 MB; images can be at most 10 MB"],
    ["an oversize video", file("clip.mov", "video/quicktime", "x", 62 * 1024 * 1024), "clip.mov is 62.0 MB; videos can be at most 50 MB"],
    ["an unsupported type", file("photo.heic", "image/heic"), "photo.heic: HEIC isn't supported — use PNG, JPEG, GIF, WebP, MP4, MOV or WebM"],
  ])("%s is refused before any upload", async (_label, refused, message) => {
    await render();
    await pick(refused);
    expect(uploadsPosted()).toHaveLength(0);
    const [item] = trayItems();
    expect(item.dataset.status).toBe("error");
    expect(item.querySelector("[data-testid=persona-upload-error]")!.textContent).toBe(message);
    expect(sendButton().disabled).toBe(true);
    await act(() => (q(`button[aria-label='Remove ${refused.name}']`) as HTMLElement).click());
    expect(trayItems()).toHaveLength(0);
  });

  test.each([
    ["a 400 with the collector's message", () => json({ error: "shot.png is not a PNG image" }, 400), "shot.png is not a PNG image"],
    ["a 413 with the collector's message", () => json({ error: "video too large (max 50 MB)" }, 413), "video too large (max 50 MB)"],
    ["a 413 from the gateway, with no JSON", () => new Response("request body too large", { status: 413 }), "shot.png is too large to upload"],
  ])("%s shows on the chip and the file is never sent", async (_label, reply, message) => {
    uploadReply = reply;
    await render();
    await pick(file("shot.png", "image/png"));
    const [item] = trayItems();
    expect(item.dataset.status).toBe("error");
    expect(item.querySelector("[data-testid=persona-upload-error]")!.textContent).toBe(message);
    expect(sendButton().disabled).toBe(true);
    await typeText("still sending words");
    expect(sendButton().disabled).toBe(false);
    await act(() => sendButton().click());
    await settle();
    expect(messagesPosted()[0].body).not.toHaveProperty("attachmentIds");
    expect(revoked).toEqual(["blob:local/1"]);
  });

  /** A clipboard holding `text` as text/plain and `html` as text/html beside `files`. */
  const clipboard = (text: string, files: File[] = [], html = "") => ({
    files: [],
    items: [
      ...(text ? [{ kind: "string", getAsFile: () => null }] : []),
      ...(html ? [{ kind: "string", getAsFile: () => null }] : []),
      ...files.map((f) => ({ kind: "file", getAsFile: () => f })),
    ],
    types: [...(text ? ["text/plain"] : []), ...(html ? ["text/html"] : []), ...(files.length ? ["Files"] : [])],
    getData: (type: string) => (type === "text/plain" ? text : type === "text/html" ? html : ""),
  });
  const png = () => [file("image.png", "image/png")];

  test.each([
    ["plain text", clipboard("hello there"), null],
    [
      "a spreadsheet copy: text and a table beside a rendered image",
      clipboard("Q1\t42\nQ2\t57", png(), "<table><tr><td>Q1</td><td>42</td></tr></table>"),
      "Pasted as text — drag the image in or use the paperclip to attach it",
    ],
    [
      "a copied link: its URL as text, its anchor as HTML, beside a preview image",
      clipboard("https://example.com/page", png(), '<a href="https://example.com/page">https://example.com/page</a>'),
      "Pasted as text — drag the image in or use the paperclip to attach it",
    ],
    [
      "a document copy: a paragraph beside a rendered image",
      clipboard("Quarterly plan", png(), "<meta charset='utf-8'><p>Quarterly plan</p>"),
      "Pasted as text — drag the image in or use the paperclip to attach it",
    ],
  ])("pasting %s pastes the text and attaches nothing", async (_label, data, notice) => {
    await render();
    const paste = transferEvent("paste", "clipboardData", data);
    await act(() => textarea().dispatchEvent(paste));
    await settle();
    expect(paste.defaultPrevented).toBe(false);
    expect(uploadsPosted()).toHaveLength(0);
    expect(trayItems()).toHaveLength(0);
    expect(q("[data-testid=persona-upload-notice]")?.textContent ?? null).toBe(notice);
  });

  test.each([
    ["an image alone", clipboard("", png())],
    [
      "Firefox's Copy Image: the image, its <img>, and its URL as text",
      clipboard("https://example.com/cat.png", png(), '<meta http-equiv="content-type" content="text/html; charset=utf-8"><img src="https://example.com/cat.png" alt="">'),
    ],
    ["Chrome's Copy Image: the image and a wrapped <img>", clipboard("", png(), "<html><body><!--StartFragment--><img src=\"https://x/y.png\"/><!--EndFragment--></body></html>")],
    ["a lone <img> beside its alt text", clipboard("cat", png(), "<div><img src=\"https://x/y.png\"></div>")],
  ])("pasting %s uploads the image", async (_label, data) => {
    await render();
    const imagePaste = transferEvent("paste", "clipboardData", data);
    await act(() => textarea().dispatchEvent(imagePaste));
    await settle();
    expect(imagePaste.defaultPrevented).toBe(true);
    expect(uploadsPosted().map((c) => c.body!.name)).toEqual(["image.png"]);
    expect(trayItems()).toHaveLength(1);
  });

  test("dragging files highlights the composer, and dropping uploads them", async () => {
    await render();
    const composer = q("[data-testid=persona-composer]")!;
    const clip = file("clip.mp4", "video/mp4");
    await act(() => composer.dispatchEvent(transferEvent("dragenter", "dataTransfer", filesPayload([clip]))));
    expect(composer.dataset.dragging).toBe("true");
    expect(q("[data-testid=persona-drop-zone]")!.textContent).toBe("Drop images or videos to attach");
    const drop = transferEvent("drop", "dataTransfer", filesPayload([clip]));
    await act(() => composer.dispatchEvent(drop));
    await settle();
    expect(drop.defaultPrevented).toBe(true);
    expect(composer.dataset.dragging).toBeUndefined();
    expect(uploadsPosted().map((c) => c.body)).toEqual([
      { threadId: "t1", name: "clip.mp4", mimeType: "video/mp4", dataBase64: "aGVsbG8=" },
    ]);
    const thumb = trayItems()[0].querySelector("video")!;
    expect(thumb.getAttribute("src")).toBe("blob:local/1");
    expect(thumb.muted).toBe(true);
    expect(thumb.getAttribute("preload")).toBe("metadata");
  });

  test("past four attachments, the rest are turned away with a message", async () => {
    await render();
    await pick(...["a", "b", "c", "d", "e"].map((n) => file(`${n}.png`, "image/png")));
    expect(uploadsPosted()).toHaveLength(4);
    expect(trayItems()).toHaveLength(4);
    expect(q("[data-testid=persona-upload-notice]")!.textContent).toBe(
      "A message can carry at most 4 attachments — not added: e.png"
    );
  });

  test("files upload one at a time, in order; the rest wait as Queued", async () => {
    const finish: (() => void)[] = [];
    uploadReply = (body, n) =>
      new Promise((resolve) => {
        finish[n] = () => resolve(json({ attachment: attachment(`att-${n}`, String(body.name), "image/png") }, 201));
      });
    await render();
    await pick(file("a.png", "image/png"), file("b.png", "image/png"), file("c.png", "image/png"));
    const states = () => trayItems().map((i) => [i.dataset.status, i.querySelector("[data-testid=persona-upload-state]")?.textContent]);
    expect(uploadsPosted().map((c) => c.body!.name)).toEqual(["a.png"]);
    expect(states()).toEqual([
      ["uploading", expect.stringContaining("Uploading…")],
      ["queued", "Queued"],
      ["queued", "Queued"],
    ]);
    expect(sendButton().disabled).toBe(true);

    // A queued file removed before its turn is never sent, so there is nothing to delete.
    await act(() => (q("button[aria-label='Remove b.png']") as HTMLElement).click());
    await act(async () => finish[1]());
    await settle();
    expect(uploadsPosted().map((c) => c.body!.name)).toEqual(["a.png", "c.png"]);
    expect(states().map(([s]) => s)).toEqual(["ready", "uploading"]);
    expect(sendButton().disabled).toBe(true);
    await act(async () => finish[2]());
    await settle();
    expect(states().map(([s]) => s)).toEqual(["ready", "ready"]);
    expect(sendButton().disabled).toBe(false);
    expect(discarded()).toEqual([]);
  });

  test("removing the file under way moves on to the next and deletes the late upload", async () => {
    const finish: (() => void)[] = [];
    uploadReply = (body, n) =>
      new Promise((resolve) => {
        finish[n] = () => resolve(json({ attachment: attachment(`att-${n}`, String(body.name), "image/png") }, 201));
      });
    await render();
    await pick(file("a.png", "image/png"), file("b.png", "image/png"));
    expect(uploadsPosted()).toHaveLength(1);
    await act(() => (q("button[aria-label='Remove a.png']") as HTMLElement).click());
    await settle();
    // a's request is aborted and b starts without waiting for it to settle.
    const [a, b] = uploadsPosted();
    expect(a.signal?.aborted).toBe(true);
    expect(b.body!.name).toBe("b.png");
    expect(b.signal?.aborted).toBe(false);
    expect(trayItems().map((i) => i.dataset.status)).toEqual(["uploading"]);
    // Had a landed anyway, its late answer is deleted.
    await act(async () => finish[1]());
    await settle();
    expect(discarded()).toEqual(["/api/persona/uploads/att-1"]);
    await act(async () => finish[2]());
    await settle();
    expect(trayItems().map((i) => i.dataset.status)).toEqual(["ready"]);
  });

  test("leaving the view stops the queue", async () => {
    let finish!: () => void;
    uploadReply = (body) =>
      new Promise((resolve) => {
        finish = () => resolve(json({ attachment: attachment("att-1", String(body.name), "image/png") }, 201));
      });
    await render();
    await pick(file("a.png", "image/png"), file("b.png", "image/png"));
    await act(() => root.render(createElement("div")));
    await new Promise((r) => setTimeout(r, 5));
    await act(async () => finish());
    await settle();
    expect(uploadsPosted()).toHaveLength(1);
    expect(discarded()).toEqual(["/api/persona/uploads/att-1"]);
  });

  test("discarding a failed send deletes its uploads", async () => {
    messageReply = () => json({ error: "collector restarting" }, 500);
    await render();
    await pick(file("a.png", "image/png"), file("b.png", "image/png"));
    await act(() => sendButton().click());
    await settle();
    await act(() => ([...host.querySelectorAll("button")].find((b) => b.textContent === "Discard") as HTMLElement).click());
    await settle();
    expect(discarded()).toEqual(["/api/persona/uploads/att-1", "/api/persona/uploads/att-2"]);
    expect(q("[data-testid=persona-outbox-attachments]")).toBeNull();
  });

  test("a paste and a drop in the same tick share the four slots", async () => {
    await render();
    const composer = q("[data-testid=persona-composer]")!;
    const batch = (prefix: string) => [1, 2, 3].map((n) => file(`${prefix}${n}.png`, "image/png"));
    await act(() => {
      textarea().dispatchEvent(transferEvent("paste", "clipboardData", clipboard("", batch("p"))));
      composer.dispatchEvent(transferEvent("drop", "dataTransfer", filesPayload(batch("d"))));
    });
    await settle();
    expect(uploadsPosted().map((c) => c.body!.name)).toEqual(["p1.png", "p2.png", "p3.png", "d1.png"]);
    expect(q("[data-testid=persona-upload-notice]")!.textContent).toBe(
      "A message can carry at most 4 attachments — not added: d2.png, d3.png"
    );
  });

  test("leaving the view releases the previews of sends still pending", async () => {
    messageReply = () => new Promise<Response>(() => {});
    await render();
    await pick(file("shot.png", "image/png"));
    await act(() => sendButton().click());
    await settle();
    expect(q("[data-testid=persona-outbox-attachments] img")!.getAttribute("src")).toBe("blob:local/1");
    expect(revoked).toEqual([]);
    await act(() => root.render(createElement("div")));
    await new Promise((r) => setTimeout(r, 5));
    expect(revoked).toEqual(["blob:local/1"]);
  });

  test("a failed send keeps its attachment ids, and Retry re-sends them", async () => {
    messageReply = () => json({ error: "collector restarting" }, 500);
    await render();
    await pick(file("shot.png", "image/png"));
    await act(() => sendButton().click());
    await settle();
    expect(host.textContent).toContain("Not sent — collector restarting");
    messageReply = (body) =>
      json({ message: { id: "m9", threadId: "t1", seq: 9, role: "user", text: "", createdAt: "2026-10-09T12:00:00.000Z", idempotencyKey: body.idempotencyKey } });
    await act(() => ([...host.querySelectorAll("button")].find((b) => b.textContent === "Retry") as HTMLElement).click());
    await settle();
    const [first, retry] = messagesPosted();
    expect(retry.body!.attachmentIds).toEqual(["att-1"]);
    expect(retry.body!.idempotencyKey).toBe(first.body!.idempotencyKey);
  });

  test("a shared thread offers no uploads: the paperclip explains why, and a paste uploads nothing", async () => {
    const thread = (id: string, extra: Partial<PersonaThreadSummary>): PersonaThreadSummary =>
      ({ id, owner: "me", channel: "slack", audience: "private", messageCount: 1, createdAt: "2026-10-09T10:00:00.000Z", updatedAt: "2026-10-09T10:00:00.000Z", ...extra }) as PersonaThreadSummary;
    initial = {
      ...initial,
      threadId: "t2",
      threads: [thread("t1", { channel: "console" }), thread("t2", { audience: "shared", title: "#eng" })],
    };
    await render();
    const button = q("button[aria-label='Attach image or video']")!;
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title")).toBe("Images and videos can only be sent in private threads");
    const input = q<HTMLInputElement>("[data-testid=persona-attach-input]")!;
    let opened = 0;
    input.click = () => {
      opened++;
    };
    await act(() => button.click());
    expect(opened).toBe(0);
    expect(q("[data-testid=persona-upload-notice]")!.textContent).toBe("Images and videos can only be sent in private threads");
    const paste = transferEvent("paste", "clipboardData", { files: [file("image.png", "image/png")], items: [], types: ["Files"] });
    await act(() => textarea().dispatchEvent(paste));
    await settle();
    expect(uploadsPosted()).toHaveLength(0);
    expect(trayItems()).toHaveLength(0);
  });

  test.each([
    ["a spreadsheet copy", () => clipboard("Q1\t42", png(), "<table><tr><td>Q1</td></tr></table>")],
    ["a copied image with its URL", () => clipboard("https://example.com/cat.png", png(), '<img src="https://example.com/cat.png">')],
  ])("in a shared thread, %s still pastes its text and attaches nothing", async (_label, data) => {
    initial = {
      ...initial,
      threadId: "t2",
      threads: [
        { id: "t1", owner: "me", channel: "console", audience: "private", messageCount: 1 },
        { id: "t2", owner: "me", channel: "slack", audience: "external", messageCount: 1, title: "#partners" },
      ] as unknown as PersonaThreadSummary[],
    };
    await render();
    const paste = transferEvent("paste", "clipboardData", data());
    await act(() => textarea().dispatchEvent(paste));
    await settle();
    expect(paste.defaultPrevented).toBe(false);
    expect(q("[data-testid=persona-upload-notice]")!.textContent).toBe("Images and videos can only be sent in private threads");
    expect(uploadsPosted()).toHaveLength(0);
    expect(trayItems()).toHaveLength(0);
  });

  test("removing an item or leaving the view revokes its preview", async () => {
    await render();
    await pick(file("a.png", "image/png"), file("b.png", "image/png"));
    await act(() => (q("button[aria-label='Remove a.png']") as HTMLElement).click());
    expect(revoked).toEqual(["blob:local/1"]);
    await act(() => root.render(createElement("div")));
    await new Promise((r) => setTimeout(r, 5));
    expect(revoked).toEqual(["blob:local/1", "blob:local/2"]);
    expect(discarded()).toEqual(["/api/persona/uploads/att-1", "/api/persona/uploads/att-2"]);
  });

  test("switching threads empties the tray and deletes its uploads", async () => {
    await render();
    await pick(file("shot.png", "image/png"));
    expect(trayItems()).toHaveLength(1);
    await act(() => dispatch({ type: "select", threadId: "t3" }));
    await settle();
    expect(trayItems()).toHaveLength(0);
    expect(revoked).toEqual(["blob:local/1"]);
    expect(discarded()).toEqual(["/api/persona/uploads/att-1"]);
  });

  test("removing a ready item deletes its upload; a refused or failed one has nothing to delete", async () => {
    uploadReply = (body, n) =>
      n === 2 ? json({ error: "nope" }, 400) : json({ attachment: attachment(`att-${n}`, String(body.name), "image/png") }, 201);
    await render();
    await pick(file("ok.png", "image/png"), file("bad.png", "image/png"), file("x.heic", "image/heic"));
    for (const name of ["ok.png", "bad.png", "x.heic"]) {
      await act(() => (q(`button[aria-label='Remove ${name}']`) as HTMLElement).click());
    }
    await settle();
    expect(discarded()).toEqual(["/api/persona/uploads/att-1"]);
  });

  test("an upload that finishes after its item was removed is deleted", async () => {
    let finish!: () => void;
    uploadReply = (body) =>
      new Promise((resolve) => {
        finish = () => resolve(json({ attachment: attachment("late-1", String(body.name), "image/png") }, 201));
      });
    await render();
    await pick(file("slow.png", "image/png"));
    await act(() => (q("button[aria-label='Remove slow.png']") as HTMLElement).click());
    expect(discarded()).toEqual([]);
    await act(async () => finish());
    await settle();
    expect(discarded()).toEqual(["/api/persona/uploads/late-1"]);
    expect(trayItems()).toHaveLength(0);
  });

  test("a sent upload is never deleted, even when the view goes", async () => {
    await render();
    await pick(file("shot.png", "image/png"));
    await act(() => sendButton().click());
    await settle();
    await act(() => root.render(createElement("div")));
    await new Promise((r) => setTimeout(r, 5));
    expect(discarded()).toEqual([]);
  });
});

describe("Persona composer tray across threads", () => {
  let host: HTMLElement;
  let root: Root;

  afterEach(async () => {
    await act(() => root.unmount());
    host.remove();
    await new Promise((r) => setTimeout(r, 5));
  });

  test("an upload that throws is shown as an error and the queue moves on", async () => {
    URL.createObjectURL = (() => "blob:x") as typeof URL.createObjectURL;
    URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
    const started: string[] = [];
    const upload = async (f: File) => {
      started.push(f.name);
      if (f.name === "a.png") throw new Error("reader exploded");
      return { ok: true as const, attachment: attachment("b1", f.name, "image/png") };
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(() =>
      root.render(createElement(PersonaComposer, { jobs: [], onTag: () => {}, paused: false, placeholder: "", upload, onSend: () => {} }))
    );
    const input = host.querySelector("[data-testid=persona-attach-input]") as HTMLInputElement;
    Object.defineProperty(input, "files", { configurable: true, value: [file("a.png", "image/png"), file("b.png", "image/png")] });
    await act(() => input.dispatchEvent(new window.Event("change", { bubbles: true }) as unknown as Event));
    for (let i = 0; i < 3; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
    expect(started).toEqual(["a.png", "b.png"]);
    const items = [...host.querySelectorAll("[data-testid=persona-upload]")] as HTMLElement[];
    expect(items.map((i) => i.dataset.status)).toEqual(["error", "ready"]);
    expect(items[0].querySelector("[data-testid=persona-upload-error]")!.textContent).toBe("Upload failed: reader exploded");
  });

  test("the console thread's id resolving keeps the tray; moving to another thread empties it", async () => {
    URL.createObjectURL = (() => "blob:x") as typeof URL.createObjectURL;
    URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
    const upload = async (f: File) => ({ ok: true as const, attachment: attachment("a1", f.name, "image/png") });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const renderComposer = (threadId?: string, consoleThreadId?: string) =>
      act(() =>
        root.render(
          createElement(PersonaComposer, { jobs: [], onTag: () => {}, paused: false, placeholder: "", threadId, consoleThreadId, upload, onSend: () => {} })
        )
      );
    await renderComposer(undefined, undefined);
    const input = host.querySelector("[data-testid=persona-attach-input]") as HTMLInputElement;
    Object.defineProperty(input, "files", { configurable: true, value: [file("a.png", "image/png")] });
    await act(() => input.dispatchEvent(new window.Event("change", { bubbles: true }) as unknown as Event));
    await act(async () => new Promise((r) => setTimeout(r, 5)));
    const tray = () => host.querySelectorAll("[data-testid=persona-upload]").length;
    expect(tray()).toBe(1);
    await renderComposer("t1", "t1");
    expect(tray()).toBe(1);
    await renderComposer("t2", "t1");
    expect(tray()).toBe(0);
  });
});

describe("Persona message media", () => {
  let host: HTMLElement;
  let root: Root;
  const noop = () => {};

  afterEach(async () => {
    await act(() => root.unmount());
    host.remove();
  });

  function renderThread(messages: PersonaMessage[], outbox: PersonaViewState["outbox"] = []) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    return act(() =>
      root.render(
        createElement(Thread, {
          persona: { ...initialPersonaViewState, loaded: true, threadId: "t1", consoleThreadId: "t1", messages, outbox },
          approvalsById: new Map<string, PersonaApproval>(),
          jobsById: new Map(),
          approvalProps: { busy: new Set<string>(), errors: {}, onDecide: noop },
          narrow: false,
          consoleThread: true,
          onQuickReply: noop,
          onResend: noop,
          onDiscard: noop,
          onRevealJob: noop,
        })
      )
    );
  }

  const row = (seq: number, role: PersonaMessage["role"], text: string, attachments: PersonaAttachment[]): PersonaMessage => ({
    id: `m${seq}`,
    threadId: "t1",
    seq,
    role,
    text,
    createdAt: "2026-10-09T12:00:00.000Z",
    attachments,
  });

  test("an owner's video plays inline from the attachment route, with its length and note", async () => {
    await renderThread([
      row(1, "user", "", [
        attachment("v/1", "demo.mov", "video/quicktime", { video: { durationSec: 83.4, frames: 0, note: "ffmpeg is not available on the collector host" } }),
        attachment("i1", "shot.png", "image/png"),
      ]),
    ]);
    const video = host.querySelector("[data-message-id=m1] video") as HTMLVideoElement;
    expect(video.getAttribute("src")).toBe(personaAttachmentPath("v/1"));
    expect(video.hasAttribute("controls")).toBe(true);
    expect(video.getAttribute("preload")).toBe("metadata");
    const caption = host.querySelector("[data-attachment-id='v/1'] figcaption")!;
    expect(caption.textContent).toContain("demo.mov");
    expect(caption.textContent).toContain("1:23");
    expect(host.querySelector("[data-testid=attachment-video-note]")!.textContent).toBe("ffmpeg is not available on the collector host");
    expect(host.querySelector("[data-message-id=m1] img")!.getAttribute("src")).toBe(personaAttachmentPath("i1"));
    const download = host.querySelector("[data-attachment-id='v/1'] [data-testid=attachment-download]")!;
    expect(download.textContent).toBe("Download");
    expect(download.getAttribute("href")).toBe(personaAttachmentPath("v/1"));
    expect(download.getAttribute("download")).toBe("demo.mov");
    // A media-only message renders no empty text bubble.
    expect(host.querySelector("[data-message-id=m1]")!.textContent).not.toContain("undefined");
  });

  test("a video Persona attached plays inline with its poster frame; one without a poster gets none", async () => {
    await renderThread([
      row(1, "persona", "Here's the flow.", [
        attachment("pv", "signup-flow.mp4", "video/mp4", { caption: "Signup flow", video: { durationSec: 12.5, frames: 0, poster: true } }),
      ]),
      row(2, "persona", "And the cold load.", [attachment("pw", "cold-load.webm", "video/webm", { video: { frames: 0 } })]),
    ]);
    const withPoster = host.querySelector("[data-attachment-id=pv] video") as HTMLVideoElement;
    expect({
      src: withPoster.getAttribute("src"),
      poster: withPoster.getAttribute("poster"),
      preload: withPoster.getAttribute("preload"),
      controls: withPoster.hasAttribute("controls"),
    }).toEqual({ src: personaAttachmentPath("pv"), poster: personaAttachmentPosterPath("pv"), preload: "metadata", controls: true });
    expect(host.querySelector("[data-attachment-id=pv] figcaption")!.textContent).toContain("Signup flow");
    const noPoster = host.querySelector("[data-attachment-id=pw] video")!;
    expect(noPoster.getAttribute("src")).toBe(personaAttachmentPath("pw"));
    expect(noPoster.hasAttribute("poster")).toBe(false);
  });

  describe("lazy loading", () => {
    /** The IntersectionObserver stand-in's live instances, each with what it watches. */
    let observers: Array<{ callback: (entries: Array<{ isIntersecting: boolean }>) => void; options?: { root?: Element | null; rootMargin?: string }; targets: Element[]; disconnected: boolean }>;
    const realObserver = (globalThis as Record<string, unknown>).IntersectionObserver;

    beforeEach(() => {
      observers = [];
      (globalThis as Record<string, unknown>).IntersectionObserver = class {
        private readonly entry: (typeof observers)[number];
        constructor(callback: (typeof observers)[number]["callback"], options?: { root?: Element | null; rootMargin?: string }) {
          this.entry = { callback, options, targets: [], disconnected: false };
          observers.push(this.entry);
        }
        observe(el: Element) {
          this.entry.targets.push(el);
        }
        disconnect() {
          this.entry.disconnected = true;
        }
      };
    });

    afterEach(() => {
      (globalThis as Record<string, unknown>).IntersectionObserver = realObserver;
    });

    test("a video far from the viewport holds its place without loading, and loads once it comes near", async () => {
      await renderThread([
        row(1, "persona", "Recording:", [attachment("pv", "flow.mp4", "video/mp4", { video: { frames: 0, poster: true } })]),
      ]);
      const figure = host.querySelector("[data-attachment-id=pv]")!;
      expect(figure.querySelector("video")).toBeNull();
      expect(figure.querySelector("[data-testid=attachment-video-placeholder]")).not.toBeNull();
      // Nothing that would fetch the video or its poster is in the DOM yet.
      expect(host.innerHTML).not.toContain(personaAttachmentPosterPath("pv"));
      expect(observers).toHaveLength(1);
      expect(observers[0]!.options?.rootMargin).toBe("400px");
      expect(observers[0]!.targets).toEqual([figure]);
      // The margin is measured around the thread's own scroll box, which clips the messages, not the page.
      const root = observers[0]!.options?.root as HTMLElement | null | undefined;
      expect(root).toBeTruthy();
      expect(root!.contains(figure)).toBe(true);
      expect(root!.style.overflowY).toBe("auto");

      await act(() => observers[0]!.callback([{ isIntersecting: false }]));
      expect(figure.querySelector("video")).toBeNull();
      await act(() => observers[0]!.callback([{ isIntersecting: true }]));
      const video = figure.querySelector("video")!;
      expect(video.getAttribute("src")).toBe(personaAttachmentPath("pv"));
      expect(video.getAttribute("poster")).toBe(personaAttachmentPosterPath("pv"));
      expect(figure.querySelector("[data-testid=attachment-video-placeholder]")).toBeNull();
      expect(observers[0]!.disconnected).toBe(true);
      // The player keeps the placeholder's 16:9 box until its metadata gives its own shape.
      expect((video as HTMLVideoElement).style.aspectRatio).toBe("16 / 9");
      await act(() => video.dispatchEvent(new window.Event("loadedmetadata") as unknown as Event));
      expect((figure.querySelector("video") as HTMLVideoElement).style.aspectRatio).toBe("");
    });

    test("a video reply arriving as a live frame shows its player without a refresh", async () => {
      host = document.createElement("div");
      document.body.appendChild(host);
      root = createRoot(host);
      let dispatchFrame: Dispatch<PersonaAction> = () => {};
      function Live() {
        const [persona, d] = useReducer(personaReducer, {
          ...initialPersonaViewState,
          loaded: true,
          threadId: "t1",
          consoleThreadId: "t1",
          messages: [row(1, "user", "show me the recording", [])],
        });
        dispatchFrame = d;
        return createElement(Thread, {
          persona,
          approvalsById: new Map<string, PersonaApproval>(),
          jobsById: new Map(),
          approvalProps: { busy: new Set<string>(), errors: {}, onDecide: noop },
          narrow: false,
          consoleThread: true,
          onQuickReply: noop,
          onResend: noop,
          onDiscard: noop,
          onRevealJob: noop,
        });
      }
      await act(() => root.render(createElement(Live)));
      expect(host.querySelector("[data-attachment-id=live]")).toBeNull();

      const reply = row(2, "persona", "Here it is.", [attachment("live", "flow.mp4", "video/mp4", { video: { frames: 0, poster: true } })]);
      await act(() =>
        dispatchFrame({ type: "frame", message: { type: "persona:message", payload: reply, timestamp: "2026-10-10T12:00:00.000Z" } })
      );
      expect(host.querySelector("[data-message-id=m2]")!.textContent).toContain("Here it is.");
      expect(host.querySelector("[data-attachment-id=live] [data-testid=attachment-video-placeholder]")).not.toBeNull();
      const observer = observers.find((o) => o.targets.includes(host.querySelector("[data-attachment-id=live]")!))!;
      await act(() => observer.callback([{ isIntersecting: true }]));
      expect(host.querySelector("[data-attachment-id=live] video")!.getAttribute("src")).toBe(personaAttachmentPath("live"));
    });
  });

  /** Fails the video element the way the browser would, with a MediaError code. */
  async function failVideo(code: number) {
    const video = host.querySelector("[data-attachment-id=v2] video")!;
    Object.defineProperty(video, "error", { configurable: true, value: { code } });
    await act(() => video.dispatchEvent(new window.Event("error") as unknown as Event));
  }

  test("a failed load offers Retry, which loads the same source again", async () => {
    await renderThread([row(1, "user", "", [attachment("v2", "clip.mp4", "video/mp4")])]);
    const first = host.querySelector("[data-attachment-id=v2] video");
    await failVideo(2);
    expect(host.querySelector("[data-attachment-id=v2] video")).toBeNull();
    const retry = host.querySelector("[data-testid=attachment-video-retry]")!;
    expect(retry.textContent).toBe("Couldn't load the video — Retry");
    await act(() => (retry.querySelector("button") as HTMLElement).click());
    const again = host.querySelector("[data-attachment-id=v2] video")!;
    expect(again).not.toBe(first);
    expect(again.getAttribute("src")).toBe(personaAttachmentPath("v2"));
  });

  test("an aborted load leaves the player as it is", async () => {
    await renderThread([row(1, "user", "", [attachment("v2", "clip.mp4", "video/mp4")])]);
    await failVideo(1);
    expect(host.querySelector("[data-attachment-id=v2] video")).not.toBeNull();
    expect(host.querySelector("[data-testid=attachment-video-fallback]")).toBeNull();
  });

  /** Answers the "not supported" probe with `status` (0: the request fails), recording each request. */
  function stubProbe(status: number): { url: string; init?: RequestInit }[] {
    const probes: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      probes.push({ url: String(input), init });
      if (status === 0) throw new TypeError("Failed to fetch");
      return new Response(status < 300 ? "x" : "{}", { status });
    }) as typeof fetch;
    return probes;
  }

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test.each([
    ["a 401", 401],
    ["a 404", 404],
    ["a 503", 503],
    ["a refused connection", 0],
  ])("a 'not supported' error whose source answers %s offers Retry", async (_label, status) => {
    const probes = stubProbe(status);
    await renderThread([row(1, "user", "", [attachment("v2", "clip.mp4", "video/mp4")])]);
    await failVideo(4);
    await act(async () => new Promise((r) => setTimeout(r, 5)));
    expect(probes.map((p) => [p.url, p.init?.method, (p.init?.headers as Record<string, string>).Range])).toEqual([
      [personaAttachmentPath("v2"), "GET", "bytes=0-0"],
    ]);
    expect(host.querySelector("[data-testid=attachment-video-retry]")!.textContent).toBe("Couldn't load the video — Retry");
    expect(host.querySelector("[data-testid=attachment-video-fallback]")).toBeNull();
  });

  test.each([
    ["undecodable", 3, 0],
    ["'not supported' whose source serves a range", 4, 206],
    ["'not supported' whose source serves it whole", 4, 200],
  ])("an %s video gives way to a download link", async (_label, code, status) => {
    const probes = stubProbe(status);
    await renderThread([row(1, "user", "", [attachment("v2", "hevc.mov", "video/quicktime")])]);
    await failVideo(code);
    await act(async () => new Promise((r) => setTimeout(r, 5)));
    expect(probes).toHaveLength(code === 3 ? 0 : 1);
    expect(host.querySelector("[data-attachment-id=v2] video")).toBeNull();
    const fallback = host.querySelector("[data-testid=attachment-video-fallback]")!;
    expect(fallback.textContent).toContain("This browser can't play this video.");
    const links = [...host.querySelectorAll("[data-attachment-id=v2] [data-testid=attachment-download]")];
    expect(links.map((l) => [l.textContent, l.getAttribute("href"), l.getAttribute("download")])).toEqual([
      ["Download hevc.mov", personaAttachmentPath("v2"), "hevc.mov"],
    ]);
  });

  test("a pending send without a local preview names its files", async () => {
    await renderThread([], [
      {
        idempotencyKey: "k1",
        text: "",
        createdAt: "2026-10-09T12:00:00.000Z",
        afterSeq: 0,
        status: "sending",
        attachmentIds: ["gone-1"],
        attachments: [attachment("gone-1", "clip.webm", "video/webm")],
      },
    ]);
    const chip = host.querySelector("[data-testid=persona-outbox-attachments] [data-attachment-id=gone-1]")!;
    expect(chip.textContent).toBe("▶ clip.webm");
  });
});

async function onRefresh() {}
