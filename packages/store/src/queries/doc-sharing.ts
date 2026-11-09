import type { Database } from "bun:sqlite";
import type { DocDetail, DocFolder, SharedWithMe } from "@standup/shared";
import { DOC_FOLDER_DEPTH_MAX } from "@standup/shared";
import { getDoc, getDocFolder } from "./docs.js";

/**
 * Shareable docs (migration 096): a doc its owner marks shareable, or any doc
 * in a folder (or below a folder) its owner marks shareable, can be read by
 * every signed-in user, always at its latest revision, and commented on.
 * Only the owner writes it. `docAccessFor` is the one place that decides who
 * may read and comment on a doc; every docs route that serves another
 * user's doc goes through it. This is separate from share links
 * (share-grants.ts), which stay as they are.
 */

/** Who a viewer is to a doc: its owner, or a signed-in reader of a doc shared with everyone. */
export interface DocAccess {
  doc: DocDetail;
  owner: string;
  role: "owner" | "reader";
}

/** The nearest folder at or above `folderId` that is shareable, or null. */
export function shareableFolderAbove(db: Database, folderId: string | null, owner: string): DocFolder | null {
  let at = folderId;
  // Bounded: a chain longer than the depth cap can only be a corrupt cycle.
  for (let i = 0; at !== null && i <= DOC_FOLDER_DEPTH_MAX + 1; i++) {
    const folder = getDocFolder(db, at, owner);
    if (!folder) return null;
    if (folder.shareable) return folder;
    at = folder.parentId;
  }
  return null;
}

/**
 * What `viewer` may do with the doc `docId`: everything as its owner; read
 * and comment as anyone else when the doc, or a folder above it, is
 * shareable; nothing otherwise (null, the same as no such doc).
 */
export function docAccessFor(db: Database, docId: string, viewer: string): DocAccess | null {
  const row = db.query("SELECT owner FROM docs WHERE id = ?").get(docId) as { owner: string } | null;
  if (!row) return null;
  const doc = getDoc(db, docId, row.owner);
  if (!doc) return null;
  if (row.owner === viewer) return { doc, owner: row.owner, role: "owner" };
  if (doc.shareable || shareableFolderAbove(db, doc.folderId, row.owner)) return { doc, owner: row.owner, role: "reader" };
  return null;
}

/** Marks the owner's doc shareable or not; false when it isn't the owner's. The doc's revision is unchanged. */
export function setDocShareable(db: Database, id: string, owner: string, shareable: boolean): boolean {
  return db.run("UPDATE docs SET shareable = ? WHERE id = ? AND owner = ?", [shareable ? 1 : 0, id, owner]).changes > 0;
}

/** Marks the owner's folder shareable or not; false when it isn't the owner's. */
export function setDocFolderShareable(db: Database, id: string, owner: string, shareable: boolean): boolean {
  return db.run("UPDATE doc_folders SET shareable = ? WHERE id = ? AND owner = ?", [shareable ? 1 : 0, id, owner]).changes > 0;
}

/**
 * Every doc other users have made readable to `viewer`, grouped by owner
 * (owners and paths in name order). A doc's path starts at the topmost
 * shareable folder above it, or is just its name when it is shareable on its
 * own, so no unshared folder's name shows. Each owner's folders are read once
 * and walked in memory: a query per folder would scan the owner's rows.
 */
export function listSharedWithMe(db: Database, viewer: string): SharedWithMe[] {
  const owners = db
    .query(
      `SELECT owner FROM doc_folders WHERE shareable = 1 AND owner != ?
       UNION SELECT owner FROM docs WHERE shareable = 1 AND owner != ? ORDER BY owner`
    )
    .all(viewer, viewer) as Array<{ owner: string }>;
  const out: SharedWithMe[] = [];
  for (const { owner } of owners) {
    const folders = db.query("SELECT id, parent_id, name, shareable FROM doc_folders WHERE owner = ?").all(owner) as Array<{
      id: string;
      parent_id: string | null;
      name: string;
      shareable: number;
    }>;
    const byId = new Map(folders.map((f) => [f.id, f]));
    /**
     * The path readers see for a doc in `folderId`: from the topmost shareable
     * folder above it down, so no unshared folder's name is shown; null when
     * no folder above it is shareable (or the chain is corrupt).
     */
    const sharedPath = (folderId: string | null): string[] | null => {
      const names: string[] = [];
      let top = -1;
      let at = folderId;
      for (let i = 0; at !== null; i++) {
        const f = byId.get(at);
        if (!f || i > DOC_FOLDER_DEPTH_MAX) return null;
        names.unshift(f.name);
        if (f.shareable === 1) top = names.length;
        at = f.parent_id;
      }
      return top === -1 ? null : names.slice(names.length - top);
    };
    const docs = db.query("SELECT id, folder_id, name, shareable, updated_at FROM docs WHERE owner = ?").all(owner) as Array<{
      id: string;
      folder_id: string | null;
      name: string;
      shareable: number;
      updated_at: string;
    }>;
    const visible: SharedWithMe["docs"] = [];
    for (const d of docs) {
      const above = sharedPath(d.folder_id);
      if (!above && d.shareable !== 1) continue;
      // docAccessFor is the rule; the walk above only picks candidates and their paths.
      if (docAccessFor(db, d.id, viewer)?.role !== "reader") continue;
      visible.push({ id: d.id, path: [...(above ?? []), d.name].join("/"), updatedAt: d.updated_at });
    }
    visible.sort((a, b) => a.path.localeCompare(b.path));
    if (visible.length > 0) out.push({ owner, docs: visible });
  }
  return out;
}
