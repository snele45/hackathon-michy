let state = {
  backendUrl: 'http://localhost:8787',
  context: null,
  screenshotCache: {
    pageKey: null,
    screenshot: null
  },
  steps: [],
  currentStepIndex: 0,
  history: [],
  busy: false,
  lastPageEventAt: 0,
  walkthroughTrace: [],
  autoRefreshEnabled: true,
  walkthroughCompleted: false,
  session: {
    id: 1,
    startedAt: Date.now(),
    pageKey: null
  },
  postClickRefresh: { timer: null, lastSeq: 0 },
  lastInteraction: { at: 0, eventType: null, actionId: null },
  loopGuard: {
    // key -> count
    counts: {},
    // last key we observed
    lastKey: null
  }
  ,final: {
    awaitingConfirmation: false,
    lastStepIssuedAt: 0,
    lastStepIsFinal: false,
    lastStepActionId: null,
    lastStepActionLabel: null,
    executedAt: 0,
    preSig: null,
    preSvgSig: null,
    postSig: null,
    postSvgSig: null,
    successKind: null
  }
};

function schedulePostProgressRefresh(seq) {
  const s = Number.isFinite(seq) ? seq : 0;
  if (s <= state.postClickRefresh.lastSeq) return;
  state.postClickRefresh.lastSeq = s;

  if (state.postClickRefresh.timer) {
    clearTimeout(state.postClickRefresh.timer);
    state.postClickRefresh.timer = null;
  }

  // DOM updates after a click can be async (framework re-render). Re-capture once more quietly.
  state.postClickRefresh.timer = setTimeout(async () => {
    state.postClickRefresh.timer = null;
    if (state.busy) return;
    if (state.walkthroughCompleted) return;
    if (!state.context) return;
    if (!Array.isArray(state.steps) || state.steps.length === 0) return;

    try {
      await captureContext();
      await refreshCurrentStepHelp({ reason: 'dom' });
    } catch {
      // ignore
    }
  }, 650);
}

const el = (id) => document.getElementById(id);

function setThemeFromHint(themeHint) {
  if (!themeHint) return;
  // Keep a unified, predictable UI in the side panel.
  // We do not adopt page fonts/colors; the panel uses its own design tokens.
}

function render() {
  const ctx = state.context;
  el('pageTitle').textContent = ctx?.title || 'No page captured yet';
  el('pageMeta').textContent = ctx?.url ? ctx.url : '';

  // Simple flow: allow typing a goal anytime; Explain will auto-capture context.
  const goalEl = el('goal');
  const explainBtn = el('explain');
  goalEl.disabled = false;
  explainBtn.disabled = !goalEl.value.trim() || state.busy;
  // Context preview removed (no longer needed).

  const stepsEl = el('steps');
  stepsEl.innerHTML = '';
  state.steps.forEach((s, idx) => {
    const li = document.createElement('li');
    li.className = idx === state.currentStepIndex ? 'active' : '';
    const title = document.createElement('div');
    title.style.fontWeight = '700';
    title.textContent = s.title || `Step ${idx + 1}`;
    const details = document.createElement('div');
    details.style.color = 'var(--ui-muted)';
    details.style.marginTop = '4px';
    details.textContent = s.details || '';
    li.appendChild(title);
    li.appendChild(details);

    const actionLabel = typeof s.actionLabel === 'string' ? s.actionLabel.trim() : '';
    const actionId = typeof s.actionId === 'string' ? s.actionId.trim() : '';
    if (actionLabel || actionId) {
      const meta = document.createElement('div');
      meta.className = 'stepMeta';

      const preview = document.createElement('button');
      preview.type = 'button';
      preview.className = 'actionPreview';
      preview.textContent = actionLabel || actionId;

      const candidate = findActionCandidate(actionLabel);
      applyPreviewStyle(preview, candidate);

      preview.addEventListener('click', async () => {
        setStatus('');
        try {
          const r = await chrome.runtime.sendMessage({
            type: 'HIGHLIGHT_ACTION',
            label: actionLabel || null,
            actionId: actionId || null,
            hintText: typeof s?.details === 'string' ? s.details : null
          });
          if (!r?.ok) {
            setStatus(r?.error || 'Could not locate that element on the page.');
            return;
          }

          if (r?.matchedLabel && actionLabel && r.matchedLabel !== actionLabel) {
            setStatus(`Located: ${r.matchedLabel}`);
          }
        } catch {
          setStatus('Failed to send highlight request.');
        }
      });

      const hint = document.createElement('div');
      hint.className = 'hintPill';
      hint.textContent = 'Click preview to locate';

      meta.appendChild(preview);
      meta.appendChild(hint);
      li.appendChild(meta);
    } else {
      const suggestions = findTargetSuggestions(s, state.context);
      if (suggestions.length) {
        const meta = document.createElement('div');
        meta.className = 'stepMeta';

        const hint = document.createElement('div');
        hint.className = 'hintPill';
        hint.textContent = 'Pick target to locate';
        meta.appendChild(hint);

        for (const sug of suggestions) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'actionPreview secondary';
          btn.textContent = sug.label;
          if (sug?.style) applyPreviewStyle(btn, { style: sug.style });
          btn.addEventListener('click', async () => {
            setStatus('');
            // Persist the chosen target so progress detection becomes deterministic.
            const next = {
              ...s,
              actionLabel: sug.label,
              ...(sug.actionId ? { actionId: sug.actionId } : {})
            };
            state.steps[idx] = next;
            render();

            try {
              const r = await chrome.runtime.sendMessage({
                type: 'HIGHLIGHT_ACTION',
                label: sug.label || null,
                actionId: sug.actionId || null,
                hintText: typeof s?.details === 'string' ? s.details : null
              });
              if (!r?.ok) {
                setStatus(r?.error || 'Could not locate that element on the page.');
                return;
              }
              if (r?.matchedLabel && r.matchedLabel !== sug.label) setStatus(`Located: ${r.matchedLabel}`);
            } catch {
              setStatus('Failed to send highlight request.');
            }
          });
          meta.appendChild(btn);
        }

        li.appendChild(meta);
      }
    }

    stepsEl.appendChild(li);
  });

  const doneBtn = el('done');
  const finalYes = el('finalYes');
  const finalNo = el('finalNo');

  const awaitingFinal = Boolean(state.final?.awaitingConfirmation);
  if (finalYes) finalYes.style.display = awaitingFinal ? '' : 'none';
  if (finalNo) finalNo.style.display = awaitingFinal ? '' : 'none';
  if (doneBtn) doneBtn.style.display = awaitingFinal ? 'none' : '';
  const hasSteps = state.steps.length > 0;
  if (doneBtn) {
    doneBtn.disabled = !hasSteps || state.walkthroughCompleted;
    doneBtn.textContent = state.walkthroughCompleted ? 'Completed' : 'Done';
    doneBtn.classList.toggle('primary', hasSteps && !state.walkthroughCompleted);
  }

  if (finalYes) finalYes.disabled = !awaitingFinal || state.busy;
  if (finalNo) finalNo.disabled = !awaitingFinal || state.busy;
}

