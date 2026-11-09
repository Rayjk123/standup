import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { LuFilePlus, LuFolderPlus, LuImport, LuSearch } from "react-icons/lu";
import type { DocImportResult, DocTree as DocTreeData, ShareState, SharedWithMe } from "@standup/shared";
import { alpha, theme } from "../theme";
import { ShareToggle } from "../share/ShareToggle";
import { getShare, listShared, setShare as setShareRemote } from "../share/api";
import { subscribeDocsUpdates } from "../../lib/docsUpdates";
import { DocTree, type PendingCreate } from "./DocTree";
import { DocPane } from "./DocPane";
import { SharedDocPane } from "./SharedDocPane";
import { ShareLinkDisclosure, ShareableToggle } from "./ShareableToggle";
import { SharedWithMeList } from "./SharedWithMeList";
import { getSharedWithMe } from "./sharingApi";
import { dismissUnsavedDoc, noteDeletedHere, useUnsavedDocs, type HeldUnsavedDoc } from "../../lib/unsavedDocs";
import { EMPTY_TREE, folderPath, type TreeItem } from "./docsTree";
import { docsStorage, loadOpenFolders, pruneOpenFolders, saveOpenFolders } from "./openFolders";
import { DocSearch } from "./DocSearch";
import { isSearchShortcut, searchShortcutLabel } from "./searchText";
import {
  createDoc,
  createFolder,
  deleteAsset,
  deleteDoc,
  deleteFolder,
  getTree,
  importDocs,
  updateAsset,
  updateDoc,
  updateFolder,
} from "./api";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

const toolbarButton = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  padding: "4px 8px",
  borderRadius: 5,
  border: `1px solid ${theme.edge}`,
  background: "transparent",
  color: theme.text,
  fontSize: 12,
  cursor: "pointer",
} as const;

