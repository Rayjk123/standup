import type { Database } from "bun:sqlite";
import { closeSync, lstatSync, opendirSync, readSync, realpathSync } from "fs";
import type { Dir, Stats } from "fs";
import { homedir } from "os";
import { basename, isAbsolute, join, relative, resolve, sep } from "path";
import type { PersonaAttachmentMime } from "@standup/shared";
import type { DocImportResult, DocImportSkip } from "@standup/shared";
import {
  DOC_ASSET_MAX_BYTES,
  DOC_BODY_MAX_BYTES,
  DOC_FOLDER_DEPTH_MAX,
  DOC_IMAGE_EXTENSIONS,
  DOC_IMPORT_MAX_BYTES,
  DOC_IMPORT_MAX_ENTRIES,
  DOC_IMPORT_MAX_FILES,
  DOC_MARKDOWN_EXTENSIONS,
  isValidDocName,
} from "@standup/shared";
import { countDocAssetRefs, createDoc, createDocAsset, createDocFolder, docFolderPath, uniqueDocName } from "@standup/store";
import type { DocLimits } from "@standup/store";
import { AttachmentError, deniedRoots, openSafeFd } from "../persona/attachments.js";
import type { SafeFileMessages } from "../persona/attachments.js";
import { deleteStoredDocAsset, docAssetMimeFor, nameExtension, storeDocAssetBytes } from "./assets.js";

/**
 * Importing markdown and images from this host's disk into the owner's doc
 * tree. A path names one file (a doc or an asset) or a directory, which is
 * brought in as a folder of its own name holding its structure. The walk
 * reads entries with lstat and never follows a symlink; dot-files and
 * dot-directories and node_modules are left out; /proc, /sys and /dev are
 * refused (by path and by real path); every file is opened through
 * openSafeFd (denied roots, the data dir, hard links and size caps checked
 * before a byte is read). The walk is capped at DOC_IMPORT_MAX_ENTRIES
 * directory entries of any kind, and the import at DOC_IMPORT_MAX_FILES
 * files brought in (skipped ones don't count). Everything is read and
 * checked first, and the tree is written in one transaction, so a failed
 * import leaves nothing: no rows, and no asset copies.
 */

export class DocImportError extends Error {}

/** Kernel pseudo-filesystems an import never walks. */
const PSEUDO_ROOTS = ["/proc", "/sys", "/dev"];

export interface DocImportOptions {
  owner: string;
  /** The path as the owner typed it; `~/` expands to `home`. */
  path: string;
  /** The folder the import lands in (null: the root). */
  folderId: string | null;
  /** Standup's data dir: refused as a source, and where asset copies are stored. */
  dataDir: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** The owner's tree caps the import must stay within (defaults: DEFAULT_DOC_LIMITS). */
  limits?: Partial<DocLimits>;
  /** Caps on one import's walk (defaults: DOC_IMPORT_MAX_ENTRIES and DOC_IMPORT_MAX_FILES). */
  maxEntries?: number;
  maxFiles?: number;
}

const MARKDOWN_EXTENSIONS: readonly string[] = DOC_MARKDOWN_EXTENSIONS.map((e) => e.slice(1));
const IMAGE_EXTENSIONS: readonly string[] = DOC_IMAGE_EXTENSIONS.map((e) => e.slice(1));
const NOT_IMPORTABLE = "not markdown or an image";

const MESSAGES: SafeFileMessages = {
  extension: NOT_IMPORTABLE,
  denied: "refused: a protected location",
  notAllowed: "refused: a protected location",
  tooLarge: (_path, size, max) => `${size}, over the ${max} an import takes for its type`,
};

/** One file to bring in: where it lands (its folder's path below the import's root) and what it holds. */
type Planned =
  | { kind: "doc"; dir: string[]; name: string; body: string; bytes: number }
  | { kind: "asset"; dir: string[]; name: string; mime: PersonaAttachmentMime; data: Uint8Array };

