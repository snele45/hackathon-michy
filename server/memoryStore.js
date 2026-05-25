import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function clampNumber(x, lo, hi) {
  if (!Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

function l2Norm(vec) {
  let sum = 0;
  for (const v of vec) sum += v * v;
  return Math.sqrt(sum) || 1;
}

function normalizeVector(vec) {
  const n = l2Norm(vec);
  return vec.map((v) => v / n);
}

function dot(a, b) {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i += 1) s += a[i] * b[i];
  return s;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeUrl(u) {
  if (!u || typeof u !== 'string') return null;
  try {
    const url = new URL(u);
    url.hash = '';
    // Keep query because it can encode app state, but cap later.
    return url.toString();
  } catch {
    return u.slice(0, 400);
  }
}

function pickHost(u) {
  if (!u || typeof u !== 'string') return null;
  try {
    return new URL(u).host;
  } catch {
    return null;
  }
}

export class MemoryStore {
  constructor({ filePath, maxDocs }) {
    this.filePath = filePath;
    this.maxDocs = maxDocs;
    this._saveChain = Promise.resolve();
    this.data = {
      version: 1,
      updatedAt: nowIso(),
      graph: {
        pages: {},
        actions: {},
        edges: []
      },
      vector: {
        docs: {},
        order: []
      }
    };
  }

  static async load({ filePath, maxDocs = 250 }) {
    const store = new MemoryStore({ filePath, maxDocs });
    try {
      const text = await readFile(filePath, 'utf8');
      const parsed = safeJsonParse(text, null);
      if (parsed && typeof parsed === 'object') {
        store.data = parsed;
        if (!store.data.graph) store.data.graph = { pages: {}, actions: {}, edges: [] };
        if (!store.data.vector) store.data.vector = { docs: {}, order: [] };
        if (!store.data.vector.docs) store.data.vector.docs = {};
        if (!Array.isArray(store.data.vector.order)) store.data.vector.order = [];
        store.data.updatedAt = nowIso();
      }
    } catch {
      // new store
    }
    return store;
  }

  async save() {
    // Serialize saves to avoid overlapping writes from concurrent requests.
    this._saveChain = this._saveChain.then(async () => {
      this.data.updatedAt = nowIso();

      // Ensure the directory exists (important on fresh deployments / mounted volumes).
      const dir = dirname(this.filePath);
      await mkdir(dir, { recursive: true });

      // Atomic write to reduce risk of corrupted JSON.
      const tmp = `${this.filePath}.tmp`;
      const payload = JSON.stringify(this.data, null, 2);
      await writeFile(tmp, payload, 'utf8');
      await rename(tmp, this.filePath);
    });

    return this._saveChain;
  }

  // ---- Knowledge graph ----
  updateGraphFromContext({ url, title, uiActions, navGraph, recentEvents }) {
    const urlNorm = normalizeUrl(url);
    const host = pickHost(urlNorm);

    if (urlNorm) {
      this.data.graph.pages[urlNorm] = {
        url: urlNorm,
        host,
        title: typeof title === 'string' ? title.slice(0, 180) : null,
        lastSeenAt: nowIso()
      };
    }

    for (const a of Array.isArray(uiActions) ? uiActions : []) {
      const actionId = typeof a?.actionId === 'string' ? a.actionId.slice(0, 40) : null;
      if (!actionId) continue;
      this.data.graph.actions[actionId] = {
        actionId,
        label: typeof a?.label === 'string' ? a.label.slice(0, 120) : null,
        semanticType: typeof a?.semanticType === 'string' ? a.semanticType.slice(0, 40) : null,
        area: a?.area || null,
        lastSeenAt: nowIso()
      };
    }

    const edges = [];
    for (const e of Array.isArray(navGraph) ? navGraph : []) {
      const to = normalizeUrl(e?.to);
      const from = normalizeUrl(e?.from);
      const label = typeof e?.label === 'string' ? e.label.slice(0, 120) : null;
      if (from && to) {
        edges.push({ kind: 'navGraph', from, to, label, at: nowIso() });
      }
    }

    for (const ev of Array.isArray(recentEvents) ? recentEvents : []) {
      const before = normalizeUrl(ev?.urlBefore);
      const after = normalizeUrl(ev?.urlAfter);
      const label = typeof ev?.label === 'string' ? ev.label.slice(0, 120) : null;
      if (before && after && before !== after) {
        edges.push({ kind: 'recentEvent', from: before, to: after, label, at: nowIso() });
      }
    }

    // Keep last N edges.
    const merged = [...(Array.isArray(this.data.graph.edges) ? this.data.graph.edges : []), ...edges];
    this.data.graph.edges = merged.slice(-400);

    // no await save here; caller decides
  }

  getGraphNeighborhood({ url, maxEdges = 18 }) {
    const urlNorm = normalizeUrl(url);
    if (!urlNorm) return { url: null, edgesOut: [], edgesIn: [] };

    const all = Array.isArray(this.data.graph.edges) ? this.data.graph.edges : [];
    const edgesOut = all.filter((e) => e?.from === urlNorm).slice(-maxEdges);
    const edgesIn = all.filter((e) => e?.to === urlNorm).slice(-Math.floor(maxEdges / 2));

    // Compact for prompt
    return {
      url: urlNorm,
      edgesOut: edgesOut.map((e) => ({ kind: e.kind, label: e.label || null, to: e.to })),
      edgesIn: edgesIn.map((e) => ({ kind: e.kind, label: e.label || null, from: e.from }))
    };
  }

  // ---- Vector store ----
  async upsertDocuments({ client, embeddingModel, documents }) {
    const docs = Array.isArray(documents) ? documents : [];
    const newDocs = [];

    for (const d of docs) {
      const id = typeof d?.id === 'string' ? d.id : null;
      const text = typeof d?.text === 'string' ? d.text : null;
      if (!id || !text) continue;
      if (this.data.vector.docs[id]) continue;
      newDocs.push({ id, text: text.slice(0, 800), meta: d?.meta || null });
    }

    if (!newDocs.length) return { inserted: 0 };

    // Batch embeddings.
    const batchSize = 24;
    let inserted = 0;
    for (let i = 0; i < newDocs.length; i += batchSize) {
      const batch = newDocs.slice(i, i + batchSize);
      const inputs = batch.map((d) => d.text);

      const emb = await client.embeddings.create({
        model: embeddingModel,
        input: inputs
      });

      const vectors = Array.isArray(emb?.data) ? emb.data : [];
      for (let j = 0; j < batch.length; j += 1) {
        const v = vectors[j]?.embedding;
        if (!Array.isArray(v)) continue;
        const unit = normalizeVector(v);
        const doc = batch[j];
        this.data.vector.docs[doc.id] = {
          id: doc.id,
          text: doc.text,
          meta: doc.meta || null,
          host: pickHost(doc?.meta?.url || null),
          createdAt: nowIso(),
          embedding: unit
        };
        this.data.vector.order.push(doc.id);
        inserted += 1;
      }
    }

    // Evict old docs.
    const order = Array.isArray(this.data.vector.order) ? this.data.vector.order : [];
    const maxDocs = clampNumber(this.maxDocs, 50, 2000);
    if (order.length > maxDocs) {
      const toRemove = order.slice(0, order.length - maxDocs);
      this.data.vector.order = order.slice(-maxDocs);
      for (const id of toRemove) delete this.data.vector.docs[id];
    }

    return { inserted };
  }

  async querySimilar({ client, embeddingModel, queryText, hostHint, sessionKey, topK = 6 }) {
    const q = (queryText || '').toString().trim();
    if (!q) return [];

    const emb = await client.embeddings.create({
      model: embeddingModel,
      input: [q]
    });

    const vec = emb?.data?.[0]?.embedding;
    if (!Array.isArray(vec)) return [];
    const qv = normalizeVector(vec);

    const docs = this.data.vector.docs || {};
    const ids = Array.isArray(this.data.vector.order) ? this.data.vector.order : Object.keys(docs);

    const scored = [];
    for (const id of ids) {
      const d = docs[id];
      if (!d?.embedding) continue;
      if (hostHint && d.host && d.host !== hostHint) continue;
      if (sessionKey && d?.meta?.sessionKey && d.meta.sessionKey !== sessionKey) continue;
      if (sessionKey && !d?.meta?.sessionKey) continue;
      const score = dot(qv, d.embedding);
      scored.push({ id, score, text: d.text, meta: d.meta || null });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, clampNumber(topK, 1, 20)).map((x) => ({
      id: x.id,
      score: Math.round(x.score * 1000) / 1000,
      text: x.text,
      meta: x.meta
    }));
  }

  clearVectorForSession(sessionKey) {
    const key = (sessionKey || '').toString().trim();
    if (!key) return { removed: 0 };

    const docs = this.data.vector?.docs || {};
    let removed = 0;
    for (const id of Object.keys(docs)) {
      const d = docs[id];
      if (d?.meta?.sessionKey === key) {
        delete docs[id];
        removed += 1;
      }
    }

    const order = Array.isArray(this.data.vector?.order) ? this.data.vector.order : [];
    this.data.vector.order = order.filter((id) => Boolean(docs[id]));
    return { removed };
  }
}

export function buildMemoryDocuments({ goal, url, uiActions, previousStep, returnedStep, sessionKey }) {
  const docs = [];
  const urlNorm = normalizeUrl(url);
  const host = pickHost(urlNorm);
  const sk = typeof sessionKey === 'string' && sessionKey.trim() ? sessionKey.trim().slice(0, 260) : null;

  const goalText = typeof goal === 'string' ? goal.slice(0, 200) : '';

  // Action candidates (semantic extraction output)
  for (const a of Array.isArray(uiActions) ? uiActions.slice(0, 18) : []) {
    const actionId = typeof a?.actionId === 'string' ? a.actionId.slice(0, 40) : null;
    const label = typeof a?.label === 'string' ? a.label.slice(0, 120) : null;
    if (!actionId || !label) continue;

    const id = `action:${sk || host || 'unknown'}:${actionId}`;
    const text = [
      `Goal: ${goalText}`,
      `URL: ${urlNorm || ''}`,
      `ActionLabel: ${label}`,
      `SemanticType: ${a?.semanticType || ''}`,
      `Area: ${a?.area || ''}`
    ].join('\n');

    docs.push({
      id,
      text,
      meta: {
        type: 'uiAction',
        url: urlNorm,
        host,
        sessionKey: sk,
        actionId,
        actionLabel: label,
        semanticType: a?.semanticType || null,
        area: a?.area || null
      }
    });
  }

  // Previous/returned steps as "workflow memory"
  const stepPairs = [
    previousStep ? { kind: 'previousStep', step: previousStep } : null,
    returnedStep ? { kind: 'returnedStep', step: returnedStep } : null
  ].filter(Boolean);

  for (const sp of stepPairs) {
    const step = sp.step || {};
    const label = typeof step?.actionLabel === 'string' ? step.actionLabel.slice(0, 120) : '';
    const actionId = typeof step?.actionId === 'string' ? step.actionId.slice(0, 40) : '';
    const id = `step:${sk || host || 'unknown'}:${sp.kind}:${actionId || label || nowIso()}`;

    const text = [
      `Goal: ${goalText}`,
      `URL: ${urlNorm || ''}`,
      `StepKind: ${sp.kind}`,
      `StepTitle: ${(step?.title || '').toString().slice(0, 120)}`,
      `ActionLabel: ${label}`,
      `ActionId: ${actionId}`,
      `Details: ${(step?.details || '').toString().slice(0, 260)}`
    ].join('\n');

    docs.push({
      id,
      text,
      meta: {
        type: sp.kind,
        url: urlNorm,
        host,
        sessionKey: sk,
        actionId: actionId || null,
        actionLabel: label || null,
        title: typeof step?.title === 'string' ? step.title.slice(0, 120) : null
      }
    });
  }

  return docs;
}

export function defaultMemoryFilePath() {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, 'data', 'memory.json');
}
