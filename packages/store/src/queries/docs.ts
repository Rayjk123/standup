import type { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import type { DocAsset, DocDetail, DocFolder, DocSearchHit, DocSummary, DocTree } from "@standup/shared";
import {
  DOC_BODY_MAX_BYTES,
  DOC_FOLDER_DEPTH_MAX,
  DOC_NAME_MAX,
  DOC_OWNER_ASSET_QUOTA_BYTES,
  DOC_OWNER_BODY_QUOTA_BYTES,
  DOC_OWNER_MAX_ITEMS,
  docPaths,
  isValidDocName,
} from "@standup/shared";
import { deleteDocComments } from "./doc-comments.js";
import { getLiveGrant, revokeGrantsFor } from "./share-grants.js";

/**
 * Each owner's doc tree (migration 080): folders, markdown docs and image
 * assets. Every read and write is scoped by owner; a row of anyone else's
 * reads as missing. A name is unique within its folder across all three
 * kinds. Deletes are recursive here, not cascades, and revoke the share
 * links of the docs they remove in the same transaction; a folder's delete
 * returns the docs and asset copies it removed, so the caller can drop copies
 * nothing else names. Each owner's tree is capped (DocLimits) inside the
 * transaction that grows it.
 */

/**
 * Why a doc-tree write was refused; the route maps `code` to a status:
 * not_found 404, conflict 409, invalid 400, and both too_large (one doc or
 * image over its cap) and quota (the owner's tree over one of its DocLimits,
 * in bytes or in items) 413.
 */
export type DocErrorCode = "not_found" | "conflict" | "invalid" | "too_large" | "quota";

export class DocError extends Error {
  readonly code: DocErrorCode;
  constructor(code: DocErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** An asset as stored: the listed fields plus its owner and the digest naming its stored copy. */
export interface DocAssetRow extends DocAsset {
  owner: string;
  sha256: string;
}

interface FolderRow {
  id: string;
  owner: string;
  parent_id: string | null;
  name: string;
  created_at: string;
  updated_at: string;
  /** Migration 096; 1 when every signed-in user may read what is in the folder. */
  shareable?: number;
}

interface DocRow {
  id: string;
  owner: string;
  folder_id: string | null;
  name: string;
  /** The body's UTF-8 bytes (a BLOB, so a leading byte-order mark survives; see migration 080). */
  body: Uint8Array | string;
  revision: number;
  bytes: number;
  created_at: string;
  updated_at: string;
  /** Migration 096; 1 when every signed-in user may read the doc. */
  shareable?: number;
}

interface AssetRow {
  id: string;
  owner: string;
  folder_id: string | null;
  name: string;
  mime: string;
  sha256: string;
  bytes: number;
  created_at: string;
}

/** The URL an asset's bytes are read from by its owner. */
export function docAssetUrl(id: string): string {
  return `/api/docs/assets/${id}`;
}

function toFolder(r: FolderRow): DocFolder {
  return { id: r.id, parentId: r.parent_id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at, ...(r.shareable ? { shareable: true } : {}) };
}

function toSummary(r: Omit<DocRow, "body">): DocSummary {
  return {
    id: r.id,
    folderId: r.folder_id,
    name: r.name,
    revision: r.revision,
    bytes: r.bytes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.shareable ? { shareable: true } : {}),
  };
}

function toDetail(r: DocRow): DocDetail {
  return { ...toSummary(r), body: decodeBody(r.body) };
}

/** A body as stored: its UTF-8 bytes. */
function encodeBody(body: string): Uint8Array {
  return Buffer.from(body, "utf8");
}

function decodeBody(stored: Uint8Array | string): string {
  return typeof stored === "string" ? stored : Buffer.from(stored.buffer, stored.byteOffset, stored.byteLength).toString("utf8");
}

function toAssetRow(r: AssetRow): DocAssetRow {
  return {
    id: r.id,
    folderId: r.folder_id,
    name: r.name,
    mime: r.mime,
    bytes: r.bytes,
    createdAt: r.created_at,
    url: docAssetUrl(r.id),
    owner: r.owner,
    sha256: r.sha256,
  };
}

/** An asset's listed fields, without its owner or digest. */
export function toDocAssetInfo(a: DocAssetRow): DocAsset {
  return { id: a.id, folderId: a.folderId, name: a.name, mime: a.mime, bytes: a.bytes, createdAt: a.createdAt, url: a.url };
}

/** A body's size as stored, in UTF-8 bytes. */
export function docBodyBytes(body: string): number {
  return Buffer.byteLength(body, "utf8");
}

function checkName(name: unknown): string {
  if (!isValidDocName(name)) throw new DocError("invalid", "name must be a non-empty name without slashes or control characters");
  return name;
}

function checkBody(body: string): number {
  const bytes = docBodyBytes(body);
  if (bytes > DOC_BODY_MAX_BYTES) throw new DocError("too_large", `the doc is over ${DOC_BODY_MAX_BYTES} bytes`);
  return bytes;
}

// ── Per-owner limits ────────────────────────────────────────────────────────

/** Caps on one owner's whole tree: image bytes (summed over asset rows), doc body bytes, and folders + docs + assets. */
export interface DocLimits {
  assetBytes: number;
  bodyBytes: number;
  items: number;
}

export const DEFAULT_DOC_LIMITS: Readonly<DocLimits> = {
  assetBytes: DOC_OWNER_ASSET_QUOTA_BYTES,
  bodyBytes: DOC_OWNER_BODY_QUOTA_BYTES,
  items: DOC_OWNER_MAX_ITEMS,
};

function limitsOf(limits: Partial<DocLimits> | undefined): DocLimits {
  return { ...DEFAULT_DOC_LIMITS, ...limits };
}

/** How many folders, docs and assets the owner has. */
function ownerItemCount(db: Database, owner: string): number {
  const row = db
    .query(
      `SELECT (SELECT COUNT(*) FROM doc_folders WHERE owner = ?1)
            + (SELECT COUNT(*) FROM docs WHERE owner = ?1)
            + (SELECT COUNT(*) FROM doc_assets WHERE owner = ?1) AS n`
    )
    .get(owner) as { n: number };
  return row.n;
}

function ownerBytes(db: Database, table: "docs" | "doc_assets", owner: string): number {
  return (db.query(`SELECT COALESCE(SUM(bytes), 0) AS n FROM ${table} WHERE owner = ?`).get(owner) as { n: number }).n;
}

/** Throws quota when one more folder, doc or asset would put the owner over the item cap. */
function requireItemRoom(db: Database, owner: string, limits: DocLimits): void {
  if (ownerItemCount(db, owner) + 1 > limits.items) {
    throw new DocError("quota", `your Docs hold at most ${limits.items} folders, docs and images`);
  }
}

/** Throws quota when a body growing from `before` to `after` bytes would put the owner's doc text over its cap. */
function requireBodyRoom(db: Database, owner: string, limits: DocLimits, before: number, after: number): void {
  if (after <= before) return;
  if (ownerBytes(db, "docs", owner) - before + after > limits.bodyBytes) {
    throw new DocError("quota", `your docs' text is capped at ${limits.bodyBytes} bytes in all`);
  }
}

/** Throws quota when `bytes` more image bytes would put the owner over the image cap. */
function requireAssetRoom(db: Database, owner: string, limits: DocLimits, bytes: number): void {
  if (ownerBytes(db, "doc_assets", owner) + bytes > limits.assetBytes) {
    throw new DocError("quota", `your Docs' images are capped at ${limits.assetBytes} bytes in all`);
  }
}

// ── Folders ─────────────────────────────────────────────────────────────────

/** The owner's folder, or null. */
export function getDocFolder(db: Database, id: string, owner: string): DocFolder | null {
  const row = db.query("SELECT * FROM doc_folders WHERE id = ? AND owner = ?").get(id, owner) as FolderRow | null;
  return row ? toFolder(row) : null;
}

/** The owner's folder named `name` directly under `parentId` (null: the root), or null. */
function folderNamed(db: Database, owner: string, parentId: string | null, name: string): DocFolder | null {
  const row = db
    .query("SELECT * FROM doc_folders WHERE owner = ? AND COALESCE(parent_id, '') = COALESCE(?, '') AND name = ?")
    .get(owner, parentId, name) as FolderRow | null;
  return row ? toFolder(row) : null;
}

/** The names of the folders from the root down to `folderId` (empty for the root); null when one isn't the owner's. */
export function docFolderPath(db: Database, folderId: string | null, owner: string): string[] | null {
  const names: string[] = [];
  let at = folderId;
  // Bounded: a chain longer than the depth cap can only be a corrupt cycle.
  for (let i = 0; at !== null; i++) {
    if (i > DOC_FOLDER_DEPTH_MAX) return null;
    const folder = getDocFolder(db, at, owner);
    if (!folder) return null;
    names.unshift(folder.name);
    at = folder.parentId;
  }
  return names;
}

/** The folder `folderId` must name: the root (null) or a folder of the owner's; throws not_found otherwise. */
function requireParent(db: Database, folderId: string | null, owner: string): string[] {
  const path = docFolderPath(db, folderId, owner);
  if (!path) throw new DocError("not_found", "Unknown folder");
  return path;
}

/** Ids of every folder below `folderId` (not itself), each before its own children. */
function descendantFolderIds(db: Database, folderId: string, owner: string): string[] {
  const out: string[] = [];
  let frontier = [folderId];
  for (let depth = 0; frontier.length > 0 && depth <= DOC_FOLDER_DEPTH_MAX + 1; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      const children = db.query("SELECT id FROM doc_folders WHERE owner = ? AND parent_id = ?").all(owner, id) as Array<{ id: string }>;
      for (const c of children) next.push(c.id);
    }
    out.push(...next);
    frontier = next;
  }
  return out;
}

/** How many folder levels are below `folderId` (0 for a folder with no subfolders). */
function subtreeHeight(db: Database, folderId: string, owner: string): number {
  let height = 0;
  let frontier = [folderId];
  while (frontier.length > 0 && height <= DOC_FOLDER_DEPTH_MAX + 1) {
    const next: string[] = [];
    for (const id of frontier) {
      const children = db.query("SELECT id FROM doc_folders WHERE owner = ? AND parent_id = ?").all(owner, id) as Array<{ id: string }>;
      for (const c of children) next.push(c.id);
    }
    if (next.length === 0) break;
    height++;
    frontier = next;
  }
  return height;
}

/**
 * Whether `name` is taken directly under `parentId` by a folder, doc or
 * asset of the owner's; `except` names the row being renamed or moved.
 */
export function docNameTaken(
  db: Database,
  owner: string,
  parentId: string | null,
  name: string,
  except?: { kind: "folder" | "doc" | "asset"; id: string }
): boolean {
  const checks: Array<[kind: "folder" | "doc" | "asset", sql: string]> = [
    ["folder", "SELECT id FROM doc_folders WHERE owner = ? AND COALESCE(parent_id, '') = COALESCE(?, '') AND name = ?"],
    ["doc", "SELECT id FROM docs WHERE owner = ? AND COALESCE(folder_id, '') = COALESCE(?, '') AND name = ?"],
    ["asset", "SELECT id FROM doc_assets WHERE owner = ? AND COALESCE(folder_id, '') = COALESCE(?, '') AND name = ?"],
  ];
  for (const [kind, sql] of checks) {
    const rows = db.query(sql).all(owner, parentId, name) as Array<{ id: string }>;
    if (rows.some((r) => !(except && except.kind === kind && except.id === r.id))) return true;
  }
  return false;
}

function requireFreeName(
  db: Database,
  owner: string,
  parentId: string | null,
  name: string,
  except?: { kind: "folder" | "doc" | "asset"; id: string }
): void {
  if (docNameTaken(db, owner, parentId, name, except)) {
    throw new DocError("conflict", `"${name}" already exists in this folder`);
  }
}

/** `text` cut to at most `max` UTF-16 units, never splitting a surrogate pair. */
function cutTo(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, Math.max(0, max));
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * `name`, or the first of `name (2)`, `name (3)`… that is free directly
 * under `parentId`. A file's suffix goes before its extension (`a (2).md`); a
 * folder's goes at the very end (`notes.v2 (2)`). The stem is cut so the
 * suffixed name stays within DOC_NAME_MAX.
 */
export function uniqueDocName(
  db: Database,
  owner: string,
  parentId: string | null,
  name: string,
  kind: "file" | "folder" = "file"
): string {
  if (!docNameTaken(db, owner, parentId, name)) return name;
  const dot = kind === "file" ? name.lastIndexOf(".") : -1;
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`;
    let stem = dot > 0 ? name.slice(0, dot) : name;
    let ext = dot > 0 ? name.slice(dot) : "";
    // An extension too long to keep beside a suffix is treated as part of the stem.
    if (DOC_NAME_MAX - suffix.length - ext.length < 1) {
      stem = name;
      ext = "";
    }
    const candidate = `${cutTo(stem, DOC_NAME_MAX - suffix.length - ext.length)}${suffix}${ext}`;
    if (!docNameTaken(db, owner, parentId, candidate)) return candidate;
  }
}

/** Creates a folder of the owner's under `parentId` (null: the root). */
export function createDocFolder(
  db: Database,
  input: { owner: string; parentId: string | null; name: string; limits?: Partial<DocLimits> },
  now: Date = new Date()
): DocFolder {
  const create = db.transaction((): DocFolder => {
    const name = checkName(input.name);
    const parentPath = requireParent(db, input.parentId, input.owner);
    if (parentPath.length + 1 > DOC_FOLDER_DEPTH_MAX) {
      throw new DocError("invalid", `folders nest at most ${DOC_FOLDER_DEPTH_MAX} deep`);
    }
    requireFreeName(db, input.owner, input.parentId, name);
    requireItemRoom(db, input.owner, limitsOf(input.limits));
    const id = randomUUID();
    const at = now.toISOString();
    db.run("INSERT INTO doc_folders (id, owner, parent_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [
      id,
      input.owner,
      input.parentId,
      name,
      at,
      at,
    ]);
    return { id, parentId: input.parentId, name, createdAt: at, updatedAt: at };
  });
  return create();
}

/**
 * Renames and/or moves the owner's folder. A move may not put a folder inside
 * itself or one of its own subfolders, nor nest anything past the depth cap.
 */
export function updateDocFolder(
  db: Database,
  input: { id: string; owner: string; name?: string; parentId?: string | null },
  now: Date = new Date()
): DocFolder {
  const update = db.transaction((): DocFolder => {
    const folder = getDocFolder(db, input.id, input.owner);
    if (!folder) throw new DocError("not_found", "Unknown folder");
    const name = input.name === undefined ? folder.name : checkName(input.name);
    const parentId = input.parentId === undefined ? folder.parentId : input.parentId;
    if (parentId !== folder.parentId) {
      const parentPath = requireParent(db, parentId, input.owner);
      if (parentId === folder.id || (parentId !== null && descendantFolderIds(db, folder.id, input.owner).includes(parentId))) {
        throw new DocError("invalid", "a folder can't be moved into itself or one of its subfolders");
      }
      if (parentPath.length + 1 + subtreeHeight(db, folder.id, input.owner) > DOC_FOLDER_DEPTH_MAX) {
        throw new DocError("invalid", `folders nest at most ${DOC_FOLDER_DEPTH_MAX} deep`);
      }
    }
    if (name === folder.name && parentId === folder.parentId) return folder;
    requireFreeName(db, input.owner, parentId, name, { kind: "folder", id: folder.id });
    const at = now.toISOString();
    db.run("UPDATE doc_folders SET name = ?, parent_id = ?, updated_at = ? WHERE id = ? AND owner = ?", [
      name,
      parentId,
      at,
      folder.id,
      input.owner,
    ]);
    return { ...folder, name, parentId, updatedAt: at };
  });
  return update();
}

/** What a recursive delete removed: the docs (for their share links) and the asset rows (for their stored copies). */
export interface DocDeletion {
  docIds: string[];
  assets: Array<{ sha256: string; mime: string }>;
}

/**
 * Deletes the owner's folder with everything in it, revoking the share links
 * of its docs and of it and every folder below it; null when it isn't the owner's.
 */
export function deleteDocFolder(db: Database, id: string, owner: string): DocDeletion | null {
  const remove = db.transaction((): DocDeletion | null => {
    if (!getDocFolder(db, id, owner)) return null;
    const folderIds = [id, ...descendantFolderIds(db, id, owner)];
    const docIds: string[] = [];
    const assets: Array<{ sha256: string; mime: string }> = [];
    for (const folderId of folderIds) {
      const docs = db.query("SELECT id FROM docs WHERE owner = ? AND folder_id = ?").all(owner, folderId) as Array<{ id: string }>;
      docIds.push(...docs.map((d) => d.id));
      assets.push(
        ...(db.query("SELECT sha256, mime FROM doc_assets WHERE owner = ? AND folder_id = ?").all(owner, folderId) as Array<{
          sha256: string;
          mime: string;
        }>)
      );
      db.run("DELETE FROM docs WHERE owner = ? AND folder_id = ?", [owner, folderId]);
      db.run("DELETE FROM doc_assets WHERE owner = ? AND folder_id = ?", [owner, folderId]);
    }
    // Deepest first, so no folder is removed while a subfolder still names it.
    for (const folderId of [...folderIds].reverse()) {
      db.run("DELETE FROM doc_folders WHERE id = ? AND owner = ?", [folderId, owner]);
    }
    revokeGrantsFor(db, "doc", docIds);
    revokeGrantsFor(db, "folder", folderIds);
    deleteDocComments(db, docIds);
    return { docIds, assets };
  });
  return remove();
}

// ── Docs ────────────────────────────────────────────────────────────────────

/** The owner's doc with its body, or null. */
export function getDoc(db: Database, id: string, owner: string): DocDetail | null {
  const row = db.query("SELECT * FROM docs WHERE id = ? AND owner = ?").get(id, owner) as DocRow | null;
  return row ? toDetail(row) : null;
}

/** Creates a doc of the owner's in `folderId` (null: the root). */
export function createDoc(
  db: Database,
  input: { owner: string; folderId: string | null; name: string; body?: string; limits?: Partial<DocLimits> },
  now: Date = new Date()
): DocDetail {
  const create = db.transaction((): DocDetail => {
    const name = checkName(input.name);
    const body = input.body ?? "";
    const bytes = checkBody(body);
    requireParent(db, input.folderId, input.owner);
    requireFreeName(db, input.owner, input.folderId, name);
    const limits = limitsOf(input.limits);
    requireItemRoom(db, input.owner, limits);
    requireBodyRoom(db, input.owner, limits, 0, bytes);
    const id = randomUUID();
    const at = now.toISOString();
    db.run(
      `INSERT INTO docs (id, owner, folder_id, name, body, revision, bytes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      [id, input.owner, input.folderId, name, encodeBody(body), bytes, at, at]
    );
    return { id, folderId: input.folderId, name, body, revision: 1, bytes, createdAt: at, updatedAt: at };
  });
  return create();
}

