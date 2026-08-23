// Runs in the extension's isolated world (has chrome.* APIs, no direct access to the page's
// real fetch/XHR). Relays captures posted by content-main.js to the background service worker.
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== '__gmgn_capture__') return;
  chrome.runtime.sendMessage({ type: 'GMGN_CAPTURE', capture: data.capture });
});

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.source !== '__gmgn_risk_capture__') return;
  chrome.runtime.sendMessage({ type: 'GMGN_RISK_CAPTURE', capture: event.data.capture });
});

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== '__gmgn_investigation__') return;
  chrome.runtime.sendMessage({ type: 'GMGN_INVESTIGATION', sample: data.sample });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'SET_INVESTIGATION') window.postMessage({ source: '__gmgn_investigation_state__', active: message.active === true }, '*');
  if (message?.type === 'SET_RISK_AUTO') window.postMessage({ source: '__gmgn_risk_auto_state__', active: message.active === true }, '*');
});

chrome.runtime.sendMessage({ type: 'GET_INVESTIGATION_STATE' }, (state) => {
  if (chrome.runtime.lastError) return;
  window.postMessage({ source: '__gmgn_investigation_state__', active: state?.investigationActive === true }, '*');
});

chrome.runtime.sendMessage({ type: 'GET_RISK_STATE' }, (state) => {
  if (chrome.runtime.lastError) return;
  window.postMessage({ source: '__gmgn_risk_auto_state__', active: state?.riskAutoActive === true }, '*');
});
