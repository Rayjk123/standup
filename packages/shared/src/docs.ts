// ============================================================================
// Docs: the owner's working documents (design notes, research write-ups) in a
// folder tree, stored as markdown. Separate from the knowledge base: docs are
// never indexed, embedded or injected into agent prompts.
// No node imports: the web bundles this file.
// ============================================================================

import { PERSONA_ATTACHMENT_MAX_BYTES } from "./persona.js";
import type { ShareState } from "./share.js";

/** A folder in the owner's doc tree; `parentId` null is the root. */
export interface DocFolder {
  id: string;
  parentId: string | null;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Present (true) when every signed-in user may read every doc in it and below it. */
  shareable?: true;
}

/** A doc as the tree lists it: everything but its body. */
export interface DocSummary {
  id: string;
  folderId: string | null;
  /** The doc's file name, e.g. `oauth-vs-saml.md`. */
  name: string;
  /** Bumped on every body or name change; a save names the revision it was based on. */
  revision: number;
  bytes: number;
  createdAt: string;
  updatedAt: string;
  /** Present (true) when every signed-in user may read the doc. */
  shareable?: true;
}

/** An image stored in the tree, referenced from docs by a path relative to their folder. */
export interface DocAsset {
  id: string;
  folderId: string | null;
  name: string;
  mime: string;
  bytes: number;
  createdAt: string;
  /** `/api/docs/assets/<id>`. */
  url: string;
}

/** The owner's whole tree (GET /api/docs/tree). */
export interface DocTree {
  folders: DocFolder[];
  docs: DocSummary[];
  assets: DocAsset[];
}

/** A doc with its markdown body (GET /api/docs/:id). */
export interface DocDetail extends DocSummary {
  body: string;
  /** Whether the doc is shared by link; only on a person's own read. */
  share?: ShareState;
  /** On the owner's read of a doc under a shareable folder: that folder's name. */
  shareableVia?: string;
  /**
   * On another user's read of a doc shared with them: the doc's owner, and
   * the images its body shows, keyed by `src` as written (served to that
   * reader only through this doc).
   */
  readOnly?: { owner: string; images: Record<string, SharedDocAsset> };
}

/** The docs other users have made shareable, by owner (GET /api/docs/shared-with-me). */
export interface SharedWithMe {
  owner: string;
  /** Each doc with its path in the owner's tree, `folder/sub/name.md`. */
  docs: Array<{ id: string; path: string; updatedAt: string }>;
}

/** A doc the Docs tab's search found (GET /api/docs/search). */
export interface DocSearchHit {
  id: string;
  /** The doc's path from the root, `folder/sub/name.md`. */
  path: string;
  /** What matched: the doc's name or path, its body's words, or only its body's meaning (the semantic index). */
  match: "path" | "body" | "meaning";
  /** The line of the body around the first match, for a body match; the closest passage's opening, for a meaning match. */
  snippet?: string;
}

/** The longest query the docs search reads. */
export const DOC_SEARCH_QUERY_MAX = 200;

/** One path an import left out, and why. */
export interface DocImportSkip {
  path: string;
  reason: string;
}

/** What POST /api/docs/import brought in. */
export interface DocImportResult {
  /** The folder the import created for a directory, or null for a single file. */
  rootFolderId: string | null;
  folders: number;
  docs: number;
  assets: number;
  skipped: DocImportSkip[];
}

/**
 * Payload of a `docs:changed` frame: something in the owner's tree changed.
 * It carries no content (addressed to the owner with proof, and the client
 * re-reads through the authorized routes). `docId` names a doc whose body or
 * name changed, with its new `revision`; `tree` is set when the tree's shape
 * changed (a create, rename, move or delete).
 */
export interface DocsChangedPayload {
  tree: boolean;
  docId?: string;
  revision?: number;
  deleted?: boolean;
  /** Set when the doc's share link was turned on or off. */
  share?: boolean;
  /** A folder whose share link was turned on or off (with `share` set). */
  folderId?: string;
}

/** A shared doc's image, served only through the share token. */
export interface SharedDocAsset {
  /** `/api/share/docs/<token>/media/<assetId>`. */
  url: string;
  mime: string;
}

