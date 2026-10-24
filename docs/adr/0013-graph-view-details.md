# ADR-0013 — Dettagli della Graph view (M6-WP1)

|                       |                                                                         |
| --------------------- | ----------------------------------------------------------------------- |
| **Stato**             | proposta                                                                |
| **Data**              | 2026-10-24                                                              |
| **Riferimenti spec**  | §2.5 `graph`; matrice funzioni (Graph view); D-06 (perimetro per-vault) |
| **Devia dallo spec?** | no (raffina: Canvas 2D invece di WebGL, ctime da frontmatter/mtime)     |

## Contesto

La roadmap M6-WP1 ammette `pixi.js` oppure canvas 2D. L'indice (`index.db`) non memorizza il tempo di creazione dei file, necessario al timelapse.

## Decisione

- **Rendering Canvas 2D**, senza `pixi.js`. Il layout (`d3-force` 3.0.0, pinnato) gira in un Web Worker; un solo `stroke` per gli archi e un `fill` per classe di colore. Misure in `docs/qa/m6-graph-benchmark.md`. Gli archi sono tracciati a 1 pixel di dispositivo (percorso "hairline" di Skia): linee più larghe su decine di migliaia di segmenti costano ~50 volte di più nei rasterizzatori CPU. Durante pan/zoom si trasforma un bitmap della scena (costo indipendente dalla dimensione del grafo) e si ridisegna esatto a gesto concluso.
- **Tab del grafo come pseudo-path** nel layout: `graph://global` e `graph://local/<nota>`; così la persistenza in `.nodus/workspace.json` non cambia. All'avvio i tab grafo non vengono scartati dal controllo di esistenza file.
- **Dati**: `GraphAPI.Build(vaultId, options)` esegue un numero fisso di query sull'indice (file, link, tag, proprietà `created`, più la ricerca per query/gruppi) e restituisce nodi e archi indicizzati; oltre `maxNodes` (default 20000) restano i nodi più connessi (`truncated`). I gruppi colore sono query del linguaggio di ricerca (§2.4) valutate dal backend.
- **Tempo di creazione**: proprietà frontmatter `created` / `date created` / `creation date` se valida, altrimenti `mtime` indicizzato (la data di nascita del file non è disponibile in modo portabile). I nodi fantasma e tag compaiono con la nota meno recente che li collega.
- **Impostazioni** in `.nodus/graph.json` (aggiunto alla allow-list di `ReadConfig`/`WriteConfig`); non scritte sui vault di sola lettura.

## Alternative considerate

- **pixi.js (WebGL)** — non necessario per l'obiettivo e con CSP/offline più onerosi; resta l'opzione se in un webview reale i numeri non bastano.
- **Birth time dal file system** — dipende dalla piattaforma (Linux spesso assente) e richiederebbe una stat per nota.

## Conseguenze

Le date del timelapse per note senza `created` riflettono l'ultima modifica. Il layout non è persistito: ogni apertura riparte da una disposizione nuova (nessun dato derivato da sincronizzare).
