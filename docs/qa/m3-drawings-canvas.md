# Checklist manuale — disegni e canvas (M3)

Da eseguire sul webview reale (macOS, Windows, Linux). Gli e2e automatici (`yarn workspace @memobrain/desktop-frontend e2e`) coprono apertura, modifica, salvataggio, embed e l'assenza di richieste di rete sul mock dei binding; qui si verifica ciò che solo il webview reale mostra. **Eseguire con la rete scollegata.**

Segnare `[x]` con data e sistema operativo.

## Disegni (Excalidraw)

- [ ] Palette → "Nuovo disegno": il file `Drawing …excalidraw` compare nell'explorer e si apre in una tab; se invocato da una nota in modifica, la nota riceve `![[Drawing ….excalidraw]]`.
- [ ] Il testo dei disegni usa i font di Excalidraw (Excalifont, Virgil…) anche offline: nessun quadratino o font di ripiego.
- [ ] Disegno con forme, frecce, testo e un'immagine incollata: dopo ~2 s "Salvato"; chiudi e riapri: identico.
- [ ] Tema chiaro/scuro: l'editor segue il tema dell'app; lingua italiana/inglese.
- [ ] Esporta → PNG 1×, 2×, 3× con e senza sfondo, SVG: i file compaiono accanto al disegno; "Copia negli appunti" incolla l'immagine in un'altra app.
- [ ] Zen e Presenta (schermo intero in sola lettura; Esc per uscire).
- [ ] Libreria: aggiungi un elemento, riapri il vault: presente; il file `excalidraw-library.json` nella cartella di configurazione del vault si sincronizza (e, dalla 1.6, si fonde forma per forma).
- [ ] Disegno > 10 MB: banner di avviso, il salvataggio funziona.
- [ ] Vault privato bloccato: il disegno è in sola lettura.
- [ ] Modifica del file dall'esterno con la tab aperta e nessuna modifica locale: la tab mostra la nuova versione (anche sfondo e griglia); con modifiche locali non salvate: le due versioni si fondono (1.6, ADR-0054); se la fusione non è ammessa o non riesce: banner di conflitto con _Ricarica_, _Sovrascrivi_ e _Tieni entrambe_.

## Navigazione, fusione e libreria (M18, 1.6; ADR-0053, ADR-0054)

Da eseguire sul webview reale: gli e2e usano Chromium con i binding simulati e il core WASM, e il posizionamento dei pulsanti dipende dalle classi del fork di Excalidraw.

