import type { ShareResourceType, ShareState } from "@standup/shared";

function errorOf(body: unknown): string | undefined {
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = (body as { error: unknown }).error;
    if (typeof error === "string" && error.trim()) return error;
  }
  return undefined;
}

function sharePath(type: ShareResourceType, id: string): string {
  return `/api/shares/${encodeURIComponent(type)}/${encodeURIComponent(id)}`;
}

/** A resource's share link as it stands; null when it can't be read. */
export async function getShare(type: ShareResourceType, id: string): Promise<ShareState | null> {
  try {
    const res = await fetch(sharePath(type, id));
    if (!res.ok) return null;
    const body = (await res.json()) as { share?: ShareState } | null;
    return body?.share ?? null;
  } catch {
    return null;
  }
}

/** The ids of the caller's resources of `type` shared by link now; null when they can't be read. */
export async function listShared(type: ShareResourceType): Promise<string[] | null> {
  try {
    const res = await fetch(`/api/shares/${encodeURIComponent(type)}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { ids?: unknown } | null;
    return Array.isArray(body?.ids) ? body.ids.filter((id): id is string => typeof id === "string") : null;
  } catch {
    return null;
  }
}

/**
 * Turns a resource's read-only share link on or off. Never throws: a refused
 * or failed request comes back as `{ error }`.
 */
export async function setShare(
  type: ShareResourceType,
  id: string,
  enabled: boolean
): Promise<{ share?: ShareState; error?: string }> {
  try {
    const res = await fetch(sharePath(type, id), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) return { error: errorOf(body) ?? `Request failed (HTTP ${res.status})` };
    const share = (body as { share?: ShareState } | null)?.share;
    if (!share) return { error: errorOf(body) ?? "The collector returned no share state" };
    return { share };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
