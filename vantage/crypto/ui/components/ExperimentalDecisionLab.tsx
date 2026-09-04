import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DataTable } from './DataTable.js';
import { Modal } from './Modal.js';
import { GmgnTag } from './GmgnTag.js';
import { WalletDataCoveragePanel } from './WalletDataCoveragePanel.js';
import { DataStatusSummary } from './data/DataStatusSummary.js';
import { Input } from './ui/input.js';
import { Switch } from './ui/switch.js';
import { Checkbox } from './ui/checkbox.js';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip.js';
import { strings } from '../strings.js';
import type { ApiClient } from '../httpClient.js';

type LabWallet = {
  walletAddress: string;
  name: string | null;
  rank: number | null;
  tags?: string[];
  evidence: { level: 'complete' | 'partial' | 'insufficient' | 'missing'; detail: string };
  candidateStatus: 'eligible' | 'rejected' | 'insufficient_evidence' | 'missing_evidence';
  winnerPolicy: {
    policyVersion: string;
    status: 'WINNER' | 'REJECTED' | 'UNPROVEN';
    actionability?: 'ACTIONABLE' | 'REVIEW' | 'NOT_ACTIONABLE';
    finalScore: number | null;
    proofGates: {
      completedCopiedTrades: { status: string; detail: string };
      simulatedPortfolioPositive: { status: string; detail: string };
      duneEvidenceActionable: { status: string; detail: string };
      uncopyableProfitDependency: { status: string; detail: string };
    };
    profitabilityScore: {
      score: number;
      max: number;
      portfolioScore: number;
      profitFactorScore: number;
      evidenceConfidenceScore: number;
      robustnessScore: number;
      weightedProfitFactor: number | null;
      bestTradeProfitSharePercent: number | null;
      bestThreeProfitSharePercent: number | null;
      portfolioWithoutBestTradeEndingCapitalUsd: number | null;
    } | null;
    gmgnRiskScore: {
      score: number;
      max: number;
      walletAgeDays: number | null;
      deductions: {
        executionSpeed: number;
        hyperactivity: number;
        tradeQuality: number;
        tokenRisk: number;
        costs: number;
        walletAge: number;
      };
      deductionDetails?: {
        executionSpeed: string;
        hyperactivity: string;
        tradeQuality: string;
        tokenRisk: string;
        costs: string;
        walletAge: string;
      };
    } | null;
    gates: Array<{ label: string; status: string; detail: string }>;
    positiveReasons: string[];
    rejectionReasons: string[];
    unprovenReasons: string[];
    warnings: string[];
    evidence: {
      periodDays: number | null;
      completedCopiedBuyOutcomes: number;
      medianReturnPercent: number | null;
      startingCapitalUsd: number;
      endingCapitalUsd: number | null;
      capitalPath?: Array<{ day: string; capitalUsd: number }>;
      riskBundle: { fetchedAt: string } | null;
      holdouts: Array<{
        index: number;
        completedCopiedBuyOutcomes: number;
        medianReturnPercent: number | null;
        endingCapitalUsd: number | null;
        profitable: boolean | null;
      }>;
      coverageQuality?: {
        status: string;
        operationalStatus?: 'PENDING' | 'GOOD' | 'REVIEW' | 'UNPROVEN';
        missingTradeMateriality?: {
          severity: 'LOW' | 'MODERATE' | 'HIGH';
          aggregateInterpretation: string;
        };
        eligibleTrips: number;
        simulatedTrips: number;
        confirmedMissing: { total: number; missingEntry: number; missingExit: number };
        pendingTrips: number;
        coveragePercent: number | null;
        reason: string;
      };
    };
  };
  scores: {
    edge: number | null;
    consistency: number | null;
    robustness: number | null;
    copyability: number | null;
    overall: number | null;
  };
  scoreDetails?: Record<
    'edge' | 'consistency' | 'robustness' | 'copyability' | 'overall',
    { label: string; detail: string }
  >;
  copyabilityDiagnostics: {
    medianHoldSeconds: number | null;
    holdContribution: number | null;
    fastRoundTripPercent: number | null;
    fastRoundTripPenalty: number;
    under15SecondPercent: number | null;
    under15SecondPenalty: number;
    patternAdjustment: number;
    confidenceAdjustment: number;
    sampleSize: {
      pairedTrades: number;
      holdingObservations: number;
      fastRoundTripDenominator: number;
      under15SecondDenominator: number;
      under15SecondObservations: number | null;
    };
    confidence: 'insufficient' | 'low' | 'moderate' | 'high';
    gate: 'pass' | 'insufficient_sample' | 'missing_hold';
    finalScore: number | null;
  };
  facts: {
    activityPeriodDays: 30 | 60 | 90;
    activityTradeCount: number;
    activityMedianReturnPercent: number | null;
    activityUnder15SecondsPercent?: number | null;
    activityBestTokenSharePercent?: number | null;
    activityFastRoundTripPercent?: number | null;
    activityNoCostBasisPercent?: number | null;
    activityMedianHoldSeconds: number | null;
    officialGmgnPeriod?: string | null;
    officialGmgnFetchedAt?: string | null;
    officialGmgnBuyCount?: number | null;
    officialGmgnSellCount?: number | null;
    officialGmgnWinRatePercent?: number | null;
    officialGmgnRealizedProfitUsd?: number | null;
    copyMedianPercent: number | null;
    copyCapitalUsd: number | null;
    duneCoveragePercent: number | null;
    matchedRoundTrips: number;
    roundTripsConsidered: number;
  };
  scrutiny: {
    pass: number;
    fail: number;
    insufficient: number;
    checks: Array<{ label: string; verdict: string; detail: string }>;
  } | null;
  riskDetails?: { available: boolean; metrics: Record<string, unknown> | null };
  liquidity: { low: number | null; medium: number | null; high: number | null } | null;
  liquidityBands?: Array<{
    band: 'low' | 'medium' | 'high';
    minEntryTradeAmountUsd: number;
    maxEntryTradeAmountUsd: number;
    tradeCount: number;
    simulatedCount: number;
    missedCount: number;
    missedTradeRatePercent: number | null;
    winRatePercent: number | null;
    medianSimulatedReturnPercent: number | null;
    medianWalletReturnPercent: number | null;
    medianDelayCostPercentagePoints: number | null;
    reliable: boolean;
  }> | null;
  risks: string[];
};

const fallbackDeductionDetail = (rule: string, deduction: number): string => {
  const labels: Record<string, string> = {
    executionSpeed: 'Execution-speed penalty',
    hyperactivity: 'Hyperactivity penalty',
    tradeQuality: 'Trade-quality penalty',
    tokenRisk: 'Token/security-risk penalty',
    costs: 'Cost/fee penalty',
    walletAge: 'Wallet-maturity penalty',
  };
  const label = labels[rule] ?? 'GMGN risk penalty';
  return deduction > 0
    ? `${label}: −${deduction} points; detailed source metrics are unavailable in this saved result.`
    : `${label}: no points deducted; no qualifying signal is present in this saved result.`;
};
type LabResponse = {
  generatedAt: string;
  periodDays: number;
  readOnly: true;
  noProviderFetch: true;
  source: string;
  winnerPolicyVersion: string;
  methodology: string[];
  weighting?: {
    mode: 'fixed-fallback' | 'validated-patterns';
    weights: { edge: number; consistency: number; robustness: number; copyability: number };
    detail: string;
    supportingThresholds: number[];
    supportingWallets: number;
  };
  wallets: LabWallet[];
};

type LabSortKey =
  | 'rank'
  | 'wallet'
  | 'evidence'
  | 'winnerScore'
  | 'coverageQuality'
  | 'edge'
  | 'consistency'
  | 'robustness'
  | 'copyability'
  | 'overall'
  | 'facts'
  | 'scrutiny'
  | 'liquidity'
  | 'risk'
  | 'tags';