/**
 * Everything a doc's share link shows: its name and body, and the images the
 * body references (keyed by the `src` exactly as written in the markdown).
 * No ids, owner, folder, revision or anything else of the tree.
 */
export interface SharedDoc {
  name: string;
  body: string;
  images: Record<string, SharedDocAsset>;
}

/** A folder in a shared folder's tree; the shared folder itself has a null `parentId`. */
export interface SharedFolderNode {
  id: string;
  parentId: string | null;
  name: string;
}

/** A doc in a shared folder's tree, opened through `/api/share/folders/<token>/docs/<id>`. */
export interface SharedFolderDoc {
  id: string;
  folderId: string;
  name: string;
}

/**
 * Everything a folder's share link shows of its tree: the shared folder, the
 * folders below it and the docs in any of them, each with its id and name
 * only. Images and anything above the shared folder are left out.
 */
export interface SharedFolder {
  name: string;
  folders: SharedFolderNode[];
  docs: SharedFolderDoc[];
}

export const DOC_NAME_MAX = 200;
export const DOC_BODY_MAX_BYTES = 2 * 1024 * 1024;
export const DOC_ASSET_MAX_BYTES = 20 * 1024 * 1024;
export const DOC_FOLDER_DEPTH_MAX = 16;
/**
 * The largest image POST /api/docs/write-image stores (write_doc's images and
 * the editor's uploads): the cap on an image Persona attaches to a reply.
 */
export const DOC_TOOL_IMAGE_MAX_BYTES = PERSONA_ATTACHMENT_MAX_BYTES;
/** The most images one doc-tool write (Persona's or a worker's write_doc) stores beside its doc. */
export const DOC_TOOL_IMAGES_PER_CALL = 50;
/** The most image bytes one doc-tool write stores, all its images together. */
export const DOC_TOOL_IMAGES_TOTAL_MAX_BYTES = 100 * 1024 * 1024;
/** Caps on one import: files looked at, and bytes brought in. */
export const DOC_IMPORT_MAX_FILES = 2000;
export const DOC_IMPORT_MAX_BYTES = 200 * 1024 * 1024;
/** Directory entries one import may walk (files of any kind, and folders). */
export const DOC_IMPORT_MAX_ENTRIES = 20000;
/** Per-owner caps on the whole tree: image bytes, doc body bytes, and folders + docs + assets. */
export const DOC_OWNER_ASSET_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
export const DOC_OWNER_BODY_QUOTA_BYTES = 256 * 1024 * 1024;
export const DOC_OWNER_MAX_ITEMS = 20000;

/** File extensions imported as docs. */
export const DOC_MARKDOWN_EXTENSIONS = [".md", ".markdown"] as const;
/** File extensions imported (and uploaded) as image assets. */
export const DOC_IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"] as const;

/**
 * Whether `name` is a usable doc, folder or asset name: non-empty after
 * trimming, at most DOC_NAME_MAX characters, no path separators, no control
 * characters, and not `.` or `..`.
 */
export function isValidDocName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > DOC_NAME_MAX || trimmed !== name) return false;
  if (trimmed === "." || trimmed === "..") return false;
  return !/[/\\\u0000-\u001f\u007f]/.test(name);
}

/**
 * Each folder's path of names from the root (its own name last), by folder
 * id. A parent missing from `folders`, or a loop, ends the path where it
 * breaks.
 */
export function docFolderPaths(folders: readonly Pick<DocFolder, "id" | "parentId" | "name">[]): Map<string, string[]> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const paths = new Map<string, string[]>();
  const pathOf = (id: string, seen: Set<string>): string[] => {
    const known = paths.get(id);
    if (known) return known;
    const folder = byId.get(id);
    if (!folder || seen.has(id)) return [];
    seen.add(id);
    const path = [...(folder.parentId ? pathOf(folder.parentId, seen) : []), folder.name];
    paths.set(id, path);
    return path;
  };
  for (const f of folders) pathOf(f.id, new Set());
  return paths;
}

/** Each doc's path from the root (`folder/sub/name.md`), by doc id. */
export function docPaths(tree: Pick<DocTree, "folders" | "docs">): Map<string, string> {
  const folderPaths = docFolderPaths(tree.folders);
  return new Map(tree.docs.map((d) => [d.id, [...(d.folderId ? (folderPaths.get(d.folderId) ?? []) : []), d.name].join("/")]));
}

