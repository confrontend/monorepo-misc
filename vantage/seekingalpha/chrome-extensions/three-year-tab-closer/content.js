(() => {
  'use strict';

  const TARGET_SELECTOR = '[data-test-id="charting-intervals-threeYear"]';
  let hasActed = false;
  let intervalObserver;
  let screenerObserver;
  let processedSymbols = new Set();
  let hasSuccessfulSync = false;
  let highlightEnabled = true;
  let highlightQueued = false;

  const isEnabled = async () => {
    const { enabled = false } = await chrome.storage.local.get({ enabled: false });
    return enabled;
  };

  const findAndClickTarget = async () => {
    if (hasActed || !document.documentElement || !(await isEnabled())) return;

    const target = document.querySelector(TARGET_SELECTOR);
    if (!target || target.matches('[aria-disabled="true"], :disabled')) return;

    hasActed = true;
    chrome.runtime.sendMessage({ type: 'target-clicked' });
    target.click();
    intervalObserver?.disconnect();
  };

  const startWatching = () => {
    intervalObserver?.disconnect();
    intervalObserver = new MutationObserver(() => void findAndClickTarget());
    intervalObserver.observe(document.documentElement, { childList: true, subtree: true });
    void findAndClickTarget();
  };

  const clearHighlights = () => {
    document.querySelectorAll(`.${SABacktestHighlights.UNPROCESSED_CLASS}`).forEach((element) => {
      element.classList.remove(SABacktestHighlights.UNPROCESSED_CLASS);
      delete element.dataset.backtestStatus;
      if (element.title?.endsWith(' is not in the local Seeking Alpha backtest yet')) {
        element.removeAttribute('title');
      }
    });
  };

  const applyHighlights = () => {
    highlightQueued = false;
    if (!highlightEnabled) {
      clearHighlights();
      return;
    }
    SABacktestHighlights.applyHighlights(document, processedSymbols, hasSuccessfulSync);
  };

  const queueHighlights = () => {
    if (highlightQueued) return;
    highlightQueued = true;
    requestAnimationFrame(applyHighlights);
  };

  const loadHighlightState = async () => {
    const state = await chrome.storage.local.get({
      highlightEnabled: true,
      processedSymbols: [],
      processedSymbolsUpdatedAt: null,
    });
    highlightEnabled = state.highlightEnabled;
    processedSymbols = new Set(state.processedSymbols.map((symbol) => String(symbol).toUpperCase()));
    hasSuccessfulSync = Boolean(state.processedSymbolsUpdatedAt);
    queueHighlights();
  };

  const startHighlighting = () => {
    screenerObserver?.disconnect();
    screenerObserver = new MutationObserver(queueHighlights);
    screenerObserver.observe(document.documentElement, { childList: true, subtree: true });
    void loadHighlightState();
    void chrome.runtime.sendMessage({ type: 'sync-processed-symbols' }).catch(() => {
      // The last successful list remains valid when the local backtest is temporarily offline.
    });
  };

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.enabled) {
      hasActed = false;
      if (changes.enabled.newValue) startWatching();
      else intervalObserver?.disconnect();
    }
    if (areaName === 'local' && (changes.highlightEnabled
      || changes.processedSymbols || changes.processedSymbolsUpdatedAt)) {
      void loadHighlightState();
    }
  });

  startWatching();
  startHighlighting();
})();
