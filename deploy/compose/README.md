# MemoBrain Notes Cloud on-premise con Docker Compose

Stack per un singolo host: reverse proxy Caddy (TLS automatico, HTTP/2 per gRPC), Cloud Service (`--role=api` e `--role=worker`), PostgreSQL, store S3-compatibile (RustFS) e Keycloak. Solo il proxy pubblica porte. Per cluster Kubernetes usare invece il chart Helm in `deploy/helm/memobrain`.

> Stato di verifica: `docker compose config` e un avvio completo con i default di sviluppo (HTTP, nomi `*.localhost`) sono stati eseguiti; `/readyz` risponde `ok` tramite il proxy. Il percorso TLS (Let's Encrypt / CA interna) e il flusso gRPC con TLS **non** sono stati provati in questo ambiente.

## Requisiti

- Docker Engine 24+ con il plugin Compose v2, 4 GB di RAM liberi.
- Tre nomi DNS che puntano all'host (esempio: `memobrain.example.com`, `notify.example.com`, `auth.example.com`) e le porte 80/443 raggiungibili da Internet per l'emissione dei certificati ACME. Senza accesso pubblico: `CADDY_GLOBAL=local_certs` (CA interna di Caddy, da distribuire ai client).
- L'immagine `MEMOBRAIN_IMAGE:MEMOBRAIN_VERSION` pubblicata da `release.yml`. L'immagine non è firmata (vedi `docs/release/README.md`).

## Primo avvio

1. `cp .env.example .env` e modificarlo: nomi host, `MEMOBRAIN_VERSION`, e **tutti i segreti** (`openssl rand -base64 24 | tr -d '=+/'`). `.env` non va committato. Finché un segreto vale ancora il segnaposto di `.env.example` (`change-me`, `change-me-too`) il servizio one-shot `preflight` termina con errore e PostgreSQL, S3 e Keycloak non partono (`docker compose logs preflight` elenca le variabili da cambiare); anche il Cloud Service rifiuta di avviarsi. `MEMOBRAIN_ALLOW_PLACEHOLDER_SECRETS=1` salta entrambi i controlli: solo per prove usa e getta.
2. `docker compose config -q` per controllare che non manchi nessuna variabile obbligatoria.
3. `docker compose up -d`. L'ordine è garantito dai healthcheck: PostgreSQL (crea anche il database `keycloak` solo al primo avvio con volume vuoto), S3 e creazione bucket, Keycloak, poi API, worker e proxy. Il Cloud Service applica le migrazioni DB all'avvio di `cloud-api`: nel frattempo, e finché Keycloak non risponde, `/api/v1/healthz` risponde già 200 mentre `/api/v1/readyz` e le altre API rispondono 503 (il proxy non inoltra traffico). `cloud-worker` attende da solo che lo schema sia aggiornato prima di eseguire i job.
4. Verifica: `curl https://memobrain.example.com/api/v1/readyz` deve rispondere `{"status":"ok",...}`. Tramite il proxy la risposta non riporta il dettaglio per dipendenza; per vederlo: `docker compose exec proxy wget -qO- http://cloud-api:18081/api/v1/readyz` (`database` e `storage` a `ok`). Il worker: `docker compose exec proxy wget -qO- http://cloud-worker:18083/healthz`.

### Keycloak: realm, utente admin, client

- Al primo avvio Keycloak importa il realm `memobrain` da `deploy/keycloak/realm-memobrain.json` (client `memobrain-desktop`, `memobrain-web`, `memobrain-admin-svc`, ruoli). L'utente amministratore del **server Keycloak** è `KC_BOOTSTRAP_ADMIN_*` (console su `https://auth.example.com/admin`). La console e il realm `master` **non sono pubblici**: il proxy risponde `403` a meno che l'IP del client sia in `KEYCLOAK_ADMIN_FROM` (CIDR separati da spazio, per esempio la VPN degli amministratori). Per il primo avvio impostarla in `.env`, `docker compose up -d proxy`, configurare il realm, poi rimuoverla e ripetere il comando (dettagli in `docs/admin-guide/keycloak.md`). I client usano solo `/realms/memobrain/...` e `/resources/...`, che restano pubblici.
- Questo stack importa il realm di **produzione** `deploy/keycloak-prod/realm-memobrain.json`: nessun utente di prova (il realm di sviluppo `deploy/keycloak/` resta per `task stack-up` e k3d), il secret di `memobrain-admin-svc` è `KC_ADMIN_CLIENT_SECRET` del `.env` e l'origine della Web UI è `WEB_UI_ORIGIN`, sostituiti da Keycloak all'import. Creare i veri utenti (o federare l'IdP aziendale) dalla console. Se cambiano le definizioni in `deploy/keycloak/`, riportarle nella variante di produzione (stessi client e ruoli).
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

Nota per chi aggiorna un'installazione esistente a questa versione del compose: la `/tmp` di `cloud-api` è ora un tmpfs limitato (`API_TMP_SIZE`, default `2g`: la RAM effettivamente usata è solo quella occupata dagli upload in corso) e quella di `cloud-worker` è il nuovo volume `worker_tmp` su disco (prima entrambe erano tmpfs senza limite, cioè fino a metà della RAM). `docker compose up -d` crea il volume da solo; non contiene dati da salvare e può essere eliminato con `docker volume rm <progetto>_worker_tmp` a stack fermo. Lo spazio libero sul disco di Docker deve bastare per l'archivio di export del vault più grande.

## Hardening già applicato

HSTS (`Strict-Transport-Security: max-age=31536000`, spec §3.7) impostato dal proxy sui tre siti quando sono serviti in HTTPS (nessun header sui siti `http://` di prova; sulle pagine di Keycloak resta l'HSTS che Keycloak invia già). Senza `includeSubDomains`, perché i tre nomi possono condividere il dominio padre con altri siti non HTTPS; dopo la prima visita in HTTPS i browser non usano più HTTP per quei nomi per un anno, quindi tornare a HTTP richiede di cambiare nome host. Container MemoBrain Notes con filesystem root in sola lettura, `/tmp` limitata (tmpfs di `API_TMP_SIZE` per l'API, volume dedicato per il worker; i file temporanei abbandonati da un crash si eliminano all'avvio), `cap_drop: ALL`, `no-new-privileges`, utente non root (immagine distroless); PostgreSQL, S3 e Keycloak non pubblicano porte sull'host; la console S3 è disattivata; console di amministrazione di Keycloak e realm `master` chiusi sul proxy (`KEYCLOAK_ADMIN_FROM`); avvio rifiutato con i segreti segnaposto (`preflight`); immagini di terze parti fissate per versione e digest (aggiornamento: `deploy/PINS.md`).

## Limiti noti

- Il container del Cloud Service è distroless: non ha `curl` né shell, quindi non ha un healthcheck Docker; la readiness è controllata dal proxy (`health_uri`) e a mano con `docker compose exec proxy wget -qO- http://cloud-api:18081/api/v1/readyz`.
- Un solo host: nessuna alta affidabilità. Per HA usare Kubernetes (chart Helm) con PostgreSQL e S3 gestiti.
