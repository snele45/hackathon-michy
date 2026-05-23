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

function areaFromRect(rect) {
  try {
    const vw = Math.max(1, window.innerWidth || 1);
    const vh = Math.max(1, window.innerHeight || 1);
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    if (cx <= vw * 0.28) return 'left';
    if (cx >= vw * 0.72) return 'right';
    if (cy <= vh * 0.20) return 'top';
    if (cy >= vh * 0.80) return 'bottom';
    return 'main';
  } catch {
    return null;
  }
}

function areaHintForElement(el) {
  if (!el) return null;
  try {
    const rect = el.getBoundingClientRect();
    return areaFromRect(rect);
  } catch {
    return null;
  }
}

function getVisibleActionLabel(element) {
  if (!element) return '';

  // Only use what the user can actually see.
  const tag = element.tagName.toLowerCase();

  if (tag === 'input') {
    const type = (element.getAttribute('type') || '').toLowerCase();
    if (type === 'button' || type === 'submit' || type === 'reset') {
      const v = (element.value || '').trim();
      if (v) return v;
    }
  }

  // Prefer innerText (respects visibility / rendered text).
  const t = (element.innerText || '').trim();
  if (t) return t;

  // Icon-only buttons/links often expose a usable label via aria-label/title.
  const aria = (element.getAttribute('aria-label') || '').trim();
  if (aria) return aria;
  const title = (element.getAttribute('title') || '').trim();
  if (title) return title;

  return '';
}

function isNoisyActionLabel(label) {
  const t = (label || '').trim();
  if (!t) return true;
  // Skip links are not useful for walkthrough.
  if (/^skip to /i.test(t)) return true;
  // Badges/counters like "3" or "15" are usually noise.
  if (/^\d{1,3}$/.test(t)) return true;
  return false;
}

function collectNavigationGroups() {
  // Best-effort: detect sidebar/header navigation lists and extract their items.
  const containers = [];
  const sidebar =
    document.querySelector('aside') ||
    document.querySelector('.sidebar') ||
    document.querySelector('.main-sidebar') ||
    document.querySelector('[class*="sidebar"]');
  if (sidebar) containers.push(sidebar);

  const navs = [...document.querySelectorAll('nav, [role="navigation"]')].slice(0, 6);
  for (const n of navs) containers.push(n);

  const groups = [];
  const seenGroupKeys = new Set();

  for (const container of containers) {
    if (!container || !isElementVisible(container)) continue;
    const key = container.className || container.id || container.tagName.toLowerCase();
    if (seenGroupKeys.has(key)) continue;
    seenGroupKeys.add(key);

    const items = [];
    const nodes = [...container.querySelectorAll(getClickableSelectors())].slice(0, 220);
    for (const node of nodes) {
      if (!isElementVisible(node)) continue;
      const t = getVisibleActionLabel(node).replace(/\s+/g, ' ').trim();
      if (!t) continue;
      if (t.length > 60) continue;
      if (isNoisyActionLabel(t)) continue;
      items.push(t);
      if (items.length >= 24) break;
    }

    const deduped = [...new Set(items)];
    if (deduped.length >= 4) {
      groups.push({
        kind: 'navigation',
        key: key || null,
        area: areaHintForElement(container),
        items: deduped
      });
    }

    if (groups.length >= 4) break;
  }

  return groups;
}

function collectNavItems(navigationGroups) {
  const out = [];
  const groups = Array.isArray(navigationGroups) ? navigationGroups : [];
  for (const g of groups) {
    if (!Array.isArray(g?.items)) continue;
    for (const item of g.items) out.push(item);
  }
  return [...new Set(out)].slice(0, 25);
}

function safeNavUrl(rawHref) {
  try {
    if (!rawHref) return null;
    const u = new URL(rawHref, location.href);
    // Avoid leaking tokens in query strings.
    return `${u.origin}${u.pathname}${u.hash || ''}`.slice(0, 160);
  } catch {
    return null;
  }
}

