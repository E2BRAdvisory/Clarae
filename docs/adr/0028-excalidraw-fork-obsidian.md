# ADR-0028 — Excalidraw: fork del plugin Obsidian (lazo, secchiello, disegna per la forma)

|                       |                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------- |
| **Stato**             | accettata                                                                          |
| **Recepito in**       | `Specifications.md` v1.4 (2026-11-02): §2.7.3, §4.2, C.2 (Appendice C.4)           |
| **Data**              | 2026-10-29                                                                         |
| **Riferimenti spec**  | ADR-0003, ADR-0024 (limiti noti: Scribble Helper), ADR-0025 (build esbuild)        |
| **Devia dallo spec?** | sì: dipendenza `@zsviczian/excalidraw` al posto di `@excalidraw/excalidraw` 0.18.1 |

**Aggiornamento 2026-11-02.** La dipendenza sta ora in `packages/workbench/package.json` (frontend condiviso da desktop e workbench web, ADR-0029), con lo stesso alias `npm:@zsviczian/excalidraw@0.18.145`; la copia dello script è fatta da `copyExcalidrawAssets`, condivisa dalle build di desktop e web.

## Contesto

Il plugin Excalidraw di Obsidian offre _Disegna per la forma_ (Shift+X), _Secchiello riempimento_ (B) e _Selezione a lazo_. Excalidraw upstream 0.18.1 non li ha (nessun tool `lasso`, `bucketfill`, `autoshape`). Il plugin usa il fork `@zsviczian/excalidraw` (MIT), che li include.

## Decisione

- `apps/desktop/frontend/package.json`: `"@excalidraw/excalidraw": "npm:@zsviczian/excalidraw@0.18.145"` (alias npm: gli import restano invariati).
- Il dist/prod del fork non è autocontenuto; l'unica build completa è uno script classico (`dist/obsidian/excalidraw.production.min.js`) che legge `React`, `ReactDOM` e `ReactJSXRuntime` dai globali. `scripts/esbuild.mjs` (plugin `excalidraw-fork`) lo copia in `dist/excalidraw-assets/excalidraw.js`, lo carica con un tag `<script>` (stessa origine, compatibile con `script-src 'self'`, offline) e lo riesporta per nome (`scripts/excalidraw-exports.json`, da rigenerare se cambiano gli export del fork). Il CSS è quello della build `obsidian`.
- `drawing/ExcalidrawIsland.tsx` monta l'editor in una root React propria: il fork non regge il doppio mount di `<StrictMode>` in sviluppo.
- Adattamenti all'API del fork: `onExcalidrawAPI`, `setViewport` al posto di `scrollToContent`, binding delle frecce `{ elementId, fixedPoint, mode }` (`actions/factory.ts`), tipi mappati in `tsconfig.app.json`.
- Menu e comandi di Excalidraw al 90% (variabili CSS dei pulsanti/icone in `style.css`); rimosso il pulsante del menu principale.

## Alternative considerate

- **Implementazione custom su 0.18.1** — meno fedele al plugin, tre strumenti da mantenere.
- **Solo voci segnaposto** — non funzionanti.

## Conseguenze

- \+ Strumenti identici al plugin; Scribble Helper (ADR-0024) coperto da _Disegna per la forma_.
- − Script di 6,5 MB servito come asset (fuori dal budget del bundle); fork con release proprie, da pinnare e riverificare a ogni aggiornamento (e2e `drawing*`, merge fixture `excalidraw-*`).
- − Struttura DOM diversa (`.App-top-bar`, `.App-bottom-bar`): selettori CSS/e2e aggiornati.
