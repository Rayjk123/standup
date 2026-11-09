import { createHash, randomUUID } from "crypto";
import { closeSync, constants as fsConstants, fstatSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "fs";
import { dirname, join, resolve } from "path";
import type { PersonaAttachmentMime } from "@standup/shared";
import { sniffImageMime } from "../persona/attachments.js";
import { ensureOwnDirectory, isOwnDirectory } from "../review/media.js";

/**
 * The stored copies of doc assets: `<dataDir>/doc-assets/<sha256>.<ext>`,
 * named by the digest of exactly the bytes written, owner-only, written to a
 * temp file and renamed into place. Only PNG, JPEG, GIF and WebP are ever
 * stored (checked by content, never SVG); only these copies are served.
 */

/** The stored copy's extension for each image type. */
const MIME_EXTENSIONS: Record<PersonaAttachmentMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** The image type each file extension (lower-case, no dot) must hold. */
const EXTENSION_MIMES: Record<string, PersonaAttachmentMime> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

const SHA256 = /^[0-9a-f]{64}$/;

export function isDocAssetMime(value: unknown): value is PersonaAttachmentMime {
  return typeof value === "string" && value in MIME_EXTENSIONS;
}

/** The trailing extension of `name`, lower-case, without the dot ("" when it has none). */
export function nameExtension(name: string): string {
  const match = /\.([^./]+)$/.exec(name);
  return match ? match[1]!.toLowerCase() : "";
}

/** Whether `name` has an image extension an asset may carry. */
export function isImageName(name: string): boolean {
  return nameExtension(name) in EXTENSION_MIMES;
}

/** The image type `name`'s extension says, or null. */
export function mimeOfImageName(name: string): PersonaAttachmentMime | null {
  return EXTENSION_MIMES[nameExtension(name)] ?? null;
}

/**
 * The image type of `bytes` when it is a PNG, JPEG, GIF or WebP whose type
 * matches `name`'s extension; null otherwise.
 */
export function docAssetMimeFor(name: string, bytes: Uint8Array): PersonaAttachmentMime | null {
  const expected = EXTENSION_MIMES[nameExtension(name)];
  const sniffed = sniffImageMime(bytes);
  return expected && sniffed === expected ? sniffed : null;
}

export function docAssetsDir(dataDir: string): string {
  return join(dataDir, "doc-assets");
}

/** The stored copy's path for `sha256` of type `mime`, built only from those two once validated; null when either is invalid. */
function storedPath(dataDir: string, sha256: string, mime: string): string | null {
  if (!SHA256.test(sha256) || !isDocAssetMime(mime)) return null;
  const dir = docAssetsDir(dataDir);
  const path = join(dir, `${sha256}.${MIME_EXTENSIONS[mime]}`);
  return dirname(resolve(path)) === resolve(dir) ? path : null;
}

export function docAssetDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Writes `bytes` as the stored copy of type `mime`, atomically; returns its digest. Throws when the dir isn't the collector's own. */
export function storeDocAssetBytes(dataDir: string, bytes: Uint8Array, mime: PersonaAttachmentMime): string {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const dir = docAssetsDir(dataDir);
  ensureOwnDirectory(dir);
  const sha256 = docAssetDigest(bytes);
  const path = storedPath(dataDir, sha256, mime);
  if (!path) throw new Error("invalid doc asset path");
  const tmpPath = join(dir, `.staging-${randomUUID()}.tmp`);
  let fd: number | undefined = openSync(
    tmpPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
    0o600
  );
  try {
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
    closeSync(fd);
    fd = undefined;
    // A copy already there (the same bytes, or a tampered file or symlink) is replaced, not followed.
    renameSync(tmpPath, path);
    return sha256;
  } catch (err) {
    if (fd !== undefined) closeSync(fd);
    rmSync(tmpPath, { force: true });
    throw err;
  }
}

/**
 * The stored copy opened for serving, or null when it is missing, its dir or
 * the file is a symlink, it is not a regular file, or its size isn't
 * `expectedSize`. The caller reads it through `fd` and closes it.
 */
export function openStoredDocAsset(dataDir: string, sha256: string, mime: string, expectedSize: number): { fd: number; size: number } | null {
  const path = storedPath(dataDir, sha256, mime);
  if (!path || !isOwnDirectory(docAssetsDir(dataDir))) return null;
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (st.isFile() && st.size === expectedSize) return { fd, size: st.size };
  } catch {
    // Unreadable: treated as missing.
  }
  closeSync(fd);
  return null;
}

/** Removes the stored copy, only through a stored-copy dir of the collector's own. The caller removes only a copy no row names. */
export function deleteStoredDocAsset(dataDir: string, sha256: string, mime: string): void {
  const path = storedPath(dataDir, sha256, mime);
  if (!path || !isOwnDirectory(docAssetsDir(dataDir))) return;
  rmSync(path, { force: true });
}
