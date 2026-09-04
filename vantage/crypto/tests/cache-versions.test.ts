import assert from 'node:assert/strict';
import test from 'node:test';
import { CACHE_VERSIONS, versionedCacheKey } from '../src/platform/cache/cacheVersions.js';

test('persisted report cache keys derive from the centralized version registry', () => {
  assert.equal(
    versionedCacheKey('patternDiscovery', 'report', 30, 100, 10, 500),
    'crypto-pattern-discovery-v6-period-aware-coverage-grid:report:30:100:10:500',
  );
  assert.equal(
    versionedCacheKey('decisionLab', 100, 'latest', 'fingerprint:updated'),
    'experimental-decision:decision-lab-scoring-v14-uncopyable-gate:100:latest:fingerprint:updated',
  );
  assert.equal(
    versionedCacheKey('copySimulation', 30, 'scope-hash'),
    'copy-simulation-v4-uncopyable-gate:30:scope-hash',
  );
  assert.equal(
    CACHE_VERSIONS.patternDiscovery,
    'crypto-pattern-discovery-v6-period-aware-coverage-grid',
  );
});
