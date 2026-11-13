# Guida dell'amministratore

Per chi installa, configura e gestisce il **Cloud Service** (API, worker, Web UI incorporata), PostgreSQL, l'archivio S3-compatibile e Keycloak. Il prodotto si chiama "Clarae notanda"; nei manifest e nei comandi compare come `clarae`.

| Argomento                                       | Contenuto                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [Installazione](installazione.md)               | Architettura, prerequisiti, Helm, compose di sviluppo, primo avvio e verifica.                   |
| [Keycloak](keycloak.md)                         | Realm, client, ruoli, service account con i ruoli minimi (ADR-0012), ruolo `clarae-admin`.       |
| [Configurazione](configurazione.md)             | Riferimento di **tutte** le variabili d'ambiente (verificato da un test) e impostazioni runtime. |
| [Profili, quote, audit](profili-quote-audit.md) | Gruppi, config profile distribuiti ai client, limiti di archiviazione, registro di audit.        |
| [Backup e upgrade](backup-upgrade.md)           | Cosa salvare, ripristino, aggiornamenti con migrazioni, rollback.                                |
| [Monitoraggio](monitoraggio.md)                 | Metriche Prometheus, dashboard Grafana, regole di alerting, log.                                 |
| [Runbook](runbook.md)                           | Sintomo → verifica → rimedio: login, sync, quota, sospensioni, export, database, S3.             |

Documenti collegati: `docs/runbook/` (procedure operative dettagliate: backup e ripristino), `docs/security/` (progetto crittografico, ambito pen test, conservazione dei dati), `docs/release/` (versioni, distribuzione, segreti di firma), `docs/adr/README.md` (decisioni architetturali).

## Cosa non fa il server (e quindi cosa non potete fare voi)

- Il server **non interpreta mai il contenuto** delle note: non cerca, non indicizza e non mostra il testo dei vault. L'unione delle modifiche (merge) è sempre eseguita dai client. Attenzione: i blob dei vault **condivisi** (non E2EE) sono in chiaro sull'archivio S3, quindi chi ha accesso diretto allo storage può leggerli (lo dichiara anche la procedura di collegamento al cloud nel client).
- I **vault privati** sono cifrati end-to-end dal client: percorsi e contenuti sono opachi anche per l'amministratore. Non esiste un "reset password" per la passphrase di un vault privato: se l'utente perde passphrase **e** recovery key, i dati sono irrecuperabili. Per lo stesso motivo il server non può esportarli.
- I **gruppi** esistono solo nel database del servizio (D-05): non vengono letti da Keycloak né da LDAP.
