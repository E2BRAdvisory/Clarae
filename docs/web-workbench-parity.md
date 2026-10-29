# Parità tra il workbench web e il client desktop (M9-WP7)

Obiettivo (ADR-0029): dal browser si fa tutto ciò che si fa dal client desktop, con la stessa interfaccia e lo stesso comportamento. Qui sta ciò che è **verificato**, ciò che **non lo è** e le **eccezioni**.

## Perché la parità è per costruzione, e dove no

- **Stessa UI:** il frontend desktop è il pacchetto `@memobrain/workbench`, montato così com'è dal desktop e dalla Web UI. Un comando o un pannello non esiste in due versioni.
- **Stessa logica:** i binding sono gli struct Go del desktop compilati in WebAssembly (`apps/desktop/cmd/memobrain-core`), esposti da un dispatcher che segue la semantica di Wails. L'elenco dei servizi è uno solo (`App.Services()`).
- **Cosa cambia davvero:** il file system (OPFS dietro lo shim `fs`), SQLite (sqlite-wasm), la sessione (il token lo dà la pagina), la notifica delle modifiche (niente fsnotify) e le finestre di dialogo (download, selettore di file del browser). È lì che possono nascondersi le differenze: i bug veri trovati finora stanno tutti in quel livello (un `open` concorrente dello stesso file dava EBUSY; il mock di Wails copriva il bridge).

## Eccezioni dichiarate

| Funzione desktop                                                            | Sul web                           | Motivo                                                               |
| --------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------- |
| Aggiornamento automatico (`update:check`, `UpdaterAPI`)                     | assente                           | la Web UI la serve il cloud, è sempre aggiornata                     |
| Vault su una cartella del computer (`VaultAPI.PickFolder`, «Apri cartella») | assente                           | si aprono vault del cloud, copiati nel browser                       |
| Importer da cartella                                                        | assente (per ora)                 | richiede una cartella locale; riattivabile con `showDirectoryPicker` |
| Avviso sul disco non cifrato (`DiskEncryption`)                             | assente                           | non c'è un disco di cui parlare                                      |
| Link `memobrain://`                                                         | sostituito da `/vaults/:id/open`  | schema di URL del sistema operativo                                  |
| Schermo intero della finestra                                               | solo Fullscreen API dell'elemento | nessuna finestra nativa                                              |
| Cestino di sistema                                                          | `.trash/` del vault               | il browser non ha un cestino                                         |
| Più vault aperti insieme                                                    | uno per browser                   | gli handle sincroni di OPFS sono esclusivi                           |

## Cosa è verificato (2026-10-29)

| Livello                                 | Cosa                                                                                                                                                        | Dove                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Core Go sotto WASM                      | tutti i pacchetti di `apps/desktop/internal` e `cmd`                                                                                                        | `make test-wasm` (29 pacchetti)                                   |
| Shim `fs` su OPFS                       | 11 test in un worker vero, tra cui rename atomico, cartelle, handle condivisi                                                                               | `web/e2e/opfs-fs.spec.ts`                                         |
| Workbench sul core vero                 | 11 test: scrittura, ricerca FTS5, link, rinomina, storia, ZIP, grafo, persistenza, blocco e cancellazione, «Dimentica questo browser»                       | `web/e2e/workbench.spec.ts`                                       |
| **Gli stessi spec del desktop sul web** | 14 test di 5 file (`workflows`, `keyboard`, `editor-toolbar`, `slides`, `graph`) eseguiti sul core vero con `E2E_TARGET=web`                                | `yarn workspace @memobrain/web e2e:workbench-ui`                  |
| Cloud vero                              | login Keycloak, dispositivo `web`, due browser: una nota arriva dall'uno all'altro e due modifiche concorrenti alla stessa nota `.md` si fondono sul client | `web/e2e-cloud/web-sync.spec.ts` (`e2e:cloud`, richiede lo stack) |
| Sicurezza                               | build minificata con l'handler Go e la CSP di produzione, nessuna violazione né richiesta esterna, WASM in gzip                                             | `web/e2e-security/workbench-csp.spec.ts`                          |

## Cosa NON è verificato

