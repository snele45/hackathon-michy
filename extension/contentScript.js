function pickAccentColor() {
  const a = document.querySelector('a');
  if (a) {
    const c = getComputedStyle(a).color;
    if (c) return c;
  }
  return null;
}

function isElementVisible(element) {
  if (!element) return false;
  const style = getComputedStyle(element);
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden') return false;
  if (Number.parseFloat(style.opacity || '1') === 0) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  return true;
}

function getVisibleActionLabel(element) {
  if (!element) return '';

  // Only use what the user can actually see.
  const tag = element.tagName.toLowerCase();

  if (tag === 'input') {
    const type = (element.getAttribute('type') || '').toLowerCase();
    if (type === 'button' || type === 'submit' || type === 'reset') {
      return (element.value || '').trim();
    }
  }

  // Prefer innerText (respects visibility / rendered text).
  const t = (element.innerText || '').trim();
  if (t) return t;

  return '';
}

function getActionStyleSnapshot(element) {
  const s = getComputedStyle(element);
  return {
    backgroundColor: s.backgroundColor || null,
    color: s.color || null,
    borderColor: s.borderColor || null,
    borderWidth: s.borderWidth || null,
    borderStyle: s.borderStyle || null,
    borderRadius: s.borderRadius || null,
    padding: s.padding || null,
    fontSize: s.fontSize || null,
    fontWeight: s.fontWeight || null,
    textTransform: s.textTransform || null,
    letterSpacing: s.letterSpacing || null
  };
}

function describeElementKind(element) {
  const tag = element.tagName.toLowerCase();
  const type = tag === 'input' ? (element.getAttribute('type') || '').toLowerCase() : null;
  if (tag === 'button') return 'button';
  if (tag === 'a') return 'link';
  if (tag === 'input' && (type === 'button' || type === 'submit' || type === 'reset')) return 'input';
  if (element.getAttribute('role') === 'button') return 'role=button';
  return tag;
}

function collectActionCandidates() {
  const out = [];
  const candidates = [
    ...document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a')
  ];

  for (const el of candidates.slice(0, 180)) {
    if (!isElementVisible(el)) continue;
    const t = getVisibleActionLabel(el);
    if (!t) continue;
    const compact = t.replace(/\s+/g, ' ');
    if (compact.length > 60) continue;

    out.push({
      label: compact,
      kind: describeElementKind(el),
      style: getActionStyleSnapshot(el)
    });
  }

  // de-dupe by label while preserving first style snapshot
  const seen = new Set();
  const deduped = [];
  for (const item of out) {
    if (seen.has(item.label)) continue;
    seen.add(item.label);
    deduped.push(item);
  }

  return deduped.slice(0, 25);
}

function collectHeadings() {
  const hs = [...document.querySelectorAll('h1, h2')].slice(0, 20);
  return hs
    .filter((h) => isElementVisible(h))
    .map((h) => (h.innerText || '').trim())
    .filter(Boolean)
    .map((t) => t.replace(/\s+/g, ' '))
    .slice(0, 10);
}

function collectFieldLabels() {
  const labels = [];
  const els = [...document.querySelectorAll('label')].slice(0, 80);
  for (const l of els) {
    if (!isElementVisible(l)) continue;
    const t = (l.innerText || '').trim();
    if (!t) continue;
    const compact = t.replace(/\s+/g, ' ');
    if (compact.length > 60) continue;
    labels.push(compact);
  }
  return [...new Set(labels)].slice(0, 20);
}

function findClickableAncestor(node) {
  if (!node) return null;
  const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  if (!el) return null;
  return el.closest('button, [role="button"], input[type="button"], input[type="submit"], a');
}

let __obClickSeq = 0;
function emitPageEvent(event) {
  try {
    chrome.runtime.sendMessage({ type: 'PAGE_EVENT', event });
  } catch {
    // ignore
  }
}

