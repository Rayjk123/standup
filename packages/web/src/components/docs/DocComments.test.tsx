import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement, useRef } from "react";
import type { DocComment } from "@standup/shared";
import type { Root } from "react-dom/client";
import { GlobalWindow } from "happy-dom";

// react-dom decides whether a DOM exists when it is first imported, so the
// window is installed before the view modules load.
const window = new GlobalWindow({ url: "http://localhost/" });
const GLOBALS = ["window", "document", "navigator", "Node", "HTMLElement", "Element", "Text", "Event", "MutationObserver", "getComputedStyle"] as const;
const saved = new Map<string, unknown>();
const savedFetch = globalThis.fetch;

let act: (fn: () => void | Promise<void>) => Promise<void>;
let createRoot: (el: Element) => Root;
let DocComments: typeof import("./DocComments").DocComments;

beforeAll(async () => {
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    const value = (window as unknown as Record<string, unknown>)[name];
    (globalThis as Record<string, unknown>)[name] = typeof value === "function" && /^[a-z]/.test(name) ? value.bind(window) : value;
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = (await import("react")) as unknown as { act: typeof act });
  ({ createRoot } = await import("react-dom/client"));
  ({ DocComments } = await import("./DocComments"));
});

afterAll(async () => {
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  globalThis.fetch = savedFetch;
  await window.happyDOM.close();
});

let host: HTMLElement;
let root: Root;

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  globalThis.fetch = savedFetch;
});

const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
};
/** Waits up to `ms` for `check` to hold. */
async function until(check: () => boolean, ms = 3000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (check()) return true;
    await act(async () => new Promise((r) => setTimeout(r, 25)));
  }
  return check();
}
/** Selects from one text position to another in the doc, as a mouse drag ending in mouseup does. */
async function select(doc: HTMLElement, from: Text, fromOffset: number, to: Text, toOffset: number) {
  const range = window.document.createRange();
  type Boundary = Parameters<typeof range.setStart>[0];
  range.setStart(from as unknown as Boundary, fromOffset);
  range.setEnd(to as unknown as Boundary, toOffset);
  await act(async () => {
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    // The selectionchange events fire on a later tick.
    await new Promise((r) => setTimeout(r, 0));
    doc.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }) as unknown as Event);
  });
}
/** Types `value` into a React-controlled input or textarea. */
async function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value);
    el.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
  });
}
const qa = (id: string) => [...host.querySelectorAll(`[data-testid=${id}]`)] as HTMLElement[];
const q = (id: string) => qa(id)[0] ?? null;

const comment = (id: string, quote: string, patch: Partial<DocComment> = {}): DocComment => ({
  id,
  anchor: { quote, prefix: "", suffix: "" },
  author: "alex",
  body: `About ${quote}?`,
  state: "answered",
  resolved: false,
  createdAt: new Date().toISOString(),
  replies: [],
  ...patch,
});

/** A fake comments API holding `comments`; records every write. New comments are the owner's when `asOwner`, as the server makes them. */
function serve(comments: DocComment[], asOwner = false) {
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
    if (method === "GET") return json({ comments });
    writes.push({ method, path, body });
    const one = /comments\/([^/]+)\/(reply|resolve)$/.exec(path);
    if (one) {
      const c = comments.find((x) => x.id === one[1])!;
      const next =
        one[2] === "reply"
          ? { ...c, state: "answered" as const, replies: [...c.replies, { id: "r", authorKind: "owner" as const, author: "alice", body: body.body, createdAt: c.createdAt }] }
          : { ...c, resolved: body.resolved };
      comments.splice(comments.indexOf(c), 1, next);
      return json({ comment: next });
    }
    const made = comment("new", body.anchor.quote, {
      body: body.body,
      anchor: body.anchor,
      ...(asOwner ? { author: "alice", byOwner: true as const, state: "answered" as const } : { state: "pending" as const }),
    });
    comments.push(made);
    return json({ comment: made });
  }) as typeof fetch;
  return writes;
}

/**
 * Renders `html` as the doc with its comment margin beside it; returns the
 * doc element. The owner's doc is mounted as DocPane mounts it, with an
 * editor toolbar of its own: `startComment` is what that toolbar's Comment
 * item runs. A reader's doc has no toolbar, so the margin shows its chip.
 */
