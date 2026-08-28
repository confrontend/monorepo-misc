import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/platform/db/client.js';
import { syncCopyTradeRoster } from '../src/copytrade/screening/roster.js';
import {
  computeLiveEvaluation,
  parseLiveEvaluationRequest,
  isSolWalletAddress,
} from '../src/copytrade/liveEvaluation.js';
import {
  computeEvaluationTrend,
  readEvaluationHistory,
  recordEvaluationHistory,
  shouldRecordEvaluationHistory,
} from '../src/copytrade/liveEvaluationHistory.js';
import {
  patternDiscoveryCacheKey,
  readPatternDiscoveryDataFingerprint,
  writePatternDiscoveryCache,
} from '../src/copytrade/discovery/patternDiscovery.js';

const VALID_ADDRESS = '11111111111111111111111111111111111111111';
const OTHER_ADDRESS = '22222222222222222222222222222222222222222';

const setup = (): DatabaseSync => openDatabase(':memory:');

const insertTrade = (
  database: DatabaseSync,
  options: {
    id: number;
    wallet: string;
    txHash: string;
    eventType: 'buy' | 'sell';
    tokenAddress: string;
    timestamp: number;
    costUsd?: string | null;
    buyCostUsd?: string | null;
    chain?: string;
  },
): void => {
  database
    .prepare(
      `INSERT INTO copytrade_trades
         (id, wallet_address, chain, tx_hash, event_type, token_address, token_symbol, observed_timestamp,
          token_amount, cost_usd, buy_cost_usd, price_usd, gas_usd, dex_usd, launchpad_platform, raw_payload, fetched_at, dedup_key)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, '{}', ?, ?)`,
    )
    .run(
      options.id,
      options.wallet,
      options.chain ?? 'sol',
      options.txHash,
      options.eventType,
      options.tokenAddress,
      options.timestamp,
      options.costUsd ?? null,
      options.buyCostUsd ?? null,
      '2026-08-25T00:00:00.000Z',
      `dedup-${options.id}`,
    );
};

/** Seeds `count` completed, profitable round trips for one wallet, spaced `holdSeconds` apart,
 *  each returning `returnPercent`. Enough (>= RULES.minTrades) to clear the minimum-evidence gate. */
// Shared across every seedRoundTrips call in the whole file (not reset per test) so two wallets
// seeded into the same in-memory database never collide on copytrade_trades' INTEGER PRIMARY KEY.
let nextTradeId = 1;

const seedRoundTrips = (
  database: DatabaseSync,
  wallet: string,
  options: { count: number; startTimestamp: number; holdSeconds: number; returnPercent: number; chain?: string },
): void => {
  const buyCostUsd = 100;
  const sellCostUsd = buyCostUsd * (1 + options.returnPercent / 100);
  let timestamp = options.startTimestamp;
  for (let index = 0; index < options.count; index += 1) {
    const token = `TOKEN_${index}`;
    insertTrade(database, {
      id: nextTradeId++,
      wallet,
      txHash: `buy-${index}`,
      eventType: 'buy',
      tokenAddress: token,
      timestamp,
      chain: options.chain,
    });
    timestamp += options.holdSeconds;
    insertTrade(database, {
      id: nextTradeId++,
      wallet,
      txHash: `sell-${index}`,
      eventType: 'sell',
      tokenAddress: token,
      timestamp,
      costUsd: String(sellCostUsd),
      buyCostUsd: String(buyCostUsd),
      chain: options.chain,
    });
    timestamp += 3600; // an hour between round trips, well within the 30-day window
  }
};

const seedGmgnStats = (
  database: DatabaseSync,
  wallet: string,
  options: {
    buyCount: number;
    sellCount: number;
    boughtCost?: number;
    soldIncome?: number;
    realizedProfit?: number;
    winRate?: number;
    fetchedAt?: string;
    chain?: string;
  },
): void => {
  const payload = {
    buy: options.buyCount,
    sell: options.sellCount,
    bought_cost: options.boughtCost ?? options.buyCount * 100,
    sold_income: options.soldIncome ?? options.sellCount * 110,
    bought_fee: 0,
    sold_fee: 0,
    total_cost: (options.boughtCost ?? options.buyCount * 100) + 0,
    realized_profit: options.realizedProfit ?? 1000,
    realized_profit_pnl: 0.1,
    native_balance: 1,
    last_timestamp: Math.floor(Date.now() / 1000),
    pnl_stat: { winrate: options.winRate ?? 0.5, token_num: options.buyCount, avg_holding_period: 120 },
  };
  database
    .prepare(
      `INSERT INTO copytrade_wallet_stats (wallet_address, chain, period, fetched_at, raw_payload)
       VALUES (?, ?, '30d', ?, ?)`,
    )
    .run(wallet, options.chain ?? 'sol', options.fetchedAt ?? '2026-08-25T00:00:00.000Z', JSON.stringify(payload));
};

