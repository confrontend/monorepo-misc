/** Canonical activity types used by the accounting layer. Unknown provider values are retained
 * by callers but never treated as buys or sells. */
export type CanonicalActivityType = 'buy' | 'sell' | 'transfer_in' | 'transfer_out' | 'other';

export type InventoryEvent = {
  id?: number;
  eventType: string;
  tokenAddress: string;
  observedTimestamp: number;
  tokenAmount: string | null;
  costUsd?: string | null;
  buyCostUsd?: string | null;
};

export type ResolvedSell = {
  canonicalEventType: 'sell';
  knownAmount: number | null;
  unknownAmount: number | null;
  eligible: boolean;
  reason:
    'known_cost_basis' | 'unknown_transfer_inventory' | 'no_known_buy_inventory' | 'invalid_sell';
};

type LotState = {
  knownAmount: number | null;
  knownLotCount: number;
  unknownAmount: number | null;
};

const finiteAmount = (value: string | null | undefined): number | null => {
  if (value === null || value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

/** Map GMGN spellings to one internal vocabulary. `transfer` is treated as incoming because the
 * legacy browser payload did not distinguish direction; caution is safer than inventing a buy. */
export const canonicalizeActivityType = (
  value: string | null | undefined,
): CanonicalActivityType => {
  const normalized = (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (normalized === 'buy') return 'buy';
  if (normalized === 'sell') return 'sell';
  if (
    normalized === 'transfer_in' ||
    normalized === 'transferin' ||
    normalized === 'tx_in' ||
    normalized === 'txin' ||
    normalized === 'received' ||
    normalized === 'receive' ||
    normalized === 'transfer'
  )
    return 'transfer_in';
  if (
    normalized === 'transfer_out' ||
    normalized === 'transferout' ||
    normalized === 'tx_out' ||
    normalized === 'txout' ||
    normalized === 'sent'
  )
    return 'transfer_out';
  return 'other';
};

const add = (left: number | null, right: number | null): number | null =>
  left === null || right === null ? null : left + right;

/**
 * Conservative chronological inventory accounting. A transfer contaminates the token position:
 * while unknown inventory remains, a sell is entirely unproven rather than assuming the bought
 * lots were sold first. This prevents transfer-backed inventory from receiving artificial PnL.
 */
export class TransferAwareInventory {
  private readonly lots = new Map<string, LotState>();

  apply(row: InventoryEvent): ResolvedSell | null {
    const type = canonicalizeActivityType(row.eventType);
    if (type === 'other' || type === 'transfer_out') return null;
    const current = this.lots.get(row.tokenAddress) ?? {
      knownAmount: 0,
      knownLotCount: 0,
      unknownAmount: 0,
    };
    if (type === 'buy') {
      const amount = finiteAmount(row.tokenAmount);
      current.knownAmount = add(current.knownAmount, amount);
      current.knownLotCount += 1;
      this.lots.set(row.tokenAddress, current);
      return null;
    }
    if (type === 'transfer_in') {
      const amount = finiteAmount(row.tokenAmount);
      current.unknownAmount = add(current.unknownAmount, amount);
      this.lots.set(row.tokenAddress, current);
      return null;
    }

    const sellAmount = finiteAmount(row.tokenAmount);
    if (sellAmount === null) {
      if (current.unknownAmount === null || current.unknownAmount > 0) {
        return {
          canonicalEventType: 'sell',
          knownAmount: null,
          unknownAmount: null,
          eligible: false,
          reason: 'unknown_transfer_inventory',
        };
      }
      if (current.knownLotCount > 0) {
        return {
          canonicalEventType: 'sell',
          knownAmount: null,
          unknownAmount: 0,
          eligible: true,
          reason: 'known_cost_basis',
        };
      }
      return {
        canonicalEventType: 'sell',
        knownAmount: null,
        unknownAmount: null,
        eligible: false,
        reason: 'invalid_sell',
      };
    }
    if (current.unknownAmount === null || current.unknownAmount > 0) {
      const unknownBefore = current.unknownAmount;
      if (unknownBefore !== null) {
        const consumedUnknown = Math.min(unknownBefore, sellAmount);
        current.unknownAmount = unknownBefore - consumedUnknown;
        const knownConsumed = sellAmount - consumedUnknown;
        if (current.knownAmount !== null)
          current.knownAmount = Math.max(0, current.knownAmount - knownConsumed);
      }
      this.lots.set(row.tokenAddress, current);
      return {
        canonicalEventType: 'sell',
        knownAmount: null,
        unknownAmount: sellAmount,
        eligible: false,
        reason: 'unknown_transfer_inventory',
      };
    }
    if (current.knownLotCount === 0) {
      return {
        canonicalEventType: 'sell',
        knownAmount: null,
        unknownAmount: sellAmount,
        eligible: false,
        reason: 'no_known_buy_inventory',
      };
    }
    // A known buy with an omitted token amount still provides provenance, even though quantity
    // matching is impossible. For a quantified buy, never let a sell exceed known inventory.
    if (current.knownAmount !== null)
      current.knownAmount = Math.max(0, current.knownAmount - sellAmount);
    this.lots.set(row.tokenAddress, current);
    return {
      canonicalEventType: 'sell',
      knownAmount: sellAmount,
      unknownAmount: 0,
      eligible: true,
      reason: 'known_cost_basis',
    };
  }
}
