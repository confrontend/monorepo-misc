# JSON Sniper

When capture starts, JSON Sniper also attaches to already-open HTTP(S) tabs. This matters after
installing or reloading the unpacked extension: Chrome does not retroactively run declared content
scripts in tabs that were already open. Requests that happened before the attach point cannot be
recovered, but later fetch/XHR calls in those tabs can be captured without bringing each tab to
the foreground.

A Manifest V3 Chrome extension that watches every site you browse, matches API
response URLs against a regex you supply, and appends the JSON to a local
IndexedDB dataset keyed by ticker.

## Install

1. `chrome://extensions` → turn on **Developer mode**
2. **Load unpacked** → select this folder
3. Pin the extension, open the popup, review the prefilled Seeking Alpha pattern, and hit **Start capture**

The default pattern is `api/v3/(ticker_changes|historical_prices)`, which matches the
Seeking Alpha rating-history and historical-price endpoints. You can replace it with any
regular expression when capturing other JSON APIs.

Captures accumulate in IndexedDB automatically. Exports land in
`~/Downloads/json-sniper/`; Chrome will ask once to allow multiple automatic
downloads, which the per-endpoint CSV export needs.

## Slug detection

The slug comes from the first query param whose key ends in `slug` or `slugs`,
so `filters[slugs]=bma` and `filter[ticker][slug]=bma` both work (percent-encoded
brackets too). A comma list becomes `aapl-msft`. No slug found → `unknown`. Endpoint aliases
(`ticker_changes` → `changes`, `historical_prices` → `prices`) live in
`ENDPOINT_ALIAS` in `sw.js`.

## Save confirmation

A small chip appears bottom-right of the page for each capture — the key plus
how many rows were appended (`prices:bma  +504 rows`), ~2.4s, gone.

It fires after the IndexedDB transaction commits, so it confirms the rows are
actually stored. Failures stay up ~4s in red: `0 rows — check payload shape`
means the body was stored raw but the flattener didn't recognise its structure,
and `db: …` means the write itself failed (in which case the session dedupe is
rolled back so the next page load retries).

Rendered in a closed shadow root from the isolated world, top frame only, so
page CSS can't touch it and page JS can't see it. Turn it off in the popup.

## Where the data goes

**IndexedDB**, database `json-sniper`, not `chrome.storage.local`. Two object
stores:

| Store | Key | Contents |
|---|---|---|
| `rows` | auto-increment `_id` | One entry per record inside a payload, flattened, tagged `_key` / `_slug` / `_kind` / `_ts`. Indexed on all three tags. |
| `payloads` | `_key` | The untouched response body per capture, plus source URL, timestamp, record count. |

The key is **`{kind}:{slug}`** — `changes:bma`, `prices:bma`. Each capture
appends its records to `rows` under that key.

`chrome.storage.local` still holds settings only (pattern, flags, checkboxes).

### Why not chrome.storage.local

It's a key-value blob store. Appending to an array there means reading the whole
array, pushing, and rewriting it — quadratic as the dataset grows — and there's
no way to query by ticker without deserialising everything. IndexedDB writes one
record at a time and indexes `_slug` / `_kind`. With `unlimitedStorage` (already
in the manifest) there's no practical size ceiling.

### Flattening

`findRecords()` looks for a list of objects under `data`, `results`, or `items`,
falling back to a single nested list if there's exactly one. `flatten()` lifts
JSON:API `attributes` to the top level and drops `relationships` / `links`.
Same logic as `load_captures.py`, so the in-browser dataset and the offline
loader agree.

If a payload doesn't fit, the capture still stores the raw body in `payloads`
and the toast reads `0 rows — check payload shape`. Nothing is lost; export
**Raw** and adjust.

### Replace vs append on re-capture

Default is **replace**: capturing `changes:bma` again deletes the previous rows
for that key first. Without this, re-pulling a ticker in a later session
silently doubles its records — which would quietly corrupt any per-ticker
statistics computed downstream. Uncheck the option only if you're deliberately
capturing distinct time windows under the same key.

Session dedupe still applies on top: each key is captured at most once per
browser session regardless.

## Getting data out

| Button | Output |
|---|---|
| **CSV** | One `{kind}_{timestamp}.csv` per endpoint, union of all columns, `slug` first |
| **Rows JSON** | Every flattened row in one file |
| **Raw** | Every untouched payload with provenance |