/** The import dialog: a host path in, the import's counts and skipped files out. */
function ImportPanel({
  targetLabel,
  onImport,
  onClose,
}: {
  targetLabel: string;
  onImport: (path: string) => Promise<DocImportResult>;
  onClose: () => void;
}) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DocImportResult | null>(null);
  const run = async () => {
    if (!path.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await onImport(path.trim()));
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      role="dialog"
      aria-label="Import docs"
      data-testid="docs-import"
      style={{
        margin: "0 0 8px",
        padding: 10,
        borderRadius: 6,
        border: `1px solid ${theme.edge}`,
        background: theme.surface,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        fontSize: 12.5,
      }}
    >
      <div style={{ color: theme.dim }}>
        Import a markdown file or a folder of them (with its images) from this machine into <strong style={{ color: theme.text }}>{targetLabel}</strong>.
      </div>
      <input
        autoFocus
        data-testid="docs-import-path"
        aria-label="Path on this machine"
        placeholder="~/notes"
        value={path}
        onChange={(e) => setPath(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void run();
          if (e.key === "Escape") onClose();
        }}
        style={{
          padding: "4px 8px",
          borderRadius: 5,
          border: `1px solid ${theme.edge}`,
          background: theme.ground,
          color: theme.text,
          fontFamily: theme.mono,
          fontSize: 12,
        }}
      />
      <div style={{ display: "flex", gap: 6 }}>
        <button type="button" data-testid="docs-import-run" disabled={busy || !path.trim()} onClick={run} style={{ ...toolbarButton, borderColor: alpha(theme.running, 0x66), color: theme.running }}>
          {busy ? "Importing…" : "Import"}
        </button>
        <button type="button" onClick={onClose} style={toolbarButton}>
          {result ? "Done" : "Cancel"}
        </button>
      </div>
      {error && (
        <div role="alert" style={{ color: theme.waiting }}>
          {error}
        </div>
      )}
      {result && (
        <div data-testid="docs-import-result" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div>
            Imported {result.docs} doc{result.docs === 1 ? "" : "s"}, {result.assets} image{result.assets === 1 ? "" : "s"} and {result.folders} folder
            {result.folders === 1 ? "" : "s"}.
          </div>
          {result.skipped.length > 0 && (
            <details>
              <summary style={{ cursor: "pointer", color: theme.stalled }}>Skipped {result.skipped.length}</summary>
              <ul style={{ margin: "4px 0 0", paddingLeft: 16, maxHeight: 160, overflowY: "auto", color: theme.dim }}>
                {result.skipped.map((s) => (
                  <li key={s.path} style={{ overflowWrap: "anywhere" }}>
                    <span style={{ fontFamily: theme.mono }}>{s.path}</span> — {s.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

/** The name of the nearest shareable folder above `folderId` (not itself), or undefined. */
function shareableFolderAbove(tree: DocTreeData, folderId: string): string | undefined {
  const byId = new Map(tree.folders.map((f) => [f.id, f]));
  const seen = new Set<string>();
  for (let at = byId.get(folderId)?.parentId ?? null; at && !seen.has(at); at = byId.get(at)?.parentId ?? null) {
    seen.add(at);
    const folder = byId.get(at);
    if (folder?.shareable) return folder.name;
  }
  return undefined;
}

/**
 * A folder's Shareable switch, opened from the folder's Share action: the
 * same switch a doc has, for the folder with everything below it. A share
 * link made for the folder earlier shows below it while it is on, and
 * re-reads when it is switched elsewhere (another tab).
 */
function FolderSharePanel({
  folderId,
  label,
  shareable,
  via,
  onClose,
  onChanged,
  onShareableChanged,
}: {
  folderId: string;
  label: string;
  shareable: boolean;
  /** The shareable folder above this one, which shares it whatever its own switch says. */
  via?: string;
  onClose: () => void;
  /** Called after this panel turned the folder's share link off. */
  onChanged: () => void;
  /** Called after this panel turned the folder's Shareable switch on or off. */
  onShareableChanged: () => void;
}) {
  const [share, setShare] = useState<ShareState | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    const read = () =>
      void getShare("folder", folderId).then((next) => {
        if (!live) return;
        setFailed(!next);
        if (next) setShare(next);
      });
    read();
    const unsubscribe = subscribeDocsUpdates((change) => {
      if (!change || (change.share && change.folderId === folderId)) read();
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [folderId]);

  return (
    <div
      role="dialog"
      aria-label={`Share ${label}`}
      data-testid="docs-folder-share"
      style={{
        margin: "0 0 8px",
        padding: 10,
        borderRadius: 6,
        border: `1px solid ${theme.edge}`,
        background: theme.surface,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        fontSize: 12.5,
      }}
    >
      <div style={{ color: theme.dim, overflowWrap: "anywhere" }}>
        Share the folder <strong style={{ color: theme.text }}>{label}</strong> and everything in it with everyone signed in.
      </div>
      <ShareableToggle kind="folder" id={folderId} shareable={shareable} via={via} onChanged={onShareableChanged} />
      {share && (
        <ShareLinkDisclosure testId="folder-share-link" live={share.enabled}>
          <ShareToggle
            resourceType="folder"
            resourceId={folderId}
            share={share}
            onToggle={async (enabled) => {
              // Kept here too, so a later change made elsewhere reads as a change.
              const result = await setShareRemote("folder", folderId, enabled);
              if (result.share) {
                setShare(result.share);
                onChanged();
              }
              return result;
            }}
          />
        </ShareLinkDisclosure>
      )}
      {!share && failed && (
        <div role="alert" style={{ color: theme.waiting }}>
          Couldn't read this folder's share link.
        </div>
      )}
      <span>
        <button type="button" data-testid="docs-folder-share-close" onClick={onClose} style={toolbarButton}>
          Done
        </button>
      </span>
    </div>
  );
}

function unsavedHeading({ reason, name, message: why, deletedHere }: HeldUnsavedDoc): string {
  if (reason === "deleted") return deletedHere ? `“${name}” was deleted — your unsaved text is below.` : `“${name}” was deleted elsewhere — your unsaved text is below.`;
  if (reason === "conflict") return `“${name}” was changed in another tab or by an agent before your last edits saved — your unsaved text is below.`;
  return `Couldn't save your last edits to “${name}”: ${why}. Your unsaved text is below.`;
}

/** Edits a closed doc's pane couldn't save, shown so they can be copied somewhere safe. */
function UnsavedPanel({ unsaved, onDismiss }: { unsaved: HeldUnsavedDoc; onDismiss: () => void }) {
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(unsaved.text);
      setCopied(true);
    } catch {
      textRef.current?.select();
    }
  };
  return (
    <div
      role="alert"
      data-testid="docs-unsaved"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "10px 20px",
        background: alpha(theme.waiting, 0x14),
        borderBottom: `1px solid ${alpha(theme.waiting, 0x55)}`,
        fontSize: 12.5,
        color: theme.text,
      }}
    >
      <span>{unsavedHeading(unsaved)}</span>
      <textarea
        ref={textRef}
        readOnly
        data-testid="docs-unsaved-text"
        aria-label={`Unsaved text of ${unsaved.name}`}
        value={unsaved.text}
        onFocus={(e) => e.currentTarget.select()}
        rows={8}
        style={{
          width: "100%",
          boxSizing: "border-box",
          padding: 8,
          borderRadius: 5,
          border: `1px solid ${theme.edge}`,
          background: theme.ground,
          color: theme.text,
          fontFamily: theme.mono,
          fontSize: 12,
          resize: "vertical",
        }}
      />
      <span style={{ display: "flex", gap: 6 }}>
        <button type="button" data-testid="docs-unsaved-copy" onClick={copy} style={toolbarButton}>
          {copied ? "Copied" : "Copy text"}
        </button>
        <button type="button" data-testid="docs-unsaved-dismiss" onClick={onDismiss} style={toolbarButton}>
          Dismiss
        </button>
      </span>
    </div>
  );
}

/**
 * The Docs tab: the owner's folder tree on the left, the open doc (its name,
 * save status, share switch and editor) on the right. The open doc is in the
 * path (`/docs/<id>`). The tree re-reads on every `docs:changed` frame that
 * changed its shape and on every resync; the open doc follows newer
 * revisions saved elsewhere (see DocPane).
 */
export function DocsView() {
  const { id: selectedDocId = null } = useParams();
  const navigate = useNavigate();
  const [tree, setTree] = useState<DocTreeData>(EMPTY_TREE);
  const [loaded, setLoaded] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => loadOpenFolders(docsStorage()));
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [creating, setCreating] = useState<PendingCreate | null>(null);
  const [importing, setImporting] = useState(false);
  const [searching, setSearching] = useState(false);
  const [sharingFolderId, setSharingFolderId] = useState<string | null>(null);
  const [sharedFolderIds, setSharedFolderIds] = useState<ReadonlySet<string>>(() => new Set());
  /** The newest revision a frame announced per doc, ahead of the tree's next read. */
  const [announced, setAnnounced] = useState<Record<string, number>>({});
  const [deletedDocs, setDeletedDocs] = useState<ReadonlySet<string>>(() => new Set());
  const unsaved = useUnsavedDocs();

  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  // One tree read at a time; a request while one runs reads again after it.
  const reading = useRef<Promise<void> | null>(null);
  const again = useRef(false);
  const refreshTree = useCallback((): Promise<void> => {
    if (reading.current) {
      again.current = true;
      return reading.current;
    }
    const run = async () => {
      do {
        again.current = false;
        const openAtRead = expandedRef.current;
        try {
          const next = await getTree();
          setTree(next);
          setTreeError(null);
          // Only a tree that was read can say a folder is gone, and only one open when it was asked for.
          setExpanded((prev) => pruneOpenFolders(prev, next, openAtRead));
        } catch (err) {
          setTreeError(message(err));
        }
      } while (again.current);
      setLoaded(true);
      reading.current = null;
    };
    reading.current = run();
    return reading.current;
  }, []);

  useEffect(() => {
    void refreshTree();
    return subscribeDocsUpdates((change) => {
      if (!change || change.tree || change.deleted) void refreshTree();
      if (change?.docId && typeof change.revision === "number") {
        const { docId, revision } = change;
        setAnnounced((prev) => (prev[docId] !== undefined && prev[docId]! >= revision ? prev : { ...prev, [docId]: revision }));
      }
      if (change?.docId && change.deleted) setDeletedDocs((prev) => new Set(prev).add(change.docId!));
    });
  }, [refreshTree]);

  // Which folders are shared by link, for the tree's marker: re-read when a
  // folder's share changes, the tree changes (a delete revokes) or on a resync.
  const sharedRead = useRef(0);
  const refreshShared = useCallback(() => {
    const id = ++sharedRead.current;
    void listShared("folder").then((ids) => {
      if (!ids || id !== sharedRead.current) return;
      // An unchanged set keeps its identity, so a re-read that finds nothing new re-renders nothing.
      setSharedFolderIds((prev) => (ids.length === prev.size && ids.every((x) => prev.has(x)) ? prev : new Set(ids)));
    });
  }, []);
  useEffect(() => {
    refreshShared();
    return subscribeDocsUpdates((change) => {
      if (!change || change.tree || (change.share && change.folderId)) refreshShared();
    });
  }, [refreshShared]);

  // Other users' shareable docs: read on open, on every resync and now and then, since their edits send this tab no frame.
  const [sharedWithMe, setSharedWithMe] = useState<SharedWithMe[]>([]);
  /** Whether the list has been read (or failed to be) once, so a doc isn't called gone before it is known. */
  const [sharedListRead, setSharedListRead] = useState(false);
  useEffect(() => {
    let live = true;
    const read = () =>
      void getSharedWithMe()
        .then((next) => live && setSharedWithMe(next), () => undefined)
        .finally(() => live && setSharedListRead(true));
    read();
    const t = setInterval(read, 30_000);
    const unsubscribe = subscribeDocsUpdates((change) => !change && read());
    return () => {
      live = false;
      clearInterval(t);
      unsubscribe();
    };
  }, []);
  const sharedSelected = selectedDocId !== null && sharedWithMe.some((s) => s.docs.some((d) => d.id === selectedDocId));

  const selectedSummary = selectedDocId ? tree.docs.find((d) => d.id === selectedDocId) : undefined;
  const remoteRevision = selectedDocId ? Math.max(selectedSummary?.revision ?? 0, announced[selectedDocId] ?? 0) : 0;
  const docGone =
    selectedDocId !== null && !sharedSelected && (deletedDocs.has(selectedDocId) || (loaded && sharedListRead && !treeError && !selectedSummary));

  // Opening a doc opens the folders above it and makes its folder the target for new things.
  const selectedDocFolder = selectedSummary?.folderId ?? null;
  useEffect(() => {
    if (!selectedDocId || !selectedSummary) return;
    setSelectedFolderId(selectedDocFolder);
    setExpanded((prev) => {
      const next = new Set(prev);
      const byId = new Map(tree.folders.map((f) => [f.id, f]));
      // Every ancestor: an open folder can sit inside a closed one.
      const seen = new Set<string>();
      for (let at = selectedDocFolder; at && !seen.has(at); at = byId.get(at)?.parentId ?? null) {
        seen.add(at);
        next.add(at);
      }
      return next.size === prev.size ? prev : next;
    });
    // Only a newly opened doc (or a move of it) re-targets the tree.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDocId, selectedDocFolder]);

  useEffect(() => saveOpenFolders(docsStorage(), expanded), [expanded]);

  // Cmd/Ctrl+K opens search from anywhere on the tab, the doc editor included.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isSearchShortcut(e) || e.repeat) return;
      e.preventDefault();
      setSearching(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const run = async (action: () => Promise<unknown>): Promise<string | null> => {
    setActionError(null);
    try {
      await action();
      await refreshTree();
      return null;
    } catch (err) {
      return message(err);
    }
  };

  const onMove = (item: TreeItem, folderId: string | null) => {
    void run(async () => {
      if (item.kind === "folder") await updateFolder(item.id, { parentId: folderId });
      else if (item.kind === "doc") {
        const result = await updateDoc(item.id, { folderId });
        if (!result.ok) throw new Error("The doc changed while it was being moved; try again");
      } else await updateAsset(item.id, { folderId });
      if (folderId) setExpanded((prev) => new Set(prev).add(folderId));
    }).then((err) => err && setActionError(err));
  };

  const onRename = (item: TreeItem, name: string) =>
    run(async () => {
      if (item.kind === "folder") await updateFolder(item.id, { name });
      else if (item.kind === "doc") {
        const result = await updateDoc(item.id, { name });
        if (!result.ok) throw new Error("The doc changed while it was being renamed; try again");
      } else await updateAsset(item.id, { name });
    });

  const onDelete = (item: TreeItem) =>
    run(async () => {
      if (item.kind === "folder") await deleteFolder(item.id);
      else if (item.kind === "doc") {
        noteDeletedHere(item.id, true);
        try {
          await deleteDoc(item.id);
        } catch (err) {
          noteDeletedHere(item.id, false);
          throw err;
        }
      }
      else await deleteAsset(item.id);
      if (item.kind === "doc" && item.id === selectedDocId) navigate("/docs", { replace: true });
      if (item.kind === "folder" && selectedFolderId === item.id) setSelectedFolderId(null);
    });

  const startCreate = (kind: PendingCreate["kind"]) => {
    if (selectedFolderId) setExpanded((prev) => new Set(prev).add(selectedFolderId));
    setCreating({ kind, parentId: selectedFolderId });
  };

  const onCreate = async (name: string) => {
    const pending = creating;
    if (!pending) return null;
    let created: string | null = null;
    const err = await run(async () => {
      if (pending.kind === "folder") {
        const folder = await createFolder(pending.parentId, name);
        setSelectedFolderId(folder.id);
        setExpanded((prev) => new Set(prev).add(folder.id));
      } else {
        created = (await createDoc(pending.parentId, /\.(md|markdown)$/i.test(name) ? name : `${name}.md`)).id;
      }
    });
    if (err) return err;
    setCreating(null);
    // The tree has re-read by now, so the new doc opens straight into its pane.
    if (created) navigate(`/docs/${encodeURIComponent(created)}`);
    return null;
  };

  // A folder is marked when it is shareable, or shared by a link made earlier.
  const markedFolderIds = useMemo(() => {
    const shareable = tree.folders.filter((f) => f.shareable).map((f) => f.id);
    return shareable.length === 0 ? sharedFolderIds : new Set([...sharedFolderIds, ...shareable]);
  }, [tree, sharedFolderIds]);

  const targetLabel = useMemo(() => {
    const path = folderPath(tree, selectedFolderId);
    return path.length ? path.join("/") : "the top level";
  }, [tree, selectedFolderId]);

  return (
    <div data-testid="docs-view" style={{ display: "flex", height: "100%", minHeight: 0, background: theme.ground }}>
      {searching && (
        <DocSearch
          onClose={() => setSearching(false)}
          onOpen={(id) => {
            setSearching(false);
            navigate(`/docs/${encodeURIComponent(id)}`);
          }}
        />
      )}
      <aside
        style={{
          width: 280,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          padding: "12px 10px",
          borderRight: `1px solid ${theme.edgeSoft}`,
          boxSizing: "border-box",
        }}
      >
        <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
          <button type="button" data-testid="docs-new-folder" onClick={() => startCreate("folder")} style={toolbarButton} title={`New folder in ${targetLabel}`}>
            <LuFolderPlus size={13} /> Folder
          </button>
          <button type="button" data-testid="docs-new-doc" onClick={() => startCreate("doc")} style={toolbarButton} title={`New doc in ${targetLabel}`}>
            <LuFilePlus size={13} /> Doc
          </button>
          <button type="button" data-testid="docs-import-open" onClick={() => setImporting(true)} style={toolbarButton} title={`Import into ${targetLabel}`}>
            <LuImport size={13} /> Import
          </button>
          <button
            type="button"
            data-testid="docs-search-open"
            aria-label="Search docs"
            aria-haspopup="dialog"
            aria-keyshortcuts="Meta+K Control+K"
            title={`Search docs (${searchShortcutLabel()})`}
            onClick={() => setSearching(true)}
            style={{ ...toolbarButton, marginLeft: "auto", padding: "4px 6px" }}
          >
            <LuSearch size={13} />
          </button>
        </div>
        {importing && (
          <ImportPanel
            targetLabel={targetLabel}
            onClose={() => setImporting(false)}
            onImport={async (path) => {
              const result = await importDocs(path, selectedFolderId);
              if (result.rootFolderId) setExpanded((prev) => new Set(prev).add(result.rootFolderId!));
              await refreshTree();
              return result;
            }}
          />
        )}
        {sharingFolderId && tree.folders.some((f) => f.id === sharingFolderId) && (
          <FolderSharePanel
            key={sharingFolderId}
            folderId={sharingFolderId}
            label={folderPath(tree, sharingFolderId).join("/")}
            shareable={!!tree.folders.find((f) => f.id === sharingFolderId)?.shareable}
            via={shareableFolderAbove(tree, sharingFolderId)}
            onClose={() => setSharingFolderId(null)}
            onChanged={refreshShared}
            onShareableChanged={() => void refreshTree()}
          />
        )}
        {treeError && (
          <div role="alert" style={{ color: theme.waiting, fontSize: 12.5, marginBottom: 8 }}>
            Couldn't load your docs: {treeError}
          </div>
        )}
        {actionError && (
          <div role="alert" data-testid="docs-action-error" style={{ color: theme.waiting, fontSize: 12.5, marginBottom: 8 }}>
            {actionError}
          </div>
        )}
        <DocTree
          tree={tree}
          selectedDocId={selectedDocId}
          selectedFolderId={selectedFolderId}
          expanded={expanded}
          onToggleFolder={(id) =>
            setExpanded((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
          onSelectFolder={setSelectedFolderId}
          onSelectDoc={(id) => navigate(`/docs/${encodeURIComponent(id)}`)}
          onMove={onMove}
          onRename={onRename}
          onDelete={onDelete}
          onShareFolder={setSharingFolderId}
          sharedFolderIds={markedFolderIds}
          creating={creating}
          onCreate={onCreate}
          onCancelCreate={() => setCreating(null)}
        />
        <SharedWithMeList shared={sharedWithMe} selectedDocId={selectedDocId} onOpen={(id) => navigate(`/docs/${encodeURIComponent(id)}`)} />
      </aside>
      <main style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {unsaved.map((u) => (
          <UnsavedPanel key={u.id} unsaved={u} onDismiss={() => dismissUnsavedDoc(u.id)} />
        ))}
        {!selectedDocId && (
          <div style={{ margin: "auto", color: theme.faint, fontSize: 13, textAlign: "center", lineHeight: 1.6 }}>
            {sharedWithMe.length > 0
              ? "Open a doc from the tree, or one shared with you under Shared with me."
              : loaded && tree.docs.length === 0
                ? "Create a doc or import some to get started."
                : "Open a doc from the tree."}
          </div>
        )}
        {selectedDocId && docGone && (
          <div data-testid="docs-gone" style={{ margin: "auto", color: theme.dim, fontSize: 13 }}>
            {deletedDocs.has(selectedDocId)
              ? "This doc no longer exists. It may have been deleted in another tab or by an agent."
              : "This doc no longer exists, or it isn't shared with you any more."}
          </div>
        )}
        {selectedDocId && !loaded && !sharedSelected && <div style={{ padding: 24, color: theme.dim, fontSize: 13 }}>Loading…</div>}
        {/* The pane waits for the tree: the editor maps each image's relative src to its asset as it renders it. */}
        {selectedDocId && sharedSelected && <SharedDocPane key={selectedDocId} docId={selectedDocId} />}
        {selectedDocId && loaded && !docGone && !sharedSelected && (
          <Suspense fallback={<div style={{ padding: 24, color: theme.dim }}>Loading…</div>}>
            <DocPane
              key={selectedDocId}
              docId={selectedDocId}
              tree={tree}
              remoteRevision={remoteRevision}
              onTreeChanged={() => void refreshTree()}
            />
          </Suspense>
        )}
      </main>
    </div>
  );
}
