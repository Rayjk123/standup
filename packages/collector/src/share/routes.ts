/**
 * Read-only share links for every shareable resource (mountShareRoutes): the
 * public routes a link reads, and the owner's toggle.
 *
 * Trust boundary. The public routes are the only ones here that need no
 * identity: the share token in the path is the whole credential. They are
 * ordinary routes with their own exact patterns, never a prefix the rest of
 * the API is let through by, so they open nothing else:
 *   - the segment must name a shareable type (SHARE_API_SEGMENTS) and the
 *     token must be well formed (SHARE_TOKEN); it is looked up by its digest
 *     among that type's live grants on every request, so turning sharing off
 *     revokes the link at once;
 *   - a bad segment, a bad, revoked or rotated token, unknown media and a
 *     file that can't be served all get the same bare 404, which names no
 *     resource and tells nothing of whether one exists;
 *   - a resubmitted or superseded review packet's link is revoked
 *     (submitReviewPacket), and a deleted doc's with it, so a link only ever
 *     shows content the owner chose to share;
 *   - each type's public view copies its display fields out by name
 *     (ShareResource.publicView), so nothing added later leaks;
 *   - a shared folder's docs are addressed by the token and a doc id only
 *     (`<token>/docs/<id>`), and a doc is shown only while it lies in the
 *     folder or a folder below it, checked by its parent links on every
 *     request; a type that holds no docs answers that route with the 404;
 *   - a deleted folder's link is revoked with it (deleteDocFolder);
 *   - media is addressed by the token and a media id only, must belong to
 *     the token's resource (a doc's only when its body shows it and it lives
 *     in the doc's folder or a folder below it; a folder's only when it lives
 *     in the folder or below it), and the
 *     file served is the collector's own content-addressed copy, never a path
 *     a request names;
 *   - responses are not cached and send no referrer, so a share page's token
 *     doesn't outlive the share in a cache or leak to a site it links to.
 *
 * Turning sharing on or off is a person's alone: the resource's owner
 * through a human channel (the owner secret or their user channel token,
 * with an identified alias), never Persona, and as a same-site JSON write.
 */
import type { Context, Hono } from "hono";
import type { Database } from "bun:sqlite";
import type { DocsChangedPayload, ShareResourceType, ShareState, WsMessage } from "@standup/shared";
import { SHARE_API_ROOT, SHARE_API_SEGMENTS, SHARE_RESOURCE_TYPES, SHARE_TOKEN, isShareResourceType } from "@standup/shared";
import { findLiveGrantByToken, listSharedResourceIds, setShare } from "@standup/store";
import type { ShareGrant } from "@standup/store";
import { PERSONA_WRITER_HEADER } from "../persona/memory-trust.js";
import { PERSONA_TOKEN_HEADER, isCrossSiteWrite } from "../persona/routes.js";
import { ANONYMOUS_ALIAS } from "../review/stage.js";
import { SHARE_HEADERS, shareResources } from "./resources.js";
import type { ShareResource } from "./resources.js";
import { shareStateOf } from "./state.js";

/** A resource or media id as the store mints it (a UUID). */
const RESOURCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ShareRoutesOptions {
  db: Database;
  /** Standup's data dir: review media copies and doc asset copies live under it. */
  dataDir: string;
  /** The request's own identity (the server's actingAlias) — never a body field. */
  identityOf(c: Context): string;
  /** Whether the request carries the owner secret (OWNER_TOKEN_HEADER). */
  ownerChannel(c: Context): boolean;
  /** Whether the request carries `alias`'s user channel token (USER_CHANNEL_HEADER). */
  userChannel(c: Context, alias: string): boolean;
  /** Announces a doc's share toggle to its owner's other tabs (a content-free `docs:changed`). */
  broadcast?: (message: WsMessage) => void;
}

/** The type a public API segment names, or null. */
function typeOfSegment(segment: string | undefined): ShareResourceType | null {
  return SHARE_RESOURCE_TYPES.find((t) => SHARE_API_SEGMENTS[t] === segment) ?? null;
}

/** The bare 404 every public refusal answers with. */
function notFound(c: Context): Response {
  return c.json({ error: "Not found" }, 404, SHARE_HEADERS);
}

