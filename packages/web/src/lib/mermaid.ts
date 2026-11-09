import type { Mermaid, MermaidConfig } from "mermaid";
import { theme, type ThemeName } from "../components/theme";
import { appliedTheme } from "./themePreference";

/*
 * Mermaid diagrams for docs: a ```mermaid fence renders as a picture of its
 * diagram. Mermaid is large, so it is fetched only the first time a diagram
 * is drawn; a doc without one never loads it.
 *
 * Doc content can come from agents, so a diagram is untrusted input. Mermaid
 * runs at securityLevel "strict" (no click handlers, labels as SVG text
 * rather than HTML), and the SVG it draws is shown through an <img>: the
 * browser renders an image's SVG without running scripts or fetching
 * anything, whatever the markup holds. Mermaid lays a diagram out in a live
 * page first, though, and some syntax names a URL it loads there (a
 * flowchart image node, a sequence participant's icon). So Mermaid runs in a
 * page of its own, mermaid-frame.html, in a hidden frame: that page's policy
 * lets it load nothing, and only the SVG's text comes back out of it.
 *
 * An image can't read the page's CSS variables, so a diagram is drawn in
 * Mermaid's own theme for the palette showing (see mermaidConfig), and drawn
 * again when the palette switches.
 */

const CONFIG: MermaidConfig = {
  startOnLoad: false,
  securityLevel: "strict",
  htmlLabels: false,
  flowchart: { htmlLabels: false },
  // A broken diagram throws instead of drawing Mermaid's error picture into the page.
  suppressErrorRendering: true,
  // Directives in a diagram (%%{init: …}%%, front-matter config) can't change
  // these: Mermaid drops a secure key at any depth of a directive.
  secure: [
    "secure",
    "securityLevel",
    "startOnLoad",
    "maxTextSize",
    "suppressErrorRendering",
    "maxEdges",
    "htmlLabels",
    "themeCSS",
    "themeVariables",
    "fontFamily",
    "altFontFamily",
    "fontSize",
    "dompurifyConfig",
  ],
};

/** Mermaid's theme for each palette: its dark one, and its default (light) one. */
const MERMAID_THEMES = { dark: "dark", light: "default" } as const satisfies Record<ThemeName, MermaidConfig["theme"]>;

/** The config Mermaid draws with while palette `name` is showing. */
export function mermaidConfig(name: ThemeName): MermaidConfig {
  return { ...CONFIG, theme: MERMAID_THEMES[name] };
}

/** How long one diagram may take to draw before it counts as failed. */
const RENDER_TIMEOUT_MS = 10_000;

export type MermaidResult =
  | { kind: "svg"; src: string; width: number; height: number }
  | { kind: "error"; message: string };

/** Whether a fence's language names a Mermaid diagram. */
export function isMermaidLanguage(language: string | null | undefined): boolean {
  return language?.trim().toLowerCase() === "mermaid";
}

/** The page Mermaid runs in, and its <title>. */
export const FRAME_PATH = "/mermaid-frame.html";
export const FRAME_TITLE = "Diagram renderer";

/** How long the frame may take to start before drawing counts as failed. */
const FRAME_TIMEOUT_MS = 30_000;

/** The frame Mermaid was last started in; a frame taken off the page takes its Mermaid with it. */
let mermaidFrame: HTMLIFrameElement | undefined;

/** Whether the frame Mermaid was started in is still on the page and running. */
export function mermaidFrameAlive(): boolean {
  return !!mermaidFrame?.isConnected && !!mermaidFrame.contentWindow;
}

/**
 * Starts Mermaid in a hidden frame on mermaid-frame.html and resolves to it
 * once the page's script has run. The frame keeps a real size, off screen,
 * since Mermaid measures text as it lays a diagram out. Its sandbox keeps it
 * from opening windows, navigating the console or submitting forms; it stays
 * same-origin so the console can call into it.
 */
export function loadMermaidFrame(): Promise<Mermaid> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
    frame.src = FRAME_PATH;
    frame.title = "Diagram renderer";
    frame.tabIndex = -1;
    frame.setAttribute("aria-hidden", "true");
    Object.assign(frame.style, {
      position: "fixed",
      left: "-10000px",
      top: "0",
      width: "1600px",
      height: "1200px",
      border: "0",
      visibility: "hidden",
      pointerEvents: "none",
    });
    const fail = (message: string) => {
      clearTimeout(timer);
      frame.remove();
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail("the diagram frame didn't start"), FRAME_TIMEOUT_MS);
    frame.addEventListener(
      "load",
      () => {
        // Anything but the frame page (a server answering with the console's own index.html, say) is refused.
        const page = frame.contentWindow as (Window & { standupMermaid?: Mermaid }) | null;
        const m = page?.document?.title === FRAME_TITLE ? page.standupMermaid : undefined;
        if (!m) return fail("the diagram frame didn't start");
        clearTimeout(timer);
        mermaidFrame = frame;
        resolve(m);
      },
      { once: true }
    );
    document.body.appendChild(frame);
  });
}

