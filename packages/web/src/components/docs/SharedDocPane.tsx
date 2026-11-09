import { useEffect, useRef, useState } from "react";
import type { DocDetail } from "@standup/shared";
import { theme } from "../theme";
import { DocComments, type DocCommentsSummary } from "./DocComments";
import { SharedDocBody } from "./SharedDocPage";
import { DocsRequestError, getDoc } from "./api";

/** How often an open shared doc is re-read, so the reader follows the owner's edits. */
const REREAD_MS = 20_000;

/**
 * Another user's shareable doc, opened from "Shared with me": read-only, at
 * its latest revision, with the comment margin. Selecting text offers a
 * Comment button.
 */
export function SharedDocPane({ docId }: { docId: string }) {
  const [doc, setDoc] = useState<DocDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<DocCommentsSummary>({ total: 0, waiting: 0 });
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    const read = () =>
      getDoc(docId)
        .then((next) => {
          if (!live) return;
          // An unchanged revision keeps the rendered body (and the reader's selection) as it is.
          setDoc((prev) => (prev && prev.revision === next.revision && prev.body === next.body ? prev : next));
          setError(null);
        })
        .catch((err: unknown) => {
          if (!live) return;
          setError(err instanceof Error ? err.message : String(err));
          // Unshared (or deleted) since it opened: stop showing what the reader can no longer read.
          if (err instanceof DocsRequestError && err.status === 404) setDoc(null);
        });
    void read();
    const t = setInterval(read, REREAD_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [docId]);

  if (error && !doc) {
    return (
      <div role="alert" data-testid="shared-doc-error" style={{ padding: 24, color: theme.dim, fontSize: 13 }}>
        This doc isn't shared with you any more, or it was deleted.
      </div>
    );
  }
  if (!doc?.readOnly) return <div style={{ padding: 24, color: theme.dim, fontSize: 13 }}>Loading…</div>;

  return (
    <div data-testid="shared-doc-pane" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <header style={{ display: "flex", alignItems: "baseline", gap: 12, padding: "12px 20px", borderBottom: `1px solid ${theme.edgeSoft}` }}>
        <h1 data-testid="shared-doc-name" style={{ margin: 0, fontSize: 17, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
          {doc.name}
        </h1>
        <span style={{ fontSize: 12.5, color: theme.dim, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          Shared by <b style={{ color: theme.text }}>{doc.readOnly.owner}</b> · Read-only · Select text to comment
        </span>
        <span data-testid="shared-doc-comment-count" style={{ marginLeft: "auto", fontSize: 13, color: theme.dim, whiteSpace: "nowrap" }}>
          {summary.total === 1 ? "1 comment" : summary.total > 1 ? `${summary.total} comments` : ""}
        </span>
      </header>
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div ref={body} data-testid="shared-doc-scroll" style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
          <SharedDocBody doc={{ name: doc.name, body: doc.body, images: doc.readOnly.images }} hideName />
        </div>
        <DocComments docId={docId} root={body} role="reader" onSummary={setSummary} contentKey={doc.revision} />
      </div>
    </div>
  );
}
