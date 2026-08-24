import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_PATTERN_DISCOVERY_PERIOD_DAYS,
  MAX_PATTERN_DISCOVERY_PERIOD_DAYS,
  readPatternDiscoveryExport,
} from './patternDiscovery.js';

const execFileAsync = promisify(execFile);
const VALIDATION_FRACTION = 0.3;
const HOLDOUT_FRACTION = 0.2;
const RUN_TIMEOUT_MS = 120_000;

export type PatternDiscoveryStatus = 'discovered candidate' | 'validation survivor' | 'rejected' | 'insufficient data';

export type PatternDiscoveryPattern = {
  source?: string;
  kind?: string;
  feature?: string;
  conditions?: unknown;
  effect?: number | null;
  discovery_sample_size?: number;
  validationStatus?: PatternDiscoveryStatus;
  validation?: { sample_size?: number; effect_vs_all?: number | null; reason?: string };
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

export class PatternDiscoveryRunnerError extends Error {
  constructor(message: string, public readonly statusCode = 503) {
    super(message);
    this.name = 'PatternDiscoveryRunnerError';
  }
}

export const validatePatternDiscoveryRunInput = (
  periodDays: number = DEFAULT_PATTERN_DISCOVERY_PERIOD_DAYS,
  minN = 10,
): { periodDays: number; minN: number } => {
  if (!Number.isInteger(periodDays) || periodDays <= 0 || periodDays > MAX_PATTERN_DISCOVERY_PERIOD_DAYS) {
    throw new PatternDiscoveryRunnerError(`periodDays must be an integer between 1 and ${MAX_PATTERN_DISCOVERY_PERIOD_DAYS}.`, 400);
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
  const bundledOverride = environment.PATTERN_DISCOVERY_BUNDLED_PYTHON?.trim() || environment.PATTERN_DISCOVERY_PYTHON_BUNDLE?.trim();
  return candidates.find((candidate) => existsSync(candidate)) ?? bundledOverride ?? (process.platform === 'win32' ? 'python' : 'python3');
};

export const patternDiscoveryPythonCandidates = (
  projectRoot: string,
  sharedRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): string[] => {
  const executable = process.platform === 'win32' ? 'python.exe' : 'python';
  const workspaceRoot = path.resolve(sharedRoot, '..', '..');
  const workspaceVenvCandidates = process.platform === 'win32'
    ? [path.join(projectRoot, '.venv', 'Scripts', executable), path.join(workspaceRoot, '.venv', 'Scripts', executable), path.join(sharedRoot, '.venv', 'Scripts', executable)]
    : [path.join(projectRoot, '.venv', 'bin', executable), path.join(workspaceRoot, '.venv', 'bin', executable), path.join(sharedRoot, '.venv', 'bin', executable)];
  const runtimeRoots = [environment.PATTERN_DISCOVERY_RUNTIME_ROOT, environment.CODEX_RUNTIME_ROOT]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  const bundledNames = process.platform === 'win32'
    ? ['python', path.join('python', 'python.exe'), path.join('python', 'Scripts', 'python.exe')]
    : ['python', path.join('python', 'bin', 'python'), path.join('python', 'python')];
  const configuredBundle = environment.PATTERN_DISCOVERY_BUNDLED_PYTHON?.trim() || environment.PATTERN_DISCOVERY_PYTHON_BUNDLE?.trim();
  const configuredRuntimeCandidates = [
    ...runtimeRoots.flatMap((root) => bundledNames.map((name) => path.join(root, name))),
    ...(configuredBundle ? [configuredBundle] : []),
  ];
  const localBundleCandidates = [
    ...[projectRoot, workspaceRoot, sharedRoot].flatMap((root) => process.platform === 'win32'
      ? [path.join(root, '.runtime', 'python.exe'), path.join(root, '.bundled-python', 'python.exe')]
      : [path.join(root, '.runtime', 'bin', 'python'), path.join(root, '.bundled-python', 'bin', 'python')]),
  ];
  const home = environment.USERPROFILE?.trim() || environment.HOME?.trim();
  const homeBundleCandidates = home
    ? [path.join(home, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', executable)]
    : [];
  return [...workspaceVenvCandidates, ...configuredRuntimeCandidates, ...localBundleCandidates, ...homeBundleCandidates];
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
}): { executable: string; cwd: string; args: string[]; inputPath: string; outputPath: string } => {
  const inputPath = path.resolve(input.inputPath);
  const outputPath = path.resolve(input.outputPath);
  return {
    executable: input.executable,
    cwd: path.resolve(input.sharedRoot),
    inputPath,
    outputPath,
    args: [
      '-m', 'shared_pattern_discovery.cli',
      '--project', 'crypto',
      '--input', inputPath,
      '--output', outputPath,
      '--min-n', String(input.minN),
      '--validation-fraction', String(VALIDATION_FRACTION),
      '--holdout-fraction', String(HOLDOUT_FRACTION),
      '--seed', '0',
    ],
  };
};

export const parsePatternDiscoveryReport = (raw: string): PatternDiscoveryReport => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PatternDiscoveryRunnerError(`Shared Python discovery returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`, 502);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new PatternDiscoveryRunnerError('Shared Python discovery returned a non-object report.', 502);
  }
  const report = parsed as Partial<PatternDiscoveryReport>;
  if (report.project !== 'crypto' || !Array.isArray(report.patterns) || !report.status_counts || typeof report.status_counts !== 'object' || !report.split || typeof report.split !== 'object') {
    throw new PatternDiscoveryRunnerError('Shared Python discovery returned an incomplete crypto report.', 502);
  }
  return report as PatternDiscoveryReport;
};

export const runPatternDiscoveryReport = async (
  database: DatabaseSync,
  options: { projectRoot: string; periodDays?: number; minN?: number; minimumCoveragePercent?: number },
): Promise<{ report: PatternDiscoveryReport; execution: { pythonExecutable: string; inputPath: string; outputPath: string; sharedRoot: string } }> => {
  const { periodDays, minN } = validatePatternDiscoveryRunInput(options.periodDays, options.minN);
  const sharedRoot = resolvePatternDiscoverySharedRoot(options.projectRoot);
  const normalized = readPatternDiscoveryExport(database, periodDays, undefined, options.minimumCoveragePercent ?? 100);
  if (normalized.rows.length === 0) {
    throw new PatternDiscoveryRunnerError(`No outcome-coverage rows meet the selected ${normalized.metadata.minimum_coverage_percent}% threshold for the selected ${periodDays}-day period.`, 422);
  }
  const runRoot = path.join(sharedRoot, 'runs', 'crypto', `pattern-discovery-${periodDays}d-${Date.now()}`);
  mkdirSync(runRoot, { recursive: true });
  const inputPath = path.join(runRoot, 'normalized-export.json');
  const outputPath = path.join(runRoot, 'report.json');
  writeFileSync(inputPath, JSON.stringify(normalized, null, 2), 'utf8');
  const executable = resolvePatternDiscoveryPython(options.projectRoot, sharedRoot);
  const command = buildPatternDiscoveryCommand({ executable, sharedRoot, inputPath, outputPath, minN });
  try {
    await execFileAsync(command.executable, command.args, {
      cwd: command.cwd,
      timeout: RUN_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    const detail = error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string' && error.stderr.trim()
      ? error.stderr.trim()
      : error instanceof Error ? error.message : String(error);
    const dependencyHint = /No module named ['"]numpy['"]|ModuleNotFoundError/.test(detail)
      ? 'The selected runtime is missing the required NumPy dependency.'
      : '';
    throw new PatternDiscoveryRunnerError(`Shared Python discovery could not run with ${executable}. ${dependencyHint} Configure PATTERN_DISCOVERY_PYTHON (highest priority), PATTERN_DISCOVERY_BUNDLED_PYTHON, PATTERN_DISCOVERY_RUNTIME_ROOT, or a workspace .venv. ${detail}`);
  }
  let reportRaw: string;
  try {
    reportRaw = readFileSync(outputPath, 'utf8');
  } catch (error) {
    throw new PatternDiscoveryRunnerError(`Shared Python discovery completed without a readable report at ${outputPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    report: parsePatternDiscoveryReport(reportRaw),
    execution: { pythonExecutable: executable, inputPath, outputPath, sharedRoot },
  };
};
