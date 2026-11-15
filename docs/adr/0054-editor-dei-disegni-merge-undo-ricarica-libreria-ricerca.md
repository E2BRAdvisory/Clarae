# ADR-0054 — Editor dei disegni: merge delle modifiche, undo, ricarica, libreria e ricerca (M18)

|                       |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stato**             | accettata il 2026-11-15 (decisione dell'owner); implementata in M18 e rilasciata con la 1.6.0. Emenda [ADR-0010](0010-drawing-and-canvas-details.md) (decisioni 5, 6 e 7) e, per l'auto-export, [ADR-0024](0024-excalidraw-feature-parity.md) (decisione 5)                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Recepito in**       | `Specifications.md` v1.6 (2026-11-15): §2.7.1, §2.7.2 (punti 3, 4, 5, 7), §2.7.3, §3.4.3, §3.4.5, §3.4.6 e Appendice C.4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Data**              | 2026-11-15                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Riferimenti spec**  | §2.7.1 (anteprima, libreria forme), §2.7.2 (punti 3, 4, 5 e 7), §3.4.3 (stato locale `sync.db`), §3.4.5 (D-04, tabella delle strategie e flusso di decisione), §3.4.6 (scope di `.memobrain/`, riga `excalidraw-library.json`); D-04, D-02; ADR-0038, ADR-0039, ADR-0045                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Devia dallo spec?** | sì, in modo puntuale: §3.4.5 (la libreria di forme non segue «LWW per chiave» ma un merge per id) e §3.4.6 (la riga `excalidraw-library.json` dice che segue i config JSON); §2.7.2 punto 4 (auto-export «dopo ogni salvataggio»); inoltre precisazioni a §2.7.1, §2.7.2 (3, 5 e 7) e §3.4.3. L'elenco puntuale è in «Sezioni dello spec da aggiornare» in fondo                                                                                                                                                                                                                                                                                                                                                          |
| **Superfici**         | desktop (prove: `go test -race` di `apps/desktop/internal/{app,sync,drawing,indexer}` e `shared/go/{merge,pathrules}`; `task conformance`; e2e `drawing-lifecycle`, `drawing-merge`, `drawing-split`, `drawing-theme`, `drawing-library`; sync a due dispositivi: `TestShapeLibraryMergesByID` in `task test-desktop-e2e`) · workbench web (stesso core in WebAssembly e stessa UI; prove: `task test-wasm` e gli stessi e2e sul core WASM nel browser) · console: non applicabile · cloud: nessuna modifica, né di API né di schema: il merge resta sul client e il protocollo di sync non cambia. Registro: voci `drawing.edit`, `drawing.embeds`, `drawing.export`, `drawing.library` di `shared/parity/features.yaml` |

## Contesto

Una rassegna dell'editor dei disegni (Excalidraw nel fork di ADR-0028) fatta per M18 ha confermato venti debolezze, una delle quali con perdita di dati. Le principali:

- **Perdita di dati.** Se un file `.excalidraw` diventava invalido fuori dall'app (un altro programma, una sincronizzazione interrotta), l'editor lo teneva come «versione letta» e il salvataggio successivo lo sovrascriveva con la scena in memoria.
- **Modifiche non salvate contro una versione nuova.** Con modifiche non ancora scritte, ogni versione nuova del file (la sincronizzazione, l'altro pannello dello stesso disegno) apriva il banner di conflitto e obbligava a scegliere; con il merge a tre vie già disponibile in `shared/go/merge` e usato dalla sincronizzazione.
- **Annulla.** `updateScene` senza `captureUpdate` esplicito poteva trasformare in passo di annullamento una ricarica esterna, o spezzare in più passi un'azione.
- **Costi a ogni modifica.** La scena veniva serializzata a ogni `onChange` (anche per selezione e scroll), `onChange` e `initialData` cambiavano identità a ogni render, l'auto-export disegnava PNG e SVG a ogni salvataggio, e ogni embed rileggeva il disegno intero (megabyte, con le immagini) solo per calcolarne l'hash e trovare l'anteprima in cache.
- **Cache e tema.** `.clarae/cache/drawings/` non veniva mai ripulita, gli embed erano sempre chiari e il tema «Sistema» non seguiva il sistema operativo a caldo.
- **Libreria di forme.** Era un file letto una volta per editor e sincronizzato come ogni file di impostazioni, cioè con «ultimo scrittore vince» sulla chiave `libraryItems`: le forme aggiunte da un dispositivo sparivano se un altro scriveva dopo.
- **Ricerca.** Il testo indicizzato di un elemento era `text`, con gli a capo automatici inseriti da Excalidraw: una parola spezzata su due righe non si trovava. Il TeX delle formule non era indicizzato.

Vincoli: il merge è sempre sul client e il server non interpreta il contenuto (nessuna operazione di API nuova); D-04 garantisce il merge multi-utente solo per i `.md`; D-02 fa dei vault privati un vault di un solo utente; il core è lo stesso su desktop e nel browser (ADR-0030), quindi ogni logica nuova sta nel core Go, una volta.

## Decisione

### 1. Un file invalido non si sovrascrive

`useNoteDocument` (`packages/workbench/src/editor/useNoteDocument.ts`) accetta l'opzione `accept(content)`. Una versione letta dopo il primo caricamento che non la soddisfa **non viene adottata**: l'hash resta quello del testo mostrato, quindi il salvataggio successivo non può scrivere sopra un file che l'editor non ha mai visto; il documento passa a `save: 'conflict'` con il nuovo campo `rejected: true`. Il disegno passa `isScene` (`parseScene` non deve fallire). Il banner dice «Il file su disco non è più un disegno valido…» e offre **solo «Sovrascrivi»** (non c'è nulla da ricaricare né da tenere accanto). Quando il file torna valido e non ci sono modifiche non salvate, la ricarica lo mostra e lo stato rientra da solo. L'opzione è usata dal solo disegno; note e lavagne non cambiano.

### 2. Annulla: `captureUpdate` esplicito

Ogni `updateScene` dell'editor dichiara `captureUpdate`: `NEVER` per ciò che arriva da fuori (ricarica esterna, merge) e per lo spostamento della vista della mini-mappa; `IMMEDIATELY` per le azioni che cambiano elementi, così **un'azione è un passo di annullamento**. Una modifica di un altro non entra mai nella cronologia di questo editor.

### 3. Ricarica esterna e costo del salvataggio

- La ricarica applica anche le chiavi di documento di `appState` (`viewBackgroundColor`, `gridSize`, `gridStep`, `gridModeEnabled`, `lockedMultiSelections`: `drawing/externalReload.ts`, `documentAppState`) e mai scroll, zoom, selezione o strumento in mano; ripubblica i frame dello Slideshow; aggiorna la firma di scena, perché il cambiamento che Excalidraw riporta per ciò che ha appena ricevuto non è una modifica dell'utente e **non riscrive il file**.
- La scena si serializza solo al salvataggio: `doc.edit` riceve una funzione, e le chiavi di primo livello del file diverse da quelle di Excalidraw si aggiungono per giunzione di testo (`drawing/serialize.ts`, `appendRootKeys`) invece che rileggendo megabyte di base64. La firma di scena (`sceneSignature`) è un hash scorrevole di id e versioni degli elementi, non l'elenco scritto per esteso. `onChange` e `initialData` hanno identità stabile.

### 4. Merge delle modifiche non salvate: `VaultAPI.MergeEdit`

Nuovo binding `VaultAPI.MergeEdit(vaultID, relPath, base, ours, theirs) → { strategy, merged, clean }` (`apps/desktop/internal/app/bindings_merge.go`; nel browser è nel core WASM e in `web/src/workbench/core.gen.ts`):

- **Solo calcolo:** non legge né scrive file. `base` è il testo da cui partono le modifiche, `ours` il testo dell'editor, `theirs` la versione ora su disco.
- **Stesso codice e stessa tabella della sincronizzazione:** la strategia è `merge.Decide(syncproto.KindOf(path), sameAuthor, modify, modify)`; poi `merge.Markdown`, `merge.Excalidraw` o `merge.Canvas`. `clean` è vero solo se il merge non lascia scelte. Non è un errore, ma `clean: false` e `merged` vuoto, quando: ci sono hunk in conflitto (nota), il tipo non si fonde mai (strategia diversa dalle tre), l'autore non è quello dell'utente su un vault condiviso (D-04, punto 5), il testo non si analizza (`strategy: conflict-copy`, come farebbe la sync).
- **Dentro `useNoteDocument`** l'opzione `merge(base, ours, theirs)`: quando arriva una versione nuova e ci sono modifiche non salvate, si prova il merge. Se riesce, il testo fuso diventa quello dell'editor, l'hash diventa quello di `theirs` e il testo si salva sopra `theirs` dopo il normale ritardo; se una scrittura è rifiutata perché il file è cambiato prima dell'evento, si rifà lo stesso merge. Se non si può, si passa al banner come prima. La scena fusa **non entra nell'annulla** (punto 2).
- **Mai sotto un gesto:** il merge sostituisce la scena a schermo, quindi aspetta che non ci sia un gesto in corso (testo in modifica, forma o linea in disegno, trascinamento, ridimensionamento, rotazione, selezione a riquadro: `drawing/gesture.ts`), fino a `MERGE_WAIT_MS` = 20 s; dopo, lascia la scelta all'utente con il banner. Un file ridotto a testo vuoto non si fonde.
- Oggi chiama il binding solo `DrawingEditor`. Il binding sa fondere anche `.md`, `.canvas` e `.base` (stessa strategia della sync), ma note e lavagne tengono il loro flusso con il banner: estenderlo è una scelta separata.

### 5. Regola D-04 nell'editor: l'autore della revisione di testa in `sync.db`

Per decidere se la versione su disco è «dello stesso utente», l'editor non ha il cambio in arrivo, ha solo il file. Quindi `sync.db` registra l'autore della revisione di cui una riga contiene il contenuto: colonna `sync_files.head_author TEXT NOT NULL DEFAULT ''` (migrazione `apps/desktop/internal/store/migrations/sync/0004_head_author.sql`; `Down` la toglie). Si valorizza con l'autore del cambio quando il pull, una risoluzione o una fusione portano contenuto, con l'utente dell'account quando il commit è nostro; si azzera quando il contenuto non ha un autore noto (bootstrap, `republish` con contenuto diverso, `reupload`, rifiuto del server); un solo spostamento di path lo conserva.

`Manager.SameAuthorOnDisk(ctx, localID, path, diskHash)` (`apps/desktop/internal/sync/manager_author.go`) risponde così:

| Caso                                                                                                           | Risposta                                         |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| vault non collegato, o privato (un solo autore, D-02)                                                          | vero                                             |
| file che la sync non ha mai visto                                                                              | vero (scritto qui)                               |
| contenuto su disco diverso da quello che la riga ha visto (scritto qui: altro pannello, altra app, ripristino) | vero                                             |
| stato `local_new`, `local_modified`, spostato con modifiche                                                    | vero (contenuto nostro)                          |
| contenuto del server (`synced`, spostato senza modifiche)                                                      | vero solo se `head_author` è l'account del vault |
| `conflict`, `head_author` vuoto, errore di lettura di `sync.db`                                                | falso (cammino prudente: banner)                 |

**Limite dichiarato:** le righe che esistevano prima della migrazione, e quelle adottate da un bootstrap, non hanno autore e contano come «altro autore». Su un vault condiviso, un disegno già sincronizzato prima della 1.6 mostra il banner invece del merge, la prima volta che arriva una versione nuova con modifiche non salvate, finché un pull o un commit non riscrive la riga. Su un vault personale non collegato o privato il merge non ha questo limite. Il merge dell'editor è quindi **più prudente** della sincronizzazione, che conosce l'autore del cambio in arrivo.

### 6. «Tieni entrambe»

Il banner di conflitto ha una terza scelta oltre a _Ricarica_ e _Sovrascrivi_: `NoteDocument.keepBoth()` ferma il salvataggio in attesa, salva il testo dell'editor in una copia accanto al file (lo stesso meccanismo di salvataggio di emergenza usato per le modifiche che non si possono scrivere), ricarica il file e dice dove sta la copia («La tua versione del disegno è in una copia accanto al file: …»). Non c'è quando il file è invalido (punto 1).

### 7. Due pannelli sullo stesso disegno

Un disegno aperto in due pannelli ha due editor. `getSceneController()` sceglie quello del pannello a fuoco (`paneId()` contro `layout.activePane`), poi quello del disegno della scheda attiva, poi l'ultimo registrato. Lo store dello Slideshow (`drawing/slidesStore.ts`) ha un **proprietario** (`owner`, l'id dell'editor): lo prende chi pubblica quando nessuno lo ha, o quando è a fuoco, e quando un pannello lascia il disegno i frame dell'altro restano nella scheda. Drop e dialoghi vanno all'editor da cui partono.

### 8. Auto-export ritardato (emenda ADR-0024, decisione 5)

L'esportazione automatica non parte a ogni salvataggio ma **15 s dopo l'ultimo** (`AUTO_EXPORT_QUIET_MS`, `drawing/export/autoExport.ts`), e subito alla chiusura del disegno, del vault, al cambio di workspace e all'uscita (`registerNoteFlusher`). Lavora su una chiave (scena e impostazioni di export): una chiave già esportata non si ripete, e tornare a una scena già esportata (un annulla) annulla l'attesa; i lavori vanno in coda uno alla volta; un lavoro fallito si riprova al salvataggio successivo.

### 9. Anteprime: `DrawingAPI.Preview` e varianti per tema (emenda ADR-0010, decisione 5)

- `DrawingAPI.Preview(vaultID, relPath, variant) → { hash, svg }`: il core calcola l'hash del file **a flusso** (`FS.HashFile`, senza caricarlo) e restituisce l'SVG in cache per quell'hash e variante, vuoto se non c'è. Un embed con anteprima in cache non rilegge il disegno. `variant` è `""` (chiaro) o `"dark"`; il percorso è `.clarae/cache/drawings/<hash>.svg` o `<hash>.dark.svg`; il file deve essere un `.excalidraw`.
- `DrawingAPI.SavePreview(vaultID, hash, variant, svg)` prende la variante (limiti invariati: 64 esadecimali, 4 MB, `<svg` e niente `<script`). **`DrawingAPI.ReadPreview` è rimosso.**
- Lato UI (`drawing/preview.ts`): gli embed che chiedono lo stesso disegno, parte, variante e versione nello stesso momento **condividono lettura e resa**; solo i disegni interi usano la cache su disco (le parti usano quella in memoria, come prima). Con il tema scuro l'embed mostra la versione scura (`exportWithDarkMode`) e passa dall'una all'altra al cambio di tema; stampa ed esportazione della nota usano sempre la chiara.
- Il tema «Sistema» segue il sistema operativo a caldo (`app/theme.ts`, `watchTheme`/`currentTheme`; `app/useTheme.ts`).

### 10. Potatura della cache delle anteprime

All'apertura del vault, **dopo** che l'indice è allineato al disco (`apps/desktop/internal/app/drawing_cache.go`), si tolgono da `.clarae/cache/drawings/` i file `<hash>.svg` e `<hash>.dark.svg` il cui hash non è quello corrente di nessun disegno dell'indice e che hanno più di 10 minuti (`drawingCacheMinAge`, per non toccare l'anteprima di un salvataggio appena fatto che il watcher non ha ancora indicizzato). Si guarda solo il nome (`^[0-9a-f]{64}(\.dark)?\.svg$`); gli altri file restano. È a massimo sforzo (la cache è derivata e locale): un errore finisce nel log, non blocca l'apertura. L'ordine conta: la migrazione dell'indice del punto 12 azzera gli hash finché la passata completa non li ripristina. `FS.ListFiles` elenca una cartella senza applicare le regole di esclusione di `Walk`.

