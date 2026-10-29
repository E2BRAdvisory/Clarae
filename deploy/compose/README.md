# MemoBrain Notes Cloud on-premise con Docker Compose

Stack per un singolo host: reverse proxy Caddy (TLS automatico, HTTP/2 per gRPC), Cloud Service (`--role=api` e `--role=worker`), PostgreSQL, store S3-compatibile (RustFS) e Keycloak. Solo il proxy pubblica porte. Per cluster Kubernetes usare invece il chart Helm in `deploy/helm/memobrain`.

> Stato di verifica: `docker compose config` e un avvio completo con i default di sviluppo (HTTP, nomi `*.localhost`) sono stati eseguiti; `/readyz` risponde `ok` tramite il proxy. Il percorso TLS (Let's Encrypt / CA interna) e il flusso gRPC con TLS **non** sono stati provati in questo ambiente.

## Requisiti

- Docker Engine 24+ con il plugin Compose v2, 4 GB di RAM liberi.
- Tre nomi DNS che puntano all'host (esempio: `memobrain.example.com`, `notify.example.com`, `auth.example.com`) e le porte 80/443 raggiungibili da Internet per l'emissione dei certificati ACME. Senza accesso pubblico: `CADDY_GLOBAL=local_certs` (CA interna di Caddy, da distribuire ai client).
- L'immagine `MEMOBRAIN_IMAGE:MEMOBRAIN_VERSION` pubblicata da `release-images.yml`. **Verificare la firma** prima di usarla (vedi `docs/release/README.md`): `cosign verify ghcr.io/e2br/memobrain-cloud:1.0.0 --certificate-identity-regexp ... --certificate-oidc-issuer https://token.actions.githubusercontent.com`.

## Primo avvio

1. `cp .env.example .env` e modificarlo: nomi host, `MEMOBRAIN_VERSION`, e **tutti i segreti** (`openssl rand -base64 24 | tr -d '=+/'`). `.env` non va committato.
2. `docker compose config -q` per controllare che non manchi nessuna variabile obbligatoria.
3. `docker compose up -d`. L'ordine è garantito dai healthcheck: PostgreSQL (crea anche il database `keycloak` solo al primo avvio con volume vuoto), S3 e creazione bucket, Keycloak, poi API, worker e proxy. Il Cloud Service applica le migrazioni DB all'avvio.
4. Verifica: `curl https://memobrain.example.com/api/v1/readyz` deve rispondere `{"status":"ok",...}` con `database` e `storage` a `ok`.

### Keycloak: realm, utente admin, client

- Al primo avvio Keycloak importa il realm `memobrain` da `deploy/keycloak/realm-memobrain.json` (client `memobrain-desktop`, `memobrain-web`, `memobrain-admin-svc`, ruoli). L'utente amministratore del **server Keycloak** è `KC_BOOTSTRAP_ADMIN_*` (console su `https://auth.example.com/admin`).
- Questo stack importa il realm di **produzione** `deploy/keycloak-prod/realm-memobrain.json`: nessun utente di prova (il realm di sviluppo `deploy/keycloak/` resta per `make stack-up` e k3d), il secret di `memobrain-admin-svc` è `KC_ADMIN_CLIENT_SECRET` del `.env` e l'origine della Web UI è `WEB_UI_ORIGIN`, sostituiti da Keycloak all'import. Creare i veri utenti (o federare l'IdP aziendale) dalla console. Se cambiano le definizioni in `deploy/keycloak/`, riportarle nella variante di produzione (stessi client e ruoli).
- Il primo amministratore **MemoBrain Notes** è l'utente a cui si assegna il ruolo di realm `memobrain-admin` (gli utenti normali hanno `memobrain-user`): assegnarlo dalla console Keycloak, poi accedere alla Web UI. Non eliminare l'utente di servizio `service-account-memobrain-admin-svc`.
- Il realm si importa solo su database vuoto: modifiche successive al file JSON non hanno effetto, si fanno dalla console.

### Desktop

Nelle impostazioni Cloud del client inserire `https://memobrain.example.com`. Lo stream di notifica gRPC usa `notify.example.com:443` (pubblicato da `PUBLIC_GRPC_ADDR`): **richiede TLS** end to end, un proxy che parla solo HTTP/1.1 o HTTP in chiaro non funziona.

## Volumi e dati

| Volume       | Contenuto                           | Da salvare                 |
| ------------ | ----------------------------------- | -------------------------- |
| `pgdata`     | database MemoBrain Notes e Keycloak | sì                         |
| `s3data`     | blob dei vault, export              | sì                         |
| `caddy_data` | certificati e chiave ACME           | sì (evita nuove emissioni) |

## Backup

- Dump logico: `docker compose --profile backup run --rm pg-backup` scrive `backups/memobrain-<data>.dump` (formato custom, `pg_restore`). Il comando salva solo il database `memobrain`; per Keycloak ripetere con `pg_dump ... keycloak` o salvare il volume `pgdata`.
- Per un RPO basso usare archiviazione WAL / PITR di PostgreSQL (runbook nella guida amministratore, WP4) e la replica o lo snapshot del bucket S3.
- Un backup è valido solo se il ripristino è stato provato.

## Aggiornamento e rollback

1. Leggere le note di rilascio, cambiare `MEMOBRAIN_VERSION` in `.env`.
2. `docker compose pull && docker compose up -d`. Le migrazioni sono in avanti: **il rollback dell'immagine dopo una migrazione richiede il ripristino del backup**, quindi fare un dump prima.

## Hardening già applicato

Container MemoBrain Notes con filesystem root in sola lettura, `cap_drop: ALL`, `no-new-privileges`, utente non root (immagine distroless); PostgreSQL, S3 e Keycloak non pubblicano porte sull'host; la console S3 è disattivata.

## Limiti noti

- Il container del Cloud Service è distroless: non ha `curl` né shell, quindi non ha un healthcheck Docker; la readiness è controllata dal proxy (`health_uri`) e a mano con `docker compose exec proxy wget -qO- http://cloud-api:18081/api/v1/readyz`.
- Un solo host: nessuna alta affidabilità. Per HA usare Kubernetes (chart Helm) con PostgreSQL e S3 gestiti.
