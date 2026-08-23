import test from 'node:test';
import assert from 'node:assert/strict';
import { REPRESENTATIVE_SAMPLE_METHOD, selectRepresentativeTrades } from '../src/copytrade/representativeSample.js';

const row = (id: number, walletAddress: string, timestamp: number, eventType: 'buy' | 'sell', tokenAddress = 'TOKEN'): {
  id: number; walletAddress: string; observedTimestamp: number; eventType: string; tokenAddress: string;
} => ({ id, walletAddress, observedTimestamp: timestamp, eventType, tokenAddress });

test('representative sample is deterministic and bounded by sell count', () => {
  const rows = Array.from({ length: 2_400 }, (_, index) => row(index + 1, 'wallet-a', 1_700_000_000 + index * 3_600, 'sell'));
  const first = selectRepresentativeTrades(rows, 1_000);
  const second = selectRepresentativeTrades(rows, 1_000);
  assert.equal(first.byWallet.get('wallet-a')?.populationSellCount, 2_400);
  assert.equal(first.byWallet.get('wallet-a')?.selectedSellCount, 1_000);
  assert.equal(first.byWallet.get('wallet-a')?.sampled, true);
  assert.deepEqual(first.rows.map((item) => item.id), second.rows.map((item) => item.id));
  assert.equal(first.rows.filter((item) => item.eventType === 'sell').length, 1_000);
});

test('sample keeps all rows when under the limit and records the method-independent result', () => {
  const rows = [row(1, 'wallet-a', 1_700_000_000, 'buy'), row(2, 'wallet-a', 1_700_000_060, 'sell')];
  const result = selectRepresentativeTrades(rows, 1_000);
  assert.equal(result.rows.length, 2);
  assert.equal(result.byWallet.get('wallet-a')?.sampled, false);
  assert.equal(REPRESENTATIVE_SAMPLE_METHOD, 'utc-day-stratified-systematic-v1');
});

test('sample retains the nearest prior buy for every selected sell', () => {
  const rows = [
    row(1, 'wallet-a', 1_700_000_000, 'buy', 'TOKEN'),
    row(2, 'wallet-a', 1_700_000_060, 'buy', 'TOKEN'),
    row(3, 'wallet-a', 1_700_000_120, 'sell', 'TOKEN'),
  ];
  const result = selectRepresentativeTrades(rows, 1);
  assert.deepEqual(result.rows.map((item) => item.id), [2, 3]);
});

test('sampling is independent per wallet', () => {
  const rows = [
    ...Array.from({ length: 1_100 }, (_, index) => row(index + 1, 'wallet-a', 1_700_000_000 + index, 'sell')),
    ...Array.from({ length: 3 }, (_, index) => row(2_000 + index, 'wallet-b', 1_700_000_000 + index, 'sell')),
  ];
  const result = selectRepresentativeTrades(rows, 1_000);
  assert.equal(result.byWallet.get('wallet-a')?.selectedSellCount, 1_000);
  assert.equal(result.byWallet.get('wallet-b')?.selectedSellCount, 3);
});
