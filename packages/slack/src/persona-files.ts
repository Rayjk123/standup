// Files a Persona user shares in their DM with the app, on their way to
// Persona: Slack's file objects normalized, checked against what Persona
// accepts before anything is downloaded, and fetched from Slack with the bot
// token.
//
// The token goes only to Slack: a download URL (and every redirect it takes)
// must be https on slack.com or a subdomain, or it is refused before a request
// carries the token. The body is streamed under a hard byte cap. Slack answers
// a token that lacks `files:read` with its HTML sign-in page rather than an
// error, so an HTML body reads as the missing scope (a file declared as HTML
// is refused before it is fetched).

import {
  PERSONA_ATTACHMENT_MAX_BYTES,
  PERSONA_UPLOAD_IMAGE_MIMES,
  PERSONA_UPLOAD_VIDEO_MIMES,
  PERSONA_VIDEO_MAX_BYTES,
  isPersonaImageMime,
  isPersonaVideoMime,
  type PersonaMediaMime,
} from "@standup/shared";

/** A file attached to an inbound Slack message, as the bridge uses it. */
export interface InboundSlackFile {
  id: string;
  name: string;
  /** Slack's declared media type, when it gave one. */
  mimetype?: string;
  /** Slack's short type name (`heic`, `pdf`, …), used to name an unsupported type. */
  filetype?: string;
  size?: number;
  urlPrivateDownload?: string;
  urlPrivate?: string;
  /** `check_file_info`: the event carried only the id; files.info has the rest. */
  fileAccess?: string;
  /** `hosted`, `external` (a link to another service), `tombstone` (deleted), `hidden_by_limit`. */
  mode?: string;
}

/** Most redirects a download follows. */
const MAX_REDIRECTS = 3;
/** How long one download may take, redirects included. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** What the owner sees for each type Persona takes, in the order they're listed. */
const MEDIA_LABELS: Record<PersonaMediaMime, string> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/gif": "GIF",
  "image/webp": "WebP",
  "video/mp4": "MP4",
  "video/quicktime": "MOV",
  "video/webm": "WebM",
};

/** "PNG, JPEG, GIF, WebP, MP4, MOV or WebM". */
export function acceptedTypesText(): string {
  const labels = [...PERSONA_UPLOAD_IMAGE_MIMES, ...PERSONA_UPLOAD_VIDEO_MIMES].map((m) => MEDIA_LABELS[m]);
  return `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/** One Slack file object (snake_case, as events and files.info carry it), or undefined without an id. */
export function inboundSlackFile(raw: unknown): InboundSlackFile | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const f = raw as Record<string, unknown>;
  const id = str(f.id);
  if (!id) return undefined;
  const size = typeof f.size === "number" && Number.isFinite(f.size) && f.size >= 0 ? f.size : undefined;
  const out: InboundSlackFile = { id, name: str(f.name) ?? str(f.title) ?? id };
  const fields: [keyof InboundSlackFile, string | undefined][] = [
    ["mimetype", str(f.mimetype)],
    ["filetype", str(f.filetype)],
    ["urlPrivateDownload", str(f.url_private_download)],
    ["urlPrivate", str(f.url_private)],
    ["fileAccess", str(f.file_access)],
    ["mode", str(f.mode)],
  ];
  for (const [k, v] of fields) if (v) (out as unknown as Record<string, string>)[k] = v;
  if (size !== undefined) out.size = size;
  return out;
}

/** A message's `files` array normalized; anything that isn't a file object is dropped. */
export function inboundSlackFiles(raw: unknown): InboundSlackFile[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(inboundSlackFile).filter((f): f is InboundSlackFile => !!f);
}

/** Whether the event left the file's details to files.info. */
export function needsFileInfo(f: InboundSlackFile): boolean {
  return f.fileAccess === "check_file_info" || (!f.urlPrivateDownload && !f.urlPrivate && f.mode !== "external");
}

/** The media type to declare upstream: Slack's, when it is one Persona takes. */
export function acceptedMime(f: InboundSlackFile): PersonaMediaMime | undefined {
  const m = f.mimetype?.toLowerCase();
  if (!m) return undefined;
  return isPersonaImageMime(m) || isPersonaVideoMime(m) ? m : undefined;
}

/** Whether Slack's declared type says nothing about the content. */
function uninformativeMime(m: string | undefined): boolean {
  return !m || m === "application/octet-stream" || m === "binary/octet-stream";
}

/** The most bytes the file may have: its type's cap, or the larger (video) cap when the type is unknown. */
export function byteCapFor(f: InboundSlackFile): number {
  const m = acceptedMime(f);
  return m && isPersonaImageMime(m) ? PERSONA_ATTACHMENT_MAX_BYTES : PERSONA_VIDEO_MAX_BYTES;
}

/** Bytes as "62.0 MB" (MiB, one decimal). */
export function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A cap as "50 MB". */
function capMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** How to name a type Persona doesn't take: Slack's short type, else the media subtype. */
function typeLabel(f: InboundSlackFile): string {
  const short = f.filetype && f.filetype !== "binary" ? f.filetype : f.mimetype?.split("/")[1]?.replace(/^x-/, "");
  return short ? short.toUpperCase() : "That file type";
}

/**
 * Why the file can't go to Persona, judged from Slack's metadata alone (so
 * nothing is downloaded for it), or undefined when it's worth fetching. An
 * unknown or generic type is fetched: the collector decides from the bytes.
 */
export function precheckFile(f: InboundSlackFile): string | undefined {
  if (f.mode === "external") return "it's a link to a file stored outside Slack — attach the file itself";
  if (f.mode === "tombstone") return "it was deleted from Slack";
  if (f.mode === "hidden_by_limit") return "Slack is hiding it (this workspace's file storage limit)";
  const declared = f.mimetype?.toLowerCase();
  const mime = acceptedMime(f);
  if (!mime && !uninformativeMime(declared)) return `${typeLabel(f)} isn't supported — send ${acceptedTypesText()}`;
  if (f.size !== undefined) {
    const cap = byteCapFor(f);
    if (f.size > cap) {
      const kind = mime && isPersonaImageMime(mime) ? "images" : "videos";
      return `it's ${formatMb(f.size)}; ${kind} can be at most ${capMb(cap)}`;
    }
    if (f.size === 0) return "it's empty";
  }
  return undefined;
}

