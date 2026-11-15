# M18-D — Benchmark del grafo 3D

Riguarda la vista 3D del grafo ([ADR-0055](../adr/0055-grafo-3d.md)). Riporta ciò che è stato misurato, il metodo e i limiti. Non è il benchmark del grafo 2D, che resta in [`m6-graph-benchmark.md`](m6-graph-benchmark.md): l'obiettivo di quello (10.000 nodi a ≥ 30 fps, M6/ADR-0013) vale per il 2D e non cambia. **Il 3D non lo eredita:** ha un inviluppo suo, quello qui sotto, e un tetto di 5.000 nodi.

**Stato:** il grafo 3D è implementato e rilasciato con la 1.7.0; `task ci` completo è verde sull'albero rilasciato (2026-11-15). **La 1.7.1 aggiunge un livello di dettaglio intermedio, i solidi istanziati**: le misure sono nella sezione [«Il livello intermedio (1.7.1)»](#il-livello-intermedio-171), e la tabella «Misure» qui sotto resta quella della 1.7.0, con due livelli. La revisione del codice ha corretto, con una prova e2e ciascuno, la selezione nel livello a punti (un click apriva il nodo), un nodo nascosto dal timelapse ancora cliccabile e trascinabile nel livello a sprite, la selezione riferita al grafo precedente dopo un aggiornamento, la texture dell'anello di selezione non rilasciata al cambio di tema e il nuovo download del chunk dopo un errore. Ciò che non è provato resta in _Cosa NON è stato verificato_.

Nessun valore è stato stimato. Ogni riga della tabella «Misure» è **una sola esecuzione**, su una macchina non isolata: i numeri indicano l'ordine di grandezza, non una garanzia. Le misure del livello intermedio (1.7.1) sono una o due serie per riga, su una macchina condivisa con carico variabile: stesso avvertimento.

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

Il livello di dettaglio dipende dai nodi (`graph/lod.ts`). **Nella 1.7.0** erano due: fino a 2.000 uno sprite per nodo, oltre un `Points` per aspetto; è il caso della tabella che segue. **Dalla 1.7.1** sono tre (sprite fino a 1.000, solidi istanziati fino a 2.000, punti oltre): vedi la sezione sul livello intermedio.

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

## Il livello intermedio (1.7.1)

La 1.7.1 (M20, sessione S4) ha aggiunto tra sprite e punti un livello di **solidi istanziati**: un `InstancedMesh` per forma (sfera per note e presentazioni, cubo per i disegni, ottaedro per le lavagne, cilindro per le basi, cono per gli allegati, toro per i tag, icosaedro per le note non ancora create), con colore e scala per istanza; picking e trascinamento li fa la scena. Soglie in `graph/lod.ts`: **sprite fino a 1.000 nodi** (`SPRITE_NODES`), **solidi da 1.001 a 2.000** (`INSTANCED_NODES`), **punti oltre**. La regola era: misurare prima e dopo, e se non migliorava toglierlo e scriverlo. Migliora, quindi resta. [ADR-0055](../adr/0055-grafo-3d.md), punto 7.

**Metodo.** Lo stesso del benchmark sopra, con tre aggiunte al test `graph-3d-bench.spec.ts`:

- `CLARAE_GRAPH3D_KINDS=mixed` costruisce un grafo di **nove tipi di documento** (note, presentazioni, disegni, lavagne, basi, allegati, tag, note non create), invece di sole note: è ciò che distingue i livelli, perché il livello istanziato fa una draw call per forma e non per nodo;
- `CLARAE_GRAPH3D_LOD=sprite|instanced|points` disegna i nodi a quel livello qualunque sia il loro numero (solo nelle build E2E), per misurare ciascun livello alla stessa dimensione;
- nuove colonne: **CPU di un render** (mediana e p95, in ms: quanto spende la pagina per consegnare un frame) e **triangoli**.

