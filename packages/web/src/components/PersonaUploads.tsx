import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { LuPaperclip, LuX } from "react-icons/lu";
import type { PersonaAttachment } from "@standup/shared";
import { PERSONA_ATTACHMENTS_PER_MESSAGE, isPersonaVideoMime } from "@standup/shared";
import { alpha, theme } from "./theme";
import {
  PERSONA_UPLOAD_ACCEPT,
  createPreviewUrl,
  discardPersonaUpload,
  formatDuration,
  formatMegabytes,
  revokePreviewUrl,
  sentPreviewUrl,
  uploadPersonaFile,
  uploadPrecheck,
  type UploadOutcome,
} from "../lib/personaUploads";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** One file in the composer's tray, from the moment it is added until the message is sent. */
export interface PendingUpload {
  key: string;
  name: string;
  /** The browser's `File.type`; empty when it couldn't tell. */
  mimeType: string;
  bytes: number;
  /** A local object URL of the file, owned by the tray until sent or removed. */
  previewUrl?: string;
  /** `queued` waits for the uploads added before it: one file is sent at a time. */
  status: "queued" | "uploading" | "ready" | "error";
  error?: string;
  /** The collector's record, once the upload is accepted. */
  attachment?: PersonaAttachment;
  /** The video's length as the browser read it from the local copy. */
  durationSec?: number;
}

/** Uploads one file; `signal` aborts it when its item is dropped. */
export type UploadFn = (file: File, threadId: string | undefined, signal?: AbortSignal) => Promise<UploadOutcome>;

const defaultUpload: UploadFn = (file, threadId, signal) => uploadPersonaFile(file, threadId, { signal });

let nextKey = 0;

/** True while an item hasn't finished uploading (queued or under way). */
export function isUploadPending(item: Pick<PendingUpload, "status">): boolean {
  return item.status === "queued" || item.status === "uploading";
}

/**
 * The composer's pending uploads. Accepted files upload one at a time, in the
 * order added: the gateway buffers each request body whole (twice, across its
 * two hops), so several large videos at once would exhaust its shared buffer.
 * One the pre-checks refuse stays in the tray as an error, never sent.
 * The tray is per thread (an upload may only be sent where it was made), so
 * switching threads empties it; `undefined` and `consoleThreadId` are the same
 * thread, so the console thread's id resolving on load keeps the tray. Object
 * URLs are revoked when an item is removed or discarded and on unmount; `take`
 * hands the ready items' URLs to the caller. An upload dropped unsent (removed,
 * cleared, or left behind on unmount) is deleted on the collector, including
 * one whose upload finishes after its item is gone.
 */
