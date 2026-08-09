// Verifies that the factual claims in README.md still match the code, the database and the saved
// research report.
//
//   node scripts/check-readme.mjs
//
// Why this exists: README.md is written to be handed to someone -- or to an AI agent -- as the only
// context they get, alongside a screenshot. That only works while its numbers are true. Several of
// them are a dated snapshot: import new files or re-run the research pipeline and the README quietly
// starts describing a run that no longer exists, with nothing on screen to say so. This script is
// the tripwire. Run it after an import, after a research run, or before handing the file to anyone.
//
// It deliberately checks facts, not prose: counts, table names, endpoint names, file paths. Wording
// and interpretation are reviewed by reading.
//
// No non-ASCII characters in this file, for the reason explained in scripts/fix-encoding.mjs.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readme = readFileSync(path.join(projectRoot, 'README.md'), 'utf8');

let failures = 0;
let checks = 0;
const check = (label, passed, detail = '') => {
  checks += 1;
  if (!passed) failures += 1;
  console.log(`${passed ? '  ok    ' : '  STALE '}${label}${detail ? `  ${detail}` : ''}`);
};
// README numbers are written for humans, with thousands separators.
const mentions = (value) => readme.includes(Number(value).toLocaleString('en-US')) || readme.includes(String(value));

console.log('\nSaved research run (README section 6.7)');
const metaPath = path.join(projectRoot, 'research', 'report', 'run_meta.json');
if (!existsSync(metaPath)) {
  check('research/report/run_meta.json exists', false, '- run the Research lab analysis');
} else {
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  const { dataset, summary, top_candidate: top } = meta;
  const placebo = top?.placebo ?? {};
  check('ticker count', mentions(dataset.tickers), `= ${dataset.tickers}`);
  check('price rows', mentions(dataset.price_rows), `= ${dataset.price_rows.toLocaleString('en-US')}`);
  check('rating events', mentions(dataset.rating_events), `= ${dataset.rating_events.toLocaleString('en-US')}`);
  check('price date range', readme.includes(dataset.price_start) && readme.includes(dataset.price_end),
    `= ${dataset.price_start} .. ${dataset.price_end}`);
  check('grid cells', mentions(summary.cuts_total), `= ${summary.cuts_total}`);
  check('testable cells', mentions(summary.cuts_testable), `= ${summary.cuts_testable}`);
  check('cells clearing the bar', mentions(summary.discovered_rules), `= ${summary.discovered_rules}`);
  if (placebo.observed_mean !== undefined && placebo.observed_mean !== null) {
    const pp = (value) => (value * 100).toFixed(2);
    check('observed mean excess', readme.includes(pp(placebo.observed_mean)), `= ${pp(placebo.observed_mean)}pp`);
    check('random-ticker median', readme.includes(pp(placebo.random_median)), `= ${pp(placebo.random_median)}pp`);
    check('placebo empirical p', readme.includes(pp(placebo.empirical_p)), `= ${pp(placebo.empirical_p)}%`);
  }
  check('discovery bar t >= 3.0', readme.includes(String(meta.thresholds.discovery_t)), `= ${meta.thresholds.discovery_t}`);
  check('cluster floor', mentions(meta.thresholds.min_clusters), `= ${meta.thresholds.min_clusters}`);
}

