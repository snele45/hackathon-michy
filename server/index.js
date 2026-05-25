import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { randomUUID } from 'crypto';
import { MemoryStore, buildMemoryDocuments, defaultMemoryFilePath } from './memoryStore.js';

dotenv.config();

const PORT = Number.parseInt(process.env.PORT || '8787', 10);
const OPENAI_API_BASE_URL = process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const OPENAI_EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
const MEMORY_MAX_DOCS = Number.parseInt(process.env.MEMORY_MAX_DOCS || '250', 10);
const MEMORY_DISABLED = /^(1|true|yes|on)$/i.test(String(process.env.MEMORY_DISABLED || '').trim());

const client = OPENAI_API_KEY
  ? new OpenAI({
      apiKey: OPENAI_API_KEY,
      baseURL: OPENAI_API_BASE_URL
    })
  : null;

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));

function nowIso() {
  return new Date().toISOString();
}

function mkReqId() {
  try {
    return randomUUID().slice(0, 8);
  } catch {
    return Math.random().toString(16).slice(2, 10);
  }
}

function logEvent(event, data) {
  try {
    const payload = data && typeof data === 'object' ? data : { value: data };
    console.log(JSON.stringify({ at: nowIso(), event, ...payload }));
  } catch {
    console.log(`[${nowIso()}] ${event}`);
  }
}

const MEMORY_FILE_PATH = process.env.MEMORY_FILE_PATH || defaultMemoryFilePath();

const memoryStorePromise = MEMORY_DISABLED
  ? Promise.resolve(null)
  : MemoryStore.load({
      filePath: MEMORY_FILE_PATH,
      maxDocs: Number.isFinite(MEMORY_MAX_DOCS) ? MEMORY_MAX_DOCS : 250
    });

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

function computeSessionKey({ session, url }) {
  const pageKey = typeof session?.pageKey === 'string' ? session.pageKey.slice(0, 220) : null;
  const sessionId = Number.isFinite(session?.id) ? session.id : null;
  const startedAt = Number.isFinite(session?.startedAt) ? session.startedAt : null;

  let host = null;
  try {
    if (typeof url === 'string' && url) host = new URL(url).host;
  } catch {
    host = null;
  }

  return `${pageKey || host || 'unknown'}|${sessionId ?? ''}|${startedAt ?? ''}`;
}