function tracePush(entry) {
  const e = {
    at: Date.now(),
    ...entry
  };
  state.walkthroughTrace.push(e);
  // Keep it bounded.
  if (state.walkthroughTrace.length > 120) state.walkthroughTrace = state.walkthroughTrace.slice(-120);
}

function normalizeUrlForSession(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return (url || '').trim();
  }
}

function resetAiContext({ reason, keepContext }) {
  const preservedContext = keepContext ? state.context : null;
  const preservedThemeHint = keepContext ? state.context?.themeHint : null;

  state.steps = [];
  state.currentStepIndex = 0;
  state.history = [];
  state.busy = false;
  state.lastPageEventAt = 0;
  state.walkthroughTrace = [];
  state.autoRefreshEnabled = true;
  state.walkthroughCompleted = false;
  state.loopGuard = { counts: {}, lastKey: null };

  // Always reset final-confirmation UI state when clearing context.
  if (state.final) {
    state.final.awaitingConfirmation = false;
    state.final.lastStepIssuedAt = 0;
    state.final.lastStepIsFinal = false;
    state.final.lastStepActionId = null;
    state.final.lastStepActionLabel = null;
    state.final.executedAt = 0;
    state.final.preSig = null;
    state.final.preSvgSig = null;
    state.final.postSig = null;
    state.final.postSvgSig = null;
    state.final.successKind = null;
  }

  if (!keepContext) state.context = null;
  if (keepContext && preservedContext) {
    state.context = preservedContext;
    setThemeFromHint(preservedThemeHint);
  }

  el('summary').textContent = '';
  el('clarifying').textContent = '';
  const helpEl = el('currentHelp');
  if (helpEl) helpEl.textContent = '';

  tracePush({ type: 'session_reset', reason: reason || 'manual' });
}

function startNewSession({ reason, pageKey, keepContext, setStatusText }) {
  state.session.id = (state.session.id || 0) + 1;
  state.session.startedAt = Date.now();
  state.session.pageKey = pageKey ?? state.session.pageKey;

  resetAiContext({ reason, keepContext: keepContext !== false });
  if (setStatusText) setStatus(setStatusText);
  render();
}

function normalizeLabel(label) {
  return (label || '').trim().replace(/\s+/g, ' ');
}

function normalizeKey(label) {
  return normalizeLabel(label).toLowerCase();
}

function isSameLabel(a, b) {
  const aa = normalizeKey(a);
  const bb = normalizeKey(b);
  return Boolean(aa && bb && aa === bb);
}

function findUiActionSnapshotForStep(ctx, step) {
  const list = Array.isArray(ctx?.uiActions) ? ctx.uiActions : [];
  const wantedId = typeof step?.actionId === 'string' ? step.actionId.trim() : '';
  if (wantedId) {
    const byId = list.find((a) => typeof a?.actionId === 'string' && a.actionId.trim() === wantedId);
    if (byId) return byId;
  }

  const wantedLabel = typeof step?.actionLabel === 'string' ? normalizeKey(step.actionLabel) : '';
  if (!wantedLabel) return null;
  const exact = list.find((a) => normalizeKey(a?.label || '') === wantedLabel);
  if (exact) return exact;

  const partial = list.filter((a) => normalizeKey(a?.label || '').includes(wantedLabel));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    partial.sort((a, b) => (normalizeLabel(a?.label || '').length - normalizeLabel(b?.label || '').length));
    return partial[0];
  }

  return null;
}