function collectNavLinkCandidates() {
  // Best-effort: collect visible anchors in detected navigation containers
  // and capture their destination (without query params).
  const containers = [];
  const sidebar =
    document.querySelector('aside') ||
    document.querySelector('.sidebar') ||
    document.querySelector('.main-sidebar') ||
    document.querySelector('[class*="sidebar"]');
  if (sidebar) containers.push(sidebar);

  const navs = [...document.querySelectorAll('nav, [role="navigation"]')].slice(0, 6);
  for (const n of navs) containers.push(n);

  const out = [];
  const seen = new Set();

  for (const container of containers) {
    if (!container || !isElementVisible(container)) continue;
    const groupKey = container.className || container.id || container.tagName.toLowerCase();
    const area = areaHintForElement(container);
    const anchors = [...container.querySelectorAll('a[href]')].slice(0, 220);
    for (const a of anchors) {
      if (!isElementVisible(a)) continue;
      const label = getVisibleActionLabel(a).replace(/\s+/g, ' ').trim();
      if (!label) continue;
      if (label.length > 60) continue;
      if (isNoisyActionLabel(label)) continue;
      const dest = safeNavUrl(a.getAttribute('href'));
      if (!dest) continue;
      const key = `${label.toLowerCase()}|${dest}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ label, to: dest, area, groupKey: groupKey || null });
      if (out.length >= 35) return out;
    }
  }

  return out;
}

function getAssociatedLabelText(fieldEl) {
  if (!fieldEl) return '';

  // 1) <label for="id">
  const id = (fieldEl.getAttribute('id') || '').trim();
  if (id) {
    const forLabel = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (forLabel && isElementVisible(forLabel)) {
      const t = (forLabel.innerText || '').trim();
      if (t) return t;
    }
  }

  // 2) Wrapped by <label>
  const parentLabel = fieldEl.closest('label');
  if (parentLabel && isElementVisible(parentLabel)) {
    const t = (parentLabel.innerText || '').trim();
    if (t) return t;
  }

  // 3) Nearby label-ish text in same container (best-effort)
  const container = fieldEl.closest('div, form, section') || fieldEl.parentElement;
  if (container) {
    const lbl = container.querySelector('label');
    if (lbl && isElementVisible(lbl)) {
      const t = (lbl.innerText || '').trim();
      if (t) return t;
    }
  }

  return '';
}

function getFieldPlaceholder(fieldEl) {
  if (!fieldEl) return '';
  const tag = fieldEl.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea') {
    return (fieldEl.getAttribute('placeholder') || '').trim();
  }
  return '';
}

function describeFieldKind(fieldEl) {
  const tag = fieldEl.tagName.toLowerCase();
  if (tag === 'textarea') return 'textarea';
  if (tag === 'select') return 'select';
  if (tag === 'input') {
    const type = (fieldEl.getAttribute('type') || '').toLowerCase();
    return type ? `input:${type}` : 'input';
  }
  if (fieldEl.getAttribute('contenteditable') === 'true') return 'contenteditable';
  return tag;
}

function isLikelyTextField(fieldEl) {
  const tag = fieldEl.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') {
    const type = (fieldEl.getAttribute('type') || 'text').toLowerCase();
    // Include common fill-in fields.
    return !['hidden', 'button', 'submit', 'reset', 'image', 'file', 'checkbox', 'radio', 'range', 'color'].includes(type);
  }
  if (fieldEl.getAttribute('contenteditable') === 'true') return true;
  return false;
}

function collectFieldCandidates() {
  const out = [];
  const nodes = [
    ...document.querySelectorAll(
      'input, textarea, select, [contenteditable="true"]'
    )
  ];

  for (const el of nodes.slice(0, 260)) {
    if (!isElementVisible(el)) continue;
    if (!isLikelyTextField(el)) continue;

    const label = (getAssociatedLabelText(el) || '').trim();
    const placeholder = (getFieldPlaceholder(el) || '').trim();
    const name = (el.getAttribute('name') || '').trim();

    const key = (label || placeholder || name || '').replace(/\s+/g, ' ').trim();
    if (!key) continue;
    if (key.length > 60) continue;

    let hasValue = false;
    let valueLength = 0;
    try {
      const tag = el.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea') {
        const v = (el.value || '').toString();
        valueLength = v.length;
        hasValue = valueLength > 0;
      }
    } catch {
      // ignore
    }

    let optionsCount = null;
    if (el.tagName.toLowerCase() === 'select') {
      try {
        optionsCount = el.options?.length ?? null;
      } catch {
        optionsCount = null;
      }
    }

    out.push({
      label: (label || placeholder || name).replace(/\s+/g, ' ').trim(),
      labelSource: label ? 'label' : placeholder ? 'placeholder' : 'name',
      placeholder: placeholder || null,
      name: name || null,
      kind: describeFieldKind(el),
      disabled: el.hasAttribute('disabled') || null,
      required: el.hasAttribute('required') || null,
      hasValue: hasValue || null,
      valueLength: Number.isFinite(valueLength) ? valueLength : null,
      optionsCount
    });
  }

  // De-dupe by label
  const seen = new Set();
  const deduped = [];
  for (const item of out) {
    const k = (item.label || '').toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    deduped.push(item);
  }
  return deduped.slice(0, 30);
}

function collectKeyTextSnippets() {
  const roots = [];
  const main = document.querySelector('main') || document.querySelector('[role="main"]');
  if (main) roots.push(main);
  roots.push(document.body);

  const snippets = [];
  const seen = new Set();
  for (const root of roots) {
    const nodes = [...root.querySelectorAll('p, li, h3, h4, .subtitle, .title')].slice(0, 240);
    for (const el of nodes) {
      if (!isElementVisible(el)) continue;
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (!t) continue;
      if (t.length < 18) continue;
      const compact = t.length > 110 ? t.slice(0, 110) : t;
      const k = compact.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      snippets.push(compact);
      if (snippets.length >= 12) return snippets;
    }
  }
  return snippets;
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
  if (tag === 'summary') return 'summary';
  if (element.getAttribute('role') === 'menuitem') return 'menuitem';
  if (element.getAttribute('role') === 'option') return 'option';
  if (element.getAttribute('role') === 'tab') return 'tab';
  if (element.getAttribute('role') === 'link') return 'role=link';
  if (element.getAttribute('role') === 'button') return 'role=button';
  return tag;
}

function getClickableSelectors() {
  // Keep this tight: only things users actually click in walkthroughs.
  return [
    'button',
    'a[href]',
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[role="tab"]',
    'summary',
    'input[type="button"]',
    'input[type="submit"]'
  ].join(', ');
}

function collectActionCandidates() {
  const out = [];
  const candidates = [...document.querySelectorAll(getClickableSelectors())];

  for (const el of candidates.slice(0, 320)) {
    if (!isElementVisible(el)) continue;
    const t = getVisibleActionLabel(el);
    if (!t) continue;
    const compact = t.replace(/\s+/g, ' ');
    if (compact.length > 60) continue;
    if (isNoisyActionLabel(compact)) continue;

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

  return deduped.slice(0, 40);
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
  return el.closest(getClickableSelectors());
}

function isNavContainer(el) {
  if (!el) return false;
  const container = el.closest('nav, [role="navigation"], aside, .sidebar, .main-sidebar, [class*="sidebar"]');
  return Boolean(container && isElementVisible(container));
}

function safeHrefForElement(el) {
  try {
    if (!el) return null;
    const tag = el.tagName?.toLowerCase?.() || '';
    if (tag !== 'a') return null;
    const raw = el.getAttribute('href');
    if (!raw) return null;
    const trimmed = raw.trim();
    if (!trimmed || trimmed === '#') return null;
    if (/^javascript:/i.test(trimmed)) return null;
    const u = new URL(trimmed, location.href);
    return `${u.origin}${u.pathname}${u.hash || ''}`.slice(0, 180);
  } catch {
    return null;
  }
}

function scoreActionElement(el) {
  if (!el) return -999;
  let score = 0;

  // Prefer navigation/sidebar items when ambiguous.
  if (isNavContainer(el)) score += 6;

  const href = safeHrefForElement(el);
  if (href) {
    score += 4;

    // Prefer links that lead somewhere different than the current page.
    const current = safeNavUrl(location.href);
    if (current && href !== current) score += 2;
  }

  // Prefer more specific (shorter) labels when multiple matches exist.
  const label = getVisibleActionLabel(el).trim().replace(/\s+/g, ' ');
  if (label) score += Math.max(0, 6 - Math.min(6, Math.floor(label.length / 10)));

  // De-prioritize disabled controls.
  if (el.matches?.(':disabled,[aria-disabled="true"]')) score -= 4;

  return score;
}

// Make this script safe to inject multiple times in the same page.
// NOTE: Avoid top-level `let`/`const` that would redeclare and throw.
var __obGlobal = globalThis;
__obGlobal.__obState = __obGlobal.__obState || {
  clickSeq: 0,
  clickListenerInstalled: false,
  messageListenerInstalled: false
};

function emitPageEvent(event) {
  try {
    chrome.runtime.sendMessage({ type: 'PAGE_EVENT', event });
  } catch {
    // ignore
  }
}

// Track actionable clicks to allow the sidepanel to re-capture context and offer updated steps.
if (!__obGlobal.__obState.clickListenerInstalled) {
  document.addEventListener(
    'click',
    (e) => {
      const targetEl = findClickableAncestor(e.target);
      if (!targetEl) return;
      if (!isElementVisible(targetEl)) return;

      const label = getVisibleActionLabel(targetEl).trim().replace(/\s+/g, ' ') || null;
      const kind = describeElementKind(targetEl);
      const urlBefore = location.href;
      const seq = ++__obGlobal.__obState.clickSeq;
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
  __obGlobal.__obState.clickListenerInstalled = true;
}

function findBestActionElementByLabel(label) {
  const target = (label || '').trim().replace(/\s+/g, ' ');
  if (!target) return null;

  const candidates = [...document.querySelectorAll(getClickableSelectors())];

  const normalizedTarget = target.toLowerCase();

  const exactMatches = [];
  const partialMatches = [];
  for (const el of candidates) {
    if (!isElementVisible(el)) continue;
    const t = getVisibleActionLabel(el).trim().replace(/\s+/g, ' ');
    if (!t) continue;
    if (t.length > 60) continue;
    const normalized = t.toLowerCase();
    if (normalized === normalizedTarget) {
      exactMatches.push({ el, label: t });
      continue;
    }
    if (normalized.includes(normalizedTarget)) {
      partialMatches.push({ el, label: t });
    }
  }

  if (exactMatches.length === 1) return { el: exactMatches[0].el, matchedLabel: target };
  if (exactMatches.length > 1) {
    exactMatches.sort((a, b) => scoreActionElement(b.el) - scoreActionElement(a.el));
    return { el: exactMatches[0].el, matchedLabel: target };
  }

  // Safe fallback: if the partial match is unique, use it.
  if (partialMatches.length === 1) {
    return { el: partialMatches[0].el, matchedLabel: partialMatches[0].label };
  }

  // If multiple partial matches, pick the shortest label (often the closest).
  if (partialMatches.length > 1) {
    partialMatches.sort((a, b) => {
      const scoreDiff = scoreActionElement(b.el) - scoreActionElement(a.el);
      if (scoreDiff) return scoreDiff;
      return (a.label || '').length - (b.label || '').length;
    });
    return { el: partialMatches[0].el, matchedLabel: partialMatches[0].label };
  }

  return null;
}

function getVisibleFieldLabel(fieldEl) {
  const label = (getAssociatedLabelText(fieldEl) || '').trim();
  if (label) return label;
  const placeholder = (getFieldPlaceholder(fieldEl) || '').trim();
  if (placeholder) return placeholder;
  const name = (fieldEl.getAttribute('name') || '').trim();
  if (name) return name;
  return '';
}

function findBestFieldElementByLabel(label) {
  const target = (label || '').trim().replace(/\s+/g, ' ');
  if (!target) return null;
  const normalizedTarget = target.toLowerCase();

  const candidates = [...document.querySelectorAll('input, textarea, select, [contenteditable="true"]')];
  let exact = null;
  const partialMatches = [];

  for (const el of candidates) {
    if (!isElementVisible(el)) continue;
    if (!isLikelyTextField(el)) continue;
    const t = getVisibleFieldLabel(el).trim().replace(/\s+/g, ' ');
    if (!t) continue;
    if (t.length > 60) continue;
    const normalized = t.toLowerCase();
    if (normalized === normalizedTarget) {
      exact = el;
      break;
    }
    if (normalized.includes(normalizedTarget) || normalizedTarget.includes(normalized)) {
      partialMatches.push({ el, label: t });
    }
  }

  if (exact) return { el: exact, matchedLabel: target };
  if (partialMatches.length === 1) return { el: partialMatches[0].el, matchedLabel: partialMatches[0].label };
  if (partialMatches.length > 1) {
    partialMatches.sort((a, b) => a.label.length - b.label.length);
    return { el: partialMatches[0].el, matchedLabel: partialMatches[0].label };
  }

  return null;
}

function findBestAnyElementByQuery(query) {
  // 1) try actions, 2) try fields, 3) try headings/labels/text.
  const q = (query || '').trim();
  if (!q) return null;

  const action = findBestActionElementByLabel(q);
  if (action?.el) return { ...action, kind: 'action' };

  const field = findBestFieldElementByLabel(q);
  if (field?.el) return { ...field, kind: 'field' };

  const normalizedTarget = q.toLowerCase();
  const textCandidates = [...document.querySelectorAll('h1,h2,h3,label,legend,summary,button,a,[role="button"],[role="link"],p,li')];
  const matches = [];
  for (const el of textCandidates.slice(0, 500)) {
    if (!isElementVisible(el)) continue;
    const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 120) continue;
    const n = t.toLowerCase();
    if (n === normalizedTarget) return { el, matchedLabel: t, kind: 'text' };
    if (n.includes(normalizedTarget)) matches.push({ el, label: t, kind: 'text' });
  }
  if (matches.length === 1) return { el: matches[0].el, matchedLabel: matches[0].label, kind: 'text' };
  if (matches.length > 1) {
    matches.sort((a, b) => a.label.length - b.label.length);
    return { el: matches[0].el, matchedLabel: matches[0].label, kind: 'text' };
  }
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function tryPressEscape() {
  try {
    const evt = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(evt);
  } catch {
    // ignore
  }
}

async function tryOpenMenusThenFind(label) {
  const target = (label || '').trim();
  if (!target) return null;

  let triggers = collectDropdownTriggers();
  if (!Array.isArray(triggers) || triggers.length === 0) return null;

  // Prefer collapsed triggers first.
  triggers = triggers
    .filter((t) => t?.label && !isNoisyActionLabel(t.label))
    .sort((a, b) => {
      const ae = a?.expanded === false ? 0 : a?.expanded === true ? 2 : 1;
      const be = b?.expanded === false ? 0 : b?.expanded === true ? 2 : 1;
      return ae - be;
    });

  const max = Math.min(6, triggers.length);
  for (let i = 0; i < max; i++) {
    const t = triggers[i];
    const triggerMatch = findBestActionElementByLabel(t.label);
    const triggerEl = triggerMatch?.el;
    if (!triggerEl) continue;
    if (!isElementVisible(triggerEl)) continue;

    // Open.
    try {
      triggerEl.click();
    } catch {
      // ignore
    }
    await sleep(90);

    const match = findBestActionElementByLabel(target);
    if (match?.el) return match;

    // Close (best-effort).
    tryPressEscape();
    try {
      triggerEl.click();
    } catch {
      // ignore
    }
    await sleep(70);
  }

  return null;
}

function getDropdownTriggerLabel(el) {
  if (!el) return '';
  const tag = el.tagName.toLowerCase();
  if (tag === 'select') {
    const l = (getAssociatedLabelText(el) || '').trim();
    if (l) return l;
    return (el.getAttribute('name') || '').trim();
  }
  if (tag === 'input' || tag === 'textarea') {
    return (getAssociatedLabelText(el) || getFieldPlaceholder(el) || el.getAttribute('name') || '').trim();
  }
  return (getVisibleActionLabel(el) || el.innerText || '').trim();
}

function collectDropdownTriggers() {
  const out = [];
  const nodes = [
    ...document.querySelectorAll(
      'select, summary, [role="combobox"], [aria-haspopup], [aria-expanded]'
    )
  ];

  for (const el of nodes.slice(0, 240)) {
    if (!isElementVisible(el)) continue;
    const label = getDropdownTriggerLabel(el).replace(/\s+/g, ' ').trim();
    if (!label) continue;
    if (label.length > 60) continue;
    const expandedAttr = (el.getAttribute('aria-expanded') || '').toLowerCase();
    const expanded = expandedAttr === 'true' ? true : expandedAttr === 'false' ? false : null;
    const haspopup = (el.getAttribute('aria-haspopup') || '').toLowerCase() || null;
    out.push({
      label,
      kind: describeElementKind(el),
      role: el.getAttribute('role') || null,
      haspopup,
      expanded,
      area: areaHintForElement(el)
    });
  }

  const seen = new Set();
  const deduped = [];
  for (const item of out) {
    const k = item.label.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(item);
  }
  return deduped.slice(0, 20);
}

function collectOpenMenuGroups() {
  const groups = [];
  const containers = [...document.querySelectorAll('[role="menu"], [role="listbox"], [role="tree"], [role="dialog"], [role="menuitem"], [role="option"]')];

  // Pick likely containers (menu/listbox/tree/dialog) that are visible and big enough.
  const picked = [];
  for (const el of containers) {
    const role = el.getAttribute('role');
    if (!role || !['menu', 'listbox', 'tree', 'dialog'].includes(role)) continue;
    if (!isElementVisible(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 80 || rect.height < 40) continue;
    picked.push(el);
    if (picked.length >= 10) break;
  }

  for (const container of picked) {
    const role = container.getAttribute('role') || container.tagName.toLowerCase();
    const items = [];
    const nodes = [...container.querySelectorAll('[role="menuitem"], [role="option"], [role="treeitem"], button, a[href]')].slice(0, 80);
    for (const node of nodes) {
      if (!isElementVisible(node)) continue;
      const t = getVisibleActionLabel(node).replace(/\s+/g, ' ').trim();
      if (!t) continue;
      if (t.length > 60) continue;
      items.push(t);
      if (items.length >= 12) break;
    }
    const deduped = [...new Set(items)];
    if (deduped.length >= 2) {
      groups.push({ kind: role, items: deduped });
    }
  }

  return groups.slice(0, 6);
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

if (!__obGlobal.__obState.messageListenerInstalled) {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'PING') {
      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === 'GET_CONTEXT') {
      const actionCandidates = collectActionCandidates();
      const fieldCandidates = collectFieldCandidates();
      const dropdownTriggers = collectDropdownTriggers();
      const openMenuGroups = collectOpenMenuGroups();
      const navigationGroups = collectNavigationGroups();
      const navItems = collectNavItems(navigationGroups);
      const navLinkCandidates = collectNavLinkCandidates();

      // Prefer nav items first for primaryActions (walkthrough oriented).
      const otherActions = actionCandidates.map((a) => a.label).filter(Boolean);
      const primaryActions = [...navItems, ...otherActions].filter(Boolean);
      const dedupedPrimaryActions = [...new Set(primaryActions)].slice(0, 35);
      const context = {
        url: location.href,
        title: document.title,
        selectedText: getSelectedText(),
        headings: collectHeadings(),
        actionCandidates,
        navItems,
        navLinkCandidates,
        navigationGroups,
        primaryActions: dedupedPrimaryActions,
        fieldLabels: collectFieldLabels(),
        fieldCandidates,
        primaryFields: fieldCandidates.map((f) => f.label).filter(Boolean).slice(0, 20),
        dropdownTriggers,
        openMenuGroups,
        themeHint: getThemeHint()
      };

      sendResponse(context);
      return;
    }

    if (msg?.type === 'HIGHLIGHT_ACTION') {
      (async () => {
        const label = msg?.label;
        // Backwards-compatible: allow highlighting fields too.
        let match = findBestAnyElementByQuery(label);
        if (!match?.el) {
          // If it's inside a menu that isn't open yet, try opening dropdowns.
          match = await tryOpenMenusThenFind(label);
        }

        if (!match?.el) {
          sendResponse({ ok: false, error: 'Could not find a visible element with that label.' });
          return;
        }
        highlightElement(match.el);
        sendResponse({ ok: true, matchedLabel: match.matchedLabel, kind: match.kind || null });
      })();
      return true;
    }

    if (msg?.type === 'HIGHLIGHT_FUZZY') {
      const q = msg?.query;
      const match = findBestAnyElementByQuery(q);
      if (!match?.el) {
        sendResponse({ ok: false, error: 'Could not locate any visible match for that text.' });
        return;
      }
      highlightElement(match.el);
      sendResponse({ ok: true, matchedLabel: match.matchedLabel, kind: match.kind || null });
      return;
    }
  });
  __obGlobal.__obState.messageListenerInstalled = true;
}