function isWithin(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Reads a whole opened file; throws when it changed size while being read. */
function readAll(fd: number, size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let read = 0;
  while (read < size) {
    const n = readSync(fd, bytes, read, size - read, read);
    if (n <= 0) break;
    read += n;
  }
  if (read !== size) throw new AttachmentError("it changed while it was read");
  return bytes;
}

export function importDocs(db: Database, opts: DocImportOptions): DocImportResult {
  const home = opts.home ?? homedir();
  const trimmed = opts.path.trim();
  if (!trimmed || trimmed.includes("\0")) throw new DocImportError("path is required");
  const expanded = trimmed === "~" ? home : trimmed.startsWith("~/") ? join(home, trimmed.slice(2)) : trimmed;
  if (!isAbsolute(expanded)) throw new DocImportError("path must be absolute (or start with ~/)");
  const root = resolve(expanded);
  const denied = [...deniedRoots({ home, dataDir: opts.dataDir, env: opts.env }), resolve(opts.dataDir), ...PSEUDO_ROOTS];
  if (denied.some((d) => isWithin(root, d))) throw new DocImportError("refused: a protected location");
  let rootStat: Stats;
  try {
    rootStat = lstatSync(root);
  } catch {
    throw new DocImportError(`no such file or directory: ${trimmed}`);
  }
  if (rootStat.isSymbolicLink()) throw new DocImportError(`${trimmed} is a symlink; import the path it points to`);
  // A directory on the way may be a symlink into a pseudo-filesystem.
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    throw new DocImportError(`no such file or directory: ${trimmed}`);
  }
  if (PSEUDO_ROOTS.some((d) => isWithin(realRoot, d))) throw new DocImportError("refused: a protected location");
  const parentPath = docFolderPath(db, opts.folderId, opts.owner);
  if (!parentPath) throw new DocImportError("Unknown folder");

  const maxEntries = opts.maxEntries ?? DOC_IMPORT_MAX_ENTRIES;
  const maxFiles = opts.maxFiles ?? DOC_IMPORT_MAX_FILES;
  const skipped: DocImportSkip[] = [];
  const planned: Planned[] = [];
  const folders: string[][] = [];
  let entriesSeen = 0;
  let total = 0;

  /** Plans `p`, refusing the import once it brings in more than maxFiles files. */
  const plan = (p: Planned): void => {
    if (planned.length + 1 > maxFiles) throw new DocImportError(`the import has more than ${maxFiles} files to bring in`);
    planned.push(p);
  };

  /** Reads and checks the file at `abs`, planning it at `dir`; a file that can't come in is skipped with why. */
  const planFile = (abs: string, label: string, dir: string[], name: string): void => {
    const ext = nameExtension(name);
    const markdown = MARKDOWN_EXTENSIONS.includes(ext);
    if (!markdown && !IMAGE_EXTENSIONS.includes(ext)) return void skipped.push({ path: label, reason: NOT_IMPORTABLE });
    if (!isValidDocName(name)) return void skipped.push({ path: label, reason: "its name can't name a doc" });
    let data: Uint8Array;
    try {
      const file = openSafeFd(abs, {
        home,
        dataDir: opts.dataDir,
        env: opts.env,
        allowedExtensions: [...MARKDOWN_EXTENSIONS, ...IMAGE_EXTENSIONS],
        maxBytes: (e) => (MARKDOWN_EXTENSIONS.includes(e) ? DOC_BODY_MAX_BYTES : DOC_ASSET_MAX_BYTES),
        messages: MESSAGES,
        refuseHardLinks: true,
        denyWithin: { roots: [opts.dataDir], except: [] },
      });
      try {
        data = readAll(file.fd, file.size);
      } finally {
        closeSync(file.fd);
      }
    } catch (err) {
      const why = err instanceof AttachmentError ? err.message.replace(abs, "it") : "it could not be read";
      return void skipped.push({ path: label, reason: why });
    }
    total += data.length;
    if (total > DOC_IMPORT_MAX_BYTES) throw new DocImportError(`the import is over ${DOC_IMPORT_MAX_BYTES} bytes`);
    if (markdown) {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(data);
      } catch {
        return void skipped.push({ path: label, reason: "not valid UTF-8" });
      }
      // Valid UTF-8, decoded with any byte-order mark kept, so the body stores the file's bytes exactly.
      const body = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
      plan({ kind: "doc", dir, name, body, bytes: data.length });
    } else {
      const mime = docAssetMimeFor(name, data);
      if (!mime) return void skipped.push({ path: label, reason: `its content is not a .${ext} image` });
      plan({ kind: "asset", dir, name, mime, data });
    }
  };

  /**
   * The names in the directory `abs`, sorted; each counts against maxEntries,
   * read one at a time so a huge directory is refused before it is all read.
   * Null when it can't be read.
   */
  const readEntries = (abs: string): string[] | null => {
    let handle: Dir;
    try {
      handle = opendirSync(abs);
    } catch {
      return null;
    }
    const names: string[] = [];
    try {
      for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
        entriesSeen++;
        if (entriesSeen > maxEntries) throw new DocImportError(`the import walks more than ${maxEntries} files and folders`);
        names.push(entry.name);
      }
    } catch (err) {
      if (err instanceof DocImportError) throw err;
      return null;
    } finally {
      handle.closeSync();
    }
    return names.sort();
  };

  /** Walks the directory `abs` (its folder's path `dir` below the import's root), depth-first in name order. */
  const walk = (abs: string, label: string, dir: string[]): void => {
    const entries = readEntries(abs);
    if (!entries) return void skipped.push({ path: label, reason: "the directory could not be read" });
    for (const entry of entries) {
      const childAbs = join(abs, entry);
      const childLabel = `${label}/${entry}`;
      if (entry.startsWith(".")) {
        skipped.push({ path: childLabel, reason: "dot-files and dot-directories are not imported" });
        continue;
      }
      if (entry === "node_modules") {
        skipped.push({ path: childLabel, reason: "node_modules is not imported" });
        continue;
      }
      if (PSEUDO_ROOTS.some((d) => isWithin(childAbs, d))) {
        skipped.push({ path: childLabel, reason: "refused: a protected location" });
        continue;
      }
      let st: Stats;
      try {
        st = lstatSync(childAbs);
      } catch {
        skipped.push({ path: childLabel, reason: "it could not be read" });
        continue;
      }
      if (st.isSymbolicLink()) {
        skipped.push({ path: childLabel, reason: "a symlink; symlinks are not followed" });
      } else if (st.isDirectory()) {
        if (!isValidDocName(entry)) {
          skipped.push({ path: childLabel, reason: "its name can't name a folder" });
        } else if (parentPath.length + 1 + dir.length + 1 > DOC_FOLDER_DEPTH_MAX) {
          skipped.push({ path: childLabel, reason: `folders nest at most ${DOC_FOLDER_DEPTH_MAX} deep` });
        } else {
          const childDir = [...dir, entry];
          folders.push(childDir);
          walk(childAbs, childLabel, childDir);
        }
      } else if (st.isFile()) {
        planFile(childAbs, childLabel, dir, entry);
      } else {
        skipped.push({ path: childLabel, reason: "not a regular file" });
      }
    }
  };

  const rootName = basename(root);
  const isDirectory = rootStat.isDirectory();
  if (isDirectory) {
    if (!isValidDocName(rootName)) throw new DocImportError("the directory's name can't name a folder");
    if (parentPath.length + 1 > DOC_FOLDER_DEPTH_MAX) throw new DocImportError(`folders nest at most ${DOC_FOLDER_DEPTH_MAX} deep`);
    walk(root, rootName, []);
  } else if (rootStat.isFile()) {
    planFile(root, rootName, [], rootName);
    if (planned.length === 0) throw new DocImportError(`${trimmed} can't be imported: ${skipped[0]?.reason ?? NOT_IMPORTABLE}`);
  } else {
    throw new DocImportError(`${trimmed} is not a regular file or a directory`);
  }

  // Asset copies go in place first; any the transaction leaves unnamed are removed.
  const written: Array<{ sha256: string; mime: string }> = [];
  const shaOf = new Map<Planned, string>();
  const dropUnreferenced = () => {
    for (const w of written) if (countDocAssetRefs(db, w.sha256) === 0) deleteStoredDocAsset(opts.dataDir, w.sha256, w.mime);
  };
  try {
    for (const p of planned) {
      if (p.kind !== "asset") continue;
      const sha256 = storeDocAssetBytes(opts.dataDir, p.data, p.mime);
      written.push({ sha256, mime: p.mime });
      shaOf.set(p, sha256);
    }
  } catch (err) {
    dropUnreferenced();
    throw new DocImportError(`an image could not be stored: ${(err as Error).message}`);
  }

  const write = db.transaction((): DocImportResult => {
    let rootFolderId: string | null = null;
    const folderIds = new Map<string, string | null>([["", opts.folderId]]);
    if (isDirectory) {
      const name = uniqueDocName(db, opts.owner, opts.folderId, rootName, "folder");
      rootFolderId = createDocFolder(db, { owner: opts.owner, parentId: opts.folderId, name, limits: opts.limits }).id;
      folderIds.set("", rootFolderId);
      for (const dir of folders) {
        const parent = folderIds.get(dir.slice(0, -1).join("/")) ?? null;
        const folder = createDocFolder(db, { owner: opts.owner, parentId: parent, name: dir[dir.length - 1]!, limits: opts.limits });
        folderIds.set(dir.join("/"), folder.id);
      }
    }
    let docs = 0;
    let assets = 0;
    for (const p of planned) {
      const folderId = folderIds.get(p.dir.join("/")) ?? null;
      const name = uniqueDocName(db, opts.owner, folderId, p.name);
      if (p.kind === "doc") {
        createDoc(db, { owner: opts.owner, folderId, name, body: p.body, limits: opts.limits });
        docs++;
      } else {
        createDocAsset(db, {
          owner: opts.owner,
          folderId,
          name,
          mime: p.mime,
          sha256: shaOf.get(p)!,
          bytes: p.data.length,
          limits: opts.limits,
        });
        assets++;
      }
    }
    return { rootFolderId, folders: isDirectory ? folders.length + 1 : 0, docs, assets, skipped };
  });
  try {
    return write();
  } catch (err) {
    dropUnreferenced();
    throw err;
  }
}
