import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { GlobalWindow } from "happy-dom";

// react-dom decides whether a DOM exists when it is first imported, so the
// window is installed before it loads.
const window = new GlobalWindow({ url: "http://localhost/" });
const GLOBALS = ["window", "document", "navigator", "location", "history", "Node", "HTMLElement", "Element", "Text", "Event", "MutationObserver"] as const;
const saved = new Map<string, unknown>();

let act: (fn: () => unknown) => Promise<void>;
let createRoot: (el: Element) => Root;
let router: typeof import("react-router-dom");
let BuildUpdateBanner: typeof import("./BuildUpdateBanner").BuildUpdateBanner;
let lib: typeof import("../lib/buildUpdate");

beforeAll(async () => {
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = (window as unknown as Record<string, unknown>)[name];
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = (await import("react")) as unknown as { act: typeof act });
  ({ createRoot } = await import("react-dom/client"));
  router = await import("react-router-dom");
  ({ BuildUpdateBanner } = await import("./BuildUpdateBanner"));
  lib = await import("../lib/buildUpdate");
});

afterAll(() => {
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  window.close();
});

const BUILT = (entry: string) =>
  `<!doctype html><html><head><script type="module" crossorigin src="${entry}"></script>` +
  `<link rel="modulepreload" crossorigin href="/assets/vendor-1a2b.js"></head><body><div id="root"></div></body></html>`;

describe("build entries", () => {
  test("an index.html names its built entry chunk; the dev server's names none", () => {
    expect(lib.servedEntry(BUILT("/assets/index-Ab12Cd.js"))).toBe("/assets/index-Ab12Cd.js");
    expect(lib.servedEntry(`<script src="/assets/legacy-1.js"></script><script type=module src='/assets/index-9.js'></script>`)).toBe(
      "/assets/index-9.js"
    );
    expect(lib.servedEntry(`<script type="module" src="/src/main.tsx"></script>`)).toBeUndefined();
    expect(lib.servedEntry("<html>sign in</html>")).toBeUndefined();
  });

  test("the page's own entry is read from its module script", () => {
    // A page's scripts as querySelectorAll hands them over; parsing real ones would make happy-dom fetch them.
    const page = (...srcs: string[]) =>
      ({
        baseURI: "http://localhost:5173/board",
        querySelectorAll: () => srcs.map((src) => ({ getAttribute: () => src })),
      }) as unknown as Document;
    expect(lib.loadedEntry(page("http://localhost:5173/assets/index-Ab12Cd.js"))).toBe("/assets/index-Ab12Cd.js");
    expect(lib.loadedEntry(page("/src/main.tsx"))).toBeUndefined();
    expect(lib.loadedEntry(page())).toBeUndefined();
  });

  test("a newer build is served only when the served entry differs; a failure never claims one", async () => {
    const serving = (body: string, status = 200) => (async () => new Response(body, { status })) as unknown as typeof fetch;
    expect(await lib.newerBuildServed("/assets/index-old.js", serving(BUILT("/assets/index-new.js")))).toBe(true);
    expect(await lib.newerBuildServed("/assets/index-old.js", serving(BUILT("/assets/index-old.js")))).toBe(false);
    expect(await lib.newerBuildServed("/assets/index-old.js", serving("collector restarting", 502))).toBe(false);
    expect(await lib.newerBuildServed("/assets/index-old.js", serving("<html></html>"))).toBe(false);
    const down = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await lib.newerBuildServed("/assets/index-old.js", down)).toBe(false);
    // The dev server: nothing to compare.
    expect(await lib.newerBuildServed(undefined, serving(BUILT("/assets/index-new.js")))).toBe(false);
  });
});

test("a path's tab is its first segment", async () => {
  const { tabOf } = await import("./BuildUpdateBanner");
  expect(tabOf("/work/s/abc")).toBe("work");
  expect(tabOf("/board")).toBe("board");
  expect(tabOf("/")).toBe("");
});

describe("BuildUpdateBanner", () => {
  let host: HTMLElement;
  let root: Root;
  let navigate: (to: string) => void = () => {};

  afterEach(async () => {
    await act(() => root.unmount());
    host.remove();
  });

  const settle = async () => {
    for (let i = 0; i < 5; i++) await act(() => new Promise((done) => setTimeout(done, 5)));
  };
  async function until(check: () => boolean, ms = 1000) {
    const deadline = Date.now() + ms;
    while (!check() && Date.now() < deadline) await settle();
  }

  async function mount(newer: () => boolean, reload: () => void) {
    const { MemoryRouter, useNavigate } = router;
    const Nav = () => {
      navigate = useNavigate();
      return null;
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(() =>
      root.render(
        createElement(
          MemoryRouter,
          { initialEntries: ["/persona"] },
          createElement(Nav),
          createElement(BuildUpdateBanner, {
            intervalMs: 20,
            loaded: "/assets/index-old.js",
            check: async () => newer(),
            reload,
          })
        )
      )
    );
  }
  const banner = () => host.querySelector('[data-testid="build-update-banner"]');

  test("stays hidden while the page is on the served build", async () => {
    let reloads = 0;
    await mount(() => false, () => reloads++);
    await settle();
    await act(async () => navigate("/board"));
    await settle();
    expect(banner()).toBeNull();
    expect(reloads).toBe(0);
  });

  test("offers a reload once the console is rebuilt, and the next tab switch reloads onto the new build", async () => {
    let newer = false;
    let reloads = 0;
    await mount(() => newer, () => reloads++);
    await settle();
    expect(banner()).toBeNull();
    newer = true;
    await until(() => !!banner());
    expect(banner()?.textContent).toContain("Standup was updated");
    // Showing the banner reloads nothing by itself, nor does a move within the tab.
    expect(reloads).toBe(0);
    await act(async () => navigate("/persona/thread-2"));
    await settle();
    expect(reloads).toBe(0);
    await act(async () => navigate("/board"));
    await settle();
    expect(reloads).toBe(1);
  });
});