function loopKey({ currentStepIndex, expectedActionLabel, stepsSig, url }) {
  const expected = normalizeLabel(expectedActionLabel).toLowerCase();
  const u = (url || '').slice(0, 140);
  return `${currentStepIndex}|${expected}|${stepsSig}|${u}`;
}

function recordLoopObservation(key, { isProgress }) {
  if (!key) return 0;
  if (isProgress) {
    // Reset loop state on progress.
    state.loopGuard.counts = {};
    state.loopGuard.lastKey = null;
    return 0;
  }

  const counts = state.loopGuard.counts;
  counts[key] = (counts[key] || 0) + 1;
  state.loopGuard.lastKey = key;
  // Bound the map.
  const keys = Object.keys(counts);
  if (keys.length > 50) {
    for (const k of keys.slice(0, keys.length - 50)) delete counts[k];
  }
  return counts[key];
}

function setStatus(text) {
  el('statusLine').textContent = text || '';
}

function sanitizeStep(s) {
  if (!s || typeof s !== 'object') return null;
  const title = typeof s.title === 'string' ? s.title.trim() : '';
  const details = typeof s.details === 'string' ? s.details.trim() : '';
  const actionId = typeof s.actionId === 'string' ? s.actionId.trim() : '';
  const actionLabel = typeof s.actionLabel === 'string' ? s.actionLabel.trim() : '';
  const visualTargetNumber = Number.isFinite(s.visualTargetNumber) ? s.visualTargetNumber : null;
  const isFinalStep = typeof s.isFinalStep === 'boolean' ? s.isFinalStep : null;
  if (!title && !details && !actionLabel && !actionId) return null;
  return {
    title: title || 'Next step',
    details,
    ...(actionId ? { actionId } : {}),
    ...(actionLabel ? { actionLabel } : {})
    ,...(visualTargetNumber ? { visualTargetNumber } : {}),
    ...(typeof isFinalStep === 'boolean' ? { isFinalStep } : {})
  };
}

function setSingleStepFromResponse(data, { source }) {
  if (!data || typeof data !== 'object') return false;
  if (!Array.isArray(data.steps) || data.steps.length === 0) return false;

  const candidate = sanitizeStep(data.steps[0]);
  if (!candidate) return false;

  // Always show exactly one active step.
  state.steps = [candidate];
  state.currentStepIndex = 0;

  // Arm/track final step state.
  state.final.lastStepIssuedAt = Date.now();
  state.final.lastStepIsFinal = candidate?.isFinalStep === true;
  state.final.lastStepActionId = typeof candidate?.actionId === 'string' ? candidate.actionId : null;
  state.final.lastStepActionLabel = typeof candidate?.actionLabel === 'string' ? candidate.actionLabel : null;
  // Reset confirmation state when a new step is set.
  state.final.awaitingConfirmation = false;
  state.final.executedAt = 0;
  state.final.successKind = null;
  state.final.postSig = null;
  state.final.postSvgSig = null;

  const pre = findUiActionSnapshotForStep(state.context, candidate);
  state.final.preSig = typeof pre?.sig === 'string' ? pre.sig : null;
  state.final.preSvgSig = typeof pre?.svgSig === 'string' ? pre.svgSig : null;

  tracePush({ type: 'step_set_single', source: source || 'unknown' });
  return true;
}

function enterFinalConfirmation() {
  state.final.awaitingConfirmation = true;
  state.final.executedAt = Date.now();
  try {
    // Keep model-provided summary; only ask the user what to do next.
    el('clarifying').textContent = 'Do you still need my help? If you are done, click Done. If not, click No.';
  } catch {
    // ignore
  }
  setStatus('');
  tracePush({ type: 'final_confirmation', actionId: state.final.lastStepActionId || null, actionLabel: state.final.lastStepActionLabel || null });
  render();
}

