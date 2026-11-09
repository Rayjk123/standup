/*
 * How `vite build` groups third-party code into chunks (rollupOptions.output.
 * manualChunks). React and the router change only on a dependency bump, so as
 * their own chunk they keep their hash, and the browser's cached copy,
 * across the app rebuilds a merge triggers. The markdown stack is only reached
 * through MarkdownRenderer's dynamic import (see components/Markdown.tsx) and
 * the knowledge graph only through KnowledgeGraphCanvas's, and the doc editor
 * only through the Docs tab's (see components/docs/DocPane.tsx), so naming their
 * chunks keeps them off the first load and stable between builds. Anything
 * not matched here goes wherever rollup puts it.
 */

const GROUPS: [chunk: string, packages: RegExp][] = [
  ["react", /^(react|react-dom|scheduler|react-router|react-router-dom|cookie|set-cookie-parser)$/],
  // Used by the editor and by Mermaid (lib/mermaid.ts) alike. Left to follow
  // the editor, it would join its chunk, and a shared doc page drawing a
  // diagram would fetch the whole editor for it. lodash-es is split the same
  // way module by module (see EDITOR_LODASH).
  ["vendor-shared", /^dompurify$/],
  // Ahead of "markdown": the editor's own markdown pieces (stringify, math)
  // stay with it rather than joining the renderer the first load fetches.
  // CodeMirror's per-language parsers are left out so each stays a chunk of
  // its own, loaded only when a code block names that language.
  [
    "editor",
    /^(@milkdown\/.*|prosemirror-.*|@codemirror\/(autocomplete|commands|language|language-data|lint|search|state|theme-one-dark|view)|codemirror|@lezer\/(common|highlight|lr)|crelt|style-mod|w3c-keyname|orderedmap|rope-sequence|@marijn\/.*|vue|@vue\/.*|@floating-ui\/.*|clsx|nanoid|remark-stringify|remark-math|micromark-extension-math|mdast-util-math|prosemirror-virtual-cursor|tslib)$/,
  ],
  [
    "markdown",
    /^(react-markdown|remark-.*|rehype-.*|micromark.*|mdast-.*|hast-.*|unist-.*|unified|vfile.*|bail|ccount|character-entities.*|comma-separated-tokens|decode-named-character-reference|devlop|escape-string-regexp|estree-util-.*|html-url-attributes|inline-style-parser|is-plain-obj|longest-streak|markdown-table|property-information|space-separated-tokens|style-to-js|style-to-object|trim-lines|trough|zwitch)$/,
  ],
  ["graph", /^(sigma|graphology.*|events|obliterator|pandemonium|mnemonist)$/],
];

/** The package a module id belongs to, from its last node_modules segment. */
export function packageOf(id: string): string | undefined {
  const at = id.lastIndexOf("/node_modules/");
  if (at < 0) return undefined;
  const parts = id.slice(at + "/node_modules/".length).split("/");
  return parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

/**
 * The lodash-es functions the editor (Milkdown) imports. Mermaid's layout
 * uses some two hundred lodash-es modules and the editor these few. As one
 * group, the editor would fetch all of them; left to follow the editor, the
 * ones it uses would join its chunk and pull it into every page that draws a
 * diagram. So these and the helpers they import are shared, and the rest
 * are a chunk of their own that only Mermaid loads. Both sides import
 * through lodash-es's barrel, which
 * re-exports every module, so the import graph can't tell this by itself;
 * `editorStaysOwn` fails the build should a new import make Mermaid reach
 * the editor's chunk.
 */
const EDITOR_LODASH = /^(debounce|throttle|defaultsDeep|mergeWith)$/;

/** The part of rollup's manualChunks `meta` this module reads. */
export interface ChunkMeta {
  getModuleInfo(id: string): { importers: readonly string[] } | null;
}

/** The function a lodash-es module defines, from its file name; the barrel defines none. */
function lodashName(id: string): string | undefined {
  const name = id.slice(id.lastIndexOf("/") + 1).replace(/\.m?js$/, "");
  return name === "lodash" || name === "lodash.default" ? undefined : name;
}

/** Whether `id` is one of EDITOR_LODASH or imported, through other lodash-es modules, by one. */
function editorLodash(id: string, meta: ChunkMeta, seen = new Set<string>()): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  const name = lodashName(id);
  if (!name) return false;
  if (EDITOR_LODASH.test(name)) return true;
  return (meta.getModuleInfo(id)?.importers ?? []).some((importer) => packageOf(importer) === "lodash-es" && editorLodash(importer, meta, seen));
}

/** The part of a rollup output chunk `editorStaysOwn` reads. */
interface OutputChunkLike {
  type: "chunk" | "asset";
  name?: string;
  isEntry?: boolean;
  imports?: readonly string[];
  dynamicImports?: readonly string[];
  moduleIds?: readonly string[];
}

