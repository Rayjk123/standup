import { languages } from "@codemirror/language-data";
import { CrepeBuilder } from "@milkdown/crepe/builder";
import { blockEdit } from "@milkdown/crepe/feature/block-edit";
import { codeMirror } from "@milkdown/crepe/feature/code-mirror";
import { cursor } from "@milkdown/crepe/feature/cursor";
import { imageBlock } from "@milkdown/crepe/feature/image-block";
import { linkTooltip } from "@milkdown/crepe/feature/link-tooltip";
import { listItem } from "@milkdown/crepe/feature/list-item";
import { placeholder } from "@milkdown/crepe/feature/placeholder";
import { table } from "@milkdown/crepe/feature/table";
import { toolbar } from "@milkdown/crepe/feature/toolbar";
import { imageBlockSchema } from "@milkdown/kit/component/image-block";
import { commandsCtx, editorViewCtx, remarkStringifyOptionsCtx, type Editor } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { uploadConfig } from "@milkdown/kit/plugin/upload";
import { clearTextInCurrentBlockCommand } from "@milkdown/kit/preset/commonmark";
import { Slice, type Node as ProseNode } from "@milkdown/kit/prose/model";
import { Selection } from "@milkdown/kit/prose/state";
import { codeMirrorTheme } from "../../lib/codeMirrorTheme";
import { mermaidPreview } from "../../lib/mermaid";
import { COMMENT_ARIA_SHORTCUT, COMMENT_ICON, COMMENT_LABEL, COMMENT_SHORTCUT } from "./commentIcon";

/*
 * The doc editor: Milkdown's Crepe with headings, emphasis, lists (task lists
 * included), links, code blocks, tables and images. Math and the AI features
 * are left out, so a `$` in prose stays text and the chunk carries no KaTeX.
 * Markdown is the storage format: what the editor serializes is what is saved.
 */

export interface DocEditorOptions {
  root: HTMLElement;
  /** The doc's markdown, without its frontmatter. */
  markdown: string;
  /**
   * The URL an image `src` (as written in the markdown) displays from. The
   * markdown keeps the src as written; only the rendered `<img>` uses this.
   */
  resolveImage: (src: string) => string;
  /**
   * Stores an uploaded or pasted image and returns the src to write for it.
   * `first` is false for a file after the first of one paste or drop, whose
   * refusal is reported beside the earlier ones.
   */
  uploadImage: (file: File, first?: boolean) => Promise<string>;
  /** Starts a comment on the selected passage; given, the selection toolbar gets a Comment item after its own. */
  onComment?: () => void;
}

/**
 * Keeps an image's alt text through the editor. Crepe turns an image that is
 * alone in its paragraph into an image block, which reads the markdown alt
 * as its display size ratio and writes the ratio back in its place
 * (`![1.00](src)`), so a document's alt text would be lost on its first save.
 * Here the block keeps the alt as written and writes it back; the display
 * size stays the editor's own (it is not part of the markdown).
 */
export function keepImageAlt(editor: Editor): Editor {
  return editor.config((ctx) => {
    ctx.update(imageBlockSchema.key, (prev) => (innerCtx) => {
      const base = prev(innerCtx);
      return {
        ...base,
        attrs: { ...base.attrs, alt: { default: "", validate: "string" } },
        parseDOM: base.parseDOM?.map((rule) => ({
          ...rule,
          getAttrs: (dom: HTMLElement | string) => {
            const attrs = typeof rule.getAttrs === "function" ? rule.getAttrs(dom as HTMLElement) : {};
            const alt = typeof dom === "string" ? "" : (dom.getAttribute("alt") ?? "");
            return attrs === false ? false : { ...(attrs ?? {}), alt };
          },
        })),
        parseMarkdown: {
          match: ({ type }) => type === "image-block",
          runner: (state, node, type) => {
            state.addNode(type, {
              src: node.url as string,
              caption: (node.title as string | null) ?? "",
              alt: (node.alt as string | null) ?? "",
              ratio: 1,
            });
          },
        },
        toMarkdown: {
          match: (node) => node.type.name === "image-block",
          runner: (state, node) => {
            state.openNode("paragraph");
            state.addNode("image", undefined, undefined, {
              title: node.attrs.caption || null,
              url: node.attrs.src,
              alt: node.attrs.alt ?? "",
            });
            state.closeNode();
          },
        },
      };
    });
  });
}

/**
 * A block with a preview hides its code until its toggle shows it. Crepe
 * hides it with `display: none !important`, which CodeMirror can't take focus
 * under; here the hidden code is folded to no height instead, so the cursor
 * can still land in it (arrowing into the block, or typing a new one).
 */
const CODE_FOLDED_SELECTOR = ".milkdown-code-block .codemirror-host.hidden";
/**
 * The code unfolds while the diagram can't be drawn (the preview is then the
 * note saying why, and the toggle is left out), and while the cursor is in
 * the code, so a block being typed doesn't vanish once it first draws.
 */
const CODE_KEPT_SHOWN_SELECTORS = [
  ".milkdown-code-block:has(.standup-mermaid-error) .codemirror-host.hidden",
  ".milkdown-code-block:has(.cm-editor.cm-focused) .codemirror-host.hidden",
];
const TOGGLE_LEFT_OUT_SELECTOR = ".milkdown-code-block:has(.standup-mermaid-error) .preview-toggle-button";

/** The rules for the selectors above, under the editor's `scope` class. */
export function codeKeptShownCss(scope: string): string {
  const under = (s: string) => `.${scope} .milkdown ${s}`;
  return [
    `${under(CODE_FOLDED_SELECTOR)} { display: block !important; height: 0; overflow: hidden; }`,
    `${CODE_KEPT_SHOWN_SELECTORS.map(under).join(",\n")} { height: auto; overflow: visible; }`,
    `${under(TOGGLE_LEFT_OUT_SELECTOR)} { display: none; }`,
    "",
  ].join("\n");
}

