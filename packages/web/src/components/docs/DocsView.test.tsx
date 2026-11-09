import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test as bunTest } from "bun:test";

// Each test waits out the autosave pause and then up to seconds more for a save: on a loaded machine, past bun's 5s default.
const test = (name: string, fn: () => unknown) => bunTest(name, fn as () => Promise<void>, 20_000);
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { GlobalWindow, PropertySymbol } from "happy-dom";
import type { Node as HappyNode } from "happy-dom";
import type { DocAsset, DocDetail, DocFolder, DocSearchHit, ShareState } from "@standup/shared";

// react-dom decides whether a DOM exists when it is first imported, so the
// window is installed before the view modules load. The editor (ProseMirror,
// CodeMirror, Crepe's Vue widgets) needs a fuller DOM than most views.
const window = new GlobalWindow({ url: "http://localhost/docs" });

/**
 * happy-dom's MutationObserver holds the callback it registers on each
 * observed node only through a WeakRef, so a garbage collection after
 * observe() drops it and the observer hears nothing more: ProseMirror then
 * never reads typing in. This observer keeps those callbacks alive for as
 * long as it is itself.
 */
const HappyMutationObserver = window.MutationObserver;
class HeldMutationObserver extends HappyMutationObserver {
  readonly #held = new Set<unknown>();
  override observe(target: HappyNode, options: Parameters<InstanceType<typeof HappyMutationObserver>["observe"]>[1]) {
    const listeners = target[PropertySymbol.mutationListeners];
    const before = new Set(listeners);
    super.observe(target, options);
    for (const listener of listeners) if (!before.has(listener)) this.#held.add(listener.callback.deref());
  }
  override disconnect() {
    super.disconnect();
    this.#held.clear();
  }
}
(window as { MutationObserver: typeof HappyMutationObserver }).MutationObserver = HeldMutationObserver;
const GLOBALS = [
  "window",
  "document",
  "navigator",
  "location",
  "history",
  "Node",
  "HTMLElement",
  "HTMLImageElement",
  "HTMLInputElement",
  "SVGElement",
  "MathMLElement",
  "ShadowRoot",
  "Element",
  "Text",
  "DocumentFragment",
  "Event",
  "KeyboardEvent",
  "MouseEvent",
  "MutationObserver",
  "ResizeObserver",
  "IntersectionObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "DOMParser",
  "Range",
  "Selection",
  "getSelection",
] as const;
const saved = new Map<string, unknown>();
const savedFetch = globalThis.fetch;

let act: (fn: () => void | Promise<void>) => Promise<void>;
let createRoot: (el: Element) => Root;
let router: typeof import("react-router-dom");
let DocsView: typeof import("./DocsView").DocsView;
let publishDocsChanged: typeof import("../../lib/docsUpdates").publishDocsChanged;
let clearUnsavedDocs: typeof import("../../lib/unsavedDocs").clearUnsavedDocs;
let AUTOSAVE_DELAY_MS: number;
let MISSING_IMAGE_SRC: string;
let missingImageSrc: typeof import("./DocPane").missingImageSrc;
let themeStore: typeof import("../../hooks/useTheme");

beforeAll(async () => {
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    const value = (window as unknown as Record<string, unknown>)[name];
    (globalThis as Record<string, unknown>)[name] = typeof value === "function" && /^[a-z]/.test(name) ? value.bind(window) : value;
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = (await import("react")) as unknown as { act: typeof act });
  ({ createRoot } = await import("react-dom/client"));
  router = await import("react-router-dom");
  ({ DocsView } = await import("./DocsView"));
  const pane = await import("./DocPane");
  AUTOSAVE_DELAY_MS = pane.AUTOSAVE_DELAY_MS;
  ({ missingImageSrc } = pane);
  MISSING_IMAGE_SRC = missingImageSrc("dark");
  themeStore = await import("../../hooks/useTheme");
  ({ publishDocsChanged } = await import("../../lib/docsUpdates"));
  ({ clearUnsavedDocs } = await import("../../lib/unsavedDocs"));
  // The editor is a lazy chunk; loaded here, no test's own time limit pays for its cold import on a busy machine.
  await import("./DocEditor");
}, 60_000);

afterAll(async () => {
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  globalThis.fetch = savedFetch;
  await window.happyDOM.close();
});

const AT = "2026-10-01T00:00:00.000Z";

/** An in-memory collector for the docs routes; every request is recorded. */
interface Server {
  folders: DocFolder[];
  docs: Map<string, DocDetail>;
  assets: DocAsset[];
  requests: { method: string; path: string; body?: unknown }[];
  /** Each doc's share state as the share route reports it. */
  shares: Map<string, ShareState>;
  /** While set, every PATCH waits for it before it is handled. */
  patchGate: Promise<void> | null;
  /** HTTP statuses the next body saves fail with, one per save. */
  failSaves: number[];
  /** When each body save arrived (ms). */
  saveTimes: number[];
  /** Hits the search adds after its keyword hits, as the semantic index finds them. */
  meaningHits: DocSearchHit[];
}

let server: Server;

function folder(id: string, parentId: string | null, name: string): DocFolder {
  return { id, parentId, name, createdAt: AT, updatedAt: AT };
}

function seed(): Server {
  const body = "---\ntitle: Limits\n---\n# Limits\n\nThe first paragraph.\n";
  return {
    folders: [folder("f1", null, "notes"), folder("f2", "f1", "authz")],
    docs: new Map([
      [
        "d1",
        {
          id: "d1",
          folderId: null,
          name: "limits.md",
          revision: 1,
          bytes: body.length,
          createdAt: AT,
          updatedAt: AT,
          body,
          share: { enabled: false, path: null },
        },
      ],
    ]),
    assets: [{ id: "a1", folderId: "f2", name: "diagram.png", mime: "image/png", bytes: 1, createdAt: AT, url: "/api/docs/assets/a1" }],
    requests: [],
    shares: new Map(),
    patchGate: null,
    failSaves: [],
    saveTimes: [],
    meaningHits: [],
  };
}

function installServer() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    server.requests.push({ method, path: url.pathname, ...(body === undefined ? {} : { body }) });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    const summary = ({ body: _body, share: _share, ...rest }: DocDetail) => rest;
    if (url.pathname === "/api/docs/tree" && method === "GET") {
      return json({ folders: server.folders, docs: [...server.docs.values()].map(summary), assets: server.assets });
    }
    if (url.pathname === "/api/docs/search" && method === "GET") {
      // The collector's ranking is its own test's; this lists path matches, then body matches.
      const term = (url.searchParams.get("q") ?? "").toLowerCase();
      const pathOf = (d: DocDetail) => {
        const names = [d.name];
        for (let f = server.folders.find((x) => x.id === d.folderId); f; f = server.folders.find((x) => x.id === f!.parentId)) names.unshift(f.name);
        return names.join("/");
      };
      const docs = [...server.docs.values()];
      const byPath = docs.filter((d) => pathOf(d).toLowerCase().includes(term));
      const byBody = docs.filter((d) => !byPath.includes(d) && d.body.toLowerCase().includes(term));
      return json({
        hits: [
          ...byPath.map((d) => ({ id: d.id, path: pathOf(d), match: "path" })),
          ...byBody.map((d) => ({ id: d.id, path: pathOf(d), match: "body", snippet: d.body.split("\n").find((l) => l.toLowerCase().includes(term)) })),
          ...server.meaningHits,
        ],
      });
    }
    if (url.pathname === "/api/docs/shared-with-me" && method === "GET") return json({ shared: [] });
    if (/^\/api\/docs\/[^/]+\/comments$/.test(url.pathname) && method === "GET") return json({ comments: [] });
    const shareableMatch = /^\/api\/docs\/(folders\/)?([^/]+)\/shareable$/.exec(url.pathname);
    if (shareableMatch && method === "PUT") {
      const target = shareableMatch[1] ? server.folders.find((f) => f.id === shareableMatch[2]) : server.docs.get(shareableMatch[2]!);
      if (!target) return json({ error: "Not found" }, 404);
      if (body.shareable) Object.assign(target, { shareable: true });
      else delete (target as { shareable?: true }).shareable;
      return json({ shareable: body.shareable });
    }
    const docMatch = /^\/api\/docs\/([^/]+)$/.exec(url.pathname);
    if (docMatch && !["tree", "folders", "assets", "import", "write-image"].includes(docMatch[1]!)) {
      if (method === "PATCH" && server.patchGate) await server.patchGate;
      const doc = server.docs.get(decodeURIComponent(docMatch[1]!));
      if (!doc) return json({ error: "Not found" }, 404);
      if (method === "GET") return json({ doc });
      if (method === "DELETE") {
        server.docs.delete(doc.id);
        return json({ ok: true });
      }
      if (method === "PATCH") {
        if (typeof body.body === "string") {
          server.saveTimes.push(Date.now());
          const failure = server.failSaves.shift();
          if (failure === 413) return json({ error: "Doc body is larger than 2 MiB" }, 413);
          if (failure !== undefined) return json({ error: "Something broke" }, failure);
        }
        if (typeof body.baseRevision === "number" && body.baseRevision !== doc.revision) return json({ error: "Revision conflict", doc }, 409);
        const next = { ...doc, ...body, revision: doc.revision + 1 };
        delete (next as Record<string, unknown>).baseRevision;
        server.docs.set(doc.id, next);
        return json({ doc: next });
      }
    }
    const folderMatch = /^\/api\/docs\/folders\/([^/]+)$/.exec(url.pathname);
    if (folderMatch && method === "PATCH") {
      const f = server.folders.find((x) => x.id === folderMatch[1]);
      if (!f) return json({ error: "Not found" }, 404);
      Object.assign(f, body);
      return json({ folder: f });
    }
    const assetMatch = /^\/api\/docs\/assets\/([^/]+)$/.exec(url.pathname);
    if (assetMatch && method === "PATCH") {
      const a = server.assets.find((x) => x.id === assetMatch[1]);
      if (!a) return json({ error: "Not found" }, 404);
      Object.assign(a, body);
      return json({ asset: a });
    }
    if (url.pathname === "/api/docs/write-image" && method === "POST") {
      const names = String(body.path).split("/");
      let folderId: string | null = null;
      for (const name of names.slice(0, -1)) folderId = server.folders.find((f) => f.parentId === folderId && f.name === name)?.id ?? null;
      if (body.folderId !== folderId) return json({ error: "no longer the folder" }, 409);
      // The collector's own naming is its test's; a taken name here gets a ` (2)`.
      const wanted = names[names.length - 1]!;
      const taken = server.assets.some((a) => a.folderId === folderId && a.name === wanted);
      const name = taken ? wanted.replace(/(\.[^.]+)$/, " (2)$1") : wanted;
      const id = `up${server.assets.length + 1}`;
      const asset: DocAsset = { id, folderId, name, mime: "image/png", bytes: 1, createdAt: AT, url: `/api/docs/assets/${id}` };
      server.assets.push(asset);
      return json({ asset: { id, path: [...names.slice(0, -1), name].join("/"), mime: asset.mime, bytes: asset.bytes, url: asset.url } });
    }
    if (url.pathname === "/api/docs/folders" && method === "POST") {
      const created = folder(`f${server.folders.length + 1}`, body.parentId, body.name);
      server.folders.push(created);
      return json({ folder: created });
    }
    if (folderMatch && method === "DELETE") {
      server.folders = server.folders.filter((x) => x.id !== folderMatch[1] && x.parentId !== folderMatch[1]);
      return json({ ok: true });
    }
    if (url.pathname === "/api/docs/import" && method === "POST") {
      server.folders.push(folder("f9", body.folderId, "launch-notes"));
      return json({ rootFolderId: "f9", folders: 1, docs: 3, assets: 1, skipped: [{ path: "launch-notes/huge.md", reason: "larger than 2 MiB" }] });
    }
    if (url.pathname === "/api/shares/folder" && method === "GET") {
      const folderIds = new Set(server.folders.map((f) => f.id));
      return json({ ids: [...server.shares].filter(([id, s]) => s.enabled && folderIds.has(id)).map(([id]) => id) });
    }
    const shareMatch = /^\/api\/shares\/(doc|folder)\/([^/]+)$/.exec(url.pathname);
    if (shareMatch && method === "GET") {
      const id = decodeURIComponent(shareMatch[2]!);
      return json({ share: server.shares.get(id) ?? { enabled: false, path: null } });
    }
    if (shareMatch && method === "PUT") {
      return json({ share: body.enabled ? { enabled: true, path: `/share/${shareMatch[1]}/${"S".repeat(43)}` } : { enabled: false, path: null } });
    }
    return json({ error: "Unexpected request" }, 500);
  }) as typeof fetch;
}

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  server = seed();
  installServer();
  clearUnsavedDocs();
  window.localStorage.clear();
});

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  globalThis.fetch = savedFetch;
});

