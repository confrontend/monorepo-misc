/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'Circular dependencies make the application graph hard to reason about.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'platform-does-not-depend-on-application-layers',
      comment: 'Platform services are foundational and must not depend on scripts, UI, or the browser extension.',
      severity: 'error',
      from: { path: '^src/platform' },
      to: { path: '^(src/scripts|ui|extension)' },
    },
    {
      name: 'domain-does-not-depend-on-ui-or-extension',
      comment: 'Domain and provider code must remain usable without the UI or browser extension.',
      severity: 'error',
      from: { path: '^src' },
      to: { path: '^(ui|extension)' },
    },
    {
      name: 'ui-does-not-depend-on-server-entrypoints',
      comment: 'The UI may call the HTTP API, but must not import server entrypoints or CLI code.',
      severity: 'error',
      from: { path: '^ui' },
      to: { path: '^src/scripts' },
    },
    {
      name: 'live-evaluation-does-not-read-decision-lab-or-dune',
      comment:
        'Live Evaluation is a GMGN-only estimate that must never fetch Dune data or read a saved ' +
        'Decision Lab score into its own computation. The history module reads finished evaluation ' +
        'results separately -- this rule keeps liveEvaluation.ts structurally unable to import back ' +
        'into that comparison module or into any Dune-dependent code.',
      severity: 'error',
      from: { path: '^src/copytrade/liveEvaluation\\.ts$' },
      to: { path: '^(src/copytrade/liveEvaluationHistory\\.ts$|src/dune)' },
    },
    {
      name: 'canonical-wallet-features-do-not-depend-on-dune',
      comment:
        'Canonical GMGN wallet features must remain reproducible from saved GMGN evidence. ' +
        'Dune belongs on the future-outcome and validation side of the architecture.',
      severity: 'error',
      from: { path: '^src/copytrade/features' },
      to: { path: '^(src/dune|src/copytrade/simulation)' },
    },
    {
      name: 'analysis-modules-do-not-trigger-production-fetches',
      comment:
        'Pattern Research, Decision Engine, and Live Evaluation must only read data that the ' +
        'centralized Data workflow already fetched -- they must never import the GMGN activity/stats ' +
        'fetchers or the Dune copy-simulation trigger themselves, since that would reintroduce the ' +
        'scattered per-tab fetch controls the Data tab replaced.',
      severity: 'error',
      from: {
        path: '^src/copytrade/(discovery/patternDiscovery\\.ts$|experimentalDecision\\.ts$|liveEvaluation\\.ts$)',
      },
      to: {
        path: '^src/copytrade/(screening/(fetch|statsFetch)\\.ts$|simulation/copySimulationDune\\.ts$)',
      },
    },
  ],
  options: {
    doNotFollow: [
      'node_modules',
      'dist',
      'dist-ui',
      'build',
      'coverage',
      'graphify-out',
      'src/.data',
      '.secrets',
      'ui-mockups',
      'research',
    ],
    exclude: [
      '(^|/)(node_modules|dist|dist-ui|build|coverage|graphify-out|src/.data|.secrets|ui-mockups|research)(/|$)',
      '\\.(generated|d)\\.(js|ts|tsx)$',
    ],
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    moduleSystems: ['es6', 'cjs'],
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      mainFields: ['module', 'main'],
    },
  },
};
