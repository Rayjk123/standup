import { mkdirSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createLaunch, createStore, setLaunchReviewTokenHash, upsertProject } from "@standup/store";
import type { DocLimits } from "@standup/store";
import type { WsMessage } from "@standup/shared";
import { DEFAULT_IDENTITY_HEADER, WORKER_TOKEN_HEADER } from "@standup/shared";
import { OWNER_TOKEN_HEADER, USER_CHANNEL_HEADER, userChannelToken } from "@standup/shared/owner-token";
import { workerTokenHash } from "../floor/gate.js";
import { generateOwnerSecrets } from "../owner-secret.js";
import { resolvePersonaConfig } from "../persona/config.js";
import { PersonaFleet } from "../persona/fleet.js";
import { PERSONA_TOKEN_HEADER } from "../persona/routes.js";
import { PersonaRuntime } from "../persona/runtime.js";
import { createServer, resolveUserAlias } from "../server.js";
import type { DocAnswerer } from "./answer.js";
import type { DocCommentAgent } from "./comments.js";

/**
 * A collector with the docs routes for tests: an in-memory store, a data dir
 * and home under a fresh temp dir, the host owner's Persona, and every frame
 * broadcast captured, with optional per-owner doc limits. Credentials for
 * each kind of caller are built here.
 */

export const IDENTITY = DEFAULT_IDENTITY_HEADER;
/** The host owner: the alias the owner channel speaks for. */
export const HOST = resolveUserAlias(undefined);

export function docsHarness(
  opts: { docLimits?: Partial<DocLimits>; consoleUrl?: string; embeddingProvider?: string; docAnswerer?: DocAnswerer } = {}
) {
  const root = mkdtempSync(join(tmpdir(), "docs-routes-"));
  const dataDir = join(root, "data");
  const home = join(root, "home");
  for (const d of [dataDir, home]) mkdirSync(d, { recursive: true });
  const store = createStore(":memory:");
  const frames: WsMessage[] = [];
  const broadcast = (m: WsMessage) => {
    frames.push(m);
  };
  const secrets = generateOwnerSecrets();
  const runtime = new PersonaRuntime({
    db: store.db,
    owner: HOST,
    config: resolvePersonaConfig({}),
    broadcast,
    dataDir,
    turnRunner: async () => ({ ok: true, text: "[silent]", sessionId: "sid" }),
    ownerToken: () => secrets.ownerToken,
    ...(opts.consoleUrl ? { consoleUrl: opts.consoleUrl } : {}),
  });
  const fleet = new PersonaFleet({ db: store.db, host: HOST, hostRuntime: runtime });
  let commentAgent: DocCommentAgent | null = null;
  const app = createServer(
    store, broadcast, opts.embeddingProvider ?? null, undefined, undefined, "", "", {}, undefined, undefined, undefined, undefined,
    { fleet, ownerSecrets: secrets },
    {},
    {},
    {},
    {
      dataDir,
      mediaHome: home,
      mediaEnv: {},
      docLimits: opts.docLimits,
      // No test reaches a real model: without an answerer of its own, the doc agent makes no reply.
      docAnswerer: opts.docAnswerer ?? (async () => null),
      onDocCommentAgent: (agent) => {
        commentAgent = agent;
      },
    }
  );
  upsertProject(store.db, { id: "p", name: "P", branch: "main", repos: [] });

  /** A person through their user channel. */
  const as = (alias: string): Record<string, string> => ({
    [IDENTITY]: alias,
    [USER_CHANNEL_HEADER]: userChannelToken(secrets.ownerToken, alias),
  });
  /** The host owner through the owner channel. */
  const owner = (): Record<string, string> => ({ [IDENTITY]: HOST, [OWNER_TOKEN_HEADER]: secrets.ownerToken });
  const persona = (): Record<string, string> => ({ [PERSONA_TOKEN_HEADER]: runtime.token });

  let n = 0;
  /** A running launch of `launchedBy`'s and its worker token header. */
  const worker = (launchedBy: string): Record<string, string> => {
    n++;
    const token = `doc-worker-${n}-${"x".repeat(40)}`;
    createLaunch(store.db, { id: `L${n}`, projectId: "p", task: "t", worktreePath: root, branch: "b", status: "running", launchedBy });
    setLaunchReviewTokenHash(store.db, `L${n}`, workerTokenHash(token));
    return { [WORKER_TOKEN_HEADER]: token };
  };

  /** A JSON request with `headers`. */
  const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
    app.request(path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  /** The JSON of a request that must succeed. */
  const ok = async <T>(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<T> => {
    const res = await call(method, path, headers, body);
    if (res.status !== 200) throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  };

  /** Resolves once the doc agent has no reply queued or being written. */
  const agentIdle = () => commentAgent!.idle();

  return { root, dataDir, home, store, app, frames, secrets, runtime, as, owner, persona, worker, call, ok, agentIdle };
}

/** A PNG header followed by `n` bytes of `fill`. */
export function png(n = 84, fill = 1): Uint8Array {
  const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52];
  return Uint8Array.from([...head, ...Array.from({ length: n }, () => fill)]);
}
