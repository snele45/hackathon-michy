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

function compactTokens(str, max = 4) {
  const t = (str || '').trim();
  if (!t) return [];
  return t
    .split(/\s+/g)
    .filter(Boolean)
    .slice(0, max);
}

function getAttr(el, name) {
  try {
    return (el.getAttribute(name) || '').trim() || null;
  } catch {
    return null;
  }
}

function pickInterestingAttrs(el) {
  if (!el) return {};
  const attrs = {
    id: getAttr(el, 'id'),
    role: getAttr(el, 'role'),
    name: getAttr(el, 'name'),
    type: getAttr(el, 'type'),
    ariaLabel: getAttr(el, 'aria-label'),
    ariaHaspopup: getAttr(el, 'aria-haspopup'),
    ariaExpanded: getAttr(el, 'aria-expanded'),
    testid: getAttr(el, 'data-testid'),
    subpanelId: getAttr(el, 'data-subpanel-id'),
    labelAttr: getAttr(el, 'label')
  };

  const className = (el.className || '').toString();
  const classTokens = compactTokens(className, 4);
  if (classTokens.length) attrs.classTokens = classTokens;

  // Data-* keys can be very informative for component libraries.
  try {
    const dataKeys = [];
    for (const a of [...el.attributes]) {
      const n = (a?.name || '').toLowerCase();
      if (!n.startsWith('data-')) continue;
      if (n === 'data-testid' || n === 'data-subpanel-id') continue;
      dataKeys.push(n);
      if (dataKeys.length >= 6) break;
    }
    if (dataKeys.length) attrs.dataKeys = dataKeys;
  } catch {
    // ignore
  }

  // Drop nulls.
  for (const k of Object.keys(attrs)) if (attrs[k] == null) delete attrs[k];
  return attrs;
}

function buildDomHintPath(el) {
  try {
    if (!el) return '';
    const parts = [];
    let cur = el;
    for (let i = 0; i < 5 && cur; i++) {
      if (cur === document.body) break;
      const tag = (cur.tagName || '').toLowerCase();
      if (!tag) break;
      const id = getAttr(cur, 'id');
      const testid = getAttr(cur, 'data-testid');
      const role = getAttr(cur, 'role');
      const cls = compactTokens((cur.className || '').toString(), 2);
      const suffix = id
        ? `#${id}`
        : testid
          ? `[data-testid=${testid}]`
          : role
            ? `[role=${role}]`
            : cls.length
              ? `.${cls.join('.')}`
              : '';
      parts.push(`${tag}${suffix}`);
      cur = cur.parentElement;
    }
    return parts.join(' < ');
  } catch {
    return '';
  }
}

function fnv1aHex(str) {
  // Deterministic small hash for stable actionId (non-crypto).
  let h = 0x811c9dc5;
  const s = (str || '').toString();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // 32-bit FNV-1a multiply
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function safeCssValue(v) {
  const s = (v || '').toString();
  if (!s) return '';
  // Escape quotes/backslashes minimally.
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildBestSelectorForElement(el) {
  if (!el) return null;
  try {
    const tag = (el.tagName || '').toLowerCase();
    const id = getAttr(el, 'id');
    if (id) return `#${CSS.escape(id)}`;

    const testid = getAttr(el, 'data-testid');
    if (testid) return `${tag || '*'}[data-testid="${safeCssValue(testid)}"]`;

    const name = getAttr(el, 'name');
    if (name) return `${tag || '*'}[name="${safeCssValue(name)}"]`;

    const aria = getAttr(el, 'aria-label');
    if (aria) return `${tag || '*'}[aria-label="${safeCssValue(aria)}"]`;

    // As a last resort, fall back to a short dom hint path.
    const domPath = buildDomHintPath(el);
    return domPath ? { domPath } : null;
  } catch {
    return null;
  }
}

function computeActionId(el) {
  if (!el) return null;
  try {
    const tag = (el.tagName || '').toLowerCase();
    const kind = describeElementKind(el);
    const label = getVisibleActionLabel(el).trim().replace(/\s+/g, ' ').slice(0, 120);
    const href = safeHrefForElement(el) || '';
    const attrs = pickInterestingAttrs(el);
    const domPath = buildDomHintPath(el);
    const sig = [tag, kind || '', label || '', href, attrs.testid || '', attrs.id || '', attrs.ariaLabel || '', domPath].join('|');
    return `a_${fnv1aHex(sig)}`;
  } catch {
    return null;
  }
}

function elementEnabledState(el) {
  if (!el) return { enabled: null, disabledReason: null };
  try {
    const disabled = el.matches?.(':disabled,[aria-disabled="true"]') || false;
    if (disabled) return { enabled: false, disabledReason: 'disabled' };
    return { enabled: true, disabledReason: null };
  } catch {
    return { enabled: null, disabledReason: null };
  }
}

function elementSelectionState(el) {
  if (!el) return {};
  try {
    const expandedRaw = el.getAttribute?.('aria-expanded');
    const checkedRaw = el.getAttribute?.('aria-checked');
    const pressedRaw = el.getAttribute?.('aria-pressed');
    const selectedRaw = el.getAttribute?.('aria-selected');

    const expanded = expandedRaw === 'true' ? true : expandedRaw === 'false' ? false : null;
    const checked = checkedRaw === 'true' ? true : checkedRaw === 'false' ? false : null;
    const pressed = pressedRaw === 'true' ? true : pressedRaw === 'false' ? false : null;
    const selected = selectedRaw === 'true' ? true : selectedRaw === 'false' ? false : null;

    const out = {};
    if (expanded !== null) out.expanded = expanded;
    if (checked !== null) out.checked = checked;
    if (pressed !== null) out.pressed = pressed;
    if (selected !== null) out.selected = selected;
    return out;
  } catch {
    return {};
  }
}

function rectForElement(el) {
  try {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height)
    };
  } catch {
    return null;
  }
}