/**
 * A render error as a short note: the first line, plus the last when there
 * are more (a parse error is "Parse error on line N:", an ASCII pointer, then
 * what was expected). Errors from the frame are another window's, so this
 * reads `message` rather than asking `instanceof Error`.
 */
export function errorNote(err: unknown): string {
  const message = (err as { message?: unknown } | null)?.message;
  const text = typeof message === "string" ? message : String(err);
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const first = lines[0] ?? "unknown error";
  const last = lines.length > 1 ? lines[lines.length - 1]! : undefined;
  const note = last && !/^[-.^\s]*$/.test(last) ? `${first} ${last}` : first;
  return note.length > 200 ? `${note.slice(0, 199)}…` : note;
}

/**
 * The SVG Mermaid returned, as an image: a data URL plus the size it was
 * drawn at. The markup is parsed in an inert <template> (nothing in it runs
 * or loads) and re-serialized as XML, which an SVG image requires.
 */
function svgImage(svg: string): { src: string; width: number; height: number } {
  const template = document.createElement("template");
  template.innerHTML = svg;
  const root = template.content.querySelector("svg");
  if (!root) throw new Error("Mermaid returned no SVG");
  const [, , width = 0, height = 0] = (root.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  if (!(width > 0 && height > 0)) throw new Error("Mermaid returned an SVG without a size");
  root.setAttribute("width", String(width));
  root.setAttribute("height", String(height));
  root.removeAttribute("style");
  const xml = new XMLSerializer().serializeToString(root);
  return { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`, width, height };
}

/** How many drawn diagrams to remember, so a re-render (or retyping a source) doesn't draw again. */
const CACHE_SIZE = 64;

class RenderTimeout extends Error {}

/** One diagram to draw: its source, the palette it is drawn for, and its cache key. */
interface DrawJob {
  source: string;
  palette: ThemeName;
  key: string;
}

/**
 * A diagram renderer over `load`, which fetches Mermaid; it is first called
 * by the first diagram that gets as far as drawing. The renderer never
 * rejects: a diagram that can't be drawn resolves to an error. A failed
 * fetch, and a draw that timed out, are tried again by the next render of
 * that source. A diagram is drawn for a palette (the one showing, unless
 * one is named) and remembered per palette.
 */
export function createMermaidRenderer(
  load: () => Promise<Mermaid>,
  {
    timeoutMs = RENDER_TIMEOUT_MS,
    alive = () => true,
  }: {
    timeoutMs?: number;
    /** Whether the Mermaid `load` gave is still usable; when not, the next render loads it again. */
    alive?: () => boolean;
  } = {}
): (source: string, palette?: ThemeName) => Promise<MermaidResult> {
  let loading: Promise<Mermaid> | undefined;
  let loaded = false;
  /** Drawn diagrams, by palette and source. */
  const cache = new Map<string, Promise<MermaidResult>>();
  /** The palette each loaded Mermaid was last configured for. */
  const configured = new WeakMap<Mermaid, ThemeName>();
  let nextId = 0;
  /** The draw in progress, or the last one: draws run one at a time. */
  let drawing: Promise<unknown> = Promise.resolve();

  const mermaid = () => {
    if (loaded && !alive()) {
      loading = undefined;
      loaded = false;
    }
    if (!loading) {
      const started = load().then((m) => {
        if (loading === started) loaded = true;
        return m;
      });
      // A failed load is let go (once, by whichever render sees it first) so the next render tries again.
      started.catch(() => {
        if (loading === started) loading = undefined;
      });
      loading = started;
    }
    return loading;
  };

  /** Lets go of a cached result that failed for a passing reason, unless a newer one has replaced it. */
  const forget = (key: string, result: Promise<MermaidResult>) => {
    if (cache.get(key) === result) cache.delete(key);
  };

  /**
   * Draws one diagram once the draws before it are done, so its timeout
   * counts only its own drawing. The timeout stops waiting for a draw that
   * stalls; it can't stop Mermaid itself, which also draws one diagram at a
   * time, so a stalled draw holds up the ones after it until it ends.
   */
  const draw = (m: Mermaid, job: DrawJob, self: () => Promise<MermaidResult>): Promise<MermaidResult> => {
    const turn = drawing.then(() => drawNow(m, job, self));
    drawing = turn;
    return turn;
  };

  const drawNow = async (m: Mermaid, { source, palette, key }: DrawJob, self: () => Promise<MermaidResult>): Promise<MermaidResult> => {
    const id = `standup-mermaid-${++nextId}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Draws run one at a time, so configuring here holds for this draw alone.
      if (configured.get(m) !== palette) {
        m.initialize(mermaidConfig(palette));
        configured.set(m, palette);
      }
      const rendering = m.render(id, source);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RenderTimeout(`it took longer than ${timeoutMs / 1000}s to draw`)), timeoutMs);
      });
      const { svg } = await Promise.race([rendering, timeout]);
      return { kind: "svg", ...svgImage(svg) };
    } catch (err) {
      if (err instanceof RenderTimeout) forget(key, self());
      return { kind: "error", message: errorNote(err) };
    } finally {
      clearTimeout(timer);
    }
  };

  return (source, palette = appliedTheme()) => {
    const key = `${palette}\n${source}`;
    const hit = cache.get(key);
    if (hit) {
      // Most recently used last, so the oldest unused diagram is the one let go.
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const self = () => result;
    const result: Promise<MermaidResult> = mermaid().then(
      (m) => draw(m, { source, palette, key }, self),
      (err: unknown): MermaidResult => {
        forget(key, result);
        return { kind: "error", message: `the diagram renderer didn't load (${errorNote(err)})` };
      }
    );
    cache.set(key, result);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
    return result;
  };
}

