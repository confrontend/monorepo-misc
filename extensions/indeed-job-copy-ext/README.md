# Indeed Job Copier

Versioned Chrome MV3 extension that saves job descriptions from Indeed, advances through the loaded job list, and exports the saved descriptions.

## Install locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this directory.
4. Open an Indeed Jobs search page and use the **Indeed Memory** panel.

The extension loads `indeed.js` as its content script. Saved entries and clipboard exports include the current job page URL. Use the `×` button to close the panel; closing it also stops autopilot. Click the extension toolbar icon to reopen the panel without reloading the page.

The Job Memory panel's **Export & Flush** action copies versioned Indeed jobs JSON, including stable IDs, to the clipboard before clearing memory. Give that JSON to ChatGPT, then use **Import AI Decisions** in the same panel with a response containing `schemaVersion: 1` and decisions with `jobId`, `apply`, `score` (0–100), and an optional `reason`. Matching job cards are marked with a green check or red cross and score.

## Release version

Update the `version` field in `manifest.json` and `package.json` together before distributing a new build. The current extension version is `1.0.1`.
