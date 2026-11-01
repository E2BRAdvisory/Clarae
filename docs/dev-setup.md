# Ambiente di sviluppo

## Prerequisiti

| Strumento | Versione       | Note                                                                                                                                                                                                                                              |
| --------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Go        | 1.27.x         | `go.work` alla radice unisce i tre moduli; con `GOTOOLCHAIN=auto` (default) il toolchain viene scaricato                                                                                                                                          |
| Wails CLI | v2.17.x        | `wails doctor` deve riportare "ready" (Xcode CLT su macOS, WebView2 su Windows, `webkit2gtk-4.1` su Linux). Installarlo con `task wails-cli`: la versione è quella di `apps/desktop/go.mod` e `gen-wails`/`dev-desktop` rifiutano una CLI diversa |
| Node      | 24 LTS         | `.nvmrc`                                                                                                                                                                                                                                          |
| Yarn      | 4.18.1         | via `corepack enable` (versione bloccata da `packageManager`); npm e pnpm sono bloccati dallo script `preinstall`                                                                                                                                 |
| Docker    | con Compose v2 | stack di sviluppo (PostgreSQL, RustFS, Keycloak) e test con testcontainers                                                                                                                                                                        |
| Task      | v3.54.x        | task runner (`Taskfile.yml`), pinnato in `tools/go.mod`: `cd tools && GOWORK=off go install github.com/go-task/task/v3/cmd/task`. `task` elenca i task                                                                                            |

Tool Go (golangci-lint, buf, govulncheck, oapi-codegen, sqlc, goose, protoc-gen-go/grpc) si installano con:

```sh
task tools
```

## Avvio

```sh
task stack-up        # PostgreSQL :5433, RustFS (S3) :9000/:9001, Keycloak :8080 (admin/admin)
task dev-cloud       # API su 127.0.0.1:18081, gRPC su :18082, Web UI su :5174 (WEB=0 per non avviarla); variabili in deploy/docker/cloud.dev.env
task dev-desktop     # app Wails con ricarica del frontend (esbuild, ricarica completa della pagina)
```

`task dev-web` avvia solo la Web UI su :5174 con proxy di `/api` verso il cloud su :18081. Con `--role=worker` il cloud non ha il listener API: metriche e probe stanno su `METRICS_LISTEN_ADDR` (127.0.0.1:18083 in sviluppo).

Utenti di test nel realm `memobrain` (importato da `deploy/keycloak/realm-memobrain.json`): `admin`, `user1`, `user2`, tutti con password `memobrain-dev-password`.

## Script per verifiche e debug

Gli script stanno in `scripts/` (bash, macOS/Linux) e tengono tutto lo stato in `.dev/` (ignorato da git: data dir, log, binari).

| Comando                                                               | Cosa fa                                                                                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `task run-desktop` (`scripts/run-desktop.sh --demo`)                  | App desktop **standalone**, senza cloud né Docker, con un vault demo in `.dev/standalone/vaults/Demo`                    |
| `scripts/run-desktop.sh --build`                                      | Come sopra ma con build di produzione (verifica CSP, bundle) invece di `wails dev`                                       |
| `task run-desktop-cloud` (`scripts/run-desktop-with-cloud.sh --demo`) | Stack Docker + servizio cloud in background + desktop in hot reload; URL del server precompilato in Impostazioni → Cloud |
| `task run-desktop-2devices`                                           | Stack + cloud + **due istanze** desktop (data dir separate) per simulare due dispositivi                                 |
| `scripts/run-desktop-with-cloud.sh --cloud-only`                      | Solo stack + cloud, per provare client o API a mano                                                                      |
| `scripts/run-desktop-with-cloud.sh --reset-stack`                     | Azzera i volumi (re-importa il realm Keycloak)                                                                           |
| `task dev-stop` (`ARGS=--stack` / `--purge`)                          | Ferma il cloud (e opzionalmente lo stack, o cancella anche volumi e `.dev/`)                                             |

Opzioni comuni: `--fresh` (solo standalone) azzera la data dir; `--data-dir DIR` ne usa un'altra; `--keep` lascia cloud e stack attivi all'uscita. Ogni script ha `--help`.

Accesso nel cloud: `user1` / `memobrain-dev-password` (anche `user2`, e `admin` per il ruolo admin). Log: `.dev/logs/cloud.log` e `.dev/<istanza>/logs/memobrain.log`. Keycloak: <http://localhost:8080> (admin/admin); console S3: <http://localhost:9001> (memobrain/memobrain-secret). Le istanze desktop usano `MEMOBRAIN_DATA_DIR` per la data dir e `MEMOBRAIN_AUTH_REDIRECT=scheme` forza il fallback `memobrain://` del login.