### 11. Libreria di forme: store condiviso e merge per id (devia da §3.4.5 e §3.4.6)

- **Store** (`drawing/library/store.ts`): una libreria per vault, condivisa da tutti gli editor aperti (una forma aggiunta in un pannello compare subito negli altri); le modifiche si scrivono con un ritardo di 800 ms (`LIBRARY_WRITE_MS`) e subito alla chiusura; si ricarica quando la sincronizzazione o un altro programma cambiano il file (`isLibraryPath`, sotto il nome corrente o quello della 1.x della cartella di configurazione).
- **Sync: strategia nuova `library-by-id`** (`merge.StrategyLibraryByID`, `merge.LibraryByID`). `merge.DecideByPath(path, kind, sameAuthor, ours, theirs)` è `Decide` con una eccezione: se la strategia è `config-lww` e `pathrules.IsShapeLibrary(path)` (il file `excalidraw-library.json` nella cartella di configurazione, sotto uno dei due nomi; non in sottocartelle né alla radice), si usa il merge per id. Il motore di sync (`sync/resolve.go`) chiama `DecideByPath`. Regole, a tre vie sugli elementi di `libraryItems` per `id`:
  - una forma aggiunta da un lato resta;
  - una forma tolta da un lato e lasciata com'era dall'altro è tolta;
  - una forma tolta da un lato e **modificata** dall'altro resta, con la modifica (nulla si perde in silenzio);
  - una forma modificata da entrambi prende la versione del lato più recente (come le chiavi di `ConfigLWW`); l'altra resta nello storico del server;
  - senza base (storico potato) le due librerie si **uniscono**;
  - l'ordine è quello di `ours`, poi le forme nuove di `theirs` nel loro ordine; le altre chiavi di primo livello si fondono come `ConfigLWW`.
