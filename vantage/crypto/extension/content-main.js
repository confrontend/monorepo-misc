// Runs in the page's own JS context (world: "MAIN") so it can see the page's real
// fetch/XMLHttpRequest calls before gmgn.ai's own scripts run. Never blocks or alters the
// real request/response — only observes and relays a copy.
(function () {
  const TARGET_PATH = '/vas/api/v1/token-signal';
  const MARKER = '__gmgn_capture__';

  const emit = (url, status, bodyText) => {
    try {
      if (!url.includes(TARGET_PATH)) return;
      const parsed = JSON.parse(bodyText);
      const path = new URL(url, location.href).pathname; // query string (device_id/fp_did/client_id) intentionally dropped
      window.postMessage({
        source: MARKER,
        capture: { capturedAt: new Date().toISOString(), requestPath: path, status, responseBody: parsed },
      }, '*');
    } catch {
      // Not JSON, or not the endpoint we care about — ignore silently.
    }
  };

  const originalFetch = window.fetch;
  window.fetch = async function patchedFetch(...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      if (url.includes(TARGET_PATH)) {
        response.clone().text().then((text) => emit(url, response.status, text)).catch(() => {});
      }
    } catch {
      // Never let capture logic break the page's real request.
    }
    return response;
  };

  const OriginalXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new OriginalXHR();
    const originalOpen = xhr.open;
    let capturedUrl = '';
    xhr.open = function (method, url, ...rest) {
      capturedUrl = String(url);
      return originalOpen.call(xhr, method, url, ...rest);
    };
    xhr.addEventListener('load', () => {
      if (capturedUrl.includes(TARGET_PATH)) {
        emit(capturedUrl, xhr.status, xhr.responseText);
      }
    });
    return xhr;
  }
  PatchedXHR.prototype = OriginalXHR.prototype;
  window.XMLHttpRequest = PatchedXHR;
})();
