# Checklist manuale — parità con Obsidian (M1)

Da eseguire sul webview reale (macOS, Windows, Linux) con un vault Obsidian esistente, senza conversioni. Gli e2e automatici (`yarn workspace @memobrain/desktop-frontend e2e`) coprono i flussi principali sul mock dei binding; qui si verifica ciò che solo il webview reale mostra.

Segnare `[x]` con data e sistema operativo.

## Apertura vault

- [ ] "Apri cartella come vault" su un vault Obsidian reale: albero completo, `.obsidian/` non mostrato, nessuna modifica ai file all'apertura.
- [ ] Indice iniziale con barra di avanzamento in basso; dopo il termine la ricerca restituisce risultati.
- [ ] Chiusura e riapertura: tab, split e barre laterali ripristinati (`.memobrain/workspace.json`); un file cancellato nel frattempo non lascia tab vuote.

## Link

- [ ] `[[Nota]]`, `[[Nota|alias]]`, `[[Nota#Heading]]`, `[[Nota#^blocco]]`, `[[#Heading]]` si risolvono come in Obsidian (percorso più breve, alias del frontmatter).
- [ ] Link non risolto: stile "fantasma"; clic con ⌘/Ctrl crea la nota.
- [ ] Rinomina di un file dall'explorer: anteprima "N link in M note", i link sono riscritti, le tab seguono il nuovo nome.
- [ ] Spostamento via drag&drop in una cartella: stesso comportamento.
- [ ] Backlink e menzioni non collegate coerenti con Obsidian.

## Editor

- [ ] Live (editor WYSIWYG Milkdown; Live Preview in Obsidian): heading, grassetto/corsivo/barrato/evidenziato, codice inline e blocchi, citazioni, liste, task (checkbox cliccabile), tabelle, footnote, tag, commenti `%%`.
- [ ] Differenza voluta rispetto a Obsidian (ADR-0049): in Live i simboli Markdown non riappaiono sulla riga del cursore (la nota è WYSIWYG); riappaiono per wikilink, embed e commenti `%%` quando il cursore li tocca, e in Sorgente. Frontmatter nascosto e mostrato in Properties.
- [ ] Callout (tutti i tipi, titolo personalizzato, `+`/`-` ripiegabili).
- [ ] Math `$…$` e `$$…$$`; diagramma mermaid; errori di sintassi mostrati senza rompere la nota.
- [ ] Embed: nota intera, `#heading`, `#^blocco`, immagine con `|300` e `|300x200`, PDF `#page=2`, audio, video; embed circolare → avviso.
- [ ] Autocompletamento `[[` (note, alias, `#heading`, `#^blocco`), `#tag`, nomi proprietà.
- [ ] Hotkey: ⌘B/I, ⌘K, ⌘⇧K, ⌘1…6, ⌘⏎ (task), ⌘E (reading), ⌘O, ⌘P, ⌘N, ⌘\ (split), ⌘W.
- [ ] Incolla: URL su selezione → link; HTML → Markdown; immagine → allegato + `![[…]]`.
- [ ] Modifica esterna mentre la nota è aperta: senza modifiche locali si aggiorna; con modifiche locali compare il banner Ricarica/Sovrascrivi.
- [ ] Digitazione fluida (nessun lag percepibile) su una nota da ~1 MB: oltre 250.000 caratteri la nota si apre in Sorgente (con avviso), quindi la prova va fatta in Sorgente; in Live provare una nota di 200 kB (apertura attesa circa 2,5 s in Chromium headless, da confermare sulla webview reale).

## Reading view

- [ ] Resa equivalente alla Live Preview; wikilink e tag cliccabili; callout, task con stati personalizzati; HTML pericoloso (`<script>`, `onerror`) non eseguito.

## Properties, tag, outline

- [ ] Properties tipizzate (testo, lista, numero, casella, data, data/ora): modifica riscrive il frontmatter preservando ordine e commenti.
- [ ] Vista Tags gerarchica con conteggi; clic filtra la ricerca. Outline segue i titoli e porta alla riga.
- [ ] Barra di stato (facoltativa, spenta per default, ADR-0035): parole, caratteri, selezione, riga:colonna, modalità; spenta, gli stessi conteggi sono nella scheda _Statistiche_.

## Workspace e impostazioni

- [ ] Split orizzontale/verticale, trascinamento tab tra pannelli, pannelli collegati, ridimensionamento.
- [ ] Palette comandi, selettore rapido (⌘⏎ nuova tab, crea se manca).
- [ ] Impostazioni: editor, file e link, aspetto, hotkey (registrazione, conflitti, ripristino), cloud, informazioni; `memobrain://open?vault=&file=` apre la nota.

## Limiti noti

- Ricerca su vault da 50k note: risolto in M7-WP1 con la cache dei candidati (ADR-0020): 0,03-0,14 s misurati; le regex sull'intero vault restano ≈ 0,45 s (`docs/perf/README.md`).

## M6 — funzioni P1 residue

Da eseguire sul webview reale (le parti automatiche sono coperte da Vitest, Go e Playwright sul mock).

