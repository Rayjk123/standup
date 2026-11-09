import type { DocTree } from "@standup/shared";

/*
 * Which Docs-tree folders are open, kept across reloads in one localStorage
 * key as a JSON array of the open folders' ids (never a map of every folder).
 * The newest opens are kept when the list passes its cap.
 */

export const OPEN_FOLDERS_KEY = "standup.docs.openFolders";
export const OPEN_FOLDERS_CAP = 500;

/** The browser's localStorage, or undefined where it is unavailable (private mode, a plain-http LAN origin). */
export function docsStorage(): Storage | undefined {
  try {
    return typeof window !== "undefined" ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}

/** The stored open folders; an empty set when the value is missing or malformed. */
export function loadOpenFolders(storage: Storage | undefined): Set<string> {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(OPEN_FOLDERS_KEY) ?? null;
  } catch {
    return new Set();
  }
  if (!raw) return new Set();
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return new Set();
    return new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0).slice(-OPEN_FOLDERS_CAP));
  } catch {
    return new Set();
  }
}

/** Stores `open` (the last OPEN_FOLDERS_CAP of it); an empty set removes the key. */
export function saveOpenFolders(storage: Storage | undefined, open: ReadonlySet<string>): void {
  try {
    if (open.size === 0) storage?.removeItem(OPEN_FOLDERS_KEY);
    else storage?.setItem(OPEN_FOLDERS_KEY, JSON.stringify([...open].slice(-OPEN_FOLDERS_CAP)));
  } catch {
    // A full or unavailable storage only costs the tree its open folders on the next load.
  }
}

/**
 * `open` without the folders `tree` no longer has, among `checked` (the
 * folders open when the tree was asked for: one opened since may be newer
 * than the read); `open` itself when nothing is dropped.
 */
export function pruneOpenFolders(open: ReadonlySet<string>, tree: DocTree, checked: ReadonlySet<string> = open): ReadonlySet<string> {
  const exists = new Set(tree.folders.map((f) => f.id));
  const gone = (id: string) => checked.has(id) && !exists.has(id);
  for (const id of open) {
    if (gone(id)) return new Set([...open].filter((x) => !gone(x)));
  }
  return open;
}
