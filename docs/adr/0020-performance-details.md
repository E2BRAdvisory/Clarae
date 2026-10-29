# ADR-0020 — Prestazioni: indicizzazione a batch, cache dei candidati di ricerca, albero virtualizzato (M7-WP1)

|                       |                                                                             |
| --------------------- | --------------------------------------------------------------------------- |
| **Stato**             | proposta                                                                    |
| **Data**              | 2026-10-27                                                                  |
| **Riferimenti spec**  | Appendice A (prestazioni client, indicizzazione, cloud), §2.4 ricerca; D-06 |
| **Devia dallo spec?** | no                                                                          |

## Contesto

Su un vault sintetico da 50.000 note (168 MB, `apps/desktop/internal/perf`) il profilo CPU mostrava tre problemi: l'indicizzazione iniziale non finiva in tempo utile (un commit WAL per nota, flush di FTS5 a ogni statement, risoluzione dei link di tutto il vault a ogni salvataggio), la ricerca leggeva ogni corpo con una query separata (un lock di lettura WAL per file) e l'albero dei file montava un nodo DOM per ogni voce. Misure e metodo in `docs/perf/README.md`.

## Decisione

1. **Indexer** (`internal/indexer`): `Full` legge e analizza i file con un pool di worker e li scrive in transazioni da al massimo 250 note o 16 MB; statement preparati per transazione; le righe FTS di un batch si scrivono dopo tutte le altre tabelle (dopo la prima scrittura FTS5 ogni statement con foreign key provoca un flush del segmento). Un batch fallito si riprova nota per nota (una riga cattiva non perde le altre). `Update` risolve i link solo della nota modificata con un resolver in cache (`links.ResolvePaths`); la risoluzione completa resta quando cambia l'insieme dei file o degli alias.
2. **Ricerca** (`internal/search`): cache dei candidati per database (`cache.go`): elenco file, titolo, corpo e tag in memoria, ordinati per path, ricaricati in modo incrementale (impronta `count/max(indexed_at)/somma dimensioni` e confronto per riga `(id, indexed_at)`); valutazione parallela sui core con lo stesso `eval` di prima, quindi stessi risultati e stesso ordine. Budget di default 512 MB di testo (`DefaultCacheBudget`): oltre, si torna allo streaming da SQLite in una sola transazione di lettura (comunque molto più veloce del vecchio N+1). `Warm` carica la cache in background dopo il primo indice; `Forget` la libera alla chiusura del vault. `matchBody` taglia la riga dello snippet dal corpo invece di abbassare e provare ogni riga.
3. **Albero dei file**: righe di altezza fissa (24 px) e finestra di rendering (`flattenTree` + overscan); nessuna dipendenza nuova.
4. **Misura**: dataset deterministici (`internal/perf/dataset`), suite `TestPerf` (`make perf`), `perfcheck` contro baseline JSON in `docs/perf/`, workflow `nightly-perf.yml`, spec Playwright `ui-perf.spec.ts`, load test cloud (`TestServeLoadEnv` solo test + k6).

## Alternative considerate

- **Tabella FTS5 `contentless`/external content**: dimezzerebbe `index.db` (894 MB per 168 MB di note) ma richiede una migrazione dello schema e di ogni query che legge `fts_content`; rimandata.
- **Cache dei corpi in minuscolo**: elimina `ToLower` per query ma raddoppia la RAM; scartata finché la ricerca è sotto i 200 ms.
- **Libreria di virtualizzazione (`react-virtual`)**: non necessaria per una lista a righe fisse.
- **Segnale di invalidazione dall'indexer alla cache**: meno query ma accoppia i pacchetti; l'impronta costa pochi ms.

## Conseguenze

- La cache tiene in RAM circa il testo del vault (≈ 210 MB heap a 50k note); è il costo dichiarato della ricerca < 200 ms. Per vault oltre il budget la ricerca resta corretta ma più lenta.
- Le regex su tutto il vault (≈ 0,45 s a 50k) non rispettano i 200 ms: servirebbe un prefiltro con i letterali della regex.
- `index.db` è ≈ 5,3 volte il testo (trigram): da rivedere se la dimensione disco diventa un problema.
- Il test `TestQueryEquivalentToLegacy` conserva la strategia precedente come riferimento: eliminarlo solo se si rimuove la modalità streaming. Differenza nota: "nessun risultato" ora è `[]` e non `null`.

## Revisione 2026-10-29 — Budget del bundle Web UI con il workbench (M9-WP0, ADR-0029)

Il budget della Web UI (`BUDGET` in `web/scripts/esbuild.mjs`: iniziale ≤ 700 kB, totale ≤ 1000 kB, ADR-0025) valeva per un'app di sola console. Il workbench del vault (ADR-0029) porta nella Web UI tutto il frontend desktop (Excalidraw, mermaid, pdfjs, mathjax) e il core Go in WebAssembly (ADR-0030). Applicare un solo limite a tutto alzerebbe il limite della console o renderebbe impossibile il workbench. Il budget si divide quindi in tre parti, misurate e verificate dalla build (`checkBudget`) in M9-WP5:

| Parte                                                      | Cosa si misura                                                                                                                    | Limite                                                         |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **Console** (entry `src/main.tsx`)                         | iniziale: entry e import statici; totale: tutti i chunk **esclusi** quelli raggiungibili solo dall'import dinamico del workbench  | invariato: iniziale ≤ 700 kB, totale ≤ 1000 kB                 |
| **Workbench JS** (pagina `workbench.html` e worker)        | iniziale: il chunk d'ingresso e i suoi import statici, **CSS compreso**; totale: tutto ciò che l'ingresso e il worker raggiungono | iniziale ≤ 2500 kB, totale ≤ 23000 kB                          |
| **Workbench WASM** (`memobrain-core.wasm`, `sqlite3.wasm`) | dimensione compressa con gzip (come viene servita)                                                                                | core ≤ 8 MB (obiettivo dello spike, ADR-0030); sqlite ≤ 1,5 MB |

Regole:

- La console non deve importare staticamente nessun modulo di `@memobrain/workbench`. Un test della build verifica che il chunk iniziale della console non contenga moduli del pacchetto.
- Il limite del workbench JS segue quello del desktop, perché il codice è lo stesso: se il desktop alza il proprio limite di proposito, il web lo segue nella stessa modifica.
- Il limite del WASM è un obiettivo dello spike M9-WP1. Se lo spike lo supera, si ridiscute qui con le misure, invece di alzarlo in silenzio.
