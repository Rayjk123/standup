import { describe, expect, test } from "bun:test";
import { createStore } from "../store.js";
import {
  appendPersonaMessage,
  getOrCreatePersonaConsoleThread,
  getOrCreatePersonaState,
  updatePersonaState,
  getOrCreatePersonaThreadByRef,
  getPersonaAttachment,
  getPersonaMessage,
  isOwnerUpload,
  isPersonaAttachmentFileReferenced,
  listPersonaMessages,
  OWNER_UPLOAD_BATCH_PREFIX,
  addPersonaSessionImages,
  carryPersonaSessionImages,
  deleteUnsentOwnerUpload,
  findPersonaMediaShare,
  launchShareKey,
  recordPersonaMediaShares,
  personaSessionImages,
  prunePersonaSessionImages,
  pruneStaleOwnerUploads,
  PersonaAttachmentCapError,
  personaAttachmentPoster,
  publicPersonaAttachment,
  unsentOwnerUploadBytes,
  stageOwnerUpload,
  stagePersonaAttachment,
  stagedPersonaAttachments,
} from "../index.js";

function setUp() {
  const { db } = createStore();
  const thread = getOrCreatePersonaConsoleThread(db, "me");
  const other = getOrCreatePersonaThreadByRef(db, "me", "slack", "C1:1.0", "t", "shared");
  const stage = (sha: string, extra: { threadId?: string; batchKey?: string; caption?: string } = {}) =>
    stagePersonaAttachment(db, {
      owner: "me",
      threadId: extra.threadId ?? thread.id,
      batchKey: extra.batchKey ?? "batch-1",
      sha256: sha.padEnd(64, "0"),
      mimeType: "image/png",
      bytes: 100,
      name: `${sha}.png`,
      ...(extra.caption !== undefined ? { caption: extra.caption } : {}),
    });
  return { db, thread, other, stage };
}

