# Lavagne, disegni, basi e grafo

## Lavagne (canvas)

_Nuova lavagna_ crea un file `.canvas` (formato JSON Canvas, compatibile con Obsidian): una superficie infinita con **schede** di testo, note, file, immagini e link, collegate da **frecce** con etichetta, e raggruppabili. Si usa con trascinamento, zoom con la rotella o i gesti del trackpad, selezione multipla e le scorciatoie indicate nella barra della lavagna. Le note incorporate si aprono con doppio clic.

## Disegni

_Nuovo disegno_ crea un file `.excalidraw`, modificabile con l'editor di disegno integrato (forme, frecce, testo, tratto libero, librerie). Funziona **offline**: gli asset sono inclusi nell'app. Un disegno si inserisce in una nota con _Inserisci disegno_ (`![[disegno.excalidraw]]`) e mostra un'anteprima.

## Basi (Bases)

_Nuova base_ crea un file `.base`: una **vista tabellare** sulle note del vault, costruita sulle proprietà. Si scelgono colonne, filtri, ordinamenti e raggruppamenti; si possono modificare i valori direttamente nella tabella (la modifica scrive la proprietà nella nota). Il formato è compatibile con Obsidian Bases; le funzioni non supportate vengono segnalate invece di essere perse (il file non si rovina). Una base si può incorporare in una nota con `![[nome.base]]`.

## Vista grafo

_Apri vista grafo_ (`Mod+Maiusc+G`) mostra le note come nodi e i link come archi: filtri per tag, cartella o ricerca, colori per gruppo, dimensione per numero di link, cursore del tempo. _Apri grafo locale_ mostra solo il vicinato della nota corrente, con la profondità regolabile. Il grafo si sposta e si ingrandisce con mouse o tastiera (frecce e `+`/`-`); il grafo del vault non include altri vault.
