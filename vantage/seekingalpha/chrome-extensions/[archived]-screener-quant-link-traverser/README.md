# Screener Quant Link Traverser

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this directory.
4. Open the screener results page containing the table.
5. Open the extension popup and click **Start on current page**.

The extension collects unique links matching:

```css
[data-test-id="screener-results-card"] table[data-test-id="table"] tbody a[data-test-id="conditional-link"][href*="/ratings/quant-ratings"]
```

It opens each URL with `active: false` (a background tab), at a rate of one tab every 1.5 seconds. The queue is persisted in `chrome.storage.local`, so the service worker can resume after suspension. Use **Stop** to cancel future tab creation; tabs already opened remain open.
