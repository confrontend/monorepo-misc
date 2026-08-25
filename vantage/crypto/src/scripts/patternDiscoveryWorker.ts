import { openDatabase } from '../platform/db/client.js';
import {
  PatternDiscoveryRunnerError,
  runPatternDiscoverySensitivity,
} from '../copytrade/discovery/patternDiscoveryRunner.js';
import type {
  PatternDiscoveryWorkerCommand,
  PatternDiscoveryWorkerEvent,
} from '../copytrade/discovery/patternDiscoveryWorkerProtocol.js';

let abortController: AbortController | null = null;
let started = false;

const send = (event: PatternDiscoveryWorkerEvent): void => {
  if (process.send) process.send(event);
};

process.on('message', (message: PatternDiscoveryWorkerCommand) => {
  if (message.type === 'cancel') {
    abortController?.abort();
    return;
  }
  if (message.type !== 'run' || started) return;
  started = true;
  abortController = new AbortController();
  const database = openDatabase();
  void runPatternDiscoverySensitivity(database, {
    projectRoot: message.projectRoot,
    periodDays: message.periodDays,
    minN: message.minN,
    signal: abortController.signal,
    onProgress: ({ threshold, index, total, phase }) =>
      send({
        type: 'progress',
        progress: {
          status: phase === 'complete' && index === total ? 'complete' : 'running',
          stage: phase === 'complete' && index === total ? 'complete' : 'running threshold',
          message:
            phase === 'starting'
              ? `Starting ${threshold}% coverage (${index + 1}/${total}).`
              : `${threshold}% coverage complete (${index}/${total}).`,
          thresholdsCompleted: phase === 'complete' ? index : Math.max(0, index),
          thresholdsTotal: total,
          currentThreshold: phase === 'complete' ? null : threshold,
          heartbeatAt: new Date().toISOString(),
        },
      }),
    onEngineProgress: (progress) => send({ type: 'progress', progress }),
  })
    .then(() => send({ type: 'complete' }))
    .catch((error: unknown) => {
      if (abortController?.signal.aborted) {
        send({
          type: 'stopped',
          message: 'Discovery stopped. Completed coverage levels remain cached.',
        });
        return;
      }
      send({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
        statusCode: error instanceof PatternDiscoveryRunnerError ? error.statusCode : 500,
      });
    })
    .finally(() => {
      database.close();
      abortController = null;
      setTimeout(() => process.exit(0), 0);
    });
});

send({
  type: 'progress',
  progress: {
    stage: 'loading evidence',
    message: 'Discovery worker started and is waiting for its run configuration.',
    heartbeatAt: new Date().toISOString(),
  },
});
