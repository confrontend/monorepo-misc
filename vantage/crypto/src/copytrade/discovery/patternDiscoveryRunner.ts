import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, freemem } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_PATTERN_DISCOVERY_PERIOD_DAYS,
  MAX_PATTERN_DISCOVERY_PERIOD_DAYS,
  MAX_PATTERN_DISCOVERY_WALLETS,
  patternDiscoveryCacheKey,
  readPatternDiscoveryCache,
  readPatternDiscoveryDataFingerprint,
  readPatternDiscoveryExport,
  readPatternDiscoveryExportGrid,
  type PatternDiscoveryExport,
  writePatternDiscoveryCache,
} from './patternDiscovery.js';

const execFileAsync = promisify(execFile);
const VALIDATION_FRACTION = 0.3;
const HOLDOUT_FRACTION = 0.2;
const MIN_PATTERN_PROMOTION_WALLETS = 10;
export const PATTERN_DISCOVERY_COVERAGE_THRESHOLDS = Array.from(
  { length: 11 },
  (_, index) => 50 + index * 5,
);

export type PatternDiscoveryStatus =
  'discovered candidate' | 'validation survivor' | 'rejected' | 'insufficient data';

export type PatternDiscoveryPattern = {
  source?: string;
  kind?: string;
  feature?: string;
  conditions?: unknown;
  effect?: number | null;
  discovery_sample_size?: number;
  validationStatus?: PatternDiscoveryStatus;
  validation?: { sample_size?: number; effect_vs_all?: number | null; reason?: string };
  historical_stability?: {
    status: 'stable' | 'unstable' | 'insufficient data';
    blocks: number;
    surviving_blocks: number;
    reason?: string;
  };
  reason?: string;
};

export type PatternDiscoveryReport = {
  report_version?: string;
  project: 'crypto';
  run_id?: string;
  patterns: PatternDiscoveryPattern[];
  status_counts: Record<PatternDiscoveryStatus, number>;
  minimum_n?: number;
  dataset_summary?: Record<string, unknown>;
  split: {
    method?: string;
    discovery_rows?: number;
    validation_rows?: number;
    untouched_holdout_rows?: number;
    holdout_policy?: string;
    holdout_used_for_discovery?: boolean;
    holdout_used_for_validation?: boolean;
    holdout_used_for_model_fit?: boolean;
    holdout_used_for_multiple_testing?: boolean;
    [key: string]: unknown;
  };
  language?: string;
  isolation?: Record<string, unknown>;
};

export type PatternDiscoverySensitivityPoint = {
  minimumCoveragePercent: number;
  wallets: number;
  rows: number;
  independentEntries: number;
  validationSurvivors: number;
  discoveredCandidates: number;
  promotedPatterns: number;
  historicalStablePatterns: number;
  rejected: number;
  insufficientData: number;
  reportAvailable: boolean;
  error?: string;
};

export type PatternDiscoveryCrossCoveragePattern = {
  pattern: PatternDiscoveryPattern;
  supportingCoveragePercent: number[];
};

export type PatternDiscoverySensitivity = {
  thresholds: PatternDiscoverySensitivityPoint[];
  weighting: 'equal wallet total weight';
  note: string;
  /** Cached reports by coverage level, exposed for transparent result comparison only. */
  reportsByCoverage?: Record<string, PatternDiscoveryReport>;
  /** Unique stable validation survivors repeated across at least two coverage reports. */
  crossCoveragePromotedPatterns?: PatternDiscoveryCrossCoveragePattern[];
  /** The 100% grid member, returned as a projection of the same run for legacy report consumers. */
  report?: PatternDiscoveryReport;
  execution?: {
    pythonExecutable: string;
    inputPath: string;
    outputPath: string;
    sharedRoot: string;
  };
};

