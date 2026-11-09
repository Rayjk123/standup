import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import type { SharedDoc } from "@standup/shared";
import type { Root } from "react-dom/client";
import { GlobalWindow } from "happy-dom";

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
  "MutationObserver",
  "XMLSerializer",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const;
const saved = new Map<string, unknown>();
const savedFetch = globalThis.fetch;

let act: (fn: () => void | Promise<void>) => Promise<void>;
let createRoot: (el: Element) => Root;
let SharedDocPage: typeof import("./SharedDocPage").SharedDocPage;

beforeAll(async () => {
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = (window as unknown as Record<string, unknown>)[name];
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = (await import("react")) as unknown as { act: typeof act });
  ({ createRoot } = await import("react-dom/client"));
  ({ SharedDocPage } = await import("./SharedDocPage"));
  // The markdown renderer is its own chunk; let it land so bodies render as markdown.
  await (await import("../Markdown")).markdownReady;
  // happy-dom doesn't run mermaid-frame.html, so the diagram frame stands in
  // with the real Mermaid: its parse errors are what a broken diagram shows.
  const real = (await import("mermaid")).default;
  // happy-dom can't lay a diagram out, so DRAWN_SOURCE draws as a fixed SVG.
  const mermaid = {
    ...real,
    initialize: real.initialize.bind(real),
    render: (id: string, source: string) =>
      source === DRAWN_SOURCE ? Promise.resolve({ svg: DRAWN_SVG }) : real.render(id, source),
  };
  const createElement = document.createElement.bind(document);
  document.createElement = ((tag: string, options?: ElementCreationOptions) => {
    const el = createElement(tag, options);
    if (tag === "iframe") {
      setTimeout(() => {
        Object.defineProperty(el, "contentWindow", { value: { standupMermaid: mermaid, document: { title: "Diagram renderer" } } });
        el.dispatchEvent(new (window.Event as unknown as typeof Event)("load"));
      }, 0);
    }
    return el;
  }) as typeof document.createElement;
});

afterAll(async () => {
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  globalThis.fetch = savedFetch;
  await window.happyDOM.close();
});

// The renderer and its cache of drawn diagrams are shared by every file in a
// run, so this is a source no other test file draws.
const DRAWN_SOURCE = "flowchart LR\n    Shared --> Page";
const DRAWN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><rect width="120" height="40"/></svg>';

let host: HTMLElement;
let root: Root;

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  globalThis.fetch = savedFetch;
});

async function render(element: ReturnType<typeof createElement>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(() => root.render(element));
}

