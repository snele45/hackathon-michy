let state = {
  backendUrl: 'http://localhost:8787',
  context: null,
  steps: [],
  currentStepIndex: 0,
  history: []
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
  el('contextPreview').textContent = ctx
    ? JSON.stringify(
        {
          selectedText: ctx.selectedText || null,
          headings: ctx.headings,
          primaryActions: ctx.primaryActions,
          fieldLabels: ctx.fieldLabels
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

  el('done').disabled = state.steps.length === 0;
}

function setStatus(text) {
  el('statusLine').textContent = text || '';
}

function findActionCandidate(label) {
  const ctx = state.context;
  if (!ctx?.actionCandidates || !Array.isArray(ctx.actionCandidates)) return null;
  const target = (label || '').trim().toLowerCase();
  if (!target) return null;
  const exact = ctx.actionCandidates.find((a) => (a?.label || '').trim().toLowerCase() === target);
  if (exact) return exact;

  const partial = ctx.actionCandidates.filter((a) => ((a?.label || '').trim().toLowerCase() || '').includes(target));
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

async function captureContext() {
  setStatus('');
  const result = await chrome.runtime.sendMessage({ type: 'CAPTURE_CONTEXT' });
  if (!result?.ok) {
    setStatus(result?.error || 'Failed to capture context.');
    return;
  }

  state.context = result.context;
  setThemeFromHint(state.context?.themeHint);
  render();
}

async function explainNextStep() {
  const goal = el('goal').value.trim();
  if (!goal) {
    el('summary').textContent = 'Type a goal first.';
    return;
  }

  if (!state.context) {
    el('summary').textContent = 'Capture page context first.';
    return;
  }

  el('summary').textContent = 'Thinking…';
  el('clarifying').textContent = '';
  el('currentHelp').textContent = '';

  const payload = {
    goal,
    context: state.context,
    history: state.history,
    currentStepIndex: state.currentStepIndex,
    mode: state.steps.length === 0 ? 'plan' : 'step'
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

  if (Array.isArray(data.steps) && data.steps.length > 0) {
    state.steps = data.steps;
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

  render();
}

function markDone() {
  if (state.steps.length === 0) return;
  state.currentStepIndex = Math.min(state.currentStepIndex + 1, state.steps.length - 1);
  render();
}

el('capture').addEventListener('click', captureContext);
el('explain').addEventListener('click', explainNextStep);
el('done').addEventListener('click', markDone);

render();
