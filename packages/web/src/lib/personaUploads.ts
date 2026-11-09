import type { PersonaAttachment, PersonaThread, PersonaUploadRequest, PersonaUploadResponse } from "@standup/shared";
import {
  PERSONA_ATTACHMENT_MAX_BYTES,
  PERSONA_UPLOAD_IMAGE_MIMES,
  PERSONA_UPLOAD_VIDEO_MIMES,
  PERSONA_VIDEO_MAX_BYTES,
  isPersonaImageMime,
  isPersonaVideoMime,
} from "@standup/shared";
import { personaCall, type PersonaCallResult } from "./persona";

/**
 * The owner's image and video uploads to Persona: the checks the console runs
 * before sending a file (the collector stays the authority on type and size),
 * the upload call, and the local previews that stand in for an attachment
 * until the message carrying it is confirmed.
 */

/** The file picker's `accept` list: every type the collector takes. */
export const PERSONA_UPLOAD_ACCEPT = [...PERSONA_UPLOAD_IMAGE_MIMES, ...PERSONA_UPLOAD_VIDEO_MIMES].join(",");

/** The accepted types as the owner knows them, for the "isn't supported" message. */
export const PERSONA_UPLOAD_TYPES_LABEL = "PNG, JPEG, GIF, WebP, MP4, MOV or WebM";

const MIB = 1024 * 1024;

/** A byte count in megabytes with one decimal, e.g. "62.0 MB". */
export function formatMegabytes(bytes: number): string {
  return `${(bytes / MIB).toFixed(1)} MB`;
}

/** A whole-megabyte cap, e.g. "50 MB". */
function capLabel(bytes: number): string {
  return `${Math.round(bytes / MIB)} MB`;
}

/** What to call a refused file's type: its extension, else its MIME type. */
function typeName(name: string, mimeType: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && dot < name.length - 1 ? name.slice(dot + 1) : "";
  if (ext && /^[a-z0-9]{1,8}$/i.test(ext)) return ext.toUpperCase();
  return mimeType;
}

/** The parts of a `File` the pre-checks read. */
export interface UploadCandidate {
  name: string;
  /** The browser's `File.type`; empty when it couldn't tell. */
  type: string;
  size: number;
}

/**
 * Why the console won't upload `file`, or undefined to send it. A file the
 * browser couldn't type is sent anyway (the collector reads its content) but
 * is still held to the larger, video cap.
 */
export function uploadPrecheck(file: UploadCandidate): string | undefined {
  const { name, type, size } = file;
  if (type && !isPersonaImageMime(type) && !isPersonaVideoMime(type)) {
    return `${name}: ${typeName(name, type)} isn't supported — use ${PERSONA_UPLOAD_TYPES_LABEL}`;
  }
  if (type && isPersonaImageMime(type) && size > PERSONA_ATTACHMENT_MAX_BYTES) {
    return `${name} is ${formatMegabytes(size)}; images can be at most ${capLabel(PERSONA_ATTACHMENT_MAX_BYTES)}`;
  }
  if (size > PERSONA_VIDEO_MAX_BYTES) {
    return `${name} is ${formatMegabytes(size)}; videos can be at most ${capLabel(PERSONA_VIDEO_MAX_BYTES)}`;
  }
  return undefined;
}

/**
 * A file's bytes as base64. FileReader encodes natively in chunks, so a 50 MB
 * video never becomes one giant string of char codes on the JS side; only the
 * `data:…;base64,` prefix is stripped.
 */
export function readFileBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : "";
      const comma = url.indexOf(",");
      resolve(comma === -1 ? "" : url.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the file"));
    reader.readAsDataURL(file);
  });
}

/** `personaCall`'s message when a response carried no `{error}` of its own. */
const GENERIC_ERROR = /^Request failed \(\d+\)$/;

/**
 * The message to show for a failed upload: the collector's own `{error}` when
 * it sent one. A 413 without one came from something in front of the
 * collector (the gateway's body cap), so it is explained in the owner's terms.
 */
export function uploadErrorMessage(name: string, res: PersonaCallResult<unknown>): string {
  const error = res.error ?? "";
  if (error && !GENERIC_ERROR.test(error)) return res.status === 0 ? `Upload failed: ${error}` : error;
  if (res.status === 413) return `${name} is too large to upload`;
  if (res.status === 503) return `The server is busy — remove ${name} and add it again in a moment`;
  return `Upload failed${res.status ? ` (${res.status})` : ""}`;
}

export type UploadOutcome = { ok: true; attachment: PersonaAttachment } | { ok: false; error: string };

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** How long to wait before retrying a busy gateway when its `Retry-After` gives no usable seconds. */
export const UPLOAD_RETRY_DEFAULT_MS = 2000;
/** The longest `Retry-After` the console will sit out. */
const UPLOAD_RETRY_MAX_MS = 10_000;

