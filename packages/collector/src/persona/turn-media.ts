import type { Database } from "bun:sqlite";
import { statSync } from "fs";
import type { PersonaAttachmentMime } from "@standup/shared";
import { isPersonaImageMime, isPersonaVideoMime } from "@standup/shared";
import { getPersonaAttachment, isOwnerUpload } from "@standup/store";
import type { PersonaAttachmentRecord, PersonaInboxItem } from "@standup/store";
import { readStoredAttachment, storedAttachmentPath } from "./attachments.js";
import { formatMediaSize, originalShowable } from "./media.js";
import { attachmentLabel, frameLabel, promptSafeName } from "./prompt.js";
import type { PromptAttachment } from "./prompt.js";
import type { TurnImage } from "./turn.js";

/** Most images (uploaded images and video frames together) one turn shows Persona. */
export const MAX_TURN_IMAGES = 20;
/** Most base64 characters of image data one turn sends, well inside the API's request size limit. */
export const MAX_TURN_IMAGE_BASE64_BYTES = 20 * 1024 * 1024;
/**
 * How long a session's image count is kept after its last update even when
 * nothing names the session (a turn in progress may not have stored it yet).
 */
export const SESSION_IMAGES_PRUNE_GRACE_MS = 15 * 60 * 1000;

/** The base64 characters of `images` in all. */
export function base64BytesOf(images: readonly TurnImage[]): number {
  return images.reduce((n, image) => n + image.base64.length, 0);
}

const NOT_SHOWABLE_NOTE = "too large to show Persona";

/** What a turn shows Persona of its owner messages' media. */
export interface TurnMedia {
  /** Each owner message's attachments, by message id, for the prompt. */
  byMessage: Map<string, PromptAttachment[]>;
  /** The image blocks, in message then attachment order, each labeled as the prompt names it. */
  images: TurnImage[];
}

export interface TurnMediaLimits {
  /** The turn's own image cap (default MAX_TURN_IMAGES). */
  maxImages?: number;
  /** The turn's own base64 cap (default MAX_TURN_IMAGE_BASE64_BYTES). */
  maxBase64Bytes?: number;
  /** The session's image budget, when it is tighter than the turn's cap. */
  sessionImageBudget?: number;
  /** The session's base64 budget, when it is tighter than the turn's cap. */
  sessionImageBytesBudget?: number;
}

/** What is left of a turn's image allowance as blocks are added. */
interface Allowance {
  images: number;
  base64Bytes: number;
  /** Says which limit ran out, for an attachment shown in part or not at all. */
  note(): string;
}