export const renderMermaid = createMermaidRenderer(loadMermaidFrame, { alive: mermaidFrameAlive });

/**
 * The CSS width a diagram drawn `width` pixels wide is shown at: its own
 * width when that fits, else the column's, but never under three quarters
 * of its own, so a wide diagram (a sequence diagram with many participants)
 * scrolls sideways in its container rather than shrinking its text past
 * reading.
 */
export function diagramWidth(width: number): string {
  return `min(${width}px, max(100%, ${Math.round(width * 0.75)}px))`;
}

/** The note shown under a diagram that couldn't be drawn. */
export function errorText(message: string): string {
  return `Couldn't draw this diagram: ${message}`;
}

/** The doc editor code block holding the focus, if any. */
function focusedCodeBlock(): Element | null {
  return document.activeElement?.closest(".milkdown-code-block") ?? null;
}

/** A code block's text as its editor shows it (one element per line), whitespace dropped for comparing. */
function blockText(block: Element): string {
  return (block.querySelector(".cm-content")?.textContent ?? "").replace(/\s+/g, "");
}

/** Whether `content` is what `block` holds now, so a change to `content` was made in it. */
function holds(block: Element, content: string): boolean {
  return block.isConnected && blockText(block) === content.replace(/\s+/g, "");
}

/** Calls made in one task (an editor mounting or replacing its blocks) share a number. */
function taskCounter(): () => number {
  let task = 0;
  let scheduled = false;
  return () => {
    if (!scheduled) {
      scheduled = true;
      setTimeout(() => {
        task++;
        scheduled = false;
      }, 0);
    }
    return task;
  };
}

/**
 * The doc editor's code-block preview (Crepe's `renderPreview`): a mermaid
 * block shows its diagram under the code, or a note when it doesn't parse;
 * any other block has no preview.
 *
 * Crepe calls this on every change to a block and says nothing of which
 * block it is. A change whose text is what the focused block holds is that
 * block being typed in: it waits `debounceMs` for the next keystroke, which
 * replaces it, so a half-typed line isn't drawn, and it is dropped when it
 * comes due if the block no longer holds that text (it changed again, or
 * was replaced). A replace while a block holds the focus calls once for
 * every block in the same task; those never replace one another. Draws run
 * one at a time and apply in the order they were asked for, so an earlier
 * version of a block never lands over a later one, and a block that stops
 * being a diagram is cleared after any draw still in flight.
 */
