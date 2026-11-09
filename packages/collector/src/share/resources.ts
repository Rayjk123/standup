import type { Context } from "hono";
import type { Database } from "bun:sqlite";
import type {
  DocDetail,
  ReviewChangeArea,
  ReviewPacket,
  ReviewValidation,
  ShareResourceType,
  SharedDoc,
  SharedDocAsset,
  SharedFolder,
  SharedReviewMedia,
  SharedReviewPacket,
} from "@standup/shared";
import { resolveDocRelativePath, shareApiPrefix } from "@standup/shared";
import {
  docFolderPath,
  findDocAssetByPath,
  getDoc,
  getDocAsset,
  getDocFolder,
  getDocFolderSubtree,
  getReviewMedia,
  isDocFolderWithin,
  getReviewPacket,
  getSharedReviewPacket,
  listReviewMedia,
  reviewShareRefusal,
} from "@standup/store";
import type { DocAssetRow } from "@standup/store";
import { isDocAssetMime, openStoredDocAsset } from "../docs/assets.js";
import { openedFileResponse, storedMediaResponse } from "../review/routes.js";
import { docImageSources } from "./doc-images.js";

/**
 * What each shareable type is to the share routes: how its owner's resource
 * is found, why one can't be shared, and what its public link shows. Every
 * public view copies its fields out by name, so nothing added to a resource
 * later leaks through a link.
 */
export interface ShareResource {
  type: ShareResourceType;
  /** The type as an error names it ("Unknown review"). */
  noun: string;
  /** Whether the owner has a resource with this id. */
  exists(db: Database, id: string, owner: string): boolean;
  /** Why the owner's resource can't be shared right now (a 409), or null when it can. */
  shareRefusal?(db: Database, id: string, owner: string): string | null;
  /** The public JSON a live link shows, or null when the resource can't be shown (a 404). */
  publicView(db: Database, resourceId: string, owner: string, token: string): Record<string, unknown> | null;
  /** For a resource holding docs (a folder): one of its docs' public JSON, or null (a 404). */
  publicDoc?(db: Database, resourceId: string, owner: string, token: string, docId: string): Record<string, unknown> | null;
  /** One of the resource's media files served through the link, or null (a 404). */
  publicMedia(c: Context, db: Database, resourceId: string, owner: string, mediaId: string): Response | null;
}

/** Headers on every share response: never stored, never indexed, no referrer. */
export const SHARE_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
};

const text = (v: unknown): string => (typeof v === "string" ? v : "");
const texts = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);
const count = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

// ── Review packets ──────────────────────────────────────────────────────────

/** A change area's display fields, each copied by name. */
function sharedChange(change: ReviewChangeArea): ReviewChangeArea {
  const files = texts(change.files);
  const hunks = Array.isArray(change.hunks)
    ? change.hunks.map((h) => ({ file: text(h?.file), ...(typeof h?.header === "string" ? { header: h.header } : {}), diff: text(h?.diff) }))
    : [];
  return {
    area: text(change.area),
    bullets: texts(change.bullets),
    ...(files.length > 0 ? { files } : {}),
    ...(hunks.length > 0 ? { hunks } : {}),
  };
}

/** The validation's display fields, each copied by name. */
function sharedValidation(validation: ReviewValidation): ReviewValidation {
  const samples = Array.isArray(validation.samples)
    ? validation.samples.map((s) => ({ label: text(s?.label), input: text(s?.input), output: text(s?.output) }))
    : [];
  const tests = validation.tests;
  if (!tests || typeof tests !== "object") return { samples };
  const passed = count(tests.passed);
  const failed = count(tests.failed);
  return {
    samples,
    tests: { summary: text(tests.summary), ...(passed !== undefined ? { passed } : {}), ...(failed !== undefined ? { failed } : {}) },
  };
}

/** The share URL of one of a shared resource's media files. */
export function sharedMediaUrl(type: ShareResourceType, token: string, mediaId: string): string {
  return `${shareApiPrefix(type)}${token}/media/${encodeURIComponent(mediaId)}`;
}