async function endSessionAndClear() {
  try {
    await fetch(`${state.backendUrl}/api/session/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: state.session, url: state.context?.url || null })
    });
  } catch {
    // ignore
  }

  try {
    await chrome.runtime.sendMessage({ type: 'CLEAR_TAB_STATE' });
  } catch {
    // ignore
  }

  try {
    el('goal').value = '';
  } catch {
    // ignore
  }

  startNewSession({ reason: 'completed', pageKey: null, keepContext: false, setStatusText: 'Session ended — cleared.' });
}

function findActionCandidate(label) {
  const ctx = state.context;
  if (!ctx) return null;
  const target = (label || '').trim().toLowerCase();
  if (!target) return null;
  const actionCandidates = Array.isArray(ctx.actionCandidates) ? ctx.actionCandidates : [];
  const fieldCandidates = Array.isArray(ctx.fieldCandidates) ? ctx.fieldCandidates : [];
  const candidates = [...actionCandidates, ...fieldCandidates];

  const exact = candidates.find((a) => (a?.label || '').trim().toLowerCase() === target);
  if (exact) return exact;

  const partial = candidates.filter((a) => ((a?.label || '').trim().toLowerCase() || '').includes(target));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    partial.sort((a, b) => (a.label || '').length - (b.label || '').length);
    return partial[0];
  }

  return null;
}

function resolveActionIdForLabel(ctx, label) {
  const key = normalizeKey(label);
  if (!key) return null;

  const overlays = Array.isArray(ctx?.overlayActions) ? ctx.overlayActions : [];
  for (const o of overlays) {
    if (!o) continue;
    if (normalizeKey(o.label || '') === key && typeof o.actionId === 'string' && o.actionId.trim()) return o.actionId.trim();
  }

  const uiList = Array.isArray(ctx?.uiActions) ? ctx.uiActions : [];
  for (const a of uiList) {
    if (!a) continue;
    if (normalizeKey(a.label || '') === key && typeof a.actionId === 'string' && a.actionId.trim()) return a.actionId.trim();
  }

  return null;
}

function extractColorHints(text) {
  const t = (text || '').toString().toLowerCase();
  if (!t) return [];
  const hints = [];
  const add = (k) => {
    if (!hints.includes(k)) hints.push(k);
  };

  if (/(\bgreen\b|\bzelen\w*\b)/.test(t)) add('green');
  if (/(\bred\b|\bcrven\w*\b)/.test(t)) add('red');
  if (/(\bblue\b|\bplav\w*\b)/.test(t)) add('blue');
  if (/(\bgray\b|\bgrey\b|\bsiv\w*\b)/.test(t)) add('gray');
  if (/(\bblack\b|\bcrn\w*\b)/.test(t)) add('black');
  if (/(\bwhite\b|\bbel\w*\b)/.test(t)) add('white');
  if (/(\borange\b|\bnarand\w*\b)/.test(t)) add('orange');
  if (/(\byellow\b|\bzut\w*\b|\bžut\w*\b)/.test(t)) add('yellow');
  return hints;
}

function parseRgb(color) {
  const s = (color || '').toString().trim().toLowerCase();
  if (!s) return null;
  let m = s.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
  if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
  m = s.match(/^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([0-9.]+)\)$/);
  if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: Number(m[4]) };
  m = s.match(/^#([0-9a-f]{6})$/i);
  if (m) {
    const hex = m[1];
    return {
      r: Number.parseInt(hex.slice(0, 2), 16),
      g: Number.parseInt(hex.slice(2, 4), 16),
      b: Number.parseInt(hex.slice(4, 6), 16)
    };
  }
  return null;
}

function colorCategory(bg) {
  const rgb = parseRgb(bg);
  if (!rgb) return null;
  if (Number.isFinite(rgb.a) && rgb.a <= 0.05) return null;

  const { r, g, b } = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const spread = max - min;
  const isDark = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.35;
  const isLight = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.88;
  if (spread < 22) {
    if (isDark) return 'black';
    if (isLight) return 'white';
    return 'gray';
  }
  if (max === r && g > 140) return 'orange';
  if (max === r) return 'red';
  if (max === g) return 'green';
  if (max === b) return 'blue';
  return null;
}

function extractQuotedPhrases(text) {
  const t = (text || '').toString();
  if (!t) return [];
  const out = [];
  const re = /["'“”‘’]([^"'\n]{2,60})["'“”‘’]/g;
  let m;
  while ((m = re.exec(t))) {
    const s = normalizeLabel(m[1]);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= 6) break;
  }
  return out;
}

function extractAllCapsTokens(text) {
  const t = (text || '').toString();
  if (!t) return [];
  const out = [];
  const re = /\b[A-Z0-9]{2,10}\b/g;
  let m;
  while ((m = re.exec(t))) {
    const s = m[0];
    if (!s) continue;
    if (['HTTP', 'HTTPS', 'URL', 'JSON', 'CSS', 'SVG', 'DOM'].includes(s)) continue;
    if (!out.includes(s)) out.push(s);
    if (out.length >= 8) break;
  }
  return out;
}

function scoreLabelAgainstText(label, blob, { colorHints, style } = {}) {
  const l = normalizeLabel(label);
  if (!l) return 0;
  const raw = (blob || '').toString();
  const t = raw.toLowerCase();
  const key = l.toLowerCase();

  let score = 0;

  // Strong signals
  if (t.includes(key)) score += 80;

  // Short labels (OFF/RUN/AUTO) need word-boundary match.
  if (key.length <= 4) {
    try {
      const re = new RegExp(`\\b${key.replace(/[-/\\^$*+?.()|[\\]{}]/g, '\\$&')}\\b`, 'i');
      if (re.test(raw)) score += 90;
    } catch {
      // ignore
    }
  }

  // Token overlap
  const textTokens = new Set(t.split(/[^a-z0-9]+/g).filter((x) => x.length >= 2));
  const labelTokens = key.split(/[^a-z0-9]+/g).filter((x) => x.length >= 2);
  if (labelTokens.length) {
    let hits = 0;
    for (const tok of labelTokens) {
      if (textTokens.has(tok)) hits++;
    }
    score += hits * 10;
    if (hits === labelTokens.length && hits >= 2) score += 25;
  }

  // Color hint bonus (best-effort)
  if (colorHints?.length && style?.backgroundColor) {
    const cat = colorCategory(style.backgroundColor);
    if (cat && colorHints.includes(cat)) score += 14;
  }

  return score;
}

function findTargetSuggestions(step, ctx) {
  if (!ctx) return [];
  const blob = [step?.title || '', step?.details || '', el('summary')?.textContent || ''].join('\n');
  const colorHints = extractColorHints(blob);

  const overlayLabels = (Array.isArray(ctx.overlayActions) ? ctx.overlayActions : []).map((x) => x?.label).filter(Boolean);
  const actionCandidates = Array.isArray(ctx.actionCandidates) ? ctx.actionCandidates : [];
  const fieldCandidates = Array.isArray(ctx.fieldCandidates) ? ctx.fieldCandidates : [];
  const navItems = Array.isArray(ctx.navItems) ? ctx.navItems : [];

  const styleByLabel = new Map();
  for (const a of actionCandidates) {
    if (a?.label) styleByLabel.set(normalizeKey(a.label), a.style || null);
  }
  for (const f of fieldCandidates) {
    if (f?.label && f?.style) styleByLabel.set(normalizeKey(f.label), f.style);
  }

  const labels = [
    ...overlayLabels,
    ...actionCandidates.map((a) => a?.label).filter(Boolean),
    ...fieldCandidates.map((f) => f?.label).filter(Boolean),
    ...navItems
  ];

  const unique = [];
  const seen = new Set();
  for (const lbl of labels) {
    const k = normalizeKey(lbl);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    unique.push(lbl);
  }

  // Boost phrases explicitly mentioned in text.
  const explicit = [...extractQuotedPhrases(blob), ...extractAllCapsTokens(blob)];
  for (const ex of explicit) {
    const k = normalizeKey(ex);
    if (k && !seen.has(k)) {
      seen.add(k);
      unique.unshift(ex);
    }
  }

  const scored = unique
    .map((lbl) => {
      const style = styleByLabel.get(normalizeKey(lbl)) || null;
      const score = scoreLabelAgainstText(lbl, blob, { colorHints, style });
      return {
        label: normalizeLabel(lbl),
        actionId: resolveActionIdForLabel(ctx, lbl),
        style,
        score
      };
    })
    .filter((x) => x.label && x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  // If the model didn't mention anything we can score, still offer explicit tokens.
  if (!scored.length && explicit.length) {
    const fallback = [];
    for (const ex of explicit) {
      const label = normalizeLabel(ex);
      if (!label) continue;
      fallback.push({
        label,
        actionId: resolveActionIdForLabel(ctx, label),
        style: styleByLabel.get(normalizeKey(label)) || null,
        score: 1
      });
      if (fallback.length >= 4) break;
    }
    return fallback;
  }

  return scored;
}

function applyPreviewStyle(buttonEl, candidate) {
  const style = candidate?.style;
  if (!style) return;

  const fg = typeof style.color === 'string' ? style.color.trim() : '';
  const bg = typeof style.backgroundColor === 'string' ? style.backgroundColor.trim() : '';

  const isTransparentColor = (c) => {
    const s = (c || '').toString().trim().toLowerCase();
    if (!s) return true;
    if (s === 'transparent') return true;
    const m = s.match(/^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([0-9.]+)\)$/);
    if (m) {
      const a = Number.parseFloat(m[4]);
      return Number.isFinite(a) ? a <= 0.03 : false;
    }
    return false;
  };

  const parseRgb = (c) => {
    const s = (c || '').toString().trim().toLowerCase();
    let m = s.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
    if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
    m = s.match(/^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([0-9.]+)\)$/);
    if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
    m = s.match(/^#([0-9a-f]{6})$/i);
    if (m) {
      const hex = m[1];
      return {
        r: Number.parseInt(hex.slice(0, 2), 16),
        g: Number.parseInt(hex.slice(2, 4), 16),
        b: Number.parseInt(hex.slice(4, 6), 16)
      };
    }
    return null;
  };

  const isDark = (c) => {
    const rgb = parseRgb(c);
    if (!rgb) return false;
    // Relative luminance-ish.
    const l = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
    return l < 0.56;
  };

  const hasFg = Boolean(fg);
  const hasBg = Boolean(bg) && !isTransparentColor(bg);

  // If we can't replicate background (e.g. link-like element with transparent bg), keep the default Tandem pill.
  if (!hasBg) return;

  if (hasBg) buttonEl.style.backgroundColor = bg;
  if (hasFg) buttonEl.style.color = fg;
  if (hasBg && !hasFg) buttonEl.style.color = isDark(bg) ? '#ffffff' : 'var(--ui-fg)';

  if (style.borderWidth && style.borderStyle && style.borderColor) {
    buttonEl.style.border = `${style.borderWidth} ${style.borderStyle} ${style.borderColor}`;
  } else if (style.borderColor) {
    buttonEl.style.border = `1px solid ${style.borderColor}`;
  }

  if (style.borderRadius) buttonEl.style.borderRadius = style.borderRadius;

  if (style.padding) {
    const nums = [...style.padding.matchAll(/(\d+(?:\.\d+)?)px/g)].map((m) => Number.parseFloat(m[1]));
    const max = nums.length ? Math.max(...nums) : 0;
    if (!Number.isFinite(max) || max <= 24) {
      buttonEl.style.padding = style.padding;
    }
  }

  if (style.fontSize) {
    const m = style.fontSize.match(/(\d+(?:\.\d+)?)px/);
    const px = m ? Number.parseFloat(m[1]) : null;
    if (!px || px <= 16) buttonEl.style.fontSize = style.fontSize;
  }

  if (style.fontWeight) buttonEl.style.fontWeight = style.fontWeight;
  if (style.textTransform) buttonEl.style.textTransform = style.textTransform;
  if (style.letterSpacing) buttonEl.style.letterSpacing = style.letterSpacing;
}

async function captureContext({ statusText } = {}) {
  if (typeof statusText === 'string') setStatus(statusText);
  const result = await chrome.runtime.sendMessage({ type: 'CAPTURE_CONTEXT', includeScreenshot: true });
  if (!result?.ok) {
    setStatus(result?.error || 'Failed to capture context.');
    return;
  }

  const incomingUrl = result?.context?.url || '';
  const newPageKey = normalizeUrlForSession(incomingUrl);
  const prevPageKey = state.session?.pageKey || (state.context?.url ? normalizeUrlForSession(state.context.url) : null);

  // If navigation happened (new page), clear AI communication context.
  if (prevPageKey && newPageKey && prevPageKey !== newPageKey) {
    state.session.pageKey = newPageKey;
    startNewSession({
      reason: 'navigation',
      pageKey: newPageKey,
      keepContext: true,
      setStatusText: 'New page detected — context cleared.'
    });
  } else if (!state.session.pageKey && newPageKey) {
    state.session.pageKey = newPageKey;
  }

  state.context = result.context;

  // Screenshot is a first-class multimodal input.
  // If capture failed to produce it transiently, reuse the last screenshot for the same page key.
  if (state.context) {
    const hasShot = typeof state.context.screenshot === 'string' && state.context.screenshot.startsWith('data:image/');
    if (hasShot) {
      state.screenshotCache.pageKey = newPageKey || null;
      state.screenshotCache.screenshot = state.context.screenshot;
      state.context.screenshotStale = false;
    } else if (
      newPageKey &&
      state.screenshotCache.pageKey === newPageKey &&
      typeof state.screenshotCache.screenshot === 'string'
    ) {
      state.context.screenshot = state.screenshotCache.screenshot;
      state.context.screenshotStale = true;
    }
  }

  setThemeFromHint(state.context?.themeHint);
  tracePush({ type: 'context_captured', url: state.context?.url || null });
  render();
}

async function explainNextStep() {
  const goal = el('goal').value.trim();
  if (!goal) {
    el('summary').textContent = 'Type a goal first.';
    return;
  }

  if (state.busy) return;

  // Always capture latest context on Explain so the model uses fresh page state.
  state.busy = true;
  render();
  await captureContext({ statusText: 'Capturing page context…' });
  if (!state.context) {
    el('summary').textContent = 'Could not capture page context. Try again.';
    state.busy = false;
    render();
    return;
  }

  el('summary').textContent = 'Thinking…';
  el('clarifying').textContent = '';
  {
    const helpEl = el('currentHelp');
    if (helpEl) helpEl.textContent = '';
  }
  setStatus('');
  const isPlan = state.steps.length === 0;
  tracePush({ type: 'explain_requested', mode: isPlan ? 'plan' : 'step' });

  const payload = {
    goal,
    context: state.context,
    screenshot: state.context?.screenshot || null,
    history: state.history,
    currentStepIndex: state.currentStepIndex,
    mode: isPlan ? 'plan' : 'step',
    steps: state.steps,
    session: state.session
  };

  const resp = await fetch(`${state.backendUrl}/api/explain`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    el('summary').textContent = `Backend error (${resp.status}). Check server.`;
    try {
      const err = await resp.json();
      if (err?.error) setStatus(err.error);
    } catch {
      // ignore
    }
    state.busy = false;
    return;
  }

  const data = await resp.json();
  if (typeof data.summary === 'string') el('summary').textContent = data.summary;
  if (data.clarifyingQuestion) el('clarifying').textContent = `Question: ${data.clarifyingQuestion}`;

  // New behavior: build steps incrementally.
  // - First request (plan mode): take the single returned step as step[0]
  // - Later (step mode): append next step only when server returns it
  let stepSet = false;
  if (Array.isArray(data.steps) && data.steps.length > 0) {
    stepSet = setSingleStepFromResponse(data, { source: isPlan ? 'plan' : 'explain_step' }) || stepSet;
  }

  if (!stepSet && Number.isFinite(data.currentStepIndex)) {
    state.currentStepIndex = Math.max(0, Math.min(data.currentStepIndex, Math.max(0, state.steps.length - 1)));
  }

  if (typeof data.currentStepHelp === 'string') {
    const helpEl = el('currentHelp');
    if (helpEl) helpEl.textContent = data.currentStepHelp;
  }

  state.history.push({
    at: Date.now(),
    goal,
    currentStepIndex: state.currentStepIndex,
    summary: data.summary || null
  });

  state.busy = false;

  render();
}

async function refreshCurrentStepHelp({ reason }) {
  const goal = el('goal')?.value?.trim() || '';
  if (!goal) return;
  if (!state.context) return;
  if (!Array.isArray(state.steps) || state.steps.length === 0) return;
  if (state.busy) return;
  if (state.final?.awaitingConfirmation) return;

  state.busy = true;
  render();

  try {
    const payload = {
      goal,
      context: state.context,
      screenshot: state.context?.screenshot || null,
      history: state.history,
      currentStepIndex: state.currentStepIndex,
      mode: 'step',
      steps: state.steps,
      reason: reason || null,
      session: state.session
    };

    const resp = await fetch(`${state.backendUrl}/api/explain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) return;
    const data = await resp.json();

    // Incremental mode:
    // - On progress, server may return exactly 1 next step; append it.
    // - Otherwise keep steps stable and only refresh help.
    if (typeof data.summary === 'string') el('summary').textContent = data.summary;
    if (typeof data.currentStepHelp === 'string') {
      const helpEl = el('currentHelp');
      if (helpEl) helpEl.textContent = data.currentStepHelp;
    }

    const stepSet = setSingleStepFromResponse(data, { source: `refresh:${reason || 'unknown'}` });

    if (!stepSet && Number.isFinite(data.currentStepIndex)) {
      state.currentStepIndex = Math.max(0, Math.min(data.currentStepIndex, Math.max(0, state.steps.length - 1)));
    }

    tracePush({ type: 'step_help_refreshed', reason: reason || null });
  } catch {
    // ignore
  } finally {
    state.busy = false;
    render();
  }
}

