// Runs in the page's own JS context (world: "MAIN") so it can see the page's real
// fetch/XMLHttpRequest calls before gmgn.ai's own scripts run. Never blocks or alters the
// real request/response — only observes and relays a copy.
(function () {
  // Every path is matched as a substring, so a trailing "/" before a dynamic segment
  // (token address, wallet address) still matches regardless of what follows it.
  const TARGET_PATHS = [
    '/vas/api/v1/token-signal', // the original signal event feed
    '/api/v1/token_mcap_candles/', // OHLC market-cap/price candles for a token
    '/vas/api/v1/token_trades/', // recent raw trades for a token, straight from GMGN's own indexer
    '/vas/api/v1/token_holder_stat/', // holder count/concentration for a token
    '/defi/quotation/v1/smartmoney/sol/wallet/', // per-wallet smart-money reputation data (older path form)
    '/defi/quotation/v1/smartmoney/sol/walletNew/', // per-wallet smart-money reputation data (path form seen in a live capture; keep both until confirmed which one the site actually calls)
    '/vas/api/v1/radar/detail', // GMGN's own curated trending-token lists, keyed by category
    '/api/v1/rank/sol/wallets/', // public top-wallet leaderboard (e.g. 7d window)
    '/vas/api/v1/twitter/messages', // KOL/influencer Twitter activity feed
  ];
  const MARKER = '__gmgn_capture__';
  const RISK_MARKER = '__gmgn_risk_capture__';
  const RISK_STATE_MARKER = '__gmgn_risk_auto_state__';
  const INVESTIGATION_MARKER = '__gmgn_investigation__';
  const INVESTIGATION_STATE_MARKER = '__gmgn_investigation_state__';
  const MAX_PAYLOAD_CHARS = 50000;
  let investigationActive = false;
  let riskAutoActive = false;
  const riskObservedWallets = new Set();

  const matchesTarget = (url) => TARGET_PATHS.some((target) => url.includes(target));

  // Query keys that are pure browser/device fingerprinting, never useful for research and
  // deliberately never persisted, even redacted. Distinct from sensitiveKey below (credentials),
  // which get redacted (kept but blanked) rather than dropped outright.
  const FINGERPRINT_QUERY_KEYS = new Set(['device_id', 'fp_did', 'client_id', 'from_app', 'app_ver', 'tz_name', 'tz_offset', 'app_lang', 'os', 'worker']);
  const sensitiveKey = /^(access_token|authorization|cookie|set-cookie|x-api-key|api[_-]?key|secret|private[_-]?key|password|jwt)$/i;
  const redactValue = (value) => {
    if (Array.isArray(value)) return value.map(redactValue);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitiveKey.test(key) ? '[REDACTED]' : redactValue(item)]));
    return value;
  };
  const safeUrl = (value) => {
    try {
      const url = new URL(String(value), location.href);
      for (const key of [...url.searchParams.keys()]) if (sensitiveKey.test(key)) url.searchParams.set(key, '[REDACTED]');
      return url.href;
    } catch { return String(value).replace(/(access_token|authorization|api[_-]?key|secret)=[^&\s]+/gi, '$1=[REDACTED]'); }
  };
  const payloadText = (value) => {
    if (value == null) return null;
    if (typeof value === 'string') {
      try { return JSON.stringify(redactValue(JSON.parse(value))).slice(0, MAX_PAYLOAD_CHARS); }
      catch { return value.replace(/((?:access_token|authorization|api[_-]?key|secret|private[_-]?key)=)[^&\s]+/gi, '$1[REDACTED]').slice(0, MAX_PAYLOAD_CHARS); }
    }
    if (value instanceof URLSearchParams) {
      const params = new URLSearchParams(value);
      for (const key of [...params.keys()]) if (sensitiveKey.test(key)) params.set(key, '[REDACTED]');
      return params.toString().slice(0, MAX_PAYLOAD_CHARS);
    }
    try { return JSON.stringify(redactValue(value)).slice(0, MAX_PAYLOAD_CHARS); } catch { return String(value).slice(0, MAX_PAYLOAD_CHARS); }
  };

  const emitInvestigation = (sample) => {
    if (!investigationActive) return;
    window.postMessage({ source: INVESTIGATION_MARKER, sample: { ...sample, observedAt: new Date().toISOString(), pageUrl: location.href } }, '*');
  };

  const walletFromLocation = () => {
    const match = location.pathname.match(/^\/sol\/address\/([1-9A-HJ-NP-Za-km-z]{32,44})/);
    return match ? match[1] : null;
  };

  const isRiskUrl = (url) => /\/pf\/api\/v1\/wallet\/sol\/[1-9A-HJ-NP-Za-km-z]{32,44}\/profit_stat\/30d(?:[/?]|$)/.test(String(url));

  const emitRisk = (url, status, bodyText) => {
    if (!riskAutoActive || !isRiskUrl(url)) return;
    try {
      const parsed = JSON.parse(bodyText);
      const match = String(url).match(/\/wallet\/sol\/([1-9A-HJ-NP-Za-km-z]{32,44})\/profit_stat\/30d/);
      if (!match) return;
      riskObservedWallets.add(match[1]);
      const parsedUrl = new URL(url, location.href);
      window.postMessage({ source: RISK_MARKER, capture: { capturedAt: new Date().toISOString(), walletAddress: match[1], period: '30d', status, url: `${parsedUrl.origin}${parsedUrl.pathname}`, responseBody: parsed } }, '*');
    } catch {
      // The background record should only contain the structured GMGN response.
    }
  };

  const scheduleRiskFetch = () => {
    const wallet = walletFromLocation();
    if (!riskAutoActive || !wallet) return;
    setTimeout(() => {
      if (!riskAutoActive || riskObservedWallets.has(wallet) || walletFromLocation() !== wallet) return;
      const endpoint = `/pf/api/v1/wallet/sol/${wallet}/profit_stat/30d`;
      fetch(endpoint, { credentials: 'include', headers: { accept: 'application/json' } }).catch(() => {});
    }, 1500);
  };

  window.addEventListener('message', (event) => {
    if (event.source === window && event.data?.source === INVESTIGATION_STATE_MARKER) investigationActive = event.data.active === true;
    if (event.source === window && event.data?.source === RISK_STATE_MARKER) {
      riskAutoActive = event.data.active === true;
      scheduleRiskFetch();
    }
  });

  const emitOne = (path, status, parsed, query) => {
    window.postMessage({ source: MARKER, capture: { capturedAt: new Date().toISOString(), requestPath: path, requestQuery: query && Object.keys(query).length ? query : undefined, status, responseBody: parsed } }, '*');
  };

  // Research-relevant query params (chain/period/type/orderby/has_token/...) are kept, redacted
  // like everything else; fingerprinting IDs (device_id/fp_did/client_id/...) are dropped
  // outright rather than merely redacted, since they identify this browser/device specifically
  // and have no research value at all.
  const captureQuery = (url) => {
    let parsed;
    try { parsed = new URL(url, location.href); } catch { return undefined; }
    const query = {};
    for (const [key, value] of parsed.searchParams.entries()) {
      if (FINGERPRINT_QUERY_KEYS.has(key)) continue;
      query[key] = sensitiveKey.test(key) ? '[REDACTED]' : value;
    }
    return query;
  };

  const emit = (url, status, bodyText) => {
    try {
      const parsed = JSON.parse(bodyText);
      const path = new URL(url, location.href).pathname;
      emitOne(path, status, parsed, captureQuery(url));
    } catch {
      // Not JSON (static assets, etc.) — nothing useful to record.
    }
  };

  const originalFetch = window.fetch;
  window.fetch = async function patchedFetch(...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      const request = args[1] || (args[0] && typeof args[0] === 'object' ? args[0] : null);
      if (matchesTarget(url) || isRiskUrl(url) || investigationActive) {
        response.clone().text().then((text) => {
          if (matchesTarget(url)) emit(url, response.status, text);
          emitRisk(url, response.status, text);
          emitInvestigation({ transport: 'fetch', method: request?.method || 'GET', url: safeUrl(url), status: response.status, requestPayload: payloadText(request?.body), responsePayload: payloadText(text) });
        }).catch(() => {});
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
    const originalSend = xhr.send;
    let capturedUrl = '';
    let capturedMethod = 'GET';
    let capturedRequestBody = null;
    xhr.open = function (method, url, ...rest) {
      capturedMethod = String(method || 'GET');
      capturedUrl = String(url);
      return originalOpen.call(xhr, method, url, ...rest);
    };
    xhr.send = function (body) {
      capturedRequestBody = payloadText(body);
      return originalSend.call(xhr, body);
    };
    xhr.addEventListener('load', () => {
      if (matchesTarget(capturedUrl) || isRiskUrl(capturedUrl) || investigationActive) {
        if (matchesTarget(capturedUrl)) emit(capturedUrl, xhr.status, xhr.responseText);
        emitRisk(capturedUrl, xhr.status, xhr.responseText);
        emitInvestigation({ transport: 'xhr', method: capturedMethod, url: safeUrl(capturedUrl), status: xhr.status, requestPayload: capturedRequestBody, responsePayload: payloadText(xhr.responseText || '') });
      }
    });
    return xhr;
  }
  PatchedXHR.prototype = OriginalXHR.prototype;
  window.XMLHttpRequest = PatchedXHR;

  // WebSocket capture. The live "Signal" panel is not delivered over fetch/XHR at all — it's
  // pushed over a WebSocket (wss://ws.gmgn.ai/v2/ws) as JSON messages shaped
  // { channel, data: [...] }. Channel "token_signal" carries both real new-signal events
  // (items with a defined sig_t field) and a much larger volume of plain live-price-update
  // ticks for tokens already on screen (no sig_t) — only the real events are captured here;
  // the backend importer defensively re-filters the same way (see
  // src/gmgn/browserImport.ts's mapWebSocketSignal), so this filter is an efficiency choice,
  // not the only thing standing between ticks and gmgn_signals.
  const WS_SIGNAL_CHANNEL = 'token_signal';
  const isRealSignalItem = (item) => item && typeof item === 'object' && item.sig_t !== undefined;

  const sameGmgnHost = (url) => {
    try {
      const hostname = new URL(url, location.href).hostname;
      return hostname === 'gmgn.ai' || hostname.endsWith('.gmgn.ai');
    } catch { return false; }
  };

  const OriginalWebSocket = window.WebSocket;
  function PatchedWebSocket(url, protocols) {
    const socket = protocols === undefined ? new OriginalWebSocket(url) : new OriginalWebSocket(url, protocols);
    try {
      if (sameGmgnHost(url)) {
        const originalSend = socket.send;
        socket.send = function (data) {
          emitInvestigation({ transport: 'websocket', method: 'message', direction: 'outbound', url: safeUrl(url), status: null, requestPayload: payloadText(data), responsePayload: null });
          return originalSend.call(socket, data);
        };
        // Listener is attached unconditionally at connection time — GMGN's socket connects
        // once on page load, before the extension's own start/stop state is even relevant.
        socket.addEventListener('message', (event) => {
          const data = event.data;
          const handle = (text) => {
            emitInvestigation({ transport: 'websocket', method: 'message', direction: 'inbound', url: safeUrl(url), status: null, requestPayload: null, responsePayload: payloadText(text) });
            let parsed;
            try { parsed = JSON.parse(text); } catch { return; }
            if (parsed && parsed.channel === WS_SIGNAL_CHANNEL && Array.isArray(parsed.data)) {
              const realSignals = parsed.data.filter(isRealSignalItem);
              if (realSignals.length) emitOne(`ws-message:${String(url)}`, null, { channel: parsed.channel, data: realSignals });
            }
          };
          if (typeof data === 'string') handle(data);
          else if (data instanceof Blob) data.text().then(handle).catch(() => {});
          // ArrayBuffer/binary frames are left uncaptured for now — every GMGN endpoint
          // observed so far has been JSON-over-text, so this is the likely case to miss least.
        });
      }
    } catch {
      // Never let capture logic break the page's real WebSocket.
    }
    return socket;
  }
  PatchedWebSocket.prototype = OriginalWebSocket.prototype;
  PatchedWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  PatchedWebSocket.OPEN = OriginalWebSocket.OPEN;
  PatchedWebSocket.CLOSING = OriginalWebSocket.CLOSING;
  PatchedWebSocket.CLOSED = OriginalWebSocket.CLOSED;
  window.WebSocket = PatchedWebSocket;

  const originalPushState = history.pushState;
  history.pushState = function (...args) {
    const result = originalPushState.apply(this, args);
    scheduleRiskFetch();
    return result;
  };
  const originalReplaceState = history.replaceState;
  history.replaceState = function (...args) {
    const result = originalReplaceState.apply(this, args);
    scheduleRiskFetch();
    return result;
  };
  window.addEventListener('popstate', scheduleRiskFetch);
  window.addEventListener('hashchange', scheduleRiskFetch);
  scheduleRiskFetch();
})();
