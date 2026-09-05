import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkSolanaAgainstDune, type BenchmarkLeg } from '../src/solana/benchmark.js';

const observation = (signature: string, slot: number, price: number, gapSeconds = 2) => ({
  found: true,
  signature,
  slot,
  price,
  gapSeconds,
  timestamp: 1_700_000_000,
});

test('benchmark reports coverage, parity, quantiles, and explicit failures', () => {
  const legs: BenchmarkLeg[] = [
    {
      id: 1, tokenMint: 'mint-a', direction: 'buy', delaySeconds: 10, targetTimestamp: 1_700_000_010,
      dune: observation('sig-a', 10, 1), solana: observation('sig-a', 10, 1.01),
    },
    {
      id: 2, tokenMint: 'mint-b', direction: 'sell', delaySeconds: 60, targetTimestamp: 1_700_000_060,
      dune: observation('sig-b', 20, 2), solana: { found: false, failureReason: 'NO_MARKET_TRADE_WITHIN_WINDOW' },
    },
  ];
  const report = benchmarkSolanaAgainstDune(legs);
  assert.equal(report.sampleSize, 2);
  assert.equal(report.solanaFound, 1);
  assert.equal(report.duneFound, 2);
  assert.equal(report.bothFound, 1);
  assert.equal(report.sameSignature, 1);
  assert.equal(report.sameSlot, 1);
  assert.equal(report.failures.total, 1);
  assert.equal(report.failures.byReason.NO_MARKET_TRADE_WITHIN_WINDOW, 1);
  assert.equal(report.failures.byDirection.sell, 1);
  assert.equal(report.failures.byDelaySeconds['60'], 1);
  assert.equal(report.recommendation, 'KEEP_DUNE');
});

test('empty and perfectly matching samples are deterministic', () => {
  assert.equal(benchmarkSolanaAgainstDune([]).medianAbsolutePriceDifferencePercent, null);
  const leg: BenchmarkLeg = {
    id: 'x', tokenMint: 'mint', direction: 'buy', delaySeconds: 5, targetTimestamp: 1,
    dune: observation('sig', 1, 100), solana: observation('sig', 1, 100),
  };
  const report = benchmarkSolanaAgainstDune([leg]);
  assert.equal(report.solanaCoveragePercent, 100);
  assert.equal(report.sameSignaturePercent, 100);
  assert.equal(report.recommendation, 'SOLANA_RPC_PRIMARY_DUNE_FALLBACK');
});