```sh
CLARAE_GRAPH3D_BENCH=<nodi> CLARAE_GRAPH3D_GL=metal|swiftshader \
  CLARAE_GRAPH3D_KINDS=mixed CLARAE_GRAPH3D_LOD=sprite|instanced|points \
  yarn workspace @clarae/desktop-frontend exec playwright test e2e/graph-3d-bench.spec.ts
```

**Ambiente e avvertenza.** Apple M4, Chromium headless, come sopra; **macchina condivisa con carico variabile**; **una o due serie per riga**. I numeri sono ordini di grandezza, non garanzie, e non sono confrontabili con le righe della tabella «Misure» (altro grafo, altro carico).

**Su Metal (GPU), grafo misto.**

| Livello    | Nodi          | Draw call                 | CPU di render per frame | fps in orbita           |
| ---------- | ------------- | ------------------------- | ----------------------- | ----------------------- |
| sprite     | 1.000         | una per nodo (più i link) | 0,9 ms                  | 60 (limitati dal vsync) |
| sprite     | 2.000         | una per nodo (più i link) | 1,8 ms                  | 60 (limitati dal vsync) |
| istanziato | 1.000 e 2.000 | 8, a qualunque dimensione | 0,1 ms                  | 60 (limitati dal vsync) |

Con una GPU gli fps non distinguono i livelli (il vsync li tiene a 60): cambia il lavoro della CPU, che con i solidi è circa un nono di quello degli sprite a 1.000 nodi e circa un diciottesimo a 2.000. Le 8 draw call corrispondono alle sette forme più il `LineSegments` dei link.

**Su SwiftShader (rasterizzatore software), 2.000 nodi, grafo misto.**

| Livello    | fps in orbita (serie con più carico / serie con meno carico) |
| ---------- | ------------------------------------------------------------ |
| sprite     | 9,3 / 18,0                                                   |
| istanziato | 11,3 / 27,3                                                  |

Senza GPU il livello istanziato è più veloce degli sprite a 2.000 nodi in entrambe le serie: in orbita da 9,3 a 11,3 fps con la macchina più carica, da 18,0 a 27,3 con meno carico.

**Oltre 2.000 nodi non guadagna.** Rispetto ai punti il livello istanziato ha la stessa CPU di render e, su un rasterizzatore software, **perde**: a 5.000 nodi 7,7 fps in orbita contro 24,7 dei punti, perché disegna i triangoli dei solidi e i punti no. Per questo il livello si ferma a 2.000 nodi e oltre restano i punti.

**Dimensioni.** Il chunk `Graph3D-*.js` cresce di 10,6 KiB e `layout.worker.js` di 0,9 kB; i budget del bundle non cambiano.

**Che cosa non dicono queste misure.** Nulla sulla WebView reale (WKWebView, WebView2, WebKitGTK), su GPU integrate o su un vault reale; la forma dei solidi, la legenda con la forma al posto dell'icona e il trascinamento di un solido non sono stati visti su una finestra vera. Il runbook [`verifica-manuale-1.7.md`](verifica-manuale-1.7.md) dice che cosa annotare.

## Il punto di partenza: lo spike D0

Lo spike (un prototipo usa-e-getta, non fuso nel prodotto; le sue misure grezze sono in [`docs/qa/graph-3d-spike-d0/`](graph-3d-spike-d0/)) ha misurato, a 3.000 nodi con i link di serie della libreria, 19 fps in orbita; con il layout della libreria sul thread principale, 5.000 nodi si assestavano in 23 s a 13,8 fps. Da lì le tre condizioni dell'ADR (link in un solo `LineSegments`, layout in un worker, tetto di 5.000 nodi). Sul costo dei nodi: a 5.000 nodi su Apple M4 con Metal, 12,9 ms di CPU per frame con gli sprite e 9,3 ms con le sfere, in entrambi i casi 5.001 draw call; il livello a punti ne faceva 7 a qualunque dimensione. Per questo la 1.7.0 è uscita con due livelli di dettaglio e non con i tre del piano; la 1.7.1 ne ha aggiunto uno, perché lo spike non aveva misurato le geometrie istanziate (sezione seguente).

