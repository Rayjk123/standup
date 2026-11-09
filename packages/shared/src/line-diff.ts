/**
 * Small line-level diff for showing a regenerated draft against the doc it
 * would replace. Deliberately a plain LCS rather than a dependency — knowledge
 * docs are a few hundred lines at most, so the O(n·m) table is cheap, and
 * pulling in a diff library for one view isn't worth it.
 */

export type DiffLine = { type: "same" | "add" | "remove"; text: string };

export function lineDiff(oldText: string, newText: string): DiffLine[] {
  // "".split("\n") is [""], one phantom empty line — guard it so diffing
  // against genuinely empty text doesn't manufacture a spurious remove/add
  // pair around real content.
  const a = oldText === "" ? [] : oldText.split("\n");
  const b = newText === "" ? [] : newText.split("\n");
  const n = a.length;
  const m = b.length;

  // dp[i][j] = length of the LCS of a[i..] and b[j..]. Built bottom-up so
  // the walk below can read it left-to-right without recursion.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      result.push({ type: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: "remove", text: a[i] });
      i++;
    } else {
      result.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) {
    result.push({ type: "remove", text: a[i] });
    i++;
  }
  while (j < m) {
    result.push({ type: "add", text: b[j] });
    j++;
  }
  return result;
}

/**
 * A diff as compact text: changed lines prefixed `+ ` / `- `, `context`
 * unchanged lines around each change, `…` where unchanged lines are skipped,
 * and at most `maxLines` lines (a final `… (n more lines)` says how many were
 * cut). Empty when the texts are the same.
 */
export function formatLineDiff(lines: DiffLine[], opts: { context?: number; maxLines?: number } = {}): string {
  const context = opts.context ?? 1;
  const maxLines = opts.maxLines ?? 80;
  if (!lines.some((l) => l.type !== "same")) return "";
  const keep = lines.map(() => false);
  lines.forEach((l, i) => {
    if (l.type === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: string[] = [];
  let skipped = false;
  lines.forEach((l, i) => {
    if (!keep[i]) {
      skipped = true;
      return;
    }
    if (skipped && out.length > 0) out.push("…");
    skipped = false;
    out.push(`${l.type === "add" ? "+ " : l.type === "remove" ? "- " : "  "}${l.text}`);
  });
  if (out.length <= maxLines) return out.join("\n");
  return [...out.slice(0, maxLines), `… (${out.length - maxLines} more lines)`].join("\n");
}
