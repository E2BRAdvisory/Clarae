# ADR-0048 — Presentazioni Marp: editor a tutta larghezza, tab SlideShow, export nel ribbon e PPTX modificabile

|                       |                                                                                                                                                                                                                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stato**             | accettata                                                                                                                                                                                                                                                                                                      |
| **Data**              | 2026-11-05                                                                                                                                                                                                                                                                                                     |
| **Riferimenti spec**  | §2.2.1 (matrice funzioni), §2.3 (editor e rendering), §3.4.5 (strategia per tipo di file); V-02/D-01, D-04, V-07; ADR-0020, ADR-0027, ADR-0045, ADR-0047                                                                                                                                                       |
| **Devia dallo spec?** | sì, come ADR-0047: §2.2.1 (righe «Presentazioni Marp» e «Export»: vista, tab SlideShow, ribbon, PPTX), §3.4.5 (`.marp` nella riga «Markdown»), §3.4.6 (`.marp` nel contenuto sincronizzato) → richiede aggiornamento di `Specifications.md` da parte dell'owner, che deve recepire insieme ADR-0047 e ADR-0048 |
| **Superfici**         | desktop (editor, tab SlideShow, ribbon, binding `ExportAPI.SaveFile`) · workbench web (stessa UI sul core WASM; il PPTX viene scaricato; prove sul core nella matrice `e2e:workbench-ui`) · console: nessuna · cloud: nessuna (il server non interpreta il contenuto)                                          |

## Contesto

