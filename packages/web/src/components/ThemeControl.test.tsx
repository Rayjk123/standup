import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { GlobalWindow } from "happy-dom";

// react-dom decides whether a DOM exists when it is first imported, so the
// window is installed before the view modules load.
const window = new GlobalWindow({ url: "http://localhost/" });
const GLOBALS = ["window", "document", "navigator", "Node", "HTMLElement", "Element", "Text", "Event", "MutationObserver", "localStorage"] as const;
const saved = new Map<string, unknown>();

/** A stand-in for the OS color-scheme setting, driving window.matchMedia. */
const os = {
  scheme: "dark" as "dark" | "light",
  listeners: new Set<() => void>(),
  set(scheme: "dark" | "light") {
    this.scheme = scheme;
    for (const l of [...this.listeners]) l();
  },
};

function fakeMatchMedia(query: string) {
  return {
    media: query,
    get matches() {
      return query.includes(os.scheme);
    },
    addEventListener: (_: string, l: () => void) => os.listeners.add(l),
    removeEventListener: (_: string, l: () => void) => os.listeners.delete(l),
  };
}

let act: (fn: () => void | Promise<void>) => Promise<void>;
let createRoot: (el: Element) => Root;
let ThemeControl: typeof import("./ThemeControl").ThemeControl;
let ThemeToggle: typeof import("./ThemeControl").ThemeToggle;
let store: typeof import("../hooks/useTheme");
let prefs: typeof import("../lib/themePreference");

beforeAll(async () => {
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = (window as unknown as Record<string, unknown>)[name];
  }
  (window as unknown as { matchMedia: typeof fakeMatchMedia }).matchMedia = fakeMatchMedia;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = (await import("react")) as unknown as { act: typeof act });
  ({ createRoot } = await import("react-dom/client"));
  ({ ThemeControl, ThemeToggle } = await import("./ThemeControl"));
  store = await import("../hooks/useTheme");
  prefs = await import("../lib/themePreference");
});

afterAll(async () => {
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  await window.happyDOM.close();
});

let root: Root | null = null;
let host: HTMLElement;

beforeEach(() => {
  window.localStorage.clear();
  os.scheme = "dark";
  os.listeners.clear();
  delete window.document.documentElement.dataset.theme;
  store.resetThemeStore();
  host = window.document.createElement("div") as unknown as HTMLElement;
  window.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) await act(() => root!.unmount());
  root = null;
  host.remove();
});

async function mount() {
  root = createRoot(host);
  await act(() => root!.render(createElement(ThemeControl)));
}

const option = (p: string) => host.querySelector(`[data-theme-option="${p}"]`) as HTMLButtonElement;
const checked = () => [...host.querySelectorAll('[role="radio"]')].find((b) => b.getAttribute("aria-checked") === "true")?.textContent;
const shown = () => window.document.documentElement.dataset.theme;

describe("ThemeControl", () => {
  test("offers Light, Dark and System, with System picked by default", async () => {
    await mount();
    expect([...host.querySelectorAll('[role="radio"]')].map((b) => b.textContent)).toEqual(["Light", "Dark", "System"]);
    expect(checked()).toBe("System");
  });

  test("a pick applies at once and is stored", async () => {
    store.initTheme();
    await mount();
    expect(shown()).toBe("dark");
    await act(() => option("light").click());
    expect(shown()).toBe("light");
    expect(checked()).toBe("Light");
    expect(window.localStorage.getItem(prefs.THEME_STORAGE_KEY)).toBe("light");
    await act(() => option("dark").click());
    expect(shown()).toBe("dark");
    expect(window.localStorage.getItem(prefs.THEME_STORAGE_KEY)).toBe("dark");
  });

  test("the stored pick survives a reload", async () => {
    store.initTheme();
    await mount();
    await act(() => option("light").click());
    await act(() => root!.unmount());
    root = null;
    // A reload: fresh page state, the boot script, then the app.
    store.resetThemeStore();
    delete window.document.documentElement.dataset.theme;
    window.eval(prefs.THEME_BOOT_SCRIPT);
    expect(shown()).toBe("light");
    store.initTheme();
    await mount();
    expect(checked()).toBe("Light");
    expect(shown()).toBe("light");
  });

  test("System follows the OS, live", async () => {
    store.initTheme();
    await mount();
    expect(shown()).toBe("dark");
    await act(() => os.set("light"));
    expect(shown()).toBe("light");
    await act(() => os.set("dark"));
    expect(shown()).toBe("dark");
  });

  test("System keeps following the OS after the control unmounts", async () => {
    store.initTheme();
    await mount();
    await act(() => root!.unmount());
    root = null;
    os.set("light");
    expect(shown()).toBe("light");
  });

  test("a pick made in another tab shows here too", async () => {
    store.initTheme();
    await mount();
    window.localStorage.setItem(prefs.THEME_STORAGE_KEY, "light");
    await act(() => {
      globalThis.window.dispatchEvent(new window.StorageEvent("storage", { key: prefs.THEME_STORAGE_KEY, newValue: "light" }) as unknown as StorageEvent);
    });
    expect(shown()).toBe("light");
    expect(checked()).toBe("Light");
  });

  test("ArrowLeft wraps from the first option to the last, and focus follows the pick", async () => {
    store.initTheme();
    await mount();
    await act(() => option("light").click());
    const group = host.querySelector('[role="radiogroup"]')!;
    await act(() => {
      group.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }) as unknown as Event);
    });
    expect(checked()).toBe("System");
    expect(window.document.activeElement?.getAttribute("data-theme-option")).toBe("system");
  });

  test("an explicit pick ignores the OS", async () => {
    store.initTheme();
    await mount();
    await act(() => option("dark").click());
    await act(() => os.set("light"));
    expect(shown()).toBe("dark");
  });

  test("going back to System clears the stored pick and follows the OS again", async () => {
    os.scheme = "light";
    store.initTheme();
    await mount();
    await act(() => option("dark").click());
    expect(shown()).toBe("dark");
    await act(() => option("system").click());
    expect(window.localStorage.getItem(prefs.THEME_STORAGE_KEY)).toBeNull();
    expect(shown()).toBe("light");
  });

  test("arrow keys move the pick", async () => {
    store.initTheme();
    await mount();
    const group = host.querySelector('[role="radiogroup"]')!;
    await act(() => {
      group.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }) as unknown as Event);
    });
    expect(checked()).toBe("Light");
    expect(shown()).toBe("light");
  });
});