async function settle(rounds = 5) {
  for (let i = 0; i < rounds; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
}

async function until(check: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await settle(1);
  return check();
}

const wait = (ms: number) => act(async () => new Promise((r) => setTimeout(r, ms)));

/** Moves the mounted console to another path, as its tab links do. */
let go: (path: string) => void = () => {};

function Navigator() {
  const navigate = router.useNavigate();
  go = (path) => navigate(path);
  return null;
}

async function mount(path: string) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const { MemoryRouter, Routes, Route } = router;
  await act(() =>
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(Navigator),
        createElement(
          Routes,
          null,
          createElement(Route, { path: "/docs/:id?", element: createElement(DocsView) }),
          createElement(Route, { path: "/board", element: createElement("div", { "data-testid": "another-tab" }) })
        )
      )
    )
  );
  await settle();
}

const q = (selector: string) => host.querySelector(selector) as HTMLElement | null;
const writes = () => server.requests.filter((r) => r.method !== "GET");

/** Fires a drag of `from` dropped on `onto`, through the events React listens for. */
async function dragAndDrop(from: Element, onto: Element) {
  await act(async () => {
    from.dispatchEvent(new window.Event("dragstart", { bubbles: true, cancelable: true }) as unknown as Event);
  });
  let accepted = false;
  await act(async () => {
    const over = new window.Event("dragover", { bubbles: true, cancelable: true }) as unknown as Event;
    onto.dispatchEvent(over);
    accepted = over.defaultPrevented;
  });
  await act(async () => {
    onto.dispatchEvent(new window.Event("drop", { bubbles: true, cancelable: true }) as unknown as Event);
    from.dispatchEvent(new window.Event("dragend", { bubbles: true }) as unknown as Event);
  });
  await settle();
  return accepted;
}

describe("Docs tree drag and drop", () => {
  test("dropping a doc on a folder moves it there", async () => {
    await mount("/docs");
    const docRow = q('[data-testid=docs-doc-row][data-doc-id="d1"]')!;
    const notes = q('[data-testid=docs-folder][data-folder-id="f1"]')!;
    expect(await dragAndDrop(docRow, notes)).toBe(true);
    expect(writes()).toEqual([{ method: "PATCH", path: "/api/docs/d1", body: { folderId: "f1" } }]);
  });

  test("dropping a folder on the root moves it to the top level", async () => {
    await mount("/docs");
    await act(async () => q('[data-testid=docs-folder][data-folder-id="f1"] [data-testid=docs-folder-row]')!.click());
    const authz = q('[data-testid=docs-folder][data-folder-id="f2"] [data-testid=docs-folder-row]')!;
    expect(await dragAndDrop(authz, q("[data-testid=docs-root]")!)).toBe(true);
    expect(writes()).toEqual([{ method: "PATCH", path: "/api/docs/folders/f2", body: { parentId: null } }]);
  });

  test("an image dropped on the root moves to the top level", async () => {
    await mount("/docs");
    await act(async () => q('[data-testid=docs-folder][data-folder-id="f1"] [data-testid=docs-folder-row]')!.click());
    await act(async () => q('[data-testid=docs-folder][data-folder-id="f2"] [data-testid=docs-folder-row]')!.click());
    const image = q('[data-testid=docs-asset-row][data-asset-id="a1"]')!;
    expect(await dragAndDrop(image, q("[data-testid=docs-root]")!)).toBe(true);
    expect(writes()).toEqual([{ method: "PATCH", path: "/api/docs/assets/a1", body: { folderId: null } }]);
  });

  /** A DataTransfer as a browser hands one to drag events: what dragstart sets, the later events read. */
  function dataTransfer() {
    const data = new Map<string, string>();
    return {
      types: [] as string[],
      files: [],
      effectAllowed: "uninitialized",
      dropEffect: "none",
      setData(type: string, value: string) {
        data.set(type, value);
        this.types = [...data.keys()];
      },
      getData: (type: string) => data.get(type) ?? "",
    };
  }

  function dragEvent(type: string, transfer: ReturnType<typeof dataTransfer>) {
    const event = new window.Event(type, { bubbles: true, cancelable: true }) as unknown as Event;
    Object.defineProperty(event, "dataTransfer", { value: transfer });
    return event;
  }

  test("a real browser's drag sequence onto a child of a folder row moves the doc there", async () => {
    // The doc sits two folders down, open; the target is a top-level folder.
    server.folders.push(folder("f3", null, "research"));
    server.docs.set("d1", { ...server.docs.get("d1")!, folderId: "f2" });
    await mount("/docs");
    await act(async () => q('[data-testid=docs-folder][data-folder-id="f1"] [data-testid=docs-folder-row]')!.click());
    await act(async () => q('[data-testid=docs-folder][data-folder-id="f2"] [data-testid=docs-folder-row]')!.click());
    const source = q('[data-testid=docs-doc-row][data-doc-id="d1"]')!;
    expect(source.getAttribute("draggable")).toBe("true");
    const label = q('[data-testid=docs-folder][data-folder-id="f3"] [data-testid=docs-folder-row]')!.querySelector("span")!;
    const transfer = dataTransfer();
    await act(async () => {
      source.dispatchEvent(dragEvent("dragstart", transfer));
    });
    expect(transfer.types).toContain("application/x-standup-doc-item");
    expect(transfer.effectAllowed).toBe("move");
    // The browser takes the drop effect at a new element from dragenter; a drop can follow it directly.
    const enter = dragEvent("dragenter", transfer);
    await act(async () => {
      label.dispatchEvent(enter);
    });
    expect(enter.defaultPrevented).toBe(true);
    const over = dragEvent("dragover", transfer);
    await act(async () => {
      label.dispatchEvent(over);
    });
    expect(over.defaultPrevented).toBe(true);
    expect(transfer.dropEffect).toBe("move");
    await act(async () => {
      label.dispatchEvent(dragEvent("drop", transfer));
      source.dispatchEvent(dragEvent("dragend", transfer));
    });
    await settle();
    expect(writes()).toEqual([{ method: "PATCH", path: "/api/docs/d1", body: { folderId: "f3" } }]);
  });

  test("Move to… moves an item through a folder picker, offering only the folders it can go to", async () => {
    await mount("/docs");
    const docRow = q('[data-testid=docs-doc-row][data-doc-id="d1"]')!;
    await act(async () => (docRow.querySelector("[data-testid=docs-move]") as HTMLElement).click());
    const targets = () => [...host.querySelectorAll("[data-testid=docs-move-target]")] as HTMLButtonElement[];
    expect(targets().map((t) => [t.textContent, t.disabled])).toEqual([
      ["All docs (top level)", true],
      ["notes", false],
      ["notes/authz", false],
    ]);
    await act(async () => targets().find((t) => t.dataset.folderId === "f2")!.click());
    await settle();
    expect(writes()).toEqual([{ method: "PATCH", path: "/api/docs/d1", body: { folderId: "f2" } }]);
    expect(q("[data-testid=docs-move-picker]")).toBeNull();

    // A folder can't go into itself or anything inside it.
    const notesRow = q('[data-testid=docs-folder][data-folder-id="f1"] [data-testid=docs-folder-row]')!;
    await act(async () => (notesRow.querySelector("[data-testid=docs-move]") as HTMLElement).click());
    expect(targets().map((t) => [t.dataset.folderId, t.disabled])).toEqual([
      ["", true],
      ["f1", true],
      ["f2", true],
    ]);
    await act(async () => q("[data-testid=docs-move-cancel]")!.click());
    expect(q("[data-testid=docs-move-picker]")).toBeNull();
  });

  test("Escape closes the Move to… picker and gives the focus back to the row's Move button", async () => {
    await mount("/docs");
    const moveButton = q('[data-testid=docs-doc-row][data-doc-id="d1"] [data-testid=docs-move]')!;
    await act(async () => moveButton.click());
    expect(q("[data-testid=docs-move-picker]")).not.toBeNull();
    await press(q("[data-testid=docs-move-cancel]")!, "Escape");
    expect(q("[data-testid=docs-move-picker]")).toBeNull();
    expect(document.activeElement).toBe(moveButton);
    expect(writes()).toEqual([]);
  });

  test("a drag that ended outside the tree leaves nothing behind for a later drag of desktop files", async () => {
    await mount("/docs");
    const transfer = dataTransfer();
    await act(async () => {
      q('[data-testid=docs-doc-row][data-doc-id="d1"]')!.dispatchEvent(dragEvent("dragstart", transfer));
    });
    // Dropped somewhere outside the tree; the row never gets a dragend.
    await act(async () => {
      document.body.dispatchEvent(dragEvent("drop", transfer));
    });
    await settle();
    const files = { types: ["Files"], files: [], dropEffect: "copy" };
    const notes = q('[data-testid=docs-folder][data-folder-id="f1"]')!;
    const over = new window.Event("dragover", { bubbles: true, cancelable: true }) as unknown as Event;
    Object.defineProperty(over, "dataTransfer", { value: files });
    const drop = new window.Event("drop", { bubbles: true, cancelable: true }) as unknown as Event;
    Object.defineProperty(drop, "dataTransfer", { value: files });
    await act(async () => {
      notes.dispatchEvent(over);
      notes.dispatchEvent(drop);
    });
    await settle();
    expect(files.dropEffect).toBe("none");
    expect(writes()).toEqual([]);
  });

  test("a folder can't be dropped into itself or anything inside it", async () => {
    await mount("/docs");
    await act(async () => q('[data-testid=docs-folder][data-folder-id="f1"] [data-testid=docs-folder-row]')!.click());
    const notesRow = q('[data-testid=docs-folder][data-folder-id="f1"] [data-testid=docs-folder-row]')!;
    const authz = q('[data-testid=docs-folder][data-folder-id="f2"]')!;
    // Onto its own child: refused there, and not passed on to an outer folder or the root.
    expect(await dragAndDrop(notesRow, authz)).toBe(false);
    // Onto itself.
    expect(await dragAndDrop(notesRow, q('[data-testid=docs-folder][data-folder-id="f1"]')!)).toBe(false);
    expect(writes()).toEqual([]);
  });
});

