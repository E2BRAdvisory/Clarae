# ADR-0025 — Build e dev server del frontend desktop con esbuild al posto di Vite

|                       |                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| **Stato**             | proposta                                                                                       |
| **Data**              | 2026-10-28                                                                                     |
| **Riferimenti spec**  | §2.7 (Excalidraw offline); ADR-0003 (stack), ADR-0005 (CSP), ADR-0010 (asset di Excalidraw)    |
| **Devia dallo spec?** | sì, in modo puntuale: il bundler di `apps/desktop/frontend` (lo spec e ADR-0003 indicano Vite) |

## Contesto

Il frontend desktop era costruito e servito in sviluppo da Vite (con `@vitejs/plugin-react`). Si è chiesto di sostituirlo con esbuild. `web/` e i pacchetti condivisi restano su Vite: la modifica riguarda solo `apps/desktop/frontend`.

## Decisione

1. `scripts/esbuild.mjs` sostituisce `vite` e `vite build`: `build` produce `dist/` (ESM con code splitting, minificato, sourcemap collegate, nomi con hash); `dev` ricostruisce a ogni modifica, serve `dist/` su `127.0.0.1:5173` (porta configurabile) e ricarica la pagina via `EventSource('/esbuild')`. Niente HMR: la pagina si ricarica per intero.
2. Ciò che Vite faceva implicitamente è esplicito nello script: `index.html` generato con bundle e CSS hashati, copia dei font di Excalidraw in `dist/excalidraw-assets/` (anche in dev, quindi senza middleware), import `?url` (worker di pdf.js) tramite un plugin, worker del grafo come bundle a parte in `dist/assets/layout.worker.js` (URL fisso, usato da `graph/layoutHost.ts`), `process.env.NODE_ENV` e `import.meta.env.MEMOBRAIN_E2E` definiti in build (prima `VITE_E2E`).
3. Wails non riconosce più il dev server da sé: `frontend:dev:serverUrl` è `http://localhost:5173` invece di `auto`.
4. Vitest resta (dipende da Vite, che quindi rimane come dipendenza transitiva solo dei test): `vitest.config.ts` sostituisce `vite.config.ts` e non usa più il plugin React. `src/env.d.ts` sostituisce `vite/client`.
5. Nuova dipendenza di sviluppo: `esbuild@0.28.2` (pubblicata il 2026-08-08).
6. Le importazioni dinamiche di moduli CommonJS con code splitting danno solo `default`: MathJax (`drawing/latex/tex2svg.ts`) le legge da lì quando i nomi mancano.

## Conseguenze

- Build più semplice e veloce; nessun HMR in sviluppo (reload completo, stato dell'app perso a ogni modifica).
- Lo script è codice nostro da mantenere; la CSP non cambia (il reload in sviluppo usa un file `dev-reload.js`, non script inline).
- ADR-0003 (Vite 8), ADR-0005 (dev server Vite) e ADR-0010 (plugin Vite per gli asset) restano come storia: per il desktop valgono le decisioni qui sopra. Aggiornare lo spec è a cura dell'owner.
