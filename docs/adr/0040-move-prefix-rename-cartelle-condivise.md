# ADR-0040 — `move_prefix` resta il rename atomico delle cartelle condivise

|                       |                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Stato**             | accettata                                                                                                           |
| **Recepito in**       | `Specifications.md` v1.2 (2026-11-02): §2.6.4, §3.4.7, §3.5.3, §3.8.5 (Appendice C.4)                               |
| **Data**              | 2026-11-01                                                                                                          |
| **Riferimenti spec**  | §3.4.7 (share e mount, rename della radice condivisa), §3.5.3 (operazioni del commit), §3.8.5 (vault privati); D-04 |
| **Devia dallo spec?** | no: conferma §3.4.7; precisa solo che un rename che cambia soltanto maiuscole/minuscole è ammesso                   |

## Contesto

La review del 2026-11-01 (rilievo _move-prefix-unused_) ha verificato che il cloud implementa l'operazione `move_prefix` (rename atomico di una cartella: una revisione `move` per ogni file sotto il prefisso, nella stessa transazione, e ribasamento di `shares.path_prefix` con `RebasePrefixShares`) e il rifiuto `SHARE_ROOT_MOVE` (un rename "file per file" che porterebbe fuori dalla cartella condivisa il suo ultimo file). Nessun client però li usa: il motore di sync del desktop e il workbench web emettono un rename di cartella come N `move` singole e non hanno un ramo per `SHARE_ROOT_MOVE`.

Conseguenze attuali, su un vault condiviso con una share di cartella:

- il proprietario rinomina `Acme` in `Acme-2024`: N−1 `move` sono accettate, l'ultima è rifiutata con `SHARE_ROOT_MOVE`. La cartella resta divisa su due percorsi, `path_prefix` non viene ribasato e i destinatari vedono i file spostati come cancellazioni;
- un rename che cambia solo maiuscole/minuscole (`notes` → `Notes`) via `move_prefix` era rifiutato con un fuorviante `PATH_INVALID` ("a folder cannot move into itself"), perché le chiavi dei percorsi sono case-folded.

Il lotto W8 A1 deve decidere se tenere il percorso lato server o rimuoverlo, senza implementare il lato client.

## Decisione

**Si tiene `move_prefix` (e `SHARE_ROOT_MOVE`) come unico modo di rinominare una cartella condivisa**, come richiede §3.4.7.

