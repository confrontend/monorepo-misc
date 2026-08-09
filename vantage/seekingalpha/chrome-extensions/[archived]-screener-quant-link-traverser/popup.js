const startButton = document.querySelector('#start');
const stopButton = document.querySelector('#stop');
const status = document.querySelector('#status');

const showStatus = ({ running, total = 0, openedCount = 0 }) => {
  status.textContent = running
    ? `Running: ${openedCount}/${total} opened`
    : total > 0 ? `Stopped: ${openedCount}/${total} opened` : 'Ready';
};

const getCurrentTab = async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0];

startButton.addEventListener('click', async () => {
  const tab = await getCurrentTab();
  if (!tab?.id) return;

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'collect-links' });
    const result = await chrome.runtime.sendMessage({
      type: 'start-traversal',
      urls: response?.urls || [],
      windowId: tab.windowId,
    });
    status.textContent = result?.total ? `Started: ${result.total} unique links` : 'No matching links found';
  } catch {
    status.textContent = 'Could not read this page. Reload it and try again.';
  }
});

stopButton.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'stop-traversal' });
  status.textContent = 'Stopped';
});

chrome.runtime.sendMessage({ type: 'get-status' }).then(showStatus);
