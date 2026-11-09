import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { GlobalWindow } from "happy-dom";
import type { GraphData } from "./knowledgeGraph";
import { palettes } from "./theme";

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
  "ResizeObserver",
  "localStorage",
] as const;
const saved = new Map<string, unknown>();

const sigmas: FakeSigma[] = [];

/** A stand-in for Sigma (which needs WebGL) that records what the canvas asks of it. */
class FakeSigma {
  readonly settingsSet: [string, unknown][] = [];
  refreshes = 0;
  constructor(private readonly graph: unknown) {
    sigmas.push(this);
  }
  setSetting(key: string, value: unknown) {
    this.settingsSet.push([key, value]);
  }
  refresh() {
    this.refreshes++;
  }
  getGraph() {
    return this.graph;
  }
  on() {}
  kill() {}
}

let act: (fn: () => void | Promise<void>) => Promise<void>;
let createRoot: (el: Element) => Root;
let mod: typeof import("./KnowledgeGraphCanvas");
let store: typeof import("../hooks/useTheme");

beforeAll(async () => {
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = (window as unknown as Record<string, unknown>)[name];
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  mock.module("sigma", () => ({ default: FakeSigma }));
  ({ act } = (await import("react")) as unknown as { act: typeof act });
  ({ createRoot } = await import("react-dom/client"));
  mod = await import("./KnowledgeGraphCanvas");
  store = await import("../hooks/useTheme");
});

afterAll(async () => {
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  await window.happyDOM.close();
});

describe("the graph canvas's colors", () => {
  test("dark draws with the dark palette's graph inks", () => {
    const dark = mod.canvasColors("dark");
    expect(dark.palette).toBe(palettes.dark);
    expect(dark.label).toBe("#c9ccd6");
    expect(dark.muted).toBe("#6b7080");
  });

  test("light draws with the light palette and its graph inks", () => {
    const light = mod.canvasColors("light");
    expect(light.palette).toBe(palettes.light);
    expect(light.label).toBe(palettes.light.graphLabel);
    expect(light.muted).toBe(palettes.light.graphMuted);
    expect(light.label).not.toBe(mod.canvasColors("dark").label);
    expect(light.muted).not.toBe(mod.canvasColors("dark").muted);
  });
});

describe("the graph canvas on a theme switch", () => {
  let host: HTMLElement;
  let root: Root;

  afterEach(async () => {
    await act(() => root.unmount());
    host.remove();
    store.resetThemeStore();
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
    sigmas.length = 0;
  });

  test("relabels the renderer in the new palette's ink and redraws it", async () => {
    store.setThemePreference("dark");
    const graph: GraphData = {
      nodes: [{ id: "a", slug: "a", title: "A", projectId: "p", originClass: "authored" }],
      edges: [],
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(() =>
      root.render(
        createElement(mod.default, {
          graph,
          positions: { a: { x: 0, y: 0 } },
          visible: graph,
          nodeColor: () => palettes.dark.dim,
          nodeSize: () => 4,
          edgeColor: () => palettes.dark.dim,
          deemphasized: new Set<string>(),
          focus: null,
          selected: null,
          forcedLabels: new Set<string>(),
          onHoverNode: () => {},
          onHoverEdge: () => {},
          onClickNode: () => {},
          onClickEdge: () => {},
          onClickStage: () => {},
        })
      )
    );
    expect(sigmas).toHaveLength(1);
    const sigma = sigmas[0]!;
    const refreshesBefore = sigma.refreshes;
    sigma.settingsSet.length = 0;

    await act(async () => store.setThemePreference("light"));

    expect(sigmas).toHaveLength(1);
    expect(sigma.settingsSet).toEqual([["labelColor", { color: palettes.light.graphLabel }]]);
    expect(sigma.refreshes).toBeGreaterThan(refreshesBefore);
  });
});
