import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import {
  readCurrentWalletFeatures,
  readPatternDiscoveryExportGrid,
  readPreEventFeatures,
} from '../src/copytrade/discovery/patternDiscovery.js';
import { DEFAULT_COPIER_DELAY_SECONDS } from '../src/copytrade/simulation/copySimulation.js';
import {
  readCurrentWalletFeaturesBatch,
  readWalletFeatureSnapshotsBatch,
} from '../src/copytrade/features/walletFeatureReader.js';
import { WalletFeatureAccumulator } from '../src/copytrade/features/walletFeatureEngine.js';
import {
  computeProfitConcentration,
  holdSecondsPerSell,
  performanceByPeriod,
  summarizeTrades,
} from '../src/copytrade/scrutiny/evaluate.js';
import { openDatabase } from '../src/platform/db/client.js';
import { applyMigrations } from '../src/platform/db/schema.js';

const setup = (): DatabaseSync => {
  const database = openDatabase(':memory:');
  applyMigrations(database);
  return database;
};

type TradeInput = {
  id: number;
  walletAddress: string;
  eventType: 'buy' | 'sell';
  tokenAddress: string;
  observedTimestamp: number;
  costUsd: number | null;
  buyCostUsd?: number | null;
  priceUsd?: number | null;
  tokenAmount?: number | null;
  launchpadPlatform?: string | null;
};

const insertTrade = (database: DatabaseSync, input: TradeInput): void => {
  database
    .prepare(
      `INSERT INTO copytrade_trades
       (id, wallet_address, chain, tx_hash, event_type, token_address, token_symbol,
        observed_timestamp, token_amount, cost_usd, buy_cost_usd, price_usd, gas_usd,
        dex_usd, launchpad_platform, raw_payload, fetched_at, dedup_key)
       VALUES (?, ?, 'sol', ?, ?, ?, 'TKN', ?, ?, ?, ?, ?, '0.01', '0.02', ?, '{}', 'now', ?)`,
    )
    .run(
      input.id,
      input.walletAddress,
      `TX_${input.id}`,
      input.eventType,
      input.tokenAddress,
      input.observedTimestamp,
      input.tokenAmount === undefined
        ? '100'
        : input.tokenAmount === null
          ? null
          : String(input.tokenAmount),
      input.costUsd === null ? null : String(input.costUsd),
      input.buyCostUsd === undefined || input.buyCostUsd === null ? null : String(input.buyCostUsd),
      input.priceUsd === undefined || input.priceUsd === null ? null : String(input.priceUsd),
      input.launchpadPlatform ?? null,
      `DEDUP_${input.id}`,
    );
};

const seedDuneMatch = (
  database: DatabaseSync,
  tradeId: number,
  matchedTradeAt: number,
  priceUsd: number,
): void => {
  database
    .prepare(
      `INSERT INTO copytrade_copy_simulation_runs
       (trade_refs, query_sql, status, requested_at, completed_at, raw_result)
       VALUES (?, 'SELECT 1', 'completed', 'now', 'now', ?)`,
    )
    .run(
      JSON.stringify([tradeId]),
      JSON.stringify({
        result: {
          rows: [
            {
              trade_id: tradeId,
              matched_trade_at: new Date(matchedTradeAt * 1000).toISOString(),
              price_usd: priceUsd,
              matched_tx_id: `MATCH_${tradeId}`,
              amount_usd: 100,
            },
          ],
        },
      }),
    );
};

const assertApproximately = (actual: number | null, expected: number): void => {
  assert.notEqual(actual, null);
  assert.ok(Math.abs((actual ?? 0) - expected) < 1e-9, `${actual} should equal ${expected}`);
};