export type PatternDiscoveryProgress = {
  status: 'idle' | 'preparing' | 'running' | 'complete' | 'stopped' | 'error';
  stage:
    | 'loading evidence'
    | 'building dataset'
    | 'running threshold'
    | 'running engine'
    | 'validating'
    | 'promoting'
    | 'persisting results'
    | 'complete'
    | 'stopped'
    | 'error';
  message: string;
  thresholdsTotal: number;
  thresholdsCompleted: number;
  currentThreshold: number | null;
  startedAt: string | null;
  completedAt: string | null;
  wallets?: number;
  independentEntries?: number;
  featuresCompleted?: number;
  featuresTotal?: number;
  candidatePatterns?: number;
  validationSurvivors?: number;
  historicalStablePatterns?: number;
  promotedPatterns?: number;
  heartbeatAt?: string;
  activeThresholds?: number[];
  cpuWorkersActive?: number;
  cpuWorkersTotal?: number;
  cpuThreadsPerWorker?: number;
  walletsCompleted?: number;
  walletsTotal?: number;
  cacheHits?: number;
  runId?: number;
  workerPid?: number;
  recentEvents?: Array<{ at: string; message: string }>;
};

export class PatternDiscoveryRunnerError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 503,
  ) {
    super(message);
    this.name = 'PatternDiscoveryRunnerError';
  }
}

export const validatePatternDiscoveryRunInput = (
  periodDays: number = DEFAULT_PATTERN_DISCOVERY_PERIOD_DAYS,
  minN = 10,
): { periodDays: number; minN: number } => {
  if (
    !Number.isInteger(periodDays) ||
    periodDays <= 0 ||
    periodDays > MAX_PATTERN_DISCOVERY_PERIOD_DAYS
  ) {
    throw new PatternDiscoveryRunnerError(
      `periodDays must be an integer between 1 and ${MAX_PATTERN_DISCOVERY_PERIOD_DAYS}.`,
      400,
    );
  }
  if (!Number.isInteger(minN) || minN < 2 || minN > 10_000) {
    throw new PatternDiscoveryRunnerError('minN must be an integer between 2 and 10000.', 400);
  }
  return { periodDays, minN };
};

export const resolvePatternDiscoveryPython = (
  projectRoot: string,
  sharedRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): string => {
  const configured = environment.PATTERN_DISCOVERY_PYTHON?.trim();
  if (configured) return configured;
  const candidates = patternDiscoveryPythonCandidates(projectRoot, sharedRoot, environment);
  const bundledOverride =
    environment.PATTERN_DISCOVERY_BUNDLED_PYTHON?.trim() ||
    environment.PATTERN_DISCOVERY_PYTHON_BUNDLE?.trim();
  return (
    candidates.find((candidate) => existsSync(candidate)) ??
    bundledOverride ??
    (process.platform === 'win32' ? 'python' : 'python3')
  );
};

