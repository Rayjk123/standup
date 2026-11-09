import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { REVIEW_SHARE_TOKEN } from "@standup/shared";
import { createStore } from "../store.js";
import { createReviewPacket, submitReviewPacket } from "./review-packets.js";
import { getReviewShare, getSharedReviewPacket, setReviewShare } from "./review-packets.js";
import { shareTokenDigest } from "./share-grants.js";

const draft = {
  title: "t",
  intent: "i",
  changes: [],
  validation: { samples: [] },
  risks: { risks: [], questions: [] },
  links: [],
};

function pending(db: Database, owner = "alice") {
  const p = createReviewPacket(db, { owner, launchId: `L-${Math.random()}` });
  return submitReviewPacket(db, { id: p.id, owner, draft })!;
}

const grants = (db: Database, id: string) =>
  db.query("SELECT token, token_sha256, revoked_at FROM share_grants WHERE resource_type = 'review' AND resource_id = ? ORDER BY rowid").all(id) as Array<{
    token: string;
    token_sha256: string;
    revoked_at: string | null;
  }>;

describe("review share state", () => {
  test("on mints a 256-bit token stored as a grant with its digest; off revokes it", () => {
    const { db } = createStore(":memory:");
    const p = pending(db);
    expect(getReviewShare(db, p.id, "alice")).toEqual({ enabled: false, token: null });
    const on = setReviewShare(db, { id: p.id, owner: "alice", enabled: true });
    if (!on || typeof on === "string") throw new Error("not shared");
    expect(on.token).toMatch(REVIEW_SHARE_TOKEN);
    expect(Buffer.from(on.token!, "base64url")).toHaveLength(32);
    expect(grants(db, p.id)).toEqual([{ token: on.token!, token_sha256: shareTokenDigest(on.token!), revoked_at: null }]);
    expect(getSharedReviewPacket(db, on.token!)?.id).toBe(p.id);
    expect(getReviewShare(db, p.id, "alice")).toEqual({ enabled: true, token: on.token });

    expect(setReviewShare(db, { id: p.id, owner: "alice", enabled: false })).toEqual({ enabled: false, token: null });
    expect(grants(db, p.id)[0]!.revoked_at).not.toBeNull();
    expect(getSharedReviewPacket(db, on.token!)).toBeNull();
    // The legacy columns are never written.
    expect(db.query("SELECT share_enabled, share_token FROM review_packets WHERE id = ?").get(p.id)).toEqual({ share_enabled: 0, share_token: null });
  });

  test("every turn-on rotates the token", () => {
    const { db } = createStore(":memory:");
    const p = pending(db);
    const tokens = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const s = setReviewShare(db, { id: p.id, owner: "alice", enabled: true });
      if (!s || typeof s === "string") throw new Error("not shared");
      tokens.add(s.token!);
    }
    expect(tokens.size).toBe(5);
    const last = [...tokens].pop()!;
    for (const t of tokens) expect(getSharedReviewPacket(db, t)?.id ?? null).toBe(t === last ? p.id : null);
    expect(grants(db, p.id).filter((g) => g.revoked_at === null)).toHaveLength(1);
  });

  test("only the owner's packet, never a draft", () => {
    const { db } = createStore(":memory:");
    const p = pending(db);
    expect(setReviewShare(db, { id: p.id, owner: "bob", enabled: true })).toBeNull();
    expect(getReviewShare(db, p.id, "bob")).toBeNull();
    const d = createReviewPacket(db, { owner: "alice" });
    expect(setReviewShare(db, { id: d.id, owner: "alice", enabled: true })).toBe("draft");
    expect(grants(db, d.id)).toEqual([]);
  });

  test("resubmitting a shared packet revokes its link", () => {
    const { db } = createStore(":memory:");
    const p = pending(db);
    const s = setReviewShare(db, { id: p.id, owner: "alice", enabled: true });
    if (!s || typeof s === "string") throw new Error("not shared");
    submitReviewPacket(db, { id: p.id, owner: "alice", draft: { ...draft, title: "changed" } });
    expect(getSharedReviewPacket(db, s.token!)).toBeNull();
    expect(getReviewShare(db, p.id, "alice")).toEqual({ enabled: false, token: null });
  });

  test("a packet superseded by its launch's next submission has its link revoked", () => {
    const { db } = createStore(":memory:");
    const first = createReviewPacket(db, { owner: "alice", launchId: "L" });
    submitReviewPacket(db, { id: first.id, owner: "alice", draft });
    const s = setReviewShare(db, { id: first.id, owner: "alice", enabled: true });
    if (!s || typeof s === "string") throw new Error("not shared");
    const next = createReviewPacket(db, { owner: "alice", launchId: "L" });
    submitReviewPacket(db, { id: next.id, owner: "alice", draft });
    expect(db.query("SELECT status FROM review_packets WHERE id = ?").get(first.id)).toEqual({ status: "superseded" });
    expect(getSharedReviewPacket(db, s.token!)).toBeNull();
    expect(grants(db, first.id)[0]!.revoked_at).not.toBeNull();
    expect(setReviewShare(db, { id: first.id, owner: "alice", enabled: true })).toBe("superseded");
  });

  test("a resubmission that fails rolls back with the revocation", () => {
    const { db } = createStore(":memory:");
    const p = pending(db);
    const s = setReviewShare(db, { id: p.id, owner: "alice", enabled: true });
    if (!s || typeof s === "string") throw new Error("not shared");
    db.exec("CREATE TRIGGER fail_resubmit BEFORE UPDATE OF title ON review_packets BEGIN SELECT RAISE(ABORT, 'boom'); END");
    expect(() => submitReviewPacket(db, { id: p.id, owner: "alice", draft: { ...draft, title: "changed" } })).toThrow("boom");
    expect(getSharedReviewPacket(db, s.token!)?.id).toBe(p.id);
  });

  test("a token whose digest matches but whose stored text differs is refused", () => {
    const { db } = createStore(":memory:");
    const p = pending(db);
    const s = setReviewShare(db, { id: p.id, owner: "alice", enabled: true });
    if (!s || typeof s === "string") throw new Error("not shared");
    db.run("UPDATE share_grants SET token = ? WHERE resource_id = ?", ["B".repeat(43), p.id]);
    expect(getSharedReviewPacket(db, s.token!)).toBeNull();
  });
});
