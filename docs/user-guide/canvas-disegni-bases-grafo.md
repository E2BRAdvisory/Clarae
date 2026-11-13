# Lavagne, disegni, basi e grafo

## Lavagne (canvas)

_Nuova lavagna_ crea un file `.canvas` (formato JSON Canvas, compatibile con Obsidian): una superficie infinita con **schede** di testo, note, file, immagini e link, collegate da **frecce** con etichetta, e raggruppabili. Si usa con trascinamento, zoom con la rotella o i gesti del trackpad, selezione multipla e le scorciatoie indicate nella barra della lavagna. Le note incorporate si aprono con doppio clic.

## Disegni

_Nuovo disegno_ crea un file `.excalidraw` (JSON standard in chiaro, apribile anche con excalidraw.com), modificabile con l'editor di disegno integrato (forme, frecce, testo, tratto libero, librerie). Funziona **offline**: gli asset sono inclusi nell'app. Dove nasce il file, come si chiama e come si apre (modifica, sola lettura, zen) si sceglie in _Impostazioni > Disegni_; lì si fissano anche i colori, il carattere e la dimensione predefiniti dei nuovi elementi e l'esportazione automatica. Le impostazioni stanno in `.clarae/drawing.json` e viaggiano con il vault (in un vault della 1.x collegato al cloud possono stare ancora nella cartella con il nome precedente: vedi [Aggiornare dalla 1.x](installazione.md#aggiornare-dalla-1x)). I disegni creati con la 1.x si aprono come prima: i dati dei vostri elementi (formule, frame, schede delle note) e le impostazioni del singolo disegno passano al nome nuovo solo quando li modificate o salvate il disegno, e un dispositivo con la 1.4 non riconosce più, su un disegno salvato dalla 1.5, le formule modificabili e l'ordine delle diapositive.

### Nelle note

- `![[disegno.excalidraw]]` mostra un'anteprima; `|400` ne fissa la larghezza e `|left`, `|right`, `|center`, `|left-wrap`, `|right-wrap` l'allineamento. Doppio clic apre il disegno.
- Si incorpora anche **una parte**: `![[disegno.excalidraw#frame=Nome]]`, `#clippedframe=`, `#group=`, `#area=`.
- Un elemento con un link `[[Nota]]` (o un indirizzo web) lo apre con un clic; ⌘/Ctrl+passaggio ne mostra l'anteprima. Il testo del disegno e i nomi delle cornici si trovano con la ricerca, i link compaiono nei backlink e, se rinomini la nota, il link nel disegno si aggiorna.
- Dal comando `/disegno` o da _Inserisci disegno_ si aggiunge un disegno alla nota.

### Dentro il disegno

- **Inserisci** immagini, note (come schede) e altri disegni dal vault, anche trascinandoli dall'esplorazione file nel punto desiderato; _Crea una nota e aggiungi la scheda_; _Sposta la selezione in un nuovo disegno_.
- **Formule LaTeX** (_Inserisci formula_, doppio clic per modificarla) e **diagrammi Mermaid** (testo → elementi modificabili): tutto locale, senza rete.
- **Azioni sulla scena** (palette dei comandi o pannello _Strumenti del disegno_, con ricerca, preferiti e usati di recente): distribuzione e allineamento, Auto Layout, colore e stile, schemi di colori, forme (riquadri, Boolean Operations, ellisse divisa), frecce (collega, a gomito, passo successivo), testo, ripetizione, mappa mentale da un elenco indentato, calendari, vignette e nuvolette, linea organica. Ogni azione si può annullare e ha un comando assegnabile a una scorciatoia.
- **Strumenti del plugin Obsidian** (menu ⋮ della barra): _Disegna per la forma_ (Maiusc+X) trasforma un tratto a mano libera in una forma, _Secchiello riempimento_ (B) riempie la forma o l'area cliccata, _Selezione a lazo_ seleziona gli elementi circondati da un tratto libero. Barra, pulsanti e menu sono al 90% della dimensione standard di Excalidraw; il menu principale di Excalidraw (ricerca, guida, link) non è mostrato.
- **Penne e puntatore laser**: penna fine, pennarello, evidenziatore e laser sono comandi con scorciatoia propria.
- **Scheda Slideshow** (barra destra, scheda _Slide_, con un disegno aperto): come nel plugin Obsidian elenca le cornici con miniatura e permette di avviare la presentazione (anche da una diapositiva), stamparla o salvarla in PDF, descrivere il disegno come testo e impostare ripetizione, contatore e note. Ogni cornice si può rinominare, spostare su/giù, escludere dalla presentazione (resta sulla lavagna) e ha le proprie _note del relatore_ in Markdown, salvate da sole. Le impostazioni stanno nel file del disegno.
- **Presentazione**: ogni cornice è una diapositiva (ordinate per numero, poi per nome, poi per posizione); frecce, Pagina su/giù, Spazio, Home/Fine navigano, Esc esce. Le _note del relatore_ si impostano con _Modifica le note del relatore_.
- **Descrivi il disegno come testo**: elenco di contenuto, cornici, testi e link, per chi non può vedere la lavagna.

