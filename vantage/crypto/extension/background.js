const STORAGE_KEY = 'gmgn_captures';
const ACTIVE_KEY = 'gmgn_capture_active';
const COVERAGE_KEY = 'gmgn_coverage_windows';
const HEARTBEAT_ALARM = 'gmgn-heartbeat';
const HEARTBEAT_INTERVAL_MINUTES = 1;
// A window only proves continuous coverage while heartbeats keep landing near this cadence.
// A gap bigger than this multiple (service worker suspended, tab closed, browser quit) means
// the window must be split rather than silently stretched across time capture wasn't running.
const HEARTBEAT_GAP_MULTIPLIER = 3;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'GMGN_CAPTURE') {
    handleCapture(message.capture);
    return false;
  }
  if (message.type === 'GET_STATE') {
    getState().then(sendResponse);
    return true;
  }
  if (message.type === 'SET_ACTIVE') {
    setActive(message.active).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === 'CLEAR') {
    clearAll().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === 'EXPORT') {
    exportCaptures().then(sendResponse);
    return true;
  }
  return false;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) recordHeartbeat();
});

// The service worker can be suspended and later re-woken by any event, or the whole browser
// can be closed and reopened; either way, time passes with no heartbeat. Reconcile on every
// wake so a stale "still active" window gets honestly closed instead of silently spanning a gap.
chrome.runtime.onStartup.addListener(() => reconcileOnWake());
chrome.runtime.onInstalled.addListener(() => reconcileOnWake());
reconcileOnWake();

async function getWindows() {
  const { [COVERAGE_KEY]: windows = [] } = await chrome.storage.local.get(COVERAGE_KEY);
  return windows;
}

async function reconcileOnWake() {
  const { [ACTIVE_KEY]: active = false } = await chrome.storage.local.get(ACTIVE_KEY);
  if (!active) return;
  const windows = await getWindows();
  const open = windows.at(-1);
  const now = Date.now();
  const gapMs = HEARTBEAT_INTERVAL_MINUTES * 60 * 1000 * HEARTBEAT_GAP_MULTIPLIER;
  if (open && open.endedAt === null && now - Date.parse(open.lastHeartbeatAt) > gapMs) {
    open.endedAt = open.lastHeartbeatAt;
    open.closedReason = 'heartbeat-gap-detected-on-wake';
    windows.push({ startedAt: new Date(now).toISOString(), endedAt: null, lastHeartbeatAt: new Date(now).toISOString(), closedReason: null });
    await chrome.storage.local.set({ [COVERAGE_KEY]: windows });
  }
  await chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_INTERVAL_MINUTES });
}

async function recordHeartbeat() {
  const { [ACTIVE_KEY]: active = false } = await chrome.storage.local.get(ACTIVE_KEY);
  if (!active) return;
  const windows = await getWindows();
  const open = windows.at(-1);
  if (open && open.endedAt === null) {
    open.lastHeartbeatAt = new Date().toISOString();
    await chrome.storage.local.set({ [COVERAGE_KEY]: windows });
  }
}

async function setActive(active) {
  const windows = await getWindows();
  const now = new Date().toISOString();
  if (active) {
    const open = windows.at(-1);
    if (!open || open.endedAt !== null) {
      windows.push({ startedAt: now, endedAt: null, lastHeartbeatAt: now, closedReason: null });
    }
    await chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_INTERVAL_MINUTES });
  } else {
    const open = windows.at(-1);
    if (open && open.endedAt === null) {
      open.endedAt = now;
      open.lastHeartbeatAt = now;
    }
    await chrome.alarms.clear(HEARTBEAT_ALARM);
  }
  await chrome.storage.local.set({ [ACTIVE_KEY]: active, [COVERAGE_KEY]: windows });
}

async function handleCapture(capture) {
  const { [ACTIVE_KEY]: active } = await chrome.storage.local.get(ACTIVE_KEY);
  if (!active) return;
  const { [STORAGE_KEY]: existing = [] } = await chrome.storage.local.get(STORAGE_KEY);
  existing.push(capture);
  await chrome.storage.local.set({ [STORAGE_KEY]: existing });
}

async function clearAll() {
  await chrome.storage.local.set({ [STORAGE_KEY]: [], [COVERAGE_KEY]: [] });
}

async function getState() {
  const { [ACTIVE_KEY]: active = false, [STORAGE_KEY]: captures = [] } = await chrome.storage.local.get([ACTIVE_KEY, STORAGE_KEY]);
  const windows = await getWindows();
  return { active, count: captures.length, coverageWindowCount: windows.length };
}

async function exportCaptures() {
  const { [STORAGE_KEY]: captures = [] } = await chrome.storage.local.get(STORAGE_KEY);
  const windows = await getWindows();
  const manifest = chrome.runtime.getManifest();
  return {
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    extensionVersion: manifest.version,
    source: 'gmgn-browser-extension',
    coverageWindows: windows,
    captures,
  };
}