/** Splits a slash-separated doc path (`auth/oauth-vs-saml.md`) into names; null when any part is invalid. */
export function parseDocPath(path: unknown): string[] | null {
  if (typeof path !== "string") return null;
  const parts = path.split("/").filter((p) => p.length > 0);
  if (parts.length === 0 || parts.length > DOC_FOLDER_DEPTH_MAX + 1) return null;
  return parts.every(isValidDocName) ? parts : null;
}

/**
 * Resolves an image `src` written in a doc against the doc's folder path
 * (its folder names from the root). Returns the target's path from the root,
 * or null for an absolute URL, a data/blob URL, a root-absolute path, or a
 * path that climbs above the root. A `?query` or `#hash` is ignored, and
 * percent-escapes are decoded within each segment (so `%2F` is part of a
 * name, never a separator).
 */
export function resolveDocRelativePath(folderPath: readonly string[], src: string): string[] | null {
  const raw = src.trim().split(/[?#]/)[0] ?? "";
  if (raw.length === 0 || raw.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  const out = [...folderPath];
  for (const segment of raw.split("/")) {
    let part: string;
    try {
      part = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.length > 0 ? out : null;
}

/**
 * Whether the lines between a leading pair of `---` fences read as YAML
 * frontmatter: at least one non-blank line, and every non-blank line a
 * `key:` entry, an indented continuation or a `- ` list item. Anything else
 * (prose between two thematic breaks, say) is the document's own content.
 */
function looksLikeFrontmatter(inner: string): boolean {
  const lines = inner.split(/\r?\n/).filter((line) => line.trim() !== "");
  return lines.length > 0 && lines.every((line) => /^[\w-]+\s*:/.test(line) || /^\s+/.test(line) || /^- /.test(line));
}

/**
 * Splits a leading YAML frontmatter block (`---` … `---`) off a markdown body,
 * so an editor that doesn't model frontmatter edits only the rest and the
 * block is put back verbatim on save. A leading `---` pair whose lines don't
 * read as YAML (see looksLikeFrontmatter) is left in the content.
 */
export function splitFrontmatter(body: string): { frontmatter: string; content: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(body);
  if (!match || !looksLikeFrontmatter(match[1]!)) return { frontmatter: "", content: body };
  return { frontmatter: match[0], content: body.slice(match[0].length) };
}

/**
 * Puts a frontmatter block split off by splitFrontmatter back in front of
 * `content`. A block that closed at the very end of the body gets a newline,
 * so its closing fence never runs into the first line of content.
 */
export function joinFrontmatter(frontmatter: string, content: string): string {
  if (frontmatter === "" || content === "" || frontmatter.endsWith("\n")) return frontmatter + content;
  return `${frontmatter}\n${content}`;
}

/**
 * Why a doc tool's arguments may not have arrived whole, or null when they
 * did. A tool call whose response was stopped while the model was still
 * writing it can reach the tool as complete JSON holding only the arguments
 * written before the cut, the last of them cut short. So the argument named
 * `argName` must come last in `args` (JSON keeps the order they were written
 * in) and repeat the last line of `args.content` that has text, trimmed; ""
 * for a blank body. Anything else means some argument may be incomplete and
 * nothing may be written.
 */
export function docContentCutOff(args: Record<string, unknown>, argName: string): string | null {
  const lastLine = args[argName];
  if (typeof lastLine !== "string") {
    return `${argName} is required: the content's last line that has text, repeated exactly, so a body cut off in transit is refused`;
  }
  if (Object.keys(args).at(-1) !== argName) {
    return `${argName} must be the last argument, after content and every other one, so a call cut off before it is refused. Nothing was written; send the call again with ${argName} last`;
  }
  if (typeof args.content !== "string") return "content must be a string";
  const content = args.content;
  const lines = content.split("\n");
  let i = lines.length - 1;
  while (i > 0 && lines[i]!.trim() === "") i--;
  if (lines[i]!.trim() === lastLine.trim()) return null;
  return (
    `the content does not end with ${argName} (its last line is ${JSON.stringify(lines[i]!.trim().slice(-80))}), ` +
    "so it may have been cut off before it arrived. Nothing was written; send the whole body again"
  );
}
