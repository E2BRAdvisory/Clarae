# Monitoraggio e osservabilità

## Endpoint

| Endpoint              | Uso                                                                                                                                                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /metrics`        | Metriche Prometheus (stessa porta HTTP dell'API; non autenticato ma servito solo alle richieste dirette: se arriva tramite un proxy o un ingress (header `X-Forwarded-For` o `Forwarded`) risponde 404, quindi Prometheus deve raccogliere dai pod nel cluster (ServiceMonitor), non dall'ingress pubblico). |
| `GET /api/v1/healthz` | Liveness: il processo è vivo.                                                                                                                                                                                                                                                                                |
| `GET /api/v1/readyz`  | Readiness: database e storage rispondono entro 3 s; 503 con il dettaglio per dipendenza.                                                                                                                                                                                                                     |

## Metriche esposte

Oltre alle metriche standard di Go (`go_*`, `process_*`):

| Metrica                                         | Tipo      | Etichette                                   | Significato                                                                       |
| ----------------------------------------------- | --------- | ------------------------------------------- | --------------------------------------------------------------------------------- |
| `memobrain_http_requests_total`                 | counter   | `route`, `method`, `status`                 | Richieste HTTP. `route` è il pattern, non il path (cardinalità limitata).         |
| `memobrain_http_request_duration_seconds`       | histogram | `route`, `method`                           | Latenza delle richieste.                                                          |
| `memobrain_http_inflight_requests`              | gauge     | —                                           | Richieste in corso.                                                               |
| `memobrain_sync_commits_total`                  | counter   | `outcome` (`ok`/`error`)                    | Richieste di commit di sync.                                                      |
| `memobrain_sync_ops_total`                      | counter   | `status` (`accepted`/`conflict`/`rejected`) | Operazioni di sync per esito.                                                     |
| `memobrain_notify_streams_active`               | gauge     | —                                           | Stream di notifica aperti (gRPC + SSE) su questo processo.                        |
| `memobrain_jobs_runs_total`                     | counter   | `job`, `result`                             | Esecuzioni dei job (`blob-gc`, `uploads`, `retention`, `maintenance`, `exports`). |
| `memobrain_jobs_run_duration_seconds`           | histogram | `job`                                       | Durata dei job.                                                                   |
| `memobrain_jobs_last_success_timestamp_seconds` | gauge     | `job`                                       | Quando ogni job è riuscito l'ultima volta (solo processi worker).                 |
| `memobrain_db_pool_connections`                 | gauge     | `state` (`acquired`/`idle`/`total`/`max`)   | Connessioni del pool PostgreSQL.                                                  |
| `memobrain_db_pool_acquires_total`              | counter   | —                                           | Acquisizioni di connessione completate.                                           |
| `memobrain_db_pool_empty_acquires_total`        | counter   | —                                           | Acquisizioni che hanno dovuto attendere (pool esaurito).                          |
| `memobrain_db_pool_acquire_wait_seconds_total`  | counter   | —                                           | Tempo totale speso in attesa di una connessione.                                  |

Il tracciamento distribuito (OpenTelemetry) non è incluso in questa versione.

Le metriche dei job compaiono solo sui processi che eseguono il worker (`--role=worker|all`); quelle HTTP e degli stream solo su quelli che servono l'API.

## Dashboard Grafana

File: `deploy/observability/grafana/memobrain-overview.json` (Grafana 10+). Importarlo da _Dashboards → Import_, scegliendo il datasource Prometheus; la variabile `job` seleziona i job di scraping di MemoBrain Notes. Sezioni: panoramica (richieste/s, 5xx, p95, stream, repliche), RED per route, sincronizzazione (commit, operazioni per esito, pull, blob), job in background (esecuzioni, durata, tempo dall'ultimo successo), pool del database, processo Go. Un test (`TestDeployAssetsUseExistingMetrics`) garantisce che dashboard e regole usino solo metriche realmente registrate dal servizio.

## Regole di alerting

File: `deploy/observability/prometheus/alerts.yaml` (esempio da adattare). Contiene: istanza giù, tasso 5xx, latenza p95, picchi 401/403, errori di commit, operazioni rifiutate, job che falliscono o fermi (export, manutenzione), saturazione e attese del pool. Ogni alert ha l'annotazione `runbook` che rimanda al [runbook](runbook.md). Validazione: `promtool check rules deploy/observability/prometheus/alerts.yaml` (oppure via Docker: `docker run --rm --entrypoint promtool -v $PWD/deploy/observability/prometheus:/r:ro prom/prometheus:v2.55.1 check rules /r/alerts.yaml`).

Scraping con Prometheus Operator (esempio):

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata: { name: memobrain }
spec:
  selector: { matchLabels: { app.kubernetes.io/name: memobrain } }
  endpoints: [{ port: http, path: /metrics, interval: 30s }]
```

(adattare le label a quelle del Service generato dal chart).

## Log

JSON su stdout, livello con `LOG_LEVEL`. Campi utili: `request_id` (propagato dal client con `X-Request-Id`), `job`, `vault`, `user`. I log non contengono token né contenuto delle note. Eventi da cercare: `job failed`, `usage drift corrected`, `blob ref count corrected`, errori di migrazione all'avvio.
