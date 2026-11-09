import { lazy, memo, Suspense, type ComponentType } from "react";
import type { MarkdownProps } from "./MarkdownRenderer";
import { theme } from "./theme";

/*
 * The markdown stack is the largest dependency the console has, and nearly
 * every view renders through it, so it is its own chunk rather than part of
 * the first load. Its download starts as soon as this module evaluates, in
 * parallel with the app's boot, and until it lands a message renders as its
 * plain text: the first Persona message never waits on the parser. Once it
 * has landed every Markdown renders it directly, with no Suspense. Should the
 * chunk fail to load, text stays plain rather than taking the view down.
 */
let Renderer: ComponentType<MarkdownProps> | undefined;

/** Settles once the renderer's chunk has loaded (or failed, leaving text plain). */
export const markdownReady: Promise<void> = import("./MarkdownRenderer").then(
  (m) => void (Renderer = m.MarkdownRenderer),
  () => void (Renderer = PlainText)
);
const LazyRenderer = lazy(() => markdownReady.then(() => ({ default: Renderer ?? PlainText })));

/** The text as written, in the rendered markdown's type and wrapping. */
function PlainText({ children }: MarkdownProps) {
  return (
    <div style={{ fontSize: 13, lineHeight: 1.6, color: theme.text, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
      {children}
    </div>
  );
}

/**
 * Markdown rendering for agent output; see MarkdownRenderer for what it
 * renders and the props' contract. Shows the plain text until the renderer's
 * chunk has loaded, then renders in place.
 */
export const Markdown = memo(function Markdown(props: MarkdownProps) {
  if (Renderer) return <Renderer {...props} />;
  return (
    <Suspense fallback={<PlainText>{props.children}</PlainText>}>
      <LazyRenderer {...props} />
    </Suspense>
  );
});