- **Desktop nativo ↔ web contro lo stesso cloud.** Il test del cloud usa due browser: il protocollo e il codice di sincronizzazione sono gli stessi del desktop (è lo stesso core), ma una modifica fatta da un'app desktop vera e letta dal browser non è stata provata. Il desktop ha i propri test di sync a due dispositivi (`apps/desktop/internal/sync`, tag `integration`).
- **Copia di conflitto per `.canvas` e `.excalidraw`** dal browser: provata solo la fusione di un `.md`.
- **Vault privati (E2EE)** nel browser: sblocco con passphrase, scrittura cifrata e cancellazione al blocco sono provati solo in parte (la cancellazione sì; lo sblocco e la sincronizzazione cifrata no, perché il test non crea un vault privato).
- **Mount di una condivisione** (`?share=`) e il flag `web_workbench` spento con un cloud vero.
- **Specifici del desktop non portati:** gli spec di disegno (Excalidraw), canvas, condivisione, accessibilità (axe) e prestazioni dipendono dai dati del mock e non girano ancora sul web; l'unico controllo di accessibilità sul web è quello delle slide.
- **Safari e Firefox:** solo Chromium.
- **Prestazioni:** indicizzazione di vault grandi nel browser (stimata > 5 minuti a 50k note, ADR-0030).

## Tabelle generate

Le tabelle qui sotto si rigenerano con `node scripts/parity.mjs`; la CI (`--check`) fallisce se un comando o un binding nuovo non compare.

<!-- parity:begin (generated by scripts/parity.mjs; do not edit) -->

### Comandi (72)

71 su 72 sono disponibili sul web; gli altri dipendono da una capability che il browser non ha. Il codice è quello del desktop (`packages/workbench`).

| Comando | Gruppo | Sul web | Nota |
| --- | --- | --- | --- |
| `note:new` | file | yes |  |
| `note:new-tab` | file | yes |  |
| `folder:new` | file | yes |  |
| `drawing:new` | file | yes |  |
| `canvas:new` | file | yes |  |
| `bases:new` | file | yes |  |
| `drawing:insert` | editor | yes |  |
| `note:rename` | file | yes |  |
| `note:delete` | file | yes |  |
| `sharing:open` | app | yes |  |
| `sharing:share` | file | yes |  |
| `vault:export-zip` | file | yes |  |
| `note:export-pdf` | file | yes |  |
| `note:export-image` | file | yes |  |
| `note:export-html` | file | yes |  |
| `update:check` | file | no (needs `updater`) | the Web UI is served by the cloud: there is nothing to update |
| `import:open` | file | yes |  |
| `vault:switch` | file | yes |  |
| `vault:close` | file | yes |  |
| `index:rebuild` | app | yes |  |
| `switcher:open` | navigate | yes |  |
| `palette:open` | navigate | yes |  |
| `search:vault` | navigate | yes |  |
| `tab:next` | navigate | yes |  |
| `tab:prev` | navigate | yes |  |
| `tab:close` | navigate | yes |  |
| `tab:pin` | navigate | yes |  |
| `tab:close-right` | navigate | yes |  |
| `tab:close-left` | navigate | yes |  |
| `tab:close-others` | navigate | yes |  |
| `tab:close-all` | navigate | yes |  |
| `pane:close` | navigate | yes |  |
| `mode:toggle-reading` | view | yes |  |
| `mode:toggle-source` | view | yes |  |
| `pane:split-right` | view | yes |  |
| `pane:split-down` | view | yes |  |
| `pane:link` | view | yes |  |
| `sidebar:left` | view | yes |  |
| `sidebar:right` | view | yes |  |
| `theme:toggle` | view | yes |  |
| `separator:insert` | editor | yes |  |
| `sidebar:outline` | view | yes |  |
| `graph:open` | view | yes |  |
| `graph:open-local` | view | yes |  |
| `sidebar:properties` | view | yes |  |
| `slides:start` | view | yes |  |
| `slides:start-here` | view | yes |  |
| `sidebar:slides` | view | yes |  |
| `sidebar:stats` | view | yes |  |
| `sidebar:backlinks` | view | yes |  |
| `sidebar:tags` | view | yes |  |
| `sidebar:files` | view | yes |  |
| `editor:bold` | editor | yes |  |
| `editor:italic` | editor | yes |  |
| `editor:highlight` | editor | yes |  |
| `editor:strike` | editor | yes |  |
| `editor:code` | editor | yes |  |
| `editor:comment` | editor | yes |  |
| `editor:link` | editor | yes |  |
| `editor:wikilink` | editor | yes |  |
| `editor:bullet` | editor | yes |  |
| `editor:numbered` | editor | yes |  |
| `editor:quote` | editor | yes |  |
| `editor:task` | editor | yes |  |
| `sync:connect` | app | yes |  |
| `sync:now` | app | yes |  |
| `sync:conflicts` | app | yes |  |
| `sync:history` | app | yes |  |
| `recovery:open` | file | yes |  |
| `recovery:deleted` | file | yes |  |
| `sync:unlock` | app | yes |  |
| `settings:hotkeys` | app | yes |  |