function stepsSignature(steps) {
  try {
    return JSON.stringify(
      (Array.isArray(steps) ? steps : []).map((s) => ({
        title: s?.title || '',
        details: s?.details || '',
        actionLabel: s?.actionLabel || ''
      }))
    );
  } catch {
    return '';
  }
}

function normalizeStepKey(step) {
  const title = (step?.title || '').trim().toLowerCase();
  const details = (step?.details || '').trim().toLowerCase();
  const actionLabel = (step?.actionLabel || '').trim().toLowerCase();

  // Keep details but cap it to reduce noise.
  const shortDetails = details.length > 80 ? details.slice(0, 80) : details;
  return `${title}|${actionLabel}|${shortDetails}`.replace(/\s+/g, ' ').trim();
}

function stepsSimilarity(a, b) {
  const aList = Array.isArray(a) ? a : [];
  const bList = Array.isArray(b) ? b : [];
  if (aList.length === 0 && bList.length === 0) return 1;
  if (aList.length === 0 || bList.length === 0) return 0;

  const aSet = new Set(aList.map(normalizeStepKey).filter(Boolean));
  const bSet = new Set(bList.map(normalizeStepKey).filter(Boolean));
  if (aSet.size === 0 && bSet.size === 0) return 1;
  if (aSet.size === 0 || bSet.size === 0) return 0;

  let intersection = 0;
  for (const k of aSet) if (bSet.has(k)) intersection++;
  const union = aSet.size + bSet.size - intersection;
  return union ? intersection / union : 0;
}

