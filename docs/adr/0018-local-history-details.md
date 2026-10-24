# ADR-0018: History locale e File recovery (M6-WP5)

- Stato: proposto
- Data: 2026-10-24
- Riferimenti: Specifications §3.4 (`.nodus/snapshots` locale al dispositivo), matrice §2.2.1 "File recovery", roadmap M6-WP5, D-06

## Contesto

La matrice P1 richiede snapshot locali dei file con ripristino, integrati con la cronologia cloud (M2) in un'unica vista. Gli snapshot non devono finire in sync, indice, albero file, ricerca, né innescare loop del watcher.

## Decisioni

**Trigger.** Lo snapshotter (`internal/history`, uno per vault aperto) è guidato dai batch del watcher già in uso (`Observe(paths)` in `watchLoop`), non da una scansione: costo nullo a vault inattivo e nessun secondo albero di eventi. Per ogni file modificato: snapshot immediato se l'ultimo ha più di N minuti (default 5), altrimenti il file resta in coda e un worker (tick 30 s) lo salva allo scadere dell'intervallo ("leading + trailing edge"). Limite noto: se il file viene cancellato prima del trailing edge, le modifiche dopo l'ultimo snapshot non sono recuperabili da qui (lo sono dal cestino).

**Layout** (tutto sotto `.nodus/snapshots/`, già escluso da `pathrules.IsExcluded` e dal watcher):
`blobs/<hh>/<hash>` contenuto indirizzato per hash (SHA-256, lo stesso di `WriteNote`), condiviso tra versioni identiche e file diversi; `meta/<pathkey>/<ms>.json` un piccolo JSON per snapshot (path, time, size, hash, reason), con `pathkey` = primi 16 hex di SHA-256(path). ID snapshot = `<pathkey>-<ms>`, validato con regex prima di costruire percorsi. Scrittura crash-safe: tmp + fsync + rename, blob prima del meta (un crash lascia al massimo un blob orfano, rimosso dal prune).

**Dedupe.** Nessuno snapshot se l'hash coincide con il più recente del file; i blob sono comunque condivisi. Sono saltati file non testuali (NUL o UTF-8 non valido), oltre il tetto per file (default 5 MB), path esclusi, `.nodus/` e cestino.

**Retention.** Default 7 giorni; per un file esistente si conserva sempre l'ultimo snapshot anche oltre la scadenza; per un file cancellato tutti gli snapshot scadono con la retention (finestra di recupero = retention). Tetto totale sui contenuti unici (default 500 MB): si eliminano prima i più vecchi non-ultimi, poi gli ultimi. Prune all'apertura del vault, ogni ora e a ogni cambio impostazioni; poi garbage collection dei blob non referenziati.

**Impostazioni.** `.nodus/history.json` (intervallo, giorni, MB per file, MB totali; valori fuori range riportati nei limiti), gestite da `HistoryAPI.GetSettings/SetSettings` e da `settings/HistorySettings.tsx` (sezione File). Il file è sincronizzato come le altre impostazioni del vault.

**Ripristino senza perdita.** `Restore` salva prima il testo corrente (motivo `pre-restore`, senza tetto dimensione né controllo testo), poi scrive con `expectedHash` = hash appena letto (una modifica esterna concorrente annulla il ripristino); se il file era stato cancellato lo ricrea. Vault read-only (mount viewer): nessuno snapshot, nessun ripristino (`writable()` + callback `ReadOnly`). `useNoteDocument` tratta il ripristino come modifica esterna: ricarica se pulito, segnala conflitto se ci sono modifiche non salvate (test dedicati).

**Interazione con sync e indice.** Gli snapshot non sono mai sincronizzati né indicizzati (test su `IsExcluded`, `ListTree`, `Walk`, indice). Il file ripristinato è una normale modifica locale e viaggia con il sync. Il motivo `pre-sync-overwrite` è definito (`Take`) ma non agganciato al motore di sync (da valutare in un secondo momento per non toccare `internal/sync`).

**UI.** Dialogo unico "File recovery" per nota (comando `recovery:open`, menu contestuale di albero e tab): snapshot locali e revisioni cloud (se il vault è collegato e sbloccato) in un'unica lista cronologica con badge di origine, diff (`sync/diff.ts`) e "Ripristina questa versione" con conferma; comando `recovery:deleted` per l'elenco dei file cancellati con versioni. Il ripristino di una revisione cloud usa `SyncAPI.RestoreRevision` (nuova revisione sul server). `sync:history` e `HistoryView` restano invariati.

## Conseguenze

Spazio disco aggiuntivo limitato dai tetti; nessuna dipendenza nuova. Da verificare manualmente: modifica rapida in editor con vault grande (nessun lag), ripristino di nota cancellata dall'elenco, vault viewer (pulsanti disabilitati), apertura del dialogo con cloud offline (messaggio, solo versioni locali).