export const patternDiscoveryPythonCandidates = (
  projectRoot: string,
  sharedRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): string[] => {
  const executable = process.platform === 'win32' ? 'python.exe' : 'python';
  const workspaceRoot = path.resolve(sharedRoot, '..', '..');
  const workspaceVenvCandidates =
    process.platform === 'win32'
      ? [
          path.join(projectRoot, '.venv', 'Scripts', executable),
          path.join(workspaceRoot, '.venv', 'Scripts', executable),
          path.join(sharedRoot, '.venv', 'Scripts', executable),
        ]
      : [
          path.join(projectRoot, '.venv', 'bin', executable),
          path.join(workspaceRoot, '.venv', 'bin', executable),
          path.join(sharedRoot, '.venv', 'bin', executable),
        ];
  const runtimeRoots = [environment.PATTERN_DISCOVERY_RUNTIME_ROOT, environment.CODEX_RUNTIME_ROOT]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  const bundledNames =
    process.platform === 'win32'
      ? ['python', path.join('python', 'python.exe'), path.join('python', 'Scripts', 'python.exe')]
      : ['python', path.join('python', 'bin', 'python'), path.join('python', 'python')];
  const configuredBundle =
    environment.PATTERN_DISCOVERY_BUNDLED_PYTHON?.trim() ||
    environment.PATTERN_DISCOVERY_PYTHON_BUNDLE?.trim();
  const configuredRuntimeCandidates = [
    ...runtimeRoots.flatMap((root) => bundledNames.map((name) => path.join(root, name))),
    ...(configuredBundle ? [configuredBundle] : []),
  ];
  const localBundleCandidates = [
    ...[projectRoot, workspaceRoot, sharedRoot].flatMap((root) =>
      process.platform === 'win32'
        ? [
            path.join(root, '.runtime', 'python.exe'),
            path.join(root, '.bundled-python', 'python.exe'),
          ]
        : [
            path.join(root, '.runtime', 'bin', 'python'),
            path.join(root, '.bundled-python', 'bin', 'python'),
          ],
    ),
  ];
  const home = environment.USERPROFILE?.trim() || environment.HOME?.trim();
  const homeBundleCandidates = home
    ? [
        path.join(
          home,
          '.cache',
          'codex-runtimes',
          'codex-primary-runtime',
          'dependencies',
          'python',
          executable,
        ),
      ]
    : [];
  return [
    ...workspaceVenvCandidates,
    ...configuredRuntimeCandidates,
    ...localBundleCandidates,
    ...homeBundleCandidates,
  ];
};

export const resolvePatternDiscoverySharedRoot = (projectRoot: string): string => {
  const direct = path.resolve(projectRoot, 'research', 'shared-pattern-discovery');
  if (existsSync(direct)) return direct;
  return path.resolve(projectRoot, '..', 'research', 'shared-pattern-discovery');
};

export const buildPatternDiscoveryCommand = (input: {
  executable: string;
  sharedRoot: string;
  inputPath: string;
  outputPath: string;
  minN: number;
  progressPath?: string;
}): { executable: string; cwd: string; args: string[]; inputPath: string; outputPath: string } => {
  const inputPath = path.resolve(input.inputPath);
  const outputPath = path.resolve(input.outputPath);
  return {
    executable: input.executable,
    cwd: path.resolve(input.sharedRoot),
    inputPath,
    outputPath,
    args: [
      '-m',
      'shared_pattern_discovery.cli',
      '--project',
      'crypto',
      '--input',
      inputPath,
      '--output',
      outputPath,
      '--min-n',
      String(input.minN),
      '--validation-fraction',
      String(VALIDATION_FRACTION),
      '--holdout-fraction',
      String(HOLDOUT_FRACTION),
      '--seed',
      '0',
      ...(input.progressPath ? ['--progress-file', path.resolve(input.progressPath)] : []),
    ],
  };
};