async function typeValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
  });
}

async function press(el: Element, key: string) {
  await act(async () => {
    el.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true }) as unknown as Event);
  });
  await settle();
}

describe("Docs tree editing", () => {
  test("a new folder is named inline: Enter creates it in the selected folder, Escape cancels", async () => {
    await mount("/docs");
    await act(async () => q('[data-testid=docs-folder][data-folder-id="f1"] [data-testid=docs-folder-row]')!.click());
    await act(async () => q("[data-testid=docs-new-folder]")!.click());
    let input = q("[data-testid=docs-name-input]") as HTMLInputElement;
    await typeValue(input, "drafts");
    await press(input, "Escape");
    expect(q("[data-testid=docs-name-input]")).toBeNull();
    expect(writes()).toEqual([]);

    await act(async () => q("[data-testid=docs-new-folder]")!.click());
    input = q("[data-testid=docs-name-input]") as HTMLInputElement;
    await typeValue(input, "drafts");
    await press(input, "Enter");
    expect(writes()).toEqual([{ method: "POST", path: "/api/docs/folders", body: { parentId: "f1", name: "drafts" } }]);
    expect(await until(() => host.textContent?.includes("drafts") === true)).toBe(true);
    expect(q("[data-testid=docs-name-input]")).toBeNull();
  });

  test("deleting a folder asks first, saying everything inside goes too", async () => {
    await mount("/docs");
    const row = q('[data-testid=docs-folder][data-folder-id="f1"] [data-testid=docs-folder-row]')!;
    await act(async () => (row.querySelector("[data-testid=docs-delete]") as HTMLElement).click());
    expect(q("[data-testid=docs-delete-confirm]")?.textContent).toContain("everything inside it");
    expect(writes()).toEqual([]);
    await act(async () => q("[data-testid=docs-delete-confirm-button]")!.click());
    await settle();
    expect(writes()).toEqual([{ method: "DELETE", path: "/api/docs/folders/f1" }]);
    expect(q("[data-testid=docs-delete-confirm]")).toBeNull();
    expect(q('[data-testid=docs-folder][data-folder-id="f1"]')).toBeNull();
  });

  test("a folder's Share action opens its Shareable switch, which makes the folder shareable", async () => {
    await mount("/docs");
    const row = q('[data-testid=docs-folder][data-folder-id="f1"] [data-testid=docs-folder-row]')!;
    // Only folders carry the Share action; a doc's switch is in its pane.
    expect(q("[data-testid=docs-doc-row] [data-testid=docs-share-folder]")).toBeNull();
    await act(async () => (row.querySelector("[data-testid=docs-share-folder]") as HTMLElement).click());
    const shareable = "[data-testid=docs-folder-share] [data-testid=shareable] [data-testid=share-switch]";
    expect(await until(() => q(shareable) !== null)).toBe(true);
    const panel = q("[data-testid=docs-folder-share]")!;
    expect(panel.textContent).toContain("notes");
    expect(q(shareable)!.getAttribute("aria-label")).toContain("folder");
    expect(q(shareable)!.getAttribute("aria-checked")).toBe("false");
    // No link is made: the folder has none, so no link switch shows.
    expect(q("[data-testid=folder-share-link]")).toBeNull();
    await act(async () => q(shareable)!.click());
    await settle();
    expect(writes()).toEqual([{ method: "PUT", path: "/api/docs/folders/f1/shareable", body: { shareable: true } }]);
    expect(q(shareable)!.getAttribute("aria-checked")).toBe("true");
    expect(q("[data-testid=share-link]")).toBeNull();
    expect(await until(() => q('[data-testid=docs-folder][data-folder-id="f1"] [data-testid=docs-folder-shared]') !== null)).toBe(true);
    await act(async () => q("[data-testid=docs-folder-share-close]")!.click());
    expect(q("[data-testid=docs-folder-share]")).toBeNull();
  });

  test("a folder's existing share link shows under its Shareable switch until it is turned off, here or elsewhere", async () => {
    server.shares.set("f1", { enabled: true, path: `/share/folder/${"S".repeat(43)}` });
    await mount("/docs");
    const row = q('[data-testid=docs-folder][data-folder-id="f1"] [data-testid=docs-folder-row]')!;
    await act(async () => (row.querySelector("[data-testid=docs-share-folder]") as HTMLElement).click());
    expect(await until(() => q("[data-testid=folder-share-link] [data-testid=share-link]") !== null)).toBe(true);
    server.shares.set("f1", { enabled: false, path: null });
    await act(async () => publishDocsChanged({ tree: false, folderId: "f1", share: true }));
    expect(await until(() => q("[data-testid=folder-share-link]") === null)).toBe(true);
  });

  test("a shared folder is marked in the tree, and a doc inside it says the folder's link reaches it", async () => {
    server.shares.set("f1", { enabled: true, path: `/share/folder/${"S".repeat(43)}` });
    const d1 = server.docs.get("d1")!;
    server.docs.set("d1", { ...d1, share: { enabled: false, path: null, viaFolder: "notes" } });
    server.shares.set("d1", { enabled: false, path: null, viaFolder: "notes" });
    await mount("/docs/d1");
    // The editor is let finish loading, so it isn't torn down mid-setup when the test ends.
    expect(await until(() => prose() !== null && status() === "Saved", 5000)).toBe(true);
    expect(await until(() => q('[data-testid=docs-folder][data-folder-id="f1"] [data-testid=docs-folder-shared]') !== null)).toBe(true);
    expect(q('[data-testid=docs-folder][data-folder-id="f2"] [data-testid=docs-folder-row] [data-testid=docs-folder-shared]')).toBeNull();
    expect(await until(() => q("[data-testid=doc-share-link] [data-testid=share-via-folder]") !== null, 5000)).toBe(true);
    expect(q("[data-testid=share-via-folder]")!.textContent).toContain("“notes”");
    expect(q("[data-testid=doc-share-link] [data-testid=share-switch]")!.getAttribute("aria-checked")).toBe("false");

    // Unshared elsewhere: the marker and the note go.
    server.shares.set("f1", { enabled: false, path: null });
    server.shares.set("d1", { enabled: false, path: null });
    await act(async () => publishDocsChanged({ tree: false, folderId: "f1", share: true }));
    expect(await until(() => q("[data-testid=docs-folder-shared]") === null && q("[data-testid=share-via-folder]") === null)).toBe(true);
  });

  test("Import brings a host path into the selected folder and shows what it skipped", async () => {
    await mount("/docs");
    await act(async () => q('[data-testid=docs-folder][data-folder-id="f1"] [data-testid=docs-folder-row]')!.click());
    await act(async () => q("[data-testid=docs-import-open]")!.click());
    expect(q("[data-testid=docs-import]")?.textContent).toContain("notes");
    await typeValue(q("[data-testid=docs-import-path]") as HTMLInputElement, "~/billing-launch-notes");
    await act(async () => q("[data-testid=docs-import-run]")!.click());
    await settle();
    expect(writes()).toEqual([{ method: "POST", path: "/api/docs/import", body: { path: "~/billing-launch-notes", folderId: "f1" } }]);
    const result = q("[data-testid=docs-import-result]")!.textContent!;
    expect(result).toContain("Imported 3 docs, 1 image and 1 folder");
    expect(result).toContain("Skipped 1");
    expect(result).toContain("launch-notes/huge.md");
    // The tree re-read and opened the imported folder.
    expect(q('[data-testid=docs-folder][data-folder-id="f9"]')).not.toBeNull();
  });
});