export function createMermaidPreview(
  render: (source: string) => Promise<MermaidResult>,
  {
    debounceMs = 250,
    typingIn = (content: string) => {
      const block = focusedCodeBlock();
      return block && holds(block, content) ? block : null;
    },
    stillHolds = holds,
  }: {
    debounceMs?: number;
    /** The block a change with this text was typed in, or null when it wasn't typed. */
    typingIn?: (content: string) => Element | null;
    /** Whether the block still holds the text a waiting change was made with. */
    stillHolds?: (block: Element, content: string) => boolean;
  } = {}
) {
  let queue: Promise<unknown> = Promise.resolve();
  /** Previews asked for and not yet applied. */
  let outstanding = 0;
  /** The typed changes waiting out their debounce, by block. */
  const waiting = new Map<Element, { task: number; timer: ReturnType<typeof setTimeout> }[]>();
  const currentTask = taskCounter();

  /**
   * Draws `content` in the palette the page shows once the draw is done: a
   * draw the palette switched under is drawn again, since the switch has
   * already passed over the previews on the page.
   */
  const drawInShownPalette = async (content: string): Promise<MermaidResult> => {
    for (;;) {
      const palette = appliedTheme();
      const result = await render(content);
      if (result.kind !== "svg" || appliedTheme() === palette) return result;
    }
  };

  const enqueue = (content: string, apply: (value: HTMLElement | null) => void) => {
    const drawn = queue.then(() => drawInShownPalette(content)).catch((err: unknown): MermaidResult => ({ kind: "error", message: errorNote(err) }));
    queue = drawn;
    void drawn.then((result) => {
      outstanding--;
      if (result.kind === "svg") followTheme(result.src, content);
      apply(previewElement(result));
    });
  };

  /**
   * The source each drawn preview shows, by its image's src. Crepe shows a
   * sanitized copy of the preview element, not the element itself, so a
   * palette switch finds the previews on the page by their src and draws
   * each again in place; the next change to a block draws it anew anyway.
   */
  const shownSources = new Map<string, string>();
  let watching = false;
  let shownPalette: ThemeName | undefined;
  const followTheme = (src: string, content: string) => {
    shownSources.delete(src);
    shownSources.set(src, content);
    if (shownSources.size > PREVIEW_SOURCES_KEPT) shownSources.delete(shownSources.keys().next().value as string);
    if (watching || typeof MutationObserver === "undefined") return;
    watching = true;
    shownPalette = appliedTheme();
    new MutationObserver(() => {
      if (appliedTheme() === shownPalette) return;
      shownPalette = appliedTheme();
      for (const img of document.querySelectorAll<HTMLImageElement>(PREVIEW_IMAGE_SELECTOR)) {
        const source = shownSources.get(img.getAttribute("src") ?? "");
        if (source === undefined) continue;
        void drawInShownPalette(source).then((result) => {
          if (result.kind !== "svg" || !img.isConnected) return;
          followTheme(result.src, source);
          showDiagram(img, result);
        });
      }
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  };

  return (language: string, content: string, apply: (value: HTMLElement | null) => void): null | undefined => {
    const block = typingIn(content);
    const task = currentTask();
    /** Drops `of`'s typed changes from earlier tasks: this call is newer. */
    const supersede = (of: Element) => {
      const earlier = waiting.get(of) ?? [];
      const kept = earlier.filter((w) => w.task === task);
      for (const w of earlier) {
        if (w.task === task) continue;
        clearTimeout(w.timer);
        outstanding--;
      }
      if (kept.length) waiting.set(of, kept);
      else waiting.delete(of);
    };
    if (block) supersede(block);
    if (!isMermaidLanguage(language) || !content.trim()) {
      // A block whose language changed without the focus in it: a waiting
      // change of its, made with this same text, would otherwise draw on it.
      if (!block) for (const of of [...waiting.keys()]) if (stillHolds(of, content)) supersede(of);
      if (outstanding > 0) queue = queue.then(() => apply(null));
      return null;
    }
    outstanding++;
    if (!block) {
      enqueue(content, apply);
      return undefined;
    }
    const entry = {
      task,
      timer: setTimeout(() => {
        const rest = (waiting.get(block) ?? []).filter((w) => w !== entry);
        if (rest.length) waiting.set(block, rest);
        else waiting.delete(block);
        if (stillHolds(block, content)) enqueue(content, apply);
        else outstanding--;
      }, debounceMs),
    };
    waiting.set(block, [...(waiting.get(block) ?? []), entry]);
    return undefined;
  };
}

export const mermaidPreview = createMermaidPreview(renderMermaid);

/** How many previews' sources are kept for drawing again on a palette switch. */
const PREVIEW_SOURCES_KEPT = 256;

/** A drawn preview's image, as shown in the doc editor. */
const PREVIEW_IMAGE_SELECTOR = ".milkdown .standup-mermaid img";

/** Shows a drawn diagram in `img`, at the size it was drawn. */
function showDiagram(img: HTMLImageElement, result: Extract<MermaidResult, { kind: "svg" }>): void {
  img.src = result.src;
  img.width = result.width;
  img.height = result.height;
  img.style.width = diagramWidth(result.width);
}

/**
 * The preview element for a drawn diagram, or the reason it couldn't be
 * drawn: the block's code stays in the editor above it either way.
 */
function previewElement(result: MermaidResult): HTMLElement {
  const box = document.createElement("div");
  box.className = "standup-mermaid";
  if (result.kind === "svg") {
    const img = document.createElement("img");
    img.alt = "Mermaid diagram";
    showDiagram(img, result);
    img.style.maxWidth = "none";
    img.style.height = "auto";
    box.style.overflowX = "auto";
    box.appendChild(img);
    return box;
  }
  const note = document.createElement("div");
  note.className = "standup-mermaid-error";
  note.textContent = errorText(result.message);
  note.style.fontSize = "12px";
  note.style.color = theme.waiting;
  box.appendChild(note);
  return box;
}
