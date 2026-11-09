import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalWindow } from "happy-dom";
import type { Mermaid, MermaidConfig } from "mermaid";
import { mermaidFenceSource, type HastNode } from "./mermaidFence";

const window = new GlobalWindow({ url: "http://localhost/" });
const GLOBALS = ["window", "document", "Node", "HTMLElement", "Element", "XMLSerializer", "MutationObserver"] as const;
const saved = new Map<string, unknown>();

let mod: typeof import("./mermaid");

beforeAll(async () => {
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = (window as unknown as Record<string, unknown>)[name];
  }
  mod = await import("./mermaid");
});

afterAll(async () => {
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  await window.happyDOM.close();
});

const SVG = '<svg id="x" width="100%" viewBox="0 0 320 120" style="max-width: 320px;" xmlns="http://www.w3.org/2000/svg"><g><text>A</text></g></svg>';

/** A stand-in for Mermaid that records what it was asked to do. */
function fakeMermaid(render: (id: string, source: string) => Promise<{ svg: string }>) {
  const calls = { loads: 0, configs: [] as MermaidConfig[], renders: [] as string[] };
  const m = {
    initialize: (config: MermaidConfig) => calls.configs.push(config),
    render: (id: string, source: string) => {
      calls.renders.push(source);
      return render(id, source);
    },
  } as unknown as Mermaid;
  const load = async () => {
    calls.loads++;
    return m;
  };
  return { calls, load };
}

function pre(language: string | undefined, text: string): HastNode {
  return {
    type: "element",
    tagName: "pre",
    children: [
      {
        type: "element",
        tagName: "code",
        properties: language ? { className: [`language-${language}`] } : {},
        children: [{ type: "text", value: text }],
      },
    ],
  };
}

describe("mermaid fence detection", () => {
  test("only a mermaid language counts, however it is cased or spaced", () => {
    expect(mod.isMermaidLanguage("mermaid")).toBe(true);
    expect(mod.isMermaidLanguage(" Mermaid ")).toBe(true);
    for (const other of ["", "ts", "mermaid-js", "mmd", null, undefined]) expect(mod.isMermaidLanguage(other)).toBe(false);
  });

  test("a ```mermaid block's source is its code, without the closing newline", () => {
    expect(mermaidFenceSource(pre("mermaid", "flowchart LR\n  A --> B\n"))).toBe("flowchart LR\n  A --> B");
    expect(mermaidFenceSource(pre("Mermaid", "pie\n"))).toBe("pie");
  });

  test("any other block, and a non-code <pre>, is not a diagram", () => {
    expect(mermaidFenceSource(pre("ts", "const a = 1;\n"))).toBeUndefined();
    expect(mermaidFenceSource(pre(undefined, "flowchart LR\n"))).toBeUndefined();
    expect(mermaidFenceSource({ type: "element", tagName: "pre", children: [{ type: "text", value: "mermaid" }] })).toBeUndefined();
    expect(mermaidFenceSource(undefined)).toBeUndefined();
  });
});