## Dimensioni (build di produzione, minificate)

- Chunk lazy `Graph3D-*.js`: 791 kB sul desktop, 792 kB sul web; si scarica solo alla prima apertura del 3D. Lo spike ne aveva misurato 793 kB.
- `layout.worker.js`: 34,8 kB (contiene ora anche `d3-force-3d`).
- Budget del bundle (ADR-0020), come stampato dalle build, nessun limite alzato: desktop `initial 1389 kB (limit 2000), total 19225 kB (limit 23000)`; web, workbench `initial 1950 kB (limit 2500), total 17298 kB (limit 23000)`; console `initial 697 kB (limit 700)` (la console non importa nulla di questo lavoro).

## Cosa NON è stato verificato

- **L'applicazione desktop reale.** Le prove automatiche girano in Chromium (con i binding simulati e sul core WASM). La WebView del desktop è WKWebView su macOS, WebView2 su Windows, WebKitGTK su Linux: prestazioni, WebGL2 e rilascio del contesto lì non sono stati misurati. La verifica manuale con `task run-desktop` non è stata fatta e resta da fare: aprire un vault con qualche migliaio di note, passare al 3D dal pulsante della barra del grafo e dal ribbon, orbitare, trascinare un nodo, chiudere e riaprire il grafo più volte, e controllare che non compaiano avvisi sui contesti WebGL.
- **GPU integrate, Windows e Linux.** Si è misurato solo un Apple M4, con Metal e con il rasterizzatore software.
- **Vault reali.** Un grafo sintetico, di soli nodi «nota» nella tabella «Misure» e di nove tipi nel livello intermedio: la distribuzione dei gradi, il numero di tipi di documento di un vault vero (quindi le draw call del livello a punti, una per aspetto) e le etichette non sono misurati.
- **Ripetibilità.** Una sola esecuzione per riga nella tabella «Misure», una o due serie nel livello intermedio, macchina non isolata e con carico variabile, nessuna media su più prove.
- **Hardware meno recente di un M4.** Il layout (CPU, nel worker) scala con la CPU; il tetto di 5.000 nodi è una costante (`GRAPH3D_MAX_NODES` in `graph/settings.ts`) e un'impostazione per vault (`maxNodes3d`, da 500 a 5.000): se serve, si abbassa il default o si alza solo dopo aver misurato.

## Prove automatiche collegate

- vitest: `geometry3d.test.ts`, `layoutEngine3d.test.ts`, `GraphView.3d.test.tsx`, e le aggiunte a `graph.test.ts` e `incremental.test.ts`.
- vitest del livello di dettaglio: `lod.test.ts` (soglie, forme, raggruppamento per forma, matrici delle istanze).
- e2e sul mock dei binding e sul core WASM: `apps/desktop/frontend/e2e/graph-3d.spec.ts`, **stabilizzato nella 1.7.1** (timeout esplicito, 17 commutazioni invece di 20, attese più larghe sullo stato della scena, attesa della quiete della scena) (chunk lazy, scena WebGL2, legenda, pausa a riposo, click, doppio click e tastiera, nodo fissato e sbloccato, ripiego senza WebGL2, contesto rilasciato e contesto perso, livello a punti); accessibilità: `a11y.spec.ts` (voce «graph view in 3D»).
- sicurezza: `web/e2e-security/workbench-csp.spec.ts` (handler e CSP di produzione: nessuna violazione, nessuna richiesta fuori origine; il test del 3D stava in `graph3d-csp.spec.ts` fino alla 1.7.0 e dalla 1.7.1 sta in questo file, dove prova anche il livello istanziato).
- Go: `TestBuildDocuments` in `apps/desktop/internal/graph/graph_test.go` (disegni, lavagne e basi come nodi).
