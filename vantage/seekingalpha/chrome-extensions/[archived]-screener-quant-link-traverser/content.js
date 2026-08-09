(() => {
  'use strict';

  const LINK_SELECTOR = [
    '[data-test-id="screener-results-card"]',
    'table[data-test-id="table"]',
    'tbody a[data-test-id="conditional-link"][href*="/ratings/quant-ratings"]',
  ].join(' ');

  const collectLinks = () => {
    const urls = [...document.querySelectorAll(LINK_SELECTOR)]
      .map((link) => new URL(link.href, location.href).href)
      .filter((url) => new URL(url).origin === location.origin);
    return [...new Set(urls)];
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'collect-links') return;
    sendResponse({ urls: collectLinks(), pageUrl: location.href });
  });
})();
