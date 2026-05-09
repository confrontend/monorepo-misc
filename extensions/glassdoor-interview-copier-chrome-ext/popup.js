console.log('Popup v2 loaded');

let currentFilename = 'interviews.txt';
let currentContent = '';
let detectedCompany = 'interviews';
let statusTimeout;

chrome.storage.local.get(['filename', 'content'], (data) => {
  if (data.filename) currentFilename = data.filename;
  if (data.content) currentContent = data.content;
  console.log('Loaded:', {filename: currentFilename, contentLength: currentContent.length});
});

// Auto-detect company & page info
document.addEventListener('DOMContentLoaded', () => {
  chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
    chrome.tabs.sendMessage(tabs[0].id, {action: 'getPageInfo'}, (response) => {
      
      if (response) {
        detectedCompany = response.company.replace(/[^a-z0-9]/gi, '_');
        document.getElementById('filename').value = detectedCompany + '.txt';
        document.getElementById('currentPage').textContent = `Page: ${response.title}`;
        console.log('Page info:', response);
      }
    });
  });
});

document.getElementById('filename').addEventListener('input', (e) => {
  currentFilename = e.target.value || detectedCompany + '.txt';
});

function setStatus(msg, type = 'info') {
  const statusEl = document.getElementById('status');
  statusEl.textContent = msg;
  statusEl.className = type;
  clearTimeout(statusTimeout);
  statusTimeout = setTimeout(() => {
    statusEl.textContent = '';
    statusEl.className = '';
  }, 4000);
}

document.getElementById('copy').addEventListener('click', () => {
  setStatus('Copying page...', 'info');
  chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
    chrome.tabs.sendMessage(tabs[0].id, {action: 'copyPage'}, (response) => {
      if (response && response.content) {
        currentContent += response.content + '\n\n';
        downloadFile();
        setStatus(`Copied! Total: ${Math.round(currentContent.length/1000)}KB`, 'success');
        chrome.storage.local.set({content: currentContent});
      } else {
        setStatus('No content found', 'error');
        console.error('Copy failed:', response, chrome.runtime.lastError);
      }
    });
  });
});

document.getElementById('newfile').addEventListener('click', () => {
  currentContent = '';
  setStatus('New file ready', 'info');
  chrome.storage.local.set({content: ''});
});

document.getElementById('next').addEventListener('click', () => {
  setStatus('Clicking next...', 'info');
  chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
    chrome.tabs.sendMessage(tabs[0].id, {action: 'nextPage'}, () => {
      setStatus('Go to next page', 'success');
    });
  });
});

function downloadFile() {
  const safeFilename = (document.getElementById('filename').value || detectedCompany + '.txt').replace(/[^a-z0-9.-]/gi, '_');
  console.log('Saving:', safeFilename, currentContent.length);
  
  const blob = new Blob([currentContent], {type: 'text/plain'});
  const url = URL.createObjectURL(blob);
  
  chrome.downloads.download({
    url: url,
    filename: safeFilename,
    saveAs: false,
    conflictAction: 'overwrite'
  }, (downloadId) => {
    console.log('Download:', downloadId);
  });
}