type LabSort = { key: LabSortKey; direction: 'asc' | 'desc' };

const pct = (value: number | null) => (value === null ? '—' : `${value.toFixed(1)}%`);
const usd = (value: number | null) =>
  value === null
    ? '—'
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: value < 10 ? 2 : 0,
      }).format(value);
const coverageQualityLabel = (status: string): string => {
  switch (status) {
    case 'GOOD_COVERAGE_NO_OBVIOUS_BIAS':
      return 'Reliable';
    case 'PARTIAL_COVERAGE_MISSING_SET_SIMILAR':
      return 'Incomplete, no obvious bias';
    case 'POSSIBLE_OPTIMISTIC_BIAS':
      return 'Possible optimistic bias';
    case 'POSSIBLE_CONSERVATIVE_BIAS':
      return 'Possible conservative bias';
    case 'INCOMPLETE_COVERAGE_REQUIRES_REVIEW':
      return 'Incomplete, review coverage';
    case 'PENDING_DUNE':
      return 'Pending Dune data';
    default:
      return 'Insufficient to assess';
  }
};
const operationalCoverageLabel = (quality: {
  status: string;
  operationalStatus?: string;
}): string =>
  quality.operationalStatus === 'PENDING'
    ? 'Pending'
    : quality.operationalStatus === 'REVIEW'
      ? 'Review'
      : quality.operationalStatus === 'UNPROVEN'
        ? 'Unproven'
        : quality.operationalStatus === 'GOOD'
          ? 'Good'
          : coverageQualityLabel(quality.status);
const coverageQualityExplanation = (status: string): string => {
  switch (status) {
    case 'GOOD_COVERAGE_NO_OBVIOUS_BIAS':
      return 'Enough trades have Dune results, with no obvious sign that missing data is distorting the result.';
    case 'PARTIAL_COVERAGE_MISSING_SET_SIMILAR':
      return 'Some trades are missing Dune results, but the available and missing trades do not look materially different.';
    case 'POSSIBLE_OPTIMISTIC_BIAS':
      return 'Dune-covered trades look better than missing trades, so displayed profitability may be too positive.';
    case 'POSSIBLE_CONSERVATIVE_BIAS':
      return 'Missing trades look better than Dune-covered trades, so displayed profitability may be too pessimistic.';
    case 'INCOMPLETE_COVERAGE_REQUIRES_REVIEW':
      return 'Many trades are missing and the missing group looks different enough to review before relying on the result.';
    case 'PENDING_DUNE':
      return 'Trades are waiting to be queried by Dune; the evidence is not finished yet.';
    default:
      return 'There is not enough information to determine whether missing Dune data creates bias.';
  }
};
const score = (value: number | null) => (value === null ? '—' : `${Math.round(value)}`);
const candidateStatusLabel = (status: LabWallet['candidateStatus']) =>
  ({
    eligible: 'Eligible',
    rejected: 'Not a candidate',
    insufficient_evidence: 'Insufficient evidence',
    missing_evidence: 'Missing evidence',
  })[status];
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const gmgnUrl = (address: string) => `https://gmgn.ai/sol/address/${encodeURIComponent(address)}`;
type CopyingRisk = 'unknown' | 'low' | 'watch' | 'high';
const copyingRisk = (wallet: LabWallet): CopyingRisk => {
  const bands = wallet.liquidityBands;
  if (!bands?.length) return 'unknown';
  const low = bands.find((band) => band.band === 'low');
  if (!low) return 'unknown';
  const worstMissedRate = Math.max(...bands.map((band) => band.missedTradeRatePercent ?? 0));
  if (worstMissedRate >= 50 || bands.some((band) => band.simulatedCount === 0)) return 'high';
  if (!low.reliable || (low.missedTradeRatePercent ?? 0) >= 20) return 'watch';
  return 'low';
};
const copyingRiskLabel = (wallet: LabWallet) => {
  const risk = copyingRisk(wallet);
  if (risk === 'unknown') return strings.decisionLab.copyingRiskUnknown;
  if (risk === 'watch') return strings.decisionLab.copyingRiskWatch;
  if (risk === 'high') return strings.decisionLab.copyingRiskHigh;
  return strings.decisionLab.copyingRiskLow;
};
const ScoreCell = ({
  wallet,
  value,
  scoreKey,
}: {
  wallet: LabWallet;
  value: number | null;
  scoreKey: 'edge' | 'consistency' | 'robustness' | 'copyability' | 'overall';
}) => {
  if (value !== null) {
    return (
      <strong
        className={value >= 70 ? 'change-positive' : value < 40 ? 'change-negative' : undefined}
      >
        {score(value)}
      </strong>
    );
  }

  const status = strings.decisionLab.scoreUnavailable[wallet.evidence.level];
  const detail = wallet.scoreDetails?.[scoreKey]?.detail ?? wallet.evidence.detail;
  return (
    <TableTooltip
      label="Score unavailable"
      detail={detail}
      className="experimental-score-unavailable"
    >
      <strong>—</strong>
      <small>{status}</small>
    </TableTooltip>
  );
};
const TableTooltip = ({
  children,
  label,
  detail,
  className,
}: {
  children: ReactNode;
  label: string;
  detail: string;
  className?: string;
}) => {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={`experimental-tooltip-cell ${className ?? ''}`} tabIndex={0}>
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent className="experimental-table-tooltip" side="top">
        <b>{label}</b>
        <p>{detail}</p>
      </TooltipContent>
    </Tooltip>
  );
};
const CapitalPathChart = ({ path }: { path: Array<{ day: string; capitalUsd: number }> }) => {
  const [zoom, setZoom] = useState(1);
  const [hovered, setHovered] = useState<number | null>(null);
  if (path.length < 2) return null;
  const values = path.map((point) => point.capitalUsd);
  const max = Math.max(100, ...values);
  const min = Math.min(100, ...values);
  const range = Math.max(1, max - min);
  return (
    <section className="copytrade-capital-chart-block" aria-label="Daily $100 after-copy portfolio">
      <div className="capital-path-chart-heading">
        <strong>$100 after-copy path</strong>
        <button
          type="button"
          className="capital-path-reset"
          onClick={() => setZoom(1)}
          disabled={zoom === 1}
        >
          Reset 100%
        </button>
      </div>
      <div
        className="capital-path-chart"
        onWheel={(event) => {
          event.preventDefault();
          setZoom((value) => Math.max(1, Math.min(6, value * (event.deltaY < 0 ? 1.2 : 0.84))));
        }}
      >
        <div className="capital-path-y-axis">
          <span>${max.toFixed(0)}</span>
          <span>$100</span>
          <span>${min.toFixed(0)}</span>
        </div>
        <div className="capital-path-plot">
          <div className="capital-path-bars" style={{ width: `${zoom * 100}%` }}>
            {path.map((point, index) => (
              <span
                key={point.day}
                className={`capital-path-bar ${point.capitalUsd >= 100 ? 'positive' : 'negative'}`}
                style={{ height: `${Math.max(2, ((point.capitalUsd - min) / range) * 100)}%` }}
                onMouseEnter={() => setHovered(index)}
                onMouseLeave={() => setHovered(null)}
              >
                {hovered === index && (
                  <b className="capital-path-tooltip">
                    {point.day}
                    <strong>${point.capitalUsd.toFixed(2)}</strong>
                  </b>
                )}
              </span>
            ))}
          </div>
          <div className="capital-path-x-axis">
            <span>{path[0].day}</span>
            <span>{path[path.length - 1].day}</span>
          </div>
        </div>
      </div>
      <small>
        Dates → · portfolio value ($) ↑ · latest ${path[path.length - 1].capitalUsd.toFixed(2)} ·
        wheel to zoom
      </small>
    </section>
  );
};
const SavedFactsCell = ({ wallet }: { wallet: LabWallet }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <span className="experimental-tooltip-cell experimental-facts-cell" tabIndex={0}>
        <span>
          {pct(wallet.facts.activityMedianReturnPercent)} ·{' '}
          {usd(wallet.facts.officialGmgnRealizedProfitUsd ?? null)}
          <small>
            {wallet.facts.activityTradeCount} local activity trades ({wallet.facts.activityPeriodDays}d)
          </small>
        </span>
      </span>
    </TooltipTrigger>
    <TooltipContent className="experimental-table-tooltip experimental-facts-tooltip" side="top">
      <b>Saved facts</b>
      <span>
        <strong>Local activity median return</strong>
        <small>Reconstructed from copytrade_trades inside the selected activity window.</small>
        <em>{pct(wallet.facts.activityMedianReturnPercent)}</em>
      </span>
      <span>
        <strong>Official GMGN realized profit</strong>
        <small>
          Reference value from the saved {wallet.facts.officialGmgnPeriod ?? 'GMGN'} snapshot.
        </small>
        <em>{usd(wallet.facts.officialGmgnRealizedProfitUsd ?? null)}</em>
      </span>
      <span>
        <strong>Activity vs official counts</strong>
        <small>
          Activity trades are local; buy/sell counts are official GMGN reference values.
        </small>
        <em>
          {wallet.facts.activityTradeCount} activity trades ·{' '}
          {wallet.facts.officialGmgnBuyCount ?? '—'} / {wallet.facts.officialGmgnSellCount ?? '—'}{' '}
          official GMGN buys/sells ({wallet.facts.officialGmgnPeriod ?? 'unavailable'})
        </em>
      </span>
      <span>
        <strong>Official GMGN win rate</strong>
        <small>
          Reference value from the saved {wallet.facts.officialGmgnPeriod ?? 'GMGN'} snapshot.
        </small>
        <em>{pct(wallet.facts.officialGmgnWinRatePercent ?? null)}</em>
      </span>
      <span>
        <strong>Local activity median hold</strong>
        <small>Reconstructed from copytrade_trades inside the selected activity window.</small>
        <em>
          {wallet.facts.activityMedianHoldSeconds === null
            ? '—'
            : `${Math.round(wallet.facts.activityMedianHoldSeconds)}s`}
        </em>
      </span>
    </TooltipContent>
  </Tooltip>
);
const evidenceOrder: Record<LabWallet['evidence']['level'], number> = {
  complete: 0,
  partial: 1,
  insufficient: 2,
  missing: 3,
};
const nullableNumber = (value: number | null) =>
  value === null ? Number.POSITIVE_INFINITY : value;
