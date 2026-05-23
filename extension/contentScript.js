function pickAccentColor() {
  const a = document.querySelector('a');
  if (a) {
    const c = getComputedStyle(a).color;
    if (c) return c;
  }
  return null;
}

function collectPrimaryActions() {
  const labels = [];

  const candidates = [
    ...document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a')
  ];

  for (const el of candidates.slice(0, 80)) {
    const t = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
    if (!t) continue;
    if (t.length > 60) continue;
    labels.push(t.replace(/\s+/g, ' '));
  }

  // de-dupe while preserving order
  return [...new Set(labels)].slice(0, 20);
}

function collectHeadings() {
  const hs = [...document.querySelectorAll('h1, h2')].slice(0, 10);
  return hs
    .map((h) => (h.innerText || '').trim())
    .filter(Boolean)
    .map((t) => t.replace(/\s+/g, ' '));
}

function getThemeHint() {
  const bodyStyle = getComputedStyle(document.body);
  return {
    fontFamily: bodyStyle.fontFamily || null,
    backgroundColor: bodyStyle.backgroundColor || null,
    textColor: bodyStyle.color || null,
    accentColor: pickAccentColor()
  };
}

function getSelectedText() {
  try {
    return (window.getSelection()?.toString() || '').trim();
  } catch {
    return '';
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'PING') {
    sendResponse({ ok: true });
    return;
  }

  if (msg?.type === 'GET_CONTEXT') {
    const context = {
      url: location.href,
      title: document.title,
      selectedText: getSelectedText(),
      headings: collectHeadings(),
      primaryActions: collectPrimaryActions(),
      themeHint: getThemeHint()
    };

    sendResponse(context);
    return;
  }
});
