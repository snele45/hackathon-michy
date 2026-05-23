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
      mode
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
      themeHint: context?.themeHint || null
    };

    const safeHistory = Array.isArray(history) ? history.slice(-10) : [];

    const prompt = [
      'You are an onboarding buddy for a clerk using a specific web software.',
      'Goal: provide step-by-step guidance grounded in the provided page context.',
      '',
      'Rules:',
      '- Do not invent UI elements that are not suggested by context; if unsure, ask a clarifying question.',
      '- Keep steps actionable and short.',
      '- Prefer referencing common UI affordances: menus, tabs, buttons, search boxes, forms.',
      '- Output MUST be valid JSON only (no markdown, no prose outside JSON).',
      '',
      'Return JSON schema:',
      '{',
      '  "summary": string,',
      '  "clarifyingQuestion": string | null,',
      '  "steps": Array<{"title": string, "details": string}>,',
      '  "currentStepIndex": number,',
      '  "currentStepHelp": string',
      '}',
      '',
      `Mode: ${mode || 'auto'}`,
      `CurrentStepIndex: ${Number.isFinite(currentStepIndex) ? currentStepIndex : 0}`,
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

    return res.json(data);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