const hasSortableValue = (wallet: LabWallet, key: LabSortKey) => {
  if (key === 'rank') return wallet.rank !== null;
  if (key === 'winnerScore') return wallet.winnerPolicy.finalScore !== null;
  if (
    key === 'edge' ||
    key === 'consistency' ||
    key === 'robustness' ||
    key === 'copyability' ||
    key === 'overall'
  )
    return wallet.scores[key] !== null;
  if (key === 'facts')
    return wallet.facts.copyMedianPercent !== null || wallet.facts.copyCapitalUsd !== null;
  if (key === 'scrutiny') return wallet.scrutiny !== null;
  if (key === 'liquidity') return Boolean(wallet.liquidityBands?.length);
  if (key === 'tags') return Boolean(wallet.tags?.length);
  return true;
};
const compareWallets = (left: LabWallet, right: LabWallet, key: LabSortKey) => {
  if (key === 'rank') return nullableNumber(left.rank) - nullableNumber(right.rank);
  if (key === 'winnerScore')
    return (
      nullableNumber(left.winnerPolicy.finalScore) - nullableNumber(right.winnerPolicy.finalScore)
    );
  if (key === 'wallet')
    return (left.name?.trim() || left.walletAddress).localeCompare(
      right.name?.trim() || right.walletAddress,
    );
  if (key === 'evidence')
    return evidenceOrder[left.evidence.level] - evidenceOrder[right.evidence.level];
  if (
    key === 'edge' ||
    key === 'consistency' ||
    key === 'robustness' ||
    key === 'copyability' ||
    key === 'overall'
  )
    return nullableNumber(left.scores[key]) - nullableNumber(right.scores[key]);
  if (key === 'facts')
    return (
      nullableNumber(left.facts.copyMedianPercent) -
        nullableNumber(right.facts.copyMedianPercent) ||
      nullableNumber(left.facts.copyCapitalUsd) - nullableNumber(right.facts.copyCapitalUsd)
    );
  if (key === 'scrutiny')
    return (
      (right.scrutiny?.pass ?? -1) - (left.scrutiny?.pass ?? -1) ||
      (left.scrutiny?.fail ?? Number.POSITIVE_INFINITY) -
        (right.scrutiny?.fail ?? Number.POSITIVE_INFINITY)
    );
  if (key === 'liquidity')
    return (
      ['unknown', 'high', 'watch', 'low'].indexOf(copyingRisk(left)) -
      ['unknown', 'high', 'watch', 'low'].indexOf(copyingRisk(right))
    );
  if (key === 'risk')
    return (
      Number(Boolean(left.riskDetails?.available)) - Number(Boolean(right.riskDetails?.available))
    );
  return (left.tags ?? []).join(',').localeCompare((right.tags ?? []).join(','));
};
const exportDecisionLab = (response: LabResponse, winnersOnly: boolean) => {
  const wallets = winnersOnly
    ? response.wallets.filter(
        (wallet) =>
          wallet.winnerPolicy.status === 'WINNER' && wallet.winnerPolicy.actionability !== 'REVIEW',
      )
    : response.wallets;
  const payload = {
    format: 'vantage-crypto-decision-lab-v1',
    exportedAt: new Date().toISOString(),
    exportScope: winnersOnly ? 'winners' : 'all',
    ...response,
    wallets,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  const policyVersion =
    wallets[0]?.winnerPolicy.policyVersion.replace('winner-policy-', '') ?? 'v4';
  link.download = `decision-lab-${winnersOnly ? 'winners' : 'all-history'}-${policyVersion}-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
};

export function ExperimentalDecisionLab({
  api,
  periodDays,
  onPeriodDaysChange,
}: {
  api: ApiClient;
  periodDays: 30 | 60 | 90;
  onPeriodDaysChange: (periodDays: 30 | 60 | 90) => void;
}) {
  const [response, setResponse] = useState<LabResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedWallet, setSelectedWallet] = useState<LabWallet | null>(null);
  const [sort, setSort] = useState<LabSort>({ key: 'winnerScore', direction: 'desc' });
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [scoringInfoOpen, setScoringInfoOpen] = useState(false);
  const [riskImportInfoOpen, setRiskImportInfoOpen] = useState(false);
  const [winnersOnly, setWinnersOnly] = useState(false);
  const [walletFilter, setWalletFilter] = useState('');
  const [selectedForDune, setSelectedForDune] = useState<Set<string>>(new Set());
  const [dunePlan, setDunePlan] = useState<{ pendingTargets: number; message: string } | null>(
    null,
  );
  const [dunePlansByWallet, setDunePlansByWallet] = useState<
    Map<string, { pendingTargets: number; tradeCount: number }>
  >(new Map());
  const [dunePreflightLoading, setDunePreflightLoading] = useState<Set<string>>(new Set());
  const [duneFetchBusy, setDuneFetchBusy] = useState(false);
  const [duneFetchProgress, setDuneFetchProgress] = useState<{
    processed: number;
    total: number;
    failed: number;
  } | null>(null);
  const duneFetchObservedRunning = useRef(false);
  const load = (refresh = false, showPageLoading = true) => {
    if (showPageLoading) setLoading(true);
    setError(null);
    void api<LabResponse>(
      `/api/copytrade/experimental-decision?limit=100${refresh ? '&refresh=1' : ''}`,
    )
      .then(setResponse)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => {
        if (showPageLoading) setLoading(false);
      });
  };
  useEffect(() => {
    load();
  }, [api, periodDays]);
  const sortedWallets = response
    ? [...response.wallets].sort((left, right) => {
        const leftHasValue = hasSortableValue(left, sort.key);
        const rightHasValue = hasSortableValue(right, sort.key);
        if (leftHasValue !== rightHasValue) return leftHasValue ? -1 : 1;
        const comparison = compareWallets(left, right, sort.key);
        return (
          (sort.direction === 'asc' ? comparison : -comparison) ||
          nullableNumber(left.rank) - nullableNumber(right.rank)
        );
      })
    : [];
  const displayedWallets = (
    winnersOnly
      ? sortedWallets.filter(
          (wallet) =>
            wallet.winnerPolicy.status === 'WINNER' &&
            wallet.winnerPolicy.actionability !== 'REVIEW',
        )
      : sortedWallets
  ).filter((wallet) => {
    const query = walletFilter.trim().toLowerCase();
    if (!query) return true;
    return (
      wallet.walletAddress.toLowerCase().includes(query) ||
      (wallet.name?.toLowerCase().includes(query) ?? false)
    );
  });
  useEffect(() => {
    let disposed = false;
    if (!selectedForDune.size) {
      setDunePlan(null);
      return undefined;
    }
    const query = encodeURIComponent([...selectedForDune].join(','));
    void fetch(`/api/copytrade/decision/dune?walletAddresses=${query}`)
      .then(async (result) => {
        if (!result.ok) throw new Error(`Dune preflight failed (${result.status}).`);
        return (await result.json()) as {
          pendingTargets: number;
          tradeCount?: number;
          message: string;
        };
      })
      .then((plan) => {
        if (!disposed) {
          setDunePlan(plan);
          if (selectedForDune.size === 1) {
            const walletAddress = [...selectedForDune][0];
            if (walletAddress) {
              setDunePlansByWallet((current) =>
                new Map(current).set(walletAddress, {
                  pendingTargets: plan.pendingTargets,
                  tradeCount: plan.tradeCount ?? 0,
                }),
              );
            }
          }
        }
      })
      .catch(() => {
        if (!disposed) setDunePlan({ pendingTargets: 0, message: 'Dune preflight unavailable.' });
      });
    return () => {
      disposed = true;
    };
  }, [selectedForDune]);
  useEffect(() => {
    if (!response?.wallets.length) {
      setDunePlansByWallet(new Map());
      setDunePreflightLoading(new Set());
      return undefined;
    }
    let disposed = false;
    const addresses = response.wallets.map((wallet) => wallet.walletAddress);
    setDunePreflightLoading(new Set(addresses));
    const query = encodeURIComponent(addresses.join(','));
    void fetch(`/api/copytrade/decision/dune?walletAddresses=${query}`)
      .then(async (result) => {
        if (!result.ok) throw new Error('Dune preflight unavailable.');
        return (await result.json()) as {
          wallets?: Array<{ walletAddress: string; pendingTargets: number; tradeCount: number }>;
        };
      })
      .then((plan) => {
        if (disposed) return;
        setDunePlansByWallet(
          new Map(
            (plan.wallets ?? []).map((wallet) => [
              wallet.walletAddress,
              { pendingTargets: wallet.pendingTargets, tradeCount: wallet.tradeCount },
            ]),
          ),
        );
      })
      .catch(() => {
        if (!disposed) setDunePlansByWallet(new Map());
      })
      .finally(() => {
        if (!disposed) setDunePreflightLoading(new Set());
      });
    return () => {
      disposed = true;
    };
  }, [response]);
  const startSelectedDuneFetch = async () => {
    if (!selectedForDune.size || !dunePlan?.pendingTargets) return;
    setDuneFetchBusy(true);
    setError(null);
    duneFetchObservedRunning.current = false;
    setDuneFetchProgress({ processed: 0, total: dunePlan.pendingTargets, failed: 0 });
    try {
      const result = await fetch('/api/copytrade/decision/dune', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ walletAddresses: [...selectedForDune] }),
      });
      if (!result.ok) throw new Error(`Dune fetch could not start (${result.status}).`);
      setSelectedForDune(new Set());
      setDunePlan(null);
    } catch (reason) {
      setImportMessage(reason instanceof Error ? reason.message : 'Dune fetch could not start.');
      setDuneFetchBusy(false);
      setDuneFetchProgress(null);
      setLoading(false);
    }
  };
  useEffect(() => {
    if (!duneFetchBusy) return undefined;
    let disposed = false;
    const poll = async () => {
      try {
        const result = await fetch('/api/copytrade/copy-simulation/status');
        if (!result.ok) return;
        const status = (await result.json()) as {
          running?: boolean;
          targetsTotal?: number;
          targetsProcessed?: number;
          failedTargets?: number;
        };
        if (disposed) return;
        setDuneFetchProgress((previous) => ({
          processed: status.targetsProcessed ?? previous?.processed ?? 0,
          total: status.targetsTotal ?? previous?.total ?? 0,
          failed: status.failedTargets ?? previous?.failed ?? 0,
        }));
        if (status.running === true) duneFetchObservedRunning.current = true;
        if (
          status.running === false &&
          (duneFetchObservedRunning.current || (status.targetsTotal ?? 0) > 0)
        ) {
          setDuneFetchBusy(false);
          setDuneFetchProgress(null);
          load(true, false);
        }
      } catch {
        // Keep the button in its current state; the next poll retries.
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [duneFetchBusy]);
  const toggleSort = (key: LabSortKey) =>
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: key === 'winnerScore' ? 'desc' : 'asc' },
    );
  const sortableHeader = (key: LabSortKey, label: string, title = `Sort by ${label}`) => (
    <button
      type="button"
      className="experimental-sort-button"
      onClick={() => toggleSort(key)}
      title={title}
    >
      {label}
      <span aria-hidden="true">
        {sort.key === key ? (sort.direction === 'asc' ? ' ↑' : ' ↓') : ' ↕'}
      </span>
    </button>
  );
  const importRiskBundle = async (file: File) => {
    setImporting(true);
    setImportMessage(null);
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const root =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
      const captures =
        root && Array.isArray(root.captures) ? root.captures : Array.isArray(parsed) ? parsed : [];
      let ignoredNon30d = 0;
      let ignoredUnavailable = 0;
      const results = captures.flatMap((value) => {
        if (!value || typeof value !== 'object') return [];
        const capture = value as {
          walletAddress?: unknown;
          period?: unknown;
          status?: unknown;
          responseBody?: unknown;
        };
        if (typeof capture.walletAddress !== 'string' || capture.period !== '30d') {
          ignoredNon30d += 1;
          return [];
        }
        if (capture.responseBody === undefined) {
          ignoredUnavailable += 1;
          return [];
        }
        const status = typeof capture.status === 'number' ? capture.status : 200;
        return [
          {
            walletAddress: capture.walletAddress,
            period: '30d',
            available: status === 200,
            metrics: capture.responseBody,
            error: status === 200 ? undefined : `GMGN returned HTTP ${status}`,
          },
        ];
      });
      if (!results.length)
        throw new Error('No 30-day wallet risk captures were found in this JSON file.');
      const saved = await fetch('/api/copytrade/scrutiny/gmgn-risk/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ results }),
      });
      if (!saved.ok) throw new Error(`Import failed (${saved.status}).`);
      const outcome = (await saved.json()) as {
        imported?: number;
        ignored?: number;
        results?: Array<{ walletAddress?: unknown; available?: unknown; metrics?: unknown }>;
      };
      const ignored = (outcome.ignored ?? 0) + ignoredNon30d + ignoredUnavailable;
      setImportMessage(
        `Imported ${outcome.imported ?? 0} 30-day risk response(s).${ignored ? ` Ignored ${ignored} non-usable or non-30-day entr${ignored === 1 ? 'y' : 'ies'}.` : ''}`,
      );
      // Importing risk JSON only changes the saved GMGN-risk column. Do not recompute the
      // entire Decision Lab report here; that expensive read is unnecessary because risk
      // details are descriptive context and do not affect the four scores.
      const importedByWallet = new Map(
        (outcome.results ?? [])
          .filter(
            (result): result is { walletAddress: string; available: boolean; metrics?: unknown } =>
              typeof result.walletAddress === 'string' && typeof result.available === 'boolean',
          )
          .map((result) => [result.walletAddress, result]),
      );
      if (importedByWallet.size > 0) {
        setResponse((current) =>
          current
            ? {
                ...current,
                wallets: current.wallets.map((wallet) => {
                  const imported = importedByWallet.get(wallet.walletAddress);
                  return imported
                    ? {
                        ...wallet,
                        riskDetails: {
                          available: imported.available,
                          metrics:
                            imported.metrics && typeof imported.metrics === 'object'
                              ? (imported.metrics as Record<string, unknown>)
                              : null,
                        },
                      }
                    : wallet;
                }),
              }
            : current,
        );
      }
    } catch (reason: unknown) {
      setImportMessage(
        reason instanceof Error ? reason.message : 'Could not import the risk JSON.',
      );
    } finally {
      setImporting(false);
    }
  };
  return (
    <section className="menu-section panel experimental-decision-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">EXPERIMENTAL · READ-ONLY</p>
          <h2>Decision Lab</h2>
        </div>
        <div className="experimental-actions">
          <span className="experimental-period-control">All available history · 45-day decay</span>
          <button
            type="button"
            className="secondary"
            onClick={() => load(true)}
            disabled={loading || importing}
          >
            Reload saved evidence
          </button>
          <label className="experimental-import-button">
            Import GMGN risk bundle
            <input
              type="file"
              accept="application/json,.json"
              disabled={importing}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void importRiskBundle(file);
                event.currentTarget.value = '';
              }}
            />
          </label>
          <button
            type="button"
            className="experimental-info-button"
            aria-label="How to export a GMGN risk bundle"
            title="How to export a GMGN risk bundle"
            onClick={() => setRiskImportInfoOpen(true)}
          >
            <span aria-hidden="true">i</span> How to import
          </button>
        </div>
      </div>
      {!loading && (
        <>
          <DataStatusSummary api={api} targetDays={response?.periodDays ?? 90} />
          <WalletDataCoveragePanel api={api} periodDays={periodDays} />
        </>
      )}
      {loading && (
        <p className="copytrade-analysis-status running">
          <span className="loading-spinner" /> Reading saved SQLite evidence…
        </p>
      )}
      {error && <p className="copytrade-status-warning">Could not load the experiment: {error}</p>}
      {importMessage && <p className="copytrade-analysis-status">{importMessage}</p>}
      {response && !loading && (
        <>
          <div className="experimental-scoring-card">
            <section className="experimental-model-block">
              <span className="experimental-model-icon" aria-hidden="true">
                ✓
              </span>
              <div>
                <strong>Winner Policy · {response.winnerPolicyVersion}</strong>
                <p>{strings.decisionLab.winnerPolicyIntro}</p>
                <div className="experimental-gate-pills">
                  {strings.decisionLab.winnerPolicyGates.map((gate) => (
                    <span key={gate}>{gate}</span>
                  ))}
                </div>
                <small>{strings.decisionLab.winnerPolicyScoreSummary}</small>
              </div>
            </section>
            <button
              type="button"
              className="experimental-info-button"
              aria-label="Open scoring and candidate gate details"
              title="Scoring and gate details"
              onClick={() => setScoringInfoOpen(true)}
            >
              <span aria-hidden="true">i</span> Scoring details
            </button>
          </div>
          {scoringInfoOpen && (
            <Modal
              onClose={() => setScoringInfoOpen(false)}
              ariaLabel="Decision Engine scoring details"
              dialogClassName="experimental-scoring-help-modal"
            >
              <div className="copytrade-modal-head">
                <div>
                  <p className="eyebrow">WINNER POLICY v3 · EXPLANATION</p>
                  <h3>How the score is calculated</h3>
                </div>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setScoringInfoOpen(false)}
                >
                  Close
                </button>
              </div>
              <h4>Hard gates</h4>
              <ul className="experimental-rule-list">
                <li>20+ actual completed delayed-copy buys, otherwise UNPROVEN.</li>
                <li>Chronological canonical $100 portfolio must end above $100.</li>
                <li>Profitability must survive removal of sub-60-second trades.</li>
              </ul>
              <h4>Score</h4>
              <p>
                70 points come from delayed-copy profitability. 30 points start at 30 and are
                reduced by GMGN execution, trade-quality, cost, token-risk, and wallet-maturity
                deductions. Historical metrics use a 45-day decay.
              </p>
              <p className="muted">
                Holdouts, Pattern Discovery, legacy analytical scores, and best-token concentration
                are context only.
              </p>
              <small className="muted">
                {strings.decisionLab.generatedAt(new Date(response.generatedAt).toLocaleString())}
              </small>
            </Modal>
          )}
          <div className="experimental-table-toolbar">
            <div className="experimental-table-controls">
              <label className="experimental-wallet-filter">
                <span className="visually-hidden">Filter wallets</span>
                <Input
                  type="search"
                  value={walletFilter}
                  onChange={(event) => setWalletFilter(event.target.value)}
                  placeholder={strings.decisionLab.walletFilterPlaceholder}
                  aria-label="Filter wallet or name"
                />
              </label>
              <label className={`experimental-winners-toggle${winnersOnly ? ' active' : ''}`}>
                <Switch
                  checked={winnersOnly}
                  onChange={(event) => setWinnersOnly(event.target.checked)}
                />
                <span className="experimental-toggle-track" aria-hidden="true">
                  <i />
                </span>
                <span>{strings.decisionLab.winnersOnly}</span>
              </label>
              {response && (
                <button
                  type="button"
                  className="secondary experimental-export-table-button"
                  onClick={() => exportDecisionLab(response, winnersOnly)}
                  disabled={loading || importing}
                >
                  {winnersOnly
                    ? strings.decisionLab.exportWinnersData
                    : strings.decisionLab.exportAllWithDetails}
                </button>
              )}
              <button
                type="button"
                className="secondary"
                onClick={() => void startSelectedDuneFetch()}
                disabled={duneFetchBusy || !selectedForDune.size || !dunePlan?.pendingTargets}
                title={dunePlan?.message ?? 'Select wallets to check pending Dune data.'}
              >
                {duneFetchBusy
                  ? `Fetching Dune data (${duneFetchProgress?.processed ?? 0}/${duneFetchProgress?.total ?? dunePlan?.pendingTargets ?? 0})`
                  : `Fetch Dune data${selectedForDune.size ? ` (${selectedForDune.size})` : ''}`}
              </button>
              {selectedForDune.size > 0 && (
                <small className="experimental-dune-fetch-plan" role="status">
                  {dunePlan?.message ?? 'Counting pending Dune observations…'}
                </small>
              )}
            </div>
            <p className="experimental-score-legend">{strings.decisionLab.tableLegend}</p>
          </div>
          <DataTable
            wrapClassName="experimental-table-wrap"
            tableClassName="experimental-table"
            enableColumnHiding
            columnVisibilityStorageKey="vantage-decision-lab-columns"
            rows={displayedWallets}
            getRowKey={(wallet) => wallet.walletAddress}
            rowProps={(wallet) => ({
              className: 'experimental-clickable-row',
              onClick: () => setSelectedWallet(wallet),
            })}
            columns={[
              {
                key: 'duneSelect',
                header: 'Select',
                render: (wallet) => (
                  <Checkbox
                    aria-label={`Select ${wallet.name?.trim() || short(wallet.walletAddress)} for Dune fetch`}
                    checked={selectedForDune.has(wallet.walletAddress)}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => {
                      event.stopPropagation();
                      setSelectedForDune((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(wallet.walletAddress);
                        else next.delete(wallet.walletAddress);
                        return next;
                      });
                    }}
                  />
                ),
              },
              {
                key: 'rank',
                header: sortableHeader('rank', 'Rank'),
                render: (wallet) => (wallet.rank === null ? '—' : `#${wallet.rank}`),
              },
              {
                key: 'wallet',
                header: sortableHeader('wallet', 'Wallet'),
                headerProps: { className: 'experimental-wallet-column' },
                cellProps: () => ({ className: 'experimental-wallet-column' }),
                render: (wallet) => (
                  <TableTooltip label="Wallet address" detail={wallet.walletAddress}>
                    <a
                      className="gmgn-wallet-link"
                      href={gmgnUrl(wallet.walletAddress)}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <strong>{wallet.name?.trim() || short(wallet.walletAddress)}</strong>
                      {wallet.name?.trim() && <small>{short(wallet.walletAddress)}</small>}
                    </a>
                  </TableTooltip>
                ),
              },
              {
                key: 'evidence',
                header: sortableHeader('evidence', 'Evidence'),
                render: (wallet) => (
                  <TableTooltip
                    className={`experimental-evidence ${wallet.evidence.level}`}
                    label="Evidence"
                    detail={wallet.evidence.detail}
                  >
                    {wallet.evidence.level}
                  </TableTooltip>
                ),
              },
              {
                key: 'winnerPolicy',
                header: 'Policy',
                render: (wallet) => (
                  <TableTooltip
                    className={`experimental-evidence ${wallet.winnerPolicy.status.toLowerCase()}`}
                    label={`Winner Policy ${wallet.winnerPolicy.policyVersion}`}
                    detail={
                      [
                        ...wallet.winnerPolicy.rejectionReasons,
                        ...wallet.winnerPolicy.unprovenReasons,
                        ...wallet.winnerPolicy.positiveReasons,
                        ...wallet.winnerPolicy.warnings,
                      ].join(' ') || 'All fixed policy gates passed.'
                    }
                  >
                    {wallet.winnerPolicy.actionability === 'REVIEW'
                      ? 'REVIEW'
                      : wallet.winnerPolicy.status}
                  </TableTooltip>
                ),
              },
              {
                key: 'coverageQuality',
                header: 'Dune evidence',
                render: (wallet) => {
                  const quality = wallet.winnerPolicy.evidence.coverageQuality;
                  if (!quality) return '—';
                  const coverage =
                    quality.coveragePercent === null
                      ? '—'
                      : `${quality.coveragePercent.toFixed(0)}%`;
                  return (
                    <TableTooltip
                      className={
                        quality.operationalStatus === 'UNPROVEN' ||
                        quality.operationalStatus === 'PENDING' ||
                        quality.operationalStatus === 'REVIEW'
                          ? 'experimental-evidence insufficient'
                          : 'experimental-evidence complete'
                      }
                      label="Dune evidence quality"
                      detail={`${coverageQualityExplanation(quality.status)} ${quality.reason} ${quality.simulatedTrips}/${quality.eligibleTrips} trips simulated; ${quality.pendingTrips} pending.`}
                    >
                      {coverage} · {operationalCoverageLabel(quality)}
                    </TableTooltip>
                  );
                },
              },
              {
                key: 'dunePreflight',
                header: 'Dune preflight',
                render: (wallet) => {
                  if (dunePreflightLoading.has(wallet.walletAddress)) {
                    return (
                      <span className="experimental-preflight-loading" role="status">
                        <span className="loading-spinner" aria-hidden="true" /> Checking…
                      </span>
                    );
                  }
                  const plan = dunePlansByWallet.get(wallet.walletAddress);
                  if (!plan) return '—';
                  if (plan.pendingTargets === 0) return 'Complete';
                  return `${plan.pendingTargets.toLocaleString()} pending`;
                },
              },
              {
                key: 'winnerScore',
                header: sortableHeader('winnerScore', 'Score'),
                render: (wallet) =>
                  wallet.winnerPolicy.finalScore === null ? '—' : wallet.winnerPolicy.finalScore,
              },
              {
                key: 'facts',
                header: sortableHeader('facts', 'Saved facts'),
                render: (wallet) => <SavedFactsCell wallet={wallet} />,
              },
              {
                key: 'risk',
                header: sortableHeader('risk', 'GMGN snapshot'),
                render: (wallet) =>
                  wallet.riskDetails?.available ? (
                    <TableTooltip
                      className="experimental-evidence complete"
                      label="GMGN snapshot"
                      detail="Saved GMGN aggregate statistics are available. The Chrome-extension risk bundle is separate and may still be unavailable."
                    >
                      available
                    </TableTooltip>
                  ) : (
                    <TableTooltip
                      className="muted"
                      label="GMGN snapshot"
                      detail="No saved GMGN aggregate snapshot for this wallet."
                    >
                      not imported
                    </TableTooltip>
                  ),
              },
              {
                key: 'riskData',
                header: 'GMGN risk data',
                render: (wallet) =>
                  wallet.riskDetails?.available ? (
                    <TableTooltip
                      className="experimental-evidence complete"
                      label="GMGN risk data"
                      detail="Imported Chrome-extension GMGN risk data is available for this wallet."
                    >
                      available
                    </TableTooltip>
                  ) : (
                    <TableTooltip
                      className="experimental-evidence insufficient"
                      label="GMGN risk data"
                      detail="Chrome-extension GMGN risk data is unavailable. Import the wallet risk bundle via the extension to apply token/security-risk checks."
                    >
                      unavailable
                    </TableTooltip>
                  ),
              },
              {
                key: 'walletAge',
                header: 'Wallet age',
                render: (wallet) => {
                  const ageDays = wallet.winnerPolicy.gmgnRiskScore?.walletAgeDays;
                  return ageDays === null || ageDays === undefined
                    ? '—'
                    : `${ageDays.toFixed(1)} days`;
                },
              },
              {
                key: 'tags',
                header: sortableHeader('tags', 'Tags'),
                render: (wallet) =>
                  wallet.tags?.length ? (
                    <span className="experimental-tag-list">
                      {wallet.tags.map((tag) => (
                        <GmgnTag key={tag} tag={tag} />
                      ))}
                    </span>
                  ) : (
                    '—'
                  ),
              },
            ]}
            emptyMessage="No saved wallet evidence is available yet."
          />
          {selectedWallet && (
            <Modal
              onClose={() => setSelectedWallet(null)}
              ariaLabel={`Decision Lab details for ${selectedWallet.name?.trim() || short(selectedWallet.walletAddress)}`}
              dialogClassName="experimental-detail-modal"
            >
              <div className="copytrade-modal-head">
                <div>
                  <p className="eyebrow">DECISION LAB · SAVED EVIDENCE</p>
                  <h3>{selectedWallet.name?.trim() || short(selectedWallet.walletAddress)}</h3>
                  <a
                    className="gmgn-wallet-link"
                    href={gmgnUrl(selectedWallet.walletAddress)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View wallet on GMGN ↗
                  </a>
                  <small title={selectedWallet.walletAddress}>{selectedWallet.walletAddress}</small>
                </div>
                <button type="button" className="secondary" onClick={() => setSelectedWallet(null)}>
                  Close
                </button>
              </div>
              <p className="muted">Winner Policy v3 evidence and score calculation.</p>
              <CapitalPathChart path={selectedWallet.winnerPolicy.evidence.capitalPath ?? []} />
              <section className="experimental-calculation-summary">
                <div className="experimental-calculation-total">
                  <span>Winner Policy score</span>
                  <strong>{score(selectedWallet.winnerPolicy.finalScore)} / 100</strong>
                </div>
                {selectedWallet.winnerPolicy.profitabilityScore && (
                  <div className="experimental-calculation-line">
                    <strong className="calculation-positive">
                      + {selectedWallet.winnerPolicy.profitabilityScore.score} / 70
                    </strong>
                    <span>Delayed-copy profitability</span>
                  </div>
                )}
                {selectedWallet.winnerPolicy.gmgnRiskScore && (
                  <div className="experimental-calculation-line">
                    <strong className="calculation-negative">
                      −{' '}
                      {selectedWallet.winnerPolicy.gmgnRiskScore.max -
                        selectedWallet.winnerPolicy.gmgnRiskScore.score}{' '}
                      points
                    </strong>
                    <span>GMGN execution and risk deductions</span>
                  </div>
                )}
                {(selectedWallet.winnerPolicy.profitabilityScore ||
                  selectedWallet.winnerPolicy.gmgnRiskScore) && (
                  <div
                    className="experimental-score-ledger"
                    role="table"
                    aria-label="Winner Policy score calculation"
                  >
                    <div className="score-ledger-row score-ledger-header" role="row">
                      <span>Rule / component</span>
                      <span>Points</span>
                      <span>Evidence / application</span>
                    </div>
                    {selectedWallet.winnerPolicy.profitabilityScore && (
                      <>
                        <div className="score-ledger-row" role="row">
                          <span>$100 portfolio growth</span>
                          <strong className="calculation-positive">
                            +{selectedWallet.winnerPolicy.profitabilityScore.portfolioScore}
                          </strong>
                          <small>
                            {usd(selectedWallet.winnerPolicy.evidence.endingCapitalUsd)} ending · up
                            to 30
                          </small>
                        </div>
                        <div className="score-ledger-row" role="row">
                          <span>Net-dollar profit factor</span>
                          <strong className="calculation-positive">
                            +{selectedWallet.winnerPolicy.profitabilityScore.profitFactorScore}
                          </strong>
                          <small>
                            PF{' '}
                            {selectedWallet.winnerPolicy.profitabilityScore.weightedProfitFactor ??
                              '—'}{' '}
                            · up to 20
                          </small>
                        </div>
                        <div className="score-ledger-row" role="row">
                          <span>Evidence / sample confidence</span>
                          <strong className="calculation-positive">
                            +
                            {selectedWallet.winnerPolicy.profitabilityScore.evidenceConfidenceScore}
                          </strong>
                          <small>
                            {selectedWallet.winnerPolicy.evidence.completedCopiedBuyOutcomes}{' '}
                            completed copied buys · up to 10
                          </small>
                        </div>
                        <div className="score-ledger-row" role="row">
                          <span>Tail robustness</span>
                          <strong className="calculation-positive">
                            +{selectedWallet.winnerPolicy.profitabilityScore.robustnessScore}
                          </strong>
                          <small>
                            Best trade{' '}
                            {pct(
                              selectedWallet.winnerPolicy.profitabilityScore
                                .bestTradeProfitSharePercent,
                            )}{' '}
                            · best 3{' '}
                            {pct(
                              selectedWallet.winnerPolicy.profitabilityScore
                                .bestThreeProfitSharePercent,
                            )}{' '}
                            · without best{' '}
                            {usd(
                              selectedWallet.winnerPolicy.profitabilityScore
                                .portfolioWithoutBestTradeEndingCapitalUsd,
                            )}
                          </small>
                        </div>
                      </>
                    )}
                    {selectedWallet.winnerPolicy.gmgnRiskScore && (
                      <>
                        {Object.entries(selectedWallet.winnerPolicy.gmgnRiskScore.deductions).map(
                          ([rule, deduction]) => (
                            <div className="score-ledger-row" role="row" key={rule}>
                              <span>
                                GMGN{' '}
                                {rule.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)}
                              </span>
                              <strong
                                className={
                                  deduction > 0 ? 'calculation-negative' : 'calculation-neutral'
                                }
                              >
                                {deduction > 0 ? `−${deduction}` : '0'}
                              </strong>
                              <small>
                                {selectedWallet.winnerPolicy.gmgnRiskScore!.deductionDetails?.[
                                  rule as keyof NonNullable<
                                    typeof selectedWallet.winnerPolicy.gmgnRiskScore.deductionDetails
                                  >
                                ] ?? fallbackDeductionDetail(rule, deduction)}
                              </small>
                            </div>
                          ),
                        )}
                      </>
                    )}
                  </div>
                )}
                <div
                  className="experimental-calculation-gates"
                  aria-label="Winner Policy hard gates"
                >
                  {[
                    ['completedCopiedTrades', strings.decisionLab.winnerPolicyGates[0]],
                    ['simulatedPortfolioPositive', strings.decisionLab.winnerPolicyGates[1]],
                    ['duneEvidenceActionable', strings.decisionLab.winnerPolicyGates[2]],
                    ['uncopyableProfitDependency', strings.decisionLab.winnerPolicyGates[3]],
                  ].map(([key, label]) => {
                    const gate =
                      selectedWallet.winnerPolicy.proofGates[
                        key as keyof typeof selectedWallet.winnerPolicy.proofGates
                      ];
                    return (
                      <span className={`calculation-gate ${gate.status}`} key={key}>
                        {gate.status === 'pass' ? '✓' : '×'} {label}
                      </span>
                    );
                  })}
                </div>
              </section>
              {selectedWallet.winnerPolicy.evidence.coverageQuality && (
                <section
                  className="experimental-coverage-quality"
                  aria-label="Dune coverage quality"
                >
                  <strong>Dune evidence: </strong>
                  <span>
                    {operationalCoverageLabel(selectedWallet.winnerPolicy.evidence.coverageQuality)}
                  </span>
                  <small>
                    {' '}
                    {selectedWallet.winnerPolicy.evidence.coverageQuality.coveragePercent === null
                      ? '—'
                      : `${selectedWallet.winnerPolicy.evidence.coverageQuality.coveragePercent.toFixed(0)}%`}{' '}
                    ·{' '}
                    {coverageQualityExplanation(
                      selectedWallet.winnerPolicy.evidence.coverageQuality.status,
                    )}{' '}
                    {selectedWallet.winnerPolicy.evidence.coverageQuality.reason}
                  </small>
                  {selectedWallet.winnerPolicy.evidence.coverageQuality.missingTradeMateriality && (
                    <small>
                      {' '}
                      Missing-trade materiality:{' '}
                      {selectedWallet.winnerPolicy.evidence.coverageQuality.missingTradeMateriality.severity.toLowerCase()}
                      {' · '}
                      {
                        selectedWallet.winnerPolicy.evidence.coverageQuality.missingTradeMateriality
                          .aggregateInterpretation
                      }
                    </small>
                  )}
                </section>
              )}
              <details className="experimental-advanced-details">
                <summary>Advanced details</summary>
                <div className="experimental-detail-grid">
                  <section>
                    <h4>Authoritative Winner Policy</h4>
                    <p
                      className={`experimental-evidence ${selectedWallet.winnerPolicy.status.toLowerCase()}`}
                    >
                      {selectedWallet.winnerPolicy.status}
                    </p>
                    <p className="muted">
                      Policy {selectedWallet.winnerPolicy.policyVersion}; this is the authoritative
                      wallet decision.
                    </p>
                    <div className="experimental-policy-visual">
                      <h5>{strings.decisionLab.winnerPolicyDetailHardGates}</h5>
                      <div className="experimental-policy-gate-grid">
                        {[
                          ['completedCopiedTrades', strings.decisionLab.winnerPolicyGates[0]],
                          ['simulatedPortfolioPositive', strings.decisionLab.winnerPolicyGates[1]],
                          ['duneEvidenceActionable', strings.decisionLab.winnerPolicyGates[2]],
                          ['uncopyableProfitDependency', strings.decisionLab.winnerPolicyGates[3]],
                        ].map(([key, label]) => {
                          const gate =
                            selectedWallet.winnerPolicy.proofGates[
                              key as keyof typeof selectedWallet.winnerPolicy.proofGates
                            ];
                          return (
                            <div className={`experimental-policy-gate ${gate.status}`} key={key}>
                              <strong>
                                {gate.status === 'pass' ? '✓' : '×'} {label}
                              </strong>
                              <small>{gate.detail}</small>
                            </div>
                          );
                        })}
                      </div>
                      <h5>Score allocation</h5>
                      <div className="experimental-policy-allocation-grid">
                        <div className="allocation-positive">
                          <strong>+70</strong>
                          <span>Dune delayed-copy profitability</span>
                          <small>Median return · portfolio growth · evidence confidence</small>
                        </div>
                        <div className="allocation-negative">
                          <strong>−30 max</strong>
                          <span>GMGN risk / copyability deductions</span>
                          <small>
                            Execution speed · activity · trade quality · token risk · costs
                          </small>
                        </div>
                      </div>
                      <h5>Warnings, not gates</h5>
                      <p className="experimental-policy-not-gates">
                        100 GMGN trades · holdout windows · Pattern Discovery rules · Copyability
                        score · best-token concentration
                      </p>
                    </div>
                    {selectedWallet.winnerPolicy.finalScore !== null && (
                      <div className="experimental-policy-score-breakdown">
                        <strong>Final score: {selectedWallet.winnerPolicy.finalScore} / 100</strong>
                        {selectedWallet.winnerPolicy.profitabilityScore && (
                          <p>
                            Profitability {selectedWallet.winnerPolicy.profitabilityScore.score} /{' '}
                            {selectedWallet.winnerPolicy.profitabilityScore.max} (portfolio{' '}
                            {selectedWallet.winnerPolicy.profitabilityScore.portfolioScore}, profit
                            factor{' '}
                            {selectedWallet.winnerPolicy.profitabilityScore.profitFactorScore},
                            evidence-confidence points{' '}
                            {selectedWallet.winnerPolicy.profitabilityScore.evidenceConfidenceScore}
                            , tail robustness{' '}
                            {selectedWallet.winnerPolicy.profitabilityScore.robustnessScore})
                          </p>
                        )}
                        {selectedWallet.winnerPolicy.gmgnRiskScore && (
                          <p>
                            GMGN risk/execution {selectedWallet.winnerPolicy.gmgnRiskScore.score} /{' '}
                            {selectedWallet.winnerPolicy.gmgnRiskScore.max} (deductions: execution
                            speed{' '}
                            {selectedWallet.winnerPolicy.gmgnRiskScore.deductions.executionSpeed},
                            hyperactivity{' '}
                            {selectedWallet.winnerPolicy.gmgnRiskScore.deductions.hyperactivity},
                            trade quality{' '}
                            {selectedWallet.winnerPolicy.gmgnRiskScore.deductions.tradeQuality},
                            token risk{' '}
                            {selectedWallet.winnerPolicy.gmgnRiskScore.deductions.tokenRisk}, costs{' '}
                            {selectedWallet.winnerPolicy.gmgnRiskScore.deductions.costs}, wallet age{' '}
                            {selectedWallet.winnerPolicy.gmgnRiskScore.deductions.walletAge})
                          </p>
                        )}
                      </div>
                    )}
                    <ul>
                      {selectedWallet.winnerPolicy.gates.map((item) => (
                        <li key={item.label}>
                          <strong>{item.status}</strong> · {item.label}: {item.detail}
                        </li>
                      ))}
                    </ul>
                    <div className="experimental-policy-holdouts">
                      <strong>Chronological holdouts (context only — no longer a gate)</strong>
                      {selectedWallet.winnerPolicy.evidence.holdouts.map((holdout) => (
                        <p key={holdout.index}>
                          Window {holdout.index}: {holdout.completedCopiedBuyOutcomes} copied buys ·
                          median {pct(holdout.medianReturnPercent)} · end{' '}
                          {usd(holdout.endingCapitalUsd)} ·{' '}
                          {holdout.profitable === null
                            ? 'UNPROVEN'
                            : holdout.profitable
                              ? 'profitable'
                              : 'not profitable'}
                        </p>
                      ))}
                    </div>
                  </section>
                  <section>
                    <h4>Evidence used</h4>
                    <p className={`experimental-evidence ${selectedWallet.evidence.level}`}>
                      {selectedWallet.evidence.level}
                    </p>
                    <p className="muted">{selectedWallet.evidence.detail}</p>
                    <dl>
                      <dt>GMGN median</dt>
                      <dd>{pct(selectedWallet.facts.activityMedianReturnPercent)}</dd>
                      <dt>Median hold</dt>
                      <dd>
                        {selectedWallet.facts.activityMedianHoldSeconds === null
                          ? '—'
                          : `${(selectedWallet.facts.activityMedianHoldSeconds / 3600).toFixed(1)}h`}
                      </dd>
                    </dl>
                  </section>
                  <section>
                    <h4>Warnings and context</h4>
                    {selectedWallet.risks.length ? (
                      <ul className="experimental-risk-list">
                        {selectedWallet.risks.map((risk) => (
                          <li key={risk}>{risk}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="change-positive">No recorded warnings.</p>
                    )}
                    <p>
                      <strong>Tags:</strong> {selectedWallet.tags?.join(', ') || '—'}
                    </p>
                    <p>
                      <strong>GMGN risk:</strong>{' '}
                      {selectedWallet.riskDetails?.available
                        ? 'Snapshot available'
                        : 'Not imported'}
                    </p>
                    {selectedWallet.liquidityBands && (
                      <p>
                        <strong>{strings.decisionLab.bandDetails}:</strong>{' '}
                        {selectedWallet.liquidityBands
                          .map(
                            (band) =>
                              `${band.band} $${band.minEntryTradeAmountUsd.toFixed(0)}–$${band.maxEntryTradeAmountUsd.toFixed(0)}, ${band.simulatedCount}/${band.tradeCount} copied, ${pct(band.medianSimulatedReturnPercent)} median`,
                          )
                          .join(' · ')}
                      </p>
                    )}
                  </section>
                </div>
                {selectedWallet.scrutiny && (
                  <section className="experimental-detail-checks">
                    <h4>Scrutiny checks</h4>
                    <div>
                      {selectedWallet.scrutiny.checks.map((check) => (
                        <article
                          className={`experimental-check ${check.verdict}`}
                          key={check.label}
                        >
                          <strong>
                            {check.verdict === 'pass' ? '✓' : check.verdict === 'fail' ? '×' : '…'}{' '}
                            {check.label}
                          </strong>
                          <span>{check.detail}</span>
                        </article>
                      ))}
                    </div>
                  </section>
                )}
              </details>
            </Modal>
          )}
        </>
      )}
      {riskImportInfoOpen && (
        <Modal
          onClose={() => setRiskImportInfoOpen(false)}
          ariaLabel="How to export a GMGN risk bundle"
          dialogClassName="experimental-scoring-help-modal"
        >
          <div className="copytrade-modal-head">
            <div>
              <p className="eyebrow">GMGN RISK DATA</p>
              <h3>How to get the import file</h3>
            </div>
            <button
              type="button"
              className="secondary"
              onClick={() => setRiskImportInfoOpen(false)}
            >
              Close
            </button>
          </div>
          <ol className="experimental-rule-list">
            <li>Install or reload the Vantage GMGN Chrome extension.</li>
            <li>
              Open GMGN and enable <strong>30d risk capture</strong> in the extension popup.
            </li>
            <li>Open the wallet pages or wallet list you want to capture.</li>
            <li>
              Return to the popup and click <strong>Export 30d risk JSON</strong>.
            </li>
            <li>
              Use <strong>Import GMGN risk bundle</strong> here and select that JSON file.
            </li>
          </ol>
          <p className="muted">
            The extension captures GMGN’s existing browser response; it does not request GMGN data
            itself. Only 30-day responses are imported.
          </p>
        </Modal>
      )}
    </section>
  );
}