## Comandi quotidiani

```sh
task gen             # rigenera OpenAPI (stub Go, client Go, client TS), proto, sqlc, binding Wails
task lint            # golangci-lint + eslint + prettier
task typecheck       # tsc in tutti i pacchetti TypeScript (genera i binding Wails se mancano)
task test            # go test -race, vitest, conformance
task e2e             # Playwright (Chromium): UI desktop sul mock, bundle di produzione, Web UI (prima volta: yarn workspace @memobrain/desktop-frontend exec playwright install chromium)
task ci              # verifica completa prima di merge e tag (vedi «Verifiche»)
task --list
```

Per un singolo test Go: `cd services/cloud && go test -race -run 'TestNome' ./internal/sync/...`.
Per un singolo test TS: `yarn workspace @memobrain/workbench exec vitest run src/editor/foo.test.ts` (la UI sta in `packages/workbench`; `apps/desktop/frontend` contiene solo l'entry e gli e2e).
Gli e2e del desktop girano in un browser normale: con `MEMOBRAIN_E2E=1` `mountWorkbench` (`packages/workbench/src/mount.tsx`) installa il mock dei binding (`packages/workbench/src/test/wails-mock`), esposto come `window.__mock` per preparare note nei test.

## Verifiche

Non c'è un servizio di CI ([ADR-0036](adr/0036-verifiche-locali-senza-ci.md)). **`task ci` va eseguito, verde, prima di ogni merge su `main` e prima di creare un tag di rilascio.** Esegue nell'ordine:

| Passo         | Cosa                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `lint`        | golangci-lint sui tre moduli Go (con le regole depguard dei moduli del cloud), ESLint, Prettier                                            |
| `typecheck`   | `tsc` in tutti i pacchetti TypeScript                                                                                                      |
| `vuln`        | govulncheck sui tre moduli Go                                                                                                              |
| `wailsjs`     | genera i binding Wails se mancano                                                                                                          |
| `test-go`     | `go test -race` (tag `webkit2_41` dove serve) con `MEMOBRAIN_REQUIRE_BINDINGS=1`: il test dispatcher/binding fallisce se i binding mancano |
| `test-ts`     | Vitest in ogni pacchetto                                                                                                                   |
| `conformance` | fixture Markdown, merge e crittografia in Go e TypeScript                                                                                  |
| `test-wasm`   | test del core Go compilato in WebAssembly, sotto Node con sqlite-wasm                                                                      |
| `parity`      | test di `scripts/parity/` e `node scripts/parity.mjs --check` (registro delle funzioni)                                                    |
| `check-gen`   | fallisce se `task gen` cambia l'albero                                                                                                     |

**Suite lente**, fuori da `task ci`: si eseguono quando si tocca l'area relativa e comunque prima di un rilascio.

| Comando                                          | Cosa                                                                                                  | Prerequisiti                                                                  |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `task test-integration`                          | cloud con testcontainers (PostgreSQL, MinIO, Keycloak)                                                | Docker                                                                        |
| `task test-desktop-e2e`                          | sync a due dispositivi e contract test del client REST (`internal/sync/...` con il tag `integration`) | Docker (costruisce il binario del cloud, PostgreSQL in container)             |
| `task e2e`                                       | Playwright: UI desktop sul mock, spec di disegno/grafo/canvas sul bundle di produzione, Web UI        | Chromium di Playwright                                                        |
| `yarn workspace @memobrain/web e2e:workbench-ui` | gli spec del desktop eseguiti sul workbench web contro il core vero                                   | `task wasm-core`                                                              |
| `yarn workspace @memobrain/web e2e:cloud`        | workbench contro un cloud vero: login, sync tra browser, vault privato nel browser                    | `task web-build`, poi `scripts/run-desktop-with-cloud.sh --cloud-only --keep` |
| `yarn workspace @memobrain/web e2e:security`     | CSP, SRI e richieste esterne sulla build di produzione servita dall'handler Go                        | `task web-build`                                                              |
| `task perf` / `task perf-check`                  | suite di prestazioni del desktop e confronto con la baseline (vedi sotto)                             | dataset sintetico (`task perf-data`)                                          |

Con la build della Web UI presente (`task web-build`), `MEMOBRAIN_REQUIRE_WEB_BUILD=1 go test ./web-embed/...` in `services/cloud` rende obbligatori i controlli di CSP e SRI sugli asset incorporati invece di saltarli.

## Workbench web e WebAssembly

Il workbench nel browser esegue il core Go del desktop compilato in WebAssembly (ADR-0030); guida per gli sviluppatori in [desktop-web-sync.md](desktop-web-sync.md).

```sh
task wasm-core       # build/wasm/memobrain-core.wasm + wasm_exec.js (GOOS=js GOARCH=wasm)
task test-wasm       # test di apps/desktop/internal/... e cmd/... sotto Node, con scripts/go-js-exec.sh e @memobrain/sqlite-bridge
task web-build       # core WASM + Web UI di produzione, copiati in services/cloud/web-embed/dist (poi task build-cloud)
task web-clean       # rimuove la build incorporata e ripristina il segnaposto
```

Per un singolo pacchetto sotto WASM: `cd apps/desktop && GOOS=js GOARCH=wasm go test -exec "$PWD/../../scripts/go-js-exec.sh" ./internal/store/...`. Il codice di `apps/desktop/internal` deve compilare anche per `js/wasm`: ciò che dipende dall'host va dietro l'interfaccia `Host` o in file `*_js.go` / `*_native.go`.

## Contract test

`apps/desktop/internal/sync/transport/contract_test.go` (tag `integration`) avvia il cloud vero (`internal/cloudtest`: binario costruito dal repository, PostgreSQL in container, un issuer OIDC locale al posto di Keycloak) e valida contro `api/openapi.yaml`, con `openapi3filter` di kin-openapi, ogni richiesta e risposta del client di sync, problem compresi. Gira con `task test-desktop-e2e`, o da solo:

```sh
cd apps/desktop && go test -race -count=1 -tags integration -run TestTransportHonoursTheContract ./internal/sync/transport/
```

Il test `shared/go/syncproto/codes_contract_test.go` allinea l'enum `ErrorCode` di OpenAPI alle costanti Go (gira con `task test`).

## Prestazioni

```sh
task perf PERF_NOTES=50000                 # indice, ricerca, apertura nota e vault, grafo → .perf/results-50000.json
task perf-check PERF_NOTES=50000           # confronto con docs/perf/baseline-50000.json (PERF_TOLERANCE=25)
task perf-data PERF_NOTES=10000            # solo il dataset sintetico, in cache in .perf/
task perf-load-env USERS=1000              # ambiente per il test di carico k6 del cloud (Docker)
```

Metodo, obiettivi e misure in [perf/README.md](perf/README.md).

## Registro delle funzioni

Ogni funzione utente ha una voce in `shared/parity/features.yaml` (ADR-0037 §1), che dice cosa la realizza su desktop, nel workbench web e nella console, con quale stato e quali test. `task parity` (anche in `task ci`) fallisce se un comando, un binding Go o un'operazione di `api/openapi.yaml` nuovi non compaiono in nessuna voce. Quando aggiungi una funzione, un comando, un binding o un'operazione:

1. **Trova o crea la voce.** Un comando nuovo di una funzione esistente va nel suo `commands`; una funzione nuova ha una voce sua, con `id` a punti (`area.funzione`, per esempio `vault.rename`) e `title` in italiano.
2. **Compila le superfici.**
   - `desktop`: `status`, `commands`, `bindings` (`Servizio.Metodo`), `operationIds` chiamati dal core ed eventuale `capability`.
   - `workbench`: basta `status` se usa gli stessi elenchi del desktop (li eredita); altrimenti li elenca.
   - `console`: `status`, `routes` di `web/src/App.tsx` e `operationIds`. Si omette se la funzione riguarda il contenuto di un vault aperto.
3. **Motiva ciò che non è `yes`.** `partial`, `exception`, `console-only` e `missing` vogliono un `reason`, per esempio «ADR-0037, fase B».
4. **Elenca i test** (`tests.desktop`, `tests.web`, `tests.cloud`): percorsi di file dalla radice del repository.
5. **Comandi che dipendono dalla piattaforma.** Se il comando esiste solo dove c'è una capability (`packages/workbench/src/platform`), dichiaralo con `requires: ['updater']` nel `Command` invece di un controllo in `enabled`. Il controllo legge `requires` e rifiuta un `yes` sul workbench per un comando che il browser non ha.
6. **Un'operazione che non è una funzione utente** (sonda, bootstrap pubblico) va in `server_only`, con il motivo.
7. **Rigenera e verifica:** `node scripts/parity.mjs` aggiorna le tabelle di `docs/web-workbench-parity.md`; `task parity` esegue i test del controllo e `node scripts/parity.mjs --check`.

## Struttura

Mappa del repository nel [README](../README.md#struttura-del-repository), componenti e contratti in [architecture.md](architecture.md), regole di contribuzione in [CONTRIBUTING.md](../CONTRIBUTING.md). Il module path Go è locale (`memobrain/…`); quando l'hosting sarà deciso: `task rename-module NEW=github.com/org/memobrain`.
