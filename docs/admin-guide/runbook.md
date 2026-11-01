# Runbook degli incidenti

Formato: **sintomo → verifica → rimedio**. Prima di ogni caso, i tre strumenti base:

- log del servizio (JSON, un `request_id` per richiesta; il client invia `X-Request-Id`): `kubectl logs deploy/memobrain-api`, `kubectl logs deploy/memobrain-worker`;
- `GET /api/v1/healthz` (processo vivo) e `GET /api/v1/readyz` (database e storage rispondono entro 3 s; risponde 503 e, solo se interrogato direttamente dalla rete interna, ad esempio con `kubectl port-forward deploy/memobrain-api 18081` o `docker compose exec proxy wget -qO- http://cloud-api:18081/api/v1/readyz`, il nome e l'errore della dipendenza che manca; da fuori, il dettaglio è nel log `readiness check failed`). Per il worker: `/healthz` e `/readyz` sulla porta 18083 (`state`: `running`, `waiting-for-schema`, `stalled`);
- dashboard Grafana "Panoramica servizio cloud" ([monitoraggio](monitoraggio.md)) e registro di audit della console admin.

## Il login non funziona

**Sintomo:** il browser o l'app desktop non completano l'accesso; l'API risponde `401`; la Web UI mostra "configurazione non disponibile".

1. `curl -s https://<host>/api/v1/client-config`: deve restituire issuer e client id. Se manca o l'issuer è sbagliato, controllare `OIDC_ISSUER` (deve coincidere **esattamente** con il claim `iss` dei token, incluso `/realms/memobrain`).
2. Il servizio raggiunge Keycloak? Dal pod: `curl -s $OIDC_ISSUER/.well-known/openid-configuration`. Al riavvio il servizio recupera le chiavi JWKS: se Keycloak è giù il processo non parte (`connectOIDC` nei log).
3. `401` con token valido: verificare `aud` (`OIDC_AUDIENCE`, default `memobrain-api`) e `azp` (`OIDC_ALLOWED_AZP`). Nel realm il client scope deve aggiungere l'audience `memobrain-api`.
4. Scarto dell'orologio: i token sono validati con il tempo del server; sincronizzare NTP su nodi e Keycloak.
5. Desktop: il redirect loopback fallisce o è bloccato dal firewall → l'app ripiega su `memobrain://auth/callback`; verificare che lo scheme sia registrato (installer) e che il client `memobrain-desktop` ammetta entrambi i redirect.
6. Web UI: l'origine deve essere in `WEB_UI_ORIGIN` (CORS) e tra i redirect URI del client `memobrain-web`.
7. Un solo utente non entra: potrebbe essere sospeso (vedi sotto) oppure bloccato da Keycloak (Utenti → stato, brute-force detection).

**Rimedio:** correggere la variabile o il realm, riavviare l'API (`kubectl rollout restart deploy/memobrain-api`).

## La sincronizzazione è bloccata o lenta

**Sintomo:** i client mostrano "sync in corso" a lungo, errori di rete, o le modifiche arrivano in ritardo.

1. Dashboard → _Sincronizzazione_: commit/s con `outcome="error"` > 0? Latenza p95 alta? Pool del database saturo?
2. `rejected` in aumento: leggere il campo `code` nelle risposte (`QUOTA_EXCEEDED`, `PATH_COLLISION`, `VAULT_ENCRYPTED`…): non è un guasto ma una regola; vedi [Quota esaurita](#quota-esaurita).
3. Solo notifiche in ritardo: lo stream (gRPC o SSE) può essere interrotto da proxy. Verificare `memobrain_notify_streams_active` e che l'ingress inoltri HTTP/2 per gRPC (host dedicato `grpcHost` nel chart); il client ripiega su SSE e su un polling periodico, quindi il ritardo è limitato ma non nullo.
4. Un solo vault: confrontare `last_seq` del vault (pagina Vault utente nella console) con il cursore dei client; un client rimasto indietro oltre `sync.changelog_window_days` riparte dal manifesto (comportamento normale, più lento).
5. Un file in conflitto continuo: il merge è sul client; per i tipi diversi da `.md` il server produce copie di conflitto. Nessun dato viene perso (le versioni scartate restano nello storico).
6. Blocchi sul database: query lente o lock (`pg_stat_activity`); il commit tiene lock di riga sul proprietario del vault (quota) per microsecondi, un lock prolungato indica una transazione ferma.

**Rimedio:** aumentare repliche API o `max_connections`, correggere l'ingress, riavviare lo stream; per un client bloccato basta "Sincronizza ora" o riavviare l'app (lo stato è in `sync.db`, l'operazione è idempotente grazie agli `op_id`).

## Quota esaurita

**Sintomo:** gli utenti ricevono `QUOTA_EXCEEDED`; la barra dell'utilizzo nella Web UI è rossa (soglie `warn_percent`/`critical_percent`).

1. Console → **Archiviazione**: utenti sopra soglia e principali consumatori. La quota conta **solo i file correnti**, non lo storico (D-03) ed è addebitata al **proprietario** del vault condiviso.
2. Se il dato sembra sbagliato, la riconciliazione notturna (`maintenance`) corregge le derive: forzarla con un riavvio del worker non è necessario; controllare nei log del worker `usage drift corrected`.
3. Vault eliminati non ancora purgati occupano spazio fino a `vaults.deleted_retention_days`.

**Rimedio:** aumentare la quota dell'utente (console → Utenti → _Cambia quota_, o quota in blocco dalla lista), aumentare il default in **Limiti**, oppure chiedere all'utente di eliminare file. Ogni modifica è nel registro di audit (`user.quota`).

## Utente sospeso

**Sintomo:** un utente non riesce più a usare l'API (errore di account sospeso) pur avendo un token valido.

1. Console → Utenti → stato `Sospeso`. L'azione è nel registro di audit (`user.suspend`, con attore e IP).
2. La sospensione ha effetto entro `OIDC_STATUS_CACHE_TTL` (30 s): il servizio controlla `users.status` oltre alla validità del token. Una sospensione non revoca i token già emessi in Keycloak, li rende inutilizzabili sull'API.
3. Gli stream di notifica attivi si chiudono al successivo controllo; i client mostrano "account sospeso" e non perdono i dati locali.

**Rimedio:** _Riattiva_ dalla console (`user.activate`). Se la sospensione è stata fatta su Keycloak e non nella console, riabilitare l'utente lì.

## Gli export restano in coda

**Sintomo:** il download ZIP di un vault condiviso resta su "in coda" o "in preparazione"; stato `failed` o `expired`.

1. Gli export sono eseguiti dal job `exports` (ogni 15 s) in un processo con `--role=worker` o `--role=all`. Se tutte le repliche sono `--role=api`, **nessuno** li elabora: aggiungere un worker. Un worker con `/readyz` a 503 e `state` `waiting-for-schema` non esegue job finché l'API non ha migrato il database (log `waiting for the API to migrate the database schema`): verificare che almeno una replica API della stessa versione sia partita.
2. Il worker sfrattato (`Evicted`, `ephemeral-storage`) ha superato `worker.tmp.sizeLimit` costruendo un archivio: alzare il limite (e `resources.limits.ephemeral-storage`) sopra la dimensione del vault più grande.
3. Dashboard → _Job_: `memobrain_jobs_runs_total{exported_job="exports",result="error"}` (`job` con `honor_labels: true`) e "Tempo dall'ultimo successo". Nei log del worker cercare `job failed` con `job=exports`.
4. Cause tipiche: bucket `S3_BUCKET_EXPORTS` inesistente o credenziali senza scrittura; disco o quota dell'archivio pieni; vault molto grande che supera il tempo (il job ritenta alla successiva esecuzione).
5. `expired`: l'archivio è stato rimosso dopo il periodo di validità; l'utente deve ripetere la richiesta.
6. I vault **privati** non si esportano dal server (`409 VAULT_ENCRYPTED`): lo ZIP si costruisce nel browser dopo aver inserito passphrase o recovery key. Se "non funziona", verificare che l'utente conosca la passphrase: non esiste recupero lato server.

**Rimedio:** correggere bucket e credenziali, riavviare il worker; l'utente rilancia l'export dalla Web UI.

## Il servizio non risponde o il database è giù

**Sintomo:** `readyz` risponde 503 con `database`, errori 5xx, allarmi `MemobrainDown` / `MemobrainDbPoolSaturated`.

1. `kubectl get pods`; `kubectl describe pod` (OOMKilled? probe fallite?); `kubectl logs --previous`.
2. Database: raggiungibile dal pod? (`psql "$DATABASE_URL" -c 'select 1'`), spazio su disco, `max_connections`, failover in corso. Il servizio non perde dati se il DB è momentaneamente giù: restituisce errori e i client riprovano con backoff; i commit sono idempotenti.
3. Saturazione del pool: dashboard → _Database_. Il pool è dimensionato dalla libreria; con molte repliche la somma delle connessioni può superare `max_connections` di PostgreSQL (usare un pooler come PgBouncer in modalità session; **non** transaction se si usano `LISTEN/NOTIFY` — lo stream di notifica ne ha bisogno).
4. Migrazioni fallite all'avvio: il pod resta in crash loop con l'errore di goose (con più repliche, una sola migra alla volta sotto advisory lock: le altre attendono fino a 10 minuti e, se il lock non si libera, falliscono con `failed to acquire lock`); non avviare versioni precedenti sul DB migrato (vedi [upgrade](backup-upgrade.md)).

**Rimedio:** ripristinare il database (da backup o replica, [backup](backup-upgrade.md)), poi `kubectl rollout restart`. Al ritorno del DB i client si riallineano da soli.

## L'archivio S3 non è raggiungibile

**Sintomo:** `readyz` 503 con `storage`; upload e download di blob falliscono; gli export non si completano.

1. Raggiungibilità e credenziali: `aws --endpoint-url $S3_ENDPOINT s3 ls s3://memobrain-blobs` con le chiavi del Secret; certificato TLS valido; regola CORS se si usa `S3_PUBLIC_ENDPOINT`.
2. Bucket esistenti con i nomi di `S3_BUCKET_BLOBS` e `S3_BUCKET_EXPORTS`; spazio e quota del provider.
3. I metadati (database) e i blob sono separati: con S3 giù i client possono ancora scaricare l'elenco delle modifiche, ma non i contenuti; le scritture riprovano. Il GC dei blob **non** cancella nulla se la cancellazione dell'oggetto fallisce (prima l'oggetto, poi la riga): nessuna incoerenza.
4. Dopo un ripristino parziale dello storage: la riconciliazione notturna dei riferimenti blob (`blob ref count corrected` nei log) corregge i contatori, ma non può ricreare oggetti mancanti. Un oggetto mancante appare come errore di download di un file specifico: ripristinarlo dal backup dello storage.

**Rimedio:** ripristinare la connettività o le credenziali; nessun riavvio necessario se il provider torna disponibile.

## Raccogliere informazioni per un'escalation

Versione (`GET /api/v1/healthz` e log di avvio), orario e `request_id` della richiesta fallita, estratto dei log API/worker, screenshot della dashboard, esito di `readyz`, versione di Keycloak e PostgreSQL. Non allegare token, segreti o contenuto delle note.