/** The wait a `Retry-After` header asks for, in ms. */
export function retryAfterMs(header: string): number {
  const seconds = Number(header.trim());
  if (!header.trim() || !Number.isFinite(seconds) || seconds < 0) return UPLOAD_RETRY_DEFAULT_MS;
  return Math.min(UPLOAD_RETRY_MAX_MS, Math.max(500, seconds * 1000));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Reads `file` and uploads it to `threadId` (the console thread when absent).
 * A 503 carrying `Retry-After` is the gateway out of buffer room for the
 * moment, so it is retried once after the wait it asks for. `signal` cancels
 * the upload: the request is aborted and no wait or retry follows.
 */
export async function uploadPersonaFile(
  file: File,
  threadId: string | undefined,
  {
    fetchFn = fetch,
    wait = sleep,
    signal,
  }: { fetchFn?: FetchFn; wait?: (ms: number) => Promise<void>; signal?: AbortSignal } = {}
): Promise<UploadOutcome> {
  const cancelled: UploadOutcome = { ok: false, error: `Upload of ${file.name} cancelled` };
  let dataBase64: string;
  try {
    dataBase64 = await readFileBase64(file);
  } catch (err) {
    return { ok: false, error: `Couldn't read ${file.name}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (signal?.aborted) return cancelled;
  const send: FetchFn = (input, init) => fetchFn(input, signal ? { ...init, signal } : init);
  const body: PersonaUploadRequest = {
    ...(threadId ? { threadId } : {}),
    name: file.name,
    ...(file.type ? { mimeType: file.type } : {}),
    dataBase64,
  };
  // personaCall keeps no headers, so the response's Retry-After is noted on the way through.
  const seen: { retryAfter: string | null } = { retryAfter: null };
  const noting: FetchFn = async (input, init) => {
    const response = await send(input, init);
    seen.retryAfter = response.status === 503 ? response.headers.get("Retry-After") : null;
    return response;
  };
  // An upload that landed is reported even if cancelled meanwhile, so the
  // caller can delete it; a cancelled one that didn't land just stops.
  let res = await personaCall<PersonaUploadResponse>("/uploads", { method: "POST", body }, noting);
  if (!res.ok && res.status === 503 && seen.retryAfter !== null && !signal?.aborted) {
    await wait(retryAfterMs(seen.retryAfter));
    if (signal?.aborted) return cancelled;
    res = await personaCall<PersonaUploadResponse>("/uploads", { method: "POST", body }, send);
  }
  if (res.ok && res.data?.attachment) return { ok: true, attachment: res.data.attachment };
  if (signal?.aborted) return cancelled;
  return { ok: false, error: res.ok ? "Upload failed: no attachment in the response" : uploadErrorMessage(file.name, res) };
}

/**
 * Deletes an upload the owner won't send, so the collector doesn't keep it.
 * Best effort: a 404 (already gone) or any failure is left alone.
 */
export async function discardPersonaUpload(attachmentId: string, fetchFn: FetchFn = fetch): Promise<void> {
  await personaCall(`/uploads/${encodeURIComponent(attachmentId)}`, { method: "DELETE" }, fetchFn);
}

/**
 * True when `src` serves its bytes: a one-byte range request answers 2xx.
 * Tells a video the browser can't decode (served fine) from one whose load
 * failed (any other status, or no answer).
 */
export async function sourceAnswers(src: string, fetchFn: FetchFn = fetch): Promise<boolean> {
  try {
    const res = await fetchFn(src, { method: "GET", headers: { Range: "bytes=0-0" } });
    void res.body?.cancel().catch(() => {});
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Why the composer offers no uploads on `thread`, or undefined where it does.
 * Uploads go only to private threads: what the owner sends in a shared or
 * external one, everyone there could see.
 */
export function uploadBlockedReason(thread: Pick<PersonaThread, "audience"> | undefined): string | undefined {
  return thread?.audience === "shared" || thread?.audience === "external"
    ? "Images and videos can only be sent in private threads"
    : undefined;
}

/** A video's length as m:ss, or h:mm:ss past an hour. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** A local object URL for `file`, where the browser can make one. */
export function createPreviewUrl(file: Blob): string | undefined {
  return typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : undefined;
}

export function revokePreviewUrl(url: string | undefined): void {
  if (url && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
}

/**
 * Local previews of sent attachments, by attachment id. A claimed attachment
 * is only served once the message carrying it lands, so a pending bubble shows
 * the owner's own copy; each URL is revoked once no unconfirmed send holds it.
 */
const sentPreviews = new Map<string, string>();

export function keepSentPreview(attachmentId: string, url: string): void {
  const prior = sentPreviews.get(attachmentId);
  if (prior && prior !== url) revokePreviewUrl(prior);
  sentPreviews.set(attachmentId, url);
}

export function sentPreviewUrl(attachmentId: string): string | undefined {
  return sentPreviews.get(attachmentId);
}

/** Revokes every kept preview whose attachment no pending send still carries. */
export function pruneSentPreviews(pendingIds: ReadonlySet<string>): void {
  for (const [id, url] of sentPreviews) {
    if (pendingIds.has(id)) continue;
    revokePreviewUrl(url);
    sentPreviews.delete(id);
  }
}
