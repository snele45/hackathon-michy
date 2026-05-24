# Tandem — Brandbook (Current Product)

Ovaj dokument opisuje **kako Tandem trenutno izgleda i radi**, i služi kao vodič za **fine-tuning** (šta menjati, gde, i šta ne smemo da pokvarimo).

## 1) Produkt u jednoj rečenici

**Tandem** je side-panel asistent za web aplikacije koji, na osnovu **svežeg DOM snapshot-a + screenshot-a**, vraća **tačno jedan sledeći korak** i **naglašava** (highlight) element koji korisnik treba da klikne/selektuje/popuni.

## 2) Produktni principi (non‑negotiables)

1. **Single-step UX**: u svakom trenutku postoji samo **jedan aktivan korak**.
2. **Ground truth je browser**: svaki refresh uzima novi snapshot (DOM + recent events + screenshot).
3. **Kratko i operativno**: `steps[0].details` je strogo ≤ **400 karaktera** (server enforcement, bez lokalnog sečenja).
4. **Determinističko targetovanje**: gde god može, koristi se `actionId` da highlight bude 1:1.
5. **Vidljiv highlight**: highlight mora biti “ne možeš da promašiš” (crveno + dimming/spotlight) i mora da pobedi stacking context.

## 3) Ton i stil komunikacije (Tone of Voice)

- **Direktno i proceduralno**: “Klikni…”, “Izaberi…”, “U polju X upiši…”.
- **Bez pitanja**: model ne postavlja clarifying pitanja (fallback umesto toga).
- **Uvek sadrži ‘success check’**: jedna kratka rečenica kako izgleda uspeh + jedan fallback ako UI nije isti.
- **Bez viška teksta**: sve bitno je u `steps[0].details` (≤ 400), `currentStepHelp` minimalan.

## 4) Vizuelni identitet (Side Panel UI)

### 4.0 Color system (Tandem)

- Navy `#0F2153`
- Blue `#1B5EBF`
- Blue Mid `#2B7DD4`
- Blue Light `#5BA8F0`
- Teal `#0E6B5A`
- Teal Mid `#1A9A7C`
- Teal Light `#3DBFA0`
- Danger `#C13030`

CSS var mapping (u [extension/sidepanel.css](extension/sidepanel.css)):

- `--ui-bg`: `#F7F9FC`
- `--ui-card`: `#FFFFFF`
- `--ui-fg`: `#0F2153`
- `--ui-muted`: `#5A6A85`
- `--ui-border`: `rgba(27,94,191,0.14)`
- `--ui-accent`: `#1B5EBF`
- `--ui-accent-2`: `#1A9A7C`
- `--ui-accent-bg`: `rgba(27,94,191,0.07)`
- `--ui-danger`: `#C13030`
- `--ui-font`: `'DM Sans', system-ui, sans-serif`

Typography:

- H1: 20px ("Session Goal")
- H2: 14px ("Guidance")

### 4.1 Layout
Side panel je minimalistički “tooling UI”: header + dve kartice.

- Header: naziv proizvoda + trenutna stranica (title) + status line
- Card 1: session controls + input za Goal + meta + debug context preview
- Card 2: Guidance (summary) + Steps (lista, iako UX radi single-step, lista služi kao istorija/trace)

Referentni fajlovi:
- [extension/sidepanel.html](extension/sidepanel.html)
- [extension/sidepanel.css](extension/sidepanel.css)
- [extension/sidepanel.js](extension/sidepanel.js)

### 4.2 Design tokens (CSS var)
U [extension/sidepanel.css](extension/sidepanel.css) trenutno koristimo sledeće tokene (ovo je glavno mesto za “brand” finetune):

- `--ui-bg`: pozadina panela
- `--ui-card`: kartice
- `--ui-fg`: primarni tekst
- `--ui-muted`: sekundarni tekst
- `--ui-border`: border
- `--ui-accent`, `--ui-accent-2`: primarni CTA
- `--ui-accent-bg`: blagi highlight background
- `--ui-danger`: danger akcije
- `--ui-font`: font stack (po default-u system)

**Pravilo:** menjaj kroz varijable, ne kroz hard-coded vrednosti u komponentama.

### 4.3 Komponente (UI elementi)

- **Buttons**: `.btn` (default), `.btn.primary` (glavni), `.btn.danger` (destruktivno)
- **Input**: `.input` sa fokus ringom
- **Cards**: `.card`
- **Steps list**: `.steps li` i `.steps li.active`
- **Action preview pill**: `.actionPreview` (klik za highlight), i `.hintPill`

## 5) Interaction model (Kako korisnik “vozi” produkt)

### 5.1 Glavni flow

1. Korisnik upiše Goal u side panel-u.
2. Klikne **Explain**.
3. Side panel radi `CAPTURE_CONTEXT` (snapshot + screenshot).
4. Side panel šalje payload na server `POST /api/explain`.
5. Server vrati 1 step; UI ga prikaže i omogućava “preview highlight”.

### 5.2 Auto-refresh posle interakcija na stranici

- `contentScript` emituje `PAGE_EVENT` za:
  - `click`
  - `change` na `select/checkbox/radio`
