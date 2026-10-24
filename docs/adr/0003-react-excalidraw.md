# ADR-0003 — React 19 e strategia per Excalidraw (SPIKE-03)

|                       |                                                                  |
| --------------------- | ---------------------------------------------------------------- |
| **Stato**             | accettata (verifica asset offline nel webview rinviata a M3-WP1) |
| **Data**              | 2026-10-23                                                       |
| **Riferimenti spec**  | §2.7.3, V-04                                                     |
| **Devia dallo spec?** | no                                                               |

## Contesto

Lo spec chiede di verificare la compatibilità tra Excalidraw e la major di React prima di fissare il lockfile.

## Decisione

- **React 19.3** (`react`, `react-dom`); `@excalidraw/excalidraw` 0.18.1 dichiara `peerDependencies: react ^17.0.2 || ^18.2.0 || ^19.0.0` (verificato con `npm view`).
- Vite 8, TypeScript 5.9 (non la 7.x: ecosistema ESLint/tooling non ancora allineato), Vitest 5, ESLint 10 con `typescript-eslint` 8.
- Excalidraw sarà caricato lazy (`React.lazy`) in M3 con `window.EXCALIDRAW_ASSET_PATH` puntato agli asset copiati nel bundle; il test "zero richieste di rete" è un gate di M3-WP4.

## Alternative considerate

- **React 18.3** — valida, ma non necessaria: nessuna dipendenza attuale richiede la 18.
- **TypeScript 7 (compilatore nativo)** — rinviata finché `typescript-eslint` e Vite non la supportano ufficialmente.

## Conseguenze

Le versioni sono fissate dal `yarn.lock`; eventuali aggiornamenti major passano da un ADR.
