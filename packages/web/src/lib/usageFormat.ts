import type { FleetUsageTotals } from "@standup/shared";

/** 12345678 → "12.35M" / "15.1K" / "812". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** A dollar figure; null (unknown model) reads as "—". Sub-cent costs keep
 * more precision so a small session isn't flattened to $0.00. */
export function formatUsd(n: number | null): string {
  if (n === null) return "—";
  if (n === 0) return "$0.00";
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

/**
 * The note under the headline cost when some sessions have tokens but no
 * price: the figure is then a partial lower bound, or "—" when nothing is
 * priceable. Undefined when every session is priced.
 */
export function unpricedNote(totals: FleetUsageTotals): string | undefined {
  const n = totals.unpricedSessionCount;
  if (n === 0) return undefined;
  return `${n} session${n === 1 ? "" : "s"} unpriced${totals.costUsd === null ? "" : " — partial"}`;
}
