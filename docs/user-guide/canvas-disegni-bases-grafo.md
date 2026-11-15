# Lavagne, disegni, basi e grafo

## Lavagne (canvas)

_Nuova lavagna_ crea un file `.canvas` (formato JSON Canvas, compatibile con Obsidian): una superficie infinita con **schede** di testo, note, file, immagini e link, collegate da **frecce** con etichetta, e raggruppabili. Si usa con trascinamento, zoom con la rotella o i gesti del trackpad, selezione multipla e le scorciatoie indicate nella barra della lavagna. Le note incorporate si aprono con doppio clic.

## Disegni

_Nuovo disegno_ crea un file `.excalidraw` (JSON standard in chiaro, apribile anche con excalidraw.com), modificabile con l'editor di disegno integrato (forme, frecce, testo, tratto libero, librerie). Funziona **offline**: gli asset sono inclusi nell'app. Dove nasce il file, come si chiama e come si apre (modifica, sola lettura, zen) si sceglie in _Impostazioni > Disegni_; lì si fissano anche i colori, il carattere e la dimensione predefiniti dei nuovi elementi e l'esportazione automatica. Le impostazioni stanno in `.clarae/drawing.json` e viaggiano con il vault (in un vault della 1.x collegato al cloud possono stare ancora nella cartella con il nome precedente: vedi [Aggiornare dalla 1.x](installazione.md#aggiornare-dalla-1x)). I disegni creati con la 1.x si aprono come prima: i dati dei vostri elementi (formule, frame, schede delle note) e le impostazioni del singolo disegno passano al nome nuovo solo quando li modificate o salvate il disegno, e un dispositivo con la 1.4 non riconosce più, su un disegno salvato dalla 1.5, le formule modificabili e l'ordine delle diapositive.

### Nelle note

- `![[disegno.excalidraw]]` mostra un'anteprima; `|400` ne fissa la larghezza e `|left`, `|right`, `|center`, `|left-wrap`, `|right-wrap` l'allineamento. Doppio clic apre il disegno.
- Si incorpora anche **una parte**: `![[disegno.excalidraw#frame=Nome]]`, `#clippedframe=`, `#group=`, `#area=`.
- Un elemento con un link `[[Nota]]` (o un indirizzo web) lo apre con un clic; ⌘/Ctrl+passaggio ne mostra l'anteprima. Il testo del disegno (così come è stato scritto, anche quando è andato a capo dentro una forma), il TeX delle formule e i nomi delle cornici si trovano con la ricerca, i link compaiono nei backlink e, se rinomini la nota, il link nel disegno si aggiorna.
- Dal comando `/disegno` o da _Inserisci disegno_ si aggiunge un disegno alla nota.
- Il disegno incorporato segue il tema: in tema scuro la nota mostra la versione scura, e passa dall'una all'altra quando cambi tema (anche quando, con il tema «Sistema», è il sistema operativo a cambiarlo). Stampa ed esportazione della nota usano sempre la versione chiara.

### Dentro il disegno

- **Inserisci** immagini, note (come schede) e altri disegni dal vault, anche trascinandoli dall'esplorazione file nel punto desiderato; _Crea una nota e aggiungi la scheda_; _Sposta la selezione in un nuovo disegno_.
- **Formule LaTeX** (_Inserisci formula_, doppio clic per modificarla) e **diagrammi Mermaid** (testo → elementi modificabili): tutto locale, senza rete.
- **Azioni sulla scena** (palette dei comandi o pannello _Strumenti del disegno_, con ricerca, preferiti e usati di recente): distribuzione e allineamento, Auto Layout, colore e stile, schemi di colori, forme (riquadri, Boolean Operations, ellisse divisa), frecce (collega, a gomito, passo successivo), testo, ripetizione, mappa mentale da un elenco indentato, calendari, vignette e nuvolette, linea organica. Ogni azione si può annullare e ha un comando assegnabile a una scorciatoia.
- **Strumenti del plugin Obsidian** (menu ⋮ della barra): _Disegna per la forma_ (Maiusc+X) trasforma un tratto a mano libera in una forma, _Secchiello riempimento_ (B) riempie la forma o l'area cliccata, _Selezione a lazo_ seleziona gli elementi circondati da un tratto libero. Barra, pulsanti e menu sono al 90% della dimensione standard di Excalidraw; il menu principale di Excalidraw (ricerca, guida, link) non è mostrato.
- **Penne e puntatore laser**: penna fine, pennarello, evidenziatore e laser sono comandi con scorciatoia propria.
- **Libreria di forme**: è una sola per vault, condivisa da tutti i disegni aperti (una forma aggiunta in un pannello compare subito negli altri) e sincronizzata. Se due dispositivi aggiungono forme diverse, restano entrambe.
- **Navigazione**: accanto al controllo dello zoom, in basso a sinistra, _Zoom sulla selezione_ inquadra gli elementi selezionati, o tutto il disegno se non c'è selezione (funziona anche in sola visualizzazione), e _Mini-mappa_ mostra o nasconde una miniatura dell'intero disegno con la porzione visibile evidenziata. Nella mini-mappa un clic o un trascinamento spostano la vista; con il focus, le frecce la scorrono (Maiusc per passi più ampi) e Home inquadra tutto. La mini-mappa resta visibile o nascosta su questo dispositivo, non si sincronizza, e non compare in modalità Zen né in presentazione. Entrambi sono anche comandi della palette.
- **Scheda Slideshow** (barra destra, scheda _Slide_, con un disegno aperto): come nel plugin Obsidian elenca le cornici con miniatura e permette di avviare la presentazione (anche da una diapositiva), stamparla o salvarla in PDF, descrivere il disegno come testo e impostare ripetizione, contatore e note. Ogni cornice si può rinominare, spostare su/giù, escludere dalla presentazione (resta sulla lavagna) e ha le proprie _note del relatore_ in Markdown, salvate da sole. Le impostazioni stanno nel file del disegno.
- **Presentazione**: ogni cornice è una diapositiva (ordinate per numero, poi per nome, poi per posizione); frecce, Pagina su/giù, Spazio, Home/Fine navigano, Esc esce. Le _note del relatore_ si impostano con _Modifica le note del relatore_.
- **Descrivi il disegno come testo**: elenco di contenuto, cornici, testi e link, per chi non può vedere la lavagna.

