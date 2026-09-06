export const COPY_PORTFOLIO_STARTING_CAPITAL_USD = 100;
export const COPY_PORTFOLIO_STAKE_USD = 10;
export const COPY_PORTFOLIO_MAX_OPEN_POSITIONS = 10;

export type CopySimulationScenario = {
  startingBankrollUsd: number;
  copyAmountUsd: number;
};

export type FixedStakePortfolioTrade = {
  id: number;
  entryAt: number;
  exitAt: number;
  returnRatio: number;
  gasFeeSol: number;
  gasFeeUsd?: number | null;
  positionId?: number;
  /** Fraction of the original wallet position copied by this leg. */
  copyFraction?: number;
  stakeUsd?: number;
  entryGasFeeSol?: number;
  exitGasFeeSol?: number;
  entryGasFeeUsd?: number | null;
  exitGasFeeUsd?: number | null;
  cutoffReturnRatio?: number | null;
  isOpenAtCutoff?: boolean;
};

export type FixedStakePortfolioReport = {
  startingCapitalUsd: number;
  stakePerTradeUsd: number;
  maxOpenPositions: number;
  endingCapitalUsd: number;
  realizedPnlUsd: number;
  markToMarketPnlUsd?: number;
  openPositionsMarked?: number;
  openPositionsUnpriced?: number;
  eligibleTrades: number;
  copiedTrades: number;
  skippedInsufficientCash: number;
  skippedMaxOpenPositions: number;
  maxConcurrentPositions: number;
  maxConcurrentCapitalUsd?: number;
  totalCapitalDeployedUsd?: number;
  gasFeeSol: number;
  gasFeeUsd?: number;
  gasCostComplete?: boolean;
  capitalPath: { day: string; capitalUsd: number }[];
  tradeCapitalPath?: { trade: number; tradeId?: number; day: string; capitalUsd: number }[];
};

