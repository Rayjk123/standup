import { describe, expect, test } from "bun:test";
import type { ReviewUpdatedPayload } from "@standup/shared";
import { publishReviewResync, publishReviewUpdate, subscribeReviewUpdates } from "./reviewUpdates";

const update: ReviewUpdatedPayload = { packetId: "rp-1", owner: "alice", status: "approved" };

describe("reviewUpdates", () => {
  test("delivers each published update to every subscriber until it unsubscribes", () => {
    const a: Array<ReviewUpdatedPayload | null> = [];
    const b: Array<ReviewUpdatedPayload | null> = [];
    const offA = subscribeReviewUpdates((u) => a.push(u));
    const offB = subscribeReviewUpdates((u) => b.push(u));
    publishReviewUpdate(update);
    offA();
    publishReviewUpdate({ ...update, status: "superseded" });
    offB();
    publishReviewUpdate(update);
    expect(a).toEqual([update]);
    expect(b.map((u) => u?.status)).toEqual(["approved", "superseded"]);
  });

  test("a resync reaches every subscriber as null, so each re-reads everything", () => {
    const seen: Array<ReviewUpdatedPayload | null> = [];
    const off = subscribeReviewUpdates((u) => seen.push(u));
    publishReviewResync();
    off();
    expect(seen).toEqual([null]);
  });
});
