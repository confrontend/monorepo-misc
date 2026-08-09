const ALARM_NAME = 'screener-quant-link-traverser-next';
const OPEN_INTERVAL_MS = 1500;
const STATE_KEY = 'screenerQuantLinkTraverserState';

const defaultState = {
  running: false,
  queue: [],
  nextIndex: 0,
  openedCount: 0,
  sourceWindowId: null,
};

const getState = async () => {
  const stored = await chrome.storage.local.get({ [STATE_KEY]: defaultState });
  return { ...defaultState, ...stored[STATE_KEY] };
};

const saveState = (state) => chrome.storage.local.set({ [STATE_KEY]: state });

const publishStatus = async (state) => {
  await chrome.storage.local.set({
    screenerQuantLinkTraverserStatus: {
      running: state.running,
      total: state.queue.length,
      nextIndex: state.nextIndex,
      openedCount: state.openedCount,
    },
  });
};

const finish = async (state) => {
  state.running = false;
  await saveState(state);
  await publishStatus(state);
  await chrome.alarms.clear(ALARM_NAME);
};

const openNext = async () => {
  const state = await getState();
  if (!state.running) return;

  if (state.nextIndex >= state.queue.length) {
    await finish(state);
    return;
  }

  const url = state.queue[state.nextIndex];
  state.nextIndex += 1;
  state.openedCount += 1;
  await saveState(state);
  await publishStatus(state);

  try {
    await chrome.tabs.create({
      url,
      active: false,
      ...(Number.isInteger(state.sourceWindowId) ? { windowId: state.sourceWindowId } : {}),
    });
  } catch (error) {
    console.warn('Could not open screener link', url, error);
  }

  await chrome.alarms.create(ALARM_NAME, { delayInMinutes: OPEN_INTERVAL_MS / 60000 });
};

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) void openNext();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'start-traversal') {
    void (async () => {
      const urls = [...new Set(message.urls || [])];
      const state = {
        ...defaultState,
        running: urls.length > 0,
        queue: urls,
        sourceWindowId: message.windowId ?? sender.tab?.windowId ?? null,
      };
      await saveState(state);
      await publishStatus(state);
      await chrome.alarms.clear(ALARM_NAME);
      if (state.running) await openNext();
      sendResponse({ ok: true, total: urls.length });
    })();
    return true;
  }

  if (message?.type === 'stop-traversal') {
    void (async () => {
      const state = await getState();
      await finish(state);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message?.type === 'get-status') {
    void getState().then((state) => {
      sendResponse({
        running: state.running,
        total: state.queue.length,
        nextIndex: state.nextIndex,
        openedCount: state.openedCount,
      });
    });
    return true;
  }
});
