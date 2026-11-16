# ADR-0061 — Budget iniziale della console a 720 kB (M21)

|                       |                                                                                                                                                                                                                                                                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stato**             | accettata (2026-11-16, decisione dell'owner); recepita in `Specifications.md` v1.7 (2026-11-16); implementata e rilasciata con la 1.7.2. Emenda [ADR-0020](0020-performance-details.md) (il limite iniziale della console)                                                                                                                                |
| **Recepito in**       | `Specifications.md` v1.7 (2026-11-16): §4.4 e Appendice C.4 (riga di ADR-0020)                                                                                                                                                                                                                                                                            |
| **Data**              | 2026-11-16                                                                                                                                                                                                                                                                                                                                                |
| **Riferimenti spec**  | §4.4 (budget di build della Web UI: «console iniziale ≤ 700 kB», `Specifications.md:1870`); Appendice C.4, riga di ADR-0020 (`:2001`); ADR-0020 (budget della Web UI, tabella «Console»: iniziale ≤ 700 kB, totale ≤ 1000 kB); ADR-0025; ADR-0029 (la console resta senza code splitting); `docs/web-ui.md` (tabella dei budget)                          |
| **Devia dallo spec?** | **sì, in un punto:** §4.4 dice «console iniziale ≤ 700 kB» (`Specifications.md:1870`) e la riga di ADR-0020 in C.4 lo riassume; con questo ADR il limite è 720 kB. **Emenda ADR-0020** nel solo limite iniziale della console. Da recepire nello spec v1.7 ([`spec-v1.7-proposta.md`](../spec-v1.7-proposta.md)). **Decisione dell'owner del 2026-11-16** |
| **Superfici**         | console (prova: `task web-budget`, dentro `task ci`, che misura gli import statici di `src/main.tsx` con `checkBudget` di `web/scripts/esbuild.mjs`) · workbench, desktop e WebAssembly invariati                                                                                                                                                         |

## Contesto

Con il lavoro di M21 la console pesa **701 kB** iniziali (e totali) contro un limite di 700: `task ci` fallisce solo su `web-budget`. Le aggiunte sono funzioni richieste dall'owner: la pagina pubblica «Sei uscito» e il logout completo (ADR-0058), il tooltip della percentuale rispetto alla quota, la gestione delle gemelle legacy nello ZIP dei vault privati (ADR-0059). Il margine prima di M21 era di pochi kB.

La console si compila **in un solo file, senza code splitting** (`splitting: false` in `web/scripts/esbuild.mjs`, ADR-0029, `docs/web-ui.md`): il suo `<script>` è coperto da SRI, mentre i chunk caricati da un import dinamico non lo sarebbero senza un'import map. Per questo un `React.lazy` non riduce nulla: esbuild riporta il codice nel file principale (una prova sulla pagina «Sei uscito» ha dato 703 kB). La parte più grande evitabile è l'export dei vault privati (circa 50 kB: `hash-wasm` per Argon2id, `packages/vaultcrypto-web`, `src/export/privateExport.ts`), che servirebbe solo all'apertura del suo dialog.

## Decisione

`BUDGET.console.initialKB` passa da **700 a 720 kB** in `web/scripts/esbuild.mjs`. Il totale (1000 kB), il budget del workbench e quelli del WebAssembly non cambiano. La console resta un file unico coperto da SRI.

## Alternative considerate

- **Togliere 2–3 kB dalle aggiunte di M21** — scartata: il margine resterebbe quasi zero e il prossimo rilascio avrebbe lo stesso problema, senza un guadagno per l'utente.
- **Code splitting della console con import map SRI** (come il workbench: `importMap: true` nella pagina, CSP di `services/cloud/web-embed/webembed.go` con gli hash dell'import map, test di sicurezza e ADR-0029 da aggiornare), che sposterebbe l'export privato in un chunk caricato all'apertura del dialog e libererebbe circa 50 kB — scartata per la 1.7.2: tocca la CSP e la catena SRI, quindi va decisa e verificata a parte. È la strada da prendere se la console cresce ancora.

## Conseguenze

- `task ci` torna verde con 701 kB su 720.
- Il budget iniziale della console non è più lo stesso del desktop (ADR-0025, 700 kB): i due numeri restano indipendenti.
- Allineati con l'accettazione: ADR-0020 (revisione del 2026-11-16, che rinvia a questo ADR) e la tabella dei budget di [`docs/web-ui.md`](../web-ui.md) (iniziale ≤ 720 kB). Lo spec cita il limite in §4.4: la v1.7 lo porta a 720 kB.
