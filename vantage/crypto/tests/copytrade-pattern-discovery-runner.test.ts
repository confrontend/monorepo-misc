import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tmpdir } from 'node:os';
import {
  buildPatternDiscoveryCommand,
  parsePatternDiscoveryReport,
  patternDiscoveryPythonCandidates,
  resolvePatternDiscoveryPython,
  validatePatternDiscoveryRunInput,
} from '../src/copytrade/discovery/patternDiscoveryRunner.js';

test('builds an isolated crypto CLI command with chronological holdout settings', () => {
  const command = buildPatternDiscoveryCommand({
    executable: 'python-test',
    sharedRoot: path.resolve('research/shared-pattern-discovery'),
    inputPath: 'research/shared-pattern-discovery/runs/crypto/input.json',
    outputPath: 'research/shared-pattern-discovery/runs/crypto/report.json',
    minN: 17,
  });
  assert.equal(command.executable, 'python-test');
  assert.equal(command.cwd, path.resolve('research/shared-pattern-discovery'));
  assert.equal(command.args[0], '-m');
  assert.equal(command.args[1], 'shared_pattern_discovery.cli');
  assert.deepEqual(
    command.args.slice(command.args.indexOf('--project'), command.args.indexOf('--project') + 2),
    ['--project', 'crypto'],
  );
  assert.deepEqual(
    command.args.slice(command.args.indexOf('--min-n'), command.args.indexOf('--min-n') + 2),
    ['--min-n', '17'],
  );
  assert.deepEqual(
    command.args.slice(
      command.args.indexOf('--holdout-fraction'),
      command.args.indexOf('--holdout-fraction') + 2,
    ),
    ['--holdout-fraction', '0.2'],
  );
  assert.ok(command.args.includes('--validation-fraction'));
  assert.equal(command.args.includes('--database'), false);
});

test('validates runner inputs and parses only complete crypto reports', () => {
  assert.deepEqual(validatePatternDiscoveryRunInput(30, 10), { periodDays: 30, minN: 10 });
  assert.throws(() => validatePatternDiscoveryRunInput(91, 10), /periodDays must be an integer/);
  assert.throws(() => validatePatternDiscoveryRunInput(30, 1), /minN must be an integer/);
  const report = parsePatternDiscoveryReport(
    JSON.stringify({
      project: 'crypto',
      patterns: [],
      status_counts: {
        'discovered candidate': 0,
        'validation survivor': 0,
        rejected: 0,
        'insufficient data': 0,
      },
      split: { method: 'chronological', untouched_holdout_rows: 2 },
    }),
  );
  assert.equal(report.project, 'crypto');
  assert.equal(report.split.untouched_holdout_rows, 2);
  assert.throws(
    () =>
      parsePatternDiscoveryReport(
        '{"project":"unusualwhales","patterns":[],"status_counts":{},"split":{}}',
      ),
    /incomplete crypto report/,
  );
});

test('configured Python executable takes precedence over fallback paths', () => {
  assert.equal(
    resolvePatternDiscoveryPython(
      'C:/workspace',
      'C:/workspace/research/shared-pattern-discovery',
      { PATTERN_DISCOVERY_PYTHON: 'C:/tools/python.exe' },
    ),
    'C:/tools/python.exe',
  );
});

test('portable home-based bundled runtime is considered after workspace venvs', () => {
  const home = 'C:/portable-home';
  const candidates = patternDiscoveryPythonCandidates(
    'C:/workspace/crypto',
    'C:/workspace/research/shared-pattern-discovery',
    { USERPROFILE: home },
  );
  assert.equal(
    candidates.at(-1),
    path.join(
      home,
      '.cache',
      'codex-runtimes',
      'codex-primary-runtime',
      'dependencies',
      'python',
      'python.exe',
    ),
  );
  const root = path.join(tmpdir(), `pattern-discovery-runtime-${Date.now()}`);
  const bundled = path.join(
    root,
    '.cache',
    'codex-runtimes',
    'codex-primary-runtime',
    'dependencies',
    'python',
    'python.exe',
  );
  try {
    mkdirSync(path.dirname(bundled), { recursive: true });
    writeFileSync(bundled, 'placeholder');
    assert.equal(
      resolvePatternDiscoveryPython(
        'C:/workspace/crypto',
        'C:/workspace/research/shared-pattern-discovery',
        { USERPROFILE: root },
      ),
      bundled,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
