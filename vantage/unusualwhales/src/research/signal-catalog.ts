export type SignalFeasibility = 'ready' | 'candidate' | 'limited' | 'blocked';

export type SignalDefinition = {
  id: string;
  label: string;
  family: 'options' | 'equity' | 'macro' | 'public-filings';
  sourceEndpoint: string;
  eventTimestampField: string;
  simpleRule: string;
  direction: 'bullish' | 'bearish' | 'signed' | 'neutral';
  feasibility: SignalFeasibility;
  timingLimitations: string;
};

/**
 * Breadth-first registry. This is deliberately descriptive: it records what can
 * be tested and how, without selecting thresholds or implying profitability.
 */
export const SIGNAL_CATALOG: readonly SignalDefinition[] = [
  {
    id: 'call_sweep', label: 'Call Sweeps', family: 'options',
    sourceEndpoint: 'GET /api/option-trades', eventTimestampField: 'executed_at',
    simpleRule: 'Provider report flag intermarket_sweep and option type call.', direction: 'bullish',
    feasibility: 'ready', timingLimitations: 'Provider publication delay; current implementation excludes canceled trades.'
  },
  {
    id: 'put_sweep', label: 'Put Sweeps', family: 'options',
    sourceEndpoint: 'GET /api/option-trades', eventTimestampField: 'executed_at',
    simpleRule: 'Provider report flag intermarket_sweep and option type put.', direction: 'bearish',
    feasibility: 'candidate', timingLimitations: 'Requires a separate normalized import; direction must be evaluated as bearish.'
  },
  {
    id: 'repeated_sweeps', label: 'Repeated Sweeps / Hits', family: 'options',
    sourceEndpoint: 'GET /api/option-trades or repeated-hit alerts', eventTimestampField: 'executed_at',
    simpleRule: 'At least three same-direction sweeps for one symbol inside a fixed 30-minute window.', direction: 'signed',
    feasibility: 'candidate', timingLimitations: 'Must be grouped using only events available by the group end time; overlapping groups need one representative.'
  },
  {
    id: 'dark_pool_block', label: 'Dark Pool Blocks', family: 'equity',
    sourceEndpoint: 'GET /api/darkpool/recent or GET /api/darkpool/{ticker}', eventTimestampField: 'executed_at',
    simpleRule: 'Every non-canceled block above a fixed notional floor; retain reported side when available.', direction: 'signed',
    feasibility: 'candidate', timingLimitations: 'Reported execution may lag the true trade; block direction can be unavailable or ambiguous.'
  },
  {
    id: 'flow_imbalance', label: 'Call/Put Flow Imbalance', family: 'options',
    sourceEndpoint: 'Derived from imported Call/Put Sweep trades', eventTimestampField: 'executed_at',
    simpleRule: 'Thirty-minute mixed call/put sweep premium imbalance, (call premium - put premium) / total premium.', direction: 'signed',
    feasibility: 'candidate', timingLimitations: 'This is sweep-only flow, not the provider market-tide feed; only windows containing both call and put sweeps are included.'
  },
  {
    id: 'open_interest_spike', label: 'Open Interest Spikes', family: 'options',
    sourceEndpoint: 'GET /api/market/oi-change', eventTimestampField: 'curr_date',
    simpleRule: 'Daily open interest increase versus the prior observation for the same contract.', direction: 'signed',
    feasibility: 'candidate', timingLimitations: 'Daily OI is not an intraday signal; the provider response exposes the current and prior observation dates.'
  },
  {
    id: 'gex_gamma', label: 'GEX / Gamma', family: 'options',
    sourceEndpoint: 'GET /api/stock/{ticker}/spot-exposures', eventTimestampField: 'time',
    simpleRule: 'Use the first published signed gamma exposure observation per symbol/day.', direction: 'signed',
    feasibility: 'candidate', timingLimitations: 'GEX is evaluated as a volatility/regime observation; the provider timestamp is used as the observable calculation time.'
  },
  {
    id: 'market_etf_flow', label: 'Market / ETF Flow', family: 'macro',
    sourceEndpoint: 'GET /api/market/market-tide and GET /api/market/{ticker}/etf-tide', eventTimestampField: 'timestamp',
    simpleRule: 'Timestamped aggregate flow observation for SPY or another liquid ETF.', direction: 'signed',
    feasibility: 'candidate', timingLimitations: 'Market/ETF aggregates are regime observations; the timestamp is the provider tick start and must not be treated as a trade execution time.'
  },
  {
    id: 'insider_activity', label: 'Insider Activity', family: 'public-filings',
    sourceEndpoint: 'GET /api/insider/transactions', eventTimestampField: 'filing_date',
    simpleRule: 'First disclosed purchase or sale per issuer/insider filing.', direction: 'signed',
    feasibility: 'candidate', timingLimitations: 'Backtest entry uses the filing date, not the underlying transaction date; sparse observations require longer horizons.'
  },
  {
    id: 'congress_activity', label: 'Congress Activity', family: 'public-filings',
    sourceEndpoint: 'GET /api/politician-portfolios/recent_trades', eventTimestampField: 'filed_at_date',
    simpleRule: 'First public disclosure of a buy or sell transaction per issuer/day.', direction: 'signed',
    feasibility: 'candidate', timingLimitations: 'Backtest entry uses filed_at_date, not transaction_date; disclosure lag and sparse samples make short horizons unsuitable.'
  },
] as const;

export const getSignalDefinition = (id: string) => SIGNAL_CATALOG.find((signal) => signal.id === id) ?? null;
