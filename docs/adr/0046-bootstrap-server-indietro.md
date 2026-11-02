# ADR-0046 — Bootstrap quando il server è tornato indietro (ripristino PITR): ripubblicare, non cancellare

|                       |                                                                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stato**             | accettata                                                                                                                                           |
| **Data**              | 2026-11-02                                                                                                                                          |
| **Riferimenti spec**  | §3.4.4 B (bootstrap dal manifest), Appendice A (affidabilità dei dati, RPO); D-04 (nessuna perdita silenziosa); integra ADR-0022 (bug 3) e ADR-0039 |
| **Devia dallo spec?** | sì (§3.4.4: i file che il server non elenca più finiscono nel cestino locale) → richiede aggiornamento di `Specifications.md` da parte dell'owner   |

## Contesto

ADR-0022 (bug 3) ha fatto rispondere `GET /vaults/{id}/changes` con `410 CURSOR_EXPIRED` anche quando il cursore del client è **più avanti** dell'ultimo `seq` del server: succede dopo un ripristino point-in-time del database cloud, quando i nuovi commit riuserebbero numeri di sequenza già consumati. Il problem distingue i due casi con un campo esteso: `compaction_seq` per un cursore più vecchio della finestra del changelog (ADR-0038), `last_seq` per un cursore oltre la fine (`services/cloud/internal/sync/changes.go`).

Il client però reagisce allo stesso modo in entrambi i casi (`apps/desktop/internal/sync/pull.go`, `bootstrap`): tratta l'albero del server come autorevole. Nel caso del ripristino questo distrugge proprio ciò che il server ha perso:

- un file che tutti i dispositivi hanno alla revisione 5, mentre il server ripristinato è alla 3, viene riscritto con il contenuto della 3 su ogni dispositivo, senza snapshot nella history (`overwriteFromRemote` non passa da `BeforeOverwrite`);
- i file creati dopo il punto di ripristino, che il server non elenca più, finiscono nel cestino locale e non vengono mai ricaricati;
- le righe con modifiche locali restano bloccate: il candidato alla revisione 3 viene scartato e la push con `base_rev` 5 va in conflitto all'infinito.

Il risultato è una perdita silenziosa su tutti i client, contraria a D-04 e allo spirito di ADR-0022 («ciò che il server ha perso non va distrutto sul client»). La revisione del 2026-11-02 l'ha confermata sul codice (rilievo alto A1).

## Decisione

1. **Il transport espone i campi estesi del problem.** `transport.Problem` conserva gli `Extra` (`last_seq`, `compaction_seq`); un helper `transport.ServerBehind(err)` dice se il 410 riguarda un cursore oltre la fine.
2. **Bootstrap in modalità _reconcile-upload_.** Quando il server è indietro, il bootstrap confronta ogni riga locale con l'albero:
   - riga presente sul server con `row.ServerRev > rf.Rev`, oppure con la stessa revisione ma hash diverso: il contenuto locale è più recente di quello che il server conosce. Non si applica il contenuto remoto; la riga diventa `LocalModify` con `BaseRev = ServerRev = rf.Rev` e `ServerHash = rf.Hash`, così la prossima push la ripubblica come nuova revisione (il merge a tre vie, se un altro dispositivo ha già ripubblicato, resta quello di sempre);
   - riga con `ServerRev > 0` assente dall'albero: il file esisteva sul server prima del ripristino. Invece di `applyDelete` la riga diventa `LocalNew` (`ServerRev = BaseRev = 0`, nuovo `op_id`), e la push la ricarica; se il file locale non c'è più, la riga viene semplicemente rimossa;
   - riga con `row.ServerRev < rf.Rev` (il server, pur ripristinato, ha qualcosa di più nuovo): si applica come oggi.
