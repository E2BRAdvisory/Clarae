# ADR-0030 — Core del desktop compilato in WebAssembly per il workbench web

|                       |                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| **Stato**             | proposta (spike M9-WP1 eseguito in parte: via libera provvisorio, vedi "Esito dello spike")            |
| **Data**              | 2026-10-29                                                                                             |
| **Riferimenti spec**  | §1.2 (struttura del client), §3.4 (sync e merge sul client), §3.7 (index.db); ADR-0029, ADR-0020, D-07 |
| **Devia dallo spec?** | no di per sé: è la realizzazione tecnica di ADR-0029                                                   |

## Contesto

Il workbench web (ADR-0029) richiede le stesse funzioni del desktop. Sul desktop, gran parte di queste funzioni è in Go, in `apps/desktop/internal` (circa 24k LOC):

- indice SQLite FTS5 (`indexer`, `store`);
- ricerca con linguaggio di query (`search`);
- link, backlink e rename (`links`);
- `bases`, `templates`, `composer`, `graph`, `properties`;
- history locale;
- sync engine con merge 3-way (`sync`, `shared/go/merge`);
- E2EE (`crypto`, `shared/go/vaultcrypto`);
- importer.

Per i vault privati il server non può eseguire nessuna di queste funzioni: devono girare nel browser.

L'accoppiamento con l'ambiente è concentrato in pochi punti:

- Wails solo in `internal/app` (eventi, dialoghi, finestra);
- SQLite solo in `internal/store/store.go` (`sql.Open("sqlite")` con `modernc.org/sqlite`, che **non compila** per `js/wasm`);
- l'I/O su file con `os` in `vault`, `sync`, `history`, `indexer`, `links`, `store`, `app` e `importer`: su `GOOS=js` `os` passa da `globalThis.fs`, che la pagina può fornire (decisione 1).

## Decisione

Il core del desktop viene compilato con `GOOS=js GOARCH=wasm` in `apps/desktop/cmd/memobrain-core` ed eseguito in un **Web Worker dedicato**.

1. **File system: lo shim `fs` di Go, non un'interfaccia `vfs`.**
   - Su `GOOS=js` il pacchetto `os` di Go non chiama il sistema operativo: passa da `globalThis.fs` (lo stesso oggetto che `wasm_exec.js` riempie con `require("fs")` in Node). La pagina che ospita il core fornisce un `fs` basato su OPFS (`FileSystemSyncAccessHandle`, `rename` con `FileSystemFileHandle.move()`), quindi **nessuna chiamata a `os` e nessun pacchetto Go va riscritto**: `vault.FS`, `history`, `sync`, `importer` e `app` restano invariati, e con loro la scrittura atomica tmp + fsync + rename e il rifiuto del path traversal.
   - Sostituisce l'interfaccia `internal/vfs` prevista nella prima stesura di questo ADR (circa 60 punti di chiamata a `os` da migrare). Il lavoro si sposta dal Go al JavaScript: lo shim `fs` si scrive e si prova in M9-WP5.
   - **Eccezione: i database SQLite non passano da `os`.** Stanno nel VFS di sqlite-wasm (`opfs-sahpool`), invisibile allo shim. Ogni accesso a un database per percorso passa quindi da `internal/store`: `store.Open`, `store.Reset` e `store.Exists` (un controllo `os.Stat` su `sync.db` in `sync.ReadMount` è stato sostituito, perché sul web non avrebbe mai trovato il file).
   - **Le modifiche arrivano senza fsnotify.** `vault.FS` ha un callback opzionale `SetOnChange`, chiamato dopo ogni `WriteFile`, `Mkdir`, `Rename`, `Trash` e `Delete` riusciti. Nel browser il callback inoltra a `watcher.Notify`, che applica gli stessi filtri e lo stesso debounce degli eventi; sul desktop non è registrato (fsnotify vede anche le modifiche di altri programmi).
