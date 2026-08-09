// Service worker: matches arrive here, get flattened into IndexedDB, and are
// optionally also written to disk as individual files.

import {
  appendCapture,
  clearAll,
  getKinds,
  getPayloads,
  getRows,
  makeKey,
  stats,
  toCsv,
} from "./db.js";

/* ---------- helpers ---------- */

function toDataUrl(text, mime = "application/json") {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return `data:${mime};base64,` + btoa(bin);
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

const ENDPOINT_ALIAS = {
  ticker_changes: "changes",
  historical_prices: "prices",
};
const DEFAULT_PATTERN = "api/v3/(ticker_changes|historical_prices)";

// Pull the ticker out of the query string. Matches filters[slugs]=bma,
// filter[ticker][slug]=bma, or a bare slug=bma. searchParams decodes %5B/%5D.
function parseTarget(url) {
  let u;
  try {
    u = new URL(url);
  } catch (_) {
    return { kind: "response", slug: "unknown" };
  }

  const last = u.pathname.split("/").filter(Boolean).pop() || "response";
  const kind = ENDPOINT_ALIAS[last] || last.replace(/[^a-zA-Z0-9_-]+/g, "");

  let slug = "";
  for (const [k, v] of u.searchParams) {
    if (/(^|\[)slugs?\]?$/i.test(k) && v) {
      slug = v;
      break;
    }
  }

  slug = slug.toLowerCase().replace(/[^a-z0-9,._-]+/g, "").replace(/,+/g, "-").slice(0, 40);
  return { kind, slug: slug || "unknown" };
}

/* ---------- once-per-browser-session dedupe ---------- */
// chrome.storage.session lives in memory and is wiped when the browser quits.
// The in-memory Set is a synchronous guard against two responses racing.
const seenThisRun = new Set();

async function claim(key) {
  if (seenThisRun.has(key)) return false;
  seenThisRun.add(key);
  const k = "seen:" + key;
  const hit = await chrome.storage.session.get(k);
  if (hit[k]) return false;
  await chrome.storage.session.set({ [k]: Date.now() });
  return true;
}

/* ---------- badge + toasts ---------- */

async function refreshBadge() {
  const { keyCount } = await stats();
  await chrome.action.setBadgeBackgroundColor({ color: "#B45309" });
  await chrome.action.setBadgeText({ text: keyCount ? String(keyCount) : "" });
}

function toast(tabId, payload) {
  if (typeof tabId !== "number") return;
  chrome.tabs.sendMessage(tabId, { type: "toast", ...payload }, { frameId: 0 }, () =>
    void chrome.runtime.lastError
  );
}

const pendingDownloads = new Map();

chrome.downloads.onChanged.addListener((delta) => {
  const info = pendingDownloads.get(delta.id);
  if (!info || !delta.state) return;
  if (delta.state.current === "complete") {
    pendingDownloads.delete(delta.id);
    toast(info.tabId, { ok: true, name: info.name, note: info.note });
  } else if (delta.state.current === "interrupted") {
    pendingDownloads.delete(delta.id);
    toast(info.tabId, {
      ok: false,
      name: info.name,
      reason: (delta.error && delta.error.current) || "failed",
    });
  }
});

function download(opts, track) {
  chrome.downloads.download(opts, (id) => {
    if (chrome.runtime.lastError || id === undefined) return;
    if (track) pendingDownloads.set(id, track);
  });
}

/* ---------- attach to tabs that predate an install/reload ---------- */

async function attachToTab(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["inject.js"],
      world: "MAIN",
    });
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["bridge.js"],
      world: "ISOLATED",
    });
  } catch (_) {
    // Chrome-managed pages and tabs that disappear during the query are not scriptable.
  }
}

async function attachToOpenTabs() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs
    .filter((tab) => typeof tab.id === "number" && /^https?:/i.test(tab.url || ""))
    .map((tab) => attachToTab(tab.id)));
}

/* ---------- capture pipeline ---------- */

