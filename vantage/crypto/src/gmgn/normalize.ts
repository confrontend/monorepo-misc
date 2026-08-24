/** Shared between the server (fetching GMGN risk stats live) and the browser UI (normalizing a
 *  pasted/imported raw GMGN payload for the same feature) — both need the exact same field-alias
 *  mapping, since a live-fetched and a manually-imported payload for the same wallet must parse
 *  to the same shape. Pure functions only, no Node-specific imports, so this is safe to bundle
 *  into the Vite UI build as well as the server build. */
export const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const firstValue = (source: Record<string, unknown>, keys: string[]): unknown =>
  keys.map((key) => source[key]).find((value) => value !== undefined && value !== null);

export const numberValueByAliases = (
  source: Record<string, unknown>,
  keys: string[],
): number | null => {
  const value = firstValue(source, keys);
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

export type GmgnProfitStat = {
  realizedProfit: number | null;
  realizedPnlPercent: number | null;
  winRate: number | null;
  buys: number | null;
  sells: number | null;
  fees: number | null;
  averageHoldingSeconds: number | null;
  nativeBalance: number | null;
  tokenCount: number | null;
  risk: {
    noBuyHold: number | null;
    noBuyHoldRatio: number | null;
    sellPassBuy: number | null;
    sellPassBuyRatio: number | null;
    fastTx: number | null;
    fastTxRatio: number | null;
  };
  pnlDistribution: Record<string, number | string>;
};

export const normalizeGmgnProfitStat = (payload: unknown): GmgnProfitStat => {
  const outer = asRecord(payload);
  const source = asRecord(outer.data ?? outer.result ?? payload);
  const risk = asRecord(source.risk);
  return {
    realizedProfit: numberValueByAliases(source, ['realized_profit', 'realizedProfit', 'profit']),
    realizedPnlPercent: numberValueByAliases(source, [
      'realized_profit_pnl',
      'realized_profit_pnl_percent',
      'pnl',
      'pnl_percent',
    ]),
    winRate: numberValueByAliases(source, ['winrate', 'win_rate', 'winRate']),
    buys: numberValueByAliases(source, ['buy', 'buy_count', 'buys']),
    sells: numberValueByAliases(source, ['sell', 'sell_count', 'sells']),
    fees: numberValueByAliases(source, ['fee', 'fees', 'total_fee', 'total_fees']),
    averageHoldingSeconds: numberValueByAliases(source, [
      'avg_holding_period',
      'avg_holding_period_seconds',
      'avg_hold_time',
    ]),
    nativeBalance: numberValueByAliases(source, ['native_balance', 'nativeBalance', 'sol_balance']),
    tokenCount: numberValueByAliases(source, ['token_num', 'token_count', 'tokens']),
    risk: {
      noBuyHold: numberValueByAliases(risk, ['no_buy_hold']),
      noBuyHoldRatio: numberValueByAliases(risk, ['no_buy_hold_ratio']),
      sellPassBuy: numberValueByAliases(risk, ['sell_pass_buy']),
      sellPassBuyRatio: numberValueByAliases(risk, ['sell_pass_buy_ratio']),
      fastTx: numberValueByAliases(risk, ['fast_tx']),
      fastTxRatio: numberValueByAliases(risk, ['fast_tx_ratio']),
    },
    pnlDistribution: Object.fromEntries(
      Object.entries(source).filter(
        ([key, value]) =>
          /pnl|profit/i.test(key) && (typeof value === 'number' || typeof value === 'string'),
      ),
    ) as Record<string, number | string>,
  };
};
