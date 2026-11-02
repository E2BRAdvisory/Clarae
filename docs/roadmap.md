# Piano di sviluppo MemoBrain Notes — da `Specifications.md` v1.1 al rilascio 1.0

## Contesto

Il repository contiene solo `Specifications.md` (v1.1, 23/10/2026) e `CLAUDE.md`. Lo spec definisce architettura, vincoli (V-01…V-10), decisioni (D-01…D-08), schema DB, API, protocollo di sync, E2EE e layout del monorepo, oltre a una roadmap per milestone (Appendice B) senza scomposizione in task. Questo piano trasforma la roadmap in un piano eseguibile: per ogni milestone M0–M7 definisce work package (WP), task concreti con file e ordine, criteri di uscita e verifica. Il piano è pensato per un singolo sviluppatore affiancato da Claude Code; dove due WP sono indipendenti lo segnalo come parallelizzabile (worktree/agent).

Regole ereditate da `CLAUDE.md`: non modificare `Specifications.md` in automatico (le deviazioni si propongono come ADR in `docs/adr/` e l'utente aggiorna lo spec); nessun commit/push senza richiesta esplicita.

---

## 1. Decisioni di piano (vincolanti per l'esecuzione)

| Tema           | Scelta                                                                                                                         | Note                                                                                                                                                                                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Module path Go | Path locale `memobrain` (moduli `memobrain/apps/desktop`, `memobrain/services/cloud`, `memobrain/shared`) in `go.work`         | Host non ancora deciso. Il rename futuro è un `find/sed` sugli import + `go.mod`; task **M0-00** lo prevede con `task rename-module NEW=…`.                                                                                                                                                                                                |
| Go             | 1.27 (sqlc 1.31 e buf 1.75 richiedono ≥ 1.26; il toolchain si scarica via `GOTOOLCHAIN=auto`)                                  | Tutti i tool (`oapi-codegen`, `sqlc`, `goose`, `buf`, `golangci-lint`, `govulncheck`, `protoc-gen-go*`) sono pinnati con `tool` directive in un modulo separato `tools/go.mod` **fuori da `go.work`** (installazione con `task tools` → `GOWORK=off go install tool`), così il loro albero di dipendenze non entra nei moduli applicativi. |
| Wails          | v2.12.0 (installato) — D-07                                                                                                    | `OnUrlOpen` (Mac) + `SingleInstanceLock`/`OnSecondInstanceLaunch` esistono in v2 ≥ 2.10; comportamento "URL verso istanza già attiva su macOS" da verificare nello **SPIKE-01**.                                                                                                                                                           |
| Node / Yarn    | Node 24 LTS, Yarn 4 (corepack, `packageManager` bloccato)                                                                      | Workspace Yarn: `apps/desktop/frontend`, `web`, `packages/*`.                                                                                                                                                                                                                                                                              |
| React          | 19 (verifica peerDeps di `@excalidraw/excalidraw` 0.18.x nello **SPIKE-03**; fallback React 18.3)                              | Vite 6, TypeScript 5 `strict`, ESLint flat config, Prettier, Vitest, Playwright.                                                                                                                                                                                                                                                           |
| Stato/query FE | Zustand + TanStack Query (cache delle chiamate ai binding)                                                                     | Spec §4.2 `state/`.                                                                                                                                                                                                                                                                                                                        |
| Editor         | CodeMirror 6 + `@lezer/markdown`; reading view `unified` (remark/rehype) + plugin OFM custom                                   | KaTeX, Mermaid (`securityLevel: strict`), DOMPurify.                                                                                                                                                                                                                                                                                       |
| Cloud HTTP     | `chi` + `oapi-codegen` v2 (strict server, chi) ; errori RFC 9457                                                               | `api/openapi.yaml` fonte unica.                                                                                                                                                                                                                                                                                                            |
| gRPC           | `buf` + `protoc-gen-go`/`protoc-gen-go-grpc`; SSE fallback in `httpserver`                                                     | Solo `NotifyService`.                                                                                                                                                                                                                                                                                                                      |
| DB             | PostgreSQL 17 (compose) — pgx v5, sqlc, goose (migrazioni SQL embedded)                                                        | **Deviazione dichiarata dalla roadmap (App. B pone "schema DB" in M0):** lo schema §3.2.2 viene introdotto per migrazioni incrementali per milestone (`0001` M0, `0002`–`0003` M2, `0004` M4, `0005` M5), così ogni tabella arriva con il modulo che la usa e i suoi test.                                                                 |
| Storage        | S3 via `minio-go` (MinIO in dev) + driver filesystem per test unit                                                             | tus 1.0 con `tusd/v2` (handler embedded, store S3).                                                                                                                                                                                                                                                                                        |
| JWT/OIDC       | `coreos/go-oidc/v3` + `golang.org/x/oauth2` (desktop PKCE e cloud JWKS)                                                        | Keycloak 26.x (26.7 ultima nota) in compose; realm export in `deploy/keycloak/realm-memobrain.json`.                                                                                                                                                                                                                                       |
| Keychain       | `zalando/go-keyring`                                                                                                           | macOS Keychain / Credential Manager / Secret Service.                                                                                                                                                                                                                                                                                      |
| SQLite client  | `modernc.org/sqlite` (FTS5 + `trigram`): verifica **SPIKE-02**                                                                 | Migrazioni `index.db`/`sync.db`/`app.db` con goose su `database/sql`.                                                                                                                                                                                                                                                                      |
| Cripto         | `crypto/aes`, `crypto/cipher`, `x/crypto/argon2`, `x/crypto/hkdf`; browser WebCrypto + `hash-wasm` (Argon2id)                  | Formato §3.8.3; test vector condivisi.                                                                                                                                                                                                                                                                                                     |
| Diff/merge     | `sergi/go-diff` (diff-match-patch) + diff3 a righe custom in `shared/go/merge`                                                 |                                                                                                                                                                                                                                                                                                                                            |
| UUID           | `google/uuid` v7                                                                                                               |                                                                                                                                                                                                                                                                                                                                            |
| Log            | `zerolog` (desktop e cloud), OpenTelemetry SDK + exporter Prometheus/OTLP                                                      |                                                                                                                                                                                                                                                                                                                                            |
| Lingua         | Codice, commit, log, messaggi API in inglese; `docs/`, ADR, runbook in italiano; UI via i18n `it`/`en`                         |                                                                                                                                                                                                                                                                                                                                            |
| CI             | Dal 2026-11-01 nessun servizio di CI: `task ci` in locale prima di merge e tag; solo `release.yml` su GitHub (ADR-0036)        |                                                                                                                                                                                                                                                                                                                                            |
| Nome           | Nome in codice `nodus` (segnaposto); nome ufficiale **MemoBrain Notes** (identificatori `memobrain`), rebrand eseguito dopo M7 |                                                                                                                                                                                                                                                                                                                                            |

---

## 2. Principi di esecuzione

1. **Contract-first.** Ogni endpoint nasce in `api/openapi.yaml` (e `proto/`), poi `task gen`, poi implementazione. I tipi condivisi del protocollo (op, codici errore) vivono in `shared/go/syncproto` e sono la fonte per OpenAPI (enum) e per il client.
2. **Vertical slice per WP.** Ogni WP arriva fino a un comportamento osservabile (binding + UI minima, o endpoint + test d'integrazione), non "tutto il backend poi tutta la UI".
3. **Gate di qualità per milestone** (bloccanti in `task ci`, eseguito in locale: ADR-0036): `golangci-lint`, `go test -race`, `govulncheck`, ESLint/tsc, Vitest, conformance Go+TS, integration cloud (testcontainers), build desktop su 3 OS (da M0). Copertura ≥ 80 % su `parser`, `merge`, `sync`, `sharing` misurata da M2 in poi.
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

| ID       | Domanda                                                                                                                                                                                                 | Esito atteso / fallback                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| SPIKE-01 | Wails v2.12 su macOS: un URL `memobrain://…` con app già aperta arriva a `OnUrlOpen` o a `OnSecondInstanceLaunch`? Su Windows (NSIS) e Linux (`.desktop`) l'URL arriva come argv della seconda istanza? | ADR-0001 "Consegna URL scheme per OS". Fallback: loopback resta primario (D-08), scheme solo dove verificato. |
| SPIKE-02 | `modernc.org/sqlite`: `CREATE VIRTUAL TABLE … USING fts5(…, tokenize='trigram')` funziona? prestazioni su 50k documenti sintetici?                                                                      | ADR-0002. Fallback: tokenizer `unicode61` + indice LIKE su candidati (degrado documentato).                   |
| SPIKE-03 | `@excalidraw/excalidraw` 0.18.x: peerDeps React, `EXCALIDRAW_ASSET_PATH` offline nel webview Wails (WKWebView/WebView2/WebKitGTK), bundle size con lazy import                                          | ADR-0003 "Versione React e strategia asset".                                                                  |
| SPIKE-04 | Live Preview CodeMirror 6: prototipo con 3 elementi (heading, wikilink, bold) con decorations/widget e "sintassi riappare sulla riga del cursore"                                                       | ADR-0004 "Architettura Live Preview" (pattern di estensione riusato in M1-WP5).                               |
| SPIKE-05 | CSP `default-src 'self'` senza `unsafe-eval` nel webview Wails: compatibilità con Vite dev server, KaTeX, Mermaid, WASM (`wasm-unsafe-eval`)                                                            | ADR-0005.                                                                                                     |

---

## 5. M0 — Fondamenta (esito: "Hello vault" con login funzionante)

### M0-WP0 Scaffolding monorepo

- `go.work` con i tre moduli; `shared/go/go.mod` (`memobrain/shared`), `apps/desktop/go.mod`, `services/cloud/go.mod`.
- `package.json` radice + `workspaces di package.json.yaml` (`apps/desktop/frontend`, `web`, `packages/*`); `tsconfig.base.json`; ESLint flat config + Prettier condivisi in `packages/config/` (o radice).
- `Makefile` (sostituito da `Taskfile.yml`, ADR-0032): `tools`, `gen`, `lint`, `test`, `test-integration`, `conformance`, `dev-cloud`, `dev-desktop`, `build-desktop`, `build-cloud`, `rename-module`.
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
- `api/proto/memobrain/v1/notify.proto` (testo §3.6), `buf.yaml`, `buf.gen.yaml`.
- `task gen`: `oapi-codegen` → `services/cloud/internal/api/{types,server}.gen.go`; client TS → `packages/api-client/src/gen/`; buf → Go in `services/cloud/internal/api/grpc/` e client gRPC in `apps/desktop/internal/sync/transport/pb/`; `sqlc` (da M0-WP3); `wails generate module` per `wailsjs/`.

### M0-WP3 Cloud skeleton (`services/cloud`)

- `cmd/memobrain-cloud/main.go`: flag `--role=api|worker|all`, config da env (`internal/config`: `DATABASE_URL`, `S3_*`, `OIDC_ISSUER`, `OIDC_AUDIENCE=memobrain-api`, `KC_ADMIN_*`, `LISTEN_ADDR`), graceful shutdown.
- `internal/db`: pool pgx, helper `WithTx`, goose embedded; migrazione `0001_core.sql` = `citext`, `users`, `devices`, `settings`, `audit_log`; seed in `0002_seed_settings.sql` (`storage.default_quota_bytes`, soglie 80/95, `history.retention_days`, `files.max_size_bytes`).
- `internal/db/queries/*.sql` + `sqlc.yaml`.
- `internal/httpserver`: router chi, middleware `request-id`, `recover`, `logging`, `otel`, `ratelimit` (token bucket per utente/IP, header `RateLimit-*`), `cors` (solo origine Web UI), `compress` (gzip/br solo su JSON, mai sui blob), helper `ETag`/`If-Match` per le risorse modificabili (usato da M2-WP1 e M4-WP2), handler `Problem` RFC 9457; `/healthz`, `/readyz`, `/metrics`.
- `internal/auth`: verifica JWT via `go-oidc` (JWKS cache, `iss`, `aud`, `exp`, `azp`, skew 60 s), estrazione claims, **JIT provisioning** utenti (`users` upsert su `keycloak_sub`), controllo `users.status` con cache 30 s → `USER_SUSPENDED`; contesto `Principal{UserID, Role}`.
- `internal/users`: `GET /me`, dispositivi (`POST /me/devices` ritorna `device_id`), quota effettiva (default da `settings`).
- `internal/audit`, `internal/observability` (metriche RED, tracing).
- `internal/grpcserver`: `NotifyService.Subscribe` che per ora invia solo keepalive; interceptor auth.
- `test/integration`: testcontainers PG (+ Keycloak solo per il test di login reale, tag `integration`); test contratto base (`test/contract`: validazione risposte contro `openapi.yaml` con `kin-openapi`).
- `Dockerfile` multi-stage; `deploy/helm/memobrain/` chart minimo (Deployment api/worker, Service, Ingress, ConfigMap/Secret).

### M0-WP4 Keycloak

- `deploy/keycloak/realm-memobrain.json`: realm `memobrain`, client `memobrain-desktop` (public, PKCE S256, redirect `http://127.0.0.1/*` e `memobrain://auth/callback`, scope `offline_access`), `memobrain-web`, `memobrain-api` (audience mapper), `memobrain-admin-svc` (service account con `manage-users`,`view-users`,`query-users`), realm roles `memobrain-admin`/`memobrain-user`, token 5 min, SSO idle 8 h, refresh rotation, brute-force protection, password policy, WebAuthn/OTP abilitati come opzionali (§3.3.1), utenti di test `admin`/`user1`/`user2`.
- Script `deploy/keycloak/dev-seed.sh`.

### M0-WP5 Desktop skeleton (`apps/desktop`)

- `wails init -t react-ts` poi ristrutturazione secondo §4.2 (`internal/…`, `frontend/src/…`), `wails.json` con `info.protocols` per `memobrain`.
- `main.go`: finestra singola, `SingleInstanceLock{UniqueId, OnSecondInstanceLaunch}` con `UniqueId` derivato dalla directory dati (`MEMOBRAIN_DATA_DIR`/flag `--data-dir`), così due istanze con dir dati distinte possono coesistere per i test multi-dispositivo (M2); `Mac.OnUrlOpen`, menu nativo base, assetserver con CSP (SPIKE-05).
- `internal/app`: composizione (costruttori espliciti, niente DI framework), `bindings.go` (`VaultAPI`, `AuthAPI`, `SettingsAPI` iniziali), `events.go` (nomi evento come costanti condivise con TS in `frontend/src/app/events.ts`).
- `internal/store`: apertura `app.db` (vault recenti, impostazioni app), `index.db`/`sync.db` per vault in `.memobrain/`; migrazioni goose embedded.
- `internal/vault`: `Manager` (vault recenti, apri/crea), `FS` con `ReadFile`, `WriteAtomic(tmp+fsync+rename)`, `Rename`, `Delete→.trash/`, guardie path traversal (`pathrules` + `filepath.EvalSymlinks` dentro la radice), `ListTree`.
- `internal/watcher`: fsnotify ricorsivo + debounce 1.5 s + riconciliazione periodica (mtime/size) → evento `vault:file-changed`.
- `internal/parser` v0: goldmark con estensione wikilink minima + heading + tag; `internal/indexer` v0: tabella `files` + `headings` + `links` + `tags` in `index.db`, scansione all'apertura (serve a M1 e a verificare l'ingranaggio).
- `internal/platform`: parsing URL `memobrain://open?vault=&file=` e `memobrain://auth/callback`, registrazione scheme (Info.plist via `build/darwin`, NSIS script, `.desktop` Linux).
- `internal/telemetry`: zerolog su file rotante in dir dati app; crash report **opt-in** (consenso nelle impostazioni, invio rinviato a M7-WP4).
- Frontend testabile fuori dal webview: shim dei binding (`frontend/src/test/wails-mock/` che implementa `window.go.*` e `runtime` con fixture) per far girare l'app in Chromium con Playwright; i test sul webview reale restano manuali (checklist per OS).
- Frontend: `app/` (shell, tema chiaro/scuro con token CSS, provider), `workspace/` minimo (una tab), `sidebar/` file explorer (tree, apri nota), `editor/` CodeMirror 6 in **Source mode** (solo highlighting markdown base), `state/` Zustand store vault + TanStack Query sui binding, `i18n/` (it, en) con i18next, `settings/` pannello "Generale" (lingua, tema).

### M0-WP6 Auth desktop end-to-end

- `internal/auth`: `Login()` → PKCE (verifier/challenge S256, `state`), listener `127.0.0.1:0`, apertura browser di sistema, callback, scambio token, salvataggio refresh token nel keychain; `Refresh()` silenzioso con rotation; fallback `scheme` (D-08) quando listener fallisce o Keycloak risponde `invalid_redirect_uri` o config forza `scheme`; `Logout()`; stato `auth:state` (`signed_out|signing_in|ready|disconnected`).
- `internal/sync/transport` v0: client HTTP con bearer + retry/backoff + `X-Request-Id`; chiamata `GET /me` e `POST /me/devices` (registrazione dispositivo con nome host/piattaforma).
- UI: pulsante "Accedi al cloud" nelle impostazioni → profilo mostrato.

### M0-WP7 CI

- `.github/workflows/ci.yml`: job `go` (lint, test -race, govulncheck), `ts` (tsc, eslint, vitest), `conformance`, `cloud-integration` (testcontainers), `desktop-build` matrix (ubuntu-24.04 con `webkit2gtk-4.1` e `wails build -tags webkit2_41`, windows, macos); `cloud-image` (buildx, push solo su tag).
- Cache Go/Yarn; `task ci` locale equivalente.

**Criteri di uscita M0:** `task dev-cloud` avvia lo stack (compose) e `curl /api/v1/me` con token Keycloak risponde; l'app desktop apre una cartella come vault, mostra l'albero, apre/modifica/salva una nota in Source mode (scrittura atomica verificata con test), rileva modifiche esterne; login PKCE loopback funziona su macOS (e in CI build su 3 OS); SPIKE-01, -02, -03, -05 chiusi con ADR (SPIKE-04 apre M1); CI verde.

---

## 6. M1 — Core editing (P0) (esito: parità funzionale P0 offline)

> **Stato (2026-10-24):** WP1–WP9 implementati (ADR-0004). Verificati in CI locale: conformance Go/TS su 69 fixture, vitest, e2e Playwright su mock dei binding. Restano la checklist manuale su webview reale (`docs/qa/obsidian-parity.md`) e il benchmark di ricerca a 50k note (cache dei candidati).

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

- `internal/properties`: schema tipi in `.memobrain/types.json`, validazione/coercizione (`text,list,number,checkbox,date,datetime`), binding `PropertiesAPI` (`GetTypes`, `SetType`, `Update(file, key, value)` che riscrive il frontmatter preservando ordine/commenti).
- Frontend: editor Properties tipizzato in cima alla nota, vista Properties nel sidebar; vista Tags (gerarchica, conteggi); Outline; `statusbar/` word/char count (anche selezione).

### M1-WP8 Workspace, navigazione, comandi, impostazioni

- `workspace/`: tab, split orizzontale/verticale, linked panes, sidebar sx/dx, drag tab; persistenza `.memobrain/workspace.json` (non sync); modalità per pannello (source/live/reading) ricordata.
- `commands/`: registro comandi unico (id, titolo i18n, hotkey default, `when`), command palette, hotkey personalizzabili (`.memobrain/hotkeys.json`), quick switcher (fuzzy su nome/alias/heading con `fuse.js` o algoritmo custom), vault switcher.
- File explorer completo: crea nota/cartella, rinomina (usa `PlanRename`), sposta (drag), elimina (cestino di sistema via Wails/`.trash/` da impostazione), ordina, mostra allegati.
- `settings/`: pannelli Editor, File e link, Aspetto (tema, accento, font, zoom, larghezza), Hotkeys, Lingua; persistenza `.memobrain/{editor,appearance}.json` (per utente, sincronizzabili in M2) + `app.db` per preferenze app.
- URI `memobrain://open?vault=&file=` funzionante.

### M1-WP9 Qualità M1

- Playwright e2e in Chromium con lo shim dei binding (M0-WP5) per: apri vault, crea nota, wikilink + backlink, ricerca, rename con aggiornamento link, cambio modalità; checklist manuale equivalente sul webview reale per OS.
- Benchmark: apertura nota < 150 ms, indice iniziale 50k < 3 min (dataset sintetico), digitazione senza lag su 1 MB (test manuale documentato).

**Criteri di uscita M1:** tutte le righe P0 della matrice §2.2.1 tranne Sync/Excalidraw sono implementate; conformance Go/TS verde su ≥ 60 fixture; un vault Obsidian esistente di esempio si apre senza conversioni e i link si risolvono come in Obsidian (checklist manuale in `docs/qa/obsidian-parity.md`).

---

## 7. M2 — Sync (P0) (esito: multi-dispositivo affidabile, vault privati E2EE e condivisi)

> **Stato: implementata (2026-10-24)** — WP1–WP8 completati; criteri di uscita verificati (e2e a 2 dispositivi in entrambi i tipi di vault, load test p95, test vector Go+TS). Dettagli e deviazioni: [ADR-0009](adr/0009-sync-protocol-details.md).

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

- `internal/sync`: schema `sync.db` (§3.4.3: `sync_files`, `sync_cursor`, `outbox`, `conflicts`), `detect.go` (stato da watcher + riconciliazione, rename per hash o `file_id` da `RenameWithLinkUpdate`), `engine.go` (ciclo: pull → applica → push → risolvi; scheduler, pause/resume, backoff con jitter, `Retry-After`), `resolve.go` (usa `merge`, conflict copy `<nome> (conflitto <device> <data>).<ext>` con `conflict_of`, limite 5 tentativi → stato `conflict`), scope `.memobrain/` (§3.4.6), esclusioni, eco per `device_id`, bootstrap da `/tree` su `CURSOR_EXPIRED`, upload grandi via tus.
- Vault privati: cifratura blob/path prima dell'upload, decifratura dopo il download, `kind=opaque`, nessun `move_prefix`; hash plaintext in `sync.db` per evitare re-upload.
- Binding `SyncAPI` (§2.5) + eventi `sync:status`, `sync:conflict`, `vault:locked`.
- Test: simulatore di 2 client contro cloud in testcontainers (test e2e Go in `apps/desktop/internal/sync/e2e_test.go`, tag `integration`): modifica concorrente `.md` non sovrapposta → merge; sovrapposta → conflict copy; rename vs modifica; delete vs modify; vault privato round-trip.

### M2-WP7 Job e manutenzione cloud

- `internal/jobs` (role `worker`): GC blob (`ref_count=0` + grace 24 h), riconciliazione `used_bytes` notturna, purge vault eliminati > 30 gg, retention revisioni, compattazione changelog (finestra configurabile, aggiorna `compaction_seq`).
- `GET/PUT /admin/settings/storage` rinviato a M5; in M2 i valori arrivano da `settings` seed.

### M2-WP8 UI sync

- `sync/` frontend: wizard "Collega al cloud" (tipo vault privato/condiviso con testi espliciti, passphrase + robustezza, recovery key con conferma per ri-digitazione, primo upload con progresso/ripresa), sblocco vault bloccato (con passphrase o recovery key; in quest'ultimo caso passo obbligatorio "imposta nuova passphrase" e opzione "rigenera recovery key"), indicatore stato per vault, vista "Risoluzione conflitti" (diff affiancato, Tieni locale/remoto/Unisci/Entrambi), "Cronologia nota" (lista revisioni, diff — decifrato sul client per i privati — e ripristino), dispositivi (lista/revoca via `/me/devices`), impostazioni sync (intervallo, pausa).
- Sync delle impostazioni utente `.memobrain/*.json` con LWW per chiave.

**Criteri di uscita M2:** scenario a 2 dispositivi (2 istanze desktop con dir dati distinte) converge in entrambi i tipi di vault; nessuna perdita silenziosa (test); p95 `changes` < 200 ms e `commit` ≤ 50 op < 500 ms in load test locale (k6 base in `services/cloud/test/load/`); test vector cripto verdi in Go e TS.

---

## 8. M3 — Excalidraw + Canvas (esito: disegni nativi sincronizzati)

> **Stato (2026-10-24):** WP1–WP4 implementati ([ADR-0010](adr/0010-drawing-and-canvas-details.md)). Verificati in locale: unit test Go (`drawing`, `canvas`, indexer) e frontend, e2e Playwright su mock dei binding (apertura/modifica/salvataggio di un disegno senza richieste di rete, embed, canvas), e2e a due dispositivi per `.excalidraw` e `.canvas`. Resta la checklist manuale sul webview reale (`docs/qa/m3-drawings-canvas.md`).

### M3-WP1 Excalidraw (frontend `drawing/`)

- Wrapper `@excalidraw/excalidraw` con `React.lazy`, `EXCALIDRAW_ASSET_PATH` → asset copiati nel bundle (`vite` plugin di copia), tema app, i18n.
- Tab "Disegno": apertura `.excalidraw`, autosave debounce 2 s via `WriteNote` binario con `expectedHash`, read-only se permesso `viewer` (M4) o vault bloccato.
- Comandi: "Nuovo disegno" (palette, inserisce embed se invocato da una nota), "Inserisci disegno"; doppio clic su embed → editor (tab o overlay); export PNG 1x–3x con/senza sfondo, SVG, copia appunti; libreria `.memobrain/excalidraw-library.json`; modalità presentazione/zen.
- Soglia 10 MB per disegno con avviso.

### M3-WP2 Supporto backend disegni (`internal/drawing`)

- Validazione JSON Excalidraw; estrattore per l'indexer: testo elementi `text` (FTS) e `link` degli elementi verso `[[Nota]]` (archi grafo/backlink con etichetta "Disegno X").
- Anteprima SVG: generata dal frontend (`exportToSvg`) e salvata via binding in `.memobrain/cache/drawings/<hash>.svg`; invalidazione per hash; embed `![[x.excalidraw|600]]` in Live Preview/Reading usa la cache (fallback: render lazy).

### M3-WP3 Canvas (JSON Canvas)

- `internal/canvas`: parse/validate `.canvas` (nodi `text|file|link|group`, edges), estrattore indexer (testo, link a file).
- Frontend `canvas/`: editor su `<canvas>`/SVG con pan/zoom, creazione nodi (testo con mini editor CM6, nota come embed, media, link, gruppo), archi con etichette, selezione/drag/resize, colori preset, undo/redo, autosave; embed `![[mappa.canvas]]` in nota (render statico).

### M3-WP4 Sync per-id e CI offline

- Attivazione in `sync/resolve.go` delle strategie `jsonid` per `.excalidraw`/`.canvas` (stesso utente); test e2e di merge tra 2 dispositivi.
- Test Playwright (Chromium + shim binding) che intercetta le richieste di rete durante apertura di un disegno: **zero richieste esterne** (gate CI); verifica manuale sul webview per OS nella checklist M3.

**Criteri di uscita M3:** creare/embed/modificare/esportare un disegno offline; link da elemento a nota compare nei backlink; ricerca trova testo nel disegno; 2 dispositivi convergono su un disegno modificato in parti diverse.

---

## 9. M4 — Condivisione e gruppi (esito: collaborazione asincrona)

> **Stato (2026-10-24):** WP1–WP5 implementati ([ADR-0011](adr/0011-sharing-groups-config-details.md)). Verificati in locale: unit e integrazione del cloud (matrice ACL, scope, eventi, config profile), e2e desktop contro il cloud reale (due utenti: merge, conflict copy per autori diversi, viewer in sola lettura, revoca, manager) e sul mock (inviti, mount, sola lettura, chiavi `locked`), Web UI con unit test e Playwright. Resta la checklist manuale (`docs/qa/m4-sharing.md`); la finestra "nuova condivisione" della Web UI e le API admin (M5) non sono incluse.

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

- `web/`: Vite + React, `oidc-client-ts` PKCE (`memobrain-web`), guardie di ruolo, `packages/api-client`, `packages/ui` (design system: tokens, tabelle, form, barra quota).
- Route utente: Spazio utilizzato (`/me/usage`), I miei vault (tipo, dimensione, file, ultimo sync), Dispositivi, Condivisioni. Download ZIP rinviato a M5.
- `services/cloud/web-embed` con `go:embed` + fallback SPA; CSP rigida e SRI.

> **Stato (2026-10-24):** implementato ([docs/web-ui.md](web-ui.md)). Verificati: lint/typecheck/vitest (web, ui), e2e Playwright su API mockata, test Go di `web-embed`, build di produzione con SRI. Non verificato: login reale contro Keycloak e immagine Docker con la SPA (stack locale non avviabile in questa sessione).

**Criteri di uscita M4:** utente A condivide una cartella con un gruppo; B (membro) accetta, vede il mount, modifica (editor) e A riceve; `viewer` non può scrivere (server e UI); revoca → smontaggio; config profile con chiave `locked` bloccata nella UI del client; Web UI utente funzionante.

---

## 10. M5 — Console admin ed export (esito: governance completa)

> **Stato (2026-10-24):** WP1 e WP2 implementati lato cloud e desktop ([ADR-0012](adr/0012-admin-export-details.md)); verificati in locale: integrazione del cloud (admin, sospensione immediata, quota, profili con cronologia, audit, export diretto e a job), client Keycloak anche contro il Keycloak reale del dev stack (`KC_LIVE_URL`), comando desktop con test. WP3 e WP4 web: vedi sotto. Resta la checklist manuale (`docs/qa/m5-admin-export.md`).

### M5-WP1 API admin (cloud)

- `internal/keycloak`: client Admin REST (service account, token caching, rotazione segreto), `CreateUser` con required actions, `SetEnabled`, `LogoutUser` (revoca sessioni), `GetUserSessions`, `ResetPassword` action, `SetRealmRole`; test con testcontainers Keycloak.
- `internal/users` admin: `/admin/users` (lista paginata con filtri), CRUD, `:suspend`/`:activate` (Keycloak + `users.status`), `/role`, `/quota` (`null`=default, `-1`=illimitata), `:reset-password`, `/vaults` (solo metadati), `/config/effective`.
- `/admin/groups…` (membri, ruolo, config-profiles con priorità), `/admin/config-profiles…` (incrementa `version`, cronologia in tabella `config_profile_versions` — migrazione `0005_admin.sql`), `/admin/settings/storage`, `/admin/storage/overview`, `/admin/audit-log` (+ export CSV).
- Ogni mutazione → `audit_log`. Eventi `AccountChanged` (sospensione, quota).

### M5-WP2 Export ZIP (cloud)

- Migrazione `export_jobs`; `internal/exports`: `GET /vaults/{vid}/export.zip` streaming (`archive/zip` con `Store` per i blob, soglia 512 MB), `POST /vaults/{vid}/exports` → job (worker) che scrive ZIP su S3 e `download_url` presigned 24 h; `409 VAULT_ENCRYPTED` per i privati; esclusione `.memobrain/` device-specific; job `expired`.

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

> **Stato (2026-10-24):** WP1–WP6 implementati (ADR-0013…0019: grafo, Bases, daily/template/composer, bookmarks/workspaces/preview, importer, history, query/export). Verificati in locale: unit Go con `-race` e lint, Vitest (290 test), Playwright su mock; benchmark grafo e Bases in `docs/qa/m6-graph-benchmark.md` e ADR-0014. **Non verificato su webview reale** (hover, stampa PDF, selettori nativi, 30 fps del grafo in WKWebView/WebView2/WebKitGTK): checklist manuale in `docs/qa/obsidian-parity.md` (sezione M6) e `docs/qa/m6-search-export.md`. Lacune dichiarate: importer Keep HTML e Apple Notes (P2), "applica template a ogni nuova nota", `pre-sync-overwrite` della history non collegato alla sync.

### M6-WP1 Graph view

- `internal/graph`: nodi/archi dall'indice (note, fantasma, allegati opzionali, tag opzionali), filtri (query di ricerca, tag, cartelle, orfani), dati per timelapse (ctime).
- Frontend `graph/`: rendering WebGL (`pixi.js` o canvas 2D con fallback), layout force-directed in Web Worker (`d3-force`), grafo globale e locale (profondità), gruppi colore per query, forze regolabili, hover/click apre nota; obiettivo 10k nodi ≥ 30 fps.

### M6-WP2 Bases

- `internal/bases`: parser `.base` (YAML: viste, filtri, formule, ordinamento), motore di query sulle `properties` indicizzate, valutatore di formule (sottoinsieme: aritmetica, stringhe, date, `if`, funzioni su liste), binding `BasesAPI`.
- Frontend `bases/`: viste tabella (edit inline delle properties) e card, selettore vista, filtri UI, embed `![[x.base]]`.

### M6-WP3 Daily notes, unique notes, template, composer, bookmarks, workspaces

- `internal/templates`: variabili `{{date:FORMAT}}`, `{{time}}`, `{{title}}`, cartella template (anche mount di gruppo), daily notes (formato, cartella, template, "apri oggi", navigazione giorni), unique note creator (prefisso timestamp).
- `internal/composer`: unisci note (append + redirect link), estrai selezione in nuova nota (sostituisce con link).
- Bookmarks (`.memobrain/bookmarks.json`, gruppi, nota/heading/block/ricerca/grafo) con vista sidebar; Workspaces (layout salvati `.memobrain/workspaces.json`).
- Slash commands `/` nell'editor (riusa il registro comandi); Random note; Page preview (hover con render reading in popover).

### M6-WP4 Importer

- `internal/importer`: interfaccia `Importer{Detect, Preview, Run}` + report; sorgenti: cartella Markdown/HTML (con riscrittura link), Evernote ENEX, Notion (export zip), Roam (JSON), Bear, Google Keep (Takeout), CSV→note; Apple Notes rinviato a P2. UI wizard con anteprima e report.

### M6-WP5 History locale e recovery

- `internal/history`: snapshot in `.memobrain/snapshots/` ogni 5 min se modificato, retention 7 gg (configurabile), UI "File recovery" (lista, diff, ripristino); integrazione con cronologia cloud (M2) in un'unica vista.

### M6-WP6 Embedded search, export, varie

- Code block `query` renderizzato in Live Preview/Reading con risultati live; export PDF (stampa webview con stile reading) e HTML autonomo; impostazioni rimanenti (cestino, cartella allegati, daily notes).

**Criteri di uscita M6:** tutte le righe P1 della matrice §2.2.1 implementate; checklist parità aggiornata; benchmark grafo.

---

## 12. M7 — Hardening e rilascio 1.0

> **Stato (2026-10-27):** WP1–WP4 implementati e verificati in locale (ADR-0020…0023): benchmark e ottimizzazioni (indice 50k ≈ 73 s, ricerca con cache), documenti per audit crittografico e pen test, GDPR (`GET /me/export`, `DELETE /me`, purge), scansioni in CI, resilienza (fault injection, drain, prova di ripristino con PITR, chaos sul chart), updater firmato, installer, pipeline di release, chart completo, compose on-premise, accessibilità (axe), i18n, guide utente e admin, dashboard Grafana. **WP5 (release) non è completabile da qui**: firma e notarizzazione, audit e pen test esterni, test manuale cross-OS con screen reader, misure su webview e infrastruttura reali, rebrand e tag. Tutto ciò che resta è in `docs/release/v1.0.0-checklist.md`; il codice è la candidata `1.0.0-rc.1` (`CHANGELOG.md`).

### M7-WP1 Prestazioni

- Dataset sintetici (50k note, 10k nodi grafo) in CI nightly; benchmark avvio < 3 s, apertura nota < 150 ms, ricerca < 200 ms, indice 50k < 3 min; profiling Go/React; k6 su cloud (1.000 utenti attivi simulati: `changes`/`commit`).

### M7-WP2 Sicurezza e privacy

- Pacchetto per audit esterno del design cripto (`docs/security/crypto-design.md`, test vector, threat model §3.8.1); preparazione pen test (`docs/security/pentest-scope.md`); CSP/SRI verificati; `govulncheck`, `yarn npm audit`, SBOM (syft) in CI; GDPR: `GET /me/export` (dati account) e cancellazione account con purge (`DELETE /me` con conferma, job purge) — endpoint non in §3.5, ADR + proposta spec; retention documentata.

### M7-WP2b Resilienza (Appendice A: disponibilità e affidabilità dati)

- Fault injection: kill del cloud a metà `commit` (nessuna revisione parziale, client riprova con idempotenza), crash del client durante `WriteAtomic` (nessun file parziale), interruzione upload tus e ripresa, perdita di rete durante pull (cursor non avanza), restart PG/MinIO (readiness, backoff).
- Chaos test base sul chart Helm (pod kill, restart rolling) con misura dell'SLO 99,9 % su finestra di test; runbook backup/PITR PG e versioning bucket provati con un restore reale e documentati (`docs/runbook/backup-restore.md`).

### M7-WP3 Distribuzione e aggiornamenti

- `internal/updater`: canale di update firmato (manifest JSON firmato ed25519, verifica firma, download, applicazione per OS), UI "Aggiornamento disponibile".
- Installer: NSIS (Windows, firma Authenticode), `.dmg` notarizzato (macOS), AppImage + `.deb` (Linux, `.desktop` con `x-scheme-handler/memobrain`); pipeline release con tag semver; immagini OCI firmate (cosign) + Helm chart completo (HPA, PDB, secret, ingress gRPC/HTTP2) e `compose` per on-premise.

### M7-WP4 Accessibilità, i18n, documentazione

- Audit WCAG 2.1 AA Web UI (axe in Playwright), navigazione tastiera/screen reader del client; revisione traduzioni it/en.
- Docs: guida utente, guida amministratore (installazione, Keycloak, backup/PITR, runbook incidenti, osservabilità con dashboard Grafana), `docs/adr/` completo, rebrand del nome (eseguito: MemoBrain Notes).

### M7-WP5 Release

- Release candidate, test manuale cross-OS da checklist, fix, tag `v1.0.0`.

**Post-1.0 (P2, fuori piano):** Audio recorder, Web viewer, Vim mode, CLI, finestre pop-out (processo secondario + IPC), rotazione VMK, Apple Notes importer, format converter. Slides è stato anticipato in M8 (ADR-0027).

---

## 13. M8 — Revisione UI shell desktop (esito: shell conforme al mockup 28/10/2026)

> **Stato (2026-10-29):** WP0–WP10 implementati e verificati in locale (`task test`, lint Go e TS, e2e su mock Wails, build, conformance Go e TS): milestone chiusa lato codice. Restano le verifiche manuali su webview e cloud reali di `docs/qa/m8-shell-ui.md` e l'aggiornamento dello spec da parte dell'owner (ADR-0026 e ADR-0027 in stato _proposta_). In WP2 la tab bar resta per pane (sotto l'header) e non nell'header, perché con gli split ogni pane ha le proprie tab. La tab «Segnalibri» del mockup si chiama _Link_ (link in uscita, backlink e bookmark del vault); _Statistiche_ è completa (WP7) e _Slide_ è completa (WP8). Gli indicatori di stato (permessi, aggiornamenti, sync, inviti, indicizzazione) stanno nel footer della sidebar destra e, a sidebar chiusa, nell'header. `note:export-image` non è verificato su una webview reale (WKWebView può marcare come «tainted» il canvas con `foreignObject`): voce da aggiungere a `docs/qa/m8-shell-ui.md`. Pianificata il 2026-10-28. ADR-0026 (shell) e ADR-0027 (Slides) in stato _proposta_: entrambi deviano dallo spec (`statusbar`, `sidebar/`, Slides da P2 a P1) e attendono l'aggiornamento di `Specifications.md` da parte dell'owner. Piano di dettaglio: `.claude/roadmap/progetta-e-pianifica-la-staged-dragon.md`. Solo frontend desktop, più un binding Go per le statistiche (WP7).

Ordine: WP0 → WP1 → (WP2 ∥ WP3 ∥ WP4) → WP5 → (WP6 ∥ WP7) → WP8 → WP9 → WP10.

### M8-WP0 ADR e documenti

- ADR-0026 e ADR-0027; indice ADR; questa sezione di roadmap. `Specifications.md` non si modifica: le modifiche si propongono all'owner.

### M8-WP1 Scomposizione della shell

- Estrazione da `app/App.tsx` in `src/shell/` di `Header`, `LeftSidebar`, `RightSidebar`, `SidebarTabs`, `SidebarResizer`, `StatusBar` e `useVaultSession`, senza cambi funzionali né di DOM/CSS; `App.test.tsx`, `a11y.spec.ts` e `keyboard.spec.ts` restano verdi.

### M8-WP2 Header e tema

- Pulsanti sidebar sinistra/destra e ricerca; tab bar nell'header; switch chiaro/scuro (`theme:toggle`); set di icone SVG locali al posto dei glifi unicode.

### M8-WP3 Ribbon comandi rapidi

- Barra verticale: nuova cartella, nota, lavagna, disegno, base, separatore, esporta PDF, esporta immagine; nuovi comandi `folder:new`, `separator:insert`, `note:export-image`.

### M8-WP4 Sidebar sinistra

- Tab _File_ e _Struttura_; mappatura retrocompatibile dei valori legacy in `workspace.json`.

### M8-WP5 Sidebar destra e footer di sync

- Tab _Proprietà_, _Tag_, _Segnalibri_ (link, backlink, bookmark), _ShowSlide_, _Statistiche_; `SyncFooter` con stato di sync, permessi, aggiornamenti e inviti; eliminazione della status bar.

### M8-WP6 Tab: blocco e menu contestuale

- `Tab.pinned` (opzionale) in `workspace/layout.ts` con `parseNode` retrocompatibile. Una tab bloccata non si chiude con nessuna azione dell'utente (✕, click centrale, `Delete`, `tab:close`, chiusure di massa) e non viene sostituita dalla navigazione (la nota si apre in una tab nuova); si chiude solo se il suo file viene eliminato (`closeTab(…, { force: true })` in `removePath`). Le chiusure di massa operano sul pane della tab e non hanno conferma: il blocco è la protezione.
- Menu contestuale: Blocca/Sblocca, Chiudi, Chiudi a destra, Chiudi a sinistra, Chiudi altre, Chiudi tutte (disabilitate se non chiuderebbero nulla), più le voci già presenti; comandi `tab:pin`, `tab:close-right|left|others|all`.

### M8-WP7 Pannello Statistiche

- Il pannello compone dati già esposti dai binding esistenti, quindi **non serve un nuovo binding Go** (scostamento dal piano iniziale): dimensione e ultima modifica dalla lista file; versioni locali (`HistoryAPI.List`) e cloud (`SyncAPI.History`); autore dell'ultima revisione cloud (nome da `Mine` o dai destinatari della condivisione); destinatari (`SharingAPI.VaultShares`, filtrati per le condivisioni che coprono la nota), oppure «condiviso da» su un mount e «vault privato» su un vault E2EE; parole, caratteri e titoli dal testo (frontmatter escluso), più cursore e selezione dell'editor. Calcoli puri in `sidebar/noteStats.ts`.
- Data di creazione: come per il grafo (ADR-0013), proprietà `created` del frontmatter, altrimenti la prima revisione cloud, altrimenti l'ultima modifica (segnalata con «≈»): il file system non dà un tempo di creazione portabile e una copia sincronizzata mostrerebbe la data del download.
- Sostituisce la vecchia riga di stato dell'editor: le chiavi `status.words|chars` sono state rimosse.

### M8-WP8 ShowSlide

- Parser delle slide in TS (`packages/markdown/src/slides.ts`) e in Go (`apps/desktop/internal/parser/slides.go`, oggi senza consumatori a runtime) verificati con le stesse fixture `shared/conformance/slides/` (12 casi: separatori, setext, code fence, math, note, configurazione, slide vuote). Separatore: `---` dopo una riga vuota; note: righe dopo `Note:`; configurazione in chiavi piatte `slide-transition|theme|progress|numbers|notes` (ADR-0027 aggiornato).
- Tab _Slide_: opzioni scritte nel frontmatter con lo stesso percorso delle Proprietà (disabilitate su vault di sola lettura), pulsanti «Avvia» e «Dalla slide corrente», miniature cliccabili. Presentazione nella stessa finestra (overlay, `requestFullscreen` dove la webview lo permette): tastiera, transizioni (rispettano `prefers-reduced-motion`), barra di avanzamento e numeri, vista presentatore con slide successiva, note e timer; comandi `slides:start` e `slides:start-here`. Le slide usano la pipeline dell'export (immagini e diagrammi inclusi, nessuna richiesta di rete: verificato in e2e).
- Da verificare su webview reale (checklist `docs/qa/m8-shell-ui.md`): schermo intero in WKWebView/WebView2/WebKitGTK.

### M8-WP9 Footer sinistro e chat

- **Selettore vault** in fondo alla sidebar sinistra: nome, numero di note, tipo (privato/condiviso, D-02) e menu con i vault recenti, «Apri un'altra cartella…» e «Chiudi vault»; comando `vault:switch` (apre la sidebar e il menu). Il cambio (`openVaultAt` in `app/actions.ts`) scrive subito note in sospeso e `workspace.json` del vault che lascia, apre il nuovo, chiude il precedente e azzera lo store solo dopo; riaprire il vault già aperto non fa nulla.
- **Impostazioni e account** in fondo al ribbon (visibili anche a sidebar chiusa; senza vault restano nell'header): avatar con le iniziali e menu (account e dispositivi, esci) a sessione attiva, pulsante «Accedi» altrimenti (usa il server già noto o quello predefinito, altrimenti apre le impostazioni cloud; l'OIDC resta nel browser di sistema, D-08), stati «in attesa del browser» e «disconnesso» con «Riconnetti».
- **Slot chat ACP** sotto l'editor: campo disabilitato con spiegazione, mostrato solo con la feature `chat` attiva nel Config Profile; la feature è **spenta per default** (`features.Defaults` in Go, `ProductDefaults` e schema del cloud). Nessun codice di protocollo: l'integrazione ACP richiede un ADR dedicato.

### M8-WP10 Chiusura qualità

- i18n it/en (la parità delle chiavi è un test bloccante), accessibilità: le scansioni axe coprono shell, schede a icona, menu della scheda bloccata e del vault, tab Slide e presentazione (hanno fatto emergere e correggere tre difetti: albero dei segnalibri vuoto, puntina della scheda bloccata dentro la `tablist`, collisione di classi con la slideshow dei disegni).
- Guida utente: «Il primo vault» riscritto sulla nuova shell, nuovo capitolo «Presentazioni», scorciatoie, accessibilità, condivisione e sincronizzazione senza più la barra di stato; checklist manuale `docs/qa/m8-shell-ui.md` (export come immagine e schermo intero su webview reali, login OIDC, cloud).

**Criteri di uscita M8:** layout conforme al mockup; comandi del ribbon operativi e presenti in palette; tab bloccabili con menu completo; cambio vault e login/avatar funzionanti; Statistiche e ShowSlide offline; chat visibile ma disabilitata; `task ci` e `task e2e` verdi.

---

## 13-bis. M9 — Workbench del vault nella Web UI (esito: parità web/desktop)

> **Stato (2026-10-29):** pianificata. ADR-0029 (workbench web, deviazione da A-03) e ADR-0030 (core Go in WASM) in stato _proposta_: in attesa dello spike WP1 e dell'aggiornamento di `Specifications.md` da parte dell'owner. Piano di dettaglio: `.claude/roadmap/progetta-e-pianifica-gli-glistening-kahan.md`.

Decisioni dell'owner:

- la logica del desktop gira nel browser come **core Go compilato in WASM** in un Web Worker, con SQLite-wasm e OPFS;
- i vault privati E2EE sono modificabili anche dal web;
- il web è **online-first con cache locale**, senza PWA.

Il browser registra un dispositivo `web` e usa il protocollo di sync esistente: il server resta cieco al contenuto.

Ordine: WP0 → WP1 (gate go/no-go) → WP2 → WP3 → WP4 → WP5 → WP6 → WP7. WP0 e WP1 possono procedere in parallelo con M10.

### M9-WP0 ADR e documenti

- ADR-0029 e ADR-0030; questa sezione; budget separato del chunk workbench (revisione di ADR-0020); testo proposto per lo spec (A-03, §0.1, §2.8, §4.4, §3.8.1, tabella rischi), che l'owner riporta in `Specifications.md`.

### M9-WP1 Spike core WASM (time-boxed)

- `GOOS=js` build di `cmd/memobrain-core` con `indexer`, `search`, `links`, `bases`, `sync` e `shared/go`.
- Driver `database/sql` su `@sqlite.org/sqlite-wasm` (`opfs-sahpool`, FTS5 `trigram`, migrazioni goose) e VFS OPFS.
- Misure riportate in ADR-0030: dimensione, avvio, indicizzazione 5k note, latenza ricerca, memoria.
- Se un modulo non rientra negli obiettivi, fallback mirato per quel modulo.

> **Stato (2026-10-29):** spike eseguito **in parte**, con via libera provvisorio (esito in ADR-0030, comandi in `docs/perf/wasm-spike.md`). Verificato: il core compila per `js/wasm` (solo `modernc.org/sqlite` e `updater` bloccano), 6,4 MB con brotli, SQLite-wasm applica le migrazioni reali con FTS5 `trigram` (5k note in 1,7 s, ricerca p95 4,4 ms), il parser Go è 4,5× più lento del nativo. **Non verificato**: driver `database/sql` su sqlite-wasm, VFS OPFS, indicizzazione end-to-end, memoria del core, confronto con il desktop nativo. Questi punti restano in WP2/WP3 e possono ancora cambiare il go/no-go.

### M9-WP2 Portabilità del core Go

> **Stato (2026-10-29):** implementato e provato in Node (ADR-0030, "Esito dell'implementazione"). Tutti i 27 pacchetti di `apps/desktop/internal/...` passano sotto `GOOS=js GOARCH=wasm` (`task test-wasm`, scritto solo in WP3: vedi lì) e il desktop nativo resta verde (`go test ./...`, `golangci-lint`). **Deviazione dal piano:** niente interfaccia `vfs` in Go. Su `js` il pacchetto `os` passa da `globalThis.fs`, che la pagina fornirà sopra OPFS (WP5): evita di migrare circa 60 chiamate in otto pacchetti. **Non verificato:** OPFS e `opfs-sahpool` in un browser vero, lo stream SSE nel browser, `cmd/memobrain-core` (WP3).

- Driver SQL scelto con build tag in `internal/store`; nuovo `internal/sqlitejs` (driver `database/sql` sincrono verso `globalThis.__memobrainSQLite`) e `packages/sqlite-bridge`; `store.Exists`/`Reset` perché i database non stanno nel file system.
- Interfaccia `Host` in `internal/app` (`host_wails.go` / `host_web.go`); nessun binding importa Wails; `isWeb` spegne updater, cestino di sistema e watcher.
- Cambi di file senza fsnotify: `vault.FS.SetOnChange` → `watcher.Notify`.
- Sessione ospitata in `auth` (`Hosted`: token dalla pagina, niente keychain), chiavi dei vault privati in memoria, SSE come canale di notifica (nessun endpoint gRPC annunciato).
- `SettingsAPI.Info` espone `platform`. Bug trovati dai test su WASM e corretti: `sync.ReadMount`, colonne `TIMESTAMP`, `updater` per `js`.
- Resta per WP5: blocco per inattività della VMK, shim `fs` su OPFS, lettura dello stream SSE nel browser.
- Il desktop resta verde a ogni passo.

### M9-WP3 Host RPC WASM

> **Stato (2026-10-29):** implementato e provato (ADR-0030, "Esito dell'implementazione (M9-WP3)"). `internal/rpc` (dispatcher con la semantica di Wails), `App.Services()` come elenco unico dei servizi (usato anche da `main.go`), `cmd/memobrain-core` con `globalThis.__memobrainCore`, `task wasm-core` (**6,44 MB con brotli**) e `task test-wasm`. La parità con `wailsjs/go/app/*.d.ts` è verificata: 20 servizi, 122 metodi, nessuna eccezione (le funzioni non applicabili al web restano esposte e rispondono con un errore o con lo stato «disattivato»; le nasconde la UI in WP4). **Non verificato:** caricamento in un Web Worker vero. **Correzione:** il target `task test-wasm`, dato per esistente alla chiusura del WP2, è stato scritto solo ora.

- `cmd/memobrain-core`: stessi struct dei binding Wails, dispatcher JSON via reflection con la semantica di Wails; gli eventi escono dall'`Emit` dell'host (`__memobrainHost.emit`), che la pagina inoltra con `postMessage`.
- Test che ogni metodo di `wailsjs/go/app/*.d.ts` sia esposto (si salta se i binding non sono generati).

### M9-WP4 Frontend condiviso `packages/workbench`

> **Stato (2026-10-29):** implementato e verificato (ADR-0029, ADR-0030). Verificati: typecheck dei due pacchetti, 562 test unitari del workbench (554 prima dello spostamento + 8 nuovi), build di produzione (iniziale 1962 kB su 2000 di budget), e2e Playwright del desktop (104 passati, 3 saltati) e della build minificata (42), `wails generate module` (binding identici, ora in `packages/workbench/wailsjs`) e `task build-desktop`. **Non verificato:** il workbench in un browser vero (WP5) e in modalità `web` dentro Playwright (WP7): la modalità `web` è coperta solo da test unitari.

- `apps/desktop/frontend/src` è ora `packages/workbench/src` (`@memobrain/workbench`, spostato con `git mv`: cronologia conservata); `wailsjsdir` punta a `packages/workbench`. `apps/desktop/frontend` ha solo `src/main.tsx` (chiama `mountWorkbench`), `index.html`, lo script di build e gli e2e.
- `mountWorkbench(root, { kind, onBackToConsole })`: l'host dice di che tipo è. `kind` (`desktop` per default, `web`) imposta le capability.
- **Build condivisa:** `@memobrain/workbench/build` (`packages/workbench/build/esbuild.mjs`) esporta plugin, loader, alias e la copia degli asset di Excalidraw; il frontend desktop ci aggiunge entry, HTML, dev server e budget. In WP5 lo userà anche la Web UI.
- **Tipi:** `workbench` e `desktop-frontend` si controllano ciascuno con il proprio `tsc -b`; il desktop vede solo la firma pubblica del workbench (`src/workbench.d.ts`) e non ricompila i sorgenti.
- **Capability** (`platform/`): `localFolders`, `updater`, `diskEncryptionCheck`, `nativeWindow`. Sul web: niente "Apri cartella" (schermata iniziale, menu del vault), niente sorgenti d'importazione che richiedono una cartella, niente aggiornamenti (dialogo, indicatore, impostazioni, comando), niente avviso sul disco; i link esterni si aprono in una nuova scheda con `noopener`; lo schermo intero usa solo la Fullscreen API; "Torna alla console" compare nell'intestazione e nella schermata iniziale se l'host lo fornisce.
- **Scostamento dal piano:** i dialoghi nativi (salvataggio, stampa, scelta di un file) **non** hanno una sostituzione nel frontend. Passano dai binding Go, e l'`Host` web (WP2) li trasforma in download, `window.print()` e selettore di file: la UI non cambia. Resta aperta la scelta di una cartella per l'importer (`localFolders` falso: sorgenti a cartella nascoste); si potrà riattivare con `showDirectoryPicker` in WP5.

### M9-WP5 Integrazione in `web/`

> **Stato (2026-10-29):** implementato e verificato in un Chromium vero (ADR-0029/0030, `docs/web-ui.md`). Verificati: lo shim `fs` su OPFS (9 test in un worker vero), il workbench con il **core WASM reale** (10 test: scrittura, ricerca FTS5 su SQLite `opfs-sahpool`, backlink, rinomina con riscrittura dei link, storia locale, download dello ZIP, grafo, persistenza al reload, blocco + cancellazione della copia, una scheda sola), la build minificata servita dall'handler Go di produzione con la sua CSP (nessuna violazione, nessuna richiesta esterna, WASM in gzip), 16 test unitari di bridge e inattività, test Go di `web-embed`, e un'immagine Docker completa (114 MB). Budget: console 611/1000 kB, workbench 2416/2500 kB iniziale e 12774/23000 kB totale, core 7841 kB gzip (limite 8192). **Non verificato:** il flusso con un cloud vero (login OIDC, `LinkExisting`, sync web ↔ desktop, vault privato con passphrase), l'apertura di un mount (`?share=`), e Safari/Firefox (solo Chromium).

**Deviazioni dal piano** (da confermare):

- Il workbench è una **pagina a sé** (`workbench.html`), non una route lazy della SPA: l'esbuild non separa il CSS dei chunk dinamici e lo stile globale della UI desktop avrebbe toccato la console. Il server la serve per `/vaults/:id/open` con una CSP dedicata.
- Il blocco è **uno per browser**, non uno per vault: gli handle sincroni di OPFS e il pool di SQLite sono esclusivi per tutta l'origine.
- Il budget WASM si misura in **gzip** (7,8 MB), non in brotli (6,4 MB): niente nuove dipendenze Go per il serving; il file `.wasm.gz` si serve com'è o si decomprime con la libreria standard.
- Il worker non ha `tokens.ts`: il token passa dal protocollo dell'host (`bridge.ts`).
- Cancellazione della copia in chiaro: **fatta** per blocco e inattività; **non fatta** per il logout e per un "Dimentica questo browser" (resta in WP7).
- Il blocco per inattività è fisso a 15 minuti: non legge ancora il Config Profile.

- Pagina `workbench.html` e `web/src/workbench/{main.tsx,launch.ts,bridge.ts,worker.ts,opfs-fs.ts,idle.ts}`; "Apri" nella tabella dei vault e nelle condivisioni accettate.
- esbuild: due pagine, worker a sé, `core/*.wasm.gz` con hash e SRI verificata dal worker, budget separati; `task wasm-core`, `task web-build` (core e binding generati se mancano).
- `web-embed`: route, CSP del workbench, servizio dei `.wasm` da `.wasm.gz`; `webembed-serve -dir` per provare una build E2E.
- Dockerfile con gli stage `bindings` e `wasm`; CI con binding, core e job `wasm-core`.

### M9-WP6 Cloud

> **Stato (2026-10-29):** implementato. **Scostamento:** il flag si chiama `web_workbench` (non `web.workbench.enabled`): le feature del Config Profile sono booleani piatti con underscore (`features.*`), le chiavi con il punto sono le impostazioni. Il valore predefinito è _acceso_. Verificati: test di integrazione con PostgreSQL vero (un dispositivo `web` si registra e si revoca; l'enum OpenAPI e la colonna lo ammettevano già, nessuna migrazione), test dello schema (le due copie identiche, il flag accettato e il tipo errato rifiutato), test Go di `features` (acceso di default, spegnibile), 2 test web (il pulsante «Apri» c'è e sparisce con il flag spento). **Non verificato:** il rifiuto dell'indirizzo digitato a mano con il flag spento, che richiede un cloud vero (il lancio lo chiede al core con `ConfigAPI.Effective` e mostra «disattivato dall'amministratore»), e l'effetto per gruppo in un'istanza reale.

- Dispositivi con `platform: "web"`: già previsti dal contratto; coperti da un test di integrazione.
- Feature `web_workbench` nel Config Profile: `api/config-profile.schema.json` e la sua copia nel cloud (test di parità), `features.Known`/`Defaults` del desktop (che la ignora), console web (`useWorkbenchAllowed`, nasconde «Apri» in Vault e nelle condivisioni) e lancio del workbench (rifiuta anche l'indirizzo digitato).
- Nessuna nuova API di contenuto.

### M9-WP7 Parità e qualità

> **Stato (2026-10-29):** implementato; **i criteri di uscita di M9 sono soddisfatti solo in parte** (vedi sotto). Dettaglio e matrice in [web-workbench-parity.md](web-workbench-parity.md) (tabelle generate da `scripts/parity.mjs`, verificate da `task parity` in `task ci`, ADR-0036).
>
> Verificato: 14 spec dei flussi utente del desktop (`workflows`, `keyboard`, `editor-toolbar`, `slides`, `graph`) eseguiti **sul workbench web contro il core vero** (`e2e:workbench-ui`, `E2E_TARGET=web`, lo stesso `apps/desktop/frontend/e2e/support.ts`); e2e contro un **cloud vero** (Keycloak, PostgreSQL, S3: `e2e:cloud`): login, dispositivo `web`, una nota passa da un browser all'altro e due modifiche concorrenti alla stessa nota `.md` si fondono sul client; «Dimentica questo browser» e logout cancellano le copie e i database (`forgetThisBrowser`, 1 test); un test di regressione dello shim; 81 test e2e web e 14 workbench-ui stabili su più esecuzioni, 104 e2e desktop invariati; sicurezza (build minificata, CSP di produzione).
>
> **Bug veri trovati dalla parità:** (1) due `open` concorrenti dello stesso file sullo shim OPFS davano EBUSY e il tab restava vuoto (corretto: acquisizione serializzata); (2) il nome del vault mostrava l'id del cloud (ora il core usa il nome del cloud, `sync.ReadVaultName`).
>
> **Non verificato** (resta in elenco, nessuno è nascosto): desktop nativo ↔ web contro lo stesso cloud (provato web ↔ web: stesso core); copie di conflitto `.canvas`/`.excalidraw` dal browser; vault privato nel browser (sblocco, sync cifrata); mount `?share=`; flag `web_workbench` spento con un cloud vero; spec di disegno, canvas, condivisione, accessibilità (axe) e prestazioni sul web (usano dati del mock); Safari e Firefox; indicizzazione di vault grandi.

- Matrice di parità `docs/web-workbench-parity.md`: eccezioni dichiarate, cosa è verificato e cosa no, e tabelle generate di 72 comandi (71 sul web) e 122 binding (13 chiamati da un test web contro il core vero: gli altri sono provati solo sotto WASM dai test del core).
- Spec del desktop eseguiti anche sul web con un helper comune (`openVault` apre un vault sul mock o su una cartella del browser).
- E2E web ↔ cloud vero in `web/e2e-cloud` (richiede `scripts/run-desktop-with-cloud.sh --cloud-only --keep` dopo `task web-build`; suite lenta, non è in `task ci`).
- Test Go del core sotto `GOOS=js` (`task test-wasm`), con `scripts/parity.mjs --check`; il job CI `wasm-core` è stato rimosso con `ci.yml` e oggi entrambi girano in `task ci` (ADR-0036).
- Sicurezza: blocco e cancellazione (`lockAndForget`), «Dimentica questo browser» e logout (`forgetThisBrowser`), CSP e SRI (`web/e2e-security`).

**Criteri di uscita M9:**

- un vault condiviso e uno privato si aprono, si modificano e si sincronizzano dal browser con tutte le funzioni della matrice di parità;
- le modifiche web ↔ desktop si propagano in entrambi i sensi;
- `task ci` verde, con desktop invariato.

---

## 13-ter. M10 — Pipeline di rilascio (esito: installer e immagini pubblicati da `release.yml`)

> **Stato (2026-10-29):** WP1-WP3 implementati (ADR-0031); **WP4 solo in parte**: un dry run su GitHub (`0.0.0-dryrun.3`) costruisce gli installer macOS, Windows amd64 e arm64 e Linux amd64 e ha trovato tre difetti, corretti. **Non verificati**: immagine Docker (la build locale è caduta per la rete, il dry run non la include), gate CI nel release, Linux arm64, firme, GHCR, tag RC e avvio degli installer: i criteri di uscita **non sono soddisfatti**. Mancano i certificati di firma: il canale non firmato è attivo, e la firma si accende quando arrivano i segreti. Dettaglio di cosa è verificato e no in ADR-0031.
>
> **Aggiornamento (2026-11-01):** i workflow sono stati ridotti a uno solo. Dalla 1.2.2 `release.yml` parte da un tag, pubblica immagine multi-arch e chart Helm su GHCR, costruisce gli installer e crea la GitHub Release con `SHA256SUMS`, **senza firme, cosign, SBOM né attestazioni** e senza eseguire controlli; `ci.yml` e `security.yml` sono stati rimossi. Dalla 1.2.3 la matrice desktop è macOS universale (`macos-15`), Windows amd64 e Linux amd64: Windows arm64 è stato tolto, Linux arm64 non è mai entrato. Le verifiche si fanno in locale con `task ci` (ADR-0036). I tag dalla 1.1.0 alla 1.2.4 sono stati creati con questa pipeline (voci in `CHANGELOG.md`); l'esito delle singole run non è registrato qui. I criteri di uscita sotto che parlano di firme e di verifiche sulla push restano non soddisfatti per scelta: firma e verifiche automatiche sono da riattivare (`docs/release/secrets.md`).

### M10-WP1 Correzioni bloccanti

- `services/cloud/Dockerfile`:
  - niente `COPY .yarn`, che è ignorato da git;
  - cross-compilazione da `$BUILDPLATFORM` invece di QEMU;
  - stage `wasm` per M9.
- Wails CLI installata con `scripts/install-wails.sh` in `ci.yml` e `release.yml` (incompatibilità con Go 1.27); oggi resta solo `release.yml`.
- `task build-desktop` con `-tags webkit2_41` su Linux; target `docker-build` e `docker-push`.

### M10-WP2 Canale non firmato

- Variabile `REQUIRE_SIGNING`, default `false`. Senza segreti, prerelease "unsigned" con avviso nel job summary e nelle note.
- Senza le chiavi del manifest: `updater.DisabledByBuild=1` e nessun manifest pubblicato.
- Con il certificato Authenticode si firma anche `memobrain.exe`.
- Aggiornamento di `docs/release/secrets.md` e `docs/release/README.md`.

### M10-WP3 Matrice e pubblicazione

- Desktop: macOS universal, Windows amd64 e arm64, Linux amd64 e arm64 (`.deb` + AppImage). Dalla 1.2.3: macOS universale, Windows amd64, Linux amd64.
- Immagini GHCR: semver dai tag (`X.Y.Z`, più `X.Y` sulle stabili); cosign, SBOM e provenance tolti nella 1.2.2 (il canale `edge` da `main` era già stato tolto nella semplificazione dei workflow).
- `ci.yml` riusabile (`workflow_call`) come gate dei workflow di rilascio (rimosso nella 1.2.2: il gate è `task ci` in locale, ADR-0036).
- Una sola GitHub Release per tag, in bozza salvo `RELEASE_AUTO_PUBLISH=true`.
- Placeholder: `ghcr.io/ORG` → `ghcr.io/e2br`; `memobrain.example` → variabili `HOMEPAGE_URL` e `UPDATE_BASE_URL`.

### M10-WP4 Verifica reale

- `actionlint` sui workflow.
- Build multi-arch dell'immagine da un clone pulito.
- Dry run `workflow_dispatch` su GitHub (serve un `gh` autenticato).
- Tag `v1.1.0-rc.1`, poi verifiche: installer avviati sui cinque target; `docker run … --version`; `deploy/compose` con `/api/v1/readyz`.
- Package GHCR reso pubblico.
- Aggiornamento di ADR-0023 ("Verificato e non").

**Criteri di uscita M10:**

- un tag produce in automatico installer per i cinque target e un'immagine multi-arch firmata su GHCR;
- una push su `main` verifica, costruisce il desktop su tre sistemi e l'immagine (senza pubblicarla) — superato da ADR-0036: nessuna CI sulla push;
- tutto è verificato su una run reale.

---

## 13-quater. Prossimi passi (post-M10): M11 — Affidabilità e parità

L'analisi del 2026-11-01 (code review a più revisori su `main@70d8c0d`, con verifica avversariale dei rilievi alti e medi) ha prodotto un piano a onde. Lo si registra qui come **M11**; le decisioni sono negli ADR 0036–0044, accettati il 2026-11-02 e recepiti in `Specifications.md` v1.2. Ogni onda si chiude con le verifiche (`task ci` e le suite lente dell'area) e un check-in con il proprietario. Stato al 2026-11-01:

| Onda                               | Contenuto                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Stato                                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| W0 — rete di sicurezza             | ADR-0036; `task ci` ermetico e completo (typecheck, `test-wasm`, `parity`, `check-gen`, binding obbligatori, tag `webkit2_41`); `parity.mjs --check` severo                                                                                                                                                                                                                                                                                                                                                                                       | fatta; per scelta del proprietario nessun `ci.yml`                                                                                          |
| W1 — integrità dei dati nel cloud  | retention con copie di conflitto e `compaction_seq` (ADR-0038, migrazione 0007), paginazione keyset, validatore senza body binari, lock dei job su un pool dedicato, default di `TRUSTED_PROXIES`, riconciliazione sotto lock                                                                                                                                                                                                                                                                                                                     | fatta; la quota sugli upload dei blob e il `PATCH` tus senza transazione aperta sono stati chiusi in W8                                     |
| W2 — integrità dei dati nel client | candidati al merge persistenti e quarantena (ADR-0039), pull fermo su vault bloccato, lock per path in `vault.FS`, «Sovrascrivi» nei conflitti, flush delle modifiche in sospeso al teardown, merge del frontmatter, copia di conflitto prima della sovrascrittura                                                                                                                                                                                                                                                                                | fatta                                                                                                                                       |
| W3 — sicurezza e host del web      | core come unico timer di blocco, cancellazione della copia su `vault:locked` con marcatori e overlay, sweep all'avvio, `CoreDeadError` e limiti di tempo nel bridge, rinnovo del token, `persist()`                                                                                                                                                                                                                                                                                                                                               | fatta; identità stabile del dispositivo web e capability estese chiuse in W8                                                                |
| W4 — prestazioni e osservabilità   | metriche e probe del worker, cache e dettagli di `/readyz`, migrazioni sotto advisory lock, ETag e gzip della Web UI, `sizeLimit` dello spool; desktop: chiavi dei link, risoluzione incrementale, candidati alla rinomina, ultimo scan persistito, eventi tipizzati                                                                                                                                                                                                                                                                              | fatta; strategia del watcher per vault grandi chiusa in W8 (FSEvents, ADR-0044); baseline `task perf` in [perf/README.md](perf/README.md)   |
| W5 — architettura di parità        | registro delle funzioni e nuovo `parity.mjs`, `Command.requires`, client Go generato e contract test, `@memobrain/cloud-features` con `CloudPort`, ciclo di vita dei vault su console e desktop (ADR-0037)                                                                                                                                                                                                                                                                                                                                        | fatta (fasi A e B); migrazione di dispositivi, utilizzo e condivisioni, feature flag generati dallo schema e matrice e2e mista chiusi in W8 |
| W6 — documentazione                | README, `CONTRIBUTING.md`, [architecture.md](architecture.md), [desktop-web-sync.md](desktop-web-sync.md), OpenAPI, CHANGELOG, documenti senza promesse di CI; riscrittura di [web-ui.md](web-ui.md) e capitolo utente sul browser                                                                                                                                                                                                                                                                                                                | fatta                                                                                                                                       |
| W7 — bassa priorità                | rilievi di priorità bassa (concorrenza minore, audit e sessioni, crittografia: NFC della passphrase, ADR-0034, azzeramento delle chiavi; supply chain), a lotti                                                                                                                                                                                                                                                                                                                                                                                   | lotti 1 e 2 fatti; i rilievi bassi rimasti sono stati chiusi in W8                                                                          |
| W8 — punti aperti                  | tutti i rilievi rimasti del report (medi e bassi) e i rinvii delle onde precedenti, in otto lotti più due di completamento: quota degli upload, tus, history condivisa, commit, export, ruoli e account (ADR-0041), hub delle notifiche, watcher FSEvents (ADR-0044), path cifrati legati al file (ADR-0042), capability estese e identità del dispositivo web, SRI completa e core WASM più piccolo, `cloud-features` completo, flag dallo schema, matrice e2e e suite mista, `move_prefix` lato client (ADR-0040), stato «dispositivo revocato» | fatta; ADR 0040–0044 accettati il 2026-11-02 (ADR-0041 punto 8 implementato, punto 9 confermato; ADR-0043 implementato nei passi 2–5)       |

**Criteri di uscita M11:** `task ci` verde; suite lente verdi sulle aree toccate (`task test-integration`, `task test-desktop-e2e`, `task e2e`, `e2e:workbench-ui`, `e2e:cloud`); ADR 0036–0044 accettati o rivisti dal proprietario e recepiti nello spec (fatto il 2026-11-02: tutti accettati e recepiti in `Specifications.md` v1.2, Appendice C.4); ogni funzione di gestione dei vault cloud disponibile su console, desktop e workbench secondo il registro.

---

## 14. Trasversale: test e verifica

| Livello            | Strumento                                                                         | Dove                                                       |
| ------------------ | --------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Unit Go            | `go test -race ./...` (tabelle per parser, pathrules, merge, vaultcrypto, search) | tutti i moduli                                             |
| Conformance        | fixture `shared/conformance/{markdown,merge,crypto}` eseguite da Go e TS          | `task conformance`                                         |
| Integrazione cloud | testcontainers (PG, MinIO, Keycloak)                                              | `services/cloud/test/integration`, `task test-integration` |
| Contratto          | richieste e risposte del client validate contro `openapi.yaml`                    | `apps/desktop/internal/sync/transport/contract_test.go`    |
| E2E sync           | 2 engine desktop contro cloud in container                                        | `apps/desktop/internal/sync/e2e_test.go`                   |
| Frontend           | Vitest (unit/componenti), Playwright sul mock dei binding e su Web UI             | `packages/*/src`, `apps/desktop/frontend/e2e`, `web/e2e`   |
| Prestazioni        | benchmark Go (`-bench`), k6, dataset sintetici                                    | a mano (`task perf`, `task perf-check`)                    |
| Sicurezza          | govulncheck, yarn npm audit, test CSP/no-network (SBOM da riattivare)             | `task vuln` in `task ci`; e2e di sicurezza a mano          |

Verifica end-to-end di ogni milestone = i "Criteri di uscita" sopra, eseguiti con `task ci` + scenario manuale documentato in `docs/qa/m<N>-checklist.md`.

---

## 15. Primi passi operativi (subito dopo l'approvazione)

1. M0-WP0 scaffolding + `docs/roadmap.md` (questo piano) + aggiornamento `CLAUDE.md` con i comandi.
2. SPIKE-01, -02, -03, -05 (SPIKE-04 all'inizio di M1) con ADR.
3. M0-WP1 → WP2 → WP3/WP4 (cloud+Keycloak) → WP5 → WP6 → WP7.
4. Decisioni ancora aperte: hosting (il module path resta `memobrain`, licenza MIT già decisa); scelta `op_id` persistito (M2-WP2); libreria rendering grafo (M6).