/** The ProseMirror surface of the open doc, once the editor is up. */
function prose(): HTMLElement | null {
  return host.querySelector(".ProseMirror");
}

function status(): string {
  return q("[data-testid=doc-save-status]")?.textContent ?? "";
}

/**
 * Types `suffix` onto the end of the first paragraph the way the browser
 * reports typing to ProseMirror: a key press, then the text node changing
 * under its DOM observer. Under a loaded test run happy-dom sometimes doesn't
 * get that change read in, so the typing is repeated once if the pane hasn't
 * seen an edit; a repeat sets the paragraph's text afresh rather than adding
 * to it, so the suffix is typed once however many tries it takes.
 */
async function typeInto(suffix: string) {
  const paragraph = [...prose()!.querySelectorAll("p")].find((p) => p.textContent?.includes("first paragraph"))!;
  const original = (paragraph.firstChild as Text).data;
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = [...prose()!.querySelectorAll("p")].find((p) => p.textContent?.includes("first paragraph"))!.firstChild as Text;
    await act(async () => {
      prose()!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "!", bubbles: true }) as unknown as Event);
      if (attempt > 0) text.data = original;
      text.data = `${original}${suffix}`;
    });
    if (await until(() => status() !== "Saved" || writes().length > 0, 1500)) return;
  }
}

/** How many times `needle` occurs in `haystack`. */
const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

/**
 * Pastes `text` at the editor's selection, the way the browser hands a paste
 * to ProseMirror; the document changes at once, ahead of the editor's
 * debounced report.
 */
async function pasteInto(text: string) {
  await act(async () => {
    const event = new window.Event("paste", { bubbles: true, cancelable: true }) as unknown as Event;
    Object.defineProperty(event, "clipboardData", {
      value: { getData: (type: string) => (type === "text/plain" ? text : ""), types: ["text/plain"], files: [], items: [] },
    });
    prose()!.dispatchEvent(event);
  });
}

function docDetail(id: string, folderId: string | null, name: string, body: string): DocDetail {
  return { id, folderId, name, revision: 1, bytes: body.length, createdAt: AT, updatedAt: AT, body, share: { enabled: false, path: null } };
}

const docPatches = (docId: string) => writes().filter((w) => w.method === "PATCH" && w.path === `/api/docs/${docId}`);
const patchBody = (w: { body?: unknown }) => w.body as { body: string; baseRevision: number };

/** Holds every PATCH until the returned function is called. */
function holdPatches(): () => void {
  let release: () => void = () => {};
  server.patchGate = new Promise<void>((resolve) => (release = resolve));
  return () => {
    server.patchGate = null;
    release();
  };
}