/** The image types the picker offers: the ones a doc stores. */
export const IMAGE_PICKER_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";

/**
 * Opens the browser's file picker for one image, through a hidden file input
 * that is gone once the picker closes. Resolves with the file, or null when
 * the person cancels.
 */
export function pickImageFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = IMAGE_PICKER_ACCEPT;
    input.hidden = true;
    input.setAttribute("data-testid", "doc-image-picker");
    const done = (file: File | null) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener("change", () => done(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => done(null), { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

/** Where the image a picker's paste hands over goes, when not at the selection. */
const pickedInsertPos = new WeakMap<Event, number>();

/** A paste of `file` alone, as the clipboard would hand it over. */
function filePaste(file: File): ClipboardEvent {
  const data = new DataTransfer();
  data.items.add(file);
  return new ClipboardEvent("paste", { clipboardData: data });
}

/**
 * The slash menu's Image item: it clears the typed command and opens the
 * file picker. The picked file is handed to the upload plugin as a paste
 * there, so it takes the pasted files' path: a placeholder marks the spot
 * (and follows any edit made while the upload runs), and the image block
 * replaces it once the image is stored. Typed on a line of its own, the
 * command leaves that line empty: the line goes, and the image takes its
 * place between the blocks around it (an empty line would be saved as a
 * `<br />`). A cancelled pick inserts nothing, and a refused upload only
 * drops the placeholder (uploadImage reports why).
 */
export function imageMenuRun(pick: () => Promise<File | null> = pickImageFile) {
  return (ctx: Ctx) => {
    ctx.get(commandsCtx).call(clearTextInCurrentBlockCommand.key);
    void pick()
      .then((file) => {
        if (!file) return;
        const view = ctx.get(editorViewCtx);
        const paste = filePaste(file);
        const { $from } = view.state.selection;
        if ($from.depth === 1 && $from.parent.type.name === "paragraph" && $from.parent.content.size === 0) {
          const before = $from.before();
          // The last line stays, after the image, as the line to type on (an empty last line isn't saved).
          if ($from.index(0) < view.state.doc.childCount - 1) {
            const tr = view.state.tr.delete(before, $from.after());
            // The cursor goes into the nearest text, never onto an image beside the line.
            const at = tr.doc.resolve(before);
            const text = Selection.findFrom(at, 1, true) ?? Selection.findFrom(at, -1, true);
            view.dispatch(text ? tr.setSelection(text) : tr);
          }
          pickedInsertPos.set(paste, before);
        }
        view.someProp("handlePaste", (handle) => handle(view, paste, Slice.empty));
      })
      // An editor gone while the picker was open has nowhere to put the image.
      .catch(() => {});
  };
}

/** Builds (but doesn't create) the doc editor; call `create()` on the result. */
export function buildDocEditor({ root, markdown, resolveImage, uploadImage, onComment }: DocEditorOptions): CrepeBuilder {
  const crepe = new CrepeBuilder({ root, defaultValue: markdown });
  crepe
    .addFeature(cursor)
    .addFeature(listItem)
    .addFeature(linkTooltip)
    .addFeature(imageBlock, { onUpload: uploadImage, proxyDomURL: resolveImage })
    .addFeature(blockEdit, {
      buildMenu: (builder) => {
        const item = builder.getGroup("advanced").group.items.find((i) => i.key === "image");
        if (item) item.onRun = imageMenuRun();
      },
    })
    .addFeature(placeholder, { text: "Write something…" })
    // The toolbar shows only over a non-empty selection, so Comment is offered only when there is text to comment on.
    .addFeature(toolbar, {
      buildToolbar: (builder) => {
        if (!onComment) return;
        builder.addGroup("comment", COMMENT_LABEL).addItem("comment", {
          icon: COMMENT_ICON,
          label: COMMENT_LABEL,
          shortcut: COMMENT_SHORTCUT,
          ariaKeyshortcuts: COMMENT_ARIA_SHORTCUT,
          active: () => false,
          onRun: () => onComment(),
        });
      },
    })
    // A mermaid block shows its diagram, its code a click away (see codeKeptShownCss);
    // the stored markdown is the code alone.
    .addFeature(codeMirror, { theme: codeMirrorTheme, languages, renderPreview: mermaidPreview, previewOnlyByDefault: true })
    .addFeature(table);
  keepImageAlt(crepe.editor);
  // A pasted, dropped or picked file becomes an image block once stored. Each
  // file goes through uploadImage, which refuses (and reports) anything a doc
  // can't hold; a refused file inserts nothing, and its upload placeholder goes.
  crepe.editor.config((ctx) =>
    ctx.update(uploadConfig.key, (prev) => ({
      ...prev,
      getInsertPos: (event, _ctx, pos) => pickedInsertPos.get(event) ?? pos,
      uploader: async (files, schema) => {
        const nodes: ProseNode[] = [];
        for (const [i, file] of Array.from(files).entries()) {
          const src = await uploadImage(file, i === 0).catch(() => null);
          const node = src === null ? null : schema.nodes["image-block"]?.createAndFill({ src });
          if (node) nodes.push(node);
        }
        return nodes;
      },
    }))
  );
  // `-` bullets, the common hand-written style, so a save rewrites fewer lines.
  crepe.editor.config((ctx) => ctx.update(remarkStringifyOptionsCtx, (prev) => ({ ...prev, bullet: "-" as const })));
  return crepe;
}
