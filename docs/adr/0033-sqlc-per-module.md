# ADR-0033 — Un pacchetto sqlc per modulo e proprietà delle tabelle nel cloud

|                       |                                                                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stato**             | accettata                                                                                                                                                 |
| **Recepito in**       | `Specifications.md` v1.4 (2026-11-02): §1.1, §2.7.3, §4.3 (Appendice C.4)                                                                                 |
| **Data**              | 2026-10-30                                                                                                                                                |
| **Riferimenti spec**  | §4.3 (moduli del cloud, «mai alle tabelle altrui», lint `depguard`/`go-arch-lint`), §2.7.3 (Excalidraw offline), V-08                                     |
| **Devia dallo spec?** | sì (§4.3) → eccezioni dichiarate alla regola «mai alle tabelle altrui»; nuovo modulo `settings`; l'albero di §4.3 guadagna `internal/<modulo>/<modulo>db` |

**Aggiornamento 2026-11-02.** `security.yml` è stato rimosso (ADR-0036); il gate offline di Excalidraw gira nella suite locale `yarn workspace @memobrain/web e2e:security`. Le eccezioni recepite nello spec sono quelle di `ownership_test.go` alla data (tra cui le letture di `jobs` su `file_revisions` e `shares`).

## Contesto

Lo spec (§4.3) chiede che ogni modulo del cloud dipenda solo da `db`, `storage`, `audit`, `notify` e dalle interfacce degli altri moduli, **mai dalle loro tabelle**, con un lint che lo verifichi. Il codice aveva invece un unico pacchetto generato, `internal/db/dbgen`, con tutte le 165 query, e `.golangci.yml` non conteneva alcuna regola per i moduli. Una misura sul codice ha trovato 12 moduli su 15 che leggevano o scrivevano tabelle altrui. Tra le scritture incrociate:

- `admin` cambiava stato, ruolo e quota in `users`;
- `sync` aggiornava `vaults`, `devices` e `shares` nel commit;
- `groups` cancellava `share_grants`;
- `jobs` e `privacy` toccavano quasi tutto.

I tipi generati (`dbgen.Vault`, `dbgen.User`, `dbgen.Share`) attraversavano i moduli.

## Decisione

**Pacchetti.** Ogni modulo ha un file di query, `internal/db/queries/<modulo>.sql`. sqlc lo genera in `internal/<modulo>/<modulo>db`: una voce per modulo in `sqlc.yaml`, con `omit_unused_structs`. `dbgen` non esiste più. Le query non usate sono state eliminate: `ListUserUsage`, `ListSettings`, `GetGrant`, `GetFileLive`, `GetUserBySub`, `GetUserStatus`.

**Transazioni.** `db.WithTx` passa la `pgx.Tx`, e ogni modulo costruisce le proprie query (`<modulo>db.New(tx)`). Le funzioni che un modulo offre agli altri dentro una transazione prendono `db.DBTX` (pool o transazione), per esempio:

- `blobs.AddRef` e `blobs.VaultBlob`;
- `quota.Charge`, `quota.UsedBytes` e `quota.Release`;
- `audit.Record`;
- `sharing.DeleteGrantsOfPrincipal`.

**Accessi incrociati.** Il proprietario espone wrapper sottili (`internal/<modulo>/exported.go`). Ogni wrapper esegue una query sul `DBTX` del chiamante. I tipi di parametri e righe sono alias (`users.User = usersdb.User`, `vaults.Vault`, `groups.Group`, …), così i valori passano invariati e il chiamante non importa mai il pacchetto db altrui. Se la chiamata diretta creerebbe un ciclo di import, si inietta un'interfaccia dall'applicazione: `groups.GrantRemover`, implementata da `sharing`.

**Nuovo modulo `settings`.** È proprietario della tabella `settings`, cioè delle impostazioni di sistema e della revisione della configurazione. Prima sei moduli la leggevano direttamente; ora espongono le funzioni `Get`, `Int`, `Set`, `ConfigRevision` e `BumpConfigRevision`.

**Proprietà delle tabelle** (`services/cloud/internal/db/ownership_test.go`):

| Modulo           | Tabelle                                                            |
| ---------------- | ------------------------------------------------------------------ |
| `users`          | `users`, `devices`                                                 |
| `vaults`         | `vaults`, `vault_key_envelopes`                                    |
| `sync`           | `files`, `file_revisions`                                          |
| `revisions`      | `files`, `file_revisions` (co-proprietario: storico e retention)   |
| `quota`          | `users` (solo le colonne di consumo, co-proprietario)              |
| `blobs`          | `blobs`, `vault_blobs`, `uploads`                                  |
| `sharing`        | `shares`, `share_grants`                                           |
| `groups`         | `groups`, `group_members`                                          |
| `configprofiles` | `config_profiles`, `config_profile_versions`, `config_assignments` |
| `audit`          | `audit_log`                                                        |
| `export`         | `export_jobs`                                                      |
| `admin`          | `storage_snapshots`                                                |
| `settings`       | `settings`                                                         |

