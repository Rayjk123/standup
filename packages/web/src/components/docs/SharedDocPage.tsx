import { useEffect, useMemo, useState } from "react";
import type { Components } from "react-markdown";
import type { SharedDoc, SharedDocAsset } from "@standup/shared";
import { splitFrontmatter } from "@standup/shared";
import { theme } from "../theme";
import { Markdown } from "../Markdown";
import { useShareHead } from "../share/useShareHead";
import { getSharedDoc } from "./api";

type Loaded = { state: "loading" } | { state: "missing" } | { state: "error"; message: string } | { state: "ready"; doc: SharedDoc };

/**
 * Links open in a new tab with no opener and no referrer, so the page they
 * lead to learns nothing of the share link.
 */
const link: Components["a"] = ({ href, children }) => (
  <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: theme.running }}>
    {children}
  </a>
);

/** `text` with its percent-escapes decoded, or unchanged when they don't decode. */
function percentDecoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Finds a shared image by the `src` the renderer hands over. The share keys
 * each image by its destination as written in the markdown, while the
 * renderer percent-encodes a src (`café.png` arrives as `caf%C3%A9.png`,
 * `<my pic.png>` as `my%20pic.png`), so a src that isn't a key as it stands
 * is matched with the escapes decoded on both sides.
 */
export function sharedImageLookup(images: Record<string, SharedDocAsset>): (src: string) => SharedDocAsset | undefined {
  const byDecoded = new Map<string, SharedDocAsset>();
  for (const [key, asset] of Object.entries(images)) {
    const decoded = percentDecoded(key);
    if (!byDecoded.has(decoded)) byDecoded.set(decoded, asset);
  }
  return (src) => (Object.hasOwn(images, src) ? images[src] : byDecoded.get(percentDecoded(src)));
}

/**
 * Image renderers for a shared doc: an image the share carries loads from its
 * share URL; any other image shows only its alt text, so the page never
 * fetches anything the share didn't grant.
 */
function sharedComponents(images: Record<string, SharedDocAsset>): Components {
  const lookup = sharedImageLookup(images);
  return {
    a: link,
    img: ({ src, alt }) => {
      const asset = typeof src === "string" ? lookup(src) : undefined;
      if (asset) return <img src={asset.url} alt={alt ?? ""} referrerPolicy="no-referrer" style={{ maxWidth: "100%" }} />;
      return alt ? <span style={{ color: theme.dim }}>[{alt}]</span> : null;
    },
  };
}

/** The read-only body of a shared doc: its name (unless the page shows it elsewhere) and its markdown. */
export function SharedDocBody({ doc, hideName = false }: { doc: SharedDoc; hideName?: boolean }) {
  const components = useMemo(() => sharedComponents(doc.images), [doc.images]);
  const { content } = splitFrontmatter(doc.body);
  return (
    <article
      data-testid="shared-doc"
      style={{ width: "100%", maxWidth: 860, margin: "0 auto", boxSizing: "border-box", padding: "20px 24px 48px", color: theme.text }}
    >
      {!hideName && <h1 style={{ margin: "0 0 18px", fontSize: 22, lineHeight: 1.3, overflowWrap: "anywhere" }}>{doc.name}</h1>}
      <div style={{ fontSize: 15 }}>
        <Markdown components={components} diagrams>
          {content}
        </Markdown>
      </div>
    </article>
  );
}

/**
 * The page a doc's share link opens (`/share/doc/<token>`), outside the
 * console: no navigation, no sign-in, no live socket and no editing — only
 * the doc, read through its token. An unknown or revoked link shows a plain
 * "not found" that says nothing of any doc.
 */
export function SharedDocPage({ token }: { token: string | null }) {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  useShareHead();

  useEffect(() => {
    if (!token) {
      setLoaded({ state: "missing" });
      return;
    }
    let live = true;
    getSharedDoc(token)
      .then((doc) => live && setLoaded(doc ? { state: "ready", doc } : { state: "missing" }))
      .catch((err: unknown) => live && setLoaded({ state: "error", message: err instanceof Error ? err.message : String(err) }));
    return () => {
      live = false;
    };
  }, [token]);

  useEffect(() => {
    document.title = loaded.state === "ready" ? `${loaded.doc.name} — shared doc` : "Shared doc";
  }, [loaded]);

  return (
    <div style={{ minHeight: "100vh", background: theme.ground, color: theme.text, fontFamily: theme.sans }}>
      <ShareHeader what="Shared doc (read-only)" />
      {loaded.state === "loading" && <div style={{ padding: 24, color: theme.dim }}>Loading…</div>}
      {loaded.state === "missing" && <ShareNotFound testId="shared-doc-missing" />}
      {loaded.state === "error" && (
        <div role="alert" style={{ padding: 24, color: theme.waiting }}>
          Couldn't load this page: {loaded.message}
        </div>
      )}
      {loaded.state === "ready" && <SharedDocBody doc={loaded.doc} />}
    </div>
  );
}

/** A share page's top bar: Standup's name and what the page shows. */
export function ShareHeader({ what }: { what: string }) {
  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "12px 24px",
        borderBottom: `1px solid ${theme.edgeSoft}`,
        fontSize: 13,
        color: theme.dim,
      }}
    >
      <span style={{ color: theme.accent, fontWeight: 700, letterSpacing: "0.02em" }}>Standup</span>
      <span aria-hidden="true">·</span>
      <span>{what}</span>
    </header>
  );
}

/** The "not found" a share page shows for an unknown or revoked link, naming nothing. */
export function ShareNotFound({ testId, message = "This link doesn't lead anywhere. It may have been mistyped or turned off." }: { testId: string; message?: string }) {
  return (
    <div data-testid={testId} style={{ padding: "64px 24px", textAlign: "center", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 20, fontWeight: 700 }}>404 — Not found</div>
      <div style={{ color: theme.dim }}>{message}</div>
    </div>
  );
}
