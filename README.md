# Onboarding Buddy (Chrome Extension + AI Proxy)

This repo contains:
- `extension/`: Chrome Extension (Manifest V3) with a Side Panel UI.
- `server/`: Node.js/Express proxy that calls OpenAI API (keeps API key off the client).

## 1) Run the server

Prereq: Node.js 18+.

From repo root you can also use:

```powershell
npm run server:install
npm run server:dev
```

```powershell
cd server
npm install
npm run dev
```

Create `server/.env` from the example:

```ini
OPENAI_API_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=YOUR_KEY_HERE
OPENAI_MODEL=gpt-4.1-mini
PORT=8787
```

Server runs at `http://localhost:8787`.

VS Code: you can run the task **Server: dev**.

## 2) Load the extension in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `extension/` folder

## 3) Use it

- Open your target web app.
- Open the extension Side Panel (click the extension icon).
- Click **Capture page context** to pull URL/title/selected text + basic theme.
- Enter a goal (what you want to do) and click **Explain next step**.

## Notes / Security

- The OpenAI key must stay in `server/.env` (never in the extension).
- Don't paste API keys into chat or commit them; rotate the key if it was exposed.
- For a tighter security posture, restrict `extension/manifest.json` `host_permissions` and `content_scripts.matches` to only your app domains.
