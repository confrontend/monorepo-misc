const pendingTabs = new Map();
const CLOSE_AFTER_MS = 2000;
const DOWNLOAD_WAIT_TIMEOUT_MS = 10000;
const DEFAULT_BACKTEST_URL = 'http://localhost:5173';
const SYNC_ALARM = 'sync-processed-symbols';
const MIN_SYNC_INTERVAL_MS = 30000;
let syncPromise = null;
let lastSyncAttempt = 0;

const normalizedBacktestUrl = (value) => {
  const candidate = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_BACKTEST_URL;
  const url = new URL(candidate);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Backtest address must start with http:// or https://.');
  }
  return url.href.replace(/\/$/, '');
};

const syncProcessedSymbols = async ({ force = false } = {}) => {
  if (syncPromise) return syncPromise;
  if (!force && Date.now() - lastSyncAttempt < MIN_SYNC_INTERVAL_MS) {
    return chrome.storage.local.get([
      'processedSymbols', 'processedSymbolsUpdatedAt', 'backtestDataVersion',
      'backtestSourceUpdatedAt', 'syncError', 'backtestUrl',
    ]);
  }

  lastSyncAttempt = Date.now();
  syncPromise = (async () => {
    const { backtestUrl = DEFAULT_BACKTEST_URL } = await chrome.storage.local.get({
      backtestUrl: DEFAULT_BACKTEST_URL,
    });
    let baseUrl;
    try {
      baseUrl = normalizedBacktestUrl(backtestUrl);
      const response = await fetch(`${baseUrl}/api/data/processed-symbols`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`Backtest returned HTTP ${response.status}.`);
      const payload = await response.json();
      if (!Array.isArray(payload?.symbols)) throw new Error('Backtest returned an invalid symbol list.');
      const processedSymbols = [...new Set(payload.symbols
        .filter((symbol) => typeof symbol === 'string' && symbol.trim())
        .map((symbol) => symbol.trim().toUpperCase()))].sort();
      const synced = {
        backtestUrl: baseUrl,
        processedSymbols,
        processedSymbolsUpdatedAt: new Date().toISOString(),
        backtestDataVersion: Number.isFinite(payload.dataVersion) ? payload.dataVersion : null,
        backtestSourceUpdatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : null,
        syncError: null,
      };
      await chrome.storage.local.set(synced);
      return synced;
    } catch (error) {
      const failed = {
        backtestUrl: baseUrl ?? String(backtestUrl),
        syncError: error instanceof Error ? error.message : String(error),
        syncErrorAt: new Date().toISOString(),
      };
      await chrome.storage.local.set(failed);
      return { ...await chrome.storage.local.get(null), ...failed };
    } finally {
      syncPromise = null;
    }
  })();
  return syncPromise;
};

const closeTab = (tabId) => {
  const pending = pendingTabs.get(tabId);
  if (!pending) return;
  clearTimeout(pending.fallbackTimer);
  pendingTabs.delete(tabId);
  chrome.tabs.remove(tabId).catch(() => {
    // The tab may already have been closed by the user.
  });
};

const scheduleClose = (tabId, clickedAt) => {
  const delay = Math.max(0, CLOSE_AFTER_MS - (Date.now() - clickedAt));
  const pending = pendingTabs.get(tabId);
  if (!pending) return;
  clearTimeout(pending.closeTimer);
  pending.closeTimer = setTimeout(() => closeTab(tabId), delay);
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'sync-processed-symbols') {
    const force = message.force === true;
    syncProcessedSymbols({ force }).then(sendResponse);
    return true;
  }
  if (message?.type !== 'target-clicked' || !sender.tab?.id) return undefined;

  const tabId = sender.tab.id;
  const clickedAt = Date.now();
  const fallbackTimer = setTimeout(() => closeTab(tabId), DOWNLOAD_WAIT_TIMEOUT_MS);
  pendingTabs.set(tabId, { clickedAt, fallbackTimer, closeTimer: null });
  return undefined;
});

chrome.downloads.onCreated.addListener((download) => {
  const pending = pendingTabs.get(download.tabId);
  if (pending) scheduleClose(download.tabId, pending.clickedAt);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const pending = pendingTabs.get(tabId);
  if (!pending) return;
  clearTimeout(pending.fallbackTimer);
  clearTimeout(pending.closeTimer);
  pendingTabs.delete(tabId);
});

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get({
    enabled: false,
    highlightEnabled: true,
    backtestUrl: DEFAULT_BACKTEST_URL,
  });
  await chrome.storage.local.set(current);
  await chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 5 });
  await syncProcessedSymbols({ force: true });
});

chrome.runtime.onStartup.addListener(() => {
  void chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 5 });
  void syncProcessedSymbols({ force: true });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) void syncProcessedSymbols();
});