describe("ThemeToggle", () => {
  /** The top bar's toggle beside the You tab's Appearance control, as one page shows them. */
  async function mountBoth() {
    root = createRoot(host);
    await act(() => root!.render(createElement("div", null, createElement(ThemeToggle), createElement(ThemeControl))));
  }
  const toggle = () => host.querySelector("[data-theme-toggle]") as HTMLButtonElement;

  test("is a labelled button that says the current pick and the next one", async () => {
    store.initTheme();
    await mountBoth();
    expect(toggle().tagName).toBe("BUTTON");
    expect(toggle().getAttribute("type")).toBe("button");
    expect(toggle().getAttribute("aria-label")).toBe("Color theme: System (dark). Switch to Light");
  });

  test("each press applies and stores the next pick, Light → Dark → System", async () => {
    store.initTheme();
    await mountBoth();
    await act(() => toggle().click());
    expect(shown()).toBe("light");
    expect(window.localStorage.getItem(prefs.THEME_STORAGE_KEY)).toBe("light");
    expect(toggle().getAttribute("aria-label")).toBe("Color theme: Light. Switch to Dark");
    await act(() => toggle().click());
    expect(shown()).toBe("dark");
    expect(window.localStorage.getItem(prefs.THEME_STORAGE_KEY)).toBe("dark");
    await act(() => toggle().click());
    expect(toggle().dataset.themeToggle).toBe("system");
    expect(window.localStorage.getItem(prefs.THEME_STORAGE_KEY)).toBeNull();
  });

  test("a press moves the Appearance control's pick, and a pick there moves the toggle", async () => {
    store.initTheme();
    await mountBoth();
    await act(() => toggle().click());
    expect(checked()).toBe("Light");
    await act(() => option("dark").click());
    expect(toggle().dataset.themeToggle).toBe("dark");
    expect(toggle().getAttribute("aria-label")).toBe("Color theme: Dark. Switch to System");
  });

  test("follows a pick made in another tab", async () => {
    store.initTheme();
    await mountBoth();
    window.localStorage.setItem(prefs.THEME_STORAGE_KEY, "light");
    await act(() => {
      globalThis.window.dispatchEvent(new window.StorageEvent("storage", { key: prefs.THEME_STORAGE_KEY, newValue: "light" }) as unknown as StorageEvent);
    });
    expect(toggle().dataset.themeToggle).toBe("light");
    expect(checked()).toBe("Light");
  });

  test("the stored pick survives a reload", async () => {
    store.initTheme();
    await mountBoth();
    await act(() => toggle().click());
    await act(() => root!.unmount());
    root = null;
    store.resetThemeStore();
    delete window.document.documentElement.dataset.theme;
    window.eval(prefs.THEME_BOOT_SCRIPT);
    store.initTheme();
    await mountBoth();
    expect(shown()).toBe("light");
    expect(toggle().dataset.themeToggle).toBe("light");
  });
});

describe("the boot script", () => {
  test("applies a stored pick before the app loads", () => {
    window.localStorage.setItem(prefs.THEME_STORAGE_KEY, "light");
    window.eval(prefs.THEME_BOOT_SCRIPT);
    expect(shown()).toBe("light");
  });

  test("with no stored pick follows the OS", () => {
    os.scheme = "light";
    window.eval(prefs.THEME_BOOT_SCRIPT);
    expect(shown()).toBe("light");
    os.scheme = "dark";
    window.eval(prefs.THEME_BOOT_SCRIPT);
    expect(shown()).toBe("dark");
  });

  test("falls back to dark without matchMedia", () => {
    const real = window.matchMedia;
    (window as unknown as { matchMedia: unknown }).matchMedia = undefined;
    try {
      window.eval(prefs.THEME_BOOT_SCRIPT);
      expect(shown()).toBe("dark");
      expect(prefs.systemTheme()).toBe("dark");
    } finally {
      (window as unknown as { matchMedia: unknown }).matchMedia = real;
    }
  });

  test("ignores an unknown stored value", () => {
    window.localStorage.setItem(prefs.THEME_STORAGE_KEY, "sepia");
    os.scheme = "light";
    window.eval(prefs.THEME_BOOT_SCRIPT);
    expect(shown()).toBe("light");
    expect(prefs.readThemePreference()).toBe("system");
  });
});