async function fetchSuggestedSteps() {
  const goal = el('goal')?.value?.trim() || '';
  if (!goal) return null;
  if (!state.context) return null;

  const payload = {
    goal,
    context: state.context,
    screenshot: state.context?.screenshot || null,
    history: state.history,
    currentStepIndex: state.currentStepIndex,
    mode: state.steps.length === 0 ? 'plan' : 'step',
    steps: state.steps,
    session: state.session
  };

  const resp = await fetch(`${state.backendUrl}/api/explain`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!resp.ok) return null;
  const data = await resp.json();
  if (!Array.isArray(data.steps) || data.steps.length === 0) return null;
  return data;
}

async function handlePageEvent(event) {
  const at = Number.isFinite(event?.at) ? event.at : Date.now();
  if (state.busy) return;
  if (state.final?.awaitingConfirmation) {
    tracePush({ type: 'page_event_ignored_final_confirmation', eventType: event?.eventType || null });
    return;
  }

  const eventType = typeof event?.eventType === 'string' ? event.eventType : 'click';
  const eventActionId = typeof event?.actionId === 'string' ? event.actionId.trim() : '';

  // De-dupe: a click on a label often causes an immediate change on the input.
  const li = state.lastInteraction || { at: 0, eventType: null, actionId: null };
  if (
    eventType === 'change' &&
    li.eventType === 'click' &&
    li.actionId &&
    eventActionId &&
    li.actionId === eventActionId &&
    at - (li.at || 0) < 350
  ) {
    return;
  }

  if (at <= state.lastPageEventAt) return;
  state.lastPageEventAt = at;
  state.lastInteraction = { at, eventType, actionId: eventActionId || null };

  if (state.walkthroughCompleted) {
    tracePush({ type: `page_${eventType}_ignored_completed`, label: event?.label || null });
    return;
  }

  tracePush({
    type: `page_${eventType}`,
    label: event?.label || null,
    kind: event?.kind || null,
    urlBefore: event?.urlBefore || null,
    urlAfter: event?.urlAfter || null
  });

  // Always re-capture context after a meaningful page interaction.
  await captureContext({ statusText: 'Updating context…' });

  // Mark progress if the click label matches current step actionLabel.
  const clickedLabel = typeof event?.label === 'string' ? event.label.trim() : '';
  const clickedActionId = eventActionId;
  const currentStep = state.steps[state.currentStepIndex];
  const expected = typeof currentStep?.actionLabel === 'string' ? currentStep.actionLabel.trim() : '';
  const expectedActionId = typeof currentStep?.actionId === 'string' ? currentStep.actionId.trim() : '';
  const matchedExpected = expectedActionId
    ? Boolean(clickedActionId && clickedActionId === expectedActionId)
    : isSameLabel(clickedLabel, expected);

  // If the user just executed the final step, stop auto-refresh and ask for confirmation.
  if (matchedExpected && currentStep?.isFinalStep === true) {
    // Compute success heuristics from before/after signatures.
    const post = findUiActionSnapshotForStep(state.context, currentStep);
    state.final.postSig = typeof post?.sig === 'string' ? post.sig : null;
    state.final.postSvgSig = typeof post?.svgSig === 'string' ? post.svgSig : null;

    const svgChanged = Boolean(state.final.preSvgSig && state.final.postSvgSig && state.final.preSvgSig !== state.final.postSvgSig);
    const domChanged = Boolean(state.final.preSig && state.final.postSig && state.final.preSig !== state.final.postSig);
    state.final.successKind = svgChanged ? 'svg' : domChanged ? 'dom' : null;

    state.history.push({ at: Date.now(), type: eventType, label: clickedLabel, matchedStep: state.currentStepIndex, finalStepExecuted: true });
    tracePush({ type: `final_step_executed_by_${eventType}`, stepIndex: state.currentStepIndex, actionLabel: expected });

    // Always refresh the step/guidance once after final-step execution.
    // If the model offers an additional intuitive step, show it immediately.
    try {
      state.busy = true;
      render();
      setStatus('Refreshing guidance…');
      const data = await fetchSuggestedSteps();

      if (typeof data?.summary === 'string') el('summary').textContent = data.summary;
      const helpEl = el('currentHelp');
      if (typeof data?.currentStepHelp === 'string' && helpEl) helpEl.textContent = data.currentStepHelp;

      const candidate = data?.steps?.[0] ? sanitizeStep(data.steps[0]) : null;
      const hasTarget = Boolean((candidate?.actionId || '').trim() || (candidate?.actionLabel || '').trim());
      const sameActionId = Boolean(candidate?.actionId && expectedActionId && candidate.actionId.trim() === expectedActionId);
      const sameActionLabel = Boolean(candidate?.actionLabel && expected && isSameLabel(candidate.actionLabel, expected));
      const isSameTarget = sameActionId || sameActionLabel;
      const followupOk = Boolean(candidate && hasTarget && candidate?.isFinalStep !== true && !isSameTarget);

      if (followupOk) {
        setSingleStepFromResponse(data, { source: 'post_final_followup' });
        el('clarifying').textContent = 'Do you still need my help? If not, click Done. Otherwise, follow the suggested step below.';
        setStatus('');
        tracePush({ type: 'final_followup_offered' });
        state.busy = false;
        render();
        return;
      }
    } catch {
      // ignore
    } finally {
      state.busy = false;
      render();
    }

    enterFinalConfirmation();
    return;
  }
  if (matchedExpected) {
    state.history.push({ at: Date.now(), type: eventType, label: clickedLabel, matchedStep: state.currentStepIndex });
    tracePush({ type: `step_matched_by_${eventType}`, stepIndex: state.currentStepIndex, actionLabel: expected });
  } else {
    state.history.push({ at: Date.now(), type: eventType, label: clickedLabel || null });
    tracePush({ type: `${eventType}_no_step_match`, expectedActionLabel: expected || null });
  }

  // Step-by-step mode: keep the plan stable; just ask the model if we're on track.
  setStatus('');
  await refreshCurrentStepHelp({ reason: matchedExpected ? 'progress' : eventType });

  if (matchedExpected) schedulePostProgressRefresh(event?.seq);
}