function semanticTypeForElement(el) {
  const kind = describeElementKind(el);
  const tag = (el?.tagName || '').toLowerCase();
  if (kind) return kind;
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return 'field';
  return 'action';
}

function buildUiActionsAndTargets() {
  const selector = `${getClickableSelectors()}, input, textarea, select, [contenteditable="true"]`;
  const nodes = [...document.querySelectorAll(selector)].slice(0, 900);

  const uiActions = [];
  const visualTargets = [];
  const actionIndex = new Map();

  for (const el of nodes) {
    if (!isElementVisible(el)) continue;

    const tag = (el.tagName || '').toLowerCase();
    const kind = semanticTypeForElement(el);
    let label = getVisibleActionLabel(el).trim().replace(/\s+/g, ' ');

    if (!label) {
      if (tag === 'input' || tag === 'textarea') {
        label = (getAttr(el, 'placeholder') || getAttr(el, 'aria-label') || getAttr(el, 'name') || '').trim();
      } else if (tag === 'select') {
        label = (getAttr(el, 'aria-label') || getAttr(el, 'name') || '').trim();
      }
    }

    // Filter noisy clickable labels, but keep fields.
    if ((kind === 'button' || kind === 'link' || kind === 'tab' || kind === 'menuitem' || kind === 'action') && label) {
      if (label.length > 70) continue;
      if (isNoisyActionLabel(label)) continue;
    }

    const actionId = computeActionId(el);
    if (!actionId) continue;

    const area = areaHintForElement(el);
    const rect = rectForElement(el);
    const { enabled } = elementEnabledState(el);
    const sel = elementSelectionState(el);

    const container = el.closest('nav, [role="navigation"], aside, header, form, [role="dialog"], [role="menu"], [role="listbox"], [role="tablist"], [role="toolbar"]');
    const containerId = container ? buildDomHintPath(container) : null;

    const domRef = buildBestSelectorForElement(el);
    actionIndex.set(actionId, {
      domRef,
      label: label || null
    });

    uiActions.push({
      actionId,
      label: label || null,
      semanticType: kind || null,
      visible: true,
      enabled: typeof enabled === 'boolean' ? enabled : null,
      area: area || null,
      containerId: containerId || null,
      rect,
      ...sel
    });

    // Keep a smaller list for visualTargets.
    if (visualTargets.length < 50 && rect && rect.w >= 6 && rect.h >= 6) {
      visualTargets.push({
        id: actionId,
        number: visualTargets.length + 1,
        label: label || null,
        kind: kind || null,
        enabled: typeof enabled === 'boolean' ? enabled : null,
        visible: true,
        area: area || null,
        rect
      });
    }

    if (uiActions.length >= 140) break;
  }

  return { uiActions, visualTargets, actionIndex };
}

