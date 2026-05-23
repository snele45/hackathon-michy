let state = {
  backendUrl: 'http://localhost:8787',
  context: null,
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
  loopGuard: {
    // key -> count
    counts: {},
    // last key we observed
    lastKey: null
  }
};

const el = (id) => document.getElementById(id);

function setThemeFromHint(themeHint) {
  if (!themeHint) return;
  const root = document.documentElement;

  // Keep a unified, predictable UI in the side panel.
  // We only adopt the page font (optional) but do not override colors.
  if (themeHint.fontFamily) root.style.setProperty('--ui-font', themeHint.fontFamily);
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
  el('contextPreview').textContent = ctx
    ? JSON.stringify(
        {
          headings: ctx.headings,
          navItems: ctx.navItems,
          navigationGroups: ctx.navigationGroups,
          primaryActions: ctx.primaryActions,
          primaryFields: ctx.primaryFields,
          dropdownTriggers: ctx.dropdownTriggers,
          openMenuGroups: ctx.openMenuGroups,
          walkthrough: {
            currentStepIndex: state.currentStepIndex,
            stepsCount: state.steps.length,
            completed: state.walkthroughCompleted,
            autoRefreshEnabled: state.autoRefreshEnabled,
            trace: state.walkthroughTrace.slice(-12)
          }
        },
        null,
        2
      )
    : '';

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
    if (actionLabel) {
      const meta = document.createElement('div');
      meta.className = 'stepMeta';

      const preview = document.createElement('button');
      preview.type = 'button';
      preview.className = 'actionPreview';
      preview.textContent = actionLabel;

      const candidate = findActionCandidate(actionLabel);
      applyPreviewStyle(preview, candidate);

      preview.addEventListener('click', async () => {
        setStatus('');
        try {
          const r = await chrome.runtime.sendMessage({ type: 'HIGHLIGHT_ACTION', label: actionLabel });
          if (!r?.ok) {
            setStatus(r?.error || 'Could not locate that element on the page.');
            return;
          }

          if (r?.matchedLabel && r.matchedLabel !== actionLabel) {
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
    }

    stepsEl.appendChild(li);
  });

  const doneBtn = el('done');
  const hasSteps = state.steps.length > 0;
  const isLast = hasSteps && state.currentStepIndex === state.steps.length - 1;
  doneBtn.disabled = !hasSteps || state.walkthroughCompleted;
  doneBtn.textContent = state.walkthroughCompleted
    ? 'Completed'
    : isLast
      ? 'Finish walkthrough'
      : 'Complete step →';
  doneBtn.classList.toggle('primary', hasSteps && !state.walkthroughCompleted);
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

  if (!keepContext) state.context = null;
  if (keepContext && preservedContext) {
    state.context = preservedContext;
    setThemeFromHint(preservedThemeHint);
  }

  el('summary').textContent = '';
  el('clarifying').textContent = '';
  el('currentHelp').textContent = '';

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

function isSameLabel(a, b) {
  const aa = normalizeLabel(a).toLowerCase();
  const bb = normalizeLabel(b).toLowerCase();
  return Boolean(aa && bb && aa === bb);
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

function applyPreviewStyle(buttonEl, candidate) {
  const style = candidate?.style;
  if (!style) return;

  if (style.backgroundColor) buttonEl.style.backgroundColor = style.backgroundColor;
  if (style.color) buttonEl.style.color = style.color;

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
  const result = await chrome.runtime.sendMessage({ type: 'CAPTURE_CONTEXT' });
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
  el('currentHelp').textContent = '';
  setStatus('');
  tracePush({ type: 'explain_requested', mode: state.steps.length === 0 ? 'plan' : 'step' });

  const payload = {
    goal,
    context: state.context,
    history: state.history,
    currentStepIndex: state.currentStepIndex,
    mode: state.steps.length === 0 ? 'plan' : 'step',
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

  if (Array.isArray(data.steps) && data.steps.length > 0) {
    state.steps = data.steps;
    tracePush({ type: 'steps_set', stepsCount: state.steps.length });
  }

  if (Number.isFinite(data.currentStepIndex)) {
    state.currentStepIndex = Math.max(0, Math.min(data.currentStepIndex, Math.max(0, state.steps.length - 1)));
  }

  if (typeof data.currentStepHelp === 'string') {
    el('currentHelp').textContent = data.currentStepHelp;
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
    history: state.history,
    currentStepIndex: state.currentStepIndex,
    mode: state.steps.length === 0 ? 'plan' : 'step',
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
  if (at <= state.lastPageEventAt) return;
  state.lastPageEventAt = at;
  if (state.busy) return;

  if (state.walkthroughCompleted) {
    tracePush({ type: 'page_click_ignored_completed', label: event?.label || null });
    return;
  }

  tracePush({
    type: 'page_click',
    label: event?.label || null,
    kind: event?.kind || null,
    urlBefore: event?.urlBefore || null,
    urlAfter: event?.urlAfter || null
  });

  // Always re-capture context after a click on the page.
  await captureContext({ statusText: 'Updating context…' });

  // Mark progress if the click label matches current step actionLabel.
  const clickedLabel = typeof event?.label === 'string' ? event.label.trim() : '';
  const currentStep = state.steps[state.currentStepIndex];
  const expected = typeof currentStep?.actionLabel === 'string' ? currentStep.actionLabel.trim() : '';
  const matchedExpected = isSameLabel(clickedLabel, expected);
  const wasLastStep = state.steps.length > 0 && state.currentStepIndex === state.steps.length - 1;
  if (matchedExpected) {
    state.history.push({ at: Date.now(), type: 'click', label: clickedLabel, matchedStep: state.currentStepIndex });
    tracePush({ type: 'step_matched_by_click', stepIndex: state.currentStepIndex, actionLabel: expected });

    if (wasLastStep) {
      state.walkthroughCompleted = true;
      state.autoRefreshEnabled = false;
      tracePush({ type: 'walkthrough_completed', stepsCount: state.steps.length });
      setStatus('All steps completed successfully.');
      render();
      return;
    }

    state.currentStepIndex = Math.min(state.currentStepIndex + 1, Math.max(0, state.steps.length - 1));
  } else {
    state.history.push({ at: Date.now(), type: 'click', label: clickedLabel || null });
    tracePush({ type: 'click_no_step_match', expectedActionLabel: expected || null });
  }

  // If we already have steps, refresh them after each click.
  const goal = el('goal')?.value?.trim() || '';
  if (!goal) {
    setStatus('');
    render();
    return;
  }
  if (!Array.isArray(state.steps) || state.steps.length === 0) {
    setStatus('');
    render();
    return;
  }

  if (!state.autoRefreshEnabled) {
    setStatus('');
    render();
    return;
  }

  state.busy = true;
  setStatus('Preparing new steps…');
  const suggested = await fetchSuggestedSteps();
  state.busy = false;

  if (!suggested?.steps) {
    setStatus('');
    render();
    return;
  }

  const similarity = stepsSimilarity(state.steps, suggested.steps);
  const currentSig = stepsSignature(state.steps);
  const newSig = stepsSignature(suggested.steps);

  const url = state.context?.url || '';
  const obsKey = loopKey({
    currentStepIndex: state.currentStepIndex,
    expectedActionLabel: expected,
    stepsSig: newSig || currentSig,
    url
  });
  const loopCount = recordLoopObservation(obsKey, { isProgress: matchedExpected });

  // If we keep seeing the same situation without progress, pause auto-refresh.
  if (!matchedExpected && loopCount >= 3) {
    state.autoRefreshEnabled = false;
    tracePush({ type: 'loop_detected', key: obsKey, count: loopCount });
    setStatus('Seems stuck in a loop. Use “Explain next step” manually or re-capture context.');
    render();
    return;
  }

  // If they are effectively the same, do nothing to avoid confusion.
  // Threshold tuned: "pretty similar" ~ 85% overlap.
  if (newSig && newSig !== currentSig && similarity < 0.85) {
    state.steps = suggested.steps;
    state.currentStepIndex = Math.max(0, Math.min(state.currentStepIndex, Math.max(0, state.steps.length - 1)));
    tracePush({ type: 'steps_refreshed', similarity });
    setStatus('');
  } else {
    tracePush({ type: 'steps_suppressed_similar', similarity });
    setStatus('');
  }

  render();
}

function markDone() {
  if (state.steps.length === 0) return;

  if (state.walkthroughCompleted) return;

  const isLast = state.currentStepIndex >= state.steps.length - 1;
  if (isLast) {
    state.walkthroughCompleted = true;
    state.autoRefreshEnabled = false;
    tracePush({ type: 'walkthrough_completed_manual', stepsCount: state.steps.length });
    setStatus('All steps completed successfully.');
    render();
    return;
  }

  const prev = state.currentStepIndex;
  state.currentStepIndex = Math.min(state.currentStepIndex + 1, state.steps.length - 1);
  tracePush({ type: 'step_completed_manual', from: prev, to: state.currentStepIndex });
  render();
}

el('goal').addEventListener('input', () => {
  // Keep Explain enabled/disabled in sync with typed goal.
  render();
});
el('explain').addEventListener('click', explainNextStep);
el('done').addEventListener('click', markDone);
el('newSession').addEventListener('click', () => {
  const pageKey = state.context?.url ? normalizeUrlForSession(state.context.url) : state.session.pageKey;
  state.session.pageKey = pageKey || null;
  startNewSession({
    reason: 'manual',
    pageKey: state.session.pageKey,
    keepContext: true,
    setStatusText: 'Context cleared.'
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'PAGE_EVENT' && msg?.event) {
    handlePageEvent(msg.event);
  }
});

render();
