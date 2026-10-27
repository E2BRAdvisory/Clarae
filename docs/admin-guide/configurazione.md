# Riferimento di configurazione

Il binario `memobrain-cloud` si configura **solo con variabili d'ambiente** (12-factor) e con il flag `--role`. Questa pagina elenca ogni variabile letta da `services/cloud/internal/config/config.go`. Un test (`TestEveryEnvVarIsDocumented` in `services/cloud/internal/config`) fallisce se una variabile del codice non compare in questa tabella: aggiungere una variabile al codice richiede di documentarla qui.

## Ruolo del processo

| Flag            | Effetto                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------- |
| `--role=all`    | API HTTP + gRPC e worker nello stesso processo (default dell'immagine; sviluppo e piccole istanze). |
| `--role=api`    | Solo API HTTP, gRPC/SSE e Web UI.                                                                   |
| `--role=worker` | Solo lavori in background (GC blob, retention, compattazione, export). Non richiede `OIDC_*`.       |

I job usano un advisory lock PostgreSQL: più repliche worker non duplicano il lavoro.

## Variabili

Le colonne "Obbl." indicano se il servizio rifiuta di avviarsi senza la variabile (o senza una delle alternative indicate).

### Rete e processo

| Variabile          | Default              | Obbl. | Descrizione                                                                                                                                                                                                                       |
| ------------------ | -------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LISTEN_ADDR`      | `127.0.0.1:18081`    | no    | Indirizzo HTTP (API REST `/api/v1`, Web UI, `/metrics`). L'immagine Docker imposta `0.0.0.0:18081`.                                                                                                                               |
| `GRPC_LISTEN_ADDR` | `127.0.0.1:18082`    | no    | Indirizzo gRPC dello stream di notifiche. L'immagine imposta `0.0.0.0:18082`.                                                                                                                                                     |
| `PUBLIC_GRPC_ADDR` | = `GRPC_LISTEN_ADDR` | no    | `host:porta` con cui i client raggiungono lo stream (dietro ingress differisce dall'indirizzo di ascolto); esposto da `GET /client-config`.                                                                                       |
| `WEB_UI_ORIGIN`    | vuoto                | no    | Origine del Web UI ammessa da CORS (es. `https://memobrain.example.com`). Vuoto = CORS disattivato.                                                                                                                               |
| `LOG_LEVEL`        | `info`               | no    | `debug`, `info`, `warn`, `error` (log JSON su stdout).                                                                                                                                                                            |
| `SHUTDOWN_TIMEOUT` | `15s`                | no    | Durata massima dello spegnimento ordinato (formato Go: `30s`, `1m`).                                                                                                                                                              |
| `SHUTDOWN_DRAIN`   | `5s`                 | no    | Quanto il servizio resta in ascolto dopo SIGTERM con `/readyz` già non pronto, così il bilanciatore smette di inviare traffico prima dello spegnimento; deve stare sotto `terminationGracePeriodSeconds` meno `SHUTDOWN_TIMEOUT`. |

### Database

| Variabile      | Default | Obbl.  | Descrizione                                                                                                       |
| -------------- | ------- | ------ | ----------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL` | —       | **sì** | URL PostgreSQL (`postgres://utente:password@host:5432/db?sslmode=require`). Le migrazioni si applicano all'avvio. |

### Archivio oggetti (blob ed export)

| Variabile            | Default             | Obbl.               | Descrizione                                                                                                                                                                                          |
| -------------------- | ------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `S3_ENDPOINT`        | vuoto               | sì, o `STORAGE_DIR` | Endpoint S3-compatibile (RustFS, MinIO, AWS S3, Ceph…).                                                                                                                                              |
| `S3_ACCESS_KEY`      | vuoto               | con S3              | Access key (segreto: usare un Secret).                                                                                                                                                               |
| `S3_SECRET_KEY`      | vuoto               | con S3              | Secret key (segreto).                                                                                                                                                                                |
| `S3_REGION`          | `us-east-1`         | no                  | Regione S3.                                                                                                                                                                                          |
| `S3_BUCKET_BLOBS`    | `memobrain-blobs`   | no                  | Bucket dei blob content-addressed. Deve esistere.                                                                                                                                                    |
| `S3_BUCKET_EXPORTS`  | `memobrain-exports` | no                  | Bucket degli archivi ZIP di export. Deve esistere.                                                                                                                                                   |
| `S3_USE_PATH_STYLE`  | `true`              | no                  | `true` per MinIO/RustFS (path-style), `false` per AWS S3 con virtual-host.                                                                                                                           |
| `S3_PUBLIC_ENDPOINT` | vuoto               | no                  | Endpoint raggiungibile dai browser: se impostato i download di export usano URL presigned (il bucket richiede una regola CORS per l'origine del Web UI); vuoto = scaricati tramite l'API (ADR-0012). |
| `STORAGE_DIR`        | vuoto               | alternativa a S3    | Directory locale per i blob quando `S3_ENDPOINT` è vuoto. Solo sviluppo/test a nodo singolo.                                                                                                         |

### Autenticazione (OIDC / Keycloak)

| Variabile                | Default                           | Obbl.           | Descrizione                                                                                                                                       |
| ------------------------ | --------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OIDC_ISSUER`            | —                                 | sì (non-worker) | URL dell'issuer del realm (`https://auth.example.com/realms/memobrain`). Usato per JWKS e claim `iss`.                                            |
| `OIDC_AUDIENCE`          | `memobrain-api`                   | sì (non-worker) | Valore atteso del claim `aud`.                                                                                                                    |
| `OIDC_ALLOWED_AZP`       | `memobrain-desktop,memobrain-web` | no              | Client id (claim `azp`) ammessi a chiamare l'API, separati da virgola.                                                                            |
| `OIDC_DESKTOP_CLIENT_ID` | `memobrain-desktop`               | no              | Client pubblico del desktop, pubblicato da `GET /client-config`.                                                                                  |
| `OIDC_WEB_CLIENT_ID`     | `memobrain-web`                   | no              | Client pubblico del Web UI, pubblicato da `GET /client-config`.                                                                                   |
| `OIDC_STATUS_CACHE_TTL`  | `30s`                             | no              | Per quanto il servizio memorizza lo stato di un utente (sospensione): è il ritardo massimo con cui una sospensione blocca un token ancora valido. |

### Keycloak Admin REST (service account)

| Variabile                | Default               | Obbl.                | Descrizione                                                                                          |
| ------------------------ | --------------------- | -------------------- | ---------------------------------------------------------------------------------------------------- |
| `KC_ADMIN_BASE_URL`      | vuoto                 | per la console admin | URL base di Keycloak (senza `/realms/...`). Vuoto = le operazioni admin sugli utenti non funzionano. |
| `KC_REALM`               | `memobrain`           | no                   | Nome del realm.                                                                                      |
| `KC_ADMIN_CLIENT_ID`     | `memobrain-admin-svc` | no                   | Client confidential con service account (ruoli minimi: vedi [Keycloak](keycloak.md)).                |
| `KC_ADMIN_CLIENT_SECRET` | vuoto                 | per la console admin | Segreto del client (segreto: usare un Secret).                                                       |

## Impostazioni a runtime (non sono variabili d'ambiente)

Alcuni parametri si cambiano dalla console admin (**Limiti**) o dalla tabella `settings` senza riavviare il servizio. Valori predefiniti:

| Chiave                          | Default | Significato                                                              |
| ------------------------------- | ------- | ------------------------------------------------------------------------ |
| `files.max_size_bytes`          | 100 MiB | Dimensione massima di un file sincronizzato.                             |
| `history.retention_days`        | 30      | Giorni in cui si conservano tutte le revisioni.                          |
| `history.daily_retention_days`  | 90      | Giorni in cui si conserva una revisione al giorno (poi viene potata).    |
| `sync.changelog_window_days`    | 90      | Oltre questa finestra i client molto indietro ripartono dal manifesto.   |
| `vaults.deleted_retention_days` | 30      | Periodo in cui un vault eliminato è ancora recuperabile prima del purge. |
| `blobs.gc_grace_hours`          | 24      | Attesa prima di cancellare un blob non più referenziato.                 |

La quota predefinita e le soglie di avviso/critica (`warn_percent`, `critical_percent`) si impostano nella stessa pagina **Limiti**.

## Esempi

Sviluppo (`deploy/docker/cloud.dev.env`) e Kubernetes (`deploy/helm/memobrain/values.yaml`, sezioni `config:` per le variabili non segrete e `secret:` per `DATABASE_URL`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `KC_ADMIN_CLIENT_SECRET`).