/**
 * What went wrong fetching a file from Slack. `scope` is an HTML answer:
 * precheckFile never fetches a file declared as HTML, so a page in place of
 * the file is Slack's sign-in page for a token without files:read.
 */
export type SlackDownloadFailure = "scope" | "refused" | "too_large" | "failed";

export class SlackDownloadError extends Error {
  constructor(
    readonly kind: SlackDownloadFailure,
    message: string,
  ) {
    super(message);
    this.name = "SlackDownloadError";
  }
}

/** Fetches a Slack file's bytes with the bot token, at most `maxBytes` of them. */
export type SlackFileDownloader = (url: string, opts: { token: string; maxBytes: number }) => Promise<Uint8Array>;

/** Whether `url` is https on slack.com or one of its subdomains — the only place the bot token is sent. */
export function isSlackFileUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "slack.com" || u.hostname.endsWith(".slack.com")) && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** Read `res`'s body, aborting once it passes `maxBytes`. */
async function readCapped(res: Response, maxBytes: number, abort: () => void): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    abort();
    throw new SlackDownloadError("too_large", `it's ${formatMb(declared)}, over the ${capMb(maxBytes)} limit`);
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      abort();
      throw new SlackDownloadError("too_large", `it's over the ${capMb(maxBytes)} limit`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * Download a Slack file with `Authorization: Bearer <token>`. Redirects are
 * followed by hand (at most MAX_REDIRECTS) and only to Slack hosts, so the
 * token never leaves Slack. Throws SlackDownloadError: `refused` for a
 * non-Slack URL or redirect, `scope` for an HTML answer (Slack's sign-in
 * page: the token lacks files:read), `too_large` past `maxBytes`, `failed`
 * otherwise.
 */
export async function downloadSlackFile(
  url: string,
  opts: { token: string; maxBytes: number },
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    let current = url;
    for (let hop = 0; ; hop++) {
      if (!isSlackFileUrl(current)) {
        throw new SlackDownloadError("refused", hop === 0 ? "its link isn't a Slack file URL" : "Slack redirected the download away from Slack");
      }
      let res: Response;
      try {
        res = await fetchImpl(current, {
          headers: { authorization: `Bearer ${opts.token}` },
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (err) {
        throw new SlackDownloadError("failed", controller.signal.aborted ? "the download timed out" : `the download failed (${err instanceof Error ? err.message : String(err)})`);
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        await res.body?.cancel().catch(() => {});
        if (!location) throw new SlackDownloadError("failed", `Slack answered HTTP ${res.status} with nowhere to go`);
        if (hop >= MAX_REDIRECTS) throw new SlackDownloadError("failed", "Slack redirected the download too many times");
        try {
          current = new URL(location, current).toString();
        } catch {
          throw new SlackDownloadError("refused", "Slack redirected the download away from Slack");
        }
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new SlackDownloadError("failed", `Slack answered HTTP ${res.status}`);
      }
      if ((res.headers.get("content-type") ?? "").toLowerCase().startsWith("text/html")) {
        await res.body?.cancel().catch(() => {});
        throw new SlackDownloadError("scope", "Slack served its sign-in page instead of the file");
      }
      return await readCapped(res, opts.maxBytes, () => controller.abort());
    }
  } finally {
    clearTimeout(timer);
  }
}