- **Non produce mai una copia di conflitto**, salvo un file che non si legge (JSON non valido, `libraryItems` che non è un elenco, una forma senza `id`): `LibraryByID` restituisce un errore e la sync ricade sulla copia di conflitto, come per ogni altro file illeggibile.
- Prove: 13 fixture `shared/conformance/merge/library-*` (`kind: "library"` nel `meta.json`, eseguite da `shared/go/merge/merge_test.go`), `TestDecideByPathGivesTheShapeLibraryItsOwnStrategy`, `TestLibraryByIDNeverDropsAShapeSomeoneChanged` (proprietà), `TestShapeLibraryMergesByID` (due dispositivi contro il cloud).

### 12. Ricerca nei disegni: `originalText` e TeX (emenda ADR-0010, decisione 7)

`internal/drawing` indicizza di un elemento `text` il testo **come lo ha scritto l'utente** (`originalText`; se manca, `text`: i file di altri strumenti) e, per un elemento che è una formula, il suo TeX (`customData.clarae` con `kind == "latex"` e `latex`; per i file della 1.x vale ancora `customData.memobrain`, e la chiave corrente vince). Il TeX entra nel testo cercabile, non nei link. Per questo la migrazione dell'indice `apps/desktop/internal/store/migrations/index/0005_reindex_drawings.sql` marca le righe dei disegni come scadute (`mtime_ns = 0`, `hash = ''`): la prima passata completa dopo l'aggiornamento rianalizza **una volta** ogni disegno e riscrive le due colonne. `Down` non fa nulla (l'indice è derivato).