function sanitizeHtmlSnippet(html) {
  const raw = (html || '').toString();
  if (!raw) return '';
  // Collapse whitespace
  let s = raw.replace(/\s+/g, ' ').trim();
  // Remove huge inline styles and values to reduce token size and avoid leaking.
  s = s.replace(/\sstyle="[^"]*"/gi, ' style="…"');
  s = s.replace(/\svalue="[^"]*"/gi, ' value="…"');
  // Cap overly long attribute values.
  s = s.replace(/(\w+\s*=\s*")([^"]{80,})(")/g, (_m, a, b, c) => `${a}${b.slice(0, 77)}…${c}`);
  // Hard cap.
  if (s.length > 700) s = `${s.slice(0, 697)}…`;
  return s;
}

function summarizeInteractive(el) {
  if (!el) return null;
  const tag = (el.tagName || '').toLowerCase();
  const label = getVisibleActionLabel(el).replace(/\s+/g, ' ').trim();
  const attrs = pickInterestingAttrs(el);
  return {
    tag,
    label: label ? (label.length > 80 ? `${label.slice(0, 77)}…` : label) : null,
    kind: describeElementKind(el),
    attrs
  };
}

function collectInteractiveContainers() {
  // Goal: detect component-library "button-like" UIs by scraping containers that *contain* interactives.
  // We return compact metadata + a short sanitized HTML snippet (NOT full DOM dump).
  const interactives = [
    ...document.querySelectorAll(
      `${getClickableSelectors()}, input, textarea, select, [contenteditable="true"]`
    )
  ];

  const out = [];
  const seen = new Set();

  for (const el of interactives.slice(0, 600)) {
    if (!isElementVisible(el)) continue;

    const container = el.closest(
      'div, section, form, fieldset, li, [role="group"], [role="dialog"], [role="tabpanel"], [data-testid], [data-subpanel-id]'
    );
    if (!container) continue;
    if (!isElementVisible(container)) continue;

    const key = buildDomHintPath(container);
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);

    // Ensure the container actually has multiple relevant descendants.
    const childInteractives = [...container.querySelectorAll(`${getClickableSelectors()}, input, textarea, select, [contenteditable="true"]`)]
      .filter(isElementVisible)
      .slice(0, 10);
    if (childInteractives.length === 0) continue;

    const snippet = sanitizeHtmlSnippet(container.outerHTML);
    const sample = [];
    for (const c of childInteractives.slice(0, 6)) {
      const sum = summarizeInteractive(c);
      if (sum) sample.push(sum);
    }

    // A small label hint near the container can help the model.
    let nearbyLabel = '';
    try {
      const lbl = container.querySelector('label, legend, summary');
      if (lbl && isElementVisible(lbl)) nearbyLabel = (lbl.innerText || '').replace(/\s+/g, ' ').trim();
    } catch {
      // ignore
    }

    out.push({
      area: areaHintForElement(container),
      domPath: key,
      attrs: pickInterestingAttrs(container),
      nearbyLabel: nearbyLabel ? nearbyLabel.slice(0, 80) : null,
      childCount: childInteractives.length,
      childSample: sample,
      htmlSnippet: snippet
    });

    if (out.length >= 18) break;
  }

  return out;
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
  // Social counters / profile meta are rarely helpful for workflows.
  if (/^\d+\s+(followers|following)$/i.test(t)) return true;
  if (/\b(contribution|contributions)\b/i.test(t) && /\b(settings|activity|count)\b/i.test(t)) return true;
  if (/^learn how we count contributions$/i.test(t)) return true;
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

function getSafeAttr(el, name, maxLen = 80) {
  try {
    if (!el) return null;
    const v = (el.getAttribute(name) || '').trim();
    if (!v) return null;
    return v.length > maxLen ? v.slice(0, maxLen) : v;
  } catch {
    return null;
  }
}

function getClassSig(el, maxLen = 120) {
  try {
    if (!el) return null;
    const cls = (el.className || '').toString().trim().replace(/\s+/g, ' ');
    if (!cls) return null;
    return cls.length > maxLen ? cls.slice(0, maxLen) : cls;
  } catch {
    return null;
  }
}

function isButtonLike(el) {
  if (!el) return false;
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'button') return true;
  if (tag === 'a' && el.getAttribute('href')) return true;
  const role = (el.getAttribute('role') || '').toLowerCase();
  if (role === 'button' || role === 'link' || role === 'menuitem' || role === 'option') return true;
  const testid = (el.getAttribute('data-testid') || '').toLowerCase();
  if (testid.includes('button')) return true;
  const cls = (el.className || '').toString().toLowerCase();
  if (/(^|\s)(btn|button)(\s|$)/i.test(cls) || cls.includes('button')) return true;
  const id = (el.getAttribute('id') || '').toLowerCase();
  if (id.includes('button') || id.startsWith('btn')) return true;
  if (el.hasAttribute('onclick')) return true;
  const tabindex = el.getAttribute('tabindex');
  if (tabindex && tabindex !== '-1') return true;
  return false;
}