// Track actionable clicks to allow the sidepanel to re-capture context and offer updated steps.
document.addEventListener(
  'click',
  (e) => {
    const targetEl = findClickableAncestor(e.target);
    if (!targetEl) return;
    if (!isElementVisible(targetEl)) return;

    const label = getVisibleActionLabel(targetEl).trim().replace(/\s+/g, ' ') || null;
    const kind = describeElementKind(targetEl);
    const urlBefore = location.href;
    const seq = ++__obClickSeq;
    const at = Date.now();

    emitPageEvent({
      kind,
      label,
      urlBefore,
      urlAfter: null,
      at,
      seq
    });

    setTimeout(() => {
      try {
        const urlAfter = location.href;
        if (urlAfter !== urlBefore) {
          emitPageEvent({
            kind,
            label,
            urlBefore,
            urlAfter,
            at: Date.now(),
            seq
          });
        }
      } catch {
        // ignore
      }
    }, 450);
  },
  true
);

function findBestActionElementByLabel(label) {
  const target = (label || '').trim().replace(/\s+/g, ' ');
  if (!target) return null;

  const candidates = [
    ...document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a')
  ];

  const normalizedTarget = target.toLowerCase();

  let exact = null;
  const partialMatches = [];
  for (const el of candidates) {
    if (!isElementVisible(el)) continue;
    const t = getVisibleActionLabel(el).trim().replace(/\s+/g, ' ');
    if (!t) continue;
    if (t.length > 60) continue;
    const normalized = t.toLowerCase();
    if (normalized === normalizedTarget) {
      exact = el;
      break;
    }
    if (normalized.includes(normalizedTarget)) {
      partialMatches.push({ el, label: t });
    }
  }

  if (exact) return { el: exact, matchedLabel: target };

  // Safe fallback: if the partial match is unique, use it.
  if (partialMatches.length === 1) {
    return { el: partialMatches[0].el, matchedLabel: partialMatches[0].label };
  }

  // If multiple partial matches, pick the shortest label (often the closest).
  if (partialMatches.length > 1) {
    partialMatches.sort((a, b) => a.label.length - b.label.length);
    return { el: partialMatches[0].el, matchedLabel: partialMatches[0].label };
  }

  return null;
}

function highlightElement(element) {
  if (!element) return;
  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });

  const prev = {
    outline: element.style.outline,
    outlineOffset: element.style.outlineOffset,
    transition: element.style.transition,
    backgroundColor: element.style.backgroundColor,
    boxShadow: element.style.boxShadow
  };

  element.style.transition = 'outline 120ms ease-in-out, box-shadow 120ms ease-in-out, background-color 120ms ease-in-out';
  element.style.outline = '4px solid rgba(37, 99, 235, 0.98)';
  element.style.outlineOffset = '6px';
  element.style.backgroundColor = 'rgba(37, 99, 235, 0.10)';
  element.style.boxShadow = '0 0 0 6px rgba(37, 99, 235, 0.12)';

  setTimeout(() => {
    element.style.outline = prev.outline;
    element.style.outlineOffset = prev.outlineOffset;
    element.style.transition = prev.transition;
    element.style.backgroundColor = prev.backgroundColor;
    element.style.boxShadow = prev.boxShadow;
  }, 2000);
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
    const actionCandidates = collectActionCandidates();
    const context = {
      url: location.href,
      title: document.title,
      selectedText: getSelectedText(),
      headings: collectHeadings(),
      actionCandidates,
      primaryActions: actionCandidates.map((a) => a.label),
      fieldLabels: collectFieldLabels(),
      themeHint: getThemeHint()
    };

    sendResponse(context);
    return;
  }

  if (msg?.type === 'HIGHLIGHT_ACTION') {
    const label = msg?.label;
    const match = findBestActionElementByLabel(label);
    if (!match?.el) {
      sendResponse({ ok: false, error: 'Could not find a visible element with that label.' });
      return;
    }
    highlightElement(match.el);
    sendResponse({ ok: true, matchedLabel: match.matchedLabel });
  }
});
