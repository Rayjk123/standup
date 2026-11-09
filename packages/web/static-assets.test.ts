import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import type { IncomingMessage, ServerResponse } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { cacheControlFor, cacheHeaders, IMMUTABLE, REVALIDATE } from "./static-assets";
import { editorStaysOwn, manualChunks, packageOf } from "./chunks";
import { ASSET_GRACE_MS, indexHtmlLast, liveAssets, pruneAssets } from "./serve";

const dir = mkdtempSync(join(tmpdir(), "standup-static-assets-"));
mkdirSync(join(dir, "assets"));
writeFileSync(join(dir, "assets", "index-AbC123.js"), "export {}");
mkdirSync(join(dir, "assets", "nested"));
writeFileSync(join(dir, "index.html"), "<html></html>");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Sent {
  headers: Record<string, string>;
  status: number;
  ended: boolean;
  nexted: boolean;
}
function run(method: string, url: string): Sent {
  const sent: Sent = { headers: {}, status: 200, ended: false, nexted: false };
  const res = {
    setHeader: (k: string, v: string) => void (sent.headers[k.toLowerCase()] = v),
    set statusCode(code: number) {
      sent.status = code;
    },
    end: () => void (sent.ended = true),
  } as unknown as ServerResponse;
  cacheHeaders(() => dir)({ method, url } as IncomingMessage, res, () => void (sent.nexted = true));
  return sent;
}

describe("cacheControlFor", () => {
  test("an existing hashed asset is immutable; anything else revalidates", () => {
    expect(cacheControlFor("/assets/index-AbC123.js", dir)).toBe(IMMUTABLE);
    expect(cacheControlFor("/assets/missing-1.js", dir)).toBe(REVALIDATE);
    expect(cacheControlFor("/assets/nested", dir)).toBe(REVALIDATE);
    expect(cacheControlFor("/", dir)).toBe(REVALIDATE);
    expect(cacheControlFor("/index.html", dir)).toBe(REVALIDATE);
    expect(cacheControlFor("/work/s/abc", dir)).toBe(REVALIDATE);
  });

  test("a path that leaves assets/ is never immutable", () => {
    for (const p of ["/assets/../index.html", "/assets/%2e%2e/index.html", "/assets/nested/x.js", "/assets/.hidden", "/assets/%E0%A4%A"]) {
      expect(cacheControlFor(p, dir)).toBe(REVALIDATE);
    }
  });
});

describe("cacheHeaders", () => {
  test("sets the header and hands on the build's files", () => {
    const asset = run("GET", "/assets/index-AbC123.js?v=1");
    expect(asset).toMatchObject({ nexted: true, ended: false });
    expect(asset.headers["cache-control"]).toBe(IMMUTABLE);
    expect(asset.headers.vary).toBe("Accept-Encoding");
    const page = run("GET", "/persona");
    expect(page).toMatchObject({ nexted: true, headers: { "cache-control": REVALIDATE } });
    expect(run("HEAD", "/").headers["cache-control"]).toBe(REVALIDATE);
  });

  test("a missing asset is a 404, not the SPA's index.html", () => {
    const missing = run("GET", "/assets/gone-Zz9.js");
    expect(missing).toMatchObject({ status: 404, ended: true, nexted: false });
    expect(missing.headers["cache-control"]).toBe(REVALIDATE);
  });

  test("proxied and server-owned paths and writes keep their own caching", () => {
    for (const url of ["/api/projects", "/ws", "/__standup/login?code=x"]) {
      const sent = run("GET", url);
      expect(sent.nexted).toBe(true);
      expect(sent.headers["cache-control"]).toBeUndefined();
    }
    expect(run("POST", "/assets/index-AbC123.js").headers["cache-control"]).toBeUndefined();
  });
});