test('pre-event features exclude the event and later rows while honoring the same-second id tie-break', () => {
  const database = setup();
  try {
    const walletAddress = 'EVENT_WALLET';
    const base = 1_700_000_000;
    const rows: TradeInput[] = [
      {
        id: 1,
        walletAddress,
        eventType: 'buy',
        tokenAddress: 'A',
        observedTimestamp: base,
        costUsd: 100,
      },
      {
        id: 2,
        walletAddress,
        eventType: 'sell',
        tokenAddress: 'A',
        observedTimestamp: base + 10,
        costUsd: 150,
        buyCostUsd: 100,
      },
      {
        id: 3,
        walletAddress,
        eventType: 'buy',
        tokenAddress: 'B',
        observedTimestamp: base + 20,
        costUsd: 200,
      },
      {
        id: 4,
        walletAddress,
        eventType: 'sell',
        tokenAddress: 'B',
        observedTimestamp: base + 40,
        costUsd: 100,
        buyCostUsd: 200,
      },
      {
        id: 5,
        walletAddress,
        eventType: 'buy',
        tokenAddress: 'C',
        observedTimestamp: base + 50,
        costUsd: 50,
      },
      {
        id: 6,
        walletAddress,
        eventType: 'sell',
        tokenAddress: 'C',
        observedTimestamp: base + 65,
        costUsd: 100,
        buyCostUsd: 50,
      },
      {
        id: 7,
        walletAddress,
        eventType: 'sell',
        tokenAddress: 'A',
        observedTimestamp: base + 100,
        costUsd: 120,
        buyCostUsd: 100,
      },
      {
        id: 8,
        walletAddress,
        eventType: 'buy',
        tokenAddress: 'A',
        observedTimestamp: base + 100,
        costUsd: 999,
        launchpadPlatform: 'pumpdotfun',
      },
      {
        id: 9,
        walletAddress,
        eventType: 'sell',
        tokenAddress: 'A',
        observedTimestamp: base + 100,
        costUsd: 9_999,
        buyCostUsd: 1,
      },
      {
        id: 10,
        walletAddress,
        eventType: 'buy',
        tokenAddress: 'LATER',
        observedTimestamp: base + 101,
        costUsd: 8_888,
      },
    ];
    for (const row of rows) insertTrade(database, row);

    const features = readPreEventFeatures(
      database,
      walletAddress,
      'A',
      new Date((base + 100) * 1000).toISOString(),
      8,
    );

    assert.equal(features.priorWalletTradeCount, 7);
    assert.equal(features.priorWalletBuyCount, 3);
    assert.equal(features.priorWalletSellCount, 4);
    assert.equal(features.priorWalletBuyVolumeUsd, 350);
    assert.equal(features.priorWalletSellVolumeUsd, 470);
    assert.equal(features.priorWalletRealizedProfitUsd, 20);
    assert.equal(features.priorWalletMedianReturnPercent, 35);
    assert.equal(features.priorWalletWinRatePercent, 75);
    assert.equal(features.priorWalletPositiveDayPercent, 100);
    assertApproximately(features.priorWalletBestTokenProfitSharePercent, (70 / 120) * 100);
    assert.equal(features.priorWalletTop3TokenProfitSharePercent, 100);
    assert.equal(features.priorWalletMedianHoldSeconds, 17.5);
    assert.equal(features.priorWalletUnder15SecondsPercent, 50);
    assert.equal(features.priorWalletPairedTradeCount, 4);
    assert.equal(features.priorWalletDistinctTokenCount, 3);
    assert.equal(features.priorWalletTradesPerActiveDay, 7);
    assert.equal(features.priorWalletMedianBuySizeUsd, 100);
    assertApproximately(features.priorWalletReturnVolatilityPercent, Math.sqrt(2_950));
    assert.equal(features.priorTokenTradeCount, 3);
    assert.equal(features.priorTokenBuyCount, 1);
    assert.equal(features.priorTokenSellCount, 2);
    assert.equal(features.priorTokenBuyVolumeUsd, 100);
    assert.equal(features.priorTokenSellVolumeUsd, 270);
    assert.equal(features.tokenLaunchpadPlatform, 'pumpdotfun');
    assert.equal(features.entryTradeAmountUsd, 999);
  } finally {
    database.close();
  }
});

