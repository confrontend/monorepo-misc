import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../highlighting.js', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(source, context);
const highlights = context.SABacktestHighlights;

const fakeResult = (href, text) => {
  const classes = new Set();
  const name = {
    textContent: text,
    title: '',
    dataset: {},
    classList: {
      contains: (value) => classes.has(value),
      toggle: (value, enabled) => enabled ? classes.add(value) : classes.delete(value),
    },
    removeAttribute: (attribute) => { if (attribute === 'title') name.title = ''; },
  };
  const link = {
    getAttribute: (attribute) => attribute === 'href' ? href : null,
    querySelector: () => name,
  };
  return { link, name };
};

test('reads the canonical symbol from a Seeking Alpha link', () => {
  const { link } = fakeResult('/symbol/soxx#source=screeners', 'wrong fallback');
  assert.equal(highlights.tickerFromLink(link), 'SOXX');
});

test('boxes only symbols missing from a successfully synced list', () => {
  const spy = fakeResult('/symbol/SPY', 'SPY');
  const soxx = fakeResult('/symbol/SOXX', 'SOXX');
  const root = { querySelectorAll: () => [spy.link, soxx.link] };

  const result = highlights.applyHighlights(root, new Set(['SPY']), true);

  assert.deepEqual({ ...result }, { found: 2, highlighted: 1 });
  assert.equal(spy.name.classList.contains(highlights.UNPROCESSED_CLASS), false);
  assert.equal(soxx.name.classList.contains(highlights.UNPROCESSED_CLASS), true);
  assert.equal(soxx.name.dataset.backtestStatus, 'not-processed');
});

test('does not mark everything missing before the first successful sync', () => {
  const soxx = fakeResult('/symbol/SOXX', 'SOXX');
  const root = { querySelectorAll: () => [soxx.link] };

  highlights.applyHighlights(root, new Set(), false);

  assert.equal(soxx.name.classList.contains(highlights.UNPROCESSED_CLASS), false);
});

test('removes a stale box after the symbol is processed', () => {
  const soxx = fakeResult('/symbol/SOXX', 'SOXX');
  const root = { querySelectorAll: () => [soxx.link] };
  highlights.applyHighlights(root, new Set(), true);

  highlights.applyHighlights(root, new Set(['SOXX']), true);

  assert.equal(soxx.name.classList.contains(highlights.UNPROCESSED_CLASS), false);
  assert.equal(soxx.name.dataset.backtestStatus, undefined);
  assert.equal(soxx.name.title, '');
});