/** Seeds both cache entries a promoted pattern needs to actually take effect: the 'sensitivity'
 *  blob `readPromotedProfile`/`applyPromotedGmgnRules` read, and the per-threshold 'report'
 *  entries `readExperimentalDecisionWeighting` separately reads to decide category weights.
 *  Without the 'report' entries, weighting stays 'neutral-fallback' and no promoted pattern --
 *  however well-formed -- can ever produce a validated-patterns estimatedOverallScore. */
const seedPromotedPatterns = (
  database: DatabaseSync,
  patterns: Array<{ pattern: Record<string, unknown>; supportingCoveragePercent: number[] }>,
): void => {
  const fingerprint = readPatternDiscoveryDataFingerprint(database);
  writePatternDiscoveryCache(
    database,
    patternDiscoveryCacheKey('sensitivity', 30, 50, 10, 500),
    fingerprint,
    { crossCoveragePromotedPatterns: patterns },
  );
  const reportPatterns = patterns.map(({ pattern }) => pattern);
  for (const threshold of [90, 95]) {
    writePatternDiscoveryCache(
      database,
      patternDiscoveryCacheKey('report', 30, threshold, 10, 500),
      fingerprint,
      { patterns: reportPatterns, dataset_summary: { wallets: 10 } },
    );
  }
};

const NOW = new Date('2026-08-25T12:00:00.000Z');
const THIRTY_DAYS_AGO = Math.floor(NOW.getTime() / 1000) - 10 * 86_400;

test('1. a valid, evidenced wallet returns an estimated score', () => {
  const database = setup();
  try {
    seedRoundTrips(database, VALID_ADDRESS, {
      count: 120,
      startTimestamp: THIRTY_DAYS_AGO,
      holdSeconds: 300,
      returnPercent: 10,
    });
    seedGmgnStats(database, VALID_ADDRESS, { buyCount: 120, sellCount: 120 });
    seedPromotedPatterns(database, [
      {
        pattern: {
          feature: 'prior_wallet_median_return_percent',
          effect: 5,
          validationStatus: 'validation survivor',
          historical_stability: { status: 'stable' },
          conditions: [{ feature: 'prior_wallet_median_return_percent', operator: 'correlation', value: 'positive' }],
        },
        supportingCoveragePercent: [90, 95],
      },
    ]);
    const result = computeLiveEvaluation(database, VALID_ADDRESS, { now: NOW });
    assert.notEqual(result.estimatedOverallScore, null);
    assert.equal(result.walletAddress, VALID_ADDRESS);
    assert.equal(result.disclaimer, 'GMGN-only estimate — no delayed-copy/Dune validation.');
  } finally {
    database.close();
  }
});