test('current wallet features consume the wallet entire stored trade history', () => {
  const database = setup();
  try {
    const walletAddress = 'CURRENT_WALLET';
    const oldTimestamp = Math.floor(Date.UTC(2020, 0, 1) / 1000);
    const recentTimestamp = Math.floor(Date.UTC(2026, 7, 29) / 1000);
    insertTrade(database, {
      id: 20,
      walletAddress,
      eventType: 'buy',
      tokenAddress: 'OLD',
      observedTimestamp: oldTimestamp,
      costUsd: 100,
    });
    insertTrade(database, {
      id: 21,
      walletAddress,
      eventType: 'sell',
      tokenAddress: 'OLD',
      observedTimestamp: oldTimestamp + 10,
      costUsd: 200,
      buyCostUsd: 100,
    });
    insertTrade(database, {
      id: 22,
      walletAddress,
      eventType: 'buy',
      tokenAddress: 'NEW',
      observedTimestamp: recentTimestamp,
      costUsd: 50,
    });
    insertTrade(database, {
      id: 23,
      walletAddress,
      eventType: 'sell',
      tokenAddress: 'NEW',
      observedTimestamp: recentTimestamp + 30,
      costUsd: 25,
      buyCostUsd: 50,
    });

    const features = readCurrentWalletFeatures(database, walletAddress);

    assert.ok(features);
    assert.equal(features.priorWalletTradeCount, 4);
    assert.equal(features.priorWalletBuyCount, 2);
    assert.equal(features.priorWalletSellCount, 2);
    assert.equal(features.priorWalletBuyVolumeUsd, 150);
    assert.equal(features.priorWalletSellVolumeUsd, 225);
    assert.equal(features.priorWalletRealizedProfitUsd, 75);
    assert.equal(features.priorWalletMedianReturnPercent, 25);
    assert.equal(features.priorWalletWinRatePercent, 50);
    assert.equal(features.priorWalletPositiveDayPercent, 50);
    assert.equal(features.priorWalletBestTokenProfitSharePercent, 100);
    assert.equal(features.priorWalletMedianHoldSeconds, 20);
    assert.equal(features.priorWalletUnder15SecondsPercent, 50);
    assert.equal(features.priorWalletPairedTradeCount, 2);
    assert.equal(features.priorWalletDistinctTokenCount, 2);
    assert.equal(features.priorWalletTradesPerActiveDay, 2);
    assert.equal(features.priorWalletMedianBuySizeUsd, 75);
    assert.equal(features.priorWalletTop3TokenProfitSharePercent, 100);
  } finally {
    database.close();
  }
});

