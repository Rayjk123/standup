import type { Context, Hono } from "hono";
import { tokenMatches } from "@standup/shared/write-token";
import { PERSONA_TOKEN_HEADER, isAllowedHost, isCrossSiteWrite, requestHost } from "../persona/routes.js";
import type { PersonaRuntime } from "../persona/runtime.js";
import type { RestartService } from "./service.js";

export interface RestartRoutesOptions {
  /** The operator Persona serves. */
  owner: string;
  /** Undefined when Persona is disabled; then no caller can restart. */
  runtime?: PersonaRuntime;
  /** Undefined when the collector was started without one (tests, embedded uses). */
  service?: RestartService;
  /**
   * The server's owner check (its ownerRefusal): a 403 unless the request
   * carries the owner secret (OWNER_TOKEN_HEADER) and comes from the owner;
   * null when the owner may proceed.
   */
  ownerRefusal(c: Context): Response | null;
}

const MAX_REASON_CHARS = 2_000;
const MAX_ID_CHARS = 200;

/** The header a redeploy presents the local write token in. */
export const WRITE_TOKEN_HEADER = "x-standup-write-token";

/**
 * `POST /api/standup/restart` restarts this collector (see restart/service.ts).
 * Persona asks with its per-boot token, which workers never get. The
 * post-merge redeploy (scripts/standup-redeploy.ts) asks with
 * `{source: "redeploy"}` and the per-user local write token in
 * x-standup-write-token, which only the owner's own OS user can read; it
 * gets no thread, a rate-limit exemption, a no-op when nothing changed, and
 * coalescing while a restart is under way (RestartService.redeploy). Either
 * way the Host must be a loopback (or allowed) name and the body JSON. The
 * owner asks Persona, or reads progress with `GET /api/standup/restart`,
 * which takes Persona's token or the owner secret with the owner's identity
 * — never an identity alone, which a worker on the owner's machine shares.
 */
export function mountRestartRoutes(app: Hono, opts: RestartRoutesOptions): void {
  const personaRefusal = (c: Context): Response | null => {
    if (!isAllowedHost(requestHost(c))) return c.json({ error: "refused: this Host is not a loopback name" }, 403);
    if (!opts.runtime) return c.json({ error: "Persona is disabled (STANDUP_PERSONA=0), and only Persona can restart Standup" }, 503);
    if (!tokenMatches(c.req.header(PERSONA_TOKEN_HEADER), opts.runtime.token)) {
      return c.json({ error: "only Persona can restart Standup (invalid or missing persona token)" }, 401);
    }
    return null;
  };

  const redeploy = async (c: Context): Promise<Response> => {
    if (!isAllowedHost(requestHost(c))) return c.json({ error: "refused: this Host is not a loopback name" }, 403);
    if (!opts.service) return c.json({ error: "restarts are not available in this collector" }, 503);
    const expected = opts.service.writeToken;
    if (!expected) return c.json({ error: "redeploys are not enabled in this collector (it has no local write token)" }, 403);
    if (!tokenMatches(c.req.header(WRITE_TOKEN_HEADER), expected)) {
      return c.json({ error: "a redeploy needs the local write token (invalid or missing x-standup-write-token)" }, 401);
    }
    const forged = isCrossSiteWrite(c);
    if (forged) return c.json({ error: `refused: ${forged}` }, 403);
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    if (body.source !== "redeploy") return c.json({ error: 'the local write token only asks for redeploys ({"source": "redeploy"})' }, 400);
    const given = typeof body.reason === "string" ? body.reason.trim().slice(0, MAX_REASON_CHARS) : "";
    const result = await opts.service.redeploy({ reason: given || "redeploy" });
    if ("error" in result) return c.json({ error: result.error }, result.status);
    if ("noop" in result) return c.json({ status: "noop", head: result.head }, 200);
    if ("coalesced" in result) return c.json({ status: "coalesced", ...(result.id ? { id: result.id } : {}) }, 202);
    return c.json(
      {
        status: "duplicate" in result ? "duplicate" : "scheduled",
        id: result.id,
        phase: result.record.phase,
        mode: result.record.mode,
        ...(result.record.warnings?.length ? { warnings: result.record.warnings } : {}),
      },
      result.status
    );
  };

  app.post("/api/standup/restart", async (c) => {
    // The write token marks a redeploy; Persona's token never rides with it.
    if (c.req.header(WRITE_TOKEN_HEADER) !== undefined && c.req.header(PERSONA_TOKEN_HEADER) === undefined) return redeploy(c);
    const refused = personaRefusal(c);
    if (refused) return refused;
    const forged = isCrossSiteWrite(c);
    if (forged) return c.json({ error: `refused: ${forged}` }, 403);
    if (!opts.service) return c.json({ error: "restarts are not available in this collector" }, 503);
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason) return c.json({ error: "reason is required" }, 400);
    const optional = (key: string, max: number): string | undefined | null => {
      const v = body[key];
      if (v === undefined || v === null || v === "") return undefined;
      return typeof v === "string" && v.length <= max ? v.trim() || undefined : null;
    };
    const uiUrl = optional("uiUrl", 2_000);
    const threadId = optional("threadId", MAX_ID_CHARS);
    const batchKey = optional("batchKey", MAX_ID_CHARS);
    if (uiUrl === null || threadId === null || batchKey === null) {
      return c.json({ error: "uiUrl, threadId and batchKey must be short strings" }, 400);
    }
    if (uiUrl && !/^https?:\/\//i.test(uiUrl)) return c.json({ error: "uiUrl must be an http(s) URL" }, 400);
    const result = await opts.service.request({
      reason: reason.slice(0, MAX_REASON_CHARS),
      requestedBy: `persona (${opts.owner})`,
      uiUrl,
      threadId,
      batchKey,
    });
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(
      {
        id: result.id,
        phase: result.record.phase,
        mode: result.record.mode,
        ...("duplicate" in result ? { duplicate: true } : {}),
        ...(result.record.warnings?.length ? { warnings: result.record.warnings } : {}),
      },
      result.status
    );
  });

  app.get("/api/standup/restart", (c) => {
    if (!isAllowedHost(requestHost(c))) return c.json({ error: "refused: this Host is not a loopback name" }, 403);
    const presented = c.req.header(PERSONA_TOKEN_HEADER);
    if (presented) {
      if (!opts.runtime || !tokenMatches(presented, opts.runtime.token)) return c.json({ error: "invalid persona token" }, 401);
    } else {
      const refused = opts.ownerRefusal(c);
      if (refused) return refused;
    }
    return c.json({ restart: opts.service?.current() ?? null });
  });
}