/** How an update came out: the saved doc, or the doc as it stands when `baseRevision` was stale. */
export type DocUpdateResult =
  | { ok: true; doc: DocDetail; renamed: boolean; moved: boolean; bodyChanged: boolean }
  | { ok: false; reason: "revision"; doc: DocDetail };

/**
 * Updates the owner's doc: its name, folder and/or body. With
 * `baseRevision`, the update is refused (with the current doc) unless the
 * doc is still at that revision. The revision is bumped when the body or the
 * name changes; a move alone keeps it.
 */
export function updateDoc(
  db: Database,
  input: {
    id: string;
    owner: string;
    name?: string;
    folderId?: string | null;
    body?: string;
    baseRevision?: number;
    limits?: Partial<DocLimits>;
  },
  now: Date = new Date()
): DocUpdateResult {
  const update = db.transaction((): DocUpdateResult => {
    const doc = getDoc(db, input.id, input.owner);
    if (!doc) throw new DocError("not_found", "Unknown doc");
    if (input.baseRevision !== undefined && input.baseRevision !== doc.revision) return { ok: false, reason: "revision", doc };
    const name = input.name === undefined ? doc.name : checkName(input.name);
    const folderId = input.folderId === undefined ? doc.folderId : input.folderId;
    const body = input.body === undefined ? doc.body : input.body;
    const bytes = input.body === undefined ? doc.bytes : checkBody(body);
    const moved = folderId !== doc.folderId;
    const renamed = name !== doc.name;
    const bodyChanged = body !== doc.body;
    if (moved) requireParent(db, folderId, input.owner);
    if (moved || renamed) requireFreeName(db, input.owner, folderId, name, { kind: "doc", id: doc.id });
    if (!moved && !renamed && !bodyChanged) return { ok: true, doc, renamed, moved, bodyChanged };
    if (bodyChanged) requireBodyRoom(db, input.owner, limitsOf(input.limits), doc.bytes, bytes);
    const revision = renamed || bodyChanged ? doc.revision + 1 : doc.revision;
    const at = now.toISOString();
    db.run(
      "UPDATE docs SET name = ?, folder_id = ?, body = ?, bytes = ?, revision = ?, updated_at = ? WHERE id = ? AND owner = ?",
      [name, folderId, encodeBody(body), bytes, revision, at, doc.id, input.owner]
    );
    return { ok: true, doc: { ...doc, name, folderId, body, bytes, revision, updatedAt: at }, renamed, moved, bodyChanged };
  });
  return update();
}

