chrome.action.onClicked.addListener(tab => {
  if (!tab.id) return;

  chrome.tabs.sendMessage(tab.id, { type: 'open-job-copier-panel' }, () => {
    if (!chrome.runtime.lastError) return;

    // If the tab was already open when the extension was loaded, inject it now.
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['decision-contract.js', 'indeed.js']
    }).catch(() => {
      // Ignore clicks on unsupported or restricted pages.
    });
  });
});
