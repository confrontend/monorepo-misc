import assert from 'node:assert/strict';
import test from 'node:test';
import { weightCategoryForFeature } from '../src/copytrade/decisionCategories.js';

test('maps both best- and top3-token profit share features to robustness', () => {
  assert.equal(weightCategoryForFeature('prior_wallet_best_token_profit_share_percent'), 'robustness');
  assert.equal(weightCategoryForFeature('prior_wallet_top3_token_profit_share_percent'), 'robustness');
  assert.equal(weightCategoryForFeature('prior_wallet_concentration_ratio'), 'robustness');
});

test('maps the other three known category families', () => {
  assert.equal(weightCategoryForFeature('prior_wallet_median_return_percent'), 'edge');
  assert.equal(weightCategoryForFeature('prior_wallet_realized_profit_usd'), 'edge');
  assert.equal(weightCategoryForFeature('prior_wallet_positive_day_percent'), 'consistency');
  assert.equal(weightCategoryForFeature('prior_wallet_win_rate_percent'), 'consistency');
  assert.equal(weightCategoryForFeature('prior_wallet_median_hold_seconds'), 'copyability');
  assert.equal(weightCategoryForFeature('prior_wallet_under_15_seconds_percent'), 'copyability');
  assert.equal(weightCategoryForFeature('prior_wallet_buy_count'), 'copyability');
  assert.equal(weightCategoryForFeature('prior_wallet_sell_count'), 'copyability');
});

test('returns null for a feature with no category mapping', () => {
  assert.equal(weightCategoryForFeature('prior_wallet_distinct_token_count'), null);
  assert.equal(weightCategoryForFeature('prior_wallet_trades_per_active_day'), null);
});
