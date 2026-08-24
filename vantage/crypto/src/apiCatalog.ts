export type ApiDoc = {
  method: 'GET' | 'POST';
  path: string;
  summary: string;
  explanation: string;
  parameters?: string[];
  exampleResponse: unknown;
};

const route = (
  method: ApiDoc['method'], path: string, summary: string, explanation: string,
  exampleResponse: unknown, parameters?: string[],
): ApiDoc => ({ method, path, summary, explanation, exampleResponse, ...(parameters ? { parameters } : {}) });

export const API_CATALOG: ApiDoc[] = [
  route('GET', '/api/stats', 'Project totals', 'Returns stored database counts for a quick health check.', { tokenCount: 0, signalCount: 0, tradeCount: 0 }),
  route('GET', '/api/quality', 'Data quality', 'Summarizes missing, malformed, and incomplete source data.', { status: 'ok', checks: [] }),
  route('GET', '/api/integrity', 'Integrity checks', 'Reports consistency problems found in the local database.', { status: 'ok', issues: [] }),
  route('GET', '/api/copytrade/summary', 'CopyTrade summary', 'Returns the latest saved copy-trading overview. It reads SQLite only.', { traders: 0, trades: 0, historyDays: 30 }),
  route('GET', '/api/copytrade/rosters', 'Roster snapshots', 'Lists saved GMGN leaderboard snapshots and the selected snapshot.', { selectedByDefault: null, snapshots: [] }),
  route('GET', '/api/copytrade/roster/compare', 'Compare rosters', 'Shows which wallets joined or left between two saved leaderboard snapshots.', { joined: [], left: [], baselineAvailable: false }, ['snapshotId']),
  route('GET', '/api/copytrade/stats', 'Saved GMGN wallet stats', 'Reads stored GMGN 30-day wallet statistics. It does not call GMGN.', { stats: [], status: 'idle' }, ['snapshotId', 'limit']),
  route('GET', '/api/copytrade/stats/status', 'GMGN stats progress', 'Reports the current GMGN statistics fetch state and wallet progress.', { running: false, status: 'idle', walletDone: 0, walletTotal: 0 }),
  route('GET', '/api/copytrade/results', 'CopyTrade results', 'Returns saved wallet results used by the research tables.', { rows: [], computedAt: null }),
  route('GET', '/api/copytrade/trades/{wallet}', 'Wallet trade history', 'Reads stored GMGN trades for one wallet. No provider request is made.', { walletAddress: '…', total: 0, rows: [] }, ['wallet']),
  route('POST', '/api/copytrade/trades/bulk', 'Bulk wallet trade history', 'Reads stored GMGN trades for many wallets in one database request. It never calls GMGN or Dune.', { histories: [{ walletAddress: '…', total: 0, rows: [], coverage: null }] }, ['walletAddresses']),
  route('GET', '/api/copytrade/copy-simulation', 'Delayed-copy simulation', 'Returns Dune-backed delayed-copy results for the requested period and wallets.', { wallets: [], assumptions: { copierDelaySeconds: 15 } }, ['periodDays', 'walletAddresses', 'snapshotId']),
  route('GET', '/api/copytrade/copy-simulation/status', 'Dune simulation progress', 'Reports Dune query batches, stored matches, failures, and remaining work.', { outcome: 'idle', targetsTotal: 0, targetsProcessed: 0, remainingTargets: 0 }),
  route('GET', '/api/copytrade/liquidity-impact', 'Trade-size liquidity proxy', 'Compares delayed-copy results across low, medium, and high entry trade-size bands. This is a proxy, not historical pool liquidity.', { measuredVsProxied: 'proxied', bands: [], byWallet: [] }, ['periodDays', 'snapshotId']),
  route('GET', '/api/copytrade/winners', 'Candidate wallets', 'Returns wallets that pass the current shared research gates.', { candidates: [], counts: {} }, ['limit', 'snapshotId']),
  route('GET', '/api/copytrade/elimination', 'Triage report', 'Explains which wallets can stop consuming Dune budget and why.', { eliminated: [], surviving: [], generatedAt: null }, ['limit', 'snapshotId']),
  route('GET', '/api/copytrade/scrutiny', 'Scrutiny checks', 'Runs the saved-evidence scrutiny checks for the selected wallets.', { reports: [], missingWallets: [] }, ['wallets', 'snapshotId']),
  route('GET', '/api/copytrade/experimental-decision', 'Experimental Decision Lab', 'Read-only exploratory score from saved 30-day GMGN and Dune evidence. It never calls a provider or changes production verdicts.', { generatedAt: '2026-08-23T00:00:00.000Z', readOnly: true, noProviderFetch: true, wallets: [] }, ['limit', 'snapshotId']),
  route('GET', '/api/copytrade/scrutiny/gmgn-risk', 'Saved GMGN risk details', 'Reads imported or previously saved 30-day GMGN risk details.', { results: [] }, ['wallets']),
  route('GET', '/api/copytrade/fetch/status', 'GMGN history progress', 'Reports complete-history fetch progress, resume state, and failures.', { running: false, status: 'idle', walletDone: 0, walletTotal: 0 }),
  route('GET', '/api/copytrade/fetch/estimate', 'GMGN fetch estimate', 'Estimates request count and duration from recent measured runs.', { walletCount: 0, estimatedRequests: 0, estimatedSeconds: 0 }, ['limit', 'periodDays']),
  route('GET', '/api/copytrade/capture-health', 'Capture health', 'Shows whether the latest roster capture has usable provenance and freshness.', { latestSnapshotId: null, latestSnapshotAt: null, latestProvenanceStatus: null }),
  route('GET', '/api/gmgn/status', 'GMGN connection status', 'Reports whether the local GMGN credential or browser capture is available.', { configured: false }),
  route('GET', '/api/gmgn/raw-endpoints/summary', 'Raw GMGN endpoint summary', 'Lists browser-captured GMGN endpoint observations without exposing credentials.', { endpoints: [] }),
  route('GET', '/api/logs', 'Diagnostic logs', 'Reads recent local diagnostic events for debugging fetches and imports.', { entries: [] }, ['limit']),
  route('GET', '/api/analysis/patterns', 'Pattern report', 'Returns saved pattern-discovery findings and their validation status.', { patterns: [], status_counts: {} }),
  route('GET', '/api/analysis/patterns/robust', 'Robust pattern report', 'Returns the saved holdout-aware pattern analysis.', { patterns: [], validation: {} }),
  route('GET', '/api/dune/measurement-plan', 'Dune measurement plan', 'Shows which captured signals are eligible for Dune measurement and why.', { measuredCount: 0, unmeasuredCount: 0, eligibleSignalIds: [] }),
  route('GET', '/api/dune/outcomes/latest', 'Latest Dune outcomes', 'Reads the latest stored Dune outcome measurements.', { outcomes: [] }),
  route('POST', '/api/copytrade/roster/refresh', 'Refresh GMGN roster', 'Fetches a fresh leaderboard snapshot from GMGN and stores it locally.', { snapshotId: 1, walletCount: 100 }),
  route('POST', '/api/copytrade/roster/sync', 'Sync saved roster', 'Synchronizes the selected saved roster into the local research scope.', { synced: true, walletCount: 100 }),
  route('POST', '/api/copytrade/roster/import', 'Import GMGN roster JSON', 'Stores a local GMGN leaderboard response or Chrome extension capture as a roster snapshot. It does not call GMGN.', { snapshotId: 1, walletCount: 100, live: false, roster: { total: 100 } }, ['name', 'content']),
  route('POST', '/api/copytrade/fetch', 'Fetch GMGN history', 'Starts or resumes the complete GMGN trade-history fetch for the selected roster.', { started: true, runId: 1 }),
  route('POST', '/api/copytrade/fetch/stop', 'Stop GMGN fetch', 'Requests a safe stop. Already stored trades remain available for resume.', { stopped: true }),
  route('POST', '/api/copytrade/fetch/resume', 'Resume GMGN fetch', 'Continues the saved GMGN fetch snapshot from its persisted cursor.', { resumed: true, runId: 1 }),
  route('POST', '/api/copytrade/fetch/reset', 'Reset GMGN fetch snapshot', 'Explicitly forgets the resumable GMGN fetch state. This is destructive to resume metadata.', { reset: true }),
  route('POST', '/api/copytrade/stats/fetch', 'Fetch GMGN summaries', 'Fetches and persists GMGN wallet statistics, reusing fresh saved responses where possible.', { started: true, walletTotal: 100 }),
  route('POST', '/api/copytrade/copy-simulation/run', 'Fetch Dune copy prices', 'Starts the Dune delayed-copy price fetch for missing eligible targets only.', { started: true, targets: 0 }),
  route('POST', '/api/copytrade/copy-simulation/stop', 'Stop Dune fetch', 'Requests a safe stop while retaining already stored Dune matches.', { stopped: true }),
  route('POST', '/api/copytrade/copy-simulation/wide-retry', 'Widen Dune search', 'Retries selected no-match trade legs with a wider time window.', { started: true, retryLegs: 0 }),
  route('POST', '/api/copytrade/scrutiny/gmgn-risk/import', 'Import GMGN risk JSON', 'Validates and persists a 30-day GMGN risk export produced by the browser extension.', { imported: 1, saved: 1 }),
  route('POST', '/api/copytrade/scrutiny/refresh-trades', 'Refresh Scrutiny trades', 'Fetches missing GMGN trade history for selected scrutiny wallets.', { wallets: [], started: true }),
  route('POST', '/api/copytrade/pattern-discovery/run/report', 'Run pattern discovery', 'Runs the shared pattern-discovery analysis over the saved normalized outcome export.', { report: { status_counts: {} } }),
  route('POST', '/api/dune/reconcile', 'Reconcile Dune runs', 'Checks saved Dune executions and updates runs that completed or failed externally.', { checked: 0, completed: 0, failed: 0 }),
];
