/**
 * Deterministic local sampling for copy-trade research.
 *
 * This module never calls GMGN and never deletes rows. It selects a bounded, time-balanced
 * sample from rows already present in SQLite so high-volume wallets do not dominate analysis.
 * Sells are the unit of analysis; the nearest preceding buy for every selected sell is retained
 * so hold-time calculations continue to work.
 */

// No analysis sample cap: retain every stored sell. The optional limit parameter remains for
// focused tests and callers that explicitly request a sample.
export const REPRESENTATIVE_SELL_LIMIT = Number.MAX_SAFE_INTEGER;
export const REPRESENTATIVE_SAMPLE_METHOD = 'utc-day-stratified-systematic-v1';

export type RepresentativeTradeRow = {
  walletAddress: string;
  observedTimestamp: number;
  eventType: string;
  tokenAddress: string;
  id?: number;
};

export type RepresentativeWalletSample = {
  populationSellCount: number;
  selectedSellCount: number;
  sampled: boolean;
};

export type RepresentativeSampleResult<T extends RepresentativeTradeRow> = {
  rows: T[];
  byWallet: Map<string, RepresentativeWalletSample>;
};

const stableRowOrder = <T extends RepresentativeTradeRow>(left: T, right: T): number =>
  left.observedTimestamp - right.observedTimestamp || (left.id ?? 0) - (right.id ?? 0);

const utcDay = (timestamp: number): string => new Date(timestamp * 1000).toISOString().slice(0, 10);

/** Pick evenly spaced rows from a sorted bucket, including both edges when possible. */
const systematicPick = <T>(rows: T[], count: number): T[] => {
  if (count >= rows.length) return [...rows];
  if (count <= 0) return [];
  const picked: T[] = [];
  for (let index = 0; index < count; index += 1) {
    picked.push(rows[Math.min(rows.length - 1, Math.floor(((index + 0.5) * rows.length) / count))]);
  }
  return picked;
};

/**
 * Allocate a fixed quota across UTC-day buckets using largest remainder rounding. This keeps the
 * sample's time distribution close to the stored population while still sampling every period
 * that can fit into the quota.
 */
const pickSells = <T extends RepresentativeTradeRow>(sells: T[], limit: number): T[] => {
  if (sells.length <= limit) return [...sells];
  const buckets = new Map<string, T[]>();
  for (const sell of sells) {
    const bucket = buckets.get(utcDay(sell.observedTimestamp)) ?? [];
    bucket.push(sell);
    buckets.set(utcDay(sell.observedTimestamp), bucket);
  }
  const ordered = [...buckets.entries()].sort(([left], [right]) => left.localeCompare(right));
  const allocations = ordered.map(([day, rows]) => {
    const exact = rows.length * limit / sells.length;
    return { day, rows, base: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let assigned = allocations.reduce((sum, item) => sum + item.base, 0);
  // Give leftover slots to the largest fractional buckets, with the day as a stable tie-break.
  allocations.sort((left, right) => right.remainder - left.remainder || left.day.localeCompare(right.day));
  for (let index = 0; assigned < limit && index < allocations.length; index += 1) {
    allocations[index].base += 1;
    assigned += 1;
  }
  const selected = allocations.flatMap((item) => systematicPick(item.rows, item.base));
  return selected.sort(stableRowOrder);
};

/** Select a bounded, reproducible sample for every wallet represented in `rows`. */
export const selectRepresentativeTrades = <T extends RepresentativeTradeRow>(
  rows: readonly T[],
  limit = REPRESENTATIVE_SELL_LIMIT,
): RepresentativeSampleResult<T> => {
  if (!Number.isInteger(limit) || limit <= 0) throw new Error('Representative sample limit must be a positive integer.');
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const walletRows = grouped.get(row.walletAddress) ?? [];
    walletRows.push(row);
    grouped.set(row.walletAddress, walletRows);
  }

  const output: T[] = [];
  const byWallet = new Map<string, RepresentativeWalletSample>();
  for (const [walletAddress, walletRows] of grouped) {
    const orderedRows = [...walletRows].sort(stableRowOrder);
    const sells = orderedRows.filter((row) => row.eventType === 'sell');
    const selectedSells = pickSells(sells, limit);
    const selected = new Map<string, T>();
    const buysByToken = new Map<string, T[]>();
    for (const row of orderedRows) {
      if (row.eventType !== 'buy') continue;
      const tokenBuys = buysByToken.get(row.tokenAddress) ?? [];
      tokenBuys.push(row);
      buysByToken.set(row.tokenAddress, tokenBuys);
    }
    for (const sell of selectedSells) {
      selected.set(`${sell.id ?? ''}|${sell.observedTimestamp}|${sell.tokenAddress}|sell`, sell);
      const tokenBuys = buysByToken.get(sell.tokenAddress) ?? [];
      // Keep the latest prior buy, which is the same approximation used by holdSecondsPerSell.
      for (let index = tokenBuys.length - 1; index >= 0; index -= 1) {
        if (tokenBuys[index].observedTimestamp <= sell.observedTimestamp) {
          const buy = tokenBuys[index];
          selected.set(`${buy.id ?? ''}|${buy.observedTimestamp}|${buy.tokenAddress}|buy`, buy);
          break;
        }
      }
    }
    output.push(...[...selected.values()].sort(stableRowOrder));
    byWallet.set(walletAddress, {
      populationSellCount: sells.length,
      selectedSellCount: selectedSells.length,
      sampled: selectedSells.length < sells.length,
    });
  }
  return { rows: output.sort((left, right) => left.walletAddress.localeCompare(right.walletAddress) || stableRowOrder(left, right)), byWallet };
};
