# M18-D — Benchmark del grafo 3D

Riguarda la vista 3D del grafo ([ADR-0055](../adr/0055-grafo-3d.md)). Riporta ciò che è stato misurato, il metodo e i limiti. Non è il benchmark del grafo 2D, che resta in [`m6-graph-benchmark.md`](m6-graph-benchmark.md): l'obiettivo di quello (10.000 nodi a ≥ 30 fps, M6/ADR-0013) vale per il 2D e non cambia. **Il 3D non lo eredita:** ha un inviluppo suo, quello qui sotto, e un tetto di 5.000 nodi.

**Stato:** il grafo 3D è implementato e rilasciato con la 1.7.0; `task ci` completo è verde sull'albero rilasciato (2026-11-15). La revisione del codice ha corretto, con una prova e2e ciascuno, la selezione nel livello a punti (un click apriva il nodo), un nodo nascosto dal timelapse ancora cliccabile e trascinabile nel livello a sprite, la selezione riferita al grafo precedente dopo un aggiornamento, la texture dell'anello di selezione non rilasciata al cambio di tema e il nuovo download del chunk dopo un errore. Ciò che non è provato resta in _Cosa NON è stato verificato_.

Nessun valore è stato stimato. Ogni riga della tabella è **una sola esecuzione**, su una macchina non isolata: i numeri indicano l'ordine di grandezza, non una garanzia.

## Ambiente

MacBook Apple M4, macOS, Chromium headless di Playwright, finestra 1280×800. Grafo sintetico (`packages/workbench/src/graph/synthetic.ts`): **tutti i nodi sono «nota»**, quindi c'è un solo aspetto (colore della classe più icona del tipo). Il layout gira nel Web Worker vero, in tre dimensioni; il grafo arriva dal mock dei binding (`window.__CLARAE_GRAPH_FIXTURE__`).

Due backend WebGL, scelti con `CLARAE_GRAPH3D_GL`:

- `metal`: la GPU del Mac (`--use-angle=metal`), quello che dà una macchina con una GPU;
- `swiftshader`: rasterizzatore software (`--use-angle=swiftshader`), quello che dà una macchina senza GPU.

## Metodo

```sh
CLARAE_GRAPH3D_BENCH=<nodi> CLARAE_GRAPH3D_GL=metal|swiftshader \
  yarn workspace @clarae/desktop-frontend exec playwright test e2e/graph-3d-bench.spec.ts
```

Il test (`apps/desktop/frontend/e2e/graph-3d-bench.spec.ts`) si salta senza `CLARAE_GRAPH3D_BENCH`, per non rallentare gli e2e normali; sul web si salta anche con la variabile (il grafo sintetico viene dal mock dei binding del desktop). Le colonne:

- **layout nel worker**: tempo, nel worker, fino al raffreddamento del layout;
- **fps durante il layout**: frame disegnati diviso il tempo, mentre il layout lavora;
- **fps in orbita**: frame disegnati diviso il tempo, per 4 s di trascinamento del puntatore che ruota la camera;
- **intervallo tra frame in orbita**: mediana, 95° percentile e massimo, in ms;
- **draw call**: quante ne conta il renderer per un frame.

Il livello di dettaglio dipende dai nodi (`SPRITE_NODES` = 2.000 in `three/scene.ts`): fino a 2.000 uno sprite per nodo, oltre un `Points` per aspetto.

## Misure

| GL                     | nodi  | link   | livello | layout nel worker | fps durante il layout | fps in orbita | intervallo tra frame in orbita (mediana / p95 / max) | draw call |
| ---------------------- | ----- | ------ | ------- | ----------------- | --------------------- | ------------- | ---------------------------------------------------- | --------- |
| Metal (GPU)            | 1.000 | 3.453  | sprite  | 1.650 ms          | 59,6                  | 60,0          | 16,7 / 17,5 / 18,3 ms                                | 1.001     |
| Metal                  | 2.000 | 6.942  | sprite  | 716 ms            | 61,1                  | 60,0          | 16,7 / 17,6 / 19,6 ms                                | 2.001     |
| Metal                  | 3.000 | 10.381 | punti   | 1.077 ms          | 60,8                  | 60,0          | 16,7 / 17,4 / 17,7 ms                                | 2         |
| Metal                  | 5.000 | 17.408 | punti   | 1.847 ms          | 60,6                  | 60,0          | 16,7 / 17,4 / 17,8 ms                                | 2         |
| SwiftShader (software) | 1.000 | 3.453  | sprite  | 1.880 ms          | 15,0                  | 28,1          | 33,7 / 42,4 / 70,8 ms                                | 1.001     |
| SwiftShader            | 2.000 | 6.942  | sprite  | 926 ms            | 12,3                  | 19,2          | 49,9 / 68,7 / 133,8 ms                               | 2.001     |
| SwiftShader            | 3.000 | 10.381 | punti   | 1.292 ms          | 15,0                  | 29,0          | 33,0 / 40,9 / 69,3 ms                                | 2         |
| SwiftShader            | 5.000 | 17.408 | punti   | 2.086 ms          | 11,2                  | 22,3          | 42,8 / 55,4 / 126,1 ms                               | 2         |

