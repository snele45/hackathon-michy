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
  el('backendUrl').value = state.backendUrl;

  const ctx = state.context;
  el('pageTitle').textContent = ctx?.title || 'No page captured yet';
  el('pageMeta').textContent = ctx?.url ? ctx.url : '';
  el('contextPreview').textContent = ctx
    ? JSON.stringify(
        {
          selectedText: ctx.selectedText || null,
          headings: ctx.headings,
          primaryActions: ctx.primaryActions
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
    stepsEl.appendChild(li);
  });

  el('done').disabled = state.steps.length === 0;
}

async function saveBackendUrl() {
  const v = el('backendUrl').value.trim();
  state.backendUrl = v || 'http://localhost:8787';
  await chrome.storage.local.set({ backendUrl: state.backendUrl });
  el('backendStatus').textContent = `Saved: ${state.backendUrl}`;
  render();
}

async function loadSettings() {
  const { backendUrl } = await chrome.storage.local.get(['backendUrl']);
  if (backendUrl) state.backendUrl = backendUrl;
  render();
}

async function captureContext() {
  el('backendStatus').textContent = '';
  const result = await chrome.runtime.sendMessage({ type: 'CAPTURE_CONTEXT' });
  if (!result?.ok) {
    el('backendStatus').textContent = result?.error || 'Failed to capture context.';
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

el('saveBackend').addEventListener('click', saveBackendUrl);
el('capture').addEventListener('click', captureContext);
el('explain').addEventListener('click', explainNextStep);
el('done').addEventListener('click', markDone);

loadSettings();
