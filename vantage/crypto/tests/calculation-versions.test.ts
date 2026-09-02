import assert from 'node:assert/strict';
import test from 'node:test';
import { CACHE_VERSIONS } from '../src/platform/cache/cacheVersions.js';
import { WALLET_FEATURE_ENGINE_VERSION } from '../src/copytrade/features/walletFeatureDefinitions.js';
import {
  attachCalculationProvenance,
  CALCULATION_MANIFEST_VERSION,
  CALCULATION_VERSION_MANIFEST,
  CALCULATION_VERSIONS,
  calculationProvenanceFor,
  isEvidencePeriodDays,
  requireEvidencePeriodDays,
} from '../src/copytrade/calculationVersions.js';

test('manifest reflects the current calculation sources without importing heavy calculators', () => {
  assert.equal(CALCULATION_VERSION_MANIFEST.manifestVersion, CALCULATION_MANIFEST_VERSION);
  assert.equal(CALCULATION_VERSIONS.walletFeatures, WALLET_FEATURE_ENGINE_VERSION);
  assert.equal(CALCULATION_VERSIONS.copyability, CACHE_VERSIONS.decisionLab);
  assert.equal(CALCULATION_VERSIONS.delayedCopyOutcomes, CACHE_VERSIONS.copySimulation);
  assert.equal(CALCULATION_VERSIONS.patternDiscovery, CACHE_VERSIONS.patternDiscovery);
  assert.equal(
    CALCULATION_VERSION_MANIFEST.pitPolicy.cutoffRule,
    'observed_timestamp < asOfTimestamp',
  );
  assert.deepEqual(CALCULATION_VERSION_MANIFEST.evidenceSnapshot.namespaces, [
    'activity',
    'officialGmgn',
    'delayedCopy',
    'provenance',
  ]);
});

test('period helpers accept only supported evidence windows', () => {
  assert.equal(isEvidencePeriodDays(30), true);
  assert.equal(isEvidencePeriodDays(60), true);
  assert.equal(isEvidencePeriodDays(90), true);
  assert.equal(isEvidencePeriodDays(45), false);
  assert.equal(requireEvidencePeriodDays(60), 60);
  assert.throws(() => requireEvidencePeriodDays(45), RangeError);
});

test('provenance helper attaches the selected version and PIT context without changing the result', () => {
  const result = { score: 73.5, confidence: 'medium' as const };
  const attached = attachCalculationProvenance(result, 'copyability', {
    asOfTimestamp: '2026-08-30T10:00:00.000Z',
    periodDays: 60,
    sourceDataRevision: 123,
  });

  assert.equal(attached.result, result);
  assert.deepEqual(attached.provenance, {
    manifestVersion: CALCULATION_MANIFEST_VERSION,
    calculation: 'copyability',
    calculationVersion: CACHE_VERSIONS.decisionLab,
    source: 'mixed',
    asOfTimestamp: '2026-08-30T10:00:00.000Z',
    periodDays: 60,
    sourceDataRevision: 123,
  });
});

test('provenance defaults remain explicit for source and missing PIT context', () => {
  assert.deepEqual(calculationProvenanceFor('delayedCopyOutcomes'), {
    manifestVersion: CALCULATION_MANIFEST_VERSION,
    calculation: 'delayedCopyOutcomes',
    calculationVersion: CACHE_VERSIONS.copySimulation,
    source: 'dune_delayed_copy',
    asOfTimestamp: null,
    periodDays: null,
    sourceDataRevision: null,
  });
});