- `sidepanel` na `PAGE_EVENT` radi:
  - novi snapshot + screenshot
  - novi `/api/explain` (step mode)

Relevantno:
- [extension/contentScript.js](extension/contentScript.js)
- [extension/service-worker.js](extension/service-worker.js)
- [extension/sidepanel.js](extension/sidepanel.js)

### 5.3 “Session end” semantika

- “Završi sesiju” čisti **samo session-scoped vektor memoriju**, ne briše KG “stablo”.
- Endpoint: `POST /api/session/end`.

Relevantno:
- [server/index.js](server/index.js)
- [server/memoryStore.js](server/memoryStore.js)

## 6) Highlight sistem (na samoj stranici)

### 6.1 Cilj
Highlight mora da bude:
- maksimalno vidljiv
- stabilan čak i u prisustvu `z-index`, `transform`, `position` i drugih stacking context-ova

### 6.2 Trenutna implementacija

U [extension/contentScript.js](extension/contentScript.js) `highlightElement()`:

- crta **top-level fixed overlay** (dimming + crveni ring) sa `z-index: 2147483647`
- kao fallback na target element stavlja `outline/background` sa `!important` + visokim `z-index`

**Finetune knobs:**
- boja ring-a, dim opacity, debljina bordera, radius
- trajanje highlight-a (timeout)

## 7) Determinističko targetovanje (Action IDs)

### 7.1 Standardno
- `actionId` se računa heuristički iz (tag, kind, label, attrs, domPath…). Ovo radi dobro za “normalne” UI elemente.

### 7.2 Demo/QA override (ručno injektovan atribut)
Za SVG tile / element bez teksta, podržano je ručno targetovanje:

- `data-ob-action-id="fan"`  → actionId postaje `ob_fan`
- `data-ob-label="Fan"`      → label postaje `Fan`

Ovo omogućava da prompt “turn fan on” pouzdano navede model na taj element i highlight bude 1:1.

Relevantno:
- [extension/contentScript.js](extension/contentScript.js)

## 8) Corner indicator (Injected UI)

Tandem injektuje mali indikator u **donji desni ugao** stranice:

- Text: `Tandem · active`
- Klik: otvara side panel
- Ikonica: koristi favicon iz extension asset-a

Relevantno:
- [extension/contentScript.js](extension/contentScript.js)
- [extension/service-worker.js](extension/service-worker.js)

### 8.1 Gde staviti favicon/logo fajlove

Pošto injektovani UI živi u kontekstu stranice, asset mora biti dostupan kao `web_accessible_resource`.

Stavi fajlove ovde:

- [extension/assets/](extension/assets/)
  - `tandem-favicon-32.png` (koristi se u corner indikatoru i u header-u sidepanel-a)
  - (opciono) `tandem-logo.png` ako želiš veći logo za panel/header

Napomena: ako fajl ne postoji, UI će raditi i bez ikonice (ikonica će se samo sakriti).

## 9) AI output contract (server enforcement)

Server u [server/index.js](server/index.js) enforce-uje:

- JSON only
- `steps.length === 1`
- `currentStepIndex === 0`
- `steps[0].details.length <= 400` (rewrite-retry ako pređe)
- “no clarifying questions”

**Finetune knobs:**
- prompt pravila (tekst u `prompt` nizu)
- temperature / max tokens
- retry uslovi (repeat step, details over limit)

## 10) Observability (Logovi)

Server loguje JSON linije (stdout) koje omogućavaju rekonstrukciju toka:

- `explain_request` (reqId, sessionKey, mode/reason, url, lastEvent)
- `openai_call` (ms + withImage)
- `details_over_limit_retry`
- `explain_response` (msTotal + actionId/actionLabel)
- `session_end` (removed docs)

Relevantno:
- [server/index.js](server/index.js)

## 11) Fine-tuning mapa (Šta menjati gde)

### 10.1 Ako želiš drugačiji “brand” UI
- Tokene i komponente: [extension/sidepanel.css](extension/sidepanel.css)
- Layout/labels: [extension/sidepanel.html](extension/sidepanel.html)

### 10.2 Ako želiš drugačije ponašanje “auto refresh”
- Event de-dupe, cadence, šta triggeruje explain: [extension/sidepanel.js](extension/sidepanel.js)
- Koji eventi se emituju sa stranice: [extension/contentScript.js](extension/contentScript.js)

### 10.3 Ako želiš strožiji/opušteniji AI output
- Prompt + enforcement: [server/index.js](server/index.js)

### 10.4 Ako želiš promeniti “šta je memorija”
- Session scoping + vector/KG: [server/memoryStore.js](server/memoryStore.js)

## 12) Checklist (pre demo / pre release)

- [ ] Highlight uvek iznad svega (test na stranicama sa modals/sidebars)
- [ ] “turn fan on” vraća step sa `actionId = ob_fan`
- [ ] `details` nikad preko 400 karaktera
- [ ] Posle `click/change` automatski ide refresh (snapshot + screenshot + explain)
- [ ] `/api/session/end` čisti samo session vector docs, graph ostaje

---

Ako želiš, mogu da napravim i “v2” ovog brandbook-a kao kraći 1‑pager (za pitch/demonstraciju) + poseban “tuning matrix” (šta menja UX vs tačnost vs brzinu).
