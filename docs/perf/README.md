# Prestazioni (M7-WP1)

Obiettivi dall'Appendice A dello spec, misure e come ripeterle. Le cifre sono quelle realmente misurate; dove un obiettivo non è raggiunto o non è misurabile qui è scritto.

## Come si esegue

```sh
make perf PERF_NOTES=50000      # indice, ricerca, apertura nota, apertura vault, grafo 10k → .perf/results-50000.json
make perf-check PERF_NOTES=50000 [PERF_TOLERANCE=25]   # confronto con docs/perf/baseline-50000.json
make perf-data PERF_NOTES=10000 # solo il dataset (cache in .perf/vault-N, mai committato)
```

- Dataset: `apps/desktop/internal/perf/dataset` (seed fisso, stesso vault a ogni esecuzione). Note con dimensioni log-normali (mediana ≈ 1,8 KB, coda fino a 600 KB), frontmatter, intestazioni, tag, wikilink con grado entrante a legge di potenza (hub e coda lunga), link fantasma, riferimenti ad allegati. 50.000 note = 168 MB, ≈ 395.000 link.
- Variabili del test (`internal/perf/perf_test.go`): `MEMOBRAIN_PERF_NOTES`, `MEMOBRAIN_PERF_DIR`, `MEMOBRAIN_PERF_GRAPH_NOTES`, `MEMOBRAIN_PERF_OUT`, `MEMOBRAIN_PERF_KEEP_INDEX`, `MEMOBRAIN_PERF_CPUPROFILE`, `MEMOBRAIN_PERF_INDEX_PROFILE`.
- UI (Chromium headless su mock dei binding): `MEMOBRAIN_UI_BENCH=1 yarn workspace @memobrain/desktop-frontend exec playwright test e2e/ui-perf.spec.ts` (`MEMOBRAIN_UI_BENCH_NOTES`, `MEMOBRAIN_UI_BENCH_NOTE_KB`, `MEMOBRAIN_UI_BENCH_OUT`).
- Cloud: vedi la sezione sotto.
- Nightly: `.github/workflows/nightly-perf.yml` (desktop + smoke k6), artifact dei risultati, budget con `perfcheck`. Le baseline di CI sono `docs/perf/baseline-ci-<note>.json`: vanno create dalla prima esecuzione verde (artifact "candidate baseline"), perché quella di questo repository è di un'altra macchina.

## Macchina e metodo

MacBook Apple M4 (10 core), 32 GB, macOS 27.0.1, SSD, Go 1.26.0; Chromium di Playwright headless. **La macchina era condivisa con altre build: load average 11-15 durante le misure**, quindi i tempi sono pessimistici e variano di decine di percento da una corsa all'altra (la stessa indicizzazione da 50k ha impiegato 72,6 s e 85,9 s). Ricerca: mediana di 7 esecuzioni dopo una di riscaldamento (cache pagine del sistema e cache dei candidati). Nessuna cifra è stimata o estrapolata.

## Tabella obiettivi

| Obiettivo (spec)                                               | Misurato                                                                                                                                                                                                         | Macchina              | Stato                                                                        |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------- |
| Indice 50.000 note < 3 min                                     | **72,6 s** (prima: non terminato dopo 2 h 23 min, 38.000 file)                                                                                                                                                   | M4, carica            | raggiunto                                                                    |
| Indice incrementale < 100 ms/nota                              | **3,8 ms** mediana, 34 ms p95 (prima: 280 ms a 5k note, cresceva col vault)                                                                                                                                      | M4, carica            | raggiunto                                                                    |
| Ricerca < 200 ms su 50.000 note                                | testo: **27-143 ms** mediana; frase 63 ms; `line:` 81 ms; proprietà+testo 143 ms (prima: 0,6-2,8 s)                                                                                                              | M4, carica            | raggiunto, tranne regex                                                      |
| Ricerca con regex su tutto il vault                            | 461 ms mediana (578 ms p95)                                                                                                                                                                                      | M4, carica            | **non raggiunto**                                                            |
| Apertura nota < 150 ms (parte backend)                         | **0,7 ms** mediana, 1,6 ms p95 (lettura + parse + link uscenti + backlink); menzioni non collegate 15 ms                                                                                                         | M4                    | raggiunto (solo Go)                                                          |
| Avvio a freddo < 3 s                                           | parte Go: **147 ms** (store + albero di 50.968 voci + indice pronto); cache di ricerca 0,76 s in background                                                                                                      | M4                    | parte Go raggiunta; **avvio completo non misurato** (serve la webview reale) |
| Grafo 10.000 nodi ≥ 30 fps                                     | `Build` 10k: **99 ms**; rendering e layout come in `docs/qa/m6-graph-benchmark.md` (60 fps pan/zoom, Chromium headless)                                                                                          | M4                    | riuso M6                                                                     |
| Digitazione senza lag su nota ≤ 1 MB                           | 1 MB, Live Preview: latenza tasto→2 frame mediana **24,4 ms**, p95 32,9 ms; nota da 1 KB: 24,1 / 31,8 ms (il pavimento di 2 frame a 60 Hz è ≈ 33 ms)                                                             | M4, Chromium headless | nessun lag misurabile; da confermare sulla webview reale                     |
| Albero file con 50.000 note                                    | render 856 ms (prima 3.319 ms), 37 righe nel DOM (prima 50.715), espandi/comprimi 6 ms (prima 642 ms); 10k: 736 ms prima                                                                                         | M4, Chromium headless | migliorato                                                                   |
| Memoria dell'indice                                            | cache di ricerca ≈ **210 MB** di heap a 50k; picco runtime Go in indicizzazione 161 MB; `index.db` 894 MB su disco (5,3× il testo)                                                                               | M4                    | misurato, vedi limiti                                                        |
| Cloud p95 `changes` < 200 ms, `commit` < 500 ms a 1.000 utenti | k6 **non eseguito** (vedi sotto). Test Go esistente, 8 client: changes p95 13 ms, commit 50 op p95 216 ms. Misto piccolo, 200 utenti a ciclo chiuso: changes p95 50 ms (1.891/s), commit 1 op p95 203 ms (627/s) | M4 + PG in Docker     | indicativo, non il test richiesto                                            |