/** Everything a share link shows of `packet`, and nothing else. */
export function sharedReviewPacket(db: Database, packet: ReviewPacket, token: string): SharedReviewPacket {
  const media: SharedReviewMedia[] = listReviewMedia(db, packet.id, packet.owner).map((m) => ({
    id: m.id,
    kind: m.kind,
    mime: m.mime,
    caption: m.caption,
    position: m.position,
    url: sharedMediaUrl("review", token, m.id),
  }));
  return {
    title: packet.title,
    intent: packet.intent,
    changes: Array.isArray(packet.changes) ? packet.changes.map(sharedChange) : [],
    validation: sharedValidation(packet.validation),
    media,
  };
}

function reviewResource(dataDir: string): ShareResource {
  return {
    type: "review",
    noun: "review",
    exists: (db, id, owner) => getReviewPacket(db, id, owner) !== null,
    shareRefusal: (db, id, owner) => {
      const packet = getReviewPacket(db, id, owner);
      const refusal = packet ? reviewShareRefusal(packet.status) : null;
      if (refusal === "draft") return "A draft review can't be shared: it has nothing to show yet";
      if (refusal === "superseded") return "A superseded review can't be shared: share its latest revision";
      return null;
    },
    publicView: (db, resourceId, owner, token) => {
      // getSharedReviewPacket re-checks the grant and refuses a draft or superseded packet.
      const packet = getSharedReviewPacket(db, token);
      if (!packet || packet.id !== resourceId || packet.owner !== owner) return null;
      return { review: sharedReviewPacket(db, packet, token) };
    },
    publicMedia: (c, db, resourceId, owner, mediaId) => {
      const packet = getReviewPacket(db, resourceId, owner);
      if (!packet || reviewShareRefusal(packet.status)) return null;
      const media = getReviewMedia(db, { packetId: packet.id, mediaId, owner });
      if (!media) return null;
      const served = storedMediaResponse(c, dataDir, media, SHARE_HEADERS);
      // A copy that can't be served reads as missing, like any other refusal here.
      return served.status === 410 ? null : served;
    },
  };
}

// ── Docs ────────────────────────────────────────────────────────────────────

/** Whether `names` lies strictly below the folder at `folderPath`. */
function isBelow(names: readonly string[], folderPath: readonly string[]): boolean {
  return names.length > folderPath.length && folderPath.every((n, i) => names[i] === n);
}

/**
 * The owner's assets `doc`'s body shows as images, keyed by the `src` as
 * written: each src resolved against the doc's folder to an image asset of
 * the same owner in the folder `within` names (the doc's own by default) or
 * one below it. A src that climbs out of that folder (`../private/x.png`) is
 * never resolved, so sharing a doc or a folder exposes no image from
 * elsewhere in the tree. Sources that resolve to nothing are left out.
 */
export function referencedDocAssets(
  db: Database,
  doc: DocDetail,
  owner: string,
  within?: readonly string[]
): Map<string, DocAssetRow> {
  const out = new Map<string, DocAssetRow>();
  const folderPath = docFolderPath(db, doc.folderId, owner);
  if (!folderPath) return out;
  const scope = within ?? folderPath;
  for (const src of docImageSources(doc.body)) {
    const names = resolveDocRelativePath(folderPath, src);
    const asset = names && isBelow(names, scope) ? findDocAssetByPath(db, owner, names) : null;
    if (asset && isDocAssetMime(asset.mime)) out.set(src, asset);
  }
  return out;
}

/**
 * Everything a share link shows of `doc`: its name, body and the images the
 * body references, each served through the link of `type` under `token`.
 * A folder's link (`within` names the shared folder) shows images from
 * anywhere in that folder.
 */
