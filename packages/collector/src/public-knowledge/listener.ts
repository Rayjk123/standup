import { chmodSync, existsSync, lstatSync, mkdirSync, statSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import type { Server } from "bun";
import { publicIdentityHeaderProblem } from "./identity.js";

/** Largest request body the listener reads; no route takes a body anywhere near it. */
export const PUBLIC_KB_MAX_BODY_BYTES = 16 * 1024;

/** How long the stale-socket probe waits for a connection before calling the socket dead. */
const PROBE_TIMEOUT_MS = 1_000;

/** Whether the public knowledge listener is switched on (STANDUP_PUBLIC_KB=1). */
export function publicKnowledgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.STANDUP_PUBLIC_KB === "1";
}

/** Where the listener's socket is: STANDUP_PUBLIC_KB_SOCKET, else `<dataDir>/public/kb.sock`. */
export function publicKnowledgeSocketPath(dataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.STANDUP_PUBLIC_KB_SOCKET?.trim() || join(dataDir, "public", "kb.sock");
}

/**
 * Whether the public knowledge API is being served, as the owner's console
 * reports it: `enabled` only while the listener is bound; `socketPath` once a
 * start was attempted; `error` why the start failed.
 */
export interface PublicKnowledgeListenerStatus {
  enabled: boolean;
  socketPath?: string;
  error?: string;
}

/** Why `dir` can't hold the socket, or null when it is a directory this process owns that no one else may enter. */
export function socketDirRefusal(dir: string): string | null {
  let st;
  try {
    st = statSync(dir);
  } catch (err) {
    return `${dir} is not readable: ${String(err)}`;
  }
  if (!st.isDirectory()) return `${dir} is not a directory`;
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) return `${dir} is not owned by this user`;
  if ((st.mode & 0o077) !== 0) return `${dir} is accessible to group or others (mode ${(st.mode & 0o777).toString(8)}); it must be 0700`;
  return null;
}

/** Whether something accepts a connection on the Unix socket at `path` within PROBE_TIMEOUT_MS. */
export async function socketAnswers(path: string, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const connect = Bun.connect({ unix: path, socket: { data() {} } }).then(
    (socket) => {
      socket.end();
      return true;
    },
    () => false
  );
  try {
    return await Promise.race([connect, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Serves `fetch` on a Unix socket at `socketPath`, readable and writable by
 * this user alone, with request bodies capped at PUBLIC_KB_MAX_BODY_BYTES. It
 * resolves to the server and its status, or to no server and a status naming
 * why (also logged): STANDUP_PUBLIC_KB_IDENTITY_HEADER names no header (so
 * no caller could be read), the socket's directory is not private to this user,
 * something other than a socket is at the path, another process already
 * answers on the socket, or binding failed. The default directory
 * (`<dataDir>/public`) is created 0700 and tightened if it exists; a directory
 * STANDUP_PUBLIC_KB_SOCKET names is checked, never changed. A socket file no
 * process answers on is removed first; one a live process answers on is left
 * alone, so a second collector never takes over or deletes the first's
 * socket. If setup fails after binding, the server is stopped.
 */
export async function startPublicKnowledgeListener(opts: {
  socketPath: string;
  /** True when the socket path is the default under the data dir, whose directory this may create and tighten. */
  managedDir: boolean;
  fetch: (request: Request) => Response | Promise<Response>;
  /** Where STANDUP_PUBLIC_KB_IDENTITY_HEADER is read from; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}): Promise<{ server: Server<undefined> | null; status: PublicKnowledgeListenerStatus }> {
  const { socketPath } = opts;
  const refuse = (error: string) => {
    console.error(`[public-kb] Not listening: ${error}`);
    return { server: null, status: { enabled: false, socketPath, error } };
  };
  const headerProblem = publicIdentityHeaderProblem(opts.env ?? process.env);
  if (headerProblem) return refuse(headerProblem);
  const dir = dirname(socketPath);
  try {
    if (opts.managedDir) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
    }
  } catch (err) {
    return refuse(`could not prepare ${dir}: ${(err as Error).message}`);
  }
  const refusal = socketDirRefusal(dir);
  if (refusal) return refuse(refusal);
  if (existsSync(socketPath)) {
    if (!lstatSync(socketPath).isSocket()) return refuse(`${socketPath} exists and is not a socket`);
    if (await socketAnswers(socketPath)) return refuse(`another process is already listening on ${socketPath}`);
    try {
      unlinkSync(socketPath);
    } catch (err) {
      return refuse(`could not remove the stale socket ${socketPath}: ${(err as Error).message}`);
    }
  }
  let server: Server<undefined> | null = null;
  try {
    server = Bun.serve({ unix: socketPath, fetch: opts.fetch, maxRequestBodySize: PUBLIC_KB_MAX_BODY_BYTES });
    chmodSync(socketPath, 0o600);
  } catch (err) {
    if (server) {
      server.stop(true);
      try {
        unlinkSync(socketPath);
      } catch {
        // Already gone.
      }
    }
    return refuse(`could not listen on ${socketPath}: ${(err as Error).message}`);
  }
  return { server, status: { enabled: true, socketPath } };
}
