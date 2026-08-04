import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import type { AnalysisModule } from './server/analysisModule';
import { ensureRunForFingerprint, findExistingRun } from './server/db/runs';
import { getMethodologyVersion, invalidateMethodologyVersionCache } from './server/db/methodologyVersion';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const dataDirectories = [path.join(projectRoot, 'input'), path.join(projectRoot, 'benchmark')];
// The two files whose content determines "what gets computed and how it's stored" -- watched
// directly (rather than relying on buildFingerprint(), which only looks at input/benchmark) so
// that editing calculation or persistence logic invalidates the methodology identity even when no
// input JSON file changed. See methodologyVersion.ts, which hashes these same two files.
const methodologyWatchPaths = [path.join(projectRoot, 'src', 'data.ts'), path.join(projectRoot, 'server', 'db', 'runs.ts')];

const buildFingerprint = async () => {
  const entries: string[] = [];
  for (const directory of dataDirectories) {
    let names: string[] = [];
    try {
      names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
    } catch {
      // A missing benchmark directory is a valid empty-data state.
    }
    for (const name of names) {
      const filePath = path.join(directory, name);
      const metadata = await stat(filePath);
      entries.push(`${filePath}|${metadata.size}|${metadata.mtimeMs}`);
    }
  }
  return createHash('sha1').update(entries.join('\n')).digest('hex');
};

const sendJson = (response: import('node:http').ServerResponse, status: number, payload: unknown) => {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store, max-age=0');
  response.end(JSON.stringify(payload));
};

const compactTicker = (result: any) => ({
  ...result,
  detail: { ...result.detail, events: [], ratingDistribution: [] },
});

