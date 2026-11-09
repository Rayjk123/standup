/**
 * Each user's docs (mountDocsRoutes): a tree of folders, markdown docs and
 * image assets, read and edited from the console, by the user's Persona, and
 * by the user's own workers through the doc tools.
 *
 * Who owns a request's docs. Every route works on exactly one owner's tree,
 * resolved from the request's credentials, never from a body field:
 *   - a person through a human channel (the owner secret, or their user
 *     channel token, with an identified alias) owns their alias's docs;
 *   - a Persona credential (its token or writer secret) owns its runtime
 *     owner's docs;
 *   - a worker's launch token (WORKER_TOKEN_HEADER) owns its launch's
 *     trusted owner's docs (reviewOwnerForLaunch).
 * A request with none of these is refused, and a row of anyone else's reads
 * as unknown. Persona and workers reach only the doc tools' routes
 * (POST /api/docs/write, POST /api/docs/write-image, GET /api/docs/read,
 * GET /api/docs/list), and only a worker's doc write may name image files on
 * this host to store beside the doc (tool-images.ts); the tree, search,
 * folders, docs by id, assets and import are a person's (a 403 for an agent).
 * A share link is a read-only view of the latest revision, so a doc shared by
 * link (or inside a folder that is) takes the same writes as any other doc;
 * only a worker's image where a link would show it, or a worker's body that
 * adds an image reference to a doc with a link of its own, is refused.
 * Writes with a JSON body must be JSON (isCrossSiteWrite), and an asset upload must name its image type, so a
 * cross-site form can't send either. Importing from this host's disk is the
 * host owner's alone, as a person through the owner channel: never Persona, a
 * worker or a teammate.
 *
 * Each owner's tree is capped (DocLimits): a write past the image bytes, the
 * doc text bytes or the item count is refused with a 413, like a single doc
 * or image over its own cap.
 *
 * Every change is announced with a `docs:changed` frame addressed to the
 * owner (with proof), which carries no content: the client re-reads through
 * these routes. A write that changes nothing announces nothing.
 */
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Database } from "bun:sqlite";
import { homedir } from "os";
import type { DocDetail, DocsChangedPayload, DocTree, Launch, WsMessage } from "@standup/shared";
import { scratchRoot } from "@standup/shared/scratch";
import {
  DOC_ASSET_MAX_BYTES,
  DOC_SEARCH_QUERY_MAX,
  DOC_TOOL_IMAGE_MAX_BYTES,
  WORKER_TOKEN_HEADER,
  docFolderPaths,
  docPaths,
  isValidDocName,
  parseDocPath,
  resolveDocRelativePath,
} from "@standup/shared";
import {
  DocError,
  countDocAssetRefs,
  createDoc,
  createDocAsset,
  createDocFolder,
  deleteDoc,
  deleteDocAsset,
  deleteDocFolder,
  docFolderPath,
  ensureDocFolderPath,
  findDocAssetByPath,
  findDocByPath,
  findDocFolderByPath,
  getDoc,
  getDocAsset,
  getDocFolder,
  getDocTree,
  getLiveGrant,
  searchDocs,
  toDocAssetInfo,
  updateDoc,
  updateDocAsset,
  updateDocFolder,
  uniqueDocName,
} from "@standup/store";
import type { DocAssetRow, DocDeletion, DocLimits } from "@standup/store";
import type { PersonaFleet } from "../persona/fleet.js";
import { PERSONA_WRITER_HEADER } from "../persona/memory-trust.js";
import { PERSONA_TOKEN_HEADER, isCrossSiteWrite } from "../persona/routes.js";
import { readImageForAttachment } from "../persona/attachments.js";
import { launchForWorkerToken, openedFileResponse, readBodyCapped } from "../review/routes.js";
import { ANONYMOUS_ALIAS, reviewMediaLaunchScratch, reviewMediaWorktree, reviewOwnerForLaunch } from "../review/stage.js";
import { reviewScratchDirFor } from "../review/media.js";
import { IMAGE_REFS_MAX, docImageSources } from "../share/doc-images.js";
import { shareStateOf } from "../share/state.js";
import {
  deleteStoredDocAsset,
  docAssetDigest,
  docAssetMimeFor,
  isImageName,
  mimeOfImageName,
  openStoredDocAsset,
  storeDocAssetBytes,
} from "./assets.js";
import type { DocCommentAgent } from "./comments.js";
import { mountDocSharingRoutes, readerDocAsset, readerDocDetail, shareableViaOf } from "./sharing.js";
import { DocImportError, importDocs } from "./import.js";
import { DocToolImageError, parseDocImages, writeDocWithImages } from "./tool-images.js";
import type { DocToolRequest } from "./tool-images.js";
import { fuseDocHits } from "./semantic.js";
import type { DocsSemanticIndex } from "./semantic.js";

/** A folder, doc or asset id as the store mints it (a UUID). */
const DOC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ASSET_CACHE_SECONDS = 3600;
/** A write-image body: the image in base64 (4 characters per 3 bytes) and room for the path. */
const DOC_TOOL_IMAGE_BODY_MAX = Math.ceil(DOC_TOOL_IMAGE_MAX_BYTES / 3) * 4 + 16 * 1024;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const GUEST_WORKER_IMAGE_REFUSAL = "refused: this worker stores only images inside its own worktree or scratch dirs";
/** Content types an asset upload may declare: none of them a cross-site form can send. */
const UPLOAD_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/octet-stream"]);

