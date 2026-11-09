import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import type { MermaidConfig } from "mermaid";
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
  "localStorage",
] as const;
const saved = new Map<string, unknown>();

let act: (fn: () => void | Promise<void>) => Promise<void>;
let createRoot: (el: Element) => Root;
let MermaidBlock: typeof import("./MermaidBlock").MermaidBlock;
let store: typeof import("../hooks/useTheme");

/** The themes the frame's Mermaid was configured with, in order. */
const configured: MermaidConfig["theme"][] = [];
const renders: string[] = [];

beforeAll(async () => {
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = (window as unknown as Record<string, unknown>)[name];
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = (await import("react")) as unknown as { act: typeof act });
  ({ createRoot } = await import("react-dom/client"));
  ({ MermaidBlock } = await import("./MermaidBlock"));
  store = await import("../hooks/useTheme");
  const { FRAME_TITLE } = await import("../lib/mermaid");
  // happy-dom doesn't run mermaid-frame.html, so the frame hands over a fake
  // Mermaid that draws the theme it was last configured with into its SVG.
  const mermaid = {
    initialize: (config: MermaidConfig) => configured.push(config.theme),
    render: async (_id: string, source: string) => {
      renders.push(source);
      return {
        svg: `<svg width="100%" viewBox="0 0 320 120" style="max-width: 320px;" xmlns="http://www.w3.org/2000/svg"><text>${configured.at(-1)}</text></svg>`,
      };
    },
  };
  const create = document.createElement.bind(document);
  document.createElement = ((tag: string, options?: ElementCreationOptions) => {
    const el = create(tag, options);
    if (tag === "iframe") {
      setTimeout(() => {
        Object.defineProperty(el, "contentWindow", { value: { standupMermaid: mermaid, document: { title: FRAME_TITLE } } });
        el.dispatchEvent(new (window.Event as unknown as typeof Event)("load"));
      }, 0);
    }
    return el;
  }) as typeof document.createElement;
});

afterAll(async () => {
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  await window.happyDOM.close();
});

let host: HTMLElement;
let root: Root;

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  store.resetThemeStore();
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

const SOURCE = "flowchart LR\n    A --> B";

const diagramSrc = () => host.querySelector("[data-testid=mermaid-diagram] img")?.getAttribute("src") ?? null;

async function until(done: () => boolean) {
  for (let i = 0; i < 100 && !done(); i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
}

describe("MermaidBlock", () => {
  test("a palette switch draws the diagram again in the new palette", async () => {
    store.setThemePreference("dark");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(() => root.render(createElement(MermaidBlock, { source: SOURCE, children: createElement("pre", null, SOURCE) })));
    await until(() => diagramSrc() !== null);
    const dark = diagramSrc();
    expect(dark).toStartWith("data:image/svg+xml");
    expect(configured).toEqual(["dark"]);

    await act(async () => store.setThemePreference("light"));
    await until(() => diagramSrc() !== dark);
    const light = diagramSrc();
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(configured).toEqual(["dark", "default"]);
    expect(light).not.toBe(dark);
    expect(renders).toEqual([SOURCE, SOURCE]);

    // Back to dark shows the cached dark drawing without drawing again.
    await act(async () => store.setThemePreference("dark"));
    await until(() => diagramSrc() === dark);
    expect(diagramSrc()).toBe(dark);
    expect(renders).toHaveLength(2);
  }, 10000);
});
