# Ambiente di sviluppo

## Prerequisiti

| Strumento | Versione       | Note                                                                                                                                                                                                                                                                                                                                                    |
| --------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Go        | 1.27.x         | `go.work` alla radice unisce i tre moduli; con `GOTOOLCHAIN=auto` (default) il toolchain viene scaricato                                                                                                                                                                                                                                                |
| Wails CLI | v3.1.x         | `wails3`, solo per `task dev-desktop` (il watcher) e per la build Windows (risorse dell'exe e bootstrapper WebView2); la build e `task gen-wails` non la usano. Installarla con `task wails-cli`: la versione è quella di `apps/desktop/go.mod` e `task dev-desktop` rifiuta una CLI diversa; `task lint-wails-versions` controlla anche il runtime npm |
| Node      | 24 LTS         | `.nvmrc`                                                                                                                                                                                                                                                                                                                                                |
| Yarn      | 4.18.1         | via `corepack enable` (versione bloccata da `packageManager`); npm e pnpm sono bloccati dallo script `preinstall`                                                                                                                                                                                                                                       |
| Docker    | con Compose v2 | stack di sviluppo (PostgreSQL, RustFS, Keycloak) e test con testcontainers                                                                                                                                                                                                                                                                              |
| Task      | v3.54.x        | task runner (`Taskfile.yml`), pinnato in `tools/go.mod`: `cd tools && GOWORK=off go install github.com/go-task/task/v3/cmd/task`. `task` elenca i task                                                                                                                                                                                                  |

Tool Go (golangci-lint, buf, govulncheck, oapi-codegen, sqlc, goose, protoc-gen-go/grpc) si installano con:

```sh
task tools
```

## Avvio

```sh
task stack-up        # PostgreSQL :5433, RustFS (S3) :9000/:9001, Keycloak :8080 (admin/admin)
task dev-cloud       # API su 127.0.0.1:18081, gRPC su :18082, Web UI su :5174 (WEB=0 per non avviarla); variabili in deploy/docker/cloud.dev.env
task dev-desktop     # app Wails v3 con ricarica del frontend (esbuild su 127.0.0.1:5173, ricarica completa della pagina)
```

`task dev-web` avvia solo la Web UI su :5174 con proxy di `/api` verso il cloud su :18081. Con `--role=worker` il cloud non ha il listener API: metriche e probe stanno su `METRICS_LISTEN_ADDR` (127.0.0.1:18083 in sviluppo).

Utenti di test nel realm `clarae` (importato da `deploy/keycloak/realm-clarae.json`): `admin`, `user1`, `user2`, tutti con password `clarae-dev-password`.

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

Accesso nel cloud: `user1` / `clarae-dev-password` (anche `user2`, e `admin` per il ruolo admin). Log: `.dev/logs/cloud.log` e `.dev/<istanza>/logs/clarae.log`. Keycloak: <http://localhost:8080> (admin/admin); console S3: <http://localhost:9001> (clarae/clarae-secret). Le istanze desktop usano `CLARAE_DATA_DIR` per la data dir e `CLARAE_AUTH_REDIRECT=scheme` forza il fallback `clarae://` del login.

## Comandi quotidiani

```sh
task gen             # rigenera tutto il codice generato (sotto)
task lint            # golangci-lint + eslint + prettier
task typecheck       # tsc in tutti i pacchetti TypeScript (genera i binding Wails se mancano)
task test            # go test -race, vitest, conformance
task e2e             # Playwright (Chromium): UI desktop sul mock, bundle di produzione, Web UI (prima volta: yarn workspace @clarae/desktop-frontend exec playwright install chromium)
task ci              # verifica completa prima di merge e tag (vedi «Verifiche»)
task --list
```

`task gen` esegue, nell'ordine, i generatori `task gen-*` (l'elenco dei file con le sorgenti è in [CONTRIBUTING.md, «File generati»](../CONTRIBUTING.md#file-generati-mai-a-mano)):

| Generatore            | Da                                                                 | A                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gen-features`        | `api/config-profile.schema.json`                                   | flag e default del Config Profile in Go (`shared/go/features`) e TypeScript (`@clarae/api-client/features`)                                                                       |
| `gen-openapi`         | `api/openapi.yaml`                                                 | stub del server, client Go (`shared/go/apiclient`), client TypeScript (`packages/api-client`)                                                                                     |
| `gen-proto`           | `api/proto`                                                        | `shared/go/notifyv1`                                                                                                                                                              |
| `gen-sqlc`            | `services/cloud/internal/db/queries`                               | `services/cloud/internal/<modulo>/<modulo>db`                                                                                                                                     |
| `gen-wails`           | i binding Go di `App.Services()`                                   | `packages/workbench/wailsjs` (non versionato) e il client dell'host del browser `web/src/workbench/core.gen.ts`                                                                   |
| `gen-events`          | `apps/desktop/internal/app/events_registry.go`                     | `packages/workbench/src/app/events.gen.ts`                                                                                                                                        |
| `gen-capabilities`    | `apps/desktop/internal/app/capabilities.go`, `shared/go/pathrules` | `packages/workbench/src/platform/capabilities.gen.ts`, `shared/parity/capabilities.gen.json`, `packages/workbench/src/platform/vaultPaths.gen.ts` (nomi delle cartelle del vault) |
| `gen-parity-features` | `shared/parity/features.yaml`                                      | `FeatureId` (`packages/workbench/src/parity/features.gen.ts`) e `shared/go/parity/features_gen.go`                                                                                |

**Nome del prodotto e percorsi del vault (ADR-0052).** `task lint-brand` (primo passo di `task lint`, quindi di `task ci`) esegue `node --test 'scripts/rebrand/*.test.mjs'` e `node scripts/rebrand/check.mjs`: il vecchio nome del prodotto può comparire solo dove una riga di `scripts/rebrand/allowlist.tsv` lo ammette (`classe ⇥ glob ⇥ regex ⇥ motivo`; classi `frozen`, `legacy`, `fixture`, `history`, `external`, `tool`; il motivo di una riga `legacy` nomina la release che la toglie). Un'eccezione nuova si aggiunge solo se il codice o un documento deve citare il vecchio nome, con glob e regex stretti: una riga che non copre più nulla fa fallire la guardia, quindi quando un percorso legacy viene rimosso dal codice si toglie anche la riga. Un nome nuovo non serve mai un'eccezione. Un percorso di impostazioni o di database non si costruisce mai a mano: `vaultdir.DB` per `index.db` e `sync.db`, `vault.FS.ReadConfig` e `WriteConfig` per le impostazioni, `packages/workbench/src/platform/vaultPaths.ts` nella UI (dettagli in [desktop-web-sync.md](desktop-web-sync.md#cartella-di-configurazione-del-vault)).

Fuori da `task gen`: le tabelle di [web-workbench-parity.md](web-workbench-parity.md) (`node scripts/parity.mjs`) e l'inventario degli endpoint di `docs/security/pentest-scope.md` (`node scripts/pentest-inventory.mjs`, `--check` per verificarlo).

Per un singolo test Go: `cd services/cloud && go test -race -run 'TestNome' ./internal/sync/...`.
Per un singolo test TS: `yarn workspace @clarae/workbench exec vitest run src/editor/foo.test.ts` (la UI sta in `packages/workbench`; `apps/desktop/frontend` contiene solo l'entry e gli e2e).
Gli e2e del desktop girano in un browser normale: con `CLARAE_E2E=1` `mountWorkbench` (`packages/workbench/src/mount.tsx`) installa il mock dei binding (`packages/workbench/src/test/wails-mock`), esposto come `window.__mock` per preparare note nei test.

## Verifiche

Non c'è un servizio di CI ([ADR-0036](adr/0036-verifiche-locali-senza-ci.md)). **`task ci` va eseguito, verde, prima di ogni merge su `main` e prima di creare un tag di rilascio.** Esegue nell'ordine:

| Passo         | Cosa                                                                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lint`        | `lint-brand` (il vecchio nome del prodotto solo dove `scripts/rebrand/allowlist.tsv` lo ammette), controllo delle versioni di Wails, golangci-lint sui tre moduli Go (con le regole depguard dei moduli del cloud), ESLint, Prettier |
| `typecheck`   | `tsc` in tutti i pacchetti TypeScript                                                                                                                                                                                                |
| `vuln`        | govulncheck sui tre moduli Go                                                                                                                                                                                                        |
| `wailsjs`     | genera i binding Wails se mancano                                                                                                                                                                                                    |
| `test-go`     | `go test -race` (tag `webkit2_41` dove serve) con `CLARAE_REQUIRE_BINDINGS=1`: il test dispatcher/binding fallisce se i binding mancano                                                                                              |
| `test-ts`     | Vitest in ogni pacchetto                                                                                                                                                                                                             |
| `conformance` | fixture Markdown, merge e crittografia in Go e TypeScript                                                                                                                                                                            |
| `test-wasm`   | test del core Go compilato in WebAssembly, sotto Node con sqlite-wasm                                                                                                                                                                |
| `test-core`   | le suite dei pannelli cloud su `CoreCloudPort` sopra il core WebAssembly, in Node, con un cloud finto validato su `api/openapi.yaml`                                                                                                 |
| `parity`      | test di `scripts/parity/` e `node scripts/parity.mjs --check` (registro delle funzioni)                                                                                                                                              |
| `check-gen`   | fallisce se `task gen` cambia l'albero                                                                                                                                                                                               |

**Suite lente**, fuori da `task ci`: si eseguono quando si tocca l'area relativa e comunque prima di un rilascio.

| Comando                                   | Cosa                                                                                                  | Prerequisiti                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `task test-integration`                   | cloud con testcontainers (PostgreSQL, MinIO, Keycloak)                                                | Docker                                                                        |
| `task test-desktop-e2e`                   | sync a due dispositivi e contract test del client REST (`internal/sync/...` con il tag `integration`) | Docker (costruisce il binario del cloud, PostgreSQL in container)             |
| `task e2e`                                | Playwright: UI desktop sul mock, spec di disegno/grafo/canvas sul bundle di produzione, Web UI        | Chromium di Playwright                                                        |
| `task e2e-matrix`                         | matrice e2e: tutti gli spec di `apps/desktop/frontend/e2e` su `desktop-mock` e `web-core` (sotto)     | Chromium di Playwright (`task wasm-core` è una dipendenza)                    |
| `task e2e-mixed`                          | client misti sullo stesso cloud: dispositivo desktop headless e workbench web (sotto)                 | Docker, porte 5434, 8080, 9010-9012, 18091-18093 libere                       |
| `yarn workspace @clarae/web e2e:cloud`    | workbench contro un cloud vero: login, sync tra browser, vault privato nel browser                    | `task web-build`, poi `scripts/run-desktop-with-cloud.sh --cloud-only --keep` |
| `yarn workspace @clarae/web e2e:security` | CSP, SRI e richieste esterne sulla build di produzione servita dall'handler Go                        | `task web-build`                                                              |
| `task perf` / `task perf-check`           | suite di prestazioni del desktop e confronto con la baseline (vedi sotto)                             | dataset sintetico (`task perf-data`)                                          |

Con la build della Web UI presente (`task web-build`), `CLARAE_REQUIRE_WEB_BUILD=1 go test ./web-embed/...` in `services/cloud` rende obbligatori i controlli di CSP e SRI sugli asset incorporati invece di saltarli.

## Workbench web e WebAssembly

Il workbench nel browser esegue il core Go del desktop compilato in WebAssembly (ADR-0030); guida per gli sviluppatori in [desktop-web-sync.md](desktop-web-sync.md).

```sh
task wasm-core       # build/wasm/clarae-core.wasm + wasm_exec.js (GOOS=js GOARCH=wasm)
task test-wasm       # test di apps/desktop/internal/... e cmd/... sotto Node, con scripts/go-js-exec.sh e @clarae/sqlite-bridge
task test-core       # pannelli cloud su CoreCloudPort sopra il core WASM in Node (*.core.test.tsx), cloud finto validato sull'OpenAPI
task web-build       # core WASM + Web UI di produzione, copiati in services/cloud/web-embed/dist (poi task build-cloud)
task web-clean       # rimuove la build incorporata e ripristina il segnaposto
```

Per un singolo pacchetto sotto WASM: `cd apps/desktop && GOOS=js GOARCH=wasm go test -exec "$PWD/../../scripts/go-js-exec.sh" ./internal/store/...`. Il codice di `apps/desktop/internal` deve compilare anche per `js/wasm`: ciò che dipende dall'host va dietro l'interfaccia `Host` o in file `*_js.go` / `*_native.go`.

## Matrice e2e e client misti

**Matrice** (`web/playwright.workbench-ui.config.ts`, `task e2e-matrix` o `yarn workspace @clarae/web e2e:workbench-ui`): ogni spec di `apps/desktop/frontend/e2e` gira in due progetti, `desktop-mock` (la UI sul mock dei binding, server su :5199) e `web-core` (il workbench nel browser sul core WebAssembly, OPFS, server su :5176); un solo target con `--project web-core`. I due server si costruiscono una volta sola (`--no-watch`): con il watch una modifica ai sorgenti ricaricherebbe le pagine dei test in corso. I server servono build proprie (`CLARAE_DIST`, che accetta anche percorsi assoluti: uno relativo parte dalla cartella del pacchetto dell'app, e il pacchetto stesso o una sua cartella madre è rifiutato), perché `web/dist` e `apps/desktop/frontend/dist` vengono ricostruiti da altre build. Due esecuzioni contemporanee (più worktree) vogliono porte diverse: `E2E_MATRIX_DESKTOP_PORT=5299 E2E_MATRIX_WEB_PORT=5276 task e2e-matrix`. Build, artefatti e trace in `.dev/e2e-matrix/<porta desktop>-<porta web>/`.

Gli spec importano `test` ed `expect` da `e2e/support.ts`, che espone l'opzione `target` e gli helper che dipendono dal target (`openVault`, `seedVault`, `readVaultFile`, `listVaultFiles`, `vaultBinaries`, `appOrigin`): sul mock leggono e scrivono `window.__mock`, sul web chiamano i binding del core. Uno spec, o un singolo test, che non può girare sul web lo dichiara con `skipOnWeb('<id del registro>', '<motivo>')`: a livello di file esclude tutto lo spec, come prima istruzione di un test solo quel test. `node scripts/parity.mjs` riporta la copertura per target nella tabella «Spec e2e per target» di [web-workbench-parity.md](web-workbench-parity.md) e fallisce se l'id non è una voce di `shared/parity/features.yaml`.

**Client misti** (`task e2e-mixed`, cioè `scripts/e2e-mixed.sh`): il dispositivo A è il core del desktop senza finestra (`apps/desktop/cmd/e2e-device`, tag di build `e2e`: gli stessi binding di Wails, il motore di sync vero e cartelle del vault su disco, comandato da Playwright con una piccola API HTTP su loopback), il dispositivo B è il workbench web in Chromium, entrambi sullo stesso cloud. Scenari (`web/e2e-mixed/mixed.spec.ts`): merge di modifiche concorrenti a un `.md`, copia di conflitto di un `.canvas` e merge per elemento di un `.excalidraw`, vault privato creato sul desktop e sbloccato nel browser, condivisione creata sul desktop e accettata, montata e revocata nel browser, profilo con `features.web_workbench = false`, revoca del dispositivo dal browser.

Lo script usa uno stack usa e getta, mai quello di sviluppo: progetto compose `clarae-w8e2e` (`deploy/docker/compose.e2e-mixed.yaml` sopra `compose.dev.yaml`) con PostgreSQL :5434, S3 :9010/:9011, Keycloak :8080 (management :9012) e il cloud su :18091 (gRPC :18092). Keycloak importa una copia del realm di sviluppo in `.dev/e2e-mixed/realm`, con l'origine :18091 su `clarae-web` e il password grant su `clarae-desktop`, con cui il dispositivo headless ottiene i token (mai nel realm distribuito). Le build stanno sotto `.dev/e2e-mixed` (core WASM, Web UI con `CLARAE_DIST`, cloud compilato in una copia del modulo con la Web UI incorporata): `build/wasm`, `web/dist` e `services/cloud/web-embed/dist` non vengono toccati.

```sh
task e2e-mixed                     # stack, build, cloud, test, poi down -v
KEEP=1 task e2e-mixed              # lascia lo stack acceso; poi:
task e2e-mixed -- test --grep canvas   # di nuovo i soli test (SKIP_BUILD=1 riusa i binari con `all`)
task e2e-mixed -- down             # ferma il cloud, rimuove stack e volumi
```

Log in `.dev/e2e-mixed/logs` (`cloud.log`, `compose.log`, `web-build.log`); `CLARAE_E2E_DEVICE_VERBOSE=1` manda il log del core del dispositivo su stderr.

## Contract test

`apps/desktop/internal/sync/transport/contract_test.go` (tag `integration`) avvia il cloud vero (`internal/cloudtest`: binario costruito dal repository, PostgreSQL in container, un issuer OIDC locale al posto di Keycloak) e valida contro `api/openapi.yaml`, con `openapi3filter` di kin-openapi, ogni richiesta e risposta del client di sync, problem compresi. Gira con `task test-desktop-e2e`, o da solo:

```sh
cd apps/desktop && go test -race -count=1 -tags integration -run TestTransportHonoursTheContract ./internal/sync/transport/
```

Il test `shared/go/syncproto/codes_contract_test.go` allinea l'enum `ErrorCode` di OpenAPI alle costanti Go (gira con `task test`).

Lo stesso contratto valida i finti cloud lato TypeScript: `contractFetch` di `@clarae/cloud-features/testing/contract` riconduce ogni richiesta a un'operazione di `api/openapi.yaml` e valida corpi e risposte JSON. Lo usano le suite sul core (`task test-core`) e il mock REST di Playwright (`web/e2e/cloudMock.ts`, negli spec del workbench e della matrice). Uno stato che l'operazione non dichiara viene confrontato con la sua risposta `default` (l'errore interno): per questo ogni operazione autenticata dichiara anche i rifiuti dell'autenticazione (401, `403 USER_SUSPENDED`, `409 INVALID_STATE` per il conflitto d'identità, 429), così i client generati e i test li trattano come risposte previste.

## Prestazioni

```sh
task perf PERF_NOTES=50000                 # indice, ricerca, apertura nota e vault, grafo → .perf/results-50000.json
task perf-check PERF_NOTES=50000           # confronto con docs/perf/baseline-50000.json (PERF_TOLERANCE=25)
task perf-data PERF_NOTES=10000            # solo il dataset sintetico, in cache in .perf/
task perf-load-env USERS=1000              # ambiente per il test di carico k6 del cloud (Docker)
```

Metodo, obiettivi e misure in [perf/README.md](perf/README.md).

## Registro delle funzioni

Ogni funzione utente ha una voce in `shared/parity/features.yaml` (ADR-0037 §1), che dice cosa la realizza su desktop, nel workbench web e nella console, con quale stato e quali test. `task parity` (anche in `task ci`) fallisce se un comando, un'azione dei pannelli, un binding Go o un'operazione di `api/openapi.yaml` nuovi non compaiono in nessuna voce. Quando aggiungi una funzione, un comando, un'azione, un binding o un'operazione (la checklist completa è in [desktop-web-sync.md](desktop-web-sync.md#una-funzione-nuova-passo-per-passo)):

1. **Trova o crea la voce.** Un comando nuovo di una funzione esistente va nel suo `commands`, un'azione dei pannelli (`defineAction`) nel suo `actions`; una funzione nuova ha una voce sua, con `id` a punti (`area.funzione`, per esempio `vault.rename`) e `title` in italiano, e dopo `task gen` il suo id è un `FeatureId`: il comando o l'azione lo dichiara in `feature`, e il controllo rifiuta una `feature` che non lo elenca.
2. **Compila le superfici.**
   - `desktop`: `status`, `commands`, `actions`, `bindings` (`Servizio.Metodo`), `operationIds` chiamati dal core ed eventuale `capability`.
   - `workbench`: basta `status` se usa gli stessi elenchi del desktop (li eredita); altrimenti li elenca.
   - `console`: `status`, `routes` di `web/src/App.tsx`, `operationIds` e `actions` (le azioni della console che non chiamano la REST, marcate con `data-action="<id>"` in `web/src`). Si omette se la funzione riguarda il contenuto di un vault aperto. Ogni rotta, ogni operazione chiamata dalla console e ogni `data-action` va citata da una voce.
3. **Motiva ciò che non è `yes`.** `partial`, `exception`, `console-only` e `missing` vogliono un `reason`, per esempio «ADR-0037, fase B».
4. **Elenca i test per superficie** (`tests.desktop`, `tests.workbench`, `tests.console`, `tests.cloud`; ADR-0045 §4): percorsi di file dalla radice del repository, ciascuno nel posto della sua superficie. Un `yes` del workbench vuole in `tests.workbench` almeno una prova sul core WebAssembly: uno spec del browser che apre il workbench (`web/e2e`, `web/e2e-security`), `web/e2e-cloud` o `web/e2e-mixed`, uno spec della matrice (`apps/desktop/frontend/e2e`) che sul web gira per quella funzione, oppure un test della UI sul core in Node (`*.core.test.tsx` di `packages/workbench`, `task test-core`). Senza prova lo stato è `partial` con la motivazione «non verificata sul web: …». I pannelli cloud girano sul core con il mock REST `web/e2e/cloudMock.ts` (fixture `cloud` di `apps/desktop/frontend/e2e/cloud.ts`): dettagli in [desktop-web-sync.md](desktop-web-sync.md#prove-per-superficie).
5. **Comandi e azioni che dipendono dalla piattaforma.** Se il comando esiste solo dove c'è una capability (dichiarata dal core in `apps/desktop/internal/app/capabilities.go`, letta dalla UI con `packages/workbench/src/platform`), dichiaralo con `requires: ['updater']` nel `Command` invece di un controllo in `enabled`; un'azione dichiara allo stesso modo `requires`, oppure `excludes` se fa le veci di una capability dove manca, e si mostra con `<ActionButton>`. Il controllo legge `requires` ed `excludes` e rifiuta un `yes` su una superficie la cui piattaforma non offre il comando o l'azione (il workbench elenca allora i suoi `commands`/`actions`).
6. **Un'operazione che non è una funzione utente** (sonda, bootstrap pubblico) va in `server_only`, con il motivo.
7. **Rigenera e verifica:** `node scripts/parity.mjs` aggiorna le tabelle di `docs/web-workbench-parity.md`; `task parity` esegue i test del controllo e `node scripts/parity.mjs --check`.

## Flag e chiavi del Config Profile

`api/config-profile.schema.json` è l'unica fonte delle chiavi del Config Profile: ogni flag `features.*` ha `type`, `default` e `description`, e le altre chiavi un `default` se il prodotto ne ha uno. `task gen` (`task gen-features`, `go run ./features/gen` in `shared/go`) ne genera:

- `shared/go/features/features_gen.go`: le costanti Go dei flag (`features.WebWorkbench`, …), `Known`, `Defaults`, `Descriptions` e i default del prodotto (`features.ProductDefaults()`, distribuiti dal cloud come base della configurazione effettiva); il pacchetto, importabile da cloud e core del desktop, aggiunge `Flags` ed `Enabled`;
- `shared/go/features/config-profile.schema.json`: la copia dello schema incorporata (il cloud valida i profili con questa);
- `packages/api-client/src/gen/features.ts`: l'unione TypeScript `Feature`, `FEATURES` e `FEATURE_DEFAULTS`, esportati con `featureEnabled` da `@clarae/api-client/features` (senza dipendenze: lo usano workbench, console e `@clarae/cloud-features`).

Per un flag nuovo: aggiungilo allo schema con default e descrizione, `task gen`, una riga nella tabella «Chiavi del profilo» di [admin-guide/profili-quote-audit.md](admin-guide/profili-quote-audit.md), poi usalo con la costante (`featureOn(m.features, Feature.X)` nel workbench, `features.Enabled(cfg, features.X)` in Go). I test di `shared/go/features` falliscono se i file generati non corrispondono allo schema o se la tabella della guida non elenca esattamente le chiavi dello schema con tipo e default; `featureOn` accetta solo nomi dello schema (`Feature`), quindi un refuso non compila.

## Struttura

Mappa del repository nel [README](../README.md#struttura-del-repository), componenti e contratti in [architecture.md](architecture.md), regole di contribuzione in [CONTRIBUTING.md](../CONTRIBUTING.md). Il module path Go è locale (`clarae/…`).
