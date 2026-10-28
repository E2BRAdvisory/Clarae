# ADR-0025 — Build e dev server del frontend desktop con esbuild al posto di Vite

|                       |                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| **Stato**             | accettata                                                                                               |
| **Data**              | 2026-10-28                                                                                              |
| **Riferimenti spec**  | §2.7 (Excalidraw offline); ADR-0003 (stack), ADR-0005 (CSP), ADR-0010 (asset di Excalidraw)             |
| **Devia dallo spec?** | sì, in modo puntuale: il bundler di `apps/desktop/frontend` e `web/` (lo spec e ADR-0003 indicano Vite) |

## Contesto

Il frontend desktop era costruito e servito in sviluppo da Vite (con `@vitejs/plugin-react`). Si è chiesto di sostituirlo con esbuild. La stessa sostituzione è stata estesa a `web/` (Web UI incorporata nel binario cloud, vedi «Estensione a `web/`»); i pacchetti condivisi non hanno build proprie.

## Decisione

1. `scripts/esbuild.mjs` sostituisce `vite` e `vite build`: `build` produce `dist/` (ESM con code splitting, minificato, sourcemap collegate, nomi con hash); `dev` ricostruisce a ogni modifica, serve `dist/` su `127.0.0.1:5173` (porta configurabile) con un piccolo server HTTP proprio (quello di esbuild rifiuta l'header `Host: wails.localhost` con cui Wails fa da proxy) e ricarica la pagina via `EventSource('/esbuild')`. Niente HMR: la pagina si ricarica per intero.
2. Ciò che Vite faceva implicitamente è esplicito nello script: `index.html` generato con bundle e CSS hashati, copia dei font di Excalidraw in `dist/excalidraw-assets/` (anche in dev, quindi senza middleware), import `?url` (worker di pdf.js) tramite un plugin, worker del grafo come bundle a parte in `dist/assets/layout.worker.js` (URL fisso, usato da `graph/layoutHost.ts`), `process.env.NODE_ENV` e `import.meta.env.MEMOBRAIN_E2E` definiti in build (prima `VITE_E2E`).
3. Wails non riconosce più il dev server da sé: `frontend:dev:serverUrl` è `http://127.0.0.1:5173` invece di `auto`.
4. Vitest resta (dipende da Vite, che quindi rimane come dipendenza transitiva solo dei test): `vitest.config.ts` sostituisce `vite.config.ts` e non usa più il plugin React. `src/env.d.ts` sostituisce `vite/client`.
5. Nuova dipendenza di sviluppo: `esbuild@0.28.2` (pubblicata il 2026-08-08).
6. **Release.** In produzione non si emettono source map (`dist/` è incorporato nel binario con `go:embed`). `build` verifica un budget (`BUDGET` in `esbuild.mjs`): 2000 kB per ciò che si carica all'avvio (entry e import statici, minificati) e 23000 kB per tutto l'output senza i font di Excalidraw copiati; misure attuali 1880 e 21206 kB. Si alza un limite solo di proposito. `katex` è unico per tutta l'app (alias sulla copia radice, prima c'erano quattro copie); `mermaid` resta in tre versioni (10.9.3 del convertitore, 11.x di Excalidraw, 12.2 diretta), da rivalutare con la questione aperta di ADR-0024.
7. **Gate sul bundle di produzione.** `node scripts/esbuild.mjs preview` costruisce il bundle di produzione in `node_modules/.preview/` e lo serve; `yarn e2e:prod` (`make e2e-desktop-prod`, incluso in `make e2e`) esegue su di esso gli spec di disegni, grafo e canvas, così problemi di chunk, interop CommonJS o CSP emergono prima del rilascio.
8. Le importazioni dinamiche di moduli CommonJS con code splitting danno solo `default`: MathJax (`drawing/latex/tex2svg.ts`) le legge da lì quando i nomi mancano.

## Conseguenze

- Build più semplice e veloce; nessun HMR in sviluppo (reload completo, stato dell'app perso a ogni modifica).
- Lo script è codice nostro da mantenere; la CSP non cambia (il reload in sviluppo usa un file `dev-reload.js`, non script inline).
- ADR-0003 (Vite 8), ADR-0005 (dev server Vite) e ADR-0010 (plugin Vite per gli asset) restano come storia: per il desktop valgono le decisioni qui sopra. Aggiornare lo spec è a cura dell'owner.

## Estensione a `web/`

`web/scripts/esbuild.mjs` sostituisce `vite`/`vite build`/`vite preview` e `web/vite-plugin-sri.ts`:

- `build` produce `dist/` (ESM con splitting, minificato, **nessuna sourcemap**: `dist/` è incorporata con `go:embed`) e controlla il budget (ADR-0020: chunk iniziale ≤ 700 kB, totale ≤ 1000 kB; misurati 599/608 kB).
- L'SRI (`integrity` sha384 + `crossorigin`) è calcolata dal plugin `index-html` sui byte scritti in `dist/`; in dev non c'è. `index.html` non contiene script né stili inline (CSP del cloud).
- `dev [--port N]` serve `dist/` su `127.0.0.1:5174`, con fallback SPA a `index.html` per le rotte di react-router, proxy di `/api` verso il cloud (`MEMOBRAIN_API`, default `http://127.0.0.1:18081`) e live reload via `EventSource('/esbuild')`.
- `VITE_E2E` diventa `MEMOBRAIN_E2E` (`define`): il doppio OIDC resta fuori dai build di produzione (verificato con `grep -r memobrain.e2e web/dist`).
- Verifiche: tipi, 59 e2e Playwright sul dev server e `e2e:security` (CSP, SRI, nessuna richiesta cross-origin) sul build di produzione servito dall'handler incorporato.