export function usePendingUploads(
  threadId: string | undefined,
  upload: UploadFn = defaultUpload,
  consoleThreadId?: string,
  discard: (attachmentId: string) => Promise<void> = discardPersonaUpload
) {
  const [items, setItems] = useState<PendingUpload[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  // Kept in step synchronously by every change, so two adds in one tick (a
  // paste and a drop) see each other: the items that hold a slot (uploading
  // or ready), every item's object URL, the collector's id for each finished
  // upload, and the in-flight uploads whose item is already gone.
  const live = useRef(new Set<string>());
  const urls = useRef(new Map<string, string>());
  const uploaded = useRef(new Map<string, string>());
  const abandoned = useRef(new Set<string>());
  const discardRef = useRef(discard);
  discardRef.current = discard;
  const uploadRef = useRef(upload);
  uploadRef.current = upload;
  // Files waiting their turn, oldest first, and the one uploading now (with
  // the controller that aborts it).
  const queue = useRef<{ key: string; file: File; threadId: string | undefined }[]>([]);
  const running = useRef<{ key: string; controller: AbortController } | null>(null);

  const update = useCallback((fn: (prev: PendingUpload[]) => PendingUpload[]) => setItems(fn), []);

  /** Starts the next queued upload, if none is under way. */
  const pump = useCallback(() => {
    if (running.current) return;
    const next = queue.current.shift();
    if (!next) return;
    const { key, file, threadId: target } = next;
    const controller = new AbortController();
    running.current = { key, controller };
    update((prev) => prev.map((i) => (i.key === key ? { ...i, status: "uploading" } : i)));
    void Promise.resolve()
      .then(() => uploadRef.current(file, target, controller.signal))
      .catch((err): UploadOutcome => ({ ok: false, error: `Upload failed: ${err instanceof Error ? err.message : String(err)}` }))
      .then((outcome) => {
        if (abandoned.current.delete(key)) {
          if (outcome.ok) void discardRef.current(outcome.attachment.id);
          return;
        }
        if (outcome.ok) uploaded.current.set(key, outcome.attachment.id);
        else live.current.delete(key);
        update((prev) =>
          prev.map((i) =>
            i.key !== key
              ? i
              : outcome.ok
              ? { ...i, status: "ready", attachment: outcome.attachment }
              : { ...i, status: "error", error: outcome.error }
          )
        );
      })
      .finally(() => {
        if (running.current?.key === key) running.current = null;
        pump();
      });
  }, [update]);

  /** Forgets one item: revokes its preview and deletes (or marks for deletion) its upload. */
  // The upload under way, when dropped, is aborted and frees the queue at
  // once rather than when (or if) its request settles; should it have landed
  // anyway, its late answer is still deleted. Callers pump afterwards.
  const drop = useCallback((key: string, sent = false) => {
    if (!sent) {
      revokePreviewUrl(urls.current.get(key));
      const id = uploaded.current.get(key);
      const waiting = queue.current.findIndex((q) => q.key === key);
      // A queued file was never sent: dropping it from the queue is enough.
      if (waiting !== -1) queue.current.splice(waiting, 1);
      else if (id) void discardRef.current(id);
      else if (live.current.has(key)) abandoned.current.add(key);
      if (running.current?.key === key) {
        running.current.controller.abort();
        running.current = null;
      }
    }
    urls.current.delete(key);
    uploaded.current.delete(key);
    live.current.delete(key);
  }, []);

  const releaseAll = useCallback(
    (sent?: ReadonlySet<string>) => {
      const keys = new Set([...urls.current.keys(), ...uploaded.current.keys(), ...live.current]);
      for (const key of keys) drop(key, sent?.has(key));
      queue.current = [];
    },
    [drop]
  );

  const add = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      let room = PERSONA_ATTACHMENTS_PER_MESSAGE - live.current.size;
      const added: PendingUpload[] = [];
      const skipped: string[] = [];
      for (const file of files) {
        const key = `u${++nextKey}`;
        const base = { key, name: file.name, mimeType: file.type, bytes: file.size };
        const refused = uploadPrecheck(file);
        if (refused) {
          added.push({ ...base, status: "error", error: refused });
          continue;
        }
        if (room <= 0) {
          skipped.push(file.name);
          continue;
        }
        room--;
        const previewUrl = createPreviewUrl(file);
        live.current.add(key);
        if (previewUrl) urls.current.set(key, previewUrl);
        added.push({ ...base, status: "queued", previewUrl });
        queue.current.push({ key, file, threadId });
      }
      setNotice(
        skipped.length > 0
          ? `A message can carry at most ${PERSONA_ATTACHMENTS_PER_MESSAGE} attachments — not added: ${skipped.join(", ")}`
          : null
      );
      if (added.length > 0) update((prev) => [...prev, ...added]);
      pump();
    },
    [threadId, update, pump]
  );

  const remove = useCallback(
    (key: string) => {
      drop(key);
      update((prev) => prev.filter((i) => i.key !== key));
      setNotice(null);
      pump();
    },
    [update, drop, pump]
  );

  const clear = useCallback(() => {
    releaseAll();
    update(() => []);
    setNotice(null);
  }, [update, releaseAll]);

  /** Empties the tray, returning the ready items; their uploads and preview URLs become the caller's. */
  const take = useCallback((): PendingUpload[] => {
    const ready = itemsRef.current.filter((i) => i.status === "ready" && i.attachment);
    releaseAll(new Set(ready.map((i) => i.key)));
    update(() => []);
    setNotice(null);
    return ready;
  }, [update, releaseAll]);

  const setDuration = useCallback(
    (key: string, seconds: number) => {
      if (!Number.isFinite(seconds)) return;
      update((prev) => prev.map((i) => (i.key === key && i.durationSec !== seconds ? { ...i, durationSec: seconds } : i)));
    },
    [update]
  );

  // Another thread's composer starts empty.
  const shownThread = useRef(threadId);
  useEffect(() => {
    const prev = shownThread.current;
    shownThread.current = threadId;
    const isConsole = (id: string | undefined) => id === undefined || id === consoleThreadId;
    if (prev === threadId || (isConsole(prev) && isConsole(threadId))) return;
    clear();
  }, [threadId, consoleThreadId, clear]);

  // Release everything on unmount. Deferred, and cancelled by a remount, so
  // React's development double-mount doesn't drop what the tray still shows.
  const revokeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    clearTimeout(revokeTimer.current);
    return () => {
      revokeTimer.current = setTimeout(() => releaseAll(), 0);
    };
  }, [releaseAll]);

  return { items, notice, setNotice, add, remove, clear, take, setDuration };
}

/** Markup that only wraps content, ignored when asking whether HTML is just an image. */
const HTML_WRAPPERS =
  /<!--[\s\S]*?-->|<!doctype[^>]*>|<meta\b[^>]*>|<\/?(?:html|head|body|div|span|p|a|picture|figure|source|br)\b[^>]*>/gi;