### Esportare e importare

- _Esporta_: PNG o SVG di tutto il disegno, della selezione o di una cornice, con scala, margine, tema e scena incorporata (si può poi trascinare di nuovo nell'editor); salva nel vault, con nome, copia o stampa/PDF.
- **Esportazione automatica** accanto al file (`Disegno.excalidraw.png`, `.svg`, anche `.dark`/`.light`): parte quindici secondi dopo l'ultimo salvataggio, quando il lavoro si ferma, e subito alla chiusura del disegno, non a ogni salvataggio; si può scegliere per singolo disegno.
- **Importa**: un `.excalidraw.md` del plugin Obsidian (_Converti un disegno di Obsidian_) diventa un `.excalidraw` accanto all'originale, che resta intatto (le immagini incorporate sono incluse e le formule LaTeX tornano formule modificabili, disegnate all'apertura); una libreria `.excalidrawlib` copiata nel vault si importa in libreria e la libreria si esporta come `Library.excalidrawlib`.

### Limiti

L'editor parla la lingua dell'app (inglese e italiano). Un disegno oltre 8 MB (di solito per le immagini incorporate) non viene più indicizzato: il suo testo non si trova con la ricerca e i suoi link non compaiono nei backlink; oltre 10 MB anche salvataggio e sincronizzazione rallentano. L'editor lo segnala in entrambi i casi, misurando il file così come è salvato. Un'immagine oltre 10 MB non si inserisce dall'editor; se un file `.excalidraw` ne contiene già una (creata con un altro strumento) viene salvato lo stesso e l'indicizzazione ne scrive un avviso nel registro.

Non ci sono le funzioni del plugin Obsidian che richiedono script utente, rete o una penna fisica (ExcaliAI, OCR, …) né alcune azioni minori (Icon Library, Image Occlusion, LayerManager, Crop Vintage Mask, Collaboration Frame, Capture Note, Folder Note); dettagli in `docs/qa/obsidian-parity.md`. Una modifica fatta in contemporanea sulla stessa forma da due dispositivi tiene la versione più recente; le modifiche a forme diverse si fondono. Lo stesso vale mentre il disegno è aperto: se il file cambia (la sincronizzazione, l'altro pannello dello stesso disegno) quando ci sono modifiche non ancora salvate, le due versioni vengono fuse e il disegno continua senza interruzioni. Solo quando la fusione non è ammessa — la modifica di un altro utente in un vault condiviso — compare l'avviso con _Ricarica_, _Sovrascrivi_ e _Tieni entrambe_, che salva la tua versione in una copia accanto al file. Lo stesso avviso compare in due altri casi: in un vault condiviso, per un disegno sincronizzato l'ultima volta prima della 1.6 (non se ne conosce ancora l'autore, finché non viene sincronizzato di nuovo), e quando stai ancora disegnando o scrivendo da più di venti secondi mentre la fusione aspetta che tu finisca. L'amministratore può disattivare separatamente formule, Mermaid, esportazione automatica e azioni (flag `drawing_*` del profilo di configurazione).

## Basi (Bases)

_Nuova base_ crea un file `.base`: una **vista tabellare** sulle note del vault, costruita sulle proprietà. Si scelgono colonne, filtri, ordinamenti e raggruppamenti; si possono modificare i valori direttamente nella tabella (la modifica scrive la proprietà nella nota). Il formato è compatibile con Obsidian Bases; le funzioni non supportate vengono segnalate invece di essere perse (il file non si rovina). Una base si può incorporare in una nota con `![[nome.base]]`.

## Vista grafo

