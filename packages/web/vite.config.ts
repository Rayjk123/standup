import type { Server as HttpServer } from "http";
import { resolve } from "path";
import { defineConfig, type Logger, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { consoleAllowedHosts, consoleBaseUrlFromEnv } from "@standup/shared/console-url";
import { ownerTokenPath, readOwnerToken } from "@standup/shared/owner-token";
import { GATEWAY_HOST, publicPorts, vitePortFromEnv } from "@standup/shared/topology";
import { loginMiddleware, loginUrl, ownerTokenProxyConfigure, ownerTokenWsProxyConfigure } from "./owner-proxy";
import { cacheHeaders } from "./static-assets";
import { collectorShareCheck, sharePageMiddleware } from "./share-page";
import { editorStaysOwn, manualChunks } from "./chunks";
import { themeHtml } from "./theme-html";

/*
 * Owner sign-in for the console: serves /__standup/login (see owner-proxy.ts)
 * and prints a fresh sign-in URL once the server is listening, from the dev
 * server and from the production preview server alike (see serve.ts). The
 * preview server also gets the build's cache headers (static-assets.ts).
 */
function ownerLogin(): Plugin {
  const announce = (httpServer: HttpServer | null | undefined, logger: Logger) =>
    httpServer?.once("listening", () => {
      const token = readOwnerToken(ownerTokenPath());
      // Behind the gateway the URL to open is the public web port, not vite's own.
      const address = httpServer.address();
      const port = behindGateway ? ports.web : typeof address === "object" && address ? address.port : vitePort;
      if (token) {
        logger.info(`\n  Owner sign-in (valid 10 min): ${loginUrl(token, `http://localhost:${port}`)}\n`);
      } else {
        logger.info("\n  Owner sign-in: no owner token file yet; once the collector is up run `bun run scripts/console-login.ts`\n");
      }
    });
  // A share page's status comes from the collector it proxies to (see share-page.ts).
  const sharePages = () => sharePageMiddleware(collectorShareCheck(`http://127.0.0.1:${ports.collector}`));
  return {
    name: "standup-owner-login",
    configureServer(server) {
      server.middlewares.use(loginMiddleware());
      server.middlewares.use(sharePages());
      announce(server.httpServer as HttpServer | null, server.config.logger);
    },
    configurePreviewServer(server) {
      const outDir = resolve(server.config.root, server.config.build.outDir);
      server.middlewares.use(cacheHeaders(() => outDir));
      server.middlewares.use(loginMiddleware());
      server.middlewares.use(sharePages());
      announce(server.httpServer as HttpServer, server.config.logger);
    },
  };
}

// In gateway mode dev.ts runs vite behind the gateway on STANDUP_VITE_PORT
// (by default vitePortFor the web port, 10000 above it and so outside the
// ports another vite hops through when 5173 is busy) and the gateway owns the
// public web port, so that port is strict: drifting to a free one would leave
// the gateway proxying to nothing. It also binds
// GATEWAY_HOST, the address the gateway dials: vite's default "localhost"
// resolves to ::1 on macOS. Classic mode serves the public web port
// (STANDUP_WEB_PORT, else 5173) with vite's default host and port-hopping.
const behindGateway = Boolean(process.env.STANDUP_VITE_PORT);
// The public ports (the gateway's in gateway mode): STANDUP_WEB_PORT,
// COLLECTOR_PORT and WS_PORT, so an instance started on other ports proxies to
// its own collector rather than whichever one holds the defaults.
const ports = publicPorts(process.env);
const vitePort = behindGateway ? vitePortFromEnv(process.env) : ports.web;
// Host headers answered besides localhost and IPs: STANDUP_WEB_URL's host and
// hosts under STANDUP_TUNNEL_DOMAIN (consoleAllowedHosts), so a tunnel to the web port isn't
// refused with "403 Blocked request". __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS
// still adds more.
const allowedHosts = consoleAllowedHosts(process.env);

export default defineConfig({
  plugins: [react(), ownerLogin(), themeHtml()],
  // The console's configured public URL (STANDUP_WEB_URL, else
  // STANDUP_CONSOLE_ORIGIN), which share links are built on; "" when unset,
  // and the page falls back to its own origin.
  define: { __STANDUP_WEB_URL__: JSON.stringify(consoleBaseUrlFromEnv(process.env) ?? "") },
  server: {
    port: vitePort,
    strictPort: behindGateway,
    ...(behindGateway ? { host: GATEWAY_HOST } : {}),
    allowedHosts,
    // The HMR client keeps dialing the page's own origin (the gateway on 5173,
    // or the tunnel), so no hmr.clientPort is set for the internal vite port.
    proxy: {
      // Targets use 127.0.0.1, not "localhost": the collector binds IPv4
      // (127.0.0.1 by default, 0.0.0.0 with STANDUP_BIND_HOST), but macOS
      // resolves "localhost" to IPv6 ::1 first, so a "localhost" target fails
      // with ECONNREFUSED ::1. Forcing IPv4 matches both bind modes.
      //
      // The console is an owner channel: each forwarded /api request carries
      // the owner secret only when the browser holds the owner session cookie, and
      // a user's channel token only when it holds that user's session cookie and
      // the tunnel identity matches (see owner-proxy.ts); the secret is read here
      // server-side.
      "/api": {
        target: `http://127.0.0.1:${ports.collector}`,
        changeOrigin: true,
        configure: ownerTokenProxyConfigure(),
      },
      // The collector's live WebSocket, proxied onto the same origin at /ws so a
      // single tunnelled port carries the web app, /api, and the socket. The
      // client derives ws(s)://<page-host>/ws (see resolveWsUrl); without this
      // hop the standalone WS port (7778) is unreachable through the tunnel and
      // a remote teammate gets no hello-ok identity frame or live updates. The
      // upgrade carries the same channel tokens an /api request would (owner
      // or user, same-origin only), which is what lets the collector send this
      // socket its viewer's Persona frames.
      "/ws": {
        target: `ws://127.0.0.1:${ports.ws}`,
        ws: true,
        changeOrigin: true,
        configure: ownerTokenWsProxyConfigure(),
      },
    },
  },
  // serve.ts serves the production build on the same port, host and proxies
  // (vite preview inherits server.proxy), so the gateway and a tunnel reach it
  // exactly as they reach the dev server.
  preview: {
    port: vitePort,
    strictPort: behindGateway,
    ...(behindGateway ? { host: GATEWAY_HOST } : {}),
    // No allowedHosts of its own: preview falls back to server.allowedHosts,
    // the list vite appends __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS to.
  },
  build: {
    rollupOptions: {
      // mermaid-frame.html is the page diagrams are drawn in (see src/lib/mermaid.ts).
      input: { index: resolve(__dirname, "index.html"), mermaidFrame: resolve(__dirname, "mermaid-frame.html") },
      output: { manualChunks },
      plugins: [editorStaysOwn()],
    },
  },
});
