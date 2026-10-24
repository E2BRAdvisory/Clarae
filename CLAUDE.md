# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Fonti di verità

`Specifications.md` (v1.1, in italiano) definisce architettura, vincoli (V-01…V-10), decisioni (D-01…D-08, Appendice C), schema DB, API e protocollo di sync. `docs/roadmap.md` è il piano di sviluppo per milestone (M0–M7) con work package, ordine e criteri di uscita: leggi la milestone corrente prima di iniziare un task. Le deviazioni dallo spec si registrano come ADR in `docs/adr/` (template `0000-template.md`) e si propongono all'utente, che aggiorna lo spec. Codice, commit, log e messaggi API in inglese; docs/ADR in italiano.

## Comandi

Monorepo: `go.work` (moduli `nodus/shared` in `shared/go`, `nodus/services/cloud`, `nodus/apps/desktop`) + workspace Yarn 4 (`packageManager` bloccato in package.json). Il module path `nodus/…` è un segnaposto (`make rename-module NEW=…`). Go 1.26 (scaricato dal toolchain se manca), Wails v2.12, Node 24, Yarn 4.18.

```sh
make tools              # tool Go pinnati in tools/go.mod (fuori dal workspace: GOWORK=off) + yarn install
make gen                # OpenAPI → Go/TS, proto (buf), sqlc, binding Wails (frontend/wailsjs, non editare a mano)
make lint | test | ci   # golangci-lint + eslint/prettier | go test -race + vitest + conformance | tutto
make test-integration   # cloud con testcontainers (PG, MinIO, Keycloak)
make stack-up           # PostgreSQL :5433, RustFS (S3) :9000, Keycloak :8080 (admin/admin; utenti admin/user1/user2, password "nodus-dev-password")
make dev-cloud          # nodus-cloud --role=all su :18081 (env in deploy/docker/cloud.dev.env)
make dev-desktop        # wails dev
make run-desktop        # app standalone (no cloud) + vault demo; scripts/ ha anche run-desktop-with-cloud.sh (stack+cloud+desktop, --two-devices) e dev-stop.sh; stato in .dev/
```

Singolo test Go: `cd services/cloud && go test -race -run 'TestNome' ./internal/sync/...`. Singolo test TS: `pnpm --filter @nodus/desktop-frontend exec vitest run src/path/file.test.ts`. Lo shell dell'utente aliasa `grep` a `ugrep`: nei comandi usare `command grep`.

## Cos'è Nodus

App di knowledge management local-first ispirata a Obsidian (nome in codice, segnaposto):

- **Client desktop** Wails **v2** (Go + React/TS, CodeMirror 6), funziona offline su vault = cartelle di file ordinari (`.md`, `.canvas`, `.base`, `.excalidraw`), compatibili con vault Obsidian.
- **Cloud Service** Go (modular monolith, REST `/api/v1` + gRPC/SSE per notifiche), PostgreSQL, S3-compatibile, **Keycloak** (OIDC; il cloud è solo resource server).
- **Web UI** React/TS (admin + utente), compilata e incorporata nel binario cloud via `go:embed`.

## Architettura (il quadro d'insieme)

Layout previsto: `apps/desktop` (Wails), `services/cloud`, `web/`, `shared/go` (codice Go condiviso client/server), `shared/conformance`, `packages/*` (TS condiviso), `api/` (OpenAPI + proto), `deploy/`.

Punti che richiedono di leggere più file/sezioni per essere compresi:

- **Il merge è sempre sul client.** Il server ordina le modifiche (changelog per vault con `seq` monotono, revisioni immutabili con `rev_no`, concorrenza ottimistica via `base_rev`) e archivia blob content-addressed (SHA-256), ma non interpreta mai il contenuto. Per questo il protocollo è identico per vault privati e condivisi. La logica di merge vive in `shared/go/merge` (3-way per `.md`, per-id per JSON excalidraw/canvas). Flusso: pull `changes?since=cursor` → push `blobs:check` / `PUT blob` / `commit` con `ops[]` → `accepted|conflict|rejected`.
- **Due tipi di vault cloud, scelta immutabile (D-02):** _privato_ = E2EE lato client (VMK 256 bit avvolta da passphrase via Argon2id e da recovery key; path e contenuto opachi al server; **non condivisibile**, perso l'accesso i dati sono irrecuperabili) vs _condiviso_ = non E2EE, condivisibile con utenti/gruppi. Il codice cripto condiviso è in `shared/go/vaultcrypto` con test vector Go+TS; la Web UI decifra nel browser (`packages/vaultcrypto-web`) per lo ZIP dei vault privati. Operazioni non ammesse su vault privato → errore `VAULT_ENCRYPTED`.
- **Perimetro per-vault (D-06):** nessuna funzione cross-vault (link, backlink, grafo, ricerca, bookmark, template). Il contenuto condiviso appare come _mount_ = vault separato.
- **Doppio parser, una sola verità:** backend Go (`goldmark` + estensioni OFM) per l'indice; frontend (Lezer per l'editor, remark/rehype per il reading view). Le divergenze si prevengono con fixture condivise in `shared/conformance/` eseguite sia in Go che in TS in CI (bloccante).
- **Frontend senza accesso diretto a disco/rete:** tutto passa dai binding Wails (Go) ed eventi Go→TS; `wailsjs/` è generato, non modificare a mano. `WriteNote` richiede `expectedHash` per non sovrascrivere modifiche esterne; le scritture su vault sono atomiche (tmp + fsync + rename) e rifiutano path traversal.
- **Dati locali derivati:** `index.db` (SQLite FTS5 con driver pure-Go `modernc.org/sqlite`, niente CGO, tokenizer `trigram`) è ricostruibile e non sincronizzato; `sync.db` tiene lo stato di sync; configurazione vault in `.nodus/` con scope di sync differenziato.
- **Cloud modular monolith:** `internal/<modulo>` con interfacce esplicite; dipendenze solo verso `db`, `storage`, `audit`, `notify` e interfacce di altri moduli, **mai alle tabelle altrui** (lint `depguard`/`go-arch-lint`). Stesso binario con `--role=api|worker|all`. DB access con pgx + sqlc, migrazioni SQL versionate.
- **Auth:** desktop = Authorization Code + PKCE nel browser di sistema, redirect loopback con fallback a `nodus://auth/callback` (D-08); refresh token nel keychain OS. Cloud valida JWT (JWKS, `iss`, `aud=nodus-api`) e controlla anche `users.status` (cache 30 s) per la sospensione. **I gruppi esistono solo nel DB del cloud (D-05)**: niente claim di gruppo nel token, né import da Keycloak/LDAP.
- **Config Profile:** JSON versionato assegnato a gruppi; risoluzione: default prodotto → globale → gruppi (priorità) → override utente (non `locked`). Funge anche da feature flag.
- **Contratti:** `api/openapi.yaml` è la fonte unica (stub Go con `oapi-codegen`, client TS generato); errori `application/problem+json` con campo `code`; ID UUID v7.

## Vincoli da rispettare

- Architettura **chiusa** (V-02/D-01): niente plugin, temi di terze parti, CSS personalizzato (né `<style>`/`style` negli HTML inline: sanificazione con DOMPurify).
- Wails **v2**: una sola finestra per processo, desktop-only (niente mobile, pop-out rinviate a P2).
- Excalidraw (`@excalidraw/excalidraw`, lazy) deve funzionare **offline**: asset locali via `window.EXCALIDRAW_ASSET_PATH`, CI verifica assenza di richieste di rete.
- Collaborazione asincrona (D-04): merge multi-utente garantito solo per `.md`; altri tipi → copia di conflitto. Nessuna perdita silenziosa (versioni scartate restano nello storico).
- La quota conta solo i file correnti, non lo storico (D-03).

## Cosa non fare in automatico

1. Modificare il file ./Specification.md
2. non eseguire mai commit e/o push senza esplicita richiesta!
