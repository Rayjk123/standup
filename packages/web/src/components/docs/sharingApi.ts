import type { DocComment, DocCommentAnchor, SharedWithMe } from "@standup/shared";
import { DocsRequestError } from "./api";

/*
 * Shareable docs and their comments: the owner's Shareable switches, the
 * "Shared with me" list, and a doc's comments. Every call throws a
 * DocsRequestError carrying the collector's `error` text on a refused or
 * failed request.
 */

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, body === undefined ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (err) {
    throw new DocsRequestError(err instanceof Error ? err.message : String(err), 0);
  }
  const parsed = (await res.json().catch(() => null)) as { error?: unknown } | null;
  if (!res.ok) {
    const error = typeof parsed?.error === "string" && parsed.error.trim() ? parsed.error : `Request failed (HTTP ${res.status})`;
    throw new DocsRequestError(error, res.status);
  }
  return parsed as T;
}

const id = (value: string) => encodeURIComponent(value);

/** Marks the owner's doc or folder shareable with everyone signed in, or not. */
export async function setShareable(kind: "doc" | "folder", itemId: string, shareable: boolean): Promise<void> {
  await call(kind === "doc" ? `/api/docs/${id(itemId)}/shareable` : `/api/docs/folders/${id(itemId)}/shareable`, "PUT", { shareable });
}

/** Other users' shareable docs, by owner. */
export async function getSharedWithMe(): Promise<SharedWithMe[]> {
  const res = await call<{ shared?: SharedWithMe[] } | null>("/api/docs/shared-with-me");
  return Array.isArray(res?.shared) ? res.shared : [];
}

export async function listComments(docId: string): Promise<DocComment[]> {
  const res = await call<{ comments?: DocComment[] } | null>(`/api/docs/${id(docId)}/comments`);
  return Array.isArray(res?.comments) ? res.comments : [];
}

export async function leaveComment(docId: string, body: string, anchor: DocCommentAnchor): Promise<DocComment> {
  return (await call<{ comment: DocComment }>(`/api/docs/${id(docId)}/comments`, "POST", { body, anchor })).comment;
}

export async function replyToComment(docId: string, commentId: string, body: string): Promise<DocComment> {
  return (await call<{ comment: DocComment }>(`/api/docs/${id(docId)}/comments/${id(commentId)}/reply`, "POST", { body })).comment;
}

export async function resolveComment(docId: string, commentId: string, resolved: boolean): Promise<DocComment> {
  return (await call<{ comment: DocComment }>(`/api/docs/${id(docId)}/comments/${id(commentId)}/resolve`, "POST", { resolved })).comment;
}
