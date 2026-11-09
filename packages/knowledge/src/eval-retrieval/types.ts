/**
 * Data shapes of the retrieval-only knowledge eval: the real-shaped golden
 * tier (R) and the task-usefulness tier (U). Doc references are
 * `project/slug` strings throughout.
 */

/** A doc reference, `project/slug`. */
export type DocRef = string;

/** The categories of the real-shaped golden tier, after the 38-query live study. */
export type RealCategory = "single" | "cross" | "stale" | "paraphrase" | "mirror" | "unanswerable";

export const REAL_CATEGORIES: readonly RealCategory[] = [
  "single",
  "cross",
  "stale",
  "paraphrase",
  "mirror",
  "unanswerable",
];

export interface GradedDoc {
  doc: DocRef;
  /** 2 = the answer, 1 = useful supporting context. */
  grade: number;
}

/** One labelled query of tier R. */
export interface RealCase {
  id: string;
  category: RealCategory;
  /** The project the asking session runs in. */
  project: string;
  query: string;
  relevant: GradedDoc[];
  /** A correct system returns nothing for this query. */
  expectEmpty?: boolean;
  /** For a stale-doc case: the current docs and the outdated ones that must not outrank them. */
  stale?: { fresh: DocRef[]; stale: DocRef[] };
}

/** One query a worker on a task would type, with the docs that would actually help do the task. */
export interface TaskQuery {
  id: string;
  query: string;
  /** Overrides the task's project, for a query asked from another session context. */
  project?: string;
  helpful: DocRef[];
}

/** One realistic worker task of tier U. */
export interface UsefulnessTask {
  id: string;
  project: string;
  /** The launch brief: what launch injection retrieves against. */
  brief: string;
  queries: TaskQuery[];
  /** Files (relative to the project's repo) a worker on the task would edit: the first-edit push targets. */
  paths?: string[];
}

/** One returned hit, as the metrics see it. */
export interface Hit {
  ref: DocRef;
  /** Identity of the hit's content: equal for byte-identical copies homed in different projects. */
  contentKey: string;
  /** The surface's confidence flag, when it reports one. */
  confident?: boolean;
  /** Marked by the surface (disputed, stale, not injection-eligible). */
  marked?: boolean;
  /** The search result's relevance and ordering score, when the surface has them. */
  relevance?: number;
  score?: number;
}

/** The surfaces the harness drives. `push` is the hook-context extension point. */
export type RetrievalSurface = "search" | "recall" | "inject" | "push";
