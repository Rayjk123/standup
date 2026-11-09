import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import type { SharedDoc, SharedFolder } from "@standup/shared";
import type { Root } from "react-dom/client";
import { GlobalWindow } from "happy-dom";

// react-dom decides whether a DOM exists when it is first imported, so the
// window is installed before the view modules load.
const window = new GlobalWindow({ url: "http://localhost/share/folder/x" });
const GLOBALS = [
  "window",
  "document",
  "navigator",
  "Node",
  "HTMLElement",
  "Element",
  "Text",
  "Event",
  "MutationObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const;
const saved = new Map<string, unknown>();
const savedFetch = globalThis.fetch;

let act: (fn: () => void | Promise<void>) => Promise<void>;
let createRoot: (el: Element) => Root;
let SharedFolderPage: typeof import("./SharedFolderPage").SharedFolderPage;

beforeAll(async () => {
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = (window as unknown as Record<string, unknown>)[name];
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = (await import("react")) as unknown as { act: typeof act });
  ({ createRoot } = await import("react-dom/client"));
  ({ SharedFolderPage } = await import("./SharedFolderPage"));
  await (await import("../Markdown")).markdownReady;
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

const TOKEN = "F".repeat(43);

async function render(search = "") {
  window.history.replaceState({}, "", `/share/folder/${TOKEN}${search}`);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(() => root.render(createElement(SharedFolderPage, { token: TOKEN })));
  await settle();
}

async function settle() {
  for (let i = 0; i < 4; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
}

const q = (id: string) => host.querySelector(`[data-testid=${id}]`) as HTMLElement | null;
const qa = (id: string) => [...host.querySelectorAll(`[data-testid=${id}]`)] as HTMLElement[];

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const D_INDEX = uuid(1);
const D_IDEAS = uuid(2);
const D_LAUNCH = uuid(3);
const D_ELSEWHERE = uuid(9);

const FOLDER: SharedFolder = {
  name: "field-notes",
  folders: [
    { id: "root", parentId: null, name: "field-notes" },
    { id: "dr", parentId: "root", name: "drafts" },
    { id: "pb", parentId: "root", name: "published" },
  ],
  docs: [
    { id: D_INDEX, folderId: "root", name: "index.md" },
    { id: D_IDEAS, folderId: "dr", name: "ideas.md" },
    { id: D_LAUNCH, folderId: "pb", name: "launch.md" },
  ],
};

const DOCS: Record<string, SharedDoc> = {
  [D_IDEAS]: { name: "ideas.md", body: "# Ideas in progress", images: {} },
  [D_LAUNCH]: { name: "launch.md", body: "# Launch notes", images: {} },
};

/** The collector's share routes for TOKEN: the tree, and the docs in DOCS (anything else a 404). */
function stubCollector() {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url === `/api/share/folders/${TOKEN}`) return json(200, { folder: FOLDER });
    const doc = url.match(/\/docs\/([^/]+)$/)?.[1];
    if (doc && DOCS[doc]) return json(200, { doc: DOCS[doc] });
    return json(404, { error: "Not found" });
  }) as typeof fetch;
  return calls;
}

describe("SharedFolderPage", () => {
  test("shows the folder's tree with its subfolders, and opens a nested doc read-only", async () => {
    const calls = stubCollector();
    await render();
    expect(calls).toEqual([`/api/share/folders/${TOKEN}`]);
    const tree = q("shared-folder-tree")!;
    expect(tree.textContent).toContain("field-notes");
    expect(qa("shared-folder-folder").map((f) => f.querySelector("button")!.textContent)).toEqual(["drafts", "published"]);
    expect(qa("shared-folder-doc").map((d) => d.textContent)).toEqual(["ideas.md", "launch.md", "index.md"]);

    const ideas = qa("shared-folder-doc").find((d) => d.textContent === "ideas.md")!;
    await act(async () => ideas.click());
    await settle();
    expect(calls.at(-1)).toBe(`/api/share/folders/${TOKEN}/docs/${D_IDEAS}`);
    expect(window.location.search).toBe(`?doc=${D_IDEAS}`);
    expect(ideas.getAttribute("aria-current")).toBe("page");
    const article = q("shared-doc")!;
    expect(article.querySelector("h1")?.textContent).toBe("ideas.md");
    expect(article.textContent).toContain("Ideas in progress");
    // Read-only: nothing on the page edits.
    expect(host.querySelector("textarea, [contenteditable=true], input")).toBeNull();

    // Back returns to the doc opened before.
    const launch = qa("shared-folder-doc").find((d) => d.textContent === "launch.md")!;
    await act(async () => launch.click());
    await settle();
    expect(q("shared-doc")!.textContent).toContain("Launch notes");
    window.history.back();
    await settle();
    // happy-dom moves the location without firing popstate, which a browser fires.
    await act(async () => {
      window.dispatchEvent(new window.Event("popstate"));
    });
    await settle();
    expect(window.location.search).toBe(`?doc=${D_IDEAS}`);
    expect(q("shared-doc")!.textContent).toContain("Ideas in progress");
  });

  test("opens the doc the link names", async () => {
    stubCollector();
    await render(`?doc=${D_LAUNCH}`);
    expect(q("shared-doc")!.textContent).toContain("Launch notes");
  });

  test("a doc outside the folder is a plain not-found beside the tree", async () => {
    stubCollector();
    await render(`?doc=${D_ELSEWHERE}`);
    expect(q("shared-folder-tree")).not.toBeNull();
    expect(q("shared-folder-doc-missing")!.textContent).toContain("isn't in the shared folder");
    expect(q("shared-doc")).toBeNull();
  });

  test("a ?doc= that isn't a doc id (a path, a dot segment) is not-found without being asked for", async () => {
    for (const bad of ["..", "../../api/docs/tree", "%2e%2e%2ftree"]) {
      const calls = stubCollector();
      await render(`?doc=${bad}`);
      expect(calls).toEqual([`/api/share/folders/${TOKEN}`]);
      expect(q("shared-folder-doc-missing")).not.toBeNull();
      await act(() => root.unmount());
      host.remove();
      root = createRoot(document.createElement("div"));
    }
  });

  test("an empty shared folder says so", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ folder: { name: "empty", folders: [{ id: "r", parentId: null, name: "empty" }], docs: [] } }), {
        status: 200,
      })) as unknown as typeof fetch;
    await render();
    expect(q("shared-folder-tree")!.textContent).toContain("No docs in this folder yet.");
  });

  test("a revoked or unknown link shows only the not-found page", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "Not found" }), { status: 404 })) as unknown as typeof fetch;
    await render(`?doc=${D_IDEAS}`);
    expect(q("shared-folder-missing")).not.toBeNull();
    expect(q("shared-folder-tree")).toBeNull();
  });
});
