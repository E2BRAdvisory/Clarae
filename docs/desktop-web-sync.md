# Desktop e web allineati: guida per gli sviluppatori

Come resta uguale ciò che l'utente vede sul client desktop, nel workbench web e, per la gestione dei vault cloud, nella console. Le decisioni stanno in ADR-0029 (workbench web), ADR-0030 (core in WebAssembly) e ADR-0037 (registro delle funzioni, `@memobrain/cloud-features`, client Go generato); lo stato misurato della parità sta in [web-workbench-parity.md](web-workbench-parity.md). Panoramica dell'architettura: [architecture.md](architecture.md).

## Il principio: una UI, una logica

- **Una UI.** Tutta l'interfaccia di un vault è il pacchetto `@memobrain/workbench` (`packages/workbench`). Entrambi gli host lo montano con `mountWorkbench(root, options)` (`packages/workbench/src/mount.tsx`): il desktop da `apps/desktop/frontend/src/main.tsx` con il `kind` predefinito (`desktop`), la Web UI da `web/src/workbench/main.tsx` con `kind: 'web'`. La funzione restituisce un handle con `flush()`, che scrive le modifiche in sospeso entro pochi secondi e non fallisce mai: l'host la chiama prima di smontare la pagina, chiudere la finestra o cancellare una copia.
- **Una logica.** I binding sono gli struct Go elencati da `App.Services()` (`apps/desktop/internal/app/services.go`). Sul desktop Wails li espone come `window.go.app.<Servizio>.<Metodo>`; nel browser lo stesso codice è compilato con `GOOS=js GOARCH=wasm` (`apps/desktop/cmd/memobrain-core`) e il dispatcher `apps/desktop/internal/rpc` li chiama per nome con la stessa semantica di Wails. Il bridge del browser installa `window.go` e `window.runtime`, quindi i moduli generati in `packages/workbench/wailsjs` funzionano senza modifiche. Il protocollo tra pagina, worker e core è descritto in `apps/desktop/cmd/memobrain-core/doc.go`.

Una funzione nuova scritta in `packages/workbench` e nei binding Go esiste quindi su entrambi gli host per costruzione. Le differenze possibili stanno in tre punti, descritti sotto: il confine `Host` nel Go, le capability nella UI e l'host del browser.

## Il confine nel core Go

- **`Host`** (`apps/desktop/internal/app/host.go`) è tutto ciò che il core chiede all'ambiente: eventi verso la UI, finestre di dialogo per file e cartelle, aprire un URL, stampare, uscire, errori fatali. `host_wails.go` (`//go:build !js`) lo implementa con il runtime di Wails; `host_web.go` (`//go:build js`) inoltra ogni chiamata all'oggetto `globalThis.__memobrainHost` che il worker installa. Nel browser `SessionHost` dà al core il token della pagina invece del login nel browser di sistema, e le chiavi dei vault restano solo in memoria. I binding non importano mai Wails.
- **File per piattaforma** con i suffissi `_js.go` e `_native.go` (o un build tag):
  - `internal/store/driver_js.go` e `driver_native.go`: SQLite su sqlite-wasm (`internal/sqlitejs`, driver `database/sql` che chiama `@memobrain/sqlite-bridge`) oppure su `modernc.org/sqlite`;
  - `internal/watcher/notifier_js.go` e `notifier_native.go`: nel browser niente fsnotify, le uniche modifiche sono le scritture del core, notificate da `vault.FS.SetOnChange`;
  - `internal/updater/detach_js.go`: nessun processo da staccare, l'updater è disattivato.
