const statusEl = document.getElementById('status');
const toggleBtn = document.getElementById('toggle');
const exportBtn = document.getElementById('export');
const clearBtn = document.getElementById('clear');

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  statusEl.textContent = `${state.active ? 'Capturing' : 'Stopped'} — ${state.count} event batch(es), ${state.coverageWindowCount} coverage window(s) this session.`;
  toggleBtn.textContent = state.active ? 'Stop capture' : 'Start capture';
  toggleBtn.classList.toggle('active', state.active);
}

toggleBtn.addEventListener('click', async () => {
  const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  await chrome.runtime.sendMessage({ type: 'SET_ACTIVE', active: !state.active });
  refresh();
});

exportBtn.addEventListener('click', async () => {
  const payload = await chrome.runtime.sendMessage({ type: 'EXPORT' });
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `gmgn-browser-capture-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
});

clearBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'CLEAR' });
  refresh();
});

refresh();
