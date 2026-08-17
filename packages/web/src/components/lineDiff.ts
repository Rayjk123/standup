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