describe("the open doc", () => {
  test("opening a doc never saves it", async () => {
    await mount("/docs/d1");
    expect(await until(() => prose() !== null && status() === "Saved", 5000)).toBe(true);
    expect(q("[data-testid=doc-name]")?.textContent).toBe("limits.md");
    expect(prose()!.textContent).toContain("The first paragraph.");
    // The frontmatter isn't part of what the editor shows.
    expect(prose()!.textContent).not.toContain("title: Limits");
    await wait(AUTOSAVE_DELAY_MS + 700);
    expect(writes()).toEqual([]);
    expect(status()).toBe("Saved");
  });

  test("an edit saves after a pause, against the revision it was made on, with the frontmatter put back", async () => {
    await mount("/docs/d1");
    expect(await until(() => prose() !== null && status() === "Saved", 5000)).toBe(true);
    await typeInto(" More.");
    expect(await until(() => writes().length > 0, AUTOSAVE_DELAY_MS + 3000)).toBe(true);
    const [save] = writes();
    expect(save!.path).toBe("/api/docs/d1");
    const body = save!.body as { body: string; baseRevision: number };
    expect(body.baseRevision).toBe(1);
    expect(body.body.startsWith("---\ntitle: Limits\n---\n")).toBe(true);
    expect(body.body).toContain("The first paragraph. More.");
    expect(occurrences(body.body, "More.")).toBe(1);
    expect(await until(() => status() === "Saved")).toBe(true);
    expect(occurrences(server.docs.get("d1")!.body, "More.")).toBe(1);

    // The frame announcing this pane's own save is not news.
    const reads = server.requests.filter((r) => r.method === "GET" && r.path === "/api/docs/d1").length;
    await act(async () => publishDocsChanged({ tree: false, docId: "d1", revision: 2 }));
    await settle();
    expect(server.requests.filter((r) => r.method === "GET" && r.path === "/api/docs/d1").length).toBe(reads);
    expect(q("[data-testid=doc-conflict]")).toBeNull();
  });

  test("a newer revision saved elsewhere reloads in place when nothing here is unsaved", async () => {
    await mount("/docs/d1");
    expect(await until(() => prose() !== null && status() === "Saved", 5000)).toBe(true);
    const editorDom = prose();
    const d1 = server.docs.get("d1")!;
    server.docs.set("d1", { ...d1, revision: 2, body: "---\ntitle: Limits\n---\n# Limits\n\nRewritten by an agent.\n" });
    await act(async () => publishDocsChanged({ tree: false, docId: "d1", revision: 2 }));
    expect(await until(() => prose()?.textContent?.includes("Rewritten by an agent.") === true)).toBe(true);
    // The same editor, updated in place.
    expect(prose()).toBe(editorDom);
    expect(q("[data-testid=doc-conflict]")).toBeNull();
    await wait(AUTOSAVE_DELAY_MS + 500);
    expect(writes()).toEqual([]);
  });

  test("a newer revision while an edit is unsaved asks which to keep; Keep mine overwrites", async () => {
    await mount("/docs/d1");
    expect(await until(() => prose() !== null && status() === "Saved", 5000)).toBe(true);
    // Another tab saves first.
    const d1 = server.docs.get("d1")!;
    server.docs.set("d1", { ...d1, revision: 2, body: "---\ntitle: Theirs\n---\n# Limits\n\nTheirs.\n" });
    await typeInto(" Mine.");
    // The save goes out on revision 1 and loses the race.
    expect(await until(() => q("[data-testid=doc-conflict]") !== null, AUTOSAVE_DELAY_MS + 3000)).toBe(true);
    expect(q("[data-testid=doc-conflict]")!.textContent).toContain("Changed in another tab or by an agent");
    expect(q("[data-testid=doc-conflict]")!.textContent).toContain("including its frontmatter");
    expect(server.docs.get("d1")!.body).toBe("---\ntitle: Theirs\n---\n# Limits\n\nTheirs.\n");
    await act(async () => q("[data-testid=doc-conflict-keep]")!.click());
    expect(await until(() => server.docs.get("d1")!.revision === 3)).toBe(true);
    // Mine throughout: my frontmatter and my body.
    expect(server.docs.get("d1")!.body).toBe("---\ntitle: Limits\n---\n# Limits\n\nThe first paragraph. Mine.\n");
    expect(occurrences(server.docs.get("d1")!.body, "Mine.")).toBe(1);
    expect(q("[data-testid=doc-conflict]")).toBeNull();
  });

  test("an image's relative src shows the asset beside the doc; any other src shows a placeholder and never loads", async () => {
    const body = [
      "# Design",
      "",
      "![Diagram](diagram.png)",
      "",
      "Inline ![logo](../missing.png) too.",
      "",
      "![beacon](https://tracker.example/pixel.png?doc=design)",
      "",
      "Inline ![relative-host](//tracker.example/p.png) and ![rooted](/api/docs/tree) too.",
      "",
    ].join("\n");
    server.docs.set("d2", {
      id: "d2",
      folderId: "f2",
      name: "design.md",
      revision: 1,
      bytes: body.length,
      createdAt: AT,
      updatedAt: AT,
      body,
      share: { enabled: false, path: null },
    });
    await mount("/docs/d2");
    expect(await until(() => (prose()?.querySelectorAll("img").length ?? 0) >= 5, 5000)).toBe(true);
    const srcs = [...prose()!.querySelectorAll("img")].map((img) => img.getAttribute("src"));
    expect(srcs.filter((s) => s === "/api/docs/assets/a1")).toHaveLength(1);
    expect(srcs.filter((s) => s === MISSING_IMAGE_SRC)).toHaveLength(4);
    expect(srcs.some((s) => /tracker|missing\.png|\/api\/docs\/tree/.test(s ?? ""))).toBe(false);
    await wait(AUTOSAVE_DELAY_MS + 300);
    expect(writes()).toEqual([]);
  });

  test("an image stored beside the open doc after it rendered shows once the tree lists it", async () => {
    const body = "# Baseline\n\n![Home](screens/home.png)\n";
    server.docs.set("d2", { ...docDetail("d2", "f2", "baseline.md", body), share: { enabled: false, path: null } });
    await mount("/docs/d2");
    const imgSrc = () => prose()?.querySelector("img")?.getAttribute("src") ?? null;
    expect(await until(() => imgSrc() === MISSING_IMAGE_SRC && status() === "Saved", 5000)).toBe(true);
    server.folders.push(folder("f7", "f2", "screens"));
    server.assets.push({ id: "a7", folderId: "f7", name: "home.png", mime: "image/png", bytes: 1, createdAt: AT, url: "/api/docs/assets/a7" });
    await act(async () => publishDocsChanged({ tree: true }));
    expect(await until(() => imgSrc() === "/api/docs/assets/a7", 5000)).toBe(true);
    // An image the doc doesn't embed leaves the editor as it is.
    const rendered = prose();
    server.assets.push({ id: "a8", folderId: "f7", name: "other.png", mime: "image/png", bytes: 1, createdAt: AT, url: "/api/docs/assets/a8" });
    await act(async () => publishDocsChanged({ tree: true }));
    await wait(500);
    expect(prose()).toBe(rendered);
    await wait(AUTOSAVE_DELAY_MS + 300);
    expect(writes()).toEqual([]);
  });

  test("a missing image's placeholder follows a theme switch, and the switch saves nothing", async () => {
    const body = "# Baseline\n\n![Home](screens/home.png)\n\n![Found](diagram.png)\n";
    server.docs.set("d2", { ...docDetail("d2", "f2", "baseline.md", body), share: { enabled: false, path: null } });
    const srcs = () => [...(prose()?.querySelectorAll("img") ?? [])].map((img) => img.getAttribute("src"));
    try {
      themeStore.setThemePreference("dark");
      await mount("/docs/d2");
      expect(await until(() => srcs()[0] === MISSING_IMAGE_SRC && status() === "Saved", 5000)).toBe(true);
      const light = missingImageSrc("light");
      expect(light).not.toBe(MISSING_IMAGE_SRC);

      await act(async () => themeStore.setThemePreference("light"));
      expect(await until(() => srcs()[0] === light, 3000)).toBe(true);
      // An image that resolved to an asset is left as it is.
      expect(srcs()[1]).toBe("/api/docs/assets/a1");

      await act(async () => themeStore.setThemePreference("dark"));
      expect(await until(() => srcs()[0] === MISSING_IMAGE_SRC, 3000)).toBe(true);
      await wait(AUTOSAVE_DELAY_MS + 300);
      expect(writes()).toEqual([]);
    } finally {
      themeStore.resetThemeStore();
      delete document.documentElement.dataset.theme;
    }
  });

  test("the open doc closes when a frame says it was deleted, or its folder was", async () => {
    await mount("/docs/d1");
    expect(await until(() => prose() !== null && status() === "Saved", 5000)).toBe(true);
    server.docs.delete("d1");
    await act(async () => publishDocsChanged({ tree: true, docId: "d1", deleted: true }));
    expect(await until(() => q("[data-testid=docs-gone]") !== null)).toBe(true);
    expect(q("[data-testid=doc-pane]")).toBeNull();
    await act(() => root.unmount());
    host.remove();

    // A folder delete names no doc: the tree's re-read shows the open doc went with it.
    server = seed();
    installServer();
    server.docs.set("d1", { ...server.docs.get("d1")!, folderId: "f1" });
    await mount("/docs/d1");
    expect(await until(() => prose() !== null && status() === "Saved", 5000)).toBe(true);
    server.folders = server.folders.filter((f) => f.id !== "f1" && f.parentId !== "f1");
    server.docs.delete("d1");
    await act(async () => publishDocsChanged({ tree: true, deleted: true }));
    expect(await until(() => q("[data-testid=docs-gone]") !== null)).toBe(true);
    expect(q('[data-testid=docs-folder][data-folder-id="f1"]')).toBeNull();
  });

  test("the doc's Shareable switch makes the doc shareable, and makes no link", async () => {
    await mount("/docs/d1");
    const shareable = "[data-testid=shareable] [data-testid=share-switch]";
    expect(await until(() => q(shareable) !== null, 5000)).toBe(true);
    expect(q(shareable)!.getAttribute("aria-label")).toContain("doc");
    expect(q("[data-testid=doc-share-link]")).toBeNull();
    await act(async () => q(shareable)!.click());
    await settle();
    expect(writes()).toEqual([{ method: "PUT", path: "/api/docs/d1/shareable", body: { shareable: true } }]);
    expect(q(shareable)!.getAttribute("aria-checked")).toBe("true");
    expect(q("[data-testid=share-link]")).toBeNull();
  });

  test("a share link switched on elsewhere shows on the open doc", async () => {
    await mount("/docs/d1");
    expect(await until(() => q("[data-testid=shareable]") !== null, 5000)).toBe(true);
    expect(q("[data-testid=share-link]")).toBeNull();
    server.shares.set("d1", { enabled: true, path: `/share/doc/${"E".repeat(43)}` });
    await act(async () => publishDocsChanged({ tree: false, docId: "d1", share: true }));
    expect(await until(() => q("[data-testid=share-link]") !== null)).toBe(true);
    expect((q("[data-testid=share-link]") as HTMLInputElement).value).toContain(`/share/doc/${"E".repeat(43)}`);
    expect(q("[data-testid=doc-share-link] [data-testid=share-switch]")!.getAttribute("aria-checked")).toBe("true");
  });
});