**Eccezioni accettate.** Sono elencate anche nel test, che fallisce per ogni accesso non dichiarato.

- Letture:
  - `admin`: aggregati della console (utenti, vault, dispositivi, audit, gruppi);
  - `privacy`: export dei dati personali (GDPR art. 15);
  - `notify`: fan-out degli eventi, perché `notify` non può dipendere dai moduli che pubblicano tramite lui;
  - `blobs`: quali blob sono ancora referenziati e quali file vede un lettore condiviso;
  - `sharing`: autorizzazione e radici delle condivisioni, perché `sync` dipende da `sharing`;
  - `vaults`: manifest del vault, perché `sync` dipende da `vaults`;
  - `configprofiles`: appartenenze ai gruppi;
  - `groups`: nomi dei membri.
- Scritture:
  - `jobs`: manutenzione (raccolta dei blob, compattazione, purge, riconciliazione dei contatori);
  - `privacy`: cancellazione dell'account (GDPR art. 17), che cancella le righe dell'account ovunque in un'unica transazione.
- Tipi: `access.Vault` è un alias di `vaultsdb.Vault`. `access` è il vocabolario comune dei moduli che servono contenuto, e `vaults` dipende da `access`. È l'unico import di un pacchetto db altrui, consentito per percorso in depguard.

**Verifica.** Due controlli complementari:

- `depguard` in `.golangci.yml`, con una regola per ogni pacchetto db: nessun file fuori dal modulo può importarlo, salvo l'eccezione di `access`. Gira in `task lint`.
- Il test di proprietà, che analizza ogni file SQL (tabelle lette e scritte) rispetto alla mappa e alle eccezioni, e richiede un proprietario per ogni tabella creata dalle migrazioni. Gira in `task test`.

**Gate offline di Excalidraw (stesso lavoro, §2.7.3).** Un nuovo test Playwright, `web/e2e-security/excalidraw-offline.spec.ts`, gira nel job `web-security` di `security.yml`. Apre nel workbench web di produzione, con la CSP reale e il core vero, un disegno con testo cinese, e fallisce per qualsiasi richiesta esterna.

Il test ha trovato un difetto reale. Excalidraw elenca `esm.sh` come seconda sorgente di ogni font, e il browser andava a prendere da lì le 209 parti del font CJK Xiaolai: tutte bloccate dalla CSP, quindi il testo cinese non veniva mai reso con quel font. Il vecchio test desktop non lo vedeva perché il suo disegno non contiene testo.

La build (`copyExcalidrawAssets`, condivisa da desktop e web) ora riscrive quel fallback verso gli asset dell'app. Se una versione futura del fork cambia quel testo, la build fallisce in modo esplicito.

## Alternative considerate

- **Pacchetti per modulo con allowlist degli import esistenti** — scartata. Fermava i nuovi accessi, ma consolidava quelli esistenti senza ridurli.
- **`dbgen` unico più un test sulle chiamate** — scartata: non dava pacchetti per modulo e non toglieva i tipi condivisi.
- **Nessuna eccezione** (ogni lettura passa dal proprietario) — scartata per ora:
  - avrebbe creato cicli (`sharing`↔`sync`, `vaults`↔`sync`, `notify`↔ moduli che pubblicano);
  - avrebbe spezzato le join di sola lettura in molte query.

  Le eccezioni sono poche e verificate.

- **`go-arch-lint`** (citato dallo spec) — non adottato. `depguard` copre già il vincolo sugli import e gira dentro golangci-lint, senza un altro tool da pinnare. Il controllo sulle tabelle richiedeva comunque un test sull'SQL.

## Conseguenze

- Una query nuova su una tabella altrui fallisce in `task test`, e un import di un pacchetto db altrui fallisce in `task lint`. Aggiungere un'eccezione richiede di aggiornare la mappa del test e questo ADR.
- Le query condivise da più moduli sono duplicate nei rispettivi file, quando una è un'eccezione di lettura (`GetVault` in `jobs`, `GetShare` in `notify`, `GetFile` in `sharing` e `revisions`). Il prezzo è un po' di SQL ripetuto.
- `jobs` ora chiama `admin.SnapshotStorage` e `quota.Release` invece di scrivere direttamente su `storage_snapshots` e `users`. `sync` passa da `vaults`, `users`, `quota` e `sharing` per le loro tabelle, sempre nella stessa transazione del commit.
- Da rivedere: ridurre le eccezioni di scrittura di `jobs` e `privacy` spostando le operazioni nei proprietari (per esempio `vaults.Purge` e `blobs.Collect`).
- L'owner deve aggiornare §4.3 di `Specifications.md`: struttura dei pacchetti, eccezioni e modulo `settings`.