async function handleCapture(data, sender) {
  const cfg = await chrome.storage.local.get({
    enabled: false,
    autoDownload: false,
    replaceOnRecapture: true,
    prettyPrint: true,
    toast: true,
  });
  if (!cfg.enabled) return;

  let parsed;
  try {
    parsed = JSON.parse(data.body);
  } catch (_) {
    return; // matched the URL but isn't valid JSON
  }

  const { kind, slug } = parseTarget(data.url);
  const key = makeKey(kind, slug);
  if (!(await claim(key))) return; // already captured this key this session

  const tabId = sender.tab ? sender.tab.id : null;
  const ts = data.ts || Date.now();

  let count;
  try {
    count = await appendCapture({
      key,
      slug,
      kind,
      url: data.url,
      ts,
      payload: parsed,
      replace: cfg.replaceOnRecapture,
    });
  } catch (err) {
    seenThisRun.delete(key);
    await chrome.storage.session.remove("seen:" + key); // let it retry
    if (cfg.toast) toast(tabId, { ok: false, name: key, reason: "db: " + err.message });
    return;
  }

  await refreshBadge();

  if (cfg.toast) {
    toast(tabId, {
      ok: true,
      name: key,
      note: count ? `+${count} rows` : "0 rows — check payload shape",
    });
  }

  if (cfg.autoDownload) {
    const text = cfg.prettyPrint ? JSON.stringify(parsed, null, 2) : data.body;
    download({
      url: toDataUrl(text),
      filename: `json-sniper/${slug}_${kind}.json`,
      saveAs: false,
      conflictAction: "overwrite",
    });
  }
}

/* ---------- exports ---------- */

async function exportCsv() {
  const kinds = await getKinds();
  for (const kind of kinds) {
    const rows = await getRows(kind);
    if (!rows.length) continue;
    download({
      url: toDataUrl(toCsv(rows), "text/csv"),
      filename: `json-sniper/${kind}_${stamp()}.csv`,
      saveAs: false,
      conflictAction: "uniquify",
    });
  }
  return { kinds: kinds.length };
}

async function exportJson() {
  const rows = await getRows();
  const clean = rows.map(({ _id, _key, ...r }) => r);
  download({
    url: toDataUrl(JSON.stringify(clean, null, 2)),
    filename: `json-sniper/rows_${stamp()}.json`,
    saveAs: true,
  });
  return { rows: clean.length };
}

async function exportRaw() {
  const payloads = await getPayloads();
  download({
    url: toDataUrl(JSON.stringify(payloads, null, 2)),
    filename: `json-sniper/raw_${stamp()}.json`,
    saveAs: true,
  });
  return { payloads: payloads.length };
}

/* ---------- messaging ---------- */

const HANDLERS = {
  stats: () => stats(),
  exportCsv,
  exportJson,
  exportRaw,
  clear: async () => {
    await clearAll();
    seenThisRun.clear();
    await chrome.storage.session.clear(); // lets you re-pull the same keys
    await refreshBadge();
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === "capture") {
    handleCapture(msg.data, sender);
    return;
  }

  const fn = HANDLERS[msg.type];
  if (!fn) return;

  fn()
    .then((r) => sendResponse(r))
    .catch((e) => sendResponse({ error: e.message }));
  return true; // keep the channel open for the async reply
});

/* ---------- lifecycle ---------- */

chrome.runtime.onStartup.addListener(async () => {
  seenThisRun.clear();
  await chrome.storage.session.clear();
  await refreshBadge();
  const { enabled } = await chrome.storage.local.get({ enabled: false });
  if (enabled) await attachToOpenTabs();
});

chrome.runtime.onInstalled.addListener(async () => {
  const defaults = {
    enabled: false,
    pattern: DEFAULT_PATTERN,
    flags: "i",
    autoDownload: false,
    replaceOnRecapture: true,
    prettyPrint: true,
    toast: true,
  };
  const cur = await chrome.storage.local.get(null);
  const missing = {};
  for (const [k, v] of Object.entries(defaults)) if (!(k in cur)) missing[k] = v;
  // Existing versions persisted an empty pattern; replace that old unset value
  // with the Seeking Alpha endpoint matcher while preserving custom patterns.
  if (cur.pattern === "") missing.pattern = DEFAULT_PATTERN;
  if (Object.keys(missing).length) await chrome.storage.local.set(missing);

  // Drop the old chrome.storage.local capture store from v1.0.
  const stale = Object.keys(cur).filter((k) => k.startsWith("cap:") || k === "index" || k === "seq");
  if (stale.length) await chrome.storage.local.remove(stale);

  await refreshBadge();
  if (cur.enabled) await attachToOpenTabs();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.enabled?.newValue === true) void attachToOpenTabs();
});