/** True for HTML that is a single `<img>`, as a browser's "Copy Image" writes it. */
export function isLoneImageHtml(html: string): boolean {
  const rest = html.replace(HTML_WRAPPERS, "").trim();
  return /^<img\b[^>]*>$/i.test(rest);
}

/** True for text that is one http(s) URL, as Firefox's "Copy Image" writes beside the image. */
export function isLoneUrl(text: string): boolean {
  return /^https?:\/\/\S+$/i.test(text.trim());
}

/**
 * What a paste should attach. A copied image comes with at most its URL as
 * text and a lone `<img>` as HTML, so its files are attached. A copy from a
 * spreadsheet, document or slide puts real text beside a rendered picture of
 * it: the owner is pasting words, so the text pastes and `textWon` says an
 * image was left out.
 */
export function pastedFiles(data: DataTransfer | null): { files: File[]; textWon: boolean } {
  const files = transferFiles(data);
  if (!data || files.length === 0) return { files: [], textWon: false };
  const read = (type: string) => (typeof data.getData === "function" ? data.getData(type) : "");
  const text = read("text/plain").trim();
  const html = read("text/html");
  const loneImage = html !== "" && isLoneImageHtml(html);
  // A URL alone is the image's address only when no HTML says otherwise (a
  // copied link to a page carries its own anchor markup).
  if (!text || loneImage || (isLoneUrl(text) && !html)) return { files, textWon: false };
  return { files: [], textWon: true };
}

export const PASTED_AS_TEXT = "Pasted as text — drag the image in or use the paperclip to attach it";

/** The files a paste or drop carries, if any. */
export function transferFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  if (data.files && data.files.length > 0) return Array.from(data.files);
  const files: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

/** True while a drag carries files (rather than text or a link). */
export function dragHasFiles(data: DataTransfer | null): boolean {
  return !!data && Array.from(data.types ?? []).includes("Files");
}

/** The paperclip and the hidden picker it opens. */
export function AttachButton({
  blockedReason,
  onFiles,
  onBlocked,
}: {
  /** Why uploads are off here; the button stays visible but inert, with this as its tooltip. */
  blockedReason?: string;
  onFiles: (files: File[]) => void;
  onBlocked: (reason: string) => void;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <button
        type="button"
        aria-label="Attach image or video"
        aria-disabled={blockedReason ? "true" : undefined}
        title={blockedReason ?? "Attach image or video"}
        data-testid="persona-attach"
        onClick={() => (blockedReason ? onBlocked(blockedReason) : input.current?.click())}
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 36,
          height: 36,
          borderRadius: 8,
          border: `1px solid ${theme.edge}`,
          background: theme.ground,
          color: blockedReason ? theme.faint : theme.dim,
          cursor: blockedReason ? "not-allowed" : "pointer",
          opacity: blockedReason ? 0.5 : 1,
        }}
      >
        <LuPaperclip size={16} aria-hidden />
      </button>
      <input
        ref={input}
        type="file"
        multiple
        accept={PERSONA_UPLOAD_ACCEPT}
        data-testid="persona-attach-input"
        aria-hidden
        tabIndex={-1}
        style={{ display: "none" }}
        onChange={(e) => {
          const files = Array.from(e.currentTarget.files ?? []);
          // Cleared so picking the same file again still fires a change.
          e.currentTarget.value = "";
          onFiles(files);
        }}
      />
    </>
  );
}

function useSpinner(active: boolean): string {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((t) => t + 1), 100);
    return () => clearInterval(id);
  }, [active]);
  return SPINNER[tick % SPINNER.length];
}

const THUMB = 56;

const thumbFrame: CSSProperties = {
  position: "relative",
  width: THUMB,
  height: THUMB,
  flexShrink: 0,
  borderRadius: 6,
  overflow: "hidden",
  border: `1px solid ${theme.edgeSoft}`,
  background: theme.ground,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: theme.faint,
  fontSize: 10,
  fontWeight: 700,
};

const coverMedia: CSSProperties = { width: "100%", height: "100%", objectFit: "cover", display: "block" };

