import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dist-ui/**',
      'node_modules/**',
      '.data/**',
      '.secrets/**',
      'graphify-out/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Explicit project list (not projectService's auto-discovery), because this repo has two
        // sibling tsconfigs by non-default names -- tsconfig.json (src/tests) and tsconfig.ui.json
        // (ui/**) -- and projectService only auto-finds conventionally-named tsconfig.json files.
        project: ['./tsconfig.json', './tsconfig.ui.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      // This codebase's own convention: an intentionally unawaited promise is marked `void
      // asyncFn()` at the call site (see ui/main.tsx's `void loadScrutiny()` etc.) rather than
      // silently dropped. This rule enforces exactly that convention instead of just hoping for it.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'off', // used deliberately at known-present DOM/lookup sites throughout ui/main.tsx
      '@typescript-eslint/restrict-template-expressions': 'off', // this codebase template-interpolates numbers/nullables freely in log/detail strings
    },
  },
  {
    // node:test's test()/describe() intentionally return a promise that the test runner manages
    // itself -- calling them unawaited at module top level is the idiomatic node:test pattern,
    // not a dropped promise.
    files: ['tests/**/*.ts'],
    rules: { '@typescript-eslint/no-floating-promises': 'off' },
  },
  {
    // Root-level tooling config files aren't covered by either tsconfig's `include`, so they
    // can't get type-aware linting -- fall back to the non-type-checked rule set for just these.
    files: ['*.config.{js,mjs,ts}', 'scripts/**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // The browser extension is plain JS with its own runtime (chrome.* APIs, content-script/
    // service-worker globals), not part of either tsconfig -- same treatment as config files.
    files: ['extension/**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { ...globals.webextensions, ...globals.browser } },
  },
  {
    files: ['ui/**/*.{ts,tsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...react.configs.flat['jsx-runtime'].rules,
      ...reactHooks.configs['recommended-latest'].rules,
      'react/prop-types': 'off', // TypeScript already checks prop shapes
      'react/no-unescaped-entities': 'off', // this app writes plain apostrophes/quotes in JSX text throughout; not a real bug
      // A real signal (React docs steer away from this pattern), but this app has ~14 existing,
      // working effects that sync UI state from other state/props this way -- kept visible as a
      // warning rather than blocking lint on a pre-existing, intentional pattern.
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
);
