import assert from 'node:assert/strict';
import test from 'node:test';
import { assessPatternDiscoveryHistoryAvailability } from '../src/copytrade/discovery/patternDiscoveryAvailability.js';

test('Pattern Discovery can run on a covered subset without meeting a 90% roster threshold', () => {
  const availability = assessPatternDiscoveryHistoryAvailability({
    periodDays: 60,
    totalWallets: 100,
    coveredWallets: 69,
  });

  assert.equal(availability.available, true);
  assert.equal(availability.coveredWallets, 69);
  assert.equal(availability.excludedWallets, 31);
  assert.equal(availability.reason, null);
});

test('one covered wallet is sufficient to start discovery and zero covered wallets is not', () => {
  assert.equal(
    assessPatternDiscoveryHistoryAvailability({
      periodDays: 60,
      totalWallets: 100,
      coveredWallets: 1,
    }).available,
    true,
  );
  assert.match(
    assessPatternDiscoveryHistoryAvailability({
      periodDays: 60,
      totalWallets: 100,
      coveredWallets: 0,
    }).reason ?? '',
    /No wallet has completed 60-day history/,
  );
});