- [ ] In basso a sinistra, a destra del controllo dello zoom, ci sono _Zoom sulla selezione_ e _Mini-mappa_: non coprono il controllo, seguono la sua larghezza quando cambia la percentuale e restano al loro posto cambiando la dimensione della finestra e lo zoom dell'app.
- [ ] _Zoom sulla selezione_ con una forma selezionata la inquadra senza finire sotto la barra inferiore; senza selezione inquadra tutto il disegno; funziona anche in sola visualizzazione e su un vault in sola lettura.
- [ ] _Mini-mappa_: un disegno grande, clic e trascinamento spostano la vista, le frecce (con Maiusc a passi più larghi) e Home funzionano con il focus sulla mini-mappa; si nasconde in Zen, in presentazione e mentre è aperto il menu degli stili (finestra bassa, 720 px); resta accesa o spenta dopo aver chiuso e riaperto l'app, e non cambia su un altro dispositivo.
- [ ] Disegno aperto in due pannelli: una modifica nel primo compare nel secondo; la scheda _Slide_ della barra destra segue il pannello a fuoco e non resta vuota quando l'altro pannello passa a un altro file.
- [ ] Modificare il file fuori dall'app (anche con la sincronizzazione) mentre ci sono modifiche non salvate: le due modifiche restano, senza banner; mentre si trascina una forma la fusione aspetta la fine del gesto. Un file ridotto a testo non valido: avviso con la sola scelta _Sovrascrivi_ e il file non viene riscritto da solo.
- [ ] Vault condiviso, una modifica di un altro utente a un disegno aperto con modifiche non salvate: banner con _Tieni entrambe_ (la tua versione resta in una copia accanto al file).
- [ ] _Annulla_ dopo una modifica arrivata da fuori non la annulla; dopo un'azione sulla scena la annulla in un passo.
- [ ] Tema scuro e tema «Sistema» (cambiandolo dalle impostazioni del sistema operativo con l'app aperta): gli embed di un disegno in una nota passano alla versione scura e viceversa; la stampa della nota usa la chiara.
- [ ] La ricerca trova una parola che in un testo del disegno va a capo dentro la forma, e il TeX di una formula; dopo l'aggiornamento dalla 1.5 il primo avvio rianalizza i disegni (può impiegare di più).
- [ ] Libreria: aggiungere una forma in un pannello la mostra subito nell'altro; due dispositivi che aggiungono forme diverse le tengono entrambe dopo la sincronizzazione.

## Azioni sulla scena, esportazione e strumenti (ADR-0024)

Da eseguire sul webview reale (gli e2e usano Chromium con i binding simulati).

- [ ] Palette → "Disegno: apri il pannello strumenti": cerca, esegui un'azione, aggiungi ai preferiti, riapri il vault: il preferito resta.
- [ ] Boolean Operations (unione, intersezione, differenza, xor) su due forme sovrapposte; Split Ellipse: il risultato è corretto anche dopo la riapertura.
- [ ] Auto Layout su un diagramma con frecce legate: le frecce seguono le forme; ridimensiona una forma con "Imposta dimensioni": le frecce restano attaccate.
- [ ] Mindmap da un testo-elenco indentato, calendario annuale e lineare, vignette, nuvolette, schema colori, linea organica.
- [ ] Penne (fine, pennarello, evidenziatore) e puntatore laser: lo strumento cambia e il tratto ha stile e opacità attesi.
- [ ] Menu ⋮ della barra: _Disegna per la forma_ (Maiusc+X: un tratto diventa una forma), _Secchiello riempimento_ (B: riempie forma/area cliccata), _Selezione a lazo_ (seleziona gli elementi circondati). Barra e menu al 90%, senza il pulsante del menu principale; popover dei colori allineati.
- [ ] Barra destra → _Slide_ con un disegno di 3 cornici: miniature corrette, su/giù cambia l'ordine di presentazione, l'occhio esclude una cornice ("2 di 3 incluse"), le note del relatore si salvano e compaiono nella presentazione, Stampa produce un PDF con una cornice per pagina, ripetizione/contatore/note si applicano.
- [ ] Presentazione con 3 cornici: frecce/Spazio/Pagina navigano con animazione, il selettore salta, Esc esce; in schermo intero la cornice si adatta. Senza cornici: presentazione semplice.
- [ ] Esporta → PNG/SVG con selezione, cornice, scala e "incorpora scena"; "Stampa / PDF…" produce un PDF; "Salva con nome…" apre la finestra nativa.
- [ ] Esportazione automatica (anche l'override per singolo disegno): `Disegno.excalidraw.png/.svg` accanto al file 15 secondi dopo l'ultimo salvataggio e subito alla chiusura del disegno (dalla 1.6, non a ogni salvataggio).
- [ ] LaTeX (inserisci, doppio clic per modificare, reimposta dimensione) e Mermaid (testo → diagramma) senza richieste di rete.
- [ ] Trascina dal file explorer sul canvas: immagine, nota (scheda) e altro disegno nel punto di rilascio.
- [ ] Copia un `.excalidraw.md` dei plugin Excalidraw di terze parti (con un'immagine incorporata) nel vault → "Converti…": nasce `.excalidraw` accanto, apribile e con l'immagine; l'originale è intatto.
- [ ] Importa un `.excalidrawlib` copiato nel vault: le forme compaiono nella libreria; "Esporta la libreria" crea `Library.excalidrawlib`.
- [ ] Embed con `|left`, `|right-wrap` e `#frame=Nome`: allineamento e porzione corretti in Live Preview e Lettura.
- [ ] Inserire un'immagine oltre 10 MB è rifiutato con un messaggio chiaro; la ricerca trova il nome di una cornice.
- [ ] Sul **bundle di produzione** nel webview reale (CSP stretta): formule LaTeX, Mermaid, PDF incorporati, grafo e font di Excalidraw funzionano senza richieste di rete e senza errori in console.
- [ ] Presentazione con note del relatore: le note compaiono sotto la diapositiva; "Descrivi il disegno come testo" è leggibile con VoiceOver/NVDA.
- [ ] Un profilo di configurazione con `drawing_latex: false` nasconde formule (comandi, doppio clic) e pannello Strumenti; `drawing_auto_export: false` ferma l'esportazione automatica.
- [ ] Rinomina una nota linkata da un elemento del disegno: il link nel `.excalidraw` è riscritto.

## Embed e ricerca

- [ ] `![[disegno.excalidraw]]` e `![[disegno.excalidraw|400]]` in Live Preview e in Lettura: immagine con la larghezza richiesta; doppio clic apre il disegno.
- [ ] Modifica il disegno e torna alla nota: l'anteprima è aggiornata (nuova cache per hash).
- [ ] Un elemento con link `[[Nota]]` compare nei Backlink della nota come "Disegno: …".
- [ ] La ricerca trova il testo scritto dentro il disegno.

## Canvas

- [ ] Palette → "Nuova lavagna": file `Canvas ….canvas`, tab con barra degli strumenti.
- [ ] Doppio clic sulla lavagna aggiunge una scheda di testo; Markdown, math ed embed (`![[…]]`) si vedono a riposo.
- [ ] Aggiungi nota, media (immagine, PDF, audio), link web, gruppo; ridimensiona dall'angolo; trascina un gruppo: i nodi interni lo seguono.
- [ ] Trascina da una maniglia di una scheda su un'altra: nasce il collegamento; doppio clic sul collegamento per l'etichetta.
- [ ] Colori preset 1–6 su nodi e collegamenti; Annulla/Ripristina (⌘/Ctrl+Z, ⌘/Ctrl+Shift+Z); Elimina.
- [ ] Zoom con pizzico/⌘+rotella, pan con trascinamento o rotella; "Adatta al contenuto".
- [ ] Un `.canvas` in formato JSON Canvas creato da un altro editor si apre e, riscritto da MemoBrain Notes, si riapre in quell'editor senza perdite.
- [ ] `![[mappa.canvas]]` in una nota: immagine statica; doppio clic apre la lavagna.

## Due dispositivi

- [ ] Disegno modificato in punti diversi sui due dispositivi: convergono senza copie di conflitto.
- [ ] Stesso nodo di un canvas modificato su entrambi: una versione resta, l'altra diventa una copia di conflitto; nulla va perso.
