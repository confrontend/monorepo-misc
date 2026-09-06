import { useMemo, useState } from 'react';
import {
  COPY_PORTFOLIO_MAX_OPEN_POSITIONS,
  replayTradesForScenario,
  simulateFixedStakePortfolio,
  type CopySimulationScenario,
  type FixedStakePortfolioTrade,
} from '../../src/copytrade/simulation/fixedStakePortfolio.js';
import { strings } from '../strings.js';

type ScenarioReplayPanelProps = {
  walletLabel: string;
  trades: FixedStakePortfolioTrade[];
};

const formatUsd = (value: number | null | undefined): string =>
  value === null || value === undefined
    ? '—'
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: Math.abs(value) < 10 ? 2 : 0,
      }).format(value);

const parsePositive = (value: string, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const ScenarioReplayPanel = ({ walletLabel, trades }: ScenarioReplayPanelProps) => {
  const [startingBankroll, setStartingBankroll] = useState('100');
  const [copyAmount, setCopyAmount] = useState('10');
  const startingBankrollUsd = parsePositive(startingBankroll, 100);
  const copyAmountUsd = parsePositive(copyAmount, 10);
  const replay = useMemo(() => {
    const scenario: CopySimulationScenario = { startingBankrollUsd, copyAmountUsd };
    const replayTrades = replayTradesForScenario(trades, scenario.copyAmountUsd);
    return simulateFixedStakePortfolio(replayTrades, {
      scenario,
      maxOpenPositions: COPY_PORTFOLIO_MAX_OPEN_POSITIONS,
    });
  }, [copyAmountUsd, startingBankrollUsd, trades]);
  const returnPercent =
    startingBankrollUsd > 0
      ? ((replay.endingCapitalUsd - startingBankrollUsd) / startingBankrollUsd) * 100
      : null;
  const totalPnlUsd = replay.endingCapitalUsd - startingBankrollUsd;
  const skippedTrades = replay.skippedInsufficientCash + replay.skippedMaxOpenPositions;
  const gasLabel = replay.gasCostComplete
    ? formatUsd(replay.gasFeeUsd)
    : `${formatUsd(replay.gasFeeUsd)} + ${replay.gasFeeSol.toFixed(4)} SOL*`;

  return (
    <section className="scenario-replay-panel" aria-label="Scenario Replay">
      <div className="scenario-replay-heading">
        <div>
          <p className="eyebrow">SCENARIO REPLAY · LOCAL ONLY</p>
          <h3>Replay {walletLabel}</h3>
          <small>{strings.decisionLab.scenarioReplay.noDune}</small>
        </div>
        <span className="scenario-replay-badge">Does not change Winner Policy</span>
      </div>
      <div className="scenario-replay-controls">
        <label>
          <span>{strings.decisionLab.scenarioReplay.startingBankroll}</span>
          <input
            type="number"
            min="0.01"
            step="0.01"
            value={startingBankroll}
            onChange={(event) => setStartingBankroll(event.target.value)}
          />
        </label>
        <label>
          <span>{strings.decisionLab.scenarioReplay.copyAmount}</span>
          <input
            type="number"
            min="0.01"
            step="0.01"
            value={copyAmount}
            onChange={(event) => setCopyAmount(event.target.value)}
          />
        </label>
        <div className="scenario-replay-presets" aria-label="Copy amount presets">
          {['25', '50', '100', '250', '500'].map((preset) => (
            <button
              type="button"
              className={copyAmount === preset ? 'active' : undefined}
              key={preset}
              onClick={() => setCopyAmount(preset)}
            >
              ${preset}
            </button>
          ))}
        </div>
      </div>
      <div className="scenario-replay-results">
        <div>
          <span>Starting</span>
          <strong>{formatUsd(startingBankrollUsd)}</strong>
        </div>
        <div>
          <span>Ending</span>
          <strong>{formatUsd(replay.endingCapitalUsd)}</strong>
        </div>
        <div>
          <span>P&amp;L</span>
          <strong className={totalPnlUsd >= 0 ? 'positive' : 'negative'}>
            {formatUsd(totalPnlUsd)}
          </strong>
        </div>
        <div>
          <span>Return</span>
          <strong className={(returnPercent ?? 0) >= 0 ? 'positive' : 'negative'}>
            {returnPercent === null ? '—' : `${returnPercent.toFixed(1)}%`}
          </strong>
        </div>
        <div>
          <span>Copied / skipped</span>
          <strong>
            {replay.copiedTrades} / {skippedTrades}
          </strong>
        </div>
        <div>
          <span>Capital deployed</span>
          <strong>{formatUsd(replay.totalCapitalDeployedUsd)}</strong>
        </div>
        <div>
          <span>Gas / fees</span>
          <strong>{gasLabel}</strong>
        </div>
        <div>
          <span>Max open capital</span>
          <strong>{formatUsd(replay.maxConcurrentCapitalUsd)}</strong>
        </div>
      </div>
      {trades.length === 0 && (
        <small className="scenario-replay-warning">
          No stored delayed-copy trades for this wallet yet.
        </small>
      )}
      {skippedTrades > 0 && (
        <small className="scenario-replay-warning">
          {skippedTrades} trade{skippedTrades === 1 ? '' : 's'} skipped:{' '}
          {replay.skippedInsufficientCash} for insufficient bankroll,{' '}
          {replay.skippedMaxOpenPositions} at the open-position limit.
        </small>
      )}
      {!replay.gasCostComplete && (
        <small className="scenario-replay-warning">
          * Some gas has no stored USD conversion; SOL total is shown.
        </small>
      )}
    </section>
  );
};
