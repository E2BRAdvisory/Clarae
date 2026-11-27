# ADR-0066 — Cartelle dei sistemi di versione fuori dalla sincronizzazione ed elenco dei file non inviati (M26)

|                       |                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stato**             | accettata (2026-11-21); recepita in `Specifications.md` v1.10 (2026-11-27); implementata in M26: core nella 1.8.3, interfaccia nella 1.8.8                                                                                                                                                                                                                           |
| **Data**              | 2026-11-21                                                                                                                                                                                                                                                                                                                                                           |
| **Riferimenti spec**  | §3.4.2 (riga «Esclusi dal sync», `Specifications.md:1104`); §3.4.3 (`sync.db`, quarantena, `:1109`); §3.4.4 A (rilevamento locale, `:1138`); D-03 (quota, `:1958`); D-04; V-02; ADR-0009; ADR-0039; ADR-0047; ADR-0064                                                                                                                                               |
| **Devia dallo spec?** | **sì:** §3.4.2 non elenca le cartelle dei sistemi di versione; §3.4.4 A non dice che cosa succede a un file già sincronizzato il cui path diventa escluso; nessuna sezione descrive l'elenco dei file non inviati in Impostazioni › Sincronizzazione. Le righe da aggiornare nello spec (a cura dell'owner) sono in «Conseguenze»                                    |
| **Superfici**         | desktop e workbench web (stesso core Go, desktop e WASM; prove: test di `shared/go/pathrules` e di `apps/desktop/internal/sync`, anche sotto `task test-wasm`, vitest di `SyncUnsent`, voce `sync.unsent` nel registro di parità); cloud: nessun codice nuovo, eredita la regola (rifiuto dei commit e ZIP), con un test d'integrazione; console: nessun cambiamento |

## Contesto

Richiesta dell'owner del 2026-11-21: Clarae deve escludere **sempre** dalla sincronizzazione le cartelle dei sistemi di versione (`.git`, `.hg`, `.svn`) e mostrare in Impostazioni › Sincronizzazione **l'elenco dei file non inviati, con il motivo**.

Lo stato di partenza:

- **Le esclusioni** sono una sola funzione, `pathrules.IsExcluded` (`shared/go/pathrules/pathrules.go`): file di sistema (`.DS_Store`, `Thumbs.db`, `desktop.ini`), `*.tmp`, file di appoggio della scrittura atomica, `.trash/` (facoltativo) e i file locali della cartella di configurazione. La stessa funzione decide anche che cosa il core vede del vault: `vault.FS.Walk` (albero, indice, ricerca, ZIP locale), lo scan del sync (`walkLocal`), il pull (`skipExcluded`, `pull.go:427`), il rifiuto dei commit nei vault condivisi (`resolvePath`, `services/cloud/internal/sync/service.go:620`) e l'export ZIP del cloud (`services/cloud/internal/export/service.go:140`).
- **Le cartelle `.git` e simili** non sono escluse: l'esploratore le nasconde (`isHidden`, `packages/workbench/src/sidebar/FileExplorer.tsx:109`), ma il core le visita, le indicizza e le sincronizza. Un vault che è anche un repository manda nel cloud migliaia di oggetti, consuma quota e rallenta scan e push. Il merge dei file di un repository (`index`, `HEAD`, i pack) da due dispositivi produce copie di conflitto o un repository incoerente.
- **Un file che diventa escluso è pericoloso.** Il commento su `windowsReserved` in `pathrules.go` lo dice già: un file sincronizzato che diventa invisibile allo scan è preso per una cancellazione locale (`StateLocalDeleted`) e la cancellazione parte verso il cloud. Gli altri dispositivi aggiornati la ignorerebbero (il pull salta i path esclusi), ma un dispositivo ancora su 1.8.x la applicherebbe e manderebbe nel cestino la propria `.git`.
- **I file che non partono** non si vedono. Il motore li «parcheggia» (`Engine.park`, `push.go:382`: `Attempts = MaxAttempts` e un `LastError` a testo libero) per `FILE_TOO_LARGE`, per un errore di cifratura del path o del contenuto e per ogni rifiuto del server senza gestione dedicata (`PATH_INVALID`, `FORBIDDEN`, …); un file con troppe modifiche concorrenti finisce in `conflict` con «too many concurrent edits». I nomi che `pathrules.Normalize` rifiuta (per esempio `Riunione 10:30.md` creato da un altro programma) e i symlink sono saltati in silenzio da `vault.FS.walk`. Impostazioni › Sincronizzazione (`packages/workbench/src/settings/SyncSection.tsx`) mostra solo l'errore dell'engine, i conflitti e il **conteggio** della quarantena, che riguarda i file in arrivo (ADR-0039).