/** Deletes the owner's doc and revokes its share link; whether it was theirs. */
export function deleteDoc(db: Database, id: string, owner: string): boolean {
  const remove = db.transaction((): boolean => {
    if (db.run("DELETE FROM docs WHERE id = ? AND owner = ?", [id, owner]).changes === 0) return false;
    revokeGrantsFor(db, "doc", [id]);
    deleteDocComments(db, [id]);
    return true;
  });
  return remove();
}

// ── Assets ──────────────────────────────────────────────────────────────────

/** The owner's asset, or null. */
export function getDocAsset(db: Database, id: string, owner: string): DocAssetRow | null {
  const row = db.query("SELECT * FROM doc_assets WHERE id = ? AND owner = ?").get(id, owner) as AssetRow | null;
  return row ? toAssetRow(row) : null;
}

/** Records an asset of the owner's whose bytes are stored under `sha256`. */
export function createDocAsset(
  db: Database,
  input: {
    owner: string;
    folderId: string | null;
    name: string;
    mime: string;
    sha256: string;
    bytes: number;
    limits?: Partial<DocLimits>;
  },
  now: Date = new Date()
): DocAssetRow {
  const create = db.transaction((): DocAssetRow => {
    const name = checkName(input.name);
    requireParent(db, input.folderId, input.owner);
    requireFreeName(db, input.owner, input.folderId, name);
    const limits = limitsOf(input.limits);
    requireItemRoom(db, input.owner, limits);
    requireAssetRoom(db, input.owner, limits, input.bytes);
    const id = randomUUID();
    const at = now.toISOString();
    db.run(
      `INSERT INTO doc_assets (id, owner, folder_id, name, mime, sha256, bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.owner, input.folderId, name, input.mime, input.sha256, input.bytes, at]
    );
    return toAssetRow({ id, owner: input.owner, folder_id: input.folderId, name, mime: input.mime, sha256: input.sha256, bytes: input.bytes, created_at: at });
  });
  return create();
}

/** Renames and/or moves the owner's asset. */
export function updateDocAsset(db: Database, input: { id: string; owner: string; name?: string; folderId?: string | null }): DocAssetRow {
  const update = db.transaction((): DocAssetRow => {
    const asset = getDocAsset(db, input.id, input.owner);
    if (!asset) throw new DocError("not_found", "Unknown asset");
    const name = input.name === undefined ? asset.name : checkName(input.name);
    const folderId = input.folderId === undefined ? asset.folderId : input.folderId;
    if (name === asset.name && folderId === asset.folderId) return asset;
    if (folderId !== asset.folderId) requireParent(db, folderId, input.owner);
    requireFreeName(db, input.owner, folderId, name, { kind: "asset", id: asset.id });
    db.run("UPDATE doc_assets SET name = ?, folder_id = ? WHERE id = ? AND owner = ?", [name, folderId, asset.id, input.owner]);
    return { ...asset, name, folderId };
  });
  return update();
}

/** Deletes the owner's asset; the removed row, or null when it wasn't theirs. */
export function deleteDocAsset(db: Database, id: string, owner: string): DocAssetRow | null {
  const asset = getDocAsset(db, id, owner);
  if (!asset) return null;
  db.run("DELETE FROM doc_assets WHERE id = ? AND owner = ?", [id, owner]);
  return asset;
}

/** How many asset rows, anyone's, name the stored copy `sha256`. */
export function countDocAssetRefs(db: Database, sha256: string): number {
  return (db.query("SELECT COUNT(*) AS n FROM doc_assets WHERE sha256 = ?").get(sha256) as { n: number }).n;
}

// ── The tree and paths ──────────────────────────────────────────────────────

/** The owner's whole tree. */
export function getDocTree(db: Database, owner: string): DocTree {
  const folders = (db.query("SELECT * FROM doc_folders WHERE owner = ? ORDER BY name").all(owner) as FolderRow[]).map(toFolder);
  const docs = (
    db
      .query("SELECT id, owner, folder_id, name, revision, bytes, created_at, updated_at FROM docs WHERE owner = ? ORDER BY name")
      .all(owner) as Array<Omit<DocRow, "body">>
  ).map(toSummary);
  const assets = (db.query("SELECT * FROM doc_assets WHERE owner = ? ORDER BY name").all(owner) as AssetRow[]).map((r) =>
    toDocAssetInfo(toAssetRow(r))
  );
  return { folders, docs, assets };
}

/** The most docs a search returns. */
export const DOC_SEARCH_LIMIT = 50;
/** The most words of a query a search matches on; later words are ignored. */
const DOC_SEARCH_TERMS_MAX = 8;
const SNIPPET_BEFORE = 40;
const SNIPPET_AFTER = 120;

const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** The line of `body` around the first of `terms` it contains (else its first line), cut to a short window. */
export function snippetOf(body: string, terms: readonly string[]): string {
  const first = new RegExp(terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "iu").exec(body);
  const at = first?.index ?? 0;
  const lineStart = body.lastIndexOf("\n", at - 1) + 1;
  const lineEnd = body.indexOf("\n", at) === -1 ? body.length : body.indexOf("\n", at);
  let start = Math.max(lineStart, at - SNIPPET_BEFORE);
  let end = Math.min(lineEnd, at + SNIPPET_AFTER);
  // Never cut a character outside the Basic Multilingual Plane (an emoji) in half.
  if (start > lineStart && isLowSurrogate(body.charCodeAt(start))) start--;
  if (end < lineEnd && isLowSurrogate(body.charCodeAt(end))) end++;
  const text = body.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > lineStart ? "…" : ""}${text}${end < lineEnd ? "…" : ""}`;
}

/**
 * The owner's docs that match every word of `query` (case-insensitive): those
 * whose path (`folder/sub/name.md`) holds them all first — a name starting
 * with the first word and holding the rest ahead, then a name holding them
 * all — then the docs that hold them only in their body, each with a line of
 * the body around the match. Up to DOC_SEARCH_LIMIT docs; only the bodies
 * listed are read out of the database.
 */
export function searchDocs(db: Database, owner: string, query: string): DocSearchHit[] {
  const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, DOC_SEARCH_TERMS_MAX);
  if (terms.length === 0) return [];
  const tree = getDocTree(db, owner);
  const paths = docPaths(tree);
  const docs = tree.docs.map((d) => ({ id: d.id, name: d.name.toLowerCase(), path: paths.get(d.id)! }));

  const inName = (d: (typeof docs)[number]) => terms.every((t) => d.name.includes(t));
  const rank = (d: (typeof docs)[number]) => (inName(d) ? (d.name.startsWith(terms[0]!) ? 0 : 1) : 2);
  const hits: DocSearchHit[] = docs
    .filter((d) => terms.every((t) => d.path.toLowerCase().includes(t)))
    .map((d) => ({ d, rank: rank(d) }))
    .sort((a, b) => a.rank - b.rank || a.d.path.localeCompare(b.d.path))
    .slice(0, DOC_SEARCH_LIMIT)
    .map(({ d }) => ({ id: d.id, path: d.path, match: "path" }));
  const room = DOC_SEARCH_LIMIT - hits.length;
  if (room <= 0) return hits;

  // LIKE is case-insensitive for ASCII only; a body that differs from the query in a non-ASCII letter's case is missed.
  const pathOf = new Map(docs.map((d) => [d.id, d.path]));
  const taken = new Set(hits.map((h) => h.id));
  const like = terms.map((t) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  const matched = db
    .query(`SELECT id FROM docs WHERE owner = ? ${like.map(() => "AND CAST(body AS TEXT) LIKE ? ESCAPE '\\'").join(" ")}`)
    .all(owner, ...like) as Array<{ id: string }>;
  const listed = matched
    .filter((r) => !taken.has(r.id) && pathOf.has(r.id))
    .map((r) => ({ id: r.id, path: pathOf.get(r.id)! }))
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, room);
  if (listed.length === 0) return hits;
  const bodies = new Map(
    (
      db
        .query(`SELECT id, body FROM docs WHERE owner = ? AND id IN (${listed.map(() => "?").join(", ")})`)
        .all(owner, ...listed.map((d) => d.id)) as Array<Pick<DocRow, "id" | "body">>
    ).map((r) => [r.id, decodeBody(r.body)])
  );
  return [...hits, ...listed.map((d) => ({ ...d, match: "body" as const, snippet: snippetOf(bodies.get(d.id) ?? "", terms) }))];
}

// ── Semantic index (doc_chunks, migration 089) ──────────────────────────────

/** A doc whose chunks are missing or were embedded at another revision or by another embedder. */
export interface DocToEmbed {
  id: string;
  name: string;
  body: string;
  revision: number;
}

/** A chunk of one of the owner's docs as embedded at the doc's current revision. */
export interface DocChunkRow {
  docId: string;
  text: string;
  embedding: Uint8Array;
}

/** Up to `limit` docs, of every owner, not yet embedded at their current revision by `embedder`. */
export function docsToEmbed(db: Database, embedder: string, limit: number): DocToEmbed[] {
  const rows = db
    .query(
      `SELECT d.id, d.name, d.body, d.revision FROM docs d
       WHERE NOT EXISTS (SELECT 1 FROM doc_chunks c WHERE c.doc_id = d.id AND c.revision = d.revision AND c.embedder = ?)
       ORDER BY d.updated_at DESC LIMIT ?`
    )
    .all(embedder, limit) as Array<Pick<DocRow, "id" | "name" | "body" | "revision">>;
  return rows.map((r) => ({ id: r.id, name: r.name, body: decodeBody(r.body), revision: r.revision }));
}

/**
 * Replaces a doc's chunks with `chunks`, embedded at `revision` by `embedder`;
 * whether it did. A doc that is gone or has moved past `revision` keeps what it
 * has, so an embedding that finished after a newer save never lands.
 */
export function replaceDocChunks(
  db: Database,
  input: { docId: string; revision: number; embedder: string; chunks: ReadonlyArray<{ text: string; embedding: Uint8Array }> }
): boolean {
  const replace = db.transaction((): boolean => {
    const row = db.query("SELECT revision FROM docs WHERE id = ?").get(input.docId) as { revision: number } | null;
    if (!row || row.revision !== input.revision) return false;
    db.run("DELETE FROM doc_chunks WHERE doc_id = ?", [input.docId]);
    const insert = db.prepare("INSERT INTO doc_chunks (doc_id, seq, revision, embedder, text, embedding) VALUES (?, ?, ?, ?, ?, ?)");
    input.chunks.forEach((c, seq) => insert.run(input.docId, seq, input.revision, input.embedder, c.text, c.embedding));
    return true;
  });
  return replace();
}

const CURRENT_CHUNKS = `doc_chunks c JOIN docs d ON d.id = c.doc_id WHERE d.owner = ? AND c.embedder = ? AND c.revision = d.revision`;

/**
 * A mark that moves whenever docChunksOf would return other rows, read
 * without the vectors: their count and the sum of their ids, which are never
 * reused, so rows replaced by as many new ones raise the sum.
 */
export function docChunksMark(db: Database, owner: string, embedder: string): string {
  const row = db.query(`SELECT COUNT(*) AS n, COALESCE(SUM(c.id), 0) AS ids FROM ${CURRENT_CHUNKS}`).get(owner, embedder) as {
    n: number;
    ids: number;
  };
  return `${row.n}:${row.ids}`;
}

/** The chunks of the owner's docs embedded at each doc's current revision by `embedder`. */
export function docChunksOf(db: Database, owner: string, embedder: string): DocChunkRow[] {
  return db
    .query(`SELECT c.doc_id AS docId, c.text, c.embedding FROM ${CURRENT_CHUNKS}`)
    .all(owner, embedder) as DocChunkRow[];
}

/**
 * Whether `folderId` is the owner's folder `rootId` or one below it, walking
 * up the folders' parent links (never their names). The root of the whole
 * tree (null) is below no folder.
 */
export function isDocFolderWithin(db: Database, folderId: string | null, rootId: string, owner: string): boolean {
  let at = folderId;
  // Bounded: a chain longer than the depth cap can only be a corrupt cycle.
  for (let i = 0; at !== null && i <= DOC_FOLDER_DEPTH_MAX + 1; i++) {
    const folder = getDocFolder(db, at, owner);
    if (!folder) return false;
    if (folder.id === rootId) return true;
    at = folder.parentId;
  }
  return false;
}

/**
 * The owner's folder `rootId` with every folder below it and the docs in any
 * of them (summaries, no bodies), as the tree stands now; null when the
 * folder isn't the owner's.
 */
export function getDocFolderSubtree(
  db: Database,
  rootId: string,
  owner: string
): { root: DocFolder; folders: DocFolder[]; docs: DocSummary[] } | null {
  // Two reads of the owner's rows, the subtree picked out in memory: a query
  // per folder would each scan the owner's rows, as the indexes key on
  // COALESCE(parent_id / folder_id, '').
  const all = (db.query("SELECT * FROM doc_folders WHERE owner = ? ORDER BY name").all(owner) as FolderRow[]).map(toFolder);
  const root = all.find((f) => f.id === rootId);
  if (!root) return null;
  const children = new Map<string, DocFolder[]>();
  for (const f of all) {
    if (f.parentId === null) continue;
    const list = children.get(f.parentId);
    if (list) list.push(f);
    else children.set(f.parentId, [f]);
  }
  const folders = [root];
  // Breadth-first, each folder before its children; bounded like descendantFolderIds.
  let frontier = [root];
  for (let depth = 0; frontier.length > 0 && depth <= DOC_FOLDER_DEPTH_MAX + 1; depth++) {
    frontier = frontier.flatMap((f) => children.get(f.id) ?? []);
    folders.push(...frontier);
  }
  const within = new Set(folders.map((f) => f.id));
  const docs = (
    db
      .query("SELECT id, owner, folder_id, name, revision, bytes, created_at, updated_at FROM docs WHERE owner = ? ORDER BY name")
      .all(owner) as Array<Omit<DocRow, "body">>
  )
    .filter((r) => r.folder_id !== null && within.has(r.folder_id))
    .map(toSummary);
  return { root, folders, docs };
}

/**
 * The nearest of `folderId` and the folders above it that the owner shares
 * by link (a live folder grant), or null when none is.
 */
export function sharedDocFolderAbove(db: Database, folderId: string | null, owner: string): DocFolder | null {
  let at = folderId;
  // Bounded: a chain longer than the depth cap can only be a corrupt cycle.
  for (let i = 0; at !== null && i <= DOC_FOLDER_DEPTH_MAX + 1; i++) {
    const folder = getDocFolder(db, at, owner);
    if (!folder) return null;
    if (getLiveGrant(db, "folder", folder.id, owner)) return folder;
    at = folder.parentId;
  }
  return null;
}

/** The owner's folder at `names` from the root (empty: the root, null); undefined when there is none. */
export function findDocFolderByPath(db: Database, owner: string, names: readonly string[]): DocFolder | null | undefined {
  let folder: DocFolder | null = null;
  for (const name of names) {
    const next = folderNamed(db, owner, folder?.id ?? null, name);
    if (!next) return undefined;
    folder = next;
  }
  return folder;
}

/** The owner's doc at `names` (its folders' names, then its own), or null. */
export function findDocByPath(db: Database, owner: string, names: readonly string[]): DocDetail | null {
  if (names.length === 0) return null;
  const folder = findDocFolderByPath(db, owner, names.slice(0, -1));
  if (folder === undefined) return null;
  const row = db
    .query("SELECT * FROM docs WHERE owner = ? AND COALESCE(folder_id, '') = COALESCE(?, '') AND name = ?")
    .get(owner, folder?.id ?? null, names[names.length - 1]!) as DocRow | null;
  return row ? toDetail(row) : null;
}

/** The owner's asset at `names` (its folders' names, then its own), or null. */
export function findDocAssetByPath(db: Database, owner: string, names: readonly string[]): DocAssetRow | null {
  if (names.length === 0) return null;
  const folder = findDocFolderByPath(db, owner, names.slice(0, -1));
  if (folder === undefined) return null;
  const row = db
    .query("SELECT * FROM doc_assets WHERE owner = ? AND COALESCE(folder_id, '') = COALESCE(?, '') AND name = ?")
    .get(owner, folder?.id ?? null, names[names.length - 1]!) as AssetRow | null;
  return row ? toAssetRow(row) : null;
}

/**
 * The owner's folder at `names` under `parentId`, creating each folder that
 * is missing; returns its id (`parentId` itself for no names). A name on the
 * way taken by a doc or an asset is a conflict.
 */
export function ensureDocFolderPath(
  db: Database,
  owner: string,
  names: readonly string[],
  parentId: string | null = null,
  now: Date = new Date(),
  limits?: Partial<DocLimits>
): string | null {
  const ensure = db.transaction((): string | null => {
    let at = parentId;
    for (const raw of names) {
      const name = checkName(raw);
      const existing = folderNamed(db, owner, at, name);
      at = existing ? existing.id : createDocFolder(db, { owner, parentId: at, name, limits }, now).id;
    }
    return at;
  });
  return ensure();
}
