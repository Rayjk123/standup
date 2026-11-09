import { createRequire } from "module";
import { join, resolve } from "path";
import { fileURLToPath } from "url";

/*
 * Vite config for the fixture-driven screenshot scripts in this directory.
 * Root is packages/web. The scripts use it for a one-off `vite build` whose
 * output they serve themselves, so a run sees the source as it was when the
 * build started. It has no /api or /ws proxy and no owner sign-in, so a page
 * built from it can never reach the collector or read the owner token; every
 * API response comes from the script's page.route fixtures. When served with
 * `vite` directly, hot reload and file watching are off for the same reason.
 *
 * Vite and the React plugin are installed in packages/web, not at the repo
 * root, so the plugin is resolved from there and the config is a plain
 * function rather than a `defineConfig` call.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const WEB_DIR = resolve(HERE, "..", "..", "packages", "web");

export default async () => {
  const pluginPath = createRequire(join(WEB_DIR, "package.json")).resolve("@vitejs/plugin-react");
  const react = ((await import(pluginPath)) as { default: () => unknown }).default;
  const { themeHtml } = (await import(join(WEB_DIR, "theme-html.ts"))) as { themeHtml: () => unknown };
  return {
    root: WEB_DIR,
    plugins: [react(), themeHtml()],
    clearScreen: false,
    server: { proxy: {}, hmr: false, watch: null },
    build: {
      emptyOutDir: true,
      reportCompressedSize: false,
      chunkSizeWarningLimit: 10_000,
      // mermaid-frame.html is the page docs draw diagrams in (src/lib/mermaid.ts).
      rollupOptions: { input: { index: join(WEB_DIR, "index.html"), mermaidFrame: join(WEB_DIR, "mermaid-frame.html") } },
    },
  };
};
