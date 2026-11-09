import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { loginMiddleware, ownerTokenProxyConfigure, ownerTokenWsProxyConfigure } from "../owner-proxy";
import { themeHtml } from "../theme-html";

// The console's dev server pointed at a scratch collector (see
// live-updates.repro.ts): the same proxies and sign-in route as vite.config.ts,
// on ports taken from the environment. The owner token comes from
// STANDUP_OWNER_TOKEN_FILE, the scratch install's own.
const api = process.env.SCRATCH_API_PORT;
const ws = process.env.SCRATCH_WS_PORT;
if (!api || !ws || !process.env.SCRATCH_WEB_PORT || !process.env.STANDUP_OWNER_TOKEN_FILE) {
  throw new Error("set SCRATCH_API_PORT, SCRATCH_WS_PORT, SCRATCH_WEB_PORT and STANDUP_OWNER_TOKEN_FILE");
}

export default defineConfig({
  root: new URL("..", import.meta.url).pathname,
  plugins: [react(), themeHtml(), { name: "scratch-login", configureServer: (s) => void s.middlewares.use(loginMiddleware()) }],
  server: {
    port: Number(process.env.SCRATCH_WEB_PORT),
    strictPort: true,
    proxy: {
      "/api": { target: `http://127.0.0.1:${api}`, changeOrigin: true, configure: ownerTokenProxyConfigure() },
      "/ws": { target: `ws://127.0.0.1:${ws}`, ws: true, changeOrigin: true, configure: ownerTokenWsProxyConfigure() },
    },
  },
});