describe("the open doc's edits are never lost", () => {
  async function open(path = "/docs/d1") {
    await mount(path);
    expect(await until(() => prose() !== null && status() === "Saved", 5000)).toBe(true);
  }

  test("an edit made a moment before a newer revision arrives stays, and the pane asks which to keep", async () => {
    await open();
    const d1 = server.docs.get("d1")!;
    server.docs.set("d1", { ...d1, revision: 2, body: "---\ntitle: Limits\n---\n# Limits\n\nRewritten by an agent.\n" });
    // The editor's own report of the paste is still debounced when the newer revision is read.
    await pasteInto("Pasted. ");
    await act(async () => publishDocsChanged({ tree: false, docId: "d1", revision: 2 }));
    expect(await until(() => q("[data-testid=doc-conflict]") !== null)).toBe(true);
    expect(prose()!.textContent).toContain("Pasted.");
    expect(prose()!.textContent).not.toContain("Rewritten by an agent.");
    await wait(AUTOSAVE_DELAY_MS + 300);
    expect(prose()!.textContent).toContain("Pasted.");
    expect(docPatches("d1")).toEqual([]);
  });

  test("opening another doc a moment after an edit saves the edit", async () => {
    server.docs.set("d3", docDetail("d3", null, "other.md", "# Other\n"));
    await open();
    await pasteInto("Pasted. ");
    await act(async () => q('[data-testid=docs-doc-row][data-doc-id="d3"]')!.click());
    expect(await until(() => server.docs.get("d1")!.body.includes("Pasted."))).toBe(true);
    const patches = docPatches("d1");
    expect(patches).toHaveLength(1);
    expect(patchBody(patches[0]!).baseRevision).toBe(1);
    expect(occurrences(patchBody(patches[0]!).body, "Pasted.")).toBe(1);
    expect(patchBody(patches[0]!).body.startsWith("---\ntitle: Limits\n---\n")).toBe(true);
  });

  test("a save still in flight when the doc closes is followed by one carrying the edits made meanwhile", async () => {
    server.docs.set("d3", docDetail("d3", null, "other.md", "# Other\n"));
    await open();
    const release = holdPatches();
    await pasteInto("First. ");
    expect(await until(() => docPatches("d1").length === 1, AUTOSAVE_DELAY_MS + 3000)).toBe(true);
    await pasteInto("Second. ");
    await act(async () => q('[data-testid=docs-doc-row][data-doc-id="d3"]')!.click());
    await act(async () => release());
    expect(await until(() => docPatches("d1").length === 2)).toBe(true);
    const [first, second] = docPatches("d1").map(patchBody);
    expect(first!.body).toContain("First.");
    expect(first!.body).not.toContain("Second.");
    expect(second!.baseRevision).toBe(2);
    expect(await until(() => server.docs.get("d1")!.revision === 3)).toBe(true);
    const stored = server.docs.get("d1")!.body;
    expect(occurrences(stored, "First.")).toBe(1);
    expect(occurrences(stored, "Second.")).toBe(1);
  });

  test("a rename landing before a save in flight is no conflict: the save goes again on the new revision", async () => {
    await open();
    const release = holdPatches();
    await pasteInto("Mine. ");
    expect(await until(() => docPatches("d1").length === 1, AUTOSAVE_DELAY_MS + 3000)).toBe(true);
    // Another tab renames the doc while the save waits.
    const d1 = server.docs.get("d1")!;
    server.docs.set("d1", { ...d1, name: "renamed.md", revision: 2 });
    await act(async () => release());
    expect(await until(() => server.docs.get("d1")!.revision === 3)).toBe(true);
    expect(docPatches("d1").map((w) => patchBody(w).baseRevision)).toEqual([1, 2]);
    expect(occurrences(server.docs.get("d1")!.body, "Mine.")).toBe(1);
    expect(q("[data-testid=doc-conflict]")).toBeNull();
    expect(await until(() => status() === "Saved")).toBe(true);
    expect(q("[data-testid=doc-name]")?.textContent).toBe("renamed.md");
  });

  test("a save writes the blocks an edit didn't touch exactly as they were stored", async () => {
    const body = "---\ntitle: Keys\n---\n|Option|p99|\n|---|---|\n|API_KEY|19 ms|\n\nThe first paragraph.\n- one\n- two\n";
    server.docs.set("d5", docDetail("d5", null, "keys.md", body));
    await mount("/docs/d5");
    expect(await until(() => prose() !== null && status() === "Saved", 5000)).toBe(true);
    await typeInto(" More.");
    expect(await until(() => docPatches("d5").length === 1, AUTOSAVE_DELAY_MS + 3000)).toBe(true);
    expect(patchBody(docPatches("d5")[0]!).body).toBe(body.replace("The first paragraph.", "The first paragraph. More."));
  });

  test("frontmatter that closes at the very end of the body is kept apart from the first edit", async () => {
    server.docs.set("d4", docDetail("d4", null, "fm.md", "---\ntitle: x\n---"));
    await mount("/docs/d4");
    expect(await until(() => prose() !== null && status() === "Saved", 5000)).toBe(true);
    await pasteInto("Hello");
    expect(await until(() => docPatches("d4").length === 1, AUTOSAVE_DELAY_MS + 3000)).toBe(true);
    const saved = patchBody(docPatches("d4")[0]!).body;
    expect(saved.startsWith("---\ntitle: x\n---\n")).toBe(true);
    expect(saved).toContain("Hello");
  });

  test("after the open doc moves, an image pasted into it resolves from its new folder", async () => {
    await open();
    // A move made elsewhere: the tree lists the doc in its new folder.
    server.docs.set("d1", { ...server.docs.get("d1")!, folderId: "f2" });
    await act(async () => publishDocsChanged({ tree: true }));
    await settle();
    await pasteInto("See ![d](diagram.png) here.");
    expect(await until(() => [...prose()!.querySelectorAll("img")].some((img) => img.getAttribute("src") === "/api/docs/assets/a1"))).toBe(true);
  });

  test("a doc deleted elsewhere with unsaved edits shows the unsaved text", async () => {
    await open();
    await pasteInto("Unsaved. ");
    server.docs.delete("d1");
    await act(async () => publishDocsChanged({ tree: true, docId: "d1", deleted: true }));
    expect(await until(() => q("[data-testid=docs-unsaved]") !== null)).toBe(true);
    expect(q("[data-testid=docs-unsaved]")!.textContent).toContain("deleted elsewhere — your unsaved text is below");
    const text = (q("[data-testid=docs-unsaved-text]") as HTMLTextAreaElement).value;
    expect(text).toContain("Unsaved.");
    expect(text).toContain("title: Limits");
    expect(q("[data-testid=docs-gone]")).not.toBeNull();
  });

  test("text left unsaved by a conflict outlasts leaving the Docs tab and shows on coming back", async () => {
    await open();
    const d1 = server.docs.get("d1")!;
    server.docs.set("d1", { ...d1, revision: 2, body: "---\ntitle: Limits\n---\n# Limits\n\nTheirs.\n" });
    await pasteInto("Pasted. ");
    await act(async () => publishDocsChanged({ tree: false, docId: "d1", revision: 2 }));
    expect(await until(() => q("[data-testid=doc-conflict]") !== null)).toBe(true);
    await act(async () => go("/board"));
    expect(await until(() => q("[data-testid=another-tab]") !== null)).toBe(true);
    await act(async () => go("/docs"));
    expect(await until(() => q("[data-testid=docs-unsaved]") !== null)).toBe(true);
    expect(q("[data-testid=docs-unsaved]")!.textContent).toContain("changed in another tab or by an agent");
    expect((q("[data-testid=docs-unsaved-text]") as HTMLTextAreaElement).value).toContain("Pasted.");
    // Nothing was saved over theirs.
    expect(server.docs.get("d1")!.body).toContain("Theirs.");
  });

  test("every doc's unsaved text is kept: a second doesn't replace the first", async () => {
    server.docs.set("d3", docDetail("d3", null, "other.md", "# Other\n\nThe first paragraph of the other.\n"));
    await open();
    await pasteInto("One. ");
    server.docs.delete("d1");
    await act(async () => publishDocsChanged({ tree: true, docId: "d1", deleted: true }));
    expect(await until(() => host.querySelectorAll("[data-testid=docs-unsaved]").length === 1)).toBe(true);
    await act(async () => go("/docs/d3"));
    expect(await until(() => prose()?.textContent?.includes("other") === true && status() === "Saved", 5000)).toBe(true);
    await pasteInto("Two. ");
    server.docs.delete("d3");
    await act(async () => publishDocsChanged({ tree: true, docId: "d3", deleted: true }));
    expect(await until(() => host.querySelectorAll("[data-testid=docs-unsaved]").length === 2)).toBe(true);
    const texts = [...host.querySelectorAll("[data-testid=docs-unsaved-text]")].map((t) => (t as HTMLTextAreaElement).value);
    expect(texts.some((t) => t.includes("One."))).toBe(true);
    expect(texts.some((t) => t.includes("Two."))).toBe(true);
  });

  test("deleting the open doc yourself with unsaved edits keeps the text and says it was deleted", async () => {
    await open();
    await pasteInto("Mine. ");
    const row = q('[data-testid=docs-doc-row][data-doc-id="d1"]')!;
    await act(async () => (row.querySelector("[data-testid=docs-delete]") as HTMLElement).click());
    await act(async () => q("[data-testid=docs-delete-confirm-button]")!.click());
    expect(await until(() => q("[data-testid=docs-unsaved]") !== null)).toBe(true);
    const notice = q("[data-testid=docs-unsaved]")!.textContent!;
    expect(notice).toContain("was deleted — your unsaved text is below");
    expect(notice).not.toContain("elsewhere");
    expect((q("[data-testid=docs-unsaved-text]") as HTMLTextAreaElement).value).toContain("Mine.");
  });

  test("a save refused after the doc closed hands over the newest text, not the text it sent", async () => {
    server.docs.set("d3", docDetail("d3", null, "other.md", "# Other\n"));
    await open();
    const release = holdPatches();
    await pasteInto("First. ");
    expect(await until(() => docPatches("d1").length === 1, AUTOSAVE_DELAY_MS + 3000)).toBe(true);
    server.failSaves = [413];
    await pasteInto("Second. ");
    await act(async () => q('[data-testid=docs-doc-row][data-doc-id="d3"]')!.click());
    await act(async () => release());
    expect(await until(() => q("[data-testid=docs-unsaved]") !== null)).toBe(true);
    expect(q("[data-testid=docs-unsaved]")!.textContent).toContain("too large");
    const text = (q("[data-testid=docs-unsaved-text]") as HTMLTextAreaElement).value;
    expect(text).toContain("First.");
    expect(text).toContain("Second.");
    // Handed over once, and not saved again behind it.
    await wait(AUTOSAVE_DELAY_MS + 300);
    expect(host.querySelectorAll("[data-testid=docs-unsaved]")).toHaveLength(1);
    expect(docPatches("d1")).toHaveLength(1);
  });

  test("a save answered after a share change elsewhere doesn't turn the switch back", async () => {
    await open();
    const release = holdPatches();
    await pasteInto("Shared. ");
    expect(await until(() => docPatches("d1").length === 1, AUTOSAVE_DELAY_MS + 3000)).toBe(true);
    // The share goes on elsewhere while the save waits; the save's answer still carries the old state.
    server.shares.set("d1", { enabled: true, path: `/share/doc/${"L".repeat(43)}` });
    await act(async () => publishDocsChanged({ tree: false, docId: "d1", share: true }));
    expect(await until(() => q("[data-testid=share-link]") !== null)).toBe(true);
    await act(async () => release());
    expect(await until(() => status() === "Saved")).toBe(true);
    await settle();
    expect(q("[data-testid=doc-share-link] [data-testid=share-switch]")!.getAttribute("aria-checked")).toBe("true");
  });

  test("a save the server refuses (413) says the doc is too large and isn't retried until the next edit", async () => {
    await open();
    server.failSaves = [413];
    await pasteInto("Big. ");
    expect(await until(() => status().includes("too large"), AUTOSAVE_DELAY_MS + 3000)).toBe(true);
    await wait(AUTOSAVE_DELAY_MS * 3);
    expect(docPatches("d1")).toHaveLength(1);
    // Retry sends it again.
    await act(async () => q("[data-testid=doc-save-retry]")!.click());
    expect(await until(() => status() === "Saved")).toBe(true);
    expect(docPatches("d1")).toHaveLength(2);
  });

  test("a save that fails on the server is retried, later each time", async () => {
    await open();
    server.failSaves = [500];
    await pasteInto("Retried. ");
    expect(await until(() => status().startsWith("Couldn't save"), AUTOSAVE_DELAY_MS + 3000)).toBe(true);
    expect(await until(() => server.saveTimes.length === 2, AUTOSAVE_DELAY_MS * 2 + 3000)).toBe(true);
    expect(server.saveTimes[1]! - server.saveTimes[0]!).toBeGreaterThanOrEqual(AUTOSAVE_DELAY_MS * 2 - 50);
    expect(await until(() => status() === "Saved")).toBe(true);
    expect(occurrences(server.docs.get("d1")!.body, "Retried.")).toBe(1);
  });
});

