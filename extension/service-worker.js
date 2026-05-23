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

async function captureScreenshotForTab(tab) {
  try {
    if (!tab?.windowId) return null;
    // JPEG keeps payload smaller than PNG.
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'jpeg',
      quality: 60
    });
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return null;
    return dataUrl;
  } catch {
    return null;
  }
}

const recentEventsByTab = new Map();
const navGraphByTab = new Map();

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

function normalizeNavUrl(rawUrl) {
  try {
    if (!rawUrl) return null;
    const u = new URL(rawUrl);
    // Remove query params to avoid leaking tokens.
    return `${u.origin}${u.pathname}${u.hash || ''}`.slice(0, 180);
  } catch {
    return null;
  }
}

async function appendNavEdge(tabId, event) {
  const urlAfterRaw = event?.urlAfter;
  if (!urlAfterRaw) return null;

  const urlBefore = normalizeNavUrl(event?.urlBefore) || null;
  const urlAfter = normalizeNavUrl(urlAfterRaw) || null;
  if (!urlAfter) return null;
  if (urlBefore && urlAfter === urlBefore) return null;

  const label = typeof event?.label === 'string' ? event.label.trim().slice(0, 80) : null;
  const kind = typeof event?.kind === 'string' ? event.kind : null;

  const key = `navGraph:${tabId}`;
  let list = Array.isArray(navGraphByTab.get(tabId)) ? navGraphByTab.get(tabId).slice() : null;
  if (!list) {
    const stored = await storageGet([key]);
    list = Array.isArray(stored?.[key]) ? stored[key] : [];
  }

  const edge = {
    at: Date.now(),
    label,
    kind,
    from: urlBefore,
    to: urlAfter
  };

  const sig = `${(label || '').toLowerCase()}|${kind || ''}|${urlBefore || ''}|${urlAfter}`;
  const exists = list.some((e) => {
    const s = `${((e?.label || '') + '').toLowerCase()}|${e?.kind || ''}|${e?.from || ''}|${e?.to || ''}`;
    return s === sig;
  });
  if (!exists) list.push(edge);

  list = list.slice(-40);
  navGraphByTab.set(tabId, list);
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
  await appendNavEdge(tabId, event);

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

        const navKey = `navGraph:${tab.id}`;
        const navGraph = navGraphByTab.get(tab.id) || (await storageGet([navKey]))?.[navKey] || [];

        const includeScreenshot = Boolean(msg?.includeScreenshot);
        const screenshot = includeScreenshot ? await captureScreenshotForTab(tab) : null;

        sendResponse({ ok: true, context: { ...context, recentEvents, navGraph, screenshot } });
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
          label: msg?.label,
          actionId: msg?.actionId,
          hintText: msg?.hintText
        });
        sendResponse(result);
        return;
      }

      if (msg?.type === 'HIGHLIGHT_FUZZY') {
        const tab = await getActiveTab();
        if (!tab?.id) {
          sendResponse({ ok: false, error: 'No active tab found.' });
          return;
        }

        await ensureContentScript(tab.id);
        const result = await chrome.tabs.sendMessage(tab.id, {
          type: 'HIGHLIGHT_FUZZY',
          query: msg?.query
        });
        sendResponse(result);
        return;
      }

      if (msg?.type === 'CLEAR_TAB_STATE') {
        const tab = await getActiveTab();
        if (!tab?.id) {
          sendResponse({ ok: false, error: 'No active tab found.' });
          return;
        }

        try {
          recentEventsByTab.delete(tab.id);
          navGraphByTab.delete(tab.id);
        } catch {
          // ignore
        }

        try {
          await storageRemove([`recentEvents:${tab.id}`, `navGraph:${tab.id}`]);
        } catch {
          // ignore
        }

        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: 'Unknown message.' });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || 'Error' });
    }
  })();

  return true;
});
