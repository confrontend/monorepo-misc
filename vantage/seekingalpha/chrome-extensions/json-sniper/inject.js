// Runs in the page's own JS world at document_start, before page scripts.
// It wraps fetch + XMLHttpRequest, reads JSON response bodies, and hands them
// to bridge.js via window.postMessage. All filtering happens in bridge.js.
(() => {
  "use strict";

  if (window.__jsonSniperInjectInstalled) return;
  window.__jsonSniperInjectInstalled = true;

  const MAX_BODY = 8 * 1024 * 1024; // ignore anything bigger than 8 MB
  const looksJson = (ct, text) => {
    if (ct && /\b(json|\+json)\b/i.test(ct)) return true;
    if (ct) return false;
    // No content-type header: sniff the first non-space char.
    const head = text.slice(0, 64).trim();
    return head.startsWith("{") || head.startsWith("[");
  };

  const emit = (payload) => {
    try {
      window.postMessage({ __jsonSniper: 1, payload }, "*");
    } catch (_) {
      /* structured-clone failure, nothing to do */
    }
  };

  /* ---------- fetch ---------- */
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === "function") {
    window.fetch = function (...args) {
      const p = nativeFetch.apply(this, args);
      p.then((res) => {
        try {
          const ct = res.headers.get("content-type");
          if (ct && !/\b(json|\+json)\b/i.test(ct)) return;
          if (res.type === "opaque" || res.type === "opaqueredirect") return;
          const clone = res.clone();
          clone
            .text()
            .then((text) => {
              if (!text || text.length > MAX_BODY) return;
              if (!looksJson(ct, text)) return;
              emit({
                url: res.url || String(args[0] && args[0].url ? args[0].url : args[0]),
                method:
                  (args[1] && args[1].method) ||
                  (args[0] && args[0].method) ||
                  "GET",
                status: res.status,
                type: "fetch",
                body: text,
                ts: Date.now(),
              });
            })
            .catch(() => {});
        } catch (_) {}
      }).catch(() => {});
      return p;
    };
  }

  /* ---------- XMLHttpRequest ---------- */
  const XHR = XMLHttpRequest.prototype;
  const nativeOpen = XHR.open;
  const nativeSend = XHR.send;

  XHR.open = function (method, url, ...rest) {
    this.__sniper = { method: String(method || "GET").toUpperCase(), url: String(url) };
    return nativeOpen.call(this, method, url, ...rest);
  };

  XHR.send = function (...args) {
    this.addEventListener("load", () => {
      try {
        const meta = this.__sniper || {};
        const ct = this.getResponseHeader("content-type");
        if (ct && !/\b(json|\+json)\b/i.test(ct)) return;

        let text = null;
        const rt = this.responseType;
        if (rt === "" || rt === "text") text = this.responseText;
        else if (rt === "json") text = JSON.stringify(this.response);
        else return; // blob / arraybuffer / document — skip

        if (!text || text.length > MAX_BODY) return;
        if (!looksJson(ct, text)) return;

        emit({
          url: this.responseURL || meta.url,
          method: meta.method || "GET",
          status: this.status,
          type: "xhr",
          body: text,
          ts: Date.now(),
        });
      } catch (_) {}
    });
    return nativeSend.apply(this, args);
  };
})();
