# Installazione

## Componenti

| Componente        | Ruolo                                                                                             | Note                                              |
| ----------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `memobrain-cloud` | API REST `/api/v1`, gRPC/SSE per le notifiche, Web UI incorporata (`go:embed`), job in background | Un solo binario, `--role=api\|worker\|all`        |
| PostgreSQL        | Metadati, changelog, revisioni, utenti, gruppi, audit                                             | 15 o successivo; migrazioni automatiche all'avvio |
| Archivio S3       | Blob content-addressed ed archivi di export                                                       | RustFS, MinIO, AWS S3 o compatibile; 2 bucket     |
| Keycloak          | Autenticazione OIDC (il servizio è solo resource server)                                          | Realm `memobrain`, vedi [Keycloak](keycloak.md)   |

Il traffico ha due ingressi: HTTP(S) per API e Web UI, **HTTP/2 (gRPC)** per lo stream di notifiche (in alternativa il client usa SSE su HTTP). Il database deve supportare `LISTEN/NOTIFY` senza pooler in modalità transaction.

## Kubernetes con Helm

Il chart è in `deploy/helm/memobrain` (`values.yaml` documenta ogni valore).

1. **Preparare le dipendenze:** database e utente PostgreSQL; due bucket (`memobrain-blobs`, `memobrain-exports`) e una chiave con lettura/scrittura; realm Keycloak importato o configurato ([Keycloak](keycloak.md)).
2. **Segreti.** Creare un Secret con `DATABASE_URL`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `KC_ADMIN_CLIENT_SECRET` e indicarlo in `secret.existingSecret` (consigliato), oppure lasciare che il chart lo crei da `secret.values` (solo prove). In questo caso `values.yaml` non fornisce valori: il rendering fallisce se una delle quattro chiavi è vuota o vale un segnaposto (`change-me`…), e il servizio applica la stessa regola all'avvio ([segreti segnaposto](configurazione.md#segreti-segnaposto)).
3. **Valori non segreti** in `config:` (vedi [configurazione](configurazione.md)): `OIDC_ISSUER`, `S3_ENDPOINT`, `KC_ADMIN_BASE_URL`, `WEB_UI_ORIGIN`, …
4. **Immagine.** `image.repository` e `image.tag` (l'immagine si costruisce con `docker build -f services/cloud/Dockerfile -t <repo>:<tag> .` dalla radice del repository; il registry definitivo è da decidere con la distribuzione, M7).
5. **Ingress:** `ingress.host` per HTTP e `ingress.grpcHost` per gRPC (HTTP/2 end to end, TLS). Con ingress NGINX aggiungere l'annotation `nginx.ingress.kubernetes.io/backend-protocol: "GRPC"` sull'host gRPC.
6. **Installare:**

   ```sh
   helm upgrade --install memobrain deploy/helm/memobrain -n memobrain --create-namespace -f my-values.yaml
   ```

Il chart avvia `api.replicas` repliche con `--role=api` e `worker.replicas` (1) con `--role=worker`. Le probe dell'API usano `/api/v1/healthz` (liveness) e `/api/v1/readyz` (readiness); quelle del worker `/healthz` e `/readyz` sulla porta interna `metrics` (`worker.metricsPort`, 18083). La directory `/tmp` di ogni pod è un `emptyDir` limitato (`api.tmp.sizeLimit` 2Gi per gli upload dei blob, `worker.tmp.sizeLimit` 10Gi per gli archivi di export; oltre il limite il kubelet sfratta il pod) con richieste e limiti di `ephemeral-storage` corrispondenti in `resources`: dimensionarli sugli upload concorrenti e sul vault più grande. Il pod gira come utente non root con profilo seccomp `RuntimeDefault`.

**Versione di Kubernetes.** Il chart richiede Kubernetes 1.27 o successivo. Il ritardo prima di SIGTERM (`api.preStopSleepSeconds`, azione `preStop` di tipo `sleep`) è reso solo da Kubernetes 1.30, dove l'azione è attiva di default: l'immagine distroless non ha una shell per un `exec` equivalente. Su 1.27–1.29 l'attesa la fa il processo stesso con `SHUTDOWN_DRAIN` (default `5s`: `/readyz` risponde non pronto mentre il servizio continua a servire), purché `api.preStopSleepSeconds` + `SHUTDOWN_DRAIN` + `SHUTDOWN_TIMEOUT` resti sotto `api.terminationGracePeriodSeconds`. `task helm-check` verifica il chart su 1.27 e 1.30.

**Avvio.** Il pod API apre subito la porta HTTP, prima delle migrazioni e della discovery di Keycloak: `/api/v1/healthz` risponde 200 e `/api/v1/readyz` 503 finché l'avvio non è completo, e le altre richieste ricevono 503 con `Retry-After`. Così un'attesa del lock delle migrazioni (fino a 10 minuti) o di Keycloak non fa riavviare il pod; `progressDeadlineSeconds` è 900 per API e worker.

## Docker Compose

Uno stack di **sviluppo** (PostgreSQL, RustFS, Keycloak) è in `deploy/docker/compose.dev.yaml` (`task stack-up`) e **non** è pensato per la produzione. Un compose di produzione per installazioni piccole, con proxy TLS (Caddy) e HTTP/2 per gRPC, è in `deploy/compose` (vedi il suo `README.md`).

## Primo avvio e verifica

1. I pod diventano `Ready`; `GET https://<host>/api/v1/readyz` risponde `{"status":"ok"}`. Tramite l'ingress la risposta non riporta il dettaglio per dipendenza: per vederlo, interrogare il pod direttamente (`kubectl port-forward deploy/memobrain-api 18081` e `curl http://127.0.0.1:18081/api/v1/readyz`: `database` e `storage` a `ok`).
2. `GET /api/v1/client-config` restituisce issuer e client id: è ciò che i client usano per configurarsi partendo dal solo URL del server.
3. Accedere alla Web UI con un utente con il ruolo `memobrain-admin`: compare la voce **Amministrazione**.
4. Impostare i limiti in **Amministrazione → Limiti** (quota predefinita, conservazione dello storico, dimensione massima file).
5. Nell'app desktop: _Impostazioni → Cloud_, inserire l'URL del server e accedere.

## Dimensionamento indicativo

L'API è stateless: si scala con le repliche (2+ consigliate). Un solo worker è sufficiente (i job usano advisory lock, quindi più worker sono sicuri ma ridondanti). Il collo di bottiglia tipico è il database: monitorare il pool ([monitoraggio](monitoraggio.md)). I numeri misurati (indicizzazione, ricerca, carico del cloud) sono in `docs/perf/README.md`.