async function markDone() {
  if (state.busy) return;
  if (state.final?.awaitingConfirmation) return;
  state.busy = true;
  render();
  tracePush({ type: 'done_clicked_end_session' });
  await endSessionAndClear();
  state.busy = false;
  render();
}

async function finalYes() {
  if (!state.final?.awaitingConfirmation) return;
  if (state.busy) return;
  await endSessionAndClear();
}

async function finalNo() {
  if (!state.final?.awaitingConfirmation) return;
  if (state.busy) return;
  state.final.awaitingConfirmation = false;
  state.final.executedAt = 0;
  tracePush({ type: 'final_confirmation_no' });
  setStatus('');
  await captureContext({ statusText: 'Updating context…' });
  await refreshCurrentStepHelp({ reason: 'final_no' });
}

el('goal').addEventListener('input', () => {
  // Keep Explain enabled/disabled in sync with typed goal.
  render();
});
el('explain').addEventListener('click', explainNextStep);
el('done').addEventListener('click', markDone);
el('finalYes')?.addEventListener('click', finalYes);
el('finalNo')?.addEventListener('click', finalNo);
el('newSession').addEventListener('click', () => {
  const pageKey = state.context?.url ? normalizeUrlForSession(state.context.url) : state.session.pageKey;
  state.session.pageKey = pageKey || null;
  try {
    chrome.runtime.sendMessage({ type: 'CLEAR_TAB_STATE' });
  } catch {
    // ignore
  }
  try {
    el('goal').value = '';
  } catch {
    // ignore
  }
  startNewSession({
    reason: 'manual',
    pageKey: state.session.pageKey,
    keepContext: false,
    setStatusText: 'Context cleared.'
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'PAGE_EVENT' && msg?.event) {
    handlePageEvent(msg.event);
  }
});

render();
