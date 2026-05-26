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
  thinkingText: '',
  finalConfirm: {
    active: false,
    kind: null,
    stepIndex: null,
    clickedAt: 0,
    lastClick: null
  },
  lastPageEventAt: 0,
  walkthroughTrace: [],
  autoRefreshEnabled: true,
  walkthroughCompleted: false,
  session: {
    id: 1,
    startedAt: Date.now(),
    pageKey: null,
    origin: null,
    pendingOrigin: null
  },
  postClickRefresh: { timer: null, lastSeq: 0, lastDomSeqSeen: 0 },
  lastInteraction: { at: 0, eventType: null, actionId: null },
  loopGuard: {
    // key -> count
    counts: {},
    // last key we observed
    lastKey: null
  },
  repeatHeuristic: {
    count: 0,
    lastSig: null
  }
};

const SESSION_STATE_KEY = 'tandem:sidepanelState:v1';
let __saveTimer = null;
let __restoreStarted = false;

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

async function storageRemove(keys) {
  try {
    if (chrome.storage?.session) return await chrome.storage.session.remove(keys);
    return await chrome.storage.local.remove(keys);
  } catch {
    // ignore
  }
}

function scheduleSaveSessionState() {
  try {
    if (__saveTimer) clearTimeout(__saveTimer);
    __saveTimer = setTimeout(() => {
      __saveTimer = null;
      void saveSessionStateNow();
    }, 450);
  } catch {
    // ignore
  }
}

async function saveSessionStateNow() {
  try {
    const goal = el('goal')?.value?.trim?.() || '';
    const payload = {
      savedAt: Date.now(),
      goal,
      session: state.session,
      steps: Array.isArray(state.steps) ? state.steps.slice(-25) : [],
      currentStepIndex: Number.isFinite(state.currentStepIndex) ? state.currentStepIndex : 0,
      history: Array.isArray(state.history) ? state.history.slice(-40) : [],
      walkthroughCompleted: Boolean(state.walkthroughCompleted)
    };
    await storageSet({ [SESSION_STATE_KEY]: payload });
  } catch {
    // ignore
  }
}

async function restoreSessionStateOnce() {
  try {
    if (__restoreStarted) return;
    __restoreStarted = true;
    const stored = await storageGet([SESSION_STATE_KEY]);
    const payload = stored?.[SESSION_STATE_KEY];
    if (!payload || typeof payload !== 'object') return;

    const savedAt = Number.isFinite(payload.savedAt) ? payload.savedAt : 0;
    // Ignore very old sessions (keeps surprises low).
    if (savedAt && Date.now() - savedAt > 1000 * 60 * 60 * 6) return;

    const goal = typeof payload.goal === 'string' ? payload.goal : '';
    if (goal) {
      try {
        el('goal').value = goal;
      } catch {
        // ignore
      }
    }

    if (payload.session && typeof payload.session === 'object') {
      state.session = { ...state.session, ...payload.session };
    }
    if (Array.isArray(payload.steps)) state.steps = payload.steps;
    if (Number.isFinite(payload.currentStepIndex)) state.currentStepIndex = payload.currentStepIndex;
    if (Array.isArray(payload.history)) state.history = payload.history;
    state.walkthroughCompleted = Boolean(payload.walkthroughCompleted);

    tracePush({ type: 'session_restored', savedAt: savedAt || null });
  } catch {
    // ignore
  }
}

function urlOrigin(raw) {
  try {
    const u = new URL(raw);
    return u.origin;
  } catch {
    return null;
  }
}

