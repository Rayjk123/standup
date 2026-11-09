import { basename } from "path";
import { DOC_BODY_MAX_BYTES, DOC_TOOL_IMAGES_PER_CALL, DOC_TOOL_IMAGES_TOTAL_MAX_BYTES, isValidDocName, parseDocPath, resolveDocRelativePath } from "@standup/shared";
import { AttachmentError } from "../persona/attachments.js";
import type { ValidatedImage } from "../persona/attachments.js";

/**
 * The doc tools' write with images (Persona's write_doc, and a worker's
 * through POST /api/docs/write): each image is a file on this host, read and
 * checked by `readImage` (readImageForAttachment), stored beside the doc
 * through POST /api/docs/write-image, and then the doc is written through
 * POST /api/docs/write — all as the caller, so the routes' own rules (shared
 * links, revisions, caps) apply to every step.
 */

/** A doc tool's image: the host file and the tree path it is stored at, from `src` as the doc embeds it. */
export interface DocToolImage {
  file: string;
  path: string;
  src: string;
}

/** A refused doc write with images, with the HTTP status a route answers it with. */
export class DocToolImageError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = "DocToolImageError";
  }
}

/** A request to one of the collector's own doc routes, as the caller. */
export type DocToolRequest = (method: "GET" | "POST", path: string, body?: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown> }>;

function errorOf(res: { status: number; body: Record<string, unknown> }): string {
  const error = res.body.error;
  return typeof error === "string" && error ? error : `request failed (${res.status})`;
}

/**
 * The `images` of a doc write: each host file and the tree path it is stored
 * at, its `src` (default: the file's name) resolved against the folder of the
 * doc at `docPath`. Every src must stay inside the tree and name an image,
 * and no two may land on the same path. Absent or empty is no images.
 */
export function parseDocImages(value: unknown, docPath: string): DocToolImage[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new DocToolImageError("images must be a list of {file, src}");
  if (value.length > DOC_TOOL_IMAGES_PER_CALL) throw new DocToolImageError(`write_doc stores at most ${DOC_TOOL_IMAGES_PER_CALL} images per call`);
  if (value.length === 0) return [];
  const docNames = parseDocPath(docPath);
  if (!docNames) throw new DocToolImageError("path must be a slash-separated doc path, e.g. notes/design.md");
  const seen = new Set<string>();
  return value.map((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new DocToolImageError(`images[${i}] must be {file, src}`);
    const entry = item as Record<string, unknown>;
    const field = (key: string): string | undefined => {
      const v = entry[key];
      if (v === undefined || v === null) return undefined;
      if (typeof v !== "string") throw new DocToolImageError(`images[${i}].${key} must be a string`);
      return v.trim() || undefined;
    };
    const file = field("file");
    if (!file) throw new DocToolImageError(`images[${i}].file is required`);
    // The file's own name is escaped, so a space, `%` or parenthesis in it stays part of the name and the src parses as markdown.
    const src = field("src") ?? encodeURIComponent(basename(file)).replace(/\(/g, "%28").replace(/\)/g, "%29");
    const target = resolveDocRelativePath(docNames.slice(0, -1), src);
    if (!target || !target.every(isValidDocName) || !/\.(png|jpe?g|gif|webp)$/i.test(target[target.length - 1]!)) {
      throw new DocToolImageError(
        `images[${i}].src ${JSON.stringify(src)} must be a path relative to the doc's folder, ending in .png, .jpg, .jpeg, .gif or .webp`
      );
    }
    const path = target.join("/");
    if (seen.has(path)) throw new DocToolImageError(`images[${i}].src ${JSON.stringify(src)} names the same image as an earlier one`);
    seen.add(path);
    return { file, path, src };
  });
}

export interface DocWithImagesInput {
  path: string;
  content: string;
  ifRevision?: number;
  images: DocToolImage[];
  /** Reads and checks one host file; throws AttachmentError saying why it can't be stored. */
  readImage(file: string): ValidatedImage;
  request: DocToolRequest;
}

export interface DocWithImagesResult {
  doc: { id: string; path: string; revision: number };
  /** The tree paths of the images stored, in order. */
  stored: string[];
  /** Each stored image's src, as the doc embeds it. */
  srcs: string[];
}

/**
 * Stores `images` beside the doc and then writes it. The body's size and
 * every file are checked before any image is stored, and with ifRevision a
 * stale doc is refused before any image beside it is replaced, so each of
 * those refusals stores nothing. An image stored before a later refusal stays
 * stored, and the refusal names it.
 */
export async function writeDocWithImages(input: DocWithImagesInput): Promise<DocWithImagesResult> {
  const { path, content, ifRevision, images, readImage, request } = input;
  if (Buffer.byteLength(content, "utf8") > DOC_BODY_MAX_BYTES) throw new DocToolImageError(`the doc is over ${DOC_BODY_MAX_BYTES} bytes`, 413);
  // Each file is read once; the bytes checked are the bytes stored.
  const files: ValidatedImage[] = [];
  let total = 0;
  for (const [i, image] of images.entries()) {
    try {
      files.push(readImage(image.file));
    } catch (err) {
      if (err instanceof AttachmentError) {
        throw new DocToolImageError(`image ${i + 1} of ${images.length} (${image.path}): ${err.message.replace(/\.$/, "")}. The doc was not written.`);
      }
      throw err;
    }
    total += files[i]!.bytes.length;
    if (total > DOC_TOOL_IMAGES_TOTAL_MAX_BYTES) {
      throw new DocToolImageError(
        `the images total over ${DOC_TOOL_IMAGES_TOTAL_MAX_BYTES / (1024 * 1024)} MB by image ${i + 1} of ${images.length} (${image.path}), over what one write stores; write the rest in another call. The doc was not written.`,
        413
      );
    }
  }
  if (images.length > 0 && ifRevision !== undefined) {
    const current = await request("GET", `/api/docs/read?${new URLSearchParams({ path })}`);
    if (current.status !== 200 && current.status !== 404) throw new DocToolImageError(errorOf(current), current.status);
    const doc = current.status === 200 ? (current.body.doc as { revision: number }) : null;
    const revision = doc ? doc.revision : null;
    if (revision !== ifRevision) {
      throw new DocToolImageError(
        revision === null
          ? "there is no doc at that path to update; write without ifRevision to create it"
          : `the doc is at revision ${revision}, not ${ifRevision}: read it again and reapply your change`,
        409
      );
    }
  }
  const stored: string[] = [];
  const srcs: string[] = [];
  for (const [i, image] of images.entries()) {
    const failed = (why: string, status: number) =>
      new DocToolImageError(
        `image ${i + 1} of ${images.length} (${image.path}): ${why.replace(/\.$/, "")}. ` +
          (stored.length ? `Stored before it: ${stored.join(", ")}. ` : "") +
          "The doc was not written.",
        status
      );
    const put = await request("POST", "/api/docs/write-image", { path: image.path, data: Buffer.from(files[i]!.bytes).toString("base64") });
    if (put.status !== 200) throw failed(errorOf(put), put.status);
    stored.push(image.path);
    srcs.push(image.src);
  }
  const res = await request("POST", "/api/docs/write", { path, content, ...(ifRevision !== undefined ? { ifRevision } : {}) });
  if (res.status !== 200) {
    throw new DocToolImageError(stored.length ? `${errorOf(res)} (the images were stored: ${stored.join(", ")})` : errorOf(res), res.status);
  }
  return { doc: res.body.doc as DocWithImagesResult["doc"], stored, srcs };
}