Lettura:

- **Con una GPU** (Metal) il 3D tiene 60 fps in orbita a ogni dimensione provata, fino a 5.000 nodi, e anche mentre il layout lavora: il layout nel worker non pesa sull'interfaccia.
- **Senza GPU** (software) l'orbita scende a 19…29 fps e durante il layout a 11…15 fps; l'intervallo massimo arriva a 134 ms. Resta usabile ma non fluido: è il caso di una macchina senza accelerazione, e la vista 2D resta disponibile.
- **Oltre 2.000 nodi** il livello a punti fa 2 draw call (una per aspetto, qui uno solo, più i link) invece di una per nodo. Con più tipi di documento ne fa una per aspetto: **non è stato misurato su un vault reale**.
- **2.000 nodi si assestano prima di 1.000** perché oltre 1.000 nodi il motore usa forze più leggere (`LARGE` in `layoutEngine3d.ts`: repulsione approssimata di più, a raggio limitato, raffreddamento più rapido). Non è un errore di misura.

## Il punto di partenza: lo spike D0

Lo spike (un prototipo usa-e-getta, non fuso nel prodotto; le sue misure grezze sono in [`docs/qa/graph-3d-spike-d0/`](graph-3d-spike-d0/)) ha misurato, a 3.000 nodi con i link di serie della libreria, 19 fps in orbita; con il layout della libreria sul thread principale, 5.000 nodi si assestavano in 23 s a 13,8 fps. Da lì le tre condizioni dell'ADR (link in un solo `LineSegments`, layout in un worker, tetto di 5.000 nodi). Sul costo dei nodi: a 5.000 nodi su Apple M4 con Metal, 12,9 ms di CPU per frame con gli sprite e 9,3 ms con le sfere, in entrambi i casi 5.001 draw call; il livello a punti ne faceva 7 a qualunque dimensione. Per questo i livelli di dettaglio sono due e non i tre del piano.

## Dimensioni (build di produzione, minificate)

- Chunk lazy `Graph3D-*.js`: 791 kB sul desktop, 792 kB sul web; si scarica solo alla prima apertura del 3D. Lo spike ne aveva misurato 793 kB.
- `layout.worker.js`: 34,8 kB (contiene ora anche `d3-force-3d`).
- Budget del bundle (ADR-0020), come stampato dalle build, nessun limite alzato: desktop `initial 1389 kB (limit 2000), total 19225 kB (limit 23000)`; web, workbench `initial 1950 kB (limit 2500), total 17298 kB (limit 23000)`; console `initial 697 kB (limit 700)` (la console non importa nulla di questo lavoro).

## Cosa NON è stato verificato

- **L'applicazione desktop reale.** Le prove automatiche girano in Chromium (con i binding simulati e sul core WASM). La WebView del desktop è WKWebView su macOS, WebView2 su Windows, WebKitGTK su Linux: prestazioni, WebGL2 e rilascio del contesto lì non sono stati misurati. La verifica manuale con `task run-desktop` non è stata fatta e resta da fare: aprire un vault con qualche migliaio di note, passare al 3D dal pulsante della barra del grafo e dal ribbon, orbitare, trascinare un nodo, chiudere e riaprire il grafo più volte, e controllare che non compaiano avvisi sui contesti WebGL.
- **GPU integrate, Windows e Linux.** Si è misurato solo un Apple M4, con Metal e con il rasterizzatore software.
- **Vault reali.** Solo un grafo sintetico di soli nodi «nota»: la distribuzione dei gradi, il numero di tipi di documento (quindi di draw call nel livello a punti) e le etichette di un vault vero non sono misurati.
- **Ripetibilità.** Una sola esecuzione per riga, macchina non isolata, nessuna media su più prove.
- **Hardware meno recente di un M4.** Il layout (CPU, nel worker) scala con la CPU; il tetto di 5.000 nodi è una costante (`GRAPH3D_MAX_NODES` in `graph/settings.ts`) e un'impostazione per vault (`maxNodes3d`, da 500 a 5.000): se serve, si abbassa il default o si alza solo dopo aver misurato.

## Prove automatiche collegate

- vitest: `geometry3d.test.ts`, `layoutEngine3d.test.ts`, `GraphView.3d.test.tsx`, e le aggiunte a `graph.test.ts` e `incremental.test.ts`.
- e2e sul mock dei binding e sul core WASM: `apps/desktop/frontend/e2e/graph-3d.spec.ts` (chunk lazy, scena WebGL2, legenda, pausa a riposo, click, doppio click e tastiera, nodo fissato e sbloccato, ripiego senza WebGL2, contesto rilasciato e contesto perso, livello a punti); accessibilità: `a11y.spec.ts` (voce «graph view in 3D»).
- sicurezza: `web/e2e-security/graph3d-csp.spec.ts` (handler e CSP di produzione: nessuna violazione, nessuna richiesta fuori origine).
- Go: `TestBuildDocuments` in `apps/desktop/internal/graph/graph_test.go` (disegni, lavagne e basi come nodi).
