import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { LuChevronDown, LuChevronRight, LuFileText, LuFolder, LuFolderInput, LuFolderOpen, LuImage, LuPencil, LuShare2, LuTrash2 } from "react-icons/lu";
import type { DocTree as DocTreeData } from "@standup/shared";
import { alpha, theme } from "../theme";
import { docFolderPaths } from "@standup/shared";
import { canMove, type TreeItem } from "./docsTree";

/** A new folder or doc being named inline, in `parentId` (null: the root). */
export interface PendingCreate {
  kind: "folder" | "doc";
  parentId: string | null;
}

export interface DocTreeProps {
  tree: DocTreeData;
  selectedDocId: string | null;
  /** The folder new things go in and imports land in; null: the root. */
  selectedFolderId: string | null;
  expanded: ReadonlySet<string>;
  onToggleFolder: (folderId: string) => void;
  onSelectFolder: (folderId: string | null) => void;
  onSelectDoc: (docId: string) => void;
  /** Moves `item` into `folderId` (null: the root); the tree has already checked the move is allowed. */
  onMove: (item: TreeItem, folderId: string | null) => void;
  /** Renames `item`; resolves to an error message, or null once it is done. */
  onRename: (item: TreeItem, name: string) => Promise<string | null>;
  /** Deletes `item` (a folder with everything inside it); resolves to an error message, or null. */
  onDelete: (item: TreeItem) => Promise<string | null>;
  /** Opens the share switch of the folder `folderId`. */
  onShareFolder?: (folderId: string) => void;
  /** Folders shared by link, marked on their rows. */
  sharedFolderIds?: ReadonlySet<string>;
  creating: PendingCreate | null;
  onCreate: (name: string) => Promise<string | null>;
  onCancelCreate: () => void;
}

const ROOT_KEY = "root";
const DRAG_TYPE = "application/x-standup-doc-item";

const rowBase: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  minHeight: 26,
  paddingRight: 6,
  borderRadius: 5,
  fontSize: 13,
  cursor: "pointer",
  userSelect: "none",
};

const iconButton: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 22,
  height: 22,
  padding: 0,
  border: "none",
  borderRadius: 4,
  background: "transparent",
  color: theme.faint,
  cursor: "pointer",
};

const sortByName = <T extends { name: string }>(items: T[]) => [...items].sort((a, b) => a.name.localeCompare(b.name));