test('2. computing a Live Evaluation never touches Dune-path source', () => {
  const source = fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'src',
      'copytrade',
      'liveEvaluation.ts',
    ),
    'utf8',
  );
  assert.doesNotMatch(source, /from ['"].*\/dune\//);
  assert.doesNotMatch(source, /from ['"].*liveEvaluationComparison/);
});

test('3. a wallet already scored by Decision Lab is evaluated independently of Dune tables', () => {
  const database = setup();
  try {
    seedRoundTrips(database, VALID_ADDRESS, {
      count: 120,
      startTimestamp: THIRTY_DAYS_AGO,
      holdSeconds: 300,
      returnPercent: 8,
    });
    seedGmgnStats(database, VALID_ADDRESS, { buyCount: 120, sellCount: 120 });
    const withoutDune = computeLiveEvaluation(database, VALID_ADDRESS, { now: NOW });

    // Now add roster + Dune-side evidence for the same wallet and confirm the Live Evaluation
    // result for that wallet is unaffected.
    database
      .prepare(
        `INSERT INTO gmgn_wallet_rank_snapshots (window, orderby, captured_at, raw_payload, source_sha256)
         VALUES ('7d', 'pnl_30d', ?, ?, 'test-sha')`,
      )
      .run(
        '2026-08-25T00:00:00.000Z',
        JSON.stringify({
          code: 0,
          data: { rank: [{ wallet_address: VALID_ADDRESS, name: 'Test Wallet', pnl_30d: '5', winrate_30d: 0.5 }] },
        }),
      );
    syncCopyTradeRoster(database);

    const withDune = computeLiveEvaluation(database, VALID_ADDRESS, { now: NOW });
    // gmgnTags legitimately changes from null (no roster row) to [] (a roster row now exists,
    // defaulting to an empty tag list) -- that's an expected side effect of joining the roster,
    // not something Live Evaluation's own scoring should be sensitive to either way. Excluded
    // from the comparison; everything else (scores, verdict, rules, stats) must be identical.
    const normalize = (result: typeof withoutDune) => ({
      ...result,
      generatedAt: null,
      gmgnStatsUsed: { ...result.gmgnStatsUsed, gmgnTags: null },
    });
    assert.deepEqual(normalize(withoutDune), normalize(withDune));
  } finally {
    database.close();
  }
});

test('4. evaluation history compares a current live evaluation with the immediately older source', () => {
  const database = setup();
  try {
    const previous = recordEvaluationHistory(database, {
      walletAddress: VALID_ADDRESS,
      chain: 'sol',
      source: 'decision_lab',
      generatedAt: '2026-08-24T00:00:00.000Z',
      score: 60,
      verdict: 'pass',
      evidenceLevel: 'complete',
      componentScores: { historicalProfitability: 60, consistency: 60, robustness: 60, copyability: 60 },
    });
    const current = recordEvaluationHistory(database, {
      walletAddress: VALID_ADDRESS,
      chain: 'sol',
      source: 'live',
      generatedAt: '2026-08-25T00:00:00.000Z',
      score: 72.5,
      verdict: 'pass',
      evidenceLevel: 'complete',
      componentScores: { historicalProfitability: 70, consistency: 75, robustness: 72, copyability: 73 },
    });
    const trend = computeEvaluationTrend(current, previous);
    assert.equal(trend.available, true);
    if (trend.available) {
      assert.equal(trend.scoreDelta, 12.5);
      assert.equal(trend.direction, 'better');
      assert.equal(trend.previousSource, 'decision_lab');
    }
    assert.deepEqual(readEvaluationHistory(database, VALID_ADDRESS).map((entry) => entry.id), [current.id, previous.id]);
  } finally {
    database.close();
  }
});

test('4b. first history entry has no trend, and live-to-live history compares by score', () => {
  const database = setup();
  try {
    const first = recordEvaluationHistory(database, {
      walletAddress: OTHER_ADDRESS, chain: 'sol', source: 'live', generatedAt: NOW.toISOString(), score: null,
      verdict: 'insufficient_evidence', evidenceLevel: 'partial',
      componentScores: { historicalProfitability: null, consistency: null, robustness: null, copyability: null },
    });
    assert.deepEqual(computeEvaluationTrend(first, null), { available: false });
    const second = recordEvaluationHistory(database, {
      walletAddress: OTHER_ADDRESS, chain: 'sol', source: 'live', generatedAt: NOW.toISOString(), score: 40,
      verdict: 'reject', evidenceLevel: 'complete',
      componentScores: { historicalProfitability: 40, consistency: 40, robustness: 40, copyability: 40 },
    });
    const trend = computeEvaluationTrend(second, first);
    assert.equal(trend.available, true);
    if (trend.available) assert.equal(trend.direction, 'unknown');
  } finally {
    database.close();
  }
});

test('4c. scoreless evaluations are not persisted as comparable history', () => {
  assert.equal(shouldRecordEvaluationHistory({ score: null, evidenceLevel: 'partial' }), false);
  assert.equal(shouldRecordEvaluationHistory({ score: null, evidenceLevel: 'missing' }), false);
  assert.equal(shouldRecordEvaluationHistory({ score: 80, evidenceLevel: 'complete' }), true);
  assert.equal(shouldRecordEvaluationHistory({ score: 80, evidenceLevel: 'partial' }), true);
});

test('4d. invalid history limits fall back safely', () => {
  const database = setup();
  try {
    assert.doesNotThrow(() => readEvaluationHistory(database, VALID_ADDRESS, { limit: Number.NaN }));
  } finally {
    database.close();
  }
});

test('5. a promoted hyperactivity rule reduces the copyability estimate for a high-activity wallet', () => {
  const database = setup();
  seedPromotedPatterns(database, [
    {
      pattern: {
        feature: 'prior_wallet_trade_count',
        effect: -8.4,
        validationStatus: 'validation survivor',
        historical_stability: { status: 'stable' },
        conditions: [{ feature: 'prior_wallet_trade_count', operator: '>=', value: 580 }],
      },
      supportingCoveragePercent: [90, 95],
    },
  ]);
  try {
    seedRoundTrips(database, VALID_ADDRESS, {
      count: 300,
      startTimestamp: THIRTY_DAYS_AGO,
      holdSeconds: 300,
      returnPercent: 5,
    });
    // buyCount + sellCount = 600 >= 580 threshold
    seedGmgnStats(database, VALID_ADDRESS, { buyCount: 300, sellCount: 300 });
    const highActivity = computeLiveEvaluation(database, VALID_ADDRESS, { now: NOW });

    seedRoundTrips(database, OTHER_ADDRESS, {
      count: 120,
      startTimestamp: THIRTY_DAYS_AGO,
      holdSeconds: 300,
      returnPercent: 5,
    });
    // buyCount + sellCount = 240 < 580 threshold
    seedGmgnStats(database, OTHER_ADDRESS, { buyCount: 120, sellCount: 120 });
    const lowActivity = computeLiveEvaluation(database, OTHER_ADDRESS, { now: NOW });

    assert.ok(highActivity.rulesApplied.some((rule) => rule.feature === '[hyperactivity]'));
    assert.ok(!lowActivity.rulesApplied.some((rule) => rule.feature === '[hyperactivity]'));
    assert.ok((highActivity.componentScores.copyability ?? 100) < (lowActivity.componentScores.copyability ?? 0));
  } finally {
    database.close();
  }
});

test('6. a promoted fast-trading rule reduces the copyability estimate for a fast-trading wallet', () => {
  const database = setup();
  seedPromotedPatterns(database, [
    {
      pattern: {
        feature: 'prior_wallet_under_15_seconds_percent',
        effect: -0.5,
        validationStatus: 'validation survivor',
        historical_stability: { status: 'stable' },
        conditions: [
          { feature: 'prior_wallet_under_15_seconds_percent', operator: 'correlation', value: 'negative' },
        ],
      },
      supportingCoveragePercent: [90, 95],
    },
  ]);
  try {
    seedRoundTrips(database, VALID_ADDRESS, {
      count: 120,
      startTimestamp: THIRTY_DAYS_AGO,
      holdSeconds: 5, // held for 5 seconds -- well under the 15-second fast-trading threshold
      returnPercent: 5,
    });
    seedGmgnStats(database, VALID_ADDRESS, { buyCount: 120, sellCount: 120 });
    const fastTrading = computeLiveEvaluation(database, VALID_ADDRESS, { now: NOW });

    seedRoundTrips(database, OTHER_ADDRESS, {
      count: 120,
      startTimestamp: THIRTY_DAYS_AGO,
      holdSeconds: 3600, // held for an hour -- normal hold time
      returnPercent: 5,
    });
    seedGmgnStats(database, OTHER_ADDRESS, { buyCount: 120, sellCount: 120 });
    const normalTrading = computeLiveEvaluation(database, OTHER_ADDRESS, { now: NOW });

    assert.ok(fastTrading.rulesApplied.some((rule) => rule.feature.includes('under_15_seconds')));
    assert.ok(!normalTrading.rulesApplied.some((rule) => rule.feature.includes('under_15_seconds')));
    assert.ok((fastTrading.componentScores.copyability ?? 100) < (normalTrading.componentScores.copyability ?? 0));
  } finally {
    database.close();
  }
});

test('7. a missing Pattern Discovery profile is reported explicitly, never fabricated', () => {
  const database = setup();
  try {
    seedRoundTrips(database, VALID_ADDRESS, {
      count: 120,
      startTimestamp: THIRTY_DAYS_AGO,
      holdSeconds: 300,
      returnPercent: 5,
    });
    seedGmgnStats(database, VALID_ADDRESS, { buyCount: 120, sellCount: 120 });
    // No sensitivity cache seeded at all.
    const result = computeLiveEvaluation(database, VALID_ADDRESS, { now: NOW });
    assert.equal(result.profileLoadStatus.status, 'unavailable');
    assert.equal(result.weighting.mode, 'unavailable');
    assert.equal(result.estimatedOverallScore, null);
  } finally {
    database.close();
  }
});

test('8. a promoted rule with an unmodeled feature/condition is skipped, not fabricated', () => {
  const database = setup();
  seedPromotedPatterns(database, [
    {
      // prior_token_* has no standing-wallet equivalent.
      pattern: {
        feature: 'prior_token_buy_count',
        effect: 3,
        validationStatus: 'validation survivor',
        historical_stability: { status: 'stable' },
        conditions: [{ feature: 'prior_token_buy_count', operator: '>=', value: 5 }],
      },
      supportingCoveragePercent: [90, 95],
    },
    {
      // bucket/lower-upper condition shape has no established scoring convention.
      pattern: {
        feature: 'prior_wallet_median_return_percent',
        effect: 2,
        validationStatus: 'validation survivor',
        historical_stability: { status: 'stable' },
        conditions: [{ feature: 'prior_wallet_median_return_percent', lower: 0, upper: 10 }],
      },
      supportingCoveragePercent: [90, 95],
    },
  ]);
  try {
    seedRoundTrips(database, VALID_ADDRESS, {
      count: 120,
      startTimestamp: THIRTY_DAYS_AGO,
      holdSeconds: 300,
      returnPercent: 5,
    });
    seedGmgnStats(database, VALID_ADDRESS, { buyCount: 120, sellCount: 120 });
    const result = computeLiveEvaluation(database, VALID_ADDRESS, { now: NOW });
    assert.ok(!result.rulesApplied.some((rule) => rule.feature === 'prior_token_buy_count'));
    assert.ok(!result.rulesApplied.some((rule) => rule.feature === 'prior_wallet_median_return_percent'));
    assert.ok(result.rulesUnavailable.some((rule) => rule.feature === 'prior_token_buy_count'));
    assert.ok(
      result.rulesUnavailable.some(
        (rule) => rule.feature === 'prior_wallet_median_return_percent' && rule.reason === 'condition-shape-not-modeled',
      ),
    );
  } finally {
    database.close();
  }
});

test('9. an invalid wallet address returns a clear error before any fetch/compute work', () => {
  assert.equal(isSolWalletAddress('not-a-real-address'), false);
  const tooShort = parseLiveEvaluationRequest({ walletAddress: 'short' });
  assert.equal(tooShort.ok, false);
  const missing = parseLiveEvaluationRequest({});
  assert.equal(missing.ok, false);
  const valid = parseLiveEvaluationRequest({ walletAddress: VALID_ADDRESS });
  assert.equal(valid.ok, true);
  if (valid.ok) assert.equal(valid.walletAddress, VALID_ADDRESS);
});

test('10. results are deterministic for the same saved GMGN evidence and profile', () => {
  const database = setup();
  try {
    seedRoundTrips(database, VALID_ADDRESS, {
      count: 120,
      startTimestamp: THIRTY_DAYS_AGO,
      holdSeconds: 300,
      returnPercent: 7,
    });
    seedGmgnStats(database, VALID_ADDRESS, { buyCount: 120, sellCount: 120 });
    seedPromotedPatterns(database, [
      {
        pattern: {
          feature: 'prior_wallet_median_return_percent',
          effect: 4,
          validationStatus: 'validation survivor',
          historical_stability: { status: 'stable' },
          conditions: [{ feature: 'prior_wallet_median_return_percent', operator: 'correlation', value: 'positive' }],
        },
        supportingCoveragePercent: [90, 95],
      },
    ]);
    const first = computeLiveEvaluation(database, VALID_ADDRESS, { now: NOW });
    const second = computeLiveEvaluation(database, VALID_ADDRESS, { now: NOW });
    assert.deepEqual(first, second);
  } finally {
    database.close();
  }
});