- **Rami `isWeb`** (costante definita in `host_wails.go` e `host_web.go`), pochi e motivati: nome del vault da mostrare per le cartelle del browser (che hanno per nome l'id cloud) e notifica delle scritture (`app.go`); cestino del vault al posto di quello di sistema e `platform: "web"` in `SettingsAPI.Info` (`bindings.go`); updater disattivato con motivazione (`bindings_updater.go`).
- **Regola:** il codice di `apps/desktop/internal` deve compilare e passare i test anche per `js/wasm` (`task test-wasm`, in `task ci`). Ciò che dipende dall'host va dietro `Host` o in un file `*_js.go`/`*_native.go`, non in un controllo sparso.

## Capability nella UI

`packages/workbench/src/platform/index.ts` dice cosa offre l'host: `localFolders` (aprire una cartella come vault), `updater`, `diskEncryptionCheck`, `nativeWindow`. `mountWorkbench` le imposta dal `kind` (`desktop` o `web`); i componenti le leggono con `useCan()` e il codice fuori da React con `can()`.

Un comando che esiste solo dove c'è una capability lo dichiara in `Command.requires` (`packages/workbench/src/commands/registry.ts`), per esempio `requires: ['updater']` per `update:check`; palette, hotkey e menu lo nascondono da soli. Il controllo di parità legge `requires` dal registro a runtime e rifiuta un `yes` sul workbench per un comando che il browser non ha.

## Host del browser

Il codice sta in `web/src/workbench` e gira in una pagina separata dalla console (`workbench.html`, rotta `/vaults/:id/open`), con CSP e SRI propri:

- **`main.tsx`**: autenticazione OIDC, un solo workbench per browser (Web Lock `memobrain-workbench`: gli handle sincroni di OPFS sono esclusivi; un secondo tab mostra un messaggio), avvio di `launch.ts` e montaggio della UI con `kind: 'web'`.
- **`launch.ts`**: avvia il core, aspetta la sessione, rifiuta l'apertura se l'amministratore ha spento `web_workbench`, apre la cartella `/vaults/<id>` e la collega al vault cloud come dispositivo `web` (`SyncAPI.LinkExisting`), poi monta la UI. Le chiamate di avvio hanno limiti di tempo (`callWithin`), così un core bloccato finisce in un messaggio d'errore e non in un caricamento infinito. Se l'OIDC non riesce a rinnovare il token, le modifiche vengono scritte prima del redirect al login.
- **`worker.ts`**: il Web Worker del core. Installa lo shim `fs` su OPFS (`opfs-fs.ts`), sqlite-wasm con il VFS `opfs-sahpool`, l'oggetto `__memobrainHost`, poi carica il core (il `.wasm` è verificato con SRI nel worker; `wasm_exec.js` è incluso nel bundle del worker, coperto dall'integrità del worker stesso). Il messaggio `wipe` cancella una cartella e i database sotto lo stesso prefisso.
- **`bridge.ts`**: lato pagina. Inoltra le chiamate (`call`, `callWithin`), risponde alle richieste del core (token, file picker, download, apertura di URL), distribuisce gli eventi e installa `window.go` e `window.runtime`. Se il worker fallisce o il programma Go termina, ogni chiamata in attesa e successiva viene rifiutata con `CoreDeadError` e la pagina mostra un overlay; `callWithin` rifiuta con `CoreTimeoutError`.
- **Blocco e cancellazione dei vault privati** (W3, ADR-0029 §6, D-04). La copia di un vault privato nel browser è in chiaro, quindi non deve sopravvivere al blocco:
  - il core è l'unico timer di inattività, su entrambi gli host; la UI gli segnala l'attività dell'utente (`VaultCryptoAPI.Activity`, `packages/workbench/src/app/activity.ts`) e la sync in background non lo riavvia;
  - `guard.ts` ascolta `vault:locked`. Se il motivo è `manual` o `idle` e non ci sono modifiche da inviare né conflitti, chiude il vault, cancella la copia e torna alla console; altrimenti mostra un overlay bloccante (`overlay.ts`, costruito via DOM senza stili inline) che dice cosa resta e offre «Sblocca», «Elimina comunque» o «Torna alla console». Un conteggio sconosciuto (`pending: -1`) vale come «modifiche presenti»;
  - uscire (ritorno alla console, logout, richiesta della console) fa flush, `SyncNow`, aspetta lo svuotamento dell'outbox (15 s al massimo), blocca e decide come sopra;
  - `markers.ts` tiene in `localStorage` un marcatore per copia (nome, tipo, `pending`, `conflicts`, `dirty`), aggiornato da `sync:status` e `vault:file-changed`. La console lo legge prima del logout e di «Dimentica questo browser» (`forget.ts`), e all'avvio lo _sweep_ rimuove le copie in chiaro lasciate da un tab chiuso, saltando quelle con modifiche non inviate. Una copia privata conservata va sbloccata prima che il workbench la mostri (`needsGate`, `showUnlockGate`).

## Contratto degli eventi

Gli eventi Go → TypeScript sono definiti in `apps/desktop/internal/app/events.go` e `internal/sync/manager.go`, e ripetuti in `packages/workbench/src/app/events.ts`:

| Evento               | Payload                                                                                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vault:file-changed` | `{vaultId, paths[], changes[]}`; ogni change è `{type: create\|modify\|delete, path, entry?}`, classificato prima che l'indice veda il lotto (`internal/app/changes.go`). La UI aggiorna albero e link in modo mirato (`app/fileChanges.ts`)            |
| `vault:locked`       | `{vaultId, reason: manual\|idle\|sync, pending, conflicts}` (`sync.LockedEvent`), emesso quando la chiave ha lasciato la memoria. `sync` non è un blocco: lo ripete il ciclo di sync finché il vault aspetta la passphrase; `pending: -1` = non contato |
| `sync:status`        | `sync.Status`: `{vaultId, phase: idle\|syncing\|paused\|offline\|error\|locked, lastSync, pending, conflicts, done, total, error, kind}`                                                                                                                |
| altri                | `index:progress`, `sync:conflict`, `auth:state`, `config:updated`, `app:open-request`                                                                                                                                                                   |

Un cambiamento di payload va fatto in modo compatibile (campi nuovi opzionali): il guard del browser tratta per esempio un `vault:locked` senza `reason` come quello di un core più vecchio.

## Gestione dei vault cloud: `@memobrain/cloud-features`

La gestione dei vault cloud (elenco, creazione, rinomina, eliminazione e ripristino; poi dispositivi, utilizzo, condivisioni) è scritta una volta sola in `packages/cloud-features` (ADR-0037 §2, in corso). I componenti, come `CloudVaultsTable`, dipendono solo dall'interfaccia `CloudPort` (`src/port.ts`), con i tipi generati da OpenAPI. Gli adattatori sono due:

- `RestCloudPort` (`packages/cloud-features/src/rest.ts`) per la console, sulla REST attraverso `@memobrain/api-client`;
- `CoreCloudPort` (`packages/workbench/src/cloud/CoreCloudPort.ts`) per desktop e workbench, sui binding Go. Sta nel workbench perché chiama i suoi binding: la dipendenza va solo da workbench a cloud-features.

La stessa suite di test dei componenti (`packages/cloud-features/src/testing/suite.tsx`) gira su entrambi gli adattatori. Regola: una funzione nuova di gestione dei vault cloud nasce qui, mai direttamente in `web/src/pages` o in `packages/workbench/src/settings`. Un vault privato si crea nel browser solo dal workbench, che ha il codice crittografico Go.

## Registro delle funzioni e controllo di parità

`shared/parity/features.yaml` ha una voce per funzione utente con lo stato su desktop, workbench e console, la motivazione di ciò che non è `yes` e i test. `task parity` (in `task ci`) esegue i test di `scripts/parity/` e poi `node scripts/parity.mjs --check`, che fallisce se:

- il registro non rispetta lo schema (`shared/parity/features.schema.json`);
- un comando, un binding Go o un'operazione di `api/openapi.yaml` non compare in nessuna voce (né in `server_only`);
- una voce rimanda a un comando, binding, operazione, rotta, capability o file di test che non esiste;
- uno stato diverso da `yes` non ha motivazione;
- una superficie dice `yes` ma la piattaforma non ha la capability richiesta;
- le tabelle generate di `docs/web-workbench-parity.md` non sono aggiornate (si rigenerano con `node scripts/parity.mjs`).

Come aggiungere o estendere una voce, passo per passo: [dev-setup.md, «Registro delle funzioni»](dev-setup.md#registro-delle-funzioni). Le eccezioni dichiarate (updater, cartella locale, avviso sul disco, deep link, finestra nativa, cestino di sistema, più vault insieme) e le tabelle per funzione, comando, binding e operazione sono in [web-workbench-parity.md](web-workbench-parity.md#eccezioni-dichiarate).

## Test per livello

| Livello                                | Cosa copre                                                                                                                       | Comando                                                                          |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Go, unità                              | core, cloud, `shared/go`; il test dispatcher/binding con i binding obbligatori                                                   | `task test-go` (in `task ci` con `REQUIRE_BINDINGS=1`)                           |
| Go in WebAssembly                      | `apps/desktop/internal/...` e `cmd/...` sotto Node con sqlite-wasm                                                               | `task test-wasm`                                                                 |
| Integrazione cloud                     | moduli del cloud con PostgreSQL, MinIO e Keycloak in container                                                                   | `task test-integration`                                                          |
| Sync a due dispositivi e contract test | engine reali contro il cloud reale; ogni richiesta e risposta di `transport` validata contro `openapi.yaml` (`contract_test.go`) | `task test-desktop-e2e`                                                          |
| Vitest                                 | UI, adattatori di `cloud-features` (stessa suite su REST e core), host web                                                       | `task test-ts`                                                                   |
| Playwright desktop                     | UI del desktop sul mock dei binding                                                                                              | `task e2e-desktop`, `task e2e-desktop-prod`                                      |
| Playwright web                         | console con l'API simulata; workbench sul core vero in una cartella del browser                                                  | `task e2e-web` (gli spec del workbench vogliono `task wasm-core`)                |
| Spec del desktop sul web               | gli stessi spec di `apps/desktop/frontend/e2e` sul core vero (`E2E_TARGET=web`)                                                  | `yarn workspace @memobrain/web e2e:workbench-ui` (prima `task wasm-core`)        |
| Cloud vero                             | login, sync tra browser, vault privato nel browser (blocco e cancellazione)                                                      | `yarn workspace @memobrain/web e2e:cloud` (stack avviato, dopo `task web-build`) |
| Sicurezza del web                      | CSP, SRI, nessuna richiesta esterna sulla build di produzione                                                                    | `yarn workspace @memobrain/web e2e:security` (dopo `task web-build`)             |

Le suite lente non sono in `task ci` e si eseguono quando si tocca l'area relativa e prima di un rilascio (ADR-0036); l'elenco con i prerequisiti è in [dev-setup.md](dev-setup.md#verifiche).