test('optimized Pattern Discovery snapshots match the single-event feature reader', () => {
  const database = setup();
  try {
    const walletAddress = 'SNAPSHOT_WALLET';
    const base = Math.floor(Date.now() / 1000) - 3_600;
    const roundTrips = [
      { buyId: 30, sellId: 31, tokenAddress: 'A', buyAt: base, sellAt: base + 100, sellPrice: 1.5 },
      {
        buyId: 32,
        sellId: 33,
        tokenAddress: 'B',
        buyAt: base + 200,
        sellAt: base + 300,
        sellPrice: 0.8,
      },
    ];
    for (const trip of roundTrips) {
      insertTrade(database, {
        id: trip.buyId,
        walletAddress,
        eventType: 'buy',
        tokenAddress: trip.tokenAddress,
        observedTimestamp: trip.buyAt,
        costUsd: 100,
        priceUsd: 1,
        launchpadPlatform: 'pumpdotfun',
      });
      insertTrade(database, {
        id: trip.sellId,
        walletAddress,
        eventType: 'sell',
        tokenAddress: trip.tokenAddress,
        observedTimestamp: trip.sellAt,
        costUsd: trip.sellPrice * 100,
        buyCostUsd: 100,
        priceUsd: trip.sellPrice,
      });
      seedDuneMatch(database, trip.buyId, trip.buyAt + DEFAULT_COPIER_DELAY_SECONDS, 1);
      seedDuneMatch(
        database,
        trip.sellId,
        trip.sellAt + DEFAULT_COPIER_DELAY_SECONDS,
        trip.sellPrice,
      );
    }
    database
      .prepare(
        `INSERT INTO copytrade_wallet_coverage
         (wallet_address, chain, requests_used, truncated, coverage_complete,
          requested_period_days, stop_reason, updated_at)
         VALUES (?, 'sol', 1, 0, 1, 30, 'window_covered', 'now')`,
      )
      .run(walletAddress);

    const exported = readPatternDiscoveryExportGrid(database, 30, 100, [100]).get(100);

    assert.ok(exported);
    assert.equal(exported.rows.length, 2);
    for (const row of exported.rows) {
      const direct = readPreEventFeatures(
        database,
        walletAddress,
        row.token_address,
        row.event_time,
        Number(row.entry_id),
      );
      assert.deepEqual(row.features, {
        wallet_address: walletAddress,
        token_symbol: row.features.token_symbol,
        token_address: row.token_address,
        chain: 'sol',
        signal_type: 'gmgn_copy_round_trip',
        prior_wallet_trade_count: direct.priorWalletTradeCount,
        prior_token_trade_count: direct.priorTokenTradeCount,
        prior_wallet_buy_volume_usd: direct.priorWalletBuyVolumeUsd,
        prior_wallet_buy_count: direct.priorWalletBuyCount,
        prior_wallet_sell_count: direct.priorWalletSellCount,
        prior_wallet_sell_volume_usd: direct.priorWalletSellVolumeUsd,
        prior_wallet_realized_profit_usd: direct.priorWalletRealizedProfitUsd,
        prior_wallet_median_return_percent: direct.priorWalletMedianReturnPercent,
        prior_wallet_win_rate_percent: direct.priorWalletWinRatePercent,
        prior_wallet_positive_day_percent: direct.priorWalletPositiveDayPercent,
        prior_wallet_best_token_profit_share_percent: direct.priorWalletBestTokenProfitSharePercent,
        prior_wallet_median_hold_seconds: direct.priorWalletMedianHoldSeconds,
        prior_wallet_under_15_seconds_percent: direct.priorWalletUnder15SecondsPercent,
        prior_wallet_paired_trade_count: direct.priorWalletPairedTradeCount,
        prior_wallet_distinct_token_count: direct.priorWalletDistinctTokenCount,
        prior_wallet_trades_per_active_day: direct.priorWalletTradesPerActiveDay,
        prior_wallet_median_buy_size_usd: direct.priorWalletMedianBuySizeUsd,
        prior_wallet_return_volatility_percent: direct.priorWalletReturnVolatilityPercent,
        prior_wallet_top3_token_profit_share_percent: direct.priorWalletTop3TokenProfitSharePercent,
        prior_token_buy_count: direct.priorTokenBuyCount,
        prior_token_sell_count: direct.priorTokenSellCount,
        prior_token_buy_volume_usd: direct.priorTokenBuyVolumeUsd,
        prior_token_sell_volume_usd: direct.priorTokenSellVolumeUsd,
        token_market_cap_at_entry: direct.tokenMarketCapAtEntry,
        token_age_seconds_at_entry: direct.tokenAgeSecondsAtEntry,
        token_launchpad_platform: direct.tokenLaunchpadPlatform,
        entry_trade_amount_usd: direct.entryTradeAmountUsd,
      });
    }
  } finally {
    database.close();
  }
});