describe("manualChunks", () => {
  test("names a package from its last node_modules segment, scoped or not", () => {
    expect(packageOf("/r/node_modules/.bun/react-dom@18/node_modules/react-dom/client.js")).toBe("react-dom");
    expect(packageOf("/r/node_modules/@scope/pkg/index.js")).toBe("@scope/pkg");
    expect(packageOf("/r/packages/web/src/App.tsx")).toBeUndefined();
  });

  test("groups React, the markdown stack and the graph; leaves app code and the rest alone", () => {
    const nm = (pkg: string) => `/r/node_modules/.bun/${pkg}@1/node_modules/${pkg}/index.js`;
    expect(manualChunks(nm("react"))).toBe("react");
    expect(manualChunks(nm("react-router-dom"))).toBe("react");
    expect(manualChunks(nm("react-markdown"))).toBe("markdown");
    expect(manualChunks(nm("micromark-core-commonmark"))).toBe("markdown");
    expect(manualChunks(nm("remark-gfm"))).toBe("markdown");
    expect(manualChunks(nm("sigma"))).toBe("graph");
    expect(manualChunks(nm("graphology-layout-forceatlas2"))).toBe("graph");
    expect(manualChunks(nm("react-icons"))).toBeUndefined();
    expect(manualChunks("/r/packages/web/src/components/PersonaView.tsx")).toBeUndefined();
  });

  test("Mermaid and what only it uses stay out of the named chunks, so they load only with a diagram", () => {
    const nm = (pkg: string) => `/r/node_modules/.bun/${pkg}@1/node_modules/${pkg}/index.js`;
    for (const pkg of ["mermaid", "@mermaid-js/parser", "katex", "cytoscape", "dagre-d3-es", "d3", "khroma"]) {
      expect(manualChunks(nm(pkg))).toBeUndefined();
    }
    expect(manualChunks(nm("dompurify"))).toBe("vendor-shared");
  });

  test("a lodash-es module is shared only when the editor's functions reach it; the rest, the barrel included, are Mermaid's", () => {
    const nm = (pkg: string, file = "index.js") => `/r/node_modules/.bun/${pkg}@1/node_modules/${pkg}/${file}`;
    const debounce = nm("lodash-es", "debounce.js");
    const isObject = nm("lodash-es", "isObject.js");
    const cloneDeep = nm("lodash-es", "cloneDeep.js");
    const importers: Record<string, string[]> = {
      [debounce]: [nm("@milkdown/plugin-listener")],
      [isObject]: [debounce, cloneDeep],
      [cloneDeep]: [nm("dagre-d3-es", "src/dagre/layout.js")],
    };
    const meta = { getModuleInfo: (id: string) => ({ importers: importers[id] ?? [] }) };
    expect(manualChunks(debounce, meta)).toBe("vendor-shared");
    expect(manualChunks(isObject, meta)).toBe("vendor-shared");
    expect(manualChunks(cloneDeep, meta)).toBe("diagram-lodash");
    expect(manualChunks(nm("lodash-es", "lodash.js"), meta)).toBe("diagram-lodash");
  });

  test("editorStaysOwn fails the build when a Mermaid chunk reaches the editor's, and names the chain", () => {
    const nm = (pkg: string) => `/r/node_modules/${pkg}/index.js`;
    const bundle = (mermaidImports: string[]) => ({
      "assets/editor-1.js": { type: "chunk" as const, name: "editor", imports: [], moduleIds: [nm("@milkdown/core")] },
      "assets/shared-1.js": { type: "chunk" as const, name: "shared", imports: ["assets/editor-1.js"], moduleIds: [nm("lodash-es")] },
      "assets/mermaid.core-1.js": { type: "chunk" as const, name: "mermaid.core", imports: mermaidImports, moduleIds: [nm("mermaid")] },
    });
    const plugin = editorStaysOwn();
    expect(() => plugin.generateBundle(undefined, bundle([]))).not.toThrow();
    expect(() => plugin.generateBundle(undefined, bundle(["assets/shared-1.js"]))).toThrow(
      "assets/mermaid.core-1.js -> assets/shared-1.js -> assets/editor-1.js"
    );
  });

  test("editorStaysOwn follows Mermaid's dynamic imports too, but not through the entry", () => {
    const nm = (pkg: string) => `/r/node_modules/${pkg}/index.js`;
    const plugin = editorStaysOwn();
    const bundle = (mermaidDynamic: string[]) => ({
      "assets/index-1.js": { type: "chunk" as const, name: "index", isEntry: true, imports: [], dynamicImports: ["assets/editor-1.js"], moduleIds: ["/r/packages/web/src/main.tsx"] },
      "assets/editor-1.js": { type: "chunk" as const, name: "editor", imports: [], moduleIds: [nm("@milkdown/core")] },
      "assets/mermaid.core-1.js": { type: "chunk" as const, name: "mermaid.core", imports: [], dynamicImports: mermaidDynamic, moduleIds: [nm("mermaid")] },
    });
    expect(() => plugin.generateBundle(undefined, bundle(["assets/index-1.js"]))).not.toThrow();
    expect(() => plugin.generateBundle(undefined, bundle(["assets/editor-1.js"]))).toThrow("mermaid.core-1.js -> assets/editor-1.js");
  });

  test("editorStaysOwn checks Mermaid's chunk when it is an entry itself (the diagram frame's)", () => {
    const nm = (pkg: string) => `/r/node_modules/${pkg}/index.js`;
    const bundle = {
      "assets/editor-1.js": { type: "chunk" as const, name: "editor", imports: [], moduleIds: [nm("@milkdown/core")] },
      "assets/mermaidFrame-1.js": { type: "chunk" as const, name: "mermaidFrame", isEntry: true, imports: ["assets/editor-1.js"], moduleIds: [nm("mermaid")] },
    };
    expect(() => editorStaysOwn().generateBundle(undefined, bundle)).toThrow("mermaidFrame-1.js -> assets/editor-1.js");
  });

  test("editorStaysOwn fails when the editor imports Mermaid's lodash, or the first load reaches diagram code", () => {
    const nm = (pkg: string) => `/r/node_modules/${pkg}/index.js`;
    const plugin = editorStaysOwn();
    const lodash = { type: "chunk" as const, name: "diagram-lodash", imports: [], moduleIds: [nm("lodash-es")] };
    expect(() =>
      plugin.generateBundle(undefined, {
        "assets/editor-1.js": { type: "chunk", name: "editor", imports: ["assets/diagram-lodash-1.js"], moduleIds: [nm("@milkdown/core")] },
        "assets/diagram-lodash-1.js": lodash,
      })
    ).toThrow("add the function to EDITOR_LODASH");
    const boot = (rendererImports: string[]) => ({
      "assets/index-1.js": { type: "chunk" as const, name: "index", isEntry: true, imports: [], moduleIds: ["/r/packages/web/src/main.tsx"] },
      "assets/MarkdownRenderer-1.js": { type: "chunk" as const, name: "MarkdownRenderer", imports: rendererImports, moduleIds: ["/r/packages/web/src/components/MarkdownRenderer.tsx"] },
      "assets/mermaid-1.js": { type: "chunk" as const, name: "mermaid", imports: [], moduleIds: ["/r/packages/web/src/lib/mermaid.ts"] },
    });
    expect(() => plugin.generateBundle(undefined, boot([]))).not.toThrow();
    expect(() => plugin.generateBundle(undefined, boot(["assets/mermaid-1.js"]))).toThrow("The first load reaches diagram code");
  });
});