const round = (value: number, digits = 2): number => {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

export const scenarioStakeFor = (copyAmountUsd: number, copyFraction: number): number =>
  copyAmountUsd * copyFraction;

/**
 * Cash-constrained local portfolio replay. It is deliberately pure so the same accounting is
 * used by the server's canonical report and the browser's Scenario Replay panel. The trade
 * return ratios and gas values are inputs; this function never talks to a provider.
 */
export const simulateFixedStakePortfolio = (
  trades: FixedStakePortfolioTrade[],
  options: {
    scenario?: CopySimulationScenario;
    startingCapitalUsd?: number;
    stakePerTradeUsd?: number;
    maxOpenPositions?: number;
  } = {},
): FixedStakePortfolioReport => {
  const startingCapitalUsd =
    options.scenario?.startingBankrollUsd ??
    options.startingCapitalUsd ??
    COPY_PORTFOLIO_STARTING_CAPITAL_USD;
  const stakePerTradeUsd =
    options.scenario?.copyAmountUsd ?? options.stakePerTradeUsd ?? COPY_PORTFOLIO_STAKE_USD;
  const maxOpenPositions = options.maxOpenPositions ?? COPY_PORTFOLIO_MAX_OPEN_POSITIONS;
  const valid = trades.filter(
    (trade) => Number.isFinite(trade.returnRatio) && trade.exitAt >= trade.entryAt,
  );
  if (valid.length === 0)
    return {
      startingCapitalUsd,
      stakePerTradeUsd,
      maxOpenPositions,
      endingCapitalUsd: startingCapitalUsd,
      realizedPnlUsd: 0,
      markToMarketPnlUsd: 0,
      openPositionsMarked: 0,
      openPositionsUnpriced: 0,
      eligibleTrades: 0,
      copiedTrades: 0,
      skippedInsufficientCash: 0,
      skippedMaxOpenPositions: 0,
      maxConcurrentPositions: 0,
      maxConcurrentCapitalUsd: 0,
      totalCapitalDeployedUsd: 0,
      gasFeeSol: 0,
      gasFeeUsd: 0,
      gasCostComplete: true,
      capitalPath: [],
      tradeCapitalPath: [],
    };

  type PortfolioEvent = {
    at: number;
    kind: 'entry' | 'exit';
    trade: FixedStakePortfolioTrade;
    positionKey: string;
    stakeUsd: number;
  };
  const stakeFor = (trade: FixedStakePortfolioTrade): number => {
    if (options.scenario) {
      const copyFraction =
        trade.copyFraction ??
        (trade.stakeUsd === undefined ? 1 : trade.stakeUsd / COPY_PORTFOLIO_STAKE_USD);
      return scenarioStakeFor(stakePerTradeUsd, copyFraction);
    }
    return trade.stakeUsd ?? stakePerTradeUsd;
  };
  const positionGroups = new Map<string, { trade: FixedStakePortfolioTrade; stakeUsd: number }>();
  for (const trade of valid) {
    const positionKey = String(trade.positionId ?? trade.id);
    const group = positionGroups.get(positionKey);
    if (group) group.stakeUsd += stakeFor(trade);
    else positionGroups.set(positionKey, { trade, stakeUsd: stakeFor(trade) });
  }
  const events: PortfolioEvent[] = [];
  for (const [positionKey, group] of positionGroups) {
    events.push({
      at: group.trade.entryAt,
      kind: 'entry',
      trade: group.trade,
      positionKey,
      stakeUsd: group.stakeUsd,
    });
  }
  for (const trade of valid) {
    if (trade.isOpenAtCutoff) continue;
    events.push({
      at: trade.exitAt,
      kind: 'exit',
      trade,
      positionKey: String(trade.positionId ?? trade.id),
      stakeUsd: stakeFor(trade),
    });
  }
  events.sort(
    (left, right) =>
      left.at - right.at ||
      (left.kind === right.kind ? left.trade.id - right.trade.id : left.kind === 'exit' ? -1 : 1),
  );

  let cash = startingCapitalUsd;
  let copiedTrades = 0;
  let skippedInsufficientCash = 0;
  let skippedMaxOpenPositions = 0;
  let maxConcurrentPositions = 0;
  let maxConcurrentCapitalUsd = 0;
  let totalCapitalDeployedUsd = 0;
  let gasFeeSol = 0;
  let gasFeeUsd = 0;
  let gasCostComplete = true;
  const open = new Map<string, number>();
  const acceptedPositions = new Set<string>();
  const dailyEquity = new Map<string, number>();
  const tradeCapitalPath: { trade: number; tradeId?: number; day: string; capitalUsd: number }[] =
    [];
  const firstDay = new Date(events[0].at * 1000).toISOString().slice(0, 10);
  const equity = (): number => cash + [...open.values()].reduce((sum, value) => sum + value, 0);

  for (const event of events) {
    if (event.kind === 'entry') {
      if (open.size >= maxOpenPositions) {
        skippedMaxOpenPositions += 1;
        continue;
      }
      if (cash + 1e-9 < event.stakeUsd) {
        skippedInsufficientCash += 1;
        continue;
      }
      cash -= event.stakeUsd;
      open.set(event.positionKey, event.stakeUsd);
      acceptedPositions.add(event.positionKey);
      totalCapitalDeployedUsd += event.stakeUsd;
      maxConcurrentPositions = Math.max(maxConcurrentPositions, open.size);
      maxConcurrentCapitalUsd = Math.max(
        maxConcurrentCapitalUsd,
        [...open.values()].reduce((sum, value) => sum + value, 0),
      );
      if (event.trade.entryGasFeeSol !== undefined) {
        gasFeeSol += event.trade.entryGasFeeSol;
        if (event.trade.entryGasFeeUsd == null) gasCostComplete = false;
        else {
          gasFeeUsd += event.trade.entryGasFeeUsd;
          cash -= event.trade.entryGasFeeUsd;
        }
      }
    } else if (acceptedPositions.has(event.positionKey)) {
      const remaining = open.get(event.positionKey) ?? 0;
      if (remaining <= 0) continue;
      const stakeUsd = Math.min(event.stakeUsd, remaining);
      cash += stakeUsd * Math.max(0, 1 + event.trade.returnRatio);
      open.set(event.positionKey, Math.max(0, remaining - stakeUsd));
      if (open.get(event.positionKey) === 0) open.delete(event.positionKey);
      copiedTrades += 1;
      if (event.trade.exitGasFeeSol !== undefined) {
        gasFeeSol += event.trade.exitGasFeeSol;
        if (event.trade.exitGasFeeUsd == null) gasCostComplete = false;
        else {
          gasFeeUsd += event.trade.exitGasFeeUsd;
          cash -= event.trade.exitGasFeeUsd;
        }
      } else {
        cash -= event.trade.gasFeeUsd ?? 0;
        gasFeeSol += event.trade.gasFeeSol;
        if (event.trade.gasFeeUsd == null) gasCostComplete = false;
        else gasFeeUsd += event.trade.gasFeeUsd;
      }
      tradeCapitalPath.push({
        trade: tradeCapitalPath.length + 1,
        tradeId: event.trade.id,
        day: new Date(event.at * 1000).toISOString(),
        capitalUsd: round(equity(), 2),
      });
    }
    const day = new Date(event.at * 1000).toISOString().slice(0, 10);
    dailyEquity.set(day, equity());
  }

  let markToMarketPnlUsd = 0;
  let openPositionsMarked = 0;
  let openPositionsUnpriced = 0;
  for (const [positionKey, remainingStake] of open) {
    const entry = positionGroups.get(positionKey)?.trade;
    if (
      entry?.cutoffReturnRatio === null ||
      entry?.cutoffReturnRatio === undefined ||
      !Number.isFinite(entry.cutoffReturnRatio)
    ) {
      openPositionsUnpriced += 1;
      continue;
    }
    cash += remainingStake * Math.max(0, 1 + entry.cutoffReturnRatio);
    markToMarketPnlUsd += remainingStake * entry.cutoffReturnRatio;
    open.delete(positionKey);
    openPositionsMarked += 1;
  }
  const endingCapitalUsd = round(equity(), 2);
  return {
    startingCapitalUsd,
    stakePerTradeUsd,
    maxOpenPositions,
    endingCapitalUsd,
    realizedPnlUsd: round(endingCapitalUsd - startingCapitalUsd - markToMarketPnlUsd, 2),
    markToMarketPnlUsd: round(markToMarketPnlUsd, 2),
    openPositionsMarked,
    openPositionsUnpriced,
    eligibleTrades: valid.length,
    copiedTrades,
    skippedInsufficientCash,
    skippedMaxOpenPositions,
    maxConcurrentPositions,
    maxConcurrentCapitalUsd: round(maxConcurrentCapitalUsd, 2),
    totalCapitalDeployedUsd: round(totalCapitalDeployedUsd, 2),
    gasFeeSol: round(gasFeeSol, 6),
    gasFeeUsd: round(gasFeeUsd, 2),
    gasCostComplete,
    tradeCapitalPath,
    capitalPath: [
      { day: `${firstDay} start`, capitalUsd: startingCapitalUsd },
      ...[...dailyEquity.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([day, capitalUsd]) => ({ day, capitalUsd: round(capitalUsd, 2) })),
    ],
  };
};

/** Apply a scenario amount while retaining the historical partial-sell fraction semantics. */
export const replayTradesForScenario = (
  trades: FixedStakePortfolioTrade[],
  copyAmountUsd: number,
): FixedStakePortfolioTrade[] =>
  trades.map((trade) => ({
    ...trade,
    stakeUsd: scenarioStakeFor(
      copyAmountUsd,
      trade.copyFraction ?? (trade.stakeUsd === undefined ? 1 : trade.stakeUsd / 10),
    ),
  }));