function buttonishRegexHit(el) {
  // Generic signal for div-based UI kits.
  // Keep it simple and extensible: "btn" / "button".
  const re = /(btn|button)/i;
  if (!el) return null;
  const cls = (el.className || '').toString();
  if (cls && re.test(cls)) return 'class';
  const id = el.getAttribute && el.getAttribute('id');
  if (id && re.test(id)) return 'id';
  const testid = el.getAttribute && el.getAttribute('data-testid');
  if (testid && re.test(testid)) return 'data-testid';
  const aria = el.getAttribute && el.getAttribute('aria-label');
  if (aria && re.test(aria)) return 'aria-label';
  const title = el.getAttribute && el.getAttribute('title');
  if (title && re.test(title)) return 'title';
  // Scan a small subset of data-* attrs (best-effort, bounded)
  try {
    const attrs = el.attributes;
    if (attrs && attrs.length) {
      for (let i = 0; i < Math.min(attrs.length, 18); i++) {
        const a = attrs[i];
        if (!a) continue;
        const name = (a.name || '').toLowerCase();
        if (!name.startsWith('data-')) continue;
        const v = (a.value || '').toString();
        if (v && re.test(v)) return name;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function nearestContainerFor(el) {
  if (!el) return null;
  // Prefer semantic containers; fall back to div.
  return (
    el.closest('section, article, form, nav, aside, dialog, [role="dialog"], [role="menu"], [role="listbox"], ul, ol, li, table, tbody, tr, td, fieldset, details, summary, div') ||
    el.parentElement ||
    null
  );
}

function summarizeInteractiveElement(el) {
  if (!el) return null;
  const tag = (el.tagName || '').toLowerCase();
  const role = getSafeAttr(el, 'role', 40);
  const testid = getSafeAttr(el, 'data-testid', 80);
  const aria = getSafeAttr(el, 'aria-label', 80);
  const title = getSafeAttr(el, 'title', 80);

  let kind = 'other';
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || el.getAttribute('contenteditable') === 'true') kind = 'field';
  else if (isButtonLike(el)) kind = 'action';

  const label = (getVisibleActionLabel(el) || aria || title || '').trim().replace(/\s+/g, ' ') || null;

  const out = {
    kind,
    tag,
    role,
    label: label && label.length > 80 ? label.slice(0, 80) : label,
    id: getSafeAttr(el, 'id', 60),
    name: getSafeAttr(el, 'name', 60),
    type: tag === 'input' ? getSafeAttr(el, 'type', 40) : null,
    testid,
    ariaLabel: aria,
    title
  };

  const hit = buttonishRegexHit(el);
  if (hit && kind !== 'field') out.buttonRegexHit = hit;

  // Strip nulls.
  for (const k of Object.keys(out)) if (out[k] == null || out[k] === '') delete out[k];
  return out;
}

function collectInteractiveContainers() {
  // Goal: capture "weird UI" patterns where the clickable isn't a <button>,
  // but a div/span with data-testid/role/tabindex, and group them by container.
  const roots = [];
  const sidebar =
    document.querySelector('aside') ||
    document.querySelector('.sidebar') ||
    document.querySelector('.main-sidebar') ||
    document.querySelector('[class*="sidebar"]');
  if (sidebar) roots.push(sidebar);
  roots.push(document.body);

  const seenContainers = new WeakSet();
  const out = [];

  const MAX_DIV_SCAN = 9000;
  const MAX_CONTAINERS = 60;

  for (const root of roots) {
    if (!root) continue;
    const nodes = [...root.querySelectorAll('button, a[href], input, textarea, select, [role="button"], [role="link"], [role="menuitem"], [role="option"], [data-testid], [aria-haspopup], [aria-expanded], [tabindex]')].slice(0, 1200);
    for (const el of nodes) {
      if (!isElementVisible(el)) continue;

      const tag = (el.tagName || '').toLowerCase();
      const isField = tag === 'input' || tag === 'textarea' || tag === 'select' || el.getAttribute('contenteditable') === 'true';
      const isActionish = isButtonLike(el) || tag === 'button';
      if (!isField && !isActionish) continue;

      const container = nearestContainerFor(el);
      if (!container || !isElementVisible(container)) continue;

      if (seenContainers.has(container)) continue;
      seenContainers.add(container);

      // Pull a small set of child controls in this container.
      const childControls = [];
      const childNodes = [...container.querySelectorAll('button, a[href], input, textarea, select, [role="button"], [role="link"], [role="menuitem"], [role="option"], [data-testid], [tabindex]')].slice(0, 60);
      for (const child of childNodes) {
        if (!isElementVisible(child)) continue;
        const ctag = (child.tagName || '').toLowerCase();
        const cIsField = ctag === 'input' || ctag === 'textarea' || ctag === 'select' || child.getAttribute('contenteditable') === 'true';
        const cIsActionish = isButtonLike(child) || ctag === 'button';
        if (!cIsField && !cIsActionish) continue;
        const s = summarizeInteractiveElement(child);
        if (s) childControls.push(s);
        if (childControls.length >= 12) break;
      }

      // Only keep containers that actually look useful.
      if (childControls.length < 2) continue;

      const item = {
        tag: (container.tagName || '').toLowerCase(),
        id: getSafeAttr(container, 'id', 60),
        class: getClassSig(container, 140),
        role: getSafeAttr(container, 'role', 40),
        testid: getSafeAttr(container, 'data-testid', 80),
        label: getSafeAttr(container, 'label', 80),
        value: getSafeAttr(container, 'value', 80),
        dataSubpanelId: getSafeAttr(container, 'data-subpanel-id', 80),
        area: areaHintForElement(container),
        controls: childControls
      };

      for (const k of Object.keys(item)) if (item[k] == null || item[k] === '') delete item[k];
      out.push(item);
      if (out.length >= MAX_CONTAINERS) return out;
    }

    // Pass 2: scan ALL divs and pick the ones that look button-ish by regex.
    // This catches UI kits that use plain divs for controls.
    try {
      const divs = root.getElementsByTagName ? root.getElementsByTagName('div') : [];
      const limit = Math.min(divs.length || 0, MAX_DIV_SCAN);
      for (let i = 0; i < limit; i++) {
        const d = divs[i];
        if (!d || !isElementVisible(d)) continue;
        const hit = buttonishRegexHit(d);
        if (!hit && !isButtonLike(d)) continue;

        const container = nearestContainerFor(d);
        if (!container || !isElementVisible(container)) continue;
        if (seenContainers.has(container)) continue;
        seenContainers.add(container);

        const childControls = [];
        const childNodes = [...container.querySelectorAll('button, a[href], input, textarea, select, [role="button"], [role="link"], [role="menuitem"], [role="option"], [data-testid], [tabindex], div')].slice(0, 80);
        for (const child of childNodes) {
          if (!isElementVisible(child)) continue;
          const ctag = (child.tagName || '').toLowerCase();
          const cIsField = ctag === 'input' || ctag === 'textarea' || ctag === 'select' || child.getAttribute('contenteditable') === 'true';
          const cIsActionish = isButtonLike(child) || buttonishRegexHit(child);
          if (!cIsField && !cIsActionish) continue;
          const s = summarizeInteractiveElement(child);
          if (s) childControls.push(s);
          if (childControls.length >= 12) break;
        }

        if (childControls.length < 2) continue;

        const item = {
          tag: (container.tagName || '').toLowerCase(),
          id: getSafeAttr(container, 'id', 60),
          class: getClassSig(container, 140),
          role: getSafeAttr(container, 'role', 40),
          testid: getSafeAttr(container, 'data-testid', 80),
          label: getSafeAttr(container, 'label', 80),
          value: getSafeAttr(container, 'value', 80),
          dataSubpanelId: getSafeAttr(container, 'data-subpanel-id', 80),
          area: areaHintForElement(container),
          controls: childControls
        };
        for (const k of Object.keys(item)) if (item[k] == null || item[k] === '') delete item[k];
        out.push(item);
        if (out.length >= MAX_CONTAINERS) return out;
      }
    } catch {
      // ignore
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

function inferPreferredAreaFromHint(hintText) {
  const t = (hintText || '').toString().toLowerCase();
  if (!t) return null;
  if (t.includes('desn') || t.includes('right')) return 'right';
  if (t.includes('lev') || t.includes('left')) return 'left';
  if (t.includes('gore') || t.includes('top')) return 'top';
  if (t.includes('dole') || t.includes('bottom')) return 'bottom';
  if (t.includes('sred') || t.includes('main') || t.includes('central')) return 'main';
  return null;
}

function extractHintKeywords(hintText, max = 6) {
  const raw = (hintText || '').toString();
  if (!raw) return [];

  const stop = new Set([
    'u', 'na', 'i', 'ili', 'pa', 'da', 'je', 'se', 'su', 'od', 'do', 'za', 'sa', 'bez', 'kao', 'ovo', 'to', 'taj', 'ta', 'te',
    'the', 'and', 'or', 'to', 'of', 'in', 'on', 'a', 'an', 'is', 'are', 'be', 'with', 'by', 'then',
    'klikni', 'klik', 'click', 'unesi', 'upiši', 'upisi', 'type', 'enter', 'polje', 'field', 'panel', 'tab', 'menu', 'dugme', 'button'
  ]);

  const tokens = raw
    .replace(/[^\p{L}\p{N}\s_-]+/gu, ' ')
    .split(/\s+/g)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => x.toLowerCase())
    .filter((x) => x.length >= 4)
    .filter((x) => !stop.has(x));

  return [...new Set(tokens)].slice(0, max);
}

function extractHintPhrases(hintText, max = 4) {
  const raw = (hintText || '').toString();
  if (!raw) return [];
  const phrases = [];
  const re = /"([^"]{2,80})"|'([^']{2,80})'/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const p = (m[1] || m[2] || '').trim();
    if (!p) continue;
    phrases.push(p);
    if (phrases.length >= max) break;
  }
  return [...new Set(phrases)];
}

function scoreCandidateWithHint(el, label, hintText) {
  let score = scoreActionElement(el);

  const preferredArea = inferPreferredAreaFromHint(hintText);
  if (preferredArea) {
    const a = areaHintForElement(el);
    if (a === preferredArea) score += 10;
    else score -= 2;
  }

  const keywords = extractHintKeywords(hintText, 6);
  const phrases = extractHintPhrases(hintText, 4);
  if (keywords.length) {
    const container =
      el.closest('aside, nav, header, main, form, section, [role="dialog"], [role="region"], [aria-label], [data-testid]') ||
      el.parentElement;
    let hay = '';
    try {
      hay = (container?.innerText || '').toString().slice(0, 800).toLowerCase();
    } catch {
      hay = '';
    }

    // Also include nearby attributes (often unique per panel/component).
    let attrHay = '';
    try {
      const role = (container?.getAttribute?.('role') || '').toString();
      const testid = (container?.getAttribute?.('data-testid') || '').toString();
      const aria = (container?.getAttribute?.('aria-label') || '').toString();
      const id = (container?.getAttribute?.('id') || '').toString();
      const cls = (container?.className || '').toString();
      attrHay = `${role} ${testid} ${aria} ${id} ${cls}`.toLowerCase().slice(0, 400);
    } catch {
      attrHay = '';
    }

    let hits = 0;
    for (const k of keywords) {
      if (hay.includes(k) || attrHay.includes(k)) hits++;
    }
    score += Math.min(10, hits * 3);

    // Stronger phrase matches (usually the exact row/panel label the user should look for).
    if (phrases.length) {
      let phraseHits = 0;
      const hayNorm = normalizeTextForMatch(hay);
      const attrNorm = normalizeTextForMatch(attrHay);
      for (const p of phrases) {
        const pn = normalizeTextForMatch(p);
        if (!pn) continue;
        if (hayNorm.includes(pn) || attrNorm.includes(pn)) phraseHits++;
      }
      score += Math.min(18, phraseHits * 6);
    }
  }

  // Prefer aria-label exact match when available.
  try {
    const aria = (el.getAttribute?.('aria-label') || '').trim();
    if (aria && label && normalizeTextForMatch(aria) === normalizeTextForMatch(label)) score += 4;
  } catch {
    // ignore
  }

  return score;
}

// Make this script safe to inject multiple times in the same page.
// NOTE: Avoid top-level `let`/`const` that would redeclare and throw.
var __obGlobal = globalThis;
__obGlobal.__obState = __obGlobal.__obState || {
  clickSeq: 0,
  clickListenerInstalled: false,
  messageListenerInstalled: false,
  actionIndex: new Map()
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
      const actionId = computeActionId(targetEl);
      const kind = describeElementKind(targetEl);
      const urlBefore = location.href;
      const seq = ++__obGlobal.__obState.clickSeq;
      const at = Date.now();

      emitPageEvent({
        kind,
        label,
        actionId,
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
              actionId,
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

function findBestActionElementByLabel(label, options = {}) {
  const target = (label || '').trim().replace(/\s+/g, ' ');
  if (!target) return null;

  const hintText = options?.hintText || '';

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
    exactMatches.sort((a, b) => scoreCandidateWithHint(b.el, target, hintText) - scoreCandidateWithHint(a.el, target, hintText));
    return { el: exactMatches[0].el, matchedLabel: target };
  }

  // Safe fallback: if the partial match is unique, use it.
  if (partialMatches.length === 1) {
    return { el: partialMatches[0].el, matchedLabel: partialMatches[0].label };
  }

  // If multiple partial matches, pick the shortest label (often the closest).
  if (partialMatches.length > 1) {
    partialMatches.sort((a, b) => {
      const scoreDiff = scoreCandidateWithHint(b.el, partialMatches[0]?.label || target, hintText) - scoreCandidateWithHint(a.el, partialMatches[0]?.label || target, hintText);
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

function findBestFieldElementByLabel(label, options = {}) {
  const target = (label || '').trim().replace(/\s+/g, ' ');
  if (!target) return null;
  const normalizedTarget = target.toLowerCase();
  const hintText = options?.hintText || '';
  const preferredArea = inferPreferredAreaFromHint(hintText);

  const candidates = [...document.querySelectorAll('input, textarea, select, [contenteditable="true"]')];
  let exact = null;
  const partialMatches = [];

  for (const el of candidates) {
    if (!isElementVisible(el)) continue;
    if (!isLikelyTextField(el)) continue;
    if (preferredArea) {
      const a = areaHintForElement(el);
      if (a && a !== preferredArea) {
        // Not a hard filter; just de-prioritize by skipping on exact match only.
      }
    }
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
    partialMatches.sort((a, b) => {
      // Use similar hint scoring for fields when ambiguous.
      const as = scoreCandidateWithHint(a.el, a.label, hintText);
      const bs = scoreCandidateWithHint(b.el, b.label, hintText);
      const diff = bs - as;
      if (diff) return diff;
      return a.label.length - b.label.length;
    });
    return { el: partialMatches[0].el, matchedLabel: partialMatches[0].label };
  }

  // Heuristic fallback: sometimes the "label" is just visible text in a row,
  // while the actual input has no <label for>, placeholder, or name.
  // In that case, locate the text element and pick the nearest visible text field in the same container.
  const near = findNearestFieldByVisibleText(target);
  if (near?.el) return { el: near.el, matchedLabel: near.matchedLabel || target };

  return null;
}

function normalizeTextForMatch(t) {
  // Normalize for robust matching: lower-case, collapse whitespace, strip punctuation.
  return (t || '')
    .toString()
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeForMatch(t) {
  const n = normalizeTextForMatch(t);
  if (!n) return [];
  return n
    .split(/[\s_-]+/g)
    .map((x) => x.trim())
    .filter(Boolean);
}

function pickDistinctiveToken(t) {
  // Pick the last meaningful token (often the disambiguator: bool/byte/etc.).
  const toks = tokenizeForMatch(t);
  if (!toks.length) return null;
  const stop = new Set(['device', 'tag', 'item', 'value', 'field', 'input']);
  for (let i = toks.length - 1; i >= 0; i--) {
    const tok = toks[i];
    if (!tok) continue;
    if (tok.length < 3) continue;
    if (stop.has(tok)) continue;
    return tok;
  }
  return toks[toks.length - 1] || null;
}

function findNearestFieldByVisibleText(labelText) {
  const target = (labelText || '').trim().replace(/\s+/g, ' ');
  if (!target) return null;
  const normalizedTarget = normalizeTextForMatch(target);
  const targetTokens = tokenizeForMatch(target);
  const distinctive = pickDistinctiveToken(target);

  // Search common text-bearing nodes for the label.
  const candidates = [
    ...document.querySelectorAll('label, legend, summary, h1, h2, h3, h4, p, li, td, th, span, div')
  ];

  let best = null;
  for (const el of candidates.slice(0, 1800)) {
    if (!isElementVisible(el)) continue;
    const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (text.length > 140) continue;

    const normalized = normalizeTextForMatch(text);
    if (!normalized) continue;

    // Compute a match score instead of "first hit wins".
    let matchScore = 0;
    if (normalized === normalizedTarget) matchScore += 80;
    else if (normalized.includes(normalizedTarget)) matchScore += 45;
    else {
      // Token overlap fallback
      const tokens = tokenizeForMatch(normalized);
      let overlap = 0;
      for (const tok of targetTokens) if (tok && tokens.includes(tok)) overlap++;
      if (overlap < Math.min(2, Math.max(1, targetTokens.length))) continue;
      matchScore += overlap * 12;
    }

    // Soft boost if the distinctive token matches.
    if (distinctive && normalized.includes(distinctive)) matchScore += 12;

    // Find a nearby container and search for an input/textarea/select/contenteditable within.
    const container = el.closest('tr, li, [role="row"], [role="listitem"], .row, [data-row], div, section, form, fieldset') ||
      el.parentElement;
    if (!container) continue;

    const fieldNodes = [
      ...container.querySelectorAll('input, textarea, select, [contenteditable="true"]')
    ];

    // Prefer the field that is closest to the matched label element.
    const elRect = (() => {
      try {
        return el.getBoundingClientRect();
      } catch {
        return null;
      }
    })();

    for (const f of fieldNodes) {
      if (!isElementVisible(f)) continue;
      if (!isLikelyTextField(f)) continue;
      if (f.matches?.(':disabled,[aria-disabled="true"]')) continue;

      const rect = (() => {
        try {
          return f.getBoundingClientRect();
        } catch {
          return null;
        }
      })();

      const area = rect ? rect.width * rect.height : 0;
      let distancePenalty = 0;
      if (rect && elRect) {
        const dx = Math.abs((rect.left + rect.width / 2) - (elRect.left + elRect.width / 2));
        const dy = Math.abs((rect.top + rect.height / 2) - (elRect.top + elRect.height / 2));
        distancePenalty = (dx + dy) / 30;
      }

      const score = matchScore + Math.min(20, area / 150) - distancePenalty;
      if (!best || score > best.score) {
        best = { el: f, score, matchedLabel: text };
      }
    }
  }

  return best;
}

function findBestAnyElementByQuery(query, options = {}) {
  // 1) try actions, 2) try fields, 3) try headings/labels/text.
  const q = (query || '').trim();
  if (!q) return null;

  const hintText = options?.hintText || '';

  const action = findBestActionElementByLabel(q, { hintText });
  if (action?.el) return { ...action, kind: 'action' };

  const field = findBestFieldElementByLabel(q, { hintText });
  if (field?.el) return { ...field, kind: 'field' };

  // Extra fallback: treat query as visible text near an unlabeled field.
  const near = findNearestFieldByVisibleText(q);
  if (near?.el) return { el: near.el, matchedLabel: near.matchedLabel || q, kind: 'field' };

  const normalizedTarget = q.toLowerCase();
  const textCandidates = [...document.querySelectorAll('h1,h2,h3,h4,label,legend,summary,button,a,[role="button"],[role="link"],[role="menuitem"],[role="option"],[tabindex],p,li,td,th,span,div')];
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

  const RED = 'rgba(220, 38, 38, 0.98)';
  const RED_SOFT = 'rgba(220, 38, 38, 0.20)';
  const DIM = 'rgba(0, 0, 0, 0.35)';

  const prev = {
    outline: element.style.outline,
    outlineOffset: element.style.outlineOffset,
    transition: element.style.transition,
    backgroundColor: element.style.backgroundColor,
    boxShadow: element.style.boxShadow
  };

  element.style.transition = 'outline 120ms ease-in-out, box-shadow 120ms ease-in-out, background-color 120ms ease-in-out';
  // Stronger, more intuitive highlight: red outline + "spotlight" dimming around the element.
  element.style.outline = `6px solid ${RED}`;
  element.style.outlineOffset = '8px';
  element.style.backgroundColor = RED_SOFT;
  element.style.boxShadow = `0 0 0 10px ${RED_SOFT}, 0 0 0 9999px ${DIM}`;

  setTimeout(() => {
    element.style.outline = prev.outline;
    element.style.outlineOffset = prev.outlineOffset;
    element.style.transition = prev.transition;
    element.style.backgroundColor = prev.backgroundColor;
    element.style.boxShadow = prev.boxShadow;
  }, 2400);
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
      const interactiveContainers = collectInteractiveContainers();
      const { uiActions, visualTargets, actionIndex } = buildUiActionsAndTargets();

      // Update index so highlight-by-actionId works.
      __obGlobal.__obState.actionIndex = actionIndex;

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
        interactiveContainers,
        navigationGroups,
        primaryActions: dedupedPrimaryActions,
        fieldLabels: collectFieldLabels(),
        fieldCandidates,
        primaryFields: fieldCandidates.map((f) => f.label).filter(Boolean).slice(0, 20),
        dropdownTriggers,
        openMenuGroups,
        uiActions,
        visualTargets,
        themeHint: getThemeHint()
      };

      sendResponse(context);
      return;
    }

    if (msg?.type === 'HIGHLIGHT_ACTION') {
      (async () => {
        const actionId = msg?.actionId;
        const label = msg?.label;
        const hintText = msg?.hintText;

        // Prefer deterministic actionId lookup.
        if (typeof actionId === 'string' && actionId) {
          const entry = __obGlobal.__obState?.actionIndex?.get?.(actionId);
          const domRef = entry?.domRef;

          let el = null;
          if (typeof domRef === 'string') {
            el = document.querySelector(domRef);
          } else if (domRef && typeof domRef === 'object' && domRef.domPath) {
            // Fallback: locate by label if needed.
            el = null;
          }

          if (el && isElementVisible(el)) {
            highlightElement(el);
            sendResponse({ ok: true, matchedLabel: entry?.label || null, kind: describeElementKind(el) || null });
            return;
          }
        }

        // Backwards-compatible: allow highlighting fields too by label.
        let match = findBestAnyElementByQuery(label, { hintText });
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
