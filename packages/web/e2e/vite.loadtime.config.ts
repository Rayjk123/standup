import { resolve } from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { loginMiddleware, ownerTokenProxyConfigure, ownerTokenWsProxyConfigure } from "../owner-proxy";
import { cacheHeaders } from "../static-assets";
import { manualChunks } from "../chunks";
import { themeHtml } from "../theme-html";

// The console pointed at a scratch collector for load-time.measure.ts and
// serve-auth.probe.ts, bound to 127.0.0.1 only: the
// same proxies, sign-in route, chunking and cache headers as vite.config.ts,
// for the dev server and the production preview server alike, on ports taken
// from the environment. The owner token comes from STANDUP_OWNER_TOKEN_FILE,
// the scratch install's own.
const api = process.env.SCRATCH_API_PORT;
const ws = process.env.SCRATCH_WS_PORT;
const web = Number(process.env.SCRATCH_WEB_PORT);
if (!api || !ws || !web || !process.env.STANDUP_OWNER_TOKEN_FILE) {
  throw new Error("set SCRATCH_API_PORT, SCRATCH_WS_PORT, SCRATCH_WEB_PORT and STANDUP_OWNER_TOKEN_FILE");
}

export default defineConfig({
  root: new URL("..", import.meta.url).pathname,
  plugins: [
    react(),
    themeHtml(),
    {
      name: "scratch-login",
      configureServer: (s) => void s.middlewares.use(loginMiddleware()),
      configurePreviewServer(s) {
        const outDir = resolve(s.config.root, s.config.build.outDir);
        s.middlewares.use(cacheHeaders(() => outDir));
        s.middlewares.use(loginMiddleware());
      },
    },
  ],
  server: {
    port: web,
    strictPort: true,
    host: "127.0.0.1",
    proxy: {
      "/api": { target: `http://127.0.0.1:${api}`, changeOrigin: true, configure: ownerTokenProxyConfigure() },
      "/ws": { target: `ws://127.0.0.1:${ws}`, ws: true, changeOrigin: true, configure: ownerTokenWsProxyConfigure() },
    },
  },
  preview: { port: web, strictPort: true, host: "127.0.0.1" },
  build: { rollupOptions: { output: { manualChunks } } },
});
