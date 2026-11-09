import type { Plugin } from "vite";
import { THEME_TOKENS_STYLE_ID, themeTokensCss } from "./src/components/theme";
import { THEME_BOOT_SCRIPT } from "./src/lib/themePreference";

/**
 * Writes the theme into the console's index.html <head>: the token variables
 * of both palettes and the script that picks one from the stored preference,
 * both inline so the first paint is already in the right palette. Other pages
 * (mermaid-frame.html) are left alone.
 */
export function themeHtml(): Plugin {
  return {
    name: "standup-theme-html",
    transformIndexHtml: {
      order: "pre",
      handler(_html, ctx) {
        if (!ctx.filename.endsWith("index.html")) return;
        // Appended to <head> rather than prepended, so <meta charset> stays
        // within the first 1024 bytes where the browser looks for it.
        return [
          { tag: "style", attrs: { id: THEME_TOKENS_STYLE_ID }, children: themeTokensCss(), injectTo: "head" },
          { tag: "script", children: THEME_BOOT_SCRIPT, injectTo: "head" },
        ];
      },
    },
  };
}