function base64Of(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/** The base64 length of a `size`-byte file. */
function base64Length(size: number): number {
  return 4 * Math.ceil(size / 3);
}

/** The allowance a turn starts with: the tighter of its own caps and the session's budgets, naming whichever applies. */
function allowanceFor(limits: TurnMediaLimits): Allowance {
  const turnImages = limits.maxImages ?? MAX_TURN_IMAGES;
  const turnBytes = limits.maxBase64Bytes ?? MAX_TURN_IMAGE_BASE64_BYTES;
  const sessionImages = limits.sessionImageBudget ?? Number.POSITIVE_INFINITY;
  const sessionBytes = limits.sessionImageBytesBudget ?? Number.POSITIVE_INFINITY;
  const images = Math.min(turnImages, sessionImages);
  const bytes = Math.min(turnBytes, sessionBytes);
  return {
    images,
    base64Bytes: bytes,
    note() {
      if (this.images <= 0) {
        return sessionImages < turnImages
          ? `over the session budget of ${sessionImages} image${sessionImages === 1 ? "" : "s"}`
          : `over the ${turnImages}-image limit for one turn`;
      }
      return sessionBytes < turnBytes
        ? `over the session budget of ${formatMediaSize(sessionBytes)} of images`
        : `over the ${formatMediaSize(turnBytes)} image limit for one turn`;
    },
  };
}

/**
 * The media on a turn's owner messages: for each `user_message` item, the
 * uploads its message claimed (each must be `owner`'s, of `threadId`, carried
 * by that very message), read back through their verified stored copies. An
 * image shows as one block (its model copy when it has one), a video as its
 * frames, within the turn's caps and the session's budgets; what can't be
 * shown says why. A thread that isn't private shows no owner uploads at all
 * (one widened from a DM after its uploads were sent).
 */
export function collectTurnMedia(
  opts: {
    db: Database;
    dataDir: string;
    owner: string;
    threadId: string;
    /** Whether only the owner reads the turn's thread. */
    privateThread: boolean;
    items: readonly PersonaInboxItem[];
  } & TurnMediaLimits
): TurnMedia {
  const allowance = allowanceFor(opts);
  const byMessage = new Map<string, PromptAttachment[]>();
  const images: TurnImage[] = [];
  for (const item of opts.items) {
    if (item.kind !== "user_message") continue;
    const messageId = item.payload.messageId;
    const ids = item.payload.attachmentIds;
    if (typeof messageId !== "string" || !Array.isArray(ids)) continue;
    if (!opts.privateThread) {
      if (ids.length > 0) {
        console.warn(`[persona] withheld ${ids.length} owner upload(s) of message ${messageId}: thread ${opts.threadId} isn't private`);
      }
      continue;
    }
    const list: PromptAttachment[] = [];
    for (const id of ids) {
      if (typeof id !== "string") continue;
      const record = getPersonaAttachment(opts.db, id);
      if (
        !record ||
        record.owner !== opts.owner ||
        record.threadId !== opts.threadId ||
        record.messageId !== messageId ||
        !isOwnerUpload(record)
      ) {
        continue;
      }
      const shown = describeAttachment(record, list.length + 1, messageId, opts.dataDir, allowance);
      list.push(shown.attachment);
      images.push(...shown.images);
    }
    if (list.length > 0) byMessage.set(messageId, list);
  }
  return { byMessage, images };
}

/** `media` with no image blocks: each attachment is listed as not shown, saying `reason`. */
export function withoutImages(media: TurnMedia, reason: string): TurnMedia {
  const byMessage = new Map<string, PromptAttachment[]>();
  for (const [messageId, list] of media.byMessage) {
    byMessage.set(
      messageId,
      list.map((a) => (a.shown.length > 0 ? { ...a, shown: [], note: reason } : a))
    );
  }
  return { byMessage, images: [] };
}

type BlockOutcome = { block: TurnImage } | { missing: true } | { limited: true };

/**
 * One block of the stored copy `sha256`, labeled `label`, when the allowance
 * has room for it, taken from the allowance. The room is checked from the
 * file's size before anything is read or hashed.
 */
function takeBlock(
  allowance: Allowance,
  dataDir: string,
  source: { sha256: string; mimeType: PersonaAttachmentMime },
  label: string
): BlockOutcome {
  if (allowance.images <= 0) return { limited: true };
  let size: number;
  try {
    size = statSync(storedAttachmentPath(dataDir, source.sha256, source.mimeType)).size;
  } catch {
    return { missing: true };
  }
  if (base64Length(size) > allowance.base64Bytes) return { limited: true };
  const bytes = readStoredAttachment(dataDir, source.sha256, source.mimeType);
  if (!bytes) return { missing: true };
  const base64 = base64Of(bytes);
  if (base64.length > allowance.base64Bytes) return { limited: true };
  allowance.images--;
  allowance.base64Bytes -= base64.length;
  return { block: { mimeType: source.mimeType, base64, label } };
}

function describeAttachment(
  record: PersonaAttachmentRecord,
  index: number,
  messageId: string,
  dataDir: string,
  allowance: Allowance
): { attachment: PromptAttachment; images: TurnImage[] } {
  const media = record.media;
  const base: PromptAttachment = {
    index,
    id: record.id,
    kind: isPersonaVideoMime(record.mimeType) ? "video" : "image",
    name: record.name,
    mimeType: record.mimeType,
    bytes: record.bytes,
    ...(media?.durationSec !== undefined ? { durationSec: media.durationSec } : {}),
    path: storedAttachmentPath(dataDir, record.sha256, record.mimeType),
    shown: [],
  };
  if (base.kind === "image") {
    if (!isPersonaImageMime(record.mimeType)) return { attachment: { ...base, note: "unsupported type" }, images: [] };
    const dims = media?.width && media.height ? { width: media.width, height: media.height } : null;
    const source: { sha256: string; mimeType: PersonaAttachmentMime } | null = media?.modelCopy
      ? media.modelCopy
      : originalShowable(record.bytes, dims)
        ? { sha256: record.sha256, mimeType: record.mimeType }
        : null;
    if (!source) return { attachment: { ...base, note: media?.note ?? NOT_SHOWABLE_NOTE }, images: [] };
    const label = attachmentLabel(messageId, index, promptSafeName(record.name));
    const taken = takeBlock(allowance, dataDir, source, label);
    if ("missing" in taken) return { attachment: { ...base, note: "its stored copy is missing" }, images: [] };
    if ("limited" in taken) return { attachment: { ...base, note: allowance.note() }, images: [] };
    return { attachment: { ...base, shown: [label] }, images: [taken.block] };
  }
  const frames = media?.frames ?? [];
  const attachment: PromptAttachment = { ...base, frameCount: frames.length };
  if (frames.length === 0) return { attachment: { ...attachment, note: media?.note ?? "no frames could be extracted" }, images: [] };
  const images: TurnImage[] = [];
  let missing = 0;
  let limited = false;
  for (const [k, frame] of frames.entries()) {
    const label = attachmentLabel(messageId, index, frameLabel(k + 1, frames.length, frame.atSec));
    const taken = takeBlock(allowance, dataDir, { sha256: frame.sha256, mimeType: "image/jpeg" }, label);
    if ("missing" in taken) {
      missing++;
      continue;
    }
    if ("limited" in taken) {
      limited = true;
      break;
    }
    images.push(taken.block);
  }
  const notes = [
    ...(media?.note ? [media.note] : []),
    ...(missing > 0 ? [`${missing} stored frame${missing === 1 ? " is" : "s are"} missing`] : []),
    ...(limited ? [images.length > 0 ? `the rest are ${allowance.note()}` : allowance.note()] : []),
  ];
  return {
    attachment: { ...attachment, shown: images.map((i) => i.label), ...(notes.length > 0 ? { note: notes.join("; ") } : {}) },
    images,
  };
}
