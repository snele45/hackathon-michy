chrome.runtime.onInstalled.addListener(() => {
  // Ensure side panel is enabled.
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch {
    // Ignore
  }
});

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs?.[0] || null;
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    return;
  } catch {
    // Not injected (or page doesn't allow). Try to inject.
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['contentScript.js']
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === 'CAPTURE_CONTEXT') {
        const tab = await getActiveTab();
        if (!tab?.id) {
          sendResponse({ ok: false, error: 'No active tab found.' });
          return;
        }

        await ensureContentScript(tab.id);
        const context = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CONTEXT' });
        sendResponse({ ok: true, context });
        return;
      }

      if (msg?.type === 'HIGHLIGHT_ACTION') {
        const tab = await getActiveTab();
        if (!tab?.id) {
          sendResponse({ ok: false, error: 'No active tab found.' });
          return;
        }

        await ensureContentScript(tab.id);
        const result = await chrome.tabs.sendMessage(tab.id, {
          type: 'HIGHLIGHT_ACTION',
          label: msg?.label
        });
        sendResponse(result);
        return;
      }

      sendResponse({ ok: false, error: 'Unknown message.' });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || 'Error' });
    }
  })();

  return true;
});