### 13. Soglie di dimensione

Sopra **8 MB** un disegno non è più indicizzato (solo nome e percorso: `maxParseBytes`, `apps/desktop/internal/indexer/indexer.go`, invariato) e sopra **10 MB** si avvisa che è lento (`drawing.MaxSize`). L'editor ora misura entrambe le soglie **in byte del file salvato** (`sizeWarning`, `drawing/scene.ts`), con due avvisi diversi («non più ricercabile» e «lento»), non in caratteri come prima.

### 14. I tombstone degli elementi cancellati non si potano

Un elemento cancellato resta nel file con `isDeleted` (il salvataggio scrive `getSceneElementsIncludingDeleted`) e **non si pota mai**, né in editor, né in sync, né in un'azione di manutenzione. Nel merge per id di §3.4.5 (`merge.Excalidraw`: «elementi cancellati rispettati») un tombstone potato lascerebbe all'altro lato la sua copia viva, che **ricomparirebbe** al merge successivo. Il costo è un file che cresce con le cancellazioni, che le soglie del punto 13 rendono visibile.

## Alternative considerate

- **Reimplementare il merge in TypeScript nell'editor** — scartata: due implementazioni dello stesso merge divergono (è lo stesso motivo per cui i parser hanno fixture condivise). `MergeEdit` usa `shared/go/merge`, quindi la sync e l'editor decidono allo stesso modo sul desktop e nel browser.
- **Banner sempre, come prima** — scartata: ogni sincronizzazione con modifiche in corso chiedeva una scelta tra due versioni di un file grande, con rischio di sceglierne male.
- **Merge tra autori diversi anche nell'editor** — scartata: D-04 lo garantisce solo per i `.md`; un disegno di un altro utente su un vault condiviso resta una scelta dell'utente.
- **Chiedere l'autore al cloud, o dedurlo dalla cronologia** — scartata: servirebbe la rete (il disegno si modifica offline) e una chiamata nuova; l'informazione arriva già con il cambio che la sync applica, e `sync.db` è il posto dove si tiene lo stato di ogni file.
- **Potare i tombstone per contenere la dimensione** — scartata (punto 14).
- **Mantenere «ultimo scrittore vince» per la libreria** — scartata: `libraryItems` è una sola chiave, quindi le forme aggiunte da un dispositivo si perderebbero. **Una libreria con un file per forma** — scartata: cambierebbe il formato `excalidrawlib` e la compatibilità con gli strumenti che lo leggono.
- **Auto-export a ogni salvataggio, con soglia di dimensione** — scartata: il costo è sul thread principale e non dipende solo dalla dimensione; la quiete di 15 s lo toglie dal lavoro in corso senza perdere nulla, perché alla chiusura si esporta subito.
- **Hash dell'anteprima calcolato nel frontend (`ReadPreview(hash)`)** — scartata: per avere l'hash il frontend doveva leggere il file intero.

