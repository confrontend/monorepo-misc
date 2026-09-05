# LinkedIn Job Copier

Versioned Chrome MV3 extension that saves job descriptions from LinkedIn Jobs, advances through the loaded job list, and exports the saved descriptions.

## Install locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this directory.
4. Open a LinkedIn Jobs search page and use the **Job Memory** panel.

The extension loads `bookleet.js` directly. `bookleet.min.js` remains available for bookmarklet use. Saved entries and clipboard exports include the current job page URL. Use the `×` button to close the panel; closing it also stops autopilot. Click the extension toolbar icon to reopen the panel without reloading the page.

## Release version

Update the `version` field in `manifest.json` and `package.json` together before distributing a new build. The current extension version is `1.0.0`.
