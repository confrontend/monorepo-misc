import assert from 'node:assert/strict';
import test from 'node:test';
import { weightCategoryForFeature } from '../src/copytrade/decisionCategories.js';
import {
  getWalletFeatureDefinition,
  isWalletFeatureIdentifier,
  WALLET_FEATURE_DEFINITIONS,
  WALLET_FEATURE_IDENTIFIERS,
  walletFeaturesForApplication,
  walletFeatureSupportsApplication,
} from '../src/copytrade/features/walletFeatureDefinitions.js';

const EXPECTED_PATTERN_DISCOVERY_WALLET_FEATURES = [
  'prior_wallet_trade_count',
  'prior_wallet_buy_volume_usd',
  'prior_wallet_buy_count',
  'prior_wallet_sell_count',
  'prior_wallet_sell_volume_usd',
  'prior_wallet_realized_profit_usd',
  'prior_wallet_median_return_percent',
  'prior_wallet_win_rate_percent',
  'prior_wallet_positive_day_percent',
  'prior_wallet_best_token_profit_share_percent',
  'prior_wallet_median_hold_seconds',
  'prior_wallet_under_15_seconds_percent',
  'prior_wallet_paired_trade_count',
  'prior_wallet_distinct_token_count',
  'prior_wallet_trades_per_active_day',
  'prior_wallet_median_buy_size_usd',
  'prior_wallet_return_volatility_percent',
  'prior_wallet_top3_token_profit_share_percent',
] as const;

test('registers every existing Pattern Discovery prior_wallet feature exactly once', () => {
  assert.deepEqual(WALLET_FEATURE_IDENTIFIERS, EXPECTED_PATTERN_DISCOVERY_WALLET_FEATURES);
  assert.equal(new Set(WALLET_FEATURE_IDENTIFIERS).size, WALLET_FEATURE_IDENTIFIERS.length);
  assert.ok(WALLET_FEATURE_DEFINITIONS.every(({ pointInTimeEligible }) => pointInTimeEligible));
  assert.ok(
    WALLET_FEATURE_DEFINITIONS.every(({ identifier }) => identifier.startsWith('prior_wallet_')),
  );
});

test('preserves the existing Decision Lab category mapping', () => {
  for (const definition of WALLET_FEATURE_DEFINITIONS) {
    assert.equal(definition.category, weightCategoryForFeature(definition.identifier));
  }

  assert.equal(getWalletFeatureDefinition('prior_wallet_median_return_percent')?.category, 'edge');
  assert.equal(
    getWalletFeatureDefinition('prior_wallet_win_rate_percent')?.category,
    'consistency',
  );
  assert.equal(
    getWalletFeatureDefinition('prior_wallet_top3_token_profit_share_percent')?.category,
    'robustness',
  );
  assert.equal(
    getWalletFeatureDefinition('prior_wallet_median_hold_seconds')?.category,
    'copyability',
  );
  assert.equal(getWalletFeatureDefinition('prior_wallet_trade_count')?.category, null);
});

test('records context-sensitive hold and pairing features explicitly', () => {
  const contextFeatures = WALLET_FEATURE_DEFINITIONS.filter(
    ({ sourceClass }) => sourceClass === 'pre_window_context',
  ).map(({ identifier }) => identifier);

  assert.deepEqual(contextFeatures, [
    'prior_wallet_median_hold_seconds',
    'prior_wallet_under_15_seconds_percent',
    'prior_wallet_paired_trade_count',
  ]);
  assert.equal(
    getWalletFeatureDefinition('prior_wallet_realized_profit_usd')?.sourceClass,
    'raw_activity',
  );
});

test('models the established Decision Lab penalty application modes', () => {
  assert.deepEqual(
    walletFeaturesForApplication('decision_hyperactivity_penalty').map(
      ({ identifier }) => identifier,
    ),
    [
      'prior_wallet_trade_count',
      'prior_wallet_buy_volume_usd',
      'prior_wallet_buy_count',
      'prior_wallet_sell_count',
      'prior_wallet_sell_volume_usd',
    ],
  );
  assert.deepEqual(
    walletFeaturesForApplication('decision_fast_trading_penalty').map(
      ({ identifier }) => identifier,
    ),
    ['prior_wallet_under_15_seconds_percent'],
  );
});

test('separates live feature availability from generic live rule scoring', () => {
  assert.equal(walletFeaturesForApplication('live_evaluation').length, 18);
  assert.equal(walletFeaturesForApplication('pattern_discovery').length, 18);
  assert.equal(walletFeaturesForApplication('decision_weighting').length, 10);

  assert.equal(
    walletFeatureSupportsApplication('prior_wallet_median_return_percent', 'live_promoted_rule'),
    true,
  );
  assert.equal(
    walletFeatureSupportsApplication('prior_wallet_buy_count', 'live_promoted_rule'),
    false,
  );
  assert.equal(
    walletFeatureSupportsApplication('prior_wallet_under_15_seconds_percent', 'live_promoted_rule'),
    false,
  );
});

test('provides safe identifier and lookup helpers', () => {
  assert.equal(isWalletFeatureIdentifier('prior_wallet_trade_count'), true);
  assert.equal(isWalletFeatureIdentifier('prior_token_trade_count'), false);
  assert.equal(getWalletFeatureDefinition('prior_wallet_trade_count')?.unit, 'count');
  assert.equal(getWalletFeatureDefinition('unknown_feature'), null);
  assert.equal(walletFeatureSupportsApplication('unknown_feature', 'pattern_discovery'), false);
});
