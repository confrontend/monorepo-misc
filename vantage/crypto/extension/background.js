const STORAGE_KEY = 'gmgn_captures';
const ACTIVE_KEY = 'gmgn_capture_active';
const COVERAGE_KEY = 'gmgn_coverage_windows';
const HEARTBEAT_ALARM = 'gmgn-heartbeat';
const HEARTBEAT_INTERVAL_MINUTES = 1;
// A window only proves continuous coverage while heartbeats keep landing near this cadence.
// A gap bigger than this multiple (service worker suspended, tab closed, browser quit) means
// the window must be split rather than silently stretched across time capture wasn't running.
const HEARTBEAT_GAP_MULTIPLIER = 3;
const INVESTIGATION_KEY = 'gmgn_investigation_samples';
const INVESTIGATION_ACTIVE_KEY = 'gmgn_investigation_active';
const INVESTIGATION_STARTED_KEY = 'gmgn_investigation_started_at';
const RISK_AUTO_KEY = 'gmgn_risk_auto_active';
const RISK_CAPTURE_KEY = 'gmgn_risk_captures';
const INVESTIGATION_MAX_ENDPOINTS = 500;
const INVESTIGATION_MAX_SAMPLES_PER_ENDPOINT = 5;
let investigationWriteQueue = Promise.resolve();

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
  if (message.type === 'GET_INVESTIGATION_STATE') {
    getInvestigationState().then(sendResponse);
    return true;
  }
  if (message.type === 'SET_INVESTIGATION') {
    setInvestigationActive(Boolean(message.active)).then(sendResponse);
    return true;
  }
  if (message.type === 'GMGN_INVESTIGATION') {
    investigationWriteQueue = investigationWriteQueue
      .then(() => handleInvestigation(message.sample))
      .catch((error) => console.debug('gmgn-signal-capture: investigation sample dropped', error));
    return false;
  }
  if (message.type === 'GET_RISK_STATE') {
    getRiskState().then(sendResponse);
    return true;
  }
  if (message.type === 'SET_RISK_AUTO') {
    setRiskAuto(Boolean(message.active)).then(sendResponse);
    return true;
  }
  if (message.type === 'GMGN_RISK_CAPTURE') {
    appendRiskCapture(message.capture).catch((error) =>
      console.debug('gmgn-signal-capture: risk sample dropped', error),
    );
    return false;
  }
  if (message.type === 'EXPORT_RISK') {
    exportRisk().then(sendResponse);
    return true;
  }
  if (message.type === 'GET_RISK_EXPORT') {
    exportRisk().then(sendResponse);
    return true;
  }
  if (message.type === 'CLEAR_RISK') {
    clearRisk().then(sendResponse);
    return true;
  }
  if (message.type === 'EXPORT_INVESTIGATION') {
    exportInvestigation().then(sendResponse);
    return true;
  }
  if (message.type === 'CLEAR_INVESTIGATION') {
    clearInvestigation().then(sendResponse);
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

// Capture only the latest authenticated GMGN risk-request headers for the explicit
// clipboard action. Nothing is exported and the session value disappears with the
// browser/extension session. This never blocks, rewrites, or forwards the request.

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
    windows.push({
      startedAt: new Date(now).toISOString(),
      endedAt: null,
      lastHeartbeatAt: new Date(now).toISOString(),
      closedReason: null,
    });
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

// Appends one item to a stored array, tolerating a chrome.storage.local write failure (e.g.
// "kQuotaBytes quota exceeded") by trimming the oldest half of the array and retrying once,
// instead of the previous behavior: the write throws inside a fire-and-forget async call with
// no catch anywhere in its chain, so the failure became an invisible unhandled promise
// rejection and the new capture (and every capture after it, since the same write keeps
// failing identically forever) was silently lost with no trace outside chrome://extensions'
// hidden per-extension error log. This makes storage genuinely self-healing instead of a
// permanent, silent dead end.
async function appendToStorage(key, item) {
  const { [key]: existing = [] } = await chrome.storage.local.get(key);
  existing.push(item);
  try {
    await chrome.storage.local.set({ [key]: existing });
  } catch (error) {
    console.error(
      `gmgn-signal-capture: storage write failed for "${key}" (likely quota) — trimming oldest half and retrying`,
      error,
    );
    const trimmed = existing.slice(Math.ceil(existing.length / 2));
    try {
      await chrome.storage.local.set({ [key]: trimmed });
    } catch (retryError) {
      console.error(
        `gmgn-signal-capture: retry after trim also failed for "${key}" — this capture is dropped`,
        retryError,
      );
    }
  }
}

async function handleCapture(capture) {
  const { [ACTIVE_KEY]: active } = await chrome.storage.local.get(ACTIVE_KEY);
  if (!active) return;
  await appendToStorage(STORAGE_KEY, capture);
}

async function handleInvestigation(sample) {
  const { [INVESTIGATION_ACTIVE_KEY]: active = false } =
    await chrome.storage.local.get(INVESTIGATION_ACTIVE_KEY);
  if (!active || !sample || typeof sample.url !== 'string') return;
  const { [INVESTIGATION_KEY]: endpoints = [] } = await chrome.storage.local.get(INVESTIGATION_KEY);
  const key = `${sample.transport || 'unknown'}|${sample.method || ''}|${sample.url}`;
  const existing = endpoints.find((endpoint) => endpoint.key === key);
  const cleanSample = {
    observedAt: sample.observedAt || new Date().toISOString(),
    pageUrl: typeof sample.pageUrl === 'string' ? sample.pageUrl : null,
    direction: sample.direction || null,
    status: Number.isInteger(sample.status) ? sample.status : null,
    requestPayload: sample.requestPayload ?? null,
    responsePayload: sample.responsePayload ?? null,
  };
  if (existing) {
    if (existing.samples.length < INVESTIGATION_MAX_SAMPLES_PER_ENDPOINT)
      existing.samples.push(cleanSample);
    else if (
      cleanSample.direction &&
      !existing.samples.some((sample) => sample.direction === cleanSample.direction)
    )
      existing.samples[existing.samples.length - 1] = cleanSample;
  } else if (endpoints.length < INVESTIGATION_MAX_ENDPOINTS) {
    endpoints.push({
      key,
      transport: sample.transport || 'unknown',
      method: sample.method || null,
      url: sample.url,
      samples: [cleanSample],
    });
  }
  await chrome.storage.local.set({ [INVESTIGATION_KEY]: endpoints });
}

async function getInvestigationState() {
  const values = await chrome.storage.local.get([
    INVESTIGATION_ACTIVE_KEY,
    INVESTIGATION_KEY,
    INVESTIGATION_STARTED_KEY,
  ]);
  const endpoints = values[INVESTIGATION_KEY] || [];
  return {
    investigationActive: values[INVESTIGATION_ACTIVE_KEY] === true,
    investigationCount: endpoints.length,
    investigationHitCount: endpoints.reduce(
      (total, endpoint) => total + (endpoint.samples?.length || 0),
      0,
    ),
    investigationStartedAt: values[INVESTIGATION_STARTED_KEY] || null,
  };
}

async function broadcastInvestigationState(active) {
  try {
    const tabs = await chrome.tabs.query({ url: ['https://gmgn.ai/*'] });
    await Promise.all(
      tabs.map((tab) =>
        tab.id == null
          ? Promise.resolve()
          : chrome.tabs.sendMessage(tab.id, { type: 'SET_INVESTIGATION', active }).catch(() => {}),
      ),
    );
  } catch (error) {
    console.debug('gmgn-signal-capture: investigation state broadcast skipped', error);
  }
}

async function broadcastRiskAutoState(active) {
  try {
    const tabs = await chrome.tabs.query({ url: ['https://gmgn.ai/*'] });
    await Promise.all(
      tabs.map((tab) =>
        tab.id == null
          ? Promise.resolve()
          : chrome.tabs.sendMessage(tab.id, { type: 'SET_RISK_AUTO', active }).catch(() => {}),
      ),
    );
  } catch (error) {
    console.debug('gmgn-signal-capture: risk state broadcast skipped', error);
  }
}

async function setRiskAuto(active) {
  await chrome.storage.local.set({ [RISK_AUTO_KEY]: active });
  await broadcastRiskAutoState(active);
  return getRiskState();
}

async function getRiskState() {
  const values = await chrome.storage.local.get([RISK_AUTO_KEY, RISK_CAPTURE_KEY]);
  return {
    riskAutoActive: values[RISK_AUTO_KEY] === true,
    riskCaptureCount: (values[RISK_CAPTURE_KEY] || []).length,
  };
}

async function appendRiskCapture(capture) {
  // Risk data is intentionally 30-day-only. Keep this guard here as well as in
  // the content script so a future capture path cannot persist 7d/all-time data.
  if (!capture || typeof capture.walletAddress !== 'string' || capture.period !== '30d') return;
  const { [RISK_AUTO_KEY]: active = false, [RISK_CAPTURE_KEY]: captures = [] } =
    await chrome.storage.local.get([RISK_AUTO_KEY, RISK_CAPTURE_KEY]);
  if (!active) return;
  const next = captures.filter(
    (item) => !(item.walletAddress === capture.walletAddress && item.period === '30d'),
  );
  next.push({
    ...capture,
    capturedAt: capture.capturedAt || new Date().toISOString(),
    period: '30d',
  });
  await chrome.storage.local.set({ [RISK_CAPTURE_KEY]: next.slice(-500) });
}

async function exportRisk() {
  const values = await chrome.storage.local.get(RISK_CAPTURE_KEY);
  return {
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest().version,
    source: 'gmgn-browser-risk-capture',
    period: '30d',
    captures: values[RISK_CAPTURE_KEY] || [],
  };
}

async function clearRisk() {
  await chrome.storage.local.set({ [RISK_CAPTURE_KEY]: [] });
}

async function setInvestigationActive(active) {
  const updates = { [INVESTIGATION_ACTIVE_KEY]: active };
  if (active) updates[INVESTIGATION_STARTED_KEY] = new Date().toISOString();
  await chrome.storage.local.set(updates);
  await broadcastInvestigationState(active);
  return getInvestigationState();
}

async function clearInvestigation() {
  await chrome.storage.local.set({ [INVESTIGATION_KEY]: [], [INVESTIGATION_STARTED_KEY]: null });
}

async function exportInvestigation() {
  const values = await chrome.storage.local.get([INVESTIGATION_KEY, INVESTIGATION_STARTED_KEY]);
  const manifest = chrome.runtime.getManifest();
  return {
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    extensionVersion: manifest.version,
    source: 'gmgn-browser-extension-investigation',
    startedAt: values[INVESTIGATION_STARTED_KEY] || null,
    endpointCount: (values[INVESTIGATION_KEY] || []).length,
    endpoints: values[INVESTIGATION_KEY] || [],
  };
}

async function clearAll() {
  await chrome.storage.local.set({ [STORAGE_KEY]: [], [COVERAGE_KEY]: [] });
}

async function getState() {
  const {
    [ACTIVE_KEY]: active = false,
    [STORAGE_KEY]: captures = [],
    [INVESTIGATION_ACTIVE_KEY]: investigationActive = false,
    [INVESTIGATION_KEY]: investigation = [],
    [RISK_AUTO_KEY]: riskAutoActive = false,
    [RISK_CAPTURE_KEY]: riskCaptures = [],
  } = await chrome.storage.local.get([
    ACTIVE_KEY,
    STORAGE_KEY,
    INVESTIGATION_ACTIVE_KEY,
    INVESTIGATION_KEY,
    RISK_AUTO_KEY,
    RISK_CAPTURE_KEY,
  ]);
  const windows = await getWindows();
  return {
    active,
    count: captures.length,
    coverageWindowCount: windows.length,
    investigationActive,
    investigationCount: investigation.length,
    investigationHitCount: investigation.reduce(
      (total, endpoint) => total + (endpoint.samples?.length || 0),
      0,
    ),
    riskAutoActive,
    riskCaptureCount: riskCaptures.length,
  };
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
