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

`packages/workbench/src/platform/index.ts` dice cosa offre l'host. `mountWorkbench` imposta le capability dal `kind` (`desktop` o `web`, più eventuali `capabilities` passate dall'host); i componenti le leggono con `useCan()` e il codice fuori da React con `can()`.

| Capability            | Desktop | Web      | Cosa governa                                                                                                                                                 |
| --------------------- | ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `localFolders`        | sì      | no       | aprire una cartella come vault, importare da una cartella                                                                                                    |
| `updater`             | sì      | no       | aggiornamenti dell'applicazione (`update:check`)                                                                                                             |
| `diskEncryptionCheck` | sì      | no       | avviso sul disco non cifrato                                                                                                                                 |
| `nativeWindow`        | sì      | no       | schermo intero del sistema, link esterni nel browser di sistema                                                                                              |
| `osTrash`             | sì      | no       | scelta del cestino in Impostazioni › File (il browser usa sempre `.trash/` del vault)                                                                        |
| `multiVault`          | sì      | no       | vault recenti (benvenuto e menu del vault) e `vault:switch`: il browser apre un vault per pagina, scelto nella console                                       |
| `unlinkVault`         | sì      | no       | «Scollega» in Impostazioni › Sincronizzazione; sul web al suo posto «Rimuovi da questo browser» (`onRemoveFromBrowser` dell'host, `guard.removeCopy`)        |
| `ownsSession`         | sì      | no       | accesso, uscita e scelta del server dal client; sul web la sessione è quella OIDC della pagina e il pulsante «Accedi» non compare                            |
| `ephemeralPlaintext`  | no      | sì       | politica, non un controllo: il chiaro di un vault privato non sopravvive al blocco (ADR-0029 §6)                                                             |
| `directoryPicker`     | sì      | rilevata | scegliere una cartella del computer (dialogo nativo, oppure `showDirectoryPicker` dove il browser la offre); i picker del core vogliono anche `localFolders` |

Una funzione legata a una capability la nomina nel registro (`capability:` della superficie in `shared/parity/features.yaml`): il controllo di parità rifiuta un `yes` su una piattaforma che non la ha.

Un comando che esiste solo dove c'è una capability lo dichiara in `Command.requires` (`packages/workbench/src/commands/registry.ts`), per esempio `requires: ['updater']` per `update:check`; palette, hotkey e menu lo nascondono da soli. Il controllo di parità legge `requires` dal registro a runtime e rifiuta un `yes` sul workbench per un comando che il browser non ha.

## Host del browser

Il codice sta in `web/src/workbench` e gira in una pagina separata dalla console (`workbench.html`, rotta `/vaults/:id/open`), con CSP e SRI propri:

- **`main.tsx`**: autenticazione OIDC, un solo workbench per browser (Web Lock `memobrain-workbench`: gli handle sincroni di OPFS sono esclusivi; un secondo tab mostra un messaggio), avvio di `launch.ts` e montaggio della UI con `kind: 'web'`.
- **`launch.ts`**: avvia il core, aspetta la sessione, rifiuta l'apertura se l'amministratore ha spento `web_workbench`, apre la cartella `/vaults/<id>` e la collega al vault cloud come dispositivo `web` (`SyncAPI.LinkExisting`), poi monta la UI. Le chiamate di avvio hanno limiti di tempo (`callWithin`), così un core bloccato finisce in un messaggio d'errore e non in un caricamento infinito. Se l'OIDC non riesce a rinnovare il token, le modifiche vengono scritte prima del redirect al login.
- **`worker.ts`**: il Web Worker del core. Installa lo shim `fs` su OPFS (`opfs-fs.ts`), sqlite-wasm con il VFS `opfs-sahpool`, l'oggetto `__memobrainHost`, poi carica il core (il `.wasm` è verificato con SRI nel worker; `wasm_exec.js` è incluso nel bundle del worker, coperto dall'integrità del worker stesso). Il messaggio `wipe` cancella una cartella e i database sotto lo stesso prefisso.
- **`bridge.ts`**: lato pagina. Inoltra le chiamate (`call`, `callWithin`), risponde alle richieste del core (token, file picker, download, apertura di URL), distribuisce gli eventi e installa `window.go` e `window.runtime`. Se il worker fallisce o il programma Go termina, ogni chiamata in attesa e successiva viene rifiutata con `CoreDeadError` e la pagina mostra un overlay; `callWithin` rifiuta con `CoreTimeoutError`.
- **Identità del dispositivo** (P6). Il browser è un solo dispositivo per profilo: il core registra il dispositivo al primo accesso e la registrazione (id del dispositivo, account, server) sta in IndexedDB (`web/src/workbench/device.ts`, database `memobrain-device`), fuori dalla cartella OPFS che «Esci» e «Dimentica questo browser» cancellano. Il worker la passa al core con le funzioni host `loadDevice`/`saveDevice` (`webDevice` in `internal/app/host_web.go`, `auth.HostedDevice` in `internal/auth/hosted.go`); se la cartella dei dati è stata cancellata il core riusa quel dispositivo invece di registrarne un altro, e se non è più tra quelli attivi dell'account (revocato dalla console) ne registra uno nuovo. Un altro account nello stesso browser registra il proprio. La console marca la riga «questo browser» con `thisBrowserDevice(userId)` (id utente del cloud, `GET /me`) e dopo la revoca di quella riga chiama `forgetThisBrowserDevice()`.
- **Dispositivo revocato mentre il core è aperto** (desktop e web). Il cloud rifiuta il `commit` con `403 FORBIDDEN` ed `extra.reason = "device_revoked"` (`transport.ErrDeviceRevoked`; i server precedenti sono riconosciuti dal solo `detail` «device revoked»). Il manager della sync ferma tutti gli engine che usano quel dispositivo, senza toccare file, `sync.db` né outbox; lo stato della sync di ogni vault diventa `offline` con il motivo, `SyncNow` risponde con l'errore. La sessione passa allo stato `device_revoked` (evento `auth:state`, persistito in `auth.json`, quindi resta anche dopo un riavvio del desktop) e il workbench mostra un banner con «Registra di nuovo questo dispositivo» (anche nel menu dell'account). L'azione (`AuthAPI.ReregisterDevice`) registra un nuovo dispositivo dello stesso account con il token esistente (sul web lo salva anche in IndexedDB); gli engine ripartono con il nuovo id, che viene scritto nel `sync.db` di ogni vault dello stesso account e server, e inviano ciò che era in attesa. Se nel frattempo è decaduta anche la sessione, si torna a «non connesso» e il login registra comunque un dispositivo nuovo. Sul web un ricaricamento della pagina sostituisce da sé il dispositivo revocato, come sopra.
- **`SyncNow`** garantisce un ciclo con una scansione del disco iniziata dopo la chiamata: fino ad allora lo stato è `syncing` (mai un `idle` vecchio con `pending: 0`), e le richieste arrivate prima di quella scansione valgono come una sola (nessun ciclo in più se un round successivo dello stesso ciclo ha già scansionato).
- **«Rimuovi da questo browser»** (al posto di «Scollega», capability `unlinkVault`). `guard.removeCopy()`: scrive le modifiche, `SyncNow`, aspetta lo svuotamento dell'outbox, poi cancella la copia e torna alla console; se restano modifiche o conflitti (o il conteggio è ignoto) conserva la copia e chiede («Resta nel vault» o «Elimina comunque»). Un vault privato passa da `lockAndForget`. Il collegamento non viene mai tolto: il lancio lo rifarebbe.
- **File system e SQLite.** Lo shim OPFS rinomina e cancella anche file aperti, come POSIX: chiude l'handle sincrono per lo spostamento e lo riapre nel posto nuovo; un file cancellato mentre è aperto resta leggibile dai descrittori aperti in `/tmp/.unlinked` finché l'ultimo si chiude. Il pool `opfs-sahpool` si dimensiona all'avvio (file in uso più 32), si allarga prima di una chiamata quando restano meno di 8 posti liberi, e all'avvio scarta i database di cartelle `/vaults/<…>` che non esistono più. Le cartelle di appoggio `/tmp/memobrain-downloads`, `/tmp/memobrain-uploads` e `/tmp/.unlinked` si svuotano all'avvio del worker e a ogni cancellazione di una copia; un download passa alla pagina senza copie in più e il file viene cancellato anche se la consegna fallisce.
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
| Spec del desktop sul web               | gli stessi spec di `apps/desktop/frontend/e2e` sui progetti `desktop-mock` e `web-core`                                          | `task e2e-matrix`                                                                |
| Client misti sullo stesso cloud        | dispositivo desktop headless (`apps/desktop/cmd/e2e-device`) e workbench web                                                     | `task e2e-mixed`                                                                 |
| Cloud vero                             | login, sync tra browser, vault privato nel browser (blocco e cancellazione)                                                      | `yarn workspace @memobrain/web e2e:cloud` (stack avviato, dopo `task web-build`) |
| Sicurezza del web                      | CSP, SRI, nessuna richiesta esterna sulla build di produzione                                                                    | `yarn workspace @memobrain/web e2e:security` (dopo `task web-build`)             |

Le suite lente non sono in `task ci` e si eseguono quando si tocca l'area relativa e prima di un rilascio (ADR-0036); l'elenco con i prerequisiti è in [dev-setup.md](dev-setup.md#verifiche).
