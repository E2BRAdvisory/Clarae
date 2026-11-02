# ADR-0014 — Bases: sottoinsieme supportato, degrado e round-trip

|                       |                                                                     |
| --------------------- | ------------------------------------------------------------------- |
| **Stato**             | accettata                                                           |
| **Recepito in**       | `Specifications.md` v1.4 (2026-11-02): §2.2.1, §2.5 (Appendice C.4) |
| **Data**              | 2026-10-24                                                          |
| **Riferimenti spec**  | §2.2.1 (riga Bases, P1); D-01, D-06; roadmap M6-WP2                 |
| **Devia dallo spec?** | no                                                                  |

## Contesto

Le Bases sono file `.base` (YAML) compatibili con Obsidian: filtri, formule e viste (tabella/card) sulle properties indicizzate. Il formato Obsidian non ha una specifica normativa completa: va definito il sottoinsieme che si implementa e come si degrada su ciò che non si capisce, senza mai perdere contenuto dell'utente.

## Decisione

**Motore unico in Go** (`internal/bases`, dietro `BasesAPI`); il frontend mostra soltanto il risultato. Parser ed evaluator di espressioni scritti a mano (niente `eval`), con budget di passi per espressione.

**Supportato.** Radice: `filters`, `formulas`, `properties.<id>.displayName`, `views`. Filtri: stringa-espressione oppure gruppi `and`/`or`/`not` annidati (`not` = nessun figlio vero); i filtri di base e di vista si compongono in AND. Viste `table` e `cards` con `name`, `filters`, `order`, `sort[{property,direction}]`, `groupBy`, `limit`, `summaries` (Sum, Average, Min, Max, Median, Range, Count, Empty, Filled, Unique, Earliest, Latest). Riferimenti: `file.{name,basename,path,folder,ext,size,ctime,mtime,tags,links}`, `note.x`/`x`, `formula.x`, `this.x`. Tipi: testo, numero, booleano, data, data-ora, lista, link, durata. Espressioni: aritmetica, confronti, `&& || !`, indici, `if`, `now/today/date/number/link/list/concat/min/max/abs/round/floor/ceil/duration`, `file.hasTag/inFolder/hasLink/hasProperty`, metodi su stringhe (contains, startsWith, endsWith, lower, upper, trim, replace, split, slice, title, repeat), liste (contains, containsAll/Any, join, map, filter con `value`/`index` impliciti, sum, count, mean, min, max, unique, sort, flat, reverse, slice, concat), date (campi, `format` con token moment, `+`/`-` durata, `date - date` = durata con `.days` ecc., `relative`). Proprietà mancante ⇒ `null`; l'aritmetica su `null` resta `null`.

**Non supportato (degrado).** Tipi di vista diversi da table/cards: la vista compare nel selettore con avviso "non supportata", senza righe. Filtro con espressione non valida o struttura sconosciuta: neutro (non nasconde righe), segnalato in `Notices` e come chip evidenziato. Formula non valida o con errore a runtime: errore solo nella cella (`#ERRORE`, dettaglio nel tooltip), le altre celle restano. Errore a runtime in un filtro: la riga è esclusa. Opzioni di vista sconosciute (`image`, `cardSize`, `rowHeight`…) sono ignorate. `ctime` coincide con `mtime` (non indicizzato). Un YAML non valido mostra l'errore e l'editor YAML grezzo.

**Round-trip.** Una base non si riscrive mai se non su azione esplicita dell'utente (ordinamento, colonne, raggruppamento, filtro semplice, YAML grezzo). Le modifiche operano sull'albero `yaml.v3` (`Node`): chiavi sconosciute, commenti, altre viste e stile restano intatti; solo i nodi toccati cambiano e l'indentazione è normalizzata a 2 spazi. I filtri complessi (gruppi, radice non-`and`) sono chip in sola lettura: aggiungere un filtro a una radice diversa da `and` la incapsula senza riscriverla; la rimozione è consentita solo per le espressioni semplici dell'`and` di primo livello. Scrittura atomica con `expectedHash` (conflitto se il file è cambiato); vault in sola lettura non scrivibili. La modifica inline di una property delega a `PropertiesAPI.Update` (stesso percorso con hash, schema tipi e commenti preservati); celle formula e colonne `file.*` sono di sola lettura.

## Alternative considerate

- **Valutatore anche in TS** — scartata: due implementazioni da tenere allineate; con un solo motore Go non servono fixture di conformità.
- **Libreria di espressioni esterna (CEL, expr)** — scartata: sintassi e semantica diverse da Obsidian, superficie d'attacco maggiore.
- **Riserializzare l'intero YAML dal modello** — scartata: perde chiavi sconosciute e commenti.

## Conseguenze

Prestazioni: 10.000 note, filtro + ordinamento ≈ 6,5 ms nel motore e ≈ 86 ms includendo il caricamento da `index.db` (benchmark `BenchmarkRun10kFilterSort`, `BenchmarkLoadAndRun10k`). Il caricamento ricostruisce le note a ogni esecuzione: una cache incrementale è rinviata. Le viste non supportate (mappa, lista) e i formati di colonna avanzati restano per una milestone successiva. Il comportamento fine delle funzioni Obsidian meno comuni può differire: va verificato su vault reali.
