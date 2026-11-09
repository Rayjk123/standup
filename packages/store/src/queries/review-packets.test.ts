import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ReviewPacketDraft } from "@standup/shared";
import { createStore } from "../store.js";
import { allMigrations, ensureReviewPacketsShape } from "../migrations.js";
import { createLaunch, getLaunchByReviewTokenHash, getLaunchReviewTokenHash, setLaunchReviewTokenHash } from "./launches.js";
import { upsertProject } from "./projects.js";
import {
  addReviewComment,
  addReviewMedia,
  clearReviewMedia,
  countLaunchReviewSubmissions,
  countPendingReviews,
  countReviewMediaRefs,
  createReviewPacket,
  decideReviewPacket,
  findDraftReviewPacketForLaunch,
  getReviewMedia,
  getReviewPacket,
  heldReviewMedia,
  listReviewComments,
  listReviewMedia,
  listReviewPackets,
  submitReviewPacket,
  sumReviewMediaBytes,
  toReviewMediaInfo,
} from "./review-packets.js";

const T0 = new Date("2026-10-01T10:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

function draft(title = "Add the Review tab"): ReviewPacketDraft {
  return {
    title,
    intent: "Lets a human approve a worker's change.",
    changes: [{ area: "Store", bullets: ["Adds review tables"], files: ["a.ts"] }],
    validation: { samples: [{ label: "submit", input: "{}", output: "ok" }] },
    risks: { risks: ["none known"], questions: [] },
    links: [{ kind: "code_review", label: "R-1", url: "https://example.com/reviews/R-1" }],
  };
}

function media(db: ReturnType<typeof createStore>["db"], packetId: string, owner: string, kind: "image" | "video", position: number) {
  return addReviewMedia(db, { packetId, owner, kind, mime: kind === "image" ? "image/png" : "video/mp4", sha256: `sha${position}`, bytes: 10, caption: `c${position}`, position });
}

describe("review packets", () => {
  test("migration 62 is declared", () => {
    expect(allMigrations().some((m) => m.version === 62)).toBe(true);
  });

  test("create, find draft, submit, get", () => {
    const { db } = createStore();
    const p = createReviewPacket(db, { owner: "alice", launchId: "L1", projectId: "proj", branch: "feat" }, T0);
    expect(p.status).toBe("draft");
    expect(p.revision).toBe(0);
    expect(p.changes).toEqual([]);
    expect(p.validation).toEqual({ samples: [] });
    expect(p.risks).toEqual({ risks: [], questions: [] });
    expect(findDraftReviewPacketForLaunch(db, "alice", "L1")?.id).toBe(p.id);

    const submitted = submitReviewPacket(db, { id: p.id, owner: "alice", draft: draft(), commitSha: "abc" }, at(1))!;
    expect(submitted.status).toBe("pending");
    expect(submitted.revision).toBe(1);
    expect(submitted.title).toBe("Add the Review tab");
    expect(submitted.changes).toEqual(draft().changes);
    expect(submitted.links).toEqual(draft().links);
    expect(submitted.branch).toBe("feat");
    expect(submitted.commitSha).toBe("abc");
    expect(submitted.updatedAt).toBe(at(1).toISOString());
    expect(findDraftReviewPacketForLaunch(db, "alice", "L1")).toBeNull();
    expect(getReviewPacket(db, p.id, "alice")).toEqual(submitted);
    expect(countPendingReviews(db, "alice")).toBe(1);
  });

  test("another owner sees nothing", () => {
    const { db } = createStore();
    const p = createReviewPacket(db, { owner: "alice", launchId: "L1" }, T0);
    expect(getReviewPacket(db, p.id, "bob")).toBeNull();
    expect(findDraftReviewPacketForLaunch(db, "bob", "L1")).toBeNull();
    expect(submitReviewPacket(db, { id: p.id, owner: "bob", draft: draft() })).toBeNull();
    submitReviewPacket(db, { id: p.id, owner: "alice", draft: draft() }, at(1));
    expect(listReviewPackets(db, { owner: "bob" })).toEqual([]);
    expect(countPendingReviews(db, "bob")).toBe(0);
    expect(decideReviewPacket(db, { id: p.id, owner: "bob", decision: "approved", actor: "bob" })).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(getReviewPacket(db, p.id, "alice")!.status).toBe("pending");
    const m = media(db, p.id, "alice", "image", 0);
    expect(listReviewMedia(db, p.id, "bob")).toEqual([]);
    expect(getReviewMedia(db, { packetId: p.id, mediaId: m.id, owner: "bob" })).toBeNull();
    expect(clearReviewMedia(db, p.id, "bob")).toBe(0);
    expect(listReviewMedia(db, p.id, "alice")).toHaveLength(1);
  });

  test("resubmitting for the same launch supersedes the earlier pending packet and bumps the revision", () => {
    const { db } = createStore();
    const first = createReviewPacket(db, { owner: "alice", launchId: "L1" }, T0);
    submitReviewPacket(db, { id: first.id, owner: "alice", draft: draft("one") }, at(1));
    const second = createReviewPacket(db, { owner: "alice", launchId: "L1" }, at(2));
    const other = createReviewPacket(db, { owner: "alice", launchId: "L2" }, at(2));
    submitReviewPacket(db, { id: other.id, owner: "alice", draft: draft("other") }, at(2));
    const s2 = submitReviewPacket(db, { id: second.id, owner: "alice", draft: draft("two") }, at(3))!;
    expect(s2.revision).toBe(2);
    expect(getReviewPacket(db, first.id, "alice")!.status).toBe("superseded");
    expect(getReviewPacket(db, other.id, "alice")!.status).toBe("pending");
    expect(getReviewPacket(db, other.id, "alice")!.revision).toBe(1);

    // Resubmitting a pending packet in place keeps it pending and bumps it again.
    const again = submitReviewPacket(db, { id: second.id, owner: "alice", draft: draft("two again") }, at(4))!;
    expect(again.status).toBe("pending");
    expect(again.revision).toBe(3);
    expect(countPendingReviews(db, "alice")).toBe(2);

    // A superseded packet can't be submitted.
    expect(submitReviewPacket(db, { id: first.id, owner: "alice", draft: draft() })).toBeNull();
  });

  test("list is newest first, hides drafts by default, filters by status and counts media", () => {
    const { db } = createStore();
    const d = createReviewPacket(db, { owner: "alice", launchId: "L0" }, T0);
    const a = createReviewPacket(db, { owner: "alice", launchId: "L1" }, at(1));
    const b = createReviewPacket(db, { owner: "alice", launchId: "L2" }, at(2));
    submitReviewPacket(db, { id: a.id, owner: "alice", draft: draft("a") }, at(3));
    submitReviewPacket(db, { id: b.id, owner: "alice", draft: draft("b") }, at(4));
    decideReviewPacket(db, { id: a.id, owner: "alice", decision: "approved", actor: "alice" }, at(5));
    media(db, b.id, "alice", "image", 0);
    media(db, b.id, "alice", "image", 1);
    media(db, b.id, "alice", "video", 2);

    const all = listReviewPackets(db, { owner: "alice" });
    expect(all.map((s) => s.id)).toEqual([b.id, a.id]);
    expect(all[0]).toMatchObject({ title: "b", status: "pending", imageCount: 2, videoCount: 1, launchId: "L2", jobId: null, sessionId: null });
    expect(all[1]).toMatchObject({ status: "approved", imageCount: 0, videoCount: 0 });
    expect(listReviewPackets(db, { owner: "alice", status: "pending" }).map((s) => s.id)).toEqual([b.id]);
    expect(listReviewPackets(db, { owner: "alice", status: ["draft", "approved"] }).map((s) => s.id)).toEqual([a.id, d.id]);
    expect(listReviewPackets(db, { owner: "alice", limit: 1 })).toHaveLength(1);
  });

  test("decide only from pending, recording a comment when given", () => {
    const { db } = createStore();
    const p = createReviewPacket(db, { owner: "alice", launchId: "L1" }, T0);
    expect(decideReviewPacket(db, { id: p.id, owner: "alice", decision: "approved", actor: "alice" })).toEqual({
      ok: false,
      reason: "not_pending",
    });
    expect(decideReviewPacket(db, { id: "missing", owner: "alice", decision: "approved", actor: "alice" })).toEqual({
      ok: false,
      reason: "not_found",
    });
    submitReviewPacket(db, { id: p.id, owner: "alice", draft: draft() }, at(1));
    const decided = decideReviewPacket(
      db,
      { id: p.id, owner: "alice", decision: "changes_requested", comment: "  Handle the empty case.  ", actor: "alice" },
      at(2)
    );
    expect(decided.ok).toBe(true);
    if (!decided.ok) throw new Error("unreachable");
    expect(decided.packet).toMatchObject({ status: "changes_requested", decidedBy: "alice", decidedAt: at(2).toISOString() });
    expect(listReviewComments(db, p.id)).toMatchObject([
      { author: "alice", body: "Handle the empty case.", decision: "changes_requested" },
    ]);
    expect(decideReviewPacket(db, { id: p.id, owner: "alice", decision: "approved", actor: "alice" })).toEqual({
      ok: false,
      reason: "not_pending",
    });
    expect(countPendingReviews(db, "alice")).toBe(0);
  });

  test("a decision without a comment adds no comment row", () => {
    const { db } = createStore();
    const p = createReviewPacket(db, { owner: "alice" }, T0);
    const s = submitReviewPacket(db, { id: p.id, owner: "alice", draft: draft() }, at(1))!;
    expect(s.revision).toBe(1);
    expect(decideReviewPacket(db, { id: p.id, owner: "alice", decision: "approved", comment: " ", actor: "alice" }).ok).toBe(true);
    expect(listReviewComments(db, p.id)).toEqual([]);
  });

  test("comments list oldest first", () => {
    const { db } = createStore();
    const p = createReviewPacket(db, { owner: "alice" }, T0);
    addReviewComment(db, { packetId: p.id, author: "alice", body: "second" }, at(2));
    addReviewComment(db, { packetId: p.id, author: "bob", body: "first" }, at(1));
    expect(listReviewComments(db, p.id).map((c) => [c.body, c.decision])).toEqual([
      ["first", null],
      ["second", null],
    ]);
  });

  test("media lookups require the matching packet and owner", () => {
    const { db } = createStore();
    const p = createReviewPacket(db, { owner: "alice" }, T0);
    const q = createReviewPacket(db, { owner: "alice" }, T0);
    const second = media(db, p.id, "alice", "video", 1);
    const first = media(db, p.id, "alice", "image", 0);
    expect(listReviewMedia(db, p.id, "alice").map((m) => m.id)).toEqual([first.id, second.id]);
    expect(getReviewMedia(db, { packetId: p.id, mediaId: first.id, owner: "alice" })).toEqual(first);
    expect(getReviewMedia(db, { packetId: q.id, mediaId: first.id, owner: "alice" })).toBeNull();
    expect(getReviewMedia(db, { packetId: p.id, mediaId: "nope", owner: "alice" })).toBeNull();
    expect(toReviewMediaInfo(first)).toEqual({
      id: first.id,
      kind: "image",
      mime: "image/png",
      bytes: 10,
      caption: "c0",
      position: 0,
      url: `/api/reviews/${p.id}/media/${first.id}`,
    });
    expect(clearReviewMedia(db, p.id, "alice")).toBe(2);
    expect(listReviewMedia(db, p.id, "alice")).toEqual([]);
  });

  test("deleting a packet cascades to its comments and media", () => {
    const { db } = createStore();
    const p = createReviewPacket(db, { owner: "alice" }, T0);
    addReviewComment(db, { packetId: p.id, author: "alice", body: "x" }, at(1));
    media(db, p.id, "alice", "image", 0);
    db.run("DELETE FROM review_packets WHERE id = ?", [p.id]);
    expect((db.query("SELECT COUNT(*) AS n FROM review_comments").get() as { n: number }).n).toBe(0);
    expect((db.query("SELECT COUNT(*) AS n FROM review_media").get() as { n: number }).n).toBe(0);
  });

  test("questions and answers thread on a packet, count while unanswered, and leave it pending", () => {
    const { db } = createStore();
    const p = createReviewPacket(db, { owner: "alice" }, T0);
    submitReviewPacket(db, { id: p.id, owner: "alice", draft: draft() }, at(1));
    const openOf = () => listReviewPackets(db, { owner: "alice" })[0]!.openQuestions;
    expect(openOf()).toBe(0);
    const q = addReviewComment(db, { packetId: p.id, author: "alice", body: "Why?", kind: "question", via: "worker" }, at(2));
    expect(q).toMatchObject({ kind: "question", replyTo: null, via: "worker", decision: null });
    // A question nobody could be sent isn't counted as waiting on an answer.
    const other = addReviewComment(db, { packetId: p.id, author: "alice", body: "And?", kind: "question", via: "none" }, at(3));
    expect(openOf()).toBe(1);
    addReviewComment(db, { packetId: p.id, author: "S1", body: "Because.", kind: "answer", replyTo: q.id, via: "worker" }, at(4));
    expect(openOf()).toBe(0);
    // A follow-up is open until an answer names it, whatever else the thread holds.
    const follow = addReviewComment(db, { packetId: p.id, author: "alice", body: "Sure?", kind: "question", replyTo: q.id, via: "worker" }, at(5));
    const later = addReviewComment(db, { packetId: p.id, author: "alice", body: "Also?", kind: "question", replyTo: q.id, via: "worker" }, at(6));
    expect(openOf()).toBe(2);
    addReviewComment(db, { packetId: p.id, author: "persona", body: "Yes.", kind: "answer", replyTo: follow.id, via: "persona" }, at(7));
    expect(openOf()).toBe(1);
    expect(listReviewComments(db, p.id).map((c) => [c.kind, c.replyTo, c.via])).toEqual([
      ["question", null, "worker"],
      ["question", null, "none"],
      ["answer", q.id, "worker"],
      ["question", q.id, "worker"],
      ["question", q.id, "worker"],
      ["answer", follow.id, "persona"],
    ]);
    expect(other.replyTo).toBeNull();
    expect(later.replyTo).toBe(q.id);
    expect(getReviewPacket(db, p.id, "alice")!.status).toBe("pending");
    // A decided packet has no question waiting on it.
    decideReviewPacket(db, { id: p.id, owner: "alice", decision: "approved", actor: "alice" });
    expect(openOf()).toBe(0);
    // A remark left without a kind stays a comment.
    expect(addReviewComment(db, { packetId: p.id, author: "alice", body: "note" }).kind).toBe("comment");
    expect(() => db.run("UPDATE review_comments SET kind = 'shout' WHERE id = ?", [q.id])).toThrow();
    expect(() => db.run("UPDATE review_comments SET via = 'slack' WHERE id = ?", [q.id])).toThrow();
  });

  test("the schema rejects unknown statuses and media kinds", () => {
    const { db } = createStore();
    const p = createReviewPacket(db, { owner: "alice" }, T0);
    expect(() => db.run("UPDATE review_packets SET status = 'maybe' WHERE id = ?", [p.id])).toThrow();
    expect(() => media(db, p.id, "alice", "gif" as "image", 0)).toThrow();
  });
});

describe("review storage accounting", () => {
  test("refs count every row naming a copy; superseding a packet drops its media rows and reports the copies", () => {
    const { db } = createStore();
    const first = createReviewPacket(db, { owner: "alice", launchId: "L1" }, T0);
    media(db, first.id, "alice", "image", 0);
    media(db, first.id, "alice", "image", 1);
    submitReviewPacket(db, { id: first.id, owner: "alice", draft: draft() }, at(1));
    const second = createReviewPacket(db, { owner: "alice", launchId: "L1" }, at(2));
    media(db, second.id, "alice", "image", 0);
    const removed: Array<{ sha256: string; mime: string }> = [];
    submitReviewPacket(db, { id: second.id, owner: "alice", draft: draft(), removedMedia: removed }, at(3));
    expect(getReviewPacket(db, first.id, "alice")!.status).toBe("superseded");
    expect(listReviewMedia(db, first.id, "alice")).toEqual([]);
    expect(removed.map((r) => r.sha256).sort()).toEqual(["sha0", "sha1"]);
    const bob = createReviewPacket(db, { owner: "bob", launchId: "L2" }, T0);
    media(db, bob.id, "bob", "image", 0);

    expect(countReviewMediaRefs(db, "sha0")).toBe(2);
    expect(countReviewMediaRefs(db, "sha1")).toBe(0);
    expect(countReviewMediaRefs(db, "nope")).toBe(0);
    expect(sumReviewMediaBytes(db, "alice")).toBe(10);
    expect(sumReviewMediaBytes(db, "alice", { packetId: second.id })).toBe(0);
    expect(sumReviewMediaBytes(db, "bob")).toBe(10);
    expect(sumReviewMediaBytes(db, "carol")).toBe(0);
    expect(countLaunchReviewSubmissions(db, "L1")).toBe(2);
    expect(countLaunchReviewSubmissions(db, "L2")).toBe(0);
    expect(countLaunchReviewSubmissions(db, "none")).toBe(0);
  });

  test("the quota counts each copy once, over open (draft and pending) packets only", () => {
    const { db } = createStore();
    const add = (packetId: string, sha256: string, bytes: number, position: number) =>
      addReviewMedia(db, { packetId, owner: "alice", kind: "image", mime: "image/png", sha256, bytes, caption: "c", position });
    const pending = createReviewPacket(db, { owner: "alice", launchId: "L1" }, T0);
    add(pending.id, "dup", 100, 0);
    add(pending.id, "dup", 100, 1);
    add(pending.id, "solo", 7, 2);
    submitReviewPacket(db, { id: pending.id, owner: "alice", draft: draft() }, at(1));
    const other = createReviewPacket(db, { owner: "alice", launchId: "L2" }, at(2));
    add(other.id, "dup", 100, 0);
    expect(sumReviewMediaBytes(db, "alice")).toBe(107);
    expect(heldReviewMedia(db, "alice")).toEqual(new Map([["dup", 100], ["solo", 7]]));

    const approved = createReviewPacket(db, { owner: "alice", launchId: "L3" }, at(3));
    add(approved.id, "big", 1000, 0);
    submitReviewPacket(db, { id: approved.id, owner: "alice", draft: draft() }, at(4));
    expect(sumReviewMediaBytes(db, "alice")).toBe(1107);
    decideReviewPacket(db, { id: approved.id, owner: "alice", decision: "approved", actor: "alice" }, at(5));
    expect(sumReviewMediaBytes(db, "alice")).toBe(107);
    expect(listReviewMedia(db, approved.id, "alice")).toHaveLength(1);

    const asked = createReviewPacket(db, { owner: "alice", launchId: "L4" }, at(6));
    add(asked.id, "big2", 500, 0);
    submitReviewPacket(db, { id: asked.id, owner: "alice", draft: draft() }, at(7));
    decideReviewPacket(db, { id: asked.id, owner: "alice", decision: "changes_requested", comment: "fix", actor: "alice" }, at(8));
    expect(sumReviewMediaBytes(db, "alice")).toBe(107);

    expect(sumReviewMediaBytes(db, "alice", { launchId: "L1" })).toBe(100);
    expect(sumReviewMediaBytes(db, "alice", { launchId: "L1", packetId: other.id })).toBe(0);
  });
});

describe("launches.launched_by and launches.review_token_hash", () => {
  const launchColumns = (db: ReturnType<typeof createStore>["db"]) =>
    (db.query("PRAGMA table_info(launches)").all() as Array<{ name: string }>).map((c) => c.name);

  test("migration 62 adds them, and a launch records and reads back its launcher", () => {
    const { db } = createStore();
    expect(launchColumns(db)).toEqual(expect.arrayContaining(["launched_by", "review_token_hash"]));
    upsertProject(db, { id: "p", name: "P", branch: "main", repos: [] });
    const l = createLaunch(db, { id: "L1", projectId: "p", task: "t", worktreePath: "/wt", branch: "b", requester: "alice", launchedBy: "bob" });
    expect(l).toMatchObject({ requester: "alice", launchedBy: "bob" });
    expect(createLaunch(db, { id: "L2", projectId: "p", task: "t", worktreePath: "/wt", branch: "b", launchedBy: "  " }).launchedBy).toBeUndefined();
    setLaunchReviewTokenHash(db, "L1", "f".repeat(64));
    expect(getLaunchReviewTokenHash(db, "L1")).toBe("f".repeat(64));
    expect(getLaunchByReviewTokenHash(db, "f".repeat(64))?.id).toBe("L1");
    expect(getLaunchByReviewTokenHash(db, "")).toBeNull();
  });

  test("a database with the review tables but not the columns is repaired on open, and the shape check is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "review-shape-"));
    try {
      const path = join(dir, "standup.db");
      const first = createStore(path);
      first.db.exec("DROP INDEX IF EXISTS idx_launches_review_token_hash");
      first.db.exec("ALTER TABLE launches DROP COLUMN launched_by");
      first.db.exec("ALTER TABLE launches DROP COLUMN review_token_hash");
      expect(launchColumns(first.db)).not.toContain("launched_by");
      first.close();
      const reopened = createStore(path);
      expect(launchColumns(reopened.db)).toEqual(expect.arrayContaining(["launched_by", "review_token_hash"]));
      ensureReviewPacketsShape(reopened.db);
      ensureReviewPacketsShape(reopened.db);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("review_packets submitter provenance", () => {
  const SUBMITTER_COLUMNS = ["submitted_by_session", "submitted_by_root", "resubmitted_from_other_session"];
  const packetColumns = (db: ReturnType<typeof createStore>["db"]) =>
    (db.query("PRAGMA table_info(review_packets)").all() as Array<{ name: string }>).map((c) => c.name);

  test("a database with the review tables but not the submitter columns is repaired on open, idempotently", () => {
    const dir = mkdtempSync(join(tmpdir(), "review-submitter-shape-"));
    try {
      const path = join(dir, "standup.db");
      const first = createStore(path);
      for (const column of SUBMITTER_COLUMNS) first.db.exec(`ALTER TABLE review_packets DROP COLUMN ${column}`);
      expect(packetColumns(first.db)).not.toContain("submitted_by_session");
      first.close();
      const reopened = createStore(path);
      expect(packetColumns(reopened.db)).toEqual(expect.arrayContaining(SUBMITTER_COLUMNS));
      ensureReviewPacketsShape(reopened.db);
      ensureReviewPacketsShape(reopened.db);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a database whose review_comments predate questions gains kind, reply_to and via on open, its remarks kept as comments", () => {
    const dir = mkdtempSync(join(tmpdir(), "review-comment-shape-"));
    try {
      const path = join(dir, "standup.db");
      const first = createStore(path);
      const p = createReviewPacket(first.db, { owner: "alice" }, T0);
      for (const column of ["kind", "reply_to", "via"]) first.db.exec(`ALTER TABLE review_comments DROP COLUMN ${column}`);
      first.db.run("INSERT INTO review_comments (id, packet_id, author, body, created_at) VALUES ('c1', ?, 'alice', 'old', ?)", [p.id, T0.toISOString()]);
      first.close();
      const reopened = createStore(path);
      ensureReviewPacketsShape(reopened.db);
      expect(listReviewComments(reopened.db, p.id)).toEqual([
        expect.objectContaining({ id: "c1", body: "old", kind: "comment", replyTo: null, via: null }),
      ]);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a revision records its submitter and is flagged when the launch's previous revision came from another session", () => {
    const { db } = createStore();
    const p = createReviewPacket(db, { owner: "alice", launchId: "L1" });
    expect(p).toMatchObject({ submittedBySession: null, submittedByRootSession: false, resubmittedFromOtherSession: false });
    const one = submitReviewPacket(db, { id: p.id, owner: "alice", draft: draft(), submittedBySession: "S1", submittedByRootSession: true }, at(1))!;
    expect(one).toMatchObject({ submittedBySession: "S1", submittedByRootSession: true, resubmittedFromOtherSession: false });
    const again = submitReviewPacket(db, { id: p.id, owner: "alice", draft: draft(), submittedBySession: "S1", submittedByRootSession: true }, at(2))!;
    expect(again.resubmittedFromOtherSession).toBe(false);
    const next = createReviewPacket(db, { owner: "alice", launchId: "L1" });
    const two = submitReviewPacket(db, { id: next.id, owner: "alice", draft: draft(), submittedBySession: "S2" }, at(3))!;
    expect(two).toMatchObject({ revision: 3, submittedBySession: "S2", submittedByRootSession: false, resubmittedFromOtherSession: true });
  });

  test("an explicit null ref clears the stored one; an undefined ref keeps it", () => {
    const { db } = createStore();
    const p = createReviewPacket(db, { owner: "alice", launchId: "L1", branch: "feat", commitSha: "abc", baseSha: "def" });
    const kept = submitReviewPacket(db, { id: p.id, owner: "alice", draft: draft() }, at(1))!;
    expect([kept.branch, kept.commitSha, kept.baseSha]).toEqual(["feat", "abc", "def"]);
    const cleared = submitReviewPacket(db, { id: p.id, owner: "alice", draft: draft(), branch: null, commitSha: null, baseSha: null }, at(2))!;
    expect([cleared.branch, cleared.commitSha, cleared.baseSha]).toEqual([null, null, null]);
  });
});
