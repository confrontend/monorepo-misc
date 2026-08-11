import { Fragment, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type Stats = {
  tokenCount: number;
  gmgnSignalCount: number;
  tokenFirstTrade: { earliest: string | null; latest: string | null };
  gmgnObserved: { earliest: string | null; latest: string | null };
  gmgnCaptured: { earliest: string | null; latest: string | null };
  signalsByType: Array<{ signalType: string; count: number }>;
};

type ImportSummary = {
  id?: number;
  batchId?: number;
  sourcePath: string;
  status?: string;
  imported: number;
  skipped: number;
  errors: number;
  duplicateFile?: boolean;
  archivePath?: string | null;
};

type DataQuality = {
  cohortTokenCount: number;
  signalCount: number;
  matchedSignalCount: number;
  unmatchedSignalCount: number;
  tokensWithSignals: number;
  tokensWithoutSignals: number;
  coveragePercent: number;
  missingTokenAddressSignals: number;
  missingSignalTypeSignals: number;
  missingObservedAtSignals: number;
  signalsWithValidationIssues: number;
};

type LastDuneImport = { fileName: string; at: string; result: ImportSummary };
type GmgnTokenAddressSummary = { addresses: string[]; total: number; matchedToCohort: number; unmatchedToCohort: number };
type BrowserImportResult = { batchId: number; imported: number; skipped: number; errors: number; coverageWindowsImported: number; duplicateFile: boolean; archivePath: string | null; archiveSha256: string | null };
type SnapshotAnalysis = { generatedAt: string; scope: 'descriptive-snapshot-only'; signals: { total: number; uniqueTokens: number; averagePerToken: number; singleSignalTokens: number; multiSignalTokens: number; maxSignalsPerToken: number }; signalTypes: Array<{ signalType: string; count: number }>; sources: Array<{ source: string; count: number }>; cohortOverlap: { matchedSignals: number; unmatchedSignals: number; matchedTokens: number }; timing: { earliestObservedAt: string | null; latestObservedAt: string | null; earliestCapturedAt: string | null; latestCapturedAt: string | null }; marketCap: { count: number; minimum: number | null; median: number | null; average: number | null; maximum: number | null }; validation: { signalsWithIssues: number; missingTokenAddress: number; missingSignalType: number; missingObservedAt: number }; limitations: string[] };
type SignalScoreRow = { signalId: number; tokenAddress: string | null; signalType: string | null; observedAt: string | null; score: number; maxScore: 8; matchedDuneToken: boolean; firstTradeKnown: boolean; firstDexKnown: boolean; firstTxKnown: boolean; signalTimeKnown: boolean; temporalOrderValid: boolean; marketCapKnown: boolean };
type SignalScoringReport = { generatedAt: string; method: 'exploratory-data-readiness-v1'; totalSignals: number; averageScore: number; scoreDistribution: Array<{ score: number; count: number }>; rows: SignalScoreRow[]; limitations: string[] };
type OutcomeCandidate = { id: number; tokenAddress: string; symbol: string | null; signalType: string | null; observedAt: string; marketCap: number | null };
type OutcomeTimeline = { signal: OutcomeCandidate; checkpoints: Array<{ label: string; targetTimestamp: string; result: { priceUsd: number | null; status: string; priceHttpStatus: number | null; archivePath: string | null } }> };
const SIGNAL_TYPE_LABELS: Record<string, string> = { '1': 'General price spike', '2': 'Dex ad placement', '3': 'Dex social-link update', '4': 'Dex trending bar', '5': 'Dex Boost', '6': 'Price up', '7': 'Price ATH', '8': 'Market-cap key level', '9': 'Live stream', '10': 'Bundler sell', '11': 'Community takeover', '12': 'Smart-money buy', '13': 'Platform call', '14': 'Large-amount buy', '15': 'Multiple buys', '16': 'Multiple large buys', '17': 'Bags Claim', '18': 'Pump Claim', '19': 'Platform call V2', '20': 'KOL buy', '21': 'Banker Claim' };
const SIGNAL_TYPE_DESCRIPTIONS: Record<string, string> = {
  '1': 'Rapid K-line price movement. This records what happened, not a buy recommendation.',
  '2': 'DEX ad placement or paid visibility event. It is promotion, not proof of demand.',
  '3': 'DEX social-link metadata was updated. No trading direction is implied.',
  '4': 'Token appeared in a DEX trending bar or ranking surface.',
  '5': 'DEX Boost or boosted visibility event. The exact payment/threshold rule is not published here.',
  '6': 'Price-up threshold trigger. It confirms upward movement at the trigger time, not future performance.',
  '7': 'Token reached an all-time-high price trigger at the observed time.',
  '8': 'A recognized market-cap key level was crossed; the exact threshold is not published in the CLI docs.',
  '9': 'Live-stream or live-community event associated with the token.',
  '10': 'Sell activity attributed to bundler-linked wallets; it does not mean every holder is selling.',
  '11': 'Community takeover (CTO) event, indicating a project/community ownership change.',
  '12': 'Buy attributed by GMGN to a smart-money wallet classification. The wallet scoring rule is not published.',
  '13': 'GMGN platform call or promotion event; the exact trigger rule is not published.',
  '14': 'Buy classified as large amount. The amount threshold is not published in the CLI docs.',
  '15': 'Several buy events grouped into one signal. The exact count and time window are not published.',
  '16': 'Several large buys grouped into one signal. Count, amount, and time-window thresholds are not published.',
  '17': 'Bags Claim platform event.',
  '18': 'Pump Claim platform event.',
  '19': 'Platform call V2 event; the public docs do not specify how it differs from type 13.',
  '20': 'Buy attributed by GMGN to a KOL-labelled wallet. The KOL list and threshold are not published.',
  '21': 'Banker Claim platform event.'
};
const formatSignalType = (value: string | null): string => value ? `${value} · ${SIGNAL_TYPE_LABELS[value] ?? 'Unmapped GMGN type'}` : 'unknown signal type';

type GmgnStatus = {
  configured: boolean;
  keyPath: string;
  publicKeyConfigured: boolean;
  keyBytes: number;
  message: string;
};

type GmgnArchiveManifest = {
  capturedAt: string | null;
  eventCount: number | null;
  stored: number | null;
  repeated: number | null;
  validationErrors: number | null;
};

type GmgnArchiveSummary = {
  fileName: string;
  archiveBytes: number;
  modifiedAt: string;
  archiveSha256: string;
  expectedShaPrefix: string | null;
  hashVerified: boolean;
  structureVerified: boolean;
  eventCountVerified: boolean | null;
  verified: boolean;
  verificationError: string | null;
  entryNames: string[];
  manifest: GmgnArchiveManifest | null;
};

type GmgnWatchLastPoll = {
  at: string;
  ok: boolean;
  captured?: number;
  stored?: number;
  repeated?: number;
  errors?: number;
  gapDetected?: boolean;
  message?: string;
  rateLimited?: boolean;
};

type GmgnWatchStatus = {
  running: boolean;
  intervalSeconds: number;
  nextPollAt: string | null;
  lastPoll: GmgnWatchLastPoll | null;
  totalPolls: number;
  totalStored: number;
  totalRepeated: number;
  consecutiveFailures: number;
  stoppedReason: string | null;
  rateLimitedUntil: string | null;
};

type DiagnosticLog = {
  id: number;
  createdAt: string;
  level: 'info' | 'warn' | 'error';
  event: string;
  method: string | null;
  path: string | null;
  status: number | null;
  durationMs: number | null;
  requestBytes: number | null;
  message: string | null;
  detail: string | null;
};


// Disabled for now (kept in place, not removed): continuous polling needs more runway on the
// manual one-off capture path first. Server also rejects POST /api/gmgn/watch/start while this
// is off, so this flag just keeps the UI honest about it. Flip both back to re-enable.
const GMGN_WATCH_MODE_ENABLED = false;

const emptyStats: Stats = {
  tokenCount: 0,
  gmgnSignalCount: 0,
  tokenFirstTrade: { earliest: null, latest: null },
  gmgnObserved: { earliest: null, latest: null },
  gmgnCaptured: { earliest: null, latest: null },
  signalsByType: [],
};

const emptyQuality: DataQuality = {
  cohortTokenCount: 0, signalCount: 0, matchedSignalCount: 0, unmatchedSignalCount: 0,
  tokensWithSignals: 0, tokensWithoutSignals: 0, coveragePercent: 0,
  missingTokenAddressSignals: 0, missingSignalTypeSignals: 0, missingObservedAtSignals: 0,
  signalsWithValidationIssues: 0,
};


async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

const formatTime = (value: string | null): string => value ? new Date(value).toLocaleString() : '—';
const formatPercentChange = (base: number | null, value: number | null): string => base === null || value === null || base === 0 ? '—' : `${((value - base) / base * 100).toFixed(2)}%`;
const shortAddress = (address: string): string => `${address.slice(0, 3)}...`;
const copyAddress = async (address: string) => { try { await navigator.clipboard.writeText(address); } catch { /* clipboard access is optional */ } };
const tokenDisplay = (symbol: string | null, address: string): string => symbol?.trim() || shortAddress(address);

// Column names in the SELECT (token_address, symbol, first_trade_time, first_dex, first_tx) are
// deliberate — they match the aliases src/dune/importer.ts already recognizes, so a CSV/JSON
// export of this query's result can be uploaded back through "Choose a Dune lookup result"
// without any extra mapping step.
const buildDuneEnrichmentQuery = (addresses: string[]): string => {
  const values = addresses.map((address) => `    ('${address.replace(/'/g, "''")}')`).join(',\n');
  return `-- Targeted Dune lookup for ${addresses.length} GMGN-observed token address(es) not yet in the cohort.
-- Generated ${new Date().toISOString()} by the crypto research app.
-- Table/column names below (dex_solana.trades) are a common Solana first-trade source on
-- Dune — adjust them if your workspace uses a different one. Keep the final SELECT's output
-- column names exactly as token_address, symbol, first_trade_time, first_dex, first_tx so
-- this app recognizes them on re-upload.
with target_tokens (token_address) as (
  values
${values}
),
first_trades as (
  select
    t.token_bought_mint_address as token_address,
    t.token_bought_symbol as symbol,
    t.block_time as first_trade_time,
    t.project as first_dex,
    t.tx_id as first_tx,
    row_number() over (partition by t.token_bought_mint_address order by t.block_time asc) as rn
  from dex_solana.trades t
  inner join target_tokens tt on tt.token_address = t.token_bought_mint_address
)
select token_address, symbol, first_trade_time, first_dex, first_tx
from first_trades
where rn = 1
order by first_trade_time;
`;
};

const buildSimpleDuneEnrichmentQuery = (addresses: string[]): string => {
  const list = addresses.map((address) => `'${address.replace(/'/g, "''")}'`).join(',\n  ');
  return `-- Fast targeted lookup for ${addresses.length} GMGN-observed token addresses.
-- The 90-day filter avoids scanning all historical trades. Change or remove it if older
-- first-trade history is required. Adjust dex_solana.trades/column names if your workspace differs.
SELECT
  token_bought_mint_address AS token_address,
  MIN_BY(token_bought_symbol, block_time) AS symbol,
  MIN(block_time) AS first_trade_time,
  MIN_BY(project, block_time) AS first_dex,
  MIN_BY(tx_id, block_time) AS first_tx
FROM dex_solana.trades
WHERE block_time >= CURRENT_TIMESTAMP - INTERVAL '90' DAY
  AND token_bought_mint_address IN (
  ${list}
  )
GROUP BY token_bought_mint_address
ORDER BY first_trade_time;
`;
};

function App() {
  const [activeMenu, setActiveMenu] = useState('birdeye-batch');
  const [focusedView, setFocusedView] = useState(true);
  const [stats, setStats] = useState<Stats>(emptyStats);
  const [quality, setQuality] = useState<DataQuality>(emptyQuality);
  const [analysis, setAnalysis] = useState<SnapshotAnalysis | null>(null);
  const [scoring, setScoring] = useState<SignalScoringReport | null>(null);
  const [probeAddress, setProbeAddress] = useState('');
  const [probeTime, setProbeTime] = useState(new Date().toISOString().slice(0, 16));
  const [probeBusy, setProbeBusy] = useState(false);
  const [probeResult, setProbeResult] = useState<{ status: string; priceHttpStatus: number | null; liquidityHttpStatus: number | null; priceUsd: number | null; currentLiquidityHttpStatus: number | null; currentLiquidityUsd: number | null; liquidityMessage: string | null; archivePath: string | null; error: string | null } | null>(null);
  const [outcomeCandidates, setOutcomeCandidates] = useState<OutcomeCandidate[]>([]);
  const [selectedSignalIds, setSelectedSignalIds] = useState<number[]>([]);
  const [outcomeBusy, setOutcomeBusy] = useState(false);
  const [outcomeTimelines, setOutcomeTimelines] = useState<OutcomeTimeline[]>([]);
  const [imports, setImports] = useState<ImportSummary[]>([]);
  const [gmgnStatus, setGmgnStatus] = useState<GmgnStatus | null>(null);
  const [capturingGmgn, setCapturingGmgn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [duneBusyFile, setDuneBusyFile] = useState<string | null>(null);
  const [lastDuneImport, setLastDuneImport] = useState<LastDuneImport | null>(null);
  const [exportingAddresses, setExportingAddresses] = useState(false);
  const [enrichmentBusy, setEnrichmentBusy] = useState(false);
  const [lastEnrichmentImport, setLastEnrichmentImport] = useState<LastDuneImport | null>(null);
  const [duneQuery, setDuneQuery] = useState('');
  const [generatingQuery, setGeneratingQuery] = useState(false);
  const [browserImportBusy, setBrowserImportBusy] = useState(false);
  const [lastBrowserImport, setLastBrowserImport] = useState<{ fileName: string; at: string; result: BrowserImportResult } | null>(null);
  const [logs, setLogs] = useState<DiagnosticLog[] | null>(null);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [archives, setArchives] = useState<GmgnArchiveSummary[] | null>(null);
  const [loadingArchives, setLoadingArchives] = useState(false);
  const [expandedArchive, setExpandedArchive] = useState<string | null>(null);
  const [watchStatus, setWatchStatus] = useState<GmgnWatchStatus | null>(null);
  const [watchBusy, setWatchBusy] = useState(false);
  const [watchIntervalMinutes, setWatchIntervalMinutes] = useState(5);
  const [message, setMessage] = useState('Ready. Data is saved locally in SQLite.');
  const [gmgnPayload, setGmgnPayload] = useState(`{
  "observed_at": "2026-08-09T12:00:00Z",
  "token_address": "",
  "signal_type": "",
  "market_cap": null,
  "triggering_wallet": "",
  "raw_wallet_labels": []
}`);

  const refresh = async () => {
    const [nextStats, nextImports, nextQuality, nextGmgn, nextWatch, nextAnalysis, nextScoring, nextCandidates, latestOutcomes] = await Promise.all([
      api<Stats>('/api/stats'),
      api<ImportSummary[]>('/api/imports'),
      api<DataQuality>('/api/quality'),
      api<GmgnStatus>('/api/gmgn/status'),
      api<GmgnWatchStatus>('/api/gmgn/watch/status'),
      api<SnapshotAnalysis>('/api/analysis/snapshot'),
      api<SignalScoringReport>('/api/analysis/scores'),
      api<OutcomeCandidate[]>('/api/dune/candidates'),
      api<OutcomeTimeline[]>('/api/dune/outcomes/latest'),
    ]);
    setStats(nextStats);
    setImports(nextImports);
    setQuality(nextQuality);
    setGmgnStatus(nextGmgn);
    setWatchStatus(nextWatch);
    setAnalysis(nextAnalysis);
    setScoring(nextScoring);
    setOutcomeCandidates(nextCandidates);
    setOutcomeTimelines(latestOutcomes);
    if (selectedSignalIds.length === 0 && nextCandidates[0]) setSelectedSignalIds([nextCandidates[0].id]);
  };

  const measureSelectedOutcome = async () => {
    if (selectedSignalIds.length === 0) return;
    setOutcomeBusy(true);
    try {
      setOutcomeTimelines(await api<OutcomeTimeline[]>('/api/dune/outcomes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signalIds: selectedSignalIds }) }));
      setMessage(`${selectedSignalIds.length} signal timeline(s) captured. Each checkpoint was archived separately.`);
    } catch (error: unknown) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setOutcomeBusy(false); }
  };

  const ensureGmgnReady = async (): Promise<void> => {
    const status = await api<GmgnStatus>('/api/gmgn/status');
    setGmgnStatus(status);
    if (!status.configured) throw new Error(status.message);
  };

  const captureGmgnSignals = async () => {
    setCapturingGmgn(true);
    try {
      await ensureGmgnReady();
      const result = await api<{ captured: number; stored: number; repeated: number; errors: number; gapDetected: boolean; archivePath: string }>('/api/gmgn/capture', { method: 'POST' });
      await refresh();
      setMessage(`GMGN poll received ${result.captured}; stored ${result.stored}; repeated ${result.repeated}; issues ${result.errors}; gap ${result.gapDetected ? 'flagged' : 'not detected'}. ZIP archived.`);
    } catch (error: unknown) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setCapturingGmgn(false); }
  };

  const loadArchives = async () => {
    setLoadingArchives(true);
    try {
      setArchives(await api<GmgnArchiveSummary[]>('/api/gmgn/archives'));
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingArchives(false);
    }
  };

  const loadWatchStatus = async () => {
    try {
      setWatchStatus(await api<GmgnWatchStatus>('/api/gmgn/watch/status'));
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const startWatch = async () => {
    setWatchBusy(true);
    try {
      await ensureGmgnReady();
      const status = await api<GmgnWatchStatus>('/api/gmgn/watch/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ intervalSeconds: watchIntervalMinutes * 60 }),
      });
      setWatchStatus(status);
      setMessage(`Watch mode started — polling every ${watchIntervalMinutes} min.`);
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setWatchBusy(false);
    }
  };

  const stopWatch = async () => {
    setWatchBusy(true);
    try {
      setWatchStatus(await api<GmgnWatchStatus>('/api/gmgn/watch/stop', { method: 'POST' }));
      setMessage('Watch mode stopped.');
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setWatchBusy(false);
    }
  };

  useEffect(() => {
    if (!watchStatus?.running) return;
    const timer = window.setInterval(() => { void loadWatchStatus(); }, 4000);
    return () => window.clearInterval(timer);
  }, [watchStatus?.running]);

  const loadLogs = async () => {
    setLoadingLogs(true);
    try {
      setLogs(await api<DiagnosticLog[]>('/api/logs?limit=50'));
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingLogs(false);
    }
  };

  useEffect(() => { void refresh().catch((error: unknown) => setMessage(String(error))); }, []);
  useEffect(() => {
    const intro = document.querySelector<HTMLElement>('.signal-outcome-batch-panel .outcome-inner > p');
    if (intro) intro.textContent = 'Select one or more captured signals. The Dune SQL query uses supported time arithmetic for the signal, +1h, and +3h checkpoints. A future checkpoint or a token with no matching trade remains unavailable.';
    const candidateById = new Map(outcomeCandidates.map((candidate) => [candidate.id, candidate]));
    document.querySelectorAll<HTMLElement>('.signal-outcome-batch-panel .candidate-row').forEach((row) => {
      const id = Number(row.querySelector('b')?.textContent?.match(/#(\d+)/)?.[1]);
      const candidate = candidateById.get(id);
      const address = row.querySelector<HTMLElement>('small[title]');
      if (candidate && address) { address.textContent = ''; address.append(document.createTextNode(tokenDisplay(candidate.symbol, candidate.tokenAddress))); const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'copy-address'; copy.ariaLabel = `Copy address ${candidate.tokenAddress}`; copy.textContent = '⧉'; copy.onclick = (event) => { event.preventDefault(); event.stopPropagation(); void copyAddress(candidate.tokenAddress); }; address.append(copy); }
    });
    const tokenById = new Map(outcomeTimelines.map((timeline) => [timeline.signal.id, timeline.signal]));
    const table = document.querySelector<HTMLTableElement>('.outcome-table table');
    if (table) {
      const hasOneHour = outcomeTimelines.some((timeline) => timeline.checkpoints.some((checkpoint) => checkpoint.label === '+1h'));
      const hasThreeHour = outcomeTimelines.some((timeline) => timeline.checkpoints.some((checkpoint) => checkpoint.label === '+3h'));
      [hasOneHour, hasThreeHour].forEach((visible, index) => { const column = table.rows[0]?.cells[3 + index]; if (column) column.style.display = visible ? '' : 'none'; table.querySelectorAll('tbody tr').forEach((row) => { const cell = row.cells[3 + index]; if (cell) cell.style.display = visible ? '' : 'none'; }); });
    }
    document.querySelectorAll<HTMLTableRowElement>('.outcome-table tbody tr').forEach((row) => {
      const id = Number(row.cells[0]?.textContent?.replace('#', ''));
      const signal = tokenById.get(id);
      const cell = row.cells[2];
      if (!signal || !cell) return;
      cell.textContent = '';
      const label = document.createElement('span'); label.className = 'token-cell'; label.title = signal.tokenAddress; label.textContent = tokenDisplay(signal.symbol, signal.tokenAddress);
      const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'copy-address'; copy.ariaLabel = `Copy address ${signal.tokenAddress}`; copy.textContent = '⧉'; copy.onclick = () => void copyAddress(signal.tokenAddress);
      label.append(copy); cell.append(label);
    });
    if (table) {
      const header = Array.from(table.tHead?.rows[0]?.cells ?? []).find((cell) => cell.textContent?.trim() === 'Token');
      if (header) table.tHead?.rows[0]?.append(header);
      table.tBodies[0]?.querySelectorAll('tr').forEach((row) => { const tokenCell = row.querySelector('.token-cell')?.parentElement; if (tokenCell) row.append(tokenCell); });
    }
  }, [outcomeCandidates, outcomeTimelines]);

  const importDune = async (file: File) => {
    setBusy(true);
    setDuneBusyFile(file.name);
    setMessage(`Saving ${file.name} to SQLite and creating an archive…`);
    try {
      const result = await api<ImportSummary>('/api/import-dune', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: file.name, content: await file.text() }),
      });
      await refresh();
      setLastDuneImport({ fileName: file.name, at: new Date().toISOString(), result });
      setMessage(`Imported ${result.imported}; skipped ${result.skipped}; errors ${result.errors}. Archive: ${result.archivePath ?? 'already archived'}`);
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      setDuneBusyFile(null);
    }
  };

  const exportGmgnTokenAddresses = async () => {
    setExportingAddresses(true);
    try {
      const summary = await api<GmgnTokenAddressSummary>('/api/gmgn/token-addresses');
      if (summary.addresses.length === 0) {
        setMessage('No GMGN-observed token addresses are missing from the cohort right now — nothing to export.');
        return;
      }
      const blob = new Blob([summary.addresses.join('\n')], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `gmgn-token-addresses-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage(`Exported ${summary.addresses.length} address(es) not yet in the Dune cohort (of ${summary.total} GMGN-observed addresses total, ${summary.matchedToCohort} already matched). Look these up in Dune, then upload the result below.`);
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setExportingAddresses(false);
    }
  };

  const generateDuneQuery = async () => {
    setGeneratingQuery(true);
    try {
      const summary = await api<GmgnTokenAddressSummary>('/api/gmgn/token-addresses');
      if (summary.addresses.length === 0) {
        setMessage('No GMGN-observed token addresses are missing from the cohort right now — nothing to query.');
        setDuneQuery('');
        return;
      }
      setDuneQuery(buildSimpleDuneEnrichmentQuery(summary.addresses));
      setMessage(`Generated a Dune query for ${summary.addresses.length} address(es). Copy it below, run it in Dune, then upload the result.`);
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setGeneratingQuery(false);
    }
  };

  const copyDuneQuery = async () => {
    try {
      await navigator.clipboard.writeText(duneQuery);
      setMessage('Dune query copied to clipboard.');
    } catch {
      setMessage('Could not copy automatically — select the query text below and copy it manually.');
    }
  };

  const importDuneEnrichment = async (file: File) => {
    setEnrichmentBusy(true);
    setMessage(`Saving ${file.name} as targeted Dune enrichment…`);
    try {
      const result = await api<ImportSummary>('/api/import-dune-enrichment', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: file.name, content: await file.text() }),
      });
      await refresh();
      setLastEnrichmentImport({ fileName: file.name, at: new Date().toISOString(), result });
      setMessage(`Enrichment imported ${result.imported}; skipped ${result.skipped}; errors ${result.errors}. Addresses already in the cohort were left untouched.`);
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setEnrichmentBusy(false);
    }
  };

  const captureGmgn = async () => {
    setBusy(true);
    try {
      const stored = await api<{ id: number }>('/api/gmgn', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: gmgnPayload,
      });
      await refresh();
      setMessage(`GMGN observation #${stored.id} saved. Raw payload preserved.`);
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const importBrowserCapture = async (file: File) => {
    setBrowserImportBusy(true);
    setMessage(`Importing ${file.name} and preserving the raw browser response…`);
    try {
      const result = await api<BrowserImportResult>('/api/gmgn/import-browser-capture', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: file.name, content: await file.text() }),
      });
      await refresh();
      setLastBrowserImport({ fileName: file.name, at: new Date().toISOString(), result });
      setMessage(`${result.duplicateFile ? 'Browser capture already imported' : 'Browser capture imported'}: +${result.imported} signals · ${result.skipped} repeats · ${result.errors} issues. Raw upload archived.`);
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBrowserImportBusy(false);
    }
  };

  const runBirdeyeProbe = async () => {
    setProbeBusy(true);
    try {
      const result = await api<{ status: string; priceHttpStatus: number | null; liquidityHttpStatus: number | null; priceUsd: number | null; currentLiquidityHttpStatus: number | null; currentLiquidityUsd: number | null; liquidityMessage: string | null; archivePath: string | null; error: string | null }>('/api/birdeye/probe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tokenAddress: probeAddress.trim(), targetTimestamp: new Date(probeTime).toISOString() }) });
      setProbeResult(result);
      setMessage(`Birdeye probe ${result.status}. Raw price/liquidity responses archived.`);
    } catch (error: unknown) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setProbeBusy(false); }
  };

  const navigateTo = (section: string) => {
    setActiveMenu(section);
    document.getElementById(section)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return <main className={`shell ${focusedView ? 'focused-view' : ''}`}>
    <header className="hero">
      <div>
        <p className="eyebrow">CRYPTO RESEARCH · V1 CAPTURE</p>
        <h1>Solana Signal Research Desk.</h1>
        <p className="lede">A local collection desk for Solana cohort exports and GMGN observations. Every upload is persisted to SQLite, logged, and archived as a ZIP.</p>
      </div>
      <div className="status-pill"><span className="dot" /> SQLite connected</div>
    </header>

    <nav className="app-menu" aria-label="Research desk sections">
      <button className={focusedView ? 'active' : ''} onClick={() => setFocusedView((current) => !current)}>{focusedView ? 'Focused work' : 'Show all sections'}</button>
      <button className={activeMenu === 'overview' ? 'active' : ''} onClick={() => navigateTo('overview')}>Overview</button>
      <button className={activeMenu === 'imports' ? 'active' : ''} onClick={() => navigateTo('imports')}>Imports</button>
      <button className={activeMenu === 'capture' ? 'active' : ''} onClick={() => navigateTo('capture')}>GMGN Capture</button>
      <button className={activeMenu === 'analysis' ? 'active' : ''} onClick={() => navigateTo('analysis')}>Snapshot Analysis</button>
      <button className={activeMenu === 'scoring' ? 'active' : ''} onClick={() => navigateTo('scoring')}>Scoring</button>
      <button className={activeMenu === 'birdeye-batch' ? 'active' : ''} onClick={() => navigateTo('birdeye-batch')}>Outcome Data</button>
      <button className={activeMenu === 'evidence' ? 'active' : ''} onClick={() => navigateTo('evidence')}>Evidence</button>
      <button className={activeMenu === 'diagnostics' ? 'active' : ''} onClick={() => navigateTo('diagnostics')}>Diagnostics</button>
    </nav>

    <section id="overview" className="menu-section">
    <ol className="workflow-strip">
      <li className={stats.tokenCount > 0 ? 'done' : 'active'}><span>1</span><div><strong>Import a Dune cohort</strong><small>{stats.tokenCount > 0 ? `${stats.tokenCount.toLocaleString()} tokens stored` : 'Not started'}</small></div></li>
      <li className={gmgnStatus?.configured ? (stats.gmgnSignalCount > 0 ? 'done' : 'active') : ''}><span>2</span><div><strong>Capture GMGN signals</strong><small>{stats.gmgnSignalCount > 0 ? `${stats.gmgnSignalCount.toLocaleString()} signals captured` : 'Import a browser export, fetch once, or start watching'}</small></div></li>
      <li><span>3</span><div><strong>Review evidence &amp; diagnostics</strong><small>Archives, coverage, activity, and logs below</small></div></li>
    </ol>

    <section className="stats-grid">
      <article className="stat-card"><span>Tokens</span><strong>{stats.tokenCount.toLocaleString()}</strong><small>unique addresses</small></article>
      <article className="stat-card"><span>GMGN signals</span><strong>{stats.gmgnSignalCount.toLocaleString()}</strong><small>raw observations</small></article>
      <article className="stat-card"><span>First trade range</span><strong>{formatTime(stats.tokenFirstTrade.earliest)}</strong><small>to {formatTime(stats.tokenFirstTrade.latest)}</small></article>
      <article className="stat-card"><span>Observed range</span><strong>{formatTime(stats.gmgnObserved.earliest)}</strong><small>to {formatTime(stats.gmgnObserved.latest)}</small></article>
    </section>
    </section>

    <section id="imports" className="menu-section work-grid">
      <article className="panel upload-panel">
        <div className="panel-heading"><div><p className="eyebrow">01 · DUNE COHORT</p><h2>Import historical tokens</h2></div><span className="tag">CSV / JSON</span></div>
        <p>Choose an export from your computer. Duplicate files and token addresses are safely skipped; malformed rows remain in the audit log.</p>
        <div className="credential-status">
          <span className={`status-dot ${duneBusyFile ? '' : stats.tokenCount > 0 ? 'good' : ''}`} />
          <div>
            <strong>{duneBusyFile ? `Saving ${duneBusyFile}…` : `${stats.tokenCount.toLocaleString()} token${stats.tokenCount === 1 ? '' : 's'} stored in SQLite`}</strong>
            <small>{lastDuneImport
              ? `Last import "${lastDuneImport.fileName}": +${lastDuneImport.result.imported} imported · ${lastDuneImport.result.skipped} skipped · ${lastDuneImport.result.errors} errors · ${lastDuneImport.result.duplicateFile ? 'duplicate file, already archived' : lastDuneImport.result.archivePath ? 'archived to ZIP' : 'archive pending'} · ${formatTime(lastDuneImport.at)}`
              : 'Persists in SQLite across refreshes and restarts — import each export only once.'}</small>
          </div>
        </div>
        <label className={`dropzone ${busy ? 'disabled' : ''}`}>
          <input type="file" accept=".csv,.json,application/json,text/csv" disabled={busy} onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importDune(file);
            event.currentTarget.value = '';
          }} />
          <span className="upload-icon">↑</span><strong>Choose a Dune export</strong><small>Nothing leaves this machine</small>
        </label>
      </article>

      <article className="panel signal-panel">
        <div className="panel-heading"><div><p className="eyebrow">MANUAL OVERRIDE</p><h2>Paste a raw observation</h2></div><span className="tag">JSON</span></div>
        <p>Optional: paste one captured event by hand instead of using automated capture below. The normalized fields are only a convenience; the complete payload is always retained.</p>
        <textarea value={gmgnPayload} onChange={(event) => setGmgnPayload(event.target.value)} spellCheck={false} />
        <button className="primary" disabled={busy} onClick={() => void captureGmgn()}>Save GMGN observation</button>
      </article>

      <article className="panel upload-panel">
        <div className="panel-heading"><div><p className="eyebrow">TARGETED ENRICHMENT</p><h2>Look up GMGN tokens in Dune</h2></div><span className="tag">CSV / JSON</span></div>
        <p>Most GMGN signals land on tokens the Dune cohort export never covered. Export the addresses GMGN has actually observed, look them up in Dune yourself, then upload the result here — it's stored separately from the original cohort and never overwrites an address already on file.</p>
        <div className="watch-controls">
          <button className="secondary" disabled={exportingAddresses} onClick={() => void exportGmgnTokenAddresses()}>{exportingAddresses ? 'Exporting…' : 'Export addresses (.txt)'}</button>
          <button className="secondary" disabled={generatingQuery} onClick={() => void generateDuneQuery()}>{generatingQuery ? 'Generating…' : 'Generate Dune query'}</button>
        </div>
        {duneQuery && (
          <div className="dune-query-block">
            <textarea readOnly value={duneQuery} spellCheck={false} onFocus={(event) => event.currentTarget.select()} />
            <button className="primary" onClick={() => void copyDuneQuery()}>Copy query</button>
          </div>
        )}
        <div className="credential-status">
          <span className={`status-dot ${enrichmentBusy ? '' : lastEnrichmentImport ? 'good' : ''}`} />
          <div>
            <strong>{enrichmentBusy ? 'Importing enrichment…' : lastEnrichmentImport ? `Last enrichment: ${lastEnrichmentImport.fileName}` : 'No enrichment imported this session'}</strong>
            <small>{lastEnrichmentImport
              ? `+${lastEnrichmentImport.result.imported} imported · ${lastEnrichmentImport.result.skipped} already on file · ${lastEnrichmentImport.result.errors} errors · ${formatTime(lastEnrichmentImport.at)}`
              : 'Same audit trail and archive as a cohort import, tagged dune-targeted-enrichment.'}</small>
          </div>
        </div>
        <label className={`dropzone ${enrichmentBusy ? 'disabled' : ''}`}>
          <input type="file" accept=".csv,.json,application/json,text/csv" disabled={enrichmentBusy} onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importDuneEnrichment(file);
            event.currentTarget.value = '';
          }} />
          <span className="upload-icon">↑</span><strong>Choose a Dune lookup result</strong><small>Nothing leaves this machine</small>
        </label>
      </article>
    </section>

    <section id="capture" className="menu-section panel browser-import-panel">
      <div className="panel-heading"><div><p className="eyebrow">GMGN BROWSER CAPTURE</p><h2>Import website signal evidence</h2></div><span className="tag">JSON EXPORT</span></div>
      <p>Upload an export produced by the authorized GMGN browser capture extension. Events are tagged <code>gmgn-browser-extension</code>, stored through the same append-only signal path, and the complete upload is archived with a manifest. This does not scrape or infer anything.</p>
      <div className="credential-status">
        <span className={`status-dot ${browserImportBusy ? '' : lastBrowserImport ? 'good' : ''}`} />
        <div><strong>{browserImportBusy ? 'Importing browser capture…' : lastBrowserImport ? `Last upload: ${lastBrowserImport.fileName}` : 'No browser capture imported this session'}</strong>
          <small>{lastBrowserImport ? `+${lastBrowserImport.result.imported} imported · ${lastBrowserImport.result.skipped} repeats · ${lastBrowserImport.result.errors} issues · ${lastBrowserImport.result.coverageWindowsImported} coverage window(s) · ${lastBrowserImport.result.duplicateFile ? 'duplicate file' : 'ZIP archived'} · ${formatTime(lastBrowserImport.at)}` : 'The raw JSON remains available for later audit and replay.'}</small></div>
      </div>
      <label className={`dropzone ${browserImportBusy ? 'disabled' : ''}`}><input type="file" accept=".json,application/json" disabled={browserImportBusy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void importBrowserCapture(file); event.currentTarget.value = ''; }} /><span className="upload-icon">↑</span><strong>Choose a browser capture export</strong><small>Nothing leaves this machine</small></label>
    </section>

    <section className="menu-section panel watch-panel">
      <div className="panel-heading">
        <div><p className="eyebrow">GMGN WATCH MODE</p><h2>Continuous local polling</h2></div>
        <span className={`tag ${watchStatus?.running ? 'tag-good' : ''}`}>{watchStatus?.running ? 'RUNNING' : 'STOPPED'}</span>
      </div>
      <p>Repeats the same one-off capture on a timer while this app stays open. No cloud service, no background task — polling stops the moment the local server stops, and stops itself after repeated failures.</p>
      {/* GMGN_WATCH_MODE_ENABLED is false for now — continuous polling is disabled (code kept intact; server also rejects /watch/start). Use "Fetch once" in the meantime. */}
      {!GMGN_WATCH_MODE_ENABLED && <p className="probe-result">Continuous polling is temporarily disabled. "Fetch once" still works below.</p>}
      <div className="watch-controls">
        <label>Interval
          <select value={watchIntervalMinutes} disabled={!GMGN_WATCH_MODE_ENABLED || watchStatus?.running} onChange={(event) => setWatchIntervalMinutes(Number(event.target.value))}>
            <option value={1}>1 minute</option>
            <option value={5}>5 minutes</option>
            <option value={15}>15 minutes</option>
            <option value={30}>30 minutes</option>
            <option value={60}>60 minutes</option>
          </select>
        </label>
        <button className="secondary" disabled={capturingGmgn} onClick={() => void captureGmgnSignals()}>{capturingGmgn ? 'Fetching…' : 'Fetch once'}</button>
        {watchStatus?.running
          ? <button className="primary" disabled={watchBusy} onClick={() => void stopWatch()}>{watchBusy ? 'Stopping…' : 'Stop watching'}</button>
          : <button className="primary" disabled={!GMGN_WATCH_MODE_ENABLED || watchBusy} onClick={() => void startWatch()}>{GMGN_WATCH_MODE_ENABLED ? (watchBusy ? 'Starting…' : 'Start watching') : 'Disabled for now'}</button>}
      </div>
      <div className="credential-status">
        <span className={`status-dot ${watchStatus?.running ? 'good' : ''}`} />
        <div>
          <strong>{watchStatus?.running ? `Running — next poll ${formatTime(watchStatus.nextPollAt)}` : watchStatus?.stoppedReason ? `Stopped: ${watchStatus.stoppedReason}` : 'Not running'}</strong>
          <small>{watchStatus?.lastPoll
            ? `Last poll ${formatTime(watchStatus.lastPoll.at)}: ${watchStatus.lastPoll.ok
              ? `+${watchStatus.lastPoll.stored ?? 0} new · ${watchStatus.lastPoll.repeated ?? 0} repeats · ${watchStatus.lastPoll.errors ?? 0} issues${watchStatus.lastPoll.gapDetected ? ' · gap flagged' : ''}`
              : `failed — ${watchStatus.lastPoll.message ?? 'unknown error'}`}`
            : 'No polls yet this session.'}</small>
        </div>
      </div>
      {watchStatus && watchStatus.totalPolls > 0 && <p className="watch-totals">{watchStatus.totalPolls} polls this session · {watchStatus.totalStored} new signals · {watchStatus.totalRepeated} repeats · {watchStatus.consecutiveFailures} consecutive failures</p>}
      {watchStatus?.rateLimitedUntil && <p className="probe-result">Rate-limited by GMGN — resuming at {formatTime(watchStatus.rateLimitedUntil)}</p>}
    </section>

    <section id="analysis" className="menu-section panel snapshot-analysis-panel">
      <div className="panel-heading"><div><p className="eyebrow">DESCRIPTIVE ANALYSIS</p><h2>Captured-signal snapshot</h2></div><span className="tag">NO SCORING</span></div>
      <p>This summarizes what is currently in the database. It describes the snapshot only; it does not decide whether any signal is good or bad.</p>
      {analysis && <>
        <div className="quality-grid">
          <div className="quality-metric"><strong>{analysis.signals.total}</strong><span>signals captured</span><small>{analysis.signals.uniqueTokens} unique tokens</small></div>
          <div className="quality-metric"><strong>{analysis.cohortOverlap.matchedSignals}</strong><span>signals matched to Dune</span><small>{analysis.cohortOverlap.unmatchedSignals} unmatched</small></div>
          <div className="quality-metric"><strong>{analysis.marketCap.median === null ? '—' : `$${Math.round(analysis.marketCap.median).toLocaleString()}`}</strong><span>median signal market cap</span><small>{analysis.marketCap.count} records with market cap</small></div>
          <div className="quality-metric"><strong>{analysis.signals.multiSignalTokens}</strong><span>tokens with multiple signals</span><small>max {analysis.signals.maxSignalsPerToken} per token</small></div>
        </div>
        <div className="analysis-columns">
          <div><h3>Signal types</h3>{analysis.signalTypes.map((item) => <div className="analysis-row" key={item.signalType}><span>Type {item.signalType}</span><b>{item.count}</b></div>)}</div>
          <div><h3>Sources</h3>{analysis.sources.map((item) => <div className="analysis-row" key={item.source}><span>{item.source}</span><b>{item.count}</b></div>)}<h3>Timing</h3><p className="analysis-note">Observed: {formatTime(analysis.timing.earliestObservedAt)} → {formatTime(analysis.timing.latestObservedAt)}<br />Captured: {formatTime(analysis.timing.earliestCapturedAt)} → {formatTime(analysis.timing.latestCapturedAt)}</p></div>
        </div>
        <p className="analysis-limitations"><strong>Interpretation limits:</strong> {analysis.limitations.join(' ')}</p>
      </>}
    </section>

    <section id="scoring" className="menu-section panel scoring-panel">
      <div className="panel-heading"><div><p className="eyebrow">EXPLORATORY SCORING</p><h2>Signal data-readiness score</h2></div><span className="tag">PROVISIONAL</span></div>
      <p>This is the first transparent scoring experiment. It scores how much supporting data we have for each signal—not whether the signal made money.</p>
      {scoring && <>
        <div className="quality-grid"><div className="quality-metric"><strong>{scoring.averageScore}/8</strong><span>average readiness</span><small>{scoring.totalSignals} signals scored</small></div><div className="quality-metric"><strong>{scoring.scoreDistribution.find((item) => item.score === 8)?.count ?? 0}</strong><span>fully documented</span><small>all eight checks passed</small></div></div>
        <div className="score-legend"><span>Points: Dune match (2) · first-trade time · DEX · transaction · signal time · time order · market cap</span></div>
        <div className="table-wrap"><table><thead><tr><th>Signal</th><th>Type</th><th>Score</th><th>Dune</th><th>Evidence</th></tr></thead><tbody>{scoring.rows.slice(0, 25).map((row) => <tr key={row.signalId}><td><strong>#{row.signalId}</strong><small>{row.tokenAddress ?? 'missing address'}</small></td><td>{row.signalType ?? '—'}</td><td><span className="count-good">{row.score}/{row.maxScore}</span></td><td>{row.matchedDuneToken ? 'Matched' : 'Unmatched'}</td><td><small>{[row.firstTradeKnown && 'trade time', row.firstDexKnown && 'DEX', row.firstTxKnown && 'tx', row.temporalOrderValid && 'time order', row.marketCapKnown && 'market cap'].filter(Boolean).join(' · ') || 'No supporting fields'}</small></td></tr>)}</tbody></table></div>
        <p className="analysis-limitations"><strong>Important:</strong> {scoring.limitations.join(' ')}</p>
      </>}
    </section>

    <section id="birdeye-batch" className="menu-section panel signal-outcome-batch-panel">
      <section className="outcome-inner">
      <div className="panel-heading"><div><p className="eyebrow">DUNE SIGNAL OUTCOME TIMELINE</p><h2>Measure captured GMGN signals</h2></div><span className="tag">DUNE PRICE HISTORY</span></div>
      <details className="signal-legend"><summary>Signal-type legend</summary><div className="signal-legend-grid">{Object.keys(SIGNAL_TYPE_LABELS).map((code) => <div key={code}><b>{code} · {SIGNAL_TYPE_LABELS[code]}</b><small>{SIGNAL_TYPE_DESCRIPTIONS[code]}</small></div>)}</div><small>Names and high-level meanings are from GMGNAI’s official gmgn-skills CLI documentation. GMGN does not publish every wallet-classification, amount, count, or time-window threshold here, so these labels are observations—not quality or profitability verdicts.</small></details>
      <label className="select-all-row"><input type="checkbox" checked={outcomeCandidates.slice(0, 25).length > 0 && outcomeCandidates.slice(0, 25).every((candidate) => selectedSignalIds.includes(candidate.id))} onChange={(event) => setSelectedSignalIds(event.target.checked ? outcomeCandidates.slice(0, 25).map((candidate) => candidate.id) : [])} /><b>Select all visible signals</b><small>({Math.min(outcomeCandidates.length, 25)} shown)</small></label>
      <p>Select one or more captured signals. One Dune SQL execution requests each signal’s price at the signal, +1h, +6h, +24h, and +7d, preserving unavailable checkpoints as missing.</p>
      <div className="candidate-list">{outcomeCandidates.slice(0, 25).map((candidate) => <label key={candidate.id} className="candidate-row"><input type="checkbox" checked={selectedSignalIds.includes(candidate.id)} onChange={(event) => setSelectedSignalIds((current) => event.target.checked ? [...current, candidate.id] : current.filter((id) => id !== candidate.id))} /><span><b>#{candidate.id} · {formatSignalType(candidate.signalType)}</b><small title={candidate.tokenAddress}>{candidate.tokenAddress}</small><small>{formatTime(candidate.observedAt)}</small></span></label>)}</div>
      <button className="primary" disabled={outcomeBusy || selectedSignalIds.length === 0} onClick={() => void measureSelectedOutcome()}>{outcomeBusy ? 'Measuring…' : `Measure ${selectedSignalIds.length || 'selected'} signal${selectedSignalIds.length === 1 ? '' : 's'}`}</button>
      {outcomeTimelines.map((timeline) => <div className="timeline-result" key={timeline.signal.id}><strong>Signal #{timeline.signal.id} · {timeline.signal.signalType ?? 'unknown'} · <span className="address-compact" title={timeline.signal.tokenAddress}>{timeline.signal.tokenAddress}</span></strong><div className="timeline-grid">{timeline.checkpoints.map((checkpoint) => <div key={checkpoint.label}><span>{checkpoint.label}</span><b>{checkpoint.result.priceUsd === null ? 'not available' : `$${checkpoint.result.priceUsd}`}</b><small>{checkpoint.result.status} · HTTP {checkpoint.result.priceHttpStatus ?? '—'}</small></div>)}</div><small>Missing checkpoints remain missing, never treated as zero.</small></div>)}
    </section>

      {outcomeTimelines.length > 0 && <div className="table-wrap outcome-table"><table><thead><tr><th>Signal</th><th>Type</th><th>Token</th><th>+1h change</th><th>+3h change</th></tr></thead><tbody>{outcomeTimelines.map((timeline) => { const base = timeline.checkpoints.find((checkpoint) => checkpoint.label === 'signal')?.result.priceUsd ?? null; const plusOne = timeline.checkpoints.find((checkpoint) => checkpoint.label === '+1h')?.result.priceUsd ?? null; const plusThree = timeline.checkpoints.find((checkpoint) => checkpoint.label === '+3h')?.result.priceUsd ?? null; return <tr key={timeline.signal.id}><td>#{timeline.signal.id}</td><td>{formatSignalType(timeline.signal.signalType)}</td><td><span className="address-compact" title={timeline.signal.tokenAddress}>{timeline.signal.tokenAddress}</span></td><td><strong>{formatPercentChange(base, plusOne)}</strong></td><td><strong>{formatPercentChange(base, plusThree)}</strong></td></tr>; })}</tbody></table></div>}
    </section>

    <section id="birdeye" className="menu-section panel signal-outcome-panel">
      <div className="panel-heading"><div><p className="eyebrow">SIGNAL OUTCOME TIMELINE</p><h2>Measure a captured GMGN signal</h2></div><span className="tag">PRICE HISTORY</span></div>
      <p>Choose a signal already captured by GMGN. The app freezes its buy/sell label and observed time, then requests historical prices at the signal, +1h, +6h, +24h, and +7d. Each response is archived separately.</p>
      <p className="muted">This legacy single-token diagnostic is available only in the full view. Use the batch signal timeline above.</p>
    </section>

    <section id="legacy-probe" className="menu-section panel probe-panel">
      <div className="panel-heading"><div><p className="eyebrow">CURRENT WORK · ONE COIN</p><h2>Check one token outcome</h2></div><span className="tag">RAW EVIDENCE</span></div>
      <p>Fetches one historical price response and one liquidity response for a token and timestamp. The app stores both untouched responses and archives them; it does not calculate an outcome yet.</p>
      <div className="probe-form"><label>Token address<input value={probeAddress} onChange={(event) => setProbeAddress(event.target.value)} placeholder="Solana token address" /></label><label>Target UTC time<input type="datetime-local" value={probeTime} onChange={(event) => setProbeTime(event.target.value)} /></label><button className="primary" disabled={probeBusy || !probeAddress.trim()} onClick={() => void runBirdeyeProbe()}>{probeBusy ? 'Probing…' : 'Run one probe'}</button></div>
      {probeResult && <div className="probe-result"><strong>{probeResult.status === 'completed' ? 'Historical outcome received' : 'Partial result received'}</strong><div className="probe-result-grid"><span>Price HTTP <b>{probeResult.priceHttpStatus ?? '—'}</b></span><span>Price at target <b>{probeResult.priceUsd === null ? 'not returned' : `$${probeResult.priceUsd}`}</b></span><span>Historical liquidity HTTP <b>{probeResult.liquidityHttpStatus ?? '—'}</b></span><span>Current liquidity fallback <b>{probeResult.currentLiquidityUsd === null ? `not returned (${probeResult.currentLiquidityHttpStatus ?? '—'})` : `$${probeResult.currentLiquidityUsd}`}</b></span></div><small>{probeResult.error ? `${probeResult.error} · ` : ''}{probeResult.liquidityMessage ? `${probeResult.liquidityMessage} · ` : ''}Complete raw response archived{probeResult.archivePath ? ` · ${probeResult.archivePath}` : ''}</small></div>}
    </section>

    <div className="reference-divider"><span>3 · Reference &amp; diagnostics</span><small>Everything below is read-only — nothing here requires action</small></div>

    <section id="evidence" className="menu-section panel archives-panel">
      <div className="panel-heading">
        <div><p className="eyebrow">GMGN ARCHIVE EVIDENCE</p><h2>Capture archives on disk</h2></div>
        <button className="secondary" disabled={loadingArchives} onClick={() => void loadArchives()}>{loadingArchives ? 'Loading…' : 'Load archives'}</button>
      </div>
      <p>Every one-off capture is archived locally as a ZIP. This re-verifies each file's SHA-256 and structure from disk and shows only the safe manifest — never the API key or raw captured events.</p>
      {archives === null
        ? <p className="muted">Not loaded yet.</p>
        : archives.length === 0
          ? <p className="muted">No GMGN capture archives found.</p>
          : <div className="table-wrap"><table><thead><tr><th>Captured</th><th>Events</th><th>Size</th><th>SHA-256</th><th>Status</th></tr></thead><tbody>
              {archives.map((archive) => <Fragment key={archive.fileName}>
                <tr className="archive-row" onClick={() => setExpandedArchive((current) => (current === archive.fileName ? null : archive.fileName))}>
                  <td><strong>{formatTime(archive.manifest?.capturedAt ?? null)}</strong><small>{archive.fileName}</small></td>
                  <td>{archive.manifest?.eventCount ?? '—'}<small>{archive.manifest ? `${archive.manifest.stored ?? 0} stored · ${archive.manifest.repeated ?? 0} repeated · ${archive.manifest.validationErrors ?? 0} issues` : ''}</small></td>
                  <td>{(archive.archiveBytes / 1024).toFixed(1)} KB</td>
                  <td><small>{archive.archiveSha256.slice(0, 16)}…</small></td>
                  <td>{archive.verified ? <span className="archived">Verified</span> : <span className="log-error">Failed</span>}</td>
                </tr>
                {expandedArchive === archive.fileName && <tr className="archive-detail-row"><td colSpan={5}>
                  <div className="archive-detail">
                    <div><span>Full SHA-256</span><strong>{archive.archiveSha256}</strong></div>
                    <div><span>Filename hash matches content</span><strong className={archive.hashVerified ? 'log-info' : 'log-error'}>{archive.hashVerified ? 'Yes' : 'No'}</strong></div>
                    <div><span>ZIP structure valid</span><strong className={archive.structureVerified ? 'log-info' : 'log-error'}>{archive.structureVerified ? 'Yes' : 'No'}</strong></div>
                    <div><span>Manifest event count matches archived response</span><strong className={archive.eventCountVerified === false ? 'log-error' : 'log-info'}>{archive.eventCountVerified === null ? 'Not checked' : archive.eventCountVerified ? 'Yes' : 'No'}</strong></div>
                    <div><span>Entries</span><strong>{archive.entryNames.join(', ') || '—'}</strong></div>
                    <div><span>Modified</span><strong>{formatTime(archive.modifiedAt)}</strong></div>
                    {archive.verificationError && <div><span>Verification error</span><strong className="log-error">{archive.verificationError}</strong></div>}
                  </div>
                </td></tr>}
              </Fragment>)}
            </tbody></table></div>}
    </section>

    <section className="menu-section quality-panel panel">
      <div className="panel-heading"><div><p className="eyebrow">DATA QUALITY · V1.1 LINKAGE</p><h2>Cohort ↔ GMGN coverage</h2></div><span className="tag">ADDRESS JOIN</span></div>
      <p>Signals are matched to the imported cohort by exact <code>token_address</code>. Unmatched observations stay preserved for later review.</p>
      <div className="quality-grid">
        <div className="quality-metric"><strong>{quality.coveragePercent}%</strong><span>signals matched to cohort</span><small>{quality.matchedSignalCount} of {quality.signalCount}</small></div>
        <div className="quality-metric"><strong>{quality.tokensWithSignals}</strong><span>cohort tokens with signals</span><small>{quality.tokensWithoutSignals} without signals</small></div>
        <div className="quality-metric"><strong>{quality.unmatchedSignalCount}</strong><span>signals outside cohort</span><small>kept, not discarded</small></div>
        <div className="quality-metric"><strong>{quality.signalsWithValidationIssues}</strong><span>signals with issues</span><small>{quality.missingTokenAddressSignals} missing address · {quality.missingObservedAtSignals} missing time</small></div>
      </div>
    </section>

    <section className="menu-section lower-grid">
      <article className="panel"><div className="panel-heading"><div><p className="eyebrow">ACTIVITY</p><h2>Recent imports</h2></div></div>
        {imports.length === 0 ? <p className="muted">No Dune exports processed yet.</p> : <div className="table-wrap"><table><thead><tr><th>Source</th><th>Rows</th><th>Archive</th></tr></thead><tbody>{imports.map((item) => <tr key={item.id ?? item.batchId}><td><strong>{item.sourcePath.split(/[\\/]/).pop()}</strong><small>{item.status ?? 'completed'}</small></td><td><span className="count-good">+{item.imported}</span> / {item.skipped} skipped / {item.errors} errors</td><td>{item.archivePath ? <span className="archived">ZIP archived</span> : '—'}</td></tr>)}</tbody></table></div>}
      </article>
      <article className="panel"><div className="panel-heading"><div><p className="eyebrow">SIGNAL MIX</p><h2>By signal type</h2></div></div>
        {stats.signalsByType.length === 0 ? <p className="muted">No signal types captured yet.</p> : <div className="bars">{stats.signalsByType.map((item) => <div className="bar-row" key={item.signalType}><span>{item.signalType}</span><b style={{ width: `${Math.max(8, item.count / Math.max(...stats.signalsByType.map((entry) => entry.count)) * 100)}%` }}>{item.count}</b></div>)}</div>}
      </article>
    </section>

    <section id="diagnostics" className="menu-section panel diagnostics-panel">
      <div className="panel-heading">
        <div><p className="eyebrow">DIAGNOSTICS</p><h2>Recent request activity</h2></div>
        <button className="secondary" disabled={loadingLogs} onClick={() => void loadLogs()}>{loadingLogs ? 'Loading…' : 'Load recent activity'}</button>
      </div>
      <p>Every non-GET request, every error, and any connection dropped before a response was sent is recorded here for troubleshooting.</p>
      {logs === null
        ? <p className="muted">Not loaded yet.</p>
        : logs.length === 0
          ? <p className="muted">No diagnostic events recorded yet.</p>
          : <div className="table-wrap"><table><thead><tr><th>Time</th><th>Event</th><th>Request</th><th>Result</th></tr></thead><tbody>
              {logs.map((log) => <tr key={log.id}>
                <td><small>{formatTime(log.createdAt)}</small></td>
                <td><strong className={`log-${log.level}`}>{log.event}</strong>{log.message ? <small>{log.message}</small> : null}</td>
                <td><small>{log.method ?? '—'} {log.path ?? ''}</small></td>
                <td><small>{log.status ?? '—'}{log.durationMs !== null ? ` · ${log.durationMs}ms` : ''}{log.requestBytes ? ` · ${(log.requestBytes / 1024).toFixed(1)}KB` : ''}</small></td>
              </tr>)}
            </tbody></table></div>}
    </section>

    <footer><span>{message}</span><button className="quiet" onClick={() => void refresh()}>Refresh</button><span>V1 capture only · no scoring or returns</span></footer>
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
