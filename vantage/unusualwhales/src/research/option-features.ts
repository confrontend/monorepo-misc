import type { DatabaseSync } from 'node:sqlite';

type RawTrade = {
  id: number;
  premium: string | null;
  size: number | null;
  openInterest: number | null;
  price: string | null;
  nbboBid: string | null;
  nbboAsk: string | null;
  strike: string | null;
  underlyingPrice: string | null;
  expiry: string | null;
  executedAt: string | null;
  rawPayload: string;
  reportFlags: string;
  tags: string;
};

const finite = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const rawNumber = (payload: Record<string, unknown>, ...keys: string[]) => {
  for (const key of keys) {
    const value = finite(payload[key]);
    if (value !== null) return value;
  }
  return null;
};

const parseArray = (value: string) => { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; } };

/** Rebuilds deterministic, queryable microstructure features from normalized trades. */
export const refreshOptionFeatures = (database: DatabaseSync, now = new Date()): number => {
  const rows = database.prepare(`SELECT id,premium,size,open_interest AS openInterest,price,nbbo_bid AS nbboBid,nbbo_ask AS nbboAsk,
    strike,underlying_price AS underlyingPrice,expiry,executed_at AS executedAt,raw_payload AS rawPayload,report_flags AS reportFlags,tags
    FROM uw_option_trades WHERE canceled=0 ORDER BY id`).iterate() as Iterable<RawTrade>;
  const insert = database.prepare(`INSERT INTO uw_option_features
    (trade_id,volume_oi_ratio,spread_pct,moneyness_pct,dte_days,side_score,implied_volatility,delta,gamma,vega,is_opening_trade,calculated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(trade_id) DO UPDATE SET volume_oi_ratio=excluded.volume_oi_ratio,
    spread_pct=excluded.spread_pct,moneyness_pct=excluded.moneyness_pct,dte_days=excluded.dte_days,side_score=excluded.side_score,
    implied_volatility=excluded.implied_volatility,delta=excluded.delta,gamma=excluded.gamma,vega=excluded.vega,
    is_opening_trade=excluded.is_opening_trade,calculated_at=excluded.calculated_at`);
  let written = 0;
  database.exec('BEGIN');
  try {
    for (const row of rows) {
      let payload: Record<string, unknown> = {};
      try { const parsed = JSON.parse(row.rawPayload); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>; } catch { /* raw payload remains auditable */ }
      const bid = finite(row.nbboBid) ?? rawNumber(payload, 'nbbo_bid', 'bid');
      const ask = finite(row.nbboAsk) ?? rawNumber(payload, 'nbbo_ask', 'ask');
      const price = finite(row.price) ?? rawNumber(payload, 'price');
      const strike = finite(row.strike) ?? rawNumber(payload, 'strike');
      const underlying = finite(row.underlyingPrice) ?? rawNumber(payload, 'underlying_price');
      const openInterest = finite(row.openInterest) ?? rawNumber(payload, 'open_interest');
      const volume = rawNumber(payload, 'volume') ?? finite(row.size);
      const midpoint = bid !== null && ask !== null ? (bid + ask) / 2 : null;
      const spreadPct = midpoint && ask !== null && bid !== null ? (ask - bid) / midpoint * 100 : null;
      const sideScore = price !== null && bid !== null && ask !== null && ask > bid ? Math.max(-1, Math.min(1, (price - midpoint!) / ((ask - bid) / 2))) : null;
      const dteDays = row.expiry && row.executedAt ? (Date.parse(row.expiry) - Date.parse(row.executedAt)) / 86_400_000 : null;
      const moneynessPct = strike !== null && underlying ? (strike / underlying - 1) * 100 : null;
      const flags = [...parseArray(row.reportFlags), ...parseArray(row.tags)].map(value => value.toLowerCase());
      const opening = rawNumber(payload, 'all_opening_trades') ?? (flags.some(value => value.includes('open')) ? 1 : null);
      insert.run(row.id, volume !== null && openInterest ? volume / openInterest : null, spreadPct, moneynessPct, Number.isFinite(dteDays) ? dteDays : null,
        sideScore, rawNumber(payload, 'implied_volatility', 'iv'), rawNumber(payload, 'delta'), rawNumber(payload, 'gamma'), rawNumber(payload, 'vega'), opening, now.toISOString());
      written++;
    }
    database.exec('COMMIT');
  } catch (error) { try { database.exec('ROLLBACK'); } catch { /* preserve original error */ } throw error; }
  return written;
};
