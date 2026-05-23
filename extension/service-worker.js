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

const recentEventsByTab = new Map();

async function storageSet(obj) {
  try {
    if (chrome.storage?.session) return await chrome.storage.session.set(obj);
    return await chrome.storage.local.set(obj);
  } catch {
    // ignore
  }
}

async function storageGet(keys) {
  try {
    if (chrome.storage?.session) return await chrome.storage.session.get(keys);
    return await chrome.storage.local.get(keys);
  } catch {
    return {};
  }
}

async function appendRecentEvent(tabId, event) {
  const key = `recentEvents:${tabId}`;
  const current = recentEventsByTab.get(tabId);
  let list = Array.isArray(current) ? current.slice() : null;
  if (!list) {
    const stored = await storageGet([key]);
    list = Array.isArray(stored?.[key]) ? stored[key] : [];
  }

  list.push(event);
  list = list.slice(-25);
  recentEventsByTab.set(tabId, list);
  await storageSet({ [key]: list });
  return list;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === 'PAGE_EVENT') {
        const tabId = _sender?.tab?.id;
        if (!tabId) {
          sendResponse({ ok: false, error: 'Missing sender tab.' });
          return;
        }

        const event = msg?.event;
        if (!event || typeof event !== 'object') {
          sendResponse({ ok: false, error: 'Missing event.' });
          return;
        }

        await appendRecentEvent(tabId, event);

        // Broadcast to any open sidepanel.
        try {
          chrome.runtime.sendMessage({ type: 'PAGE_EVENT', tabId, event });
        } catch {
          // ignore
        }

        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === 'CAPTURE_CONTEXT') {
        const tab = await getActiveTab();
        if (!tab?.id) {
          sendResponse({ ok: false, error: 'No active tab found.' });
          return;
        }

        await ensureContentScript(tab.id);
        const context = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CONTEXT' });
        const key = `recentEvents:${tab.id}`;
        const recentEvents = recentEventsByTab.get(tab.id) || (await storageGet([key]))?.[key] || [];
        sendResponse({ ok: true, context: { ...context, recentEvents } });
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
