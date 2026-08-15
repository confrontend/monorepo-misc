const statusEl = document.getElementById('status');
const versionEl = document.getElementById('version');
// getManifest() is synchronous and local, but guard it anyway for consistency with
// safeSendMessage below — a popup left open across a reload can have its whole chrome.*
// surface invalidated, and a version label that fails silently is worse than a missing one.
try { versionEl.textContent = `v${chrome.runtime.getManifest().version}`; } catch { versionEl.textContent = 'v?'; }
const toggleBtn = document.getElementById('toggle');
const exportBtn = document.getElementById('export');
const clearBtn = document.getElementById('clear');
const investigationBtn = document.getElementById('investigate');
const exportInvestigationBtn = document.getElementById('exportInvestigation');
const clearInvestigationBtn = document.getElementById('clearInvestigation');
const captureStatsEl = document.getElementById('capture-stats');
const investigationStatsEl = document.getElementById('investigation-stats');

// The extension can be reloaded (e.g. picking up a new version) while this popup is still
// open from before the reload; every chrome.* call after that throws "Extension context
// invalidated" instead of returning data. Show a clear, actionable message instead of an
// uncaught crash reading a field off the rejected call's result.
async function safeSendMessage(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    console.error('gmgn-signal-capture popup: message failed, likely a stale popup after an extension reload', error);
    return null;
  }
}

async function refresh() {
  const state = await safeSendMessage({ type: 'GET_STATE' });
  if (!state) { statusEl.textContent = 'Extension was reloaded — close and reopen this popup.'; return; }
  statusEl.textContent = `${state.active ? 'Capturing' : 'Stopped'} — ${state.count} event batch(es), ${state.coverageWindowCount} coverage window(s). Investigation: ${state.investigationActive ? 'ON' : 'off'} (${state.investigationCount} unique endpoint(s), ${state.investigationHitCount} sampled hit(s)).`;
  toggleBtn.textContent = state.active ? 'Stop capture' : 'Start capture';
  toggleBtn.classList.toggle('active', state.active);
  investigationBtn.textContent = state.investigationActive ? 'Stop investigation sampling' : 'Start investigation sampling';
  investigationBtn.classList.toggle('active', state.investigationActive);
  captureStatsEl.textContent = `${state.count} event batch(es) · ${state.coverageWindowCount} coverage window(s)`;
  investigationStatsEl.textContent = `${state.investigationCount} unique endpoint(s) · ${state.investigationHitCount} sampled hit(s)`;
}

toggleBtn.addEventListener('click', async () => {
  const state = await safeSendMessage({ type: 'GET_STATE' });
  if (!state) { refresh(); return; }
  await safeSendMessage({ type: 'SET_ACTIVE', active: !state.active });
  refresh();
});

investigationBtn.addEventListener('click', async () => {
  const state = await safeSendMessage({ type: 'GET_STATE' });
  if (!state) { refresh(); return; }
  await safeSendMessage({ type: 'SET_INVESTIGATION', active: !state.investigationActive });
  refresh();
});

exportBtn.addEventListener('click', async () => {
  const payload = await safeSendMessage({ type: 'EXPORT' });
  if (!payload) return;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `gmgn-browser-capture-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
});

exportInvestigationBtn.addEventListener('click', async () => {
  const payload = await safeSendMessage({ type: 'EXPORT_INVESTIGATION' });
  if (!payload) return;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `gmgn-investigation-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
});

clearBtn.addEventListener('click', async () => {
  await safeSendMessage({ type: 'CLEAR' });
  refresh();
});

clearInvestigationBtn.addEventListener('click', async () => {
  await safeSendMessage({ type: 'CLEAR_INVESTIGATION' });
  refresh();
});

refresh();
