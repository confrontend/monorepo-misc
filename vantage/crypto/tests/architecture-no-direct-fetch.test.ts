import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards the point of the centralized Data tab: Pattern Research, Decision Engine, and Live
// Evaluation must only ever read data the Data workflow already fetched. If any of them start
// importing a fetch-triggering module again, the scattered per-tab fetch controls this task
// removed would effectively come back.

// This file compiles to dist/tests/*.test.js, two levels below the repo root, so source paths
// must be resolved from there, not from the TypeScript source location.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const FETCH_TRIGGERING_MODULES = [
  "screening/fetch.js'",
  "screening/fetch.ts'",
  "screening/statsFetch.js'",
  "screening/statsFetch.ts'",
  "simulation/copySimulationDune.js'",
  "simulation/copySimulationDune.ts'",
];

const ANALYSIS_SOURCE_FILES = [
  'src/copytrade/discovery/patternDiscovery.ts',
  'src/copytrade/experimentalDecision.ts',
  'src/copytrade/liveEvaluation.ts',
];

test('analysis modules do not import any GMGN/Dune fetch-triggering module', () => {
  for (const relativePath of ANALYSIS_SOURCE_FILES) {
    const contents = readFileSync(path.join(repoRoot, relativePath), 'utf8');
    for (const forbidden of FETCH_TRIGGERING_MODULES) {
      assert.ok(
        !contents.includes(forbidden),
        `${relativePath} must not import ${forbidden.replace(/'$/, '')}`,
      );
    }
  }
});

const FETCH_TRIGGERING_ROUTES = [
  '/api/copytrade/fetch',
  '/api/copytrade/stats/fetch',
  '/api/copytrade/copy-simulation/run',
];

const UI_ANALYSIS_COMPONENTS = [
  'ui/components/ExperimentalDecisionLab.tsx',
  'ui/components/LiveEvaluation.tsx',
];

test('the Decision Engine and Live Evaluation UI components never call a fetch-triggering route directly', () => {
  for (const relativePath of UI_ANALYSIS_COMPONENTS) {
    const contents = readFileSync(path.join(repoRoot, relativePath), 'utf8');
    for (const route of FETCH_TRIGGERING_ROUTES) {
      assert.ok(
        !contents.includes(route),
        `${relativePath} must not call ${route} directly -- production fetching belongs to the Data tab`,
      );
    }
  }
});

// Pattern Research's fetch controls live inline in App.tsx rather than a dedicated component, so
// it is checked separately: it may still legitimately read status/coverage from the Data workflow
// endpoints, but never call a route that itself triggers a GMGN or Dune fetch.
test('App.tsx no longer wires Pattern Research to a direct fetch-triggering route', () => {
  const contents = readFileSync(path.join(repoRoot, 'ui/App.tsx'), 'utf8');
  for (const route of FETCH_TRIGGERING_ROUTES) {
    assert.ok(
      !contents.includes(`'${route}`) && !contents.includes(`"${route}`),
      `ui/App.tsx must not call ${route} directly -- production fetching belongs to the Data tab`,
    );
  }
});
