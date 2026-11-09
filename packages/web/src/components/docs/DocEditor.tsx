import { useEffect, useRef } from "react";
import { replaceAll } from "@milkdown/kit/utils";
import "@milkdown/crepe/theme/common/prosemirror.css";
import "@milkdown/crepe/theme/common/reset.css";
import "@milkdown/crepe/theme/common/block-edit.css";
import "@milkdown/crepe/theme/common/code-mirror.css";
import "@milkdown/crepe/theme/common/cursor.css";
import "@milkdown/crepe/theme/common/image-block.css";
import "@milkdown/crepe/theme/common/link-tooltip.css";
import "@milkdown/crepe/theme/common/list-item.css";
import "@milkdown/crepe/theme/common/placeholder.css";
import "@milkdown/crepe/theme/common/toolbar.css";
import "@milkdown/crepe/theme/common/table.css";
import "@milkdown/crepe/theme/frame-dark.css";
import { alpha, theme } from "../theme";
import { TOOLBAR_ICON } from "./commentIcon";
import { buildDocEditor, codeKeptShownCss } from "./docEditorSetup";

/*
 * The doc editor's React shell. This module carries the whole editor stack
 * (Milkdown, ProseMirror, CodeMirror, Vue for Crepe's widgets), so the Docs
 * tab loads it on demand and `vite build` puts it in its own chunk.
 */

const SCOPE = "standup-doc-editor";

/**
 * Every variable Crepe's frame-dark theme sets, re-keyed to the console's
 * own tokens, so the editor follows the light and dark palettes.
 */
const THEME_CSS = `
.${SCOPE} .milkdown {
  --crepe-color-background: ${theme.ground};
  --crepe-color-on-background: ${theme.text};
  --crepe-color-surface: ${theme.surface};
  --crepe-color-surface-low: ${theme.hover};
  --crepe-color-on-surface: ${theme.text};
  --crepe-color-on-surface-variant: ${theme.dim};
  --crepe-color-outline: ${theme.edge};
  --crepe-color-primary: ${theme.running};
  --crepe-color-secondary: ${theme.raised};
  --crepe-color-on-secondary: ${theme.text};
  --crepe-color-inverse: ${theme.text};
  --crepe-color-on-inverse: ${theme.ground};
  --crepe-color-inline-code: ${theme.accent};
  --crepe-color-error: ${theme.waiting};
  --crepe-color-hover: ${theme.hover};
  --crepe-color-selected: ${theme.raised};
  --crepe-color-inline-area: ${theme.surface};
  --crepe-base-font-size: 15px;
  --crepe-font-title: ${theme.sans};
  --crepe-font-default: ${theme.sans};
  --crepe-font-code: ${theme.mono};
  --crepe-shadow-1: 0 1px 3px ${alpha(theme.shadow, 0.5)};
  --crepe-shadow-2: 0 2px 8px ${alpha(theme.shadow, 0.55)};
}
.${SCOPE} .milkdown .ProseMirror { padding: 24px 56px 120px; }
.${SCOPE} .milkdown .ProseMirror a { color: ${theme.running}; }
.${SCOPE} .milkdown .milkdown-toolbar .toolbar-item:not(.active) svg { color: ${TOOLBAR_ICON}; fill: ${TOOLBAR_ICON}; }
${codeKeptShownCss(SCOPE)}`;

export interface DocEditorHandle {
  /** Replaces the whole document in place (another tab's or an agent's save), keeping the editor and its scroll. */
  replace: (markdown: string) => void;
  /**
   * The document as the editor serializes it right now, ahead of the
   * debounced `onEdit`/`onLoaded` reports; null once the editor is gone.
   */
  markdown: () => string | null;
  /** Whether the person has typed, pasted, dropped or clicked into the editor since it loaded or was last replaced. */
  touched: () => boolean;
}