2. **SQLite.**
   - Il driver si sceglie con un build tag in `internal/store` (`driver_native.go`, `!js`: `modernc.org/sqlite`; `driver_js.go`, `js`: `internal/sqlitejs`). Il nome del driver resta `sqlite` e la DSN è la stessa: `store.Open` non cambia.
   - `internal/sqlitejs` è un driver `database/sql` che chiama in modo **sincrono** `globalThis.__memobrainSQLite`, un oggetto JavaScript nello stesso worker: `open`, `close`, `exec`, `query` e `fetch` (cursore a lotti di 256 righe), `closeCursor`, `deleteDatabase`, `exists`. Il lato JavaScript è `packages/sqlite-bridge` (`@memobrain/sqlite-bridge`) e non sa nulla di OPFS: riceve da chi lo installa la funzione che apre i database (`opfs-sahpool` nel browser, database in memoria nei test).
   - Formato dei valori sul confine: interi oltre 2^53 (gli `mtime_ns` lo sono) passano come `BigInt` in ingresso e come `{ i64: "<decimale>" }` in uscita; BLOB come `Uint8Array`; `time.Time` come testo RFC 3339. Le colonne dichiarate `DATE`, `DATETIME` o `TIMESTAMP` tornano come `time.Time` (come fa modernc: goose legge così `tstamp`); per questo il bridge riporta il tipo dichiarato di ogni colonna (`sqlite3_column_decltype`).
   - `:memory:` apre un database privato per connessione, come in modernc.
   - Migrazioni goose, schema e query restano invariati.