async function mount(html: string, role: "owner" | "reader") {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  let doc: HTMLElement | null = null;
  let start: (() => void) | null = null;
  const bindStartComment = role === "owner" ? (fn: (() => void) | null) => void (start = fn) : undefined;
  function Pane({ content }: { content: string }) {
    const ref = useRef<HTMLDivElement>(null);
    return createElement(
      "div",
      null,
      createElement("div", { ref: (el: HTMLDivElement | null) => ((ref as { current: HTMLDivElement | null }).current = doc = el), "data-testid": "doc", dangerouslySetInnerHTML: { __html: content } }),
      createElement(DocComments, { docId: "d1", root: ref, role, contentKey: content, bindStartComment })
    );
  }
  await act(() => root.render(createElement(Pane, { content: html })));
  await settle();
  return {
    doc: doc!,
    /** Starts a comment on the selection: the editor toolbar's Comment item for the owner, the chip's icon for a reader. */
    startComment: async () => {
      if (role === "owner") await act(async () => start!());
      else await act(async () => q("doc-comment-start")!.click());
    },
    /** Replaces the doc's content, as a new revision does. */
    replace: async (next: string) => {
      await act(() => root.render(createElement(Pane, { content: next })));
      await settle();
    },
  };
}

describe("the comment margin", () => {
  test("lists open comments in passage order, an orphan under Passage removed, and resolved ones behind a toggle", async () => {
    serve([
      comment("late", "the recommendation"),
      comment("early", "a regional cache"),
      comment("gone", "a sentence since deleted"),
      comment("done", "a regional cache", { resolved: true }),
    ]);
    await mount("<h1>Cache</h1><p>We compare a regional cache with pre-rendering.</p><h2>Recommendation</h2><p>Go with the recommendation.</p>", "reader");
    const bodies = () => qa("doc-comment").map((c) => c.textContent ?? "");
    expect(bodies()[0]).toContain("About a regional cache?");
    expect(bodies()[1]).toContain("About the recommendation?");
    expect(q("doc-comments-orphans")).not.toBeNull();
    expect(bodies()[2]).toContain("About a sentence since deleted?");
    expect(bodies()).toHaveLength(3);
    await act(async () => q("doc-comments-resolved-toggle")!.click());
    expect(bodies()).toHaveLength(4);
  });

  test("a comment finds its passage again after the doc is edited, and turns orphan when the passage goes", async () => {
    serve([comment("c", "one source of truth")]);
    const { replace } = await mount("<p>Option 1 keeps one source of truth.</p>", "reader");
    expect(q("doc-comments-orphans")).toBeNull();
    expect(qa("doc-comment")).toHaveLength(1);
    await replace("<h1>New intro</h1><p>Added first.</p><p>Option 1 keeps one\nsource of truth.</p>");
    expect(q("doc-comments-orphans")).toBeNull();
    await replace("<p>Option 1 keeps a single source.</p>");
    expect(await until(() => q("doc-comments-orphans") !== null)).toBe(true);
    await replace("<p>Back: one source of truth.</p>");
    expect(await until(() => q("doc-comments-orphans") === null)).toBe(true);
  });

  test("a reader with no comments to see gets no margin; the owner always gets one, with a quiet empty state", async () => {
    serve([]);
    await mount("<p>Nothing said yet.</p>", "reader");
    expect(q("doc-comments")).toBeNull();
    await act(() => root.unmount());
    host.remove();

    serve([]);
    await mount("<p>Nothing said yet.</p>", "owner");
    expect(q("doc-comments")).not.toBeNull();
    expect(q("doc-comments-empty")!.textContent).toBe("No comments yet. Select text to leave one.");
  });

  test("a reader's selection shows the comment chip: one icon button named Comment, no text, gone with the selection", async () => {
    serve([]);
    const { doc } = await mount("<p>Readers never wait on the renderer.</p>", "reader");
    expect(q("doc-comment-chip")).toBeNull();
    const text = doc.querySelector("p")!.firstChild as Text;
    await select(doc, text, 0, text, 7);
    const button = q("doc-comment-start")!;
    expect(q("doc-comment-chip")!.contains(button)).toBe(true);
    expect([button.getAttribute("aria-label"), button.getAttribute("title")?.startsWith("Comment ("), button.textContent!.trim()]).toEqual(["Comment", true, ""]);
    expect(button.querySelector("svg")).not.toBeNull();
    // Clicking in the doc without selecting takes it away.
    await select(doc, text, 3, text, 3);
    expect(q("doc-comment-chip")).toBeNull();
  });

  test("the owner's doc shows no chip: Comment is the editor toolbar's item, which runs the same start", async () => {
    serve([]);
    const { doc, startComment } = await mount("<p>Readers never wait on the renderer.</p>", "owner");
    const text = doc.querySelector("p")!.firstChild as Text;
    await select(doc, text, 0, text, 7);
    expect(q("doc-comment-chip")).toBeNull();
    await startComment();
    expect(q("doc-comment-composer")!.textContent).toContain("On “Readers”");
  });

  test("in the owner's editor, a selection inside a code block (where the toolbar never shows) gets the chip", async () => {
    serve([]);
    const { doc } = await mount(
      "<p>Run this:</p><div class='milkdown-code-block' contenteditable='false'><div class='cm-content' contenteditable='true'>deploy --fast</div></div>",
      "owner"
    );
    const code = doc.querySelector(".cm-content")!.firstChild as Text;
    await select(doc, code, 7, code, 13);
    await act(async () => q("doc-comment-start")!.click());
    expect(q("doc-comment-composer")!.textContent).toContain("On “--fast”");
  });

  test("Mod-Alt-M starts a comment on the selection, for the owner and a reader alike", async () => {
    for (const role of ["owner", "reader"] as const) {
      if (role === "reader") {
        await act(() => root.unmount());
        host.remove();
      }
      serve([]);
      const { doc } = await mount("<p>Readers never wait on the renderer.</p>", role);
      const text = doc.querySelector("p")!.firstChild as Text;
      await select(doc, text, 0, text, 7);
      // Sent where focus is after a mouse selection in a read-only view: the page, not the doc.
      const key = new window.KeyboardEvent("keydown", { code: "KeyM", key: "m", altKey: true, ctrlKey: true, bubbles: true, cancelable: true });
      await act(async () => void document.body.dispatchEvent(key as unknown as Event));
      expect(q("doc-comment-composer")!.textContent).toContain("On “Readers”");
      expect(key.defaultPrevented).toBe(true);
    }
  });

  test("Mod-Alt-M with no selection in the doc is left alone, so the key does what it would anyway", async () => {
    serve([]);
    await mount("<p>Readers never wait on the renderer.</p>", "reader");
    window.getSelection()!.removeAllRanges();
    const key = new window.KeyboardEvent("keydown", { code: "KeyM", key: "m", altKey: true, ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => void document.body.dispatchEvent(key as unknown as Event));
    expect(q("doc-comment-composer")).toBeNull();
    expect(key.defaultPrevented).toBe(false);
  });

  test("starting a comment with nothing selected does nothing", async () => {
    serve([]);
    const { doc, startComment } = await mount("<p>Readers never wait on the renderer.</p>", "owner");
    const text = doc.querySelector("p")!.firstChild as Text;
    await select(doc, text, 2, text, 2);
    await startComment();
    expect(q("doc-comment-composer")).toBeNull();
  });

  // The owner and a reader start a comment the same way; only the stored comment differs (the server decides).
  for (const role of ["reader", "owner"] as const) {
    test(`the ${role}'s Comment opens the composer on the selection and posts the passage's anchor`, async () => {
      const writes = serve([], role === "owner");
      const { doc, startComment } = await mount("<p>Readers never wait on the renderer, but a template change re-renders the whole site.</p>", role);
      const text = doc.querySelector("p")!.firstChild as Text;
      const at = text.data.indexOf("a template change");
      await select(doc, text, at, text, at + "a template change".length);
      await startComment();
      expect(q("doc-comment-composer")!.textContent).toContain("On “a template change”");
      expect(q("doc-comments-empty")).toBeNull();
      // Only the owner, whose comments become public when the doc is shared, is told so.
      expect(q("doc-comment-visibility") !== null).toBe(role === "owner");
      const input = q("doc-comment-input") as HTMLTextAreaElement;
      // The editor's formatting toolbar is hidden while the composer has focus, and back once it hasn't.
      const focusEvent = (type: string) => act(async () => void input.dispatchEvent(new window.FocusEvent(type, { bubbles: true }) as unknown as Event));
      await focusEvent("focusin");
      expect(doc.classList.contains("doc-commenting")).toBe(true);
      await focusEvent("focusout");
      expect(doc.classList.contains("doc-commenting")).toBe(false);
      await typeInto(input, "How long does it take?");
      await act(async () => q("doc-comment-send")!.click());
      await settle();
      expect(writes).toEqual([
        {
          method: "POST",
          path: "/api/docs/d1/comments",
          body: { body: "How long does it take?", anchor: { quote: "a template change", prefix: "never wait on the renderer, but ", suffix: " re-renders the whole site." } },
        },
      ]);
      expect(q("doc-comment-composer")).toBeNull();
      // A reader's comment goes to the agent; the owner's carries no state at all.
      expect(qa("doc-comment-state").map((t) => t.textContent)).toEqual(role === "owner" ? [] : ["Agent is replying…"]);
    });
  }

  test("the editor's own UI text (list labels, buttons) is left out of a quote, so readers find the passage too", async () => {
    const writes = serve([], true);
    const { doc, startComment } = await mount(
      "<ol><li><div class='label-wrapper' contenteditable='false'><span class='label'>1.</span></div><p>Warm the cache first.</p></li>" +
        "<li><div class='label-wrapper' contenteditable='false'><span class='label'>2.</span></div><p>Then serve one region.</p></li></ol><button>Copy</button>",
      "owner"
    );
    const [first, second] = [...doc.querySelectorAll("p")].map((p) => p.firstChild as Text);
    await select(doc, first!, 5, second!, 4);
    await startComment();
    await typeInto(q("doc-comment-input") as HTMLTextAreaElement, "Why this order?");
    await act(async () => q("doc-comment-send")!.click());
    await settle();
    expect((writes[0]!.body as { anchor: unknown }).anchor).toEqual({ quote: "the cache first.Then", prefix: "Warm ", suffix: " serve one region." });
  });

  test("a code block's text is the doc's own (its node view is contenteditable=false); only its tools are left out", async () => {
    const code =
      "<div class='milkdown-code-block' contenteditable='false'><div class='tools'><span>bash</span><button>Copy</button></div>" +
      "<div class='cm-gutters'><div>1</div></div><div class='cm-content' contenteditable='true'>deploy --fast</div></div>";
    const writes = serve([comment("r", "deploy --fast")], true);
    const { doc, startComment } = await mount(`<p>Run this:</p>${code}`, "owner");
    // A reader's comment on the code is found in the owner's editor, not left as an orphan.
    expect(q("doc-comments-orphans")).toBeNull();
    const text = doc.querySelector(".cm-content")!.firstChild as Text;
    await select(doc, text, 7, text, 13);
    await startComment();
    await typeInto(q("doc-comment-input") as HTMLTextAreaElement, "Is --fast safe?");
    await act(async () => q("doc-comment-send")!.click());
    await settle();
    expect((writes[0]!.body as { anchor: unknown }).anchor).toEqual({ quote: "--fast", prefix: "Run this:deploy ", suffix: "" });
  });

  test("a reply being written survives its comment moving to Passage removed", async () => {
    serve([comment("c", "one source of truth")]);
    const { replace } = await mount("<p>Option 1 keeps one source of truth.</p>", "owner");
    await act(async () => q("doc-comment-reply-open")!.click());
    await typeInto(q("doc-comment-reply-input") as HTMLInputElement, "Fixed in the new wording.");
    await replace("<p>Option 1 keeps a single source.</p>");
    expect(await until(() => q("doc-comments-orphans") !== null)).toBe(true);
    expect((q("doc-comment-reply-input") as HTMLInputElement).value).toBe("Fixed in the new wording.");
  });

  test("on a phone-width screen the owner's empty margin stays hidden", async () => {
    window.happyDOM.setViewport({ width: 400, height: 800 });
    try {
      serve([]);
      await mount("<p>Nothing said yet.</p>", "owner");
      expect(q("doc-comments")).toBeNull();
    } finally {
      // Still mounted: the media query change re-renders it.
      await act(async () => window.happyDOM.setViewport({ width: 1440, height: 900 }));
    }
  });

  test("the owner's own comment is marked as the owner's (You, to the owner) and carries no state tag until it is resolved", async () => {
    const own = () => [
      comment("mine", "the freeze", { author: "alice", byOwner: true, replies: [{ id: "x", authorKind: "owner", author: "alice", body: "Done.", createdAt: new Date().toISOString() }] }),
      comment("done", "the freeze", { author: "alice", byOwner: true, resolved: true }),
    ];
    for (const [role, name, replyName] of [
      ["reader", "alice · owner ·", "alice · owner"],
      ["owner", "You ·", "You"],
    ] as const) {
      if (role === "owner") {
        await act(() => root.unmount());
        host.remove();
      }
      serve(own());
      await mount("<p>Decide before the freeze.</p>", role);
      const [card] = qa("doc-comment");
      expect(card!.textContent).toContain(name);
      expect(card!.querySelector("[data-testid=doc-comment-reply] div")!.textContent).toBe(replyName);
      expect(card!.querySelector("[data-testid=doc-comment-state]")).toBeNull();
      await act(async () => q("doc-comments-resolved-toggle")!.click());
      expect(qa("doc-comment-state").map((t) => t.textContent)).toEqual(["Resolved"]);
    }
  });

  test("the owner sees every comment and can reply to or resolve any open one, and reopen a resolved one", async () => {
    const at = new Date().toISOString();
    const writes = serve([
      comment("p", "the freeze", { state: "pending" }),
      comment("a", "four hours", { replies: [{ id: "b", authorKind: "agent", fromDoc: true, body: "About 4 hours.", createdAt: at }] }),
      comment("w", "the window", { state: "waiting" }),
      comment("mine", "the window", { author: "alice", byOwner: true }),
      comment("r", "four hours", { resolved: true }),
    ]);
    await mount("<p>Decide before the freeze. It takes four hours in the window.</p>", "owner");
    expect(qa("doc-comment")).toHaveLength(4);
    // Only the waiting comment has its reply box open; the others offer Reply, and every open one Resolve.
    expect(qa("doc-comment-reply-input")).toHaveLength(1);
    expect(qa("doc-comment-reply-open")).toHaveLength(3);
    expect(qa("doc-comment-resolve")).toHaveLength(4);
    // No Reply button until there is something to send.
    expect(q("doc-comment-reply-send")).toBeNull();
    await act(async () => qa("doc-comment-reply-open")[0]!.click());
    expect(qa("doc-comment-reply-input")).toHaveLength(2);
    expect(qa("doc-comment-reply-open")).toHaveLength(2);
    await act(async () => q("doc-comments-resolved-toggle")!.click());
    expect(qa("doc-comment")).toHaveLength(5);
    expect(qa("doc-comment-resolve")).toHaveLength(4);
    await act(async () => q("doc-comment-reopen")!.click());
    await settle();
    expect(writes.map((w) => [w.path, w.body])).toEqual([["/api/docs/d1/comments/r/resolve", { resolved: false }]]);
    expect(q("doc-comments-resolved-toggle")).toBeNull();
    expect(qa("doc-comment-resolve")).toHaveLength(5);
  });

  test("the owner replies to a comment and then resolves it; a reader gets neither control", async () => {
    const waiting = comment("w", "the freeze", { state: "waiting", replies: [{ id: "a", authorKind: "agent", body: "The doc doesn't say who set it.", createdAt: new Date().toISOString() }] });
    const answered = comment("a", "four hours", { replies: [{ id: "b", authorKind: "agent", fromDoc: true, body: "About 4 hours.", createdAt: new Date().toISOString() }] });
    serve([waiting, answered]);
    await mount("<p>Decide before the freeze. It takes four hours.</p>", "reader");
    expect(q("doc-comment-reply-input")).toBeNull();
    expect(q("doc-comment-resolve")).toBeNull();
    expect(q("doc-comment-state")!.textContent).toBe("Waiting for the owner");
    expect(qa("doc-comment-reply").map((r) => r.textContent)).toEqual(["Doc agentThe doc doesn't say who set it.", "Doc agent · from the docAbout 4 hours."]);
    await act(() => root.unmount());
    host.remove();

    const writes = serve([{ ...waiting }, { ...answered }]);
    await mount("<p>Decide before the freeze. It takes four hours.</p>", "owner");
    expect(q("doc-comment-state")!.textContent).toBe("Waiting for you");
    const input = q("doc-comment-reply-input") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
      setter.call(input, "Release management sets it.");
      input.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    });
    await act(async () => q("doc-comment-reply-send")!.click());
    await settle();
    // Answered now, so its reply box closes; Resolve stayed where it was throughout.
    expect(q("doc-comment-reply-input")).toBeNull();
    await act(async () => q("doc-comment-resolve")!.click());
    await settle();
    expect(writes.map((w) => [w.path, w.body])).toEqual([
      ["/api/docs/d1/comments/w/reply", { body: "Release management sets it." }],
      ["/api/docs/d1/comments/w/resolve", { resolved: true }],
    ]);
  });
});