/** Whether a module is Mermaid's, or the console's own diagram code that loads it. */
const isDiagramCode = (id: string) => packageOf(id) === "mermaid" || /\/src\/(lib\/mermaid|components\/MermaidBlock|mermaidFrame)\.tsx?$/.test(id);

/**
 * A rollup plugin that fails the build when the chunks drift from what keeps
 * diagrams lazy: a chunk holding Mermaid reaches the editor's chunk (a shared
 * doc page drawing a diagram would fetch the whole editor), the editor's
 * chunk imports Mermaid's lodash (it would fetch that on every open), or the
 * first load statically reaches any diagram code.
 */
export function editorStaysOwn() {
  return {
    name: "standup-editor-stays-own",
    generateBundle(_options: unknown, bundle: Record<string, OutputChunkLike>) {
      const named = (name: string) => Object.keys(bundle).filter((file) => bundle[file]!.type === "chunk" && bundle[file]!.name === name);
      const editor = named("editor");
      /**
       * The chain of chunk imports from `file` to one of `targets`, if there
       * is one: static imports, and dynamic ones too when `dynamic` is set.
       * An entry reached on the way is not walked through, since the app's
       * own lazy views hang off the console's; the start always is (Mermaid's
       * core is the diagram frame's entry).
       */
      const pathTo = (targets: string[], file: string, dynamic: boolean, seen = new Set<string>()): string[] | undefined => {
        if (targets.includes(file)) return [file];
        if (seen.has(file) || (seen.size > 0 && bundle[file]?.isEntry)) return undefined;
        seen.add(file);
        const chunk = bundle[file];
        for (const next of [...(chunk?.imports ?? []), ...(dynamic ? (chunk?.dynamicImports ?? []) : [])]) {
          const rest = pathTo(targets, next, dynamic, seen);
          if (rest) return [file, ...rest];
        }
        return undefined;
      };
      for (const [file, chunk] of Object.entries(bundle)) {
        if (chunk.type !== "chunk" || !chunk.moduleIds?.some((id) => packageOf(id) === "mermaid")) continue;
        const path = pathTo(editor, file, true);
        if (path) throw new Error(`Mermaid's chunk reaches the editor's: ${path.join(" -> ")}; see EDITOR_LODASH in chunks.ts`);
      }
      // The other way round: a lodash-es function the editor newly imports would land with Mermaid's.
      for (const file of editor) {
        const path = pathTo(named("diagram-lodash"), file, false);
        if (path) throw new Error(`The editor's chunk imports Mermaid's lodash: ${path.join(" -> ")}; add the function to EDITOR_LODASH in chunks.ts`);
      }
      // What every first load of the console fetches (its entry and the markdown
      // renderer that imports at once) holds no diagram code.
      const boot = Object.keys(bundle).filter((file) =>
        bundle[file]!.moduleIds?.some((id) => id.endsWith("/src/main.tsx") || id.endsWith("/src/components/MarkdownRenderer.tsx"))
      );
      for (const start of boot) {
        const reached = new Set<string>();
        const walk = (file: string) => {
          if (reached.has(file)) return;
          reached.add(file);
          for (const next of bundle[file]?.imports ?? []) walk(next);
        };
        walk(start);
        const diagram = [...reached].find((file) => bundle[file]?.moduleIds?.some(isDiagramCode));
        if (diagram) throw new Error(`The first load reaches diagram code: ${start} statically imports ${diagram}`);
      }
    },
  };
}

/** rollup's manualChunks hook: the chunk name for a third-party module, else undefined. */
export function manualChunks(id: string, meta?: ChunkMeta): string | undefined {
  // Vite's dynamic-import preload helper is needed by the first load and by
  // every named chunk that imports lazily (CodeMirror's language list does).
  // Left unassigned, rollup can put it inside such a chunk, and the first
  // load then has to fetch that whole chunk for it; the react chunk holds it.
  if (id.includes("vite/preload-helper")) return "react";
  // The modulepreload polyfill likewise: with a second page (mermaid-frame.html)
  // it would otherwise become a chunk of its own, one more first-load request.
  if (id.includes("vite/modulepreload-polyfill")) return "react";
  const pkg = packageOf(id);
  if (!pkg) return undefined;
  // The rest of lodash-es is named too: left unassigned, rollup would put it
  // with the barrel, in whichever named chunk first depends on it.
  if (pkg === "lodash-es") return meta && editorLodash(id, meta) ? "vendor-shared" : "diagram-lodash";
  return GROUPS.find(([, packages]) => packages.test(pkg))?.[0];
}
