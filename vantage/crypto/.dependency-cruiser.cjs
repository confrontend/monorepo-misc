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
