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
2. **Segreti.** Creare un Secret con `DATABASE_URL`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `KC_ADMIN_CLIENT_SECRET` e indicarlo in `secret.existingSecret` (consigliato), oppure lasciare che il chart lo crei da `secret.values` (solo prove).
3. **Valori non segreti** in `config:` (vedi [configurazione](configurazione.md)): `OIDC_ISSUER`, `S3_ENDPOINT`, `KC_ADMIN_BASE_URL`, `WEB_UI_ORIGIN`, …
4. **Immagine.** `image.repository` e `image.tag` (l'immagine si costruisce con `docker build -f services/cloud/Dockerfile -t <repo>:<tag> .` dalla radice del repository; il registry definitivo è da decidere con la distribuzione, M7).
5. **Ingress:** `ingress.host` per HTTP e `ingress.grpcHost` per gRPC (HTTP/2 end to end, TLS). Con ingress NGINX aggiungere l'annotation `nginx.ingress.kubernetes.io/backend-protocol: "GRPC"` sull'host gRPC.
6. **Installare:**

   ```sh
   helm upgrade --install memobrain deploy/helm/memobrain -n memobrain --create-namespace -f my-values.yaml
   ```

Il chart avvia `api.replicas` repliche con `--role=api` e `worker.replicas` (1) con `--role=worker`. Le probe usano `/api/v1/healthz` (liveness) e `/api/v1/readyz` (readiness). Il pod gira come utente non root con profilo seccomp `RuntimeDefault`.

## Docker Compose

Uno stack di **sviluppo** (PostgreSQL, RustFS, Keycloak) è in `deploy/docker/compose.dev.yaml` (`task stack-up`) e **non** è pensato per la produzione. Un compose di produzione per installazioni piccole, con proxy TLS (Caddy) e HTTP/2 per gRPC, è in `deploy/compose` (vedi il suo `README.md`).

## Primo avvio e verifica

1. I pod diventano `Ready`; `GET https://<host>/api/v1/readyz` risponde `{"status":"ok"}` con `database` e `storage` a `ok`.
2. `GET /api/v1/client-config` restituisce issuer e client id: è ciò che i client usano per configurarsi partendo dal solo URL del server.
3. Accedere alla Web UI con un utente con il ruolo `memobrain-admin`: compare la voce **Amministrazione**.
4. Impostare i limiti in **Amministrazione → Limiti** (quota predefinita, conservazione dello storico, dimensione massima file).
5. Nell'app desktop: _Impostazioni → Cloud_, inserire l'URL del server e accedere.

## Dimensionamento indicativo

L'API è stateless: si scala con le repliche (2+ consigliate). Un solo worker è sufficiente (i job usano advisory lock, quindi più worker sono sicuri ma ridondanti). Il collo di bottiglia tipico è il database: monitorare il pool ([monitoraggio](monitoraggio.md)). I numeri misurati (indicizzazione, ricerca, carico del cloud) sono in `docs/perf/README.md`.