### Esportare e importare

- _Esporta_: PNG o SVG di tutto il disegno, della selezione o di una cornice, con scala, margine, tema e scena incorporata (si può poi trascinare di nuovo nell'editor); salva nel vault, con nome, copia o stampa/PDF.
- **Esportazione automatica** accanto al file (`Disegno.excalidraw.png`, `.svg`, anche `.dark`/`.light`) a ogni salvataggio; si può scegliere per singolo disegno.
- **Importa**: un `.excalidraw.md` del plugin Obsidian (_Converti un disegno di Obsidian_) diventa un `.excalidraw` accanto all'originale, che resta intatto (le immagini incorporate sono incluse e le formule LaTeX tornano formule modificabili, disegnate all'apertura); una libreria `.excalidrawlib` copiata nel vault si importa in libreria e la libreria si esporta come `Library.excalidrawlib`.

### Limiti

L'editor parla la lingua dell'app (inglese e italiano). Un'immagine oltre 10 MB non si inserisce dall'editor; se un file `.excalidraw` ne contiene già una (creata con un altro strumento) viene salvato lo stesso e l'indicizzazione ne scrive un avviso nel registro.

Non ci sono le funzioni del plugin Obsidian che richiedono script utente, rete o una penna fisica (ExcaliAI, OCR, …) né alcune azioni minori (Icon Library, Image Occlusion, LayerManager, Crop Vintage Mask, Collaboration Frame, Capture Note, Folder Note); dettagli in `docs/qa/obsidian-parity.md`. Una modifica fatta in contemporanea sulla stessa forma da due dispositivi tiene la versione più recente; le modifiche a forme diverse si fondono. L'amministratore può disattivare separatamente formule, Mermaid, esportazione automatica e azioni (flag `drawing_*` del profilo di configurazione).

## Basi (Bases)

_Nuova base_ crea un file `.base`: una **vista tabellare** sulle note del vault, costruita sulle proprietà. Si scelgono colonne, filtri, ordinamenti e raggruppamenti; si possono modificare i valori direttamente nella tabella (la modifica scrive la proprietà nella nota). Il formato è compatibile con Obsidian Bases; le funzioni non supportate vengono segnalate invece di essere perse (il file non si rovina). Una base si può incorporare in una nota con `![[nome.base]]`.

## Vista grafo

_Apri vista grafo_ (`Mod+Maiusc+G`) mostra le note come nodi e i link come archi: filtri per tag, cartella o ricerca, colori per gruppo, dimensione per numero di link, cursore del tempo. _Apri grafo locale_ mostra solo il vicinato della nota corrente, con la profondità regolabile. Il grafo si sposta e si ingrandisce con mouse o tastiera (frecce e `+`/`-`); il grafo del vault non include altri vault.
