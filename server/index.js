import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';

dotenv.config();

const PORT = Number.parseInt(process.env.PORT || '8787', 10);
const OPENAI_API_BASE_URL = process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

const client = OPENAI_API_KEY
  ? new OpenAI({
      apiKey: OPENAI_API_KEY,
      baseURL: OPENAI_API_BASE_URL
    })
  : null;

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/explain', async (req, res) => {
  try {
    if (!client) {
      return res.status(500).json({
        error: 'Missing OPENAI_API_KEY. Create server/.env (see .env.example).'
      });
    }

    const {
      goal,
      context,
      history,
      currentStepIndex,
      mode,
      steps,
      reason
    } = req.body || {};

    if (!goal || typeof goal !== 'string') {
      return res.status(400).json({ error: 'Missing `goal` (string).' });
    }

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
      recentEvents: Array.isArray(context?.recentEvents)
        ? context.recentEvents
            .slice(-10)
            .map((e) => ({
              at: e?.at || null,
              kind: e?.kind || null,
              label: typeof e?.label === 'string' ? e.label.slice(0, 80) : null,
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

    // Prefer focused context when we have enough signal.
    const contextForModel = {
      ...focused,
      // Keep these as-is to preserve page understanding.
      headings: safeContext.headings,
      navigationGroups: safeContext.navigationGroups,
      dropdownTriggers: safeContext.dropdownTriggers,
      openMenuGroups: safeContext.openMenuGroups,
      recentEvents: safeContext.recentEvents,
      navGraph: safeContext.navGraph,
      fieldLabels: safeContext.fieldLabels,
      primaryFields: safeContext.primaryFields,
      fieldCandidates: safeContext.fieldCandidates,
      themeHint: safeContext.themeHint
    };

    const safeHistory = Array.isArray(history) ? history.slice(-10) : [];
    const safePlanSteps = Array.isArray(steps)
      ? steps.slice(0, 18).map((s) => ({
          title: typeof s?.title === 'string' ? s.title.slice(0, 120) : '',
          details: typeof s?.details === 'string' ? s.details.slice(0, 260) : '',
          actionLabel: typeof s?.actionLabel === 'string' ? s.actionLabel.slice(0, 80) : null
        }))
      : [];

    const prompt = [
      'You are an onboarding buddy for a clerk using a specific web software.',
      'Goal: provide step-by-step guidance grounded in the provided page context.',
      '',
      'Rules:',
      '- Do not invent UI elements that are not suggested by context.',
      '- Do NOT ask clarifying questions. If unsure, provide your best guess with a safe fallback ("if you do not see X, try Y") and set clarifyingQuestion to null.',
      '- Keep steps actionable and short.',
      '- Prefer referencing common UI affordances: menus, tabs, buttons, search boxes, forms.',
      '- Use the Goal text to choose the most relevant actions from Context.primaryActions (e.g., if goal mentions Instagram/social media/templates, prefer matching visible labels like "Templates" or "Social media See all" if present).',
      '- If Context.openMenuGroups includes visible items (dropdown/menu options), prefer selecting an actionLabel from those items when guiding through submenus.',
      '- Prefer selecting navigation/sidebar items from Context.navItems / Context.navigationGroups for section changes (this is usually the start of a walkthrough).',
      '- If the goal is about email/inbox/unread and Context.navItems includes "Mailbox", choose "Mailbox" as the next click.',
      '- If the goal mentions a specific repository/project name and Context.navLinkCandidates includes a link with that exact label (or very close), choose that as the next click (do NOT suggest profile editing).',
      '- If on GitHub and the goal is about branches: first navigate to the repository page, then guide to its Branches view (often visible as a "Branches" link or by URL ending with "/branches").',
      '- If Context.recentEvents show recent clicks, use that to infer progress and suggest what to do next.',
      '- Output MUST be valid JSON only (no markdown, no prose outside JSON).',
      '',
      'Return JSON schema:',
      '{',
      '  "summary": string,',
      '  "clarifyingQuestion": null,',
      '  "steps": Array<{"title": string, "details": string, "actionLabel"?: string}>,',
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
      '- If Mode is "step": DO NOT re-plan.',
      '  - If Reason includes "progress": return exactly 1 next step in "steps" (the next action to take now).',
      '  - Otherwise (Reason not progress): keep "steps" as an empty array [] and only update summary/currentStepHelp/currentStepIndex.',
      '- In "step" mode you MUST assess whether the last user interaction moved toward the goal (relevance check) using Context.url/title/headings/recentEvents/navGraph.',
      '  - If it seems relevant progress: say so briefly in summary and give the next concrete action.',
      '  - If it seems NOT relevant: say why, and suggest a correction (which nav item/menu to use).',
      '',
      'Guidance for steps:',
      '- If a step requires clicking a button/link, set actionLabel to the exact visible label.',
      '- If a step requires filling a field, set actionLabel to the field label OR placeholder text (what the user sees).',
      '- Prefer an EXACT match from Context.primaryActions or Context.primaryFields (case-insensitive match is ok) so the UI can locate/highlight it.',
      '- Prefer visible text. If an element is icon-only with no visible label, using its aria-label or title is acceptable as a fallback.',
      '- If you cannot confidently provide an exact actionLabel from context, omit actionLabel and instead describe WHERE it is (left sidebar/top bar/right panel/main area) using Context.navigationGroups[*].area and the surrounding labels.',
      '- Use Context.navLinkCandidates (label -> destination) and Context.navGraph (observed clicks -> URL) to disambiguate navigation. When helpful, mention the destination path in details, but keep actionLabel as the visible label.',
      '- If the UI uses div-based controls (no <button>), use Context.interactiveContainers[*].controls to pick the best visible label/ariaLabel/testid and describe where it is (area + nearby labels).',
      '',
      'Current plan steps (may be empty):',
      JSON.stringify(safePlanSteps),
      '',
      'Context JSON:',
      JSON.stringify(contextForModel),
      '',
      'History (most recent last):',
      JSON.stringify(safeHistory)
    ].join('\n');

    const response = await client.responses.create({
      model: OPENAI_MODEL,
      input: prompt,
      temperature: 0.2
    });

    const text = response.output_text?.trim() || '';

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return res.json({
        summary: 'Model returned non-JSON output. Showing raw text.',
        clarifyingQuestion: null,
        steps: [],
        currentStepIndex: 0,
        currentStepHelp: text
      });
    }

    // Enforce UX: no questions, and keep step mode incremental.
    if (data && typeof data === 'object') {
      data.clarifyingQuestion = null;
      const effectiveMode = (mode || '').toLowerCase();
      const effectiveReason = typeof reason === 'string' ? reason.toLowerCase() : '';
      if (effectiveMode === 'step') {
        const wantsNextStep = effectiveReason.includes('progress');
        if (!wantsNextStep) {
          data.steps = [];
        } else if (Array.isArray(data.steps)) {
          data.steps = data.steps.slice(0, 1);
        } else {
          data.steps = [];
        }
      }

      // Keep output bounded.
      if (Array.isArray(data.steps) && data.steps.length > 1) data.steps = data.steps.slice(0, 1);
    }

    return res.json(data);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