describe("pruneAssets", () => {
  test("removes only assets last written before the cutoff", () => {
    const out = mkdtempSync(join(tmpdir(), "standup-prune-"));
    mkdirSync(join(out, "assets"));
    const now = Date.now();
    const old = join(out, "assets", "old-1.js");
    writeFileSync(old, "");
    utimesSync(old, (now - ASSET_GRACE_MS - 60_000) / 1000, (now - ASSET_GRACE_MS - 60_000) / 1000);
    writeFileSync(join(out, "assets", "fresh-2.js"), "");
    writeFileSync(join(out, "index.html"), "");
    expect(pruneAssets(out, now - ASSET_GRACE_MS)).toEqual(["old-1.js"]);
    expect(pruneAssets(out, now - ASSET_GRACE_MS)).toEqual([]);
    expect(pruneAssets(join(out, "missing"), now)).toEqual([]);
    rmSync(out, { recursive: true, force: true });
  });

  test("never removes the build index.html serves, however old (a failed rebuild, a warm start after a weekend)", () => {
    const out = mkdtempSync(join(tmpdir(), "standup-prune-live-"));
    mkdirSync(join(out, "assets"));
    const old = (Date.now() - ASSET_GRACE_MS - 60_000) / 1000;
    const files: Record<string, string> = {
      "index-A1.js": `import{a}from"./react-B2.js";const v=()=>import("./WorkView-C3.js")`,
      "react-B2.js": "export const a=1;x.layout.worker-D4.js",
      "WorkView-C3.js": `import"./Composer-E5.js"`,
      "Composer-E5.js": "",
      "layout.worker-D4.js": "",
      "index-OLD9.js": "an earlier build's entry, no longer served",
    };
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(out, "assets", name), body);
      utimesSync(join(out, "assets", name), old, old);
    }
    writeFileSync(join(out, "index.html"), `<script type="module" src="/assets/index-A1.js"></script>`);
    expect([...liveAssets(out)].sort()).toEqual(["Composer-E5.js", "WorkView-C3.js", "index-A1.js", "layout.worker-D4.js", "react-B2.js"]);
    expect(pruneAssets(out, Date.now())).toEqual(["index-OLD9.js"]);
    rmSync(out, { recursive: true, force: true });
  });

  test("a build served for days keeps its chunks for a full grace period after a new build replaces it", () => {
    const out = mkdtempSync(join(tmpdir(), "standup-prune-retire-"));
    mkdirSync(join(out, "assets"));
    // Build A, written three days ago and served ever since.
    const days = (Date.now() - 3 * 24 * 60 * 60 * 1000) / 1000;
    for (const [name, body] of [["index-A1.js", `import"./WorkView-A2.js"`], ["WorkView-A2.js", ""]]) {
      writeFileSync(join(out, "assets", name!), body!);
      utimesSync(join(out, "assets", name!), days, days);
    }
    writeFileSync(join(out, "index.html"), `<script type="module" src="/assets/index-A1.js"></script>`);
    // Build B lands: its chunks are written, then indexHtmlLast swaps index.html.
    writeFileSync(join(out, "assets", "index-B1.js"), "");
    const plugin = indexHtmlLast();
    const bundle: Record<string, unknown> = {
      "index.html": { type: "asset", fileName: "index.html", source: `<script type="module" src="/assets/index-B1.js"></script>` },
    };
    (plugin.generateBundle as (o: unknown, b: unknown) => void).call({}, {}, bundle);
    expect(bundle["index.html"]).toBeUndefined();
    (plugin.writeBundle as (o: { dir: string }) => void).call({}, { dir: out });
    expect(readFileSync(join(out, "index.html"), "utf8")).toContain("index-B1.js");
    // The END prune that follows: a tab opened on A a minute ago still finds its chunks.
    expect(pruneAssets(out, Date.now() - ASSET_GRACE_MS)).toEqual([]);
    expect(existsSync(join(out, "assets", "WorkView-A2.js"))).toBe(true);
    // Once A has been out of service for the grace period, it goes.
    expect(pruneAssets(out, Date.now() + 1000).sort()).toEqual(["WorkView-A2.js", "index-A1.js"]);
    rmSync(out, { recursive: true, force: true });
  });

  test("the diagram frame's page is served too: its chunks are never pruned while served, and it is written before index.html", () => {
    const out = mkdtempSync(join(tmpdir(), "standup-prune-frame-"));
    mkdirSync(join(out, "assets"));
    const old = (Date.now() - ASSET_GRACE_MS - 60_000) / 1000;
    for (const [name, body] of [["index-A1.js", ""], ["mermaidFrame-F1.js", `import("./flowDiagram-F2.js")`], ["flowDiagram-F2.js", ""], ["stale-Z9.js", ""]]) {
      writeFileSync(join(out, "assets", name!), body!);
      utimesSync(join(out, "assets", name!), old, old);
    }
    writeFileSync(join(out, "index.html"), `<script type="module" src="/assets/index-A1.js"></script>`);
    writeFileSync(join(out, "mermaid-frame.html"), `<script type="module" src="/assets/mermaidFrame-F1.js"></script>`);
    expect([...liveAssets(out)].sort()).toEqual(["flowDiagram-F2.js", "index-A1.js", "mermaidFrame-F1.js"]);
    expect(pruneAssets(out, Date.now())).toEqual(["stale-Z9.js"]);

    const plugin = indexHtmlLast();
    const bundle: Record<string, unknown> = {
      "index.html": { type: "asset", fileName: "index.html", source: "new index" },
      "mermaid-frame.html": { type: "asset", fileName: "mermaid-frame.html", source: "new frame" },
    };
    (plugin.generateBundle as (o: unknown, b: unknown) => void).call({}, {}, bundle);
    expect(Object.keys(bundle)).toEqual([]);
    (plugin.writeBundle as (o: { dir: string }) => void).call({}, { dir: out });
    expect(readFileSync(join(out, "mermaid-frame.html"), "utf8")).toBe("new frame");
    expect(readFileSync(join(out, "index.html"), "utf8")).toBe("new index");
    rmSync(out, { recursive: true, force: true });
  });
});
