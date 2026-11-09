import { useEffect, useState, type ReactNode } from "react";
import { LuChevronDown, LuChevronRight, LuFileText, LuFolder, LuFolderOpen } from "react-icons/lu";
import type { SharedDoc, SharedFolder } from "@standup/shared";
import { theme } from "../theme";
import { useShareHead } from "../share/useShareHead";
import { getSharedFolder, getSharedFolderDoc } from "./api";
import { ShareHeader, ShareNotFound, SharedDocBody } from "./SharedDocPage";

type LoadedFolder = { state: "loading" } | { state: "missing" } | { state: "error"; message: string } | { state: "ready"; folder: SharedFolder };
type LoadedDoc = { state: "none" } | { state: "loading" } | { state: "missing" } | { state: "error"; message: string } | { state: "ready"; doc: SharedDoc };

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A doc id as the store mints it (a UUID). */
const DOC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The doc the page's `?doc=` names, or null. */
function docInUrl(): string | null {
  return new URLSearchParams(window.location.search).get("doc");
}

const byName = <T extends { name: string }>(items: T[]) => [...items].sort((a, b) => a.name.localeCompare(b.name));

/** The shared folder's tree, every folder open to start with; a click on a doc opens it. */
function SharedFolderTree({
  folder,
  openDocId,
  onOpenDoc,
}: {
  folder: SharedFolder;
  openDocId: string | null;
  onOpenDoc: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const root = folder.folders.find((f) => f.parentId === null);
  if (!root) return null;

  const row = { display: "flex", alignItems: "center", gap: 6, minHeight: 28, paddingRight: 6, borderRadius: 5, fontSize: 13, cursor: "pointer" } as const;
  const renderFolder = (id: string, depth: number): ReactNode => {
    const indent = 8 + depth * 14;
    return (
      <>
        {byName(folder.folders.filter((f) => f.parentId === id)).map((sub) => {
          const open = !collapsed.has(sub.id);
          return (
            <div key={sub.id} data-testid="shared-folder-folder">
              <button
                type="button"
                aria-expanded={open}
                onClick={() =>
                  setCollapsed((prev) => {
                    const next = new Set(prev);
                    if (next.has(sub.id)) next.delete(sub.id);
                    else next.add(sub.id);
                    return next;
                  })
                }
                style={{ ...row, width: "100%", paddingLeft: indent, border: "none", background: "transparent", color: theme.text, textAlign: "left" }}
              >
                {open ? <LuChevronDown size={13} color={theme.faint} /> : <LuChevronRight size={13} color={theme.faint} />}
                {open ? <LuFolderOpen size={14} color={theme.accent} /> : <LuFolder size={14} color={theme.accent} />}
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{sub.name}</span>
              </button>
              {open && renderFolder(sub.id, depth + 1)}
            </div>
          );
        })}
        {byName(folder.docs.filter((d) => d.folderId === id)).map((doc) => {
          const selected = doc.id === openDocId;
          return (
            <a
              key={doc.id}
              href={`?doc=${encodeURIComponent(doc.id)}`}
              data-testid="shared-folder-doc"
              data-doc-id={doc.id}
              aria-current={selected ? "page" : undefined}
              onClick={(e) => {
                // A modified click opens the doc in a new tab, as the browser does it.
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                e.preventDefault();
                onOpenDoc(doc.id);
              }}
              style={{
                ...row,
                paddingLeft: indent + 19,
                color: selected ? theme.text : theme.dim,
                background: selected ? theme.raised : "transparent",
                textDecoration: "none",
              }}
            >
              <LuFileText size={14} color={selected ? theme.running : theme.faint} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{doc.name}</span>
            </a>
          );
        })}
      </>
    );
  };

  return (
    <nav aria-label={`${folder.name} docs`} data-testid="shared-folder-tree" style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <div style={{ ...row, cursor: "default", paddingLeft: 8, color: theme.text, fontWeight: 600 }}>
        <LuFolderOpen size={14} color={theme.accent} />
        <span style={{ overflowWrap: "anywhere" }}>{folder.name}</span>
      </div>
      {renderFolder(root.id, 1)}
      {folder.docs.length === 0 && <div style={{ padding: "8px 8px 8px 30px", color: theme.faint, fontSize: 12.5 }}>No docs in this folder yet.</div>}
    </nav>
  );
}

/**
 * The page a folder's share link opens (`/share/folder/<token>`), outside the
 * console: the folder's tree on the left and the open doc (`?doc=<id>`),
 * read-only, on the right. No navigation, sign-in, live socket or editing —
 * only what the token reaches. An unknown or revoked link, and a doc outside
 * the folder, show a plain "not found" that names nothing.
 */
export function SharedFolderPage({ token }: { token: string | null }) {
  const [folder, setFolder] = useState<LoadedFolder>({ state: "loading" });
  const [docId, setDocId] = useState<string | null>(docInUrl);
  const [doc, setDoc] = useState<LoadedDoc>({ state: "none" });
  const [reload, setReload] = useState(0);
  useShareHead();

  useEffect(() => {
    if (!token) {
      setFolder({ state: "missing" });
      return;
    }
    let live = true;
    getSharedFolder(token)
      .then((f) => live && setFolder(f ? { state: "ready", folder: f } : { state: "missing" }))
      .catch((err: unknown) => live && setFolder({ state: "error", message: message(err) }));
    return () => {
      live = false;
    };
  }, [token]);

  useEffect(() => {
    if (!token || !docId) {
      setDoc({ state: "none" });
      return;
    }
    // Only an id as the store mints it is asked for; anything else (`..`, a path) is not in the folder.
    if (!DOC_ID.test(docId)) {
      setDoc({ state: "missing" });
      return;
    }
    let live = true;
    setDoc({ state: "loading" });
    getSharedFolderDoc(token, docId)
      .then((d) => live && setDoc(d ? { state: "ready", doc: d } : { state: "missing" }))
      .catch((err: unknown) => live && setDoc({ state: "error", message: message(err) }));
    return () => {
      live = false;
    };
  }, [token, docId, reload]);

  // Back and forward move between the docs opened here.
  useEffect(() => {
    const onPop = () => setDocId(docInUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    const name = folder.state === "ready" ? folder.folder.name : null;
    if (doc.state === "ready") document.title = `${doc.doc.name} — shared folder${name ? ` ${name}` : ""}`;
    else document.title = name ? `${name} — shared folder` : "Shared folder";
  }, [folder, doc]);

  const openDoc = (id: string) => {
    if (id === docId) {
      // The open doc again: read it again, which retries one that failed to load.
      setReload((n) => n + 1);
      return;
    }
    window.history.pushState(null, "", `${window.location.pathname}?doc=${encodeURIComponent(id)}`);
    setDocId(id);
    window.scrollTo?.(0, 0);
  };

  return (
    <div style={{ minHeight: "100vh", background: theme.ground, color: theme.text, fontFamily: theme.sans, display: "flex", flexDirection: "column" }}>
      <ShareHeader what="Shared folder (read-only)" />
      {folder.state === "loading" && <div style={{ padding: 24, color: theme.dim }}>Loading…</div>}
      {folder.state === "missing" && <ShareNotFound testId="shared-folder-missing" />}
      {folder.state === "error" && (
        <div role="alert" style={{ padding: 24, color: theme.waiting }}>
          Couldn't load this page: {folder.message}
        </div>
      )}
      {folder.state === "ready" && (
        <div style={{ display: "flex", flexWrap: "wrap", flex: 1, minHeight: 0 }}>
          <aside
            style={{
              flex: "0 1 280px",
              minWidth: 220,
              padding: "12px 10px",
              borderRight: `1px solid ${theme.edgeSoft}`,
              boxSizing: "border-box",
            }}
          >
            <SharedFolderTree folder={folder.folder} openDocId={docId} onOpenDoc={openDoc} />
          </aside>
          <main style={{ flex: "1 1 480px", minWidth: 0 }}>
            {doc.state === "none" && (
              <div style={{ padding: "64px 24px", color: theme.faint, fontSize: 13, textAlign: "center" }}>
                {folder.folder.docs.length > 0 ? "Open a doc from the folder." : "This folder has no docs yet."}
              </div>
            )}
            {doc.state === "loading" && <div style={{ padding: 24, color: theme.dim }}>Loading…</div>}
            {doc.state === "missing" && <ShareNotFound testId="shared-folder-doc-missing" message="This doc isn't in the shared folder." />}
            {doc.state === "error" && (
              <div role="alert" style={{ padding: 24, color: theme.waiting }}>
                Couldn't load this doc: {doc.message}
              </div>
            )}
            {doc.state === "ready" && <SharedDocBody doc={doc.doc} />}
          </main>
        </div>
      )}
    </div>
  );
}
