# Template e note giornaliere

## Note giornaliere

_Apri la nota giornaliera di oggi_ crea (se manca) e apre la nota del giorno. In _Impostazioni → Note giornaliere e template_ scegliete la **cartella**, il **formato della data** (es. `YYYY-MM-DD`) e il **template** da usare per le nuove note. _Nota giornaliera precedente/successiva_ si spostano tra i giorni. Se aprite il comando da una nota che non è giornaliera, l'app vi ricorda di controllare cartella e formato.

## Template

I template stanno nella cartella `.clarae/templates` del vault e sono di tre tipi: **note** (`.md`), **disegni** (`.excalidraw`) e **presentazioni** (`.marp`). La cartella è nascosta nell'esploratore dei file: i template non compaiono tra le note, né nella ricerca o nel grafo. Si sincronizzano con il vault tra i vostri dispositivi.

**Creare e modificare un template**

- _Nuovo template_ chiede il tipo e il nome, e apre il template in una scheda.
- _Salva come template_ fa del file aperto (nota, disegno o presentazione) un template, senza toccare l'originale.
- _Modifica template_ apre un template in una scheda, come qualunque file; da lì si rinomina o si elimina.
- In _Impostazioni → Note giornaliere e template_ trovate l'elenco dei template del vault, con _Apri_ ed _Elimina_.

**Usare un template**

- _Nuova nota da template_ chiede il template e il nome, e crea la nota. _Nuovo disegno da template_ e _Nuova presentazione da template_ chiedono il template e creano il file con il nome consueto.
- _Applica template_ aggiunge un template al file aperto: in una nota al cursore, in un disegno al centro della vista, in una presentazione come slide dopo quella corrente.
- In _Impostazioni → Note giornaliere e template_ potete scegliere il template di **ogni nuova nota**, di **ogni nuovo disegno** e di **ogni nuova presentazione**.

I segnaposto `{{date}}`, `{{time}}` e `{{title}}` (elencati nelle Impostazioni) valgono per note e presentazioni; un disegno viene copiato così com'è.

**Template di una versione precedente**

Fino alla 1.8 i template erano note di una cartella del vault (di norma `Templates`). Alla prima apertura l'app chiede se spostarli in `.clarae/templates`; se rifiutate restano dove sono e continuano a funzionare, e potete spostarli più tardi con _Importa template dalla cartella…_. Una volta spostati non compaiono più tra le note e i link verso di essi non si risolvono più. Lo spostamento non è proposto per le cartelle condivise con voi né quando la cartella dei template è condivisa con altri: per i template di un gruppo c'è la libreria di template distribuita dall'amministratore.

## Note uniche

_Nuova nota unica_ crea una nota con un nome basato sull'orario (utile per appunti veloci a prova di collisione).

## Unire ed estrarre

- _Unisci la nota corrente in un'altra nota_: aggiunge il contenuto, **reindirizza i link** e sposta la nota originale nel cestino (l'app mostra un riepilogo e chiede conferma).
- _Estrai la selezione in una nuova nota_: sposta il testo selezionato in una nota nuova e lascia un link al suo posto.
- _Apri una nota casuale_: per riscoprire materiale dimenticato.