export function sharedDoc(
  db: Database,
  doc: DocDetail,
  owner: string,
  token: string,
  type: ShareResourceType = "doc",
  within?: readonly string[]
): SharedDoc {
  const images: Record<string, SharedDocAsset> = {};
  for (const [src, asset] of referencedDocAssets(db, doc, owner, within)) {
    images[src] = { url: sharedMediaUrl(type, token, asset.id), mime: asset.mime };
  }
  return { name: doc.name, body: doc.body, images };
}

function docResource(dataDir: string): ShareResource {
  return {
    type: "doc",
    noun: "doc",
    exists: (db, id, owner) => getDoc(db, id, owner) !== null,
    publicView: (db, resourceId, owner, token) => {
      const doc = getDoc(db, resourceId, owner);
      return doc ? { doc: sharedDoc(db, doc, owner, token) } : null;
    },
    publicMedia: (c, db, resourceId, owner, mediaId) => {
      const doc = getDoc(db, resourceId, owner);
      if (!doc) return null;
      // Only an asset the shared doc's body shows is reachable through its link.
      const referenced = [...referencedDocAssets(db, doc, owner).values()].some((a) => a.id === mediaId);
      const asset = referenced ? getDocAsset(db, mediaId, owner) : null;
      if (!asset) return null;
      const stored = openStoredDocAsset(dataDir, asset.sha256, asset.mime, asset.bytes);
      return stored ? openedFileResponse(c, stored, asset.mime, SHARE_HEADERS) : null;
    },
  };
}

// ── Doc folders ─────────────────────────────────────────────────────────────

/**
 * A folder shared with everything below it. What the link reaches is worked
 * out from the live tree on every request: a doc added to or moved into the
 * folder (or a folder below it) is reachable at once, one moved out no
 * longer is. A doc or image is reached by its id and is checked to lie
 * within the folder by walking up its parent folders, so no path a request
 * names is ever resolved, and a doc's images resolve only to assets inside
 * the shared folder.
 *
 * Agents may still write docs into a shared folder (write_doc, the
 * living-docs sync), and what they write shows on the link at once: the
 * owner shares a folder to publish what lands in it. A doc with a link of its
 * own takes agent writes too (see docs/routes.ts).
 */
function folderResource(dataDir: string): ShareResource {
  return {
    type: "folder",
    noun: "folder",
    exists: (db, id, owner) => getDocFolder(db, id, owner) !== null,
    publicView: (db, resourceId, owner) => {
      const subtree = getDocFolderSubtree(db, resourceId, owner);
      if (!subtree) return null;
      const folder: SharedFolder = {
        name: subtree.root.name,
        folders: subtree.folders.map((f) => ({ id: f.id, parentId: f.id === resourceId ? null : f.parentId, name: f.name })),
        docs: subtree.docs.map((d) => ({ id: d.id, folderId: d.folderId!, name: d.name })),
      };
      return { folder };
    },
    publicDoc: (db, resourceId, owner, token, docId) => {
      const doc = getDoc(db, docId, owner);
      if (!doc || !isDocFolderWithin(db, doc.folderId, resourceId, owner)) return null;
      const within = docFolderPath(db, resourceId, owner);
      return within ? { doc: sharedDoc(db, doc, owner, token, "folder", within) } : null;
    },
    publicMedia: (c, db, resourceId, owner, mediaId) => {
      const asset = getDocAsset(db, mediaId, owner);
      if (!asset || !isDocAssetMime(asset.mime) || !isDocFolderWithin(db, asset.folderId, resourceId, owner)) return null;
      const stored = openStoredDocAsset(dataDir, asset.sha256, asset.mime, asset.bytes);
      return stored ? openedFileResponse(c, stored, asset.mime, SHARE_HEADERS) : null;
    },
  };
}

/** Every shareable type's resource, keyed by type. */
export function shareResources(opts: { dataDir: string }): Record<ShareResourceType, ShareResource> {
  return { review: reviewResource(opts.dataDir), doc: docResource(opts.dataDir), folder: folderResource(opts.dataDir) };
}