export interface DocsRoutesOptions {
  db: Database;
  broadcast: (message: WsMessage) => void;
  /** Standup's data dir: asset copies live under `<dataDir>/doc-assets/`. */
  dataDir: string;
  /** The request's own identity (the server's actingAlias) — never a body field. */
  identityOf(c: Context): string;
  /** Whether the request carries the owner secret (OWNER_TOKEN_HEADER). */
  ownerChannel(c: Context): boolean;
  /** Whether the request carries `alias`'s user channel token (USER_CHANNEL_HEADER). */
  userChannel(c: Context, alias: string): boolean;
  /** Every user's Persona; undefined when Persona is disabled. */
  fleet?: PersonaFleet;
  /** The server's strict owner check (the owner secret and the owner's own identity); null when it passes. */
  ownerRefusal(c: Context, what: string): Response | null;
  /** The home directory and environment import paths are checked against (defaults: the process's). */
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Per-owner caps on the tree (defaults: DEFAULT_DOC_LIMITS). */
  limits?: Partial<DocLimits>;
  /** The semantic index search fuses in and every change pokes; without it, search is keywords only. */
  semantic?: DocsSemanticIndex;
  /** The host owner, whose workers' images may come from anywhere a host's Persona's may (default: the fleet's host). */
  host?: string;
  /** The doc agent replying to comments on docs (docs/comments.ts). */
  docComments: DocCommentAgent;
}

/** Whose docs a request works on, and through which credential. */
interface DocCaller {
  owner: string;
  via: "person" | "persona" | "worker";
  /** The worker's launch, for a worker. */
  launch?: Launch;
}

/** A body field that may be a folder id or null (the root); undefined when absent. */
function folderField(value: unknown): string | null | undefined | false {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === "string" && DOC_ID.test(value) ? value : false;
}