export interface DocEditorProps {
  /** The doc's markdown without its frontmatter; read when the editor is created. */
  initialMarkdown: string;
  resolveImage: (src: string) => string;
  uploadImage: (file: File, first?: boolean) => Promise<string>;
  /**
   * The document as the editor serializes it, once loaded and again after
   * each `replace` (and when the editor normalizes a document nobody has
   * touched yet). This, not the stored body, is what an edit is compared to.
   */
  onLoaded: (markdown: string) => void;
  /** The document after a change the person made. */
  onEdit: (markdown: string) => void;
  /** The editor failed to start. */
  onError?: (message: string) => void;
  /** Receives the editor's handle once it is up, and null when it goes away. */
  bind?: (handle: DocEditorHandle | null) => void;
  /** Starts a comment on the selected passage, from the selection toolbar's Comment item. */
  onComment?: () => void;
}

/**
 * The editor for one doc; mount it again (a new `key`) to open another. A
 * change counts as an edit only once the person has typed, pasted, dropped
 * or clicked into the editor: Crepe also reports the document changing on
 * load, which must never save.
 */
export function DocEditor({ initialMarkdown, resolveImage, uploadImage, onLoaded, onEdit, onError, bind, onComment }: DocEditorProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const touched = useRef(false);
  const callbacks = useRef({ resolveImage, uploadImage, onLoaded, onEdit, onError, bind, onComment });
  callbacks.current = { resolveImage, uploadImage, onLoaded, onEdit, onError, bind, onComment };
  // Read when the editor is created: the toolbar has the Comment item for as long as the editor lives.
  const commentable = useRef(!!onComment).current;

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let live = true;
    // Each editor gets a mount of its own, so one still tearing down never shares the DOM with the next.
    const mount = document.createElement("div");
    root.appendChild(mount);
    const crepe = buildDocEditor({
      root: mount,
      markdown: initialMarkdown,
      resolveImage: (src) => callbacks.current.resolveImage(src),
      uploadImage: (file, first) => callbacks.current.uploadImage(file, first),
      ...(commentable ? { onComment: () => callbacks.current.onComment?.() } : {}),
    });
    let ready = false;
    /** The serialization last passed to onEdit or onLoaded. */
    let reported: string | null = null;
    const report = (markdown: string) => {
      reported = markdown;
      if (touched.current) callbacks.current.onEdit(markdown);
      else callbacks.current.onLoaded(markdown);
    };
    // The listener's report is debounced and serializes the last transaction
    // it saw, which a `replace` (a new editor state, not a transaction) leaves
    // behind; the live document is what is reported instead.
    crepe.on((api) =>
      api.markdownUpdated(() => {
        if (!live || !ready) return;
        report(crepe.getMarkdown());
      })
    );
    const touch = () => {
      touched.current = true;
    };
    const events = ["keydown", "paste", "drop", "cut", "pointerdown", "input"] as const;
    for (const name of events) root.addEventListener(name, touch, true);
    const handle: DocEditorHandle = {
      replace: (markdown) => {
        if (!live) return;
        touched.current = false;
        crepe.editor.action(replaceAll(markdown, true));
        report(crepe.getMarkdown());
      },
      markdown: () => (live && ready ? crepe.getMarkdown() : null),
      touched: () => touched.current,
    };
    const created = crepe.create().then(
      () => {
        if (!live) return;
        ready = true;
        report(crepe.getMarkdown());
        callbacks.current.bind?.(handle);
      },
      (err: unknown) => live && callbacks.current.onError?.(err instanceof Error ? err.message : String(err))
    );
    return () => {
      // An edit the debounced report hasn't carried yet is handed over before the editor goes.
      if (live && ready && touched.current) {
        try {
          const markdown = crepe.getMarkdown();
          if (markdown !== reported) report(markdown);
        } catch {
          // An editor that can't serialize any more has nothing newer to hand over.
        }
      }
      live = false;
      callbacks.current.bind?.(null);
      for (const name of events) root.removeEventListener(name, touch, true);
      mount.remove();
      void created.then(() => crepe.destroy()).catch(() => {});
    };
    // The editor is created once per mount; a doc switch remounts it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={SCOPE} data-testid="doc-editor" style={{ minHeight: "100%" }}>
      <style>{THEME_CSS}</style>
      <div ref={rootRef} />
    </div>
  );
}