describe("adding an image to the open doc", () => {
  // The window's own File: a DataTransfer takes only that.
  const DomFile = window.File as unknown as typeof File;
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const pngFile = (name = "shot.png") => new DomFile([Uint8Array.from([...PNG, 1, 2, 3])], name, { type: "image/png" });
  const imageWrites = () => writes().filter((w) => w.path === "/api/docs/write-image");
  const picker = () => document.querySelector("[data-testid=doc-image-picker]");
  const imgSrcs = () => [...(prose()?.querySelectorAll("img") ?? [])].map((img) => img.getAttribute("src"));
  const alertText = () => [...host.querySelectorAll("[role=alert]")].map((el) => el.textContent ?? "").join("\n");

  const inputProto = window.HTMLInputElement.prototype as unknown as { click: () => void };
  const nativeClick = inputProto.click;
  afterEach(() => {
    inputProto.click = nativeClick;
  });

  // A picked or pasted file goes through the editor's upload plugin, which
  // takes a paste by its event class and checks for a DragEvent to place it;
  // the picker hands its file over in a DataTransfer.
  const eventGlobals = ["ClipboardEvent", "DragEvent", "DataTransfer"] as const;
  const before = new Map<string, unknown>();
  beforeAll(() => {
    for (const name of eventGlobals) {
      before.set(name, (globalThis as Record<string, unknown>)[name]);
      (globalThis as Record<string, unknown>)[name] = (window as unknown as Record<string, unknown>)[name];
    }
  });
  afterAll(() => {
    for (const [name, value] of before) (globalThis as Record<string, unknown>)[name] = value;
  });

  /** Answers the next file picker the way the browser does: with `file` picked, or cancelled when null. */
  function answerPicker(file: File | null) {
    inputProto.click = function (this: HTMLInputElement) {
      const input = this;
      expect(input.type).toBe("file");
      expect(input.accept).toBe("image/png,image/jpeg,image/gif,image/webp");
      expect(input.isConnected).toBe(true);
      setTimeout(() => {
        if (file) Object.defineProperty(input, "files", { value: [file], configurable: true });
        input.dispatchEvent(new window.Event(file ? "change" : "cancel") as unknown as Event);
      }, 0);
    };
  }

  /** Runs the slash menu's Image item, as `/image` and Enter (or a click on it) does. */
  async function runImageCommand() {
    const item = [...document.querySelectorAll(".milkdown-slash-menu li")].find((li) => li.textContent?.trim() === "Image");
    expect(item).toBeDefined();
    await act(async () => {
      prose()!.dispatchEvent(new window.Event("pointerdown", { bubbles: true }) as unknown as Event);
      item!.dispatchEvent(new window.Event("pointerup", { bubbles: true }) as unknown as Event);
    });
  }

  async function openDesign() {
    server.docs.set("d2", docDetail("d2", "f2", "design.md", "# Design\n\nIntro.\n"));
    await mount("/docs/d2");
    expect(await until(() => prose() !== null && status() === "Saved", 5000)).toBe(true);
  }

  test("/image opens the file picker; the picked PNG is stored beside the doc, shows at once, and the save embeds it by a relative src", async () => {
    await openDesign();
    answerPicker(pngFile());
    await runImageCommand();
    expect(await until(() => imgSrcs().includes("/api/docs/assets/up2"), 5000)).toBe(true);
    expect(imageWrites()).toHaveLength(1);
    expect(imageWrites()[0]!.body).toEqual({
      path: "notes/authz/shot.png",
      folderId: "f2",
      unique: true,
      data: Buffer.from([...PNG, 1, 2, 3]).toString("base64"),
    });
    expect(picker()).toBeNull();
    expect(imgSrcs()).not.toContain(MISSING_IMAGE_SRC);
    expect(await until(() => docPatches("d2").length > 0, AUTOSAVE_DELAY_MS + 3000)).toBe(true);
    expect(patchBody(docPatches("d2").at(-1)!).body).toContain("![](shot.png)");
  });

  test("/image on a line of its own puts the image in that line's place, leaving no empty line saved as <br />", async () => {
    // The editor reads `<br />` as an empty line, and starts with the cursor in it.
    server.docs.set("d2", docDetail("d2", "f2", "design.md", "<br />\n\n# Design\n\nIntro.\n"));
    await mount("/docs/d2");
    expect(await until(() => prose() !== null && status() === "Saved", 5000)).toBe(true);
    answerPicker(pngFile());
    await runImageCommand();
    expect(await until(() => imgSrcs().includes("/api/docs/assets/up2"), 5000)).toBe(true);
    expect(await until(() => docPatches("d2").length > 0, AUTOSAVE_DELAY_MS + 3000)).toBe(true);
    const saved = patchBody(docPatches("d2").at(-1)!).body;
    expect(saved).toBe("![](shot.png)\n\n# Design\n\nIntro.\n");
  });

  test("/image as the first thing in an empty doc saves the image alone", async () => {
    server.docs.set("d2", docDetail("d2", "f2", "design.md", ""));
    await mount("/docs/d2");
    expect(await until(() => prose() !== null && status() === "Saved", 5000)).toBe(true);
    answerPicker(pngFile());
    await runImageCommand();
    expect(await until(() => imgSrcs().includes("/api/docs/assets/up2"), 5000)).toBe(true);
    expect(await until(() => docPatches("d2").length > 0, AUTOSAVE_DELAY_MS + 3000)).toBe(true);
    expect(patchBody(docPatches("d2").at(-1)!).body).toBe("![](shot.png)\n");
  });

  test("cancelling the picker leaves no image block behind and stores nothing", async () => {
    await openDesign();
    answerPicker(null);
    await runImageCommand();
    expect(await until(() => picker() === null)).toBe(true);
    await wait(AUTOSAVE_DELAY_MS + 300);
    expect(prose()!.querySelector(".milkdown-image-block")).toBeNull();
    expect(imgSrcs()).toEqual([]);
    expect(imageWrites()).toEqual([]);
    for (const w of docPatches("d2")) expect(patchBody(w).body).not.toContain("![");
  });

  test("a picked file that isn't an image, or is over 10 MB, is refused inline and inserts nothing", async () => {
    await openDesign();
    // happy-dom's DataTransfer serves a text file's item as pasted text, so the non-image here is a PDF.
    answerPicker(new DomFile(["%PDF"], "notes.pdf", { type: "application/pdf" }));
    await runImageCommand();
    expect(await until(() => alertText().includes(`"notes.pdf" isn't an image a doc can hold: use a PNG, JPEG, GIF or WebP.`))).toBe(true);
    answerPicker(new DomFile([new Uint8Array(10 * 1024 * 1024 + 1)], "huge.png", { type: "image/png" }));
    await runImageCommand();
    expect(await until(() => alertText().includes(`"huge.png" is 10.0 MB; an image can be at most 10 MB.`))).toBe(true);
    await wait(AUTOSAVE_DELAY_MS + 300);
    expect(prose()!.querySelector(".milkdown-image-block")).toBeNull();
    expect(imageWrites()).toEqual([]);
    for (const w of docPatches("d2")) expect(patchBody(w).body).not.toContain("![");
  });

  test("the server's refusal shows inline, and an image block with no src yet shows the upload prompt, not 'not found'", async () => {
    server.docs.set("d2", docDetail("d2", "f2", "design.md", "# Design\n\n![]()\n"));
    await mount("/docs/d2");
    expect(await until(() => prose()?.querySelector(".milkdown-image-block") !== null && status() === "Saved", 5000)).toBe(true);
    expect(imgSrcs()).not.toContain(MISSING_IMAGE_SRC);
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === "/api/docs/write-image"
        ? new Response(JSON.stringify({ error: "the file is not a PNG, JPEG, GIF or WebP image matching its extension (checked by content)" }), { status: 400 })
        : fetchBefore(input, init)) as typeof fetch;
    answerPicker(pngFile("fake.png"));
    await runImageCommand();
    expect(await until(() => alertText().includes(`Couldn't upload "fake.png": the file is not a PNG, JPEG, GIF or WebP image`))).toBe(true);
    // Only the doc's own blank block: the refused image added none, and its upload placeholder is gone.
    expect(prose()!.querySelectorAll(".milkdown-image-block")).toHaveLength(1);
    expect(prose()!.textContent).not.toContain("Upload in progress");
  });

  // A drop is left out: ProseMirror places it by the pointer's coordinates, which need a real layout.
  describe("pasted files", () => {
    const paste = (...files: File[]) =>
      act(async () => {
        const event = new window.ClipboardEvent("paste", { bubbles: true, cancelable: true }) as unknown as Event;
        Object.defineProperty(event, "clipboardData", { value: { getData: () => "", types: ["Files"], files, items: [] } });
        prose()!.dispatchEvent(event);
      });

    test("one paste of a non-image, an oversize image and an image stores the image and reports both refusals", async () => {
      await openDesign();
      await paste(
        new DomFile(["%PDF"], "doc.pdf", { type: "application/pdf" }),
        new DomFile([new Uint8Array(10 * 1024 * 1024 + 1)], "huge.png", { type: "image/png" }),
        pngFile("ok.png")
      );
      expect(await until(() => imgSrcs().includes("/api/docs/assets/up2"), 5000)).toBe(true);
      expect(imageWrites()).toHaveLength(1);
      expect(alertText()).toContain(`"doc.pdf" isn't an image a doc can hold`);
      expect(alertText()).toContain(`"huge.png" is 10.0 MB`);
    });

    test("a name already taken beside the doc is never replaced: the image gets the free name the collector picked", async () => {
      server.assets.push({ id: "old", folderId: "f2", name: "shot.png", mime: "image/png", bytes: 1, createdAt: AT, url: "/api/docs/assets/old" });
      await openDesign();
      await paste(pngFile("shot.png"));
      expect(await until(() => imgSrcs().includes("/api/docs/assets/up3"), 5000)).toBe(true);
      expect(server.assets.find((a) => a.id === "old")?.name).toBe("shot.png");
      // The editor escapes the name's parentheses; the src still resolves to `shot (2).png`.
      expect(await until(() => docPatches("d2").some((w) => patchBody(w).body.includes("![](shot%20\\(2\\).png)")), AUTOSAVE_DELAY_MS + 3000)).toBe(true);
    });

    test("an image pasted from the clipboard is stored and shown the same way; a pasted non-image is refused inline", async () => {
      await openDesign();
      await paste(pngFile("pasted.png"));
      expect(await until(() => imgSrcs().includes("/api/docs/assets/up2"), 5000)).toBe(true);
      expect((imageWrites()[0]!.body as { path: string }).path).toBe("notes/authz/pasted.png");
      expect(await until(() => docPatches("d2").some((w) => patchBody(w).body.includes("![](pasted.png)")), AUTOSAVE_DELAY_MS + 3000)).toBe(true);
      await paste(new DomFile(["%PDF"], "doc.pdf", { type: "application/pdf" }));
      expect(await until(() => alertText().includes(`"doc.pdf" isn't an image a doc can hold`))).toBe(true);
      expect(imageWrites()).toHaveLength(1);
      expect(prose()!.textContent).not.toContain("Upload in progress");
    });
  });
});