3. **Nessuna sovrascrittura senza snapshot.** In ogni bootstrap (anche con `compaction_seq`), prima di riscrivere un file locale con il contenuto remoto si chiama `BeforeOverwrite`, come già fa la risoluzione dei conflitti: la versione locale resta recuperabile da _File recovery_.
4. Con `compaction_seq` (finestra scaduta) il resto del comportamento non cambia: l'albero è autorevole e i file che il server non elenca sono stati cancellati davvero.
5. Il cursore viene impostato a `tree.as_of_seq` come oggi; i file ripubblicati generano nuovi `seq` sul server ripristinato.
6. **Un bootstrap interrotto riprende in modalità _reconcile-upload_.** Finché il bootstrap non salva il cursore, una marca in `sync_meta` ricorda che il server era indietro: se intanto altri dispositivi hanno ripubblicato e il server non risponde più 410, il bootstrap riparte comunque nella stessa modalità e nessuna riga resta con revisioni che il server non ha più.
7. **Il cursore riconosce i `seq` riusati (completamento lato server, M12-W1).** Dopo che un dispositivo ha ripubblicato, `last_seq` del server ripristinato torna a crescere e riusa numeri già consumati: un dispositivo rimasto offline, con il cursore ora minore o uguale a `last_seq`, non riceverebbe il 410 e salterebbe in silenzio i cambiamenti riusati. Il client invia quindi con il cursore anche l'identificativo del cambiamento a quel `seq` (`since_id`); l'identificativo è quello della riga di `file_revisions` a quel `seq`, già una chiave UUID stabile. Il server risponde `410 CURSOR_EXPIRED` con `last_seq` quando a quel `seq` c'è un cambiamento diverso (numero riusato, bootstrap _reconcile-upload_), e con `compaction_seq` quando a quel `seq` non c'è più nessun cambiamento: i commit non lasciano buchi nella sequenza, quindi la riga è stata potata dalla retention e il bootstrap normale è quello sicuro (ripubblicare riporterebbe in vita file cancellati). `changes` restituisce `next_id`, `tree` restituisce `as_of_id`, e il controllo del cursore e la pagina si leggono nella stessa istantanea. Il parametro è facoltativo, così i client precedenti continuano a funzionare con il comportamento attuale.

## Alternative considerate

- **Rifiutare il sync e chiedere all'utente** — sicuro ma blocca tutti i dispositivi finché qualcuno non interviene, e non dice cosa fare; la ripubblicazione automatica ottiene lo stesso risultato senza perdite.
- **Ricaricare tutto il vault** — semplice ma moltiplica il traffico e crea conflitti artificiali tra dispositivi che hanno lo stesso contenuto; il confronto per revisione ricarica solo ciò che il server ha perso.
- **Ripristinare lato server dai blob orfani** — il server non interpreta il contenuto e non conosce i path dei vault privati; solo i client possono ricostruire lo stato.

## Conseguenze

- Dopo un PITR i client ripubblicano le revisioni perse; se più dispositivi avevano la stessa revisione, il primo la ripubblica e gli altri la ritrovano identica (stesso hash, nessun conflitto) oppure vanno al merge.
- Un file cancellato dopo il punto di ripristino può ricomparire su altri dispositivi: è il compromesso scelto, coerente con D-04 (meglio un file in più che uno perso). Il comportamento va descritto nella guida admin (backup e ripristino).
- `Specifications.md` §3.4.4 va aggiornato dall'owner: il cestino locale si applica solo con `compaction_seq`; il parametro `since_id` di `GET /vaults/{id}/changes` va aggiunto a §3.4.4 e all'OpenAPI.
- Nei vault privati l'hash del server è quello del ciphertext: se un altro dispositivo ha già ripubblicato lo stesso testo con un nonce diverso, la riga viene ripubblicata di nuovo come revisione identica, senza conflitti né perdite.
- Test: unitario sul bootstrap con `last_seq` e test e2e in `apps/desktop/internal/sync/e2e_test.go` che simula il ripristino del server a un `seq` precedente.
