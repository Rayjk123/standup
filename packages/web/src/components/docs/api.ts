import type { DocAsset, DocDetail, DocFolder, DocImportResult, DocSearchHit, DocTree, SharedDoc, SharedFolder } from "@standup/shared";
import { DOC_NAME_MAX, DOC_TOOL_IMAGE_MAX_BYTES, shareApiPrefix } from "@standup/shared";

/*
 * The Docs tab's reads and writes. Every call throws a DocsRequestError
 * carrying the collector's `error` text on a refused or failed request, except
 * a save that lost a revision race, which comes back as a conflict holding
 * the doc as it now stands.
 */

/** A refused or failed docs request; `message` is the collector's error text when it sent one. */
export class DocsRequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "DocsRequestError";
  }
}

function errorOf(body: unknown): string | undefined {
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = (body as { error: unknown }).error;
    if (typeof error === "string" && error.trim()) return error;
  }
  return undefined;
}

async function bodyOf(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (err) {
    throw new DocsRequestError(err instanceof Error ? err.message : String(err), 0);
  }
  const body = await bodyOf(res);
  if (!res.ok) throw new DocsRequestError(errorOf(body) ?? `Request failed (HTTP ${res.status})`, res.status);
  return body as T;
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

const id = (value: string) => encodeURIComponent(value);

export async function getTree(): Promise<DocTree> {
  const tree = await request<Partial<DocTree> | null>("/api/docs/tree");
  // A page that isn't the collector's JSON (a proxy's fallback) is no proof the tree is empty.
  if (typeof tree !== "object" || tree === null || !Array.isArray(tree.folders)) throw new DocsRequestError("The collector returned no tree", 200);
  return {
    folders: tree.folders,
    docs: Array.isArray(tree.docs) ? tree.docs : [],
    assets: Array.isArray(tree.assets) ? tree.assets : [],
  };
}

/** The docs whose name, path or body match `query`, name and path matches first. */
export async function searchDocs(query: string, signal?: AbortSignal): Promise<DocSearchHit[]> {
  const res = await request<{ hits?: DocSearchHit[] } | null>(`/api/docs/search?q=${encodeURIComponent(query)}`, { signal });
  return Array.isArray(res?.hits) ? res.hits : [];
}

export async function createFolder(parentId: string | null, name: string): Promise<DocFolder> {
  return (await request<{ folder: DocFolder }>("/api/docs/folders", json("POST", { parentId, name }))).folder;
}

export async function updateFolder(folderId: string, patch: { name?: string; parentId?: string | null }): Promise<DocFolder> {
  return (await request<{ folder: DocFolder }>(`/api/docs/folders/${id(folderId)}`, json("PATCH", patch))).folder;
}

export async function deleteFolder(folderId: string): Promise<void> {
  await request(`/api/docs/folders/${id(folderId)}`, { method: "DELETE" });
}

export async function createDoc(folderId: string | null, name: string, body = ""): Promise<DocDetail> {
  return (await request<{ doc: DocDetail }>("/api/docs", json("POST", { folderId, name, body }))).doc;
}

export async function getDoc(docId: string): Promise<DocDetail> {
  return (await request<{ doc: DocDetail }>(`/api/docs/${id(docId)}`)).doc;
}

/** A rename, move or body change to a doc. */
export interface DocPatch {
  name?: string;
  folderId?: string | null;
  body?: string;
  /** The revision the change was made on; a doc that has moved past it is a conflict. */
  baseRevision?: number;
}

export type DocSaveResult = { ok: true; doc: DocDetail } | { ok: false; conflict: DocDetail };

/** Saves a change to a doc. A save whose baseRevision is stale comes back as the doc's current state. */
export async function updateDoc(docId: string, patch: DocPatch): Promise<DocSaveResult> {
  let res: Response;
  try {
    res = await fetch(`/api/docs/${id(docId)}`, json("PATCH", patch));
  } catch (err) {
    throw new DocsRequestError(err instanceof Error ? err.message : String(err), 0);
  }
  const body = (await bodyOf(res)) as { doc?: DocDetail; error?: string } | null;
  if (res.status === 409 && body?.doc) return { ok: false, conflict: body.doc };
  if (!res.ok) throw new DocsRequestError(errorOf(body) ?? `Request failed (HTTP ${res.status})`, res.status);
  if (!body?.doc) throw new DocsRequestError("The collector returned no doc", res.status);
  return { ok: true, doc: body.doc };
}

export async function deleteDoc(docId: string): Promise<void> {
  await request(`/api/docs/${id(docId)}`, { method: "DELETE" });
}

/** The image types a doc stores, by content type, with the extensions a file of each is named with (the usual one first). */
export const DOC_IMAGE_TYPES: ReadonlyMap<string, readonly string[]> = new Map([
  ["image/png", [".png"]],
  ["image/jpeg", [".jpg", ".jpeg"]],
  ["image/gif", [".gif"]],
  ["image/webp", [".webp"]],
]);

/**
 * Why `file` can't be stored as a doc's image, as the person reads it, or
 * null. Only the type the browser gives it and its size are looked at here;
 * the collector checks the content itself.
 */
export function imageUploadRefusal(file: Blob & { name?: string }): string | null {
  const what = file.name ? `"${file.name}"` : "That file";
  if (!DOC_IMAGE_TYPES.has(file.type.toLowerCase())) return `${what} isn't an image a doc can hold: use a PNG, JPEG, GIF or WebP.`;
  if (file.size > DOC_TOOL_IMAGE_MAX_BYTES) {
    return `${what} is ${(file.size / (1024 * 1024)).toFixed(1)} MB; an image can be at most ${DOC_TOOL_IMAGE_MAX_BYTES / (1024 * 1024)} MB.`;
  }
  return null;
}

/** The longest name stem kept, leaving room for an extension and the collector's ` (n)` suffix. */
const IMAGE_STEM_MAX = DOC_NAME_MAX - 16;

/**
 * The name to store `file` under: its own, with any separator or control
 * character made a `-`, its stem cut to fit a doc name, and the extension of
 * its type when its own isn't one (the collector checks the content against
 * the extension).
 */
export function imageFileName(file: Blob & { name?: string }): string {
  const name = (file.name ?? "").replace(/[/\\\u0000-\u001f\u007f]/g, "-").trim();
  const exts = DOC_IMAGE_TYPES.get(file.type.toLowerCase()) ?? [".png"];
  const own = /\.[^.]*$/.exec(name)?.[0] ?? "";
  const ext = exts.includes(own.toLowerCase()) ? own : exts[0]!;
  // Cut to IMAGE_STEM_MAX UTF-16 units (how a doc name is measured), never splitting a surrogate pair.
  const cut = name.slice(0, Math.min(name.length - own.length, IMAGE_STEM_MAX));
  const stem = (/[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut).trim();
  return `${stem || "image"}${ext}`;
}

async function base64Of(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** A stored image: its asset id, its path from the root, and the URL it is served at. */
export interface WrittenImage {
  id: string;
  path: string;
  url: string;
}

/**
 * Stores `file` as a new image at `path` (folder names from the root, the
 * file name last) through the route write_doc's images use, so the same
 * content, size and path checks apply. Nothing already there is replaced:
 * a taken name gets a free `name (2)`…, and the path answered is the one
 * used. `folderId` is the folder `path`'s folders were read as; the write is
 * refused when they no longer are.
 */
export async function writeImage(path: readonly string[], folderId: string | null, file: Blob): Promise<WrittenImage> {
  const data = await base64Of(file);
  const body = { path: path.join("/"), folderId, unique: true, data };
  return (await request<{ asset: WrittenImage }>("/api/docs/write-image", json("POST", body))).asset;
}

export async function updateAsset(assetId: string, patch: { name?: string; folderId?: string | null }): Promise<DocAsset> {
  return (await request<{ asset: DocAsset }>(`/api/docs/assets/${id(assetId)}`, json("PATCH", patch))).asset;
}

export async function deleteAsset(assetId: string): Promise<void> {
  await request(`/api/docs/assets/${id(assetId)}`, { method: "DELETE" });
}

/** Imports a file or directory on the host (`path`) into `folderId` (null: the root). */
export async function importDocs(path: string, folderId: string | null): Promise<DocImportResult> {
  return request<DocImportResult>("/api/docs/import", json("POST", { path, folderId }));
}

/** A shared doc by its share token; null when the link is unknown or revoked. */
export async function getSharedDoc(token: string): Promise<SharedDoc | null> {
  // Same-origin credentials: a tunnel in front of the console signs its visitors in with a cookie.
  const res = await fetch(`${shareApiPrefix("doc")}${encodeURIComponent(token)}`, {
    credentials: "same-origin",
    referrerPolicy: "no-referrer",
  });
  if (res.status === 404) return null;
  const body = (await bodyOf(res)) as { doc?: SharedDoc } | null;
  if (!res.ok) throw new DocsRequestError(errorOf(body) ?? `Request failed (HTTP ${res.status})`, res.status);
  return body?.doc ?? null;
}

/** A public read through a share link: its JSON, null for a 404 (unknown, revoked or out of reach). */
async function sharedRead(path: string): Promise<Record<string, unknown> | null> {
  // Same-origin credentials: a tunnel in front of the console signs its visitors in with a cookie.
  const res = await fetch(path, { credentials: "same-origin", referrerPolicy: "no-referrer" });
  if (res.status === 404) return null;
  const body = (await bodyOf(res)) as Record<string, unknown> | null;
  if (!res.ok) throw new DocsRequestError(errorOf(body) ?? `Request failed (HTTP ${res.status})`, res.status);
  return body;
}

/** A shared folder's tree through its share token; null for a 404. */
export async function getSharedFolder(token: string): Promise<SharedFolder | null> {
  const body = await sharedRead(`${shareApiPrefix("folder")}${encodeURIComponent(token)}`);
  return (body?.folder as SharedFolder | undefined) ?? null;
}

/** One doc of a shared folder through the folder's share token; null for a 404 (including a doc outside the folder). */
export async function getSharedFolderDoc(token: string, docId: string): Promise<SharedDoc | null> {
  const body = await sharedRead(`${shareApiPrefix("folder")}${encodeURIComponent(token)}/docs/${encodeURIComponent(docId)}`);
  return (body?.doc as SharedDoc | undefined) ?? null;
}