### Binding Go (122 metodi, 20 servizi)

Il dispatcher del core espone tutti i 122 metodi (verificato da `TestDispatcherMatchesTheGeneratedBindings`). **13 su 122** sono chiamati da un test del workbench web contro il core vero (`web/e2e`, `web/e2e-cloud`); gli altri girano nello stesso codice Go, provato sotto WASM dai test del core (`make test-wasm`), ma non hanno ancora un test nel browser.

| Binding | Esposto sul web | Chiamato in un test web | Nota |
| --- | --- | --- | --- |
| `AuthAPI.Login` | yes | — |  |
| `AuthAPI.Logout` | yes | — |  |
| `AuthAPI.Status` | yes | — |  |
| `BasesAPI.Load` | yes | — |  |
| `BasesAPI.NewBaseContent` | yes | — |  |
| `BasesAPI.Run` | yes | — |  |
| `BasesAPI.UpdateProperty` | yes | — |  |
| `BasesAPI.UpdateView` | yes | — |  |
| `ComposerAPI.ApplyMerge` | yes | — |  |
| `ComposerAPI.Extract` | yes | — |  |
| `ComposerAPI.PlanMerge` | yes | — |  |
| `ComposerAPI.SuggestTitle` | yes | — |  |
| `ConfigAPI.Effective` | yes | — |  |
| `ConfigAPI.Refresh` | yes | — |  |
| `DrawingAPI.ImportLegacy` | yes | — |  |
| `DrawingAPI.ReadPreview` | yes | — |  |
| `DrawingAPI.SavePreview` | yes | — |  |
| `DrawingAPI.WriteExport` | yes | — |  |
| `ExportAPI.Print` | yes | — |  |
| `ExportAPI.SaveFile` | yes | — |  |
| `ExportAPI.SaveHTML` | yes | — |  |
| `GraphAPI.Build` | yes | yes |  |
| `HistoryAPI.GetSettings` | yes | — |  |
| `HistoryAPI.List` | yes | yes |  |
| `HistoryAPI.ListDeleted` | yes | — |  |
| `HistoryAPI.Read` | yes | — |  |
| `HistoryAPI.Restore` | yes | — |  |
| `HistoryAPI.SetSettings` | yes | — |  |
| `ImporterAPI.Cancel` | yes | — |  |
| `ImporterAPI.DefaultFolder` | yes | — |  |
| `ImporterAPI.Detect` | yes | — |  |
| `ImporterAPI.ListSources` | yes | — |  |
| `ImporterAPI.PickFile` | yes | — |  |
| `ImporterAPI.Preview` | yes | — |  |
| `ImporterAPI.Report` | yes | — |  |
| `ImporterAPI.Run` | yes | — |  |
| `LinksAPI.ApplyRename` | yes | yes |  |
| `LinksAPI.Backlinks` | yes | yes |  |
| `LinksAPI.Outgoing` | yes | — |  |
| `LinksAPI.PlanRename` | yes | — |  |
| `LinksAPI.Resolve` | yes | — |  |
| `LinksAPI.Suggest` | yes | — |  |
| `LinksAPI.UnlinkedMentions` | yes | — |  |
| `PropertiesAPI.Keys` | yes | — |  |
| `PropertiesAPI.Remove` | yes | — |  |
| `PropertiesAPI.Schema` | yes | — |  |
| `PropertiesAPI.SetType` | yes | — |  |
| `PropertiesAPI.Update` | yes | — |  |
| `SearchAPI.Explain` | yes | — |  |
| `SearchAPI.Query` | yes | yes |  |
| `SettingsAPI.Get` | yes | — |  |
| `SettingsAPI.Info` | yes | yes |  |
| `SettingsAPI.Set` | yes | — |  |
| `SharingAPI.AcceptShare` | yes | — |  |
| `SharingAPI.CreateShare` | yes | — |  |
| `SharingAPI.DeclineShare` | yes | — |  |
| `SharingAPI.Directory` | yes | — |  |
| `SharingAPI.Invitations` | yes | — |  |
| `SharingAPI.Mounts` | yes | — |  |
| `SharingAPI.OpenMount` | yes | — |  |
| `SharingAPI.RemoveGrant` | yes | — |  |
| `SharingAPI.RemoveMount` | yes | — |  |
| `SharingAPI.RevokeShare` | yes | — |  |
| `SharingAPI.SetGrant` | yes | — |  |
| `SharingAPI.Share` | yes | — |  |
| `SharingAPI.VaultShares` | yes | — |  |
| `SyncAPI.ConflictTexts` | yes | — |  |
| `SyncAPI.Conflicts` | yes | — |  |
| `SyncAPI.Devices` | yes | — |  |
| `SyncAPI.History` | yes | — |  |
| `SyncAPI.Info` | yes | — |  |
| `SyncAPI.LinkExisting` | yes | — |  |
| `SyncAPI.LinkNew` | yes | — |  |
| `SyncAPI.ListCloudVaults` | yes | — |  |
| `SyncAPI.ResolveConflict` | yes | — |  |
| `SyncAPI.RestoreRevision` | yes | — |  |
| `SyncAPI.RevisionText` | yes | — |  |
| `SyncAPI.RevokeDevice` | yes | — |  |
| `SyncAPI.SetPaused` | yes | yes |  |
| `SyncAPI.SetPollInterval` | yes | — |  |
| `SyncAPI.Status` | yes | — |  |
| `SyncAPI.SyncNow` | yes | yes |  |
| `SyncAPI.Unlink` | yes | — |  |
| `SyncAPI.Usage` | yes | — |  |
| `TagsAPI.List` | yes | yes |  |
| `TemplatesAPI.CreateFromTemplate` | yes | — |  |
| `TemplatesAPI.DailyAdjacent` | yes | — |  |
| `TemplatesAPI.Expand` | yes | — |  |
| `TemplatesAPI.List` | yes | — |  |
| `TemplatesAPI.NewUnique` | yes | — |  |
| `TemplatesAPI.OpenDaily` | yes | — |  |
| `TemplatesAPI.ReadSettings` | yes | — |  |
| `TemplatesAPI.WriteSettings` | yes | — |  |
| `UpdaterAPI.Check` | yes (reports disabled) | — | updates do not apply (the core reports them as disabled) |
| `UpdaterAPI.GetSettings` | yes (reports disabled) | — | updates do not apply (the core reports them as disabled) |
| `UpdaterAPI.Install` | yes (reports disabled) | — | updates do not apply (the core reports them as disabled) |
| `UpdaterAPI.SetSettings` | yes (reports disabled) | — | updates do not apply (the core reports them as disabled) |
| `UpdaterAPI.Skip` | yes (reports disabled) | — | updates do not apply (the core reports them as disabled) |
| `UpdaterAPI.Status` | yes (reports disabled) | — | updates do not apply (the core reports them as disabled) |
| `VaultAPI.CloseVault` | yes | — |  |
| `VaultAPI.CreateFolder` | yes | — |  |
| `VaultAPI.ExportZip` | yes | yes |  |
| `VaultAPI.ListOpen` | yes | yes |  |
| `VaultAPI.ListRecent` | yes | — |  |
| `VaultAPI.ListTree` | yes | — |  |
| `VaultAPI.OpenVault` | yes | — |  |
| `VaultAPI.PickFolder` | yes | — | vaults are cloud vaults, not folders of the computer |
| `VaultAPI.ReadBinary` | yes | — |  |
| `VaultAPI.ReadConfig` | yes | — |  |
| `VaultAPI.ReadNote` | yes | yes |  |
| `VaultAPI.RebuildIndex` | yes | — |  |
| `VaultAPI.Rename` | yes | — |  |
| `VaultAPI.SaveAttachment` | yes | — |  |
| `VaultAPI.Trash` | yes | — |  |
| `VaultAPI.WriteConfig` | yes | — |  |
| `VaultAPI.WriteNote` | yes | yes |  |
| `VaultCryptoAPI.ChangePassphrase` | yes | — |  |
| `VaultCryptoAPI.DiskEncryption` | yes | — | no disk to check (not called on the web) |
| `VaultCryptoAPI.Lock` | yes | — |  |
| `VaultCryptoAPI.RegenerateRecoveryKey` | yes | — |  |
| `VaultCryptoAPI.SetPassphrase` | yes | — |  |
| `VaultCryptoAPI.Unlock` | yes | — |  |

<!-- parity:end -->