async function settle() {
  for (let i = 0; i < 4; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
}

const q = (id: string) => host.querySelector(`[data-testid=${id}]`) as HTMLElement | null;
const TOKEN = "D".repeat(43);

function stubFetch(status: number, body: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

const SHARED: SharedDoc = {
  name: "limiter.md",
  body: [
    "---",
    "title: Limiter",
    "---",
    "# Rate limiting",
    "",
    "See [the RFC](https://www.rfc-editor.org/rfc/rfc6585).",
    "",
    "![Request path](images/path.png)",
    "",
    "![Not shared](secret/other.png)",
    "",
    "![](images/also-missing.png)",
    "",
  ].join("\n"),
  images: { "images/path.png": { url: `/api/share/docs/${TOKEN}/media/a1`, mime: "image/png" } },
};

describe("SharedDocPage", () => {
  test("renders the doc's name and body, with shared images from their share URL", async () => {
    const calls = stubFetch(200, { doc: SHARED });
    await render(createElement(SharedDocPage, { token: TOKEN }));
    await settle();
    expect(calls.map((c) => c.url)).toEqual([`/api/share/docs/${TOKEN}`]);
    expect(calls[0]!.init?.referrerPolicy).toBe("no-referrer");
    const article = q("shared-doc")!;
    expect(article.querySelector("h1")?.textContent).toBe("limiter.md");
    expect(article.textContent).toContain("Rate limiting");
    // The frontmatter is the doc's metadata, not its content.
    expect(article.textContent).not.toContain("title: Limiter");
    const images = article.querySelectorAll("img");
    expect(images).toHaveLength(1);
    expect(images[0]!.getAttribute("src")).toBe(`/api/share/docs/${TOKEN}/media/a1`);
    expect(images[0]!.getAttribute("alt")).toBe("Request path");
    // An image the share doesn't carry shows its alt text and never fetches.
    expect(article.textContent).toContain("[Not shared]");
    expect(article.innerHTML).not.toContain("secret/other.png");
    expect(article.innerHTML).not.toContain("also-missing.png");
  });

  test("a shared image is found whatever characters its src holds", async () => {
    const media = (id: string) => ({ url: `/api/share/docs/${TOKEN}/media/${id}`, mime: "image/png" });
    stubFetch(200, {
      doc: {
        name: "pictures.md",
        body: ["![Accented](café.png)", "", "![Spaced](<my pic.png>)", "", "![Escaped](caf%C3%A9-2.png)", "", "![Plain](plain.png)", ""].join("\n"),
        // Keyed by each destination as written, as the share route keys them.
        images: { "café.png": media("a1"), "my pic.png": media("a2"), "caf%C3%A9-2.png": media("a3"), "plain.png": media("a4") },
      } satisfies SharedDoc,
    });
    await render(createElement(SharedDocPage, { token: TOKEN }));
    await settle();
    const srcs = [...q("shared-doc")!.querySelectorAll("img")].map((img) => [img.getAttribute("alt"), img.getAttribute("src")]);
    expect(srcs).toEqual([
      ["Accented", media("a1").url],
      ["Spaced", media("a2").url],
      ["Escaped", media("a3").url],
      ["Plain", media("a4").url],
    ]);
  });

  test("a src naming an Object property is not a shared image", async () => {
    stubFetch(200, { doc: { name: "x.md", body: "![Proto](constructor)\n", images: {} } satisfies SharedDoc });
    await render(createElement(SharedDocPage, { token: TOKEN }));
    await settle();
    expect(q("shared-doc")!.querySelectorAll("img")).toHaveLength(0);
    expect(q("shared-doc")!.textContent).toContain("[Proto]");
  });

  test("links open in a new tab with no opener and no referrer", async () => {
    stubFetch(200, { doc: SHARED });
    await render(createElement(SharedDocPage, { token: TOKEN }));
    await settle();
    const link = q("shared-doc")!.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://www.rfc-editor.org/rfc/rfc6585");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  test("keeps the token out of referrers and search indexes, and shows no console chrome", async () => {
    stubFetch(200, { doc: SHARED });
    await render(createElement(SharedDocPage, { token: TOKEN }));
    await settle();
    expect(document.head.querySelector("meta[name=referrer]")?.getAttribute("content")).toBe("no-referrer");
    expect(document.head.querySelector("meta[name=robots]")?.getAttribute("content")).toContain("noindex");
    expect(host.querySelectorAll("nav, button, input, textarea")).toHaveLength(0);
    expect(host.textContent).not.toMatch(/sign in/i);
  });

  test("an unknown or revoked link shows a bare not-found page", async () => {
    stubFetch(404, { error: "Not found" });
    await render(createElement(SharedDocPage, { token: TOKEN }));
    await settle();
    expect(q("shared-doc-missing")?.textContent).toContain("404");
    expect(q("shared-doc-missing")?.textContent).toContain("turned off");
    expect(q("shared-doc")).toBeNull();
  });

  test("a doc without a ```mermaid block never loads the diagram block, where one with it does in the same wait", async () => {
    const wait = async () => {
      for (let i = 0; i < 25; i++) await act(async () => new Promise((r) => setTimeout(r, 20)));
    };
    stubFetch(200, { doc: { name: "code.md", body: "```ts\nconst a = 1;\n```\n\n```\nplain\n```\n", images: {} } satisfies SharedDoc });
    await render(createElement(SharedDocPage, { token: TOKEN }));
    await wait();
    expect(q("shared-doc")!.querySelectorAll("pre")).toHaveLength(2);
    expect(host.querySelector("[data-testid^=mermaid-]")).toBeNull();
    await act(() => root.unmount());
    host.remove();

    stubFetch(200, { doc: { name: "diagram.md", body: "```mermaid\nflowchart LR\n    A -->> -->\n```\n", images: {} } satisfies SharedDoc });
    await render(createElement(SharedDocPage, { token: TOKEN }));
    await wait();
    expect(host.querySelector("[data-testid^=mermaid-]")).not.toBeNull();
  }, 20000);

  test("a drawn ```mermaid block shows only its diagram until the reader asks for its source", async () => {
    stubFetch(200, { doc: { name: "drawn.md", body: `\`\`\`mermaid\n${DRAWN_SOURCE}\n\`\`\`\n`, images: {} } satisfies SharedDoc });
    await render(createElement(SharedDocPage, { token: TOKEN }));
    for (let i = 0; i < 100 && !q("mermaid-diagram"); i++) await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(q("mermaid-diagram")!.querySelector("img")!.getAttribute("src")).toStartWith("data:image/svg+xml");
    const toggle = q("mermaid-source-toggle")!;
    expect(toggle.textContent).toBe("Show source");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(q("mermaid-drawn")!.querySelector("pre")).toBeNull();
    expect(q("mermaid-source")).toBeNull();

    await act(async () => toggle.click());
    expect(toggle.textContent).toBe("Hide source");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(q("mermaid-source")!.querySelector("pre")!.textContent!.trimEnd()).toBe(DRAWN_SOURCE);
    expect(q("mermaid-diagram")).not.toBeNull();

    await act(async () => toggle.click());
    expect(toggle.textContent).toBe("Show source");
    expect(q("mermaid-source")).toBeNull();
  }, 20000);

  test("a ```mermaid block that doesn't parse stays its code block, with a note, and the rest of the doc renders", async () => {
    const body = "# Before\n\n```mermaid\nflowchart LR\n    A -->> -->\n```\n\nAfter the diagram.\n";
    stubFetch(200, { doc: { name: "broken.md", body, images: {} } satisfies SharedDoc });
    await render(createElement(SharedDocPage, { token: TOKEN }));
    // The real Mermaid parses the source; drawing waits on its chunk.
    for (let i = 0; i < 100 && !q("mermaid-error"); i++) await act(async () => new Promise((r) => setTimeout(r, 20)));
    const fallback = q("mermaid-error")!;
    expect(fallback.querySelector("pre")!.textContent!.trimEnd()).toBe("flowchart LR\n    A -->> -->");
    expect(fallback.textContent).toContain("Couldn't draw this diagram: Parse error");
    expect(fallback.querySelector("img")).toBeNull();
    expect(q("mermaid-source-toggle")).toBeNull();
    expect(q("shared-doc")!.textContent).toContain("Before");
    expect(q("shared-doc")!.textContent).toContain("After the diagram.");
  }, 20000);

  test("a malformed token never fetches", async () => {
    const calls = stubFetch(200, { doc: SHARED });
    await render(createElement(SharedDocPage, { token: null }));
    await settle();
    expect(calls).toEqual([]);
    expect(q("shared-doc-missing")).not.toBeNull();
  });
});
