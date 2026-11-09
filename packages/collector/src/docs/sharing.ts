import type { Context, Hono } from "hono";
import type { Database } from "bun:sqlite";
import type { DocDetail, DocsChangedPayload, SharedDocAsset } from "@standup/shared";
import { docAccessFor, getDocAsset, listSharedWithMe, setDocFolderShareable, setDocShareable, shareableFolderAbove } from "@standup/store";
import type { DocAssetRow } from "@standup/store";
import { referencedDocAssets } from "../share/resources.js";
import { mountDocCommentRoutes, type DocCommentAgent } from "./comments.js";

/**
 * Shareable docs in the console: the owner's Shareable switch on a doc or a
 * folder, the "Shared with me" list of other users' shareable docs, and a
 * reader's read-only view of one (with the images its body shows). Who may
 * read is decided by docAccessFor alone; writes stay owner-only because every
 * write route works on the caller's own tree.
 */

const DOC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The URL a reader loads one of a shared doc's images from. */
function readerAssetUrl(assetId: string, docId: string): string {
  return `/api/docs/assets/${assetId}?doc=${docId}`;
}

/**
 * `viewer`'s read-only view of another user's doc shared with them, or null
 * when they can't read it (or it is their own: the owner reads it as usual).
 */
export function readerDocDetail(db: Database, docId: string, viewer: string): DocDetail | null {
  const access = docAccessFor(db, docId, viewer);
  if (!access || access.role !== "reader") return null;
  const { doc, owner } = access;
  const images: Record<string, SharedDocAsset> = {};
  for (const [src, asset] of referencedDocAssets(db, doc, owner)) images[src] = { url: readerAssetUrl(asset.id, doc.id), mime: asset.mime };
  const { shareable: _shareable, ...summary } = doc;
  return { ...summary, readOnly: { owner, images } };
}

/** One of the images a doc shared with `viewer` shows, or null: only an image the doc's body references is served. */
export function readerDocAsset(db: Database, assetId: string, docId: string | undefined, viewer: string): DocAssetRow | null {
  if (!docId || !DOC_ID.test(docId)) return null;
  const access = docAccessFor(db, docId, viewer);
  if (!access || access.role !== "reader") return null;
  const referenced = [...referencedDocAssets(db, access.doc, access.owner).values()].some((a) => a.id === assetId);
  return referenced ? getDocAsset(db, assetId, access.owner) : null;
}

/** On the owner's own read: the shareable folder above the doc, when the doc is shareable through one. */
export function shareableViaOf(db: Database, doc: DocDetail, owner: string): { shareableVia?: string } {
  const folder = shareableFolderAbove(db, doc.folderId, owner);
  return folder ? { shareableVia: folder.name } : {};
}

export interface DocSharingRoutesOptions {
  db: Database;
  agent: DocCommentAgent;
  callerOf(c: Context): { owner: string } | Response;
  writerOf(c: Context): { owner: string } | Response;
  /** Announces a change to the owner's tabs (docs/routes.ts `changed`). */
  changed(owner: string, payload: DocsChangedPayload): void;
}

/**
 * The sharing and comment routes. Mounted ahead of the docs routes, so
 * `/api/docs/shared-with-me` is matched before `/api/docs/:id`.
 */
export function mountDocSharingRoutes(app: Hono, opts: DocSharingRoutesOptions): void {
  const { db } = opts;

  app.get("/api/docs/shared-with-me", (c) => {
    const caller = opts.callerOf(c);
    if (caller instanceof Response) return caller;
    return c.json({ shared: listSharedWithMe(db, caller.owner) });
  });

  const toggle = (kind: "doc" | "folder") => async (c: Context) => {
    const caller = opts.writerOf(c);
    if (caller instanceof Response) return caller;
    const id = c.req.param("id") ?? "";
    const body = (await c.req.json<unknown>().catch(() => null)) as { shareable?: unknown } | null;
    if (typeof body?.shareable !== "boolean") return c.json({ error: "shareable must be true or false" }, 400);
    const set = kind === "doc" ? setDocShareable : setDocFolderShareable;
    if (!DOC_ID.test(id) || !set(db, id, caller.owner, body.shareable)) return c.json({ error: kind === "doc" ? "Unknown doc" : "Unknown folder" }, 404);
    opts.changed(caller.owner, kind === "doc" ? { tree: true, docId: id } : { tree: true });
    return c.json({ shareable: body.shareable });
  };
  app.put("/api/docs/folders/:id/shareable", toggle("folder"));
  app.put("/api/docs/:id/shareable", toggle("doc"));

  mountDocCommentRoutes(app, opts);
}
