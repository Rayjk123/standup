import type { ReviewStatus } from "@standup/shared";
import { theme } from "../theme";

export const STATUS_COLORS: Record<ReviewStatus, string> = {
  draft: theme.faint,
  pending: theme.waiting,
  approved: theme.done,
  changes_requested: theme.stalled,
  superseded: theme.dim,
};

export const STATUS_LABELS: Record<ReviewStatus, string> = {
  draft: "Draft",
  pending: "Pending",
  approved: "Approved",
  changes_requested: "Changes requested",
  superseded: "Superseded",
};

/** Ages under a minute read as "just now"; then minutes, hours, days, and a date past a month. */
export function relativeAge(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const seconds = Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return then.toLocaleDateString();
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : "";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A session id's first block when it is a UUID; any other id whole. */
export function shortSessionId(id: string): string {
  return UUID.test(id) ? id.slice(0, 8) : id;
}

/** `branch@abc1234`, either half alone when the other is unknown, or empty. */
export function refLabel(branch: string | null | undefined, sha: string | null | undefined): string {
  const s = shortSha(sha);
  if (branch && s) return `${branch}@${s}`;
  return branch || s;
}

/** Only http(s) URLs are rendered as links; anything else (javascript:, data:, relative) is shown as text. */
export function isSafeHref(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
