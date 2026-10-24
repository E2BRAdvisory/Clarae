# Piano di sviluppo Nodus — da `Specifications.md` v1.1 al rilascio 1.0

## Contesto

Il repository contiene solo `Specifications.md` (v1.1, 23/10/2026) e `CLAUDE.md`. Lo spec definisce architettura, vincoli (V-01…V-10), decisioni (D-01…D-08), schema DB, API, protocollo di sync, E2EE e layout del monorepo, oltre a una roadmap per milestone (Appendice B) senza scomposizione in task. Questo piano trasforma la roadmap in un piano eseguibile: per ogni milestone M0–M7 definisce work package (WP), task concreti con file e ordine, criteri di uscita e verifica. Il piano è pensato per un singolo sviluppatore affiancato da Claude Code; dove due WP sono indipendenti lo segnalo come parallelizzabile (worktree/agent).

Regole ereditate da `CLAUDE.md`: non modificare `Specifications.md` in automatico (le deviazioni si propongono come ADR in `docs/adr/` e l'utente aggiorna lo spec); nessun commit/push senza richiesta esplicita.

---

## 1. Decisioni di piano (vincolanti per l'esecuzione)

| Tema           | Scelta                                                                                                           | Note                                                                                                                                                                                                                                                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Module path Go | Segnaposto locale `nodus` (moduli `nodus/apps/desktop`, `nodus/services/cloud`, `nodus/shared`) in `go.work`     | Host non ancora deciso. Il rename futuro è un `find/sed` sugli import + `go.mod`; task **M0-00** lo prevede con `make rename-module NEW=…`.                                                                                                                                                                                                |
| Go             | 1.26 (sqlc 1.31 e buf 1.75 richiedono ≥ 1.26; il toolchain si scarica via `GOTOOLCHAIN=auto`)                    | Tutti i tool (`oapi-codegen`, `sqlc`, `goose`, `buf`, `golangci-lint`, `govulncheck`, `protoc-gen-go*`) sono pinnati con `tool` directive in un modulo separato `tools/go.mod` **fuori da `go.work`** (installazione con `make tools` → `GOWORK=off go install tool`), così il loro albero di dipendenze non entra nei moduli applicativi. |
| Wails          | v2.12.0 (installato) — D-07                                                                                      | `OnUrlOpen` (Mac) + `SingleInstanceLock`/`OnSecondInstanceLaunch` esistono in v2 ≥ 2.10; comportamento "URL verso istanza già attiva su macOS" da verificare nello **SPIKE-01**.                                                                                                                                                           |
| Node / Yarn    | Node 24 LTS, Yarn 4 (corepack, `packageManager` bloccato)                                                        | Workspace Yarn: `apps/desktop/frontend`, `web`, `packages/*`.                                                                                                                                                                                                                                                                              |
| React          | 19 (verifica peerDeps di `@excalidraw/excalidraw` 0.18.x nello **SPIKE-03**; fallback React 18.3)                | Vite 6, TypeScript 5 `strict`, ESLint flat config, Prettier, Vitest, Playwright.                                                                                                                                                                                                                                                           |
| Stato/query FE | Zustand + TanStack Query (cache delle chiamate ai binding)                                                       | Spec §4.2 `state/`.                                                                                                                                                                                                                                                                                                                        |
| Editor         | CodeMirror 6 + `@lezer/markdown`; reading view `unified` (remark/rehype) + plugin OFM custom                     | KaTeX, Mermaid (`securityLevel: strict`), DOMPurify.                                                                                                                                                                                                                                                                                       |
| Cloud HTTP     | `chi` + `oapi-codegen` v2 (strict server, chi) ; errori RFC 9457                                                 | `api/openapi.yaml` fonte unica.                                                                                                                                                                                                                                                                                                            |
| gRPC           | `buf` + `protoc-gen-go`/`protoc-gen-go-grpc`; SSE fallback in `httpserver`                                       | Solo `NotifyService`.                                                                                                                                                                                                                                                                                                                      |
| DB             | PostgreSQL 17 (compose) — pgx v5, sqlc, goose (migrazioni SQL embedded)                                          | **Deviazione dichiarata dalla roadmap (App. B pone "schema DB" in M0):** lo schema §3.2.2 viene introdotto per migrazioni incrementali per milestone (`0001` M0, `0002` M2, `0003` M4, `0004` M5), così ogni tabella arriva con il modulo che la usa e i suoi test.                                                                        |
| Storage        | S3 via `minio-go` (MinIO in dev) + driver filesystem per test unit                                               | tus 1.0 con `tusd/v2` (handler embedded, store S3).                                                                                                                                                                                                                                                                                        |
| JWT/OIDC       | `coreos/go-oidc/v3` + `golang.org/x/oauth2` (desktop PKCE e cloud JWKS)                                          | Keycloak 26.x (26.7 ultima nota) in compose; realm export in `deploy/keycloak/realm-nodus.json`.                                                                                                                                                                                                                                           |
| Keychain       | `zalando/go-keyring`                                                                                             | macOS Keychain / Credential Manager / Secret Service.                                                                                                                                                                                                                                                                                      |
| SQLite client  | `modernc.org/sqlite` (FTS5 + `trigram`): verifica **SPIKE-02**                                                   | Migrazioni `index.db`/`sync.db`/`app.db` con goose su `database/sql`.                                                                                                                                                                                                                                                                      |
| Cripto         | `crypto/aes`, `crypto/cipher`, `x/crypto/argon2`, `x/crypto/hkdf`; browser WebCrypto + `hash-wasm` (Argon2id)    | Formato §3.8.3; test vector condivisi.                                                                                                                                                                                                                                                                                                     |
| Diff/merge     | `sergi/go-diff` (diff-match-patch) + diff3 a righe custom in `shared/go/merge`                                   |                                                                                                                                                                                                                                                                                                                                            |
| UUID           | `google/uuid` v7                                                                                                 |                                                                                                                                                                                                                                                                                                                                            |
| Log            | `zerolog` (desktop e cloud), OpenTelemetry SDK + exporter Prometheus/OTLP                                        |                                                                                                                                                                                                                                                                                                                                            |
| Lingua         | Codice, commit, log, messaggi API in inglese; `docs/`, ADR, runbook in italiano; UI via i18n `it`/`en`           |                                                                                                                                                                                                                                                                                                                                            |
| CI             | Workflow GitHub Actions in `.github/workflows/` (come da §4.1); se l'host sarà diverso si portano gli stessi job |                                                                                                                                                                                                                                                                                                                                            |
| Nome           | `nodus` resta il nome in codice ovunque (binari, scheme `nodus://`, client Keycloak); il rebrand è un task di M7 |                                                                                                                                                                                                                                                                                                                                            |

---

## 2. Principi di esecuzione

1. **Contract-first.** Ogni endpoint nasce in `api/openapi.yaml` (e `proto/`), poi `make gen`, poi implementazione. I tipi condivisi del protocollo (op, codici errore) vivono in `shared/go/syncproto` e sono la fonte per OpenAPI (enum) e per il client.
2. **Vertical slice per WP.** Ogni WP arriva fino a un comportamento osservabile (binding + UI minima, o endpoint + test d'integrazione), non "tutto il backend poi tutta la UI".
3. **Gate di qualità per milestone** (bloccanti in CI): `golangci-lint`, `go test -race`, `govulncheck`, ESLint/tsc, Vitest, conformance Go+TS, integration cloud (testcontainers), build desktop su 3 OS (da M0). Copertura ≥ 80 % su `parser`, `merge`, `sync`, `sharing` misurata da M2 in poi.
4. **Spike prima dei WP rischiosi.** Gli spike (§4) sono time-boxed (≤ 1 giorno) e producono un ADR in `docs/adr/`.
5. **Deviazioni dallo spec** → ADR + proposta all'utente; lo spec lo aggiorna l'utente. Deviazioni già note in questo piano (ciascuna → ADR): migrazioni DB incrementali; colonna `op_id` su `file_revisions` (M2-WP2); tabella `config_profile_versions` (M5-WP1); endpoint GDPR `GET /me/export` e `DELETE /me` (M7-WP2); pacchetti TS aggiuntivi `packages/config` e runner conformance in `shared/conformance/ts/` (M0-WP0/WP1).
6. **Parallelismo.** I WP marcati ∥ possono girare in worktree separati (es. parser Go ∥ editor TS); le interfacce tra i due lati sono fissate prima (binding tipizzati, fixture conformance).

---

## 3. Dipendenze tra milestone e percorso critico

```
M0 Fondamenta ─┬─► M1 Core editing ─┬─► M3 Excalidraw+Canvas ─┐
               │                     │                         ├─► M6 P1 residui ─► M7 Hardening ─► 1.0
               └─► M2 Sync ──────────┴─► M4 Sharing+Gruppi ─► M5 Console admin ┘
```

- M2 **dipende da M1-WP1** (parser frontmatter usato dal merge `.md` in M2-WP4) e da **M1-WP3** (`RenameWithLinkUpdate`/`file_id` usati da `detect.go` in M2-WP6); il resto di M1 (WP4–WP9, editor/UI) è indipendente da M2 e può procedere in parallelo (∥) con il lato cloud di M2 (WP1–WP3, WP7).
- M3 richiede M1 (embed/editor) e M2 (merge per-id sincronizzato).
- M4 richiede M2 (ACL applicata a changes/commit). M5 richiede M4 (gruppi, config profile) e M2 (export).
- M6 richiede M1 (grafo, bases su indice) e M2 (history con revisioni server).
- Ordine consigliato per un solo sviluppatore: M0 → M1 (WP1–WP4) → M2 → M1 (WP5–WP9) → M3 → M4 → M5 → M6 → M7.

---

## 4. Spike tecnici (M0, time-boxed, ciascuno con ADR)

| ID       | Domanda                                                                                                                                                                                             | Esito atteso / fallback                                                                                       |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| SPIKE-01 | Wails v2.12 su macOS: un URL `nodus://…` con app già aperta arriva a `OnUrlOpen` o a `OnSecondInstanceLaunch`? Su Windows (NSIS) e Linux (`.desktop`) l'URL arriva come argv della seconda istanza? | ADR-0001 "Consegna URL scheme per OS". Fallback: loopback resta primario (D-08), scheme solo dove verificato. |
| SPIKE-02 | `modernc.org/sqlite`: `CREATE VIRTUAL TABLE … USING fts5(…, tokenize='trigram')` funziona? prestazioni su 50k documenti sintetici?                                                                  | ADR-0002. Fallback: tokenizer `unicode61` + indice LIKE su candidati (degrado documentato).                   |
| SPIKE-03 | `@excalidraw/excalidraw` 0.18.x: peerDeps React, `EXCALIDRAW_ASSET_PATH` offline nel webview Wails (WKWebView/WebView2/WebKitGTK), bundle size con lazy import                                      | ADR-0003 "Versione React e strategia asset".                                                                  |
| SPIKE-04 | Live Preview CodeMirror 6: prototipo con 3 elementi (heading, wikilink, bold) con decorations/widget e "sintassi riappare sulla riga del cursore"                                                   | ADR-0004 "Architettura Live Preview" (pattern di estensione riusato in M1-WP5).                               |
| SPIKE-05 | CSP `default-src 'self'` senza `unsafe-eval` nel webview Wails: compatibilità con Vite dev server, KaTeX, Mermaid, WASM (`wasm-unsafe-eval`)                                                        | ADR-0005.                                                                                                     |

---

## 5. M0 — Fondamenta (esito: "Hello vault" con login funzionante)

### M0-WP0 Scaffolding monorepo

- `go.work` con i tre moduli; `shared/go/go.mod` (`nodus/shared`), `apps/desktop/go.mod`, `services/cloud/go.mod`.
- `package.json` radice + `workspaces di package.json.yaml` (`apps/desktop/frontend`, `web`, `packages/*`); `tsconfig.base.json`; ESLint flat config + Prettier condivisi in `packages/config/` (o radice).
- `Makefile`: `tools`, `gen`, `lint`, `test`, `test-integration`, `conformance`, `dev-cloud`, `dev-desktop`, `build-desktop`, `build-cloud`, `rename-module`.
- `.gitignore`, `.editorconfig`, `.golangci.yml` (con `depguard` per le regole di modularità §4.3), `LICENSE` (MIT, deciso).
- `docs/`: `docs/adr/0000-template.md`, `docs/roadmap.md` (copia di questo piano, aggiornata a ogni milestone), `docs/dev-setup.md`.
- `deploy/docker/compose.dev.yaml`: postgres:17, minio + `mc` bootstrap bucket, keycloak:26.x con import realm, (opzionale) mailpit per le email di Keycloak.
- Aggiornare `CLAUDE.md` con i comandi reali (sezione "Comandi").

### M0-WP1 Librerie condivise base (`shared/go`)

- `pathrules/`: `Normalize(path) (string, error)` (NFC, `/`, lunghezze, caratteri vietati, segmenti riservati Windows, `.`/`..`), `Key(path)` (NFC+casefold), `IsExcluded(path)` (§3.4.2). Test tabellari.
- `syncproto/`: tipi `Op`, `OpKind` (`create|modify|move|delete|restore|move_prefix`), `CommitRequest/Response`, `Change`, codici errore (§3.1) come costanti + mapping HTTP status; `hashing/` SHA-256 streaming con `io.Reader`.
- `pathrules` gestisce solo pattern/nomi; il rilevamento dei symlink (che richiede il FS) sta in `apps/desktop/internal/vault`.
- `shared/conformance/`: layout e formato fixture (`markdown/<case>.md` + `<case>.expected.json`; `crypto/vectors.json`), README del formato; runner Go (`shared/conformance/go_test.go`) e TS (`shared/conformance/ts/`, pacchetto Yarn eseguito da Vitest). In M0 solo 3 fixture (heading, wikilink, tag) per validare il meccanismo.

### M0-WP2 Contratti

- `api/openapi.yaml` v0: `/healthz`, `/readyz`, `/me`, `/me/devices` (GET/POST/DELETE), `/config/effective` (stub che ritorna default), schema `Problem`. Componenti riusabili (`Pagination`, `Error`).
- `api/proto/nodus/v1/notify.proto` (testo §3.6), `buf.yaml`, `buf.gen.yaml`.
- `make gen`: `oapi-codegen` → `services/cloud/internal/api/{types,server}.gen.go`; client TS → `packages/api-client/src/gen/`; buf → Go in `services/cloud/internal/api/grpc/` e client gRPC in `apps/desktop/internal/sync/transport/pb/`; `sqlc` (da M0-WP3); `wails generate module` per `wailsjs/`.

### M0-WP3 Cloud skeleton (`services/cloud`)

- `cmd/nodus-cloud/main.go`: flag `--role=api|worker|all`, config da env (`internal/config`: `DATABASE_URL`, `S3_*`, `OIDC_ISSUER`, `OIDC_AUDIENCE=nodus-api`, `KC_ADMIN_*`, `LISTEN_ADDR`), graceful shutdown.
- `internal/db`: pool pgx, helper `WithTx`, goose embedded; migrazione `0001_core.sql` = `citext`, `users`, `devices`, `settings`, `audit_log`; seed in `0002_seed_settings.sql` (`storage.default_quota_bytes`, soglie 80/95, `history.retention_days`, `files.max_size_bytes`).
- `internal/db/queries/*.sql` + `sqlc.yaml`.
- `internal/httpserver`: router chi, middleware `request-id`, `recover`, `logging`, `otel`, `ratelimit` (token bucket per utente/IP, header `RateLimit-*`), `cors` (solo origine Web UI), `compress` (gzip/br solo su JSON, mai sui blob), helper `ETag`/`If-Match` per le risorse modificabili (usato da M2-WP1 e M4-WP2), handler `Problem` RFC 9457; `/healthz`, `/readyz`, `/metrics`.
- `internal/auth`: verifica JWT via `go-oidc` (JWKS cache, `iss`, `aud`, `exp`, `azp`, skew 60 s), estrazione claims, **JIT provisioning** utenti (`users` upsert su `keycloak_sub`), controllo `users.status` con cache 30 s → `USER_SUSPENDED`; contesto `Principal{UserID, Role}`.
- `internal/users`: `GET /me`, dispositivi (`POST /me/devices` ritorna `device_id`), quota effettiva (default da `settings`).
- `internal/audit`, `internal/observability` (metriche RED, tracing).
- `internal/grpcserver`: `NotifyService.Subscribe` che per ora invia solo keepalive; interceptor auth.
- `test/integration`: testcontainers PG (+ Keycloak solo per il test di login reale, tag `integration`); test contratto base (`test/contract`: validazione risposte contro `openapi.yaml` con `kin-openapi`).
- `Dockerfile` multi-stage; `deploy/helm/nodus/` chart minimo (Deployment api/worker, Service, Ingress, ConfigMap/Secret).

### M0-WP4 Keycloak

- `deploy/keycloak/realm-nodus.json`: realm `nodus`, client `nodus-desktop` (public, PKCE S256, redirect `http://127.0.0.1/*` e `nodus://auth/callback`, scope `offline_access`), `nodus-web`, `nodus-api` (audience mapper), `nodus-admin-svc` (service account con `manage-users`,`view-users`,`query-users`), realm roles `nodus-admin`/`nodus-user`, token 5 min, SSO idle 8 h, refresh rotation, brute-force protection, password policy, WebAuthn/OTP abilitati come opzionali (§3.3.1), utenti di test `admin`/`user1`/`user2`.
- Script `deploy/keycloak/dev-seed.sh`.

### M0-WP5 Desktop skeleton (`apps/desktop`)

- `wails init -t react-ts` poi ristrutturazione secondo §4.2 (`internal/…`, `frontend/src/…`), `wails.json` con `info.protocols` per `nodus`.
- `main.go`: finestra singola, `SingleInstanceLock{UniqueId, OnSecondInstanceLaunch}` con `UniqueId` derivato dalla directory dati (`NODUS_DATA_DIR`/flag `--data-dir`), così due istanze con dir dati distinte possono coesistere per i test multi-dispositivo (M2); `Mac.OnUrlOpen`, menu nativo base, assetserver con CSP (SPIKE-05).
- `internal/app`: composizione (costruttori espliciti, niente DI framework), `bindings.go` (`VaultAPI`, `AuthAPI`, `SettingsAPI` iniziali), `events.go` (nomi evento come costanti condivise con TS in `frontend/src/app/events.ts`).
- `internal/store`: apertura `app.db` (vault recenti, impostazioni app), `index.db`/`sync.db` per vault in `.nodus/`; migrazioni goose embedded.
- `internal/vault`: `Manager` (vault recenti, apri/crea), `FS` con `ReadFile`, `WriteAtomic(tmp+fsync+rename)`, `Rename`, `Delete→.trash/`, guardie path traversal (`pathrules` + `filepath.EvalSymlinks` dentro la radice), `ListTree`.
- `internal/watcher`: fsnotify ricorsivo + debounce 1.5 s + riconciliazione periodica (mtime/size) → evento `vault:file-changed`.
- `internal/parser` v0: goldmark con estensione wikilink minima + heading + tag; `internal/indexer` v0: tabella `files` + `headings` + `links` + `tags` in `index.db`, scansione all'apertura (serve a M1 e a verificare l'ingranaggio).
- `internal/platform`: parsing URL `nodus://open?vault=&file=` e `nodus://auth/callback`, registrazione scheme (Info.plist via `build/darwin`, NSIS script, `.desktop` Linux).
- `internal/telemetry`: zerolog su file rotante in dir dati app; crash report **opt-in** (consenso nelle impostazioni, invio rinviato a M7-WP4).
- Frontend testabile fuori dal webview: shim dei binding (`frontend/src/test/wails-mock/` che implementa `window.go.*` e `runtime` con fixture) per far girare l'app in Chromium con Playwright; i test sul webview reale restano manuali (checklist per OS).
- Frontend: `app/` (shell, tema chiaro/scuro con token CSS, provider), `workspace/` minimo (una tab), `sidebar/` file explorer (tree, apri nota), `editor/` CodeMirror 6 in **Source mode** (solo highlighting markdown base), `state/` Zustand store vault + TanStack Query sui binding, `i18n/` (it, en) con i18next, `settings/` pannello "Generale" (lingua, tema).

### M0-WP6 Auth desktop end-to-end

- `internal/auth`: `Login()` → PKCE (verifier/challenge S256, `state`), listener `127.0.0.1:0`, apertura browser di sistema, callback, scambio token, salvataggio refresh token nel keychain; `Refresh()` silenzioso con rotation; fallback `scheme` (D-08) quando listener fallisce o Keycloak risponde `invalid_redirect_uri` o config forza `scheme`; `Logout()`; stato `auth:state` (`signed_out|signing_in|ready|disconnected`).
- `internal/sync/transport` v0: client HTTP con bearer + retry/backoff + `X-Request-Id`; chiamata `GET /me` e `POST /me/devices` (registrazione dispositivo con nome host/piattaforma).
- UI: pulsante "Accedi al cloud" nelle impostazioni → profilo mostrato.

### M0-WP7 CI

- `.github/workflows/ci.yml`: job `go` (lint, test -race, govulncheck), `ts` (tsc, eslint, vitest), `conformance`, `cloud-integration` (testcontainers), `desktop-build` matrix (ubuntu-24.04 con `webkit2gtk-4.1` e `wails build -tags webkit2_41`, windows, macos); `cloud-image` (buildx, push solo su tag).
- Cache Go/Yarn; `make ci` locale equivalente.

**Criteri di uscita M0:** `make dev-cloud` avvia lo stack (compose) e `curl /api/v1/me` con token Keycloak risponde; l'app desktop apre una cartella come vault, mostra l'albero, apre/modifica/salva una nota in Source mode (scrittura atomica verificata con test), rileva modifiche esterne; login PKCE loopback funziona su macOS (e in CI build su 3 OS); SPIKE-01, -02, -03, -05 chiusi con ADR (SPIKE-04 apre M1); CI verde.

---

## 6. M1 — Core editing (P0) (esito: parità funzionale P0 offline)

### M1-WP1 Parser OFM completo (Go) ∥ con WP5

- `internal/parser`: estensioni goldmark per wikilink (`[[Nota]]`, alias, `#heading`, `#^block`, `[[#heading]]`), embed `![[…]]` con parametri (`|WxH`, `#page=`), callout (`> [!type]±` con titolo), highlight `==`, commento `%%`, block-id `^id`, task con stati custom, tag `#a/b` (regole Obsidian: no solo cifre), footnote, math `$`/`$$` (solo riconoscimento), frontmatter YAML tipizzato (`tags`, `aliases`; `cssclasses` ignorata), tabelle GFM.
- Output: `parser.Document{Title, Aliases, Headings[], Links[], Embeds[], Tags[], Properties, Tasks[], BlockIDs[], Footnotes[], WordCount}` con posizioni (offset byte e riga).
- Fixture conformance complete (≥ 60 casi) in `shared/conformance/markdown/`, inclusi casi limite (link in code span/fence, escape, nested callout, tag in URL).

### M1-WP2 Indexer e index.db

- Schema `index.db` (goose): `files(path, mtime, size, hash, kind, title, word_count)`, `headings`, `links(src, target_raw, target_resolved, heading, block, alias, pos)`, `embeds`, `tags`, `properties(file, key, type, value_text, value_num, value_date, value_bool)`, `tasks`, `block_ids`, `aliases`, `fts_content` (FTS5 trigram su titolo+corpo), `fts_meta`.
- Pipeline incrementale: pool worker con backpressure, coalescing rename (stesso hash), re-parse solo file cambiati, evento `index:progress`; comando "Ricostruisci indice".
- Indicizzazione file `.excalidraw`/`.canvas` rinviata a M3 (hook predisposto in `indexer.Register(kind, extractor)`).

### M1-WP3 Link, backlink, rename refactoring

- `internal/links`: risoluzione target ("shortest path" configurabile: shortest/relative/absolute), alias, heading/block; note "fantasma" (non risolte); backlink e "menzioni non collegate" (ricerca del titolo nel FTS); outgoing links.
- `RenameWithLinkUpdate(from,to)`: `RenamePlan{AffectedFiles[], Rewrites[]}` → anteprima → applicazione transazionale (scrittura atomica di tutti i file, rollback su errore), aggiornamento indice. Test con fixture di vault.
- Binding `LinksAPI`: `Resolve`, `Backlinks`, `UnlinkedMentions`, `Outgoing`, `PlanRename`, `ApplyRename`.

### M1-WP4 Ricerca

- `internal/search`: parser query (§2.4: termini, frasi, `OR`, `-`, parentesi, `file: path: content: tag: line: block: section: task: task-todo: task-done: [prop:val] match-case: ignore-case: /regex/`) → AST → piano (predicati strutturali su tabelle + FTS + post-filtro RE2/co-occorrenza); snippet con evidenziazione; ordinamenti; "spiega termini".
- Sotto 3 caratteri: scansione lineare sui candidati. Benchmark con dataset sintetico 50k note (`tools/vaultgen` in `apps/desktop/internal/testutil`): obiettivo < 200 ms.
- Binding `SearchAPI.Query(vaultID, q, opts)`.

### M1-WP5 Editor CodeMirror 6 (frontend) ∥ con WP1–WP4

- `editor/`: setup (markdown language da `@lezer/markdown` con estensioni OFM Lezer: wikilink, embed, callout, highlight, comment, block-id, math, tag), tema chiaro/scuro, Source mode e **Live Preview** (ADR-0004): un'estensione per elemento in `editor/extensions/` rilasciata in quest'ordine: heading, emphasis/strike/highlight, link e wikilink (click con mod), liste e task (checkbox cliccabile), quote e callout (fold), code fence (highlight via Lezer), tabelle (editing assistito), math (KaTeX widget), mermaid (widget con render sandbox), embed (widget che chiede `ReadNote`/immagine ai binding con guardia anti-ciclo), footnote, frontmatter (vista Properties, WP7), commenti `%%` nascosti in reading.
- Autocompletamento: `[[` (note/alias da indice, `#` heading, `^` block con generazione id), `#` tag, proprietà frontmatter; slash `/` rinviato a M6.
- Comandi editor: auto-pair, continuazione liste/task/quote, indent/outdent, riordino liste, folding heading/liste, multi-cursore, find/replace con regex, selezione rettangolare, toggle formatting.
- Smart paste (URL su selezione, HTML→Markdown via `turndown`, immagine → salva in allegati + embed), drag&drop file.
- Salvataggio: debounce 500 ms, `WriteNote(expectedHash)`; su `conflict` (modifica esterna) banner "ricarica/sovrascrivi".
- Spellcheck webview, line wrap, larghezza lettura, numeri riga.

### M1-WP6 Reading view e rendering

- `reading/`: pipeline unified (`remark-parse`, `remark-gfm`, `remark-math`, plugin OFM custom per wikilink/embed/callout/highlight/comment/block-id/tag, `rehype-katex`, mermaid lazy, `rehype-sanitize` + DOMPurify, no `<style>`/`style`), TOC, embed ricorsivi (profondità max 5), PDF embed (`#page=`) via `<embed>`/pdf.js lazy, audio/video.
- Runner conformance TS: parser remark + Lezer producono lo stesso `expected.json` delle fixture (link/tag/heading/block/task) → CI.
- Page preview (hover) rinviato a M6.

### M1-WP7 Properties, tag, outline, word count

- `internal/properties`: schema tipi in `.nodus/types.json`, validazione/coercizione (`text,list,number,checkbox,date,datetime`), binding `PropertiesAPI` (`GetTypes`, `SetType`, `Update(file, key, value)` che riscrive il frontmatter preservando ordine/commenti).
- Frontend: editor Properties tipizzato in cima alla nota, vista Properties nel sidebar; vista Tags (gerarchica, conteggi); Outline; `statusbar/` word/char count (anche selezione).

### M1-WP8 Workspace, navigazione, comandi, impostazioni

- `workspace/`: tab, split orizzontale/verticale, linked panes, sidebar sx/dx, drag tab; persistenza `.nodus/workspace.json` (non sync); modalità per pannello (source/live/reading) ricordata.
- `commands/`: registro comandi unico (id, titolo i18n, hotkey default, `when`), command palette, hotkey personalizzabili (`.nodus/hotkeys.json`), quick switcher (fuzzy su nome/alias/heading con `fuse.js` o algoritmo custom), vault switcher.
- File explorer completo: crea nota/cartella, rinomina (usa `PlanRename`), sposta (drag), elimina (cestino di sistema via Wails/`.trash/` da impostazione), ordina, mostra allegati.
- `settings/`: pannelli Editor, File e link, Aspetto (tema, accento, font, zoom, larghezza), Hotkeys, Lingua; persistenza `.nodus/{editor,appearance}.json` (per utente, sincronizzabili in M2) + `app.db` per preferenze app.
- URI `nodus://open?vault=&file=` funzionante.

### M1-WP9 Qualità M1

- Playwright e2e in Chromium con lo shim dei binding (M0-WP5) per: apri vault, crea nota, wikilink + backlink, ricerca, rename con aggiornamento link, cambio modalità; checklist manuale equivalente sul webview reale per OS.
- Benchmark: apertura nota < 150 ms, indice iniziale 50k < 3 min (dataset sintetico), digitazione senza lag su 1 MB (test manuale documentato).

**Criteri di uscita M1:** tutte le righe P0 della matrice §2.2.1 tranne Sync/Excalidraw sono implementate; conformance Go/TS verde su ≥ 60 fixture; un vault Obsidian esistente di esempio si apre senza conversioni e i link si risolvono come in Obsidian (checklist manuale in `docs/qa/obsidian-parity.md`).

---

## 7. M2 — Sync (P0) (esito: multi-dispositivo affidabile, vault privati E2EE e condivisi)

### M2-WP1 Schema e moduli cloud: vault, blob, revisioni

- Migrazione `0002_vaults.sql`: `vaults`, `vault_key_envelopes`, `blobs`, `files`, `file_revisions` + trigger `vault_kind_immutable`; indici §3.2.2.
- `internal/vaults`: CRUD (`POST /vaults` con `kind` e `key_envelopes` obbligatori per `private`), rinomina, soft delete (30 gg) e `:restore`, `GET /vaults/{vid}/tree` (manifest + `as_of_seq`), `GET /vaults` con `mounts` (vuoto fino a M4).
- `internal/vaultkeys`: `GET/PUT /vaults/{vid}/key-envelopes[/{kind}]` (owner), validazione formato `kdf` e lunghezze; mai log del contenuto.
- `internal/blobs`: `POST blobs:check`, `PUT /blobs/{sha256}` (≤ 32 MB, ricalcolo hash, rifiuto mismatch), `GET /blobs/{sha256}` con `Range`, tus (`POST /vaults/{vid}/uploads`, `PATCH /uploads/{id}`) con store S3 e finalizzazione che verifica hash; `ref_count`.
- `internal/storage`: interfaccia `BlobStore` (S3 + filesystem per test).
- `internal/revisions`: `GET …/revisions`, `…/revisions/{rev}/content`, `:restore` (nuova revisione che riusa il blob), retention (tutte 30 gg, poi 1/giorno fino a 90) applicata dai job.

### M2-WP2 Commit e changes

- `internal/sync`: `POST /vaults/{vid}/commit` — per ogni op in ordine, transazione indipendente: ACL (in M2 solo owner), quota (`413 QUOTA_EXCEEDED`), `FILE_TOO_LARGE`, `PATH_INVALID`/`PATH_COLLISION` (su `path_key`), `base_rev == current_rev` altrimenti `conflict{REV_CONFLICT,current_rev,current_hash,current_seq}`, `BLOB_MISSING`, `file_id` client (UUID v7, rifiuto duplicati), `UPDATE vaults SET last_seq=last_seq+1 RETURNING`, scrittura revisione, aggiornamento `files`, `blobs.ref_count`, `users.used_bytes`, `vaults.total_bytes/file_count`; `move_prefix` (solo shared) ; `Idempotency-Key` + `op_id` univoco (tabella `commit_ops_seen` con TTL o unique su `file_revisions.op_id` → decidere: aggiungere colonna `op_id` in migrazione, ADR).
- `GET /vaults/{vid}/changes?since&limit` con `has_more`; `410 CURSOR_EXPIRED` quando `since < compaction_floor` (campo `vaults.compaction_seq`, job di compattazione in M2-WP7).
- `internal/quota`: calcolo quota effettiva, soglie 80/95/100, API `/me/usage`.
- Test d'integrazione: concorrenza (2 client stesso file → un `conflict`), quota, collisione case-insensitive, idempotenza.

### M2-WP3 Notifiche realtime

- `internal/notify`: Postgres `LISTEN/NOTIFY` canale `vault_changed` → fan-out in-process; `NotifyService.Subscribe` (replay da `known_seq`, chiusura `UNAUTHENTICATED` a token scaduto), `GET /events` SSE con `Last-Event-ID`.
- Desktop `sync/transport`: client gRPC stream con riconnessione dopo refresh; fallback SSE; polling adattivo 30 s → 5 min.

### M2-WP4 Merge condiviso (`shared/go/merge`) ∥ con WP1–WP3

- `merge/markdown.go`: 3-way (`base, ours, theirs`): frontmatter YAML per chiave (conflitto stessa chiave → remoto vince, locale in copia), corpo diff3 a righe con localizzazione via diff-match-patch; risultato `{Merged []byte, Clean bool, Conflicts []Hunk}`.
- `merge/jsonid.go`: Excalidraw (per `element.id`, `version`/`versionNonce`, `isDeleted`, unione `files`), Canvas (per id nodo/arco, tie-break per tempo server), config JSON LWW per chiave di primo livello.
- `merge/policy.go`: tabella decisionale §3.4.5 (tipo file × stesso/diverso autore × op) → `Strategy`.
- Fixture `shared/conformance/merge/` (base/ours/theirs/expected) e test tabellari; copertura ≥ 80 %.

### M2-WP5 Cripto E2EE (`shared/go/vaultcrypto` + desktop `crypto`) ∥

- `vaultcrypto`: `GenerateVMK`, `DeriveKEKPassphrase(argon2id, params)`, `DeriveKEKRecovery(hkdf)`, `Wrap/Unwrap(AES-GCM)`, `RecoveryKey` encode/decode Base32 con checksum, `DeriveSubkeys(VMK)` (`path-enc`, `path-key`, `file`), `EncryptBlob(w, r, vaultID, fileID)`/`DecryptBlob` a chunk 64 KiB con header `NDS1` e AAD §3.8.3, `EncryptPath`/`PathKey` (`enc1:`/`hmac1:`), calibrazione Argon2id sul dispositivo.
- Test vector in `shared/conformance/crypto/vectors.json` (KDF, wrap, blob a 0/1/2 chunk, path) generati da Go. Per rispettare §3.8.7 ("Go e TS a ogni CI") si anticipa qui il **core** di `packages/vaultcrypto-web` (KDF Argon2id via `hash-wasm`, HKDF/HMAC/AES-GCM via WebCrypto, formato blob e path; nessuna UI) con Vitest che verifica i vettori; M5-WP4 aggiunge solo lo streaming ZIP e la UI.
- Desktop `internal/crypto`: VMK nel keychain, lock/unlock con timeout, `VaultCryptoAPI` (§2.5): `CreateEncryptedVault`, `Unlock` (ritorna `requires_new_passphrase=true` quando lo sblocco avviene con recovery key, §3.8.4 p.4), `ChangePassphrase`, `RegenerateRecoveryKey`; zxcvbn (frontend) ≥ 3, min 12 caratteri.
- Avviso "disco non cifrato" dove rilevabile (FileVault via `fdesetup status`, BitLocker via WMI — best effort).

### M2-WP6 Sync engine desktop

- `internal/sync`: schema `sync.db` (§3.4.3: `sync_files`, `sync_cursor`, `outbox`, `conflicts`), `detect.go` (stato da watcher + riconciliazione, rename per hash o `file_id` da `RenameWithLinkUpdate`), `engine.go` (ciclo: pull → applica → push → risolvi; scheduler, pause/resume, backoff con jitter, `Retry-After`), `resolve.go` (usa `merge`, conflict copy `<nome> (conflitto <device> <data>).<ext>` con `conflict_of`, limite 5 tentativi → stato `conflict`), scope `.nodus/` (§3.4.6), esclusioni, eco per `device_id`, bootstrap da `/tree` su `CURSOR_EXPIRED`, upload grandi via tus.
- Vault privati: cifratura blob/path prima dell'upload, decifratura dopo il download, `kind=opaque`, nessun `move_prefix`; hash plaintext in `sync.db` per evitare re-upload.
- Binding `SyncAPI` (§2.5) + eventi `sync:status`, `sync:conflict`, `vault:locked`.
- Test: simulatore di 2 client contro cloud in testcontainers (test e2e Go in `apps/desktop/internal/sync/e2e_test.go`, tag `integration`): modifica concorrente `.md` non sovrapposta → merge; sovrapposta → conflict copy; rename vs modifica; delete vs modify; vault privato round-trip.

### M2-WP7 Job e manutenzione cloud

- `internal/jobs` (role `worker`): GC blob (`ref_count=0` + grace 24 h), riconciliazione `used_bytes` notturna, purge vault eliminati > 30 gg, retention revisioni, compattazione changelog (finestra configurabile, aggiorna `compaction_seq`).
- `GET/PUT /admin/settings/storage` rinviato a M5; in M2 i valori arrivano da `settings` seed.

### M2-WP8 UI sync

- `sync/` frontend: wizard "Collega al cloud" (tipo vault privato/condiviso con testi espliciti, passphrase + robustezza, recovery key con conferma per ri-digitazione, primo upload con progresso/ripresa), sblocco vault bloccato (con passphrase o recovery key; in quest'ultimo caso passo obbligatorio "imposta nuova passphrase" e opzione "rigenera recovery key"), indicatore stato per vault, vista "Risoluzione conflitti" (diff affiancato, Tieni locale/remoto/Unisci/Entrambi), "Cronologia nota" (lista revisioni, diff — decifrato sul client per i privati — e ripristino), dispositivi (lista/revoca via `/me/devices`), impostazioni sync (intervallo, pausa).
- Sync delle impostazioni utente `.nodus/*.json` con LWW per chiave.

**Criteri di uscita M2:** scenario a 2 dispositivi (2 istanze desktop con dir dati distinte) converge in entrambi i tipi di vault; nessuna perdita silenziosa (test); p95 `changes` < 200 ms e `commit` ≤ 50 op < 500 ms in load test locale (k6 base in `services/cloud/test/load/`); test vector cripto verdi in Go e TS.

---

## 8. M3 — Excalidraw + Canvas (esito: disegni nativi sincronizzati)

### M3-WP1 Excalidraw (frontend `drawing/`)

- Wrapper `@excalidraw/excalidraw` con `React.lazy`, `EXCALIDRAW_ASSET_PATH` → asset copiati nel bundle (`vite` plugin di copia), tema app, i18n.
- Tab "Disegno": apertura `.excalidraw`, autosave debounce 2 s via `WriteNote` binario con `expectedHash`, read-only se permesso `viewer` (M4) o vault bloccato.
- Comandi: "Nuovo disegno" (palette, inserisce embed se invocato da una nota), "Inserisci disegno"; doppio clic su embed → editor (tab o overlay); export PNG 1x–3x con/senza sfondo, SVG, copia appunti; libreria `.nodus/excalidraw-library.json`; modalità presentazione/zen.
- Soglia 10 MB per disegno con avviso.

### M3-WP2 Supporto backend disegni (`internal/drawing`)

- Validazione JSON Excalidraw; estrattore per l'indexer: testo elementi `text` (FTS) e `link` degli elementi verso `[[Nota]]` (archi grafo/backlink con etichetta "Disegno X").
- Anteprima SVG: generata dal frontend (`exportToSvg`) e salvata via binding in `.nodus/cache/drawings/<hash>.svg`; invalidazione per hash; embed `![[x.excalidraw|600]]` in Live Preview/Reading usa la cache (fallback: render lazy).

### M3-WP3 Canvas (JSON Canvas)

- `internal/canvas`: parse/validate `.canvas` (nodi `text|file|link|group`, edges), estrattore indexer (testo, link a file).
- Frontend `canvas/`: editor su `<canvas>`/SVG con pan/zoom, creazione nodi (testo con mini editor CM6, nota come embed, media, link, gruppo), archi con etichette, selezione/drag/resize, colori preset, undo/redo, autosave; embed `![[mappa.canvas]]` in nota (render statico).

### M3-WP4 Sync per-id e CI offline

- Attivazione in `sync/resolve.go` delle strategie `jsonid` per `.excalidraw`/`.canvas` (stesso utente); test e2e di merge tra 2 dispositivi.
- Test Playwright (Chromium + shim binding) che intercetta le richieste di rete durante apertura di un disegno: **zero richieste esterne** (gate CI); verifica manuale sul webview per OS nella checklist M3.

**Criteri di uscita M3:** creare/embed/modificare/esportare un disegno offline; link da elemento a nota compare nei backlink; ricerca trova testo nel disegno; 2 dispositivi convergono su un disegno modificato in parti diverse.

---

## 9. M4 — Condivisione e gruppi (esito: collaborazione asincrona)

### M4-WP1 Gruppi e directory (cloud)

- Migrazione `0003_groups_sharing.sql`: `groups`, `group_members`, `shares`, `share_grants`, trigger `shares_vault_kind_chk`, `config_profiles`, `config_assignments`.
- `internal/groups`: CRUD (endpoint admin in M5; in M4 API interna + `GET /me/groups`), `GET /directory/users|groups?q=` (campi minimi).

### M4-WP2 Sharing e ACL

- `internal/sharing`: `POST /shares` (solo `kind=shared` → `409 VAULT_ENCRYPTED`), `GET/PATCH/DELETE /shares/{id}`, grant `PUT/DELETE …/grants/{ptype}/{pid}`, `:accept`/`:decline`, `GET /shares?scope=`, `GET /shared-with-me` (mount + `scope`), scadenza/revoca.
- `Evaluator.Effective(user, vault, path) Permission` (§3.3.2: private → solo owner; owner; grant accettati utente+gruppi su share attivi il cui scope copre il path; massimo), cache per richiesta, invalidazione su modifica share/gruppi.
- Enforcement in `sync` (changes/blob/commit): `scope=share:{id}` filtra per prefisso/ACL e trasforma uscita/entrata dal prefisso in `delete`/`create`; path relativi alla radice dello share; `editor` vincolato al prefisso (`FORBIDDEN`); `move_prefix` aggiorna `shares.path_prefix`; `SHARE_ROOT_MOVE`; `404` per risorse non autorizzate.
- Eventi `ShareChanged` (granted/revoked/updated) e `VaultChanged` ai destinatari.
- Audit per share/grant. Test integrazione ACL (matrice §3.3.2) e scope.

### M4-WP3 Config Profile (cloud)

- `internal/configprofiles`: JSON Schema (`api/config-profile.schema.json`: feature flag, default editor/aspetto, hotkey, intervallo sync, limite allegati, daily notes, template library, server list), merge effettiva (default prodotto → globale → gruppi per priorità → override utente non `locked`), `GET /config/effective` con `ETag`/`If-None-Match`, evento `ConfigChanged`; versioning e rollback (API admin in M5).

### M4-WP4 Desktop: mount, condivisione, config

- `sync/scope.go`: mount come vault separato (dir locale `<data>/mounts/<share_id>/`, `sync.db` dedicato, cursor per scope), smontaggio su revoca (opzione "mantieni copia scollegata"), mount virtuale "Condivisi con me" per documenti singoli.
- UI: inviti (accetta/rifiuta), dialog "Condividi" (cartella/documento, ricerca utenti/gruppi, livello), elenco condivisioni (mie/con me), badge permesso, read-only per `viewer` (editor, Excalidraw, canvas).
- `internal/config` + `internal/features`: scarica config effettiva (ETag, cache offline), applica `locked` (UI disabilitata con "gestita dall'amministratore"), feature flag che nascondono funzioni; libreria template di gruppo come mount read-only (in M4 solo il montaggio; il consumo dei template arriva con `templates` in M6-WP3).
- Merge multi-utente: policy "autori diversi e non `.md` → conflict copy" attiva in `resolve.go`.

### M4-WP5 Web UI — base e area utente

- `web/`: Vite + React, `oidc-client-ts` PKCE (`nodus-web`), guardie di ruolo, `packages/api-client`, `packages/ui` (design system: tokens, tabelle, form, barra quota).
- Route utente: Spazio utilizzato (`/me/usage`), I miei vault (tipo, dimensione, file, ultimo sync), Dispositivi, Condivisioni. Download ZIP rinviato a M5.
- `services/cloud/web-embed` con `go:embed` + fallback SPA; CSP rigida e SRI.

**Criteri di uscita M4:** utente A condivide una cartella con un gruppo; B (membro) accetta, vede il mount, modifica (editor) e A riceve; `viewer` non può scrivere (server e UI); revoca → smontaggio; config profile con chiave `locked` bloccata nella UI del client; Web UI utente funzionante.

---

## 10. M5 — Console admin ed export (esito: governance completa)

### M5-WP1 API admin (cloud)

- `internal/keycloak`: client Admin REST (service account, token caching, rotazione segreto), `CreateUser` con required actions, `SetEnabled`, `LogoutUser` (revoca sessioni), `GetUserSessions`, `ResetPassword` action, `SetRealmRole`; test con testcontainers Keycloak.
- `internal/users` admin: `/admin/users` (lista paginata con filtri), CRUD, `:suspend`/`:activate` (Keycloak + `users.status`), `/role`, `/quota` (`null`=default, `-1`=illimitata), `:reset-password`, `/vaults` (solo metadati), `/config/effective`.
- `/admin/groups…` (membri, ruolo, config-profiles con priorità), `/admin/config-profiles…` (incrementa `version`, cronologia in tabella `config_profile_versions` — migrazione `0004_admin.sql`), `/admin/settings/storage`, `/admin/storage/overview`, `/admin/audit-log` (+ export CSV).
- Ogni mutazione → `audit_log`. Eventi `AccountChanged` (sospensione, quota).

### M5-WP2 Export ZIP (cloud)

- Migrazione `export_jobs`; `internal/exports`: `GET /vaults/{vid}/export.zip` streaming (`archive/zip` con `Store` per i blob, soglia 512 MB), `POST /vaults/{vid}/exports` → job (worker) che scrive ZIP su S3 e `download_url` presigned 24 h; `409 VAULT_ENCRYPTED` per i privati; esclusione `.nodus/` device-specific; job `expired`.

### M5-WP3 Web UI admin

- Route admin: Dashboard storage (totali, top consumer, soglie, trend), Limiti di archiviazione (default globale, override per utente, azioni in blocco), Utenti (tabella, creazione, sospensione, ruolo, reset password, eliminazione, dettaglio con vault/dispositivi/sessioni), Gruppi (CRUD, membri, profili con priorità), Config Profile (editor JSON con validazione schema, anteprima effettiva per utente, cronologia, rollback), Audit log (filtri, CSV).
- WCAG 2.1 AA: navigazione tastiera, label, contrasto (audit in M7).

### M5-WP4 Download ZIP utente e `vaultcrypto-web`

- `packages/vaultcrypto-web`: porting TS del formato §3.8.3 (WebCrypto AES-GCM/HKDF/HMAC, `hash-wasm` Argon2id), verifica test vector condivisi in CI (Vitest).
- Web UI: vault condiviso → download diretto o job asincrono; vault privato → `GET /key-envelopes` → passphrase/recovery key nel browser → `tree` + blob cifrati → decifratura e ZIP in streaming (`client-zip`/`fflate` + File System Access API o download stream), avviso "per vault grandi usa il client desktop".
- Desktop: comando "Esporta vault come ZIP".

**Criteri di uscita M5:** admin crea un utente (compare in Keycloak), lo sospende (accesso decade entro 30 s anche con token valido), imposta quota (scrittura bloccata a 100 %), assegna profilo a gruppo, legge audit; utente scarica ZIP di un vault condiviso e di uno privato (decifrato nel browser) e i contenuti coincidono con il vault locale.

---

## 11. M6 — P1 residui (esito: parità 1.0)

### M6-WP1 Graph view

- `internal/graph`: nodi/archi dall'indice (note, fantasma, allegati opzionali, tag opzionali), filtri (query di ricerca, tag, cartelle, orfani), dati per timelapse (ctime).
- Frontend `graph/`: rendering WebGL (`pixi.js` o canvas 2D con fallback), layout force-directed in Web Worker (`d3-force`), grafo globale e locale (profondità), gruppi colore per query, forze regolabili, hover/click apre nota; obiettivo 10k nodi ≥ 30 fps.

### M6-WP2 Bases

- `internal/bases`: parser `.base` (YAML: viste, filtri, formule, ordinamento), motore di query sulle `properties` indicizzate, valutatore di formule (sottoinsieme: aritmetica, stringhe, date, `if`, funzioni su liste), binding `BasesAPI`.
- Frontend `bases/`: viste tabella (edit inline delle properties) e card, selettore vista, filtri UI, embed `![[x.base]]`.

### M6-WP3 Daily notes, unique notes, template, composer, bookmarks, workspaces

- `internal/templates`: variabili `{{date:FORMAT}}`, `{{time}}`, `{{title}}`, cartella template (anche mount di gruppo), daily notes (formato, cartella, template, "apri oggi", navigazione giorni), unique note creator (prefisso timestamp).
- `internal/composer`: unisci note (append + redirect link), estrai selezione in nuova nota (sostituisce con link).
- Bookmarks (`.nodus/bookmarks.json`, gruppi, nota/heading/block/ricerca/grafo) con vista sidebar; Workspaces (layout salvati `.nodus/workspaces.json`).
- Slash commands `/` nell'editor (riusa il registro comandi); Random note; Page preview (hover con render reading in popover).

### M6-WP4 Importer

- `internal/importer`: interfaccia `Importer{Detect, Preview, Run}` + report; sorgenti: cartella Markdown/HTML (con riscrittura link), Evernote ENEX, Notion (export zip), Roam (JSON), Bear, Google Keep (Takeout), CSV→note; Apple Notes rinviato a P2. UI wizard con anteprima e report.

### M6-WP5 History locale e recovery

- `internal/history`: snapshot in `.nodus/snapshots/` ogni 5 min se modificato, retention 7 gg (configurabile), UI "File recovery" (lista, diff, ripristino); integrazione con cronologia cloud (M2) in un'unica vista.

### M6-WP6 Embedded search, export, varie

- Code block `query` renderizzato in Live Preview/Reading con risultati live; export PDF (stampa webview con stile reading) e HTML autonomo; impostazioni rimanenti (cestino, cartella allegati, daily notes).

**Criteri di uscita M6:** tutte le righe P1 della matrice §2.2.1 implementate; checklist parità aggiornata; benchmark grafo.

---

## 12. M7 — Hardening e rilascio 1.0

### M7-WP1 Prestazioni

- Dataset sintetici (50k note, 10k nodi grafo) in CI nightly; benchmark avvio < 3 s, apertura nota < 150 ms, ricerca < 200 ms, indice 50k < 3 min; profiling Go/React; k6 su cloud (1.000 utenti attivi simulati: `changes`/`commit`).

### M7-WP2 Sicurezza e privacy

- Pacchetto per audit esterno del design cripto (`docs/security/crypto-design.md`, test vector, threat model §3.8.1); preparazione pen test (`docs/security/pentest-scope.md`); CSP/SRI verificati; `govulncheck`, `yarn npm audit`, SBOM (syft) in CI; GDPR: `GET /me/export` (dati account) e cancellazione account con purge (`DELETE /me` con conferma, job purge) — endpoint non in §3.5, ADR + proposta spec; retention documentata.

### M7-WP2b Resilienza (Appendice A: disponibilità e affidabilità dati)

- Fault injection: kill del cloud a metà `commit` (nessuna revisione parziale, client riprova con idempotenza), crash del client durante `WriteAtomic` (nessun file parziale), interruzione upload tus e ripresa, perdita di rete durante pull (cursor non avanza), restart PG/MinIO (readiness, backoff).
- Chaos test base sul chart Helm (pod kill, restart rolling) con misura dell'SLO 99,9 % su finestra di test; runbook backup/PITR PG e versioning bucket provati con un restore reale e documentati (`docs/runbook/backup-restore.md`).

### M7-WP3 Distribuzione e aggiornamenti

- `internal/updater`: canale di update firmato (manifest JSON firmato ed25519, verifica firma, download, applicazione per OS), UI "Aggiornamento disponibile".
- Installer: NSIS (Windows, firma Authenticode), `.dmg` notarizzato (macOS), AppImage + `.deb` (Linux, `.desktop` con `x-scheme-handler/nodus`); pipeline release con tag semver; immagini OCI firmate (cosign) + Helm chart completo (HPA, PDB, secret, ingress gRPC/HTTP2) e `compose` per on-premise.

### M7-WP4 Accessibilità, i18n, documentazione

- Audit WCAG 2.1 AA Web UI (axe in Playwright), navigazione tastiera/screen reader del client; revisione traduzioni it/en.
- Docs: guida utente, guida amministratore (installazione, Keycloak, backup/PITR, runbook incidenti, osservabilità con dashboard Grafana), `docs/adr/` completo, rebrand del nome (task con l'utente).

### M7-WP5 Release

- Release candidate, test manuale cross-OS da checklist, fix, tag `v1.0.0`.

**Post-1.0 (P2, fuori piano):** Slides, Audio recorder, Web viewer, Vim mode, CLI, finestre pop-out (processo secondario + IPC), rotazione VMK, Apple Notes importer, format converter.

---

## 13. Trasversale: test e verifica

| Livello            | Strumento                                                                         | Dove                                                       |
| ------------------ | --------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Unit Go            | `go test -race ./...` (tabelle per parser, pathrules, merge, vaultcrypto, search) | tutti i moduli                                             |
| Conformance        | fixture `shared/conformance/{markdown,merge,crypto}` eseguite da Go e TS          | `make conformance`                                         |
| Integrazione cloud | testcontainers (PG, MinIO, Keycloak)                                              | `services/cloud/test/integration`, `make test-integration` |
| Contratto          | risposte validate contro `openapi.yaml`                                           | `services/cloud/test/contract`                             |
| E2E sync           | 2 engine desktop contro cloud in container                                        | `apps/desktop/internal/sync/e2e_test.go`                   |
| Frontend           | Vitest (unit/componenti), Playwright su Wails dev server e su Web UI              | `apps/desktop/frontend/src/test`, `web/src/test`           |
| Prestazioni        | benchmark Go (`-bench`), k6, dataset sintetici                                    | nightly                                                    |
| Sicurezza          | govulncheck, yarn npm audit, SBOM, test CSP/no-network                            | CI                                                         |

Verifica end-to-end di ogni milestone = i "Criteri di uscita" sopra, eseguiti con `make ci` + scenario manuale documentato in `docs/qa/m<N>-checklist.md`.

---

## 14. Primi passi operativi (subito dopo l'approvazione)

1. M0-WP0 scaffolding + `docs/roadmap.md` (questo piano) + aggiornamento `CLAUDE.md` con i comandi.
2. SPIKE-01, -02, -03, -05 (SPIKE-04 all'inizio di M1) con ADR.
3. M0-WP1 → WP2 → WP3/WP4 (cloud+Keycloak) → WP5 → WP6 → WP7.
4. Decisioni ancora aperte: hosting (il module path resta `nodus`, licenza MIT già decisa); scelta `op_id` persistito (M2-WP2); libreria rendering grafo (M6).
