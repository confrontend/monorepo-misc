import type { PatternDiscoveryProgress } from './patternDiscoveryRunner.js';

export type PatternDiscoveryWorkerCommand =
  | {
      type: 'run';
      runId: number;
      projectRoot: string;
      periodDays: number;
      minN: number;
    }
  | { type: 'cancel' };

export type PatternDiscoveryWorkerEvent =
  | { type: 'progress'; progress: Partial<PatternDiscoveryProgress> }
  | { type: 'complete' }
  | { type: 'stopped'; message: string }
  | { type: 'error'; message: string; statusCode: number };
