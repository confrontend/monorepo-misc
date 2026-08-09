const checkbox = document.querySelector('#enabled');
const automationStatus = document.querySelector('#automation-status');
const highlightCheckbox = document.querySelector('#highlight-enabled');
const backtestUrl = document.querySelector('#backtest-url');
const syncButton = document.querySelector('#sync');
const syncStatus = document.querySelector('#sync-status');

const render = (enabled) => {
  checkbox.checked = enabled;
  automationStatus.textContent = enabled ? 'On' : 'Off';
};

const relativeTime = (value) => {
  const elapsed = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsed) || elapsed < 0) return 'just now';
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return 'just now';
  if (minutes === 1) return '1 minute ago';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
};

const renderSyncState = (state) => {
  if (state.syncError) {
    const retained = state.processedSymbolsUpdatedAt
      ? ` Keeping ${state.processedSymbols?.length ?? 0} symbols from ${relativeTime(state.processedSymbolsUpdatedAt)}.`
      : '';
    syncStatus.textContent = `Could not connect: ${state.syncError}${retained}`;
    syncStatus.classList.add('error');
    return;
  }
  syncStatus.classList.remove('error');
  syncStatus.textContent = state.processedSymbolsUpdatedAt
    ? `${state.processedSymbols?.length ?? 0} processed symbols · synced ${relativeTime(state.processedSymbolsUpdatedAt)}${state.backtestDataVersion == null ? '' : ` · data v${state.backtestDataVersion}`}`
    : 'Not synced yet';
};

const load = async () => {
  const state = await chrome.storage.local.get({
    enabled: false,
    highlightEnabled: true,
    backtestUrl: 'http://localhost:5173',
    processedSymbols: [],
    processedSymbolsUpdatedAt: null,
    backtestDataVersion: null,
    syncError: null,
  });
  render(state.enabled);
  highlightCheckbox.checked = state.highlightEnabled;
  backtestUrl.value = state.backtestUrl;
  renderSyncState(state);
};

void load();
checkbox.addEventListener('change', () => {
  chrome.storage.local.set({ enabled: checkbox.checked });
  render(checkbox.checked);
});

highlightCheckbox.addEventListener('change', () => {
  chrome.storage.local.set({ highlightEnabled: highlightCheckbox.checked });
});

syncButton.addEventListener('click', async () => {
  syncButton.disabled = true;
  syncStatus.classList.remove('error');
  syncStatus.textContent = 'Syncing…';
  await chrome.storage.local.set({ backtestUrl: backtestUrl.value.trim() });
  try {
    const state = await chrome.runtime.sendMessage({ type: 'sync-processed-symbols', force: true });
    renderSyncState(state);
  } catch (error) {
    renderSyncState({ syncError: error instanceof Error ? error.message : String(error) });
  } finally {
    syncButton.disabled = false;
  }
});
