import assert from 'node:assert/strict';
import test from 'node:test';
import { isApprovedResearchQuestionV2, RESEARCH_QUESTION_V2, RESEARCH_QUESTION_V2_ID } from '../src/research/questionV2.js';

test('v2 contract is proposed, versioned, and requires an explicit collector boundary', () => {
  assert.equal(RESEARCH_QUESTION_V2_ID, 'solana-gmgn-early-winner-v2');
  assert.equal(RESEARCH_QUESTION_V2.version, 2);
  assert.equal(RESEARCH_QUESTION_V2.status, 'PROPOSED');
  assert.equal(RESEARCH_QUESTION_V2.collectorStartAt, null);
  assert.equal(isApprovedResearchQuestionV2(RESEARCH_QUESTION_V2), false);
});

test('v2 comparator forbids historical no-row inference and requires observed exposure', () => {
  assert.match(RESEARCH_QUESTION_V2.comparator, /verified exposure window/);
  assert.match(RESEARCH_QUESTION_V2.comparator, /never sufficient/);
  assert.match(RESEARCH_QUESTION_V2.observableExposure, /verified successful collection window/);
});

test('v2 retains preregistered defaults and defers outcome implementation', () => {
  assert.equal(RESEARCH_QUESTION_V2.earlyWinnerMultiple, 5);
  assert.equal(RESEARCH_QUESTION_V2.outcomeWindowDays, 7);
  assert.equal(RESEARCH_QUESTION_V2.signalCutoffMultiple, 10);
  assert.ok(RESEARCH_QUESTION_V2.forbiddenInThisPhase.includes('returns'));
  assert.ok(RESEARCH_QUESTION_V2.requiredCoverage.includes('signal types 14–16 coverage'));
});