app.post('/api/explain', async (req, res) => {
  try {
    const reqId = mkReqId();
    const t0 = Date.now();

    if (!client) {
      return res.status(500).json({
        error: 'Missing OPENAI_API_KEY. Create server/.env (see .env.example).'
      });
    }

    const {
      goal,
      context,
      screenshot,
      history,
      currentStepIndex,
      mode,
      steps,
      reason,
      session
    } = req.body || {};

    if (!goal || typeof goal !== 'string') {
      return res.status(400).json({ error: 'Missing `goal` (string).' });
    }

    const urlHint = typeof context?.url === 'string' ? context.url.slice(0, 360) : null;
    const sessionKey = computeSessionKey({ session, url: urlHint });
    const hasScreenshot = typeof screenshot === 'string' && screenshot.startsWith('data:image/');
    const lastEventRaw = Array.isArray(context?.recentEvents) ? context.recentEvents[context.recentEvents.length - 1] : null;
    const lastEvent = lastEventRaw
      ? {
          eventType: lastEventRaw?.eventType || null,
          kind: lastEventRaw?.kind || null,
          label: typeof lastEventRaw?.label === 'string' ? lastEventRaw.label.slice(0, 100) : null,
          actionId: typeof lastEventRaw?.actionId === 'string' ? lastEventRaw.actionId.slice(0, 60) : null,
          change: lastEventRaw?.change || null,
          urlAfter: typeof lastEventRaw?.urlAfter === 'string' ? lastEventRaw.urlAfter.slice(0, 180) : null
        }
      : null;

    logEvent('explain_request', {
      reqId,
      sessionKey,
      mode: typeof mode === 'string' ? mode : null,
      reason: typeof reason === 'string' ? reason : null,
      url: urlHint,
      goalLen: goal.length,
      stepsIn: Array.isArray(steps) ? steps.length : 0,
      currentStepIndex: Number.isFinite(currentStepIndex) ? currentStepIndex : null,
      hasScreenshot,
      screenshotStale: Boolean(context?.screenshotStale),
      lastEvent
    });

    function tokenizeGoal(g) {
      const raw = (g || '').toLowerCase();
      const tokens = raw
        .split(/[^a-z0-9_\-./]+/g)
        .map((t) => t.trim())
        .filter(Boolean)
        .filter((t) => t.length >= 3);
      return [...new Set(tokens)].slice(0, 18);
    }

    function isImportantNavLabel(label) {
      const t = (label || '').toLowerCase();
      return [
        'repositories',
        'repo',
        'branches',
        'branch',
        'code',
        'projects',
        'packages',
        'stars',
        'overview',
        'pull requests',
        'issues',
        'actions',
        'insights',
        'settings'
      ].some((k) => t.includes(k));
    }

    function matchesGoal(text, goalTokens) {
      const t = (text || '').toLowerCase();
      if (!t) return false;
      return goalTokens.some((k) => t.includes(k));
    }

    function scoreUiAction(a, goalTokens) {
      if (!a || typeof a !== 'object') return -999;
      let score = 0;

      const label = (a.label || '').toString().toLowerCase();
      const semanticType = (a.semanticType || '').toString().toLowerCase();
      const area = (a.area || '').toString().toLowerCase();

      for (const k of goalTokens) {
        if (label.includes(k)) score += 8;
      }

      if (area === 'left' || area === 'top') score += 2;
      if (semanticType.includes('nav') || semanticType.includes('tab')) score += 1;

      if (a.enabled === false) score -= 6;
      if (a.visible === false) score -= 8;

      // Prefer labeled targets.
      if (label) score += Math.min(3, Math.floor(label.length / 12));

      return score;
    }

    function normalizeLabelForMatch(label) {
      const raw = (label || '').toString().trim();
      if (!raw) return '';
      let s = raw.replace(/\s+/g, ' ').trim();
      s = s.replace(/^["'“”]+/, '').replace(/["'“”]+$/, '').trim();
      return s.toLowerCase();
    }

    function buildAllowedTargets({ overlayActions, uiActions }) {
      const out = [];
      const seen = new Set();

      function push(a, { source }) {
        if (!a || typeof a !== 'object') return;
        const actionId = typeof a.actionId === 'string' ? a.actionId.trim().slice(0, 40) : '';
        if (!actionId) return;
        if (seen.has(actionId)) return;
        seen.add(actionId);

        const label = typeof a.label === 'string' ? a.label.trim().replace(/\s+/g, ' ').slice(0, 90) : null;
        out.push({
          actionId,
          label,
          semanticType: typeof a.semanticType === 'string' ? a.semanticType.slice(0, 30) : null,
          area: a.area || null,
          containerId: typeof a.containerId === 'string' ? a.containerId.slice(0, 120) : null,
          overlayRole: typeof a.overlayRole === 'string' ? a.overlayRole.slice(0, 20) : null,
          enabled: typeof a.enabled === 'boolean' ? a.enabled : null,
          visible: typeof a.visible === 'boolean' ? a.visible : null,
          source
        });
      }

      const overlays = Array.isArray(overlayActions) ? overlayActions : [];
      for (const a of overlays.slice(0, 80)) push(a, { source: 'overlay' });

      const actions = Array.isArray(uiActions) ? uiActions : [];
      for (const a of actions.slice(0, 120)) push(a, { source: 'page' });

      return out.slice(0, 80);
    }

    function normalizeStepToAllowedTargets(step0, allowedTargets) {
      const step = step0 && typeof step0 === 'object' ? { ...step0 } : {};

      const byId = new Map();
      const byLabel = new Map();
      for (const t of Array.isArray(allowedTargets) ? allowedTargets : []) {
        if (!t || typeof t !== 'object') continue;
        if (typeof t.actionId === 'string' && t.actionId) byId.set(t.actionId, t);
        const key = normalizeLabelForMatch(t.label);
        if (key && !byLabel.has(key)) byLabel.set(key, t);
      }

      const rawId = typeof step.actionId === 'string' ? step.actionId.trim() : '';
      const rawLabel = typeof step.actionLabel === 'string' ? step.actionLabel.trim() : '';

      let target = null;
      if (rawId && byId.has(rawId)) {
        target = byId.get(rawId);
      } else if (rawLabel) {
        const key = normalizeLabelForMatch(rawLabel);
        target = (key && byLabel.has(key)) ? byLabel.get(key) : null;

        if (!target && key) {
          const matches = (Array.isArray(allowedTargets) ? allowedTargets : []).filter((t) => {
            const k = normalizeLabelForMatch(t?.label);
            if (!k) return false;
            return k === key || k.includes(key) || key.includes(k);
          });
          if (matches.length === 1) target = matches[0];
        }
      }

      if (target) {
        step.actionId = target.actionId;
        if (target.label) step.actionLabel = target.label;
      } else {
        if (step.actionId) delete step.actionId;
      }

      if (step.visualTargetNumber != null && !Number.isFinite(step.visualTargetNumber)) {
        delete step.visualTargetNumber;
      }

      if (step.actionLabel && typeof step.actionLabel === 'string') {
        const clean = step.actionLabel.trim().replace(/\s+/g, ' ');
        step.actionLabel = clean.length > 90 ? clean.slice(0, 90) : clean;
      }

      return step;
    }

    const goalTokens = tokenizeGoal(goal);
    const isGitHub = typeof context?.url === 'string' && context.url.includes('github.com');
    const wantsBranches = /\bbranch(es)?\b/i.test(goal);

    const safeContext = {
      url: context?.url || null,
      title: context?.title || null,
      selectedText: context?.selectedText || null,
      headings: Array.isArray(context?.headings) ? context.headings.slice(0, 10) : [],
      primaryActions: Array.isArray(context?.primaryActions) ? context.primaryActions.slice(0, 20) : [],
      navItems: Array.isArray(context?.navItems) ? context.navItems.slice(0, 25) : [],
      navLinkCandidates: Array.isArray(context?.navLinkCandidates)
        ? context.navLinkCandidates.slice(0, 60).map((x) => ({
            label: typeof x?.label === 'string' ? x.label.slice(0, 80) : null,
            to: typeof x?.to === 'string' ? x.to.slice(0, 180) : null,
            area: x?.area || null,
            groupKey: x?.groupKey || null
          }))
        : [],
      navGraph: Array.isArray(context?.navGraph)
        ? context.navGraph.slice(0, 40).map((e) => ({
            label: typeof e?.label === 'string' ? e.label.slice(0, 80) : null,
            kind: e?.kind || null,
            from: typeof e?.from === 'string' ? e.from.slice(0, 180) : null,
            to: typeof e?.to === 'string' ? e.to.slice(0, 180) : null
          }))
        : [],

      interactiveContainers: Array.isArray(context?.interactiveContainers)
        ? context.interactiveContainers.slice(0, 40).map((c) => ({
            tag: c?.tag || null,
            id: typeof c?.id === 'string' ? c.id.slice(0, 60) : null,
            class: typeof c?.class === 'string' ? c.class.slice(0, 140) : null,
            role: c?.role || null,
            testid: typeof c?.testid === 'string' ? c.testid.slice(0, 80) : null,
            label: typeof c?.label === 'string' ? c.label.slice(0, 80) : null,
            value: typeof c?.value === 'string' ? c.value.slice(0, 80) : null,
            dataSubpanelId: typeof c?.dataSubpanelId === 'string' ? c.dataSubpanelId.slice(0, 80) : null,
            area: c?.area || null,
            controls: Array.isArray(c?.controls)
              ? c.controls.slice(0, 12).map((x) => ({
                  kind: x?.kind || null,
                  tag: x?.tag || null,
                  role: x?.role || null,
                  label: typeof x?.label === 'string' ? x.label.slice(0, 80) : null,
                  id: typeof x?.id === 'string' ? x.id.slice(0, 60) : null,
                  name: typeof x?.name === 'string' ? x.name.slice(0, 60) : null,
                  type: x?.type || null,
                  testid: typeof x?.testid === 'string' ? x.testid.slice(0, 80) : null,
                  ariaLabel: typeof x?.ariaLabel === 'string' ? x.ariaLabel.slice(0, 80) : null
                }))
              : []
          }))
        : [],
      navigationGroups: Array.isArray(context?.navigationGroups)
        ? context.navigationGroups.slice(0, 4).map((g) => ({
            kind: g?.kind || null,
            key: g?.key || null,
            area: g?.area || null,
            items: Array.isArray(g?.items) ? g.items.slice(0, 24) : []
          }))
        : [],
      fieldLabels: Array.isArray(context?.fieldLabels) ? context.fieldLabels.slice(0, 20) : [],
      primaryFields: Array.isArray(context?.primaryFields) ? context.primaryFields.slice(0, 20) : [],
      fieldCandidates: Array.isArray(context?.fieldCandidates)
        ? context.fieldCandidates.slice(0, 25).map((f) => ({
            label: typeof f?.label === 'string' ? f.label.slice(0, 80) : null,
            labelSource: f?.labelSource || null,
            placeholder: typeof f?.placeholder === 'string' ? f.placeholder.slice(0, 80) : null,
            name: typeof f?.name === 'string' ? f.name.slice(0, 80) : null,
            kind: f?.kind || null,
            disabled: f?.disabled || null,
            required: f?.required || null,
            hasValue: f?.hasValue || null,
            valueLength: Number.isFinite(f?.valueLength) ? f.valueLength : null,
            optionsCount: Number.isFinite(f?.optionsCount) ? f.optionsCount : null
          }))
        : [],
      dropdownTriggers: Array.isArray(context?.dropdownTriggers)
        ? context.dropdownTriggers.slice(0, 20).map((d) => ({
            label: typeof d?.label === 'string' ? d.label.slice(0, 80) : null,
            kind: d?.kind || null,
            role: d?.role || null,
            haspopup: d?.haspopup || null,
            expanded: typeof d?.expanded === 'boolean' ? d.expanded : null,
            area: d?.area || null
          }))
        : [],
      openMenuGroups: Array.isArray(context?.openMenuGroups)
        ? context.openMenuGroups.slice(0, 6).map((g) => ({
            kind: g?.kind || null,
            items: Array.isArray(g?.items) ? g.items.slice(0, 12) : []
          }))
        : [],
      activeOverlays: Array.isArray(context?.activeOverlays)
        ? context.activeOverlays.slice(0, 4).map((o) => ({
            role: typeof o?.role === 'string' ? o.role.slice(0, 30) : null,
            containerId: typeof o?.containerId === 'string' ? o.containerId.slice(0, 120) : null,
            area: o?.area || null
          }))
        : [],
      overlayActions: Array.isArray(context?.overlayActions)
        ? context.overlayActions.slice(0, 80).map((a) => ({
            actionId: typeof a?.actionId === 'string' ? a.actionId.slice(0, 40) : null,
            label: typeof a?.label === 'string' ? a.label.slice(0, 90) : null,
            semanticType: typeof a?.semanticType === 'string' ? a.semanticType.slice(0, 30) : null,
            visible: typeof a?.visible === 'boolean' ? a.visible : null,
            enabled: typeof a?.enabled === 'boolean' ? a.enabled : null,
            area: a?.area || null,
            containerId: typeof a?.containerId === 'string' ? a.containerId.slice(0, 120) : null,
            overlayRole: typeof a?.overlayRole === 'string' ? a.overlayRole.slice(0, 20) : null,
            expanded: typeof a?.expanded === 'boolean' ? a.expanded : null,
            selected: typeof a?.selected === 'boolean' ? a.selected : null,
            checked: typeof a?.checked === 'boolean' ? a.checked : null
          }))
        : [],
      uiActions: Array.isArray(context?.uiActions)
        ? context.uiActions.slice(0, 180).map((a) => ({
            actionId: typeof a?.actionId === 'string' ? a.actionId.slice(0, 40) : null,
            label: typeof a?.label === 'string' ? a.label.slice(0, 90) : null,
            semanticType: typeof a?.semanticType === 'string' ? a.semanticType.slice(0, 30) : null,
            visible: typeof a?.visible === 'boolean' ? a.visible : null,
            enabled: typeof a?.enabled === 'boolean' ? a.enabled : null,
            area: a?.area || null,
            containerId: typeof a?.containerId === 'string' ? a.containerId.slice(0, 120) : null,
            rect: a?.rect && typeof a.rect === 'object'
              ? {
                  x: Number.isFinite(a.rect.x) ? a.rect.x : null,
                  y: Number.isFinite(a.rect.y) ? a.rect.y : null,
                  w: Number.isFinite(a.rect.w) ? a.rect.w : null,
                  h: Number.isFinite(a.rect.h) ? a.rect.h : null
                }
              : null,
            expanded: typeof a?.expanded === 'boolean' ? a.expanded : null,
            selected: typeof a?.selected === 'boolean' ? a.selected : null,
            checked: typeof a?.checked === 'boolean' ? a.checked : null
          }))
        : [],
      visualTargets: Array.isArray(context?.visualTargets)
        ? context.visualTargets.slice(0, 60).map((t) => ({
            id: typeof t?.id === 'string' ? t.id.slice(0, 40) : null,
            number: Number.isFinite(t?.number) ? t.number : null,
            label: typeof t?.label === 'string' ? t.label.slice(0, 90) : null,
            kind: typeof t?.kind === 'string' ? t.kind.slice(0, 30) : null,
            enabled: typeof t?.enabled === 'boolean' ? t.enabled : null,
            visible: typeof t?.visible === 'boolean' ? t.visible : null,
            area: t?.area || null,
            rect: t?.rect && typeof t.rect === 'object'
              ? {
                  x: Number.isFinite(t.rect.x) ? t.rect.x : null,
                  y: Number.isFinite(t.rect.y) ? t.rect.y : null,
                  w: Number.isFinite(t.rect.w) ? t.rect.w : null,
                  h: Number.isFinite(t.rect.h) ? t.rect.h : null
                }
              : null
          }))
        : [],
      recentEvents: Array.isArray(context?.recentEvents)
        ? context.recentEvents
            .slice(-10)
            .map((e) => ({
              at: e?.at || null,
              eventType: typeof e?.eventType === 'string' ? e.eventType.slice(0, 16) : null,
              kind: e?.kind || null,
              label: typeof e?.label === 'string' ? e.label.slice(0, 80) : null,
              actionId: typeof e?.actionId === 'string' ? e.actionId.slice(0, 120) : null,
              domChange:
                e?.domChange && typeof e.domChange === 'object'
                  ? {
                      childList: Number.isFinite(e.domChange.childList) ? e.domChange.childList : null,
                      attrs: Number.isFinite(e.domChange.attrs) ? e.domChange.attrs : null,
                      text: Number.isFinite(e.domChange.text) ? e.domChange.text : null
                    }
                  : null,
              cause:
                e?.cause && typeof e.cause === 'object'
                  ? {
                      label: typeof e.cause.label === 'string' ? e.cause.label.slice(0, 80) : null,
                      actionId: typeof e.cause.actionId === 'string' ? e.cause.actionId.slice(0, 120) : null,
                      kind: typeof e.cause.kind === 'string' ? e.cause.kind.slice(0, 30) : null
                    }
                  : null,
              urlBefore: typeof e?.urlBefore === 'string' ? e.urlBefore.slice(0, 300) : null,
              urlAfter: typeof e?.urlAfter === 'string' ? e.urlAfter.slice(0, 300) : null
            }))
        : [],
      themeHint: context?.themeHint || null
    };

    // Focus the context to reduce noise: keep goal-matching items plus key navigation affordances.
    const focused = { ...safeContext };

    focused.navItems = (safeContext.navItems || [])
      .filter((x) => matchesGoal(x, goalTokens) || isImportantNavLabel(x))
      .slice(0, 22);

    focused.navLinkCandidates = (safeContext.navLinkCandidates || [])
      .filter((x) => {
        const label = x?.label || '';
        const to = x?.to || '';
        return (
          matchesGoal(label, goalTokens) ||
          matchesGoal(to, goalTokens) ||
          isImportantNavLabel(label) ||
          (isGitHub && wantsBranches && label.toLowerCase().includes('repositories'))
        );
      })
      .slice(0, 28);

    // Interactive containers can easily drown the model; keep only ones that have goal matches
    // or are clearly navigation-like.
    focused.interactiveContainers = (safeContext.interactiveContainers || [])
      .filter((c) => {
        const blob = JSON.stringify(c || {}).toLowerCase();
        if (!blob) return false;
        if (goalTokens.some((k) => blob.includes(k))) return true;
        if (c?.area === 'left' || c?.area === 'top') return true;
        return false;
      })
      .slice(0, 16);

    // Rank UI actions by goal relevance and keep only top candidates.
    const rankedUiActions = (safeContext.uiActions || [])
      .map((a) => ({ ...a, relevanceScore: scoreUiAction(a, goalTokens) }))
      .sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))
      .slice(0, 60);

    focused.uiActions = rankedUiActions;
    focused.visualTargets = (safeContext.visualTargets || []).slice(0, 40);

    // Prefer focused context when we have enough signal.
    const contextForModel = {
      ...focused,
      // Keep these as-is to preserve page understanding.
      headings: safeContext.headings,
      navigationGroups: safeContext.navigationGroups,
      dropdownTriggers: safeContext.dropdownTriggers,
      openMenuGroups: safeContext.openMenuGroups,
      activeOverlays: safeContext.activeOverlays,
      overlayActions: safeContext.overlayActions,
      recentEvents: safeContext.recentEvents,
      navGraph: safeContext.navGraph,
      fieldLabels: safeContext.fieldLabels,
      primaryFields: safeContext.primaryFields,
      fieldCandidates: safeContext.fieldCandidates,
      themeHint: safeContext.themeHint
    };

    const allowedTargets = buildAllowedTargets({
      overlayActions: safeContext.overlayActions,
      uiActions: focused.uiActions
    });

    // ---- Workflow normalization (minimal) ----
    const workflowState = {
      goal: goal.slice(0, 500),
      mode: typeof mode === 'string' ? mode : 'auto',
      reason: typeof reason === 'string' ? reason : '',
      url: contextForModel.url || null,
      title: contextForModel.title || null,
      session: session && typeof session === 'object' ? session : null
    };

    const safeHistory = Array.isArray(history) ? history.slice(-10) : [];
    const safePlanSteps = Array.isArray(steps)
      ? steps.slice(0, 18).map((s) => ({
          title: typeof s?.title === 'string' ? s.title.slice(0, 120) : '',
          details: typeof s?.details === 'string' ? s.details.slice(0, 900) : '',
          actionLabel: typeof s?.actionLabel === 'string' ? s.actionLabel.slice(0, 80) : null,
          actionId: typeof s?.actionId === 'string' ? s.actionId.slice(0, 40) : null
        }))
      : [];

    const previousStep = safePlanSteps?.[0] || null;

    // ---- Knowledge Graph + Vector DB (persistent memory) ----
    let retrievedMemory = [];
    let graphNeighborhood = null;
    if (!MEMORY_DISABLED) {
      try {
        const memoryStore = await memoryStorePromise;
        if (memoryStore) {
          memoryStore.updateGraphFromContext({
            url: contextForModel.url,
            title: contextForModel.title,
            uiActions: contextForModel.uiActions,
            navGraph: contextForModel.navGraph,
            recentEvents: contextForModel.recentEvents
          });

          graphNeighborhood = memoryStore.getGraphNeighborhood({ url: contextForModel.url, maxEdges: 18 });

          const docs = buildMemoryDocuments({
            goal: workflowState.goal,
            url: workflowState.url,
            uiActions: contextForModel.uiActions,
            previousStep,
            returnedStep: null,
            sessionKey
          });

          // Store a small slice of semantic extraction results.
          await memoryStore.upsertDocuments({
            client,
            embeddingModel: OPENAI_EMBEDDING_MODEL,
            documents: docs
          });

          const headingsText = Array.isArray(contextForModel.headings) ? contextForModel.headings.slice(0, 8).join(' | ') : '';
          const queryText = [
            `Goal: ${workflowState.goal}`,
            `URL: ${workflowState.url || ''}`,
            `Title: ${workflowState.title || ''}`,
            `Reason: ${workflowState.reason}`,
            `Headings: ${headingsText}`
          ].join('\n');

          retrievedMemory = await memoryStore.querySimilar({
            client,
            embeddingModel: OPENAI_EMBEDDING_MODEL,
            queryText,
            hostHint: null,
            sessionKey,
            topK: 6
          });

          logEvent('memory_retrieved', {
            reqId,
            sessionKey,
            retrieved: Array.isArray(retrievedMemory) ? retrievedMemory.length : 0,
            hasGraphNeighborhood: Boolean(graphNeighborhood)
          });

          await memoryStore.save();
        }
      } catch (e) {
        // Memory is best-effort; never block the main guidance.
        retrievedMemory = [];
        graphNeighborhood = null;
      }
    }

    const prompt = [
      'You are an onboarding buddy for a clerk using a specific web software.',
      'Goal: provide step-by-step guidance grounded in the provided page context.',
      '',
      'Rules:',
      '- Do not invent UI elements that are not suggested by context.',
      '- Do NOT ask clarifying questions. If unsure, provide your best guess with a safe fallback ("if you do not see X, try Y") and set clarifyingQuestion to null.',
      '- Keep the step title short and actionable.',
      '- HARD LIMIT: steps[0].details MUST be <= 400 characters. Do not exceed this; optimize wording to fit.',
      '- details should include: (1) what to click/type, (2) where it is (area/nearby labels), (3) what success looks like, and (4) one short fallback if the UI differs.',
      '- Prefer referencing common UI affordances: menus, tabs, buttons, search boxes, forms.',
      '- Use the Goal text to choose the most relevant actions from Context.primaryActions (prefer visible labels that closely match goal keywords).',
      '- If Context.openMenuGroups includes visible items (dropdown/menu options), prefer selecting an actionLabel from those items when guiding through submenus.',
      '- Prefer selecting navigation/sidebar items from Context.navItems / Context.navigationGroups for section changes (this is usually the start of a walkthrough).',
      '- If the goal mentions a specific project/repository/entity name and Context.navLinkCandidates includes a link with that exact (or very close) visible label, prefer that link rather than generic account/profile areas.',
      '- If the page host suggests a known app/workflow and Retrieved memory / Graph neighborhood includes a similar path, you may use it as a hint ONLY if it matches the current Context (do not invent UI).',
      '- If Context.recentEvents show recent interactions (click/change/dom), use that to infer progress and suggest what to do next. A "dom" event means the UI changed after the last click; use it as evidence of consequence/progress.',
      '- Output MUST be valid JSON only (no markdown, no prose outside JSON).',
      '',
      'Return JSON schema:',
      '{',
      '  "summary": string,',
      '  "clarifyingQuestion": null,',
      '  "isFinalStep"?: boolean,',
      '  "steps": Array<{"title": string, "details": string, "actionId"?: string, "actionLabel"?: string, "visualTargetNumber"?: number}>,',
      '  "currentStepIndex": number,',
      '  "currentStepHelp": string',
      '}',
      '',
      `Mode: ${mode || 'auto'}`,
      `CurrentStepIndex: ${Number.isFinite(currentStepIndex) ? currentStepIndex : 0}`,
      `Reason: ${typeof reason === 'string' ? reason : ''}`,
      '',
      'Mode semantics:',
      '- If Mode is "plan": return exactly 1 next step (the immediate action to take now).',
      '- If Mode is "step": DO NOT re-plan. Return exactly 1 next step in "steps" (the next action to take now).',
      '- Because the UI shows only one active step at a time, always set currentStepIndex to 0.',
      '- In "step" mode you MUST assess whether the last user interaction moved toward the goal (relevance check) using Context.url/title/headings/recentEvents/navGraph.',
      '  - If it seems relevant progress: say so briefly in summary and give the next concrete action.',
      '  - If it seems NOT relevant: say why, and suggest a correction (which nav item/menu to use).',
      '- If Reason indicates progress (e.g. "progress" or "progress_manual"), do NOT repeat the previous actionId/actionLabel; return the next distinct step.',
      '- If Reason indicates progress but you cannot find a distinct next UI action (you would repeat the same actionId/actionLabel), treat this as likely completion: set isFinalStep=true and return a short verification step with NO actionId/actionLabel.',
      '',
      'Guidance for steps:',
      '- Set isFinalStep=true ONLY when the step you output is the last meaningful user action toward the Goal, or when the Goal already appears complete and you want the user to confirm completion.',
      '- If the Goal appears complete already: return a short verification step with NO actionId/actionLabel (describe what to check in details) and set isFinalStep=true so the UI can ask the user if they still need help.',
      '- If the next action is a final "Submit/Save/Confirm" that should finish the task, set isFinalStep=true on that step.',
      '- If a step requires clicking a button/link, set actionLabel to the exact visible label.',
      '- If a step requires filling a field, set actionLabel to the field label OR placeholder text (what the user sees).',
      '- If Context.uiActions exists, prefer returning steps[0].actionId from Context.uiActions.actionId (this makes highlighting deterministic).',
      '- IMPORTANT: If you output steps[0].actionId, it MUST be one of AllowedTargets.actionId (exact match).',
      '- If overlays are open (Context.activeOverlays non-empty), prefer an AllowedTargets entry with overlayRole/containerId (overlay actions).',
      '- If Context.visualTargets exists, you may also return visualTargetNumber from the matching visualTargets.number.',
      '- IMPORTANT: Put the main guidance in steps[0].details and the click target in steps[0].actionLabel. currentStepHelp should be empty or at most a short fallback hint.',
      '- Prefer an EXACT match from Context.primaryActions or Context.primaryFields (case-insensitive match is ok) so the UI can locate/highlight it.',
      '- Prefer visible text. If an element is icon-only with no visible label, using its aria-label or title is acceptable as a fallback.',
      '- If you cannot confidently provide an exact actionLabel from context, omit actionLabel and instead describe WHERE it is (left sidebar/top bar/right panel/main area) using Context.navigationGroups[*].area and the surrounding labels.',
      '- Use Context.navLinkCandidates (label -> destination) and Context.navGraph (observed clicks -> URL) to disambiguate navigation. When helpful, mention the destination path in details, but keep actionLabel as the visible label.',
      '- If the UI uses div-based controls (no <button>), use Context.interactiveContainers[*].controls to pick the best visible label/ariaLabel/testid and describe where it is (area + nearby labels).',
      '',
      'Current plan steps (may be empty):',
      JSON.stringify(safePlanSteps),
      '',
      'Previous step (single-step UI):',
      JSON.stringify(previousStep),
      '',
      'Workflow state (normalized):',
      JSON.stringify(workflowState),
      '',
      'Graph neighborhood (knowledge graph, compact):',
      JSON.stringify(graphNeighborhood),
      '',
      'Retrieved memory (vector DB top matches, compact):',
      JSON.stringify(retrievedMemory),
      '',
      'AllowedTargets JSON (ONLY choose actionId from this list):',
      JSON.stringify(allowedTargets),
      '',
      'Context JSON:',
      JSON.stringify(contextForModel),
      '',
      'History (most recent last):',
      JSON.stringify(safeHistory)
    ].join('\n');

    async function callModel({ withImage, extraInstruction }) {
      const finalPrompt = extraInstruction ? `${prompt}\n\n${extraInstruction}` : prompt;
      const input = withImage
        ? [
            {
              role: 'user',
              content: [
                { type: 'input_text', text: finalPrompt },
                { type: 'input_image', image_url: screenshot }
              ]
            }
          ]
        : finalPrompt;

      const tCall0 = Date.now();
      const resp = await client.responses.create({
        model: OPENAI_MODEL,
        input,
        temperature: 0.2,
        max_output_tokens: 520
      });

      logEvent('openai_call', {
        reqId,
        sessionKey,
        withImage: Boolean(withImage),
        extraInstruction: Boolean(extraInstruction),
        ms: Date.now() - tCall0
      });

      return resp;
    }

    let response;
    try {
      response = await callModel({ withImage: hasScreenshot, extraInstruction: '' });
    } catch (e) {
      // Fallback: if model or account doesn't support images, retry text-only.
      if (hasScreenshot) {
        logEvent('openai_image_fallback', { reqId, sessionKey, error: e?.message || 'image call failed' });
        response = await callModel({ withImage: false, extraInstruction: '' });
      } else {
        throw e;
      }
    }

    const text = response.output_text?.trim() || '';

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      logEvent('model_non_json', { reqId, sessionKey, textPreview: text.slice(0, 180) });
      return res.json({
        summary: 'Model returned non-JSON output. Showing raw text.',
        clarifyingQuestion: null,
        steps: [],
        currentStepIndex: 0,
        currentStepHelp: text
      });
    }

    // If we just made progress but the model repeated the same action, retry with a stricter instruction.
    const effectiveReason = typeof reason === 'string' ? reason.toLowerCase() : '';
    const isProgressReason = effectiveReason.includes('progress');
    if (isProgressReason && previousStep && data && typeof data === 'object' && Array.isArray(data.steps) && data.steps.length === 1) {
      const next0 = data.steps[0] || {};
      const prevLabel = (previousStep.actionLabel || '').toString().trim().toLowerCase();
      const prevId = (previousStep.actionId || '').toString().trim();
      const nextLabel = (next0.actionLabel || '').toString().trim().toLowerCase();
      const nextId = (next0.actionId || '').toString().trim();

      const repeats = (prevId && nextId && prevId === nextId) || (prevLabel && nextLabel && prevLabel === nextLabel);
      if (repeats) {
        logEvent('model_repeat_retry', {
          reqId,
          sessionKey,
          prevActionId: previousStep.actionId || null,
          prevActionLabel: previousStep.actionLabel || null
        });
        const extra = [
          'STRICT RULE: The user completed the previous step.',
          `Do NOT return the same actionId/actionLabel again (previous actionId=${previousStep.actionId || ''}, actionLabel=${previousStep.actionLabel || ''}).`,
          'Return the NEXT distinct step toward the Goal.'
        ].join('\n');

        const retry = await callModel({ withImage: hasScreenshot, extraInstruction: extra });
        const retryText = retry.output_text?.trim() || '';
        try {
          data = JSON.parse(retryText);
        } catch {
          // keep original data
        }
      }
    }

    // Enforce UX: no questions, and shape output for the single-step UI.
    if (data && typeof data === 'object') {
      data.clarifyingQuestion = null;
      if (Array.isArray(data.steps)) data.steps = data.steps.slice(0, 1);

      // Single-step UI always points at the only step.
      data.currentStepIndex = 0;

      // Normalize isFinalStep.
      const step0 = Array.isArray(data.steps) && data.steps.length === 1 && data.steps[0] && typeof data.steps[0] === 'object' ? data.steps[0] : null;
      const isFinal = typeof data.isFinalStep === 'boolean' ? data.isFinalStep : typeof step0?.isFinalStep === 'boolean' ? step0.isFinalStep : null;
      if (typeof isFinal === 'boolean') data.isFinalStep = isFinal;

      // If the model put the real guidance into currentStepHelp, migrate it into the step details.
      if (Array.isArray(data.steps) && data.steps.length === 1) {
        const step0 = data.steps[0] && typeof data.steps[0] === 'object' ? data.steps[0] : {};
        const help = typeof data.currentStepHelp === 'string' ? data.currentStepHelp.trim() : '';
        const details = typeof step0.details === 'string' ? step0.details.trim() : '';

        if (!details && help) {
          step0.details = help;
          data.steps[0] = step0;
          data.currentStepHelp = '';
        }
      }

      // If details exceed the hard limit, ask the model to rewrite (do not truncate locally).
      if (Array.isArray(data.steps) && data.steps.length === 1) {
        const step0 = data.steps[0] && typeof data.steps[0] === 'object' ? data.steps[0] : {};
        const details = typeof step0.details === 'string' ? step0.details.trim() : '';
        if (details && details.length > 400) {
          try {
            logEvent('details_over_limit_retry', { reqId, sessionKey, detailsLen: details.length });
            const extra = [
              'STRICT FORMAT FIX:',
              '- Your previous JSON violated the details length limit.',
              '- Rewrite the JSON so that steps[0].details is <= 400 characters (hard limit).',
              '- Keep steps array length = 1 and currentStepIndex = 0.',
              '- Keep actionId/actionLabel the same if possible; do not invent new UI.',
              '- Return valid JSON only.',
              'Previous JSON:',
              JSON.stringify(data)
            ].join('\n');

            const retry = await callModel({ withImage: hasScreenshot, extraInstruction: extra });
            const retryText = retry.output_text?.trim() || '';
            const rewritten = JSON.parse(retryText);
            if (rewritten && typeof rewritten === 'object') data = rewritten;
          } catch {
            // best-effort; keep original (client may still display it)
          }
        }
      }

      // Keep summary compact (the UI shows details inside the step).
      if (typeof data.summary === 'string' && data.summary.length > 180) {
        data.summary = data.summary.slice(0, 180);
      }

      // Keep help minimal if present.
      if (typeof data.currentStepHelp === 'string' && data.currentStepHelp.length > 140) {
        data.currentStepHelp = data.currentStepHelp.slice(0, 140);
      }

      // Normalize targets to AllowedTargets so highlighting stays deterministic.
      if (Array.isArray(data.steps) && data.steps.length === 1) {
        const s0 = data.steps[0] && typeof data.steps[0] === 'object' ? data.steps[0] : {};
        const normalized = normalizeStepToAllowedTargets(s0, allowedTargets);
        delete normalized.isFinalStep;
        data.steps[0] = normalized;
      }

      // Expose allowed targets to the client for debugging/telemetry (not required by UI).
      data.allowedTargets = allowedTargets;
    }

    // Persist the returned step into memory (KG/VDB) so future retrieval can use it.
    if (!MEMORY_DISABLED) {
      try {
        const memoryStore = await memoryStorePromise;
        if (memoryStore) {
          const returnedStep = Array.isArray(data?.steps) && data.steps.length ? data.steps[0] : null;
          const docs = buildMemoryDocuments({
            goal: workflowState.goal,
            url: workflowState.url,
            uiActions: contextForModel.uiActions,
            previousStep,
            returnedStep,
            sessionKey
          });
          await memoryStore.upsertDocuments({
            client,
            embeddingModel: OPENAI_EMBEDDING_MODEL,
            documents: docs
          });
          await memoryStore.save();
        }
      } catch {
        // best-effort
      }
    }

    const returned0 = Array.isArray(data?.steps) && data.steps.length ? data.steps[0] : null;
    logEvent('explain_response', {
      reqId,
      sessionKey,
      msTotal: Date.now() - t0,
      actionId: typeof returned0?.actionId === 'string' ? returned0.actionId : null,
      actionLabel: typeof returned0?.actionLabel === 'string' ? returned0.actionLabel : null,
      detailsLen: typeof returned0?.details === 'string' ? returned0.details.length : null
    });

    return res.json(data);
  } catch (err) {
    logEvent('explain_error', { error: err?.message || 'Server error' });
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/session/end', async (req, res) => {
  try {
    if (MEMORY_DISABLED) {
      return res.json({ ok: true, removed: 0, disabled: true });
    }
    const { session, url } = req.body || {};
    const sessionKey = computeSessionKey({ session, url });
    const memoryStore = await memoryStorePromise;
    if (!memoryStore) return res.json({ ok: true, removed: 0, disabled: true });
    const result = memoryStore.clearVectorForSession(sessionKey);
    await memoryStore.save();
    logEvent('session_end', { sessionKey, removed: result?.removed ?? 0 });
    return res.json({ ok: true, ...result });
  } catch (e) {
    logEvent('session_end_error', { error: e?.message || 'session end failed' });
    return res.status(500).json({ ok: false, error: e?.message || 'session end failed' });
  }
});

// Backwards-compatible alias (no longer wipes graph).
app.post('/api/reset', async (req, res) => {
  try {
    if (MEMORY_DISABLED) {
      return res.json({ ok: true, removed: 0, disabled: true });
    }
    const { session, url } = req.body || {};
    const sessionKey = computeSessionKey({ session, url });
    const memoryStore = await memoryStorePromise;
    if (!memoryStore) return res.json({ ok: true, removed: 0, disabled: true });
    const result = memoryStore.clearVectorForSession(sessionKey);
    await memoryStore.save();
    logEvent('reset_alias_session_end', { sessionKey, removed: result?.removed ?? 0 });
    return res.json({ ok: true, ...result });
  } catch (e) {
    logEvent('reset_alias_error', { error: e?.message || 'reset failed' });
    return res.status(500).json({ ok: false, error: e?.message || 'reset failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
