# Ambiente di sviluppo

## Prerequisiti

| Strumento | Versione       | Note                                                                                                                                                    |
| --------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Go        | 1.27.x         | `go.work` alla radice unisce i tre moduli; con `GOTOOLCHAIN=auto` (default) il toolchain viene scaricato                                                |
| Wails CLI | v2.12.x        | `wails doctor` deve riportare "ready" (Xcode CLT su macOS, WebView2 su Windows, `webkit2gtk-4.1` su Linux). Con Go 1.27 compilarlo con `task wails-cli` |
| Node      | 24 LTS         | `.nvmrc`                                                                                                                                                |
| Yarn      | 4.18.1         | via `corepack enable` (versione bloccata da `packageManager`); npm e pnpm sono bloccati dallo script `preinstall`                                       |
| Docker    | con Compose v2 | stack di sviluppo (PostgreSQL, MinIO, Keycloak)                                                                                                         |
| Task      | v3.54.x        | task runner (`Taskfile.yml`), pinnato in `tools/go.mod`: `cd tools && GOWORK=off go install github.com/go-task/task/v3/cmd/task`. `task` elenca i task  |

Tool Go (golangci-lint, buf, govulncheck, oapi-codegen, sqlc, goose, protoc-gen-go/grpc) si installano con:

```sh
task tools
```

## Avvio

```sh
task stack-up        # PostgreSQL :5433, RustFS (S3) :9000/:9001, Keycloak :8080 (admin/admin)
task dev-cloud       # API su 127.0.0.1:18081, gRPC su :18082 (variabili in deploy/docker/cloud.dev.env)
task dev-desktop     # app Wails con hot reload del frontend
```

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
task gen             # rigenera OpenAPI, proto, sqlc, binding Wails
task lint            # golangci-lint + eslint + prettier
task test            # go test -race, vitest, conformance
task e2e             # Playwright (Chromium) sull'UI con i binding simulati (prima volta: yarn workspace @memobrain/desktop-frontend exec playwright install chromium)
task test-integration
task ci              # lint + vuln + test (lo stesso della CI)
task --list
```

Per un singolo test Go: `cd services/cloud && go test -run 'TestNome' ./internal/sync/...`.
Per un singolo test TS: `yarn workspace @memobrain/desktop-frontend exec vitest run src/editor/foo.test.ts`.
Gli e2e girano in un browser normale: `MEMOBRAIN_E2E=1` fa installare a `main.tsx` il mock dei binding (`src/test/wails-mock`), esposto come `window.__mock` per preparare note nei test.

## Struttura

Vedi `Specifications.md` §4 e `docs/roadmap.md`. Il module path Go è locale (`memobrain/…`); quando l'hosting sarà deciso: `task rename-module NEW=github.com/org/memobrain`.
