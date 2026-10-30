<p align="center">
  <img src="assets/readme-banner.png" alt="MemoBrain Notes — Local-first notes and knowledge base" width="100%" />
</p>

**MemoBrain Notes** è un'app di knowledge management _local-first_ ispirata a Obsidian. Le note sono file
Markdown ordinari in una cartella (il _vault_), compatibile con i vault di Obsidian: l'app funziona
completamente offline e il cloud è facoltativo.

- **Client desktop** (macOS, Windows, Linux) basato su Wails: editor CodeMirror con Live Preview, link e
  backlink, grafo, ricerca full-text, canvas (`.canvas`), disegni Excalidraw (`.excalidraw`), Bases (`.base`),
  template, note giornaliere, presentazioni e cronologia delle versioni.
- **Cloud Service** self-hosted (Go, PostgreSQL, storage S3-compatibile, autenticazione Keycloak/OIDC) per
  sincronizzare i vault tra dispositivi e condividerli con utenti e gruppi. Il merge avviene sempre sul
  client: il server ordina le modifiche e archivia i contenuti senza interpretarli.
- **Due tipi di vault cloud:** _privati_, cifrati end-to-end sul client (il server non vede né i nomi né il
  contenuto dei file), e _condivisi_, collaborativi con altri utenti.
- **Web UI** incorporata nel cloud: console utente e amministrazione, e la stessa interfaccia del desktop nel
  browser per aprire e modificare i vault.

## Installazione

### App desktop

Scaricare l'installer dalla pagina [Releases](https://github.com/E2BR/MemoBrain/releases) e verificarlo
con `SHA256SUMS` (`sha256sum -c SHA256SUMS`).

| Sistema | Pacchetto                                 | Requisiti                          |
| ------- | ----------------------------------------- | ---------------------------------- |
| macOS   | `.dmg` universale (Apple Silicon e Intel) | trascinare l'app in _Applicazioni_ |
| Windows | installer NSIS (amd64, arm64)             | Windows 10/11 con WebView2 Runtime |
| Linux   | `.deb` o AppImage (amd64)                 | `webkit2gtk-4.1`                   |

Gli installer al momento **non sono firmati**: al primo avvio Gatekeeper (macOS) o SmartScreen (Windows)
chiedono conferma. All'avvio si apre o si crea un vault: per la sincronizzazione inserire l'URL del server
in _Impostazioni → Cloud_. Dettagli nella [guida utente](docs/user-guide/installazione.md).

### Cloud Service

Il servizio è un unico binario (`memobrain-cloud --role=api|worker|all`) distribuito come immagine
container multi-arch su GHCR, con la Web UI inclusa. Richiede PostgreSQL 15+, uno storage S3-compatibile
(RustFS, MinIO, AWS S3) e un realm Keycloak.

- **Kubernetes:** chart Helm in [`deploy/helm/memobrain`](deploy/helm/memobrain)
  ```sh
  helm upgrade --install memobrain deploy/helm/memobrain -n memobrain --create-namespace -f my-values.yaml
  ```
- **Docker Compose** per installazioni piccole, con proxy TLS: [`deploy/compose`](deploy/compose).

Procedura completa, segreti, configurazione e verifica nella [guida di amministrazione](docs/admin-guide/installazione.md).

## Ambiente di sviluppo

### Prerequisiti

| Strumento | Versione       | Note                                                                                             |
| --------- | -------------- | ------------------------------------------------------------------------------------------------ |
| Go        | 1.27.x         | con `GOTOOLCHAIN=auto` (default) il toolchain viene scaricato se manca                           |
| Wails CLI | v2.12.x        | `make wails-cli`; `wails doctor` deve risultare "ready" (Xcode CLT, WebView2 o `webkit2gtk-4.1`) |
| Node      | 24 LTS         | vedi `.nvmrc`                                                                                    |
| Yarn      | 4.18.1         | `corepack enable` (versione bloccata da `packageManager`; npm e pnpm sono bloccati)              |
| Docker    | con Compose v2 | solo per lo stack del cloud (PostgreSQL, RustFS, Keycloak)                                       |

### Preparazione

```sh
git clone git@github.com:E2BR/MemoBrain.git && cd MemoBrain
corepack enable
make tools   # tool Go pinnati (golangci-lint, buf, sqlc, oapi-codegen, …) + yarn install
make gen     # codice generato: OpenAPI → Go/TS, proto, sqlc, binding Wails
```

Il repository è un monorepo: `go.work` unisce i moduli Go (`shared/go`, `services/cloud`, `apps/desktop`),
i pacchetti TypeScript sono un workspace Yarn (`packages/*`, `web`).

### Avvio

```sh
make run-desktop        # app desktop standalone (senza cloud né Docker) con un vault demo
```

Con il cloud:

```sh
make stack-up           # PostgreSQL :5433, RustFS (S3) :9000, Keycloak :8080 (admin/admin)
make dev-cloud          # cloud su http://127.0.0.1:18081 (Web UI e API)
make dev-desktop        # app desktop con hot reload del frontend
```

In alternativa `make run-desktop-cloud` avvia stack, cloud e desktop insieme (`make run-desktop-2devices`
simula due dispositivi); `make dev-stop` ferma tutto. Utenti di prova: `admin`, `user1`, `user2`, password
`memobrain-dev-password`.

### Verifiche

```sh
make lint               # golangci-lint, eslint, prettier
make test               # go test -race, vitest, fixture di conformance Go/TS
make e2e                # Playwright (Chromium) su UI desktop e Web UI
make test-integration   # cloud con testcontainers (PostgreSQL, MinIO, Keycloak)
make ci                 # tutto ciò che esegue la CI
make help               # elenco completo dei target
```

Altri dettagli (script di debug, test singoli, struttura) in [docs/dev-setup.md](docs/dev-setup.md);
architettura e vincoli in [Specifications.md](Specifications.md), piano di sviluppo in
[docs/roadmap.md](docs/roadmap.md).
