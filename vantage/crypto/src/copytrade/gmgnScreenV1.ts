import type { CopyTradeRow } from './scrutiny/evaluate.js';
import { STRONGLY_NEGATIVE_PNL_PERCENT } from './simulation/constants.js';

export const GMGN_SCREEN_RULE_VERSION = 'gmgn-screen-v1';

export type GmgnScreenClassification = 'POTENTIAL' | 'REJECTED_PRE_DUNE' | 'UNPROVEN';

export type GmgnScreenResult = {
  ruleVersion: typeof GMGN_SCREEN_RULE_VERSION;
  classification: GmgnScreenClassification;
  reasons: string[];
};

/**
 * Cheap, deterministic pre-Dune screen. This function deliberately reads only metrics derived
 * from persisted GMGN activity/stats. It must never depend on Dune matches, Pattern Research,
 * Winner Policy, or a previous Dune decision.
 */
export const evaluateGmgnScreenV1 = (row: CopyTradeRow): GmgnScreenResult => {
  const reasons: string[] = [];
  const trades = row.trades;
  const holdSeconds = row.riskEvidence.medianHoldSeconds;
  const fastRoundTrip = row.riskEvidence.fastRoundTripPercent;
  const pnl = row.gmgnAggregate?.realizedProfitPnlPercent ?? null;

  if (row.truncated || row.historyFailed) {
    reasons.push(row.historyFailed ? 'GMGN history fetch failed.' : 'GMGN history is truncated.');
    return { ruleVersion: GMGN_SCREEN_RULE_VERSION, classification: 'UNPROVEN', reasons };
  }
  if (trades < 20) {
    reasons.push(`Only ${trades} completed GMGN trades; at least 20 are needed.`);
    return { ruleVersion: GMGN_SCREEN_RULE_VERSION, classification: 'UNPROVEN', reasons };
  }
  if (row.medianReturnPercent === null || holdSeconds === null) {
    reasons.push('GMGN history lacks a usable realized-return or holding-time measure.');
    return { ruleVersion: GMGN_SCREEN_RULE_VERSION, classification: 'UNPROVEN', reasons };
  }
  if (holdSeconds !== null && holdSeconds < 60) {
    reasons.push(`Median hold is ${Math.round(holdSeconds)}s, below the 60s copyability floor.`);
  }
  if (fastRoundTrip !== null && fastRoundTrip > 50) {
    reasons.push(`${fastRoundTrip.toFixed(1)}% of trades close within 60s.`);
  }
  if (pnl !== null && pnl <= STRONGLY_NEGATIVE_PNL_PERCENT) {
    reasons.push(`GMGN realized PnL is ${pnl.toFixed(1)}%.`);
  }
  if (reasons.length > 0) {
    return { ruleVersion: GMGN_SCREEN_RULE_VERSION, classification: 'REJECTED_PRE_DUNE', reasons };
  }
  reasons.push(`${trades} completed GMGN trades pass the pre-Dune screen.`);
  return { ruleVersion: GMGN_SCREEN_RULE_VERSION, classification: 'POTENTIAL', reasons };
};
