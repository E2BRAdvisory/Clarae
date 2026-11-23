# ADR-0063 — Nomi dei file senza estensione per ciò che si apre in una scheda, e rinomina che conserva l'estensione (M22)

|                       |                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stato**             | accettata (2026-11-20, decisione dell'owner); recepita in `Specifications.md` v1.8 (2026-11-20); implementata e rilasciata con la 1.7.3. Integra [ADR-0047](0047-apertura-file-per-tipo-e-presentazioni-marp.md) (il predicato «si apre in una scheda») e generalizza la decisione 5 di [ADR-0060](0060-web-viewer-acceso-di-default.md) (nomi senza `.webapp`) |
| **Recepito in**       | `Specifications.md` v1.8 (2026-11-20): §2.2.1 (riga «Web viewer» e, nella parte facoltativa, riga «Creare note, rinominare…») e Appendice C.4; [`spec-v1.8-proposta.md`](../spec-v1.8-proposta.md) §4 resta come storia                                                                                                                                         |
| **Data**              | 2026-11-19                                                                                                                                                                                                                                                                                                                                                      |
| **Riferimenti spec**  | §2.2.1 (riga «Web viewer», `Specifications.md:372`, che dice «nome senza `.webapp`»); l'apertura dei file per tipo (ADR-0047) non ha una riga nello spec v1.7; ADR-0037 e ADR-0045                                                                                                                                                                              |
| **Devia dallo spec?** | **no** (nessun comportamento dello spec contraddice questo ADR). **Recepito nello spec v1.8** (2026-11-20; [`spec-v1.8-proposta.md`](../spec-v1.8-proposta.md) §4): la riga «Web viewer» di §2.2.1 (`:372`), dove il nome senza `.webapp` diventa un caso della regola generale, e, facoltativa, una frase nella riga «Creare note, rinominare…» (`:336`)       |
| **Superfici**         | desktop e workbench web: lo stesso codice (`packages/workbench`), stesse prove vitest; e2e sul mock dei binding e sul core WASM · console e cloud: non applicabile · **nessuna modifica Go**, nessuna modifica di API, database o sync. Registro di parità: nessuna voce nuova                                                                                  |

## Contesto

Richiesta dell'owner del 2026-11-19: le estensioni dei file che l'app sa aprire non vanno mostrate; vanno mostrate solo per i file che si aprono fuori dall'app; la rinomina non deve mostrare né far cambiare l'estensione.

Oggi (albero al commit `db1b9d6a`):

- L'esploratore toglie solo `.md` e `.webapp` (`packages/workbench/src/sidebar/FileExplorer.tsx`, `display`, riga 103), le schede solo gli stessi due (`workspace/TabBar.tsx`, `label`, righe 17-18). Un disegno compare come `Piano.excalidraw`, una lavagna come `Piano.canvas`, una presentazione come `Review.marp`.
- Una trentina di punti (intestazioni delle viste, pannelli dei collegamenti, embed, anteprime, selettori) hanno ognuno la propria espressione regolare.
- La rinomina preriempie il prompt con il nome intero, estensione compresa (`FileExplorer.tsx`, `rename`, riga 195; comando `note:rename`, `commands/registry.ts`, `renameActive`, riga 145), e usa quello che l'utente scrive. Il comando aggiunge `.md` solo a una nota; per un `.excalidraw` o un `.canvas` chi dimentica l'estensione cambia il tipo del file e lo rende illeggibile all'app.

Il predicato di ADR-0047 esiste già: `openTarget(path)` (`packages/workbench/src/embeds/media.ts:90`) risponde `'in-app'` per note, `.marp`, disegni, lavagne, basi, applicazioni, immagini, PDF, audio e video, e `'external'` per ogni altro file, compresi quelli senza estensione (`LICENSE`, `.gitignore`).

## Decisione

1. **«Supportato» è `openTarget(path) === 'in-app'`.** L'estensione si nasconde per quei file; per quelli che si aprono fuori dall'app (`.docx`, `.zip`, `LICENSE`, `.gitignore`) il nome si mostra intero, estensione compresa. Le cartelle non passano di qui: il nome intero.
2. **Un solo helper**, in `packages/workbench/src/embeds/media.ts`, accanto a `classify` e `openTarget`:
   - `splitName(name): { stem, ext }`: `ext` è l'estensione conservata, con il punto e con il caso originale, solo se `openTarget(name) === 'in-app'`; altrimenti `stem` è il nome intero e `ext` è vuoto. `a.b.canvas` → `a.b` e `.canvas`; `Foo.MD` → `Foo` e `.MD`.
   - **Caso legacy:** `X.excalidraw.md` (i disegni del plugin Excalidraw di terze parti, che sono note) → `stem = 'X'`, `ext = '.excalidraw.md'`.
   - `displayName(pathOrName): string`: `splitName` sul nome base, restituisce `stem`.
   - `pickItems(paths): { value, label }[]`: gli elementi di un selettore di file (`dialog.pick`) con l'etichetta di `displayPath`. Nei selettori che **mescolano tipi** (lavagna: aggiungere nota o media; disegno: immagini, disegni e note incorporati) due file possono avere la stessa etichetta senza estensione (`Piano.pdf`, `Piano.png`, `Piano.marp`): se due etichette coincidono, **senza badare alle maiuscole**, tutte le voci in conflitto mostrano il **percorso completo con l'estensione** (un selettore non ha icone per distinguerle). Usato da `canvas/CanvasView.tsx` (`canvas.addNote`, `canvas.addMedia`) e `drawing/embed/commands.ts` (immagini, disegni, note).
   - `displayPath(path): string`: il percorso come lo mostra l'interfaccia, con le cartelle com'è e il nome del file senza l'estensione nascosta (`Cartella/Piano.canvas` → `Cartella/Piano`). Serve dove un nome è mostrato **con la cartella**: intestazioni delle viste (note, disegni, lavagne), titoli di recupero e cronologia, conferma del cestino, elenchi dei selettori `dialog.pick`, pannello dei collegamenti inversi (la riga di una nota), avvisi degli embed non apribili. Dove basta il nome (schede, esploratore, pannelli) si usa `displayName`.
   - `nameOf` di `webapp/model.ts` resta esportato per compatibilità interna, ma è scritto sull'helper.
3. **Dove si applica:** esploratore (riga e ordinamento), schede, titoli di grafo, intestazioni delle viste (note, disegni, lavagne, basi, applicazioni), pannelli di collegamenti inversi, collegamenti e segnalibri, embed e anteprime, esportazione, recupero, cronologia e conflitti, selettori di file (`dialog.pick`, compreso quello delle immagini dei disegni, che prima mostrava l'estensione) e conferma del cestino (il percorso senza estensione per i file, intero per le cartelle). Le regole locali con `.replace(/\.md$/, '')` e simili si sostituiscono con l'helper. Il pannello dei collegamenti oggi toglie l'estensione anche ai file non supportati: va corretto (il nome intero).
4. **Ordinamento dell'esploratore** sul nome visualizzato, con l'estensione come spareggio: una nota `Piano` e una lavagna `Piano` restano vicine e l'ordine è stabile; l'icona li distingue e il tooltip mostra il percorso.
5. **Rinomina, un solo percorso.** Una funzione `promptRename(entry)` in `packages/workbench/src/app/actions.ts`, usata dall'esploratore (menu e F2) e dal comando `note:rename`; il calcolo del percorso nuovo è la funzione pura `renameTarget(path, isDir, input)` (stesso file), che si prova da sola:
   - il prompt è preriempito con `stem`; il percorso nuovo è `cartella + stem' + ext`, con `ext` quella **originale** del file;
   - se ciò che l'utente scrive termina già con la stessa estensione (senza badare alle maiuscole), non la si raddoppia: `Foo.excalidraw` per un disegno resta `Foo.excalidraw`, non `Foo.excalidraw.excalidraw` (tollera l'abitudine di chi la digita e le prove e2e esistenti);
   - **un'altra estensione digitata resta parte del nome:** `Foo.txt` su una nota diventa `Foo.txt.md`. L'estensione non si cambia dalla rinomina, come richiesto;
   - **il nome digitato è sempre rifilato** (spazi ai lati tolti), anche per i file non supportati e le cartelle; nome vuoto o di soli spazi, o nome uguale all'attuale: nessuna azione;
   - file non supportati e cartelle: il prompt mostra il nome intero, come oggi;
   - tutto il resto passa da `renameEntry` (`app/actions.ts`): aggiornamento dei collegamenti, conferme, segnalibri. Il trascinamento di un file in un'altra cartella non cambia il nome e non passa di qui.
6. **Invariati.** Il **testo che i collegamenti inseriscono** (`editor/completionEngine.ts`, `linkTextFor`): un `.marp` resta `Review.marp` perché i collegamenti si risolvono per estensione nel core Go; i **percorsi** nei tooltip; il **selettore rapido** e la **ricerca**, che mostrano già il titolo senza estensione dall'indice Go.
7. **Nessuna modifica Go né di protocollo.** Il binding di rinomina non controlla le estensioni; il nome sul disco, sulla sync e nel cloud è quello di sempre.
8. **Parità** (ADR-0037, ADR-0045): lo stesso codice condiviso per desktop e workbench, quindi nessuna voce nuova nel registro; si aggiorna la nota della voce dell'esploratore in `shared/parity/features.yaml`. Prove: vitest per `splitName`, `displayName` e `promptRename` (casi `.md`, `.MD`, `.excalidraw.md`, `.png`, `.docx`, `LICENSE`, `.gitignore`, `a.b.canvas`), aggiornamento dei test che oggi aspettano l'estensione, e2e sul mock dei binding e sul core WASM, con un caso nuovo: rinominare un disegno da F2 conserva `.excalidraw`.

## Alternative considerate

- **Togliere solo `.md` e `.webapp` (lo stato attuale), aggiungendo caso per caso** — scartata: è la causa delle trenta regole locali, e ogni tipo nuovo ripete il difetto.
- **Un elenco di estensioni nascoste separato da `openTarget`** — scartata: due elenchi si disallineano; «supportato» è per definizione ciò che si apre in una scheda (ADR-0047).
- **Mostrare l'estensione nella rinomina e lasciarla modificabile** — scartata dall'owner: è il difetto segnalato (si perde il tipo del file).
- **Rendere l'estensione una parte non modificabile del campo** — scartata: un campo composto complica la tastiera e i lettori di schermo; il prompt senza estensione e la sua ricollocazione danno lo stesso risultato.
- **Cambiare anche il testo inserito dai collegamenti** — scartata: i collegamenti si risolvono per estensione (`Review.marp`), e una forma senza estensione ne cambierebbe il significato.
- **Una regola dentro il core Go (titolo dell'indice)** — non necessaria: il core già dà il titolo senza estensione; la regola serve solo all'interfaccia.

## Conseguenze

- Ciò che si apre nell'app si legge ovunque senza estensione; due file con lo stesso nome e tipi diversi (`Piano` nota e `Piano` lavagna) sono distinguibili solo dall'icona e dal tooltip: è il costo accettato.
- Rinominare non può più cambiare il tipo di un file supportato; per farlo servono il file system o un altro comando. Chi vuole davvero un'altra estensione non ha un modo dall'app: limite dichiarato.
- Per i file non supportati nulla cambia.
- Un utente abituato a digitare l'estensione continua a funzionare (non si raddoppia).
- Da verificare a mano, con il runbook [`docs/qa/m22-nomi-file-e-applicazioni.md`](../qa/m22-nomi-file-e-applicazioni.md): l'esploratore su un vault reale (`Desktop_UI`, `SlideClarae`, `SATAP` senza estensione) e la rinomina con F2 su un disegno, un canvas, una presentazione e un file non supportato.