## Conseguenze

- **Nessuna perdita** per un file reso invalido dall'esterno, e per il caso comune (sync mentre si disegna) nessuna scelta manuale. «Annulla» riguarda solo ciò che l'utente ha fatto.
- **Compatibilità e aggiornamento.** Due migrazioni locali: `sync.db` (colonna `head_author`) e `index.db` (rianalisi dei disegni al primo avvio, più lunga con molti disegni grandi); nessuna migrazione del cloud, nessuna operazione di API cambiata. I binding del core cambiano (`VaultAPI.MergeEdit` nuovo; `DrawingAPI.Preview` al posto di `ReadPreview`; `SavePreview` con la variante): desktop e web usano la stessa build, quindi non esistono combinazioni miste. Tornare alla 1.5 sullo stesso dispositivo non è stato provato.
- **Prudenza provvisoria sui vault condivisi** (punto 5): finché le righe non hanno un autore, un disegno condiviso mostra il banner dove la sync avrebbe fuso.
- **Il merge aspetta** fino a 20 s la fine di un gesto: chi tiene un gesto più a lungo vede il banner.
- **Il file di un disegno cresce con le cancellazioni** (punto 14). Le soglie di 8 e 10 MB avvisano.
- **Due fonti di verità sulle soglie** (`maxParseBytes` in Go e `DRAWING_SEARCH_BYTES` in TypeScript): vanno tenute uguali a mano.
- **Fuori da questo ADR:** il merge nell'editor di note, lavagne e basi (punto 4) e una release di rimozione per la lettura dei disegni della 1.x (ADR-0052).
- **Da rivedere** dopo prove su due dispositivi reali con utenti diversi su un vault condiviso e su una WebView reale (gli e2e usano Chromium con i binding simulati e il core WASM).