describe("createMermaidRenderer", () => {
  test("Mermaid is not loaded until a diagram is drawn, and then once", async () => {
    const { calls, load } = fakeMermaid(async () => ({ svg: SVG }));
    const render = mod.createMermaidRenderer(load);
    expect(calls.loads).toBe(0);
    await render("flowchart LR\n A --> B");
    await render("flowchart LR\n B --> C");
    expect(calls.loads).toBe(1);
    expect(calls.configs).toHaveLength(1);
  });

  test("Mermaid runs strict, with SVG labels, and directives can't loosen either", async () => {
    const { calls, load } = fakeMermaid(async () => ({ svg: SVG }));
    await mod.createMermaidRenderer(load)("flowchart LR\n A --> B");
    const config = calls.configs[0]!;
    expect(config.securityLevel).toBe("strict");
    expect(config.htmlLabels).toBe(false);
    expect(config.startOnLoad).toBe(false);
    expect(config.flowchart?.htmlLabels).toBe(false);
    expect(config.secure).toEqual(expect.arrayContaining(["secure", "securityLevel", "htmlLabels", "themeCSS", "themeVariables", "fontFamily"]));
  });

  test("a drawn diagram is an SVG image at the size Mermaid drew it", async () => {
    const { load } = fakeMermaid(async () => ({ svg: SVG }));
    const result = await mod.createMermaidRenderer(load)("flowchart LR\n A --> B");
    if (result.kind !== "svg") throw new Error(`expected an svg, got ${JSON.stringify(result)}`);
    expect(result.width).toBe(320);
    expect(result.height).toBe(120);
    expect(result.src.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    const xml = decodeURIComponent(result.src.slice(result.src.indexOf(",") + 1));
    expect(xml).toContain('width="320"');
    expect(xml).toContain('height="120"');
    expect(xml).not.toContain("max-width");
    expect(xml).toContain("<text>A</text>");
  });

  test("a diagram that doesn't parse resolves to a short note of its error", async () => {
    const { load } = fakeMermaid(async () => {
      throw new Error("Parse error on line 2:\n...A -->> -->\n-----^\nExpecting 'SEMI', got 'ARROW'");
    });
    const result = await mod.createMermaidRenderer(load)("flowchart LR\n A -->> -->");
    expect(result).toEqual({ kind: "error", message: "Parse error on line 2: Expecting 'SEMI', got 'ARROW'" });
  });

  test("an SVG without a size is an error, not a broken image", async () => {
    const { load } = fakeMermaid(async () => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' }));
    expect((await mod.createMermaidRenderer(load)("pie\n")).kind).toBe("error");
  });

  test("a failed load is an error for that render, and the next render loads again", async () => {
    let attempts = 0;
    const { load } = fakeMermaid(async () => ({ svg: SVG }));
    const render = mod.createMermaidRenderer(async () => {
      if (++attempts === 1) throw new Error("Failed to fetch dynamically imported module");
      return load();
    });
    const first = await render("flowchart LR\n A --> B");
    expect(first.kind).toBe("error");
    if (first.kind === "error") expect(first.message).toContain("the diagram renderer didn't load");
    expect((await render("flowchart LR\n A --> B")).kind).toBe("svg");
    expect(attempts).toBe(2);
  });

  test("a source already drawn is not drawn again", async () => {
    const { calls, load } = fakeMermaid(async () => ({ svg: SVG }));
    const render = mod.createMermaidRenderer(load);
    await render("flowchart LR\n A --> B");
    await render("flowchart LR\n A --> B");
    expect(calls.renders).toHaveLength(1);
  });

  test("a source drawn under one palette is configured and drawn again under the other", async () => {
    // The fake draws the theme it was last configured with, so each palette's image differs.
    const fake = fakeMermaid(async () => ({
      svg: SVG.replace("<text>A</text>", `<text>${fake.calls.configs.at(-1)?.theme}</text>`),
    }));
    const { calls } = fake;
    const render = mod.createMermaidRenderer(fake.load);
    const source = "flowchart LR\n A --> B";

    const dark = await render(source, "dark");
    expect(calls.configs.map((c) => c.theme)).toEqual(["dark"]);
    const light = await render(source, "light");
    expect(calls.configs.map((c) => c.theme)).toEqual(["dark", "default"]);
    expect(calls.renders).toHaveLength(2);
    if (dark.kind !== "svg" || light.kind !== "svg") throw new Error("expected both palettes to draw");
    expect(light.src).not.toBe(dark.src);

    // Each palette's drawing is cached on its own: switching back draws nothing new.
    const darkAgain = await render(source, "dark");
    const lightAgain = await render(source, "light");
    expect(calls.renders).toHaveLength(2);
    expect(darkAgain.kind === "svg" && darkAgain.src).toBe(dark.src);
    expect(lightAgain.kind === "svg" && lightAgain.src).toBe(light.src);
  });

  test("a diagram drawn with no palette named follows the page's data-theme", async () => {
    const { calls, load } = fakeMermaid(async () => ({ svg: SVG }));
    const render = mod.createMermaidRenderer(load);
    const root = document.documentElement;
    const before = root.dataset.theme;
    try {
      root.dataset.theme = "dark";
      await render("flowchart LR\n A --> B");
      root.dataset.theme = "light";
      await render("flowchart LR\n A --> B");
      expect(calls.configs.map((c) => c.theme)).toEqual(["dark", "default"]);
      expect(calls.renders).toHaveLength(2);
    } finally {
      if (before === undefined) delete root.dataset.theme;
      else root.dataset.theme = before;
    }
  });

  test("errorNote keeps a long first line short", () => {
    expect(mod.errorNote(new Error("x".repeat(500))).length).toBe(200);
    expect(mod.errorNote("plain")).toBe("plain");
    expect(mod.errorNote("first\n----^")).toBe("first");
  });

  test("a draw that never finishes times out, and the next render of that source tries again", async () => {
    let draws = 0;
    const { load } = fakeMermaid(() => (++draws === 1 ? new Promise(() => {}) : Promise.resolve({ svg: SVG })));
    const render = mod.createMermaidRenderer(load, { timeoutMs: 20 });
    const first = await render("flowchart LR\n A --> B");
    expect(first.kind).toBe("error");
    if (first.kind === "error") expect(first.message).toContain("took longer");
    expect((await render("flowchart LR\n A --> B")).kind).toBe("svg");
  });

  test("draws run one at a time, so a diagram's timeout counts only its own drawing", async () => {
    let active = 0;
    let most = 0;
    const { load } = fakeMermaid(async () => {
      most = Math.max(most, ++active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      return { svg: SVG };
    });
    const render = mod.createMermaidRenderer(load, { timeoutMs: 40 });
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => render(`pie\n n${i}`)));
    expect(most).toBe(1);
    // Six draws of 15ms each take 90ms in all, longer than one timeout: none timed out.
    expect(results.map((r) => r.kind)).toEqual(["svg", "svg", "svg", "svg", "svg", "svg"]);
  });

  test("a Mermaid that is no longer usable (its frame gone) is loaded again", async () => {
    let up = true;
    const { calls, load } = fakeMermaid(async () => ({ svg: SVG }));
    const render = mod.createMermaidRenderer(load, { alive: () => up });
    await render("pie\n a");
    up = false;
    await render("pie\n b");
    expect(calls.loads).toBe(2);
  });

  test("the cache lets go of the least recently used diagram", async () => {
    const { calls, load } = fakeMermaid(async () => ({ svg: SVG }));
    const render = mod.createMermaidRenderer(load);
    await render("flowchart LR\n keep");
    for (let i = 0; i < 64; i++) {
      await render(`flowchart LR\n n${i}`);
      await render("flowchart LR\n keep");
    }
    const keepDraws = () => calls.renders.filter((s) => s.endsWith("keep")).length;
    expect(keepDraws()).toBe(1);
    await render("flowchart LR\n n0");
    expect(calls.renders.filter((s) => s.endsWith("n0"))).toHaveLength(2);
  });
});

describe("the frame Mermaid runs in", () => {
  test("its page may run only its own scripts and load nothing from anywhere", () => {
    const html = readFileSync(join(import.meta.dir, "../../mermaid-frame.html"), "utf8");
    const policy = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1];
    expect(policy).toBeString();
    const directives = new Map(policy!.split(";").map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name!, values]));
    expect(directives.get("default-src")).toEqual(["'none'"]);
    expect(directives.get("script-src")).toEqual(["'self'"]);
    expect(directives.get("img-src")).toEqual(["data:"]);
    expect(directives.get("font-src")).toEqual(["data:"]);
    // Nothing else is allowed to fetch (connect, frames, media, objects fall back to default-src).
    for (const name of directives.keys()) expect(["default-src", "script-src", "style-src", "img-src", "font-src", "base-uri", "form-action"]).toContain(name);
    expect(html).toContain('src="/src/mermaidFrame.ts"');
  });

  test("the frame loader hands over the frame's Mermaid, kept off screen at a real size", async () => {
    const realCreate = document.createElement.bind(document);
    const fake = { render: async () => ({ svg: SVG }) };
    let frame: HTMLIFrameElement | undefined;
    document.createElement = ((tag: string) => {
      const el = realCreate(tag);
      if (tag === "iframe") frame = el as HTMLIFrameElement;
      return el;
    }) as typeof document.createElement;
    try {
      const loading = mod.loadMermaidFrame();
      expect(frame!.getAttribute("src")).toBe(mod.FRAME_PATH);
      expect(frame!.getAttribute("aria-hidden")).toBe("true");
      expect(frame!.style.visibility).toBe("hidden");
      expect(frame!.style.width).toBe("1600px");
      expect(frame!.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
      Object.defineProperty(frame!, "contentWindow", { value: { standupMermaid: fake, document: { title: mod.FRAME_TITLE } } });
      frame!.dispatchEvent(new (window.Event as unknown as typeof Event)("load"));
      expect(await loading).toBe(fake as never);
      expect(mod.mermaidFrameAlive()).toBe(true);
      frame!.remove();
      expect(mod.mermaidFrameAlive()).toBe(false);
    } finally {
      document.createElement = realCreate as typeof document.createElement;
      frame?.remove();
    }
  });

  test("a frame whose page didn't start is an error, and goes away", async () => {
    const realCreate = document.createElement.bind(document);
    let frame: HTMLIFrameElement | undefined;
    document.createElement = ((tag: string) => {
      const el = realCreate(tag);
      if (tag === "iframe") frame = el as HTMLIFrameElement;
      return el;
    }) as typeof document.createElement;
    try {
      const loading = mod.loadMermaidFrame();
      // The console's own page (a server's fallback for a missing frame page) is not the frame, whatever it holds.
      Object.defineProperty(frame!, "contentWindow", { value: { standupMermaid: {}, document: { title: "Standup" } } });
      frame!.dispatchEvent(new (window.Event as unknown as typeof Event)("load"));
      await expect(loading).rejects.toThrow("didn't start");
      expect(frame!.isConnected).toBe(false);
    } finally {
      document.createElement = realCreate as typeof document.createElement;
    }
  });

  test("an error from the frame (another window's Error) still gives its message", () => {
    const foreign = Object.create(null) as { message: string };
    foreign.message = "Parse error on line 1:\n^\nExpecting 'X'";
    expect(mod.errorNote(foreign)).toBe("Parse error on line 1: Expecting 'X'");
  });
});

