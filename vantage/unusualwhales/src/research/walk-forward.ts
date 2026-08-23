import { validateOutOfSample, type OosValidationConfig, type OosEvent, type OosValidationReport } from './oos-validation.js';
import type { DatabaseSync } from 'node:sqlite';
import { runOutOfSampleValidation } from './oos-validation.js';

export type WalkForwardWindow = {
  id: string;
  inSample: { start?: string; end: string };
  outOfSample: { start: string; end: string };
  asOf: string;
};

export type WalkForwardConfig = Omit<OosValidationConfig, 'inSample' | 'outOfSample' | 'asOf'> & {
  windows: readonly WalkForwardWindow[];
};

export type WalkForwardReport = {
  methodologyVersion: string;
  selections: OosValidationConfig['selections'];
  windows: Array<WalkForwardWindow & { report: OosValidationReport }>;
};

/**
 * Evaluates a frozen selection across sequential windows. The selections,
 * horizons, costs, and minimum evidence threshold are shared by every window;
 * only the time split and maturity cutoff change.
 */
export const validateWalkForward = (events: readonly OosEvent[], config: WalkForwardConfig): WalkForwardReport => {
  if (!config.windows.length) throw new Error('walk-forward validation requires at least one window');
  const ordered = [...config.windows].sort((left, right) => Date.parse(left.outOfSample.start) - Date.parse(right.outOfSample.start) || left.id.localeCompare(right.id));
  const ids = new Set<string>();
  let previousOutEnd = -Infinity;
  const windows = ordered.map((window) => {
    if (!window.id.trim() || ids.has(window.id)) throw new Error(`walk-forward window IDs must be unique and non-empty: ${window.id}`);
    ids.add(window.id);
    const outStart = Date.parse(window.outOfSample.start);
    if (!Number.isFinite(outStart) || outStart < previousOutEnd) throw new Error(`walk-forward windows overlap or have invalid dates: ${window.id}`);
    previousOutEnd = Date.parse(window.outOfSample.end);
    const report = validateOutOfSample(events, { ...config, inSample: window.inSample, outOfSample: window.outOfSample, asOf: window.asOf });
    return { ...window, report };
  });
  return { methodologyVersion: config.methodologyVersion, selections: config.selections, windows };
};

/** Database-backed variant. Each window uses the bounded streaming OOS runner. */
export const runWalkForwardValidation = (database: DatabaseSync, config: WalkForwardConfig): WalkForwardReport => {
  if (!config.windows.length) throw new Error('walk-forward validation requires at least one window');
  const ordered = [...config.windows].sort((left, right) => Date.parse(left.outOfSample.start) - Date.parse(right.outOfSample.start) || left.id.localeCompare(right.id));
  const ids = new Set<string>();
  let previousOutEnd = -Infinity;
  const windows = ordered.map((window) => {
    if (!window.id.trim() || ids.has(window.id)) throw new Error(`walk-forward window IDs must be unique and non-empty: ${window.id}`);
    ids.add(window.id);
    const outStart = Date.parse(window.outOfSample.start);
    const outEnd = Date.parse(window.outOfSample.end);
    if (!Number.isFinite(outStart) || !Number.isFinite(outEnd) || outStart < previousOutEnd) throw new Error(`walk-forward windows overlap or have invalid dates: ${window.id}`);
    previousOutEnd = outEnd;
    const report = runOutOfSampleValidation(database, { ...config, inSample: window.inSample, outOfSample: window.outOfSample, asOf: window.asOf });
    return { ...window, report };
  });
  return { methodologyVersion: config.methodologyVersion, selections: config.selections, windows };
};
