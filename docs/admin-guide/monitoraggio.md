# Monitoraggio e osservabilità

## Endpoint

| Endpoint                                    | Uso                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /metrics`                              | Metriche Prometheus (stessa porta HTTP dell'API; non autenticato ma servito solo alle richieste dirette: se arriva tramite un proxy o un ingress (header `X-Forwarded-For` o `Forwarded`) risponde 404, quindi Prometheus deve raccogliere dai pod nel cluster (ServiceMonitor), non dall'ingress pubblico).                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `GET /api/v1/healthz`                       | Liveness: il processo è vivo.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `GET /api/v1/readyz`                        | Readiness: database e storage rispondono entro 3 s. Il risultato dei controlli è riutilizzato per 2 s e condiviso dalle richieste concorrenti (il database e lo storage ricevono al più un controllo ogni 2 s, qualunque sia il numero di sonde); lo stato di spegnimento è invece valutato a ogni richiesta. Il dettaglio per dipendenza (`checks`) è restituito solo ai chiamanti diretti della rete interna (indirizzo loopback, privato RFC 1918/ULA, link-local o 100.64.0.0/10, senza `X-Forwarded-For`/`Forwarded`): tramite ingress o da internet la risposta contiene solo `status` (`ok`/`unavailable`) e gli errori finiscono nel log (`readiness check failed`). Le sonde sono esenti dal limite di richieste per IP solo per quei chiamanti diretti interni. |
| `GET :18083/metrics`, `/healthz`, `/readyz` | Solo `--role=worker`, sul listener interno `METRICS_LISTEN_ADDR`: metriche (comprese quelle dei job), liveness (200 mentre lo scheduler dei job batte il suo heartbeat ogni 10 s, o mentre attende la migrazione dello schema; 503 se è fermo da oltre 30 s) e readiness (200 solo quando i job girano). Rispondono JSON `{"status","state","version"}` con `state` = `running`, `waiting-for-schema` o `stalled`.                                                                                                                                                                                                                                                                                                                                                        |     |

## Metriche esposte

Oltre alle metriche standard di Go (`go_*`, `process_*`):

| Metrica                                      | Tipo      | Etichette                                   | Significato                                                                                                                                                          |
| -------------------------------------------- | --------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clarae_http_requests_total`                 | counter   | `route`, `method`, `status`                 | Richieste HTTP. `route` è il pattern, non il path, e `method` è uno tra `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS` o `OTHER` (cardinalità limitata). |
| `clarae_http_request_duration_seconds`       | histogram | `route`, `method`                           | Latenza delle richieste.                                                                                                                                             |
| `clarae_http_inflight_requests`              | gauge     | —                                           | Richieste in corso.                                                                                                                                                  |
| `clarae_sync_commits_total`                  | counter   | `outcome` (`ok`/`error`)                    | Richieste di commit di sync.                                                                                                                                         |
| `clarae_sync_ops_total`                      | counter   | `status` (`accepted`/`conflict`/`rejected`) | Operazioni di sync per esito.                                                                                                                                        |
| `clarae_notify_streams_active`               | gauge     | —                                           | Stream di notifica aperti (gRPC + SSE) su questo processo.                                                                                                           |
| `clarae_jobs_runs_total`                     | counter   | `job`, `result`                             | Esecuzioni dei job (`blob-gc`, `uploads`, `retention`, `maintenance`, `exports`).                                                                                    |
| `clarae_jobs_run_duration_seconds`           | histogram | `job`                                       | Durata dei job.                                                                                                                                                      |
| `clarae_jobs_last_success_timestamp_seconds` | gauge     | `job`                                       | Quando ogni job è riuscito l'ultima volta (solo processi worker).                                                                                                    |
| `clarae_db_pool_connections`                 | gauge     | `state` (`acquired`/`idle`/`total`/`max`)   | Connessioni del pool PostgreSQL.                                                                                                                                     |
| `clarae_db_pool_acquires_total`              | counter   | —                                           | Acquisizioni di connessione completate.                                                                                                                              |
| `clarae_db_pool_empty_acquires_total`        | counter   | —                                           | Acquisizioni che hanno dovuto attendere (pool esaurito).                                                                                                             |
| `clarae_db_pool_acquire_wait_seconds_total`  | counter   | —                                           | Tempo totale speso in attesa di una connessione.                                                                                                                     |

