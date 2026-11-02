# Il primo vault

Un **vault** è una cartella sul vostro computer che contiene le note. Potete avere più vault, ma ogni vault è un mondo a sé: link, backlink, grafo, ricerca e segnalibri non attraversano i vault.

## Aprire un vault

_Apri cartella come vault_ nella schermata iniziale; i vault recenti sono elencati sotto. Si possono aprire anche vault creati con Obsidian: le note, gli allegati e i file `.canvas` restano com'erano.

## L'interfaccia

- **Intestazione:** in alto a sinistra i pulsanti per mostrare/nascondere la barra sinistra e per cercare nel vault; a destra la palette comandi, il passaggio **chiaro/scuro** e il pulsante della barra destra. Il nome del vault è al centro.
- **Azioni rapide** (colonna di icone a sinistra): nuova cartella, nota, lavagna, disegno, base, _separatore_ (inserisce una riga `---` nella nota), esporta in PDF, esporta come immagine. In fondo: le **impostazioni** e il vostro **account** (le iniziali se avete fatto l'accesso al cloud, altrimenti il pulsante _Accedi_).
- **Barra laterale sinistra:** schede _File_ (albero delle cartelle, nuova nota/cartella, ordinamento; clic destro, o tasto Menu / `Maiusc+F10`, per rinominare, spostare nel cestino, copiare il percorso, aggiungere ai segnalibri) e _Struttura_ (i titoli della nota aperta). La ricerca si apre dalla lente in alto e compare come terza scheda finché la usate. In fondo: il **vault aperto** con il numero di note; un clic mostra i vault recenti e permette di cambiare vault senza tornare alla schermata iniziale (`Cambia vault` nella palette).
- **Area centrale:** schede (tab) e pannelli divisibili (`Mod+\` a destra, `Mod+Maiusc+\` in basso). Si trascinano le schede tra i pannelli. Il clic destro su una scheda permette di **bloccarla** (non si chiude per errore e la navigazione si apre in una scheda nuova) e di chiudere le schede a destra, a sinistra, le altre o tutte (quelle bloccate restano).
- **Barra laterale destra** (schede a icona): _Proprietà_, _Tag_, _Link_ (link in uscita, backlink e segnalibri del vault), _Slide_ ([presentazioni](presentazioni.md)) e _Statistiche_ (date, autore, versioni, con chi è condivisa, parole e titoli della nota). In fondo: lo **stato del vault** (indicizzazione, sincronizzazione, inviti in attesa, permesso sul vault condiviso, aggiornamenti); con la barra chiusa lo stesso blocco passa nell'intestazione.
- **Barra di stato** (facoltativa, spenta per default): accendetela da _Impostazioni → Aspetto_ o con il comando _Mostra/nascondi barra di stato_. È una riga sottile sotto l'area centrale con parole e caratteri della nota (quelli selezionati, se c'è una selezione), riga e colonna del cursore e la modalità, che un clic fa passare da Live a Sorgente a Lettura. Su disegni, lavagne e basi mostra solo il tipo di file; durante una presentazione si nasconde.
- **Palette comandi** (`Mod+P`): ogni azione dell'app, con la sua scorciatoia.

## Prime note

1. `Mod+N` crea una nota; il titolo è il nome del file.
2. Scrivete: il salvataggio è automatico e **atomico** (non si ottengono file a metà anche se il computer si spegne).
3. Se modificate un file con un altro programma, l'app se ne accorge; non sovrascrive mai una modifica esterna senza avvisarvi.
4. `Mod+O` apre il **selettore rapido**: digitate parte del nome per aprire una nota, o per crearla se non esiste.

Cartelle e note si possono spostare e rinominare dall'albero: i link che puntano alla nota vengono aggiornati (l'app mostra quanti link in quante note verranno modificati prima di procedere).
