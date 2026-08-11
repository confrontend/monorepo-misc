// Runs in the extension's isolated world (has chrome.* APIs, no direct access to the page's
// real fetch/XHR). Relays captures posted by content-main.js to the background service worker.
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== '__gmgn_capture__') return;
  chrome.runtime.sendMessage({ type: 'GMGN_CAPTURE', capture: data.capture });
});