console.log('\nSaved bearish research run (README section 6.7)');
const bearishMetaPath = path.join(projectRoot, 'research', 'report', 'bearish_meta.json');
if (!existsSync(bearishMetaPath)) {
  check('research/report/bearish_meta.json exists', false, '- run the Research lab analysis');
} else {
  const bearish = JSON.parse(readFileSync(bearishMetaPath, 'utf8'));
  const transition = bearish.families?.transition;
  const persistence = bearish.families?.persistence;
  const audit = bearish.universe_audit ?? {};
  const percentText = (value) => (value * 100).toFixed(2);
  check('transition correction family', mentions(transition.correction_scope), `= ${transition.correction_scope}`);
  check('persistence correction family', mentions(persistence.correction_scope), `= ${persistence.correction_scope}`);
  check('transition clearing tests', mentions(transition.summary.tests_clearing_bar), `= ${transition.summary.tests_clearing_bar}`);
  check('persistence clearing tests', mentions(persistence.summary.tests_clearing_bar), `= ${persistence.summary.tests_clearing_bar}`);
  check('top transition mean', readme.includes(percentText(transition.top_candidate.mean)),
    `= ${percentText(transition.top_candidate.mean)}%`);
  check('top transition sample', mentions(transition.top_candidate.n) && mentions(transition.top_candidate.g),
    `= ${transition.top_candidate.n} trades / ${transition.top_candidate.g} tickers`);
  check('top persistence mean', readme.includes(percentText(persistence.top_candidate.mean)),
    `= ${percentText(persistence.top_candidate.mean)}%`);
  check('top persistence sample', mentions(persistence.top_candidate.n) && mentions(persistence.top_candidate.g),
    `= ${persistence.top_candidate.n} trades / ${persistence.top_candidate.g} tickers`);
  check('universe early-ending real tickers', mentions(audit.real_early_end_count),
    `= ${audit.real_early_end_count}`);
  for (const entry of audit.early_end_tickers ?? []) {
    check(`early-ending ticker ${entry.ticker}`, readme.toLowerCase().includes(String(entry.ticker).toLowerCase())
      && readme.includes(entry.last_date), `= ${entry.last_date}`);
  }
}

console.log('\nDatabase (README section 4)');
const dbPath = path.join(projectRoot, '.data', 'vantage.sqlite');
if (!existsSync(dbPath)) {
  check('.data/vantage.sqlite exists', false, '- open the Data screen and press Import');
} else {
  let db;
  try {
    db = new DatabaseSync(dbPath);
    const names = new Set(db.prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'",
    ).all().map((row) => row.name));
    for (const table of ['source_files', 'tickers', 'prices', 'rating_changes', 'quant_history', 'benchmark_prices', 'data_version']) {
      check(`table ${table} documented and present`, names.has(table) && readme.includes(`\`${table}\``));
    }
    for (const view of ['historical_prices', 'ticker_changes']) {
      check(`compatibility view ${view}`, names.has(view) && readme.includes(`\`${view}\``));
    }
  } catch (error) {
    check('database readable', false, `- ${error.message}`);
  } finally {
    db?.close?.();
  }
}

console.log('\nAPI surface (README section 9)');
const viteConfig = readFileSync(path.join(projectRoot, 'vite.config.ts'), 'utf8');
const actions = [...viteConfig.matchAll(/action === '([a-zA-Z]+)'/g)].map((match) => match[1]);
for (const action of [...new Set(actions)]) {
  check(`action=${action}`, readme.includes(`action=${action}`));
}
for (const route of ['/api/data/status', '/api/data/import', '/api/data/consolidate', '/api/data/consolidate/job', '/api/research', '/api/research/run', '/api/research/job']) {
  check(`route ${route}`, readme.includes(route));
}

console.log('\nnpm scripts (README section 3)');
const scripts = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).scripts ?? {};
for (const name of Object.keys(scripts)) {
  check(`npm run ${name} documented`, readme.includes(`npm run ${name}`));
}
// A script the README still advertises but package.json no longer defines is worse than an
// undocumented one: it sends the reader to a command that does not exist.
for (const match of readme.matchAll(/npm run ([a-z:-]+)/g)) {
  check(`npm run ${match[1]} still exists`, Object.hasOwn(scripts, match[1]));
}

console.log('\nReferenced source files (README section 10)');
for (const match of readme.matchAll(/`((?:src|server|research|scripts)\/[A-Za-z0-9_/.-]+\.(?:ts|tsx|py|mjs))`/g)) {
  check(match[1], existsSync(path.join(projectRoot, match[1])));
}

console.log(`\n${checks - failures}/${checks} checks passed.`);
if (failures > 0) {
  console.log('\nREADME.md describes something that is no longer true. Update the sections above');
  console.log('before handing the file to anyone as standalone context.');
}
process.exit(failures > 0 ? 1 : 0);