const analysisApiPlugin = (): Plugin => ({
  name: 'local-analysis-api',
  configureServer(server) {
    let activeFingerprint = '';
    let analysisModule: AnalysisModule | null = null;
    const resultCache = new Map<string, unknown>();
    let lastRunId: number | null = null;
    let persistenceInFlight = false;

    // A data.ts or runs.ts edit changes the methodology identity but never touches an input JSON
    // file, so buildFingerprint() alone would never notice it -- the module reload above and the
    // persisted run below would both keep serving/recording stale results indefinitely. Forcing
    // analysisModule to null makes the next request's `!analysisModule` check reload it regardless
    // of whether the fingerprint changed; invalidating the methodology cache makes that reload
    // resolve to the *current* on-disk hash rather than whatever was first computed this process.
    server.watcher.add(methodologyWatchPaths);
    server.watcher.on('change', (file) => {
      if (!methodologyWatchPaths.includes(file)) return;
      invalidateMethodologyVersionCache();
      analysisModule = null;
    });

    // Full-grid persistence (writeSnapshot in runs.ts) recomputes and writes every tab, which is
    // the expensive part of a fingerprint/methodology change -- measured at ~10s cold, see
    // progress.md. Running it synchronously inside loadAnalysis() blocked whichever request
    // happened to trigger the reload (and, being single-threaded, every other request that arrived
    // during it) for that whole duration. schedulePersistence() instead does a cheap existence
    // check up front, and only defers to the expensive write via setImmediate -- after the
    // triggering request's own response has already been sent -- when no run exists yet for this
    // exact (fingerprint, methodology) pair. This does not add real parallelism (Node is still one
    // thread, so a request arriving *during* that background write still waits its turn) -- it only
    // moves the cost off the triggering request. True concurrency would need worker_threads, which
    // is deliberately out of scope here.
    const schedulePersistence = (analysis: AnalysisModule, fingerprint: string) => {
      let methodologyVersion: string;
      try {
        methodologyVersion = getMethodologyVersion();
      } catch (error) {
        console.error('[analysis-db] failed to read methodology version:', error);
        return;
      }

      const existing = findExistingRun(fingerprint, methodologyVersion);
      if (existing) {
        lastRunId = existing.id;
        return;
      }
      if (persistenceInFlight) return;

      lastRunId = null;
      persistenceInFlight = true;
      setImmediate(() => {
        try {
          const run = ensureRunForFingerprint(analysis, fingerprint);
          lastRunId = run.id;
        } catch (error) {
          console.error('[analysis-db] failed to persist analysis run:', error);
        } finally {
          persistenceInFlight = false;
        }
      });
    };

    const loadAnalysis = async () => {
      const fingerprint = await buildFingerprint();
      if (!analysisModule || fingerprint !== activeFingerprint) {
        activeFingerprint = fingerprint;
        resultCache.clear();
        server.moduleGraph.invalidateAll();
        analysisModule = await server.ssrLoadModule(`/src/data.ts?dataset=${fingerprint}`) as AnalysisModule;

        // Write-through persistence: durably snapshot every tab's results for this exact
        // (fingerprint, methodology) pair into SQLite, alongside (not instead of) the existing
        // in-memory cache above, which keeps serving /api/analysis exactly as before. A DB problem
        // here is logged, not thrown -- persistence is a side effect, it should never take the
        // live app down.
        schedulePersistence(analysisModule, fingerprint);
      }
      return { analysis: analysisModule, fingerprint, runId: lastRunId };
    };

    const cached = async (key: string, factory: (analysis: AnalysisModule) => unknown) => {
      const { analysis, fingerprint } = await loadAnalysis();
      const cacheKey = `${fingerprint}|${key}`;
      if (!resultCache.has(cacheKey)) resultCache.set(cacheKey, factory(analysis));
      return { data: resultCache.get(cacheKey), fingerprint };
    };

    server.middlewares.use('/api/analysis', async (request, response) => {
      try {
        const url = new URL(request.url ?? '/', 'http://localhost');
        const action = url.searchParams.get('action') ?? 'meta';
        const window = url.searchParams.get('window') ?? '7d';
        const policy = url.searchParams.get('policy') ?? 'long-exit-hold';
        const ticker = (url.searchParams.get('ticker') ?? '').toUpperCase();

        if (action === 'meta') {
          const { analysis, fingerprint, runId } = await loadAnalysis();
          sendJson(response, 200, { fingerprint, runId, windows: analysis.getAvailableHistoryWindows(), tiers: analysis.getAvailableRatingTiers(), accuracyHorizons: analysis.getAvailableAccuracyHorizons() });
          return;
        }

        const horizon = Number.parseInt(url.searchParams.get('horizon') ?? '90', 10);

        const result = await cached(`${action}|${window}|${policy}|${ticker}|${horizon}`, (analysis) => {
          if (action === 'tickerRows') return analysis.buildTickerResults(window, policy).map(compactTicker);
          if (action === 'tickerDetail') return analysis.buildTickerResults(window, policy).find((row) => row.ticker === ticker) ?? null;
          if (action === 'tickerMatrix') {
            return analysis.getAvailableHistoryWindows().flatMap((historyWindow) =>
              (['long-exit-hold', 'long-hold-through', 'long-short'] as const).map((signalPolicy) => {
                const row = analysis.buildTickerResults(historyWindow, signalPolicy).find((candidate) => candidate.ticker === ticker);
                return row ? { window: historyWindow, policy: signalPolicy, result: compactTicker(row) } : null;
              }).filter(Boolean));
          }
          if (action === 'aggregate') return analysis.buildAggregateResults(analysis.getAvailableHistoryWindows(), ['long-exit-hold', 'long-hold-through', 'long-short']);
          if (action === 'strongBuy') return analysis.buildStrongBuyTrustResults().map(({ trades: _trades, ...summary }) => summary);
          if (action === 'strongBuyTrades') return analysis.buildStrongBuyTrustResults().find((row) => row.ticker === ticker) ?? null;
          if (action === 'tiers') {
            const tierWindows = analysis.getAvailableHistoryWindows().filter((candidate) => candidate === '7d' || candidate === 'all' || Number.parseInt(candidate, 10) <= 24);
            return {
              cohortRows: analysis.buildCohortResults(tierWindows),
              cohortTiers: [...analysis.getAvailableRatingTiers(), 'Market'],
              tickerRows: analysis.buildTickerCohortResults(tierWindows),
              winRates: analysis.buildTierWinRates(),
              correlation: analysis.buildScoreCorrelation(),
              windows: tierWindows,
            };
          }
          if (action === 'accuracy') {
            return {
              tickerAccuracy: analysis.buildTickerAccuracy(horizon),
              ratingCalls: analysis.buildRatingCallSummary(horizon),
            };
          }
          throw new Error(`Unknown analysis action: ${action}`);
        });
        sendJson(response, 200, result);
      } catch (error) {
        server.ssrFixStacktrace(error as Error);
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    });
  },
});

export default defineConfig({
  plugins: [react(), analysisApiPlugin()],
  server: {
    watch: {
      usePolling: true,
      interval: 250,
    },
  },
});