function schedulePostProgressRefresh(seq) {
  const s = Number.isFinite(seq) ? seq : 0;
  if (s <= state.postClickRefresh.lastSeq) return;
  state.postClickRefresh.lastSeq = s;

  // If we already observed a DOM change event for this click seq,
  // avoid redundant post-click refresh.
  if (Number.isFinite(state.postClickRefresh.lastDomSeqSeen) && state.postClickRefresh.lastDomSeqSeen >= s) {
    return;
  }

  if (state.postClickRefresh.timer) {
    clearTimeout(state.postClickRefresh.timer);
    state.postClickRefresh.timer = null;
  }

  // DOM updates after a click can be async (framework re-render). Re-capture once more quietly.
  state.postClickRefresh.timer = setTimeout(async () => {
    state.postClickRefresh.timer = null;

    if (Number.isFinite(state.postClickRefresh.lastDomSeqSeen) && state.postClickRefresh.lastDomSeqSeen >= s) return;
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

  const thinkingEl = el('thinking');
  const thinkingTextEl = el('thinkingText');
  if (thinkingEl) thinkingEl.style.display = state.busy ? 'flex' : 'none';
  if (thinkingTextEl) thinkingTextEl.textContent = state.thinkingText || 'Thinking…';

  // Simple flow: allow typing a goal anytime; Explain will auto-capture context.
  const goalEl = el('goal');
  const explainBtn = el('explain');
  const newSessionBtn = el('newSession');
  const doneBtn = el('done');
  const endSessionBtn = el('endSession');
  const finalYesBtn = el('finalYes');
  const finalNoBtn = el('finalNo');
  const finalConfirmEl = el('finalConfirm');

  const uiLocked = state.busy || state.walkthroughCompleted || state.finalConfirm.active;
  goalEl.disabled = uiLocked;
  if (newSessionBtn) newSessionBtn.disabled = uiLocked;
  explainBtn.disabled = uiLocked || !goalEl.value.trim();
  // Context preview removed (no longer needed).

  const stepsEl = el('steps');
  stepsEl.innerHTML = '';
  state.steps.forEach((s, idx) => {
    const li = document.createElement('li');
    const isActive = idx === state.currentStepIndex;
    const isCompleted = Boolean(s?.doneAt);
    li.className = isActive ? 'active' : isCompleted ? 'completed' : '';
    const title = document.createElement('div');
    title.style.fontWeight = '700';
    title.textContent = isCompleted ? `✓ ${s.title || `Step ${idx + 1}`}` : s.title || `Step ${idx + 1}`;
    const details = document.createElement('div');
    details.style.color = 'var(--ui-muted)';
    details.style.marginTop = '4px';
    details.textContent = s.details || '';
    li.appendChild(title);
    li.appendChild(details);

    const actionLabel = typeof s.actionLabel === 'string' ? s.actionLabel.trim() : '';
    const actionId = typeof s.actionId === 'string' ? s.actionId.trim() : '';
    if (isActive && (actionLabel || actionId)) {
      const meta = document.createElement('div');
      meta.className = 'stepMeta';

      const preview = document.createElement('button');
      preview.type = 'button';
      preview.className = 'actionPreview';
      preview.textContent = actionLabel || actionId;
      preview.disabled = uiLocked;

      const candidate = findActionCandidate({ actionLabel, hintText: typeof s?.details === 'string' ? s.details : '' });
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
      hint.textContent = 'Click button to preview';

      meta.appendChild(preview);
      meta.appendChild(hint);
      li.appendChild(meta);
    }

    stepsEl.appendChild(li);
  });

  const hasSteps = state.steps.length > 0;
  if (doneBtn) {
    doneBtn.disabled = uiLocked || !hasSteps;
    doneBtn.textContent = state.walkthroughCompleted ? 'Completed' : 'Next step';
    doneBtn.classList.toggle('primary', hasSteps && !state.walkthroughCompleted);
  }

  if (endSessionBtn) {
    endSessionBtn.disabled = uiLocked || !hasSteps;
  }

  if (finalConfirmEl) finalConfirmEl.hidden = !state.finalConfirm.active;
  if (finalYesBtn) finalYesBtn.disabled = state.busy;
  if (finalNoBtn) finalNoBtn.disabled = state.busy;

  scheduleSaveSessionState();
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
  state.thinkingText = '';
  state.finalConfirm = { active: false, kind: null, stepIndex: null, clickedAt: 0, lastClick: null };
  state.lastPageEventAt = 0;
  state.walkthroughTrace = [];
  state.autoRefreshEnabled = true;
  state.walkthroughCompleted = false;
  state.loopGuard = { counts: {}, lastKey: null };
  state.repeatHeuristic = { count: 0, lastSig: null };

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

function sameTarget(a, b) {
  const aId = typeof a?.actionId === 'string' ? a.actionId.trim() : '';
  const bId = typeof b?.actionId === 'string' ? b.actionId.trim() : '';
  if (aId && bId && aId === bId) return true;

  const aLabel = typeof a?.actionLabel === 'string' ? a.actionLabel.trim() : '';
  const bLabel = typeof b?.actionLabel === 'string' ? b.actionLabel.trim() : '';
  if (aLabel && bLabel && isSameLabel(aLabel, bLabel)) return true;
  return false;
}

function normalizedText(s) {
  return (typeof s === 'string' ? s : '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function tokenSet(text) {
  const t = normalizedText(text);
  if (!t) return new Set();
  const parts = t
    .replace(/[^a-z0-9\u0107\u010d\u0161\u017e\u0111\s]/gi, ' ')
    .split(/\s+/g)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3);
  return new Set(parts.slice(0, 80));
}

function jaccard(aSet, bSet) {
  if (!aSet || !bSet) return 0;
  if (aSet.size === 0 && bSet.size === 0) return 1;
  if (aSet.size === 0 || bSet.size === 0) return 0;
  let inter = 0;
  for (const v of aSet) if (bSet.has(v)) inter++;
  const union = aSet.size + bSet.size - inter;
  return union ? inter / union : 0;
}

function detailsPrefixMatch(a, b) {
  const aa = normalizedText(a);
  const bb = normalizedText(b);
  if (!aa || !bb) return false;
  const n = Math.min(48, aa.length, bb.length);
  if (n < 18) return false;
  return aa.slice(0, n) === bb.slice(0, n);
}

function stepTooSimilar(prev, next) {
  if (!prev || !next) return false;
  if (normalizeStepSig(prev) === normalizeStepSig(next)) return true;

  const prevTitle = normalizedText(prev.title);
  const nextTitle = normalizedText(next.title);
  const titleSame = Boolean(prevTitle && nextTitle && prevTitle === nextTitle);
  const detailsSameish = detailsPrefixMatch(prev.details, next.details);

  // Token overlap catches paraphrases (e.g. same instruction with slight wording changes).
  const prevTokens = tokenSet(`${prev.title || ''} ${prev.details || ''} ${prev.actionLabel || ''}`);
  const nextTokens = tokenSet(`${next.title || ''} ${next.details || ''} ${next.actionLabel || ''}`);
  const sim = jaccard(prevTokens, nextTokens);

  // If title is the same, be more tolerant.
  if (titleSame && (detailsSameish || sim >= 0.55)) return true;

  // If target matches, tolerate weaker text match.
  if (sameTarget(prev, next) && (detailsSameish || sim >= 0.40)) return true;

  // Otherwise require strong overlap.
  if (sim >= 0.72) return true;
  return false;
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

function beginThinking(text) {
  state.busy = true;
  state.thinkingText = typeof text === 'string' && text.trim() ? text.trim() : 'Thinking…';
  render();
}

function endThinking() {
  state.busy = false;
  state.thinkingText = '';
  render();
}

function enterFinalConfirmation({ stepIndex, lastClick, kind, prompt, clarifying }) {
  const idx = Number.isFinite(stepIndex) ? stepIndex : state.currentStepIndex;
  const k = typeof kind === 'string' ? kind : 'completion';
  state.finalConfirm = {
    active: true,
    kind: k,
    stepIndex: idx,
    clickedAt: Date.now(),
    lastClick: lastClick || null
  };

  // Keep this copy very explicit; users should understand what Yes/No does.
  const promptEl = el('finalPrompt');
  if (promptEl) promptEl.textContent = typeof prompt === 'string' && prompt.trim() ? prompt.trim() : 'Do you still need my help?';
  el('clarifying').textContent =
    typeof clarifying === 'string' && clarifying.trim()
      ? clarifying.trim()
      : "If you still need help, click Yes. If you're done, click No to end the session.";
  setStatus('');

  tracePush({ type: 'final_confirm_shown', stepIndex: idx });
  render();
}

function stepHasTarget(step) {
  const actionId = typeof step?.actionId === 'string' ? step.actionId.trim() : '';
  const actionLabel = typeof step?.actionLabel === 'string' ? step.actionLabel.trim() : '';
  const vt = Number.isFinite(step?.visualTargetNumber) ? step.visualTargetNumber : null;
  return Boolean(actionId || actionLabel || vt);
}

function looksLikeCompletionText(text) {
  const t = (typeof text === 'string' ? text : '').trim().toLowerCase();
  if (!t) return false;
  return /\b(all set|everything is set|all done|you'?re done|you are done|done\b|completed\b|finished\b|successfully|that'?s it|thats it|no further action|you should now see|you should see|success message|confirmation message|gotovo|završeno|zavrseno|uspješno|uspesno|zavrsili smo|to je to)\b/.test(
    t
  );
}

function maybeEnterFinalConfirmationFromModel(data, { reason }) {
  try {
    if (state.walkthroughCompleted) return false;
    if (state.finalConfirm.active) return false;
    if (!Array.isArray(state.steps) || state.steps.length === 0) return false;

    const r = typeof reason === 'string' ? reason : '';

    const rawStep0 = Array.isArray(data?.steps) && data.steps.length ? data.steps[0] : null;
    const candidate = sanitizeStep({
      ...(rawStep0 && typeof rawStep0 === 'object' ? rawStep0 : {}),
      ...(typeof data?.isFinalStep === 'boolean' ? { isFinalStep: data.isFinalStep } : {})
    });
    const current = state.steps[state.currentStepIndex] || null;

    const isFinal = Boolean(typeof data?.isFinalStep === 'boolean' ? data.isFinalStep : candidate?.isFinalStep);
    const completionText =
      looksLikeCompletionText(data?.summary) ||
      looksLikeCompletionText(data?.currentStepHelp) ||
      looksLikeCompletionText(candidate?.title) ||
      looksLikeCompletionText(candidate?.details);

    const isProgressish = r.toLowerCase().includes('progress') || r.toLowerCase().includes('final');
    const isExplainOk = r.toLowerCase() === 'explain' && completionText;

    const noTarget = !(stepHasTarget(candidate) || stepHasTarget(current));
    if (isFinal && noTarget) {
      tracePush({ type: 'final_confirm_inferred', reason: r, isFinal: true, completionText });
      enterFinalConfirmation({ stepIndex: state.currentStepIndex, lastClick: null });
      return true;
    }

    if (!isProgressish && !isExplainOk) return false;

    if (completionText && noTarget) {
      tracePush({ type: 'final_confirm_inferred', reason: r, isFinal, completionText });
      enterFinalConfirmation({ stepIndex: state.currentStepIndex, lastClick: null });
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

async function withThinking(text, fn) {
  beginThinking(text);
  try {
    return await fn();
  } finally {
    endThinking();
  }
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

function normalizeStepSig(step) {
  const title = (step?.title || '').trim().toLowerCase();
  const details = (step?.details || '').trim().toLowerCase();
  const actionLabel = (step?.actionLabel || '').trim().toLowerCase();
  const actionId = (step?.actionId || '').trim();
  const shortDetails = details.length > 80 ? details.slice(0, 80) : details;
  return `${title}|${actionLabel}|${actionId}|${shortDetails}`.replace(/\s+/g, ' ').trim();
}

function applySingleStepFromResponse(data, { source, progress }) {
  if (!data || typeof data !== 'object') return false;
  if (!Array.isArray(data.steps) || data.steps.length === 0) return false;
  const rawStep0 = data.steps[0];

  const candidate = sanitizeStep({
    ...(rawStep0 && typeof rawStep0 === 'object' ? rawStep0 : {}),
    // Allow server to provide isFinalStep at top-level.
    ...(typeof data.isFinalStep === 'boolean' ? { isFinalStep: data.isFinalStep } : {})
  });
  if (!candidate) return false;

  if (!Array.isArray(state.steps) || state.steps.length === 0) {
    state.steps = [candidate];
    state.currentStepIndex = 0;
    tracePush({ type: 'step_set_initial', source: source || 'unknown' });
    return true;
  }

  const current = state.steps[state.currentStepIndex] || null;
  const sameAsCurrent = current && normalizeStepSig(current) === normalizeStepSig(candidate);
  const tooSimilarToCurrent = Boolean(current && stepTooSimilar(current, candidate));

  if (progress) {
    if (current && !current.doneAt) current.doneAt = Date.now();
    // Treat "semantically same" as same to avoid step spam.
    if (!sameAsCurrent && !tooSimilarToCurrent) {
      state.steps.push(candidate);
      state.currentStepIndex = state.steps.length - 1;
      tracePush({ type: 'step_appended', source: source || 'unknown' });
      // Reset repeat heuristic on real movement.
      state.repeatHeuristic = { count: 0, lastSig: normalizeStepSig(candidate) || null };
    } else {
      const sig = normalizeStepSig(candidate) || null;
      const lastSig = state.repeatHeuristic.lastSig;
      const sameAsLast = Boolean(lastSig && sig && lastSig === sig);
      state.repeatHeuristic.count = sameAsLast ? (state.repeatHeuristic.count || 0) + 1 : 1;
      state.repeatHeuristic.lastSig = sig;

      tracePush({
        type: tooSimilarToCurrent ? 'step_progress_too_similar' : 'step_progress_same',
        source: source || 'unknown',
        repeatCount: state.repeatHeuristic.count
      });

      // If the model keeps repeating the same instruction after "Next step",
      // ask the user whether they still need help.
      const isFinal = typeof data.isFinalStep === 'boolean' ? data.isFinalStep : typeof candidate.isFinalStep === 'boolean' ? candidate.isFinalStep : false;
      if (isFinal || tooSimilarToCurrent || state.repeatHeuristic.count >= 2) {
        enterFinalConfirmation({ stepIndex: state.currentStepIndex, lastClick: null });
      }
    }
    return true;
  }

  // Non-progress: treat as correction/refresh of the current step.
  if (state.steps[state.currentStepIndex]) {
    state.steps[state.currentStepIndex] = { ...state.steps[state.currentStepIndex], ...candidate };
    tracePush({ type: 'step_replaced_current', source: source || 'unknown' });
    return true;
  }

  return false;
}

function findActionCandidate({ actionLabel, hintText }) {
  const ctx = state.context;
  if (!ctx) return null;
  const target = (actionLabel || '').trim().toLowerCase();
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

  // Hint-based fallback: if details include a quoted phrase, try that.
  const phrases = [];
  try {
    const raw = (hintText || '').toString();
    const re = /"([^"]{2,80})"|'([^']{2,80})'/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      const p = (m[1] || m[2] || '').trim().toLowerCase();
      if (p) phrases.push(p);
      if (phrases.length >= 4) break;
    }
  } catch {
    // ignore
  }
  for (const p of phrases) {
    const hit = candidates.find((a) => (a?.label || '').trim().toLowerCase() === p);
    if (hit) return hit;
  }

  return null;
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

  const newOrigin = urlOrigin(incomingUrl);
  const prevOrigin = state.session?.origin || (state.context?.url ? urlOrigin(state.context.url) : null);

  if (!state.session.origin && newOrigin) state.session.origin = newOrigin;
  if (!state.session.pageKey && newPageKey) state.session.pageKey = newPageKey;

  // Update page key as we move around, but do NOT auto-clear the session on same-origin navigation.
  // This allows multi-page and new-tab workflows to continue.
  if (newPageKey) state.session.pageKey = newPageKey;

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

  // If the user moved to a different origin while a walkthrough is active, ask what to do.
  const goal = el('goal')?.value?.trim?.() || '';
  const hasSteps = Array.isArray(state.steps) && state.steps.length > 0;
  const sessionActive = Boolean(goal && hasSteps && !state.walkthroughCompleted);
  if (
    sessionActive &&
    prevOrigin &&
    newOrigin &&
    prevOrigin !== newOrigin &&
    !state.finalConfirm.active
  ) {
    state.session.pendingOrigin = newOrigin;
    enterFinalConfirmation({
      kind: 'origin',
      stepIndex: state.currentStepIndex,
      lastClick: null,
      prompt: 'You navigated to a different site.',
      clarifying: `This session started on ${prevOrigin}. You're now on ${newOrigin}.\n\nClick Yes to start a fresh session here (keeping your goal). Click No to end the session.`
    });
  }

  render();
}

async function explainNextStep() {
  const goal = el('goal').value.trim();
  if (!goal) {
    el('summary').textContent = 'Type a goal first.';
    return;
  }

  if (state.busy || state.finalConfirm.active) return;

  await withThinking('Capturing page context…', async () => {
    await captureContext({ statusText: 'Capturing page context…' });
  });
  if (!state.context) {
    el('summary').textContent = 'Could not capture page context. Try again.';
    return;
  }

  await withThinking('Thinking…', async () => {
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
      return;
    }

    const data = await resp.json();
    if (typeof data.summary === 'string') el('summary').textContent = data.summary;
    if (data.clarifyingQuestion) el('clarifying').textContent = `Question: ${data.clarifyingQuestion}`;

    // First Explain establishes the first step; later Explain refreshes the current step.
    const stepSet = applySingleStepFromResponse(data, { source: isPlan ? 'plan' : 'explain', progress: false });
    if (!stepSet && Number.isFinite(data.currentStepIndex)) {
      state.currentStepIndex = Math.max(0, Math.min(data.currentStepIndex, Math.max(0, state.steps.length - 1)));
    }

    if (typeof data.currentStepHelp === 'string') {
      const helpEl = el('currentHelp');
      if (helpEl) helpEl.textContent = data.currentStepHelp;
    }

    // If the model indicates the task is effectively complete (and there's no actionable target),
    // switch to the Done/No confirmation.
    if (maybeEnterFinalConfirmationFromModel(data, { reason: 'explain' })) return;

    state.history.push({
      at: Date.now(),
      goal,
      currentStepIndex: state.currentStepIndex,
      summary: data.summary || null
    });
  });
}

async function refreshCurrentStepHelp({ reason }) {
  const goal = el('goal')?.value?.trim() || '';
  if (!goal) return;
  if (!state.context) return;
  if (!Array.isArray(state.steps) || state.steps.length === 0) return;
  if (state.busy || state.finalConfirm.active) return;

  const r = typeof reason === 'string' ? reason : '';
  const isProgress = r.toLowerCase().includes('progress');

  const beforeIdx = state.currentStepIndex;
  const beforeStep = state.steps[beforeIdx] || null;
  const beforeSig = beforeStep ? normalizeStepSig(beforeStep) : '';
  const beforeLen = state.steps.length;

  await withThinking('Refreshing guidance…', async () => {
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

      if (typeof data.summary === 'string') el('summary').textContent = data.summary;
      if (typeof data.currentStepHelp === 'string') {
        const helpEl = el('currentHelp');
        if (helpEl) helpEl.textContent = data.currentStepHelp;
      }

      const stepSet = applySingleStepFromResponse(data, { source: `refresh:${reason || 'unknown'}`, progress: isProgress });
      if (!stepSet && Number.isFinite(data.currentStepIndex)) {
        state.currentStepIndex = Math.max(0, Math.min(data.currentStepIndex, Math.max(0, state.steps.length - 1)));
      }

      // If we just made progress but the "next" step is basically the same step again,
      // show the Done/No confirmation instead of looping.
      if (isProgress) {
        const afterIdx = state.currentStepIndex;
        const afterStep = state.steps[afterIdx] || null;
        const afterSig = afterStep ? normalizeStepSig(afterStep) : '';
        const afterLen = state.steps.length;

        const repeated = Boolean(afterLen === beforeLen && afterSig && beforeSig && afterSig === beforeSig);
        const tooSimilar = Boolean(beforeStep && afterStep && stepTooSimilar(beforeStep, afterStep));
        const completionText = looksLikeCompletionText(data?.summary) || looksLikeCompletionText(data?.currentStepHelp);
        const isFinal = Boolean(typeof data?.isFinalStep === 'boolean' ? data.isFinalStep : afterStep?.isFinalStep);

        if (repeated || tooSimilar) {
          const lastSig = state.repeatHeuristic.lastSig;
          const sameAsLastRepeat = Boolean(lastSig && afterSig && lastSig === afterSig);
          state.repeatHeuristic.count = sameAsLastRepeat ? (state.repeatHeuristic.count || 0) + 1 : 1;
          state.repeatHeuristic.lastSig = afterSig || null;

          tracePush({
            type: 'step_repeat_detected',
            reason: reason || null,
            repeated,
            tooSimilar,
            repeatCount: state.repeatHeuristic.count,
            isFinal,
            completionText
          });

          // Trigger immediately if model marked final or text suggests completion;
          // otherwise require a second repeat to avoid false positives.
          if (isFinal || completionText || state.repeatHeuristic.count >= 2) {
            enterFinalConfirmation({ stepIndex: state.currentStepIndex, lastClick: null });
            return;
          }
        } else {
          // Reset on real movement.
          state.repeatHeuristic = { count: 0, lastSig: null };
        }
      }

      // Conservative completion heuristic: only when the model provides no next target.
      if (maybeEnterFinalConfirmationFromModel(data, { reason: reason || '' })) return;

      tracePush({ type: 'step_help_refreshed', reason: reason || null, progress: Boolean(isProgress) });
    } catch {
      // ignore
    }
  });
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
  if (state.finalConfirm.active) return;

  // Don't auto-think before the user explicitly starts a walkthrough.
  const goal = el('goal')?.value?.trim() || '';
  if (!goal) return;
  if (!Array.isArray(state.steps) || state.steps.length === 0) return;

  const eventType = typeof event?.eventType === 'string' ? event.eventType : 'click';
  const eventActionId = typeof event?.actionId === 'string' ? event.actionId.trim() : '';

  // If a DOM mutation event arrives for a click seq, it supersedes the scheduled post-click refresh.
  if (eventType === 'dom') {
    const seq = Number.isFinite(event?.seq) ? event.seq : 0;
    if (seq) state.postClickRefresh.lastDomSeqSeen = seq;
    if (state.postClickRefresh.timer) {
      clearTimeout(state.postClickRefresh.timer);
      state.postClickRefresh.timer = null;
    }
  }

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
  await withThinking('Capturing page context…', async () => {
    await captureContext({ statusText: 'Updating context…' });
  });

  // Mark progress if the click label matches current step actionLabel.
  const clickedLabel = typeof event?.label === 'string' ? event.label.trim() : '';
  const clickedActionId = eventActionId;
  const currentStep = state.steps[state.currentStepIndex];
  const expected = typeof currentStep?.actionLabel === 'string' ? currentStep.actionLabel.trim() : '';
  const expectedActionId = typeof currentStep?.actionId === 'string' ? currentStep.actionId.trim() : '';
  const matchedExpected = expectedActionId
    ? Boolean(clickedActionId && clickedActionId === expectedActionId)
    : isSameLabel(clickedLabel, expected);
  if (matchedExpected) {
    state.history.push({ at: Date.now(), type: eventType, label: clickedLabel, matchedStep: state.currentStepIndex });
    tracePush({ type: `step_matched_by_${eventType}`, stepIndex: state.currentStepIndex, actionLabel: expected });
  } else {
    state.history.push({ at: Date.now(), type: eventType, label: clickedLabel || null });
    tracePush({ type: `${eventType}_no_step_match`, expectedActionLabel: expected || null });
  }

  // Step-by-step mode: keep the plan stable; just ask the model if we're on track.
  setStatus('');

  const overlayActions = Array.isArray(state.context?.overlayActions) ? state.context.overlayActions : [];
  const overlayOpen = overlayActions.length > 0 || (Array.isArray(state.context?.activeOverlays) && state.context.activeOverlays.length > 0);
  const clickedIsOverlayOption = Boolean(
    clickedActionId && overlayActions.some((a) => typeof a?.actionId === 'string' && a.actionId === clickedActionId)
  );

  if (matchedExpected && currentStep?.isFinalStep) {
    if (overlayOpen && !clickedIsOverlayOption) {
      await refreshCurrentStepHelp({ reason: 'progress_overlay' });
      schedulePostProgressRefresh(event?.seq);
      return;
    }

    // Final step executed: refresh guidance once. If the model proposes an additional,
    // intuitive follow-up step, show it immediately; otherwise ask for confirmation.
    tracePush({ type: `final_step_executed_by_${eventType}`, stepIndex: state.currentStepIndex, actionLabel: expected || null });

    const beforeLen = state.steps.length;
    const prevExpectedActionId = expectedActionId;
    const prevExpectedLabel = expected;

    await refreshCurrentStepHelp({ reason: 'progress_final' });

    const afterLen = state.steps.length;
    const candidate = state.steps[state.currentStepIndex] || null;
    const hasTarget = Boolean((candidate?.actionId || '').trim() || (candidate?.actionLabel || '').trim());
    const sameActionId = Boolean(candidate?.actionId && prevExpectedActionId && candidate.actionId.trim() === prevExpectedActionId);
    const sameActionLabel = Boolean(candidate?.actionLabel && prevExpectedLabel && isSameLabel(candidate.actionLabel, prevExpectedLabel));
    const isSameTarget = sameActionId || sameActionLabel;
    const followupOk = Boolean(afterLen > beforeLen && candidate && hasTarget && candidate?.isFinalStep !== true && !isSameTarget);

    if (followupOk) {
      el('clarifying').textContent = 'Suggested next step:';
      tracePush({ type: 'final_followup_offered' });
      render();
      return;
    }

    enterFinalConfirmation({
      stepIndex: state.currentStepIndex,
      lastClick: { eventType, label: clickedLabel || null, actionId: clickedActionId || null }
    });
    return;
  }

  await refreshCurrentStepHelp({ reason: matchedExpected ? 'progress' : eventType });
  if (matchedExpected) schedulePostProgressRefresh(event?.seq);
}

async function markDone() {
  if (state.steps.length === 0) return;
  if (state.walkthroughCompleted) return;

  tracePush({ type: 'step_completed_manual', stepIndex: state.currentStepIndex });
  setStatus('');
  await withThinking('Capturing page context…', async () => {
    await captureContext({ statusText: 'Updating context…' });
  });
  await refreshCurrentStepHelp({ reason: 'progress_manual' });
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
    await storageRemove([SESSION_STATE_KEY]);
  } catch {
    // ignore
  }

  try {
    el('goal').value = '';
  } catch {
    // ignore
  }

  try {
    state.session.origin = null;
    state.session.pendingOrigin = null;
    state.session.pageKey = null;
  } catch {
    // ignore
  }

  startNewSession({ reason: 'completed', pageKey: null, keepContext: false, setStatusText: 'Session ended — cleared.' });
}

el('goal').addEventListener('input', () => {
  // Keep Explain enabled/disabled in sync with typed goal.
  render();
});
el('explain').addEventListener('click', explainNextStep);
el('done').addEventListener('click', markDone);
el('endSession')?.addEventListener('click', async () => {
  if (state.busy) return;
  if (state.walkthroughCompleted) return;
  if (!Array.isArray(state.steps) || state.steps.length === 0) return;
  if (state.finalConfirm.active) return;

  tracePush({ type: 'end_session_clicked' });
  await withThinking('Ending session…', async () => {
    await endSessionAndClear();
  });
});
el('finalYes')?.addEventListener('click', async () => {
  if (state.busy) return;
  if (!state.finalConfirm.active) return;
  const kind = state.finalConfirm.kind || 'completion';
  tracePush({ type: 'final_confirm_yes', kind, stepIndex: state.finalConfirm.stepIndex });

  if (kind === 'origin') {
    const pendingOrigin = typeof state.session?.pendingOrigin === 'string' ? state.session.pendingOrigin : null;
    state.session.origin = pendingOrigin || state.session.origin || null;
    state.session.pendingOrigin = null;
    const pageKey = state.context?.url ? normalizeUrlForSession(state.context.url) : state.session.pageKey;
    state.session.pageKey = pageKey || null;
    startNewSession({ reason: 'origin_change', pageKey: state.session.pageKey, keepContext: true, setStatusText: 'New site — started a fresh session.' });
    render();
    return;
  }

  // completion: user still needs help
  state.finalConfirm = { active: false, kind: null, stepIndex: null, clickedAt: 0, lastClick: null };
  render();
  setStatus('');
  await refreshCurrentStepHelp({ reason: 'progress_final_yes' });
});

el('finalNo').addEventListener('click', async () => {
  if (state.busy) return;
  if (!state.finalConfirm.active) return;
  const kind = state.finalConfirm.kind || 'completion';
  tracePush({ type: 'final_confirm_no', kind, stepIndex: state.finalConfirm.stepIndex });

  // No means: end the session.
  await withThinking('Ending session…', async () => {
    await endSessionAndClear();
  });
});
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

restoreSessionStateOnce()
  .catch(() => {})
  .finally(() => {
    render();
    try {
      const goal = el('goal')?.value?.trim?.() || '';
      const hasSteps = Array.isArray(state.steps) && state.steps.length > 0;
      if (goal && hasSteps) {
        // Best-effort realign to the current active tab.
        void captureContext({ statusText: '' });
      }
    } catch {
      // ignore
    }
  });