describe("createMermaidPreview (the doc editor's code-block preview)", () => {
  test("any other block has no preview and never draws", () => {
    const drawn: string[] = [];
    const preview = mod.createMermaidPreview(async (source) => {
      drawn.push(source);
      return { kind: "error", message: "unused" };
    });
    const applied: unknown[] = [];
    expect(preview("ts", "const a = 1;", (v) => applied.push(v))).toBeNull();
    expect(preview("", "flowchart LR", (v) => applied.push(v))).toBeNull();
    expect(preview("mermaid", "  \n", (v) => applied.push(v))).toBeNull();
    expect(drawn).toEqual([]);
    expect(applied).toEqual([]);
  });

  test("a mermaid block previews asynchronously as an image, or as a note when it doesn't parse", async () => {
    const preview = mod.createMermaidPreview(async (source) =>
      source.includes("bad") ? { kind: "error", message: "Parse error on line 1:" } : { kind: "svg", src: "data:image/svg+xml,x", width: 10, height: 5 }
    );
    const applied: (HTMLElement | null)[] = [];
    expect(preview("mermaid", "flowchart LR", (v) => applied.push(v))).toBeUndefined();
    expect(preview("mermaid", "bad", (v) => applied.push(v))).toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(applied[0]!.querySelector("img")!.getAttribute("src")).toBe("data:image/svg+xml,x");
    expect(applied[1]!.querySelector("img")).toBeNull();
    expect(applied[1]!.textContent).toBe("Couldn't draw this diagram: Parse error on line 1:");
  });

  test("previews apply in the order they were asked for, whichever draw finishes first", async () => {
    const preview = mod.createMermaidPreview(
      (source) =>
        new Promise((done) =>
          setTimeout(() => done({ kind: "error", message: source }), source === "slow" ? 20 : 0)
        )
    );
    const order: string[] = [];
    preview("mermaid", "slow", (v) => order.push(v!.textContent!));
    preview("mermaid", "fast", (v) => order.push(v!.textContent!));
    await new Promise((r) => setTimeout(r, 50));
    expect(order).toEqual(["Couldn't draw this diagram: slow", "Couldn't draw this diagram: fast"]);
  });

  const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
  const echo = async (source: string): Promise<import("./mermaid").MermaidResult> => ({ kind: "error", message: source });

  test("typing in a block draws only once the typing pauses, and only its latest text", async () => {
    const drawn: string[] = [];
    const block = document.createElement("div");
    const preview = mod.createMermaidPreview(
      (s) => {
        drawn.push(s);
        return echo(s);
      },
      { debounceMs: 30, typingIn: () => block, stillHolds: () => true }
    );
    const applied: string[] = [];
    for (const text of ["flowchart LR\n A", "flowchart LR\n A -", "flowchart LR\n A --> B"]) {
      expect(preview("mermaid", text, (v) => applied.push(v!.textContent!))).toBeUndefined();
      await tick(5);
    }
    expect(drawn).toEqual([]);
    await tick(60);
    expect(drawn).toEqual(["flowchart LR\n A --> B"]);
    expect(applied).toEqual(["Couldn't draw this diagram: flowchart LR\n A --> B"]);
  });

  test("blocks remounted together while one holds the focus are all drawn", async () => {
    const block = document.createElement("div");
    const preview = mod.createMermaidPreview(echo, { debounceMs: 10, typingIn: () => block, stillHolds: () => true });
    const applied: string[] = [];
    for (const text of ["pie\n a", "pie\n b", "pie\n c"]) preview("mermaid", text, (v) => applied.push(v!.textContent!));
    await tick(40);
    expect(applied).toHaveLength(3);
  });

  test("a block that stops being a diagram is cleared after any draw still in flight", async () => {
    let finish: (() => void) | undefined;
    const preview = mod.createMermaidPreview(
      (s) => new Promise((done) => (finish = () => done({ kind: "error", message: s }))),
      { typingIn: () => null }
    );
    const values: (HTMLElement | null)[] = [];
    preview("mermaid", "flowchart LR\n A", (v) => values.push(v));
    expect(preview("ts", "flowchart LR\n A", (v) => values.push(v))).toBeNull();
    await tick();
    finish!();
    await tick();
    expect(values).toHaveLength(2);
    expect(values[1]).toBeNull();
  });

  test("changing a typed block's language before its draw cancels the draw", async () => {
    const drawn: string[] = [];
    const block = document.createElement("div");
    const preview = mod.createMermaidPreview(
      (s) => {
        drawn.push(s);
        return echo(s);
      },
      { debounceMs: 20, typingIn: () => block, stillHolds: () => true }
    );
    const values: (HTMLElement | null)[] = [];
    preview("mermaid", "flowchart LR\n A", (v) => values.push(v));
    await tick(5);
    expect(preview("ts", "flowchart LR\n A", (v) => values.push(v))).toBeNull();
    await tick(40);
    expect(drawn).toEqual([]);
    expect(values).toEqual([]);
  });

  /** A Crepe-like code block holding `text`, one line element per line as CodeMirror renders it. */
  function codeBlock(text: string): HTMLElement {
    const block = document.createElement("div");
    block.className = "milkdown-code-block";
    const content = document.createElement("div");
    content.className = "cm-content";
    content.tabIndex = 0;
    for (const line of text.split("\n")) {
      const el = document.createElement("div");
      el.textContent = line;
      content.appendChild(el);
    }
    block.appendChild(content);
    document.body.appendChild(block);
    return block;
  }

  test("only a change whose text is the focused block's counts as typing in it", async () => {
    const a = codeBlock("pie\n a");
    const b = codeBlock("pie\n b");
    try {
      (a.querySelector(".cm-content") as HTMLElement).focus();
      const applied: string[] = [];
      const preview = mod.createMermaidPreview(echo, { debounceMs: 30 });
      preview("mermaid", "pie\n a", (v) => applied.push(v!.textContent!));
      // A change to another block while `a` has the focus: drawn at once, and `a`'s change still stands.
      preview("mermaid", "pie\n b", (v) => applied.push(v!.textContent!));
      await tick(5);
      expect(applied).toEqual(["Couldn't draw this diagram: pie\n b"]);
      await tick(50);
      expect(applied).toEqual(["Couldn't draw this diagram: pie\n b", "Couldn't draw this diagram: pie\n a"]);
    } finally {
      a.remove();
      b.remove();
    }
  });

  test("a waiting typed change is dropped when its block no longer holds that text", async () => {
    const a = codeBlock("pie\n a");
    try {
      (a.querySelector(".cm-content") as HTMLElement).focus();
      const drawn: string[] = [];
      const preview = mod.createMermaidPreview(
        (s) => {
          drawn.push(s);
          return echo(s);
        },
        { debounceMs: 20 }
      );
      preview("mermaid", "pie\n a", () => {});
      a.remove();
      await tick(40);
      expect(drawn).toEqual([]);
    } finally {
      a.remove();
    }
  });

  /** A drawing of `source` that names the palette the page showed when it was drawn. */
  const drawing = (source: string): import("./mermaid").MermaidResult => ({
    kind: "svg",
    src: `data:image/svg+xml,${document.documentElement.dataset.theme ?? "dark"}:${encodeURIComponent(source)}`,
    width: 10,
    height: 5,
  });

  /** An editor that shows each preview the way Crepe does: a copy of it, set as the panel's HTML. */
  function editorPanel() {
    const editor = document.createElement("div");
    editor.className = "milkdown";
    const panel = document.createElement("div");
    editor.appendChild(panel);
    document.body.appendChild(editor);
    return {
      apply: (value: HTMLElement | null) => (panel.innerHTML = value ? value.outerHTML : ""),
      shown: () => panel.querySelector("img")?.getAttribute("src"),
      remove: () => editor.remove(),
    };
  }

  test("a palette switch draws the previews on the page again in the new palette", async () => {
    document.documentElement.dataset.theme = "dark";
    const panel = editorPanel();
    try {
      const preview = mod.createMermaidPreview(async (s) => drawing(s), { typingIn: () => null });
      preview("mermaid", "pie\n a", panel.apply);
      await tick();
      expect(panel.shown()).toBe("data:image/svg+xml,dark:pie%0A%20a");
      document.documentElement.dataset.theme = "light";
      await tick();
      expect(panel.shown()).toBe("data:image/svg+xml,light:pie%0A%20a");
    } finally {
      panel.remove();
      document.documentElement.dataset.theme = "dark";
    }
  });

  test("a draw the palette switches under is shown in the new palette", async () => {
    document.documentElement.dataset.theme = "dark";
    const panel = editorPanel();
    try {
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      const drawnFor: string[] = [];
      const preview = mod.createMermaidPreview(
        async (s) => {
          const result = drawing(s);
          drawnFor.push(document.documentElement.dataset.theme!);
          await held;
          return result;
        },
        { typingIn: () => null }
      );
      preview("mermaid", "pie\n a", panel.apply);
      await tick();
      document.documentElement.dataset.theme = "light";
      await tick();
      release();
      await tick();
      expect(drawnFor).toEqual(["dark", "light"]);
      expect(panel.shown()).toBe("data:image/svg+xml,light:pie%0A%20a");
    } finally {
      panel.remove();
      document.documentElement.dataset.theme = "dark";
    }
  });

  test("a block whose language changes without the focus in it drops its waiting typed change", async () => {
    const a = codeBlock("pie\n a");
    try {
      (a.querySelector(".cm-content") as HTMLElement).focus();
      const drawn: string[] = [];
      const preview = mod.createMermaidPreview(
        (s) => {
          drawn.push(s);
          return echo(s);
        },
        { debounceMs: 20 }
      );
      preview("mermaid", "pie\n a", () => {});
      (document.activeElement as HTMLElement).blur();
      await tick(5);
      expect(preview("ts", "pie\n a", () => {})).toBeNull();
      await tick(40);
      expect(drawn).toEqual([]);
    } finally {
      a.remove();
    }
  });
});
