import { Hono } from "hono";
import type { Context } from "hono";
import type { Database } from "bun:sqlite";
import { isValidSlug, redactSecrets, type KnowledgeDoc, type KnowledgeStore } from "@standup/knowledge";
import { getProjects, recordPublicKbCall } from "@standup/store";
import type { Drain } from "../drain.js";
import { readAccess } from "./access.js";
import {
  PUBLIC_KB_IDENTITY_HEADER_ENV,
  cachedGroupResolver,
  isAllowed,
  publicCallerAlias,
  publicIdentityHeader,
  type GroupResolver,
} from "./identity.js";
import { SUCCESS_LOGGED_PER_ALIAS, SUCCESS_LOGGED_TOTAL, WHOAMI_LOGGED_PER_ALIAS, refusedLogThrottle } from "./log-throttle.js";
import { publicRetrieval } from "./retrieval.js";
import {
  isPubliclyShareable,
  isPubliclyTrusted,
  shareableProjectIds,
  type ShareContext,
  type ShareableCandidate,
  type TrustCandidate,
} from "./scope.js";

/** Every public knowledge route lives under this prefix. */
export const PUBLIC_KNOWLEDGE_BASE = "/api/public/knowledge/v1";

/** The route a question is answered through: ranked hits over the served corpus. */
export const PUBLIC_SEARCH_PATH = `${PUBLIC_KNOWLEDGE_BASE}/search`;

const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 50;
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const WHOAMI_PATH = `${PUBLIC_KNOWLEDGE_BASE}/whoami`;

/**
 * What POST /ask answers: the API synthesizes no answers, so a caller is
 * pointed at the search route, whose hits it can open with /docs.
 */
export const PUBLIC_ASK_GONE = {
  error: "gone",
  message: `POST ${PUBLIC_KNOWLEDGE_BASE}/ask no longer answers questions. Search with GET ${PUBLIC_SEARCH_PATH}?q=<question>[&project=<id>] and open a hit with GET ${PUBLIC_KNOWLEDGE_BASE}/docs/<project>/<slug>.`,
  search: PUBLIC_SEARCH_PATH,
} as const;

/** What the public knowledge API reads from and answers with. */
export interface PublicKnowledgeDeps {
  db: Database;
  knowledgeStore: KnowledgeStore;
  /** Embeds a query for public retrieval's semantic arm; omitted, public retrieval is lexical only. */
  embedQuery?: (text: string) => Promise<number[] | null>;
  /** Reconciles the corpus with disk before a read; omitted, reads use the index as it stands. */
  sync?: () => Promise<void>;
  /** Resolves an alias's POSIX groups for a group allowlist; defaults to a cached `id -Gn`. */
  groupsOf?: GroupResolver;
  /** Refuses new requests once a shutdown begins. */
  drain?: Drain;
  /** The clock the call log's throttle windows read; defaults to Date.now. */
  now?: () => number;
  /**
   * The header the relay stamps with the caller's alias; defaults to
   * publicIdentityHeader() (STANDUP_PUBLIC_KB_IDENTITY_HEADER). Null: no
   * header is configured, and every request is refused with 503.
   */
  identityHeader?: string | null;
}

/** What every request gets while no caller header is configured. */
export const PUBLIC_KB_NOT_CONFIGURED = {
  error: "not configured",
  message: `the public knowledge API reads no caller header until ${PUBLIC_KB_IDENTITY_HEADER_ENV} names the one its relay stamps`,
} as const;

type Env = { Variables: { alias: string | null; logQuery: string | null } };

/** The public knowledge app. */
export type PublicKnowledgeApp = Hono<Env>;

const notFound = (c: Context) => c.json({ error: "not found" }, 404);

/**
 * Every text the API returns goes through the full redaction tier —
 * credential-shaped assignments and AWS account ids as well as provider
 * tokens — whatever tier the doc was written under, and whether or not it was
 * written through Standup at all (a hand-edited file is indexed as it is).
 */
const scrub = (text: string): string => redactSecrets(text, { tier: "full" });

/**
 * The public knowledge API: a Hono app separate from the collector's own, so
 * none of the collector's routes are reachable through it. It reads the caller
 * only from the relay's header (identityHeader) and admits only an
 * allowlisted alias; with no header configured it admits no one. Owner
 * tokens, Standup's own identity headers and cookies are never read. It serves only knowledge isPubliclyShareable and
 * isPubliclyTrusted admit (the served corpus), retrieved and scored over it
 * alone (publicRetrieval), every returned text run through the full redaction
 * tier, and logs every request to public_kb_calls, throttled per alias
 * (refusedLogThrottle): refusals, /whoami and other answers each capped.
 */
