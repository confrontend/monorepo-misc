# 3-Year Chart Tab Closer + Backtest Coverage

## Install locally

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this directory.
4. Open the extension popup.
5. Leave **Box unprocessed symbols in red** enabled.
6. Start the local backtest app at `http://localhost:5173`, then click **Sync now**.
7. Turn **Automate 3Y downloads** on when you want the existing download-and-close workflow.

## Backtest coverage highlighting

The local backtest app exposes `GET /api/data/processed-symbols`. The extension service worker reads
that endpoint every five minutes and stores the last successful symbol list in Chrome. On Seeking
Alpha screener tables, any `top-rated-ticker-link` symbol absent from that list gets a red box.

The highlighter is deliberately fail-safe:

- It does not highlight anything until the first successful sync.
- If the backtest app later goes offline, it keeps using the last successful list and shows the
  connection error in the popup.
- Seeking Alpha's generated CSS class names are ignored. Tickers are read from the stable
  `data-test-id="top-rated-ticker-link"` hook and `/symbol/{ticker}` URL.
- Infinite-scroll and dynamically replaced result rows are highlighted automatically.

If Vite is running on another port, change **Backtest address** in the popup. The default is
`http://localhost:5173`.

## 3-year download automation

When enabled, the extension looks for `[data-test-id="charting-intervals-threeYear"]` on every opened page. When it finds the control, it clicks it once and waits for Chrome to report a download from that tab. The tab closes two seconds after the download starts. If Chrome reports no download, the tab closes after a 10-second fallback window.

The `downloads` permission is used only to observe when the download has started; the extension does not choose, rename, or read downloaded files.

The extension is intentionally enabled globally and acts on any URL where Chrome permits content scripts. Chrome-managed pages such as `chrome://extensions` cannot be scripted.

## Verify locally

Run `node --test test/highlighting.test.mjs` from this directory, and run `npm run build` from the
backtest directory.