## Ottimizzazioni (prima → dopo)

- **Indicizzazione.** Profilo a 5.000 note: ~55 % del tempo nel commit WAL (una transazione per nota). Con batch da 250 note: 31 s → 5-8 s; poi il profilo ha mostrato `fts5IndexFlush` richiamato dal savepoint di ogni statement con foreign key dopo la prima scrittura FTS: scrivere le righe FTS alla fine del batch. A 50k: 72,6 s (carica). Prima: 2 h 23 min e solo 38.000 file su 50.000 (tempo di orologio, la macchina potrebbe aver dormito in parte).
- **Salvataggio di una nota.** `Update` rifaceva `ResolveAll` su tutto il vault: 280 ms a 5k note. Ora risolve solo i link della nota con il resolver in cache: 3,8 ms a 50k. La risoluzione completa resta quando una nota nuova/rimossa o gli alias cambiano (test `TestBatchesAndIncrementalResolve`).
- **Ricerca.** Profilo a 50k: ~50 % in `walBeginReadTransaction` (una query per corpo), poi lettura SQLite di ~170 MB a query. Passi: una sola transazione + corpo nella query di scansione (nessun guadagno netto sotto carico), cache dei candidati in RAM con valutazione parallela (1,8 s → 0,30 s per «budget review»), un solo `ToLower` per file e riga dello snippet tagliata dal corpo (→ 0,12 s). Tutte le query: 0,6-2,8 s → 0,03-0,14 s.
  - Equivalenza: `TestQueryEquivalentToLegacy` confronta cache, streaming e strategia precedente su query casuali (e dopo modifiche/cancellazioni, per la cache incrementale): stessi hit, ordine, snippet, punteggi e totali. I test di ricerca esistenti passano invariati.
- **Albero.** Finestra di rendering a righe fisse (vedi tabella).

## Cloud (k6)

- `services/cloud/test/load/k6/active-users.js`: fino a 1.000 utenti simulati (scenario `ramping-vus`), ciascuno con il proprio vault: polling di `changes` col cursore, commit di un piccolo file (create/modify) con upload del blob; 5 VU spediscono commit da 50 operazioni. Soglie k6: p95 `changes` < 200 ms, p95 `commit` e `commit_batch50` < 500 ms, errori < 1 %.
- Token: `TestServeLoadEnv` (`services/cloud/test/integration/loadenv_test.go`, tag `integration`, **solo test**: l'issuer OIDC finto esiste solo nei binari di test) avvia API + PostgreSQL in container, crea N utenti con vault e scrive `tokens.json`:

  ```sh
  make perf-load-env USERS=1000            # resta in attesa; fermare con: touch .perf/tokens.json.stop
  k6 run -e TOKENS=.perf/tokens.json services/cloud/test/load/k6/active-users.js
  ```

- **Non eseguito qui.** k6 non è installato; il binario scaricato non è stato eseguito (l'esecuzione di codice esterno scaricato è stata rifiutata dal sistema di permessi). Verificati: sintassi JS (`node --check`), avvio dell'ambiente (20 utenti creati in 0,2 s, token validi). Il nightly installa k6 con `grafana/setup-k6-action` e fa uno smoke da 200 utenti.
- `TestLoadSmallOps` (`MEMOBRAIN_LOAD=1`, anche con `MEMOBRAIN_LOAD_CPUPROFILE`) è il corrispettivo Go del mix «changes + commit piccoli». Con 32 client a ciclo chiuso il test M2 esistente satura (commit da 50 op p95 811 ms, tutti sullo stesso PG in Docker su un portatile carico): è un test di saturazione, non di 1.000 utenti reali (≈ 100 richieste/s).
- Profilo del server sotto `TestLoadSmallOps`: il tempo è nei round trip verso PostgreSQL e nel `PutBlob` su filesystem; la compilazione degli schemi JSON per ogni richiesta (15 % della CPU) è nel client di test (`env.do`), non nel server. Nessun N+1 o contention evidente nei percorsi `changes`/`commit`: non è stato modificato codice del cloud.

## Limiti noti

- Nessuna misura sulla webview reale (WebKit/WebView2): avvio a freddo end-to-end, digitazione e rendering vanno confermati a mano (checklist `docs/qa/obsidian-parity.md`).
- Regex su tutto il vault > 200 ms (prefiltro sui letterali non implementato).
- La cache di ricerca ha un costo in RAM pari al testo del vault (budget 512 MB, poi streaming).
- `index.db` ≈ 5,3× il testo; riconciliazione a vault invariato 3,5 s a 50k (in background).
- Il dataset è sintetico (vocabolario di pseudo-parole): le dimensioni dei corpi e la distribuzione dei link sono realistiche, il testo no.
