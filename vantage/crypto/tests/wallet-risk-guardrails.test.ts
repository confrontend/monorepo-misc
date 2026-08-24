import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessWalletRiskGuardrails,
  HIGH_VOLUME_30D_THRESHOLD,
  HIGH_CREATED_TOKEN_COUNT_THRESHOLD,
  THIN_SAMPLE_30D_THRESHOLD,
  WEAK_WIN_RATE_PERCENT,
  ONE_SIDED_IMBALANCE_PERCENT,
  type WalletRiskStats30d,
} from '../src/copytrade/scrutiny/walletRiskGuardrails.js';

const clean: WalletRiskStats30d = {
  tags: [],
  realizedProfitPnlPercent: 15,
  buyCount: 40,
  sellCount: 40,
  createdTokenCount: 0,
  winRatePercent: 55,
};

test('a wallet with no risk signals gets no reasons', () => {
  assert.deepEqual(assessWalletRiskGuardrails(clean), []);
});

test('wash_trader tag is flagged regardless of everything else looking fine', () => {
  const reasons = assessWalletRiskGuardrails({ ...clean, tags: ['wash_trader'] });
  assert.match(reasons.join(','), /wash trader/);
});

test('strongly negative 30d PnL is flagged at the threshold and just above it, not just below', () => {
  assert.equal(assessWalletRiskGuardrails({ ...clean, realizedProfitPnlPercent: -20 }).length, 1);
  assert.equal(assessWalletRiskGuardrails({ ...clean, realizedProfitPnlPercent: -19.9 }).length, 0);
});

test('high 30d volume is flagged only strictly above the threshold', () => {
  const atThreshold = {
    ...clean,
    buyCount: HIGH_VOLUME_30D_THRESHOLD / 2,
    sellCount: HIGH_VOLUME_30D_THRESHOLD / 2,
  };
  assert.equal(assessWalletRiskGuardrails(atThreshold).length, 0);
  const overThreshold = {
    ...clean,
    buyCount: HIGH_VOLUME_30D_THRESHOLD / 2 + 1,
    sellCount: HIGH_VOLUME_30D_THRESHOLD / 2,
  };
  assert.equal(assessWalletRiskGuardrails(overThreshold).length, 1);
});

test('mass token creation is flagged only strictly above the threshold', () => {
  assert.equal(
    assessWalletRiskGuardrails({ ...clean, createdTokenCount: HIGH_CREATED_TOKEN_COUNT_THRESHOLD })
      .length,
    0,
  );
  assert.equal(
    assessWalletRiskGuardrails({
      ...clean,
      createdTokenCount: HIGH_CREATED_TOKEN_COUNT_THRESHOLD + 1,
    }).length,
    1,
  );
});

test('a thin 30d sample is flagged, but a wallet with zero trades is not (nothing to judge yet)', () => {
  const thin = { ...clean, buyCount: 1, sellCount: THIN_SAMPLE_30D_THRESHOLD - 2 };
  assert.equal(assessWalletRiskGuardrails(thin).length, 1);
  const zero = { ...clean, buyCount: 0, sellCount: 0 };
  assert.equal(assessWalletRiskGuardrails(zero).length, 0);
});

test('weak win rate is flagged only strictly below the threshold', () => {
  assert.equal(
    assessWalletRiskGuardrails({ ...clean, winRatePercent: WEAK_WIN_RATE_PERCENT }).length,
    0,
  );
  assert.equal(
    assessWalletRiskGuardrails({ ...clean, winRatePercent: WEAK_WIN_RATE_PERCENT - 0.1 }).length,
    1,
  );
});

test('near-total one-sided buy/sell activity is flagged; a balanced wallet is not', () => {
  const oneSided = { ...clean, buyCount: 100, sellCount: 1 };
  const reasons = assessWalletRiskGuardrails(oneSided);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /one-sided/);
  const imbalancePercent = (Math.abs(100 - 1) / 101) * 100;
  assert.ok(imbalancePercent > ONE_SIDED_IMBALANCE_PERCENT);
});

test('a wallet can trip multiple guardrails at once, and every reason is reported', () => {
  // wash_trader tag, PnL, volume, created-token-count, win-rate, and 100% one-sided (sellCount 0)
  // all fire simultaneously — six independent reasons, none suppressing another.
  const reasons = assessWalletRiskGuardrails({
    tags: ['wash_trader'],
    realizedProfitPnlPercent: -50,
    buyCount: 6000,
    sellCount: 0,
    createdTokenCount: 500,
    winRatePercent: 5,
  });
  assert.equal(reasons.length, 6);
});

test('null fields (stats not yet available for that metric) are never treated as a violation', () => {
  const allNull: WalletRiskStats30d = {
    tags: [],
    realizedProfitPnlPercent: null,
    buyCount: null,
    sellCount: null,
    createdTokenCount: null,
    winRatePercent: null,
  };
  assert.deepEqual(assessWalletRiskGuardrails(allNull), []);
});
