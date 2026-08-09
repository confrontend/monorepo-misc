// IndexedDB layer.
//
// Two object stores:
//   rows     — one entry per record inside a payload, flattened and tagged with
//              _key / _slug / _kind. This is the appendable dataset.
//   payloads — one entry per capture, keyed by _key, holding the untouched
//              response body. Insurance in case the flattening guesses wrong.
//
// The key is `${kind}:${slug}` — e.g. "prices:bma", "changes:bma".

const DB_NAME = "json-sniper";
const DB_VERSION = 1;

let dbPromise = null;

export function makeKey(kind, slug) {
  return `${kind}:${slug}`;
}

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("rows")) {
        const rows = db.createObjectStore("rows", { keyPath: "_id", autoIncrement: true });
        rows.createIndex("_key", "_key");
        rows.createIndex("_slug", "_slug");
        rows.createIndex("_kind", "_kind");
      }
      if (!db.objectStoreNames.contains("payloads")) {
        const p = db.createObjectStore("payloads", { keyPath: "_key" });
        p.createIndex("_ts", "_ts");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("IndexedDB upgrade blocked"));
  });
  return dbPromise;
}

const asPromise = (req) =>
  new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });

const txDone = (tx) =>
  new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error || new Error("transaction aborted"));
  });

/* ---------- payload → rows ---------- */

// Find the most plausible list of records. Mirrors load_captures.py so the
// in-browser dataset and the offline loader agree.
export function findRecords(payload) {
  if (Array.isArray(payload)) {
    return payload.every((x) => x && typeof x === "object" && !Array.isArray(x)) ? payload : [];
  }
  if (!payload || typeof payload !== "object") return [];

  for (const key of ["data", "results", "items"]) {
    const v = payload[key];
    if (Array.isArray(v) && v.length && typeof v[0] === "object") return v;
  }

  const candidates = Object.values(payload).filter(
    (v) => Array.isArray(v) && v.length && v[0] && typeof v[0] === "object"
  );
  return candidates.length === 1 ? candidates[0] : [];
}

// JSON:API puts the real fields under `attributes`. Lift them to the top.
export function flatten(rec) {
  if (rec && typeof rec.attributes === "object" && rec.attributes !== null) {
    const { attributes, relationships, links, ...rest } = rec;
    return { ...rest, ...attributes };
  }
  return rec;
}

/* ---------- writes ---------- */

/**
 * Append a capture. When `replace` is true (the default) any rows previously
 * stored under the same key are removed first, so re-pulling a ticker refreshes
 * it instead of silently duplicating every record.
 */
export async function appendCapture({ key, slug, kind, url, ts, payload, replace = true }) {
  const db = await openDb();
  const records = findRecords(payload);
  const tx = db.transaction(["rows", "payloads"], "readwrite");
  const rows = tx.objectStore("rows");

  if (replace) {
    const cursorReq = rows.index("_key").openKeyCursor(IDBKeyRange.only(key));
    await new Promise((res, rej) => {
      cursorReq.onsuccess = () => {
        const c = cursorReq.result;
        if (!c) return res();
        rows.delete(c.primaryKey);
        c.continue();
      };
      cursorReq.onerror = () => rej(cursorReq.error);
    });
  }

  for (const rec of records) {
    rows.add({ _key: key, _slug: slug, _kind: kind, _ts: ts, ...flatten(rec) });
  }

  tx.objectStore("payloads").put({ _key: key, _slug: slug, _kind: kind, _ts: ts, url, count: records.length, body: payload });

  await txDone(tx);
  return records.length;
}

/* ---------- reads ---------- */

export async function stats() {
  const db = await openDb();
  const tx = db.transaction(["rows", "payloads"], "readonly");
  const rowCount = await asPromise(tx.objectStore("rows").count());
  const payloads = await asPromise(tx.objectStore("payloads").getAll());
  await txDone(tx);

  const recent = payloads
    .map(({ body, ...meta }) => meta)
    .sort((a, b) => b._ts - a._ts);

  return {
    rowCount,
    keyCount: payloads.length,
    tickerCount: new Set(payloads.map((p) => p._slug)).size,
    recent: recent.slice(0, 60),
  };
}

export async function getRows(kind = null) {
  const db = await openDb();
  const tx = db.transaction("rows", "readonly");
  const store = tx.objectStore("rows");
  const out = await asPromise(
    kind ? store.index("_kind").getAll(IDBKeyRange.only(kind)) : store.getAll()
  );
  await txDone(tx);
  return out;
}

export async function getKinds() {
  const db = await openDb();
  const tx = db.transaction("payloads", "readonly");
  const all = await asPromise(tx.objectStore("payloads").getAll());
  await txDone(tx);
  return [...new Set(all.map((p) => p._kind))];
}

export async function getPayloads() {
  const db = await openDb();
  const tx = db.transaction("payloads", "readonly");
  const all = await asPromise(tx.objectStore("payloads").getAll());
  await txDone(tx);
  return all;
}

export async function clearAll() {
  const db = await openDb();
  const tx = db.transaction(["rows", "payloads"], "readwrite");
  tx.objectStore("rows").clear();
  tx.objectStore("payloads").clear();
  await txDone(tx);
}

/* ---------- CSV ---------- */

export function toCsv(rows) {
  if (!rows.length) return "";

  // Union of columns, in first-seen order; internal fields renamed up front.
  const cols = [];
  const seen = new Set();
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (k === "_id" || k === "_key") continue;
      if (!seen.has(k)) {
        seen.add(k);
        cols.push(k);
      }
    }
  }
  cols.sort((a, b) => {
    const rank = (k) => (k === "_slug" ? 0 : k === "_kind" ? 1 : k === "_ts" ? 2 : 3);
    return rank(a) - rank(b) || cols.indexOf(a) - cols.indexOf(b);
  });

  const header = cols.map((c) => c.replace(/^_/, ""));
  const esc = (v) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };

  const lines = [header.join(",")];
  for (const r of rows) lines.push(cols.map((c) => esc(r[c])).join(","));
  return lines.join("\n");
}
