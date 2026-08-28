import { fork, type ChildProcess } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import {
  MAX_PATTERN_DISCOVERY_WALLETS,
  patternDiscoveryCacheKey,
  readPatternDiscoveryCache,
  readPatternDiscoveryDataFingerprint,
} from './patternDiscovery.js';
import {
  PATTERN_DISCOVERY_COVERAGE_THRESHOLDS,
  validatePatternDiscoveryRunInput,
  type PatternDiscoveryProgress,
} from './patternDiscoveryRunner.js';
import {
  markInterruptedPatternDiscoveryRuns,
  readLatestPatternDiscoveryRun,
  startPatternDiscoveryRun,
  updatePatternDiscoveryRun,
} from './patternDiscoveryRunStore.js';
import type {
  PatternDiscoveryWorkerCommand,
  PatternDiscoveryWorkerEvent,
} from './patternDiscoveryWorkerProtocol.js';

const terminalStatuses = new Set<PatternDiscoveryProgress['status']>([
  'complete',
  'stopped',
  'error',
]);

export class PatternDiscoveryCoordinator {
  private worker: ChildProcess | null = null;
  private runId: number | null = null;
  private progress: PatternDiscoveryProgress;
  private workerReachedTerminalState = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private cancelTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly database: DatabaseSync,
    private readonly workerModule: string,
    private readonly projectRoot: string,
  ) {
    markInterruptedPatternDiscoveryRuns(database);
    this.progress =
      readLatestPatternDiscoveryRun(database)?.progress ??
      this.idleProgress('No discovery run is active.');
  }

  status(): PatternDiscoveryProgress {
    return this.progress;
  }

  isActive(): boolean {
    return this.worker !== null && !terminalStatuses.has(this.progress.status);
  }

  start(
    rawPeriodDays?: number,
    rawMinN?: number,
  ): { runId: number; progress: PatternDiscoveryProgress } {
    if (this.isActive()) throw new Error('Pattern Discovery is already running.');
    const { periodDays, minN } = validatePatternDiscoveryRunInput(rawPeriodDays, rawMinN);
    const startedAt = new Date().toISOString();
    const currentFingerprint = readPatternDiscoveryDataFingerprint(this.database);
    const currentResult = readPatternDiscoveryCache(
      this.database,
      patternDiscoveryCacheKey(
        'sensitivity',
        periodDays,
        PATTERN_DISCOVERY_COVERAGE_THRESHOLDS[0],
        minN,
        MAX_PATTERN_DISCOVERY_WALLETS,
      ),
      currentFingerprint,
    );
    if (currentResult) {
      const cached: PatternDiscoveryProgress = {
        status: 'complete',
        stage: 'complete',
        message: 'The current discovery result is already cached. No recalculation was needed.',
        thresholdsTotal: PATTERN_DISCOVERY_COVERAGE_THRESHOLDS.length,
        thresholdsCompleted: PATTERN_DISCOVERY_COVERAGE_THRESHOLDS.length,
        currentThreshold: null,
        startedAt,
        completedAt: startedAt,
        heartbeatAt: startedAt,
        activeThresholds: [],
        cpuWorkersActive: 0,
        cpuWorkersTotal: 0,
        cacheHits: PATTERN_DISCOVERY_COVERAGE_THRESHOLDS.length,
        recentEvents: [{ at: startedAt, message: 'Current result found in SQLite cache.' }],
      };
      this.runId = startPatternDiscoveryRun(this.database, periodDays, minN, cached);
      this.progress = { ...cached, runId: this.runId };
      return { runId: this.runId, progress: this.progress };
    }
    const initial: PatternDiscoveryProgress = {
      status: 'preparing',
      stage: 'loading evidence',
      message: 'Starting the isolated discovery worker.',
      thresholdsTotal: PATTERN_DISCOVERY_COVERAGE_THRESHOLDS.length,
      thresholdsCompleted: 0,
      currentThreshold: null,
      startedAt,
      completedAt: null,
      heartbeatAt: startedAt,
      activeThresholds: [],
      cpuWorkersActive: 0,
      recentEvents: [{ at: startedAt, message: 'Run accepted by the API server.' }],
    };
    this.runId = startPatternDiscoveryRun(this.database, periodDays, minN, initial);
    this.progress = { ...initial, runId: this.runId };
    this.workerReachedTerminalState = false;

    const developmentWorker = this.workerModule.endsWith('.ts');
    const worker = fork(this.workerModule, [], {
      execArgv: developmentWorker ? ['--import', 'tsx'] : [],
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    this.worker = worker;
    this.startHeartbeat();
    this.progress = {
      ...this.progress,
      workerPid: worker.pid,
      message: `Worker ${worker.pid ?? 'starting'} is opening SQLite.`,
    };
    this.persist({ workerPid: worker.pid ?? null });

    worker.stdout?.on('data', (chunk) => this.recordWorkerOutput('stdout', String(chunk)));
    worker.stderr?.on('data', (chunk) => this.recordWorkerOutput('stderr', String(chunk)));
    worker.on('message', (event: PatternDiscoveryWorkerEvent) => this.handleWorkerEvent(event));
    worker.on('error', (error) => this.fail(`Discovery worker error: ${error.message}`));
    worker.on('exit', (code, signal) => {
      this.stopHeartbeat();
      this.clearCancelTimer();
      if (!this.workerReachedTerminalState) {
        this.fail(
          `Discovery worker exited unexpectedly (code ${code ?? 'none'}, signal ${signal ?? 'none'}).`,
        );
      }
      this.worker = null;
    });

    worker.send({
      type: 'run',
      runId: this.runId,
      projectRoot: this.projectRoot,
      periodDays,
      minN,
    } satisfies PatternDiscoveryWorkerCommand);
    return { runId: this.runId, progress: this.progress };
  }

  stop(): void {
    if (!this.worker || !this.isActive()) throw new Error('No Pattern Discovery run is active.');
    this.mergeProgress({
      status: 'running',
      stage: 'running engine',
      message: 'Cancellation requested; stopping active Python coverage workers.',
    });
    this.worker.send({ type: 'cancel' } satisfies PatternDiscoveryWorkerCommand);
    this.clearCancelTimer();
    this.cancelTimer = setTimeout(() => {
      if (!this.worker || !this.isActive()) return;
      this.worker.kill();
      this.workerReachedTerminalState = true;
      this.mergeProgress({
        status: 'stopped',
        stage: 'stopped',
        message: 'Discovery was force-stopped after cancellation did not finish within 15 seconds.',
        currentThreshold: null,
        activeThresholds: [],
        cpuWorkersActive: 0,
        completedAt: new Date().toISOString(),
      });
    }, 15_000);
  }

  private handleWorkerEvent(event: PatternDiscoveryWorkerEvent): void {
    if (event.type === 'progress') {
      this.mergeProgress(event.progress);
      return;
    }
    const completedAt = new Date().toISOString();
    this.workerReachedTerminalState = true;
    this.stopHeartbeat();
    this.clearCancelTimer();
    if (event.type === 'complete') {
      this.mergeProgress({
        status: 'complete',
        stage: 'complete',
        message: 'All coverage levels completed and the shared result was cached in SQLite.',
        thresholdsCompleted: PATTERN_DISCOVERY_COVERAGE_THRESHOLDS.length,
        currentThreshold: null,
        activeThresholds: [],
        cpuWorkersActive: 0,
        completedAt,
      });
    } else if (event.type === 'stopped') {
      this.mergeProgress({
        status: 'stopped',
        stage: 'stopped',
        message: event.message,
        currentThreshold: null,
        activeThresholds: [],
        cpuWorkersActive: 0,
        completedAt,
      });
    } else {
      this.fail(event.message);
    }
  }

  private mergeProgress(update: Partial<PatternDiscoveryProgress>): void {
    const now = update.heartbeatAt ?? new Date().toISOString();
    const message = update.message ?? this.progress.message;
    const priorEvents = this.progress.recentEvents ?? [];
    const recentEvents =
      message === this.progress.message
        ? priorEvents
        : [...priorEvents, { at: now, message }].slice(-12);
    this.progress = {
      ...this.progress,
      ...update,
      runId: this.runId ?? this.progress.runId,
      workerPid: this.worker?.pid ?? this.progress.workerPid,
      heartbeatAt: now,
      recentEvents,
    };
    this.persist();
  }

  private recordWorkerOutput(channel: 'stdout' | 'stderr', raw: string): void {
    for (const line of raw
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter(Boolean)) {
      console[channel === 'stderr' ? 'error' : 'log'](`[pattern-discovery:${channel}] ${line}`);
      this.mergeProgress({ message: `${channel}: ${line.slice(0, 500)}` });
    }
  }

  private fail(message: string): void {
    if (this.workerReachedTerminalState && this.progress.status === 'complete') return;
    this.workerReachedTerminalState = true;
    this.stopHeartbeat();
    this.clearCancelTimer();
    this.mergeProgress({
      status: 'error',
      stage: 'error',
      message,
      currentThreshold: null,
      activeThresholds: [],
      cpuWorkersActive: 0,
      completedAt: new Date().toISOString(),
    });
    this.persist({ error: message });
  }

  private persist(options: { workerPid?: number | null; error?: string | null } = {}): void {
    if (this.runId === null) return;
    updatePatternDiscoveryRun(this.database, this.runId, this.progress, options);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.worker || !this.isActive()) return;
      this.mergeProgress({ heartbeatAt: new Date().toISOString() });
    }, 2_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private clearCancelTimer(): void {
    if (this.cancelTimer) clearTimeout(this.cancelTimer);
    this.cancelTimer = null;
  }

  private idleProgress(message: string): PatternDiscoveryProgress {
    return {
      status: 'idle',
      stage: 'complete',
      message,
      thresholdsTotal: PATTERN_DISCOVERY_COVERAGE_THRESHOLDS.length,
      thresholdsCompleted: 0,
      currentThreshold: null,
      startedAt: null,
      completedAt: null,
      heartbeatAt: new Date().toISOString(),
      activeThresholds: [],
      cpuWorkersActive: 0,
    };
  }
}