## Decisione

### Parte 1 — Cartelle dei sistemi di versione

**1. Regola.** Un path è escluso dalla sincronizzazione se **un suo segmento qualsiasi** è uno di `.git`, `.hg`, `.svn`, `.bzr`, `.jj` (decisione dell'owner del 2026-11-21: le tre richieste più Bazaar e Jujutsu).

- Vale per una cartella e per un file con quel nome: il `.git` dei worktree e dei submodule è un file.
- Vale a qualunque profondità: `Progetti/sito/.git/…` è escluso come `.git/…` nella radice.
- Il confronto ignora maiuscole e minuscole: la regola dipende solo dalla stringa del path, quindi dà lo stesso esito su tutti i dispositivi.
- Restano sincronizzati `.gitignore`, `.gitattributes`, `.github/`, `.hgignore`: non sono il repository, sono contenuto dell'utente.
- `CVS` e `_darcs` **non** sono nella regola: sono nomi plausibili per cartelle normali.
- La regola è fissa, non configurabile (V-02, come le altre esclusioni di §3.4.2).

**2. Un solo punto, i motivi classificati.** `pathrules` espone `ExclusionReason(normalized string, excludeTrash bool) Reason`, con i valori `""` (non escluso), `vcs`, `os-junk`, `temporary`, `trash`, `device-local`; `IsExcluded` diventa `ExclusionReason(…) != ""`, con lo stesso comportamento per le regole esistenti. La lista delle cartelle è `pathrules.VCSDirs`. Senza altro codice ne seguono quattro effetti:

- `vault.FS.Walk` non scende nelle cartelle VCS: niente albero, indice, ricerca né ZIP locale. Su disco restano intatte: git, il terminale integrato (ADR-0064) e gli altri programmi le vedono come prima.
- Il pull le salta (`skipExcluded`): un file VCS presente nel cloud non viene mai scritto né cancellato in locale.
- Il cloud rifiuta con `PATH_INVALID` i nuovi commit su quei path nei vault condivisi (`resolvePath`). Un client 1.8.x che prova a mandarli riceve il rifiuto e parcheggia il file: nessun errore bloccante.
- L'export ZIP del cloud non li include.

**3. Righe che diventano escluse: dimenticate, mai cancellate.** All'avvio dell'engine, prima del primo scan, e a ogni scan, ogni riga di `sync_files` con un path escluso si **dimentica**: in una transazione (`DB.WithTx`) si cancellano la riga, la voce di `outbox` e l'eventuale candidato in `pending_remote`. **Non si invia nessuna operazione `delete`.** Il file su disco non si tocca.

- È la regola per **qualunque** esclusione, presente o futura: un path che diventa escluso non è mai una cancellazione.
- Le copie già nel cloud **restano** (decisione dell'owner del 2026-11-21): nessun dispositivo le scarica o le cancella più, ma contano nella quota del proprietario (D-03) finché qualcuno non le toglie. È un debito dichiarato, senza pulizia automatica né azione dedicata in questa versione.

### Parte 2 — Elenco dei file non inviati

**4. Core.** `Engine.Unsent(ctx) ([]UnsentItem, error)` in `apps/desktop/internal/sync` (stesso codice sul desktop e nel core WASM):

```go
type UnsentItem struct {
	Path      string `json:"path"`      // vault-relative; for a skipped name, the raw name made valid UTF-8
	IsDir     bool   `json:"isDir"`     // a whole folder (version control, trash, a folder with an invalid name)
	Reason    string `json:"reason"`    // see the table below
	Code      string `json:"code"`      // server or local code (PATH_INVALID, FILE_TOO_LARGE, ENCRYPT_FAILED, …), "" when none
	Detail    string `json:"detail"`    // the rest of the message (limit and size, server detail, path rule)
	Retryable bool   `json:"retryable"` // RetryUnsent applies
	Info      bool   `json:"info"`      // informative (an excluded folder), not counted in Status.Unsent
}
```

| Fonte                                                           | `Reason`                                                                  | Note                                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Riga parcheggiata (`Attempts >= MaxAttempts`)                   | `too-large`, `encrypt-failed`, `share-root-move`, `rejected` (con codice) | `Retryable`                                                         |
| Riga in errore ancora in riprova (`0 < Attempts < MaxAttempts`) | `retrying`                                                                | con l'ultimo errore                                                 |
| Riga in `conflict` con «too many concurrent edits»              | `too-many-conflicts`                                                      | rimanda alla vista dei conflitti, non `Retryable`                   |
| Riga trattenuta da un candidato al merge (ADR-0039)             | `awaiting-merge`                                                          | transitoria                                                         |
| Nome che `pathrules.Normalize` rifiuta                          | `invalid-name`                                                            | `Detail` = `pathrules.Error.Reason`; si risolve rinominando il file |
| Symlink                                                         | `symlink`                                                                 | mai seguiti (§3.4.2)                                                |
| Cartella esclusa per regola                                     | `vcs`, `trash`                                                            | **una voce per cartella**, `Info`                                   |

Non si elencano `os-junk`, `temporary` e `device-local`: sono rumore senza azione possibile, e il testo d'aiuto della sezione li nomina. Il blocco dell'intero engine (quota esaurita) resta il banner `status.error` esistente, senza dettaglio per file.

**5. Codici stabili.** `park` diventa `park(ctx, row, code, detail)` e scrive `last_error` come `"<CODE>: <detail>"`, con i codici di `syncproto` o con codici locali (`ENCRYPT_FAILED`, `TOO_MANY_CONFLICTS`); un solo helper (`classifyLastError`) ricava `Reason` e `Code` dal testo, comprese le righe scritte dalle versioni precedenti. Il prefisso già letto da `folders.go:457` (`SHARE_ROOT_MOVE`) resta valido. `sync.db` non cambia schema.

**6. Raccolta senza un walk in più.** `vault.FS.WalkReport(fn, skipped func(Skipped))` è il walk di sempre con una callback per ciò che salta (nome non valido, symlink, cartella esclusa con il suo motivo); `walkLocal` la usa e l'engine tiene in memoria le voci saltate dall'**ultimo scan**. Prima del primo scan l'elenco di queste voci è vuoto.

**7. Riprova.** `Manager.RetryUnsent(ctx, localID, paths)` azzera `Attempts` e `LastError` delle righe parcheggiate indicate (tutte, con `paths` vuoto), sotto il lock di esecuzione dell'engine, e avvia un ciclo (`Kick`). Non vale per `too-many-conflicts`, che passa dalla risoluzione dei conflitti, né per le voci che si risolvono sul disco (`invalid-name`, `symlink`).

**8. Binding, stato ed eventi.** `SyncAPI.Unsent(vaultID)` e `SyncAPI.RetryUnsent(vaultID, paths)` (generati con `task gen` nei binding Wails e in `web/src/workbench/core.gen.ts`). `Status` ha un campo `unsent`, il numero delle voci non informative: l'evento `sync:status` esistente lo porta alla UI, che ricarica l'elenco quando il numero o `lastSync` cambiano. Nessun evento nuovo.

**9. Interfaccia.** In Impostazioni › Sincronizzazione, dopo quarantena e conflitti, un blocco «File non inviati» (`packages/workbench/src/settings/SyncUnsent.tsx`):

- voci raggruppate per motivo; per ognuna il path completo (con l'estensione: è un elenco tecnico, ADR-0063 non si applica), il motivo tradotto (`sync.unsent.reason_<reason>`) e il dettaglio;
- «Riprova» sulle voci `Retryable` e «Riprova tutti» (azione `sync:retry-unsent` con `feature`, come `sync:pause`);
- le cartelle escluse in un `<details>` chiuso, «Cartelle escluse» (repository e cestino);
- stato vuoto: «Tutti i file sono stati inviati»;
- un testo d'aiuto che elenca le esclusioni fisse di §3.4.2, VCS compresi.

**10. Parità.** Nuova voce `sync.unsent` in `shared/parity/features.yaml` (binding, azione, prove desktop e workbench sul core WASM). Nel workbench web le voci `invalid-name` e `symlink` non si presentano di fatto (il vault del browser non ha nomi del genere), ma il codice è lo stesso.

## Alternative considerate

- **Escludere le cartelle VCS solo nel motore di sync, non in `IsExcluded`.** Due regole divergenti; il cloud continuerebbe ad accettare i commit `.git` dei client vecchi, e l'indice continuerebbe a visitare migliaia di file inutili. Scartata.
- **Cancellare dal cloud i file VCS già caricati, automaticamente o con un pulsante.** Libera quota, ma un dispositivo ancora su 1.8.x riceverebbe la cancellazione e manderebbe nel cestino la propria `.git`. Scartata per decisione dell'owner; resta possibile in seguito, quando i client 1.8.x non saranno più in uso.
- **Lasciare che lo scan tratti i file diventati esclusi come cancellazioni.** È la perdita descritta nel Contesto. Scartata.
- **Una colonna `last_code` in `sync.db`.** Una migrazione per un dato che un prefisso codificato già porta. Scartata.
- **Elencare anche `.DS_Store`, i temporanei e i file locali di `.clarae/`.** Rumore senza azione possibile. Scartata.
- **Esclusioni configurabili dall'utente (sul modello di `.gitignore`).** Fuori da V-02 e da §3.4.2, che vogliono un comportamento fisso e uguale su tutti i dispositivi. Scartata.

## Conseguenze

- **Vault che sono repository.** Il repository resta solo locale: per averlo su un altro dispositivo si usa git (remote), non Clarae. Le note del repository continuano a sincronizzarsi come prima.
- **Copie già nel cloud.** Restano e contano nella quota del proprietario (D-03); i dispositivi aggiornati non le toccano più. Un client 1.8.x su un vault **privato** continua a scambiarle con altri client 1.8.x (il cloud non vede i path); su un vault **condiviso** i suoi nuovi invii sono rifiutati e parcheggiati.
- **Indice e ricerca.** Le cartelle VCS escono dall'indice alla prossima ricostruzione o aggiornamento: nessuna migrazione dell'indice (`index.db` è derivato).
- **Diagnosi.** I file parcheggiati, i nomi non validi e i symlink diventano visibili all'utente; i nuovi messaggi di `park` hanno un prefisso di codice stabile.
- **Da rivedere:** la pulizia dei file VCS già nel cloud, quando non ci saranno più client 1.8.x; un elenco analogo per i file **in arrivo** non applicati (quarantena e path esclusi dal pull), oggi solo contati.

**Righe da aggiornare in `Specifications.md`** (recepite nella v1.10 del 2026-11-27, con in più la riga del modulo `sync` di §2.5):

- §3.4.2, riga «Esclusi dal sync»: aggiungere «le cartelle dei sistemi di versione `.git`, `.hg`, `.svn`, `.bzr`, `.jj` (cartella o file, a qualunque profondità, senza distinzione di maiuscole) (ADR-0066)».
- §3.4.4 A: «Un file già sincronizzato il cui path diventa escluso (§3.4.2) si dimentica in `sync.db` senza inviare cancellazioni; le copie nel cloud restano (ADR-0066)».
- §3.4.3: i codici stabili in `last_error` (`<CODE>: <detail>`) e l'elenco dei file non inviati (`SyncAPI.Unsent`, `SyncAPI.RetryUnsent`, `Status.unsent`).
- Appendice C.4: riga dell'ADR-0066.