export function mountDocsRoutes(app: Hono, opts: DocsRoutesOptions): void {
  const { db, fleet, limits, semantic } = opts;

  const hasPersonaCredential = (c: Context) => !!c.req.header(PERSONA_TOKEN_HEADER) || !!c.req.header(PERSONA_WRITER_HEADER);

  /** The owner whose docs a doc tool's request works on (a person, Persona or a worker), or the refusal. */
  const toolCallerOf = (c: Context): DocCaller | Response => {
    if (hasPersonaCredential(c)) {
      const runtime =
        fleet?.byToken(c.req.header(PERSONA_TOKEN_HEADER)) ?? fleet?.byWriterSecret(c.req.header(PERSONA_WRITER_HEADER));
      if (!runtime) return c.json({ error: "invalid persona token" }, 401);
      return { owner: runtime.owner, via: "persona" };
    }
    if (c.req.header(WORKER_TOKEN_HEADER) !== undefined) {
      const launch = launchForWorkerToken(db, c.req.header(WORKER_TOKEN_HEADER));
      const owner = launch ? reviewOwnerForLaunch(db, launch) : null;
      if (!owner) {
        return c.json({ error: `Docs are written by a Standup-launched worker with a trusted owner and its worker token (${WORKER_TOKEN_HEADER}).` }, 403);
      }
      return { owner, via: "worker", launch: launch! };
    }
    const alias = opts.identityOf(c);
    if (!alias || alias === ANONYMOUS_ALIAS) {
      return c.json({ error: "Docs need a signed-in user: this request has no authenticated identity.", reason: "unauthenticated" }, 401);
    }
    if (!opts.ownerChannel(c) && !opts.userChannel(c, alias)) {
      return c.json({ error: "Docs are read through the Standup console: this request carries no human-channel proof.", reason: "sign-in" }, 403);
    }
    return { owner: alias, via: "person" };
  };

  /** The owner whose docs a console route works on: a person only; Persona and workers use the doc tools. */
  const callerOf = (c: Context): DocCaller | Response => {
    const caller = toolCallerOf(c);
    if (caller instanceof Response || caller.via === "person") return caller;
    return c.json(
      {
        error:
          "Persona and workers reach Docs only through the doc tools (write_doc, read_doc, list_docs); " +
          "this route is the Standup console's.",
      },
      403
    );
  };

  /** A refusal for a JSON write a cross-site form could have sent, or null. */
  const forgedWrite = (c: Context): Response | null => {
    const forged = isCrossSiteWrite(c);
    return forged ? c.json({ error: `refused: ${forged}` }, 403) : null;
  };

  /** callerOf for a write with a JSON body, which must be JSON (a cross-site form can't send one). */
  const writerOf = (c: Context): DocCaller | Response => {
    const caller = callerOf(c);
    if (caller instanceof Response) return caller;
    return forgedWrite(c) ?? caller;
  };

  const changed = (owner: string, payload: DocsChangedPayload) => {
    semantic?.poke();
    opts.broadcast({ type: "docs:changed", payload, timestamp: new Date().toISOString(), audience: owner, requireProof: true });
  };

  /** The doc as its owner reads it in the console, with its share state. */
  const detail = (doc: DocDetail, caller: DocCaller): DocDetail => ({
    ...doc,
    share: shareStateOf(db, "doc", doc.id, caller.owner),
    ...shareableViaOf(db, doc, caller.owner),
  });

  const docError = (c: Context, err: unknown): Response => {
    if (!(err instanceof DocError)) throw err;
    const status =
      err.code === "not_found" ? 404 : err.code === "conflict" ? 409 : err.code === "too_large" || err.code === "quota" ? 413 : 400;
    return c.json({ error: err.message }, status);
  };

  const jsonBody = async (c: Context): Promise<Record<string, unknown> | null> => {
    const body = await c.req.json<unknown>().catch(() => null);
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  };

  /** Drops the asset copies a delete left that nothing names any more (the store revoked the docs' share links). */
  const afterDeletion = (removed: DocDeletion) => {
    for (const a of removed.assets) {
      if (countDocAssetRefs(db, a.sha256) === 0) deleteStoredDocAsset(opts.dataDir, a.sha256, a.mime);
    }
  };

  /** The doc's path from the root, `folder/sub/name.md`. */
  const pathOf = (doc: { folderId: string | null; name: string }, owner: string): string =>
    [...(docFolderPath(db, doc.folderId, owner) ?? []), doc.name].join("/");

  mountDocSharingRoutes(app, { db, agent: opts.docComments, callerOf, writerOf, changed });

  // ── The tree ─────────────────────────────────────────────────────────────

  app.get("/api/docs/tree", (c) => {
    const caller = callerOf(c);
    if (caller instanceof Response) return caller;
    const tree: DocTree = getDocTree(db, caller.owner);
    return c.json(tree);
  });

  // ── Folders ──────────────────────────────────────────────────────────────

  app.post("/api/docs/folders", async (c) => {
    const caller = writerOf(c);
    if (caller instanceof Response) return caller;
    const body = await jsonBody(c);
    if (!body) return c.json({ error: "malformed request body" }, 400);
    const parentId = folderField(body.parentId);
    if (parentId === false || parentId === undefined) return c.json({ error: "parentId must be a folder id or null" }, 400);
    if (!isValidDocName(body.name)) return c.json({ error: "name must be a valid folder name" }, 400);
    try {
      const folder = createDocFolder(db, { owner: caller.owner, parentId, name: body.name, limits });
      changed(caller.owner, { tree: true });
      return c.json({ folder });
    } catch (err) {
      return docError(c, err);
    }
  });

  app.patch("/api/docs/folders/:id", async (c) => {
    const caller = writerOf(c);
    if (caller instanceof Response) return caller;
    const id = c.req.param("id");
    if (!DOC_ID.test(id)) return c.json({ error: "Unknown folder" }, 404);
    const body = await jsonBody(c);
    if (!body) return c.json({ error: "malformed request body" }, 400);
    const parentId = folderField(body.parentId);
    if (parentId === false) return c.json({ error: "parentId must be a folder id or null" }, 400);
    if (body.name !== undefined && !isValidDocName(body.name)) return c.json({ error: "name must be a valid folder name" }, 400);
    const before = getDocFolder(db, id, caller.owner);
    try {
      const folder = updateDocFolder(db, { id, owner: caller.owner, name: body.name as string | undefined, parentId });
      if (before && (before.name !== folder.name || before.parentId !== folder.parentId)) changed(caller.owner, { tree: true });
      return c.json({ folder });
    } catch (err) {
      return docError(c, err);
    }
  });

  app.delete("/api/docs/folders/:id", (c) => {
    const caller = callerOf(c);
    if (caller instanceof Response) return caller;
    const id = c.req.param("id");
    const removed = DOC_ID.test(id) ? deleteDocFolder(db, id, caller.owner) : null;
    if (!removed) return c.json({ error: "Unknown folder" }, 404);
    afterDeletion(removed);
    changed(caller.owner, { tree: true, deleted: true });
    return c.json({ ok: true });
  });

  // ── Assets ───────────────────────────────────────────────────────────────

  app.post("/api/docs/assets", async (c) => {
    const caller = callerOf(c);
    if (caller instanceof Response) return caller;
    const type = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!UPLOAD_TYPES.has(type)) return c.json({ error: "refused: Content-Type must be the image's type" }, 403);
    const rawFolder = c.req.query("folderId") ?? "";
    const folderId = rawFolder === "" ? null : DOC_ID.test(rawFolder) ? rawFolder : false;
    if (folderId === false) return c.json({ error: "folderId must be a folder id or empty" }, 400);
    const name = c.req.query("name") ?? "";
    if (!isValidDocName(name) || !isImageName(name)) {
      return c.json({ error: "name must be a valid file name ending in .png, .jpg, .jpeg, .gif or .webp" }, 400);
    }
    const tooLarge = () => c.json({ error: `the image is over ${DOC_ASSET_MAX_BYTES} bytes` }, 413);
    if (Number(c.req.header("content-length") ?? "0") > DOC_ASSET_MAX_BYTES) return tooLarge();
    const bytes = await readBodyCapped(c.req.raw, DOC_ASSET_MAX_BYTES);
    if (bytes === null) return tooLarge();
    if (bytes.length === 0) return c.json({ error: "the image is empty" }, 400);
    const mime = docAssetMimeFor(name, bytes);
    if (!mime) return c.json({ error: "the file is not a PNG, JPEG, GIF or WebP image matching its extension (checked by content)" }, 400);
    let sha256: string;
    try {
      sha256 = storeDocAssetBytes(opts.dataDir, bytes, mime);
    } catch (err) {
      console.error("[docs] storing an asset failed:", (err as Error).message);
      return c.json({ error: "The image could not be stored" }, 500);
    }
    try {
      const asset = createDocAsset(db, { owner: caller.owner, folderId, name, mime, sha256, bytes: bytes.length, limits });
      changed(caller.owner, { tree: true });
      return c.json({ asset: toDocAssetInfo(asset) });
    } catch (err) {
      if (countDocAssetRefs(db, sha256) === 0) deleteStoredDocAsset(opts.dataDir, sha256, mime);
      return docError(c, err);
    }
  });

  // An asset's stored copy, addressed by id only: the row must be the caller's,
  // and the file served is the collector's own copy, never a path a request names.
  app.get("/api/docs/assets/:id", (c) => {
    const caller = callerOf(c);
    if (caller instanceof Response) return caller;
    const id = c.req.param("id");
    // Another user's image only through a doc shared with this caller that shows it (docs/sharing.ts).
    const asset = DOC_ID.test(id) ? (getDocAsset(db, id, caller.owner) ?? readerDocAsset(db, id, c.req.query("doc"), caller.owner)) : null;
    if (!asset) return c.json({ error: "Unknown asset" }, 404);
    const stored = openStoredDocAsset(opts.dataDir, asset.sha256, asset.mime, asset.bytes);
    if (!stored) return c.json({ error: "The asset's stored copy is missing" }, 410);
    return openedFileResponse(c, stored, asset.mime, { "cache-control": `private, max-age=${ASSET_CACHE_SECONDS}` });
  });

  app.patch("/api/docs/assets/:id", async (c) => {
    const caller = writerOf(c);
    if (caller instanceof Response) return caller;
    const id = c.req.param("id");
    if (!DOC_ID.test(id)) return c.json({ error: "Unknown asset" }, 404);
    const body = await jsonBody(c);
    if (!body) return c.json({ error: "malformed request body" }, 400);
    const folderId = folderField(body.folderId);
    if (folderId === false) return c.json({ error: "folderId must be a folder id or null" }, 400);
    if (body.name !== undefined && (!isValidDocName(body.name) || !isImageName(body.name))) {
      return c.json({ error: "name must be a valid file name ending in .png, .jpg, .jpeg, .gif or .webp" }, 400);
    }
    const current = getDocAsset(db, id, caller.owner);
    // A rename keeps the content's type: the new extension must name the same type.
    if (current && typeof body.name === "string" && mimeOfImageName(body.name) !== current.mime) {
      return c.json({ error: "the new name's extension must match the image's type" }, 400);
    }
    try {
      const asset = updateDocAsset(db, { id, owner: caller.owner, name: body.name as string | undefined, folderId });
      if (current && (current.name !== asset.name || current.folderId !== asset.folderId)) changed(caller.owner, { tree: true });
      return c.json({ asset: toDocAssetInfo(asset) });
    } catch (err) {
      return docError(c, err);
    }
  });

  app.delete("/api/docs/assets/:id", (c) => {
    const caller = callerOf(c);
    if (caller instanceof Response) return caller;
    const id = c.req.param("id");
    const removed = DOC_ID.test(id) ? deleteDocAsset(db, id, caller.owner) : null;
    if (!removed) return c.json({ error: "Unknown asset" }, 404);
    afterDeletion({ docIds: [], assets: [{ sha256: removed.sha256, mime: removed.mime }] });
    changed(caller.owner, { tree: true, deleted: true });
    return c.json({ ok: true });
  });

  // ── Import from this host's disk: the host owner's alone ────────────────

  app.post("/api/docs/import", async (c) => {
    if (hasPersonaCredential(c)) return c.json({ error: "Persona's token cannot be used to import docs" }, 403);
    if (c.req.header(WORKER_TOKEN_HEADER) !== undefined) return c.json({ error: "Only the owner can import docs" }, 403);
    const refused = opts.ownerRefusal(c, "import docs from this host");
    if (refused) return refused;
    const forged = isCrossSiteWrite(c);
    if (forged) return c.json({ error: `refused: ${forged}` }, 403);
    const owner = opts.identityOf(c);
    const body = await jsonBody(c);
    if (!body || typeof body.path !== "string") return c.json({ error: "path must be a string" }, 400);
    const folderId = folderField(body.folderId);
    if (folderId === false || folderId === undefined) return c.json({ error: "folderId must be a folder id or null" }, 400);
    try {
      const result = importDocs(db, { owner, path: body.path, folderId, dataDir: opts.dataDir, home: opts.home, env: opts.env, limits });
      changed(owner, { tree: true });
      return c.json(result);
    } catch (err) {
      if (err instanceof DocImportError) return c.json({ error: err.message }, 400);
      if (err instanceof DocError) return docError(c, err);
      console.error("[docs] an import failed:", (err as Error).message);
      return c.json({ error: "The import failed; nothing was imported" }, 500);
    }
  });

  // ── Doc tools: by path ──────────────────────────────────────────────────

  /**
   * The path of a link-shared item that would show an image placed in the
   * folder at `folderNames`, or null: a folder link shows every image inside
   * its folder, and a doc link the images below the doc's own folder. So it is
   * any folder on the way that is shared, or holds a doc that is.
   */
  const linkThatCouldShow = (owner: string, folderNames: readonly string[]): string | null => {
    const docs = getDocTree(db, owner).docs;
    for (let depth = 0; depth <= folderNames.length; depth++) {
      const prefix = folderNames.slice(0, depth);
      const folder = findDocFolderByPath(db, owner, prefix);
      if (folder === undefined) return null;
      if (folder && getLiveGrant(db, "folder", folder.id, owner)) return `${prefix.join("/")}/`;
      const folderId = folder?.id ?? null;
      const shared = docs.find((d) => d.folderId === folderId && getLiveGrant(db, "doc", d.id, owner));
      if (shared) return [...prefix, shared.name].join("/");
    }
    return null;
  };

  /**
   * The image sources `body` adds over `before` for a doc in the folder at
   * `folderPath`, as written: one counts as already there when it resolves
   * to the same path as one of `before`'s (`./a.png` and `a.png`), or reads
   * the same when it resolves to nothing. A URL or a `/`-rooted src never
   * names an image in the tree, so it is never counted. Null when `body` has
   * too many references (`![`) for docImageSources to read them all: one past
   * its cap would go unseen here and show once an earlier one is removed.
   */
  const addedImageSources = (folderPath: readonly string[], before: string, body: string): string[] | null => {
    if (body.split("![").length > IMAGE_REFS_MAX) return null;
    const key = (src: string) => {
      const path = resolveDocRelativePath(folderPath, src);
      return path ? `path:${path.join("/")}` : `raw:${src.trim()}`;
    };
    const had = new Set(docImageSources(before).map(key));
    const added = new Map<string, string>();
    for (const src of docImageSources(body)) {
      if (/^\s*(\/|[a-z][a-z0-9+.-]*:)/i.test(src) || had.has(key(src)) || added.has(key(src))) continue;
      added.set(key(src), src);
    }
    return [...added.values()];
  };

  /** The `path` a doc tool names: absent or blank is "path is required". */
  const toolPath = (path: unknown): string[] | "missing" | null =>
    path === undefined || path === null || (typeof path === "string" && path.trim() === "") ? "missing" : parseDocPath(path);

  /**
   * Where a worker's images may be read from: anywhere a host's Persona's may
   * for the host's own workers; for a guest's, only the launch's own
   * worktree, its TMPDIR scratch dir and its review scratch dir, since every
   * worker runs as the host and anywhere else on the host is the host's.
   */
  const workerImageRoots = (caller: DocCaller): string[] | undefined => {
    if (caller.owner === (opts.host ?? fleet?.host)) return undefined;
    const launch = caller.launch;
    if (!launch) return [];
    const env = opts.env ?? process.env;
    return [
      reviewMediaWorktree(launch),
      reviewMediaLaunchScratch(db, launch, scratchRoot(env, opts.home ?? homedir())),
      reviewScratchDirFor(opts.dataDir, launch.id),
    ].filter((root): root is string => !!root);
  };

  /**
   * A worker's doc write with `images` (files on this host): the doc tools'
   * write with images, each step a request to these same routes with the
   * worker's own token, so every rule a worker's image or doc write meets
   * applies unchanged.
   */
  const writeWithImages = async (c: Context, caller: DocCaller, path: string, content: string, ifRevision: number | undefined, images: unknown) => {
    const request: DocToolRequest = async (method, routePath, payload) => {
      const headers = new Headers({ "content-type": "application/json", [WORKER_TOKEN_HEADER]: c.req.header(WORKER_TOKEN_HEADER) ?? "" });
      const host = c.req.header("host");
      if (host) headers.set("host", host);
      const res = await app.request(new URL(routePath, c.req.url).toString(), {
        method,
        headers,
        ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
      });
      const parsed = (await res.json().catch(() => null)) as unknown;
      const resBody = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
      return { status: res.status, body: resBody };
    };
    const allowedRoots = workerImageRoots(caller);
    try {
      const written = await writeDocWithImages({
        path,
        content,
        ...(ifRevision !== undefined ? { ifRevision } : {}),
        images: parseDocImages(images, path),
        readImage: (file) =>
          readImageForAttachment(file, {
            dataDir: opts.dataDir,
            home: opts.home,
            env: opts.env,
            ...(allowedRoots ? { allowedRoots, notAllowedMessage: GUEST_WORKER_IMAGE_REFUSAL, refuseHardLinks: true } : {}),
          }),
        request,
      });
      return c.json({ doc: written.doc, images: written.stored.map((p, i) => ({ path: p, src: written.srcs[i]! })) });
    } catch (err) {
      if (!(err instanceof DocToolImageError)) throw err;
      const status = err.status >= 400 && err.status <= 599 ? (err.status as ContentfulStatusCode) : 500;
      return c.json({ error: err.message }, status);
    }
  };

  // Creates the doc at `path` (and any missing folders on the way) or
  // replaces its body; with ifRevision, only while the doc is at that revision.
  // A doc shared by link is written like any other: the link is a read-only
  // view of the doc's latest revision. Only a worker's body that adds an image
  // reference to a doc with a link of its own is refused: a doc link shows
  // every image its body references in the doc's folder or below (the whole
  // tree for a doc at the top), now or once one is stored there, and which of
  // the owner's images a link publishes is the owner's or their Persona's
  // call, as in write-image below.
  app.post("/api/docs/write", async (c) => {
    const caller = toolCallerOf(c);
    if (caller instanceof Response) return caller;
    const forged = forgedWrite(c);
    if (forged) return forged;
    const body = await jsonBody(c);
    if (!body) return c.json({ error: "malformed request body" }, 400);
    const names = toolPath(body.path);
    if (names === "missing") return c.json({ error: "path is required" }, 400);
    if (!names) return c.json({ error: "path must be a slash-separated doc path, e.g. notes/design.md" }, 400);
    if (typeof body.content !== "string") return c.json({ error: "content must be a string" }, 400);
    const ifRevision = body.ifRevision;
    if (ifRevision !== undefined && !(typeof ifRevision === "number" && Number.isInteger(ifRevision))) {
      return c.json({ error: "ifRevision must be an integer" }, 400);
    }
    if (body.images !== undefined && body.images !== null && !(Array.isArray(body.images) && body.images.length === 0)) {
      if (caller.via !== "worker") {
        return c.json({ error: "images name files on this host, which only a worker's doc write takes (Persona's write_doc reads its own)" }, 403);
      }
      return writeWithImages(c, caller, body.path as string, body.content, ifRevision as number | undefined, body.images);
    }
    const content = body.content;
    const folderNames = names.slice(0, -1);
    const name = names[names.length - 1]!;
    type Written =
      | { ok: true; doc: DocDetail; tree: boolean; changed: boolean }
      | { ok: false; doc: DocDetail | null }
      | { ok: false; shared: DocDetail; added: string[] | null };
    const write = db.transaction((): Written => {
      const existing = findDocByPath(db, caller.owner, names);
      if (existing) {
        if (caller.via === "worker" && getLiveGrant(db, "doc", existing.id, caller.owner)) {
          const added = addedImageSources(docFolderPath(db, existing.folderId, caller.owner) ?? [], existing.body, content);
          if (added === null || added.length > 0) return { ok: false, shared: existing, added };
        }
        const result = updateDoc(db, {
          id: existing.id,
          owner: caller.owner,
          body: content,
          baseRevision: ifRevision as number | undefined,
          limits,
        });
        return result.ok ? { ok: true, doc: result.doc, tree: false, changed: result.bodyChanged } : { ok: false, doc: result.doc };
      }
      if (ifRevision !== undefined) return { ok: false, doc: null };
      const folderId = ensureDocFolderPath(db, caller.owner, folderNames, null, new Date(), limits);
      return { ok: true, doc: createDoc(db, { owner: caller.owner, folderId, name, body: content, limits }), tree: true, changed: true };
    });
    let written: Written;
    try {
      written = write();
    } catch (err) {
      return docError(c, err);
    }
    if ("shared" in written) {
      const path = pathOf(written.shared, caller.owner);
      const what =
        written.added === null
          ? `${IMAGE_REFS_MAX} or more image references`
          : `image references it didn't have (${written.added.slice(0, 5).join(", ")}${written.added.length > 5 ? ", …" : ""})`;
      return c.json(
        {
          error: `${path} is shared by link, and the new body has ${what}; only the owner or their Persona can add an image to a shared doc, so leave the images out`,
        },
        409
      );
    }
    if (!written.ok) {
      const doc = written.doc;
      return c.json(
        {
          error: doc
            ? `the doc is at revision ${doc.revision}, not ${String(ifRevision)}: read it again and reapply your change`
            : "there is no doc at that path to update; write without ifRevision to create it",
          ...(doc ? { doc: { id: doc.id, path: pathOf(doc, caller.owner), revision: doc.revision } } : {}),
        },
        409
      );
    }
    const doc = written.doc;
    if (written.changed) changed(caller.owner, { tree: written.tree, docId: doc.id, revision: doc.revision });
    return c.json({ doc: { id: doc.id, path: pathOf(doc, caller.owner), revision: doc.revision } });
  });

  // Stores an image at `path` (and any missing folders on the way), for a doc
  // to embed by a src relative to its own folder: `![caption](screens/home.png)`.
  // The doc tools store write_doc's images here, and the console's editor
  // the images a person picks, pastes or drops. The bytes come base64 in the
  // JSON body; their type is read from their content and must match the
  // name's extension. An image already there with other bytes is replaced by
  // a new asset (a new id, so a new URL no cache still holds); the same bytes
  // change nothing. With `unique: true` (the editor's) nothing is replaced:
  // other bytes are stored under the first free `name (2)`… beside it, and
  // the path answered is the one used. A `folderId` names the folder the
  // caller means `path`'s folders to be, refused with a 409 when they are no
  // longer that folder (renamed or moved since the caller read the tree).
  // A worker may not add or
  // change an image where a share link would show it: the bytes are a file
  // from this host, so the owner or their Persona, whose doc tools run only in
  // the owner's private thread, publishes one (a worker's docs may still land
  // in a shared folder or change a shared doc; those are text it wrote).
  app.post("/api/docs/write-image", async (c) => {
    const caller = toolCallerOf(c);
    if (caller instanceof Response) return caller;
    const forged = forgedWrite(c);
    if (forged) return forged;
    const tooLarge = () => c.json({ error: `the image is over ${DOC_TOOL_IMAGE_MAX_BYTES / (1024 * 1024)} MB` }, 413);
    if (Number(c.req.header("content-length") ?? "0") > DOC_TOOL_IMAGE_BODY_MAX) return tooLarge();
    const raw = await readBodyCapped(c.req.raw, DOC_TOOL_IMAGE_BODY_MAX);
    if (raw === null) return tooLarge();
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(raw)) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      body = parsed as Record<string, unknown>;
    } catch {
      return c.json({ error: "malformed request body" }, 400);
    }
    const names = toolPath(body.path);
    if (names === "missing") return c.json({ error: "path is required" }, 400);
    const name = names ? names[names.length - 1]! : "";
    if (!names || !isImageName(name)) {
      return c.json({ error: "path must be a slash-separated image path ending in .png, .jpg, .jpeg, .gif or .webp, e.g. notes/screens/home.png" }, 400);
    }
    if (typeof body.data !== "string" || !BASE64.test(body.data)) return c.json({ error: "data must be the image's bytes in base64" }, 400);
    if (body.unique !== undefined && typeof body.unique !== "boolean") return c.json({ error: "unique must be a boolean" }, 400);
    const unique = body.unique === true;
    const meantFolder = folderField(body.folderId);
    if (meantFolder === false) return c.json({ error: "folderId must be a folder id or null" }, 400);
    const folderNames = names.slice(0, -1);
    if (meantFolder !== undefined) {
      const at = findDocFolderByPath(db, caller.owner, folderNames);
      if (at === undefined || (at?.id ?? null) !== meantFolder) {
        return c.json({ error: `${folderNames.join("/") || "the top level"} is no longer the folder this image was meant for; read the tree again` }, 409);
      }
    }
    const bytes = Buffer.from(body.data, "base64");
    if (bytes.length === 0) return c.json({ error: "the image is empty" }, 400);
    if (bytes.length > DOC_TOOL_IMAGE_MAX_BYTES) return tooLarge();
    const mime = docAssetMimeFor(name, bytes);
    if (!mime) return c.json({ error: "the file is not a PNG, JPEG, GIF or WebP image matching its extension (checked by content)" }, 400);
    const already = findDocAssetByPath(db, caller.owner, names);
    if (already && already.mime === mime && already.sha256 === docAssetDigest(bytes)) {
      return c.json({ asset: { id: already.id, path: names.join("/"), mime: already.mime, bytes: already.bytes, url: already.url }, unchanged: true });
    }
    const link = caller.via === "worker" ? linkThatCouldShow(caller.owner, folderNames) : null;
    if (link) {
      return c.json(
        { error: `${names.join("/")} is where ${link} (shared by link) shows images; only the owner or their Persona can add or change an image a link shows (turn sharing off first)` },
        409
      );
    }
    let sha256: string;
    try {
      sha256 = storeDocAssetBytes(opts.dataDir, bytes, mime);
    } catch (err) {
      console.error("[docs] storing an asset failed:", (err as Error).message);
      return c.json({ error: "The image could not be stored" }, 500);
    }
    type Stored = { asset: DocAssetRow; replaced: DocAssetRow | null; changed: boolean };
    const write = db.transaction((): Stored => {
      const existing = findDocAssetByPath(db, caller.owner, names);
      if (existing && existing.sha256 === sha256 && existing.mime === mime) return { asset: existing, replaced: null, changed: false };
      if (unique) {
        const folderId = ensureDocFolderPath(db, caller.owner, folderNames, null, new Date(), limits);
        const free = uniqueDocName(db, caller.owner, folderId, name);
        return { asset: createDocAsset(db, { owner: caller.owner, folderId, name: free, mime, sha256, bytes: bytes.length, limits }), replaced: null, changed: true };
      }
      if (existing) deleteDocAsset(db, existing.id, caller.owner);
      const folderId = existing ? existing.folderId : ensureDocFolderPath(db, caller.owner, folderNames, null, new Date(), limits);
      const asset = createDocAsset(db, { owner: caller.owner, folderId, name, mime, sha256, bytes: bytes.length, limits });
      return { asset, replaced: existing, changed: true };
    });
    let stored: Stored;
    try {
      stored = write();
    } catch (err) {
      if (countDocAssetRefs(db, sha256) === 0) deleteStoredDocAsset(opts.dataDir, sha256, mime);
      return docError(c, err);
    }
    if (stored.replaced) afterDeletion({ docIds: [], assets: [{ sha256: stored.replaced.sha256, mime: stored.replaced.mime }] });
    if (stored.changed) changed(caller.owner, { tree: true });
    return c.json({
      asset: { id: stored.asset.id, path: [...folderNames, stored.asset.name].join("/"), mime: stored.asset.mime, bytes: stored.asset.bytes, url: stored.asset.url },
      ...(stored.changed ? {} : { unchanged: true }),
    });
  });

  app.get("/api/docs/read", (c) => {
    const caller = toolCallerOf(c);
    if (caller instanceof Response) return caller;
    const names = toolPath(c.req.query("path"));
    if (names === "missing") return c.json({ error: "path is required" }, 400);
    if (!names) return c.json({ error: "path must be a slash-separated doc path, e.g. notes/design.md" }, 400);
    const doc = findDocByPath(db, caller.owner, names);
    if (!doc) return c.json({ error: "Unknown doc" }, 404);
    return c.json({ doc: { id: doc.id, path: pathOf(doc, caller.owner), revision: doc.revision, body: doc.body } });
  });

  // The folders and docs below a folder (by path), or the whole tree; every
  // path from the root. Leading and trailing slashes are ignored, so `/` is the root.
  app.get("/api/docs/list", (c) => {
    const caller = toolCallerOf(c);
    if (caller instanceof Response) return caller;
    const raw = (c.req.query("folder") ?? "").trim().replace(/^\/+|\/+$/g, "");
    const names = raw === "" ? [] : parseDocPath(raw);
    if (!names) return c.json({ error: "folder must be a slash-separated folder path" }, 400);
    if (findDocFolderByPath(db, caller.owner, names) === undefined) return c.json({ error: "Unknown folder" }, 404);
    const tree = getDocTree(db, caller.owner);
    const paths = docFolderPaths(tree.folders);
    const folderPath = (id: string | null): string[] => (id ? (paths.get(id) ?? []) : []);
    const under = (path: string[]) => path.length >= names.length && names.every((n, i) => path[i] === n);
    const folders = tree.folders
      .map((f) => folderPath(f.id))
      .filter((p) => under(p) && p.length > names.length)
      .map((p) => p.join("/"))
      .sort();
    const docs = tree.docs
      .map((d) => ({ dir: folderPath(d.folderId), d }))
      .filter(({ dir }) => under(dir))
      .map(({ dir, d }) => ({ id: d.id, path: [...dir, d.name].join("/"), revision: d.revision, bytes: d.bytes, updatedAt: d.updatedAt }))
      .sort((a, b) => a.path.localeCompare(b.path));
    return c.json({ folder: names.join("/"), folders, docs });
  });

  // The console's search over the person's own docs: name and path matches, then body matches fused with
  // meaning matches from the semantic index (keywords alone when it has no embedder or the query can't be embedded).
  app.get("/api/docs/search", async (c) => {
    const caller = callerOf(c);
    if (caller instanceof Response) return caller;
    const q = (c.req.query("q") ?? "").trim();
    if (q.length > DOC_SEARCH_QUERY_MAX) return c.json({ error: `q must be at most ${DOC_SEARCH_QUERY_MAX} characters` }, 400);
    const keyword = searchDocs(db, caller.owner, q);
    const meaning = semantic
      ? await semantic.search(caller.owner, q).catch((err) => {
          console.error("[docs] meaning search failed:", err);
          return [];
        })
      : [];
    if (meaning.length === 0) return c.json({ hits: keyword });
    return c.json({ hits: fuseDocHits(keyword, meaning, docPaths(getDocTree(db, caller.owner))) });
  });

  // ── Docs ─────────────────────────────────────────────────────────────────

  app.post("/api/docs", async (c) => {
    const caller = writerOf(c);
    if (caller instanceof Response) return caller;
    const body = await jsonBody(c);
    if (!body) return c.json({ error: "malformed request body" }, 400);
    const folderId = folderField(body.folderId);
    if (folderId === false || folderId === undefined) return c.json({ error: "folderId must be a folder id or null" }, 400);
    if (!isValidDocName(body.name)) return c.json({ error: "name must be a valid doc name" }, 400);
    if (body.body !== undefined && typeof body.body !== "string") return c.json({ error: "body must be a string" }, 400);
    try {
      const doc = createDoc(db, { owner: caller.owner, folderId, name: body.name, body: body.body as string | undefined, limits });
      changed(caller.owner, { tree: true, docId: doc.id, revision: doc.revision });
      return c.json({ doc: detail(doc, caller) });
    } catch (err) {
      return docError(c, err);
    }
  });

  app.get("/api/docs/:id", (c) => {
    const caller = callerOf(c);
    if (caller instanceof Response) return caller;
    const id = c.req.param("id");
    const doc = DOC_ID.test(id) ? getDoc(db, id, caller.owner) : null;
    // Another user's doc reads only when it is shared with everyone signed in (docs/sharing.ts).
    const shared = doc || !DOC_ID.test(id) ? null : readerDocDetail(db, id, caller.owner);
    if (shared) return c.json({ doc: shared });
    if (!doc) return c.json({ error: "Unknown doc" }, 404);
    return c.json({ doc: detail(doc, caller) });
  });

  app.patch("/api/docs/:id", async (c) => {
    const caller = writerOf(c);
    if (caller instanceof Response) return caller;
    const id = c.req.param("id");
    if (!DOC_ID.test(id)) return c.json({ error: "Unknown doc" }, 404);
    const body = await jsonBody(c);
    if (!body) return c.json({ error: "malformed request body" }, 400);
    const folderId = folderField(body.folderId);
    if (folderId === false) return c.json({ error: "folderId must be a folder id or null" }, 400);
    if (body.name !== undefined && !isValidDocName(body.name)) return c.json({ error: "name must be a valid doc name" }, 400);
    if (body.body !== undefined && typeof body.body !== "string") return c.json({ error: "body must be a string" }, 400);
    const base = body.baseRevision;
    if (base !== undefined && !(typeof base === "number" && Number.isInteger(base))) return c.json({ error: "baseRevision must be an integer" }, 400);
    try {
      const result = updateDoc(db, {
        id,
        owner: caller.owner,
        name: body.name as string | undefined,
        folderId,
        body: body.body as string | undefined,
        baseRevision: base as number | undefined,
        limits,
      });
      if (!result.ok) {
        return c.json({ error: `the doc changed: it is at revision ${result.doc.revision}`, doc: detail(result.doc, caller) }, 409);
      }
      const { doc } = result;
      if (result.renamed || result.moved || result.bodyChanged) {
        changed(caller.owner, { tree: result.renamed || result.moved, docId: doc.id, revision: doc.revision });
      }
      return c.json({ doc: detail(doc, caller) });
    } catch (err) {
      return docError(c, err);
    }
  });

  app.delete("/api/docs/:id", (c) => {
    const caller = callerOf(c);
    if (caller instanceof Response) return caller;
    const id = c.req.param("id");
    if (!DOC_ID.test(id) || !deleteDoc(db, id, caller.owner)) return c.json({ error: "Unknown doc" }, 404);
    afterDeletion({ docIds: [id], assets: [] });
    changed(caller.owner, { tree: true, docId: id, deleted: true });
    return c.json({ ok: true });
  });
}