3. **Host.**
   - `internal/app` dipende da un'interfaccia `Host` (`host.go`): eventi, dialoghi di salvataggio e apertura, `Delivered` (il file scelto è completo: il browser avvia il download), apertura URL, stampa, uscita, finestra, errori.
   - `host_wails.go` (`!js`) contiene il codice Wails di prima, compreso `OnSecondInstance`; `host_web.go` (`js`) inoltra le chiamate a `globalThis.__memobrainHost`, attendendo le promise senza bloccare il ciclo di eventi. Fuori da `host_wails.go` nessun binding importa Wails.
   - `SaveFile` nel browser restituisce un percorso in `<tmp>/memobrain-downloads/`; `Delivered` lo trasforma in download.
   - Una costante `isWeb` (definita nei due file host) spegne ciò che il browser non ha: aggiornamenti (il motivo compare nello stato dell'updater), cestino di sistema (si usa `.trash/` del vault), file watcher. `SettingsAPI.Info` espone `platform: "desktop" | "web"`, che la UI userà per le capability di M9-WP4.
4. **RPC.**
   - `internal/rpc` (Go puro, senza build tag) è un dispatcher per nome: `Call(service, method, argsJSON) → resultJSON`. Segue la semantica di Wails: tutti e soli i metodi esportati di uno struct registrato; argomenti come array JSON, uno per parametro; nessun risultato, un valore, un errore o valore + errore (un errore non nullo rifiuta la chiamata col suo messaggio); `[]byte` in base64, `time.Time` in RFC 3339, slice nil come `null`. Un metodo variadico o con più di un valore oltre all'errore si rifiuta già alla registrazione, come Wails; un panic diventa un errore.
   - `App.Services()` (`internal/app/services.go`) è l'**unico elenco** dei servizi: lo usano `main.go` per Wails e `cmd/memobrain-core` per il dispatcher, quindi le due API non possono divergere.
   - `cmd/memobrain-core` (`js`) pubblica `globalThis.__memobrainCore` con `call(service, method, argsJSON) → Promise<string>`, `start()` (OnStartup di Wails), `domReady()`, `shutdown()` e `methods()`. Ogni chiamata gira in una goroutine propria, perché un'attesa dentro una callback JavaScript fermerebbe il ciclo di eventi. La configurazione si legge da `globalThis.__memobrainConfig = { dataDir, version, logLevel }`; il log va alla console; `__memobrainCoreReady()` (se definita) è chiamata quando il core è pronto. Gli eventi Go → TypeScript escono dall'`Emit` dell'host (`__memobrainHost.emit(name, json)`).
   - Su altre piattaforme `cmd/memobrain-core` stampa come compilarlo ed esce con 2.
   - Lato pagina, il bridge (`web/src/workbench/bridge.ts`, WP5) installa `window.go.app.*` e `window.runtime.*` come fa oggi `installWailsMock()`.
   - Test di parità: `TestDispatcherExposesEveryService` (ogni servizio si registra e ne espone tutti i metodi) e `TestDispatcherMatchesTheGeneratedBindings` (i metodi dichiarati in `frontend/wailsjs/go/app/*.d.ts` sono esattamente quelli del dispatcher; si salta se i binding non sono generati con `make gen-wails`).
5. **Rete e auth.**
   - `net/http` su `js/wasm` usa la Fetch API: il client cloud del desktop funziona senza modifiche, con base URL same-origin.
   - **Sessione ospitata.** Se l'host implementa `SessionHost`, `auth.Service` parte in modalità `Hosted` (`auth/hosted.go`): niente flusso nel browser di sistema, niente refresh token, niente keychain. Il token di accesso lo dà la pagina (`oidc-client-ts` di `web/src/auth`) a ogni richiesta (`__memobrainHost.token()`); profilo e registrazione del dispositivo (`platform: "web"`) avvengono come sul desktop, e il dispositivo registrato resta in `auth.json` tra un accesso e l'altro. Se cambia l'account, la registrazione vecchia si scarta (vale anche sul desktop).
   - Le chiavi dei vault privati stanno in un `crypto.MemoryStore`: nessun keychain del sistema operativo.
   - Le notifiche usano il fallback SSE che il client già ha (`/api/v1/events`, `transport/notify.go`): la sessione ospitata non annuncia l'endpoint gRPC, quindi il client va diretto su SSE.
6. **Esclusi o neutralizzati nel build `js`:** `updater` (compila, con `detach` vuoto; disattivato da `isWeb`), `watcher` (sorgente di eventi vuota, vedi punto 1), keychain di sistema e cestino di sistema.
7. **Build e consegna.**
   - `make wasm-core` produce `memobrain-core.wasm` (`-trimpath -ldflags "-s -w"`, poi `wasm-opt -Oz` se disponibile) insieme a `wasm_exec.js` della stessa toolchain.
   - Gli asset sono copiati con hash e SRI dalla build di `web/` e serviti precompressi (brotli) dal cloud.
   - Lo stesso target entra nel `Dockerfile` del cloud (stage dedicato).
8. **Test.**
   - `make test-wasm` esegue i test Go di **tutto** `apps/desktop/internal/...` e `cmd/...` sotto `GOOS=js GOARCH=wasm` in Node (`scripts/go-js-exec.sh`), con il bridge installato da `packages/sqlite-bridge/src/go-test-preload.ts`. È più semplice di un browser e usa lo stesso V8 e lo stesso sqlite-wasm; resta da fare l'esecuzione in un browser vero per OPFS (M9-WP5/WP7).
   - Nel banco di prova ogni percorso è un database in memoria con nome, tenuto vivo da una connessione «custode» (un file sopravvive alle connessioni); i percorsi si canonicalizzano (`/var` e `/private/var` su macOS sono lo stesso file).
   - Il job CI `wasm-core` e le conformance `shared/conformance` nel WASM restano da aggiungere (M9-WP7).

## Esito dello spike (M9-WP1, 2026-10-29)

Metodo: build di prova con un overlay di `go build` (nessun file del repo modificato) su Go 1.27.3, macOS arm64, Node 24 (V8, come Chrome). Il benchmark SQLite usa `@sqlite.org/sqlite-wasm` 3.54.1 e le migrazioni reali di `internal/store/migrations/index`, con un database in memoria. **Non misurato in un browser**: OPFS e il driver `database/sql` non esistono ancora.

| Misura                                     | Obiettivo       | Risultato                                                                                                                                                                                          | Esito               |
| ------------------------------------------ | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Compilazione `GOOS=js` del core            | compila         | Tutti i pacchetti di logica e `internal/app` (Wails incluso) compilano. Unico blocco reale: `modernc.org/sqlite` (`libc` non ha file per `js`). `updater` fallisce su `syscall.SysProcAttr.Setsid` | ok con lavoro       |
| Dimensione `.wasm` compressa (brotli)      | ≤ ~8 MB         | 36,6 MB grezzi, **6,4 MB brotli** (7,9 MB gzip) con `-trimpath -ldflags "-s -w"`, tutti i 20 servizi dei binding (122 metodi) e Wails, senza `wasm-opt`                                            | ok, margine ridotto |
| `sqlite3.wasm` (sqlite-wasm)               | ≤ 1,5 MB        | 0,88 MB grezzi                                                                                                                                                                                     | ok                  |
| Avvio a freddo del core                    | ≤ 2 s           | `app.New` e registrazione dei binding in 0,1 s in Node (V8, file locale). Nel browser va aggiunto il download                                                                                      | ok (parziale)       |
| FTS5 `trigram` e migrazioni su sqlite-wasm | funzionano      | Le due migrazioni reali (indice) si applicano; FTS5 `trigram case_sensitive 0` funziona; versione SQLite 3.54.1. Goose non è stato provato (serve il driver Go)                                    | ok (parziale)       |
| Indicizzazione di 5k note                  | < 60 s          | Solo SQLite: 5.000 note, 26 MB di testo, **1,7 s**. Parser Go sotto WASM: 1,58 MB/s (nativo 7,2 MB/s, quindi **4,5× più lento**), cioè ≈ 17 s per 26 MB. Stima totale ≈ 20–25 s                    | ok per stima        |
| Ricerca FTS, p95                           | ≤ 2× il desktop | **4,4 ms** (p50 3,6 ms) su 5k note. Il confronto con il desktop nativo non è stato fatto; il valore assoluto è molto sotto i 200 ms di ADR-0020                                                    | non confrontato     |
| Memoria con 5k note                        | ≤ 512 MB        | RSS di Node 303 MB con il solo database SQLite. Heap del core Go e cache di ricerca non misurati                                                                                                   | aperto              |

Non verificato dallo spike (stato dopo M9-WP2 in "Esito dell'implementazione"):

1. ~~Driver `database/sql` su sqlite-wasm con chiamate sincrone da Go~~: **fatto in WP2**, provato in Node con tutti i test del core. Restano il VFS `opfs-sahpool` e le prestazioni reali in un browser.
2. File system su OPFS (`FileSystemSyncAccessHandle`): scrittura atomica, `Walk`, sync su vault di migliaia di file. Con lo shim `fs` (decisione 1) è lavoro JavaScript di WP5.
3. Indicizzazione end-to-end e memoria con l'indexer reale, `search` e la cache dei candidati, in un browser.
4. Ricerca a confronto con il desktop nativo sullo stesso dataset.

**Parere: via libera provvisorio.** Nessun dato contraddice l'approccio. Il costo principale è la velocità del codice Go sotto WASM (≈ 4,5× più lento del nativo sul parser), che per 5k note resta nei limiti. Per vault grandi (50k note, ≈ 73 s nativi in ADR-0020) l'indicizzazione iniziale nel browser stimata supera i 5 minuti: va fatta in background con avanzamento, e l'indice può essere costruito in modo incrementale durante il pull.

Se un modulo non rispetta gli obiettivi, il fallback riguarda solo quel modulo: implementazione TS verificata con le stesse fixture, o caricamento differito. Il resto del core rimane in WASM. La cache di ricerca in RAM di ADR-0020 (circa 210 MB a 50k note) va limitata nel build `js` con un budget più basso.

## Esito dell'implementazione (M9-WP2, 2026-10-29)

Realizzati e provati: driver `sqlitejs` e bridge, `store`, `Host`, `SetOnChange`/`Notify`, sessione ospitata, `isWeb`, `make test-wasm`.

- **Desktop invariato:** `go test ./...` e `golangci-lint` (pacchetti toccati) passano; il comportamento nativo non è cambiato (nessun test nativo modificato, salvo `config_test`, che registra il driver tramite `store`).
- **Core sotto WASM:** tutti i 27 pacchetti di `apps/desktop/internal/...` passano in Node con sqlite-wasm: indexer (13 s), search, links, bases, graph, history, importer, crypto, sync, auth e `app`, compresi i test dei binding. Test saltati su `js`: la prova di crash di `vault` (serve `fork/exec`) e `watcher` con fsnotify (sostituito da `TestNotifyDebouncesAndCoalesces`, che gira anche in nativo).
- **Bug trovati dai test sotto WASM e corretti:** (1) `sync.ReadMount` cercava `sync.db` con `os.Stat`; (2) le colonne `TIMESTAMP` tornavano come stringhe e goose non riconosceva la tabella delle versioni; (3) `updater` non compilava per `js`.
- **Non verificato (resta in WP5 e WP7):** lo shim `fs` su OPFS e il VFS `opfs-sahpool` in un browser; la lettura dello stream SSE nel browser; le prestazioni dell'indicizzazione end-to-end con OPFS.
- **Correzione (2026-10-29, M9-WP3):** il target `make test-wasm`, descritto qui sopra e in roadmap, non era stato scritto nel `Makefile` quando il WP2 è stato dichiarato chiuso (la modifica non si era applicata, e non ho ricontrollato). Le suite sotto WASM erano state eseguite con il comando completo, non con `make`. Il target esiste dal WP3 e l'ho eseguito.

## Esito dell'implementazione (M9-WP3, 2026-10-29)

Realizzati e provati: `internal/rpc`, `App.Services()`, `cmd/memobrain-core`, `make wasm-core`, `make test-wasm`.

- **Dimensione reale:** `make wasm-core` produce `memobrain-core.wasm` di 36,7 MB, **6,44 MB con brotli** (obiettivo ≤ 8 MB), con tutti i 20 servizi (122 metodi) e Wails incluso, senza `wasm-opt`. Coincide con la misura dello spike.
- **Prova del binario vero in Node** (script fuori dal repo): `methods()` riporta 122 metodi, `start()` apre `app.db`, `SettingsAPI.Info` risponde `platform: "web"` con la versione stampata nella configurazione, un servizio inesistente rifiuta la promise, `shutdown()` termina.
- **Test:** `TestCoreAnswersBindingCallsThroughThePage` (sotto `js`) attraversa Promise JavaScript → dispatcher → binding reali → sessione ospitata; il dispatcher ha test di conversione, errori, panic e registrazione; la parità con i binding generati passa (122 metodi, 20 servizi) in nativo e sotto WASM. `make test-wasm`: 29 pacchetti ok; nativo `go test -race ./...`: 28 ok; `golangci-lint` pulito.
- **Non verificato:** il caricamento in un Web Worker vero (`wasm_exec.js` del browser, `WebAssembly.instantiateStreaming`) e il bridge `window.go` (WP5); il comportamento di `app.Startup` con OPFS.

## Esito dell'implementazione (M9-WP5, 2026-10-29)

Provato in un Chromium vero (Playwright), con il core reale e senza cloud:

- **Shim `fs` su OPFS** (`web/src/workbench/opfs-fs.ts`): 9 test in un worker. Scoperto che `FileSystemFileHandle.move()` **sostituisce** un file esistente (serve alla scrittura atomica di `vault.FS`) ma `move()` **non esiste per le cartelle** in Chromium: il rename di una cartella copia l'albero e rimuove l'originale.
- **SQLite su `opfs-sahpool`**: migrazioni goose, FTS5 `trigram`, ricerca e indice sopravvivono al reload. Il pool ha una capacità fissa (64 file riservati all'avvio, perché non si può allargare da codice sincrono): è un limite sul numero di vault e di journal aperti contemporaneamente.
- **Dimensioni reali:** core 35,9 MB raw, 7,84 MB gzip (6,4 MB brotli); sqlite 0,86 MB, 0,4 MB gzip. Avvio a freddo nel test: 1–2 s dalla pagina al vault mostrato, con i file già in cache locale.
- **Bug trovato dall'e2e:** in `MEMOBRAIN_E2E` il montaggio installava il mock di Wails sopra il bridge, e i primi test «riusciti» giravano contro il mock. Ora `kind: 'web'` non installa mai il mock; la prova che risponde il core vero è `SettingsAPI.Info().platform === 'web'` e l'hash reale dei file.
- **Non verificato:** Safari e Firefox (`move()` e i worker modulari vanno controllati), il tempo di indicizzazione di vault grandi nel browser (stima del WP1: > 5 minuti a 50k note), la memoria del core con vault reali, l'uso con un cloud vero.

## Alternative considerate

- **Interfaccia `vfs` in Go al posto dello shim `fs`** (la scelta della prima stesura): scartata dopo aver visto che `os` su `js` è già un punto di estensione. Avrebbe richiesto di migrare circa 60 chiamate in otto pacchetti e di ripetere nei test le garanzie di scrittura atomica, per un guadagno nullo.
- **Port in TypeScript della logica Go**: scartato. Circa 10k LOC da riscrivere (Bases da sola ne conta circa 2,8k) e due implementazioni da tenere allineate per sempre, quando l'obiettivo esplicito è la parità di comportamento.
- **`ncruces/go-sqlite3`**: scartato. Esegue SQLite con wazero, cioè un interprete WASM dentro WASM: troppo lento nel browser.
- **TinyGo**: scartato. Il supporto alla reflection e a `database/sql` non basta per il core attuale; da rivalutare solo per ridurre la dimensione.
- **Calcolo nel cloud**: scartato in ADR-0029.

## Conseguenze

- Una sola implementazione della logica di vault, con test comuni. Ogni correzione al core vale per desktop e web.
- Refactoring del desktop (VFS, `Host`, driver SQL) a rischio controllato: deve restare verde a ogni passo con i test esistenti.
- Il download del WASM è grande (diversi MB), ma solo per chi apre il workbench e in cache dopo il primo accesso.
- La toolchain Go entra nella build della Web UI: Dockerfile, CI e `make web-build` dipendono da `make wasm-core`.