- [ ] **Grafo** (⌘⇧G): globale e locale (pulsante nei backlink); filtri, gruppi colore per query, forze, timelapse; click apre la nota, ⌘/Ctrl-click in nuova tab, nodo fantasma crea la nota; su un vault da 10k note pan/zoom fluidi e ≥ 30 fps (annotare macchina e webview: la misura headless è in `docs/qa/m6-graph-benchmark.md`).
- [ ] **Bases**: nuova base dal menu cartella; viste tabella/card, ordinamento, raggruppamento, filtro semplice, modifica inline di una property (il frontmatter cambia, il resto della nota no); `![[x.base#Vista]]` in Live Preview e Reading; un `.base` di Obsidian con chiavi sconosciute resta intatto dopo una modifica.
- [ ] **Daily/unique note**: "Apri nota di oggi" crea dal template, giorno precedente/successivo; formato con `/` crea sottocartelle; unique note con prefisso timestamp.
- [ ] **Template**: inserisci template con `{{date:FORMAT}}`, `{{time}}`, `{{title}}`; con la libreria di gruppo montata compaiono anche i template di gruppo (sola lettura).
- [ ] **Composer**: unisci note (anteprima "N link in M note", link reindirizzati, sorgente nel cestino); estrai selezione in nuova nota sostituendola con `[[link]]`.
- [ ] **Slash `/`** in una riga vuota apre il menu; non compare in codice, frontmatter, URL; si disattiva nelle impostazioni. **Nota casuale** non riapre la corrente.
- [ ] **Bookmarks**: nota, heading, blocco, ricerca, gruppi con trascinamento; rinominare un file aggiorna il segnalibro; un file cancellato resta barrato; `.memobrain/bookmarks.json` si sincronizza, `workspaces.json` no.
- [ ] **Workspaces**: salva, carica (le modifiche non salvate vengono scritte prima), elimina; le tab di file inesistenti vengono scartate.
- [ ] **Page preview**: ⌘/Ctrl + passaggio sul wikilink (o sempre, da impostazione) mostra l'anteprima di nota/heading/blocco; Esc chiude; nessun contenuto remoto.
- [ ] **Importer** (wizard "Importa…"): una cartella Markdown, un ENEX, uno zip Notion, un JSON Roam, un Bear, un Takeout Keep, un CSV — **con export reali**, annotando differenze rispetto ai fixture; il report finale e la nota "Import report" sono corretti; nessun file esistente viene sovrascritto.
- [ ] **File recovery**: modifica una nota, attendi lo snapshot (5 min o riducilo), apri "File recovery": versioni locali (e cloud se collegato) con diff; ripristina; "Recupera file eliminati".
- [ ] **Blocco ```query**: risultati live in Live Preview e Reading, errore inline, "mostra altri".
- [ ] **Export HTML/PDF**: l'HTML si apre offline, senza script né risorse remote; il PDF dal dialogo di stampa del sistema su macOS, Windows e Linux (limiti in ADR-0019).

## Disegni: parità con i plugin Obsidian Excalidraw ed Excalidraw Extras (ADR-0024)

| Funzione del plugin                                                                                               | Stato                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Formato `.excalidraw` in chiaro, link agli elementi, embed di parti, allineamento                                 | fatto                                                                                                    |
| Esportazione PNG/SVG (selezione, cornice, scala, scena incorporata), PDF, auto-export                             | fatto                                                                                                    |
| Inserimento di immagini, note e disegni; trascinamento dal vault                                                  | fatto (le note sono schede, non snapshot SVG)                                                            |
| LaTeX (MathJax), Mermaid                                                                                          | fatto, offline                                                                                           |
| Presentazione a diapositive, note del relatore, laser, penne                                                      | fatto                                                                                                    |
| Script Library: layout, colore/stile, forme, frecce, testo, generatori, mappa mentale, calendari                  | fatto come azioni native (niente script utente, V-02/D-01)                                               |
| Import `.excalidraw.md` e `.excalidrawlib`                                                                        | fatto (le formule LaTeX diventano immagini con il TeX in `customData`; l'editor le disegna all'apertura) |
| Icon Library, Image Occlusion, LayerManager, Crop Vintage Mask, Capture Note, Folder Note, "Fixed inner distance" | non implementati nella 1.0.0                                                                             |
| Collaboration Frame                                                                                               | escluso (D-04: niente collaborazione in tempo reale)                                                     |
| Scribble Helper, Hardware Eraser / Auto Draw for Pen                                                              | esclusi (richiedono una penna fisica)                                                                    |
| ExcaliAI, OCR, miniature YouTube, immagini da URL, Script Library da GitHub                                       | esclusi (rete: ADR-0005)                                                                                 |
| Modalità per mancini                                                                                              | non disponibile in Excalidraw 0.18                                                                       |

## Limiti noti (aggiornati)

- Embed `![[x.canvas]]` ed `.excalidraw` come in M3; `.base` ora supportato (sottoinsieme in ADR-0014).
- Il grafo usa Canvas 2D; se un portatile datato scende sotto 30 fps a 10k nodi la via di riserva è pixi.js (ADR-0013).