_Apri vista grafo_ (`Mod+Maiusc+G`) mostra i documenti del vault come nodi e i link come archi: filtri per tag, cartella o ricerca, colori per gruppo, dimensione per numero di link, cursore del tempo. _Apri grafo locale_ mostra solo il vicinato del documento corrente, con la profondità regolabile; si può centrare su una nota, una presentazione, un disegno o una lavagna. Il grafo si sposta e si ingrandisce con mouse o tastiera (frecce e `+`/`-`); il grafo del vault non include altri vault.

### Disegni, lavagne e basi come nodi

Oltre alle note, il grafo mostra i **disegni** (`.excalidraw`), le **lavagne** (`.canvas`) e le **basi** (`.base`). Un disegno o una lavagna ha come link quelli dei suoi elementi; una base compare solo come destinazione, perché non contiene link. I tag restano delle sole note: un filtro per tag nasconde questi nodi, come nasconde gli allegati. Si tolgono tutti insieme con la casella _Disegni, lavagne e basi_ nei filtri (nelle impostazioni del grafo).

### Vista 3D

Il pulsante a forma di cubo nella barra del grafo (o _Apri vista grafo in 3D_ dalla palette e dal ribbon, _Grafo: passa tra 2D e 3D_ per alternare) disegna lo stesso grafo nello spazio. Filtri, gruppi, timelapse e grafo locale funzionano come nel 2D. Funziona sul desktop e nel workbench web.

- **Per dispositivo.** La scelta 2D/3D vale per questo dispositivo (o questo browser): dipende dalla scheda grafica e dallo schermo, quindi non entra nel vault e non si sincronizza. Su un dispositivo nuovo il grafo si apre in 2D.
- **Icone, forme e legenda.** Il grafo si disegna in tre modi, secondo quanti nodi mostra. **Fino a 1.000 nodi** ogni nodo ha l'icona del suo tipo (le stesse dell'esploratore dei file: nota, presentazione, disegno, lavagna, base, immagine, PDF, audio, video, altri file, tag, nota non ancora creata) sul colore del suo gruppo o del suo tipo. **Da 1.001 a 2.000 nodi** ogni nodo è un solido con la forma del suo tipo (sfera per note e presentazioni, cubo per i disegni, ottaedro per le lavagne, cilindro per le basi, cono per gli allegati, toro per i tag, icosaedro per le note non ancora create), sempre sul colore del gruppo o del tipo: è più leggero da disegnare. **Oltre 2.000 nodi** i nodi sono punti. Una legenda mostra quanti nodi ci sono per tipo, con l'icona o con la forma di ciò che si vede; si spegne dalle impostazioni.
- **Con il mouse.** Trascinare lo sfondo ruota la vista, la rotella ingrandisce. Un click su un nodo lo seleziona e porta la camera su di lui; un click sul nodo già selezionato, o un doppio click, lo apre; Ctrl o Cmd+click lo apre in una nuova scheda. Passando sopra un nodo, lui e i suoi vicini restano accesi, gli altri si attenuano e i suoi link si evidenziano.
- **Con la tastiera.** Con il focus sul grafo: frecce per ruotare, `+` e `-` per lo zoom, `0` per adattare tutto allo schermo, `[` e `]` per passare da un nodo all'altro (si parte dal più connesso), Invio per aprire il nodo selezionato, Esc per togliere la selezione.
- **Nodi fissati.** Fino a 2.000 nodi ogni nodo si può **trascinare**: resta dove lo lasciate, anche quando il grafo si aggiorna. Il pulsante _Sblocca i nodi fissati_ (con il numero) li libera tutti.
- **Etichette.** Compaiono per il nodo selezionato e i suoi vicini e per i più connessi vicini alla camera, al massimo 40 alla volta.
- **Opzioni del 3D** (impostazioni del grafo, sezione _Vista 3D_, salvate nel vault): _Link reciproci curvi_ (due note che si rimandano l'una all'altra hanno due archi invece di una linea), _Legenda_, _Nodi mostrati (massimo)_ da 500 a 5.000.
- **Con «riduci movimento»** attivo nel sistema la camera salta alla nuova posizione invece di muoversi.

**Limiti.**

- **Al massimo 5.000 nodi** (o il numero scelto in _Nodi mostrati (massimo)_): se il vault ne ha di più, il 3D mostra i più connessi e la riga di stato in basso dice «Mostrati N nodi su M». Per un vault grande usate il 2D, che regge più nodi.
- **Oltre 2.000 nodi** i nodi sono punti: non si trascinano (fino a 2.000, icone e solidi, sì).
- **Senza WebGL2** il grafo resta in 2D e un avviso lo dice. Succede anche se il contesto grafico va perso, se ci sono già quattro grafi 3D aperti o se la vista non parte; scegliere di nuovo il 3D riprova.
- **Su un dispositivo senza scheda grafica** la vista 3D è più lenta (nelle nostre misure, da circa 11 a 29 fotogrammi al secondo con il rasterizzatore software contro i 60 con una GPU). Le misure sono su un solo computer, con carico variabile, e un grafo sintetico; sulla finestra reale dell'applicazione desktop non sono ancora state fatte, e le forme dei solidi non sono ancora state viste lì. I dettagli sono in `docs/qa/graph-3d-benchmark.md`.