describe("files dragged in from the desktop", () => {
  function fileDrag(type: "dragover" | "drop") {
    const event = new window.Event(type, { bubbles: true, cancelable: true }) as unknown as Event;
    Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [], dropEffect: "copy" } });
    return event;
  }

  test("are refused by the tree without the browser opening them", async () => {
    await mount("/docs");
    for (const target of [q("[data-testid=docs-root]")!, q('[data-testid=docs-folder][data-folder-id="f1"]')!]) {
      const over = fileDrag("dragover");
      const drop = fileDrag("drop");
      await act(async () => {
        target.dispatchEvent(over);
        target.dispatchEvent(drop);
      });
      expect(over.defaultPrevented).toBe(true);
      expect(drop.defaultPrevented).toBe(true);
    }
    expect(writes()).toEqual([]);
  });
});

const OPEN_KEY = "standup.docs.openFolders";
const folderRow = (id: string) => q(`[data-testid=docs-folder][data-folder-id="${id}"] [data-testid=docs-folder-row]`);
/** Whether `authz` (f2, inside notes) is open: its image is listed. */
const authzOpen = () => q('[data-testid=docs-asset-row][data-asset-id="a1"]') !== null;

async function reload(path = "/docs") {
  await act(() => root.unmount());
  host.remove();
  await mount(path);
}

describe("open folders across reloads", () => {
  test("the folders left open come back open, stored as a short list of their ids", async () => {
    await mount("/docs");
    await act(async () => folderRow("f1")!.click());
    await act(async () => folderRow("f2")!.click());
    expect(authzOpen()).toBe(true);
    expect(window.localStorage.getItem(OPEN_KEY)).toBe('["f1","f2"]');

    await reload();
    expect(authzOpen()).toBe(true);

    await act(async () => folderRow("f2")!.click());
    expect(window.localStorage.getItem(OPEN_KEY)).toBe('["f1"]');
    await reload();
    expect(folderRow("f2")).not.toBeNull();
    expect(authzOpen()).toBe(false);
  });

  test("a stored folder the tree no longer has is dropped once the tree loads", async () => {
    window.localStorage.setItem(OPEN_KEY, '["gone","f1"]');
    await mount("/docs");
    expect(folderRow("f2")).not.toBeNull();
    expect(window.localStorage.getItem(OPEN_KEY)).toBe('["f1"]');
  });

  test("a malformed stored value opens nothing and is replaced on the next toggle", async () => {
    window.localStorage.setItem(OPEN_KEY, "{not json");
    await mount("/docs");
    expect(folderRow("f2")).toBeNull();
    await act(async () => folderRow("f1")!.click());
    expect(window.localStorage.getItem(OPEN_KEY)).toBe('["f1"]');
  });
});

describe("docs search", () => {
  const input = () => q("[data-testid=docs-search-input]") as HTMLInputElement | null;
  const hits = () => [...host.querySelectorAll<HTMLElement>("[data-testid=docs-search-hit]")];
  const shortcut = (init: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) =>
    act(async () => {
      window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "k", bubbles: true, cancelable: true, ...init }));
    });
  const deep = (): DocDetail => {
    const body = "# Deep dive\n\nThe quota math lives here.\n";
    return { id: "d2", folderId: "f2", name: "deep-dive.md", revision: 1, bytes: body.length, createdAt: AT, updatedAt: AT, body, share: { enabled: false, path: null } };
  };

  test("the header's search button opens search, its tooltip naming the shortcut", async () => {
    await mount("/docs");
    const button = q("[data-testid=docs-search-open]")!;
    expect(button.getAttribute("title")).toMatch(/^Search docs \((⌘K|Ctrl\+K)\)$/);
    await act(async () => button.click());
    expect(input()).not.toBeNull();
    expect(document.activeElement).toBe(input());
  });

  test("Ctrl+K and Cmd+K open search, from an input too; K alone or with Shift does not", async () => {
    await mount("/docs");
    await shortcut({});
    await shortcut({ ctrlKey: true, shiftKey: true });
    expect(input()).toBeNull();
    await shortcut({ ctrlKey: true });
    expect(input()).not.toBeNull();
    await press(input()!, "Escape");
    expect(input()).toBeNull();

    await act(async () => q("[data-testid=docs-import-open]")!.click());
    (q("[data-testid=docs-import-path]") as HTMLInputElement).focus();
    await shortcut({ metaKey: true });
    expect(input()).not.toBeNull();
  });

  test("typing lists name and path matches, then body matches, with the match highlighted", async () => {
    server.docs.set("d2", deep());
    await mount("/docs");
    await act(async () => q("[data-testid=docs-search-open]")!.click());
    await typeValue(input()!, "quota");
    expect(await until(() => hits().length === 1)).toBe(true);
    expect(hits()[0]!.textContent).toContain("notes/authz");
    expect(hits()[0]!.querySelector("[data-testid=docs-search-snippet]")!.textContent).toBe("The quota math lives here.");
    expect([...hits()[0]!.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["quota"]);

    await typeValue(input()!, "zzz");
    expect(await until(() => q("[data-testid=docs-search-status]")?.textContent === "No docs match “zzz”.")).toBe(true);
  });

  test("a doc found by meaning is listed with its passage and nothing in it marked", async () => {
    server.meaningHits = [{ id: "d1", path: "limits.md", match: "meaning", snippet: "The first paragraph." }];
    await mount("/docs");
    await act(async () => q("[data-testid=docs-search-open]")!.click());
    await typeValue(input()!, "a rule about how far");
    expect(await until(() => hits().length === 1)).toBe(true);
    expect(hits()[0]!.textContent).toContain("limits.md");
    expect(hits()[0]!.querySelector("[data-testid=docs-search-snippet]")!.textContent).toBe("The first paragraph.");
    expect(hits()[0]!.querySelectorAll("mark")).toHaveLength(0);
  });

  test("arrow keys move the choice and wrap; Enter opens the doc and the tree opens its folders to show it", async () => {
    server.docs.set("d2", deep());
    await mount("/docs");
    expect(authzOpen()).toBe(false);
    await shortcut({ ctrlKey: true });
    await typeValue(input()!, "d");
    expect(await until(() => hits().length === 2)).toBe(true);
    const selected = () => hits().find((h) => h.getAttribute("aria-selected") === "true")?.dataset.docId;
    expect(selected()).toBe("d1");
    await press(input()!, "ArrowDown");
    expect(selected()).toBe("d2");
    await press(input()!, "ArrowDown");
    expect(selected()).toBe("d1");
    await press(input()!, "ArrowUp");
    expect(selected()).toBe("d2");
    expect(input()!.getAttribute("aria-activedescendant")).toBe("docs-search-hit-d2");

    await press(input()!, "Enter");
    expect(input()).toBeNull();
    expect(await until(() => q('[data-testid=docs-doc-row][data-doc-id="d2"]')?.getAttribute("aria-current") === "page")).toBe(true);
    expect(authzOpen()).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(OPEN_KEY)!)).toEqual(["f2", "f1"]);
  });

  test("a click outside the dialog closes it, and the focus goes back to where it was", async () => {
    await mount("/docs");
    const button = q("[data-testid=docs-search-open]")!;
    button.focus();
    await act(async () => button.click());
    expect(document.activeElement).toBe(input());
    await act(async () => {
      q("[data-testid=docs-search-backdrop]")!.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }) as unknown as Event);
    });
    expect(input()).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  test("Enter waits for the results of what was typed last, not the ones still listed", async () => {
    server.docs.set("d2", deep());
    await mount("/docs");
    await shortcut({ ctrlKey: true });
    await typeValue(input()!, "limits");
    expect(await until(() => hits().length === 1 && hits()[0]!.dataset.docId === "d1")).toBe(true);
    await typeValue(input()!, "deep");
    await press(input()!, "Enter");
    expect(input()).not.toBeNull();
    expect(await until(() => hits()[0]?.dataset.docId === "d2")).toBe(true);
    await press(input()!, "Enter");
    expect(input()).toBeNull();
    expect(await until(() => q('[data-testid=docs-doc-row][data-doc-id="d2"]')?.getAttribute("aria-current") === "page")).toBe(true);
  });
});
