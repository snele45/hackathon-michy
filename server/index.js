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
      steps
    } = req.body || {};

    if (!goal || typeof goal !== 'string') {
      return res.status(400).json({ error: 'Missing `goal` (string).' });
    }

    const safeContext = {
      url: context?.url || null,
      title: context?.title || null,
      selectedText: context?.selectedText || null,
      headings: Array.isArray(context?.headings) ? context.headings.slice(0, 10) : [],
      primaryActions: Array.isArray(context?.primaryActions) ? context.primaryActions.slice(0, 20) : [],
      navItems: Array.isArray(context?.navItems) ? context.navItems.slice(0, 25) : [],
      navLinkCandidates: Array.isArray(context?.navLinkCandidates)
        ? context.navLinkCandidates.slice(0, 35).map((x) => ({
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
      '',
      'Mode semantics:',
      '- If Mode is "plan": return a full ordered steps array (3-8 steps).',
      '- If Mode is "step": DO NOT re-plan. Keep "steps" as an empty array [], and only update summary/currentStepHelp/currentStepIndex.',
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
      '',
      'Current plan steps (may be empty):',
      JSON.stringify(safePlanSteps),
      '',
      'Context JSON:',
      JSON.stringify(safeContext),
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

    // Enforce UX: no questions, and keep plan stable in step mode.
    if (data && typeof data === 'object') {
      data.clarifyingQuestion = null;
      const effectiveMode = (mode || '').toLowerCase();
      if (effectiveMode === 'step') data.steps = [];
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
