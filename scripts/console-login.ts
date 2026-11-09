#!/usr/bin/env bun
/**
 * Sign a browser in to the web console.
 *
 *   bun run scripts/console-login.ts                 # the owner (host)
 *   bun run scripts/console-login.ts --user <alias>  # another user, to direct their own Persona
 *
 * Reads the owner secret the collector wrote (STANDUP_OWNER_TOKEN_FILE, else
 * <dataDir>/secrets/owner.token) and prints a console URL carrying a 10-minute
 * login code. Opening it makes the dev server set a session cookie: the owner's
 * makes requests from that browser go to the collector with the owner token; a
 * user's makes them carry that user's channel token, and only while the tunnel
 * identity is the same alias. The host runs `--user` and sends the printed link
 * to the teammate. The URL is built on the console's configured public URL,
 * STANDUP_WEB_URL, else STANDUP_CONSOLE_ORIGIN, else http://localhost:5173
 * (consoleOriginFromEnv, resolved as the collector's links are). The session cookie is set
 * per origin, so sign in through the origin you will browse on.
 */

import { consoleOriginFromEnv } from "../packages/shared/src/console-url";
import { ownerTokenPath, readOwnerToken } from "../packages/shared/src/owner-token";
import { loginUrl, parseConsoleLoginArgs, userLoginUrl } from "../packages/web/owner-proxy";

/** What a run prints: an exit code, its stdout lines and its stderr lines. */
export interface ConsoleLoginResult {
  code: number;
  out: string[];
  err: string[];
}

/** The script's work for `argv` (the arguments after the script) under `env`, without printing. */
export function consoleLogin(argv: string[], env: NodeJS.ProcessEnv): ConsoleLoginResult {
  // Arguments are checked before the owner secret is read.
  const args = parseConsoleLoginArgs(argv);
  if ("error" in args) return { code: 2, out: [], err: [`[console-login] ${args.error}.`] };
  const user = args.user;

  const path = ownerTokenPath(env);
  const token = readOwnerToken(path);
  if (!token) {
    return { code: 1, out: [], err: [`[console-login] no owner token at ${path}: start the collector first (it creates the file).`] };
  }

  const origin = consoleOriginFromEnv(env);
  if (user !== undefined) {
    return {
      code: 0,
      out: [
        `[console-login] send this URL to ${user}; opening it within 10 minutes, through the tunnel as ${user}, signs them in to direct their Persona:`,
        `  ${userLoginUrl(token, user, origin)}`,
      ],
      err: [],
    };
  }
  return {
    code: 0,
    out: ["[console-login] open this URL in your browser within 10 minutes to sign in as the owner:", `  ${loginUrl(token, origin)}`],
    err: [],
  };
}

if (import.meta.main) {
  const result = consoleLogin(process.argv.slice(2), process.env);
  for (const line of result.err) console.error(line);
  for (const line of result.out) console.log(line);
  if (result.code !== 0) process.exit(result.code);
}
