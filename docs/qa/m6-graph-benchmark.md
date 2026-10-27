# M6-WP1 — Benchmark della Graph view

Obiettivo (roadmap M6-WP1): grafo di 10k nodi a ≥ 30 fps. Questo documento riporta ciò che è stato misurato davvero, il metodo e i limiti. Nessun valore è stato stimato.

## Ambiente

MacBook (Apple M4), macOS, Go 1.26, Node 24, Chromium di Playwright 1.64 in modalità **headless** (rasterizzazione CPU software, nessuna GPU). Grafo sintetico (`src/graph/synthetic.ts`): 10 000 nodi, ~35 000 archi, distribuzione dei gradi a coda pesante. Durante le misure la macchina era condivisa con altri processi (load average 6-14 sui 10 core), quindi i tempi variano: sono riportati gli intervalli osservati.

## 1. Backend: `graph.Build` su vault sintetico da 10k note

`cd apps/desktop && go test -run xxx -bench Build -benchtime 3x ./internal/graph/`

Vault reale su disco indicizzato dall'indexer (10 000 note, ~5 link ciascuna, tag, fantasmi), `Build` con orfani, fantasmi e tag attivi:

- **~83 ms per chiamata** (10 060 nodi, 60 990 archi). Numero fisso di query, nessun N+1.
- L'indicizzazione iniziale del vault sintetico (non parte di `Build`) richiede minuti ed è fuori da questo benchmark.

## 2. Layout (passo di simulazione)

`MEMOBRAIN_GRAPH_BENCH=10000 yarn workspace @memobrain/desktop-frontend exec vitest run src/graph/layout.bench.test.ts` (d3-force in Node/V8, thread principale, quindi senza il costo del Worker):

| nodi   | archi  | tick (mediana) | tick (p95) | tick fino a raffreddamento |
| ------ | ------ | -------------- | ---------- | -------------------------- |
| 2 000  | 6 942  | 4,05 ms        | 4,61 ms    | 300, 1,2 s                 |
| 10 000 | 35 001 | 19,3 ms        | 23,8 ms    | 194, 3,9 s                 |

Nell'app il layout gira in un Web Worker e pubblica le posizioni circa a ogni frame: l'interfaccia non è bloccata; il grafo da 10k si assesta in ~5-8 s (misura in browser, sotto).

## 3. Rendering in Chromium reale

`MEMOBRAIN_GRAPH_BENCH=10000 yarn workspace @memobrain/desktop-frontend exec playwright test e2e/graph-bench.spec.ts`

Il test usa il Worker vero e il renderer Canvas 2D vero; la durata di disegno include una lettura di 1 pixel (`getImageData`) per forzare la rasterizzazione, altrimenti il tempo JS nasconde il costo di raster. Due fasi:

- **Frame completo** (durante il layout, vista fissa, ridisegno esatto di 10k nodi e ~35k archi): mediana **14,7 ms** (carico basso) / **21,5 ms** (macchina carica), p95 15-23 ms, massimo 31-54 ms → circa 45-65 fps possibili.
- **Pan/zoom continuo** (4 s di eventi `wheel` a ogni frame; si trasforma il bitmap): **60,1 fps**, 2 ms per frame, intervalli rAF 16,7 ms.

Prima delle ottimizzazioni (archi a 1,2 px, archi circolari per ogni nodo) lo stesso test dava 0,5-1,9 fps nello stesso browser: gli archi non-hairline dominavano (misura isolata: 35k segmenti, 37 ms a 1 px contro 1 900 ms a 1,2 px).

## Cosa NON è stato verificato

- Il webview reale di Wails (WKWebView/WebView2/WebKitGTK) con accelerazione GPU: le cifre sopra sono di Chromium headless con raster CPU, quindi un ordine di grandezza di riferimento prudente, non una garanzia per ogni piattaforma. Da ripetere su macOS/Windows/Linux con l'app (`make dev-desktop`) aprendo il grafo di un vault grande.
- Il tempo `Build` end-to-end tramite binding Wails (serializzazione JSON di ~10k nodi) non è stato misurato separatamente.
- Hardware meno recente di un M4: i tick di layout (CPU, nel Worker) scalano con la CPU; il frame completo a 10k nodi potrebbe scendere sotto 30 fps su portatili lenti con raster CPU. In tal caso le leve già previste sono: `maxNodes` più basso, `labelZoom` più alto, passaggio a `pixi.js` (vedi ADR-0013).