- Server (in questo lotto): `move_prefix` ammette il rename che cambia solo maiuscole/minuscole (stessa chiave, percorso diverso). Resta rifiutato con `VALIDATION_FAILED` "path is unchanged" se il percorso è identico, e con `PATH_INVALID` lo spostamento di una cartella dentro sé stessa. Nient'altro cambia nel contratto: nessuna modifica a `api/openapi.yaml`.
- Client (lavoro successivo, fuori da questo lotto, da pianificare nella roadmap):
  - il motore di sync del desktop e il workbench web riconoscono un rename di cartella (evento del watcher o azione dell'utente) su un vault **condiviso** ed emettono una sola `move_prefix` invece delle N `move`. Sui vault privati resta il comportamento attuale (§3.8.5: il server non vede le cartelle);
  - un risultato `rejected` con codice `SHARE_ROOT_MOVE` fa ripiegare il client su una `move_prefix` della cartella radice della share (o, se non la può ricostruire, lascia le `move` in quarantena con un messaggio, senza perdere nulla: D-04);
  - un test di contratto desktop↔cloud copre il rename di una cartella condivisa (la share segue la cartella, il destinatario continua a sincronizzare) e il rename solo-maiuscole.

## Alternative considerate

- **Rimuovere `move_prefix` e `SHARE_ROOT_MOVE`, rifiutando `move_prefix` con un codice esplicito.** Scartata. Senza un'operazione atomica il ribasamento della share dovrebbe essere dedotto dal server da una sequenza di `move` singole (eventualmente spezzata su più commit, in ordine arbitrario, con conflitti a metà): un'euristica fragile, che lascerebbe comunque dei destinatari con un mount vuoto o parziale nei casi limite. Il protocollo perderebbe una garanzia di §3.4.7 e servirebbe una deviazione dallo spec, in cambio della sola rimozione di codice già scritto e testato (`TestShareRootProtection`).
- **Ribasare la share quando l'ultimo file lascia il prefisso con una `move` singola.** Scartata per la stessa ragione: la destinazione dell'ultimo file non dice dove sono finiti gli altri (potrebbero essere stati spostati in cartelle diverse), quindi il nuovo prefisso sarebbe un'ipotesi.
- **Togliere solo il rifiuto `SHARE_ROOT_MOVE`.** Scartata: il rename "file per file" svuoterebbe la share senza ribasarla, e i destinatari vedrebbero sparire tutto senza alcun segnale al proprietario.

## Conseguenze

- Il contratto del cloud non cambia; il rename solo-maiuscole via `move_prefix` ora funziona (test `TestMovePrefixCaseOnlyRename`).
- Finché i client non emettono `move_prefix`, il difetto osservato resta: rinominare dal desktop una cartella condivisa la lascia divisa e l'ultima `move` torna `rejected` con `SHARE_ROOT_MOVE`. Il rischio è un mount incompleto per i destinatari, non una perdita di dati: il proprietario conserva tutti i file e la `move` rifiutata non tocca né il file né il suo storico.
- Il lavoro client va inserito nella roadmap (registro delle funzioni `shared/parity/features.yaml` quando verrà implementato) e il relativo test di contratto va aggiunto a quel punto.

## Esito

Lato client implementato nel lotto W8 (extra) nel motore di sync del desktop, che è anche il core WASM del workbench web (`apps/desktop/internal/sync/folders.go`):

- **Vault condiviso, owner:** una cartella rinominata (azione della UI, che passa da `Engine.Renamed`, o rilevata dalla scansione) diventa una sola `move_prefix`. Il motore la riconosce quando tutti i file che il server ha sotto la vecchia cartella risultano spostati allo stesso percorso relativo sotto la nuova (o cancellati qui) e la vecchia cartella non esiste più sul disco (confronto esatto del nome, così il rename solo-maiuscole su un file system case-insensitive è riconosciuto); si sceglie la cartella più esterna che soddisfa la regola. Le `delete` dei file sotto la cartella partono prima della `move_prefix`. Dopo `accepted` le righe passano a `synced` (o `local_modified` se anche modificate) senza indovinare le revisioni: le `move` dell'eco, al pull successivo, danno a ogni file la sua revisione; il contenuto modificato parte dopo, sulla revisione nuova. L'id dell'operazione resta nell'outbox per l'idempotenza in caso di risposta persa. Un file con una modifica remota ancora da fondere trattiene l'intero rename (inviarlo a pezzi dividerebbe la cartella).
- **`move_prefix` rifiutata** (collisione, `FORBIDDEN`, `NOT_FOUND`, …): il round successivo invia le `move` singole, ciascuna con il proprio esito; non si riprova lo stesso rename né uno più interno.
- **`SHARE_ROOT_MOVE` su una `move` singola** (per esempio l'ultimo file spostato mentre la vecchia cartella resta sul disco): il motore chiede le radici delle condivisioni di cartella del vault (`GET /shares?scope=owned`, interfaccia opzionale `FolderShareRooter` del remote) e, se il file ha mantenuto il suo posto sotto il nuovo nome della radice, invia la `move_prefix` della radice; la condivisione segue. Altrimenti lo spostamento resta in quarantena locale (riga `local_moved` ferma, `last_error` con il codice del server), il file resta dove l'utente l'ha messo (D-04) e lo stato della sync (`Status.Error`, fase `idle`, senza backoff) spiega che il file è uscito da una cartella condivisa; riportarlo dentro, o spostarlo di nuovo, lo sblocca.
- **Vault privato:** invariato, `move` per file con il path cifrato di nuovo (`enc1`/`enc2` secondo il flag e il pin del vault).
- **Mount (destinatario editor):** stesso comportamento con path relativi alla radice della condivisione; la radice del mount non è rinominabile (il server risponde `SHARE_ROOT_MOVE`). In arrivo il server proietta le revisioni: `move` dentro lo scope, `delete` per i file usciti, `create` per quelli entrati; dopo il rename della radice da parte dell'owner i file "rientrano" allo stesso path relativo e, avendo lo stesso blob, il client aggiorna solo la revisione senza riscaricarli.
- **Pull:** una serie consecutiva di `move` che rinomina un'intera cartella locale (nessun altro file sotto la cartella, destinazione libera) si applica con un solo rename della directory e una transazione su `sync.db`; negli altri casi si applicano le `move` una per una, con `makeRoom` sulle collisioni.

Test: unitari con un server in memoria che modella le regole del cloud (`folders_test.go`), di integrazione contro il binario cloud reale (`e2e_folders_test.go`: rename condiviso visto dall'altro dispositivo e dal destinatario, solo-maiuscole, privato, `SHARE_ROOT_MOVE` recuperato e parcheggiato, modifica concorrente dentro la cartella rinominata) e un caso nel test di contratto (`transport/contract_test.go`: `move_prefix` con ribasamento della share, solo-maiuscole, `SHARE_ROOT_MOVE` per file e dalla radice del mount). Nessuna modifica al server né a `api/openapi.yaml`.

### Integrazione lato server (lotto W8, finale)

Le regole della radice condivisa valgono ora anche per `move_prefix`, sul server (`checkShareRoots` in `services/cloud/internal/sync/ops.go`, nessuna modifica al contratto):

- una `move_prefix` di una cartella **dentro** una condivisione di cartella verso un percorso **fuori** da essa, che porterebbe via tutti i file della condivisione, è rifiutata con `SHARE_ROOT_MOVE` come la `move` dell'ultimo file (prima svuotava la condivisione senza ribasarla). Se nella condivisione resta almeno un file è un rename normale: i destinatari vedono le cancellazioni;
- una `move_prefix` fatta da un editor **attraverso un mount** ribasa le condivisioni annidate nella cartella spostata (prima `RebasePrefixShares` girava solo per l'owner, lasciando quelle condivisioni su una cartella non più esistente). La radice del mount resta non rinominabile;
- la stessa regola protegge le condivisioni annidate anche dalle `move` per file fatte da un mount (prima il controllo era saltato per i destinatari). Il dettaglio dell'errore usa i percorsi relativi al mount. Il client, da un mount, non può ricostruire la radice (`FolderShareRoots` non elenca le condivisioni altrui) e lascia lo spostamento in quarantena con il messaggio, senza perdite (D-04).

Test di integrazione: `TestMovePrefixShareRoots` e `TestMovePrefixFromMountRebasesNestedShares` (`services/cloud/test/integration/sharing_test.go`).