test('batch current snapshots equal single-wallet reads and use one trade query for many wallets', () => {
  const database = setup();
  try {
    for (const [offset, walletAddress] of ['BATCH_A', 'BATCH_B'].entries()) {
      insertTrade(database, {
        id: 100 + offset * 2,
        walletAddress,
        eventType: 'buy',
        tokenAddress: `TOKEN_${offset}`,
        observedTimestamp: 1_700_100_000 + offset * 100,
        costUsd: 100,
      });
      insertTrade(database, {
        id: 101 + offset * 2,
        walletAddress,
        eventType: 'sell',
        tokenAddress: `TOKEN_${offset}`,
        observedTimestamp: 1_700_100_010 + offset * 100,
        costUsd: 125,
        buyCostUsd: 100,
      });
    }

    let prepareCount = 0;
    const countedDatabase = new Proxy(database, {
      get(target, property, receiver) {
        if (property === 'prepare') {
          return (sql: string) => {
            prepareCount += 1;
            return target.prepare(sql);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function'
          ? (...args: unknown[]): unknown => {
              const result: unknown = Reflect.apply(value, target, args);
              return result;
            }
          : value;
      },
    });
    const batch = readCurrentWalletFeaturesBatch(countedDatabase, ['BATCH_A', 'BATCH_B']);

    assert.equal(prepareCount, 1);
    assert.deepEqual(batch.get('BATCH_A'), readCurrentWalletFeatures(database, 'BATCH_A'));
    assert.deepEqual(batch.get('BATCH_B'), readCurrentWalletFeatures(database, 'BATCH_B'));
  } finally {
    database.close();
  }
});

test('calendar snapshots exclude pre-window activity from metrics but retain buy context for holds', () => {
  const database = setup();
  try {
    const walletAddress = 'CALENDAR_WALLET';
    const cutoff = Math.floor(Date.UTC(2026, 7, 29) / 1000);
    const day = 24 * 60 * 60;
    insertTrade(database, {
      id: 120,
      walletAddress,
      eventType: 'buy',
      tokenAddress: 'PRE_WINDOW',
      observedTimestamp: cutoff - 31 * day,
      costUsd: 100,
    });
    insertTrade(database, {
      id: 121,
      walletAddress,
      eventType: 'sell',
      tokenAddress: 'PRE_WINDOW',
      observedTimestamp: cutoff - day,
      costUsd: 150,
      buyCostUsd: 100,
    });
    insertTrade(database, {
      id: 122,
      walletAddress,
      eventType: 'buy',
      tokenAddress: 'IN_WINDOW',
      observedTimestamp: cutoff - 100,
      costUsd: 50,
    });
    insertTrade(database, {
      id: 123,
      walletAddress,
      eventType: 'sell',
      tokenAddress: 'IN_WINDOW',
      observedTimestamp: cutoff - 90,
      costUsd: 75,
      buyCostUsd: 50,
    });

    const snapshot = readWalletFeatureSnapshotsBatch(database, {
      walletAddresses: [walletAddress],
      asOfTimestamp: new Date(cutoff * 1000).toISOString(),
      lookbackDays: 30,
      trigger: 'calendar',
    }).get(walletAddress);

    assert.ok(snapshot);
    assert.equal(snapshot.features.priorWalletTradeCount, 3);
    assert.equal(snapshot.features.priorWalletBuyCount, 1);
    assert.equal(snapshot.features.priorWalletSellCount, 2);
    assert.equal(snapshot.features.priorWalletPairedTradeCount, 2);
    assert.equal(snapshot.features.priorWalletUnder15SecondsPercent, 50);
    assert.equal(snapshot.quality.rowsExamined, 3);
    assert.equal(snapshot.quality.contextRowsExamined, 1);
    assert.equal(snapshot.quality.requestedWindowEnd, new Date(cutoff * 1000).toISOString());
    assert.equal(
      snapshot.quality.requestedWindowStart,
      new Date((cutoff - 30 * day) * 1000).toISOString(),
    );
  } finally {
    database.close();
  }
});

test('canonical Decision compatibility metrics match the legacy report helpers exactly', () => {
  const rows = [
    {
      id: 200,
      walletAddress: 'PARITY',
      eventType: 'buy',
      tokenAddress: 'A',
      observedTimestamp: Math.floor(Date.UTC(2026, 6, 31) / 1000),
      costUsd: '100',
      buyCostUsd: null,
    },
    {
      id: 201,
      walletAddress: 'PARITY',
      eventType: 'sell',
      tokenAddress: 'A',
      observedTimestamp: Math.floor(Date.UTC(2026, 7, 1) / 1000),
      costUsd: '150',
      buyCostUsd: '100',
    },
    {
      id: 202,
      walletAddress: 'PARITY',
      eventType: 'buy',
      tokenAddress: 'B',
      observedTimestamp: Math.floor(Date.UTC(2026, 7, 10) / 1000),
      costUsd: '200',
      buyCostUsd: null,
    },
    {
      id: 203,
      walletAddress: 'PARITY',
      eventType: 'sell',
      tokenAddress: 'B',
      observedTimestamp: Math.floor(Date.UTC(2026, 7, 10, 0, 0, 10) / 1000),
      costUsd: '100',
      buyCostUsd: '200',
    },
    {
      id: 204,
      walletAddress: 'PARITY',
      eventType: 'sell',
      tokenAddress: 'RECEIVED',
      observedTimestamp: Math.floor(Date.UTC(2026, 7, 20) / 1000),
      costUsd: '75',
      buyCostUsd: null,
    },
  ];
  const accumulator = new WalletFeatureAccumulator();
  for (const row of rows) accumulator.apply(row);
  const canonical = accumulator.decisionCompatibilityMetrics();
  const completed = rows
    .filter((row) => row.eventType === 'sell' && row.buyCostUsd !== null)
    .map((row) => {
      const proceeds = Number(row.costUsd);
      const costBasis = Number(row.buyCostUsd);
      return {
        sourceId: row.id,
        timestamp: row.observedTimestamp,
        returnRatio: (proceeds - costBasis) / costBasis,
        profitUsd: proceeds - costBasis,
        tokenAddress: row.tokenAddress,
        tokenSymbol: null,
      };
    });
  const summary = summarizeTrades(completed);
  const concentration = computeProfitConcentration(completed);
  const periods = [
    ...performanceByPeriod(completed, 'week'),
    ...performanceByPeriod(completed, 'month'),
  ].filter((period) => period.medianReturnPercent !== null);
  const holds = holdSecondsPerSell(rows);

  assert.equal(canonical.completedTrades, summary.trades);
  assert.equal(canonical.medianReturnPercent, summary.medianReturnPercent);
  assert.equal(canonical.winRatePercent, summary.winRatePercent);
  assert.equal(
    canonical.excludingBestTokenMedianReturnPercent,
    concentration.excludingBestToken.medianReturnPercent,
  );
  assert.equal(
    canonical.bestTokenProfitSharePercent,
    concentration.bestTokenSharePositiveProfitPercent,
  );
  assert.equal(
    canonical.top3TokenProfitSharePercent,
    concentration.bestThreeSharePositiveProfitPercent,
  );
  assert.equal(
    canonical.positivePeriodCount,
    periods.filter((period) => (period.medianReturnPercent ?? 0) > 0).length,
  );
  assert.equal(canonical.periodCount, periods.length);
  assert.equal(canonical.medianHoldSeconds, Math.round((holds[0] + holds[1]) / 2));
  assert.equal(canonical.under15SecondsPercent, 50);
  assert.equal(canonical.under60SecondsPercent, 50);
  assert.equal(canonical.noCostBasisPercent, 33.3);
});

test('100-wallet current snapshot batch stays bounded to one trade query', () => {
  const database = setup();
  try {
    const base = Math.floor(Date.UTC(2026, 7, 15) / 1_000);
    const wallets = Array.from({ length: 100 }, (_, index) => `BATCH_WALLET_${index}`);
    let id = 10_000;
    for (const [index, walletAddress] of wallets.entries()) {
      insertTrade(database, {
        id: id++,
        walletAddress,
        eventType: 'buy',
        tokenAddress: `TOKEN_${index}`,
        observedTimestamp: base + index * 10,
        costUsd: 100,
      });
      insertTrade(database, {
        id: id++,
        walletAddress,
        eventType: 'sell',
        tokenAddress: `TOKEN_${index}`,
        observedTimestamp: base + index * 10 + 5,
        costUsd: 110,
        buyCostUsd: 100,
      });
    }
    let tradeQueries = 0;
    const countedDatabase = new Proxy(database, {
      get(target, property, receiver) {
        if (property === 'prepare') {
          return (sql: string) => {
            if (sql.includes('FROM copytrade_trades') && sql.includes('wallet_address IN')) {
              tradeQueries += 1;
            }
            return target.prepare(sql);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function'
          ? (...args: unknown[]): unknown => {
              const result: unknown = Reflect.apply(value, target, args);
              return result;
            }
          : value;
      },
    });
    const startedAt = performance.now();
    const snapshots = readWalletFeatureSnapshotsBatch(countedDatabase, {
      walletAddresses: wallets,
      asOfTimestamp: '2026-09-01T00:00:00.000Z',
      lookbackDays: 30,
      includePreWindowContext: false,
      trigger: 'current',
      chain: 'sol',
    });
    const elapsedMs = performance.now() - startedAt;
    assert.equal(snapshots.size, 100);
    assert.equal(tradeQueries, 1);
    assert.ok(elapsedMs < 5_000, `100-wallet batch took ${elapsedMs.toFixed(1)}ms`);
  } finally {
    database.close();
  }
});
