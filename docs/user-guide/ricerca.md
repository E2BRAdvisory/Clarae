# Ricerca

La ricerca è **locale** e **per vault**: l'indice è sul vostro computer (è ricostruibile da _Ricostruisci indice_ nella palette comandi) e non attraversa i vault. Con i vault del cloud il server non vede mai il contenuto delle note.

## Selettore rapido (`Mod+O`)

Cerca per **nome** (anche parziale, tollera piccoli salti di lettere): note e presentazioni, e dalla 1.7.1 anche **applicazioni** (file `.webapp`), **lavagne**, **basi** e **disegni**, per nome senza l'estensione. Ogni voce ha l'icona del suo tipo e i lettori di schermo ne leggono il tipo accanto al nome. `Invio` apre il file nella sua vista, `Mod+Invio` in una nuova scheda. Se non c'è una nota con quel nome, in fondo all'elenco compare la voce «Crea …», che la crea; una lavagna, una base, un disegno o un'applicazione con lo stesso nome (la lavagna «Road» e la nota «Road» che ancora non c'è) non la toglie. Le note nel cestino (`.trash/`) e i file nelle cartelle nascoste (con un nome che inizia per punto) non compaiono, come nell'esploratore dei file: questo vale anche per i suggerimenti dei link `[[`, che restano di sole note. Una presentazione (`.marp`) o un alias con lo stesso nome toglie la voce «Crea …» (crearla riassegnerebbe i link esistenti).

## Cerca nel vault (`Mod+Maiusc+F`)

Scrive in una query libera; il risultato mostra i frammenti trovati, con ordinamento per rilevanza, nome o data di modifica. Si trova per **sottostringa** (almeno 3 caratteri). Operatori:

| Operatore                         | Esempio                                    | Significato                                                               |
| --------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------- |
| `file:` / `path:`                 | `file:budget path:"Progetti/2026"`         | Nome del file / percorso.                                                 |
| `content:`                        | `content:"verbale"`                        | Solo nel testo (non nel nome).                                            |
| `tag:`                            | `tag:#cliente/acme`                        | Tag, con gerarchia.                                                       |
| `line:()` `block:()` `section:()` | `line:(foo bar)`                           | Le parole devono comparire nella stessa riga / blocco / sezione.          |
| `task:` `task-todo:` `task-done:` | `task-todo:"chiamare"`                     | Solo nelle attività (tutte / da fare / completate).                       |
| `[proprietà:valore]`              | `[stato:attivo]`, `[scadenza:<2026-12-31]` | Filtro sulle proprietà tipizzate.                                         |
| `/regex/`                         | `/\d{4}-\d{2}/`                            | Espressione regolare (RE2).                                               |
| `OR`, `-`, `( )`                  | `(a OR b) -c`                              | Booleani e raggruppamento; più termini = AND implicito; `"frase esatta"`. |
| `match-case:` `ignore-case:`      | `match-case:Clarae notanda`                | Forza la sensibilità alle maiuscole.                                      |

Le note nel cestino sono escluse, a meno di attivare _Includi le note nel cestino_.

## Ricerche incorporate

Un blocco di codice con linguaggio `query` mostra i risultati di una ricerca dentro la nota:

````
```query
tag:#progetto -task:fatto
```
````

Il blocco si aggiorna quando le note cambiano; il pulsante _Apri nella ricerca_ porta i risultati nel pannello di ricerca. Opzioni e limiti sono nelle impostazioni (_Includi la nota ospite_).

## Ricerca nei segnalibri

Una ricerca si può salvare come **segnalibro** (_Aggiungi una ricerca ai segnalibri_) per riaprirla con un clic.