Or query it directly from the service worker console (`chrome://extensions` →
**service worker**):

```js
const { getRows, stats } = await import(chrome.runtime.getURL("db.js"));
await stats();
(await getRows("prices")).filter(r => r._slug === "bma");
```

## Session dedupe

Each `endpoint:slug` pair is captured **once per browser session** — first hit
wins, later ones are dropped silently and don't appear in the log. State lives
in `chrome.storage.session`, which the browser wipes on shutdown, so quitting
and reopening Chrome resets it. Closing a tab does not.

`Clear` in the popup also resets it, if you need to re-pull a ticker mid-session.

`Clear` empties both object stores and resets the dedupe.

## How it works

| File | World | Job |
|---|---|---|
| `inject.js` | page (MAIN) | Wraps `fetch` and `XMLHttpRequest` at `document_start`, reads JSON bodies, posts them out |
| `bridge.js` | isolated | Holds the config, applies the regex, forwards matches |
| `sw.js` | service worker | Routes captures into the database, handles exports |
| `db.js` | service worker | IndexedDB: flattening, append/replace, CSV |
| `popup.*` | — | Pattern, toggles, live log, export |

Response bodies are read from a `response.clone()`, so the page still gets its
own untouched stream.

## What it will not see

Background tabs are supported while Chrome is still running the page: the extension listens to
fetch/XHR events rather than polling on a timer. The bridge also buffers the first few responses
while its settings load, so a slow background-tab initialization does not lose the first match.

There are still two Chrome/page-lifecycle limits:

- Chrome may **freeze** a background tab under Energy Saver, or **discard** it under memory
  pressure. A discarded tab has been unloaded, so no extension can inspect requests until Chrome
  reloads it when you activate the tab. `chrome://discards` shows this state.
- Requests made by a page's service worker or web worker are outside the page's monkey-patched
  `fetch`/XHR objects. Opening a tab can make the page issue a new foreground request, which can
  make it look like the extension only started working then.

Monkey-patching `fetch`/`XHR` is the cheapest approach, but it only sees
requests the page's own JS makes:

- requests issued by a **service worker** or from inside a **web worker**
- **document navigations**, `<img>`/`<script>`/`<link>` loads, `sendBeacon`
- **WebSocket** frames and `EventSource` streams
- `no-cors` (opaque) responses — the body is unreadable by design
- responses with `responseType` of `blob` / `arraybuffer` (skipped deliberately)
- anything on `chrome://`, the Web Store, and other restricted origins

## If you need everything

Use `chrome.debugger` instead (the DevTools protocol). Add `"debugger"` to
permissions, then per tab:

```js
await chrome.debugger.attach({ tabId }, "1.3");
await chrome.debugger.sendCommand({ tabId }, "Network.enable");

chrome.debugger.onEvent.addListener(async (src, method, params) => {
  if (method !== "Network.responseReceived") return;
  if (!/json/i.test(params.response.mimeType)) return;
  if (!re.test(params.response.url)) return;
  const { body, base64Encoded } = await chrome.debugger.sendCommand(
    src, "Network.getResponseBody", { requestId: params.requestId }
  );
  save(base64Encoded ? atob(body) : body);
});
```

Trade-offs: it catches every request type, but Chrome shows a yellow
"JSON Sniper started debugging this browser" bar on each attached tab, DevTools
can't be open on the same tab, and you must attach/detach as tabs come and go.

## Writing to a real folder

`chrome.downloads` can only write under your Downloads directory (subfolders
are fine, `..` is not). For an arbitrary path, either:

- **File System Access API** — call `showDirectoryPicker()` once from an
  extension page, persist the handle in IndexedDB, and write with
  `handle.getFileHandle(name, { create: true })`. Needs a user gesture the
  first time; re-prompts for permission after a browser restart.
- **Native messaging** — a small host binary the extension pipes to. Full
  filesystem freedom, but you have to install the host and its manifest.

## Notes

- `world: "MAIN"` content scripts need Chrome 111+.
- The service worker can't use `URL.createObjectURL`, so downloads go through a
  base64 `data:` URL. Very large payloads (tens of MB) may fail that way; switch
  to an offscreen document with a blob URL if you hit it.
- An invalid regex captures nothing rather than everything.
- You're capturing authenticated responses across every site you visit. Turn it
  off when you're done, and treat the output folder as sensitive.
