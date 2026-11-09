import type { ReviewDecision, ReviewPacketDetail, ReviewPacketSummary, SharedReviewPacket } from "@standup/shared";
import { REVIEW_SHARE_API_PREFIX } from "@standup/shared";

/** Which packets the review list shows. */
export type ReviewFilter = "pending" | "all";

function errorOf(body: unknown): string | undefined {
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = (body as { error: unknown }).error;
    if (typeof error === "string" && error.trim()) return error;
  }
  return undefined;
}

/** Parses a JSON response, throwing an Error carrying the server's `error` text on a non-2xx status. */
async function readJson<T>(res: Response): Promise<T> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) throw new Error(errorOf(body) ?? `Request failed (HTTP ${res.status})`);
  return body as T;
}

function reviewPath(id: string): string {
  return `/api/reviews/${encodeURIComponent(id)}`;
}

export async function listReviews(filter: ReviewFilter): Promise<ReviewPacketSummary[]> {
  const res = await fetch(`/api/reviews?status=${filter}`);
  const body = await readJson<{ reviews?: ReviewPacketSummary[] }>(res);
  return Array.isArray(body?.reviews) ? body.reviews : [];
}

export async function getReview(id: string): Promise<ReviewPacketDetail> {
  const body = await readJson<{ review: ReviewPacketDetail }>(await fetch(reviewPath(id)));
  if (!body?.review) throw new Error("Review not found");
  return body.review;
}

export async function getPendingCount(signal?: AbortSignal): Promise<number> {
  const body = await readJson<{ count?: unknown }>(await fetch("/api/reviews/pending-count", signal ? { signal } : undefined));
  return typeof body?.count === "number" ? body.count : 0;
}

/** A shared packet by its share token; null when the link is unknown or revoked. */
export async function getSharedReview(token: string): Promise<SharedReviewPacket | null> {
  // Same-origin credentials: a tunnel in front of the console signs its visitors in with a cookie.
  const res = await fetch(`${REVIEW_SHARE_API_PREFIX}${encodeURIComponent(token)}`, {
    credentials: "same-origin",
    referrerPolicy: "no-referrer",
  });
  if (res.status === 404) return null;
  const body = await readJson<{ review?: SharedReviewPacket }>(res);
  return body?.review ?? null;
}

/**
 * Records the human's decision on a packet. Never throws: a refused or failed
 * request comes back as `{ error }` so the decision bar can show it.
 */
export async function decideReview(
  id: string,
  decision: ReviewDecision,
  comment: string
): Promise<{ review?: ReviewPacketDetail; error?: string }> {
  const action = decision === "approved" ? "approve" : "request-changes";
  const trimmed = comment.trim();
  return postReview(id, action, decision === "approved" && !trimmed ? {} : { comment: trimmed });
}

/**
 * Asks the packet's worker a question (a follow-up in `replyTo`'s thread when
 * given); the packet stays pending. Never throws, as decideReview.
 */
export function askReview(id: string, question: string, replyTo?: string): Promise<{ review?: ReviewPacketDetail; error?: string }> {
  return postReview(id, "ask", { question: question.trim(), ...(replyTo ? { replyTo } : {}) });
}

/** POSTs an owner action on a packet; the packet as it now reads, or `{ error }`. */
async function postReview(id: string, action: string, body: object): Promise<{ review?: ReviewPacketDetail; error?: string }> {
  try {
    const res = await fetch(`${reviewPath(id)}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await readJson<{ review?: ReviewPacketDetail; error?: string }>(res);
    if (!data?.review) return { error: errorOf(data) ?? "The collector returned no review" };
    return { review: data.review };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
