(() => {
  'use strict';

  const LINK_SELECTOR = 'a[data-test-id="top-rated-ticker-link"]';
  const NAME_SELECTOR = '[data-test-id="top-rated-ticker-name"]';
  const UNPROCESSED_CLASS = 'sa-backtest-unprocessed';

  const tickerFromLink = (link) => {
    const href = link?.getAttribute?.('href') ?? '';
    const match = href.match(/\/symbol\/([^/?#]+)/i);
    if (match) {
      try { return decodeURIComponent(match[1]).trim().toUpperCase(); } catch { /* use visible text */ }
    }
    return (link?.querySelector?.(NAME_SELECTOR)?.textContent ?? '').trim().split(/\s+/)[0].toUpperCase();
  };

  const applyHighlights = (root, processedSymbols, hasSuccessfulSync) => {
    const processed = processedSymbols instanceof Set ? processedSymbols : new Set(processedSymbols);
    let highlighted = 0;
    let found = 0;
    root.querySelectorAll(LINK_SELECTOR).forEach((link) => {
      const name = link.querySelector(NAME_SELECTOR) ?? link;
      const ticker = tickerFromLink(link);
      const unprocessed = Boolean(hasSuccessfulSync && ticker && !processed.has(ticker));
      name.classList.toggle(UNPROCESSED_CLASS, unprocessed);
      if (unprocessed) {
        name.dataset.backtestStatus = 'not-processed';
        name.title = `${ticker} is not in the local Seeking Alpha backtest yet`;
        highlighted += 1;
      } else {
        delete name.dataset.backtestStatus;
        if (name.title?.endsWith(' is not in the local Seeking Alpha backtest yet')) name.removeAttribute('title');
      }
      if (ticker) found += 1;
    });
    return { found, highlighted };
  };

  globalThis.SABacktestHighlights = Object.freeze({
    LINK_SELECTOR,
    UNPROCESSED_CLASS,
    tickerFromLink,
    applyHighlights,
  });
})();