/** An inline name field: Enter commits, Escape (or leaving it empty) cancels. */
function NameInput({
  initial,
  label,
  onCommit,
  onCancel,
}: {
  initial: string;
  label: string;
  onCommit: (name: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const commit = async () => {
    const name = value.trim();
    if (!name || name === initial) return onCancel();
    setBusy(true);
    const err = await onCommit(name);
    setBusy(false);
    if (err) setError(err);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
      <input
        autoFocus
        data-testid="docs-name-input"
        aria-label={label}
        value={value}
        disabled={busy}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => !busy && !error && onCancel()}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          boxSizing: "border-box",
          padding: "2px 6px",
          borderRadius: 4,
          border: `1px solid ${error ? theme.waiting : theme.running}`,
          background: theme.ground,
          color: theme.text,
          fontSize: 13,
          outline: "none",
        }}
      />
      {error && (
        <span role="alert" style={{ color: theme.waiting, fontSize: 11.5 }}>
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * The left pane's tree: folders (expandable), docs, and images (dimmed).
 * Everything can be dragged onto a folder or the root to move it; a folder
 * can't be dropped into itself or anything inside it. Rename, Move to… (a
 * folder picker, the way to move without dragging) and delete are on each
 * row's actions, with Share on a folder's, shown on hover or keyboard focus; a delete asks first, and
 * a folder's says it takes everything inside with it.
 */
export function DocTree(props: DocTreeProps) {
  const { tree, selectedDocId, selectedFolderId, expanded, creating } = props;
  /**
   * The item being dragged from this tree; a ref, so every drag event reads
   * it whatever re-renders the drag causes. Only a drag that started on a row
   * here sets it, so a drop is a move only within this window.
   */
  const dragging = useRef<TreeItem | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [moving, setMoving] = useState<{ item: TreeItem; name: string } | null>(null);
  /** The button that opened the Move to… picker, which gets the focus back when it closes. */
  const moveOpener = useRef<HTMLElement | null>(null);

  // A newly opened doc's row scrolls into view once its folders have opened.
  const revealed = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedDocId || revealed.current === selectedDocId) return;
    const row = [...document.querySelectorAll<HTMLElement>('[data-testid="docs-doc-row"]')].find((el) => el.dataset.docId === selectedDocId);
    if (!row) return;
    revealed.current = selectedDocId;
    row.scrollIntoView?.({ block: "nearest" });
  }, [selectedDocId, expanded, tree]);

  // Any drag that ends anywhere (a drop outside the tree, a row that went
  // away mid-drag and never got its dragend) forgets the dragged item, so a
  // later drag of desktop files is never taken for a move. The clearing waits
  // a task so a drop on the tree still reads the item first.
  useEffect(() => {
    let pending: ReturnType<typeof setTimeout> | null = null;
    const forget = () => {
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => {
        pending = null;
        dragging.current = null;
      }, 0);
    };
    window.addEventListener("dragend", forget, true);
    window.addEventListener("drop", forget, true);
    return () => {
      window.removeEventListener("dragend", forget, true);
      window.removeEventListener("drop", forget, true);
      if (pending) clearTimeout(pending);
    };
  }, []);

  const closeMove = () => {
    setMoving(null);
    moveOpener.current?.focus();
    moveOpener.current = null;
  };
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ item: TreeItem; name: string } | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  const keyOf = (item: TreeItem) => `${item.kind}:${item.id}`;

  const dragProps = (item: TreeItem) => ({
    draggable: renaming !== keyOf(item),
    onDragStart: (e: DragEvent) => {
      e.stopPropagation();
      dragging.current = item;
      e.dataTransfer?.setData(DRAG_TYPE, keyOf(item));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    },
    onDragEnd: () => {
      dragging.current = null;
      setDropTarget(null);
    },
  });

  // A folder's drop zone is its row and everything listed under it, and the
  // innermost folder under the pointer decides alone: a drop it refuses (a
  // folder onto its own contents) doesn't fall through to an outer folder.
  // A browser takes the drop effect of the event that first reaches a new
  // element, which is dragenter, not dragover: a drop zone accepts both, or
  // a drop made as the pointer reaches one of its rows (or a child of a row)
  // is refused. Files dragged in from the desktop are refused here, and the
  // refusal is claimed (no drop effect) so the browser doesn't open the file
  // in place of the console.
  const dropProps = (folderId: string | null) => {
    const key = folderId ?? ROOT_KEY;
    const desktopFiles = (e: DragEvent) => dragging.current === null && Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const accept = (e: DragEvent) => {
      e.stopPropagation();
      if (desktopFiles(e)) {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
        return;
      }
      const item = dragging.current;
      if (!item || !canMove(tree, item, folderId)) {
        if (dropTarget === key) setDropTarget(null);
        return;
      }
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      if (dropTarget !== key) setDropTarget(key);
    };
    return {
      onDragEnter: accept,
      onDragOver: accept,
      onDragLeave: (e: DragEvent) => {
        e.stopPropagation();
        // Moving onto a child of the zone fires a leave too; only a leave to somewhere outside it un-highlights.
        const to = e.relatedTarget as Node | null;
        if (dropTarget === key && to && !(e.currentTarget as Node).contains(to)) setDropTarget(null);
      },
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const item = dragging.current;
        dragging.current = null;
        setDropTarget(null);
        if (item && canMove(tree, item, folderId)) props.onMove(item, folderId);
      },
    };
  };

  const actions = (item: TreeItem, name: string) => (
    // Shown on hover, and on keyboard focus: the actions stay in the tab order while hidden.
    <span
      onFocus={() => setHover(keyOf(item))}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHover((prev) => (prev === keyOf(item) ? null : prev));
      }}
      style={{ display: "inline-flex", gap: 2, marginLeft: "auto", opacity: hover === keyOf(item) ? 1 : 0 }}
    >
      <button
        type="button"
        title={`Rename ${name}`}
        aria-label={`Rename ${name}`}
        data-testid="docs-rename"
        style={iconButton}
        onClick={(e) => {
          e.stopPropagation();
          setRenaming(keyOf(item));
        }}
      >
        <LuPencil size={13} />
      </button>
      {item.kind === "folder" && props.onShareFolder && (
        <button
          type="button"
          title={`Share ${name}`}
          aria-label={`Share ${name}`}
          data-testid="docs-share-folder"
          style={iconButton}
          onClick={(e) => {
            e.stopPropagation();
            props.onShareFolder?.(item.id);
          }}
        >
          <LuShare2 size={13} />
        </button>
      )}
      <button
        type="button"
        title={`Move ${name} to…`}
        aria-label={`Move ${name} to…`}
        data-testid="docs-move"
        style={iconButton}
        onClick={(e) => {
          e.stopPropagation();
          moveOpener.current = e.currentTarget;
          setMoving({ item, name });
        }}
      >
        <LuFolderInput size={13} />
      </button>
      <button
        type="button"
        title={`Delete ${name}`}
        aria-label={`Delete ${name}`}
        data-testid="docs-delete"
        style={iconButton}
        onClick={(e) => {
          e.stopPropagation();
          setDeleteError(null);
          setConfirming({ item, name });
        }}
      >
        <LuTrash2 size={13} />
      </button>
    </span>
  );

  const label = (item: TreeItem, name: string, style?: CSSProperties) =>
    renaming === keyOf(item) ? (
      <NameInput
        initial={name}
        label={`New name for ${name}`}
        onCancel={() => setRenaming(null)}
        onCommit={async (next) => {
          const err = await props.onRename(item, next);
          if (!err) setRenaming(null);
          return err;
        }}
      />
    ) : (
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, ...style }}>{name}</span>
    );

  const createRow = (parentId: string | null, depth: number): ReactNode =>
    creating && creating.parentId === parentId ? (
      <div style={{ ...rowBase, paddingLeft: 8 + depth * 14, cursor: "default" }}>
        {creating.kind === "folder" ? <LuFolder size={14} color={theme.dim} /> : <LuFileText size={14} color={theme.dim} />}
        <NameInput
          initial=""
          label={creating.kind === "folder" ? "New folder name" : "New doc name"}
          onCancel={props.onCancelCreate}
          onCommit={props.onCreate}
        />
      </div>
    ) : null;

  const renderFolder = (parentId: string | null, depth: number): ReactNode => {
    const folders = sortByName(tree.folders.filter((f) => f.parentId === parentId));
    const docs = sortByName(tree.docs.filter((d) => d.folderId === parentId));
    const assets = sortByName(tree.assets.filter((a) => a.folderId === parentId));
    const indent = 8 + depth * 14;
    return (
      <>
        {createRow(parentId, depth)}
        {folders.map((folder) => {
          const item: TreeItem = { kind: "folder", id: folder.id };
          const open = expanded.has(folder.id);
          const target = dropTarget === folder.id;
          const selected = selectedFolderId === folder.id;
          return (
            <div
              key={folder.id}
              {...dropProps(folder.id)}
              data-testid="docs-folder"
              data-folder-id={folder.id}
              style={{ borderRadius: 5, outline: target ? `1px dashed ${theme.running}` : "none", background: target ? alpha(theme.running, 0x1a) : "transparent" }}
            >
              <div
                {...dragProps(item)}
                onMouseEnter={() => setHover(keyOf(item))}
                onMouseLeave={() => setHover(null)}
                onClick={() => {
                  props.onSelectFolder(folder.id);
                  props.onToggleFolder(folder.id);
                }}
                data-testid="docs-folder-row"
                data-drop-target={target ? "true" : undefined}
                style={{
                  ...rowBase,
                  paddingLeft: indent,
                  color: theme.text,
                  background: target ? alpha(theme.running, 0x2e) : selected ? theme.hover : "transparent",
                }}
              >
                {open ? <LuChevronDown size={13} color={theme.faint} /> : <LuChevronRight size={13} color={theme.faint} />}
                {open ? <LuFolderOpen size={14} color={theme.accent} /> : <LuFolder size={14} color={theme.accent} />}
                {label(item, folder.name)}
                {props.sharedFolderIds?.has(folder.id) && renaming !== keyOf(item) && (
                  <span data-testid="docs-folder-shared" title="Shared by link: anyone with the link can read this folder" style={{ display: "inline-flex", flexShrink: 0 }}>
                    <LuShare2 size={12} color={theme.checkpoint} aria-label="Shared by link" />
                  </span>
                )}
                {renaming !== keyOf(item) && actions(item, folder.name)}
              </div>
              {open && renderFolder(folder.id, depth + 1)}
            </div>
          );
        })}
        {docs.map((doc) => {
          const item: TreeItem = { kind: "doc", id: doc.id };
          const selected = selectedDocId === doc.id;
          return (
            <div
              key={doc.id}
              {...dragProps(item)}
              data-testid="docs-doc-row"
              data-doc-id={doc.id}
              aria-current={selected ? "page" : undefined}
              onMouseEnter={() => setHover(keyOf(item))}
              onMouseLeave={() => setHover(null)}
              onClick={() => props.onSelectDoc(doc.id)}
              style={{
                ...rowBase,
                paddingLeft: indent + 19,
                color: selected ? theme.text : theme.dim,
                background: selected ? theme.raised : "transparent",
              }}
            >
              <LuFileText size={14} color={selected ? theme.running : theme.faint} />
              {label(item, doc.name)}
              {renaming !== keyOf(item) && actions(item, doc.name)}
            </div>
          );
        })}
        {assets.map((asset) => {
          const item: TreeItem = { kind: "asset", id: asset.id };
          return (
            <div
              key={asset.id}
              {...dragProps(item)}
              data-testid="docs-asset-row"
              data-asset-id={asset.id}
              title={`${asset.name} — an image docs in this folder can show`}
              onMouseEnter={() => setHover(keyOf(item))}
              onMouseLeave={() => setHover(null)}
              style={{ ...rowBase, paddingLeft: indent + 19, color: theme.faint, cursor: "grab", opacity: 0.75 }}
            >
              <LuImage size={14} />
              {label(item, asset.name, { fontSize: 12.5 })}
              {renaming !== keyOf(item) && actions(item, asset.name)}
            </div>
          );
        })}
      </>
    );
  };

  const rootTarget = dropTarget === ROOT_KEY;
  const empty = tree.folders.length === 0 && tree.docs.length === 0 && tree.assets.length === 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1, flex: 1, minHeight: 0 }}>
      {moving && (
        <div
          role="dialog"
          aria-label={`Move ${moving.name} to a folder`}
          data-testid="docs-move-picker"
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            e.stopPropagation();
            closeMove();
          }}
          style={{
            margin: "0 0 6px",
            padding: "8px 10px",
            borderRadius: 6,
            border: `1px solid ${theme.edge}`,
            background: theme.surface,
            fontSize: 12.5,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <span>Move “{moving.name}” to:</span>
          <div role="list" style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 220, overflowY: "auto" }}>
            {[
              { id: null as string | null, label: "All docs (top level)" },
              ...[...docFolderPaths(tree.folders)].map(([id, path]) => ({ id: id as string | null, label: path.join("/") })).sort((a, b) => a.label.localeCompare(b.label)),
            ].map((target) => {
              const allowed = canMove(tree, moving.item, target.id);
              return (
                <button
                  key={target.id ?? ROOT_KEY}
                  type="button"
                  role="listitem"
                  data-testid="docs-move-target"
                  data-folder-id={target.id ?? ""}
                  disabled={!allowed}
                  onClick={() => {
                    const item = moving.item;
                    closeMove();
                    props.onMove(item, target.id);
                  }}
                  style={{
                    textAlign: "left",
                    padding: "3px 8px",
                    borderRadius: 4,
                    border: "none",
                    background: "transparent",
                    color: allowed ? theme.text : theme.faint,
                    cursor: allowed ? "pointer" : "default",
                    overflowWrap: "anywhere",
                  }}
                >
                  {target.label}
                </button>
              );
            })}
          </div>
          <span>
            <button
              type="button"
              data-testid="docs-move-cancel"
              autoFocus
              onClick={closeMove}
              style={{ padding: "3px 10px", borderRadius: 5, border: `1px solid ${theme.edge}`, background: "transparent", color: theme.text, cursor: "pointer" }}
            >
              Cancel
            </button>
          </span>
        </div>
      )}
      {confirming && (
        <div
          role="alertdialog"
          aria-label="Confirm delete"
          data-testid="docs-delete-confirm"
          style={{
            margin: "0 0 6px",
            padding: "8px 10px",
            borderRadius: 6,
            border: `1px solid ${alpha(theme.waiting, 0x66)}`,
            background: alpha(theme.waiting, 0x14),
            fontSize: 12.5,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <span>
            {confirming.item.kind === "folder"
              ? `Delete the folder “${confirming.name}” and everything inside it? This can't be undone.`
              : `Delete “${confirming.name}”? This can't be undone.`}
          </span>
          {deleteError && <span style={{ color: theme.waiting }}>{deleteError}</span>}
          <span style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              data-testid="docs-delete-confirm-button"
              onClick={async () => {
                const err = await props.onDelete(confirming.item);
                if (err) setDeleteError(err);
                else setConfirming(null);
              }}
              style={{ padding: "3px 10px", borderRadius: 5, border: "none", background: theme.waiting, color: theme.ground, fontWeight: 600, cursor: "pointer" }}
            >
              Delete
            </button>
            <button
              type="button"
              onClick={() => setConfirming(null)}
              style={{ padding: "3px 10px", borderRadius: 5, border: `1px solid ${theme.edge}`, background: "transparent", color: theme.text, cursor: "pointer" }}
            >
              Cancel
            </button>
          </span>
        </div>
      )}
      <div
        {...dropProps(null)}
        data-testid="docs-root"
        data-drop-target={rootTarget ? "true" : undefined}
        onClick={() => props.onSelectFolder(null)}
        style={{
          ...rowBase,
          paddingLeft: 8,
          color: selectedFolderId === null ? theme.text : theme.dim,
          fontWeight: 600,
          fontSize: 12,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          background: rootTarget ? alpha(theme.running, 0x2e) : "transparent",
          outline: rootTarget ? `1px dashed ${theme.running}` : "none",
        }}
      >
        All docs
      </div>
      <div {...dropProps(null)} style={{ display: "flex", flexDirection: "column", gap: 1, flex: 1, overflowY: "auto", paddingBottom: 24 }}>
        {renderFolder(null, 0)}
        {empty && !creating && (
          <div style={{ padding: "10px 8px", color: theme.faint, fontSize: 12.5, lineHeight: 1.5 }}>
            No docs yet. Create one, or import a folder of markdown from this machine.
          </div>
        )}
      </div>
    </div>
  );
}
