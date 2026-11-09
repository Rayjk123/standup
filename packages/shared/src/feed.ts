// Feed curation — which agent events are "substantive" enough to carry the
// shared stream, and the one-line renderings of knowledge changes and digests.
//
// Pure and dependency-free so the Slack feed and the daily digest classify
// events the same way.

import type { CheckpointSource, Digest, KnowledgeChange } from "./types.js";

/**
 * Structural checkpoints are Standup's own low-signal ticks — a completed todo
 * item, a finished subagent turn — emitted many per turn. Self-reported (the
 * agent's own `checkpoint`) and auto (a turn-end classification or a "✓ Done"
 * marker) checkpoints are deliberate, one-per-meaningful-moment signals. Only
 * the structural ones are the firehose the substantive feed leaves out.
 */
export function isRoutineCheckpoint(source: CheckpointSource): boolean {
  return source === "structural";
}

/**
 * The one-line feed rendering of a knowledge-graph change. The emoji names the kind
 * and the doc title carries the specifics; a contradiction also names the docs
 * it conflicts with.
 */
export function knowledgeChangeLine(change: KnowledgeChange): string {
  const title = change.title || change.slug;
  switch (change.kind) {
    case "accepted":
      return `📚 Knowledge accepted — ${title}`;
    case "reconciled":
      return `♻️ Knowledge reconciled — ${title}`;
    case "removed":
      return `🗑️ Knowledge removed — ${title}`;
    case "distilled":
      return `🧪 Knowledge distilled — ${title}`;
    case "contradiction": {
      const others = (change.contradicted ?? []).filter((s) => s !== change.slug);
      const against = others.length > 0 ? ` (conflicts with ${others.join(", ")})` : "";
      return `⚠️ Knowledge conflict — ${title}${against}`;
    }
  }
}

/**
 * The one-line headline of a daily digest: the emoji, the covered date, and how many
 * projects it spans (a quiet day names zero). The digest `body` carries the
 * specifics beneath this headline.
 */
export function digestHeadline(digest: Digest): string {
  const date = digest.periodEnd.slice(0, 10);
  const n = digest.counts.projects;
  const scope =
    n === 0 ? "a quiet day" : `${n} project${n === 1 ? "" : "s"}`;
  return `🗞️ Morning digest — ${date} · ${scope}`;
}