export function mountShareRoutes(app: Hono, opts: ShareRoutesOptions): void {
  const { db } = opts;
  const resources = shareResources({ dataDir: opts.dataDir });

  /** The live grant a public request's segment and token name, or null. */
  const grantOf = (c: Context): { resource: ShareResource; grant: ShareGrant } | null => {
    const type = typeOfSegment(c.req.param("segment"));
    const token = c.req.param("token");
    if (!type || !token || !SHARE_TOKEN.test(token)) return null;
    const grant = findLiveGrantByToken(db, type, token);
    return grant ? { resource: resources[type], grant } : null;
  };

  // ── Public, by token ────────────────────────────────────────────────────

  app.get(`${SHARE_API_ROOT}:segment/:token`, (c) => {
    const found = grantOf(c);
    if (!found) return notFound(c);
    const { resource, grant } = found;
    const view = resource.publicView(db, grant.resourceId, grant.owner, grant.token);
    return view ? c.json(view, 200, SHARE_HEADERS) : notFound(c);
  });

  app.get(`${SHARE_API_ROOT}:segment/:token/docs/:docId`, (c) => {
    const found = grantOf(c);
    const docId = c.req.param("docId");
    const publicDoc = found?.resource.publicDoc;
    if (!found || !publicDoc || !RESOURCE_ID.test(docId)) return notFound(c);
    const { grant } = found;
    const view = publicDoc(db, grant.resourceId, grant.owner, grant.token, docId);
    return view ? c.json(view, 200, SHARE_HEADERS) : notFound(c);
  });

  app.get(`${SHARE_API_ROOT}:segment/:token/media/:mediaId`, (c) => {
    const found = grantOf(c);
    const mediaId = c.req.param("mediaId");
    if (!found || !RESOURCE_ID.test(mediaId)) return notFound(c);
    const { resource, grant } = found;
    return resource.publicMedia(c, db, grant.resourceId, grant.owner, mediaId) ?? notFound(c);
  });

  // ── The owner's toggle ──────────────────────────────────────────────────

  const hasPersonaCredential = (c: Context) => !!c.req.header(PERSONA_TOKEN_HEADER) || !!c.req.header(PERSONA_WRITER_HEADER);

  /**
   * The person a share request is from, or the refusal: no Persona
   * credential, the owner secret or the caller's user channel token, an
   * identified alias, and for a write a same-site JSON request.
   */
  const personOf = (c: Context, what: string, write: boolean): string | Response => {
    if (hasPersonaCredential(c)) return c.json({ error: `Persona's token cannot be used to ${what}` }, 403);
    const alias = opts.identityOf(c);
    if (!opts.ownerChannel(c) && !(alias && opts.userChannel(c, alias))) {
      return c.json({ error: `Only a person can ${what}: use the Standup console.` }, 403);
    }
    if (write) {
      const forged = isCrossSiteWrite(c);
      if (forged) return c.json({ error: `refused: ${forged}` }, 403);
    }
    if (!alias || alias === ANONYMOUS_ALIAS) return c.json({ error: `An identified user is required to ${what}` }, 403);
    return alias;
  };

  /** Turns sharing of the caller's resource on or off and answers with its share state. */
  const toggle = async (c: Context, type: ShareResourceType, id: string): Promise<Response> => {
    const resource = resources[type];
    const actor = personOf(c, `share a ${resource.noun}`, true);
    if (actor instanceof Response) return actor;
    const unknown = () => c.json({ error: `Unknown ${resource.noun}` }, 404);
    if (!RESOURCE_ID.test(id) || !resource.exists(db, id, actor)) return unknown();
    const body = await c.req.json<{ enabled?: unknown }>().catch(() => ({}) as { enabled?: unknown });
    if (typeof body.enabled !== "boolean") return c.json({ error: "enabled must be true or false" }, 400);
    if (body.enabled) {
      const refusal = resource.shareRefusal?.(db, id, actor) ?? null;
      if (refusal) return c.json({ error: refusal }, 409);
    }
    setShare(db, type, id, actor, body.enabled);
    const share: ShareState = shareStateOf(db, type, id, actor);
    if (type === "doc" || type === "folder") {
      const payload: DocsChangedPayload = type === "doc" ? { tree: false, docId: id, share: true } : { tree: false, folderId: id, share: true };
      opts.broadcast?.({ type: "docs:changed", payload, timestamp: new Date().toISOString(), audience: actor, requireProof: true });
    }
    return c.json({ share });
  };

  app.get("/api/shares/:type", (c) => {
    const type = c.req.param("type");
    if (!isShareResourceType(type)) return c.json({ error: "Unknown share type" }, 404);
    const actor = personOf(c, `list your shared ${resources[type].noun}s`, false);
    if (actor instanceof Response) return actor;
    return c.json({ ids: listSharedResourceIds(db, type, actor) });
  });

  app.get("/api/shares/:type/:id", (c) => {
    const type = c.req.param("type");
    if (!isShareResourceType(type)) return c.json({ error: "Unknown share type" }, 404);
    const resource = resources[type];
    const actor = personOf(c, `read a ${resource.noun}'s share link`, false);
    if (actor instanceof Response) return actor;
    const id = c.req.param("id");
    if (!RESOURCE_ID.test(id) || !resource.exists(db, id, actor)) return c.json({ error: `Unknown ${resource.noun}` }, 404);
    return c.json({ share: shareStateOf(db, type, id, actor) });
  });

  app.put("/api/shares/:type/:id", (c) => {
    const type = c.req.param("type");
    if (!isShareResourceType(type)) return c.json({ error: "Unknown share type" }, 404);
    return toggle(c, type, c.req.param("id"));
  });

  // The Review tab's own toggle route, the same toggle.
  app.post("/api/reviews/:id/share", (c) => toggle(c, "review", c.req.param("id")));
}
