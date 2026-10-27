# ADR-0007 — Stack di sviluppo locale: RustFS come S3, porte non standard

|                       |                                                                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Stato**             | accettata                                                                                                                          |
| **Data**              | 2026-10-23                                                                                                                         |
| **Riferimenti spec**  | §1.6 (MinIO/AWS S3), §4.1 `deploy/docker`                                                                                          |
| **Devia dallo spec?** | sì, solo per lo sviluppo locale: lo spec cita MinIO come esempio di S3-compatibile; in produzione resta "qualsiasi S3-compatibile" |

## Contesto

Le immagini `minio/minio` e `quay.io/minio/minio` non sono più scaricabili senza autenticazione (ottobre 2026). Sulla macchina di sviluppo le porte 5432, 8081 e 8082 erano già occupate da altri servizi.

## Decisione

- **RustFS** (`rustfs/rustfs`, Apache-2.0, API S3 compatibile con MinIO, console su 9001) come object store di sviluppo in `deploy/docker/compose.dev.yaml`; bucket creati da un init container `amazon/aws-cli`. Il servizio cloud parla S3 generico (`minio-go`/SDK), quindi nessun impatto sul codice.
- Porte di sviluppo: PostgreSQL **5433** sull'host, API cloud **18081**, gRPC **18082** (default in `config.go` e `cloud.dev.env`); Keycloak 8080.
- `make stack-reset` distrugge i volumi (necessario per re-importare `realm-memobrain.json`, che Keycloak importa solo su realm inesistente).

## Alternative considerate

- **LocalStack** — scartata: pesante, più lenta all'avvio.
- **Garage / SeaweedFS / versitygw** — valide; RustFS scelta per compatibilità di configurazione con MinIO (variabili `*_ACCESS_KEY`, console) e documentazione.

## Conseguenze

I test d'integrazione con S3 (M2) useranno testcontainers con la stessa immagine; se RustFS cambiasse licenza o distribuzione, la sostituzione è confinata al compose.