export const parsePatternDiscoveryReport = (raw: string): PatternDiscoveryReport => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PatternDiscoveryRunnerError(
      `Shared Python discovery returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      502,
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new PatternDiscoveryRunnerError(
      'Shared Python discovery returned a non-object report.',
      502,
    );
  }
  const report = parsed as Partial<PatternDiscoveryReport>;
  if (
    report.project !== 'crypto' ||
    !Array.isArray(report.patterns) ||
    !report.status_counts ||
    typeof report.status_counts !== 'object' ||
    !report.split ||
    typeof report.split !== 'object'
  ) {
    throw new PatternDiscoveryRunnerError(
      'Shared Python discovery returned an incomplete crypto report.',
      502,
    );
  }
  return report as PatternDiscoveryReport;
};

export const runPatternDiscoveryReport = async (
  database: DatabaseSync,
  options: {
    projectRoot: string;
    periodDays?: number;
    minN?: number;
    minimumCoveragePercent?: number;
    signal?: AbortSignal;
    onProgress?: (progress: Partial<PatternDiscoveryProgress>) => void;
    normalizedExport?: PatternDiscoveryExport;
    dataFingerprint?: string;
    cacheNormalizedExport?: boolean;
    pythonThreads?: number;
  },
): Promise<{
  report: PatternDiscoveryReport;
  execution?: {
    pythonExecutable: string;
    inputPath: string;
    outputPath: string;
    sharedRoot: string;
  };
}> => {
  const { periodDays, minN } = validatePatternDiscoveryRunInput(options.periodDays, options.minN);
  const minimumCoveragePercent = options.minimumCoveragePercent ?? 100;
  const dataFingerprint = options.dataFingerprint ?? readPatternDiscoveryDataFingerprint(database);
  const cachedReport = readPatternDiscoveryCache<PatternDiscoveryReport>(
    database,
    patternDiscoveryCacheKey(
      'report',
      periodDays,
      minimumCoveragePercent,
      minN,
      MAX_PATTERN_DISCOVERY_WALLETS,
    ),
    dataFingerprint,
  );
  if (cachedReport) {
    return { report: cachedReport };
  }
  const sharedRoot = resolvePatternDiscoverySharedRoot(options.projectRoot);
  const exportCacheKey = patternDiscoveryCacheKey(
    'export',
    periodDays,
    minimumCoveragePercent,
    undefined,
    MAX_PATTERN_DISCOVERY_WALLETS,
  );
  const cachedExport = options.normalizedExport
    ? null
    : readPatternDiscoveryCache<ReturnType<typeof readPatternDiscoveryExport>>(
        database,
        exportCacheKey,
        dataFingerprint,
      );
  const normalized =
    options.normalizedExport ??
    cachedExport ??
    readPatternDiscoveryExport(database, periodDays, undefined, minimumCoveragePercent);
  if (options.cacheNormalizedExport !== false && !cachedExport) {
    options.onProgress?.({
      stage: 'persisting results',
      message: `Saving the ${minimumCoveragePercent}% normalized dataset before discovery…`,
      wallets: Number(normalized.metadata.selected_wallet_count ?? 0),
      independentEntries: normalized.rows.length,
      heartbeatAt: new Date().toISOString(),
    });
    writePatternDiscoveryCache(database, exportCacheKey, dataFingerprint, normalized);
  }
  options.onProgress?.({
    stage: 'building dataset',
    message: `Built the ${minimumCoveragePercent}% dataset: ${normalized.metadata.selected_wallet_count} wallets, ${normalized.rows.length} independent entries.`,
    wallets: Number(normalized.metadata.selected_wallet_count ?? 0),
    independentEntries: normalized.rows.length,
    heartbeatAt: new Date().toISOString(),
  });
  if (normalized.rows.length === 0) {
    throw new PatternDiscoveryRunnerError(
      `No outcome-coverage rows meet the selected ${normalized.metadata.minimum_coverage_percent}% threshold for the selected ${periodDays}-day period.`,
      422,
    );
  }
  const runRoot = path.join(
    sharedRoot,
    'runs',
    'crypto',
    `pattern-discovery-${periodDays}d-${Date.now()}`,
  );
  mkdirSync(runRoot, { recursive: true });
  const inputPath = path.join(runRoot, 'normalized-export.json');
  const outputPath = path.join(runRoot, 'report.json');
  const progressPath = path.join(runRoot, 'progress.json');
  writeFileSync(inputPath, JSON.stringify(normalized, null, 2), 'utf8');
  const executable = resolvePatternDiscoveryPython(options.projectRoot, sharedRoot);
  const command = buildPatternDiscoveryCommand({
    executable,
    sharedRoot,
    inputPath,
    outputPath,
    minN,
    progressPath,
  });
  const progressTimer = setInterval(() => {
    try {
      const raw = readFileSync(progressPath, 'utf8');
      const update = JSON.parse(raw) as Partial<PatternDiscoveryProgress>;
      options.onProgress?.({ ...update, heartbeatAt: new Date().toISOString() });
    } catch {
      options.onProgress?.({
        stage: 'running engine',
        message: `Running the shared Python engine for ${minimumCoveragePercent}% coverage…`,
        heartbeatAt: new Date().toISOString(),
      });
    }
  }, 500);
  try {
    await execFileAsync(command.executable, command.args, {
      cwd: command.cwd,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      signal: options.signal,
      env: {
        ...process.env,
        OMP_NUM_THREADS: String(options.pythonThreads ?? 1),
        OPENBLAS_NUM_THREADS: String(options.pythonThreads ?? 1),
        MKL_NUM_THREADS: String(options.pythonThreads ?? 1),
        NUMEXPR_NUM_THREADS: String(options.pythonThreads ?? 1),
      },
    });
  } catch (error) {
    const detail =
      error &&
      typeof error === 'object' &&
      'stderr' in error &&
      typeof error.stderr === 'string' &&
      error.stderr.trim()
        ? error.stderr.trim()
        : error instanceof Error
          ? error.message
          : String(error);
    const dependencyHint = /No module named ['"]numpy['"]|ModuleNotFoundError/.test(detail)
      ? 'The selected runtime is missing the required NumPy dependency.'
      : '';
    throw new PatternDiscoveryRunnerError(
      `Shared Python discovery could not run with ${executable}. ${dependencyHint} Configure PATTERN_DISCOVERY_PYTHON (highest priority), PATTERN_DISCOVERY_BUNDLED_PYTHON, PATTERN_DISCOVERY_RUNTIME_ROOT, or a workspace .venv. ${detail}`,
    );
  } finally {
    clearInterval(progressTimer);
  }
  let reportRaw: string;
  try {
    reportRaw = readFileSync(outputPath, 'utf8');
  } catch (error) {
    throw new PatternDiscoveryRunnerError(
      `Shared Python discovery completed without a readable report at ${outputPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const report = parsePatternDiscoveryReport(reportRaw);
  options.onProgress?.({
    stage: 'persisting results',
    message: `Saving validated ${minimumCoveragePercent}% results and updating the run cache…`,
    heartbeatAt: new Date().toISOString(),
  });
  writePatternDiscoveryCache(
    database,
    patternDiscoveryCacheKey(
      'report',
      periodDays,
      minimumCoveragePercent,
      minN,
      MAX_PATTERN_DISCOVERY_WALLETS,
    ),
    dataFingerprint,
    report,
  );
  return {
    report,
    execution: { pythonExecutable: executable, inputPath, outputPath, sharedRoot },
  };
};

const sensitivityPoint = (
  minimumCoveragePercent: number,
  report: PatternDiscoveryReport,
): PatternDiscoverySensitivityPoint => {
  const summary = report.dataset_summary ?? {};
  const counts = report.status_counts;
  const historicalStablePatterns = (report.patterns ?? []).filter(
    (pattern) => pattern.historical_stability?.status === 'stable',
  ).length;
  const promotedPatterns = (report.patterns ?? []).filter(
    (pattern) =>
      pattern.validationStatus === 'validation survivor' &&
      pattern.historical_stability?.status === 'stable',
  ).length;
  return {
    minimumCoveragePercent,
    wallets: Number(summary.wallets ?? 0),
    rows: Number(summary.rows ?? 0),
    independentEntries: Number(summary.independence_groups ?? 0),
    validationSurvivors: Number(counts['validation survivor'] ?? 0),
    discoveredCandidates: (report.patterns ?? []).length,
    promotedPatterns,
    historicalStablePatterns,
    rejected: Number(counts.rejected ?? 0),
    insufficientData: Number(counts['insufficient data'] ?? 0),
    reportAvailable: true,
  };
};

const patternIdentity = (pattern: PatternDiscoveryPattern): string =>
  JSON.stringify({
    feature: pattern.feature ?? null,
    kind: pattern.kind ?? null,
    conditions: pattern.conditions ?? null,
  });

export const deriveCrossCoveragePromotedPatterns = (
  reports: Map<number, PatternDiscoveryReport>,
): PatternDiscoveryCrossCoveragePattern[] => {
  const byIdentity = new Map<
    string,
    { pattern: PatternDiscoveryPattern; supportingCoveragePercent: number[] }
  >();
  for (const [threshold, report] of [...reports.entries()].sort(
    ([left], [right]) => left - right,
  )) {
    if (Number(report.dataset_summary?.wallets ?? 0) < MIN_PATTERN_PROMOTION_WALLETS) continue;
    const seenInReport = new Set<string>();
    for (const pattern of report.patterns ?? []) {
      if (
        pattern.validationStatus !== 'validation survivor' ||
        pattern.historical_stability?.status !== 'stable'
      )
        continue;
      const identity = patternIdentity(pattern);
      if (seenInReport.has(identity)) continue;
      seenInReport.add(identity);
      const current = byIdentity.get(identity);
      if (current) {
        current.pattern = pattern;
        current.supportingCoveragePercent.push(threshold);
      } else {
        byIdentity.set(identity, {
          pattern,
          supportingCoveragePercent: [threshold],
        });
      }
    }
  }
  return [...byIdentity.values()]
    .filter((entry) => entry.supportingCoveragePercent.length >= 2)
    .sort((left, right) => {
      const support =
        right.supportingCoveragePercent.length - left.supportingCoveragePercent.length;
      return support || String(left.pattern.feature).localeCompare(String(right.pattern.feature));
    });
};

const patternDiscoveryWorkerCount = (taskCount: number): number => {
  const configured = Number(process.env.PATTERN_DISCOVERY_WORKERS);
  const cpuLimit = Math.max(1, availableParallelism());
  // A Python process can hold the normalized rows plus candidate/validation arrays. Bound by
  // available memory so "use every core" never turns into paging or an out-of-memory failure.
  const memoryLimit = Math.max(1, Math.floor(freemem() / (1024 * 1024 * 1024)));
  const requested = Number.isInteger(configured) && configured > 0 ? configured : cpuLimit;
  return Math.max(1, Math.min(taskCount, requested, cpuLimit, memoryLimit));
};

/** Build all datasets once, then run independent coverage levels with bounded CPU parallelism.
 * Unchanged reports and the completed grid result are returned from SQLite immediately. */
export const runPatternDiscoverySensitivity = async (
  database: DatabaseSync,
  options: {
    projectRoot: string;
    periodDays?: number;
    minN?: number;
    signal?: AbortSignal;
    onProgress?: (progress: {
      threshold: number;
      index: number;
      total: number;
      phase: 'starting' | 'complete';
    }) => void;
    onEngineProgress?: (progress: Partial<PatternDiscoveryProgress>) => void;
  },
): Promise<PatternDiscoverySensitivity> => {
  const thresholds = PATTERN_DISCOVERY_COVERAGE_THRESHOLDS;
  const { periodDays, minN } = validatePatternDiscoveryRunInput(options.periodDays, options.minN);
  const dataFingerprint = readPatternDiscoveryDataFingerprint(database);
  const sensitivityCacheKey = patternDiscoveryCacheKey(
    'sensitivity',
    periodDays,
    50,
    minN,
    MAX_PATTERN_DISCOVERY_WALLETS,
  );
  const cachedSensitivity = readPatternDiscoveryCache<PatternDiscoverySensitivity>(
    database,
    sensitivityCacheKey,
    dataFingerprint,
  );
  if (cachedSensitivity) {
    options.onEngineProgress?.({
      stage: 'complete',
      message: 'Loaded the unchanged 11-level discovery result from SQLite.',
      thresholdsCompleted: thresholds.length,
      thresholdsTotal: thresholds.length,
      cacheHits: thresholds.length,
      heartbeatAt: new Date().toISOString(),
    });
    return cachedSensitivity;
  }

  const reports = new Map<number, PatternDiscoveryReport>();
  let cacheHits = 0;
  for (const threshold of thresholds) {
    const report = readPatternDiscoveryCache<PatternDiscoveryReport>(
      database,
      patternDiscoveryCacheKey(
        'report',
        periodDays,
        threshold,
        minN,
        MAX_PATTERN_DISCOVERY_WALLETS,
      ),
      dataFingerprint,
    );
    if (report) {
      reports.set(threshold, report);
      cacheHits += 1;
    }
  }
  const missingThresholds = thresholds.filter((threshold) => !reports.has(threshold));
  options.onEngineProgress?.({
    stage: 'loading evidence',
    message: `${cacheHits} coverage levels cached; preparing shared evidence for ${missingThresholds.length} remaining levels.`,
    thresholdsCompleted: cacheHits,
    thresholdsTotal: thresholds.length,
    cacheHits,
    heartbeatAt: new Date().toISOString(),
  });

  const exports =
    missingThresholds.length === 0
      ? new Map<number, PatternDiscoveryExport>()
      : readPatternDiscoveryExportGrid(
          database,
          periodDays,
          MAX_PATTERN_DISCOVERY_WALLETS,
          missingThresholds,
          (progress) =>
            options.onEngineProgress?.({
              stage: 'building dataset',
              message: progress.message,
              thresholdsCompleted: cacheHits,
              thresholdsTotal: thresholds.length,
              wallets: progress.walletsTotal,
              walletsCompleted: progress.walletsCompleted,
              walletsTotal: progress.walletsTotal,
              independentEntries: progress.independentEntries,
              cacheHits,
              heartbeatAt: new Date().toISOString(),
            }),
        );

  const fullCoverageExport = exports.get(100);
  if (fullCoverageExport) {
    writePatternDiscoveryCache(
      database,
      patternDiscoveryCacheKey('export', periodDays, 100, undefined, MAX_PATTERN_DISCOVERY_WALLETS),
      dataFingerprint,
      fullCoverageExport,
    );
  }

  const workerTotal = patternDiscoveryWorkerCount(missingThresholds.length || 1);
  const cpuThreadsPerWorker = Math.max(1, Math.floor(availableParallelism() / workerTotal));
  const activeThresholds = new Set<number>();
  let nextTask = 0;
  let completed = cacheHits;
  let finalReport: PatternDiscoveryReport | undefined;
  let finalExecution:
    | { pythonExecutable: string; inputPath: string; outputPath: string; sharedRoot: string }
    | undefined;
  const unavailable = new Map<number, PatternDiscoverySensitivityPoint>();
  const runWorker = async (): Promise<void> => {
    while (true) {
      const taskIndex = nextTask;
      nextTask += 1;
      const minimumCoveragePercent = missingThresholds[taskIndex];
      if (minimumCoveragePercent === undefined) return;
      if (options.signal?.aborted)
        throw new PatternDiscoveryRunnerError('Pattern discovery was cancelled.', 499);
      activeThresholds.add(minimumCoveragePercent);
      options.onProgress?.({
        threshold: minimumCoveragePercent,
        index: completed,
        total: thresholds.length,
        phase: 'starting',
      });
      options.onEngineProgress?.({
        stage: 'running threshold',
        message: `Running coverage levels in parallel: ${[...activeThresholds].sort((a, b) => a - b).join('%, ')}%.`,
        thresholdsCompleted: completed,
        thresholdsTotal: thresholds.length,
        currentThreshold: minimumCoveragePercent,
        activeThresholds: [...activeThresholds].sort((a, b) => a - b),
        cpuWorkersActive: activeThresholds.size,
        cpuWorkersTotal: workerTotal,
        cpuThreadsPerWorker,
        cacheHits,
        heartbeatAt: new Date().toISOString(),
      });
      try {
        const normalized = exports.get(minimumCoveragePercent);
        if (!normalized)
          throw new Error(`Missing shared ${minimumCoveragePercent}% normalized dataset.`);
        const { report, execution } = await runPatternDiscoveryReport(database, {
          ...options,
          periodDays,
          minN,
          minimumCoveragePercent,
          normalizedExport: normalized,
          dataFingerprint,
          cacheNormalizedExport: false,
          pythonThreads: cpuThreadsPerWorker,
          onProgress: (update) =>
            options.onEngineProgress?.({
              ...update,
              currentThreshold: minimumCoveragePercent,
              activeThresholds: [...activeThresholds].sort((a, b) => a - b),
              cpuWorkersActive: activeThresholds.size,
              cpuWorkersTotal: workerTotal,
              cpuThreadsPerWorker,
              thresholdsCompleted: completed,
              thresholdsTotal: thresholds.length,
              cacheHits,
            }),
        });
        reports.set(minimumCoveragePercent, report);
        if (minimumCoveragePercent === thresholds[thresholds.length - 1]) {
          finalReport = report;
          finalExecution = execution;
        }
      } catch (error) {
        if (error instanceof PatternDiscoveryRunnerError && error.statusCode === 422) {
          unavailable.set(minimumCoveragePercent, {
            minimumCoveragePercent,
            wallets: 0,
            rows: 0,
            independentEntries: 0,
            validationSurvivors: 0,
            discoveredCandidates: 0,
            promotedPatterns: 0,
            historicalStablePatterns: 0,
            rejected: 0,
            insufficientData: 0,
            reportAvailable: false,
            error: error.message,
          });
        } else {
          throw error;
        }
      } finally {
        activeThresholds.delete(minimumCoveragePercent);
        completed += 1;
        options.onProgress?.({
          threshold: minimumCoveragePercent,
          index: completed,
          total: thresholds.length,
          phase: 'complete',
        });
        options.onEngineProgress?.({
          stage: completed === thresholds.length ? 'promoting' : 'running threshold',
          message:
            completed === thresholds.length
              ? 'All coverage levels finished; finalizing cross-coverage results.'
              : `${completed}/${thresholds.length} coverage levels complete; ${activeThresholds.size} workers active.`,
          thresholdsCompleted: completed,
          thresholdsTotal: thresholds.length,
          currentThreshold: null,
          activeThresholds: [...activeThresholds].sort((a, b) => a - b),
          cpuWorkersActive: activeThresholds.size,
          cpuWorkersTotal: workerTotal,
          cpuThreadsPerWorker,
          cacheHits,
          heartbeatAt: new Date().toISOString(),
        });
      }
    }
  };
  await Promise.all(Array.from({ length: workerTotal }, () => runWorker()));

  finalReport ??= reports.get(100);
  const points = thresholds.map((threshold) => {
    const report = reports.get(threshold);
    return report ? sensitivityPoint(threshold, report) : unavailable.get(threshold)!;
  });
  const result: PatternDiscoverySensitivity = {
    thresholds: points,
    weighting: 'equal wallet total weight',
    note: 'Each wallet contributes equal total weight; multiple exits from one buy are aggregated into one independent entry before discovery.',
    reportsByCoverage: Object.fromEntries(
      [...reports.entries()].map(([threshold, report]) => [String(threshold), report]),
    ),
    crossCoveragePromotedPatterns: deriveCrossCoveragePromotedPatterns(reports),
    report: finalReport,
    execution: finalExecution,
  };
  options.onEngineProgress?.({
    stage: 'persisting results',
    message: 'Saving the complete 11-level discovery result in SQLite.',
    thresholdsCompleted: thresholds.length,
    thresholdsTotal: thresholds.length,
    cpuWorkersActive: 0,
    cpuWorkersTotal: workerTotal,
    cpuThreadsPerWorker,
    cacheHits,
    heartbeatAt: new Date().toISOString(),
  });
  writePatternDiscoveryCache(database, sensitivityCacheKey, dataFingerprint, result);
  return result;
};