/** A square preview of a local file: the image, or a muted video frame with a play glyph. */
function Thumbnail({
  name,
  mimeType,
  url,
  durationSec,
  onDuration,
}: {
  name: string;
  mimeType: string;
  url?: string;
  durationSec?: number;
  onDuration?: (seconds: number) => void;
}) {
  const video = isPersonaVideoMime(mimeType);
  let media: ReactNode;
  if (!url) {
    media = <span>{video ? "VIDEO" : "FILE"}</span>;
  } else if (video) {
    media = (
      <>
        <video
          src={url}
          muted
          playsInline
          preload="metadata"
          aria-label={name}
          onLoadedMetadata={(e) => onDuration?.(e.currentTarget.duration)}
          style={coverMedia}
        />
        {/* White on a dark shadow reads over any frame of the user's video, so it ignores the theme. */}
        <span
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
            fontSize: 16,
            textShadow: "0 1px 3px #000",
          }}
        >
          ▶
        </span>
      </>
    );
  } else {
    media = <img src={url} alt={name} style={coverMedia} />;
  }
  return (
    <div style={thumbFrame}>
      {media}
      {/* A dark caption over the user's video frame, so it ignores the theme. */}
      {video && durationSec !== undefined && (
        <span
          data-testid="persona-upload-duration"
          style={{
            position: "absolute",
            right: 3,
            bottom: 3,
            padding: "0 4px",
            borderRadius: 3,
            background: "#000000b0",
            color: "#fff",
            fontSize: 9.5,
            fontFamily: theme.mono,
          }}
        >
          {formatDuration(durationSec)}
        </span>
      )}
    </div>
  );
}

/** The pending uploads above the composer's input. */
export function UploadTray({
  items,
  onRemove,
  onDuration,
}: {
  items: PendingUpload[];
  onRemove: (key: string) => void;
  onDuration: (key: string, seconds: number) => void;
}) {
  const spinner = useSpinner(items.some((i) => i.status === "uploading"));
  if (items.length === 0) return null;
  return (
    <div role="list" aria-label="Attachments" data-testid="persona-upload-tray" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {items.map((item) => {
        const duration = item.attachment?.video?.durationSec ?? item.durationSec;
        const error = item.status === "error";
        return (
          <div
            key={item.key}
            role="listitem"
            data-testid="persona-upload"
            data-status={item.status}
            title={item.error ?? item.name}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              maxWidth: error ? 420 : 260,
              padding: 4,
              paddingRight: 6,
              borderRadius: 8,
              border: `1px solid ${error ? alpha(theme.waiting, 0x88) : theme.edge}`,
              background: error ? alpha(theme.waiting, 0x14) : theme.ground,
            }}
          >
            <Thumbnail
              name={item.name}
              mimeType={item.attachment?.mimeType ?? item.mimeType}
              url={item.previewUrl}
              durationSec={duration}
              onDuration={(s) => onDuration(item.key, s)}
            />
            <div style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
              <span
                style={{
                  fontSize: 12,
                  color: theme.text,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {item.name}
              </span>
              {item.status === "queued" && (
                <span data-testid="persona-upload-state" style={{ fontSize: 11, color: theme.faint }}>
                  Queued
                </span>
              )}
              {item.status === "uploading" && (
                <span data-testid="persona-upload-state" style={{ fontSize: 11, color: theme.dim }}>
                  <span style={{ fontFamily: theme.mono }}>{spinner}</span> Uploading…
                </span>
              )}
              {item.status === "ready" && (
                <span data-testid="persona-upload-state" style={{ fontSize: 11, color: theme.faint }}>
                  {formatMegabytes(item.attachment?.bytes ?? item.bytes)}
                </span>
              )}
              {error && (
                <span
                  data-testid="persona-upload-error"
                  role="alert"
                  style={{ fontSize: 11, color: theme.waiting, overflowWrap: "anywhere" }}
                >
                  {item.error}
                </span>
              )}
            </div>
            <button
              type="button"
              aria-label={`Remove ${item.name}`}
              onClick={() => onRemove(item.key)}
              style={{
                flexShrink: 0,
                alignSelf: "flex-start",
                display: "flex",
                padding: 2,
                border: "none",
                borderRadius: 4,
                background: "transparent",
                color: theme.dim,
                cursor: "pointer",
              }}
            >
              <LuX size={13} aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The attachments of a send the server hasn't confirmed: the owner's local
 * previews while they last, else a chip per file name.
 */
export function OutboxAttachments({ attachments }: { attachments: PersonaAttachment[] }) {
  return (
    <div data-testid="persona-outbox-attachments" style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
      {attachments.map((a) => {
        const url = sentPreviewUrl(a.id);
        return url ? (
          <div key={a.id} data-attachment-id={a.id} title={a.name}>
            <Thumbnail name={a.name} mimeType={a.mimeType} url={url} durationSec={a.video?.durationSec} />
          </div>
        ) : (
          <span
            key={a.id}
            data-attachment-id={a.id}
            style={{
              fontSize: 11.5,
              color: theme.dim,
              padding: "3px 8px",
              borderRadius: 10,
              border: `1px solid ${theme.edge}`,
              background: theme.ground,
            }}
          >
            {isPersonaVideoMime(a.mimeType) ? "▶ " : ""}
            {a.name}
          </span>
        );
      })}
    </div>
  );
}
