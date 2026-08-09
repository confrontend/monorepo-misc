// Isolated world. Holds the config (the page can't read or change it),
// applies the URL regex, and forwards matches to the service worker.
(() => {
  "use strict";

  if (globalThis.__jsonSniperBridgeInstalled) return;
  globalThis.__jsonSniperBridgeInstalled = true;

  const DEFAULT_PATTERN = "api/v3/(ticker_changes|historical_prices)";
  let cfg = { enabled: false, pattern: DEFAULT_PATTERN, flags: "i" };
  let re = null;
  let configReady = false;
  const pending = [];
  let pendingBytes = 0;
  const MAX_PENDING = 8;
  const MAX_PENDING_BYTES = 16 * 1024 * 1024;

  const compile = () => {
    re = null;
    if (!cfg.pattern) return;
    try {
      re = new RegExp(cfg.pattern, cfg.flags || "i");
    } catch (_) {
      re = null; // invalid regex: capture nothing rather than everything
    }
  };

  const forward = (p) => {
    if (!cfg.enabled || !re) return;
    if (typeof p.url !== "string" || !re.test(p.url)) return;

    try {
      chrome.runtime.sendMessage(
        { type: "capture", data: { ...p, page: location.href } },
        () => void chrome.runtime.lastError // swallow "no receiver" on SW restart
      );
    } catch (_) {}
  };

  chrome.storage.local.get({ enabled: false, pattern: DEFAULT_PATTERN, flags: "i" }, (v) => {
    cfg = { ...cfg, ...v, pattern: v.pattern || DEFAULT_PATTERN };
    compile();
    configReady = true;
    for (const p of pending) forward(p);
    pending.length = 0;
    pendingBytes = 0;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    let touched = false;
    for (const k of ["enabled", "pattern", "flags"]) {
      if (k in changes) {
        cfg[k] = changes[k].newValue;
        touched = true;
      }
    }
    if (touched) compile();
  });

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__jsonSniper !== 1 || !d.payload) return;
    const p = d.payload;
    if (!configReady) {
      const bytes = typeof p.body === "string" ? p.body.length : 0;
      if (pending.length < MAX_PENDING && pendingBytes + bytes <= MAX_PENDING_BYTES) {
        pending.push(p);
        pendingBytes += bytes;
      }
      return;
    }
    forward(p);
  });
  /* ---------- success toast ---------- */
  let host = null;

  function ensureHost() {
    if (host && host.isConnected) return host.shadowRoot;
    host = document.createElement("div");
    host.style.cssText =
      "position:fixed;right:14px;bottom:14px;z-index:2147483647;pointer-events:none;";
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      .stack { display:flex; flex-direction:column; align-items:flex-end; gap:6px; }
      .chip {
        display:flex; align-items:center; gap:8px;
        padding:7px 11px 7px 9px;
        border:1px solid #23303a; border-left:2px solid #e08b28; border-radius:3px;
        background:#151d23; color:#cbd8e1;
        font:11px/1.3 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
        box-shadow:0 4px 14px rgba(0,0,0,.4);
        opacity:0; transform:translateY(4px);
        animation:in .16s ease forwards;
      }
      .chip.out { animation:out .22s ease forwards; }
      .chip.bad { border-left-color:#d9704f; }
      .meta { color:#667f90; }
      @keyframes in  { to { opacity:1; transform:none; } }
      @keyframes out { to { opacity:0; transform:translateY(4px); } }
      @media (prefers-reduced-motion: reduce) {
        .chip { animation:none; opacity:1; transform:none; }
        .chip.out { animation:none; opacity:0; }
      }`;
    const stack = document.createElement("div");
    stack.className = "stack";
    root.append(style, stack);
    (document.body || document.documentElement).appendChild(host);
    return root;
  }

  function showToast(msg) {
    let root;
    try {
      root = ensureHost();
    } catch (_) {
      return;
    }
    const stack = root.querySelector(".stack");

    const chip = document.createElement("div");
    chip.className = "chip" + (msg.ok ? "" : " bad");

    const name = document.createElement("span");
    name.textContent = msg.name || "capture";

    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = msg.ok ? msg.note || "saved" : msg.reason || "failed";

    chip.append(name, meta);
    stack.appendChild(chip);

    while (stack.children.length > 4) stack.removeChild(stack.firstChild);

    setTimeout(() => {
      chip.classList.add("out");
      setTimeout(() => {
        chip.remove();
        if (!stack.children.length && host) {
          host.remove();
          host = null;
        }
      }, 240);
    }, msg.ok ? 2400 : 4000);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "toast" && window.top === window) showToast(msg);
  });
})();
