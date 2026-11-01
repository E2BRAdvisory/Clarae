# Backup, ripristino e upgrade

Le procedure operative dettagliate (PITR, prove di ripristino, RPO/RTO misurati) sono in `docs/runbook/backup-restore.md` (provate con un ripristino reale: `scripts/chaos/restore-drill.sh`). Qui i principi e i comandi essenziali.

## Cosa salvare

| Dato                                                                | Dove                            | Come                                                                              |
| ------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------- |
| Metadati (vault, file, revisioni, changelog, utenti, gruppi, audit) | PostgreSQL                      | `pg_dump` periodico **e** archiviazione WAL per il point-in-time recovery (PITR). |
| Blob dei file                                                       | bucket `S3_BUCKET_BLOBS`        | Versioning del bucket o replica verso un secondo bucket/regione.                  |
| Archivi di export                                                   | bucket `S3_BUCKET_EXPORTS`      | **Non** da salvare: sono temporanei e si rigenerano.                              |
| Realm Keycloak                                                      | database di Keycloak            | Backup del suo database + export del realm (`kc.sh export`).                      |
| Segreti e configurazione                                            | Secret Kubernetes / values Helm | Nel vostro gestore di segreti, mai nel repository.                                |

Database e storage vanno ripristinati **a istanti coerenti**: i blob sono immutabili e content-addressed, quindi un bucket _più recente_ del database è sicuro (blob orfani, che il GC rimuove dopo `blobs.gc_grace_hours`), mentre un bucket _più vecchio_ del database lascia revisioni che puntano a blob mancanti. Regola: ripristinare il database al punto desiderato e **non** far tornare indietro il bucket dei blob.

I **vault privati** sono cifrati dal client: un backup del server contiene solo dati cifrati e non sostituisce il backup della passphrase/recovery key dell'utente.

## Ripristino

1. Fermare le repliche (`kubectl scale deploy/memobrain-api deploy/memobrain-worker --replicas=0`).
2. Ripristinare il database (dump o PITR) e verificare che il bucket dei blob contenga almeno gli oggetti fino a quel momento.
3. Riavviare: le migrazioni mancanti si applicano da sole; la riconciliazione notturna corregge contatori di utilizzo e riferimenti blob.
4. I client con un cursore di sync **più avanti** del `last_seq` ripristinato non possono proseguire sullo stesso vault: dopo un ripristino che perde modifiche i client ripartono dal manifesto e creano **copie di conflitto** invece di perdere dati locali (nessuna perdita silenziosa).

## Upgrade

- Il servizio applica le **migrazioni SQL** (goose) all'avvio delle repliche API (`--role=api`/`all`), una alla volta grazie a un advisory lock PostgreSQL; il worker non migra e attende che lo schema raggiunga la versione del proprio binario prima di eseguire i job. Sono pensate per essere compatibili con la versione precedente (aggiunte, non rimozioni) così che un rolling update con repliche miste funzioni; le eccezioni sono segnalate nelle note di rilascio (`docs/release/README.md`).
- **Prima di aggiornare:** backup del database; leggere le note di rilascio; verificare le nuove variabili in [configurazione](configurazione.md).
- **Procedura Helm:** `helm upgrade memobrain deploy/helm/memobrain -f my-values.yaml --set image.tag=<nuova>`; osservare `readyz`, la dashboard e i log del primo pod.
- **Compatibilità client:** il protocollo di sync è versionato; i client più vecchi continuano a funzionare finché il server accetta la loro versione. Le versioni minime supportate saranno riportate nelle note di rilascio.
- **Rollback:** tornare all'immagine precedente è sicuro solo se la migrazione era retrocompatibile; altrimenti ripristinare il backup del database. Per questo il backup precede sempre l'upgrade.
