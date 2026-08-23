import test from 'node:test';
import assert from 'node:assert/strict';
import { decideThirtyDayVerdict } from '../src/copytrade/scrutiny/decisionEngine.js';

const passing = {
  historyIncomplete: false,
  impossibleToCopy: false,
  hasGmgn30dStats: true,
  enoughDuneEvidence: true,
  gmgnStatsFresh: true,
  duneEvidenceFresh: true,
  gmgn30dPositive: true,
  delayedCopySurvived: true,
  delayedCopyMedianPositive: true,
  consistentlyProfitable: true,
  consistencyDataMissing: false,
};

test('30-day decision engine uses one ordered, fail-closed formula', () => {
  assert.equal(decideThirtyDayVerdict(passing), 'Tested candidate');
  assert.equal(decideThirtyDayVerdict({ ...passing, enoughDuneEvidence: false }), 'Needs data');
  assert.equal(decideThirtyDayVerdict({ ...passing, gmgnStatsFresh: false }), 'Historical / stale');
  assert.equal(decideThirtyDayVerdict({ ...passing, impossibleToCopy: true }), 'Not copyable');
  assert.equal(decideThirtyDayVerdict({ ...passing, consistentlyProfitable: false }), 'Watch');
  assert.equal(decideThirtyDayVerdict({ ...passing, gmgn30dPositive: false }), 'Historical screen failed');
});