## Sezioni dello spec da aggiornare

Recepite in `Specifications.md` v1.6 (2026-11-15), una per una come nell'elenco. Due punti della decisione non sono nell'elenco, e quindi non sono riportati nello spec: i due pannelli sullo stesso disegno (punto 7) e le soglie di 8 e 10 MB misurate in byte (punto 13).

| Sezione                                      | Cosa cambia                                                                                                                                                                                                                                          |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §3.4.5, tabella delle strategie              | Nuova riga «Libreria forme (`excalidraw-library.json`)»: merge per `id` della forma, mai conflict copy salvo file illeggibile; la riga «Config JSON» diventa «eccetto la libreria di forme». Nel flusso di decisione il ramo `config JSON` si divide |
| §3.4.5, «Ambito della collaborazione (D-04)» | Precisare che le stesse regole valgono per il merge delle modifiche non salvate in un disegno aperto, e che l'autore della revisione di testa viene da `sync.db`                                                                                     |
| §3.4.3, `sync_files`                         | Aggiungere la colonna `head_author` (autore della revisione di cui la riga ha il contenuto; vuoto se non noto)                                                                                                                                       |
| §3.4.6, riga `excalidraw-library.json`       | Togliere «segue la risoluzione dei config JSON» per questo file: si fonde per id                                                                                                                                                                     |
| §2.7.1, riga «Libreria forme»                | Una libreria per vault condivisa dagli editor, con merge per id                                                                                                                                                                                      |
| §2.7.1, riga «Anteprima»                     | Cache `<hash>.svg` e `<hash>.dark.svg`; `DrawingAPI.Preview` e `SavePreview` con variante (non più `ReadPreview`); potatura all'apertura del vault                                                                                                   |
| §2.7.2, punto 3                              | Il salvataggio serializza la scena solo al momento di scrivere; un file invalido non si sovrascrive; modifica esterna con modifiche non salvate: merge nell'editor, «Tieni entrambe»                                                                 |
| §2.7.2, punto 4                              | Auto-export 15 s dopo l'ultimo salvataggio e alla chiusura, non «dopo ogni salvataggio»                                                                                                                                                              |
| §2.7.2, punto 5                              | Il tema «Sistema» segue il sistema operativo; gli embed seguono il tema                                                                                                                                                                              |
| §2.7.2, punto 7                              | Ricerca: testo come scritto dall'utente (`originalText`) e TeX delle formule                                                                                                                                                                         |
| §2.7.3 / §3.4.5                              | Nota: i tombstone degli elementi cancellati non si potano                                                                                                                                                                                            |