export function createPublicKnowledgeApp(deps: PublicKnowledgeDeps): PublicKnowledgeApp {
  const groupsOf = deps.groupsOf ?? cachedGroupResolver();
  const now = deps.now ?? Date.now;
  const identityHeader = deps.identityHeader === undefined ? publicIdentityHeader() : deps.identityHeader;
  const refusedLog = refusedLogThrottle();
  const whoamiLog = refusedLogThrottle({ perAlias: WHOAMI_LOGGED_PER_ALIAS });
  const answeredLog = refusedLogThrottle({ perAlias: SUCCESS_LOGGED_PER_ALIAS, total: SUCCESS_LOGGED_TOTAL });
  const app = new Hono<Env>();

  const shareContext = (): ShareContext => ({ shareableProjects: shareableProjectIds(getProjects(deps.db)) });
  /** Whether a public read may use a doc: shareable and trusted. */
  const served = (doc: ShareableCandidate & TrustCandidate, ctx: ShareContext) => isPubliclyShareable(doc, ctx) && isPubliclyTrusted(doc);

  const publicSearch = publicRetrieval({
    db: deps.db,
    knowledgeStore: deps.knowledgeStore,
    ...(deps.embedQuery ? { embedQuery: deps.embedQuery } : {}),
  });

  /** The `related` refs of a doc that name a doc this API serves; a bare slug is in the doc's own project. */
  const servedRelated = (doc: KnowledgeDoc, ctx: ShareContext): string[] =>
    (doc.related ?? []).filter((ref) => {
      const cut = ref.indexOf("/");
      const [project, slug] = cut > 0 ? [ref.slice(0, cut), ref.slice(cut + 1)] : [doc.projectId, ref];
      const target = isValidSlug(slug) ? deps.knowledgeStore.getDoc(project, slug) : null;
      return !!target && served(target, ctx);
    });

  const logCall = (alias: string | null, endpoint: string, query: string | null, status: number) => {
    try {
      recordPublicKbCall(deps.db, { alias, endpoint, query, status });
    } catch (err) {
      console.error("[public-kb] failed to log a call:", err);
    }
  };

  // Outermost, so every answer is logged — the drain's refusal, a 401, a 403, a 404.
  // Every answer is throttled per alias: refusals, /whoami and the other 2xx answers each under their own cap.
  app.use("*", async (c, next) => {
    c.set("alias", null);
    c.set("logQuery", null);
    try {
      await next();
    } finally {
      const at = now();
      for (const [throttle, what] of [
        [refusedLog, "refused"],
        [whoamiLog, "whoami"],
        [answeredLog, "answered"],
      ] as const) {
        for (const collapsed of throttle.closed(at)) {
          logCall(collapsed.alias, `${what} calls (collapsed)`, `${collapsed.count} more ${what} calls since ${collapsed.since}`, collapsed.status);
        }
      }
      const status = c.res.status;
      const refused = status < 200 || status >= 300;
      const throttle = refused ? refusedLog : c.req.path === WHOAMI_PATH ? whoamiLog : answeredLog;
      if (throttle.admit(c.get("alias"), status, at)) {
        logCall(c.get("alias"), `${c.req.method} ${c.req.path}`, c.get("logQuery"), status);
      }
    }
  });
  if (deps.drain) app.use("*", deps.drain.middleware());
  app.use("*", async (c, next) => {
    if (!identityHeader) return c.json(PUBLIC_KB_NOT_CONFIGURED, 503);
    const alias = publicCallerAlias(c.req.header(identityHeader));
    if (!alias) return c.json({ error: "unauthenticated" }, 401);
    c.set("alias", alias);
    if (!(await isAllowed(alias, readAccess(deps.db), groupsOf))) return c.json({ error: "forbidden" }, 403);
    await next();
  });

  app.notFound(notFound);
  app.onError((err, c) => {
    console.error("[public-kb] request failed:", err);
    return c.json({ error: "internal error" }, 500);
  });

  /** The shareable project a request names, or undefined when it names none; null when it names one that isn't. */
  const namedProject = (raw: string | undefined, ctx: ShareContext): string | undefined | null => {
    const project = raw?.trim();
    if (!project) return undefined;
    return PROJECT_ID_PATTERN.test(project) && ctx.shareableProjects.has(project) ? project : null;
  };

  app.get(WHOAMI_PATH, (c) => c.json({ alias: c.get("alias") }));

  app.get(PUBLIC_SEARCH_PATH, async (c) => {
    const q = c.req.query("q")?.trim() ?? "";
    c.set("logQuery", q || null);
    if (!q) return c.json({ error: "q is required" }, 400);
    const ctx = shareContext();
    const project = namedProject(c.req.query("project"), ctx);
    if (project === null) return notFound(c);
    const requested = Number.parseInt(c.req.query("limit") ?? "", 10);
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_SEARCH_LIMIT) : DEFAULT_SEARCH_LIMIT;
    await deps.sync?.();
    const hits = await publicSearch({
      query: q,
      served: (d) => served(d, ctx),
      ...(project ? { onlyProject: project } : {}),
      limit,
      redact: scrub,
    });
    return c.json({
      hits: hits.map((h) => ({
        slug: h.slug,
        project: h.projectId,
        title: scrub(h.title),
        excerpt: scrub(h.excerpt),
        score: h.score,
        ...(h.verdict === "contradicted" ? { verdict: h.verdict } : {}),
      })),
    });
  });

  app.get(`${PUBLIC_KNOWLEDGE_BASE}/projects`, async (c) => {
    await deps.sync?.();
    const ctx = shareContext();
    const projects = getProjects(deps.db).filter((p) => ctx.shareableProjects.has(p.id));
    return c.json({
      projects: projects.map((p) => ({
        id: p.id,
        name: scrub(p.name),
        docCount: deps.knowledgeStore.getDocsByProject(p.id).filter((d) => served(d, ctx)).length,
      })),
    });
  });

  app.get(`${PUBLIC_KNOWLEDGE_BASE}/projects/:project/docs`, async (c) => {
    const ctx = shareContext();
    const project = namedProject(c.req.param("project"), ctx);
    c.set("logQuery", c.req.param("project"));
    if (!project) return notFound(c);
    await deps.sync?.();
    return c.json({
      docs: deps.knowledgeStore
        .getDocsByProject(project)
        .filter((d) => served(d, ctx))
        .map((d) => ({ slug: d.slug, title: scrub(d.title), kind: d.sourceKind ?? "unclassified", updatedAt: d.updatedAt.toISOString() })),
    });
  });

  app.get(`${PUBLIC_KNOWLEDGE_BASE}/docs/:project/:slug`, async (c) => {
    const slug = c.req.param("slug");
    c.set("logQuery", `${c.req.param("project")}/${slug}`);
    const ctx = shareContext();
    const project = namedProject(c.req.param("project"), ctx);
    if (!project || !isValidSlug(slug)) return notFound(c);
    await deps.sync?.();
    const doc = deps.knowledgeStore.getDoc(project, slug);
    // A withheld doc answers exactly as a missing one, so its existence isn't disclosed.
    if (!doc || !served(doc, ctx)) return notFound(c);
    // Of the doc's fields, only `related` names other docs (its disputes are not
    // served), so it alone is filtered to docs this API serves.
    const related = servedRelated(doc, ctx);
    return c.json({
      slug: doc.slug,
      project: doc.projectId,
      title: scrub(doc.title),
      body: scrub(doc.body),
      kind: doc.sourceKind ?? "unclassified",
      scope: doc.scope ?? "project",
      tags: (doc.tags ?? []).map(scrub),
      updatedAt: doc.updatedAt.toISOString(),
      ...(doc.originClass ? { originClass: doc.originClass } : {}),
      ...(doc.confidence !== undefined ? { confidence: doc.confidence } : {}),
      ...(doc.lastVerifiedAt ? { lastVerifiedAt: doc.lastVerifiedAt } : {}),
      ...(doc.verdict ? { verdict: doc.verdict } : {}),
      ...(related.length > 0 ? { related } : {}),
    });
  });

  // The question-answering route is retired: it answers 410 with a pointer to
  // the search route, after the same identity check every route runs.
  app.post(`${PUBLIC_KNOWLEDGE_BASE}/ask`, (c) => c.json(PUBLIC_ASK_GONE, 410));

  return app;
}
