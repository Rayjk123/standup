import type { DocAsset, DocTree } from "@standup/shared";
import { docFolderPaths, resolveDocRelativePath } from "@standup/shared";

/** Something in the tree that can be moved, renamed or deleted. */
export type TreeItem = { kind: "folder"; id: string } | { kind: "doc"; id: string } | { kind: "asset"; id: string };

export const EMPTY_TREE: DocTree = { folders: [], docs: [], assets: [] };

/** The names of `folderId` and its ancestors, from the root down; [] for the root. */
export function folderPath(tree: DocTree, folderId: string | null): string[] {
  return folderId ? (docFolderPaths(tree.folders).get(folderId) ?? []) : [];
}

/** Whether `folderId` is `ancestorId` itself or lies anywhere inside it. */
export function isSelfOrDescendant(tree: DocTree, folderId: string | null, ancestorId: string): boolean {
  const byId = new Map(tree.folders.map((f) => [f.id, f]));
  const seen = new Set<string>();
  let at = folderId;
  while (at && !seen.has(at)) {
    if (at === ancestorId) return true;
    seen.add(at);
    at = byId.get(at)?.parentId ?? null;
  }
  return false;
}

/** The folder a path of names (from the root) leads to: its id, null for the root, undefined when no such folder. */
function folderAt(tree: DocTree, names: readonly string[]): string | null | undefined {
  let parent: string | null = null;
  for (const name of names) {
    const next = tree.folders.find((f) => f.parentId === parent && f.name === name);
    if (!next) return undefined;
    parent = next.id;
  }
  return parent;
}

/**
 * The asset an image `src` written in a doc in `docFolderId` names, by its
 * path relative to that folder; null for an absolute URL or a path that
 * leads to no asset.
 */
export function assetForSrc(tree: DocTree, docFolderId: string | null, src: string): DocAsset | null {
  const target = resolveDocRelativePath(folderPath(tree, docFolderId), src);
  if (!target) return null;
  const name = target[target.length - 1]!;
  const folderId = folderAt(tree, target.slice(0, -1));
  if (folderId === undefined) return null;
  return tree.assets.find((a) => a.folderId === folderId && a.name === name) ?? null;
}

/** The folder a tree item sits in (null: the root), or undefined when it isn't in the tree. */
export function parentOf(tree: DocTree, item: TreeItem): string | null | undefined {
  if (item.kind === "folder") return tree.folders.find((f) => f.id === item.id)?.parentId;
  if (item.kind === "doc") return tree.docs.find((d) => d.id === item.id)?.folderId;
  return tree.assets.find((a) => a.id === item.id)?.folderId;
}

/**
 * Whether `item` may be dropped into `targetFolderId` (null: the root): not
 * where it already is, and a folder never into itself or anything inside it.
 */
export function canMove(tree: DocTree, item: TreeItem, targetFolderId: string | null): boolean {
  const parent = parentOf(tree, item);
  if (parent === undefined || parent === targetFolderId) return false;
  if (item.kind === "folder" && isSelfOrDescendant(tree, targetFolderId, item.id)) return false;
  return true;
}

/**
 * The `src` of each inline markdown image in `body` (`![alt](src)` or
 * `![alt](<src>)`), in order, with backslash escapes undone (the editor
 * writes `shot (2).png` as `shot%20\(2\).png`).
 */
export function imageSources(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/!\[[^\]\n]*\]\(\s*(?:<([^>\n]*)>|((?:\\[!-/:-@[-`{-~]|[^\s)\\])+))/g)) {
    out.push((m[1] ?? m[2]!).replace(/\\([!-/:-@[-`{-~])/g, "$1"));
  }
  return out;
}

/**
 * What each image a doc in `docFolderId` embeds resolves to in `tree` (its
 * asset's URL, or nothing), as one string: it changes exactly when one of
 * the doc's images would render differently.
 */
export function imageResolutionKey(tree: DocTree, docFolderId: string | null, body: string): string {
  return imageSources(body)
    .map((src) => `${src}\u0000${assetForSrc(tree, docFolderId, src)?.url ?? ""}`)
    .join("\n");
}

/** The markdown `src` for an asset stored beside the doc: its name, escaped so the link parses. */
export function relativeSrc(name: string): string {
  return name
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}
