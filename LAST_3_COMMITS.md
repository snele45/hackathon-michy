# Zadnja 3 commita — šta je dodano

> Generisano: 2026-05-25
> 
> Napomena: `server/data/memory.json` ima ogroman diff; ovdje je sažetak na visokom nivou (bez kopiranja sadržaja).

---

## 8e176e6 (2026-05-24) — content fix

**Šta je dodano / poboljšano (extension UI):**
- **"Thinking" indikator u sidepanelu**: spinner + tekst (npr. “Thinking… / Capturing page context… / Refreshing guidance…”), i pomoćne funkcije `beginThinking/endThinking/withThinking`.
- **Zaključavanje UI-a dok je busy/thinking**: disable inputa/dugmadi (goal, explain, new session, preview dugmad, final Yes/No).
- **Preciznije ponašanje za “final step” kad klik samo otvori overlay/popup**: ako je overlay otvoren, a klik nije jedna od overlay opcija (npr. tek otvorio popup), odmah se osvježi guidance umjesto da se tretira kao završetak.
- **Target suggestion UX pojednostavljen**: prikazuje se **tačno jedna** sugestija (umjesto liste), i tekst hint-a mijenja se u “Click button to preview”.

**Šta je dodano / poboljšano (content script):**
- **Ignorisanje injected “corner” elementa** iz DOM inference-a: novi helper `isTandemCornerElement` i filteri u kolektorima/heuristikama.
- **Pouzdanije otvaranje sidepanela iz corner indikatora**: re-wire logika i dodatni `lastError` logging.
- **Bolji highlight za male targete** (tanje outline/ring vrijednosti i box-shadow), da ne “pregazi” sitne kontrole.

**Fajlovi:**
- `extension/sidepanel.js`
- `extension/sidepanel.html`
- `extension/sidepanel.css`
- `extension/contentScript.js`

**Stat:** 4 fajla promijenjena, ~256 insertions / 54 deletions.

---

## da8a138 (2026-05-24) — final version

**Šta je dodano / poboljšano (server):**
- **Playbooks (user-authored workflow notes)**:
  - Dodan loader za `server/data/playbooks.json`.
  - Dodan odabir relevantnih playbookova po **host-u**, **URL fragmentima** i **tokenima iz goal-a** (`selectRelevantPlaybooks`).
  - Relevantni playbookovi se ubacuju u prompt kao “authoritative workflow notes” da model prati tačan flow kad se poklopi.

**Šta je dodano (data):**
- Novi fajl `server/data/playbooks.json` sa demo playbookom za Inductive Automation water-treatment demo (Fan → popup → Run/Stop/Off/Auto) + jedan disabled primjer.

**Ostalo:**
- `server/data/memory.json` je značajno promijenjen (veliki update sadržaja).

**Fajlovi:**
- `server/index.js`
- `server/data/playbooks.json` (novo)
- `server/data/memory.json`

**Stat:** 3 fajla promijenjena, ~387195 insertions / 41841 deletions.

---

## 248ffcb (2026-05-24) — prompt tuned

**Šta je dodano / poboljšano (server prompt + normalizacija):**
- **Podrška za overlay/popup kontekst** u `Context`: `activeOverlays` i `overlayActions` (i preferiranje akcija unutar overlay-a u scoringu).
- **AllowedTargets lista**: server eksplicitno šalje modelu listu dozvoljenih meta (prioritet overlay akcije), i traži da se actionId/actionLabel bira iz nje (da UI highlighting bude determinističan).
- **isFinalStep polje** u response shemi (model može označiti da je korak “final”).
- **Post-processing/normalizacija odgovora**:
  - usklađuje `actionId`→`actionLabel` kad se poklapa sa UI kandidatom,
  - pokušava da mapira label koji se jedinstveno spominje u summary/details,
  - dropa actionLabel/actionId ako nisu u “allowed” setu.

**Šta je dodano / poboljšano (extension sidepanel):**
- **Final confirmation flow**: nakon “final step” klika, UI pita “Done / No” umjesto `confirm()` dijaloga.
- **End session & clear state**: `Done` završava sesiju (`/api/session/end`), čisti tab state i resetuje goal.
- **Bogati payload prema serveru**: slanje `screenshot` i trenutnih `steps` uz `goal/context/history`.
- **Pametniji “target suggestions”**: scoring labela prema tekstu (quoted phrases, ALL CAPS tokens, color hints + backgroundColor heuristika) i mapiranje label→actionId.

**Šta je dodano / poboljšano (content script / capture):**
- **Detekcija aktivnih overlay-a** (`dialog/menu/listbox/tree`) + ekstrakcija njihovih akcija (`overlayActions`).
- **UI/SVG signature heuristike** (`sig`, `svgSig`) za bolju detekciju promjene stanja nakon klika.
- **Bolji matching klikova kad je overlay otvoren** (preferira pretragu unutar overlay container-a).
- **Fallback highlight-by-actionId**: ako actionIndex ne nađe element, skenira clickable elemente i poredi `computeActionId`.

**Fajlovi:**
- `server/index.js`
- `extension/sidepanel.js`
- `extension/sidepanel.html`
- `extension/sidepanel.css`
- `extension/contentScript.js`
- `server/data/memory.json`

**Stat:** 6 fajlova promijenjena, ~42779 insertions / 343344 deletions.
