import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { WALLET_FEATURE_IDENTIFIERS } from '../src/copytrade/features/walletFeatureDefinitions.js';

type ResearchConfig = {
  version: string;
  allow_list: Array<{
    name: string;
    justification: string;
  }>;
};

const findCryptoRoot = (): string => {
  const starts = [process.cwd(), dirname(fileURLToPath(import.meta.url))];

  for (const start of starts) {
    let candidate = resolve(start);
    while (true) {
      const registryPath = resolve(candidate, 'src/copytrade/features/walletFeatureDefinitions.ts');
      const configPath = resolve(
        candidate,
        '../research/shared-pattern-discovery/configs/crypto.json',
      );
      if (existsSync(registryPath) && existsSync(configPath)) return candidate;

      const parent = dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
  }

  throw new Error(
    'Could not locate the crypto project and shared Pattern Discovery research files.',
  );
};

const readPythonStringSet = (source: string, symbol: string): Set<string> => {
  const declaration = new RegExp(`\\b${symbol}\\s*=\\s*\\{`).exec(source);
  assert.ok(declaration, `Python exporter must declare ${symbol} as a set literal`);

  const openingBrace = source.indexOf('{', declaration.index);
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let closingBrace = -1;

  for (let index = openingBrace; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }

    if (character === '"' || character === "'") quote = character;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        closingBrace = index;
        break;
      }
    }
  }

  assert.notEqual(closingBrace, -1, `Could not find the closing brace for ${symbol}`);
  const setLiteral = source.slice(openingBrace + 1, closingBrace);
  const identifiers = [...setLiteral.matchAll(/["']([a-z][a-z0-9_]*)["']/g)].map(
    ([, identifier]) => identifier,
  );

  assert.ok(identifiers.length > 0, `${symbol} must contain string identifiers`);
  assert.equal(
    new Set(identifiers).size,
    identifiers.length,
    `${symbol} must not contain duplicate identifiers`,
  );
  return new Set(identifiers);
};

const cryptoRoot = findCryptoRoot();
const configPath = resolve(cryptoRoot, '../research/shared-pattern-discovery/configs/crypto.json');
const exporterPath = resolve(
  cryptoRoot,
  '../research/shared-pattern-discovery/shared_pattern_discovery/exporters/gmgn.py',
);
const config = JSON.parse(readFileSync(configPath, 'utf8')) as ResearchConfig;
const exporterSource = readFileSync(exporterPath, 'utf8');
const exporterFeatures = readPythonStringSet(exporterSource, 'PRE_EVENT_FEATURES');

const sorted = (values: Iterable<string>): string[] => [...values].sort();
const registryFeatures = new Set<string>(WALLET_FEATURE_IDENTIFIERS);
const configuredFeatures = new Set(config.allow_list.map(({ name }) => name));

test('keeps every registered prior_wallet feature in the checked-in research allowlist', () => {
  const configuredWalletFeatures = [...configuredFeatures].filter((name) =>
    name.startsWith('prior_wallet_'),
  );

  assert.deepEqual(sorted(configuredWalletFeatures), sorted(registryFeatures));
  assert.ok(config.allow_list.every(({ justification }) => justification.trim().length > 0));

  const researchOnlyFeatures = [...configuredFeatures].filter(
    (name) => !registryFeatures.has(name),
  );
  assert.ok(
    researchOnlyFeatures.length > 0,
    'Research should retain legitimate event and token features outside the wallet registry',
  );
  assert.ok(researchOnlyFeatures.every((name) => !name.startsWith('prior_wallet_')));
});

test('keeps the Python exporter vocabulary aligned with the checked-in research config', () => {
  // The exporter exposes only a Python set literal, not a JSON/TS-readable vocabulary. Parse that
  // declaration narrowly and also verify it is the set used to reject unexpected row features.
  assert.match(
    exporterSource,
    /set\(features\)\s*-\s*PRE_EVENT_FEATURES/,
    'The parsed Python vocabulary must remain connected to exporter validation',
  );
  assert.deepEqual(sorted(exporterFeatures), sorted(configuredFeatures));

  const exporterWalletFeatures = [...exporterFeatures].filter((name) =>
    name.startsWith('prior_wallet_'),
  );
  assert.deepEqual(sorted(exporterWalletFeatures), sorted(registryFeatures));
});

test('keeps the research allowlist version aligned with the Python export metadata', () => {
  const versionAssignment =
    /metadata\[\s*["']feature_allowlist_version["']\s*\]\s*=\s*["']([^"']+)["']/.exec(
      exporterSource,
    );
  assert.ok(versionAssignment, 'Python exporter must write feature_allowlist_version metadata');
  assert.equal(versionAssignment[1], config.version);
});