Il tracciamento distribuito (OpenTelemetry) non è incluso in questa versione.

Le metriche dei job compaiono solo sui processi che eseguono il worker: con `--role=all` sulla porta HTTP dell'API, con `--role=worker` sul listener interno `METRICS_LISTEN_ADDR` (`:18083` nell'immagine), che Prometheus deve raccogliere a parte. Quelle HTTP e degli stream compaiono solo sui processi che servono l'API.

L'etichetta `job` delle metriche dei job (il nome del job) coincide con l'etichetta di target di Prometheus: con la configurazione predefinita (`honor_labels: false`) Prometheus la rinomina in `exported_job` e `job` diventa il nome dello scraping. Le regole di alerting fornite gestiscono entrambi i casi; nelle query manuali usare `exported_job` (oppure impostare `honor_labels: true` per i target di Clarae notanda).

## Dashboard Grafana

File: `deploy/observability/grafana/clarae-overview.json` (Grafana 10+). Importarlo da _Dashboards → Import_, scegliendo il datasource Prometheus; la variabile `job` seleziona i job di scraping di Clarae notanda. Sezioni: panoramica (richieste/s, 5xx, p95, stream, repliche), RED per route, sincronizzazione (commit, operazioni per esito, pull, blob), job in background (esecuzioni, durata, tempo dall'ultimo successo), pool del database, processo Go. Un test (`TestDeployAssetsUseExistingMetrics`) garantisce che dashboard e regole usino solo metriche realmente registrate dal servizio.

## Regole di alerting

File: `deploy/observability/prometheus/alerts.yaml` (esempio da adattare). Contiene: istanza giù, tasso 5xx, latenza p95, picchi 401/403, errori di commit, operazioni rifiutate, job che falliscono o fermi (export, manutenzione), assenza delle metriche dei job (`ClaraeJobMetricsAbsent`: nessun worker raccolto da 15 minuti; `ClaraeJobNeverSucceeded`: un job senza alcun successo da 2 ore, che copre anche il caso in cui le regole "stale" non possono scattare perché la serie non esiste), saturazione e attese del pool. Ogni alert ha l'annotazione `runbook` che rimanda al [runbook](runbook.md). Validazione: `promtool check rules deploy/observability/prometheus/alerts.yaml` (oppure via Docker: `docker run --rm --entrypoint promtool -v $PWD/deploy/observability/prometheus:/r:ro prom/prometheus:v2.55.1 check rules /r/alerts.yaml`).

Scraping con Prometheus Operator (esempio):

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata: { name: clarae }
spec:
  selector: { matchLabels: { app.kubernetes.io/name: clarae } }
  endpoints: [{ port: http, path: /metrics, interval: 30s }]
---
# Il worker non ha un Service: si raccoglie dai pod, porta "metrics" (18083).
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata: { name: clarae-worker }
spec:
  selector:
    matchLabels: { app.kubernetes.io/name: clarae, app.kubernetes.io/component: worker }
  podMetricsEndpoints: [{ port: metrics, path: /metrics, interval: 30s }]
```

(adattare le label a quelle del Service generato dal chart). Senza Prometheus Operator, il chart aggiunge ai pod di entrambi i ruoli le annotazioni `prometheus.io/scrape`, `prometheus.io/port` e `prometheus.io/path` (`metrics.podAnnotations`, attivo per default) per la configurazione di scraping "kubernetes-pods". Con `networkPolicy.enabled` e `restrictEgress`, consentire a Prometheus l'accesso con `networkPolicy.metricsFrom`.

## Log

JSON su stdout, livello con `LOG_LEVEL`. Campi utili: `request_id` (propagato dal client con `X-Request-Id`), `job`, `vault`, `user`. I log non contengono token né contenuto delle note. Eventi da cercare: `job failed`, `usage drift corrected`, `blob ref count corrected`, errori di migrazione all'avvio.
