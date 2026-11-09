/**
 * Known-duplicate labels for scripts/kb-dedup-calibrate.ts.
 *
 * A pairs file has one label per line; blank lines and `#` comments are
 * skipped:
 *
 *   project/slug project/slug     # these two docs are duplicates
 *   project-a/* project-b/*       # every same-slug pair across the two projects
 *
 * The second form labels a forked or frozen copy of a whole project.
 */

export interface DupLabels {
  /** Sorted `a b` refs of the listed doc pairs. */
  pairs: Set<string>;
  /** Sorted `projectA projectB` keys of the project forks. */
  forks: Set<string>;
}

export function emptyDupLabels(): DupLabels {
  return { pairs: new Set(), forks: new Set() };
}

const FORK_SIDE = /^([^/\s]+)\/\*$/;

/** Reads a pairs file's text into `into` (or a fresh label set) and returns it. */
export function parseDupLabels(text: string, into: DupLabels = emptyDupLabels()): DupLabels {
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [x, y] = line.split(/\s+/);
    if (!x || !y) continue;
    const fx = FORK_SIDE.exec(x);
    const fy = FORK_SIDE.exec(y);
    if (fx && fy) into.forks.add([fx[1], fy[1]].sort().join(" "));
    else if (!fx && !fy) into.pairs.add([x, y].sort().join(" "));
  }
  return into;
}

/** True when the refs `project/slug` and `project/slug` are a labeled duplicate. */
export function isLabeledDup(labels: DupLabels, a: string, b: string): boolean {
  if (labels.pairs.has([a, b].sort().join(" "))) return true;
  const [pa, sa] = a.split("/");
  const [pb, sb] = b.split("/");
  return sa === sb && pa !== pb && labels.forks.has([pa, pb].sort().join(" "));
}
