import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalWindow } from "happy-dom";
import { lineDiff } from "@standup/shared";
import type { Nodes, Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

/*
 * Markdown is the docs' storage format, so whatever the editor loads it must
 * write back with the same meaning. Each fixture is loaded into the real doc
 * editor (Crepe with the features the Docs tab uses) and serialized again,
 * and both sides are parsed with remark + GFM and compared as syntax trees,
 * positions stripped. Formatting may change (bullet characters, escapes);
 * structure, text, URLs, titles and alt text may not.
 */

const window = new GlobalWindow({ url: "http://localhost/docs" });
const GLOBALS = [
  "window",
  "document",
  "navigator",
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
  "XMLSerializer",
  "Range",
  "Selection",
  "getSelection",
] as const;
const saved = new Map<string, unknown>();

/**
 * Crepe draws a code block's editor (and its preview) only once the block is
 * in view, which happy-dom never reports. While this is set, every block
 * observed counts as in view as soon as it is watched.
 */
let blocksInView = false;
class InViewObserver {
  constructor(private readonly callback: (entries: { target: Element; isIntersecting: boolean }[]) => void) {}
  observe(target: Element) {
    if (blocksInView) setTimeout(() => this.callback([{ target, isIntersecting: true }]), 0);
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

let buildDocEditor: typeof import("./docEditorSetup").buildDocEditor;
let codeKeptShownCss: typeof import("./docEditorSetup").codeKeptShownCss;
let minimalMarkdown: typeof import("./minimalDiff").minimalMarkdown;
let COMMENT_SHORTCUT: string;
let COMMENT_ARIA_SHORTCUT: string;

beforeAll(async () => {
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    const value = (window as unknown as Record<string, unknown>)[name];
    (globalThis as Record<string, unknown>)[name] = typeof value === "function" && /^[a-z]/.test(name) ? value.bind(window) : value;
  }
  globalThis.IntersectionObserver = InViewObserver as unknown as typeof IntersectionObserver;
  // happy-dom doesn't run mermaid-frame.html, so a mermaid block's preview
  // frame hands over a fake Mermaid. Without it the frame never starts and
  // the shared renderer waits out its start timeout, holding up the next
  // test file that draws a diagram.
  const { FRAME_TITLE } = await import("../../lib/mermaid");
  const mermaid = {
    initialize: () => {},
    render: async () => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><rect width="120" height="40"/></svg>' }),
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
  ({ buildDocEditor, codeKeptShownCss } = await import("./docEditorSetup"));
  ({ minimalMarkdown } = await import("./minimalDiff"));
  ({ COMMENT_SHORTCUT, COMMENT_ARIA_SHORTCUT } = await import("./commentIcon"));
});

afterAll(async () => {
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  await window.happyDOM.close();
});

const parser = unified().use(remarkParse).use(remarkGfm);

/** The markdown's syntax tree with positions stripped. */
function tree(markdown: string): Root {
  const strip = (node: Nodes): unknown => {
    const { position: _position, ...rest } = node as Nodes & { position?: unknown };
    const out: Record<string, unknown> = { ...rest };
    if ("children" in node) out.children = (node.children as Nodes[]).map(strip);
    return out;
  };
  return strip(parser.parse(markdown)) as Root;
}

/**
 * `root` with each link and image reference replaced by the inline link or
 * image its definition gives, and the definitions removed: what a reference
 * means, in the form the editor writes it.
 */
function inlineReferences(root: Root): Root {
  const definitions = new Map<string, { url: string; title: string | null }>();
  for (const node of root.children) {
    if (node.type === "definition") definitions.set(node.identifier, { url: node.url, title: node.title ?? null });
  }
  const resolve = (node: Nodes): Nodes => {
    if (node.type === "linkReference") {
      const { url, title } = definitions.get(node.identifier)!;
      return { type: "link", url, title, children: node.children.map(resolve) } as Nodes;
    }
    if (node.type === "imageReference") {
      const { url, title } = definitions.get(node.identifier)!;
      return { type: "image", url, title, alt: node.alt } as Nodes;
    }
    if ("children" in node) return { ...node, children: (node.children as Nodes[]).map(resolve) } as Nodes;
    return node;
  };
  return { ...root, children: root.children.filter((n) => n.type !== "definition").map(resolve) } as Root;
}

/** Loads `markdown` into the doc editor and returns what it serializes back. */
async function roundTrip(markdown: string): Promise<string> {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const crepe = buildDocEditor({ root, markdown, resolveImage: (src) => src, uploadImage: async () => "" });
  await crepe.create();
  try {
    return crepe.getMarkdown();
  } finally {
    await crepe.destroy();
    root.remove();
  }
}

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");

describe("doc editor markdown round trip", () => {
  for (const name of ["constructs.md", "research-note.md", "html.md", "footnotes.md", "breaks.md", "escapes.md", "diagrams.md"]) {
    test(`${name} keeps its meaning`, async () => {
      const source = fixture(name);
      const written = await roundTrip(source);
      expect(tree(written)).toEqual(tree(source));
    });
  }

  /*
   * Reference-style links and images: Milkdown's commonmark preset inlines
   * every reference through its definition (remark-inline-links) and has no
   * node for a definition, so a save writes `[text](url "title")` in place of
   * `[text][label]` and drops the `[label]: url` lines, including any no
   * reference uses. What each link and image points at survives; the
   * reference form and unused definitions don't.
   */
  test.failing("references.md keeps its reference-style links and definitions", async () => {
    const source = fixture("references.md");
    expect(tree(await roundTrip(source))).toEqual(tree(source));
  });

  test("references.md keeps every link's and image's target, title and text", async () => {
    const source = fixture("references.md");
    expect(tree(await roundTrip(source))).toEqual(inlineReferences(tree(source)));
  });

  test("agent-note.md keeps its meaning", async () => {
    const source = fixture("agent-note.md");
    expect(tree(await roundTrip(source))).toEqual(tree(source));
  });

  /*
   * What a save writes (minimalMarkdown over the editor's serialization):
   * an untouched document is its stored text byte for byte, and a
   * one-sentence edit changes one line, where the serialization as it
   * stands rewrites every table, escape and list gap.
   */
  for (const name of ["agent-note.md", "constructs.md", "research-note.md", "html.md", "footnotes.md", "breaks.md", "escapes.md", "diagrams.md"]) {
    test(`${name}: saving what was just loaded writes the stored text unchanged`, async () => {
      const source = fixture(name);
      expect(minimalMarkdown(source, await roundTrip(source))).toBe(source);
    });
  }

  test("references.md: saving what was just loaded writes what the editor means, references inlined", async () => {
    const source = fixture("references.md");
    const serialized = await roundTrip(source);
    expect(tree(minimalMarkdown(source, serialized))).toEqual(tree(serialized));
  });

  test("agent-note.md: a one-sentence edit changes one line of the stored text", async () => {
    const source = fixture("agent-note.md");
    const sentence = "The in-process cache wins on tail latency by an order of magnitude.";
    const serialized = await roundTrip(source);
    expect(serialized).toContain(sentence);
    const edited = serialized.replace(sentence, "The in-process cache wins on tail latency by an order of magnitude, at every percentile.");
    const saved = minimalMarkdown(source, edited);
    const changed = (a: string, b: string) => lineDiff(a, b).filter((l) => l.type !== "same").length;
    console.log(`agent-note.md one-sentence edit: serialization changes ${changed(source, edited)} diff lines, minimal save changes ${changed(source, saved)}`);
    expect(changed(source, saved)).toBe(2);
    expect(saved).toBe(source.replace(sentence, "The in-process cache wins on tail latency by an order of magnitude, at every percentile."));
    expect(tree(saved)).toEqual(tree(edited));
  });

  test("an image alone in its paragraph keeps its alt text and title", async () => {
    const written = await roundTrip('![Architecture diagram](diagram.png "Caption")\n');
    expect(tree(written)).toEqual(tree('![Architecture diagram](diagram.png "Caption")\n'));
  });

  test("bullets are written with `-`, the common hand-written style", async () => {
    expect(await roundTrip("- one\n- two\n  - nested\n")).toBe("- one\n- two\n  - nested\n");
  });

  test("serializing what was just loaded is stable", async () => {
    const once = await roundTrip(fixture("research-note.md"));
    expect(await roundTrip(once)).toBe(once);
  });
});

describe("doc editor mermaid blocks", () => {
  test("a mermaid block opens with its code hidden behind the toggle; any other block shows its code", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    // A source no other test file draws: the shared renderer's cache outlives this file.
    const markdown = "```mermaid\nflowchart LR\n  Editor --> Preview\n```\n\n```ts\nconst a = 1;\n```\n";
    const crepe = buildDocEditor({ root, markdown, resolveImage: (src) => src, uploadImage: async () => "" });
    blocksInView = true;
    await crepe.create();
    try {
      // The diagram's preview lands too, so no draw is still in flight once the window is gone.
      for (let i = 0; i < 100 && (root.querySelectorAll(".codemirror-host").length < 2 || !root.querySelector(".standup-mermaid img")); i++)
        await new Promise((r) => setTimeout(r, 10));
      expect(root.querySelectorAll(".codemirror-host")).toHaveLength(2);
      // A frame that never loaded would leave the shared renderer waiting on it for the next test file.
      expect(root.querySelector(".standup-mermaid img")).not.toBeNull();
      const blocks = [...root.querySelectorAll(".milkdown-code-block")];
      expect(blocks).toHaveLength(2);
      const [mermaid, ts] = blocks;
      expect(mermaid.querySelector(".codemirror-host")!.classList.contains("hidden")).toBe(true);
      expect(mermaid.querySelector(".preview-toggle-button")!.textContent).toContain("Edit");
      expect(ts.querySelector(".codemirror-host")!.classList.contains("hidden")).toBe(false);
      expect(ts.querySelector(".preview-toggle-button")).toBeNull();
      expect(crepe.getMarkdown()).toBe(markdown);
    } finally {
      blocksInView = false;
      await crepe.destroy();
      root.remove();
    }
  });

  /*
   * The blocks below are laid out as Crepe lays out a code block whose code
   * is hidden, under Crepe's own code-block stylesheet and the editor's rules,
   * and read through the computed style the browser would show.
   */
  const crepeCss = readFileSync(require.resolve("@milkdown/crepe/theme/common/code-mirror.css"), "utf8");
  const shownIn = (preview: string, focused = false) => {
    const scope = document.createElement("div");
    scope.className = "scope";
    scope.innerHTML =
      `<style>${crepeCss}\n${codeKeptShownCss("scope")}</style>` +
      `<div class="milkdown"><div class="milkdown-code-block">` +
      `<div class="tools"><button class="preview-toggle-button">Edit</button></div>` +
      `<div class="codemirror-host hidden"><div class="cm-editor${focused ? " cm-focused" : ""}"></div></div>` +
      `<div class="preview-panel"><div class="preview">${preview}</div></div>` +
      `</div></div>`;
    document.body.appendChild(scope);
    const host = getComputedStyle(scope.querySelector(".codemirror-host")!);
    const toggle = getComputedStyle(scope.querySelector(".preview-toggle-button")!);
    const shown = { display: host.display, height: host.height, overflow: host.overflow, toggle: toggle.display };
    scope.remove();
    return shown;
  };
  const drawn = '<div class="standup-mermaid"><img alt="Mermaid diagram"></div>';
  const broken = '<div class="standup-mermaid"><div class="standup-mermaid-error">Couldn\'t draw this diagram</div></div>';

  test("a drawn diagram's code is folded away, not display:none, so the cursor can still land in it", () => {
    expect(shownIn(drawn)).toEqual({ display: "block", height: "0px", overflow: "hidden", toggle: "inline-block" });
  });

  test("a drawn diagram's code unfolds while the cursor is in it", () => {
    expect(shownIn(drawn, true)).toMatchObject({ display: "block", height: "auto", overflow: "visible" });
  });

  test("a diagram that can't be drawn keeps its code shown, with no toggle", () => {
    expect(shownIn(broken)).toEqual({ display: "block", height: "auto", overflow: "visible", toggle: "none" });
  });
});

describe("doc editor selection toolbar", () => {
  /** The editor's toolbar items, by key, once it is up; `onComment` given or not. */
  async function toolbarItems(onComment?: () => void): Promise<{ items: HTMLElement[]; done: () => Promise<void> }> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const crepe = buildDocEditor({ root, markdown: "Hello world.\n", resolveImage: (src) => src, uploadImage: async () => "", ...(onComment ? { onComment } : {}) });
    await crepe.create();
    await new Promise((r) => setTimeout(r, 0));
    const items = [...root.querySelectorAll(".milkdown-toolbar [data-toolbar-item]")] as HTMLElement[];
    return {
      items,
      done: async () => {
        await crepe.destroy();
        root.remove();
      },
    };
  }

  test("with onComment, Comment is the toolbar's last item, an icon named Comment, and runs onComment", async () => {
    let runs = 0;
    const { items, done } = await toolbarItems(() => runs++);
    try {
      const comment = items.at(-1)!;
      expect(comment.getAttribute("data-toolbar-item")).toBe("comment");
      expect([comment.getAttribute("aria-label"), comment.getAttribute("title"), comment.getAttribute("aria-keyshortcuts"), comment.textContent!.trim()]).toEqual([
        "Comment",
        `Comment (${COMMENT_SHORTCUT})`,
        COMMENT_ARIA_SHORTCUT,
        "",
      ]);
      // Crepe's icon element; it passes the SVG through DOMPurify, which keeps nothing under happy-dom.
      expect(comment.querySelector(".milkdown-icon")).not.toBeNull();
      // Crepe runs an item on pointerdown, so the editor's selection is still there when it does.
      comment.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, cancelable: true }) as unknown as Event);
      expect(runs).toBe(1);
    } finally {
      await done();
    }
  });

  test("without onComment the toolbar has no Comment item", async () => {
    const { items, done } = await toolbarItems();
    try {
      expect(items.map((i) => i.getAttribute("data-toolbar-item"))).not.toContain("comment");
      expect(items.length).toBeGreaterThan(0);
    } finally {
      await done();
    }
  });
});
