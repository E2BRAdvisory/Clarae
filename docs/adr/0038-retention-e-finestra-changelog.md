# ADR-0038 — Retention delle revisioni, compattazione del changelog e copie di conflitto

|                       |                                                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Stato**             | proposta                                                                                                                                 |
| **Data**              | 2026-11-01                                                                                                                               |
| **Riferimenti spec**  | §2.6.2 (storico e retention), §3.2.2 (DDL `file_revisions`), §3.4 (protocollo di sync, `CURSOR_EXPIRED`); D-03, D-04; ADR-0009, ADR-0033 |
| **Devia dallo spec?** | sì: §3.2.2 (DDL) e la descrizione della finestra del changelog in §3.4 vanno aggiornate come in questo ADR                               |

## Contesto

L'analisi del 2026-11-01 ha trovato tre difetti nel job di retention del cloud (`internal/revisions`, `internal/jobs`), tutti verificati con test d'integrazione:

1. **Retention bloccata dalle copie di conflitto.** `file_revisions.conflict_of` puntava alla revisione dell'originale senza `ON DELETE`. Quella revisione, una volta diventata non corrente e più vecchia di `history.retention_days`, era scelta per la cancellazione: il vincolo falliva (23503), l'intero batch tornava indietro e ogni esecuzione successiva ripartiva dalle stesse righe. La retention si fermava per tutta l'installazione.
2. **Buchi nel changelog.** La retention (30 giorni, poi una revisione al giorno fino a 90) cancella revisioni che la finestra del changelog (`sync.changelog_window_days`, 90 giorni) serve ancora. L'unico controllo di completezza di `changes?since` è `since < compaction_seq`, che la retention non spostava. Un client fermo da più di 30 giorni riceveva quindi un changelog con dei salti: per esempio la modifica successiva a uno spostamento cancellato, che riscriveva il file al vecchio percorso. Le repliche divergevano senza alcun segnale (contro D-04).
3. **Paginazione.** La scansione dei candidati non aveva cursore e si fermava alla prima pagina senza nulla da cancellare: con più di 5000 "sopravvissuti giornalieri" in testa, i file successivi non venivano mai potati.

## Decisione

- **Copie di conflitto:** `conflict_of` diventa `ON DELETE SET NULL` con un indice parziale. La nuova colonna `conflict_of_file` (id del file originale, scritta al commit e riempita per le righe esistenti) è ciò che il changelog restituisce come `conflict_of`. La risposta API non cambia e non dipende più dalla sopravvivenza della revisione referenziata. Migrazione `0007_retention_fixes.sql`.
- **Compattazione legata alla retention:** nella stessa transazione del prune, per ogni vault `compaction_seq` avanza fino al `seq` più alto tra le revisioni cancellate con operazione **diversa da `modify`** (create, move, delete, restore), tramite `vaults.AdvanceCompaction` (ADR-0033).
  - Le `modify` superate si possono perdere senza danno: una revisione successiva dello stesso file ha un `seq` più alto e porta il contenuto aggiornato.
  - Un cursore precedente a un'operazione strutturale cancellata riceve `CURSOR_EXPIRED` e il client esegue il bootstrap, invece di applicare un changelog incompleto.
- **Paginazione keyset** su `(file_id, server_time, id)`, con indice dedicato. L'ultima riga di ogni pagina serve solo da look-ahead e si decide nella pagina successiva, così la regola "ultima revisione del giorno" vale anche tra una pagina e l'altra.
- **Indici:** `files_blob_ix` (controllo d'integrità del GC dei blob), rimozione di `file_revisions_changes_ix` (duplicato dell'indice di `UNIQUE (vault_id, seq)`).
- **Riconciliazione dei contatori** (`ReconcileUsage`, `ReconcileBlobRefs`): ogni correzione blocca la riga (`FOR UPDATE`), ricalcola il valore e scrive solo se differisce. Non si scrive più un valore preso da uno snapshot precedente.
- **Scheduler dei job:** gli advisory lock usano un piccolo pool dedicato, così un job non tiene occupata una connessione del pool principale mentre ne chiede un'altra. Le prime esecuzioni sono scaglionate e il pool principale ha un minimo di 8 connessioni se `DATABASE_URL` non specifica `pool_max_conns`.

## Alternative considerate

- **Non potare le revisioni non-`modify` dentro la finestra del changelog:** la finestra di 90 giorni resterebbe completa, ma la retention dello storico (§2.6.2) avrebbe un'eccezione difficile da spiegare e lo storico conterebbe righe che l'utente non vede. Scartata.
- **Portare la retention a 90 giorni:** più storico fuori quota (D-03) e un costo di storage per tutte le installazioni, solo per servire client fermi a lungo. Scartata.

## Conseguenze

- **Finestra effettiva più corta:** per un client che resta indietro oltre una create, move, delete o restore già potata, la finestra effettiva del changelog si riduce da `sync.changelog_window_days` a circa `history.retention_days`. Ne segue un bootstrap, che è sicuro: nessun file locale viene cestinato senza prova. È il prezzo di non servire mai un changelog con dei salti.
- **Lo spec va aggiornato:** il DDL di §3.2.2 (`conflict_of ... ON DELETE SET NULL`, colonna `conflict_of_file`, nuovi indici, nessun `file_revisions_changes_ix`) e la descrizione della finestra del changelog in §3.4.
- **Migrazione:** gli indici della 0007 si creano dentro la transazione della migrazione e bloccano le scritture su `file_revisions` e `files` per la durata. Va bene alle dimensioni attuali; su un'installazione molto grande servirebbe una migrazione `NO TRANSACTION` con `CREATE INDEX CONCURRENTLY`.
- **Connessioni:** il pool degli advisory lock aggiunge fino a 5 connessioni PostgreSQL per replica del worker. È documentato nella guida di amministrazione.
