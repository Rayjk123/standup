import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { themeHtml } from "./theme-html";

/*
 * Dev-server config for fixture-driven screenshot scripts. It has no /api or
 * /ws proxy and no owner sign-in, so a page served from it can never reach the
 * collector or read the owner token; every API response comes from the
 * script's own page.route fixtures.
 */
export default defineConfig({
  plugins: [react(), themeHtml()],
  server: { proxy: {} },
});