describe("persona attachments", () => {
  test("staging records the image for its turn; the same image again in the turn is the same row", () => {
    const h = setUp();
    const first = h.stage("a", { caption: "first" });
    expect(first.created).toBe(true);
    expect(first.attachment).toMatchObject({
      owner: "me",
      threadId: h.thread.id,
      batchKey: "batch-1",
      mimeType: "image/png",
      bytes: 100,
      name: "a.png",
      caption: "first",
    });
    expect(first.attachment.messageId).toBeUndefined();
    const again = h.stage("a", { caption: "better caption" });
    expect(again.created).toBe(false);
    expect(again.attachment.id).toBe(first.attachment.id);
    expect(again.attachment.caption).toBe("better caption");
    // Another turn, or another thread, stages its own row.
    expect(h.stage("a", { batchKey: "batch-2" }).created).toBe(true);
    expect(h.stage("a", { threadId: h.other.id }).created).toBe(true);
    expect(stagedPersonaAttachments(h.db, h.thread.id, "batch-1").map((a) => a.id)).toEqual([first.attachment.id]);
  });

  test("a message claims its staged images in the given order and carries their public fields", () => {
    const h = setUp();
    const a = h.stage("a", { caption: "A" }).attachment;
    const b = h.stage("b").attachment;
    const { message } = appendPersonaMessage(h.db, { threadId: h.thread.id, role: "persona", text: "see", attachmentIds: [b.id, a.id] });
    expect(message.attachments).toEqual([
      { id: b.id, mimeType: "image/png", bytes: 100, name: "b.png" },
      { id: a.id, mimeType: "image/png", bytes: 100, name: "a.png", caption: "A" },
    ]);
    expect(getPersonaAttachment(h.db, a.id)!.messageId).toBe(message.id);
    expect(stagedPersonaAttachments(h.db, h.thread.id, "batch-1")).toEqual([]);
    expect(getPersonaMessage(h.db, message.id)!.attachments).toHaveLength(2);
    expect(listPersonaMessages(h.db, h.thread.id).find((m) => m.id === message.id)!.attachments).toHaveLength(2);
    // No sha256, owner or batch key leaks onto the message.
    expect(JSON.stringify(message.attachments)).not.toContain("0000");
  });

  test("an image rides on one message only, and never on another thread's", () => {
    const h = setUp();
    const a = h.stage("a").attachment;
    const elsewhere = h.stage("x", { threadId: h.other.id }).attachment;
    const first = appendPersonaMessage(h.db, { threadId: h.thread.id, role: "persona", text: "1", attachmentIds: [a.id, elsewhere.id, "nope"] });
    expect(first.message.attachments?.map((x) => x.id)).toEqual([a.id]);
    const second = appendPersonaMessage(h.db, { threadId: h.thread.id, role: "persona", text: "2", attachmentIds: [a.id] });
    expect(second.message.attachments).toBeUndefined();
    expect(getPersonaAttachment(h.db, elsewhere.id)!.messageId).toBeUndefined();
  });

  test("an owner upload is staged apart from every turn and only a user message claims it", () => {
    const h = setUp();
    const upload = stageOwnerUpload(h.db, {
      owner: "me",
      threadId: h.thread.id,
      sha256: "c".repeat(64),
      mimeType: "video/mp4",
      bytes: 2048,
      name: "clip.mp4",
      media: {
        durationSec: 12.5,
        frames: [{ sha256: "d".repeat(64), mimeType: "image/jpeg", atSec: 1.25 }],
      },
    });
    expect(upload.batchKey.startsWith(OWNER_UPLOAD_BATCH_PREFIX)).toBe(true);
    expect(isOwnerUpload(upload)).toBe(true);
    expect(getPersonaAttachment(h.db, upload.id)!.media?.frames).toHaveLength(1);
    const persona = h.stage("p").attachment;
    expect(isOwnerUpload(persona)).toBe(false);
    // Persona's reply cannot carry the owner's upload; the owner's message cannot carry Persona's row.
    const reply = appendPersonaMessage(h.db, { threadId: h.thread.id, role: "persona", text: "r", attachmentIds: [upload.id] });
    expect(reply.message.attachments).toBeUndefined();
    const sent = appendPersonaMessage(h.db, { threadId: h.thread.id, role: "user", text: "", attachmentIds: [persona.id, upload.id] });
    expect(sent.message.attachments).toEqual([
      { id: upload.id, mimeType: "video/mp4", bytes: 2048, name: "clip.mp4", video: { durationSec: 12.5, frames: 1, poster: true } },
    ]);
    expect(getPersonaAttachment(h.db, persona.id)!.messageId).toBeUndefined();
  });

  test("publicPersonaAttachment describes what Persona saw of a video", () => {
    const h = setUp();
    const cases: Array<{ media?: Parameters<typeof stageOwnerUpload>[1]["media"]; mime: "video/webm" | "image/png"; want: unknown }> = [
      { mime: "video/webm", want: { frames: 0 } },
      { mime: "video/webm", media: { note: "no ffmpeg" }, want: { frames: 0, note: "no ffmpeg" } },
      { mime: "video/webm", media: { poster: { sha256: "f".repeat(64), mimeType: "image/jpeg" } }, want: { frames: 0, poster: true } },
      { mime: "image/png", media: { width: 10, height: 10 }, want: undefined },
    ];
    for (const c of cases) {
      const r = stageOwnerUpload(h.db, { owner: "me", threadId: h.thread.id, sha256: "e".repeat(64), mimeType: c.mime, bytes: 1, name: "x", ...(c.media ? { media: c.media } : {}) });
      expect(publicPersonaAttachment(r).video).toEqual(c.want as never);
    }
  });

  test("a video Persona stages keeps its media; its poster is the poster, an upload's is its first frame", () => {
    const h = setUp();
    const poster = { sha256: "9".repeat(64), mimeType: "image/jpeg" as const };
    const { attachment: video } = stagePersonaAttachment(h.db, {
      owner: "me",
      threadId: h.thread.id,
      batchKey: "batch-v",
      sha256: "8".repeat(64),
      mimeType: "video/mp4",
      bytes: 4096,
      name: "flow.mp4",
      media: { durationSec: 4, poster },
    });
    expect(getPersonaAttachment(h.db, video.id)!.media).toEqual({ durationSec: 4, poster });
    expect(isPersonaAttachmentFileReferenced(h.db, poster.sha256)).toBe(true);
    const upload = stageOwnerUpload(h.db, {
      owner: "me",
      threadId: h.thread.id,
      sha256: "7".repeat(64),
      mimeType: "video/webm",
      bytes: 1,
      name: "x.webm",
      media: { frames: [{ sha256: "6".repeat(64), mimeType: "image/jpeg", atSec: 0.5 }, { sha256: "5".repeat(64), mimeType: "image/jpeg", atSec: 1.5 }] },
    });
    const cases: Array<{ label: string; record: Parameters<typeof personaAttachmentPoster>[0]; want: ReturnType<typeof personaAttachmentPoster> }> = [
      { label: "Persona's video", record: video, want: poster },
      { label: "an upload's first frame", record: upload, want: { sha256: "6".repeat(64), mimeType: "image/jpeg" } },
      { label: "a video with neither", record: { mimeType: "video/webm" }, want: undefined },
      { label: "an image never has one", record: { mimeType: "image/png", media: { poster } }, want: undefined },
    ];
    for (const c of cases) expect({ label: c.label, poster: personaAttachmentPoster(c.record) }).toEqual({ label: c.label, poster: c.want });
    // maxOfKind counts only the same kind, and a re-stage of the same bytes still dedupes.
    const again = { owner: "me", threadId: h.thread.id, batchKey: "batch-v", mimeType: "video/webm" as const, bytes: 1, name: "b.webm", maxOfKind: 1 };
    expect(() => stagePersonaAttachment(h.db, { ...again, sha256: "4".repeat(64) })).toThrow(PersonaAttachmentCapError);
    expect(stagePersonaAttachment(h.db, { ...again, sha256: "8".repeat(64) }).created).toBe(false);
    const image = { owner: "me", threadId: h.thread.id, batchKey: "batch-v", mimeType: "image/png" as const, bytes: 1, name: "x.png", maxOfKind: 1 };
    expect(stagePersonaAttachment(h.db, { ...image, sha256: "3".repeat(64) }).created).toBe(true);
    expect(() => stagePersonaAttachment(h.db, { ...image, sha256: "2".repeat(64) })).toThrow(PersonaAttachmentCapError);
    const reply = appendPersonaMessage(h.db, { threadId: h.thread.id, role: "persona", text: "r", attachmentIds: [video.id] });
    expect(reply.message.attachments).toEqual([
      { id: video.id, mimeType: "video/mp4", bytes: 4096, name: "flow.mp4", video: { durationSec: 4, frames: 0, poster: true } },
    ]);
  });

  test("stale unsent owner uploads are pruned; sent ones, fresh ones, others' and Persona's rows stay", () => {
    const h = setUp();
    const upload = (owner: string, sha: string, media?: Parameters<typeof stageOwnerUpload>[1]["media"]) =>
      stageOwnerUpload(h.db, { owner, threadId: h.thread.id, sha256: sha.repeat(64), mimeType: "image/png", bytes: 1, name: "x.png", ...(media ? { media } : {}) });
    const stale = upload("me", "a", { modelCopy: { sha256: "f".repeat(64), mimeType: "image/jpeg" } });
    const sent = upload("me", "b");
    const fresh = upload("me", "c");
    const others = upload("you", "d");
    const persona = h.stage("e").attachment;
    appendPersonaMessage(h.db, { threadId: h.thread.id, role: "user", text: "x", attachmentIds: [sent.id] });
    for (const id of [stale.id, sent.id, others.id, persona.id]) {
      h.db.run("UPDATE persona_attachments SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?", [id]);
    }
    expect(isPersonaAttachmentFileReferenced(h.db, "f".repeat(64))).toBe(true);
    const pruned = pruneStaleOwnerUploads(h.db, "me", "2026-06-01T00:00:00.000Z");
    expect(pruned.map((r) => r.id)).toEqual([stale.id]);
    expect(getPersonaAttachment(h.db, stale.id)).toBeNull();
    for (const id of [sent.id, fresh.id, others.id, persona.id]) expect(getPersonaAttachment(h.db, id)).not.toBeNull();
    expect(isPersonaAttachmentFileReferenced(h.db, "a".repeat(64))).toBe(false);
    expect(isPersonaAttachmentFileReferenced(h.db, "f".repeat(64))).toBe(false);
    expect(isPersonaAttachmentFileReferenced(h.db, "b".repeat(64))).toBe(true);
  });

  test("unsent upload bytes count only the owner's unclaimed uploads", () => {
    const h = setUp();
    const up = (owner: string, bytes: number) =>
      stageOwnerUpload(h.db, { owner, threadId: h.thread.id, sha256: "a".repeat(64), mimeType: "image/png", bytes, name: "x.png" });
    up("me", 100);
    const sent = up("me", 50);
    up("you", 1000);
    h.stage("p");
    appendPersonaMessage(h.db, { threadId: h.thread.id, role: "user", text: "x", attachmentIds: [sent.id] });
    expect(unsentOwnerUploadBytes(h.db, "me")).toBe(100);
    expect(unsentOwnerUploadBytes(h.db, "nobody")).toBe(0);
  });

  test("only the owner's own unsent upload can be deleted", () => {
    const h = setUp();
    const up = (owner: string) =>
      stageOwnerUpload(h.db, { owner, threadId: h.thread.id, sha256: "a".repeat(64), mimeType: "image/png", bytes: 1, name: "x.png" });
    const mine = up("me");
    const sent = up("me");
    const theirs = up("you");
    const persona = h.stage("p").attachment;
    appendPersonaMessage(h.db, { threadId: h.thread.id, role: "user", text: "x", attachmentIds: [sent.id] });
    for (const id of [sent.id, theirs.id, persona.id, "nope"]) expect(deleteUnsentOwnerUpload(h.db, "me", id)).toBeNull();
    expect(deleteUnsentOwnerUpload(h.db, "me", mine.id)?.id).toBe(mine.id);
    expect(getPersonaAttachment(h.db, mine.id)).toBeNull();
    for (const id of [sent.id, theirs.id, persona.id]) expect(getPersonaAttachment(h.db, id)).not.toBeNull();
  });

  test("session image counts accumulate per session", () => {
    const h = setUp();
    expect(personaSessionImages(h.db, "s1")).toEqual({ images: 0, base64Bytes: 0 });
    addPersonaSessionImages(h.db, "s1", 3, 300);
    addPersonaSessionImages(h.db, "s1", 2, 50);
    addPersonaSessionImages(h.db, "s2", 0, 10);
    expect(personaSessionImages(h.db, "s1")).toEqual({ images: 5, base64Bytes: 350 });
    expect(personaSessionImages(h.db, "s2")).toEqual({ images: 0, base64Bytes: 0 });
  });

  test("counts of sessions nothing names any more are pruned", () => {
    const h = setUp();
    h.db.run("UPDATE persona_threads SET claude_session_id = 'thread-s' WHERE id = ?", [h.thread.id]);
    getOrCreatePersonaState(h.db, "me");
    updatePersonaState(h.db, "me", { claudeSessionId: "main-s" });
    for (const s of ["thread-s", "main-s", "kept", "gone"]) addPersonaSessionImages(h.db, s, 1, 1);
    // A row updated after the cutoff is kept, whatever names it.
    expect(prunePersonaSessionImages(h.db, ["kept"], "2000-01-01T00:00:00.000Z")).toBe(0);
    expect(prunePersonaSessionImages(h.db, ["kept"])).toBe(1);
    expect(personaSessionImages(h.db, "gone").images).toBe(0);
    for (const s of ["thread-s", "main-s", "kept"]) expect(personaSessionImages(h.db, s).images).toBe(1);
    h.db.run("UPDATE persona_session_images SET updated_at = '2001-01-01T00:00:00.000Z' WHERE session_id = 'kept'");
    addPersonaSessionImages(h.db, "old-unnamed", 1, 1);
    h.db.run("UPDATE persona_session_images SET updated_at = '2001-01-01T00:00:00.000Z' WHERE session_id = 'old-unnamed'");
    expect(prunePersonaSessionImages(h.db, [], "2002-01-01T00:00:00.000Z")).toBe(2);
  });

  test("media shares are found by owner, worker key and digest, keeping the first time", () => {
    const h = setUp();
    const sha = "a".repeat(64);
    recordPersonaMediaShares(h.db, { key: launchShareKey("L1"), owner: "me", files: [{ sha256: sha, attachmentId: "att" }], at: "2026-01-01T00:00:00.000Z" });
    recordPersonaMediaShares(h.db, { key: launchShareKey("L1"), owner: "me", files: [{ sha256: sha, attachmentId: "att" }], at: "2026-02-01T00:00:00.000Z" });
    expect(findPersonaMediaShare(h.db, "me", ["s1", "launch:L1"], sha)).toEqual({
      key: "launch:L1",
      sha256: sha,
      attachmentId: "att",
      owner: "me",
      sharedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(findPersonaMediaShare(h.db, "you", ["launch:L1"], sha)).toBeNull();
    expect(findPersonaMediaShare(h.db, "me", ["s1"], sha)).toBeNull();
    expect(findPersonaMediaShare(h.db, "me", ["launch:L1"], "b".repeat(64))).toBeNull();
  });

  test("a session's counts carry over to the id it goes on under", () => {
    const h = setUp();
    addPersonaSessionImages(h.db, "a", 3, 30);
    addPersonaSessionImages(h.db, "b", 1, 5);
    carryPersonaSessionImages(h.db, "a", "b");
    carryPersonaSessionImages(h.db, "b", "b");
    expect(personaSessionImages(h.db, "b")).toEqual({ images: 4, base64Bytes: 35 });
  });

  test("a turn's batch key can't pose as an owner upload", () => {
    const h = setUp();
    expect(() => h.stage("a", { batchKey: "upload:x" })).toThrow();
  });

  test("messages without images read as before", () => {
    const h = setUp();
    const { message } = appendPersonaMessage(h.db, { threadId: h.thread.id, role: "persona", text: "plain" });
    expect(message.attachments).toBeUndefined();
    expect("attachments" in message).toBe(false);
  });
});
