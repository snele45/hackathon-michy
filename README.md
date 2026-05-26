# Onboarding Buddy

Onboarding Buddy is a **Chrome Extension (MV3)** + **local Node/Express server** that provides **one next step at a time** (“click this / select that / type here”) based on the **current page state**.

The core idea: treat the browser as the ground truth. Every step is produced from a **fresh snapshot** (DOM + recent interactions + always a screenshot) so guidance stays aligned even when the UI is dynamic.

## Repo layout

- `extension/` — MV3 extension with Side Panel UI
	- `sidepanel.html/.js/.css` — the assistant UI
	- `service-worker.js` — background orchestration + screenshot capture
	- `contentScript.js` — DOM snapshot + element indexing + highlighting + interaction tracking
- `server/` — Node/Express proxy and memory layer
	- `index.js` — `/api/explain` + `/api/session/end`
	- `memoryStore.js` — persistent knowledge graph + vector store
	- `data/memory.json` — persisted memory store (graph + vector docs)

## UX design (what the user experiences)

**Single-step UI**
- The assistant always returns exactly **one next step** in `steps[0]`.
- The UI shows that step and highlights the target on the page.

**Hard limit: short, actionable guidance**
- `steps[0].details` is enforced to be **≤ 400 characters** (server-side). There is no local truncation; instead the server asks the model to rewrite shorter.

**Always screenshot**
- Every context capture requests a screenshot (`chrome.tabs.captureVisibleTab`) and sends it to `/api/explain` as a multimodal input.
- If a screenshot transiently fails, the side panel reuses the last screenshot for the same page key and marks it as `screenshotStale` in the context.

**Very visible highlight**
- Highlight uses a strong red outline + “spotlight/dim” overlay so it’s obvious even on complex pages.

## How it works (end-to-end)

### High-level pipeline

1. **User interaction on the page**
	 - `contentScript.js` emits `PAGE_EVENT` for:
		 - `click`
		 - `change` on `<select>`, `<input type="checkbox">`, `<input type="radio">`
2. **Side panel reacts**
	 - `sidepanel.js` receives the event and performs a “refresh”:
		 - capture a new snapshot + screenshot (`CAPTURE_CONTEXT`)
		 - call `/api/explain` to get a **new next step**
3. **Server builds context + retrieval**
	 - Normalizes the workflow state
	 - Updates persistent knowledge graph from the current page
	 - Stores/retrieves vector memory **scoped to this session** (details below)
4. **LLM returns one step**
	 - Server enforces JSON-only output and the 400-char details rule
5. **UI highlights deterministically**
	 - Prefer `actionId` to locate the exact element; fall back to label + hint-based disambiguation

### What the extension sends as “context”

The snapshot includes (best-effort):
- URL + title
- headings, nav groups, likely actions/fields, open menus, etc.
- `recentEvents` and `navGraph` (observed navigation edges)
- screenshot (data URL)

### Deterministic targeting (`actionId`)

When possible, the server returns `steps[0].actionId` that matches an element from `Context.uiActions[].actionId`.

`actionId` is a stable, non-cryptographic hash based on element features (tag/kind/label/href/important attrs + a short DOM path), which makes highlighting reliable even when there are multiple identical labels.

## Memory model (persistent vs session)

This project intentionally separates two kinds of memory:

### 1) Persistent “tree / KG” memory (kept across sessions)

- Stored in `server/data/memory.json` under the graph section.
- Used to keep a durable map of pages/actions/navigation edges (“stablo”).
- **Not deleted when a session ends.**

### 2) Session-scoped vector memory (cleared on session end)

- Vector docs are tagged with `meta.sessionKey`.
- Retrieval filters strictly to the current `sessionKey` so **older sessions won’t influence the current guidance**.
- Ending a session calls `/api/session/end` which removes only vector docs for that `sessionKey` (graph remains).

## Deployment notes (JSON memory store)

The memory layer is persisted to a local JSON file (`server/data/memory.json`) and is loaded into RAM on startup.

- You must deploy with a **persistent filesystem/volume** if you want memory to survive restarts/redeploys.
- Configure the path via `MEMORY_FILE_PATH` (otherwise the server uses `server/data/memory.json`).
- To disable memory entirely (no file IO, no embeddings/retrieval), set `MEMORY_DISABLED=1`.
- **Serverless deployments** (ephemeral filesystem) will lose memory on cold start/redeploy.
- **Multiple replicas** will each have their own local file, so memory will diverge unless you move it to shared storage (DB/object storage/redis/etc.).

## Server API

### `POST /api/explain`

Produces the next step from current context.

Key behaviors:
- Always returns JSON (best-effort; otherwise returns raw text as `currentStepHelp`)
- Enforces:
	- `steps.length === 1`
	- `currentStepIndex === 0`
	- `steps[0].details.length <= 400` via rewrite-retry

### `POST /api/session/end`

Clears only the **session-scoped vector docs** for the current session key.

### `POST /api/reset`

Backwards-compatible alias for session end (it no longer wipes the whole memory store).

## Server logging (debugging what happened and when)

The server prints JSON log lines to stdout for easy grepping.

Notable events:
- `explain_request` — includes `reqId`, `sessionKey`, `mode`, `reason`, `url`, `hasScreenshot`, and `lastEvent` (click/change)
- `openai_call` — includes duration `ms`, and whether the call used an image
- `details_over_limit_retry` — emitted when the model exceeded 400 chars and gets a rewrite request
- `explain_response` — includes total latency and the returned `actionId/actionLabel`
- `session_end` — includes how many session vector docs were removed

## Running locally

### 1) Start the server

Prereq: Node.js 18+ (Node 20 recommended).

From repo root:

```powershell
npm run server:install
npm run server:dev
```

Or from `server/`:

```powershell
cd server
npm install
npm run dev
```

Create `server/.env`:

```ini
OPENAI_API_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=YOUR_KEY_HERE
OPENAI_MODEL=gpt-4.1-mini
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
PORT=8787
```

Server: `http://localhost:8787`

VS Code: run task **Server: dev**.

### 2) Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `extension/` folder

### 3) Use it

1. Open your target web app
2. Open the extension Side Panel (extension icon)
3. Enter a goal and click **Explain**
4. As you click or change dropdowns/checkboxes on the page, the assistant auto-refreshes and proposes the next step

## Troubleshooting

**Port already in use (`EADDRINUSE:8787`)**
- Stop the other process using 8787 or change `PORT` in `server/.env`.

**No screenshot / restricted pages**
- Some pages (Chrome Web Store, internal pages) block scripting/screenshot capture.

**Too many refreshes**
- `click` + `change` on the same control can happen back-to-back; the side panel includes a small de-dupe window to avoid double refresh.

## Security & privacy notes

- The OpenAI key lives only in `server/.env` (never in the extension).
- Screenshots and DOM context may include sensitive data. Use only on pages you are allowed to capture and send to your local server.
- To tighten scope, restrict `extension/manifest.json` `host_permissions` / `content_scripts.matches` to your domains instead of `<all_urls>`.
