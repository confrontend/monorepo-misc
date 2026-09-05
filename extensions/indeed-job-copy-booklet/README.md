# Indeed Job Copier

Versioned Chrome MV3 extension that saves job descriptions from Indeed, advances through the loaded job list, and exports the saved descriptions.

## Install locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this directory.
4. Open an Indeed Jobs search page and use the **Indeed Memory** panel.

The extension loads `indeed.js` as its content script.

## Release version

Update the `version` field in `manifest.json` and `package.json` together before distributing a new build. The current extension version is `1.0.0`.