[ADR-0047](0047-apertura-file-per-tipo-e-presentazioni-marp.md) (1.3.3) ha introdotto i file `.marp` con una vista divisa: editor a sinistra, anteprima delle slide a destra, pulsanti Presenta / HTML / PDF / PPTX (quest'ultimo disabilitato). L'uso ha mostrato tre problemi:

- la vista doppia occupa spazio e duplica ciò che i disegni già offrono nel tab **SlideShow** della sidebar destra (cornici, card, riordino, esclusione, note, presentazione a tutto schermo); per un `.marp` quel tab mostra invece «Apri una nota Markdown per presentarla»;
- sul `.marp` compaiono i pulsanti Live / Sorgente / Lettura, che non hanno effetto: `.mode-toggle { display: flex }` annulla l'attributo `hidden`;
- gli export sono nella barra della vista, non nel ribbon dove stanno quelli di note e disegni, e il PPTX manca.

Vincoli invariati rispetto ad ADR-0047: nessun CSS dell'autore e HTML sanificato (V-02/D-01), offline, CSP con `frame-src 'none'` e senza `unsafe-eval`, finestra singola (V-07), parità desktop/web per costruzione (ADR-0045), budget dei bundle (ADR-0020).

## Decisione

### 1. Vista

La vista divisa di ADR-0047 §4 è tolta. Un `.marp` si apre come una nota, con lo stesso ramo editor di `workspace/NoteView`, a tutta larghezza e con la modalità forzata a Source. I pulsanti Live / Sorgente / Lettura non compaiono per i `.marp`; il difetto CSS si corregge con `.mode-toggle[hidden] { display: none }`. L'anteprima vive solo nel tab SlideShow e nella presentazione a tutto schermo. Restano `marp:new`, il flag `presentations` e le regole di rendering di ADR-0047 §3.

### 2. Modello delle slide

Un modulo puro (`marp/slides.ts`) ricava dal testo, per ogni slide: indice, righe di inizio e fine, titolo (primo heading, altrimenti la prima riga di testo), note e stato incluso/escluso. Le slide sono i blocchi tra i separatori `---` (frontmatter e blocchi di codice esclusi) o, con `headingDivider`, le sezioni per heading.

- **Escludere una slide** aggiunge `<!-- memobrain: hidden -->` nel suo blocco; includerla lo toglie (idempotente). Il commento non è una direttiva di Marp, quindi per Marp è una nota: un client ≤ 1.3.3 e gli altri strumenti Marp mostrano comunque la slide e possono trattare il commento come nota del relatore. L'esclusione vale quindi solo in MemoBrain Notes: è una scelta di compatibilità accettata.
- **Note del relatore**: i commenti HTML che non sono direttive di Marp, né il marcatore `memobrain: hidden`, né commenti di strumenti (`prettier-ignore`, `markdownlint-*`, `lint disable|enable|ignore`, che Marpit tiene fuori dalle note); la convenzione nativa di Marp. Più note nella stessa slide si uniscono, separate da una riga vuota.
- **Che cosa è una direttiva** (`DIRECTIVE_KEYS` in `marp/slides.ts`, che un test confronta con il motore): un commento che è una mappa YAML con almeno una chiave di direttiva. Le globali sono `theme`, `style`, `headingDivider`, `lang`, `size`, `math`; le locali `class`, `paginate`, `header`, `footer`, `backgroundColor`, `backgroundImage`, `backgroundPosition`, `backgroundRepeat`, `backgroundSize`, `color`, anche con il prefisso `_` (valgono per una sola slide). Vale anche la forma flow-YAML (`{theme: gaia}`). Chiavi come `title`, `author` o `transition` non sono direttive di Marp Core: per esso sono note.
- **Una nota che sembrerebbe una direttiva** (per esempio «theme: appunti») verrebbe letta da Marp come configurazione. Quando il pannello la scrive, la neutralizza (`neutralize`) inserendo un carattere invisibile U+200B dopo la chiave di direttiva; `displayNote` lo toglie, quindi non compare nel pannello, nella presentazione né nelle note del PPTX.
- **Dove si cercano i commenti**: non sono note, e non vengono mai toccati, i commenti dentro un code span, in un blocco di codice recintato o indentato. Una nota di una sola riga si riscrive sul posto. Una nota su più righe è sicura solo come blocco a colonna 0: se la nota esistente sta in una lista, in una citazione o in un paragrafo, viene tolta e la nuova è scritta come blocco in fondo alla slide.
- **Frontmatter**: le chiavi `memobrain-loop` (la presentazione riparte dopo l'ultima slide) e `memobrain-notes` (note visibili in presentazione) sono ignorate da Marp; `paginate` e `theme` sono le direttive native (temi `default`, `gaia`, `uncover`).
- **Riordino**: scambia i blocchi sorgente tra i separatori `---`. Non è disponibile con `headingDivider`, perché le slide non hanno separatori: il pulsante resta disabilitato con un tooltip.
- Ogni modifica (riordino, esclusione, note, frontmatter) è una transazione di CodeMirror su `getEditor(paneId)` (`marp/controller.ts`): si annulla con undo, non perde testo, ed è rifiutata se l'editor è in sola lettura. Lo stato letto dal pannello (`marp/deckStore.ts`) segue l'editor con 300 ms di attesa dopo la digitazione.
- **Numeri di pagina**: seguono il contatore di Marp (`paginate`, `_paginate: skip`, `hold`). Le slide escluse non lasciano buchi: `renumberPages` chiude lo scarto solo per le slide escluse che avevano fatto avanzare il contatore, e `includedDeck` applica lo stesso criterio alla presentazione e agli export.

### 3. Tab SlideShow per i `.marp`

`SlidesPanel` instrada i `.marp` a un pannello dedicato con le stesse funzioni di quello dei disegni:

- barra degli strumenti: presenta, stampa/PDF, informazioni (slide totali e incluse, tema, parole, note), impostazioni (loop, numeri di pagina, note in presentazione, tema), menu `…` (includi tutte, escludi tutte);
- riepilogo «n di m incluse» e una card per slide: titolo, miniatura (Shadow DOM con il CSS del tema, solo la slide), vai alla slide nell'editor, riordina, includi/escludi, presenta da qui;
- click su una card: la seleziona, sposta il cursore e apre la casella delle note, salvate come commenti HTML; la card della slide sotto il cursore è evidenziata;
- tutto disabilitato in sola lettura. `.excalidraw` e `.md` restano come oggi.

### 4. Presentazione a tutto schermo

Un overlay (come quello dei disegni, `util/fullscreen.ts`) mostra le slide incluse del testo corrente, comprese le modifiche non salvate, con gli stessi tasti e lo stesso loop dei disegni, la barra con slide precedente/successiva, selettore, «n / totale» e note se attive. Uscire dal tutto schermo chiude la presentazione. `marp:present` apre l'overlay. Il pannello e la presentazione sono caricati in modo lazy (`lazyView`), per restare nel budget del bundle iniziale (ADR-0020).

### 5. Export nel ribbon, per tipo di file attivo

Gli strumenti di creazione restano fissi; il gruppo export dipende dal tipo del file attivo:

| File attivo   | Pulsanti                                                         |
| ------------- | ---------------------------------------------------------------- |
| nota          | `note:export-pdf`, `note:export-image`, `note:export-html`       |
| disegno       | `drawing:export-png`, `drawing:export-svg`, `drawing:export-pdf` |
| presentazione | `marp:export-html`, `marp:export-pdf`, `marp:export-pptx`        |
| altro         | nessuno                                                          |

`note:export-pdf` diventa attivo solo per le note `.md` (oggi lo è per qualsiasi file). I tre comandi dei disegni sono nuovi (feature `drawing.export`): PNG e SVG aprono la finestra di esportazione con il formato preselezionato, PDF stampa l'intero disegno. I comandi dei disegni agiscono sul disegno della scheda attiva (`getSceneController(path?)` in `drawing/actions/active.ts`); se in primo piano c'è una nota, ripiegano sull'ultimo editor di disegni registrato. Per lo stesso motivo il rilascio di un file del vault su un disegno agisce su quel disegno (`dropVaultFile(path, at, drawingPath)`), anche se non è la scheda attiva. Le slide escluse sono saltate in tutti e tre gli export delle presentazioni.

### 6. PPTX modificabile

- Libreria `pptxgenjs` (MIT) a versione esatta (4.0.1 al momento della proposta), caricata on demand in un chunk lazy insieme al modulo `marp/pptx.ts`, senza rete e senza `eval`, compatibile con la CSP di desktop e Web UI.
- Pagina 16:9 (`LAYOUT_WIDE`); le slide escluse sono saltate e i numeri di pagina seguono Marp (`includedDeck`).
- **Mappatura dei contenuti** dall'HTML sanificato di `renderDeck`, con le immagini di `exportAssets`: h1–h6 → titolo o testo grande; paragrafi con grassetto, corsivo, codice e link come run di testo; `ul`/`ol` annidati → elenchi con livelli; `table` → tabella; `pre code` → testo monospazio; `img` → immagine; `blockquote` → testo rientrato; sfondi `![bg]` → immagine di sfondo; note del relatore → note PPTX; numero di pagina se c'è `paginate`.
- **Immagini non convertibili**: gli SVG sono disegnati in PNG su un canvas (nessun lato oltre 2000 px). Quelle che non si riesce a rasterizzare (per esempio SVG che il canvas rifiuta) sono saltate e segnalate all'utente (`deckToPptx` restituisce `skipped`, messaggio `marp.pptxSkipped`); il resto del file è salvato.
- **Tema approssimato**: colori e font per `default`, `gaia` e `uncover`, e classi `invert` e `lead`. Il risultato non è identico all'HTML: il testo è modificabile ma l'aspetto è una resa vicina, non fedele.
- **Salvataggio**: `ExportAPI.SaveFile` accetta un nuovo MIME `application/vnd.openxmlformats-officedocument.presentationml.presentation` → `.pptx`. Il lato Go apre l'archivio ZIP e richiede le voci `[Content_Types].xml` e `ppt/presentation.xml`; il limite `MaxBinaryBytes` non cambia. La firma dei binding non cambia. Nel workbench web il file è scaricato.
- `marp:export-pptx` si abilita con una presentazione aperta; la stringa «Non ancora disponibile» di ADR-0047 è tolta.

## Alternative considerate

- **PPTX come immagini (una per slide)** — scartata: il testo non sarebbe modificabile e, nel WebKit di macOS, il canvas viene bloccato (tainted) dagli SVG con `foreignObject`, quindi la rasterizzazione fallisce.
- **Marp CLI** — scartata: produce il PPTX con un Chromium headless, assente nella webview Wails e nel browser.
- **Mantenere la vista divisa** — scartata: duplica il tab SlideShow, occupa spazio e lascia l'editor stretto.
- **Escludere le slide con una chiave del frontmatter (elenco di indici)** — scartata: fragile al riordino e ai merge a 3 vie; il commento nel blocco segue la slide.

## Conseguenze

- Spec da aggiornare (owner), insieme ad ADR-0047: §2.2.1 (presentazioni, export per tipo di file, PPTX), §3.4.5 e §3.4.6 come da ADR-0047.
- ADR-0047 è parzialmente superata da ADR-0048 per la vista divisa (§4) e il PPTX rinviato (§5 e relative alternative e conseguenze); il resto resta valido.
- Compatibilità: il commento `<!-- memobrain: hidden -->` non è riconosciuto da client ≤ 1.3.3 né da altri strumenti Marp, che mostrano la slide e possono leggerlo come nota. Il merge a 3 vie dei `.marp` non cambia (sono ancora Markdown).
- Nuova dipendenza (`pptxgenjs`) da tenere aggiornata, nel chunk lazy e dentro i budget dei bundle; la CSP non cambia.
- La parità è registrata in `shared/parity/features.yaml` (voci `presentations` e `drawing.export`), con prove sul core WASM per il workbench.
- Debito accettato: la resa del tema nel PPTX è approssimata; il riordino non è disponibile con `headingDivider`.
